import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG } from './config.js';
import { scrapeTrendingPosts } from './telegram.js';
import { fetchCoinDetails } from './pumpfun.js';
import { fetchBatchMarketData, fetchSingleMarketData, getSolPrice, type MarketData } from './dexscreener.js';
import { sendAlert, updateWithPerformance, sendMilestoneAlert, sendLeaderboard, sendMonthlyLeaderboard, fmtUsd, fmtPct, type LeaderboardEntry, type MonthlyLeaderboardEntry } from './discord.js';
import { PerformanceTracker, type PerformanceSnapshot } from './tracker.js';
import { PaperTrader } from './paper-trader.js';
import { Trader } from './trader.js';
import { getWallet, getSolBalance } from './wallet.js';
import { checkBundle } from './bundle-check.js';
import { checkSmartWallets } from './wallet-filter.js';
import { jupiterQuoteSol, jupiterGetPrice } from './jupiter.js';
import { startDashboard } from './dashboard.js';
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
        '1 Hour': now, '6 Hours': now, '12 Hours': now,
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
const trader = new Trader();
const seenTgMsgIds = new Set<string>();
let lastMilestoneCheck = 0;
const lastLeaderboardPost = new Map<string, number>(Object.entries(_lbTs.leaderboard));
let lastMonthlyLbDate = _lbTs.monthlyDate;

// ── Helpers ─────────────────────────────────────────────────

function log(msg: string) {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// ── Fast scan loop — Telegram scrape + alert + buy (never blocked by milestones) ──

async function fastScanCycle() {
  const posts = await scrapeTrendingPosts();

  if (posts.length === 0) {
    log('⚠ No trending posts from Telegram');
    return;
  }

  const newPosts = posts.filter(p => !seenTgMsgIds.has(p.messageId));
  for (const p of posts) seenTgMsgIds.add(p.messageId);

  const seenMintsThisCycle = new Set<string>();
  const freshPosts = posts.filter(p => {
    if (tracker.hasBeenCalled(p.mint) || seenMintsThisCycle.has(p.mint)) return false;
    seenMintsThisCycle.add(p.mint);
    return true;
  });

  if (newPosts.length > 0) {
    log(`📡 ${posts.length} trending posts, ${newPosts.length} new, ${freshPosts.length} never-called`);
  }

  if (freshPosts.length === 0) return;

  const mints = [...new Set(freshPosts.map(p => p.mint))];
  const marketData = await fetchBatchMarketData(mints);
  log(`📊 DexScreener data for ${marketData.size}/${mints.length} fresh trending coins`);

  let alertCount = 0;
  for (const post of freshPosts) {
    const market = marketData.get(post.mint);
    if (!market) continue;
    const volThreshold = market.marketCap < CONFIG.MICRO_MC_THRESHOLD
      ? CONFIG.MIN_5M_VOLUME_MICRO_MC
      : market.marketCap < CONFIG.LOW_MC_THRESHOLD
        ? CONFIG.MIN_5M_VOLUME_LOW_MC
        : CONFIG.MIN_5M_VOLUME_HIGH_MC;
    if (market.volume5m < volThreshold) continue;

    if (market.priceChange5m < -25) {
      log(`⚠ DUMP — skipping ${post.name}: 5m change ${market.priceChange5m.toFixed(1)}% (actively dumping)`);
      continue;
    }

    if (tracker.hasBeenCalled(post.mint)) continue;

    const bundle = await checkBundle(post.mint);
    if (!bundle.safe) {
      log(`⚠ BUNDLED — skipping ${post.name}: ${bundle.details}`);
      continue;
    }
    if (bundle.totalChecked > 0) {
      log(`✅ Bundle check passed: ${bundle.details}`);
    }

    const smartCheck = await checkSmartWallets(post.mint);
    if (smartCheck.checked > 0 && !smartCheck.held) {
      log(`⚠ NO SMART HOLDERS — skipping ${post.name}: 0/${smartCheck.checked} tracked wallets hold this token`);
      continue;
    }
    if (smartCheck.holders > 0) {
      log(`✅ Smart wallet check passed: ${smartCheck.holders} tracked wallet(s) holding`);
    }

    if (market.marketCap >= CONFIG.MIN_GLOBAL_FEES_MC) {
      const solPrice = await getSolPrice();
      const volumeSol = market.volume24h / solPrice;
      const estFees = volumeSol * CONFIG.PUMPSWAP_FEE_RATE;
      if (estFees < CONFIG.MIN_GLOBAL_FEES_SOL) {
        log(`⚠ LOW FEES — skipping ${post.name}: est ${estFees.toFixed(2)} SOL fees (need ≥${CONFIG.MIN_GLOBAL_FEES_SOL}) — vol ${volumeSol.toFixed(1)} SOL for ${fmtUsd(market.marketCap)} MC`);
        continue;
      }
      log(`✅ Fee check passed: est ${estFees.toFixed(2)} SOL fees (vol ${volumeSol.toFixed(1)} SOL)`);
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

    log(
      `🔔 ALERT: ${coin.name} ($${coin.symbol}) — ` +
        `5m vol ${fmtUsd(market.volume5m)} — MC ${fmtUsd(market.marketCap)} — ` +
        `Price ${fmtUsd(market.priceUsd)} — SOL TRENDING ✅`,
    );

    const adjustedMarket = { ...market, priceUsd: market.priceUsd * 0.97, marketCap: market.marketCap * 0.97 };

    const paperTrade = paperTrader.openTrade(
      coin.mint, coin.symbol, coin.name, adjustedMarket.priceUsd, adjustedMarket.marketCap,
    );

    const discordMsgId = await sendAlert(coin, adjustedMarket);
    if (discordMsgId) {
      tracker.add(coin, adjustedMarket, discordMsgId);
      alertCount++;
      log(`📨 Alert sent for $${coin.symbol} — paper trade opened at ${fmtUsd(market.marketCap)} MC`);

      // Execute real buy via Jupiter
      if (CONFIG.TRADE_ENABLED) {
        log(`[Trader] 🔄 Attempting buy for $${coin.symbol}...`);
        const realPos = await trader.buy(coin.mint, coin.symbol, coin.name, market.priceUsd, market.marketCap);
        if (realPos) {
          log(`💰 REAL BUY: $${coin.symbol} — ${realPos.entrySol} SOL → ${realPos.tokensReceived} tokens (tx: ${realPos.entryTx.slice(0, 16)}...)`);
        } else {
          log(`⚠ BUY SKIPPED/FAILED for $${coin.symbol} — check [Trader] logs above for reason`);
        }
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

    const solPrice = await getSolPrice();
    const jup = await jupiterGetPrice(rec.mint, solPrice);
    if (jup && jup.priceUsd > 0) {
      const dexMult = current.priceUsd / rec.entryPrice;
      const jupMult = jup.priceUsd / rec.entryPrice;
      if (jupMult > dexMult * 1.2) {
        log(`🔄 Jupiter price correction for $${rec.symbol}: DexScreener ${dexMult.toFixed(2)}X vs Jupiter ${jupMult.toFixed(2)}X — using Jupiter`);
        current.priceUsd = jup.priceUsd;
        if (current.marketCap > 0 && dexMult > 0) {
          current.marketCap = current.marketCap * (jupMult / dexMult);
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
      const realExits = await trader.checkPosition(rec.mint, current.priceUsd, current.marketCap);
      for (const exit of realExits) {
        log(`💰 REAL EXIT: $${rec.symbol} — ${exit.label} at ${exit.multiplierAtExit.toFixed(2)}X → ${exit.solReceived.toFixed(4)} SOL (tx: ${exit.txSignature.slice(0, 16)}...)`);
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

    await updateWithPerformance(rec.alertMessageId, coin, entryMarket, rec.snapshots);
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
        if (!market || market.priceUsd === 0) continue;

        const ageMs = now - rec.entryTime;
        const dexMult = market.priceUsd / rec.entryPrice;
        const isRecent = ageMs < 7 * 24 * 60 * 60 * 1000;
        const nearMilestone = CONFIG.MILESTONES.some(m =>
          !rec.hitMilestones.some(h => h.multiplier === m) && dexMult >= m * 0.7
        );

        if (isRecent || nearMilestone) {
          const jup = await jupiterGetPrice(rec.mint, solPrice);
          if (jup && jup.priceUsd > 0) {
            const jupMult = jup.priceUsd / rec.entryPrice;
            if (jupMult > dexMult * 1.2) {
              market.priceUsd = jup.priceUsd;
              if (market.marketCap > 0 && dexMult > 0) {
                market.marketCap = market.marketCap * (jupMult / dexMult);
              }
            }
          }
        }

        tracker.updatePeak(rec.mint, market.priceUsd, market.marketCap);

        const paperTrade = paperTrader.getTrade(rec.mint);
        if (paperTrade) {
          const tradeExits = paperTrader.checkTrade(rec.mint, market.priceUsd, market.marketCap);
          for (const exit of tradeExits) {
            log(`💹 PAPER EXIT: $${rec.symbol} — ${exit.label} at ${exit.multiplierAtExit.toFixed(2)}X → ${exit.solReturned.toFixed(3)} SOL`);
          }
        }

        if (CONFIG.TRADE_ENABLED) {
          const realExits = await trader.checkPosition(rec.mint, market.priceUsd, market.marketCap);
          for (const exit of realExits) {
            log(`💰 REAL EXIT: $${rec.symbol} — ${exit.label} at ${exit.multiplierAtExit.toFixed(2)}X → ${exit.solReceived.toFixed(4)} SOL (tx: ${exit.txSignature.slice(0, 16)}...)`);
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

    const openPositions = trader.getOpenPositions();
    if (openPositions.length === 0) {
      await new Promise(r => setTimeout(r, CONFIG.TRADE_MONITOR_INTERVAL_MS));
      continue;
    }

    // 1 position = 2s, 2 = 3s, 3 = 4s, etc. (base 2s + 1s per extra position)
    const delay = CONFIG.TRADE_MONITOR_INTERVAL_MS + (openPositions.length - 1) * 1000;
    await new Promise(r => setTimeout(r, delay));

    try {
      for (const pos of openPositions) {
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

        const realExits = await trader.checkPosition(pos.mint, currentPrice, currentMC);
        for (const exit of realExits) {
          log(`💰 REAL EXIT: $${pos.symbol} — ${exit.label} at ${exit.multiplierAtExit.toFixed(2)}X → ${exit.solReceived.toFixed(4)} SOL (tx: ${exit.txSignature.slice(0, 16)}...)`);
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
          log(`${emoji} $${pos.symbol} position: ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% (${mult.toFixed(2)}X) — ${(pos.remainingPct * 100).toFixed(0)}% open — val ${solValue.toFixed(4)} SOL`);
        }
      }
    } catch (err: any) {
      console.error(`[Monitor] Error: ${err.message}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  // Ensure data directory exists (important for Railway volumes)
  mkdirSync(CONFIG.DATA_DIR, { recursive: true });

  // Start dashboard HTTP server FIRST so Railway health check passes
  startDashboard();

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

  // Trading info
  if (CONFIG.TRADE_ENABLED) {
    const wallet = getWallet();
    let balance = 0;
    try { balance = await getSolBalance(); } catch {}
    console.log('  ── Real Trading ──────────────────────────────');
    console.log(`  Wallet:         ${wallet.publicKey.toBase58()}`);
    console.log(`  Balance:        ${balance.toFixed(4)} SOL`);
    console.log(`  Entry Size:     ${(CONFIG.TRADE_ENTRY_PCT * 100).toFixed(0)}% of balance (${(balance * CONFIG.TRADE_ENTRY_PCT).toFixed(4)} SOL)`);
    console.log(`  Slippage:       ${CONFIG.TRADE_SLIPPAGE_BPS / 100}%`);
    console.log(`  Priority Fee:   ${CONFIG.TRADE_PRIORITY_FEE_LAMPORTS / 1e9} SOL`);
    console.log(`  TP Ladder:      ${CONFIG.TRADE_TP1_MULT}X/${CONFIG.TRADE_TP2_MULT}X/${CONFIG.TRADE_TP3_MULT}X (${CONFIG.TRADE_TP1_SELL * 100}%/${CONFIG.TRADE_TP2_SELL * 100}%/${CONFIG.TRADE_TP3_SELL * 100}%)`);
    console.log(`  Stop Loss:      -${Math.round((1 - CONFIG.TRADE_STOP_LOSS_PCT) * 100)}% (moves to BE after TP1)`);
    console.log(`  Trailing:       -${CONFIG.TRADE_TRAILING_DROP * 100}% from ATH after TP3`);
    console.log(`  Open Positions: ${trader.getOpenPositions().length}`);
    if (balance < CONFIG.TRADE_MIN_SOL_BALANCE) {
      console.log(`  ⚠️  LOW BALANCE — fund wallet to enable trading!`);
    }
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



  // Launch the fast position monitor in parallel
  if (CONFIG.TRADE_ENABLED) {
    positionMonitorLoop().catch(err => {
      console.error(`[Monitor] Fatal: ${err.message}`);
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
      await new Promise(r => setTimeout(r, 15_000));
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
