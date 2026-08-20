import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { truePrice } from './price-oracle.js';
import { snapshotFrom } from './filter-lab.js';
import { deepHolderScan } from './deep-holders.js';
import { join } from 'path';
import { CONFIG } from './config.js';
import { scrapeAllChannels } from './telegram.js';
import { fetchCoinDetails } from './pumpfun.js';
import { fetchBatchMarketData, fetchSingleMarketData, getSolPrice, type MarketData } from './dexscreener.js';
import { sendAlert, updateWithPerformance, sendMilestoneAlert, sendLeaderboard, sendMonthlyLeaderboard, sendFullCallListReport, fmtUsd, fmtPct, type LeaderboardEntry, type MonthlyLeaderboardEntry } from './discord.js';
import { PerformanceTracker, type PerformanceSnapshot } from './tracker.js';
import { registerRuntime } from './runtime.js';
import { PaperTrader } from './paper-trader.js';
import { taskManager } from './tasks.js';
import { getWallet, getSolBalance, withTimeout, mintSupply } from './wallet.js';
import { describeStrategy } from './strategy.js';
import { checkBundle } from './bundle-check.js';
import { checkSmartWallets } from './wallet-filter.js';
import { checkSocials } from './socials.js';
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
/**
 * Record a rejected coin — to memory for the dashboard, and to disk so the
 * decision can be judged later.
 *
 * The in-memory ring resets on every deploy, which made the only question that
 * matters about a filter unanswerable: did blocking this cost us anything? A
 * filter that blocks rugs and a filter that blocks winners look identical from
 * the inside. Persisting the skip lets its outcome be checked afterwards.
 */
const SKIPS_FILE = `${CONFIG.DATA_DIR}/skips.json`;
interface SkipRecord {
  mint: string; name: string; reason: string; details: string;
  marketCap: number; timestamp: number;
  /** Without this a creator's rejected launches are invisible, and their history
   *  reads as cleaner than it is — we would only see the ones we fell for. */
  creator?: string;
  entryPrice?: number;      // price when we passed, so a peak means something
  peakMultiplier?: number;  // running max across checks — what we missed
  lastMultiplier?: number;  // most recent spot — what it settled at
  checks?: number;          // how many samples the peak is built from
  checkedAt?: number;
}
let skipHistory: SkipRecord[] = [];
try { skipHistory = JSON.parse(readFileSync(SKIPS_FILE, 'utf-8')); } catch { skipHistory = []; }

/**
 * Graded rejections, for anything that wants to judge a filter by its results.
 *
 * The records have been written and back-filled with outcomes for a while and were
 * readable from nowhere — no endpoint, no page. A filter's cost is the winners it
 * blocked, and that number existed on disk while every discussion about thresholds
 * ran on opinion.
 */
export function gradedSkips(): SkipRecord[] {
  return skipHistory.filter(s => s.peakMultiplier !== undefined);
}

function saveSkips(): void {
  try {
    // A month is enough to judge a filter and keeps the file small.
    const cut = Date.now() - 30 * 86400_000;
    skipHistory = skipHistory.filter(s => s.timestamp >= cut).slice(-4000);
    writeFileSync(SKIPS_FILE, JSON.stringify(skipHistory));
  } catch { /* non-critical */ }
}

/**
 * Every bundle verdict, passed or blocked, with its metrics.
 *
 * The skip log only records coins that were rejected, which meant the shadow
 * slot-cluster check — which runs after every blocking test, so only on coins that
 * pass — wrote its findings to a console log and nowhere else. A detector whose
 * output cannot be reviewed is not evidence, and the whole point of shipping it in
 * shadow was to gather evidence before letting it block anything.
 *
 * Recording passes as well as blocks is also what makes the comparison possible:
 * "the cluster check fires on rugs and not on winners" needs the winners in the
 * file too.
 */
interface BundleObs {
  mint: string; name: string; passed: boolean; reason?: string;
  marketCap: number; entryPrice?: number; timestamp: number;
  slotCluster?: number; slotSpan?: number; slotFunder?: string;
  sameFunderPct?: number; freshWallets?: number; veterans?: number;
  devHoldPct?: number; lowBalPct?: number;
  peakMultiplier?: number;   // back-filled by the same grader the skip log uses
}
const BUNDLE_LOG_FILE = join(CONFIG.DATA_DIR, 'bundle-log.json');
let bundleLog: BundleObs[] = [];
try { bundleLog = JSON.parse(readFileSync(BUNDLE_LOG_FILE, 'utf-8')); } catch { bundleLog = []; }
export function getBundleLog(): BundleObs[] { return bundleLog; }

function recordBundleObs(post: { mint: string; name: string }, bundle: any, passed: boolean, reason: string | undefined, mc: number, price?: number): void {
  const m = bundle?.metrics ?? {};
  bundleLog.push({
    mint: post.mint, name: post.name, passed, reason,
    marketCap: mc, entryPrice: price, timestamp: Date.now(),
    slotCluster: m.slotClusterSize || undefined,
    slotSpan: m.slotClusterSpan,
    slotFunder: m.slotClusterFunder,
    sameFunderPct: m.sameFunderPct,
    freshWallets: m.freshWallets,
    veterans: m.veterans,
    devHoldPct: typeof m.devHoldPct === 'number' ? +m.devHoldPct.toFixed(2) : undefined,
    lowBalPct: m.lowBalPct,
  });
  try {
    const cut = Date.now() - 30 * 86400_000;
    bundleLog = bundleLog.filter(b => b.timestamp >= cut).slice(-4000);
    writeFileSync(BUNDLE_LOG_FILE, JSON.stringify(bundleLog));
  } catch { /* non-critical */ }
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
//
// Railway sends SIGTERM on every deploy and nothing caught it, so the process
// died wherever it happened to be standing. $DJT was called at 15:22:06 and the
// restart landed at 15:22:35: the call was written to calls.json, the buy never
// finished, and no buylog entry was left to say either had happened. It went 4.2x.
//
// A missed call is the mild version. The same signal arriving between a landed
// swap and the position being persisted leaves tokens in the wallet with nothing
// tracking them — no stop, no trail, and a reconciler that can only report the
// bag after the fact.
//
// So: stop starting new buys the moment the signal arrives, let the ones already
// running finish and persist, then exit.
let shuttingDown = false;
const inFlightBuys = new Set<Promise<unknown>>();

function trackBuy<T>(p: Promise<T>): Promise<T> {
  inFlightBuys.add(p);
  // Settle-tracking only; the caller still owns the result and any rejection.
  p.finally(() => inFlightBuys.delete(p)).catch(() => {});
  return p;
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] ${signal} — refusing new buys, ${inFlightBuys.size} still in flight`);
  // Railway's grace period before SIGKILL is 30s; stop well short of it so the
  // exit is ours and any final write lands.
  const deadline = Date.now() + 20_000;
  while (inFlightBuys.size > 0 && Date.now() < deadline) {
    await Promise.race([
      Promise.allSettled([...inFlightBuys]),
      new Promise(r => setTimeout(r, 500)),
    ]);
  }
  if (inFlightBuys.size > 0) {
    console.error(`[Shutdown] ${inFlightBuys.size} buy(s) unfinished at the deadline — exiting; the reconciler will surface any untracked bag`);
  } else {
    console.log('[Shutdown] every buy settled, exiting cleanly');
  }
  process.exit(0);
}

process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(0)); });
process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(0)); });

function recordSkip(post: { mint: string; name: string; creator?: string }, reason: string, details: string, mc: number, price?: number, market?: any, extra?: any) {
  // The snapshot is the whole point of the filter lab: candidates are evaluated when
  // the page is read, so a rule invented next week is scored against every coin
  // already seen instead of starting from nothing. Storing the verdict instead of
  // the inputs would mean a fresh month of waiting for each threshold tweak.
  const snap = market ? snapshotFrom(market, extra ?? {}) : undefined;
  const rec = { mint: post.mint, name: post.name, reason, details, marketCap: mc, timestamp: Date.now(), creator: post.creator, snap };
  skippedRing.push(rec);
  if (skippedRing.length > 200) skippedRing.shift();
  // LOW_VOL and COOLING_OFF used to be excluded here as "coins that were never
  // candidates". That reasoning is untestable by construction: LOW_VOL is the single
  // most common rejection the scanner makes, and excluding it meant the biggest
  // filter in the stack was the one with no evidence behind it. Asked how LOW_VOL
  // performs, the only honest answer was that we had never looked.
  //
  // RATE_CAP stays out. It is not a judgement about the coin — it fires when we have
  // already called too many this hour — so grading it measures our own throttle, not
  // the filter's taste, and it would be read as the former.
  if (reason !== 'RATE_CAP') {
    skipHistory.push({ ...rec, entryPrice: price });
    saveSkips();
  }
}

/**
 * Grade past rejections against what the coin actually did.
 *
 * Runs hourly and only looks at skips between 1 and 24 hours old — younger than
 * that and the coin has not had time to show its hand, older and it is settled.
 */
/** Last skip-grading pass: when, and what it found. Exposed on /api/health.
 *  Three correct fixes to this path changed nothing tonight and there was no way
 *  to tell a stalled loop from an empty one — so it now says. */
export let graderLastRun: { at: number; eligible: number; historySize: number } | null = null;

async function skipOutcomeLoop() {
  // Sleep-first meant the first grading pass came 60 minutes after boot, so a day
  // of frequent deploys graded nothing at all: every restart reset the timer before
  // it ever fired. 39 rows sat eligible and untouched while this looked like a
  // patient loop rather than a stalled one.
  //
  // Two minutes in is safe because eligibility is already gated on age — nothing
  // younger than 30 minutes is graded no matter how often this runs.
  let first = true;
  while (true) {
    await new Promise(r => setTimeout(r, first ? 120_000 : 3600_000));
    first = false;
    try {
      const now = Date.now();
      // Re-check across the window instead of once. One sample cannot express a
      // maximum, and the whole point of the field is what the coin reached.
      const due = skipHistory.filter(s =>
        s.entryPrice && s.entryPrice > 0 && (s.checks ?? 0) < 6 &&
        now - s.timestamp > 1800_000 && now - s.timestamp < 24 * 3600_000);
      graderLastRun = { at: now, eligible: due.length, historySize: skipHistory.length };
      if (!due.length) { log(`📋 Skip grader: 0 of ${skipHistory.length} rejections eligible`); continue; }
      for (let i = 0; i < due.length; i += 25) {
        const batch = due.slice(i, i + 25);
        const md = await fetchBatchMarketData(batch.map(s => s.mint));
        for (const s of batch) {
          const m = md.get(s.mint);
          // A single spot price is not a peak, and calling it one made every filter
          // verdict incomparable with the calls they are judged against: calls track
          // a running maximum, so a rejection graded on one sample at ~90 minutes was
          // being scored by a different measure under the same field name. Regrading
          // our own calls this way marks 54% of them as good rejections.
          //
          // Keep the running maximum, and record the spot separately so a coin that
          // doubled and came back is not filed as a death.
          const spot = m && m.priceUsd > 0 ? m.priceUsd / s.entryPrice! : 0;
          s.lastMultiplier = spot;
          s.peakMultiplier = Math.max(s.peakMultiplier ?? 0, spot);
          s.checkedAt = now;
          s.checks = (s.checks ?? 0) + 1;
        }
        await new Promise(r => setTimeout(r, 400));
      }
      saveSkips();
      log(`📋 Graded ${due.length} past rejection(s)`);
    } catch (err: any) {
      console.error(`[SkipOutcome] ${err.message}`);
    }
  }
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

  const posts = await scrapeAllChannels();

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
    if (!market) {
      // The one discard in this loop that left no trace. Every other rejection below
      // records its reason, so "why did it not buy X" is answerable — except when the
      // market lookup came back empty, which is common on a pair DexScreener has not
      // indexed yet, i.e. exactly the newest coins. Those vanished silently and the
      // skip log quietly under-counted itself.
      //
      // This is not a judgement about the coin, so it is recorded as its own reason
      // rather than folded in with the filters.
      recordSkip(post, 'NO_MARKET_DATA', 'no market data returned at scan time', 0);
      continue;
    }

    // Entry ceiling. A coin already at six figures has made its move; in the 7-day
    // sample nothing called above $100K reached 2x, median peak 1.06x.
    if (CONFIG.MAX_ENTRY_MC > 0 && market.marketCap > CONFIG.MAX_ENTRY_MC) {
      log(`⚠ HIGH_MC — skipping ${post.name}: ${fmtUsd(market.marketCap)} > ${fmtUsd(CONFIG.MAX_ENTRY_MC)} ceiling`);
      recordSkip(post, 'HIGH_MC', `${fmtUsd(market.marketCap)} > ${fmtUsd(CONFIG.MAX_ENTRY_MC)}`, market.marketCap, market.priceUsd, market);
      continue;
    }

    // No Twitter, no site, no Telegram — nobody intends to support this one.
    // Checked here because it is one cheap HTTP call and saves the bundle check's
    // ~20 RPC lookups on a coin we were never going to call.
    if (CONFIG.REQUIRE_SOCIALS) {
      const social = await checkSocials(post.mint);
      if (social.known && social.count === 0) {
        log(`⚠ NO_SOCIALS — skipping ${post.name}: no twitter, website or telegram`);
        recordSkip(post, 'NO_SOCIALS', 'no twitter / website / telegram', market.marketCap, market.priceUsd, market, { socials: 0 });
        continue;
      }
      if (!social.known) {
        // Not knowing is not the same as knowing there is nothing. Let it through
        // rather than let a pump.fun outage become a call drought.
        console.log(`[Socials] lookup failed for ${post.name} — allowing through`);
      }
    }

    const volThreshold = market.marketCap < CONFIG.MICRO_MC_THRESHOLD
      ? CONFIG.MIN_5M_VOLUME_MICRO_MC
      : market.marketCap < CONFIG.LOW_MC_THRESHOLD
        ? CONFIG.MIN_5M_VOLUME_LOW_MC
        : CONFIG.MIN_5M_VOLUME_HIGH_MC;
    if (market.volume5m < volThreshold) {
      recordSkip(post, 'LOW_VOL', `${fmtUsd(market.volume5m)} vol < ${fmtUsd(volThreshold)}`, market.marketCap, market.priceUsd, market);
      continue;
    }

    if (market.priceChange5m < -25) {
      log(`⚠ DUMP — skipping ${post.name}: 5m change ${market.priceChange5m.toFixed(1)}% (actively dumping)`);
      recordSkip(post, 'DUMP', `5m ${market.priceChange5m.toFixed(1)}%`, market.marketCap, market.priceUsd, market);
      continue;
    }

    // Buy/sell ratio — skip if sellers significantly outnumber buyers (momentum dying)
    if (market.sells5m > 0 && market.buys5m > 0) {
      const sellRatio = market.sells5m / market.buys5m;
      if (sellRatio > 1.3) {
        log(`⚠ HEAVY SELLING — skipping ${post.name}: ${market.buys5m}B/${market.sells5m}S (${sellRatio.toFixed(2)}x sells)`);
        recordSkip(post, 'HEAVY_SELLING', `${market.buys5m}B / ${market.sells5m}S (${sellRatio.toFixed(2)}x)`, market.marketCap, market.priceUsd, market);
        continue;
      }
    }

    // Trade count — require real activity, not 1 whale propping it up
    // (≥20 buys in last 5min = a buy every 15s on average)
    if (market.buys5m > 0 && market.buys5m < 20) {
      log(`⚠ LOW ACTIVITY — skipping ${post.name}: only ${market.buys5m} buys in 5m`);
      recordSkip(post, 'LOW_ACTIVITY', `${market.buys5m} buys in 5m`, market.marketCap, market.priceUsd, market);
      continue;
    }

    // Volume momentum — vol5m should be at least 15% of vol1h (last 5min concentrated)
    // If a coin had $100K vol last hour but only $5K in last 5min, momentum has died
    if (market.volume1h > 0 && market.volume5m > 0) {
      const concentration = market.volume5m / market.volume1h;
      if (concentration < 0.15) {
        log(`⚠ COOLING OFF — skipping ${post.name}: only ${(concentration*100).toFixed(0)}% of 1h vol in last 5m`);
        recordSkip(post, 'COOLING_OFF', `${(concentration*100).toFixed(0)}% of 1h vol in last 5m`, market.marketCap, market.priceUsd, market);
        continue;
      }
    }

    // Liquidity floor — coins with shallow liq are easy rug targets
    if (market.liquidity > 0 && market.liquidity < CONFIG.MIN_LIQUIDITY) {
      log(`⚠ LOW LIQ — skipping ${post.name}: ${fmtUsd(market.liquidity)} liquidity (need ≥${fmtUsd(CONFIG.MIN_LIQUIDITY)})`);
      recordSkip(post, 'LOW_LIQ', `${fmtUsd(market.liquidity)} liquidity`, market.marketCap, market.priceUsd, market);
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
      recordSkip(post, reason, bundle.details, market.marketCap, market.priceUsd, market, { devHoldPct: bundle.metrics?.devHoldPct, freshWallets: bundle.metrics?.freshWallets, veterans: bundle.metrics?.veterans, sameFunderPct: bundle.metrics?.sameFunderPct });
      recordBundleObs(post, bundle, false, reason, market.marketCap, market.priceUsd);
      if (blind && !devHeavy && !aged) noteBlindBlock(post.name); else blindBlocks = 0;
      continue;
    }
    blindBlocks = 0;
    if (bundle.totalChecked > 0) {
      log(`✅ Bundle check passed: ${bundle.details}`);
    }
    recordBundleObs(post, bundle, true, undefined, market.marketCap, market.priceUsd);

    // Smart wallet check: informational, never blocking.
    //
    // It queries all 186 tracked wallets and has returned zero hits across 100
    // calls, while costing 0.6-0.9s of the decision. Awaiting it delayed every
    // call for a signal that has never once fired. It now runs in the background
    // and back-fills the record if it does find something, so the call is not
    // held up by a check that only ever adds colour.
    let smartHolders = 0;
    checkSmartWallets(post.mint).then(r => {
      smartHolders = r.holders;
      if (r.holders > 0) {
        log(`💎 SMART HOLDERS — ${r.holders} tracked wallet(s) holding $${post.name}`);
        const rec = tracker.getByMint(post.mint);
        if (rec) rec.entrySmartHolders = r.holders;
      }
    }).catch(() => {});
    const smartCheck = { holders: smartHolders };

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
        recordSkip(post, 'LOW_FEES', `${estFees.toFixed(2)}/${needed} SOL fees at ${fmtUsd(market.marketCap)} MC`, market.marketCap, market.priceUsd, market);
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
        recordSkip(post, 'FADED', `-${(fade * 100).toFixed(1)}% during checks`, freshMarket.marketCap, freshMarket.priceUsd, freshMarket);
        continue;
      }
    }

    const liveMarket = (freshMarket && freshMarket.marketCap < market.marketCap) ? freshMarket : market;

    log(
      `🔔 ALERT: ${coin.name} ($${coin.symbol}) — ` +
        `5m vol ${fmtUsd(liveMarket.volume5m)} — MC ${fmtUsd(liveMarket.marketCap)} — ` +
        `Price ${fmtUsd(liveMarket.priceUsd)} — SOL TRENDING ✅`,
    );

    // Record what was actually observed.
    //
    // This used to multiply price and market cap by 0.96 as a slippage model, but
    // slippage on a BUY means paying more, not less. Booking a cheaper entry than
    // reality inflated every reported multiple by ~4.2% and understated every
    // market cap shown — a call at $137K displayed as $131K, and the error
    // compounds into peak multiples, milestone alerts and all 676 paper strategies.
    //
    // Costs are already modelled where they belong: the paper fill takes a 2%
    // haircut on the way OUT, and real fills pay their actual fees. Discounting the
    // entry on top was double-counting in the flattering direction.
    // Derive market cap from the price we are actually recording, so the two can
    // never describe different moments. DexScreener samples its marketCap field
    // separately from priceUsd and the pair drifts up to ~10% apart on a fast
    // mover; a call reported at one cap and traded at another price is exactly how
    // stats go quietly wrong.
    let adjustedMarket = liveMarket;
    try {
      const supply = await mintSupply(coin.mint);

      // Price it at what it will actually trade for, not what the indexer thinks.
      //
      // $Hyper was recorded at $8,024 and filled at $5,137: DexScreener had not
      // indexed the pool (it reported $0 liquidity) and its price was 56% high. The
      // fill was fine — Jupiter priced the swap — but the call record, the entry
      // basis and every statistic derived from them were keyed to a price the coin
      // never traded at, understating a 1.56x head start as 1.00x.
      //
      // This runs AFTER the MAX_ENTRY_MC gate on purpose. It corrects what gets
      // recorded; it does not move any threshold or change which coins are called.
      const solUsd = await getSolPrice().catch(() => 0);
      const truth = solUsd > 0 ? await truePrice(coin.mint, solUsd, liveMarket.priceUsd) : null;
      const priceForRecord = truth && truth.priceUsd > 0 ? truth.priceUsd : liveMarket.priceUsd;
      if (truth && truth.source !== 'dexscreener' && Math.abs(truth.disagreePct ?? 0) > 10) {
        log(`💱 ${coin.symbol}: pricing from ${truth.source} — DexScreener was ${(truth.disagreePct ?? 0) > 0 ? '+' : ''}${(truth.disagreePct ?? 0).toFixed(1)}% off executable`);
      }

      if (supply > 0 && priceForRecord > 0) {
        const derived = priceForRecord * supply;
        // The old sanity band compared against DexScreener's own market cap, which
        // is useless when DexScreener is the thing that is wrong. An executable
        // quote needs no chaperone; only a derived-from-dex figure does.
        const trusted = truth && truth.source === 'jupiter';
        if (trusted || (derived > liveMarket.marketCap / 3 && derived < liveMarket.marketCap * 3)) {
          adjustedMarket = { ...liveMarket, priceUsd: priceForRecord, marketCap: derived, fdv: derived };
        }
      } else if (priceForRecord > 0 && priceForRecord !== liveMarket.priceUsd) {
        adjustedMarket = { ...liveMarket, priceUsd: priceForRecord };
      }
    } catch { /* keep the venue's figure */ }

    // The deep holder read runs alongside the alert rather than in front of it. It is
    // measurement — it must never add latency to a buy or be able to stop one — so it
    // back-fills the record whenever it finishes, the same shape as the smart-wallet
    // check above. 100 wallets costs ~2.4s against a coin already three minutes old.
    deepHolderScan(coin.mint).then(d => {
      if (!d) return;
      const rec = tracker.getByMint(coin.mint);
      if (rec) rec.entryDeepHolders = d;
      if (d.largestCluster >= 5) {
        log(`🕸 DEEP HOLDERS $${coin.symbol}: ${d.owners} owners, largest funder cluster ` +
            `${d.largestCluster}/${d.traced} (${d.clusterPct}%) from ${String(d.clusterFunder).slice(0, 8)}… ` +
            `· ${d.independent} independent · coverage ${d.coverage}%`);
      }
    }).catch(() => {});

    const paperTrade = paperTrader.openTrade(
      coin.mint, coin.symbol, coin.name, adjustedMarket.priceUsd, adjustedMarket.marketCap,
    );

    // Mark as called BEFORE sending alerts — prevents duplicate sends if Discord is slow/down
    // Pass rich features (bundle/smart holders) so we can correlate them with outcomes later.
    tracker.add(coin, adjustedMarket, 'pending', {
      smartHolders: smartCheck.holders,
      bundleSafe: bundle.safe,
      holders: bundle.metrics,
      socials: await checkSocials(coin.mint).then(x => x.known ? x.count : undefined).catch(() => undefined),
      // messageId is "channel:id" since multi-channel scraping. Which feed surfaced a
      // coin is the only way to tell a channel that is worth scraping from one that
      // is merely loud, and it cannot be reconstructed after the fact.
      source: String(post.messageId ?? '').includes(':') ? String(post.messageId).split(':')[0] : undefined,
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
    if (CONFIG.TRADE_ENABLED && shuttingDown) {
      log(`⏹ BUY NOT STARTED for $${coin.symbol} — process is shutting down. The call is recorded; it was not traded.`);
    } else if (CONFIG.TRADE_ENABLED) {
      log(`[Trader] 🔄 Fan-out buy for $${coin.symbol} across ${taskManager.enabledTasks().length} task(s)...`);
      const boughtCount = await trackBuy(taskManager.buyAll(coin.mint, coin.symbol, coin.name, market.priceUsd, market.marketCap));
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
            if (shuttingDown) {
              log(`⏹ ${source.name}: not starting a buy for ${mint.slice(0, 8)}… — process is shutting down`);
              continue;
            }
            const bought = await trackBuy(taskManager.buyAll(mint, symbol, symbol, market.priceUsd, market.marketCap, source.id));
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

/** Last market-data fetch, reused between fast ticks so the tick is not gated on a network call. */
let mdCache: { at: number; data: Map<string, Awaited<ReturnType<typeof fetchBatchMarketData>> extends Map<string, infer V> ? V : never> } | null = null;

async function realPositionLoop() {
  while (true) {
    // The tick is fast because it no longer waits on anything. Price arrives pushed
    // from the pool subscription and is read from memory; market cap comes from a
    // cached fetch refreshed on its own slower schedule. Polling every second was
    // pacing the exit to a network round trip that the decision no longer needs.
    await new Promise(r => setTimeout(r, CONFIG.REAL_CHECK_INTERVAL_MS));
    realLoopHeartbeat = Date.now();
    try {
      const real = taskManager.openPositions().filter(({ task }) => !task.paper);
      if (real.length === 0) { mdCache = null; continue; }
      const mints = [...new Set(real.map(({ pos }) => pos.mint))];
      // Market cap and the fallback price change slowly enough to cache. The pool
      // price does not come from here.
      if (!mdCache || Date.now() - mdCache.at > CONFIG.MARKET_DATA_MAX_AGE_MS
          || mints.some(m => !mdCache!.data.has(m))) {
        mdCache = { at: Date.now(), data: await fetchBatchMarketData(mints) };
      }
      const data = mdCache.data;
      const { poolPriceUsd } = await import('./pool-price.js');
      for (const mint of mints) {
        const m = data.get(mint);
        if (!m || m.priceUsd <= 0) continue;

        // Decide on the pool, not on an aggregate.
        //
        // The pool subscription has been running since 08-12 and only ever fed the
        // dashboard. Every exit was still decided from DexScreener, which publishes
        // a smoothed average — measured 8.76% off a live pool of our own, and flat
        // through a 45-second stretch where the real price moved 1.36e-5 to 1.50e-5
        // and back. A stop 15% below entry loses most of its margin to an error that
        // size, and worse, it fires late: the level is crossed on chain seconds
        // before the number we are watching admits it.
        //
        // The pool price is what a sell would actually fill against. It arrives
        // pushed, on every trade, with no poll and no rate limit.
        //
        // Still additive. A missing, stale or implausible reading yields to the feed
        // that was already here rather than blocking the exit.
        let px = m.priceUsd, mc = m.marketCap, src = 'feed';
        const pool = await poolPriceUsd(mint, 15_000).catch(() => null);
        if (pool && pool > 0 && plausible(pool, m.priceUsd)) {
          // Market cap has to move with the price it is derived from, or an MC rule
          // starts judging one number against another's scale.
          mc = m.marketCap > 0 ? m.marketCap * (pool / m.priceUsd) : m.marketCap;
          const drift = Math.abs(pool / m.priceUsd - 1) * 100;
          if (drift > 5) {
            console.log(`[RealLoop] ${mint.slice(0, 8)}… pool ${pool.toExponential(3)} vs feed ` +
              `${m.priceUsd.toExponential(3)} (${drift.toFixed(1)}% apart) — using the pool`);
          }
          px = pool; src = 'pool';
        }
        void src;
        for (const task of taskManager.all().filter(t => !t.paper)) {
          const trader = taskManager.traderFor(task);
          if (trader.getPosition(mint)?.status !== 'open') continue;
          // Time-boxed: a single position must never be able to stall the loop that
          // manages every other position. A rejection here is logged and the loop
          // carries on; a hang used to take all exits down with it.
          const exits = await withTimeout(
            trader.checkPosition(mint, px, mc),
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
/**
 * Build the channel-quality dataset without anyone having to remember to.
 *
 * The standalone script needs running repeatedly over days before it can say
 * anything, because a coin has to age two hours before its peak means anything and
 * t.me only shows about an hour of posts. A tool that only works if someone keeps
 * clicking it is a tool that will not get run.
 */
/**
 * Fill in the creator for calls made before it was recorded.
 *
 * Creator history is only useful with history in it. Starting from zero means the
 * signal is unavailable for weeks, when pump.fun will answer for coins we called
 * months ago and the 300 records already on disk can be made to carry it.
 *
 * Deliberately slow — this is backfill, not a feature, and it must never compete
 * with the scanner for rate limit.
 */
async function creatorBackfillLoop() {
  const { fetchCoinDetails } = await import('./pumpfun.js');
  while (true) {
    await new Promise(r => setTimeout(r, 90_000));
    try {
      const missing = tracker.allCalls().filter(c => !c.creator).slice(0, 8);
      if (!missing.length) continue;
      let filled = 0;
      for (const c of missing) {
        const d = await fetchCoinDetails(c.mint).catch(() => null);
        // Mark unresolvable ones so a delisted coin is not retried forever.
        c.creator = d?.creator ?? 'unknown';
        if (d?.creator) filled++;
        await new Promise(r => setTimeout(r, 1500));
      }
      if (filled) { tracker.persist(); console.log(`[Backfill] creator filled for ${filled} past call(s)`); }
    } catch (err: any) {
      console.error(`[Backfill] ${err.message}`);
    }
  }
}

async function channelAuditLoop() {
  const { auditPass } = await import('./channel-audit.js');
  const { tgChannels } = await import('./telegram.js');
  let first = true;
  while (true) {
    if (!first) await new Promise(r => setTimeout(r, 20 * 60_000));
    first = false;
    // 60 per pass at 4s spacing is four minutes of a twenty-minute cycle, and
    // measurement has been reliable at that rate. The default of 25 was set before
    // there was a correction backlog to drain.
    try { await auditPass(tgChannels(), 60); }
    catch (err: any) { console.error(`[ChannelAudit] loop: ${err.message}`); }
  }
}

async function poolPriceLoop() {
  const { watchMint, pruneWatches, revalidate } = await import('./pool-price.js');
  let ticks = 0;
  let first = true;
  while (true) {
    // Sleep after the first pass, not before it. A position opened just after a tick
    // used to wait the full 30 seconds for its subscription — the window in which a
    // fresh memecoin is most likely to rug, spent reading the slow feed.
    if (!first) await new Promise(r => setTimeout(r, 5_000));
    first = false;
    try {
      const real = taskManager.openPositions().filter(({ task }) => !task.paper);
      const mints = new Set(real.map(({ pos }) => pos.mint));
      pruneWatches(mints);
      for (const m of mints) await watchMint(m);
      if (++ticks % 60 === 0 && mints.size) await revalidate();
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
      taskManager.prunePending();
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

/**
 * Independent exit auditor — the layer that assumes the main loop is broken.
 *
 * Every existing safety net depends on the position loop having already decided to
 * sell: getStuckPositions only returns positions where stopTriggered is true, so it
 * catches a sell that FAILED, never a sell that was never attempted. The failures
 * that actually cost money this week were all of the second kind — a hung loop, a
 * price feed 8.76% off, a balance read that returned 0. In each case the stop logic
 * ran happily and concluded there was nothing to do.
 *
 * So this shares nothing with the main loop. Its own timer, its own price read, its
 * own arithmetic on the position's recorded levels. If a position is trading below
 * the level the strategy says it should have exited at, that is a missed exit
 * regardless of what the position loop believes, and it sells.
 *
 * A grace band is applied before acting — a stop is not missed until the price has
 * been through it, not merely touching it — because firing on noise would make this
 * layer the thing that loses money.
 */
async function missedExitAuditor() {
  const { poolPriceUsd } = await import('./pool-price.js');
  const seenBelow = new Map<string, number>();   // mint -> first time seen below its stop
  const GRACE_MS = 90_000;                       // must stay below for this long
  const BAND = 0.97;                             // 3% under the level, so noise does not trip it

  while (true) {
    await new Promise(r => setTimeout(r, 45_000));
    try {
      for (const { task, pos } of taskManager.openPositions()) {
        if (task.paper || pos.remainingPct < 0.001) continue;

        // Price read independent of the position loop's feed.
        let px = await poolPriceUsd(pos.mint, 120_000).catch(() => null);
        if (!px || px <= 0) {
          const md = await fetchSingleMarketData(pos.mint).catch(() => null);
          px = md && md.priceUsd > 0 ? md.priceUsd : null;
        }
        if (!px || !plausible(px, pos.entryPrice * (pos.peakMultiplier || 1))) { seenBelow.delete(pos.mint); continue; }

        const trailLvl = pos.trailingActive ? pos.trailingStopPrice : 0;
        const hardFloor = pos.entryPrice * (1 - CONFIG.TRADE_MAX_LOSS_PCT);
        const shouldExitAt = Math.max(pos.stopLossPrice, trailLvl);

        // The clock is an exit too, and this only ever audited price levels. A
        // position that blew through its hold time sat here indefinitely so long as
        // it stayed above its stop — which is precisely how $mRNA-4157 held for
        // three hours against a five-minute clock while this layer, the one meant to
        // catch exactly that, never looked. Ten minutes past the clock is not a race
        // with the position loop at any hold length; it means the loop is not
        // getting out.
        const holdMin = (task as any).strategy?.maxHoldMin ?? 0;
        const heldMin = (Date.now() - pos.entryTime) / 60_000;
        const clockBlown = holdMin > 0 && heldMin >= holdMin + 10;

        const breached = px <= shouldExitAt * BAND || px <= hardFloor || clockBlown;
        if (!breached) { seenBelow.delete(pos.mint); continue; }

        const since = seenBelow.get(pos.mint) ?? Date.now();
        seenBelow.set(pos.mint, since);
        if (Date.now() - since < GRACE_MS) continue;

        const mult = pos.entryPrice > 0 ? px / pos.entryPrice : 0;
        const why = clockBlown
          ? `is ${heldMin.toFixed(0)}m into a ${holdMin}m clock`
          : `should have exited at ${(shouldExitAt / pos.entryPrice).toFixed(2)}X`;
        log(`🚨 MISSED EXIT [${task.name}] $${pos.symbol} at ${mult.toFixed(2)}X — ${why} and is still open. Force-selling.`);
        sendOpsAlert(
          `🚨 **Missed exit caught** — **${task.name}** still holds **$${pos.symbol}** at **${mult.toFixed(2)}X**, ` +
          `${clockBlown ? `${heldMin.toFixed(0)} minutes into a ${holdMin}-minute clock` : `below its exit level of ${(shouldExitAt / pos.entryPrice).toFixed(2)}X for over 90 seconds`}. ` +
          `The position loop did not act, so the auditor is force-selling. This is a bug worth looking at.`,
          CONFIG.TRADES_WEBHOOK,
        ).catch(() => {});

        const trader = taskManager.traderFor(task);
        pos.stopTriggered = true;            // the panic seller keeps working if this attempt fails
        const exits = await trader.panicSell(pos.mint).catch((e: any) => {
          console.error(`[Auditor] force-sell failed for ${pos.symbol}: ${e.message}`);
          return [];
        });
        for (const ex of exits) {
          log(`💰 AUDITOR EXIT [${task.name}]: $${pos.symbol} — ${ex.label} → ${ex.solReceived.toFixed(4)} SOL`);
        }
        seenBelow.delete(pos.mint);
      }
    } catch (err: any) {
      console.error(`[Auditor] ${err.message}`);
    }
  }
}

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
    missedExitAuditor().catch(err => {
      console.error(`[Auditor] loop died: ${err.message}`);
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
    creatorBackfillLoop().catch(err => {
      console.error(`[Backfill] loop died: ${err.message}`);
    });
    channelAuditLoop().catch(err => {
      console.error(`[ChannelAudit] loop died: ${err.message}`);
    });
    poolPriceLoop().catch(err => {
      console.error(`[PoolPrice] Fatal: ${err.message}`);
    });
    loopWatchdog().catch(err => {
      console.error(`[LoopWatchdog] Fatal: ${err.message}`);
    });
    skipOutcomeLoop().catch(err => {
      console.error(`[SkipOutcome] Fatal: ${err.message}`);
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
