import { readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { CONFIG, saveSettingsOverrides } from './config.js';
import { getWallet, getSolBalance, setWalletFromKey, walletSource, getTokenHoldings } from './wallet.js';
import { taskManager, type TradeTask } from './tasks.js';
import { sendTradeActivity } from './discord.js';
import { verifyInteractionSignature, handleInteraction } from './interactions.js';
import { buildHqHTML } from './hq.js';
import { fmtUsd } from './discord.js';
import { runtime } from './runtime.js';
import { getSolPrice } from './dexscreener.js';
import { jupiterGetPrice } from './jupiter.js';
import { STRATEGY_PRESETS, sanitizeStrategy, describeStrategy, type Strategy } from './strategy.js';
import { sourceRegistry, PUMPCLAW_SOURCE_ID } from './call-sources.js';
import { loadPaths, backtest, type BacktestCfg } from './candles.js';
import type { CallRecord } from './tracker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
import type { PaperTrade } from './paper-trader.js';

// ── Types for real positions (matches trader.ts) ────────────
interface RealExit {
  reason: string;
  label: string;
  multiplierAtExit: number;
  pctSold: number;
  tokensSold: number;
  solReceived: number;
  txSignature: string;
  timestamp: number;
}

interface RealPosition {
  mint: string;
  symbol: string;
  name: string;
  entrySol: number;
  entryPrice: number;
  entryMC: number;
  entryTime: number;
  entryTx: string;
  tokensReceived: number;
  stopLossPrice: number;
  beStopArmed: boolean;
  remainingPct: number;
  tokensRemaining: number;
  exits: RealExit[];
  totalSolReturned: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  peakMultiplier: number;
  trailingActive: boolean;
  trailingHighPrice: number;
  trailingStopPrice: number;
  status: 'open' | 'closed' | 'error';
  closedTime?: number;
  finalPnlSol?: number;
}

// ── Load data ───────────────────────────────────────────────

function loadJSON<T>(path: string): T[] {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

type TimeRange = '1h' | '6h' | '12h' | '24h' | '7d' | 'all';

const RANGE_MS: Record<TimeRange, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  'all': Infinity,
};

const RANGE_LABELS: Record<TimeRange, string> = {
  '1h': '1 Hour',
  '6h': '6 Hours',
  '12h': '12 Hours',
  '24h': '24 Hours',
  '7d': '7 Days',
  'all': 'All Time',
};

function buildDashboardData(range: TimeRange = 'all') {
  let calls: CallRecord[] = loadJSON(join(CONFIG.DATA_DIR, 'calls.json'));
  let trades: PaperTrade[] = loadJSON(join(CONFIG.DATA_DIR, 'trades.json'));
  // Aggregate real positions across ALL task books (positions.json + positions-<taskId>.json)
  let positions: RealPosition[] = [];
  try {
    const posFiles = readdirSync(CONFIG.DATA_DIR).filter(f => /^positions(-[a-z0-9]+)?\.json$/.test(f));
    for (const f of posFiles) positions.push(...loadJSON<RealPosition>(join(CONFIG.DATA_DIR, f)));
  } catch {
    positions = loadJSON(join(CONFIG.DATA_DIR, 'positions.json'));
  }

  // Filter by time range
  if (range !== 'all') {
    const cutoff = Date.now() - RANGE_MS[range];
    calls = calls.filter(c => c.entryTime >= cutoff);
    trades = trades.filter(t => t.entryTime >= cutoff);
    positions = positions.filter(p => p.entryTime >= cutoff);
  }

  // ── Overview stats ──
  const closedTrades = trades.filter(t => t.status === 'closed');
  const closedPositions = positions.filter(p => p.status === 'closed');
  const paperWins = closedTrades.filter(t => (t.finalPnlSol ?? 0) > 0);
  const realWins = closedPositions.filter(p => (p.finalPnlSol ?? 0) > 0);
  const totalPaperPnl = closedTrades.reduce((s, t) => s + (t.finalPnlSol ?? 0), 0);
  const totalRealPnl = closedPositions.reduce((s, p) => s + (p.finalPnlSol ?? 0), 0);
  const totalRealInvested = closedPositions.reduce((s, p) => s + p.entrySol, 0);

  // Best/worst
  const bestPaper = closedTrades.reduce((best, t) => (t.finalPnlSol ?? 0) > (best?.finalPnlSol ?? -Infinity) ? t : best, closedTrades[0]);
  const worstPaper = closedTrades.reduce((worst, t) => (t.finalPnlSol ?? 0) < (worst?.finalPnlSol ?? Infinity) ? t : worst, closedTrades[0]);
  const bestReal = closedPositions.reduce((best, p) => (p.finalPnlSol ?? 0) > (best?.finalPnlSol ?? -Infinity) ? p : best, closedPositions[0]);
  const worstReal = closedPositions.reduce((worst, p) => (p.finalPnlSol ?? 0) < (worst?.finalPnlSol ?? Infinity) ? p : worst, closedPositions[0]);

  // ── Exit reason breakdown ──
  const paperExitReasons: Record<string, number> = {};
  for (const t of closedTrades) {
    // Use the LAST exit reason as the "final" reason
    const lastExit = t.exits[t.exits.length - 1];
    const reason = lastExit?.reason ?? 'unknown';
    paperExitReasons[reason] = (paperExitReasons[reason] ?? 0) + 1;
  }

  const realExitReasons: Record<string, number> = {};
  for (const p of closedPositions) {
    const lastExit = p.exits[p.exits.length - 1];
    const reason = lastExit?.reason ?? 'unknown';
    realExitReasons[reason] = (realExitReasons[reason] ?? 0) + 1;
  }

  // ── TP hit rates ──
  const paperTP1 = closedTrades.filter(t => t.tp1Hit).length;
  const paperTP2 = closedTrades.filter(t => t.tp2Hit).length;
  const paperTP3 = closedTrades.filter(t => t.tp3Hit).length;
  const realTP1 = closedPositions.filter(p => p.tp1Hit).length;
  const realTP2 = closedPositions.filter(p => p.tp2Hit).length;
  const realTP3 = closedPositions.filter(p => p.tp3Hit).length;

  // ── Peak multiplier distribution ──
  const peakBuckets = [
    { label: '<1X (loss)', min: 0, max: 1, count: 0 },
    { label: '1-1.5X', min: 1, max: 1.5, count: 0 },
    { label: '1.5-2X', min: 1.5, max: 2, count: 0 },
    { label: '2-3X', min: 2, max: 3, count: 0 },
    { label: '3-5X', min: 3, max: 5, count: 0 },
    { label: '5-10X', min: 5, max: 10, count: 0 },
    { label: '10X+', min: 10, max: Infinity, count: 0 },
  ];
  for (const c of calls) {
    const peak = c.peakMultiplier ?? 1;
    for (const b of peakBuckets) {
      if (peak >= b.min && peak < b.max) { b.count++; break; }
    }
  }

  // ── Milestone hit rates (from calls.json) ──
  const milestoneTargets = [2, 3, 5, 10, 20, 50, 100];
  const milestoneCounts: Record<number, number> = {};
  for (const m of milestoneTargets) milestoneCounts[m] = 0;
  for (const c of calls) {
    if (!c.hitMilestones) continue;
    for (const hit of c.hitMilestones) {
      if (milestoneCounts[hit.multiplier] !== undefined) {
        milestoneCounts[hit.multiplier]++;
      }
    }
  }

  // ── Cumulative PnL over time (paper trades) ──
  const sortedTrades = [...closedTrades].sort((a, b) => (a.closedTime ?? 0) - (b.closedTime ?? 0));
  let cumPnl = 0;
  const paperPnlTimeline = sortedTrades.map(t => {
    cumPnl += t.finalPnlSol ?? 0;
    return { time: t.closedTime ?? t.entryTime, pnl: cumPnl, symbol: t.symbol, tradePnl: t.finalPnlSol ?? 0 };
  });

  // ── Cumulative PnL over time (real positions) ──
  const sortedPositions = [...closedPositions].sort((a, b) => (a.closedTime ?? 0) - (b.closedTime ?? 0));
  let cumRealPnl = 0;
  const realPnlTimeline = sortedPositions.map(p => {
    cumRealPnl += p.finalPnlSol ?? 0;
    return { time: p.closedTime ?? p.entryTime, pnl: cumRealPnl, symbol: p.symbol, tradePnl: p.finalPnlSol ?? 0 };
  });

  // ── Per-trade PnL bars ──
  const tradePnlBars = sortedTrades.map(t => ({
    symbol: t.symbol,
    pnl: t.finalPnlSol ?? 0,
    time: t.closedTime ?? t.entryTime,
    peakMult: 0, // paper trades don't track peak in trades.json
  }));

  const realPnlBars = sortedPositions.map(p => ({
    symbol: p.symbol,
    pnl: p.finalPnlSol ?? 0,
    time: p.closedTime ?? p.entryTime,
    peakMult: p.peakMultiplier ?? 1,
  }));

  // ── Calls that ran (peak > 2X) but we may not have traded well ──
  const callsWithPeaks = calls.map(c => ({
    mint: c.mint, symbol: c.symbol,
    name: c.name,
    entryMC: c.entryMC,
    peakMultiplier: c.peakMultiplier ?? 1,
    peakMC: c.peakMC ?? c.entryMC,
    entryTime: c.entryTime,
    milestones: (c.hitMilestones ?? []).map(m => m.multiplier),
  })).sort((a, b) => b.peakMultiplier - a.peakMultiplier);

  // ── MC at entry distribution ──
  const mcBuckets = [
    { label: '<5K', min: 0, max: 5000, count: 0, winners: 0 },
    { label: '5-20K', min: 5000, max: 20000, count: 0, winners: 0 },
    { label: '20-50K', min: 20000, max: 50000, count: 0, winners: 0 },
    { label: '50-100K', min: 50000, max: 100000, count: 0, winners: 0 },
    { label: '100K+', min: 100000, max: Infinity, count: 0, winners: 0 },
  ];
  for (const c of calls) {
    for (const b of mcBuckets) {
      if (c.entryMC >= b.min && c.entryMC < b.max) {
        b.count++;
        if ((c.peakMultiplier ?? 1) >= 2) b.winners++;
        break;
      }
    }
  }

  // ── Hourly distribution of calls ──
  const hourlyDist = new Array(24).fill(0);
  for (const c of calls) {
    const h = new Date(c.entryTime).getHours();
    hourlyDist[h]++;
  }

  // ── Daily PnL aggregation ──
  const dailyPnl: Record<string, { paper: number; real: number; count: number }> = {};
  for (const t of closedTrades) {
    const day = new Date(t.closedTime ?? t.entryTime).toISOString().slice(0, 10);
    if (!dailyPnl[day]) dailyPnl[day] = { paper: 0, real: 0, count: 0 };
    dailyPnl[day].paper += t.finalPnlSol ?? 0;
    dailyPnl[day].count++;
  }
  for (const p of closedPositions) {
    const day = new Date(p.closedTime ?? p.entryTime).toISOString().slice(0, 10);
    if (!dailyPnl[day]) dailyPnl[day] = { paper: 0, real: 0, count: 0 };
    dailyPnl[day].real += p.finalPnlSol ?? 0;
  }

  return {
    overview: {
      totalCalls: calls.length,
      totalPaperTrades: trades.length,
      totalRealPositions: positions.length,
      openPaperTrades: trades.filter(t => t.status === 'open').length,
      openRealPositions: positions.filter(p => p.status === 'open').length,
      paperWinRate: closedTrades.length > 0 ? (paperWins.length / closedTrades.length * 100) : 0,
      realWinRate: closedPositions.length > 0 ? (realWins.length / closedPositions.length * 100) : 0,
      paperWins: paperWins.length,
      paperLosses: closedTrades.length - paperWins.length,
      realWins: realWins.length,
      realLosses: closedPositions.length - realWins.length,
      totalPaperPnl,
      totalRealPnl,
      totalRealInvested,
      realROI: totalRealInvested > 0 ? (totalRealPnl / totalRealInvested * 100) : 0,
      bestPaper: bestPaper ? { symbol: bestPaper.symbol, pnl: bestPaper.finalPnlSol ?? 0 } : null,
      worstPaper: worstPaper ? { symbol: worstPaper.symbol, pnl: worstPaper.finalPnlSol ?? 0 } : null,
      bestReal: bestReal ? { symbol: bestReal.symbol, pnl: bestReal.finalPnlSol ?? 0, peakMult: bestReal.peakMultiplier } : null,
      worstReal: worstReal ? { symbol: worstReal.symbol, pnl: worstReal.finalPnlSol ?? 0 } : null,
      avgPaperPnl: closedTrades.length > 0 ? totalPaperPnl / closedTrades.length : 0,
      avgRealPnl: closedPositions.length > 0 ? totalRealPnl / closedPositions.length : 0,
    },
    paperExitReasons,
    realExitReasons,
    tpHitRates: {
      paper: { total: closedTrades.length, tp1: paperTP1, tp2: paperTP2, tp3: paperTP3 },
      real: { total: closedPositions.length, tp1: realTP1, tp2: realTP2, tp3: realTP3 },
    },
    peakBuckets,
    milestoneCounts,
    milestoneTargets,
    paperPnlTimeline,
    realPnlTimeline,
    tradePnlBars,
    realPnlBars,
    callsWithPeaks: callsWithPeaks.slice(0, 50), // top 50
    mcBuckets,
    hourlyDist,
    dailyPnl,
    positions: closedPositions,
  };
}

// ── HTML Template ───────────────────────────────────────────

// Server-side color constants (same as client-side)
const C = {
  GREEN: '#10b981',
  RED: '#ef4444',
  BLUE: '#3b82f6',
  PURPLE: '#8b5cf6',
  ORANGE: '#f59e0b',
  CYAN: '#06b6d4',
  PINK: '#ec4899',
};

// ── Strategy Lab ────────────────────────────────────────────
// Paper-trades EVERY recorded call through multiple exit strategies (peak-multiplier
// model: price rises entry→peak then falls until the exit triggers). Same model the
// -45% trailing switch was backtested with. Ignores path dips + slippage.

function stratLadder(P: number, tps: [number, number][], trailDrop: number, sl = 0.75): number {
  let proceeds = 0, remaining = 1, hitAny = false;
  for (const [mult, frac] of tps) {
    if (P >= mult) { proceeds += frac * mult; remaining -= frac; hitAny = true; } else break;
  }
  const allHit = P >= tps[tps.length - 1][0];
  if (remaining > 1e-9) {
    const exitMult = allHit ? Math.max(P * (1 - trailDrop), 1.0) : hitAny ? 1.0 : sl;
    proceeds += remaining * exitMult;
  }
  return proceeds;
}
function stratTrailing(P: number, drop: number): number {
  return Math.max(P * (1 - drop), 1 - drop);
}
function stratHybrid(P: number, tpMult: number, tpFrac: number, drop: number): number {
  if (P >= tpMult) return tpFrac * tpMult + (1 - tpFrac) * Math.max(P * (1 - drop), 1 - drop);
  return stratTrailing(P, drop);
}

const STRATEGIES: { key: string; name: string; color: string; fn: (P: number) => number }[] = [
  { key: 'live',    name: '−45% trailing (LIVE)',         color: C.GREEN,  fn: P => stratTrailing(P, 0.45) },
  { key: 'trail35', name: '−35% trailing',                color: C.CYAN,   fn: P => stratTrailing(P, 0.35) },
  { key: 'trail55', name: '−55% trailing',                color: C.BLUE,   fn: P => stratTrailing(P, 0.55) },
  { key: 'ladder',  name: 'TP ladder 1.5/2.5/4 (paper)',  color: C.ORANGE, fn: P => stratLadder(P, [[1.5, 0.4], [2.5, 0.3], [4, 0.2]], 0.45) },
  { key: 'hyb3',    name: '40% @ 3X + trail −45%',        color: C.PURPLE, fn: P => stratHybrid(P, 3, 0.4, 0.45) },
  { key: 'hyb2',    name: '50% @ 2X + trail −45%',        color: C.PINK,   fn: P => stratHybrid(P, 2, 0.5, 0.45) },
];

function buildStrategyData(range: TimeRange = 'all') {
  let calls: CallRecord[] = loadJSON(join(CONFIG.DATA_DIR, 'calls.json'));
  calls = calls.filter(c => (c.peakMultiplier ?? 0) > 0);
  if (range !== 'all') {
    const cutoff = Date.now() - RANGE_MS[range];
    calls = calls.filter(c => c.entryTime >= cutoff);
  }
  calls.sort((a, b) => a.entryTime - b.entryTime);
  const n = calls.length;

  const summaries: any[] = [];
  const curves: Record<string, number[]> = {};
  for (const s of STRATEGIES) {
    let cum = 0, wins = 0, worst = Infinity, best = -Infinity, total = 0;
    const curve: number[] = [];
    for (const c of calls) {
      const ret = s.fn(c.peakMultiplier);
      total += ret;
      cum += ret - 1;
      curve.push(+cum.toFixed(3));
      if (ret > 1.02) wins++;
      if (ret < worst) worst = ret;
      if (ret > best) best = ret;
    }
    curves[s.key] = curve;
    summaries.push({
      key: s.key, name: s.name, color: s.color,
      avgPerCall: n > 0 ? +(total / n).toFixed(3) : 0,
      totalPnl: +cum.toFixed(1),
      winPct: n > 0 ? +(wins / n * 100).toFixed(0) : 0,
      worst: n > 0 ? +worst.toFixed(2) : 0,
      best: n > 0 ? +best.toFixed(1) : 0,
    });
  }
  summaries.sort((a, b) => b.avgPerCall - a.avgPerCall);

  const peaksAxis = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 15, 20, 30, 50, 75, 100, 125];
  const payoutCurves = STRATEGIES.map(s => ({
    key: s.key, name: s.name, color: s.color,
    payouts: peaksAxis.map(P => +s.fn(P).toFixed(2)),
  }));

  const recent = [...calls].slice(-30).reverse().map(c => ({
    symbol: c.symbol,
    date: new Date(c.entryTime).toISOString().slice(5, 16).replace('T', ' '),
    peak: +c.peakMultiplier.toFixed(2),
    rets: STRATEGIES.map(s => +s.fn(c.peakMultiplier).toFixed(2)),
  }));

  return {
    totalCalls: n,
    avgPeak: n > 0 ? +(calls.reduce((s, c) => s + c.peakMultiplier, 0) / n).toFixed(2) : 0,
    labels: calls.map(c => new Date(c.entryTime).toISOString().slice(5, 10)),
    summaries, curves, peaksAxis, payoutCurves, recent,
    strategyNames: STRATEGIES.map(s => ({ key: s.key, name: s.name, color: s.color })),
  };
}

function buildStrategyHTML(d: ReturnType<typeof buildStrategyData>, activeRange: TimeRange = 'all'): string {
  const tiles = d.summaries.map((s: any) => `
    <div class="tile" style="border-top:2px solid ${s.color}">
      <div class="tile-name">${s.name}</div>
      <div class="tile-big" style="color:${s.color}">${s.avgPerCall}X</div>
      <div class="tile-sub">avg per call · <b>${s.totalPnl > 0 ? '+' : ''}${s.totalPnl} SOL</b> total (1 SOL/call)</div>
      <div class="tile-sub">${s.winPct}% wins · worst ${s.worst}X · best ${s.best}X</div>
    </div>`).join('');

  const summaryRows = d.summaries.map((s: any, i: number) => `
    <tr>
      <td>${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : ''} <span style="color:${s.color}">●</span> ${s.name}</td>
      <td class="mono"><b>${s.avgPerCall}X</b></td>
      <td class="mono">${s.totalPnl > 0 ? '+' : ''}${s.totalPnl}</td>
      <td class="mono">${s.winPct}%</td>
      <td class="mono">${s.worst}X</td>
      <td class="mono">${s.best}X</td>
    </tr>`).join('');

  const recentRows = d.recent.map((r: any) => `
    <tr>
      <td><b>$${r.symbol}</b></td>
      <td class="mono" style="color:var(--text2)">${r.date}</td>
      <td class="mono"><b>${r.peak}X</b></td>
      ${r.rets.map((x: number, i: number) => `<td class="mono" style="color:${x >= 1.02 ? C.GREEN : x <= 0.98 ? C.RED : 'var(--text2)'}">${x}X</td>`).join('')}
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="60">
<title>PumpClaw Strategy Lab</title>
<script src="/chart.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#06080d;--bg1:#0a0e17;--bg2:#0f1420;--bg3:#151b28;--border:#1a2035;--border2:#242e44;--text:#c8d3e6;--text2:#7a879e;--text3:#4a5570}
body{background:var(--bg);color:var(--text);font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px}
.mono{font-family:'SF Mono',Menlo,Consolas,monospace}
.topbar{display:flex;justify-content:space-between;align-items:center;padding:14px 22px;border-bottom:1px solid var(--border);background:var(--bg1)}
.topbar h1{font-size:17px}
.topbar a{color:var(--text2);text-decoration:none;font-size:13px}
.topbar a:hover{color:var(--text)}
.wrap{max-width:1200px;margin:0 auto;padding:20px 22px}
.tf{display:flex;gap:4px;margin:14px 0}
.tf a{padding:4px 12px;border-radius:6px;color:var(--text2);text-decoration:none;font-size:12px;border:1px solid var(--border)}
.tf a.active{background:var(--bg3);color:var(--text);border-color:var(--border2)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin:16px 0}
.tile{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px}
.tile-name{font-size:12px;color:var(--text2);margin-bottom:6px}
.tile-big{font-size:26px;font-weight:700}
.tile-sub{font-size:11px;color:var(--text3);margin-top:4px}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;margin:16px 0}
.card h3{font-size:13px;color:var(--text2);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:var(--text3);text-align:left;padding:6px 10px;font-size:11px;text-transform:uppercase}
td{padding:6px 10px;border-top:1px solid var(--border)}
.note{font-size:11px;color:var(--text3);margin:10px 0 30px}
canvas{max-height:340px}
</style>
</head>
<body>
<div class="topbar">
  <h1>🧪 Strategy Lab <span style="font-size:12px;color:var(--text3);font-weight:400">(model — superseded)</span></h1>
  <div style="display:flex;gap:14px"><a href="/shadow">📄 Shadow Fleet</a><a href="/?range=${activeRange}">← Dashboard</a></div>
</div>
<div class="wrap">
  <div style="background:#2a1f0a;border:1px solid #7a5a1a;border-radius:10px;padding:14px 16px;margin-bottom:16px;font-size:13px;line-height:1.6">
    <b style="color:#ffd75e">⚠️ This page shows only the 6 original strategies, and its model is unreliable.</b><br>
    It assumes every coin goes entry → peak → down, so a trailing stop always catches the peak. Real price paths
    dip <i>through</i> the stop first — median drawdown before peak is 29%. That's why this page ranked pure trailing
    best while it actually lost the most money.<br>
    <a href="/shadow" style="color:#9be826;font-weight:700">→ Go to the Shadow Fleet</a>
    <span style="color:var(--text2)">— all 61 strategies paper-trading live prices, with real fills and real paths.</span>
  </div>
  <div class="tf">
    ${(['24h', '7d', 'all'] as TimeRange[]).map(r =>
      `<a href="/strategies?range=${r}" class="${activeRange === r ? 'active' : ''}">${RANGE_LABELS[r]}</a>`).join('')}
    <span style="margin-left:auto;font-size:12px;color:var(--text3)">${d.totalCalls} calls · avg peak ${d.avgPeak}X · auto-refresh 60s</span>
  </div>

  <div class="tiles">${tiles}</div>

  <div class="card">
    <h3>Cumulative PnL — 1 SOL per call, every strategy on every call</h3>
    <canvas id="equity"></canvas>
  </div>

  <div class="card">
    <h3>Payout vs coin peak — what 1 SOL returns when a call peaks at X</h3>
    <canvas id="payout"></canvas>
  </div>

  <div class="card">
    <h3>Strategy summary</h3>
    <table>
      <tr><th>Strategy</th><th>Avg/call</th><th>Total PnL (SOL)</th><th>Win%</th><th>Worst</th><th>Best</th></tr>
      ${summaryRows}
    </table>
  </div>

  <div class="card">
    <h3>Last ${d.recent.length} calls — payout per strategy</h3>
    <table>
      <tr><th>Coin</th><th>Called</th><th>Peak</th>${d.strategyNames.map((s: any) => `<th style="color:${s.color}">${s.name.split(' ')[0]} ${s.name.includes('LIVE') ? '(live)' : s.key === 'ladder' ? '(paper)' : ''}</th>`).join('')}</tr>
      ${recentRows}
    </table>
  </div>

  <div class="note">Model: price rises entry→peak, then falls until the exit fires. Assumes fills at exact stop levels — ignores dips on the way up, slippage, and fees. Live trading fills will be worse on collapsing microcaps. Paper trader (real fills simulation) runs the ladder as the control.</div>
</div>

<script>
const D = ${JSON.stringify({ labels: d.labels, curves: d.curves, names: d.strategyNames, peaksAxis: d.peaksAxis, payoutCurves: d.payoutCurves })};
const gridC = '#1a2035', tickC = '#7a879e';
const common = { responsive: true, plugins: { legend: { labels: { color: tickC, boxWidth: 12, font: { size: 11 } } } } };

new Chart(document.getElementById('equity'), {
  type: 'line',
  data: {
    labels: D.labels,
    datasets: D.names.map(s => ({
      label: s.name, data: D.curves[s.key], borderColor: s.color,
      borderWidth: s.key === 'live' ? 2.5 : 1.5, pointRadius: 0, tension: 0.15,
    })),
  },
  options: { ...common, scales: {
    x: { ticks: { color: tickC, maxTicksLimit: 12 }, grid: { color: gridC } },
    y: { ticks: { color: tickC, callback: v => v + ' SOL' }, grid: { color: gridC } },
  } },
});

new Chart(document.getElementById('payout'), {
  type: 'line',
  data: {
    labels: D.peaksAxis.map(p => p + 'X'),
    datasets: D.payoutCurves.map(s => ({
      label: s.name, data: s.payouts, borderColor: s.color,
      borderWidth: s.key === 'live' ? 2.5 : 1.5, pointRadius: 2, tension: 0.15,
    })),
  },
  options: { ...common, scales: {
    x: { ticks: { color: tickC }, grid: { color: gridC }, title: { display: true, text: 'coin peak from entry', color: tickC } },
    y: { type: 'logarithmic', ticks: { color: tickC, callback: v => v + 'X' }, grid: { color: gridC } },
  } },
});
</script>
</body>
</html>`;
}

function buildHTML(data: ReturnType<typeof buildDashboardData>, activeRange: TimeRange = 'all'): string {
  const d = data;
  const o = d.overview;

  // Compute derived display values
  const realWinPct = (o.realWins + o.realLosses) > 0 ? (o.realWins / (o.realWins + o.realLosses) * 100) : 0;
  const paperWinPct = (o.paperWins + o.paperLosses) > 0 ? (o.paperWins / (o.paperWins + o.paperLosses) * 100) : 0;
  const tp1Pct = d.tpHitRates.real.total > 0 ? (d.tpHitRates.real.tp1 / d.tpHitRates.real.total * 100) : 0;
  const tp2Pct = d.tpHitRates.real.total > 0 ? (d.tpHitRates.real.tp2 / d.tpHitRates.real.total * 100) : 0;
  const tp3Pct = d.tpHitRates.real.total > 0 ? (d.tpHitRates.real.tp3 / d.tpHitRates.real.total * 100) : 0;

  // Milestone hit rates
  const ms2Pct = o.totalCalls > 0 ? ((d.milestoneCounts[2] ?? 0) / o.totalCalls * 100) : 0;
  const ms5Pct = o.totalCalls > 0 ? ((d.milestoneCounts[5] ?? 0) / o.totalCalls * 100) : 0;
  const ms10Pct = o.totalCalls > 0 ? ((d.milestoneCounts[10] ?? 0) / o.totalCalls * 100) : 0;

  // Average peak
  let peakSum = 0, peakCount = 0;
  for (const c of d.callsWithPeaks) { peakSum += c.peakMultiplier; peakCount++; }
  const avgPeak = peakCount > 0 ? peakSum / peakCount : 1;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="60">
<title>PumpClaw Dashboard</title>
<script src="/chart.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:     #06080d;
  --bg1:    #0a0e17;
  --bg2:    #0f1420;
  --bg3:    #151b28;
  --border: #1a2035;
  --border2:#242e44;
  --text:   #c8d3e6;
  --text2:  #7a879e;
  --text3:  #4a5570;
  --green:  #00d672;
  --green2: #00ff88;
  --red:    #ff3b5c;
  --blue:   #4d8eff;
  --purple: #a47cff;
  --orange: #ff9f40;
  --cyan:   #00d4c8;
  --accent: #4d8eff;
}
body{background:var(--bg);color:var(--text);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh}
code,td,th,.mono{font-family:'JetBrains Mono','SF Mono',SFMono-Regular,ui-monospace,'Cascadia Code',monospace}
a{color:var(--accent);text-decoration:none}

/* layout */
.wrap{max-width:1440px;margin:0 auto;padding:0 32px 60px}

/* ── header bar ── */
.topbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:16px 32px;
  border-bottom:1px solid var(--border);
  background:var(--bg1);
  position:sticky;top:0;z-index:100;
  backdrop-filter:blur(12px);
}
.brand{display:flex;align-items:center;gap:10px}
.brand-icon{
  width:34px;height:34px;border-radius:9px;
  background:linear-gradient(135deg,#ff3b5c,#ff9f40,#ffcd3c);
  background-size:200% 200%;
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 0 16px rgba(255,59,92,0.4),0 0 32px rgba(255,159,64,0.15);
  animation:brandShine 4s ease-in-out infinite;
}
@keyframes brandShine{
  0%,100%{background-position:0% 50%}
  50%{background-position:100% 50%}
}
.brand-icon svg{width:19px;height:19px}
.brand h1{
  font-size:17px;font-weight:700;letter-spacing:-0.3px;
  background:linear-gradient(135deg,#fff,#c8d3e6);
  -webkit-background-clip:text;background-clip:text;
  -webkit-text-fill-color:transparent;
}
.brand .ver{font-size:10px;color:var(--text3);margin-left:4px;font-weight:400}
.meta{display:flex;align-items:center;gap:16px;font-size:12px;color:var(--text3)}
.meta .dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}

/* ── sub nav ── */
.subnav{
  display:flex;align-items:center;justify-content:space-between;
  padding:14px 0;margin-bottom:24px;margin-top:20px;
  border-bottom:1px solid var(--border);
}
.counts{display:flex;gap:20px;font-size:12px;color:var(--text2)}
.counts strong{color:var(--text);font-weight:600}
.tf{display:flex;gap:1px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:3px;overflow:hidden}
.tf a{
  display:block;padding:5px 14px;border-radius:6px;font-size:11px;font-weight:500;
  color:var(--text3);text-decoration:none;transition:all 0.2s;letter-spacing:0.2px;
}
.tf a:hover{color:var(--text);background:var(--bg3)}
.tf .active{background:var(--accent);color:#fff}

/* ── hero PnL ── */
.hero{
  display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;
}
.hero-card{
  background:linear-gradient(135deg,var(--bg1),var(--bg2));
  border:1px solid var(--border);border-radius:14px;padding:28px 32px;
  position:relative;overflow:hidden;
}
.hero-card::before{
  content:'';position:absolute;top:0;left:0;right:0;height:3px;
}
.hero-card::after{
  content:'';position:absolute;inset:0;border-radius:14px;pointer-events:none;
  opacity:0.04;background:radial-gradient(circle at top right,var(--accent),transparent 70%);
}
.hero-real::before{background:linear-gradient(90deg,var(--green),var(--cyan))}
.hero-paper::before{background:linear-gradient(90deg,var(--blue),var(--purple))}
.hero-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:var(--text3);margin-bottom:14px}
.hero-val{font-size:46px;font-weight:800;font-family:'JetBrains Mono','SF Mono',monospace;letter-spacing:-2px;line-height:1}
.hero-sub{display:flex;gap:20px;margin-top:12px;font-size:12px;color:var(--text2)}
.hero-sub span{display:flex;align-items:center;gap:5px}
.hero-pct{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;font-family:'JetBrains Mono',monospace}
.pct-g{background:rgba(0,214,114,0.1);color:var(--green)}
.pct-r{background:rgba(255,59,92,0.1);color:var(--red)}

/* ── metric strip ── */
.metrics{
  display:grid;grid-template-columns:repeat(6,1fr);gap:1px;
  background:var(--border);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:24px;
}
.m{background:var(--bg1);padding:16px 18px}
.m .k{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text3);margin-bottom:6px}
.m .v{font-size:18px;font-weight:700;font-family:'JetBrains Mono',monospace;letter-spacing:-0.5px;color:#fff}
.m .d{font-size:11px;color:var(--text3);margin-top:4px}
.m .bar{height:3px;background:var(--bg3);border-radius:2px;margin-top:8px;overflow:hidden}
.m .bar-fill{height:100%;border-radius:2px;transition:width 0.6s ease}

/* colors */
.g{color:var(--green)}.r{color:var(--red)}.b{color:var(--blue)}.o{color:var(--orange)}.p{color:var(--purple)}.dim{color:var(--text3)}

/* ── cards ── */
.row{display:grid;gap:16px;margin-bottom:16px}
.r2{grid-template-columns:1fr 1fr}
.r3{grid-template-columns:1fr 1fr 1fr}
.r1{grid-template-columns:1fr}
.card{
  background:var(--bg1);border:1px solid var(--border);border-radius:10px;
  padding:20px 22px;overflow:hidden;
}
.card h3{
  font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;
  color:var(--text2);margin-bottom:16px;
  display:flex;align-items:center;gap:8px;
}
.card h3 .icon{width:16px;height:16px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:9px}
.ch{position:relative;height:280px}
.ch.lg{height:360px}

/* ── tables ── */
.tbl{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{
  text-align:left;padding:10px 12px;color:var(--text3);font-size:10px;font-weight:600;
  text-transform:uppercase;letter-spacing:0.6px;
  border-bottom:1px solid var(--border2);white-space:nowrap;
  background:var(--bg2);
}
th:first-child{border-radius:6px 0 0 0}
th:last-child{border-radius:0 6px 0 0}
td{padding:10px 12px;border-bottom:1px solid var(--border);white-space:nowrap;font-size:12px}
tbody tr{transition:background 0.15s}
tbody tr:hover td{background:rgba(77,142,255,0.04)}
tbody tr:nth-child(even) td{background:rgba(255,255,255,0.01)}
tbody tr:nth-child(even):hover td{background:rgba(77,142,255,0.04)}

.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;line-height:16px;letter-spacing:0.3px}
.tag-g{background:rgba(0,214,114,0.1);color:var(--green)}
.tag-r{background:rgba(255,59,92,0.1);color:var(--red)}
.tag-b{background:rgba(77,142,255,0.1);color:var(--blue)}
.tag-p{background:rgba(164,124,255,0.1);color:var(--purple)}
.tag-o{background:rgba(255,159,64,0.1);color:var(--orange)}

/* ── exit breakdown ── */
.exit-grid{display:flex;flex-direction:column;gap:14px;padding:4px 0}
.exit-row{display:flex;align-items:center;gap:12px}
.exit-label{width:110px;font-size:12px;font-weight:500;color:var(--text)}
.exit-bar-wrap{flex:1;height:8px;background:var(--bg3);border-radius:4px;overflow:hidden}
.exit-bar{height:100%;border-radius:4px;transition:width 0.5s ease}
.exit-val{min-width:70px;text-align:right;font-size:12px;color:var(--text2)}

/* ── section dividers ── */
.section-title{
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;
  color:var(--text3);padding:20px 0 12px;
  border-top:1px solid var(--border);margin-top:8px;
  display:flex;align-items:center;justify-content:space-between;
}
.section-title .badge{
  display:inline-flex;align-items:center;gap:6px;padding:3px 10px;
  background:var(--bg2);border:1px solid var(--border);border-radius:12px;
  font-size:10px;color:var(--text2);text-transform:none;letter-spacing:0;
}

/* ── Hall of Fame runner cards ── */
.runners{
  display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));
  gap:12px;margin-bottom:24px;
}
.runner{
  position:relative;background:var(--bg1);border:1px solid var(--border);
  border-radius:12px;padding:16px 18px;transition:all 0.2s;overflow:hidden;
  cursor:default;
}
.runner:hover{border-color:var(--border2);transform:translateY(-2px)}
.runner::before{
  content:'';position:absolute;inset:0;border-radius:12px;pointer-events:none;
  opacity:0.06;background:radial-gradient(circle at top right,var(--accent),transparent 60%);
}
.runner-rank{
  position:absolute;top:10px;right:12px;font-size:10px;font-weight:600;
  color:var(--text3);font-family:'JetBrains Mono',monospace;
}
.runner-sym{
  font-size:18px;font-weight:700;color:#fff;letter-spacing:-0.3px;
  margin-bottom:2px;display:flex;align-items:center;gap:6px;
}
.runner-name{font-size:11px;color:var(--text3);margin-bottom:14px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;
}
.runner-peak{
  font-size:32px;font-weight:800;font-family:'JetBrains Mono',monospace;
  letter-spacing:-1px;line-height:1;margin-bottom:8px;
  background:linear-gradient(135deg,var(--green),var(--cyan));
  -webkit-background-clip:text;background-clip:text;
  -webkit-text-fill-color:transparent;
}
.runner-peak.huge{background:linear-gradient(135deg,#ff9f40,#ff3b5c)}
.runner-peak.mid{background:linear-gradient(135deg,var(--blue),var(--purple))}
.runner-peak,.runner-peak.huge,.runner-peak.mid{
  -webkit-background-clip:text;background-clip:text;
  -webkit-text-fill-color:transparent;
}
.runner-mc{font-size:11px;color:var(--text2);margin-bottom:10px;font-family:'JetBrains Mono',monospace}
.runner-mc strong{color:var(--text)}
.runner-ms{display:flex;flex-wrap:wrap;gap:4px}
.runner-ms .ms{
  font-size:9px;font-weight:600;padding:2px 6px;border-radius:3px;
  background:rgba(0,214,114,0.12);color:var(--green);
  font-family:'JetBrains Mono',monospace;
}
.runner-date{font-size:10px;color:var(--text3);margin-top:8px;font-family:'JetBrains Mono',monospace}

/* ── trophy icons for top 3 ── */
.runner.gold{
  border-color:rgba(255,215,0,0.35);
  box-shadow:0 0 24px rgba(255,215,0,0.08),inset 0 1px 0 rgba(255,215,0,0.15);
}
.runner.gold::before{
  opacity:0.18;
  background:radial-gradient(circle at top right,#ffd700,transparent 65%);
  animation:goldPulse 3s ease-in-out infinite;
}
@keyframes goldPulse{0%,100%{opacity:0.14}50%{opacity:0.22}}
.runner.silver{
  border-color:rgba(192,192,192,0.28);
  box-shadow:0 0 18px rgba(192,192,192,0.06);
}
.runner.silver::before{opacity:0.1;background:radial-gradient(circle at top right,#c0c0c0,transparent 60%)}
.runner.bronze{
  border-color:rgba(205,127,50,0.28);
  box-shadow:0 0 18px rgba(205,127,50,0.06);
}
.runner.bronze::before{opacity:0.1;background:radial-gradient(circle at top right,#cd7f32,transparent 60%)}

/* ── refresh indicator ── */
.refresh-indicator{
  display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text3);
}
.refresh-indicator .spinner{
  width:10px;height:10px;border:1.5px solid var(--border2);border-top-color:var(--accent);
  border-radius:50%;animation:spin 1s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── milestone funnel ── */
.funnel{
  display:grid;grid-template-columns:repeat(7,1fr);gap:10px;margin-top:8px;
}
.funnel-step{
  position:relative;background:var(--bg2);border:1px solid var(--border);
  border-radius:10px;padding:18px 14px 14px;text-align:center;
  transition:all 0.2s;
}
.funnel-step:hover{transform:translateY(-1px);border-color:var(--border2)}
.funnel-step.active{
  background:linear-gradient(180deg,rgba(0,214,114,0.10),rgba(0,214,114,0.02));
  border-color:rgba(0,214,114,0.4);
}
.funnel-step.gold{
  background:linear-gradient(180deg,rgba(255,215,0,0.10),rgba(255,215,0,0.02));
  border-color:rgba(255,215,0,0.35);
}
.funnel-step.fire{
  background:linear-gradient(180deg,rgba(255,159,64,0.10),rgba(255,59,92,0.02));
  border-color:rgba(255,159,64,0.35);
}
.funnel-step.diamond{
  background:linear-gradient(180deg,rgba(164,124,255,0.10),rgba(0,212,200,0.02));
  border-color:rgba(164,124,255,0.4);
}
.funnel-target{
  font-size:12px;font-weight:700;font-family:'JetBrains Mono',monospace;
  color:var(--text3);letter-spacing:0.3px;margin-bottom:8px;
}
.funnel-step.active .funnel-target,
.funnel-step.gold .funnel-target,
.funnel-step.fire .funnel-target,
.funnel-step.diamond .funnel-target{color:var(--text)}
.funnel-count{
  font-size:24px;font-weight:800;font-family:'JetBrains Mono',monospace;
  letter-spacing:-1px;line-height:1;color:#fff;margin-bottom:4px;
}
.funnel-pct{font-size:10px;color:var(--text2);font-family:'JetBrains Mono',monospace}
.funnel-bar{
  position:absolute;bottom:0;left:0;height:3px;border-radius:0 0 10px 10px;
  background:linear-gradient(90deg,var(--green),var(--cyan));
  transition:width 0.6s ease;
}
.funnel-step.gold .funnel-bar{background:linear-gradient(90deg,#ffd700,#ffaa00)}
.funnel-step.fire .funnel-bar{background:linear-gradient(90deg,#ff9f40,#ff3b5c)}
.funnel-step.diamond .funnel-bar{background:linear-gradient(90deg,var(--purple),var(--cyan))}

/* ── win rate gauge ── */
.gauge-wrap{display:flex;align-items:center;gap:24px;padding:8px 0}
.gauge{
  position:relative;width:140px;height:140px;flex-shrink:0;
}
.gauge svg{width:100%;height:100%;transform:rotate(-90deg)}
.gauge-track{fill:none;stroke:var(--bg3);stroke-width:10;}
.gauge-fill{fill:none;stroke:url(#gaugeGrad);stroke-width:10;stroke-linecap:round;
  transition:stroke-dasharray 0.8s ease;
}
.gauge-text{
  position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;
}
.gauge-pct{font-size:28px;font-weight:800;font-family:'JetBrains Mono',monospace;
  letter-spacing:-1.5px;color:#fff;line-height:1;
}
.gauge-label{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.gauge-stats{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:14px}
.gauge-stat{padding:8px 0}
.gauge-stat .gs-k{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:4px}
.gauge-stat .gs-v{font-size:18px;font-weight:700;font-family:'JetBrains Mono',monospace;letter-spacing:-0.5px;color:#fff}

/* ── glow effect for big numbers ── */
.glow-g{text-shadow:0 0 20px rgba(0,214,114,0.4)}
.glow-r{text-shadow:0 0 20px rgba(255,59,92,0.3)}
.glow-b{text-shadow:0 0 20px rgba(77,142,255,0.3)}

/* ── MC distribution bars ── */
.mc-grid{display:flex;flex-direction:column;gap:14px;padding:4px 0}
.mc-row{display:grid;grid-template-columns:80px 1fr 90px;gap:12px;align-items:center}
.mc-label{font-size:12px;font-weight:600;color:var(--text);font-family:'JetBrains Mono',monospace}
.mc-bar-wrap{position:relative;height:24px;background:var(--bg3);border-radius:6px;overflow:hidden}
.mc-bar-total{
  position:absolute;inset:0;background:linear-gradient(90deg,var(--bg3),rgba(77,142,255,0.15));
  transition:width 0.6s ease;
}
.mc-bar-wins{
  position:absolute;left:0;top:0;bottom:0;border-radius:6px 0 0 6px;
  background:linear-gradient(90deg,var(--green),var(--cyan));
  transition:width 0.6s ease;
}
.mc-numbers{display:flex;justify-content:space-between;font-size:11px;color:var(--text2);font-family:'JetBrains Mono',monospace}
.mc-numbers .winrate{color:var(--green);font-weight:600}

/* ── hourly heatmap ── */
.hour-grid{
  display:grid;grid-template-columns:repeat(24,1fr);gap:3px;padding:4px 0;
}
.hour-cell{
  aspect-ratio:1;border-radius:4px;background:var(--bg3);
  position:relative;transition:all 0.2s;
  display:flex;align-items:flex-end;justify-content:center;
  font-size:9px;color:var(--text3);
  padding-bottom:1px;
}
.hour-cell:hover{transform:scale(1.15);z-index:2;box-shadow:0 4px 12px rgba(0,0,0,0.5)}
.hour-cell.h0{background:var(--bg3);color:var(--text3)}
.hour-cell.h1{background:rgba(77,142,255,0.15);color:var(--text2)}
.hour-cell.h2{background:rgba(77,142,255,0.30);color:var(--text2)}
.hour-cell.h3{background:rgba(77,142,255,0.50);color:#fff}
.hour-cell.h4{background:rgba(77,142,255,0.75);color:#fff}
.hour-cell.h5{background:linear-gradient(135deg,#4d8eff,#a47cff);color:#fff;box-shadow:0 0 12px rgba(77,142,255,0.4)}
.hour-axis{display:grid;grid-template-columns:repeat(24,1fr);gap:3px;margin-top:6px}
.hour-axis div{font-size:9px;color:var(--text3);text-align:center;font-family:'JetBrains Mono',monospace}

/* ── live status pill ── */
.live-pill{
  display:inline-flex;align-items:center;gap:6px;padding:4px 10px;
  background:rgba(0,214,114,0.10);border:1px solid rgba(0,214,114,0.3);
  border-radius:14px;font-size:10px;color:var(--green);
  font-weight:600;letter-spacing:0.5px;text-transform:uppercase;
}
.live-pill .live-dot{
  width:6px;height:6px;border-radius:50%;background:var(--green);
  box-shadow:0 0 8px var(--green);animation:pulse 2s infinite;
}

@media(max-width:1100px){
  .metrics{grid-template-columns:repeat(3,1fr)}
  .hero{grid-template-columns:1fr}
  .funnel{grid-template-columns:repeat(4,1fr)}
  .funnel-step:nth-child(n+5){grid-column:span 1}
}
@media(max-width:900px){
  .r2{grid-template-columns:1fr}
  .metrics{grid-template-columns:repeat(2,1fr)}
  .wrap{padding:0 16px 40px}
  .topbar{padding:12px 16px;flex-wrap:wrap;gap:10px}
  .runners{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
  .funnel{grid-template-columns:repeat(3,1fr)}
  .gauge-wrap{flex-direction:column;align-items:center;gap:14px}
  .gauge-stats{grid-template-columns:repeat(4,1fr);width:100%}
  .hero-val{font-size:36px}
  .meta .live-pill{display:none}
  .meta .refresh-indicator span{display:none}
  .mc-row{grid-template-columns:60px 1fr 80px;gap:8px}
}
@media(max-width:600px){
  .funnel{grid-template-columns:repeat(2,1fr)}
  .runners{grid-template-columns:1fr 1fr}
  .runner-peak{font-size:26px}
  .hero-val{font-size:28px}
  .gauge{width:110px;height:110px}
  .gauge-pct{font-size:22px}
}
</style>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
</head>
<body>

<!-- ── top bar ── -->
<div class="topbar">
  <div class="brand">
    <div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><path d="M5 2L9 14"/><path d="M9 2L12 14"/><path d="M13 2L15 14"/><path d="M17 4L18 12"/><path d="M3 18Q12 12 21 18"/></svg></div>
    <h1>PumpClaw<span class="ver">v2</span></h1>
  </div>
  <div class="meta">
    <div class="live-pill"><div class="live-dot"></div>Live · ${o.openPaperTrades} open</div>
    <div class="refresh-indicator"><div class="spinner"></div><span>auto-refresh 60s</span></div>
    <span class="mono" style="font-size:11px;color:var(--text3)">${new Date().toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}</span>
  </div>
</div>

<div class="wrap">

<!-- ── sub nav ── -->
<div class="subnav">
  <div class="counts">
    <span><strong>${o.totalCalls}</strong> calls</span>
    <span><strong>${o.totalRealPositions}</strong> real trades</span>
    <span><strong>${o.openPaperTrades + o.openRealPositions}</strong> open</span>
  </div>
  <div class="tf">
    ${(['1h','6h','12h','24h','7d','all'] as TimeRange[]).map(r =>
      `<a href="/?range=${r}" class="${activeRange===r?'active':''}">${RANGE_LABELS[r]}</a>`
    ).join('')}
    <a href="/strategies" style="border-color:var(--border2)">🧪 Strategy Lab</a>
    <a href="/tasks" style="border-color:var(--border2)">🤖 Tasks</a>
    <a href="/shadow" style="border-color:var(--border2)">📄 Shadow Fleet</a>
    <a href="/settings" style="border-color:var(--border2)">⚙️ Settings</a>
  </div>
</div>

<!-- ── top strategies ── -->
<div class="card" style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;margin:16px 0">
  <h3 style="font-size:13px;color:var(--text2);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">🏆 Top strategies (last 24h) <a href="/shadow" style="float:right;font-size:11px;color:#3b82f6;text-transform:none;letter-spacing:0">all 111 →</a></h3>
  <div id="ts-body" style="font-size:13px;color:var(--text3)">Loading…</div>
</div>
<script>
(function () {
  async function tick() {
    const body = document.getElementById('ts-body');
    try {
      const d = await (await fetch('/api/shadow?hours=24')).json();
      const s = (d.strategies || []).filter(x => x.trades >= 5).sort((a, b) => b.avgPerTrade - a.avgPerTrade).slice(0, 5);
      if (!s.length) { body.innerHTML = '<span style="color:var(--text3)">Not enough closed trades in the last 24h yet.</span>'; return; }
      body.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
        '<tr>' + ['#', 'Strategy', 'Trades', 'Win', 'Avg/trade', 'Total'].map(h => '<th style="color:var(--text3);text-align:left;padding:4px 8px;font-size:11px;text-transform:uppercase">' + h + '</th>').join('') + '</tr>' +
        s.map((x, i) => '<tr>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border);color:var(--text3)">' + (i + 1) + '</td>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border)"><b>' + x.strategy + '</b></td>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border)">' + x.trades + '</td>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border)">' + x.winPct + '%</td>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border);font-weight:700;color:' + (x.avgPerTrade >= 0.03 ? '#10b981' : x.avgPerTrade >= 0 ? '#f59e0b' : '#ef4444') + '">' + (x.avgPerTrade >= 0 ? '+' : '') + x.avgPerTrade.toFixed(3) + '</td>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border);color:' + (x.pnlSol >= 0 ? '#10b981' : '#ef4444') + '">' + (x.pnlSol >= 0 ? '+' : '') + x.pnlSol.toFixed(2) + ' ◎</td>' +
          '</tr>').join('') + '</table>' +
        '<div style="font-size:11px;color:var(--text3);margin-top:8px">Green = clears the ~3% real-fee break-even. Paper trades, 1 SOL each.</div>';
    } catch (e) { body.innerHTML = '<span style="color:var(--text3)">unavailable</span>'; }
  }
  tick(); setInterval(tick, 60000);
})();
</script>

<!-- ── running tasks ── -->
<div class="card" style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;margin:16px 0">
  <h3 style="font-size:13px;color:var(--text2);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">🤖 Trading Tasks <span id="tk-status" style="margin-left:auto;font-size:11px;float:right;text-transform:none;letter-spacing:0;color:var(--text3)"></span></h3>
  <div id="tk-body" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;font-size:13px"><span style="color:var(--text3)">Loading…</span></div>
</div>
<script>
(function () {
  async function tick() {
    const body = document.getElementById('tk-body');
    const st = document.getElementById('tk-status');
    try {
      const res = await fetch('/api/tasks-summary');
      if (res.status === 401) {
        body.innerHTML = '<span style="color:var(--text3)">🔒 <a href="/settings" style="color:#3b82f6">Log in</a> to view tasks</span>';
        return;
      }
      const d = await res.json();
      if (!d.tasks.length) {
        body.innerHTML = '<span style="color:var(--text3)">No tasks — <a href="/tasks" style="color:#3b82f6">create one</a></span>';
        return;
      }
      st.textContent = d.tasks.filter(t => t.enabled).length + '/' + d.tasks.length + ' running';
      body.innerHTML = d.tasks.map(t =>
        '<a href="/task?id=' + t.id + '" style="text-decoration:none;color:var(--text);background:var(--bg1);border:1px solid var(--border);border-left:3px solid ' + (t.paper ? '#8b5cf6' : t.enabled ? '#10b981' : '#4a5570') + ';border-radius:8px;padding:10px 12px;display:block">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><b>' + t.name + '</b>' +
        '<span style="font-size:11px;color:' + (t.enabled ? '#10b981' : 'var(--text3)') + '">' + (t.enabled ? '● RUNNING' : '○ paused') + '</span></div>' +
        '<div style="font-size:10px;color:' + (t.source === 'PumpClaw' ? 'var(--text3)' : '#f59e0b') + ';margin:3px 0">buys: ' + t.source + '</div>' +
        '<div style="font-size:11px;color:var(--text2);margin:4px 0">' + t.strategy + '</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;margin-top:6px">' +
        '<span>◎ ' + (t.balance === null ? '—' : t.balance.toFixed(3)) + '</span>' +
        '<span style="color:' + (t.pnl >= 0 ? '#10b981' : '#ef4444') + '">' + (t.pnl >= 0 ? '+' : '') + t.pnl + ' ◎</span>' +
        '<span style="color:var(--text2)">' + t.open + ' open · ' + t.wins + '/' + t.closed + 'W</span></div></a>'
      ).join('');
    } catch (e) {
      body.innerHTML = '<span style="color:var(--text3)">tasks unavailable — retrying</span>';
    }
  }
  tick();
  setInterval(tick, 20000);
})();
</script>

<!-- ── live trades ── -->
<div class="card" style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;margin:16px 0">
  <h3 style="font-size:13px;color:var(--text2);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;display:flex;align-items:center;gap:8px">
    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;animation:pulse 2s infinite"></span>
    Live Trades <span id="lt-status" style="margin-left:auto;font-size:11px;text-transform:none;letter-spacing:0;color:var(--text3)">loading…</span>
  </h3>
  <div id="lt-body" style="font-size:13px;color:var(--text3)">Loading…</div>
</div>
<script>
(function () {
  const fmtSol = n => (n >= 0 ? '+' : '') + n.toFixed(3) + ' SOL';
  async function tick() {
    try {
      const live = await (await fetch('/api/live')).json();
      const st = document.getElementById('lt-status');
      const body = document.getElementById('lt-body');
      st.textContent = (live.tradeEnabled ? 'LIVE MODE ON' : 'live mode OFF') +
        ' · ' + live.enabledCount + '/' + live.taskCount + ' tasks' +
        (live.balance !== null ? (' · combined ' + live.balance.toFixed(3) + ' SOL') : '');
      if (!live.open.length) {
        body.innerHTML = '<span style="color:var(--text3)">No open positions' +
          (live.tradeEnabled && live.enabledCount > 0 ? ' — ' + live.enabledCount + ' task(s) armed for the next call.' : ' — no tasks running (Tasks page).') + '</span>';
        return;
      }
      const mints = live.open.map(p => p.mint).join(',');
      let prices = {};
      try {
        const dex = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mints)).json();
        for (const pair of (dex.pairs || [])) {
          const m = pair.baseToken && pair.baseToken.address;
          if (m && (!prices[m] || +pair.volume?.h24 > +prices[m].vol)) prices[m] = { price: +pair.priceUsd, vol: +pair.volume?.h24 || 0 };
        }
      } catch (e) {}
      let rows = '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
        '<tr>' + ['Task', 'Coin', 'Now', 'Peak', 'Stop at', 'Est. PnL', 'Age'].map(h => '<th style="color:var(--text3);text-align:left;padding:4px 8px;font-size:11px;text-transform:uppercase">' + h + '</th>').join('') + '</tr>';
      for (const p of live.open) {
        const cur = prices[p.mint] ? prices[p.mint].price / p.entryPrice : null;
        const stopMult = p.trailingStopPrice > 0 ? p.trailingStopPrice / p.entryPrice : null;
        const est = cur !== null ? (p.totalSolReturned + p.entrySol * p.remainingPct * cur - p.entrySol) : null;
        const col = cur === null ? 'var(--text2)' : cur >= 1 ? '#10b981' : '#ef4444';
        const age = Math.floor((Date.now() - p.entryTime) / 60000);
        rows += '<tr>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border);color:var(--text2);font-size:11px">' + (p.taskName || 'main') + '</td>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border)"><b>$' + p.symbol + '</b> <span style="color:var(--text3);font-size:11px">' + (p.remainingPct < 1 ? Math.round(p.remainingPct * 100) + '% left' : '') + '</span></td>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border);color:' + col + ';font-weight:700">' + (cur === null ? '—' : cur.toFixed(2) + 'X') + '</td>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border)">' + p.peakMultiplier.toFixed(2) + 'X</td>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border);color:var(--text2)">' + (stopMult === null ? '—' : stopMult.toFixed(2) + 'X') + '</td>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border);color:' + (est === null ? 'var(--text2)' : est >= 0 ? '#10b981' : '#ef4444') + '">' + (est === null ? '—' : fmtSol(est)) + '</td>' +
          '<td style="padding:5px 8px;border-top:1px solid var(--border);color:var(--text3)">' + (age < 60 ? age + 'm' : Math.floor(age / 60) + 'h ' + (age % 60) + 'm') + '</td>' +
          '</tr>';
      }
      body.innerHTML = rows + '</table>';
    } catch (e) {
      document.getElementById('lt-status').textContent = 'refresh failed — retrying';
    }
  }
  tick();
  setInterval(tick, 10000);
})();
</script>
<style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}</style>

<!-- ── hero PnL ── -->
<div class="hero">
  <div class="hero-card hero-real">
    <div class="hero-label">Real Trading P&L</div>
    <div class="hero-val ${o.totalRealPnl>=0?'g glow-g':'r glow-r'}">${o.totalRealPnl>=0?'+':''}${o.totalRealPnl.toFixed(4)} <span style="font-size:16px;font-weight:500;opacity:0.6">SOL</span></div>
    <div class="hero-sub">
      <span>ROI <span class="hero-pct ${o.realROI>=0?'pct-g':'pct-r'}">${o.realROI>=0?'+':''}${o.realROI.toFixed(1)}%</span></span>
      <span>W/L: <strong style="color:var(--green)">${o.realWins}</strong>/<strong style="color:var(--red)">${o.realLosses}</strong></span>
      <span>Win Rate: <strong style="color:#fff">${realWinPct.toFixed(0)}%</strong></span>
      <span>Avg: <strong class="${o.avgRealPnl>=0?'g':'r'}">${o.avgRealPnl>=0?'+':''}${o.avgRealPnl.toFixed(4)}</strong></span>
    </div>
  </div>
  <div class="hero-card hero-paper">
    <div class="hero-label">Paper Trading P&L</div>
    <div class="hero-val ${o.totalPaperPnl>=0?'b glow-b':'r glow-r'}">${o.totalPaperPnl>=0?'+':''}${o.totalPaperPnl.toFixed(2)} <span style="font-size:16px;font-weight:500;opacity:0.6">SOL</span></div>
    <div class="hero-sub">
      <span>W/L: <strong style="color:var(--blue)">${o.paperWins}</strong>/<strong style="color:var(--red)">${o.paperLosses}</strong></span>
      <span>Win Rate: <strong style="color:#fff">${paperWinPct.toFixed(0)}%</strong></span>
      <span>Avg: <strong class="${o.avgPaperPnl>=0?'b':'r'}">${o.avgPaperPnl>=0?'+':''}${o.avgPaperPnl.toFixed(3)}</strong>/trade</span>
    </div>
  </div>
</div>

<!-- ── metric strip ── -->
<div class="metrics">
  <div class="m">
    <div class="k">Avg Peak</div>
    <div class="v">${avgPeak.toFixed(2)}×</div>
    <div class="d">across ${o.totalCalls} calls</div>
  </div>
  <div class="m">
    <div class="k">Hit 2×+</div>
    <div class="v g">${ms2Pct.toFixed(0)}%</div>
    <div class="bar"><div class="bar-fill" style="width:${ms2Pct}%;background:var(--green)"></div></div>
  </div>
  <div class="m">
    <div class="k">Hit 5×+</div>
    <div class="v b">${ms5Pct.toFixed(0)}%</div>
    <div class="bar"><div class="bar-fill" style="width:${Math.min(ms5Pct*4,100)}%;background:var(--blue)"></div></div>
  </div>
  <div class="m">
    <div class="k">Hit 10×+</div>
    <div class="v p">${ms10Pct.toFixed(0)}%</div>
    <div class="bar"><div class="bar-fill" style="width:${Math.min(ms10Pct*8,100)}%;background:var(--purple)"></div></div>
  </div>
  <div class="m">
    <div class="k">Best Trade</div>
    <div class="v g" style="font-size:14px">${o.bestReal?'$'+o.bestReal.symbol:'--'}</div>
    <div class="d">${o.bestReal?(o.bestReal.pnl>=0?'+':'')+o.bestReal.pnl.toFixed(4)+' SOL':'no trades'}</div>
  </div>
  <div class="m">
    <div class="k">Invested</div>
    <div class="v">${o.totalRealInvested.toFixed(3)}</div>
    <div class="d">SOL deployed</div>
  </div>
</div>

<!-- ── milestone funnel + win rate gauge ── -->
<div class="row r2" style="margin-bottom:16px">
  <div class="card">
    <h3>Milestone Funnel <span style="margin-left:auto;font-size:10px;color:var(--text3);text-transform:none;letter-spacing:0">how far calls go</span></h3>
    <div class="funnel">
      ${(() => {
        const targets = [2, 3, 5, 10, 20, 50, 100];
        const total = o.totalCalls || 1;
        return targets.map(t => {
          const count = d.milestoneCounts[t] ?? 0;
          const pct = (count / total) * 100;
          const cls = t >= 50 ? 'diamond' : t >= 10 ? 'fire' : t >= 5 ? 'gold' : count > 0 ? 'active' : '';
          return `<div class="funnel-step ${cls}">
            <div class="funnel-target">${t}×</div>
            <div class="funnel-count">${count}</div>
            <div class="funnel-pct">${pct.toFixed(1)}%</div>
            <div class="funnel-bar" style="width:${Math.min(pct * 4, 100)}%"></div>
          </div>`;
        }).join('');
      })()}
    </div>
  </div>
  <div class="card">
    <h3>Performance Overview</h3>
    <div class="gauge-wrap">
      <div class="gauge">
        <svg viewBox="0 0 100 100">
          <defs>
            <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="#00d672"/>
              <stop offset="100%" stop-color="#00d4c8"/>
            </linearGradient>
          </defs>
          <circle class="gauge-track" cx="50" cy="50" r="42"/>
          <circle class="gauge-fill" cx="50" cy="50" r="42"
            stroke-dasharray="${(ms2Pct/100*264).toFixed(1)} 264"/>
        </svg>
        <div class="gauge-text">
          <div class="gauge-pct">${ms2Pct.toFixed(0)}%</div>
          <div class="gauge-label">Hit 2×+</div>
        </div>
      </div>
      <div class="gauge-stats">
        <div class="gauge-stat">
          <div class="gs-k">Avg Peak</div>
          <div class="gs-v">${avgPeak.toFixed(2)}×</div>
        </div>
        <div class="gauge-stat">
          <div class="gs-k">Best Runner</div>
          <div class="gs-v g">${d.callsWithPeaks[0]?.peakMultiplier.toFixed(1) ?? '0'}×</div>
        </div>
        <div class="gauge-stat">
          <div class="gs-k">Hit 5×+</div>
          <div class="gs-v">${d.milestoneCounts[5] ?? 0}</div>
        </div>
        <div class="gauge-stat">
          <div class="gs-k">Hit 10×+</div>
          <div class="gs-v p">${d.milestoneCounts[10] ?? 0}</div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ── main chart ── -->
<div class="card" style="margin-bottom:16px">
  <h3>Cumulative P&L</h3>
  <div style="height:320px;position:relative"><canvas id="cumPnlChart"></canvas></div>
</div>

<!-- ── two col: per-trade + exit reasons ── -->
<div class="row r2" style="margin-bottom:16px">
  <div class="card">
    <h3>Per-Trade P&L</h3>
    <div style="height:260px;position:relative"><canvas id="tradePnlChart"></canvas></div>
  </div>
  <div class="card">
    <h3>Exit Breakdown</h3>
    <div class="exit-grid">
      ${(() => {
        const exitColors: Record<string,string> = {stop_loss:'var(--red)',be_stop:'var(--orange)',tp1:'var(--green)',tp2:'var(--green)',tp3:'var(--green)',trailing_stop:'var(--purple)',profit_protect:'var(--blue)',unknown:'var(--text3)'};
        const total = Object.values(d.realExitReasons).reduce((a,b)=>a+b,0);
        if (total === 0) return '<div style="color:var(--text3);padding:40px 0;text-align:center">No exits yet</div>';
        return Object.entries(d.realExitReasons).map(([reason, count]) => {
          const pct = (count / total * 100);
          const color = exitColors[reason] ?? 'var(--text3)';
          return `<div class="exit-row">
            <div class="exit-label">${formatExitReasonJS(reason)}</div>
            <div class="exit-bar-wrap"><div class="exit-bar" style="width:${pct}%;background:${color}"></div></div>
            <div class="exit-val mono">${count} <span class="dim">(${pct.toFixed(0)}%)</span></div>
          </div>`;
        }).join('');
      })()}
    </div>
  </div>
</div>

<!-- ── daily + peaks ── -->
<div class="row r2" style="margin-bottom:16px">
  <div class="card">
    <h3>Daily P&L</h3>
    <div style="height:260px;position:relative"><canvas id="dailyPnlChart"></canvas></div>
  </div>
  <div class="card">
    <h3>Peak Multipliers</h3>
    <div style="height:260px;position:relative"><canvas id="peakChart"></canvas></div>
  </div>
</div>

<!-- ── MC distribution + Hourly activity ── -->
<div class="row r2" style="margin-bottom:16px">
  <div class="card">
    <h3>Entry MC vs Win Rate <span style="margin-left:auto;font-size:10px;color:var(--text3);text-transform:none;letter-spacing:0">where the winners come from</span></h3>
    <div class="mc-grid">
      ${(() => {
        const maxCount = Math.max(...d.mcBuckets.map(b => b.count), 1);
        return d.mcBuckets.map(b => {
          const widthPct = (b.count / maxCount) * 100;
          const winPct = b.count > 0 ? (b.winners / b.count) * 100 : 0;
          const winWidthPct = (b.winners / maxCount) * 100;
          return `<div>
            <div class="mc-row">
              <div class="mc-label">${b.label}</div>
              <div class="mc-bar-wrap">
                <div class="mc-bar-total" style="width:${widthPct}%"></div>
                <div class="mc-bar-wins" style="width:${winWidthPct}%"></div>
              </div>
              <div class="mc-numbers">
                <span>${b.count} calls</span>
                <span class="winrate">${winPct.toFixed(0)}%</span>
              </div>
            </div>
          </div>`;
        }).join('');
      })()}
    </div>
    <div style="margin-top:14px;display:flex;gap:14px;font-size:10px;color:var(--text3)">
      <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:2px;background:linear-gradient(90deg,var(--green),var(--cyan))"></span>Winners (2×+)</span>
      <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:2px;background:rgba(77,142,255,0.15)"></span>All calls</span>
    </div>
  </div>
  <div class="card">
    <h3>Hourly Activity <span style="margin-left:auto;font-size:10px;color:var(--text3);text-transform:none;letter-spacing:0">when calls fire (UTC)</span></h3>
    <div class="hour-grid">
      ${(() => {
        const maxHour = Math.max(...d.hourlyDist, 1);
        return d.hourlyDist.map((count, _) => {
          const intensity = count / maxHour;
          const cls = intensity > 0.85 ? 'h5' : intensity > 0.65 ? 'h4' : intensity > 0.4 ? 'h3' : intensity > 0.2 ? 'h2' : intensity > 0 ? 'h1' : 'h0';
          return `<div class="hour-cell ${cls}" title="${count} calls">${count > 0 ? count : ''}</div>`;
        }).join('');
      })()}
    </div>
    <div class="hour-axis">
      ${Array.from({length: 24}, (_, h) => `<div>${h % 6 === 0 ? h : ''}</div>`).join('')}
    </div>
    <div style="margin-top:14px;display:flex;gap:14px;font-size:10px;color:var(--text3);align-items:center">
      <span>Less</span>
      <span style="display:flex;gap:3px">
        <span style="width:14px;height:14px;border-radius:3px;background:var(--bg3)"></span>
        <span style="width:14px;height:14px;border-radius:3px;background:rgba(77,142,255,0.30)"></span>
        <span style="width:14px;height:14px;border-radius:3px;background:rgba(77,142,255,0.50)"></span>
        <span style="width:14px;height:14px;border-radius:3px;background:rgba(77,142,255,0.75)"></span>
        <span style="width:14px;height:14px;border-radius:3px;background:linear-gradient(135deg,#4d8eff,#a47cff)"></span>
      </span>
      <span>More</span>
      <span style="margin-left:auto">Total: ${d.hourlyDist.reduce((s,n)=>s+n,0)} calls</span>
    </div>
  </div>
</div>

<!-- ── tables ── -->
<div class="section-title">Real Positions</div>

<div class="card" style="margin-bottom:16px;padding:0;overflow:hidden">
  <div class="tbl">
  <table>
    <thead><tr><th>#</th><th>Token</th><th>Entry</th><th>Returned</th><th>P&L</th><th>Peak</th><th>TP1</th><th>TP2</th><th>TP3</th><th>Exit</th><th>Date</th></tr></thead>
    <tbody>
    ${d.positions.length === 0 ? '<tr><td colspan="11" style="text-align:center;padding:32px;color:var(--text3)">No closed positions in this range</td></tr>' : ''}
    ${d.positions.map((pos,i)=>{const pnl=pos.finalPnlSol??0;const last=pos.exits[pos.exits.length-1];return`<tr>
      <td class="dim">${i+1}</td>
      <td><strong style="color:#fff">$${esc(pos.symbol)}</strong></td>
      <td class="mono dim">${pos.entrySol.toFixed(4)}</td>
      <td class="mono dim">${pos.totalSolReturned.toFixed(4)}</td>
      <td class="mono ${pnl>=0?'g':'r'}" style="font-weight:600">${pnl>=0?'+':''}${pnl.toFixed(4)}</td>
      <td class="mono ${(pos.peakMultiplier??1)>=1.5?'g':'dim'}" style="font-weight:600">${(pos.peakMultiplier??1).toFixed(2)}x</td>
      <td>${pos.tp1Hit?'<span class="tag tag-g">HIT</span>':'<span class="dim">-</span>'}</td>
      <td>${pos.tp2Hit?'<span class="tag tag-g">HIT</span>':'<span class="dim">-</span>'}</td>
      <td>${pos.tp3Hit?'<span class="tag tag-g">HIT</span>':'<span class="dim">-</span>'}</td>
      <td>${last?formatExitReason(last.reason):'<span class="dim">-</span>'}</td>
      <td class="dim">${new Date(pos.closedTime??pos.entryTime).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}</td>
    </tr>`}).join('')}
    </tbody>
  </table>
  </div>
</div>

<div class="section-title">
  <span>🏆 Hall of Fame — Top Runners</span>
  <span class="badge">avg peak ${avgPeak.toFixed(2)}× across ${o.totalCalls} calls</span>
</div>

${d.callsWithPeaks.length === 0
  ? '<div class="card" style="text-align:center;padding:48px;color:var(--text3);margin-bottom:24px">No calls in this range</div>'
  : `<div class="runners">
    ${d.callsWithPeaks.slice(0, 24).map((c, i) => {
      const peakClass = c.peakMultiplier >= 10 ? 'huge' : c.peakMultiplier >= 3 ? '' : 'mid';
      const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
      const trophy = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
      return `<div class="runner ${rankClass}">
        <div class="runner-rank">#${i + 1}</div>
        <div class="runner-sym">${trophy} $${esc(c.symbol)}</div>
        <div class="runner-name">${esc(c.name)}</div>
        <div class="runner-peak ${peakClass}">${c.peakMultiplier.toFixed(1)}×</div>
        <div class="runner-mc">$${fmtK(c.entryMC)} → <strong>$${fmtK(c.peakMC)}</strong></div>
        <div class="runner-ms">
          ${c.milestones.length ? c.milestones.map(m => `<span class="ms">${m}×</span>`).join('') : '<span class="ms" style="background:rgba(122,135,158,0.1);color:var(--text3)">—</span>'}
        </div>
        <div class="runner-date">${new Date(c.entryTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
      </div>`;
    }).join('')}
  </div>`
}

</div>

<script>
Chart.defaults.color='#4a5570';
Chart.defaults.borderColor='#1a2035';
Chart.defaults.font.family="'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
Chart.defaults.font.size=11;
Chart.defaults.plugins.tooltip.backgroundColor='#0f1420';
Chart.defaults.plugins.tooltip.borderColor='#242e44';
Chart.defaults.plugins.tooltip.borderWidth=1;
Chart.defaults.plugins.tooltip.cornerRadius=8;
Chart.defaults.plugins.tooltip.padding=12;
Chart.defaults.plugins.tooltip.titleFont={weight:'600'};
Chart.defaults.plugins.legend.labels.usePointStyle=true;
Chart.defaults.plugins.legend.labels.padding=16;
Chart.defaults.plugins.legend.labels.boxWidth=8;
Chart.defaults.plugins.legend.labels.font={size:11,weight:'500'};
Chart.defaults.elements.bar.borderRadius=4;
Chart.defaults.elements.bar.borderSkipped=false;
Chart.defaults.elements.line.tension=0.35;
Chart.defaults.elements.point.radius=0;
Chart.defaults.elements.point.hoverRadius=5;

const G='#00d672',R='#ff3b5c',B='#4d8eff',P='#a47cff',O='#ff9f40',C='#00d4c8',PK='#ff6b9d';
const grid={color:'rgba(26,32,53,0.9)'};
const noGrid={display:false};

// cumulative pnl
(function(){
  const c=document.getElementById('cumPnlChart').getContext('2d');
  const gb=c.createLinearGradient(0,0,0,360);gb.addColorStop(0,B+'20');gb.addColorStop(1,B+'00');
  const gg=c.createLinearGradient(0,0,0,360);gg.addColorStop(0,G+'25');gg.addColorStop(1,G+'00');
  new Chart(c,{type:'line',data:{
    labels:${JSON.stringify(d.paperPnlTimeline.map(p=>new Date(p.time).toLocaleDateString('en-US',{month:'short',day:'numeric'})))},
    datasets:[
      {label:'Paper',data:${JSON.stringify(d.paperPnlTimeline.map(p=>+p.pnl.toFixed(3)))},borderColor:B,backgroundColor:gb,fill:true,borderWidth:2.5},
      {label:'Real',data:${JSON.stringify(d.realPnlTimeline.map(p=>({x:new Date(p.time).toLocaleDateString('en-US',{month:'short',day:'numeric'}),y:+p.pnl.toFixed(4)})))},borderColor:G,backgroundColor:gg,fill:true,borderWidth:2.5}
    ]},options:{responsive:true,maintainAspectRatio:false,interaction:{intersect:false,mode:'index'},scales:{y:{grid,ticks:{callback:v=>(v>=0?'+':'')+v,font:{family:"'JetBrains Mono',monospace",size:10}}},x:{grid:noGrid,ticks:{maxTicksLimit:8}}}}});
})();

// per-trade pnl
new Chart(document.getElementById('tradePnlChart'),{type:'bar',data:{
  labels:${JSON.stringify(d.realPnlBars.map(p=>'$'+p.symbol))},
  datasets:[{data:${JSON.stringify(d.realPnlBars.map(p=>+p.pnl.toFixed(4)))},
    backgroundColor:${JSON.stringify(d.realPnlBars.map(p=>p.pnl>=0?'#00d67240':'#ff3b5c40'))},
    borderColor:${JSON.stringify(d.realPnlBars.map(p=>p.pnl>=0?'#00d672':'#ff3b5c'))},
    borderWidth:1}]},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{afterLabel:function(c){const p=${JSON.stringify(d.realPnlBars.map(p=>p.peakMult))};return'Peak: '+p[c.dataIndex].toFixed(1)+'x';}}}},scales:{y:{grid,ticks:{callback:v=>(v>=0?'+':'')+v,font:{family:"'JetBrains Mono',monospace",size:10}}},x:{grid:noGrid,ticks:{maxRotation:45,minRotation:45}}}}});


// peak dist — horizontal bar
new Chart(document.getElementById('peakChart'),{type:'bar',data:{
  labels:${JSON.stringify(d.peakBuckets.map(b=>b.label))},
  datasets:[{data:${JSON.stringify(d.peakBuckets.map(b=>b.count))},
    backgroundColor:${JSON.stringify(d.peakBuckets.map((_,i)=>['#ff3b5c50','#ff9f4050','#4d8eff50','#00d67250','#a47cff50','#00d4c850','#ff6b9d50'][i]))},
    borderColor:${JSON.stringify(d.peakBuckets.map((_,i)=>['#ff3b5c','#ff9f40','#4d8eff','#00d672','#a47cff','#00d4c8','#ff6b9d'][i]))},
    borderWidth:1,borderRadius:6,barThickness:18}]},
  options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,grid,ticks:{stepSize:1,font:{family:"'JetBrains Mono',monospace",size:10}}},y:{grid:noGrid,ticks:{font:{size:11}}}}}});

// daily
const dd=${JSON.stringify(Object.entries(d.dailyPnl).sort(([a],[b])=>a.localeCompare(b)))};
new Chart(document.getElementById('dailyPnlChart'),{type:'bar',data:{
  labels:dd.map(d=>d[0]),
  datasets:[
    {label:'Paper',data:dd.map(d=>+d[1].paper.toFixed(3)),backgroundColor:dd.map(d=>d[1].paper>=0?B+'40':B+'15'),borderColor:B,borderWidth:1},
    {label:'Real',data:dd.map(d=>+d[1].real.toFixed(4)),backgroundColor:dd.map(d=>d[1].real>=0?G+'40':R+'40'),borderColor:dd.map(d=>d[1].real>=0?G:R),borderWidth:1}
  ]},options:{responsive:true,maintainAspectRatio:false,scales:{y:{grid,ticks:{callback:v=>(v>=0?'+':'')+v}},x:{grid:noGrid,ticks:{maxRotation:45,minRotation:45}}}}});
</script>
</body>
</html>`;
}

// ── Helpers ──────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(0);
}

function formatExitReason(reason: string): string {
  const map: Record<string, [string, string]> = {
    stop_loss: ['Stop Loss', 'tag-r'],
    be_stop: ['BE Stop', 'tag-o'],
    tp1: ['TP1', 'tag-g'],
    tp2: ['TP2', 'tag-g'],
    tp3: ['TP3', 'tag-g'],
    trailing_stop: ['Trailing', 'tag-p'],
    profit_protect: ['Profit Protect', 'tag-b'],
    unknown: ['Unknown', 'tag-r'],
  };
  const [label, cls] = map[reason] ?? [reason, 'tag-r'];
  return `<span class="tag ${cls}">${label}</span>`;
}

function formatExitReasonJS(reason: string): string {
  const map: Record<string, string> = {
    stop_loss: 'Stop Loss',
    be_stop: 'Break-Even Stop',
    tp1: 'TP1',
    tp2: 'TP2',
    tp3: 'TP3',
    trailing_stop: 'Trailing Stop',
    profit_protect: 'Profit Protect',
  };
  return map[reason] ?? reason;
}

// ── Server ──────────────────────────────────────────────────

// Pre-load Chart.js once at startup
const chartJsSource = readFileSync(join(__dirname, 'chart.min.js'), 'utf-8');

// ── Settings page (password-gated live-trading controls) ────

function authHash(): string | null {
  const pw = process.env.DASH_PASSWORD;
  return pw ? createHash('sha256').update(pw).digest('hex') : null;
}

function authOk(req: IncomingMessage): boolean {
  const expect = authHash();
  if (!expect) return false;
  const m = (req.headers.cookie ?? '').match(/dash_auth=([a-f0-9]{64})/);
  return !!m && m[1] === expect;
}

const SETTINGS_STYLE = `
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#06080d;--bg1:#0a0e17;--bg2:#0f1420;--bg3:#151b28;--border:#1a2035;--border2:#242e44;--text:#c8d3e6;--text2:#7a879e;--text3:#4a5570;--green:#10b981;--red:#ef4444}
body{background:var(--bg);color:var(--text);font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px}
.topbar{display:flex;justify-content:space-between;align-items:center;padding:14px 22px;border-bottom:1px solid var(--border);background:var(--bg1)}
.topbar h1{font-size:17px}.topbar a{color:var(--text2);text-decoration:none;font-size:13px}
.wrap{max-width:640px;margin:0 auto;padding:24px 22px}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:20px;margin:16px 0}
.card h3{font-size:13px;color:var(--text2);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px}
label{display:block;font-size:12px;color:var(--text2);margin:14px 0 4px}
input,select{width:100%;padding:9px 12px;background:var(--bg1);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-size:14px}
input:focus,select:focus{outline:none;border-color:#3b82f6}
button{margin-top:18px;width:100%;padding:11px;background:#10b981;color:#04110b;font-weight:700;border:0;border-radius:8px;font-size:14px;cursor:pointer}
button:hover{filter:brightness(1.1)}
.toggle-row{display:flex;align-items:center;gap:10px;margin:14px 0 4px}
.toggle-row input{width:auto;transform:scale(1.3)}
.msg{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:14px}
.msg.ok{background:#10b98122;border:1px solid #10b98155;color:#6ee7b7}
.msg.err{background:#ef444422;border:1px solid #ef444455;color:#fca5a5}
.kv{font-size:12px;color:var(--text2);margin:4px 0}.kv b{color:var(--text)}
.warn{font-size:11px;color:var(--text3);margin-top:12px;line-height:1.5}
.mono{font-family:'SF Mono',Menlo,monospace}`;

function settingsShell(inner: string, self = '/settings'): string {
  const title = self === '/builder' ? '🧪 Strategy Builder' : self === '/live' ? '◆ Live Trading' : self === '/shadow' ? '📄 Shadow Fleet' : self.startsWith('/task') ? '🤖 Trading Tasks' : '⚙️ Live Trading Settings';
  const wide = self === '/builder' ? 'max-width:760px' : self === '/live' || self === '/shadow' ? 'max-width:1200px' : self.startsWith('/task') ? 'max-width:960px' : 'max-width:640px';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PumpClaw ${self.startsWith('/task') ? 'Tasks' : 'Settings'}</title><style>${SETTINGS_STYLE}</style></head><body>
<div class="topbar"><h1>${title}</h1><div style="display:flex;gap:14px"><a href="/builder">Builder</a><a href="/live">Live</a><a href="/shadow">Shadow</a><a href="/sweep">Sweep</a><a href="/tasks">Tasks</a><a href="/settings">Settings</a><a href="/">← Dashboard</a></div></div>
<div class="wrap" style="${wide}">${inner}</div></body></html>`;
}

async function buildSettingsHTML(msg?: { ok: boolean; text: string }): Promise<string> {
  if (!authHash()) {
    return settingsShell(`<div class="card"><h3>Settings disabled</h3>
      <p style="font-size:13px;line-height:1.6">Set a <b class="mono">DASH_PASSWORD</b> environment variable in Railway to enable this page.
      The dashboard URL is public — without a password, anyone who finds it could control live trading.</p></div>`);
  }

  const src = walletSource();
  let addr = '', balance: number | null = null;
  if (src !== 'none') {
    try { addr = getWallet().publicKey.toBase58(); balance = await getSolBalance(); } catch {}
  }
  const msgHtml = msg ? `<div class="msg ${msg.ok ? 'ok' : 'err'}">${msg.text}</div>` : '';

  return settingsShell(`
  ${msgHtml}
  <div class="card">
    <h3>Wallet</h3>
    <div class="kv">Source: <b>${src === 'env' ? 'WALLET_PRIVATE_KEY env var (managed in Railway)' : src === 'file' ? 'stored on volume' : 'none — paste a key below or fund the auto-generated one'}</b></div>
    ${addr ? `<div class="kv">Address: <b class="mono">${addr}</b></div>` : ''}
    ${balance !== null ? `<div class="kv">Balance: <b>${balance.toFixed(4)} SOL</b></div>` : ''}
  </div>
  <form method="POST" action="/settings">
    <div class="card">
      <h3>Live trading</h3>
      <div class="toggle-row">
        <input type="checkbox" id="en" name="trade_enabled" value="1" ${CONFIG.TRADE_ENABLED ? 'checked' : ''}>
        <label for="en" style="margin:0;font-size:14px;color:var(--text)">Live trading enabled</label>
      </div>
      <label>Exit strategy</label>
      <select name="strategy">
        <option value="trailing" ${CONFIG.TRADE_EXIT_STRATEGY === 'trailing' ? 'selected' : ''}>Always-on trailing stop (no TPs)</option>
        <option value="ladder" ${CONFIG.TRADE_EXIT_STRATEGY === 'ladder' ? 'selected' : ''}>TP ladder 1.5X/2.5X/4X</option>
      </select>
      <label>Trailing stop — % drop from ATH (5–90)</label>
      <input type="number" name="trailing_drop" min="5" max="90" step="1" value="${Math.round(CONFIG.TRADE_TRAILING_DROP * 100)}">
      <label>Entry size — % of wallet balance per trade (1–100)</label>
      <input type="number" name="entry_pct" min="1" max="100" step="1" value="${Math.round(CONFIG.TRADE_ENTRY_PCT * 100)}">
      <label>Minimum entry (SOL)</label>
      <input type="number" name="min_entry" min="0.01" step="0.01" value="${CONFIG.TRADE_MIN_ENTRY_SOL}">
      <label>Max slippage — % (1–99)</label>
      <input type="number" name="slippage" min="1" max="99" step="1" value="${Math.round(CONFIG.TRADE_SLIPPAGE_BPS / 100)}">
    </div>
    <div class="card">
      <h3>Replace wallet (optional)</h3>
      <label>Private key (base58, write-only — never shown back)</label>
      <input type="password" name="wallet_key" autocomplete="off" placeholder="${src === 'env' ? 'disabled: env var takes priority' : 'paste to replace the trading wallet'}" ${src === 'env' ? 'disabled' : ''}>
      <div class="warn">Use a burner wallet funded only with what you're prepared to lose. The key is stored on the Railway volume and never displayed. Changes apply instantly — no restart.</div>
    </div>
    <button type="submit">Save settings</button>
  </form>`);
}

function settingsLoginHTML(err?: string): string {
  return settingsShell(`
  ${err ? `<div class="msg err">${err}</div>` : ''}
  <form method="POST" action="/settings">
    <div class="card">
      <h3>Unlock settings</h3>
      <label>Password (DASH_PASSWORD)</label>
      <input type="password" name="password" autofocus autocomplete="current-password">
      <button type="submit">Unlock</button>
    </div>
  </form>`);
}

function parseFormBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split('&')) {
    const [k, v] = pair.split('=');
    if (k) out[decodeURIComponent(k)] = decodeURIComponent((v ?? '').replace(/\+/g, ' '));
  }
  return out;
}

async function handleSettingsPost(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  const form = parseFormBody(body);
  const expect = authHash();
  if (!expect) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await buildSettingsHTML());
    return;
  }

  // Login attempt
  if ('password' in form && !authOk(req)) {
    if (createHash('sha256').update(form.password).digest('hex') === expect) {
      res.writeHead(302, {
        'Set-Cookie': `dash_auth=${expect}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`,
        'Location': '/settings',
      });
      res.end();
    } else {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(settingsLoginHTML('Wrong password'));
    }
    return;
  }

  if (!authOk(req)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(settingsLoginHTML());
    return;
  }

  // Save settings
  try {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    saveSettingsOverrides({
      TRADE_ENABLED: form.trade_enabled === '1',
      TRADE_EXIT_STRATEGY: form.strategy === 'ladder' ? 'ladder' : 'trailing',
      TRADE_TRAILING_DROP: clamp(parseFloat(form.trailing_drop) || 45, 5, 90) / 100,
      TRADE_ENTRY_PCT: clamp(parseFloat(form.entry_pct) || 10, 1, 100) / 100,
      TRADE_MIN_ENTRY_SOL: clamp(parseFloat(form.min_entry) || 0.05, 0.01, 100),
      TRADE_SLIPPAGE_BPS: Math.round(clamp(parseFloat(form.slippage) || 30, 1, 99) * 100),
    });
    let text = 'Settings saved — live immediately.';
    if (form.wallet_key && form.wallet_key.trim()) {
      const addr = setWalletFromKey(form.wallet_key);
      text += ` Wallet replaced: ${addr.slice(0, 8)}…${addr.slice(-6)}`;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await buildSettingsHTML({ ok: true, text }));
  } catch (err: any) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await buildSettingsHTML({ ok: false, text: err.message }));
  }
}


// ── Tasks pages (sneaker-bot style: N wallets × N strategies) ──

function buildBuilderHTML(url: string, canAct: boolean): string {
  const fromKey = (url.match(/[?&]from=([\w-]+)/) || [])[1] ?? 'dip20tp2';
  const base = STRATEGY_PRESETS[fromKey]?.make() ?? STRATEGY_PRESETS.dip20tp2.make();
  const opts = Object.entries(STRATEGY_PRESETS)
    .map(([k, v]) => `<option value="${k}" ${k === fromKey ? 'selected' : ''}>${v.name}</option>`).join('');
  const tpRow = (i: number) => {
    const tp = base.tps[i];
    return `<div style="display:flex;gap:8px;margin:5px 0;align-items:center">
      <span style="font-size:11px;color:var(--text3);width:26px">#${i + 1}</span>
      <input type="number" step="0.05" min="1.01" id="tpm${i}" name="tp_mult_${i}" placeholder="multiple" value="${tp ? tp.mult : ''}" style="flex:1">
      <input type="number" step="1" min="1" max="100" id="tps${i}" name="tp_sell_${i}" placeholder="% to sell" value="${tp ? Math.round(tp.sellPct * 100) : ''}" style="flex:1">
    </div>`;
  };

  return settingsShell(`
  <div class="card" style="max-width:none">
    <h3>🧪 Strategy builder</h3>
    <p style="font-size:13px;color:var(--text2);line-height:1.6">
      Edit every parameter and backtest it against the <b id="pathcount">…</b> real price paths captured from our own
      calls — minute-by-minute, the actual path each coin took. Then add it to the paper fleet to run forward, or
      go straight to live trading.
    </p>
    <label>Start from an existing strategy</label>
    <select onchange="location.href='/builder?from='+this.value">${opts}</select>
  </div>

  <form method="POST" action="/builder" id="f">
    <div class="card">
      <h3>Entry</h3>
      <label>How it enters</label>
      <select name="entry_mode" id="entry_mode" onchange="preview()">
        <option value="instant" ${base.entryMode !== 'dip' ? 'selected' : ''}>Buy immediately at the call</option>
        <option value="dip" ${base.entryMode === 'dip' ? 'selected' : ''}>Wait for a pullback below the call</option>
      </select>
      <label>Pullback depth — % below the call price</label>
      <input type="number" id="dip_pct" name="dip_pct" min="1" max="80" value="${Math.round((base.dipPct ?? 0.2) * 100)}" oninput="preview()">
      <label>Give up if the pullback hasn't come within (minutes)</label>
      <input type="number" id="dip_window" name="dip_window" min="1" max="240" value="${base.dipWindowMin ?? 30}" oninput="preview()">
    </div>

    <div class="card">
      <h3>Take profit</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:4px">Multiple to sell at, and what % of the position to sell there. Leave blank to skip a rung.</p>
      ${[0, 1, 2, 3, 4, 5].map(tpRow).join('')}
      <div class="toggle-row"><input type="checkbox" id="be" name="break_even" value="1" ${base.breakEvenAfterTp1 ? 'checked' : ''} onchange="preview()">
        <label for="be" style="margin:0;font-size:13px;color:var(--text)">Move the stop to break-even after the first take-profit</label></div>
    </div>

    <div class="card">
      <h3>Risk</h3>
      <label>Stop loss — % below entry</label>
      <input type="number" id="stop_loss" name="stop_loss" min="1" max="95" value="${Math.round((1 - base.stopLossPct) * 100)}" oninput="preview()">
      <label>Trailing stop — % below the high (90 = effectively off)</label>
      <input type="number" id="trailing_drop" name="trailing_drop" min="5" max="90" value="${Math.round(base.trailingDrop * 100)}" oninput="preview()">
      <label>When the trailing stop is active</label>
      <select name="trailing_from" id="trailing_from" onchange="preview()">
        <option value="entry" ${base.trailingFrom === 'entry' ? 'selected' : ''}>From entry (it is the stop)</option>
        <option value="afterLastTp" ${base.trailingFrom !== 'entry' ? 'selected' : ''}>Only after all take-profits hit</option>
      </select>
      <label>Hard time exit — sell everything after N minutes (0 = off)</label>
      <input type="number" id="max_hold" name="max_hold" min="0" max="1440" value="${base.maxHoldMin ?? 0}" oninput="preview()">
    </div>

    <div class="card" style="border-color:#1e5c3a">
      <h3 style="color:#10b981">📊 Backtest — real captured paths</h3>
      <div id="bt" style="font-size:13px;color:var(--text2)">adjust anything above to run…</div>
      <div id="btsamples" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <h3>Sizing & execution (live tasks only)</h3>
      <label>Entry size — % of wallet per trade</label>
      <input type="number" name="entry_pct" min="1" max="100" value="${Math.round(base.entryPct * 100)}">
      <label>Min / max entry (SOL, max 0 = uncapped)</label>
      <div style="display:flex;gap:8px">
        <input type="number" name="min_entry" step="0.01" min="0.01" value="${base.minEntrySol}" style="flex:1">
        <input type="number" name="max_entry" step="0.01" min="0" value="${base.maxEntrySol}" style="flex:1">
      </div>
      <label>Slippage % / priority fee (SOL)</label>
      <div style="display:flex;gap:8px">
        <input type="number" name="slippage" min="1" max="99" value="${Math.round(base.slippageBps / 100)}" style="flex:1">
        <input type="number" name="priority_fee" step="0.00001" min="0" value="${base.priorityFeeLamports / 1e9}" style="flex:1">
      </div>
    </div>

    <div class="card">
      <h3>Save it</h3>
      <label>Name</label>
      <input name="name" maxlength="40" placeholder="My custom strategy">
      <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
        <button type="submit" name="mode" value="paper" style="flex:1;min-width:200px">📄 Add to paper fleet (no money)</button>
        ${canAct ? `<button type="submit" name="mode" value="live" style="flex:1;min-width:200px;background:#10b981;color:#04120a">▶ Create LIVE task</button>` : ''}
      </div>
      ${canAct ? `<label style="margin-top:12px">Wallet private key (live only)</label>
      <input type="password" name="wallet_key" autocomplete="off" placeholder="burner wallet — required for a live task">`
        : `<p style="font-size:12px;color:var(--text3);margin-top:10px">Log in on <a href="/settings" style="color:#3b82f6">Settings</a> to create live tasks.</p>`}
    </div>
  </form>

<script>
let timer = null;
function cfg() {
  const tps = [];
  for (let i = 0; i < 6; i++) {
    const m = parseFloat(document.getElementById('tpm' + i).value);
    const s = parseFloat(document.getElementById('tps' + i).value);
    if (m > 1 && s > 0) tps.push({ mult: m, sellPct: s / 100 });
  }
  return {
    entryMode: document.getElementById('entry_mode').value,
    dipPct: (+document.getElementById('dip_pct').value || 20) / 100,
    dipWindowMin: +document.getElementById('dip_window').value || 30,
    tps,
    trailingDrop: (+document.getElementById('trailing_drop').value || 90) / 100,
    trailingFrom: document.getElementById('trailing_from').value,
    stopLossPct: 1 - (+document.getElementById('stop_loss').value || 50) / 100,
    breakEvenAfterTp1: document.getElementById('be').checked,
    maxHoldMin: +document.getElementById('max_hold').value || 0,
  };
}
async function preview() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const el = document.getElementById('bt');
    el.textContent = 'running…';
    try {
      const r = await (await fetch('/api/backtest', { method: 'POST', body: JSON.stringify(cfg()) })).json();
      document.getElementById('pathcount').textContent = r.pathsAvailable ?? 0;
      if (!r.trades) { el.innerHTML = '<span style="color:#f59e0b">No trades — the pullback never happened on any captured path' +
        (r.pathsAvailable ? '' : ', or no paths are captured yet (they appear ~45min after each call)') + '.</span>'; document.getElementById('btsamples').innerHTML = ''; return; }
      const good = r.avg >= 0.03, ok2 = r.avg >= 0;
      el.innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px">' +
        [['Avg / trade', (r.avg >= 0 ? '+' : '') + r.avg.toFixed(3), good ? '#10b981' : ok2 ? '#f59e0b' : '#ef4444'],
         ['Robust avg', (r.robustAvg >= 0 ? '+' : '') + r.robustAvg.toFixed(3), r.robustAvg >= 0 ? '#10b981' : '#ef4444'],
         ['Win rate', r.winPct + '%', ''], ['Median', r.median.toFixed(2) + '×', ''],
         ['Trades', r.trades + (r.skipped ? ' (' + r.skipped + ' no-fill)' : ''), ''],
         ['Best / worst', r.best.toFixed(1) + '× / ' + r.worst.toFixed(2) + '×', '']]
        .map(([k, v, c]) => '<div style="background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:9px 11px">' +
          '<div style="font-size:10px;color:var(--text3);text-transform:uppercase">' + k + '</div>' +
          '<div style="font-size:18px;font-weight:700;' + (c ? 'color:' + c : '') + '">' + v + '</div></div>').join('') +
        '</div><div style="font-size:11px;color:var(--text3);margin-top:8px">Robust avg drops the best 3 trades — if it goes negative, the edge is one or two lucky coins. Real fees need roughly +0.03/trade.</div>';
      document.getElementById('btsamples').innerHTML = '<table style="width:100%;font-size:12px;border-collapse:collapse">' +
        '<tr><th style="text-align:left;padding:4px;color:var(--text3);font-size:10px">BEST</th><th></th><th style="text-align:left;padding:4px;color:var(--text3);font-size:10px">WORST</th><th></th></tr>' +
        r.samples.slice(0, 5).map((s, i) => { const w = r.samples[r.samples.length - 1 - i];
          return '<tr><td style="padding:3px 4px">$' + s.symbol.slice(0,10) + '</td><td style="color:#10b981">' + s.ret.toFixed(2) + '× <span style="color:var(--text3);font-size:10px">' + s.exit + '</span></td>' +
                 '<td style="padding:3px 4px">$' + w.symbol.slice(0,10) + '</td><td style="color:#ef4444">' + w.ret.toFixed(2) + '× <span style="color:var(--text3);font-size:10px">' + w.exit + '</span></td></tr>'; }).join('') + '</table>';
    } catch (e) { el.textContent = 'backtest failed'; }
  }, 350);
}
document.querySelectorAll('#f input,#f select').forEach(el => el.addEventListener('input', preview));
preview();
</script>`, '/builder');
}

function sourceCheckboxes(selected: string[]): string {
  const rows = [
    `<div class="toggle-row"><input type="checkbox" id="src_${PUMPCLAW_SOURCE_ID}" name="source_${PUMPCLAW_SOURCE_ID}" value="1" ${selected.includes(PUMPCLAW_SOURCE_ID) ? 'checked' : ''}><label for="src_${PUMPCLAW_SOURCE_ID}" style="margin:0;font-size:13px;color:var(--text)">PumpClaw scanner <span style="color:var(--text3)">— our own calls</span></label></div>`,
  ];
  for (const s of sourceRegistry.all()) {
    const filters = `${s.maxMc > 0 ? 'under ' + Math.round(s.maxMc / 1000) + 'K MC' : 'any MC'}${s.maxAgeHours > 0 ? ', <' + s.maxAgeHours + 'h old' : ''}`;
    rows.push(`<div class="toggle-row"><input type="checkbox" id="src_${s.id}" name="source_${s.id}" value="1" ${selected.includes(s.id) ? 'checked' : ''}><label for="src_${s.id}" style="margin:0;font-size:13px;color:var(--text)">${s.name} <span style="color:var(--text3)">— ${filters}</span></label></div>`);
  }
  return rows.join('');
}

function sourcesFromForm(form: Record<string, string>): string[] {
  const out: string[] = [];
  if (form[`source_${PUMPCLAW_SOURCE_ID}`] === '1') out.push(PUMPCLAW_SOURCE_ID);
  for (const s of sourceRegistry.all()) if (form[`source_${s.id}`] === '1') out.push(s.id);
  return out;
}

function sourceLabel(id?: string): string {
  if (!id || id === PUMPCLAW_SOURCE_ID) return 'PumpClaw';
  return sourceRegistry.get(id)?.name ?? id;
}

function sourcesLabel(task: TradeTask): string {
  return taskManager.sourcesFor(task).map(sourceLabel).join(' + ');
}

function taskSummary(task: TradeTask) {
  const positions = taskManager.traderFor(task).getAllPositions();
  const closed = positions.filter(p => p.status === 'closed');
  const open = positions.filter(p => p.status === 'open');
  const pnl = closed.reduce((s, p) => s + (p.finalPnlSol ?? 0), 0);
  const wins = closed.filter(p => (p.finalPnlSol ?? 0) > 0).length;
  return { open: open.length, closed: closed.length, pnl, wins };
}

async function buildTasksHTML(msg?: { ok: boolean; text: string }): Promise<string> {
  const tasks = taskManager.all();
  const balances = await Promise.all(tasks.map(t =>
    t.paper ? Promise.resolve(null) : getSolBalance(taskManager.keypairFor(t)).catch(() => null)));

  const rows = tasks.map((t, i) => {
    const addr = taskManager.keypairFor(t).publicKey.toBase58();
    const s = taskSummary(t);
    const bal = balances[i];
    return `<tr>
      <td><span style="color:${t.enabled ? '#10b981' : '#4a5570'}">●</span> <a href="/task?id=${t.id}" style="color:var(--text);font-weight:700">${t.name}</a>${t.paper ? ' <span style="font-size:10px;color:#8b5cf6">PAPER</span>' : ''}</td>
      <td class="mono" style="font-size:11px;color:var(--text2)">${addr.slice(0, 6)}…${addr.slice(-4)}</td>
      <td class="mono">${bal === null ? '—' : bal.toFixed(3) + ' ◎'}</td>
      <td style="font-size:11px;color:${taskManager.sourcesFor(t).includes('pumpclaw') ? 'var(--text2)' : '#f59e0b'}">${sourcesLabel(t)}</td>
      <td style="font-size:12px;color:var(--text2)">${describeStrategy(t.strategy)}${t.webhook ? ' <span title="has its own Discord channel" style="color:#5865F2">🔔</span>' : ''}</td>
      <td class="mono" style="color:${s.pnl >= 0 ? '#10b981' : '#ef4444'}">${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(3)} ◎</td>
      <td class="mono">${s.open} open · ${s.wins}/${s.closed} wins</td>
      <td>
        <form method="POST" action="/task" style="display:inline">
          <input type="hidden" name="id" value="${t.id}"><input type="hidden" name="action" value="toggle">
          <button type="submit" style="margin:0;width:auto;padding:4px 10px;font-size:11px;background:${t.enabled ? '#1a2035' : '#10b981'};color:${t.enabled ? '#c8d3e6' : '#04110b'}">${t.enabled ? 'Pause' : 'Start'}</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  const presetOpts = Object.entries(STRATEGY_PRESETS)
    .map(([k, v]) => `<option value="${k}">${v.name} — ${v.desc}</option>`).join('');

  return settingsShell(`
  ${msg ? `<div class="msg ${msg.ok ? 'ok' : 'err'}">${msg.text}</div>` : ''}
  <div class="card" style="max-width:none">
    <h3>Trading tasks · master switch ${CONFIG.TRADE_ENABLED ? '<span style="color:#10b981">ON</span>' : '<span style="color:#ef4444">OFF (Settings)</span>'}</h3>
    ${tasks.length === 0 ? '<p style="font-size:13px;color:var(--text2)">No tasks yet — create the first one below. Each task is one wallet + one strategy, buying every call independently.</p>' : `
    <div style="overflow-x:auto"><table>
      <tr><th>Task</th><th>Wallet</th><th>Balance</th><th>Buys</th><th>Strategy</th><th>Realized PnL</th><th>Positions</th><th></th></tr>
      ${rows}
    </table></div>`}
  </div>
  <form method="POST" action="/tasks">
    <div class="card">
      <h3>New task</h3>
      <label>Name (e.g. "Alex aggressive", "Jake safe")</label>
      <input name="name" maxlength="40" placeholder="Task name">
      <label>Wallet private key (base58, write-only)</label>
      <input type="password" name="wallet_key" autocomplete="off" placeholder="burner wallet key — funds at risk are this wallet's balance only">
      <label>Buy calls from (PumpClaw's own calls are on by default — external callers add lanes)</label>
      ${sourceCheckboxes([PUMPCLAW_SOURCE_ID])}
      <label>Strategy preset (tune every knob after creating)</label>
      <select name="preset">${presetOpts}</select>
      <label>Entry size — % of this wallet per trade</label>
      <input type="number" name="entry_pct" min="1" max="100" value="10">
      <button type="submit">Create task</button>
      <div class="warn">The key is stored on the Railway volume so the bot can sign trades. Anyone with this dashboard's password controls every task — use burners, fund only what each strategy is meant to risk.</div>
    </div>
  </form>`, '/tasks');
}

function tpRowsHTML(s: Strategy): string {
  const rows: string[] = [];
  for (let i = 0; i < 6; i++) {
    const tp = s.tps[i];
    rows.push(`<div style="display:flex;gap:8px;margin:4px 0">
      <input type="number" step="0.1" min="1.05" name="tp_mult_${i}" placeholder="mult (e.g. 2)" value="${tp ? tp.mult : ''}" style="flex:1">
      <input type="number" step="1" min="1" max="100" name="tp_sell_${i}" placeholder="sell %" value="${tp ? Math.round(tp.sellPct * 100) : ''}" style="flex:1">
    </div>`);
  }
  return rows.join('');
}

async function buildTaskDetailHTML(task: TradeTask, msg?: { ok: boolean; text: string }): Promise<string> {
  const addr = taskManager.keypairFor(task).publicKey.toBase58();
  let bal: number | null = null;
  try { bal = await getSolBalance(taskManager.keypairFor(task)); } catch {}
  const s = task.strategy;
  const sum = taskSummary(task);
  const positions = taskManager.traderFor(task).getAllPositions().sort((a, b) => b.entryTime - a.entryTime).slice(0, 40);

  const posRows = positions.map(p => {
    const pnl = p.status === 'closed' ? (p.finalPnlSol ?? 0) : (p.totalSolReturned - p.entrySol * (1 - p.remainingPct));
    return `<tr>
      <td><b>$${p.symbol}</b> ${p.status === 'open' ? '<span style="color:#10b981;font-size:10px">LIVE</span>' : ''}</td>
      <td class="mono" style="font-size:11px;color:var(--text2)">${new Date(p.entryTime).toISOString().slice(5, 16).replace('T', ' ')}</td>
      <td class="mono">${p.entrySol.toFixed(3)} ◎</td>
      <td class="mono">${(p.peakMultiplier ?? 1).toFixed(2)}X</td>
      <td class="mono">${p.exits.length} exit(s)</td>
      <td class="mono" style="color:${p.status === 'open' ? 'var(--text2)' : pnl >= 0 ? '#10b981' : '#ef4444'}">${p.status === 'open' ? Math.round(p.remainingPct * 100) + '% open' : (pnl >= 0 ? '+' : '') + pnl.toFixed(3) + ' ◎'}</td>
    </tr>`;
  }).join('');

  const presetOpts = ['custom', ...Object.keys(STRATEGY_PRESETS)]
    .map(k => `<option value="${k}" ${s.preset === k ? 'selected' : ''}>${k === 'custom' ? 'Custom' : STRATEGY_PRESETS[k].name}</option>`).join('');

  return settingsShell(`
  ${msg ? `<div class="msg ${msg.ok ? 'ok' : 'err'}">${msg.text}</div>` : ''}
  <div class="card">
    <h3>${task.enabled ? '🟢' : '⚪'} ${task.name}</h3>
    <div class="kv">Wallet: <b class="mono">${addr}</b></div>
    <div class="kv">Buying: <b style="color:#f59e0b">${sourcesLabel(task)}</b> calls</div>
    <div class="kv" style="margin-top:6px">${bal !== null && bal < 0.01 ? '<span style="color:#f59e0b">⚠ This wallet is empty — send SOL to the address above, or paste a funded wallet\'s key in the strategy form below.</span>' : ''}</div>
    <div class="kv">Balance: <b>${bal === null ? '—' : bal.toFixed(4) + ' SOL'}</b> · Realized PnL: <b style="color:${sum.pnl >= 0 ? '#10b981' : '#ef4444'}">${sum.pnl >= 0 ? '+' : ''}${sum.pnl.toFixed(3)} SOL</b> · ${sum.open} open · ${sum.wins}/${sum.closed} wins</div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <form method="POST" action="/task"><input type="hidden" name="id" value="${task.id}"><input type="hidden" name="action" value="toggle">
        <button type="submit" style="margin:0;width:auto;padding:8px 16px;background:${task.enabled ? '#1a2035' : '#10b981'};color:${task.enabled ? '#c8d3e6' : '#04110b'}">${task.enabled ? '⏸ Pause task' : '▶ Start task'}</button></form>
      <form method="POST" action="/task" onsubmit="return confirm('Delete task ${task.name}? Position history is kept on disk.')">
        <input type="hidden" name="id" value="${task.id}"><input type="hidden" name="action" value="delete">
        <button type="submit" style="margin:0;width:auto;padding:8px 16px;background:#2a1215;color:#fca5a5">Delete</button></form>
    </div>
  </div>

  <form method="POST" action="/task">
    <input type="hidden" name="id" value="${task.id}"><input type="hidden" name="action" value="strategy">
    <div class="card">
      <h3>Strategy — edits apply to open positions on the next price tick</h3>
      <label>Name</label>
      <input name="name" value="${task.name}" maxlength="40">
      <label>Buy calls from — tick every caller this task should follow (unticking PumpClaw stops your own calls)</label>
      ${sourceCheckboxes(taskManager.sourcesFor(task))}
      <label>Preset (picking one resets the fields below)</label>
      <select name="preset">${presetOpts}</select>
      <label>Take-profit levels — multiplier + % of original position to sell (blank = unused)</label>
      ${tpRowsHTML(s)}
      <label>Trailing stop — % drop from ATH</label>
      <input type="number" name="trailing_drop" min="5" max="90" value="${Math.round(s.trailingDrop * 100)}">
      <label>Trailing active</label>
      <select name="trailing_from">
        <option value="entry" ${s.trailingFrom === 'entry' ? 'selected' : ''}>From entry (trailing IS the stop)</option>
        <option value="afterLastTp" ${s.trailingFrom === 'afterLastTp' ? 'selected' : ''}>After last TP (ladder-style)</option>
      </select>
      <label>Stop loss % below entry (ladder-style only)</label>
      <input type="number" name="stop_loss" min="1" max="95" value="${Math.round((1 - s.stopLossPct) * 100)}">
      <div class="toggle-row"><input type="checkbox" id="be" name="break_even" value="1" ${s.breakEvenAfterTp1 ? 'checked' : ''}><label for="be" style="margin:0;font-size:13px;color:var(--text)">Move stop to break-even after first TP</label></div>
      <label>Entry — % of wallet per trade</label>
      <input type="number" name="entry_pct" min="1" max="100" value="${Math.round(s.entryPct * 100)}">
      <label>Min entry (SOL) / Max entry (SOL, 0 = uncapped)</label>
      <div style="display:flex;gap:8px">
        <input type="number" name="min_entry" step="0.01" min="0.01" value="${s.minEntrySol}" style="flex:1">
        <input type="number" name="max_entry" step="0.01" min="0" value="${s.maxEntrySol}" style="flex:1">
      </div>
      <label>Replace this task's wallet (base58 private key — leave blank to keep)</label>
      <input type="password" name="wallet_key" autocomplete="off" placeholder="only if you want this task to trade from a different wallet">
      <label>Slippage % / Priority fee (SOL)</label>
      <div style="display:flex;gap:8px">
        <input type="number" name="slippage" min="1" max="99" value="${Math.round(s.slippageBps / 100)}" style="flex:1">
        <input type="number" name="priority_fee" step="0.00001" min="0" value="${s.priorityFeeLamports / 1e9}" style="flex:1">
      </div>
      <button type="submit">Save strategy</button>
    </div>
  </form>

  <form method="POST" action="/task">
    <input type="hidden" name="id" value="${task.id}"><input type="hidden" name="action" value="webhook">
    <div class="card">
      <h3>🔔 Discord webhook for this task</h3>
      <p style="font-size:12px;color:var(--text2);line-height:1.6;margin-bottom:4px">
        ${task.webhook
          ? `Currently posting this task's buys and sells to <b style="color:#10b981">its own channel</b> (…${task.webhook.slice(-12)}).`
          : `Right now this task's fills go to the shared trades channel. Paste a webhook to give it a dedicated channel instead.`}
        Create one in Discord: <i>Channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL</i>.
      </p>
      <label>Webhook URL${task.webhook ? ' (leave blank and save to remove)' : ''}</label>
      <input name="webhook" autocomplete="off" placeholder="https://discord.com/api/webhooks/…" value="">
      <div class="toggle-row"><input type="checkbox" id="tw" name="test" value="1" checked>
        <label for="tw" style="margin:0;font-size:13px;color:var(--text)">Send a test message so I know it works</label></div>
      <button type="submit" style="background:#5865F2;color:#fff">Save webhook</button>
    </div>
  </form>

  <form method="POST" action="/task">
    <input type="hidden" name="id" value="${task.id}"><input type="hidden" name="action" value="duplicate">
    <div class="card">
      <h3>⧉ Copy this task</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:6px">Same strategy and call sources, different wallet — for running the same setup at another size, or for someone else.</p>
      <label>New task name</label>
      <input name="name" maxlength="40" placeholder="${task.name} copy">
      <label>Wallet private key for the copy (base58)</label>
      <input type="password" name="wallet_key" autocomplete="off" placeholder="burner wallet key">
      <button type="submit" style="background:#3b82f6;color:#fff">Create copy</button>
    </div>
  </form>

  <div class="card" style="max-width:none">
    <h3>📊 Stats</h3>
    <div id="stats-tiles" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;font-size:13px"><span style="color:var(--text3)">Loading…</span></div>
    <canvas id="pnl-spark" height="60" style="width:100%;margin-top:12px"></canvas>
  </div>
  <div class="card" style="max-width:none">
    <h3>💼 Wallet holdings — on-chain, live <span id="h-status" style="margin-left:8px;font-size:11px;text-transform:none;letter-spacing:0;color:var(--text3)">loading…</span></h3>
    <div id="h-body" style="font-size:13px;color:var(--text3)">Loading…</div>
  </div>
  <script>
  (function () {
    const TASK_ID = ${JSON.stringify(task.id)};
    async function tick() {
      try {
        const d = await (await fetch('/api/task?id=' + TASK_ID)).json();
        const st = document.getElementById('h-status');
        const body = document.getElementById('h-body');
        st.textContent = (d.enabled ? 'running' : 'paused') + ' · ' + d.strategy + ' · refreshes 15s';
        const mints = [...new Set([...d.holdings.map(h => h.mint), ...d.open.map(p => p.mint),
          ...(d.pending || []).map(p => p.mint)])].slice(0, 30);
        let prices = {};
        if (mints.length) {
          try {
            const dex = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mints.join(','))).json();
            for (const pair of (dex.pairs || [])) {
              const m = pair.baseToken && pair.baseToken.address;
              if (m && (!prices[m] || (+pair.volume?.h24 || 0) > prices[m].vol)) prices[m] = { price: +pair.priceUsd, vol: +pair.volume?.h24 || 0 };
            }
          } catch (e) {}
        }
        // ── sell plan: every level an open position will exit at ──
        const ep = document.getElementById('exit-plan');
        if (ep) {
          if (!d.open || !d.open.length) {
            ep.innerHTML = '';
          } else {
            const mc = v => !v ? '—' : v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? '$' + Math.round(v / 1e3) + 'K' : '$' + Math.round(v);
            let cards = '';
            for (const pos of d.open) {
              const live = prices[pos.mint] ? prices[pos.mint].price : null;
              const liveMult = live && pos.entryPrice > 0 ? live / pos.entryPrice : null;
              const liveMC = liveMult && pos.entryMC ? pos.entryMC * liveMult : null;

              // rows: take-profits above, the live stop below — the order they'd fire in
              const levels = [...(pos.ladder || [])];
              if (pos.liveStop) levels.push(pos.liveStop);
              levels.sort((a, b) => b.mult - a.mult);

              let rows = '';
              for (const L of levels) {
                const isStop = L.kind === 'trail' || L.kind === 'stop';
                const away = liveMult ? (L.mult / liveMult - 1) * 100 : null;
                const col = L.hit ? 'var(--text3)' : isStop ? '#ef4444' : '#10b981';
                rows +=
                  '<tr style="opacity:' + (L.hit ? '.45' : '1') + '">' +
                  '<td style="padding:5px 8px;border-top:1px solid var(--border);color:' + col + ';font-weight:700">' +
                    (L.hit ? '✓ ' : isStop ? '▼ ' : '▲ ') + L.label + '</td>' +
                  '<td class="mono" style="padding:5px 8px;border-top:1px solid var(--border)">' + L.mult.toFixed(2) + '×</td>' +
                  '<td class="mono" style="padding:5px 8px;border-top:1px solid var(--border);color:' + col + ';font-weight:700">' + mc(L.mc) + '</td>' +
                  '<td class="mono" style="padding:5px 8px;border-top:1px solid var(--border);color:var(--text2)">$' + L.price.toExponential(2) + '</td>' +
                  '<td class="mono" style="padding:5px 8px;border-top:1px solid var(--border)">sells ' + L.sellPct + '%</td>' +
                  '<td class="mono" style="padding:5px 8px;border-top:1px solid var(--border);color:var(--text3)">' +
                    (L.hit ? 'done' : away === null ? '—' : (away > 0 ? '+' : '') + away.toFixed(1) + '%') + '</td>' +
                  '</tr>';
              }
              const pnlPct = liveMult ? (liveMult - 1) * 100 : null;
              cards +=
                '<div class="card" style="max-width:none;border-left:3px solid ' + (pos.stopTriggered ? '#ef4444' : '#10b981') + '">' +
                '<h3>🎯 Sell plan — $' + pos.symbol + (pos.stopTriggered ? ' <span style="color:#ef4444;font-size:12px">SELLING NOW</span>' : '') + '</h3>' +
                '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--text2);margin:-4px 0 8px">' +
                  '<span>entry <b style="color:var(--text)">' + mc(pos.entryMC) + '</b></span>' +
                  '<span>now <b style="color:' + (pnlPct === null ? 'var(--text)' : pnlPct >= 0 ? '#10b981' : '#ef4444') + '">' +
                    (liveMC ? mc(liveMC) : '—') + (liveMult ? ' (' + liveMult.toFixed(2) + '×)' : '') + '</b></span>' +
                  '<span>peak <b style="color:#f59e0b">' + (pos.peakMultiplier || 1).toFixed(2) + '×</b></span>' +
                  '<span>unsold <b style="color:var(--text)">' + Math.round(pos.remainingPct * 100) + '%</b></span>' +
                  (pos.timeExitMin !== null ? '<span>clock exit in <b style="color:var(--text)">' + pos.timeExitMin + 'm</b></span>' : '') +
                '</div>' +
                '<div style="overflow-x:auto"><table style="width:100%">' +
                '<tr><th style="text-align:left">Level</th><th style="text-align:left">Mult</th><th style="text-align:left">Market cap</th><th style="text-align:left">Price</th><th style="text-align:left">Size</th><th style="text-align:left">Away</th></tr>' +
                rows + '</table></div>' +
                '<p style="font-size:11px;color:var(--text3);margin:8px 0 0">The trailing stop moves up as the coin runs — this is where it sits right now, not where it started.</p>' +
                '</div>';
            }
            ep.innerHTML = cards;
          }
        }

        // ── waiting to buy: calls queued behind a dip that hasn't happened yet ──
        const wq = document.getElementById('waiting-queue');
        if (wq) {
          if (!d.pending || !d.pending.length) {
            wq.innerHTML = '';
          } else {
            const mc = v => !v ? '—' : v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? '$' + Math.round(v / 1e3) + 'K' : '$' + Math.round(v);
            let rows = '';
            for (const p of d.pending) {
              const live = prices[p.mint] ? prices[p.mint].price : null;
              // how much further it still has to fall from here
              const away = live ? (1 - p.target / live) * 100 : null;
              const liveMC = (live && p.callPrice > 0 && p.callMC) ? p.callMC * (live / p.callPrice) : null;
              const mins = Math.max(0, Math.round((p.expiresAt - Date.now()) / 60000));
              const close = away !== null && away <= 3;
              rows +=
                '<tr>' +
                '<td style="padding:6px 8px;border-top:1px solid var(--border)"><b>$' + p.symbol + '</b>' +
                  '<div style="font-size:10px;color:var(--text3)">called at ' + mc(p.callMC) + '</div></td>' +
                '<td class="mono" style="padding:6px 8px;border-top:1px solid var(--border);color:#f59e0b">' +
                  (liveMC ? mc(liveMC) : '—') + '<div style="font-size:10px;color:var(--text3)">now</div></td>' +
                '<td class="mono" style="padding:6px 8px;border-top:1px solid var(--border);color:#10b981;font-weight:700">' +
                  (p.targetMC ? mc(p.targetMC) : '$' + p.target.toExponential(2)) +
                  '<div style="font-size:10px;color:var(--text3)">triggers here (−' + Math.round(p.dipPct) + '%)</div></td>' +
                '<td class="mono" style="padding:6px 8px;border-top:1px solid var(--border);color:' + (close ? '#10b981' : 'var(--text2)') + '">' +
                  (away === null ? '—' : away <= 0 ? 'filling…' : '−' + away.toFixed(1) + '% to go') + '</td>' +
                '<td class="mono" style="padding:6px 8px;border-top:1px solid var(--border);color:' + (mins <= 5 ? '#ef4444' : 'var(--text2)') + '">' +
                  mins + 'm left</td>' +
                '<td style="padding:6px 8px;border-top:1px solid var(--border)"><a style="font-size:11px;color:#3b82f6" href="https://dexscreener.com/solana/' + p.mint + '" target="_blank">chart</a></td>' +
                '</tr>';
            }
            wq.innerHTML =
              '<div class="card" style="max-width:none;border-left:3px solid #f59e0b">' +
              '<h3>⏳ Waiting to buy (' + d.pending.length + ')</h3>' +
              '<p style="font-size:12px;color:var(--text2);margin:-4px 0 8px">This strategy enters on a dip, so these calls are queued — no SOL is spent unless the price falls to the trigger. A fast drop can fill below it, which is a cheaper entry, not a worse one.</p>' +
              '<div style="overflow-x:auto"><table style="width:100%">' +
              '<tr><th style="text-align:left">Coin</th><th style="text-align:left">Market cap</th><th style="text-align:left">Target</th><th style="text-align:left">Distance</th><th style="text-align:left">Window</th><th></th></tr>' +
              rows + '</table></div></div>';
          }
        }

        // ── stats tiles + sparkline ──
        if (d.stats) {
          const s2 = d.stats;
          const tile = (label, val, col) => '<div style="background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:10px"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">' + label + '</div><div style="font-size:17px;font-weight:700;color:' + (col || 'var(--text)') + '">' + val + '</div></div>';
          document.getElementById('stats-tiles').innerHTML =
            tile('Realized PnL', (s2.realizedPnl >= 0 ? '+' : '') + s2.realizedPnl + ' ◎', s2.realizedPnl >= 0 ? '#10b981' : '#ef4444') +
            tile('Win rate', s2.winPct + '% (' + s2.wins + '/' + s2.closed + ')') +
            tile('Open now', d.open.length) +
            tile('Best peak', s2.bestPeak + 'X', '#f59e0b') +
            tile('Total deployed', s2.totalIn + ' ◎');
          const cv = document.getElementById('pnl-spark');
          if (cv && s2.curve.length > 1) {
            const ctx = cv.getContext('2d');
            const W = cv.width = cv.offsetWidth, H = cv.height;
            const mn = Math.min(0, ...s2.curve), mx = Math.max(0, ...s2.curve), rng = (mx - mn) || 1;
            ctx.clearRect(0, 0, W, H);
            const zy = H - 6 - ((0 - mn) / rng) * (H - 12);
            ctx.strokeStyle = '#1a2035'; ctx.beginPath(); ctx.moveTo(0, zy); ctx.lineTo(W, zy); ctx.stroke();
            ctx.strokeStyle = s2.curve[s2.curve.length - 1] >= 0 ? '#10b981' : '#ef4444';
            ctx.lineWidth = 1.6; ctx.beginPath();
            s2.curve.forEach((v, i) => {
              const x = (i / (s2.curve.length - 1)) * (W - 4) + 2;
              const y = H - 6 - ((v - mn) / rng) * (H - 12);
              i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            });
            ctx.stroke();
          }
        }
        let html = '<div style="margin-bottom:10px;font-size:14px;color:var(--text)">◎ <b>' + (d.sol === null ? '—' : d.sol.toFixed(4)) + ' SOL</b></div>';
        if (!d.holdings.length) {
          html += '<span style="color:var(--text3)">No token holdings — SOL only. Positions appear here the moment a buy fills.</span>';
        } else {
          html += '<table style="width:100%;border-collapse:collapse;font-size:13px"><tr>' +
            ['Token', 'Amount', 'Price', 'Value', ''].map(h => '<th style="color:var(--text3);text-align:left;padding:4px 8px;font-size:11px;text-transform:uppercase">' + h + '</th>').join('') + '</tr>';
          let totalUsd = 0;
          for (const h of d.holdings) {
            const pr = prices[h.mint];
            const val = pr ? h.uiAmount * pr.price : null;
            if (val) totalUsd += val;
            html += '<tr>' +
              '<td style="padding:5px 8px;border-top:1px solid var(--border)"><b>' + (h.symbol ? '$' + h.symbol : h.mint.slice(0, 6) + '…' + h.mint.slice(-4)) + '</b>' + (h.isOpen ? ' <span style="color:#10b981;font-size:10px">LIVE POSITION</span>' : (h.symbol ? ' <span style="color:var(--text3);font-size:10px">not tracked</span>' : '')) + '</td>' +
              '<td class="mono" style="padding:5px 8px;border-top:1px solid var(--border)">' + h.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</td>' +
              '<td class="mono" style="padding:5px 8px;border-top:1px solid var(--border);color:var(--text2)">' + (pr ? '$' + pr.price.toExponential(2) : '—') + '</td>' +
              '<td class="mono" style="padding:5px 8px;border-top:1px solid var(--border);color:' + (val ? '#10b981' : 'var(--text3)') + '">' + (val ? '$' + val.toFixed(2) : 'no price') + '</td>' +
              '<td style="padding:5px 8px;border-top:1px solid var(--border)"><a style="font-size:11px;color:#3b82f6" href="https://dexscreener.com/solana/' + h.mint + '" target="_blank">chart</a></td>' +
              '</tr>';
          }
          html += '</table><div style="margin-top:8px;font-size:12px;color:var(--text2)">Token value: <b style="color:var(--text)">$' + totalUsd.toFixed(2) + '</b></div>';
        }
        body.innerHTML = html;
      } catch (e) {
        document.getElementById('h-status').textContent = 'refresh failed — retrying';
      }
    }
    tick();
    setInterval(tick, 15000);
  })();
  </script>

  <div id="exit-plan"></div>
  <div id="waiting-queue"></div>

  <div class="card" style="max-width:none">
    <h3>Positions (last 40)</h3>
    ${positions.length === 0 ? '<p style="font-size:13px;color:var(--text2)">None yet — next call buys automatically while the task is running.</p>' : `
    <div style="overflow-x:auto"><table>
      <tr><th>Coin</th><th>Entry time</th><th>Size</th><th>Peak</th><th>Exits</th><th>PnL / state</th></tr>
      ${posRows}
    </table></div>`}
  </div>`, `/task?id=${task.id}`);
}

function strategyFromForm(form: Record<string, string>, current?: Strategy): Partial<Strategy> {
  // Preset switch: if a non-custom preset picked and it differs from current, take the preset wholesale
  if (form.preset && form.preset !== 'custom' && STRATEGY_PRESETS[form.preset] && form.preset !== current?.preset) {
    const s = STRATEGY_PRESETS[form.preset].make();
    if (form.entry_pct) s.entryPct = Math.min(1, Math.max(0.01, parseFloat(form.entry_pct) / 100));
    return s;
  }
  const tps: { mult: number; sellPct: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const m = parseFloat(form[`tp_mult_${i}`]), sp = parseFloat(form[`tp_sell_${i}`]);
    if (Number.isFinite(m) && Number.isFinite(sp) && m > 1 && sp > 0) tps.push({ mult: m, sellPct: sp / 100 });
  }
  return {
    preset: 'custom',
    tps,
    trailingDrop: parseFloat(form.trailing_drop) / 100,
    trailingFrom: form.trailing_from === 'afterLastTp' ? 'afterLastTp' : 'entry',
    stopLossPct: 1 - parseFloat(form.stop_loss) / 100,
    breakEvenAfterTp1: form.break_even === '1',
    entryPct: parseFloat(form.entry_pct) / 100,
    minEntrySol: parseFloat(form.min_entry),
    maxEntrySol: parseFloat(form.max_entry),
    slippageBps: parseFloat(form.slippage) * 100,
    priorityFeeLamports: parseFloat(form.priority_fee) * 1e9,
  };
}

async function handleTasksPost(req: IncomingMessage, res: ServerResponse, pathname: string, body: string): Promise<void> {
  if (!authOk(req)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(settingsLoginHTML());
    return;
  }
  const form = parseFormBody(body);
  const html = async (page: 'list' | string, msg: { ok: boolean; text: string }) => {
    const out = page === 'list'
      ? await buildTasksHTML(msg)
      : await buildTaskDetailHTML(taskManager.get(page)!, msg);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(out);
  };
  try {
    if (pathname === '/tasks') {
      const task = taskManager.create(form.name, form.wallet_key, strategyFromForm(form), sourcesFromForm(form));
      await html('list', { ok: true, text: `Task "${task.name}" created and running — it buys the next call.` });
      return;
    }
    const task = taskManager.get(form.id);
    if (!task) { await html('list', { ok: false, text: 'Task not found' }); return; }
    if (form.action === 'toggle') {
      taskManager.update(task.id, { enabled: !task.enabled });
      await html('list', { ok: true, text: `"${task.name}" ${task.enabled ? 'running' : 'paused'}.` });
    } else if (form.action === 'delete') {
      const name = task.name;
      taskManager.remove(task.id);
      await html('list', { ok: true, text: `"${name}" deleted (position history kept on disk).` });
    } else if (form.action === 'webhook') {
      const url2 = (form.webhook ?? '').trim();
      taskManager.update(task.id, { webhook: url2 });
      let note = url2 ? `Webhook saved — "${task.name}" now posts its fills to that channel.` : `Webhook cleared — "${task.name}" posts to the shared trades channel again.`;
      if (url2 && form.test === '1') {
        const ok = await sendTradeActivity(task.name, 'buy', 'TEST', 'test',
          `webhook connected — live fills for **${task.name}** will appear here`, undefined, url2)
          .then(() => true).catch(() => false);
        note += ok ? ' A test message was sent.' : ' (test message failed — double-check the URL)';
      }
      await html(task.id, { ok: true, text: note });
    } else if (form.action === 'duplicate') {
      const copy = taskManager.duplicate(task.id, form.name, form.wallet_key);
      await html(copy.id, { ok: true, text: `Copied "${task.name}" → "${copy.name}". Fund its wallet to start trading.` });
    } else if (form.action === 'strategy') {
      taskManager.update(task.id, { name: form.name, sources: sourcesFromForm(form), walletKey: form.wallet_key || undefined, strategy: strategyFromForm(form, task.strategy) });
      await html(task.id, { ok: true, text: 'Strategy saved — applies to open positions on the next tick.' });
    } else {
      await html('list', { ok: false, text: 'Unknown action' });
    }
  } catch (err: any) {
    await html('list', { ok: false, text: err.message });
  }
}

function parseRange(url: string): TimeRange {
  const match = url.match(/[?&]range=([^&]+)/);
  const val = match?.[1] ?? 'all';
  return (val in RANGE_MS) ? val as TimeRange : 'all';
}

export function startDashboard(port?: number): void {
  const PORT = port ?? parseInt(process.env.PORT || '3000', 10);
  const HOST = process.env.PORT ? '0.0.0.0' : '127.0.0.1'; // Railway needs 0.0.0.0

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];

    // POST /interactions — Discord slash commands (/mog). Signature over the RAW body.
    if (req.method === 'POST' && pathname === '/interactions') {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c; if (raw.length > 128_000) req.destroy(); });
      req.on('end', () => {
        const sig = String(req.headers['x-signature-ed25519'] ?? '');
        const ts = String(req.headers['x-signature-timestamp'] ?? '');
        if (!verifyInteractionSignature(sig, ts, raw)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid request signature' }));
          return;
        }
        handleInteraction(JSON.parse(raw)).then(out => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
        }).catch(err => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 4, data: { content: 'Card failed: ' + err.message, flags: 64 } }));
        });
      });
      return;
    }

    // POST /settings | /tasks | /task — collect body then handle
    if (req.method === 'POST' && pathname === '/strategy') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 64_000) req.destroy(); });
      req.on('end', () => {
        (async () => {
          if (!authOk(req)) {
            res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(settingsLoginHTML());
            return;
          }
          const form = parseFormBody(body);
          try {
            const shadow = taskManager.all().find(t => t.paper && t.strategy.preset === form.key);
            if (!shadow) throw new Error('unknown strategy');
            const strat = { ...shadow.strategy };
            if (form.entry_pct) strat.entryPct = Math.min(1, Math.max(0.01, parseFloat(form.entry_pct) / 100));
            if (form.max_entry) strat.maxEntrySol = Math.max(0, parseFloat(form.max_entry));
            const task = taskManager.create(form.name || `${shadow.name.replace('📄 ', '')} (live)`, form.wallet_key, strat, taskManager.sourcesFor(shadow));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(await buildTaskDetailHTML(task, { ok: true, text: `Live task "${task.name}" created with this strategy. Fund the wallet above and it trades the next call.` }));
          } catch (err: any) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(await buildTasksHTML({ ok: false, text: err.message }));
          }
        })().catch(err => { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Error: ' + err.message); });
      });
      return;
    }

    if (req.method === 'POST' && (pathname === '/settings' || pathname === '/tasks' || pathname === '/task')) {
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 64_000) req.destroy(); });
      req.on('end', () => {
        const handler = pathname === '/settings'
          ? handleSettingsPost(req, res, body)
          : handleTasksPost(req, res, pathname, body);
        handler.catch(err => {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error: ' + err.message);
        });
      });
      return;
    }

    if (pathname === '/tasks' || pathname === '/task') {
      if (!authOk(req)) {
        res.writeHead(authHash() ? 401 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(authHash() ? settingsLoginHTML() : settingsShell('<div class="card"><h3>Tasks disabled</h3><p style="font-size:13px">Set DASH_PASSWORD in Railway to enable task management.</p></div>', '/tasks'));
        return;
      }
      const idMatch = url.match(/[?&]id=([a-z0-9]+)/);
      const task = pathname === '/task' && idMatch ? taskManager.get(idMatch[1]) : undefined;
      const render = pathname === '/task'
        ? (task ? buildTaskDetailHTML(task) : buildTasksHTML({ ok: false, text: 'Task not found' }))
        : buildTasksHTML();
      render.then(html => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Tasks error: ' + err.message);
      });
      return;
    }

    if (pathname === '/settings') {
      const render = authOk(req) || !authHash()
        ? buildSettingsHTML()
        : Promise.resolve(settingsLoginHTML());
      render.then(html => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Settings error: ' + err.message);
      });
      return;
    }

    if (pathname === '/api/tasks-summary') {
      if (!authOk(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'auth required' }));
        return;
      }
      (async () => {
        const tasks = taskManager.all();
        // Only real tasks need an on-chain balance; paper wallets are throwaway.
        const balances = await Promise.all(tasks.map(t =>
          t.paper ? Promise.resolve(null) : getSolBalance(taskManager.keypairFor(t)).catch(() => null)));
        const out = tasks.map((t, i) => {
          const s = taskSummary(t);
          return {
            id: t.id, name: t.name, enabled: t.enabled, paper: !!t.paper,
            source: sourcesLabel(t),
            strategy: describeStrategy(t.strategy),
            balance: t.paper ? null : balances[i],
            pnl: +s.pnl.toFixed(3), open: s.open, wins: s.wins, closed: s.closed,
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tasks: out }));
      })().catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // POST /api/forget — remove calls (and their paper trades) from the stats.
    //
    // Destructive, so: auth-gated, backs every file up first, and reports exactly
    // what it touched. Real positions are deliberately left alone unless asked for
    // explicitly — that money actually moved, and deleting it would make the
    // dashboard's P&L disagree with the wallet, which is the opposite of the point.
    if (req.method === 'POST' && pathname === '/api/forget') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 32_000) req.destroy(); });
      req.on('end', () => {
        if (!authOk(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'auth required' }));
          return;
        }
        try {
          const parsed = JSON.parse(body || '{}');
          const mints: string[] = Array.isArray(parsed.mints) ? parsed.mints.filter((m: any) => typeof m === 'string' && m.length > 30) : [];
          const alsoReal = parsed.includeRealTrades === true;
          if (!mints.length) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'pass { mints: ["<mint>", ...] }' }));
            return;
          }
          const stamp = Date.now();
          const report: Record<string, any> = {
            requested: mints.length, calls: 0, paperTrades: 0,
            taskHistories: 0, paperPositions: 0, realPositions: 0, backups: [],
          };

          // Snapshot first. Everything below mutates live objects that persist
          // themselves, so there is no undo without this.
          for (const f of ['calls.json', 'trades.json']) {
            const full = join(CONFIG.DATA_DIR, f);
            if (!existsSync(full)) continue;
            try {
              writeFileSync(`${full}.bak-${stamp}`, readFileSync(full));
              report.backups.push(`${f}.bak-${stamp}`);
            } catch { /* a failed backup must not block the removal */ }
          }

          // Go through the live objects. Editing these files directly does nothing
          // lasting: each is rewritten from memory on the next save, which is why
          // the first version of this endpoint appeared to work and changed nothing.
          for (const mint of mints) {
            if (runtime.tracker?.forget(mint)) report.calls++;
            if (runtime.paperTrader?.forget(mint)) report.paperTrades++;
            const r = taskManager.forgetMint(mint, alsoReal);
            report.taskHistories += r.tasks;
            report.paperPositions += r.paper;
            report.realPositions += r.real;
          }

          report.realTradesKept = !alsoReal;
          report.note = alsoReal
            ? 'Real trades removed too — dashboard P&L will no longer match the wallet.'
            : 'Real position history kept so P&L still matches the wallet. Pass includeRealTrades:true to drop it as well.';

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(report, null, 2));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (pathname === '/api/poolprice') {
      (async () => {
        const { watchStats, poolPriceUsd } = await import('./pool-price.js');
        const stats = watchStats();
        const rows = await Promise.all(stats.map(async w => ({
          ...w, priceUsd: await poolPriceUsd(w.mint).catch(() => null),
        })));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ watching: rows.length, pools: rows }));
      })().catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    if (pathname === '/api/task') {
      if (!authOk(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'auth required' }));
        return;
      }
      const idm = url.match(/[?&]id=([a-z0-9]+)/);
      const task = idm ? taskManager.get(idm[1]) : undefined;
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'task not found' }));
        return;
      }
      (async () => {
        const kp = taskManager.keypairFor(task);
        const [sol, holdings] = await Promise.all([
          getSolBalance(kp).catch(() => null),
          getTokenHoldings(kp).catch(() => []),
        ]);
        const pending = taskManager.pendingEntries()
          .filter(p => p.taskId === task.id)
          .map(p => {
            // Orders queued before callMC was recorded: recover it from the call.
            const allCalls: CallRecord[] = loadJSON(join(CONFIG.DATA_DIR, 'calls.json'));
            const rec = allCalls.find((c: CallRecord) => c.mint === p.mint);
            const callMC = p.callMC ?? rec?.entryMC ?? 0;
            const dipPct = p.callPrice > 0 ? (1 - p.target / p.callPrice) * 100 : 0;
            return { ...p, callMC, dipPct, targetMC: p.targetMC ?? (callMC > 0 ? callMC * (1 - dipPct / 100) : 0) };
          });
        const positions = taskManager.traderFor(task).getAllPositions();
        const symByMint: Record<string, string> = {};
        const openMints = new Set<string>();
        for (const pos of positions) {
          symByMint[pos.mint] = pos.symbol;
          if (pos.status === 'open') openMints.add(pos.mint);
        }
        const strat = task.strategy;
        const open = positions.filter(pp => pp.status === 'open').map(pp => {
          const mcAt = (mult: number) => pp.entryMC > 0 ? pp.entryMC * mult : 0;
          const hits = pp.tpHits ?? [pp.tp1Hit, pp.tp2Hit, pp.tp3Hit];

          // Every level this position will sell at, in the order it would happen.
          const ladder = (strat.tps ?? []).map((tp, i) => ({
            kind: 'tp' as const,
            label: `TP${i + 1}`,
            mult: tp.mult,
            sellPct: Math.round(tp.sellPct * 100),
            price: pp.entryPrice * tp.mult,
            mc: mcAt(tp.mult),
            hit: !!hits[i],
          }));

          // Stops: the live one is whichever sits higher (the tighter of the two).
          const trailMult = pp.entryPrice > 0 ? pp.trailingStopPrice / pp.entryPrice : 0;
          const stopMult = pp.entryPrice > 0 ? pp.stopLossPrice / pp.entryPrice : 0;
          const stops = [
            pp.trailingActive && pp.trailingStopPrice > 0 ? {
              kind: 'trail' as const,
              label: `Trailing −${Math.round((strat.trailingDrop ?? 0) * 100)}% (from ${(pp.trailingHighPrice / (pp.entryPrice || 1)).toFixed(2)}× high)`,
              mult: trailMult, sellPct: Math.round(pp.remainingPct * 100),
              price: pp.trailingStopPrice, mc: mcAt(trailMult), hit: false,
            } : null,
            pp.stopLossPrice > 0 ? {
              kind: 'stop' as const,
              label: pp.beStopArmed ? 'Break-even stop' : `Stop −${Math.round((1 - (strat.stopLossPct ?? 0)) * 100)}%`,
              mult: stopMult, sellPct: Math.round(pp.remainingPct * 100),
              price: pp.stopLossPrice, mc: mcAt(stopMult), hit: false,
            } : null,
          ].filter(Boolean);
          // Only the higher stop can actually fire first.
          const liveStop = stops.sort((a: any, b: any) => b.mult - a.mult)[0] ?? null;

          const heldMin = (Date.now() - pp.entryTime) / 60_000;
          return {
            mint: pp.mint, symbol: pp.symbol, entrySol: pp.entrySol, entryPrice: pp.entryPrice,
            entryMC: pp.entryMC, entryTime: pp.entryTime, remainingPct: pp.remainingPct,
            totalSolReturned: pp.totalSolReturned, trailingStopPrice: pp.trailingStopPrice,
            peakMultiplier: pp.peakMultiplier, stopTriggered: !!pp.stopTriggered,
            ladder, liveStop,
            timeExitMin: strat.maxHoldMin ? Math.max(0, Math.round(strat.maxHoldMin - heldMin)) : null,
          };
        });
        // Stats + cumulative realized PnL curve from closed positions
        const closed = positions.filter(pp => pp.status === 'closed').sort((a, b) => (a.closedTime ?? 0) - (b.closedTime ?? 0));
        let cum = 0;
        const curve = closed.map(pp => { cum += pp.finalPnlSol ?? 0; return +cum.toFixed(4); });
        const wins = closed.filter(pp => (pp.finalPnlSol ?? 0) > 0).length;
        const best = closed.reduce((mx, pp) => Math.max(mx, pp.peakMultiplier ?? 1), 0);
        const stats = {
          realizedPnl: +cum.toFixed(4),
          closed: closed.length,
          wins,
          winPct: closed.length ? Math.round(wins / closed.length * 100) : 0,
          bestPeak: +best.toFixed(2),
          totalIn: +closed.reduce((s2, pp) => s2 + pp.entrySol, 0).toFixed(3),
          curve,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: task.id, name: task.name, enabled: task.enabled,
          strategy: describeStrategy(task.strategy),
          sol, stats,
          holdings: holdings.map(h => ({ ...h, symbol: symByMint[h.mint] ?? null, isOpen: openMints.has(h.mint) })),
          open, pending,
        }));
      })().catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    if (pathname === '/api/live') {
      (async () => {
        const open = taskManager.openPositions().map(({ task, pos: p }) => ({
          taskId: task.id, taskName: task.name,
          mint: p.mint, symbol: p.symbol, entrySol: p.entrySol, entryPrice: p.entryPrice,
          entryMC: p.entryMC, entryTime: p.entryTime, remainingPct: p.remainingPct,
          totalSolReturned: p.totalSolReturned, trailingStopPrice: p.trailingStopPrice,
          peakMultiplier: p.peakMultiplier, exits: p.exits.length,
          // The stop that can actually fire is the HIGHER of the two. Exposing only
          // the trailing price made every consumer report a looser stop than the one
          // the trader enforces: $BABYGROK was shown as stopping at 0.50x and
          // correctly stopped at 0.60x, which looks like a fault and is not one.
          stopLossPrice: p.stopLossPrice,
          beStopArmed: p.beStopArmed,
          effectiveStopPrice: Math.max(p.stopLossPrice, p.trailingActive ? p.trailingStopPrice : 0),
          trailingActive: p.trailingActive,
        }));
        let balance: number | null = null;
        try {
          // combined balance across enabled task wallets
          const realTasks = taskManager.allEnabled().filter(t => !t.paper);
          const bals = await Promise.all(realTasks.map(t =>
            getSolBalance(taskManager.keypairFor(t)).catch(() => null)));
          const known = bals.filter((b): b is number => b !== null);
          balance = known.length ? known.reduce((s, b) => s + b, 0) : null;
        } catch { /* omit */ }
        const tasks = taskManager.all();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          balance,
          tradeEnabled: CONFIG.TRADE_ENABLED,
          taskCount: tasks.length,
          enabledCount: tasks.filter(t => t.enabled).length,
          entryPct: tasks[0]?.strategy.entryPct ?? 0.1,
          trailingDrop: tasks[0]?.strategy.trailingDrop ?? 0.45,
          strategy: 'per-task',
          open,
        }));
      })().catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    if (pathname === '/chart.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=86400' });
      res.end(chartJsSource);
    } else if (pathname === '/' || pathname === '/hq') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildHqHTML());
    } else if (pathname === '/classic' || pathname === '/dashboard') {
      try {
        const range = parseRange(url);
        const data = buildDashboardData(range);
        const html = buildHTML(data, range);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error building dashboard: ' + err.message + '\n' + err.stack);
      }
    } else if (pathname === '/strategies') {
      try {
        const range = parseRange(url);
        const html = buildStrategyHTML(buildStrategyData(range), range);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error building strategy lab: ' + err.message + '\n' + err.stack);
      }
    } else if (pathname === '/api/strategies') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildStrategyData(parseRange(url)), null, 2));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (pathname === '/api/correlations') {
      try {
        const calls: CallRecord[] = loadJSON(join(CONFIG.DATA_DIR, 'calls.json'));
        // Only include calls with rich entry data (new format)
        const rich = calls.filter(c => c.entryLiquidity !== undefined && c.peakMultiplier > 0);

        type Bin = { label: string; samples: number[]; winners: number; total: number };
        const bin = (label: string): Bin => ({ label, samples: [], winners: 0, total: 0 });

        function bucket(bins: Bin[], value: number, peak: number, bands: { label: string; min: number; max: number }[]) {
          for (const b of bands) {
            if (value >= b.min && value < b.max) {
              const tgt = bins.find(x => x.label === b.label)!;
              tgt.samples.push(peak);
              tgt.total++;
              if (peak >= 2) tgt.winners++;
              break;
            }
          }
        }

        // Build buckets for each metric
        const liqBands = [
          { label: '<$5K', min: 0, max: 5000 },
          { label: '$5-10K', min: 5000, max: 10000 },
          { label: '$10-20K', min: 10000, max: 20000 },
          { label: '$20-50K', min: 20000, max: 50000 },
          { label: '$50K+', min: 50000, max: Infinity },
        ];
        const liqBins = liqBands.map(b => bin(b.label));

        const buyRatioBands = [
          { label: '<0.8', min: 0, max: 0.8 },
          { label: '0.8-1.0', min: 0.8, max: 1.0 },
          { label: '1.0-1.3', min: 1.0, max: 1.3 },
          { label: '1.3-2.0', min: 1.3, max: 2.0 },
          { label: '2.0+', min: 2.0, max: Infinity },
        ];
        const buyRatioBins = buyRatioBands.map(b => bin(b.label));

        const buysCountBands = [
          { label: '<20', min: 0, max: 20 },
          { label: '20-50', min: 20, max: 50 },
          { label: '50-100', min: 50, max: 100 },
          { label: '100-200', min: 100, max: 200 },
          { label: '200+', min: 200, max: Infinity },
        ];
        const buysCountBins = buysCountBands.map(b => bin(b.label));

        const ageBands = [
          { label: '<10min', min: 0, max: 10 },
          { label: '10-30min', min: 10, max: 30 },
          { label: '30-60min', min: 30, max: 60 },
          { label: '1-3h', min: 60, max: 180 },
          { label: '3h+', min: 180, max: Infinity },
        ];
        const ageBins = ageBands.map(b => bin(b.label));

        const volMomentumBands = [
          { label: '<10%', min: 0, max: 0.1 },
          { label: '10-25%', min: 0.1, max: 0.25 },
          { label: '25-50%', min: 0.25, max: 0.5 },
          { label: '50-100%', min: 0.5, max: 1.0 },
          { label: '100%+', min: 1.0, max: Infinity },
        ];
        const volMomentumBins = volMomentumBands.map(b => bin(b.label));

        let smartHolderWinRate = { withSmart: { wins: 0, total: 0 }, noSmart: { wins: 0, total: 0 } };

        for (const c of rich) {
          const peak = c.peakMultiplier;
          if (c.entryLiquidity !== undefined) bucket(liqBins, c.entryLiquidity, peak, liqBands);
          if (c.entryBuys5m && c.entrySells5m && c.entrySells5m > 0) {
            bucket(buyRatioBins, c.entryBuys5m / c.entrySells5m, peak, buyRatioBands);
          }
          if (c.entryBuys5m !== undefined) bucket(buysCountBins, c.entryBuys5m, peak, buysCountBands);
          if (c.entryAgeMin !== undefined) bucket(ageBins, c.entryAgeMin, peak, ageBands);
          if (c.entryVolume5m && c.entryVolume1h && c.entryVolume1h > 0) {
            bucket(volMomentumBins, c.entryVolume5m / c.entryVolume1h, peak, volMomentumBands);
          }
          if (c.entrySmartHolders !== undefined) {
            const tgt = c.entrySmartHolders > 0 ? smartHolderWinRate.withSmart : smartHolderWinRate.noSmart;
            tgt.total++;
            if (peak >= 2) tgt.wins++;
          }
        }

        function summarize(bins: Bin[]) {
          return bins.map(b => ({
            label: b.label,
            n: b.total,
            winRate: b.total > 0 ? +(b.winners / b.total * 100).toFixed(1) : 0,
            avgPeak: b.total > 0 ? +(b.samples.reduce((s, x) => s + x, 0) / b.samples.length).toFixed(2) : 0,
            maxPeak: b.total > 0 ? Math.max(...b.samples) : 0,
          }));
        }

        const result = {
          totalCalls: calls.length,
          richCalls: rich.length,
          note: rich.length < 50
            ? 'Need more rich-format calls (>=50) for reliable correlations. Keep the bot running.'
            : 'Sample size sufficient. Look for buckets with significantly higher win rate / avg peak.',
          liquidity: summarize(liqBins),
          buySellRatio5m: summarize(buyRatioBins),
          buysCount5m: summarize(buysCountBins),
          tokenAge: summarize(ageBins),
          volumeMomentum: summarize(volMomentumBins),
          smartHolders: {
            withSmart: { ...smartHolderWinRate.withSmart, winRate: smartHolderWinRate.withSmart.total > 0 ? +(smartHolderWinRate.withSmart.wins / smartHolderWinRate.withSmart.total * 100).toFixed(1) : 0 },
            noSmart: { ...smartHolderWinRate.noSmart, winRate: smartHolderWinRate.noSmart.total > 0 ? +(smartHolderWinRate.noSmart.wins / smartHolderWinRate.noSmart.total * 100).toFixed(1) : 0 },
          },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result, null, 2));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (pathname === '/api/backtest') {
      // Backtest an arbitrary config against every captured real price path
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 32_000) req.destroy(); });
      req.on('end', () => {
        try {
          const cfg = JSON.parse(body) as BacktestCfg;
          const paths = loadPaths();
          const r = backtest(cfg, paths);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...r, pathsAvailable: paths.length }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    } else if (pathname === '/api/presets') {
      const out = Object.entries(STRATEGY_PRESETS).map(([k, v]) => ({ key: k, name: v.name, cfg: v.make() }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ presets: out, paths: loadPaths().length }));
    } else if (req.method === 'POST' && pathname === '/builder') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 64_000) req.destroy(); });
      req.on('end', () => {
        (async () => {
          if (!authOk(req)) {
            res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(settingsLoginHTML());
            return;
          }
          const form = parseFormBody(body);
          try {
            const tps: { mult: number; sellPct: number }[] = [];
            for (let i = 0; i < 6; i++) {
              const m = parseFloat(form[`tp_mult_${i}`]), sp = parseFloat(form[`tp_sell_${i}`]);
              if (Number.isFinite(m) && Number.isFinite(sp) && m > 1 && sp > 0) tps.push({ mult: m, sellPct: sp / 100 });
            }
            const strat = sanitizeStrategy({
              preset: 'custom',
              entryMode: form.entry_mode === 'dip' ? 'dip' : 'instant',
              dipPct: parseFloat(form.dip_pct) / 100,
              dipWindowMin: parseFloat(form.dip_window),
              tps,
              trailingDrop: parseFloat(form.trailing_drop) / 100,
              trailingFrom: form.trailing_from === 'entry' ? 'entry' : 'afterLastTp',
              stopLossPct: 1 - parseFloat(form.stop_loss) / 100,
              breakEvenAfterTp1: form.break_even === '1',
              maxHoldMin: parseFloat(form.max_hold) || 0,
              entryPct: parseFloat(form.entry_pct) / 100,
              minEntrySol: parseFloat(form.min_entry),
              maxEntrySol: parseFloat(form.max_entry) || 0,
              slippageBps: parseFloat(form.slippage) * 100,
              priorityFeeLamports: parseFloat(form.priority_fee) * 1e9,
            });
            const name = (form.name || 'Custom strategy').slice(0, 40);
            if (form.mode === 'live') {
              const task = taskManager.create(name, form.wallet_key, strat);
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(await buildTaskDetailHTML(task, { ok: true, text: `Live task "${task.name}" created. Fund its wallet and it trades the next call.` }));
            } else {
              const task = taskManager.createPaper(name, strat);
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(await buildTasksHTML({ ok: true, text: `Paper strategy "${task.name}" added to the fleet — it starts trading the next call with no money at risk.` }));
            }
          } catch (err: any) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(await buildTasksHTML({ ok: false, text: err.message }));
          }
        })().catch(err => { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Builder error: ' + err.message); });
      });
      return;
    } else if (pathname === '/builder') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildBuilderHTML(url, authOk(req)));
    } else if (pathname === '/coin') {
      // Forensics: how did EVERY strategy handle this one coin? (public — read-only)
      try {
        const mm = url.match(/[?&]mint=([1-9A-HJ-NP-Za-km-z]{32,44})/);
        const mint = mm ? mm[1] : '';
        const results: any[] = [];
        let symbol = mint.slice(0, 6), entryMC = 0, callTime = 0;
        for (const t of taskManager.all()) {
          const pos = taskManager.traderFor(t).getPosition(mint);
          if (!pos) continue;
          symbol = pos.symbol; entryMC = entryMC || pos.entryMC; callTime = callTime || pos.entryTime;
          results.push({
            name: t.name.replace('📄 ', ''), paper: !!t.paper, preset: t.strategy.preset,
            entryPrice: pos.entryPrice, entryTime: pos.entryTime,
            dip: t.strategy.entryMode === 'dip' ? Math.round((t.strategy.dipPct ?? 0) * 100) : 0,
            peak: pos.peakMultiplier, status: pos.status,
            ret: pos.entrySol > 0 ? pos.totalSolReturned / pos.entrySol : 0,
            pnl: pos.status === 'closed' ? (pos.finalPnlSol ?? 0) : null,
            exits: pos.exits.map(e => `${e.label} @ ${e.multiplierAtExit.toFixed(2)}×`).join(' · ') || '—',
          });
        }
        results.sort((a, b) => (b.pnl ?? -99) - (a.pnl ?? -99));
        const closed = results.filter(r => r.pnl !== null);
        const winners = closed.filter(r => r.pnl! > 0).length;
        const rec = (() => { try { return JSON.parse(readFileSync(CONFIG.DATA_FILE, 'utf-8')).find((c: any) => c.mint === mint); } catch { return null; } })();

        const html = settingsShell(`
        <div class="card" style="max-width:none">
          <h3>$${symbol} — how every strategy handled it</h3>
          <div class="kv">Called at <b>${fmtUsd(rec?.entryMC ?? entryMC)}</b> MC${rec ? ` · peaked <b style="color:#10b981">${rec.peakMultiplier.toFixed(2)}×</b> at ${fmtUsd(rec.peakMC)}` : ''}${callTime ? ` · ${new Date(callTime).toISOString().slice(5, 16).replace('T', ' ')}` : ''}</div>
          <div class="kv"><b>${winners}</b> of ${closed.length} closed strategies made money on this coin${results.length - closed.length ? ` · ${results.length - closed.length} still open` : ''}</div>
          <div class="kv mono" style="font-size:11px;color:var(--text3);margin-top:6px">${mint}</div>
          <div style="margin-top:10px;display:flex;gap:14px;align-items:center;flex-wrap:wrap">
            <a href="https://dexscreener.com/solana/${mint}" target="_blank" style="color:#3b82f6;font-size:12px">DexScreener →</a>
            <button id="forget-btn" style="background:transparent;border:1px solid #ef4444;color:#ef4444;border-radius:6px;padding:5px 11px;font-size:12px;cursor:pointer">Remove from stats</button>
            <span id="forget-msg" style="font-size:12px;color:var(--text3)"></span>
          </div>
        </div>
        <script>
        (function () {
          var btn = document.getElementById('forget-btn'), msg = document.getElementById('forget-msg');
          btn.onclick = function () {
            // Irreversible from the UI's point of view, so make the user say it twice.
            // The server still snapshots the files, but a misclick should not need that.
            if (!confirm('Remove $${symbol} from the leaderboard and every strategy stat? Real trade history is kept so P&L still matches the wallet.')) return;
            btn.disabled = true; msg.textContent = 'removing…';
            fetch('/api/forget', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mints: ['${mint}'] }),
            }).then(function (r) { return r.json(); }).then(function (d) {
              if (d.error) { msg.textContent = 'failed: ' + d.error; btn.disabled = false; return; }
              var n = Object.values(d.removed || {}).reduce(function (a, b) { return a + b; }, 0);
              msg.innerHTML = '<span style="color:#10b981">removed ' + n + ' record(s) — backed up</span>';
              btn.textContent = 'Removed';
            }).catch(function (e) { msg.textContent = 'failed: ' + e.message; btn.disabled = false; });
          };
        })();
        </script>
        <div class="card" style="max-width:none">
          <h3>Per-strategy result (${results.length})</h3>
          ${results.length ? `<div style="overflow-x:auto"><table>
            <tr><th>Strategy</th><th>Entry</th><th>Bought at</th><th>Exits</th><th>Peak</th><th>Result</th></tr>
            ${results.map(r => `<tr>
              <td><a href="/strategy?key=${r.preset}" style="color:var(--text);text-decoration:none;border-bottom:1px dotted var(--border2)">${r.name.slice(0, 30)}</a>${r.paper ? '' : ' <span style="color:#10b981;font-size:10px">LIVE</span>'}</td>
              <td style="font-size:11px;color:${r.dip ? '#f59e0b' : 'var(--text2)'}">${r.dip ? `−${r.dip}% dip` : 'instant'}</td>
              <td class="mono" style="font-size:11px">${r.entryPrice.toPrecision(4)}</td>
              <td style="font-size:11px;color:var(--text2)">${r.exits}</td>
              <td class="mono">${r.peak.toFixed(2)}×</td>
              <td class="mono" style="font-weight:700;color:${r.pnl === null ? 'var(--text2)' : r.pnl >= 0 ? '#10b981' : '#ef4444'}">${r.pnl === null ? 'open' : (r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(3) + ' ◎'}</td>
            </tr>`).join('')}</table></div>` : '<p style="font-size:13px;color:var(--text2)">No strategy traded this coin.</p>'}
        </div>`, '/shadow');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Coin page error: ' + err.message);
      }
    } else if (pathname === '/strategy') {
      const canAct = authOk(req);
      try {
        const km = url.match(/[?&]key=([\w-]+)/);
        const key = km ? km[1] : '';
        const task = taskManager.all().find(t => t.paper && t.strategy.preset === key);
        if (!task) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(settingsShell('<div class="card"><h3>Unknown strategy</h3><p style="font-size:13px"><a href="/shadow" style="color:#3b82f6">← back to the fleet</a></p></div>', '/shadow'));
          return;
        }
        const s = task.strategy;
        const positions = taskManager.traderFor(task).getAllPositions()
          .sort((a, b) => b.entryTime - a.entryTime);
        const closed = positions.filter(p => p.status === 'closed');
        const pnl = closed.reduce((sum, p) => sum + (p.finalPnlSol ?? 0), 0);
        const wins = closed.filter(p => (p.finalPnlSol ?? 0) > 0).length;

        const shape = s.maxHoldMin ? `${s.maxHoldMin}-minute clock`
          : s.tps.length ? s.tps.map(t => `${Math.round(t.sellPct * 100)}% at ${t.mult}×`).join(', ')
          : `trailing ${Math.round(s.trailingDrop * 100)}%`;
        const entryDesc = s.entryMode === 'dip'
          ? `wait for a ${Math.round((s.dipPct ?? 0) * 100)}% dip below the call (${s.dipWindowMin}-min window)`
          : 'buy immediately at the call';

        const rows = positions.slice(0, 60).map(p => {
          const ret = p.entrySol > 0 ? p.totalSolReturned / p.entrySol : 0;
          const sells = p.exits.map(e =>
            `<div style="font-size:11px;color:var(--text2)">${e.label} — <b style="color:${e.multiplierAtExit >= 1 ? '#10b981' : '#ef4444'}">${e.multiplierAtExit.toFixed(2)}×</b> → ${e.solReceived.toFixed(3)} ◎</div>`
          ).join('') || '<div style="font-size:11px;color:var(--text3)">— still open —</div>';
          const pl = p.status === 'closed' ? (p.finalPnlSol ?? 0) : null;
          return `<tr>
            <td><b>$${p.symbol.slice(0, 12)}</b><div style="font-size:10px;color:var(--text3)">${new Date(p.entryTime).toISOString().slice(5, 16).replace('T', ' ')}</div></td>
            <td class="mono" style="font-size:11px">${p.entryPrice.toPrecision(4)}<div style="font-size:10px;color:var(--text3)">${fmtUsd(p.entryMC)} MC</div></td>
            <td>${sells}</td>
            <td class="mono">${p.peakMultiplier.toFixed(2)}×</td>
            <td class="mono" style="font-weight:700;color:${pl === null ? 'var(--text2)' : pl >= 0 ? '#10b981' : '#ef4444'}">
              ${pl === null ? `${Math.round(p.remainingPct * 100)}% open` : (pl >= 0 ? '+' : '') + pl.toFixed(3) + ' ◎'}
              ${p.status === 'closed' ? `<div style="font-size:10px;color:var(--text3);font-weight:400">${ret.toFixed(2)}× returned</div>` : ''}
            </td></tr>`;
        }).join('');

        const html = settingsShell(`
        <div class="card" style="max-width:none">
          <h3>${task.name.replace('📄 ', '')}</h3>
          <p style="font-size:13px;color:var(--text2);line-height:1.7;margin-bottom:12px">${STRATEGY_PRESETS[key]?.desc ?? ''}</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:6px">
            <div style="background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Realized PnL</div>
              <div style="font-size:20px;font-weight:700;color:${pnl >= 0 ? '#10b981' : '#ef4444'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} ◎</div></div>
            <div style="background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Win rate</div>
              <div style="font-size:20px;font-weight:700">${closed.length ? Math.round(wins / closed.length * 100) : 0}%<span style="font-size:12px;color:var(--text3)"> (${wins}/${closed.length})</span></div></div>
            <div style="background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Avg per trade</div>
              <div style="font-size:20px;font-weight:700;color:${closed.length && pnl / closed.length >= 0.03 ? '#10b981' : 'var(--text)'}">${closed.length ? (pnl / closed.length >= 0 ? '+' : '') + (pnl / closed.length).toFixed(3) : '—'}</div></div>
            <div style="background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Open now</div>
              <div style="font-size:20px;font-weight:700">${positions.length - closed.length}</div></div>
          </div>
          <div class="kv" style="margin-top:10px"><b>Entry:</b> ${entryDesc}</div>
          <div class="kv"><b>Exit:</b> ${shape}${s.stopLossPct < 0.99 ? ` · stop at −${Math.round((1 - s.stopLossPct) * 100)}%` : ''}${s.breakEvenAfterTp1 ? ' · break-even stop after first TP' : ''}</div>
          <div class="kv"><b>Sizing:</b> ${Math.round(s.entryPct * 100)}% of wallet, min ${s.minEntrySol} ◎${s.maxEntrySol ? `, max ${s.maxEntrySol} ◎` : ''} · ${s.slippageBps / 100}% slippage</div>
        </div>

        ${!canAct ? `<div class="card" style="border-color:#7a5a1a;background:#1f1708">
          <h3 style="color:#ffd75e">🔒 Log in to run this live</h3>
          <p style="font-size:13px;line-height:1.6">Viewing is open; creating a real-money task needs the dashboard password.</p>
          <form method="POST" action="/settings" style="margin-top:8px">
            <input type="password" name="password" placeholder="dashboard password" autocomplete="current-password">
            <button type="submit">Unlock</button>
          </form></div>` : `
        <form method="POST" action="/strategy">
          <input type="hidden" name="key" value="${key}">
          <div class="card" style="border-color:#1e5c3a">
            <h3 style="color:#10b981">▶ Run this strategy with real money</h3>
            <p style="font-size:12px;color:var(--text2);line-height:1.6;margin-bottom:4px">
              Creates a live task with this exact configuration on a wallet you supply. It starts enabled and buys the next qualifying call.
            </p>
            <label>Task name</label>
            <input name="name" maxlength="40" placeholder="${task.name.replace('📄 ', '')} (live)">
            <label>Wallet private key (base58) — use a burner</label>
            <input type="password" name="wallet_key" autocomplete="off" placeholder="only funds in this wallet are at risk">
            <label>Entry size — % of that wallet per trade</label>
            <input type="number" name="entry_pct" min="1" max="100" value="${Math.round(s.entryPct * 100)}">
            <label>Max entry per trade (SOL, 0 = uncapped)</label>
            <input type="number" name="max_entry" step="0.01" min="0" value="${s.maxEntrySol}">
            <button type="submit">Create live task with this strategy</button>
          </div>
        </form>`}

        <div class="card" style="max-width:none">
          <h3>Every trade (${positions.length})</h3>
          ${positions.length ? `<div style="overflow-x:auto"><table>
            <tr><th>Coin / when</th><th>Bought at</th><th>Sold at</th><th>Peak</th><th>Result</th></tr>${rows}</table></div>`
            : '<p style="font-size:13px;color:var(--text2)">No trades yet.</p>'}
        </div>`, '/shadow');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Strategy page error: ' + err.message);
      }
    } else if (pathname === '/live') {
      (async () => {
        const real = taskManager.all().filter(t => !t.paper);
        const bals = await Promise.all(real.map(t => getSolBalance(taskManager.keypairFor(t)).catch(() => null)));
        let allPos: { task: TradeTask; pos: RealPosition }[] = [];
        for (const t of real) for (const p of taskManager.traderFor(t).getAllPositions()) allPos.push({ task: t, pos: p });
        allPos.sort((a, b) => b.pos.entryTime - a.pos.entryTime);
        const closed = allPos.filter(x => x.pos.status === 'closed');
        const openP = allPos.filter(x => x.pos.status === 'open');
        const realized = closed.reduce((s, x) => s + (x.pos.finalPnlSol ?? 0), 0);
        const wins = closed.filter(x => (x.pos.finalPnlSol ?? 0) > 0).length;

        const row = (x: { task: TradeTask; pos: RealPosition }) => {
          const p = x.pos;
          const pl = p.status === 'closed' ? (p.finalPnlSol ?? 0) : null;
          const sells = p.exits.map(e => `${e.label} @ ${e.multiplierAtExit.toFixed(2)}× → ${e.solReceived.toFixed(4)} ◎`).join('<br>') || '—';
          return `<tr>
            <td><b>$${p.symbol.slice(0, 12)}</b><div style="font-size:10px;color:var(--text3)">${new Date(p.entryTime).toISOString().slice(5, 16).replace('T', ' ')}</div></td>
            <td style="font-size:11px;color:var(--text2)">${x.task.name.slice(0, 20)}</td>
            <td class="mono">${p.entrySol} ◎<div style="font-size:10px;color:var(--text3)">${fmtUsd(p.entryMC)} MC</div></td>
            <td style="font-size:11px;color:var(--text2)">${sells}</td>
            <td class="mono">${p.peakMultiplier.toFixed(2)}×</td>
            <td class="mono" style="font-weight:700;color:${pl === null ? 'var(--text2)' : pl >= 0 ? '#10b981' : '#ef4444'}">
              ${pl === null ? Math.round(p.remainingPct * 100) + '% open' : (pl >= 0 ? '+' : '') + pl.toFixed(4) + ' ◎'}</td>
            <td><a href="/coin?mint=${p.mint}" style="color:#3b82f6;font-size:11px">detail</a></td></tr>`;
        };

        const html = settingsShell(`
        <div class="card" style="max-width:none;border-color:#1e5c3a">
          <h3 style="color:#10b981">◆ Live trading — real money only</h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:8px">
            <div style="background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:11px 13px">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Realized PnL</div>
              <div style="font-size:22px;font-weight:700;color:${realized >= 0 ? '#10b981' : '#ef4444'}">${realized >= 0 ? '+' : ''}${realized.toFixed(4)} ◎</div></div>
            <div style="background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:11px 13px">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Closed trades</div>
              <div style="font-size:22px;font-weight:700">${closed.length}<span style="font-size:12px;color:var(--text3)"> · ${closed.length ? Math.round(wins / closed.length * 100) : 0}% win</span></div></div>
            <div style="background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:11px 13px">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Open now</div>
              <div style="font-size:22px;font-weight:700;color:${openP.length ? '#10b981' : 'var(--text)'}">${openP.length}</div></div>
            <div style="background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:11px 13px">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Live wallets</div>
              <div style="font-size:22px;font-weight:700">${real.length}<span style="font-size:12px;color:var(--text3)"> · ${bals.filter(b => b !== null).reduce((s, b) => s + (b || 0), 0).toFixed(3)} ◎</span></div></div>
          </div>
        </div>

        <div class="card" style="max-width:none">
          <h3>Live tasks (${real.length})</h3>
          ${real.length ? `<div style="overflow-x:auto"><table>
            <tr><th>Task</th><th>Wallet</th><th>Balance</th><th>Strategy</th><th>Buys</th><th></th></tr>
            ${real.map((t, i) => {
              const addr = taskManager.keypairFor(t).publicKey.toBase58();
              return `<tr><td><span style="color:${t.enabled ? '#10b981' : '#4a5570'}">●</span> <a href="/task?id=${t.id}" style="color:var(--text);font-weight:700">${t.name}</a></td>
                <td class="mono" style="font-size:11px;color:var(--text2)">${addr.slice(0, 6)}…${addr.slice(-4)}</td>
                <td class="mono">${bals[i] === null ? '—' : bals[i]!.toFixed(4) + ' ◎'}</td>
                <td style="font-size:11px;color:var(--text2)">${describeStrategy(t.strategy)}</td>
                <td style="font-size:11px;color:var(--text2)">${taskManager.sourcesFor(t).map(sourceLabel).join(' + ')}</td>
                <td><a href="/task?id=${t.id}" style="color:#3b82f6;font-size:11px">manage</a></td></tr>`;
            }).join('')}</table></div>`
            : `<p style="font-size:13px;color:var(--text2)">No live tasks yet. Pick a strategy on the <a href="/shadow" style="color:#3b82f6">shadow fleet</a> and hit <b>Go live</b> — or create one from <a href="/tasks" style="color:#3b82f6">Tasks</a>.</p>`}
        </div>

        <div class="card" style="max-width:none">
          <h3>Open positions (${openP.length})</h3>
          ${openP.length ? `<div style="overflow-x:auto"><table><tr><th>Coin</th><th>Task</th><th>Size</th><th>Exits so far</th><th>Peak</th><th>State</th><th></th></tr>${openP.map(row).join('')}</table></div>`
            : '<p style="font-size:13px;color:var(--text2)">Nothing open right now.</p>'}
        </div>

        <div class="card" style="max-width:none">
          <h3>Closed trades (${closed.length})</h3>
          ${closed.length ? `<div style="overflow-x:auto"><table><tr><th>Coin</th><th>Task</th><th>Size</th><th>Sold at</th><th>Peak</th><th>Result</th><th></th></tr>${closed.slice(0, 80).map(row).join('')}</table></div>`
            : '<p style="font-size:13px;color:var(--text2)">No completed live trades yet.</p>'}
        </div>`, '/live');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      })().catch((err: any) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Live page error: ' + err.message);
      });
    } else if (pathname === '/sweep') {
      // The controlled experiment, made visible.
      //
      // A leaderboard cannot answer "should we wait 5 minutes or 30" — the top row
      // is whichever strategy got lucky. GRID6 holds the exit identical and varies
      // only depth and window, so averaging every strategy that shares a window
      // cancels the exit shape out and leaves the window's own effect.
      try {
        const hm = url.match(/[?&]hours=(\d+|all)/);
        const hours = hm ? hm[1] : 'all';
        const cut = hours === 'all' ? 0 : Date.now() - parseInt(hours) * 3600_000;

        const sweep = taskManager.all().filter(t => t.paper && t.strategy.preset.startsWith('sw')).map(t => {
          const ps = taskManager.traderFor(t).getAllPositions();
          const closed = ps.filter(p => p.status === 'closed' && (p.closedTime ?? 0) >= cut);
          const pnl = closed.reduce((a, p) => a + (p.finalPnlSol ?? 0), 0);
          return {
            dip: Math.round((t.strategy.dipPct ?? 0) * 100),
            win: t.strategy.dipWindowMin ?? 30,
            shape: t.strategy.tps.length ? 'ladder' : 'trail',
            trades: closed.length,
            wins: closed.filter(p => (p.finalPnlSol ?? 0) > 0).length,
            pnl,
            skipped: ps.length === 0,
          };
        });

        const WINDOWS = [3, 5, 10, 15, 20, 30, 45];
        const DEPTHS = [10, 15, 20, 25];
        const cell = (d: number, w: number) => {
          const rs = sweep.filter(r => r.dip === d && r.win === w);
          const trades = rs.reduce((a, r) => a + r.trades, 0);
          const pnl = rs.reduce((a, r) => a + r.pnl, 0);
          const wins = rs.reduce((a, r) => a + r.wins, 0);
          return { trades, pnl, avg: trades ? pnl / trades : 0, winPct: trades ? Math.round(wins / trades * 100) : 0 };
        };
        const byWindow = WINDOWS.map(w => {
          const rs = sweep.filter(r => r.win === w);
          const trades = rs.reduce((a, r) => a + r.trades, 0);
          const pnl = rs.reduce((a, r) => a + r.pnl, 0);
          const wins = rs.reduce((a, r) => a + r.wins, 0);
          return { w, trades, pnl, avg: trades ? pnl / trades : 0, winPct: trades ? Math.round(wins / trades * 100) : 0 };
        });
        const totalTrades = byWindow.reduce((a, r) => a + r.trades, 0);
        const ranked = [...byWindow].filter(r => r.trades > 0).sort((a, b) => b.avg - a.avg);
        const short = byWindow.filter(r => r.w <= 10).reduce((a, r) => ({ t: a.t + r.trades, p: a.p + r.pnl }), { t: 0, p: 0 });
        const long = byWindow.filter(r => r.w >= 20).reduce((a, r) => ({ t: a.t + r.trades, p: a.p + r.pnl }), { t: 0, p: 0 });

        const col = (v: number) => v > 0.02 ? '#10b981' : v < -0.02 ? '#ef4444' : 'var(--text2)';
        const heat = (v: number, max: number) => {
          if (!max) return 'transparent';
          const t = Math.max(-1, Math.min(1, v / max));
          return t >= 0 ? `rgba(16,185,129,${(t * 0.28).toFixed(3)})` : `rgba(239,68,68,${(-t * 0.28).toFixed(3)})`;
        };
        const maxAbs = Math.max(0.0001, ...DEPTHS.flatMap(d => WINDOWS.map(w => Math.abs(cell(d, w).avg))));

        const verdict = totalTrades < 20
          ? `<b style="color:var(--text2)">Not enough data yet</b> — ${totalTrades} trades across the sweep. It needs a few hours of calls before any of this means anything.`
          : short.t && long.t
            ? `Short windows (≤10m) average <b style="color:${col(short.p / short.t)}">${(short.p / short.t >= 0 ? '+' : '')}${(short.p / short.t).toFixed(3)}</b> per trade over ${short.t} trades. Long windows (≥20m) average <b style="color:${col(long.p / long.t)}">${(long.p / long.t >= 0 ? '+' : '')}${(long.p / long.t).toFixed(3)}</b> over ${long.t}. ${short.p / short.t > long.p / long.t ? 'Short is ahead — consistent with a slow dip being a downtrend rather than an entry.' : 'Long is ahead so far, which contradicts the short-window thesis. Worth more data before acting.'}`
            : 'Waiting on fills in both groups before the comparison means anything.';

        const html = settingsShell(`
        <div class="card" style="max-width:none">
          <h3>🔬 Dip-window sweep</h3>
          <p style="font-size:12px;color:var(--text2);line-height:1.6;margin-bottom:4px">
            Every strategy here runs an <b>identical exit</b> — only the dip depth and how long it waits differ.
            That is what makes this readable: averaging across a whole row or column cancels the exit shape out,
            so what is left is the effect of the window itself. A leaderboard cannot tell you this, because its
            top row is whichever single strategy got lucky.
          </p>
          <div style="display:flex;gap:6px;margin:10px 0">
            ${['6', '12', '24', '48', 'all'].map(h => `<a href="/sweep?hours=${h}" style="padding:4px 10px;border-radius:6px;font-size:12px;text-decoration:none;border:1px solid ${h === hours ? 'var(--border2)' : 'var(--border)'};background:${h === hours ? 'var(--bg3)' : 'transparent'};color:${h === hours ? 'var(--text)' : 'var(--text2)'}">${h === 'all' ? 'All time' : h + 'h'}</a>`).join('')}
          </div>
          <div style="background:var(--bg1);border:1px solid var(--border);border-left:3px solid #3b82f6;border-radius:8px;padding:12px;font-size:13px;line-height:1.7">${verdict}</div>
        </div>

        <div class="card" style="max-width:none">
          <h3>Average PnL per trade — depth × window</h3>
          <div style="overflow-x:auto"><table style="width:100%">
            <tr><th style="text-align:left">Dip depth</th>${WINDOWS.map(w => `<th style="text-align:center">${w}m</th>`).join('')}</tr>
            ${DEPTHS.map(d => `<tr>
              <td style="font-weight:700;color:#f59e0b;white-space:nowrap">−${d}%</td>
              ${WINDOWS.map(w => {
                const c = cell(d, w);
                return `<td style="text-align:center;background:${heat(c.avg, maxAbs)};border-radius:4px">
                  ${c.trades ? `<div class="mono" style="color:${col(c.avg)};font-weight:700">${c.avg >= 0 ? '+' : ''}${c.avg.toFixed(3)}</div>
                  <div style="font-size:10px;color:var(--text3)">${c.trades} tr · ${c.winPct}%</div>` : '<span style="color:var(--text3);font-size:11px">—</span>'}
                </td>`;
              }).join('')}
            </tr>`).join('')}
          </table></div>
          <p style="font-size:11px;color:var(--text3);margin-top:10px">
            Green is profitable, red is not, intensity scales with size. A cell showing “—” has had no fills —
            a deep dip in a short window often never triggers, which is itself a result: the strategy simply does not trade.
          </p>
        </div>

        <div class="card" style="max-width:none">
          <h3>Window ranking — every depth pooled</h3>
          <div style="overflow-x:auto"><table style="width:100%">
            <tr><th>Window</th><th>Trades</th><th>Win rate</th><th>Avg/trade</th><th>Total PnL</th></tr>
            ${ranked.length ? ranked.map(r => `<tr>
              <td style="font-weight:700">${r.w} min</td>
              <td class="mono">${r.trades}</td>
              <td class="mono">${r.winPct}%</td>
              <td class="mono" style="color:${col(r.avg)};font-weight:700">${r.avg >= 0 ? '+' : ''}${r.avg.toFixed(4)}</td>
              <td class="mono" style="color:${col(r.pnl)}">${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)} ◎</td>
            </tr>`).join('') : '<tr><td colspan="5" style="color:var(--text3);font-size:12px">No closed trades in this window yet.</td></tr>'}
          </table></div>
          <p style="font-size:11px;color:var(--text3);margin-top:10px">
            Pooling every depth is the point — one strategy topping a leaderboard is luck, but a whole window
            beating the others across four depths and two exit shapes is a pattern.
          </p>
        </div>`, '/sweep');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html.replace('<title>PumpClaw Settings</title>', '<title>PumpClaw · Dip-window sweep</title>'));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<pre>Sweep error: ${err.message}</pre>`);
      }
    } else if (pathname === '/shadow') {
      try {
        // Rolling window — default 24h. Old trades ran under different filter settings,
        // so mixing them makes strategies incomparable. ?hours=all shows everything.
        const hm = url.match(/[?&]hours=(\d+|all)/);
        const hours = hm ? hm[1] : '24';
        const cut = hours === 'all' ? 0 : Date.now() - parseInt(hours) * 3600_000;
        const rows = taskManager.all().filter(t => t.paper).map(t => {
          const ps = taskManager.traderFor(t).getAllPositions();
          const closed = ps.filter(p => p.status === 'closed' && (p.closedTime ?? 0) >= cut);
          const pnl = closed.reduce((s, p) => s + (p.finalPnlSol ?? 0), 0);
          const wins = closed.filter(p => (p.finalPnlSol ?? 0) > 0).length;
          const rets = closed.map(p => (p.totalSolReturned / (p.entrySol || 1)));
          const best = rets.length ? Math.max(...rets) : 0;
          const s = t.strategy;
          const stopPct = Math.round((1 - s.stopLossPct) * 100);
          const trailPct = s.trailingDrop < 0.89 ? Math.round(s.trailingDrop * 100) : 0;
          return {
            key: s.preset,
            name: t.name.replace('📄 ', ''),
            dipPct: s.entryMode === 'dip' ? Math.round((s.dipPct ?? 0) * 100) : 0,
            winMin: s.entryMode === 'dip' ? (s.dipWindowMin ?? 30) : 0,
            targets: s.tps.map(x => x.mult),
            stopPct: stopPct >= 95 ? null : stopPct,
            trailPct,
            holdMin: s.maxHoldMin ?? 0,
            entry: s.entryMode === 'dip' ? `dip −${Math.round((s.dipPct ?? 0) * 100)}%` : 'instant',
            shape: s.maxHoldMin ? `${s.maxHoldMin}m clock` : s.tps.length ? s.tps.map(x => `${Math.round(x.sellPct * 100)}%@${x.mult}x`).join(' ') : `trail ${Math.round(s.trailingDrop * 100)}%`,
            trades: closed.length, open: ps.length - closed.length, wins,
            winPct: closed.length ? Math.round(wins / closed.length * 100) : 0,
            pnl: +pnl.toFixed(3),
            avg: closed.length ? +(pnl / closed.length).toFixed(4) : 0,
            best: +best.toFixed(2),
          };
        }).sort((a, b) => b.avg - a.avg);

        const showAll = /[?&]all=1/.test(url);
        const enough = rows.filter(r => r.trades >= 8);
        const thin = rows.filter(r => r.trades < 8);
        const fmt = (r: any, rank: number) => `<tr>
          <td class="mono" style="color:var(--text3)">${rank}</td>
          <td><a href="/strategy?key=${r.key}" style="color:var(--text);font-weight:700;text-decoration:none;border-bottom:1px dotted var(--border2)">${r.name}</a></td>
          <td style="color:${r.dipPct ? '#f59e0b' : 'var(--text2)'};font-size:12px;white-space:nowrap">${r.dipPct ? `−${r.dipPct}% dip` : 'instant'}</td>
          <td style="font-size:12px;color:var(--text);white-space:nowrap">${r.targets.length ? r.targets.map((m: number) => m + '×').join('/') : r.holdMin ? `${r.holdMin}m clock` : `trail ${r.trailPct}%`}</td>
          <td style="font-size:12px;white-space:nowrap;color:${r.stopPct === null ? 'var(--text3)' : r.stopPct <= 20 ? '#ef4444' : r.stopPct <= 40 ? '#f59e0b' : 'var(--text2)'}">${r.stopPct === null ? 'none' : '−' + r.stopPct + '%'}</td>
          <td style="font-size:11px;color:var(--text3);white-space:nowrap">${r.trailPct ? `trail ${r.trailPct}%` : ''}${r.holdMin && r.targets.length ? ` ${r.holdMin}m cap` : ''}</td>
          <td class="mono">${r.trades}${r.open ? ` <span style="color:#10b981">+${r.open}</span>` : ''}</td>
          <td class="mono">${r.winPct}%</td>
          <td class="mono" style="color:${r.avg >= 0 ? '#10b981' : '#ef4444'};font-weight:700">${r.avg >= 0 ? '+' : ''}${r.avg.toFixed(3)}</td>
          <td class="mono" style="color:${r.pnl >= 0 ? '#10b981' : '#ef4444'}">${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}</td>
          <td class="mono" style="color:var(--text2)">${r.best.toFixed(1)}x</td>
        </tr>`;
        const head = `<tr><th>#</th><th>Strategy</th><th>Entry</th><th>Target</th><th>Stop</th><th>Extra</th><th>Trades</th><th>Win</th><th>Avg/trade</th><th>Total</th><th>Best</th></tr>`;

        const winners = enough.filter(r => r.avg > 0.03).slice(0, 5);
        const dipRows = rows.filter(r => r.entry !== 'instant' && r.trades > 0);
        const instRows = rows.filter(r => r.entry === 'instant' && r.trades > 0);
        const grpAvg = (rs: any[]) => {
          const n = rs.reduce((s, r) => s + r.trades, 0);
          return n ? rs.reduce((s, r) => s + r.pnl, 0) / n : 0;
        };
        const html = settingsShell(`
        <div class="card" style="max-width:none;border-color:#1e5c3a;background:linear-gradient(180deg,#0d1f16,var(--bg2))">
          <h3 style="color:#9be826">🏆 What's working ${hours === 'all' ? '(all time)' : `(last ${hours}h)`}</h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-bottom:12px">
            ${winners.length ? winners.map(w => `<div style="background:var(--bg1);border:1px solid #1e5c3a;border-radius:8px;padding:10px 12px">
              <div style="font-size:12px;font-weight:700"><a href="/strategy?key=${w.key}" style="color:var(--text);text-decoration:none">${w.name} →</a></div>
              <div style="font-size:22px;font-weight:700;color:#10b981">${w.avg >= 0 ? '+' : ''}${w.avg.toFixed(3)}<span style="font-size:11px;color:var(--text3);font-weight:400"> /trade</span></div>
              <div style="font-size:11px;color:var(--text2)">${w.trades} trades · ${w.winPct}% win · ${w.pnl >= 0 ? '+' : ''}${w.pnl.toFixed(1)} SOL</div>
            </div>`).join('') : '<span style="color:var(--text3)">No strategy is clearly profitable yet.</span>'}
          </div>
          <div style="display:flex;gap:20px;font-size:13px;flex-wrap:wrap">
            <span>Dip entry: <b style="color:${grpAvg(dipRows) >= 0 ? '#10b981' : '#ef4444'}">${grpAvg(dipRows) >= 0 ? '+' : ''}${grpAvg(dipRows).toFixed(3)}</b>/trade
              <span style="color:var(--text3)">(${dipRows.reduce((s, r) => s + r.trades, 0)} trades)</span></span>
            <span>Instant entry: <b style="color:${grpAvg(instRows) >= 0 ? '#10b981' : '#ef4444'}">${grpAvg(instRows) >= 0 ? '+' : ''}${grpAvg(instRows).toFixed(3)}</b>/trade
              <span style="color:var(--text3)">(${instRows.reduce((s, r) => s + r.trades, 0)} trades)</span></span>
            <span style="color:var(--text2)">Break-even after real fees ≈ <b>+0.03</b>/trade</span>
          </div>
        </div>
        <div class="card" style="max-width:none">
          <h3>📄 Shadow fleet — ${rows.length} strategies · ${hours === 'all' ? 'all time' : `last ${hours}h`} · 1 SOL/trade</h3>
          <div style="display:flex;gap:6px;margin-bottom:10px">
            ${['6', '12', '24', '48', 'all'].map(h => `<a href="/shadow?hours=${h}" style="padding:4px 10px;border-radius:6px;font-size:12px;text-decoration:none;border:1px solid ${h === hours ? 'var(--border2)' : 'var(--border)'};background:${h === hours ? 'var(--bg3)' : 'transparent'};color:${h === hours ? 'var(--text)' : 'var(--text2)'}">${h === 'all' ? 'All time' : h + 'h'}</a>`).join('')}
          </div>
          <p style="font-size:12px;color:var(--text2);line-height:1.6">
            Ranked by average PnL per closed trade. <b>Strategies with fewer than 8 trades are listed separately</b> — a
            small sample tells you nothing. Even above that bar, treat a one-day leader with suspicion: with
            <b>${rows.length}</b> strategies running, the luckiest one is expected to reach a t-statistic of about
            <b>${Math.sqrt(2 * Math.log(Math.max(2, rows.length))).toFixed(2)}</b> with no real edge at all. Below that bar
            you are reading noise. What matters is a strategy that stays near the top across several days <i>and</i> has
            enough trades to mean something — or better, a whole <a href="/sweep" style="color:#3b82f6">family</a> that wins together.
          </p>
          <div style="overflow-x:auto"><table>${head}${enough.slice(0, showAll ? enough.length : 120).map((r, i) => fmt(r, i + 1)).join('')}</table></div>
          ${!showAll && enough.length > 120 ? `<div style="margin-top:10px;font-size:12px;color:var(--text2)">
            Showing the top 120 of ${enough.length}. <a href="/shadow?hours=${hours}&all=1" style="color:#3b82f6">Show all →</a>
            <span style="color:var(--text3)"> · the tail is rarely worth the page weight, and everything below rank 120 is noise anyway.</span>
          </div>` : ''}
        </div>
        ${thin.length ? `<div class="card" style="max-width:none">
          <h3>Too few trades to judge (${thin.length})</h3>
          <div style="overflow-x:auto"><table>${head}${thin.slice(0, showAll ? thin.length : 60).map((r, i) => fmt(r, i + 1)).join('')}</table></div>
          ${!showAll && thin.length > 60 ? `<div style="margin-top:10px;font-size:12px;color:var(--text3)">Showing 60 of ${thin.length}. <a href="/shadow?hours=${hours}&all=1" style="color:#3b82f6">Show all →</a></div>` : ''}
        </div>` : ''}
        <div class="note" style="font-size:11px;color:var(--text3);margin-top:14px;line-height:1.6">
          Paper fills at observed prices with a 2% haircut; real fills also pay ~2.5% protocol fee round-trip, so a
          strategy needs roughly +3% per trade before it earns anything real. Dip-entry strategies only trade when the
          pullback actually happens, so their trade counts run lower.
        </div>`, '/shadow');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html.replace('<title>PumpClaw Settings</title>', '<title>PumpClaw Shadow Fleet</title>'));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Shadow page error: ' + err.message);
      }
    } else if (pathname === '/api/verify') {
      // On-demand audit: every real position checked against the chain
      (async () => {
        const out: any[] = [];
        for (const t of taskManager.all().filter(x => !x.paper)) {
          const kp = taskManager.keypairFor(t);
          const trader = taskManager.traderFor(t);
          const sol = await getSolBalance(kp).catch(() => null);
          const holdings = await getTokenHoldings(kp).catch(() => []);
          const open = trader.getOpenPositions();
          const checks: any[] = [];
          for (const p of open) {
            const h = holdings.find(x => x.mint === p.mint);
            const onChain = h ? h.amountRaw : 0;
            const drift = p.tokensRemaining > 0 ? Math.abs(onChain / p.tokensRemaining - 1) : (onChain > 0 ? 1 : 0);
            checks.push({
              symbol: p.symbol, bookTokens: p.tokensRemaining, chainTokens: onChain,
              driftPct: +(drift * 100).toFixed(1),
              ok: drift < 0.03,
              entryMC: Math.round(p.entryMC),
              stopAt: p.entryPrice > 0 ? +(Math.max(p.stopLossPrice, p.trailingActive ? p.trailingStopPrice : 0) / p.entryPrice).toFixed(3) : null,
            });
          }
          const trackedMints = new Set(open.map(p => p.mint));
          const orphans = holdings.filter(h => !trackedMints.has(h.mint)).map(h => ({ mint: h.mint, amount: h.uiAmount }));
          out.push({ task: t.name, wallet: kp.publicKey.toBase58(), sol, openPositions: open.length, checks, orphans });
        }
        const allOk = out.every(t => t.checks.every((c: any) => c.ok) && t.orphans.length === 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ verdict: allOk ? 'BOOK MATCHES CHAIN' : 'MISMATCH — see details', tasks: out }, null, 2));
      })().catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    } else if (pathname === '/api/health') {
      // Data-integrity view: what's on disk, when it last changed, and whether the
      // data directory is a persistent volume (survives deploys) or ephemeral.
      try {
        const files = ['tasks.json', 'calls.json', 'sources.json', 'settings.json',
          'source-cursors.json', 'pending-entries.json', 'lb-timestamps.json'];
        const info = files.map(f => {
          const fp = join(CONFIG.DATA_DIR, f);
          try {
            const st = statSync(fp);
            return { file: f, bytes: st.size, modifiedMinAgo: Math.round((Date.now() - st.mtimeMs) / 60000) };
          } catch { return { file: f, bytes: 0, modifiedMinAgo: null, missing: true }; }
        });
        let positionFiles = 0, candleFiles = 0;
        try { positionFiles = readdirSync(CONFIG.DATA_DIR).filter(f => f.startsWith('positions')).length; } catch {}
        try { candleFiles = readdirSync(join(CONFIG.DATA_DIR, 'candles')).length; } catch {}
        const real = taskManager.all().filter(t => !t.paper);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          dataDir: CONFIG.DATA_DIR,
          persistentVolume: !CONFIG.DATA_DIR.includes('/app/dist') && CONFIG.DATA_DIR !== './data',
          uptimeMin: Math.round(process.uptime() / 60),
          tasks: { total: taskManager.all().length, real: real.length, paper: taskManager.all().length - real.length },
          liveTasks: real.map(t => ({
            name: t.name, enabled: t.enabled,
            wallet: taskManager.keypairFor(t).publicKey.toBase58(),
            hasWebhook: !!t.webhook,
            webhookTail: t.webhook ? '…' + t.webhook.slice(-14) : null,
            entryMode: t.strategy.entryMode === 'dip'
              ? `waits for a ${Math.round((t.strategy.dipPct ?? 0) * 100)}% dip (${t.strategy.dipWindowMin}min window)`
              : 'buys immediately at the call',
            strategy: describeStrategy(t.strategy),
            pendingOrders: taskManager.pendingEntries().filter(p => p.taskId === t.id)
              .map(p => ({ symbol: p.symbol, target: p.target, callPrice: p.callPrice,
                expiresInMin: Math.max(0, Math.round((p.expiresAt - Date.now()) / 60000)) })),
          })),
          positionFiles, candleFiles,
          files: info,
        }, null, 2));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (pathname === '/api/export') {
      // Full snapshot download — a manual backup you can keep off-platform
      if (!authOk(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'auth required' })); return; }
      try {
        const bundle: Record<string, any> = { exportedAt: new Date().toISOString() };
        for (const f of readdirSync(CONFIG.DATA_DIR)) {
          if (!f.endsWith('.json')) continue;
          try { bundle[f] = JSON.parse(readFileSync(join(CONFIG.DATA_DIR, f), 'utf-8')); } catch {}
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="pumpclaw-backup-${Date.now()}.json"`,
        });
        res.end(JSON.stringify(bundle));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (pathname === '/api/feed') {
      // Recent buy/sell events across every task — the live activity stream
      try {
        const ev: any[] = [];
        for (const t of taskManager.all()) {
          const paper = !!t.paper;
          for (const p of taskManager.traderFor(t).getAllPositions()) {
            ev.push({ ts: p.entryTime, task: t.name.replace('📄 ', ''), paper, kind: 'buy',
              symbol: p.symbol, mint: p.mint, sol: p.entrySol, mc: p.entryMC, detail: 'entry' });
            for (const x of p.exits) {
              ev.push({ ts: x.timestamp, task: t.name.replace('📄 ', ''), paper, kind: 'sell',
                symbol: p.symbol, mint: p.mint, sol: x.solReceived, mult: x.multiplierAtExit, detail: x.label });
            }
          }
        }
        ev.sort((a, b) => b.ts - a.ts);
        // Real money never gets buried by the paper fleet: real events keep their
        // own retention, and ?real=1 returns only them.
        const realOnly = /[?&]real=1/.test(url);
        const real = ev.filter(e => !e.paper);
        const paper = ev.filter(e => e.paper);
        res.end(JSON.stringify({
          // Live money is always listed first, never mixed into the paper stream.
          events: realOnly ? real.slice(0, 200) : [...real.slice(0, 80), ...paper.slice(0, 40)],
          realCount: real.length,
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (pathname === '/api/equity') {
      // Cumulative fleet PnL over time + per-strategy curves for the leaders
      try {
        const hm = url.match(/[?&]hours=(\d+)/);
        const hours = hm ? parseInt(hm[1]) : 24;
        const cut = Date.now() - hours * 3600_000;
        const byStrat: Record<string, { ts: number; pnl: number }[]> = {};
        const fleet: { ts: number; pnl: number }[] = [];
        for (const t of taskManager.all().filter(x => x.paper)) {
          const name = t.name.replace('📄 ', '');
          for (const p of taskManager.traderFor(t).getAllPositions()) {
            if (p.status !== 'closed' || (p.closedTime ?? 0) < cut) continue;
            const pt = { ts: p.closedTime!, pnl: p.finalPnlSol ?? 0 };
            (byStrat[name] ??= []).push(pt);
            fleet.push(pt);
          }
        }
        const curve = (pts: { ts: number; pnl: number }[]) => {
          pts.sort((a, b) => a.ts - b.ts);
          let c = 0;
          return pts.map(p => ({ ts: p.ts, v: +(c += p.pnl).toFixed(3) }));
        };
        const tops = Object.entries(byStrat)
          .map(([k, v]) => ({ k, n: v.length, tot: v.reduce((s, x) => s + x.pnl, 0) }))
          .filter(x => x.n >= 5).sort((a, b) => b.tot / b.n - a.tot / a.n).slice(0, 3);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          fleet: curve(fleet),
          leaders: tops.map(t => ({ name: t.k, curve: curve(byStrat[t.k]) })),
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (pathname === '/api/shadow') {
      // Read-only: realized performance of each shadow (paper) task on live prices.
      // This is the honest strategy comparison — same calls, same engine, real paths.
      try {
        // Defaults to the last 24h — trades older than that ran under different
        // filter settings and market conditions, so mixing them is misleading.
        // ?hours=all for full history, ?hours=N for any other window.
        const hoursM = url.match(/[?&]hours=(\d+|all)/);
        const hv = hoursM ? hoursM[1] : '24';
        const cutoff = hv === 'all' ? 0 : Date.now() - parseInt(hv) * 3600_000;
        const rows = taskManager.all().filter(t => t.paper).map(t => {
          const positions = taskManager.traderFor(t).getAllPositions();
          const closed = positions.filter(p => p.status === 'closed' && (p.closedTime ?? 0) >= cutoff);
          // ── robustness stats: with 100+ strategies running, the leader is probably
          // luck. These separate "real edge" from "rode 2 lucky trades".
          const rs = closed.map(p => p.finalPnlSol ?? 0).sort((a, b) => b - a);
          const n = rs.length;
          const mean = n ? rs.reduce((s, x) => s + x, 0) / n : 0;
          const sd = n > 1 ? Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
          const stderr = n > 1 ? sd / Math.sqrt(n) : 0;
          const tStat = stderr > 0 ? mean / stderr : 0;
          const robust = n > 3 ? rs.slice(3).reduce((s, x) => s + x, 0) / (n - 3) : 0;  // drop best 3
          const median = n ? rs[Math.floor(n / 2)] : 0;
          const topShare = n && mean > 0 ? Math.max(0, rs.slice(0, 3).reduce((s, x) => s + x, 0)) / Math.max(1e-9, rs.reduce((s, x) => s + x, 0)) : 0;
          const verdict = n < 15 ? 'thin'
            : tStat > 2 && robust > 0.03 ? 'strong'
            : tStat > 1.5 && robust > 0 ? 'promising'
            : mean > 0 && robust <= 0 ? 'tail-driven'
            : mean > 0 ? 'weak'
            : 'losing';
          const pnl = closed.reduce((s, p) => s + (p.finalPnlSol ?? 0), 0);
          const wins = closed.filter(p => (p.finalPnlSol ?? 0) > 0).length;
          const best = closed.reduce((mx, p) => Math.max(mx, p.peakMultiplier ?? 1), 0);
          const _s = t.strategy;
          const _stop = Math.round((1 - _s.stopLossPct) * 100);
          return {
            key: t.strategy.preset,
            strategy: t.name.replace('📄 ', ''),
            dipPct: _s.entryMode === 'dip' ? Math.round((_s.dipPct ?? 0) * 100) : 0,
            targets: _s.tps.map(x => x.mult),
            stopPct: _stop >= 95 ? null : _stop,
            trailPct: _s.trailingDrop < 0.89 ? Math.round(_s.trailingDrop * 100) : 0,
            holdMin: _s.maxHoldMin ?? 0,
            trades: closed.length,
            open: positions.filter(p => p.status === 'open').length,
            wins,
            winPct: closed.length ? Math.round(wins / closed.length * 100) : 0,
            pnlSol: +pnl.toFixed(3),
            avgPerTrade: closed.length ? +(pnl / closed.length).toFixed(4) : 0,
            bestPeak: +best.toFixed(2),
            // robustness
            robustAvg: +robust.toFixed(4),
            median: +median.toFixed(4),
            tStat: +tStat.toFixed(2),
            topShare: +topShare.toFixed(2),
            verdict,
          };
        }).sort((a, b) => b.pnlSol - a.pnlSol);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          window: hv === 'all' ? 'all time' : `last ${hv}h`,
          note: '1 SOL per trade, 2% fill haircut, live prices',
          strategies: rows,
        }, null, 2));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (pathname === '/api/sources') {
      import('./index.js').then(idx => {
        const events = [...(idx.sourceEvents ?? [])].sort((a: any, b: any) => b.ts - a.ts);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          sources: sourceRegistry.all().map(s => ({
            ...s,
            subscribers: taskManager.enabledTasks(s.id).map(t => t.name),
          })),
          pumpclawSubscribers: taskManager.enabledTasks(PUMPCLAW_SOURCE_ID).map(t => t.name),
          recent: events.map((e: any) => ({ ...e, when: new Date(e.ts).toISOString().slice(11, 19) })),
        }, null, 2));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    } else if (pathname === '/api/skipped') {
      // Late-resolve at request time to avoid circular import on module load
      import('./index.js').then(idx => {
        const skipped = idx.skippedRing ?? [];
        const byReason: Record<string, number> = {};
        for (const s of skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
        const recent = [...skipped].sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalSkipped: skipped.length, byReason, recent }, null, 2));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    } else if (pathname === '/api/data') {
      try {
        const range = parseRange(url);
        const data = buildDashboardData(range);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data, null, 2));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (pathname === '/api/debug') {
      try {
        const files = ['calls.json', 'trades.json', 'positions.json'];
        const fileInfo: Record<string, any> = {};
        for (const f of files) {
          const p = join(CONFIG.DATA_DIR, f);
          if (existsSync(p)) {
            const stat = statSync(p);
            const data = loadJSON<any>(p);
            const times = data.map((r: any) => r.entryTime).filter(Boolean).sort((a: number, b: number) => b - a);
            fileInfo[f] = {
              exists: true,
              sizeBytes: stat.size,
              lastModified: stat.mtime.toISOString(),
              recordCount: data.length,
              newestEntryTime: times[0] ? new Date(times[0]).toISOString() : null,
              oldestEntryTime: times[times.length - 1] ? new Date(times[times.length - 1]).toISOString() : null,
              newestEntryMs: times[0] ?? null,
            };
          } else {
            fileInfo[f] = { exists: false };
          }
        }
        const debug = {
          dataDir: CONFIG.DATA_DIR,
          serverTime: new Date().toISOString(),
          serverTimeMs: Date.now(),
          files: fileInfo,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(debug, null, 2));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (pathname.startsWith('/api/refresh/')) {
      const mint = pathname.replace('/api/refresh/', '');
      if (!mint || mint.length < 30) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid mint address' }));
        return;
      }
      // Price via the shared Jupiter helper. This block used to re-derive the
      // price inline and repeated the bug it was written to work around: the
      // quote's outAmount is raw units, and dividing by it without scaling by the
      // mint's decimals gives a price 10^decimals too small. It also carried a
      // hardcoded 140 SOL fallback, which is not a price, it is a guess from
      // whenever the line was written.
      (async () => {
        try {
          const solPriceUsd = await getSolPrice();
          if (!(solPriceUsd > 0)) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'could not resolve SOL price' }));
            return;
          }
          const jup = await jupiterGetPrice(mint, solPriceUsd);
          if (!jup || !(jup.priceUsd > 0)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No quote data from Jupiter for this mint' }));
            return;
          }
          const currentPriceUsd = jup.priceUsd;

          // Load and update calls.json
          const callsPath = join(CONFIG.DATA_DIR, 'calls.json');
          const calls: CallRecord[] = loadJSON<CallRecord>(callsPath);
          const rec = calls.find(c => c.mint === mint);
          if (!rec) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Mint not found in calls.json' }));
            return;
          }

          const oldPeak = rec.peakMultiplier;
          // A zero entry price would make this Infinity, and the block below
          // writes it straight to calls.json. Refuse rather than persist garbage.
          if (!(rec.entryPrice > 0)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'record has no entry price — cannot compute a multiple' }));
            return;
          }
          const newMult = currentPriceUsd / rec.entryPrice;
          const updatedFields: Record<string, any> = {
            entryPrice: rec.entryPrice,
            currentPriceUsd,
            oldPeakMultiplier: oldPeak,
            newMultiplier: newMult,
          };

          if (newMult > rec.peakMultiplier) {
            rec.peakMultiplier = newMult;
            rec.peakPrice = currentPriceUsd;
            if (rec.entryMC > 0) {
              rec.peakMC = rec.entryMC * newMult;
            }
            updatedFields.peakUpdated = true;
          } else {
            updatedFields.peakUpdated = false;
            updatedFields.note = 'Current price is below existing peak — peak unchanged';
          }

          writeFileSync(callsPath, JSON.stringify(calls, null, 2));

          // Also update positions.json if the mint exists there
          const posPath = join(CONFIG.DATA_DIR, 'positions.json');
          const positions: RealPosition[] = loadJSON<RealPosition>(posPath);
          const pos = positions.find(p => p.mint === mint);
          if (pos && newMult > pos.peakMultiplier) {
            pos.peakMultiplier = newMult;
            writeFileSync(posPath, JSON.stringify(positions, null, 2));
            updatedFields.positionPeakUpdated = true;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, ...updatedFields }, null, 2));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`  Dashboard:  http://${HOST}:${PORT}`);
  });
}

// Allow standalone execution: `tsx src/dashboard.ts`
const isMain = process.argv[1]?.endsWith('dashboard.ts') || process.argv[1]?.endsWith('dashboard.js');
if (isMain) {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║       5min Vol Scanner — Dashboard                ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log('');
  startDashboard();
  console.log('');
  console.log('  Refresh the page to get latest data.');
  console.log('');
}
