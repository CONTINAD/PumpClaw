import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { CONFIG } from './config.js';
import { scrapeTrendingPosts } from './telegram.js';
import { fetchCoinDetails } from './pumpfun.js';
import { fetchBatchMarketData, fetchSingleMarketData, getSolPrice, type MarketData } from './dexscreener.js';
import { sendAlert, updateWithPerformance, sendMilestoneAlert, sendLeaderboard, sendMonthlyLeaderboard, sendFullCallListReport, fmtUsd, fmtPct, type LeaderboardEntry, type MonthlyLeaderboardEntry } from './discord.js';
import { PerformanceTracker, type PerformanceSnapshot } from './tracker.js';
import { registerRuntime } from './runtime.js';
import { PaperTrader } from './paper-trader.js';
import { taskManager } from './tasks.js';
import { getWallet, getSolBalance, withTimeout } from './wallet.js';
import { describeStrategy } from './strategy.js';
import { checkBundle } from './bundle-check.js';
import { checkSmartWallets } from './wallet-filter.js';
import { jupiterQuoteSol, jupiterGetPrice } from './jupiter.js';
import { startDashboard } from './dashboard.js';
import { registerSlashCommands } from './interactions.js';
import { sourceRegistry, extractMints, classifySignal, PUMPCLAW_SOURCE_ID } from './call-sources.js';
import { capturePath, hasPath } from './candles.js';
import { sendTradeActivity, sendOpsAlert } from './discord.js';
import type { PumpFunCoin } from './pumpfun.js';

// ── Leaderboard timestamp persistence ───────────────────────

const LB_TIMESTAMPS_FILE = join(CONFIG.DATA_DIR, 'lb-timestamps.json');

interface LbTimestamps {
  leaderboard: Record<string, number>;  // label → last post epoch ms
  monthlyDate: string;                  // 'YYYY-MM-DD'
}

function loadLbTimestamps(): LbTimestamps {
  try {
    return JSON.parse(readFileSync(LB_TIMESTAMPS_FILE, 'utf-8'));
  } catch {
    // File missing (fresh deploy / update) — seed with "just posted" so we don't spam
    const now = Date.now();
    const today = new Date();
    const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    const seeded: LbTimestamps = {
      leaderboard: {
        '6 Hours': now, '12 Hours': now,
        '24 Hours': now, '7 Days': now,
      },
      monthlyDate: todayStr,
    };
    saveLbTimestamps(seeded);
    return seeded;
  }
}

function saveLbTimestamps(ts: LbTimestamps): void {
  try { writeFileSync(LB_TIMESTAMPS_FILE, JSON.stringify(ts, null, 2)); } catch {}
}

const _lbTs = loadLbTimestamps();

// ── State ───────────────────────────────────────────────────

const tracker = new PerformanceTracker();
const paperTrader = new PaperTrader();
// Share the live instances with the dashboard — it must mutate these, not copies.
registerRuntime(tracker, paperTrader);
const seenTgMsgIds = new Set<string>();
const recentCallTimes: number[] = [];
let lastMilestoneCheck = 0;

// Ring buffer of recently skipped tokens — exposed via /api/skipped on dashboard
export interface SkippedToken {
  mint: string;
  name: string;
  reason: string;
  details: string;
  marketCap: number;
  timestamp: number;
}
export const skippedRing: SkippedToken[] = [];

/** Recent external-source decisions — surfaced at /api/sources for debugging. */
export interface SourceEvent { ts: number; source: string; mint: string; action: string; detail: string }
export const sourceEvents: SourceEvent[] = [];
export function recordSourceEvent(source: string, mint: string, action: string, detail: string) {
  sourceEvents.push({ ts: Date.now(), source, mint, action, detail });
  if (sourceEvents.length > 100) sourceEvents.shift();
}
function recordSkip(post: { mint: string; name: string }, reason: string, details: string, mc: number) {
  skippedRing.push({ mint: post.mint, name: post.name, reason, details, marketCap: mc, timestamp: Date.now() });
  if (skippedRing.length > 200) skippedRing.shift();
}

// Last live-edit timestamp per mint (throttle Discord PATCHes to avoid rate limits)
const lastLiveEdit = new Map<string, number>();
const LIVE_EDIT_PEAK_GAP_MS = 30_000;     // on peak rise: at least 30s between edits
const LIVE_EDIT_REFRESH_GAP_MS = 180_000; // periodic refresh: every 3 min keep "now" fresh
const LIVE_EDIT_TRACKING_WINDOW_MS = 60 * 60 * 1000; // only auto-update for first hour
const lastLeaderboardPost = new Map<string, number>(Object.entries(_lbTs.leaderboard));
let lastMonthlyLbDate = _lbTs.monthlyDate;

// ── Helpers ─────────────────────────────────────────────────

function log(msg: string) {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// ── Fast scan loop — Telegram scrape + alert + buy (never blocked by milestones) ──

/**
 * The bundle check's wallet caches live in memory, so a deploy empties them. The
 * first scan after a restart therefore judges every holder on a cold RPC burst,
 * and thin results are not evidence of anything — they are evidence we just
 * started. Under the old fail-open flag that read as "safe": all four bad calls
 * on 08-12, including both $SAFETOAD clusters, landed within three minutes of a
 * deploy, one of them nine seconds after a push.
 *
 * Failing closed fixes the wrong answer. Not answering until the caches are warm
 * avoids being asked the question under the worst possible conditions.
 */
const BOOT_TS = Date.now();
const SCAN_WARMUP_MS = 90_000;
let warmupLogged = false;

async function fastScanCycle() {
  const sinceBoot = Date.now() - BOOT_TS;
  if (sinceBoot < SCAN_WARMUP_MS) {
    if (!warmupLogged) {
      warmupLogged = true;
      log(`⏳ Warm-up — not calling for ${Math.round((SCAN_WARMUP_MS - sinceBoot) / 1000)}s while wallet caches fill`);
    }
    return;
  }

  const posts = await scrapeTrendingPosts();

  if (posts.length === 0) {
    log('⚠ No trending posts from Telegram');
    return;
  }

  // Track message IDs to avoid processing the same post twice within a session
  const newPosts = posts.filter(p => !seenTgMsgIds.has(p.messageId));
  for (const p of posts) seenTgMsgIds.add(p.messageId);

  if (newPosts.length === 0) return;

  // Only consider mints that haven't been called before (persisted in calls.json)
  const seenMintsThisCycle = new Set<string>();
  const freshPosts = newPosts.filter(p => {
    if (tracker.hasBeenCalled(p.mint) || seenMintsThisCycle.has(p.mint)) return false;
    seenMintsThisCycle.add(p.mint);
    return true;
  });

  log(`📡 ${posts.length} trending posts, ${newPosts.length} new, ${freshPosts.length} never-called`);

  if (freshPosts.length === 0) return;

  const mints = [...new Set(freshPosts.map(p => p.mint))];
  const marketData = await fetchBatchMarketData(mints);
  log(`📊 DexScreener data for ${marketData.size}/${mints.length} fresh trending coins`);

  // Pre-screen every candidate on cheap market filters first, then run the SLOW
  // bundle/graph checks for all survivors in parallel. Sequentially this cost
  // 15-30s per coin, so a third candidate could be a minute stale before we looked.
  const cheapPass = freshPosts.filter(post => {
    const m = marketData.get(post.mint);
    if (!m) return false;
    // Ceiling first: it is free, and it stops us spending ~20 RPC calls of bundle
    // work on a coin we were never going to call.
    if (CONFIG.MAX_ENTRY_MC > 0 && m.marketCap > CONFIG.MAX_ENTRY_MC) return false;
    const vt = m.marketCap < CONFIG.MICRO_MC_THRESHOLD ? CONFIG.MIN_5M_VOLUME_MICRO_MC
      : m.marketCap < CONFIG.LOW_MC_THRESHOLD ? CONFIG.MIN_5M_VOLUME_LOW_MC : CONFIG.MIN_5M_VOLUME_HIGH_MC;
    return m.volume5m >= vt && m.priceChange5m >= -25;
  });
  const bundlePromises = new Map<string, Promise<Awaited<ReturnType<typeof checkBundle>>>>();
  for (const post of cheapPass) bundlePromises.set(post.mint, checkBundle(post.mint));
  if (bundlePromises.size > 1) log(`⚡ Running ${bundlePromises.size} bundle checks in parallel`);

  let alertCount = 0;
  for (const post of freshPosts) {
    const market = marketData.get(post.mint);
    if (!market) continue;

    // Entry ceiling. A coin already at six figures has made its move; in the 7-day
    // sample nothing called above $100K reached 2x, median peak 1.06x.
    if (CONFIG.MAX_ENTRY_MC > 0 && market.marketCap > CONFIG.MAX_ENTRY_MC) {
      log(`⚠ HIGH_MC — skipping ${post.name}: ${fmtUsd(market.marketCap)} > ${fmtUsd(CONFIG.MAX_ENTRY_MC)} ceiling`);
      recordSkip(post, 'HIGH_MC', `${fmtUsd(market.marketCap)} > ${fmtUsd(CONFIG.MAX_ENTRY_MC)}`, market.marketCap);
      continue;
    }

    const volThreshold = market.marketCap < CONFIG.MICRO_MC_THRESHOLD
      ? CONFIG.MIN_5M_VOLUME_MICRO_MC
      : market.marketCap < CONFIG.LOW_MC_THRESHOLD
        ? CONFIG.MIN_5M_VOLUME_LOW_MC
        : CONFIG.MIN_5M_VOLUME_HIGH_MC;
    if (market.volume5m < volThreshold) {
      recordSkip(post, 'LOW_VOL', `${fmtUsd(market.volume5m)} vol < ${fmtUsd(volThreshold)}`, market.marketCap);
      continue;
    }

    if (market.priceChange5m < -25) {
      log(`⚠ DUMP — skipping ${post.name}: 5m change ${market.priceChange5m.toFixed(1)}% (actively dumping)`);
      recordSkip(post, 'DUMP', `5m ${market.priceChange5m.toFixed(1)}%`, market.marketCap);
      continue;
    }

    // Buy/sell ratio — skip if sellers significantly outnumber buyers (momentum dying)
    if (market.sells5m > 0 && market.buys5m > 0) {
      const sellRatio = market.sells5m / market.buys5m;
      if (sellRatio > 1.3) {
        log(`⚠ HEAVY SELLING — skipping ${post.name}: ${market.buys5m}B/${market.sells5m}S (${sellRatio.toFixed(2)}x sells)`);
        recordSkip(post, 'HEAVY_SELLING', `${market.buys5m}B / ${market.sells5m}S (${sellRatio.toFixed(2)}x)`, market.marketCap);
        continue;
      }
    }

    // Trade count — require real activity, not 1 whale propping it up
    // (≥20 buys in last 5min = a buy every 15s on average)
    if (market.buys5m > 0 && market.buys5m < 20) {
      log(`⚠ LOW ACTIVITY — skipping ${post.name}: only ${market.buys5m} buys in 5m`);
      recordSkip(post, 'LOW_ACTIVITY', `${market.buys5m} buys in 5m`, market.marketCap);
      continue;
    }

    // Volume momentum — vol5m should be at least 15% of vol1h (last 5min concentrated)
    // If a coin had $100K vol last hour but only $5K in last 5min, momentum has died
    if (market.volume1h > 0 && market.volume5m > 0) {
      const concentration = market.volume5m / market.volume1h;
      if (concentration < 0.15) {
        log(`⚠ COOLING OFF — skipping ${post.name}: only ${(concentration*100).toFixed(0)}% of 1h vol in last 5m`);
        recordSkip(post, 'COOLING_OFF', `${(concentration*100).toFixed(0)}% of 1h vol in last 5m`, market.marketCap);
        continue;
      }
    }

    // Liquidity floor — coins with shallow liq are easy rug targets
    if (market.liquidity > 0 && market.liquidity < CONFIG.MIN_LIQUIDITY) {
      log(`⚠ LOW LIQ — skipping ${post.name}: ${fmtUsd(market.liquidity)} liquidity (need ≥${fmtUsd(CONFIG.MIN_LIQUIDITY)})`);
      recordSkip(post, 'LOW_LIQ', `${fmtUsd(market.liquidity)} liquidity`, market.marketCap);
      continue;
    }

    // Hourly call cap — when the trending feed is spraying, quality collapses.
    // Better to miss a call than to spray the channel with 1 AM exit liquidity.
    while (recentCallTimes.length > 0 && Date.now() - recentCallTimes[0] > 3600_000) recentCallTimes.shift();
    if (recentCallTimes.length >= CONFIG.MAX_CALLS_PER_HOUR) {
      log(`⚠ RATE CAP — skipping ${post.name}: already ${recentCallTimes.length} calls in the last hour`);
      recordSkip(post, 'RATE_CAP', `${recentCallTimes.length} calls in last hour`, market.marketCap);
      continue;
    }

    if (tracker.hasBeenCalled(post.mint)) continue;

    const bundle = await (bundlePromises.get(post.mint) ?? checkBundle(post.mint));
    if (!bundle.safe) {
      // Separate "this coin looks like a farm" from "we could not judge this coin".
      // Both block, but they mean different things: a run of the second is a degraded
      // RPC quietly turning into a call drought, which is exactly how five days of
      // silence happened before. Lumping them under one label hid that.
      const blind = /\[UNVERIFIABLE\]|fail closed/.test(bundle.details);
      const devHeavy = /\[DEV HOLDS\]/.test(bundle.details);
      const aged = /\[AGED COHORT\]/.test(bundle.details);
      const reason = devHeavy ? 'DEV_HOLDS' : aged ? 'AGED_FARM' : blind ? 'BUNDLE_UNVERIFIABLE' : 'BUNDLED';
      log(`⚠ ${reason} — skipping ${post.name}: ${bundle.details}`);
      recordSkip(post, reason, bundle.details, market.marketCap);
      if (blind && !devHeavy && !aged) noteBlindBlock(post.name); else blindBlocks = 0;
      continue;
    }
    blindBlocks = 0;
    if (bundle.totalChecked > 0) {
      log(`✅ Bundle check passed: ${bundle.details}`);
    }

    // Smart wallet check: informational, not blocking. Most fresh pump.fun coins
    // won't yet have any of our 186 tracked wallets in them — skipping them all
    // would mean we miss almost everything. Just log it as a positive signal.
    const smartCheck = await checkSmartWallets(post.mint);
    if (smartCheck.holders > 0) {
      log(`💎 SMART HOLDERS — ${smartCheck.holders} tracked wallet(s) holding $${post.name}`);
    }

    // Fee floor — a migrated coin that hasn't generated real fees hasn't been
    // genuinely traded. Scales with market cap: bigger claimed cap demands more
    // proof of activity behind it.
    const migrated = (market.dexId ?? '').toLowerCase().includes('pumpswap')
      || (market.dexId ?? '').toLowerCase().includes('raydium');
    if (migrated) {
      const solPrice = await getSolPrice();
      const volumeSol = market.volume24h / solPrice;
      const estFees = volumeSol * CONFIG.PUMPSWAP_FEE_RATE;
      const needed = market.marketCap >= 100_000 ? CONFIG.MIN_FEES_100K_SOL
        : market.marketCap >= 60_000 ? CONFIG.MIN_FEES_60K_SOL
        : CONFIG.MIN_FEES_BONDED_SOL;
      if (estFees < needed) {
        log(`⚠ LOW FEES — skipping ${post.name}: ${estFees.toFixed(2)} SOL fees, needs ≥${needed} at ${fmtUsd(market.marketCap)} MC (vol ${volumeSol.toFixed(0)} SOL)`);
        recordSkip(post, 'LOW_FEES', `${estFees.toFixed(2)}/${needed} SOL fees at ${fmtUsd(market.marketCap)} MC`, market.marketCap);
        continue;
      }
      log(`✅ Fees ok: ${estFees.toFixed(2)} SOL (needed ${needed}) at ${fmtUsd(market.marketCap)} MC`);
    }

    const coinDetails = await fetchCoinDetails(post.mint);
    const coin: PumpFunCoin = coinDetails ?? {
      mint: post.mint,
      name: post.name,
      symbol: post.mint.slice(0, 6),
      isTrendingPaid: true,
    };
    coin.isTrendingPaid = true;
    if (!coinDetails) coin.name = post.name;

    // Re-fetch price right before calling — use the lower MC if it dropped during checks
    const freshMarket = await fetchSingleMarketData(post.mint);

    // FADE GATE: the pipeline takes ~10-15s — a coin that lost 8%+ during that window
    // is already rolling over. Calling it is top-signalling; skip instead.
    if (freshMarket && market.priceUsd > 0 && freshMarket.priceUsd > 0) {
      const fade = 1 - freshMarket.priceUsd / market.priceUsd;
      if (fade > 0.08) {
        log(`⚠ FADED — skipping ${post.name}: price dropped ${(fade * 100).toFixed(1)}% while checks ran`);
        recordSkip(post, 'FADED', `-${(fade * 100).toFixed(1)}% during checks`, freshMarket.marketCap);
        continue;
      }
    }

    const liveMarket = (freshMarket && freshMarket.marketCap < market.marketCap) ? freshMarket : market;

    log(
      `🔔 ALERT: ${coin.name} ($${coin.symbol}) — ` +
        `5m vol ${fmtUsd(liveMarket.volume5m)} — MC ${fmtUsd(liveMarket.marketCap)} — ` +
        `Price ${fmtUsd(liveMarket.priceUsd)} — SOL TRENDING ✅`,
    );

    const adjustedMarket = { ...liveMarket, priceUsd: liveMarket.priceUsd * 0.96, marketCap: liveMarket.marketCap * 0.96 };

    const paperTrade = paperTrader.openTrade(
      coin.mint, coin.symbol, coin.name, adjustedMarket.priceUsd, adjustedMarket.marketCap,
    );

    // Mark as called BEFORE sending alerts — prevents duplicate sends if Discord is slow/down
    // Pass rich features (bundle/smart holders) so we can correlate them with outcomes later.
    tracker.add(coin, adjustedMarket, 'pending', {
      smartHolders: smartCheck.holders,
      bundleSafe: bundle.safe,
      holders: bundle.metrics,
    });
    alertCount++;

    recentCallTimes.push(Date.now());
    const discordMsgId = await sendAlert(coin, adjustedMarket);
    if (discordMsgId) {
      tracker.setDiscordMsgId(coin.mint, discordMsgId);
      log(`📨 Alert sent for $${coin.symbol} — paper trade opened at ${fmtUsd(market.marketCap)} MC`);
    } else {
      log(`⚠ Alert failed for $${coin.symbol} — TG sent, Discord failed`);
    }

    // Execute real buy via Jupiter
    if (CONFIG.TRADE_ENABLED) {
      log(`[Trader] 🔄 Fan-out buy for $${coin.symbol} across ${taskManager.enabledTasks().length} task(s)...`);
      const boughtCount = await taskManager.buyAll(coin.mint, coin.symbol, coin.name, market.priceUsd, market.marketCap);
      if (boughtCount > 0) {
        log(`💰 REAL BUY: $${coin.symbol} — filled on ${boughtCount}/${taskManager.enabledTasks().length} task(s)`);
      } else {
        log(`⚠ BUY SKIPPED/FAILED for $${coin.symbol} on all tasks — check [Trader] logs above`);
      }
    }
  }

  if (alertCount > 0) {
    log(`✅ Sent ${alertCount} new alert(s)`);
  } else {
    let topVol = 0;
    let topName = '';
    for (const post of freshPosts) {
      const m = marketData.get(post.mint);
      if (m && m.volume5m > topVol) {
        topVol = m.volume5m;
        topName = post.name;
      }
    }
    if (topName) {
      log(`— Fresh coins below threshold. Top: ${topName} at ${fmtUsd(topVol)} 5m vol (needs ${fmtUsd(CONFIG.MIN_5M_VOLUME_MICRO_MC)}-${fmtUsd(CONFIG.MIN_5M_VOLUME_HIGH_MC)})`);
    }
  }

  // Trim seen Telegram IDs
  if (seenTgMsgIds.size > 500) {
    const arr = [...seenTgMsgIds];
    seenTgMsgIds.clear();
    for (const id of arr.slice(-200)) seenTgMsgIds.add(id);
  }
}

// ── Slow maintenance loop — snapshots, milestones, leaderboards (independent) ──

async function maintenanceCycle() {
  // ─── 1. Performance snapshot updates (5m, 15m, 30m, 1h) ───
  const needsSnapshot = tracker.getCallsNeedingSnapshot();
  for (const rec of needsSnapshot) {
    const current = await fetchSingleMarketData(rec.mint);
    if (!current) {
      log(`⚠ Could not fetch snapshot for $${rec.symbol}`);
      continue;
    }

    // Cross-check with Jupiter. This used to fire only when DexScreener looked
    // stale AND Jupiter was higher — so a price that was too HIGH (the dangerous
    // direction: fake peaks, stops that never trip) was never caught.
    const dexMult = current.priceUsd / rec.entryPrice;
    const needsCheck = (dexMult < 1.3 && dexMult > 0.7)          // looks stuck
      || current.priceConfidence === 'low'                        // pairs disagree
      || current.volume5m === 0;                                  // nothing traded
    if (needsCheck) {
      const solPrice = await getSolPrice();
      const jup = await jupiterGetPrice(rec.mint, solPrice);
      if (jup && jup.priceUsd > 0 && plausible(jup.priceUsd, current.priceUsd)) {
        const jupMult = jup.priceUsd / rec.entryPrice;
        const off = Math.abs(jupMult / dexMult - 1);
        if (off > 0.2) {
          log(`🔄 Price correction $${rec.symbol}: DexScreener ${dexMult.toFixed(2)}X vs Jupiter ${jupMult.toFixed(2)}X — trusting Jupiter`);
          current.priceUsd = jup.priceUsd;
          if (current.marketCap > 0 && dexMult > 0) current.marketCap = current.marketCap * (jupMult / dexMult);
        }
      }
    }

    const interval = CONFIG.PERFORMANCE_INTERVALS[rec.nextSnapshotIndex];
    const snapshot: PerformanceSnapshot = {
      intervalMin: interval,
      price: current.priceUsd,
      marketCap: current.marketCap,
      volume5m: current.volume5m,
      timestamp: Date.now(),
    };

    tracker.recordSnapshot(rec.mint, snapshot);
    tracker.updatePeak(rec.mint, current.priceUsd, current.marketCap);

    const paperTrade = paperTrader.getTrade(rec.mint);
    if (paperTrade) {
      const tradeExits = paperTrader.checkTrade(rec.mint, current.priceUsd, current.marketCap);
      for (const exit of tradeExits) {
        log(`💹 PAPER EXIT: $${rec.symbol} — ${exit.label} at ${exit.multiplierAtExit.toFixed(2)}X → ${exit.solReturned.toFixed(3)} SOL`);
      }
    }

    if (CONFIG.TRADE_ENABLED) {
      const events = await taskManager.checkAll(rec.mint, current.priceUsd, current.marketCap);
      for (const { task, exit } of events) {
        log(`💰 REAL EXIT [${task.name}]: $${rec.symbol} — ${exit.label} at ${exit.multiplierAtExit.toFixed(2)}X → ${exit.solReceived.toFixed(4)} SOL (tx: ${exit.txSignature.slice(0, 16)}...)`);
      }
    }

    const pct = ((current.priceUsd - rec.entryPrice) / rec.entryPrice) * 100;
    const label = interval < 60 ? `${interval}m` : `${interval / 60}h`;
    const emoji = pct >= 0 ? '🟢' : '🔴';
    log(`${emoji} $${rec.symbol} ${label}: ${fmtPct(pct)} (${fmtUsd(current.priceUsd)})`);

    const coin: PumpFunCoin = {
      mint: rec.mint,
      name: rec.name,
      symbol: rec.symbol,
      image_uri: rec.imageUri,
      isTrendingPaid: true,
    };
    const entryMarket: MarketData = {
      mint: rec.mint,
      priceUsd: rec.entryPrice,
      priceNative: 0,
      volume5m: rec.entryVolume5m,
      volume1h: 0, volume6h: 0, volume24h: 0,
      marketCap: rec.entryMC, fdv: rec.entryMC, liquidity: 0, liquiditySol: 0,
      buys5m: 0, sells5m: 0, buys1h: 0, sells1h: 0,
      priceChange5m: 0, priceChange1h: 0, priceChange6h: 0, priceChange24h: 0,
      pairAddress: '', pairUrl: '', dexId: '', pairCreatedAt: 0,
    };

    await updateWithPerformance(rec.alertMessageId, coin, entryMarket, rec.snapshots, {
      currentPrice: current.priceUsd,
      currentMC: current.marketCap,
      peakPrice: rec.peakPrice,
      peakMC: rec.peakMC,
      peakMultiplier: rec.peakMultiplier,
    });
  }

  // ─── 2. Milestone checking (2x, 3x, 5x, 10x…) ───
  const now = Date.now();
  if (now - lastMilestoneCheck >= CONFIG.MILESTONE_CHECK_INTERVAL_MS) {
    lastMilestoneCheck = now;

    const allCalls = tracker.getActiveCalls();
    if (allCalls.length > 0) {
      const mints = allCalls.map(r => r.mint);
      const marketData = await fetchBatchMarketData(mints);

      const solPrice = await getSolPrice();

      for (const rec of allCalls) {
        const market = marketData.get(rec.mint);
        // Without a positive entry price every multiple below is Infinity or NaN,
        // and those propagate into peaks, milestones and Discord embeds.
        if (!market || !(market.priceUsd > 0) || !(rec.entryPrice > 0)) continue;

        const ageMs = now - rec.entryTime;
        const dexMult = market.priceUsd / rec.entryPrice;
        const isRecent = ageMs < 7 * 24 * 60 * 60 * 1000;
        const nearMilestone = CONFIG.MILESTONES.some(m =>
          !rec.hitMilestones.some(h => h.multiplier === m) && dexMult >= m * 0.7
        );

        if (isRecent || nearMilestone) {
          const jup = await jupiterGetPrice(rec.mint, solPrice);
          if (jup && jup.priceUsd > 0 && plausible(jup.priceUsd, market.priceUsd)) {
            const jupMult = jup.priceUsd / rec.entryPrice;
            // Correct in BOTH directions — an inflated price fakes milestones.
            if (Math.abs(jupMult / dexMult - 1) > 0.2) {
              market.priceUsd = jup.priceUsd;
              if (market.marketCap > 0 && dexMult > 0) {
                market.marketCap = market.marketCap * (jupMult / dexMult);
              }
            }
          }
        }

        const peakBefore = rec.peakMultiplier;
        tracker.updatePeak(rec.mint, market.priceUsd, market.marketCap);

        // Detect spikes between polls using DexScreener's 5m priceChange.
        // If the coin's 5m change is way higher than what we'd expect from
        // (current price / poll-time price), it pumped & dumped between checks.
        // Use the "shadow peak" implied by 5m high to update peak.
        if (market.priceChange5m > 30 && rec.entryPrice > 0) {
          // Estimate peak in last 5 min: current * (1 + change/100) ≈ what it WAS 5m ago,
          // but the peak was likely between then and now. Use the higher of:
          //   - current price * (1 + max(change, 0)/100) [if it's been rising]
          //   - current price [if change is positive, peak was at least current]
          // Simpler: if 5m change > 30%, assume there was a spike to at least
          // current * (1 + change/200) — half the swing as a peak proxy.
          const impliedPeak = market.priceUsd * (1 + market.priceChange5m / 200);
          if (impliedPeak > rec.peakPrice) {
            const impliedMC = rec.peakMC > 0 ? rec.peakMC * (impliedPeak / rec.peakPrice) : market.marketCap * (impliedPeak / market.priceUsd);
            tracker.updatePeak(rec.mint, impliedPeak, impliedMC);
          }
        }

        const peakAfter = rec.peakMultiplier;
        const peakChanged = peakAfter > peakBefore;

        // Live-edit logic:
        //   - If peak rose: update (throttled to >=30s between)
        //   - Else if last edit >180s ago AND we're still in tracking window: refresh "now"
        if (rec.alertMessageId && rec.alertMessageId !== 'pending' && ageMs < LIVE_EDIT_TRACKING_WINDOW_MS) {
          const lastEdit = lastLiveEdit.get(rec.mint) ?? 0;
          const gapSinceLast = now - lastEdit;
          const shouldUpdate =
            (peakChanged && gapSinceLast >= LIVE_EDIT_PEAK_GAP_MS) ||
            (gapSinceLast >= LIVE_EDIT_REFRESH_GAP_MS);

          if (shouldUpdate) {
            lastLiveEdit.set(rec.mint, now);
            const coinForUpdate: PumpFunCoin = {
              mint: rec.mint, name: rec.name, symbol: rec.symbol, image_uri: rec.imageUri, isTrendingPaid: true,
            };
            const entryMarketForUpdate: MarketData = {
              mint: rec.mint, priceUsd: rec.entryPrice, priceNative: 0,
              volume5m: rec.entryVolume5m, volume1h: 0, volume6h: 0, volume24h: 0,
              marketCap: rec.entryMC, fdv: rec.entryMC, liquidity: 0, liquiditySol: 0,
              buys5m: 0, sells5m: 0, buys1h: 0, sells1h: 0,
              priceChange5m: 0, priceChange1h: 0, priceChange6h: 0, priceChange24h: 0,
              pairAddress: '', pairUrl: '', dexId: '', pairCreatedAt: 0,
            };
            updateWithPerformance(rec.alertMessageId, coinForUpdate, entryMarketForUpdate, rec.snapshots, {
              currentPrice: market.priceUsd,
              currentMC: market.marketCap,
              peakPrice: rec.peakPrice,
              peakMC: rec.peakMC,
              peakMultiplier: rec.peakMultiplier,
            }).catch(() => {});
          }
        }

        const paperTrade = paperTrader.getTrade(rec.mint);
        if (paperTrade) {
          const tradeExits = paperTrader.checkTrade(rec.mint, market.priceUsd, market.marketCap);
          for (const exit of tradeExits) {
            log(`💹 PAPER EXIT: $${rec.symbol} — ${exit.label} at ${exit.multiplierAtExit.toFixed(2)}X → ${exit.solReturned.toFixed(3)} SOL`);
          }
        }

        if (CONFIG.TRADE_ENABLED) {
          const events = await taskManager.checkAll(rec.mint, market.priceUsd, market.marketCap);
          for (const { task, exit } of events) {
            log(`💰 REAL EXIT [${task.name}]: $${rec.symbol} — ${exit.label} at ${exit.multiplierAtExit.toFixed(2)}X → ${exit.solReceived.toFixed(4)} SOL (tx: ${exit.txSignature.slice(0, 16)}...)`);
          }
        }

        const newHits = tracker.checkMilestones(rec.mint, market.priceUsd, market.marketCap);

        for (const hit of newHits) {
          log(
            `🚀 MILESTONE: $${rec.symbol} hits ${hit.multiplier}X! ` +
              `Entry ${fmtUsd(rec.entryMC)} → ${fmtUsd(market.marketCap)}`,
          );

          const msgId = await sendMilestoneAlert(rec, hit.multiplier, market.priceUsd, market.marketCap);
          if (msgId) {
            tracker.setMilestoneMessageId(rec.mint, hit.multiplier, msgId);
            log(`📨 Milestone ${hit.multiplier}X alert sent for $${rec.symbol}`);
          }
        }
      }
    }
  }

  // ─── 3. Leaderboard posts (1h, 6h, 12h, 24h, 7d) ───
  const now2 = Date.now();
  for (const interval of CONFIG.LEADERBOARD_INTERVALS) {
    const lastPost = lastLeaderboardPost.get(interval.label) ?? 0;
    if (now2 - lastPost < interval.postEvery) continue;

    const calls = tracker.getCallsSince(interval.lookback);
    if (calls.length === 0) continue;

    const lbMints = calls.map(r => r.mint);
    const lbMarket = await fetchBatchMarketData(lbMints);

    const entries: LeaderboardEntry[] = [];
    for (const rec of calls) {
      const m = lbMarket.get(rec.mint);
      if (!m || rec.entryPrice === 0) continue;
      tracker.updatePeak(rec.mint, m.priceUsd, m.marketCap);
      entries.push({
        rec,
        currentMC: m.marketCap,
        multiplier: m.priceUsd / rec.entryPrice,
      });
    }

    if (entries.length === 0) continue;

    log(`📋 Posting ${interval.label} leaderboard (${entries.length} calls)`);
    const msgId = await sendLeaderboard(interval.label, entries);
    if (msgId) {
      lastLeaderboardPost.set(interval.label, now2);
      saveLbTimestamps({ leaderboard: Object.fromEntries(lastLeaderboardPost), monthlyDate: lastMonthlyLbDate });
      log(`📨 ${interval.label} leaderboard posted`);
    }
  }

  // ─── 4. Monthly top 10 leaderboard (daily at CONFIG.MONTHLY_LB_HOUR_UTC) ───
  const nowDate = new Date();
  const utcHour = nowDate.getUTCHours();
  const todayStr = `${nowDate.getUTCFullYear()}-${String(nowDate.getUTCMonth() + 1).padStart(2, '0')}-${String(nowDate.getUTCDate()).padStart(2, '0')}`;
  if (utcHour >= CONFIG.MONTHLY_LB_HOUR_UTC && lastMonthlyLbDate !== todayStr) {
    lastMonthlyLbDate = todayStr;
    saveLbTimestamps({ leaderboard: Object.fromEntries(lastLeaderboardPost), monthlyDate: lastMonthlyLbDate });
    const monthTrades = paperTrader.getMonthTrades();
    if (monthTrades.length > 0) {
      const openMints = monthTrades.filter(t => t.status === 'open').map(t => t.mint);
      const liveData = openMints.length > 0 ? await fetchBatchMarketData(openMints) : new Map();

      const monthLabel = nowDate.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const entries: MonthlyLeaderboardEntry[] = [];
      for (const trade of monthTrades) {
        const callRec = tracker.getByMint(trade.mint);
        const livePrice = liveData.get(trade.mint)?.priceUsd;
        entries.push({
          trade,
          peakMultiplier: callRec?.peakMultiplier ?? 1,
          currentPnl: paperTrader.currentPnl(trade.mint, livePrice),
        });
      }

      log(`📅 Posting monthly top 10 leaderboard for ${monthLabel} (${entries.length} trades)`);
      const msgId = await sendMonthlyLeaderboard(monthLabel, entries);
      if (msgId) log(`📨 Monthly leaderboard posted`);
    }
  }
}

// ── Fast position monitor (10s loop) ─────────────────────

async function positionMonitorLoop() {
  while (true) {
    if (!CONFIG.TRADE_ENABLED) {
      await new Promise(r => setTimeout(r, CONFIG.TRADE_MONITOR_INTERVAL_MS));
      continue;
    }

    // Real positions only — paper/shadow positions are priced by the DexScreener
    // maintenance loops; Jupiter quotes need raw token amounts real fills provide.
    const openPositions = taskManager.openPositions().filter(({ task }) => !task.paper);
    if (openPositions.length === 0) {
      await new Promise(r => setTimeout(r, CONFIG.TRADE_MONITOR_INTERVAL_MS));
      continue;
    }

    // Flat cadence — Jupiter quote pacing self-throttles, no need to add per-position lag
    const delay = CONFIG.TRADE_MONITOR_INTERVAL_MS;
    await new Promise(r => setTimeout(r, delay));

    try {
      for (const { task, pos } of openPositions) {
        // Use Jupiter quote for real-time pricing (no DexScreener lag)
        const solValue = await jupiterQuoteSol(pos.mint, pos.tokensRemaining);
        if (solValue === null) continue;

        // Derive current price from Jupiter quote
        // solValue = what we'd get selling remaining tokens
        // entryValue of remaining = entrySol * remainingPct
        const entryValue = pos.entrySol * pos.remainingPct;
        const mult = entryValue > 0 ? solValue / entryValue : 0;
        const currentPrice = mult * pos.entryPrice;
        const currentMC = mult * pos.entryMC;
        const pct = (mult - 1) * 100;

        const events = await taskManager.checkAll(pos.mint, currentPrice, currentMC);
        for (const { task: xTask, exit } of events) {
          log(`💰 REAL EXIT [${xTask.name}]: $${pos.symbol} — ${exit.label} at ${exit.multiplierAtExit.toFixed(2)}X → ${exit.solReceived.toFixed(4)} SOL (tx: ${exit.txSignature.slice(0, 16)}...)`);
        }

        // Also update paper trade if exists
        const paperTrade = paperTrader.getTrade(pos.mint);
        if (paperTrade) {
          const tradeExits = paperTrader.checkTrade(pos.mint, currentPrice, currentMC);
          for (const exit of tradeExits) {
            log(`💹 PAPER EXIT: $${pos.symbol} — ${exit.label} at ${exit.multiplierAtExit.toFixed(2)}X → ${exit.solReturned.toFixed(3)} SOL`);
          }
        }

        // Log position status every ~30s to avoid spam
        if (Date.now() % 30000 < delay + 1000) {
          const emoji = pct >= 0 ? '📈' : '📉';
          log(`${emoji} [${task.name}] $${pos.symbol}: ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% (${mult.toFixed(2)}X) — ${(pos.remainingPct * 100).toFixed(0)}% open — val ${solValue.toFixed(4)} SOL`);
        }
      }
    } catch (err: any) {
      console.error(`[Monitor] Error: ${err.message}`);
    }
  }
}

// ── External call sources (copy-trade another caller's channel) ──────────
// Polls each source channel over REST, extracts CAs from content/embeds/links,
// applies the source's MC + coin-age filters, then buys on tasks subscribed to it.

// Cursor persists across restarts — deploys used to consume the newest message as a
// fresh bookmark, silently eating any signal posted during the restart window.
const SOURCE_STATE_FILE = join(CONFIG.DATA_DIR, 'source-cursors.json');
const CATCHUP_WINDOW_MS = 6 * 60 * 1000;  // after downtime, act on signals at most this old

function loadSourceCursors(): Map<string, string> {
  try { return new Map(Object.entries(JSON.parse(readFileSync(SOURCE_STATE_FILE, 'utf-8')))); }
  catch { return new Map(); }
}
function saveSourceCursors(): void {
  try { writeFileSync(SOURCE_STATE_FILE, JSON.stringify(Object.fromEntries(sourceCursors), null, 2)); } catch {}
}

const sourceCursors = loadSourceCursors();       // channelId → last processed message id
const sourceSeenMints = new Set<string>();       // never buy the same mint twice per boot

/** Discord snowflake → epoch ms (no API call needed). */
function snowflakeTime(id: string): number {
  return Number(BigInt(id) >> 22n) + 1420070400000;
}

async function fetchChannelMessages(channelId: string, after?: string): Promise<any[]> {
  const qs = after ? `?after=${after}&limit=25` : '?limit=1';
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages${qs}`, {
    headers: { Authorization: `Bot ${CONFIG.DISCORD_BOT_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 80)}`);
  const data: any = await res.json();
  return Array.isArray(data) ? data : [];
}

let warnedNoContent = false;

async function externalSourceLoop() {
  if (!CONFIG.DISCORD_BOT_TOKEN) {
    log('⚠ External call sources disabled — DISCORD_BOT_TOKEN not set');
    return;
  }
  while (true) {
    await new Promise(r => setTimeout(r, 5_000));
    for (const source of sourceRegistry.enabled()) {
      // Only poll sources that at least one enabled task subscribes to
      const subscribers = taskManager.enabledTasks(source.id);
      if (subscribers.length === 0) continue;

      try {
        const cursor = sourceCursors.get(source.channelId);
        const msgs = await fetchChannelMessages(source.channelId, cursor);
        if (msgs.length === 0) continue;

        const newest = msgs.reduce((a, b) => (BigInt(a.id) > BigInt(b.id) ? a : b));
        sourceCursors.set(source.channelId, newest.id);
        saveSourceCursors();
        if (!cursor) {
          // Never-seen channel: bookmark only, don't backfill history
          log(`📡 Watching source "${source.name}" (#${source.channelId}) — ${subscribers.length} task(s) subscribed`);
          continue;
        }

        for (const msg of msgs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
          // After downtime, only act on recent signals — a 40-minute-old entry is stale
          const age = Date.now() - snowflakeTime(msg.id);
          if (age > CATCHUP_WINDOW_MS) {
            log(`⏭ ${source.name}: skipping ${Math.round(age / 60000)}m-old signal (stale after downtime)`);
            continue;
          }
          const kind = classifySignal(msg);
          const mints = extractMints(msg);

          // SELL signal → never buy. Optionally mirror the caller's exit.
          if (kind === 'sell') {
            for (const mint of mints) {
              if (!source.mirrorExits) continue;
              const held = taskManager.enabledTasks(source.id).some(t => {
                const p = taskManager.traderFor(t).getPosition(mint);
                return p?.status === 'open';
              });
              if (!held) continue;
              const m = await fetchSingleMarketData(mint);
              if (!m || m.priceUsd <= 0) continue;
              const n = await taskManager.mirrorExit(source.id, mint, m.priceUsd, m.marketCap, `${source.name} sell signal`);
              if (n > 0) log(`🚪 ${source.name} posted SELL for ${mint.slice(0, 8)}… — closed ${n} position(s)`);
              recordSourceEvent(source.name, mint, 'mirror-exit', `closed ${n} position(s)`);
            }
            continue;
          }
          if (mints.length === 0) {
            const emptyish = !msg.content && (msg.embeds ?? []).length === 0;
            if (emptyish && !warnedNoContent) {
              warnedNoContent = true;
              log(`⚠ Source "${source.name}": message content is empty — enable MESSAGE CONTENT INTENT in the Discord dev portal or CAs can't be read`);
            }
            continue;
          }

          for (const mint of mints) {
            if (sourceSeenMints.has(mint)) continue;
            sourceSeenMints.add(mint);

            const market = await fetchSingleMarketData(mint);
            if (!market || market.priceUsd <= 0) {
              log(`⏭ ${source.name}: ${mint.slice(0, 8)}… no market data — skipping`);
              recordSourceEvent(source.name, mint, 'skip', 'no market data');
              continue;
            }
            if (source.maxMc > 0 && market.marketCap > source.maxMc) {
              log(`⏭ ${source.name}: skipping ${mint.slice(0, 8)}… — MC ${fmtUsd(market.marketCap)} over ${fmtUsd(source.maxMc)} cap`);
              recordSourceEvent(source.name, mint, 'skip', `MC ${fmtUsd(market.marketCap)} > ${fmtUsd(source.maxMc)} cap`);
              continue;
            }
            if (source.maxAgeHours > 0 && market.pairCreatedAt > 0) {
              const ageH = (Date.now() - market.pairCreatedAt) / 3600_000;
              if (ageH > source.maxAgeHours) {
                log(`⏭ ${source.name}: skipping ${mint.slice(0, 8)}… — ${ageH.toFixed(1)}h old (max ${source.maxAgeHours}h)`);
                recordSourceEvent(source.name, mint, 'skip', `${ageH.toFixed(1)}h old > ${source.maxAgeHours}h`);
                continue;
              }
            }

            log(`⚡ ${source.name} CALL: ${mint.slice(0, 8)}… at ${fmtUsd(market.marketCap)} MC — buying on ${subscribers.length} task(s)`);
            const symbol = mint.slice(0, 6);
            const bought = await taskManager.buyAll(mint, symbol, symbol, market.priceUsd, market.marketCap, source.id);
            recordSourceEvent(source.name, mint, bought > 0 ? 'buy' : 'nofill',
              bought > 0 ? `${bought} task(s) filled at ${fmtUsd(market.marketCap)} MC` : `0 fills at ${fmtUsd(market.marketCap)} MC — check balance/entry size`);
            if (bought === 0) {
              log(`⚠ ${source.name}: no fills for ${mint.slice(0, 8)}… — check balances`);
            }
          }
        }
      } catch (err: any) {
        log(`⚠ Source "${source.name}" poll failed: ${err.message}`);
      }
    }
  }
}

// ── Candle capture (every 5 min) — stores the real minute path of each call
//    ~45min after it fires, so the strategy builder can backtest against what
//    actually happened instead of a peak model. Free API, never touches Helius.

async function candleCaptureLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, 5 * 60_000));
    try {
      const ready = tracker.getActiveCalls().filter(c => {
        const age = Date.now() - c.entryTime;
        return age > 45 * 60_000 && age < 7 * 24 * 3600_000 && !hasPath(c.mint);
      }).slice(0, 6);
      for (const c of ready) {
        const ok = await capturePath(c.mint, c.symbol, c.entryTime);
        if (ok) log(`🕯 Captured price path for $${c.symbol}`);
        await new Promise(r => setTimeout(r, 3000));   // GeckoTerminal rate limit
      }
    } catch (err: any) {
      console.error(`[Candles] ${err.message}`);
    }
  }
}

// ── Fast milestone loop (4s) — 2X/3X alerts fired on the 30s maintenance cycle,
//    so a spike was often announced after it had already faded. Recent calls are
//    where all the movement is, so they get their own tight loop.

const FAST_MILESTONE_WINDOW_MS = 3 * 60 * 60 * 1000;  // calls younger than 3h

async function fastMilestoneLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, 4_000));
    try {
      const fresh = tracker.getActiveCalls()
        .filter(c => Date.now() - c.entryTime < FAST_MILESTONE_WINDOW_MS && c.entryPrice > 0);
      if (fresh.length === 0) continue;

      const data = await fetchBatchMarketData(fresh.map(c => c.mint).slice(0, 30));
      for (const rec of fresh) {
        const m = data.get(rec.mint);
        if (!m || m.priceUsd <= 0) continue;

        tracker.updatePeak(rec.mint, m.priceUsd, m.marketCap);
        const hits = tracker.checkMilestones(rec.mint, m.priceUsd, m.marketCap);
        for (const hit of hits) {
          const mult = m.priceUsd / rec.entryPrice;
          log(`🚀 MILESTONE (fast): $${rec.symbol} hits ${hit.multiplier}X — live ${mult.toFixed(2)}X, ${fmtUsd(m.marketCap)} MC`);
          const msgId = await sendMilestoneAlert(rec, hit.multiplier, m.priceUsd, m.marketCap);
          if (msgId) tracker.setMilestoneMessageId(rec.mint, hit.multiplier, msgId);
        }
      }
    } catch (err: any) {
      console.error(`[FastMilestone] ${err.message}`);
    }
  }
}

// ── Real-position loop (1.5s) — REAL money gets its own fast lane.
//    The paper fleet shares a 5s batched sweep; live positions are checked far more
//    often and never queue behind 400 paper tasks.

/**
 * Is a second-opinion price close enough to the primary to be worth acting on?
 *
 * Two independent venues pricing the same token disagree by percent, not by orders
 * of magnitude. Anything outside 4x either way is a broken reading — a bad route, a
 * unit mistake, a dead pool — and must be discarded rather than allowed to overwrite
 * a good price. Without this, one malformed quote reported a live coin at -100% with
 * a market cap of five cents, and that number reached Discord.
 */
function plausible(candidate: number, reference: number): boolean {
  if (!(candidate > 0) || !(reference > 0)) return false;
  const r = candidate / reference;
  return r > 0.25 && r < 4;
}

// ── Blind-block alarm ───────────────────────────────────────
// Blocking what we cannot verify is correct, but it is indistinguishable from the
// scanner being broken unless someone says so. Five consecutive blind blocks means
// the RPC is degraded, not that every coin is a farm.
let blindBlocks = 0;
let lastBlindAlert = 0;

function noteBlindBlock(name: string): void {
  blindBlocks++;
  if (blindBlocks < 5) return;
  if (Date.now() - lastBlindAlert < 15 * 60_000) return;
  lastBlindAlert = Date.now();
  log(`🚨 ${blindBlocks} coins blocked as UNVERIFIABLE in a row — RPC likely degraded`);
  sendOpsAlert(
    `⚠️ **${blindBlocks} coins blocked in a row** because their holders could not be verified ` +
    `(most recent: ${name}). Calls are being suppressed on purpose, but a run this long usually ` +
    `means the RPC is failing rather than every coin being a farm. Check the Helius key.`,
    CONFIG.TRADES_WEBHOOK,
  ).catch(() => {});
}

/** Set every pass of the real-position loop. A stale value means exits are dead. */
export let realLoopHeartbeat = Date.now();

async function realPositionLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, CONFIG.REAL_CHECK_INTERVAL_MS));
    realLoopHeartbeat = Date.now();
    try {
      const real = taskManager.openPositions().filter(({ task }) => !task.paper);
      if (real.length === 0) continue;
      const mints = [...new Set(real.map(({ pos }) => pos.mint))];
      const data = await fetchBatchMarketData(mints);
      for (const mint of mints) {
        const m = data.get(mint);
        if (!m || m.priceUsd <= 0) continue;
        for (const task of taskManager.all().filter(t => !t.paper)) {
          const trader = taskManager.traderFor(task);
          if (trader.getPosition(mint)?.status !== 'open') continue;
          // Time-boxed: a single position must never be able to stall the loop that
          // manages every other position. A rejection here is logged and the loop
          // carries on; a hang used to take all exits down with it.
          const exits = await withTimeout(
            trader.checkPosition(mint, m.priceUsd, m.marketCap),
            60_000, `checkPosition ${task.name}/${mint.slice(0, 8)}`,
          ).catch((e: any) => {
            console.error(`[RealLoop] ${e.message}`);
            return [] as Awaited<ReturnType<typeof trader.checkPosition>>;
          });
          for (const exit of exits) {
            log(`💰 REAL EXIT [${task.name}]: $${trader.getPosition(mint)?.symbol ?? mint.slice(0, 8)} — ${exit.label} → ${exit.solReceived.toFixed(4)} SOL`);
            sendTradeActivity(task.name, 'sell', trader.getPosition(mint)?.symbol ?? mint.slice(0, 8), mint,
              `${exit.label} at **${exit.multiplierAtExit.toFixed(2)}X** → **+${exit.solReceived.toFixed(4)} SOL**`,
              exit.txSignature).catch(() => {});
          }
        }
      }
    } catch (err: any) {
      console.error(`[RealLoop] ${err.message}`);
    }
  }
}

// ── Reconciliation (every 2 min) — the book is a claim, the wallet is the truth.
//    Nothing here trusts what the bot recorded about itself.

/**
 * Pool-price observation (30s).
 *
 * Deliberately isolated from every trading decision: it subscribes, measures, and
 * reports, and nothing reads its output to size or exit a position. The reserve
 * maths is exact on some pools and 30% low on others — always low, which would trip
 * a stop early — so it earns its way into the trading path by being demonstrably
 * right in production first, not by looking right in a test.
 */
async function poolPriceLoop() {
  const { watchMint, pruneWatches, revalidate } = await import('./pool-price.js');
  let ticks = 0;
  while (true) {
    await new Promise(r => setTimeout(r, 30_000));
    try {
      const real = taskManager.openPositions().filter(({ task }) => !task.paper);
      const mints = new Set(real.map(({ pos }) => pos.mint));
      pruneWatches(mints);
      for (const m of mints) await watchMint(m);
      if (++ticks % 10 === 0 && mints.size) await revalidate();
    } catch (err: any) {
      console.error(`[PoolPrice] loop: ${err.message}`);
    }
  }
}

/**
 * Notice when the position loop itself stops.
 *
 * Every other safety layer assumes the loop is running. When it hung on 08-12
 * nothing reported it: the scanner kept calling, the dashboard kept serving, and a
 * live position sat 95% below its stop for 8 hours. A loop that has not ticked in
 * a minute is broken, and that is worth waking someone for.
 */
async function loopWatchdog() {
  let alerted = false;
  while (true) {
    await new Promise(r => setTimeout(r, 30_000));
    const stale = Date.now() - realLoopHeartbeat;
    if (stale > 60_000) {
      if (!alerted) {
        alerted = true;
        const open = taskManager.openPositions().filter(({ task }) => !task.paper).length;
        log(`🚨 POSITION LOOP STALLED — no tick for ${Math.round(stale / 1000)}s, ${open} live position(s) unmanaged`);
        sendOpsAlert(
          `🚨 **Position loop stalled** — no tick for ${Math.round(stale / 1000)}s. ` +
          `${open} live position(s) are currently **unmanaged: stops will not fire**. ` +
          `Redeploy to restart it, and sell manually if you are holding.`,
          CONFIG.TRADES_WEBHOOK,
        ).catch(() => {});
      }
    } else if (alerted) {
      alerted = false;
      log('✅ Position loop recovered');
      sendOpsAlert('✅ **Position loop recovered** — stops are being evaluated again.', CONFIG.TRADES_WEBHOOK).catch(() => {});
    }
  }
}

async function reconcileLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, 120_000));
    try {
      const results = await taskManager.reconcileAll();
      for (const r of results) {
        if (r.fixed.length) log(`🔧 [${r.task}] corrected from chain: ${r.fixed.join(', ')}`);
        if (r.ghosts.length) log(`👻 [${r.task}] position closed — wallet no longer holds ${r.ghosts.join(', ')}`);
        if (r.orphans.length) {
          log(`🚨 [${r.task}] UNTRACKED tokens in wallet: ${r.orphans.join(', ')}`);
          sendOpsAlert(`⚠️ **${r.task}** holds tokens no position is managing: ${r.orphans.join(', ')}. ` +
            `These have no stop and will not be sold automatically.`, CONFIG.TRADES_WEBHOOK).catch(() => {});
        }
      }
    } catch (err: any) {
      console.error(`[Reconcile] ${err.message}`);
    }
  }
}

// ── Stop watchdog (25s) — independent verification that stops actually execute.
//    The panic seller retries stops that FIRED. This catches the worse case: a stop
//    that never fired at all because the position stopped being priced (delisted
//    pool, feed gap, restart mid-trade). It prices every open position directly and
//    forces an exit on anything sitting below its stop.

const stopWatchAlerted = new Set<string>();

async function stopWatchdog() {
  while (true) {
    await new Promise(r => setTimeout(r, 25_000));
    try {
      const open = taskManager.openPositions();
      if (open.length === 0) { stopWatchAlerted.clear(); continue; }
      const mints = [...new Set(open.map(({ pos }) => pos.mint))];
      const data = await fetchBatchMarketData(mints);

      for (const { task, pos } of open) {
        const m = data.get(pos.mint);
        const stale = Date.now() - pos.entryTime > 10 * 60_000;

        // (a) no price data on a position we've held a while — we are flying blind
        if ((!m || m.priceUsd <= 0) && stale && !task.paper) {
          const key = `nofeed:${pos.mint}:${task.id}`;
          if (!stopWatchAlerted.has(key)) {
            stopWatchAlerted.add(key);
            log(`🚨 NO PRICE FEED for $${pos.symbol} [${task.name}] — stop cannot be evaluated`);
            sendOpsAlert(`No price feed for **$${pos.symbol}** [${task.name}] — the stop can't be evaluated, so the position is unmanaged. ` +
              `Check it manually: https://dexscreener.com/solana/${pos.mint}`, CONFIG.TRADES_WEBHOOK).catch(() => {});
          }
          continue;
        }
        if (!m || m.priceUsd <= 0) continue;

        // (b) price is at/below the stop but the position is still open → the stop
        //     didn't execute. Force it, loudly.
        const stopPrice = Math.max(pos.stopLossPrice, pos.trailingActive ? pos.trailingStopPrice : 0);
        if (stopPrice > 0 && m.priceUsd <= stopPrice && pos.remainingPct >= 0.001) {
          const mult = m.priceUsd / pos.entryPrice;
          log(`🚨 STOP NOT EXECUTED: $${pos.symbol} [${task.name}] at ${mult.toFixed(2)}X, stop ${(stopPrice / pos.entryPrice).toFixed(2)}X — forcing exit`);
          const events = await taskManager.checkAll(pos.mint, m.priceUsd, m.marketCap);
          if (events.length === 0 && !task.paper) {
            // checkAll didn't clear it — escalate straight to the panic seller
            await taskManager.panicSweep();
            const key = `stuck:${pos.mint}:${task.id}`;
            if (!stopWatchAlerted.has(key)) {
              stopWatchAlerted.add(key);
              sendOpsAlert(`⚠️ **$${pos.symbol}** [${task.name}] is **below its stop and did not sell** ` +
                `(now ${mult.toFixed(2)}X, stop ${(stopPrice / pos.entryPrice).toFixed(2)}X). Panic seller engaged — sell manually if it persists: ` +
                `https://pump.fun/${pos.mint}`, CONFIG.TRADES_WEBHOOK).catch(() => {});
            }
          }
        }
      }
    } catch (err: any) {
      console.error(`[Watchdog] ${err.message}`);
    }
  }
}

// ── Panic-sell loop (8s) — retries any stop that fired but never cleared.
//    Independent of price feeds: once a stop triggers, getting OUT is the only goal.

async function panicSellLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, 8_000));
    try {
      await taskManager.panicSweep();
    } catch (err: any) {
      console.error(`[Panic] Sweep error: ${err.message}`);
    }
  }
}

// ── DexScreener sweep (5s) — coarse but BATCHED price check across ALL open
//    positions (real + shadow) in one API call. Catches fast dumps between
//    Jupiter rounds and gives the shadow fleet fine-grained exit fidelity. ──

async function dexSweepLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, 3_000));
    try {
      const open = taskManager.openPositions();
      const pending = taskManager.pendingEntries();
      if (open.length === 0 && pending.length === 0) continue;
      const mints = [...new Set([...open.map(({ pos }) => pos.mint), ...pending.map(p => p.mint)])];
      const data = await fetchBatchMarketData(mints);
      for (const mint of mints) {
        const m = data.get(mint);
        if (!m || m.priceUsd <= 0) continue;
        // dip orders first — a fill this tick should then be managed by the exit engine
        await taskManager.checkPendingEntries(mint, m.priceUsd, m.marketCap);
        const events = await taskManager.checkAll(mint, m.priceUsd, m.marketCap);
        for (const { task, exit } of events) {
          log(`${task.paper ? '📄 SHADOW' : '💰 REAL'} EXIT [${task.name}]: ${exit.label} at ${exit.multiplierAtExit.toFixed(2)}X → ${exit.solReceived.toFixed(4)} SOL`);
        }
      }
    } catch (err: any) {
      console.error(`[Sweep] Error: ${err.message}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────

/** One-shot: post the full last-30-days call report when SEND_MONTH_REPORT is set to a
 *  new value (e.g. "jul2026"). A marker file in DATA_DIR keeps restarts from re-sending —
 *  change the env value to trigger another report. */
async function maybeSendMonthReport() {
  const tag = process.env.SEND_MONTH_REPORT;
  if (!tag) return;
  const marker = join(CONFIG.DATA_DIR, `month-report-${tag}.sent`);
  if (existsSync(marker)) return;

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const calls = tracker.getActiveCalls().filter(c => c.entryTime >= cutoff);
  log(`📋 SEND_MONTH_REPORT=${tag} — sending full report for ${calls.length} calls from last 30 days`);

  // Refresh ATH peaks with live prices first (dead coins keep their stored peak)
  try {
    const marketData = await fetchBatchMarketData(calls.map(c => c.mint));
    for (const rec of calls) {
      const m = marketData.get(rec.mint);
      if (m && m.priceUsd > 0 && rec.entryPrice > 0) {
        const mult = m.priceUsd / rec.entryPrice;
        if (mult > rec.peakMultiplier) tracker.updatePeak(rec.mint, m.priceUsd, m.marketCap);
      }
    }
  } catch (err: any) {
    log(`⚠ Peak refresh failed (using stored peaks): ${err.message}`);
  }

  await sendFullCallListReport('Last 30 Days', calls);
  writeFileSync(marker, new Date().toISOString());
  log(`📋 Month report sent (${calls.length} calls)`);
}

async function main() {
  // Ensure data directory exists (important for Railway volumes)
  mkdirSync(CONFIG.DATA_DIR, { recursive: true });

  // Start dashboard HTTP server FIRST so Railway health check passes
  startDashboard();

  maybeSendMonthReport().catch(err => log(`⚠ Month report failed: ${err.message}`));
  registerSlashCommands().catch(() => {});

  console.log('');
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║       5-Minute Volume Scanner v2.0                ║');
  console.log('║       Pump.fun SOL Trending + Real Trading        ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Trending Source: @solearlytrending (Telegram)`);
  console.log(`  5m Vol (MC<20k): ${fmtUsd(CONFIG.MIN_5M_VOLUME_MICRO_MC)}`);
  console.log(`  5m Vol (MC<50k): ${fmtUsd(CONFIG.MIN_5M_VOLUME_LOW_MC)}`);
  console.log(`  5m Vol (MC≥50k): ${fmtUsd(CONFIG.MIN_5M_VOLUME_HIGH_MC)}`);
  console.log(`  Scan Interval:  ${CONFIG.SCAN_INTERVAL_MS / 1000}s`);
  console.log(`  Milestones:     ${CONFIG.MILESTONES.map(m => `${m}X`).join(', ')}`);
  console.log(
    `  Perf Tracking:  ${CONFIG.PERFORMANCE_INTERVALS.map(m => (m < 60 ? `${m}m` : `${m / 60}h`)).join(', ')}`,
  );
  console.log(`  Data File:      ${CONFIG.DATA_FILE}`);
  console.log('');

  // Trading info — one line per task
  if (CONFIG.TRADE_ENABLED) {
    console.log('  ── Real Trading (tasks) ──────────────────────');
    for (const task of taskManager.all()) {
      const kp = taskManager.keypairFor(task);
      let balance = 0;
      try { balance = await getSolBalance(kp); } catch {}
      console.log(`  ${task.enabled ? '🟢' : '⚪'} ${task.name.padEnd(16)} ${kp.publicKey.toBase58().slice(0, 8)}…  ${balance.toFixed(4)} SOL  ${describeStrategy(task.strategy)}`);
    }
    if (taskManager.all().length === 0) {
      console.log('  (no tasks — create one at /tasks on the dashboard)');
    }
    const wallet = getWallet();
    console.log(`  Open Positions: ${taskManager.openPositions().length} across ${taskManager.all().length} task(s)`);
    console.log('');
  } else {
    console.log('  Trading:        DISABLED (paper only)');
    console.log('');
  }

  // ── One-time fixup: correct stale peak for $SOMETHING ──
  // Called at $35.7K MC, hit $274K MC (~7.7X) but DexScreener returned stale data
  {
    const FIXUP_MINT = 'BbiFLmfnbZPhm6hUCo78h5kAoAtwsXSHYjvDUHeNbonk';
    const rec = tracker.getByMint(FIXUP_MINT);
    if (rec && rec.peakMultiplier < 5) {
      const knownPeakMC = 274_000;
      const knownPeakMult = knownPeakMC / rec.entryMC;
      const knownPeakPrice = rec.entryPrice * knownPeakMult;
      tracker.updatePeak(FIXUP_MINT, knownPeakPrice, knownPeakMC);
      log(`✅ Fixed $${rec.symbol} peak: was ${rec.peakMultiplier.toFixed(1)}X → ${knownPeakMult.toFixed(1)}X (known ATH $274K MC)`);

      // Send missed milestone alerts (2X, 3X, 5X)
      const alreadyHit = new Set(rec.hitMilestones.map(m => m.multiplier));
      for (const target of CONFIG.MILESTONES) {
        if (knownPeakMult >= target && !alreadyHit.has(target)) {
          const hitPrice = rec.entryPrice * target;
          const hitMC = rec.entryMC * target;
          log(`🚀 MISSED MILESTONE: $${rec.symbol} hit ${target}X! Entry ${fmtUsd(rec.entryMC)} → ${fmtUsd(hitMC)}`);
          const msgId = await sendMilestoneAlert(rec, target, hitPrice, hitMC);
          if (msgId) {
            tracker.setMilestoneMessageId(FIXUP_MINT, target, msgId);
            rec.hitMilestones.push({ multiplier: target, price: hitPrice, marketCap: hitMC, timestamp: Date.now() });
            log(`📨 Milestone ${target}X alert sent for $${rec.symbol}`);
          }
        }
      }
    }
  }

  if (tracker.size > 0) {
    log(`Loaded ${tracker.size} previous calls — milestone tracking continues`);
  }
  log('Starting fast scan loop (15s) + maintenance loop (30s)…');
  if (CONFIG.TRADE_ENABLED) {
    log(`Starting position monitor (${CONFIG.TRADE_MONITOR_INTERVAL_MS / 1000}s interval)…`);
  }
  console.log('');



  // Fix any position whose entry was recorded at the trigger price instead of the fill
  taskManager.repairAll().catch(err => console.error(`[Repair] ${err.message}`));

  candleCaptureLoop().catch(err => console.error(`[Candles] Fatal: ${err.message}`));

  // Milestone alerts run regardless of whether trading is enabled
  fastMilestoneLoop().catch(err => {
    console.error(`[FastMilestone] Fatal: ${err.message}`);
  });

  // Launch the fast position monitor + batched price sweep in parallel
  if (CONFIG.TRADE_ENABLED) {
    positionMonitorLoop().catch(err => {
      console.error(`[Monitor] Fatal: ${err.message}`);
    });
    dexSweepLoop().catch(err => {
      console.error(`[Sweep] Fatal: ${err.message}`);
    });
    externalSourceLoop().catch(err => {
      console.error(`[Sources] Fatal: ${err.message}`);
    });
    panicSellLoop().catch(err => {
      console.error(`[Panic] Fatal: ${err.message}`);
    });
    stopWatchdog().catch(err => {
      console.error(`[Watchdog] Fatal: ${err.message}`);
    });
    reconcileLoop().catch(err => {
      console.error(`[Reconcile] Fatal: ${err.message}`);
    });
    realPositionLoop().catch(err => {
      console.error(`[RealLoop] Fatal: ${err.message}`);
    });
    poolPriceLoop().catch(err => {
      console.error(`[PoolPrice] Fatal: ${err.message}`);
    });
    loopWatchdog().catch(err => {
      console.error(`[LoopWatchdog] Fatal: ${err.message}`);
    });
  }

  // Fast scan loop — Telegram + alert + buy (15s, never blocked by milestones)
  const fastLoop = async () => {
    while (true) {
      try {
        await fastScanCycle();
      } catch (err: any) {
        log(`❌ Scan error: ${err.message}`);
        if (err.stack) console.error(err.stack);
      }
      await new Promise(r => setTimeout(r, 10_000));
    }
  };

  // Slow maintenance loop — snapshots, milestones, leaderboards (30s, independent)
  const maintenanceLoop = async () => {
    // Small initial delay so first scan runs first
    await new Promise(r => setTimeout(r, 5_000));
    while (true) {
      try {
        await maintenanceCycle();
      } catch (err: any) {
        log(`❌ Maintenance error: ${err.message}`);
        if (err.stack) console.error(err.stack);
      }

      if (tracker.size > 0) {
        log(`📋 ${tracker.size} total calls | ${tracker.activeSnapshotCount} awaiting snapshots`);
      }
      console.log('');
      await new Promise(r => setTimeout(r, CONFIG.MILESTONE_CHECK_INTERVAL_MS));
    }
  };

  // Run both loops concurrently — scan is never blocked by slow milestone checks
  await Promise.all([fastLoop(), maintenanceLoop()]);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
