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

export interface Candle { ts: number; o: number; h: number; l: number; c: number }
export interface CoinPath { mint: string; symbol: string; callTs: number; entryPrice: number; candles: Candle[] }

function pathFile(mint: string): string { return join(DIR, `${mint}.json`); }

export function hasPath(mint: string): boolean {
  try { return existsSync(pathFile(mint)); } catch { return false; }
}

export function loadPaths(limit = 400): CoinPath[] {
  try {
    const files = readdirSync(DIR).filter(f => f.endsWith('.json'));
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
  try {
    const dsRes = await fetch(`${CONFIG.DEXSCREENER_API}/latest/dex/tokens/${mint}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000),
    });
    const ds: any = await dsRes.json();
    const pairs = (ds.pairs ?? []).filter((p: any) => p.chainId === 'solana');
    if (!pairs.length) return false;
    const pair = pairs.sort((a: any, b: any) => (+b.volume?.h24 || 0) - (+a.volume?.h24 || 0))[0];

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
  maxHoldMin: number;
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
      let found = -1;
      for (let i = 0; i < Math.min(c.length, cfg.dipWindowMin); i++) if (c[i].l <= target) { found = i; break; }
      if (found < 0) { skipped++; continue; }
      idx = found; entry = target;
    }

    let remaining = 1, proceeds = 0, high = entry, exitLabel = 'held to horizon';
    let stop = cfg.trailingFrom === 'entry'
      ? entry * Math.max(1 - cfg.trailingDrop, cfg.stopLossPct)
      : entry * cfg.stopLossPct;
    let trailArmed = cfg.trailingFrom === 'entry';
    const hits = cfg.tps.map(() => false);

    for (let i = idx; i < c.length && i - idx < horizonMin; i++) {
      const k = c[i];
      // low first — stops fire before targets within a candle
      if (remaining > 0 && stop > 0 && k.l <= stop) {
        proceeds += remaining * stop; remaining = 0;
        exitLabel = trailArmed && stop > entry ? 'trailing stop' : 'stop loss';
        break;
      }
      for (let j = 0; j < cfg.tps.length; j++) {
        if (!hits[j] && k.h >= entry * cfg.tps[j].mult) {
          const sell = Math.min(cfg.tps[j].sellPct, remaining);
          proceeds += sell * entry * cfg.tps[j].mult;
          remaining -= sell; hits[j] = true;
          exitLabel = `TP ${cfg.tps[j].mult}×`;
          if (cfg.breakEvenAfterTp1 && j === 0) stop = Math.max(stop, entry);
        }
      }
      if (k.h > high) high = k.h;
      if (!trailArmed && cfg.trailingFrom === 'afterLastTp' && cfg.tps.length && hits.every(Boolean)) trailArmed = true;
      if (trailArmed && cfg.trailingDrop < 0.89) stop = Math.max(stop, high * (1 - cfg.trailingDrop));
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
