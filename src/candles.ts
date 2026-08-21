/**
 * Minute-candle cache for called coins.
 *
 * The Strategy Lab's original peak model (entry → peak → down) was misleading:
 * real coins dip *through* stops before they run. Storing the actual minute path
 * for every call lets the builder backtest a config against what really happened.
 *
 * Candles come from GeckoTerminal (free, no key). We fetch once per coin, ~45min
 * after the call, then never again — so this costs a handful of requests per hour
 * and never touches Helius.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { CONFIG } from './config.js';

const DIR = join(CONFIG.DATA_DIR, 'candles');

/** Mirrors CONFIG.DIP_MAX_OVERSHOOT. Kept local so the backtest has no runtime
 *  config dependency, but the two must not drift. */
const DIP_MAX_OVERSHOOT = 0.30;

export interface Candle { ts: number; o: number; h: number; l: number; c: number }
export interface CoinPath { mint: string; symbol: string; callTs: number; entryPrice: number; candles: Candle[] }

function pathFile(mint: string): string { return join(DIR, `${mint}.json`); }

/* ── Failure memory ──────────────────────────────────────────────────────────
 *
 * A capture that fails leaves no file, and "no file" is the only thing the
 * scheduler used to look at, so a coin that can never be captured asked to be
 * retried on every cycle for the whole seven days it stayed eligible. Most calls
 * end at zero liquidity — no pool, no candles, no possible success — so the six
 * oldest eligible coins were almost always six permanent failures, and they held
 * the only six slots there are. Capture stopped for 54 hours and nothing said so:
 * the loop was busy the entire time, just busy with the same dead coins.
 *
 * So misses are remembered. Four attempts spread over about eight hours is plenty
 * for a pool that is merely slow to index, and it caps a hopeless coin at four
 * attempts instead of two thousand. */

const MISS_FILE = join(DIR, '_misses.json');
const BACKOFF_MS = [0, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
const KEEP_MISS_MS = 8 * 24 * 3600_000;

interface Miss { n: number; last: number }
let misses: Record<string, Miss> | null = null;

function loadMisses(): Record<string, Miss> {
  if (misses) return misses;
  try { misses = JSON.parse(readFileSync(MISS_FILE, 'utf-8')); } catch { misses = {}; }
  return misses!;
}

function saveMisses(): void {
  const m = loadMisses();
  const cut = Date.now() - KEEP_MISS_MS;
  for (const k of Object.keys(m)) if (m[k].last < cut) delete m[k];
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(MISS_FILE, JSON.stringify(m));
  } catch { /* the volume is not worth crashing the loop over */ }
}

/** True when this mint has run out of attempts, or its next one is not due yet. */
export function captureCoolingOff(mint: string): boolean {
  const m = loadMisses()[mint];
  if (!m) return false;
  if (m.n >= BACKOFF_MS.length) return true;
  return Date.now() - m.last < BACKOFF_MS[m.n];
}

function noteMiss(mint: string): void {
  const m = loadMisses();
  m[mint] = { n: (m[mint]?.n ?? 0) + 1, last: Date.now() };
  saveMisses();
}

/** Coins still worth attempting, and coins written off. For the health endpoint. */
export function captureQueueStats(): { givenUp: number; waiting: number } {
  const m = loadMisses();
  let givenUp = 0, waiting = 0;
  for (const k of Object.keys(m)) (m[k].n >= BACKOFF_MS.length ? givenUp++ : waiting++);
  return { givenUp, waiting };
}

export function hasPath(mint: string): boolean {
  try { return existsSync(pathFile(mint)); } catch { return false; }
}

export function loadPaths(limit = 400): CoinPath[] {
  try {
    // '_misses.json' lives here too and is not a price path.
    const files = readdirSync(DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    const out: CoinPath[] = [];
    for (const f of files.slice(-limit)) {
      try {
        const p = JSON.parse(readFileSync(join(DIR, f), 'utf-8'));
        if (p?.candles?.length >= 5) out.push(p);
      } catch { /* skip bad file */ }
    }
    return out.sort((a, b) => b.callTs - a.callTs);
  } catch { return []; }
}

/** Fetch and store the minute path for one called coin. Returns true if stored. */
export async function capturePath(mint: string, symbol: string, callTs: number): Promise<boolean> {
  if (hasPath(mint)) return false;
  const ok = await tryCapture(mint, symbol, callTs);
  if (!ok) noteMiss(mint);
  return ok;
}

async function tryCapture(mint: string, symbol: string, callTs: number): Promise<boolean> {
  try {
    const dsRes = await fetch(`${CONFIG.DEXSCREENER_API}/latest/dex/tokens/${mint}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000),
    });
    const ds: any = await dsRes.json();
    // Ignore dead bonding curves and dust pairs — their candles are flat lines
    // at a fossil price and would poison every backtest run against them.
    const all = (ds.pairs ?? []).filter((p: any) => p.chainId === 'solana' && p.baseToken?.address === mint);
    const pairs = all.filter((p: any) => (p.liquidity?.usd ?? 0) >= 500);
    const usable = pairs.length ? pairs : all.filter((p: any) => (p.liquidity?.usd ?? 0) > 0);
    if (!usable.length) return false;
    const pair = usable.sort((a: any, b: any) => (+b.volume?.h24 || 0) - (+a.volume?.h24 || 0))[0];

    const before = Math.floor(callTs / 1000) + 6 * 3600;
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair.pairAddress}` +
      `/ohlcv/minute?aggregate=1&before_timestamp=${before}&limit=400&currency=usd`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return false;
    const gt: any = await res.json();
    const list: number[][] = gt?.data?.attributes?.ohlcv_list ?? [];
    const candles: Candle[] = list
      .map(r => ({ ts: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4] }))
      .filter(c => c.ts >= callTs - 60_000)
      .sort((a, b) => a.ts - b.ts);
    if (candles.length < 5) return false;

    mkdirSync(DIR, { recursive: true });
    const stored: CoinPath = { mint, symbol, callTs, entryPrice: candles[0].o || candles[0].c, candles };
    writeFileSync(pathFile(mint), JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

// ── Backtest engine (same conventions as the live paper trader) ──

export interface BacktestCfg {
  entryMode: 'instant' | 'dip';
  dipPct: number;
  dipWindowMin: number;
  tps: { mult: number; sellPct: number }[];
  trailingDrop: number;
  trailingFrom: 'entry' | 'afterLastTp';
  stopLossPct: number;
  breakEvenAfterTp1: boolean;
  /** Where the post-TP1 stop lands, as a multiple of entry. 1 = break-even (default). */
  postTp1StopPct?: number;
  maxHoldMin: number;
  /** Which half of a candle is assumed to happen first.
   *
   *  This is not a detail. Across the 218 captured paths the deepest fall inside a
   *  single candle is a median of 64% from that candle's own high, and 95% of coins
   *  have at least one candle that falls more than 45%. At that range the assumption
   *  decides the result, so both must be reported.
   *
   *  'low'  — the fall comes first. Stops fire against the old level, the trail never
   *           ratchets on the spike, and take-profits inside the candle are missed.
   *           The floor of what a strategy could have made.
   *  'high' — the spike comes first. Take-profits fill, the trail ratchets to the
   *           candle high, and only then does the fall test the raised stop.
   *           The ceiling.
   *
   *  Truth is somewhere between. A single number from either one is a claim the data
   *  cannot support. */
  intraOrder?: 'low' | 'high';
}

export interface BacktestResult {
  trades: number; skipped: number; avg: number; median: number; winPct: number;
  total: number; robustAvg: number; best: number; worst: number;
  samples: { symbol: string; entry: number; ret: number; exit: string }[];
}

const COST = 0.02;   // each side — matches the paper fleet's haircut

export function backtest(cfg: BacktestCfg, paths: CoinPath[], horizonMin = 180): BacktestResult {
  const rets: number[] = [];
  const samples: BacktestResult['samples'] = [];
  let skipped = 0;

  for (const p of paths) {
    const c = p.candles;
    if (!c || c.length < 3) continue;
    const ref = c[0].o || c[0].c;
    let idx = 0, entry = ref;

    if (cfg.entryMode === 'dip') {
      const target = ref * (1 - cfg.dipPct);
      // A limit order fills at its limit only if the price stops there. When a coin
      // falls through the target inside one minute it is not dipping, it is being
      // sold off, and the live bot cancels rather than catching it — that is what
      // DIP_MAX_OVERSHOOT does in tasks.ts, added after $QUASI filled at the bottom
      // of a gap. The replay had no such rule: it filled every dip at exactly the
      // limit no matter how far the candle blew past it, which is why deep dips read
      // as the best strategies on the board. A −70% dip "won" 91% of the time by
      // buying collapses at a price that was never on offer.
      const floor = target * (1 - DIP_MAX_OVERSHOOT);
      let found = -1;
      for (let i = 0; i < Math.min(c.length, cfg.dipWindowMin); i++) {
        if (c[i].l > target) continue;
        if (c[i].l < floor) break;      // gapped through — the live bot cancels here
        found = i; break;
      }
      if (found < 0) { skipped++; continue; }
      idx = found; entry = target;
    }

    let remaining = 1, proceeds = 0, high = entry, exitLabel = 'held to horizon';
    let stop = cfg.trailingFrom === 'entry'
      ? entry * Math.max(1 - cfg.trailingDrop, cfg.stopLossPct)
      : entry * cfg.stopLossPct;
    let trailArmed = cfg.trailingFrom === 'entry';
    const hits = cfg.tps.map(() => false);

    const highFirst = cfg.intraOrder === 'high';
    for (let i = idx; i < c.length && i - idx < horizonMin; i++) {
      const k = c[i];
      const takeStop = (): boolean => {
        if (remaining > 0 && stop > 0 && k.l <= stop) {
          proceeds += remaining * stop; remaining = 0;
          exitLabel = trailArmed && stop > entry ? 'trailing stop' : 'stop loss';
          return true;
        }
        return false;
      };
      const takeTps = () => {
        for (let j = 0; j < cfg.tps.length; j++) {
          if (!hits[j] && k.h >= entry * cfg.tps[j].mult) {
            const sell = Math.min(cfg.tps[j].sellPct, remaining);
            proceeds += sell * entry * cfg.tps[j].mult;
            remaining -= sell; hits[j] = true;
            exitLabel = `TP ${cfg.tps[j].mult}×`;
            if (cfg.breakEvenAfterTp1 && j === 0) stop = Math.max(stop, entry * (cfg.postTp1StopPct ?? 1));
          }
        }
      };
      const ratchet = () => {
        if (k.h > high) high = k.h;
        if (!trailArmed && cfg.trailingFrom === 'afterLastTp' && cfg.tps.length && hits.every(Boolean)) trailArmed = true;
        if (trailArmed && cfg.trailingDrop < 0.89) stop = Math.max(stop, high * (1 - cfg.trailingDrop));
      };

      if (highFirst) {
        // Spike first: targets fill and the trail ratchets to this candle's high,
        // then the fall tests the level it was just raised to.
        takeTps();
        ratchet();
        if (takeStop()) break;
      } else {
        // Fall first: the stop is tested against the level it already had, so the
        // spike in the same candle never counted for anything.
        if (takeStop()) break;
        takeTps();
        ratchet();
      }
      if (remaining <= 1e-9) break;
      if (cfg.maxHoldMin && (i - idx) >= cfg.maxHoldMin) {
        proceeds += remaining * k.c; remaining = 0; exitLabel = `${cfg.maxHoldMin}m clock`;
        break;
      }
    }
    if (remaining > 0) proceeds += remaining * (c[Math.min(c.length, idx + horizonMin) - 1]?.c ?? entry);

    const ret = (proceeds / entry) * (1 - COST) * (1 - COST);
    rets.push(ret);
    samples.push({ symbol: p.symbol, entry, ret: +ret.toFixed(3), exit: exitLabel });
  }

  const n = rets.length;
  if (!n) return { trades: 0, skipped, avg: 0, median: 0, winPct: 0, total: 0, robustAvg: 0, best: 0, worst: 0, samples: [] };
  const sorted = [...rets].sort((a, b) => b - a);
  const total = rets.reduce((s, x) => s + x, 0) - n;
  const robust = n > 3 ? (sorted.slice(3).reduce((s, x) => s + x, 0) - (n - 3)) / (n - 3) : 0;
  return {
    trades: n, skipped,
    avg: +(total / n).toFixed(4),
    median: +sorted[Math.floor(n / 2)].toFixed(3),
    winPct: Math.round(rets.filter(r => r > 1).length / n * 100),
    total: +total.toFixed(2),
    robustAvg: +robust.toFixed(4),
    best: +sorted[0].toFixed(2),
    worst: +sorted[n - 1].toFixed(2),
    samples: samples.sort((a, b) => b.ret - a.ret),
  };
}
