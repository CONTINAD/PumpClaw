import { readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { CONFIG, saveSettingsOverrides } from './config.js';
import { getWallet, getSolBalance, setWalletFromKey, walletSource } from './wallet.js';
import { taskManager, type TradeTask } from './tasks.js';
import { STRATEGY_PRESETS, sanitizeStrategy, describeStrategy, type Strategy } from './strategy.js';
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
    symbol: c.symbol,
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
  <h1>🧪 Strategy Lab</h1>
  <a href="/?range=${activeRange}">← Dashboard</a>
</div>
<div class="wrap">
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
    <a href="/settings" style="border-color:var(--border2)">⚙️ Settings</a>
  </div>
</div>

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
  const title = self.startsWith('/task') ? '🤖 Trading Tasks' : '⚙️ Live Trading Settings';
  const wide = self.startsWith('/task') ? 'max-width:960px' : 'max-width:640px';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PumpClaw ${self.startsWith('/task') ? 'Tasks' : 'Settings'}</title><style>${SETTINGS_STYLE}</style></head><body>
<div class="topbar"><h1>${title}</h1><div style="display:flex;gap:14px"><a href="/tasks">Tasks</a><a href="/settings">Settings</a><a href="/">← Dashboard</a></div></div>
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
    getSolBalance(taskManager.keypairFor(t)).catch(() => null)));

  const rows = tasks.map((t, i) => {
    const addr = taskManager.keypairFor(t).publicKey.toBase58();
    const s = taskSummary(t);
    const bal = balances[i];
    return `<tr>
      <td><span style="color:${t.enabled ? '#10b981' : '#4a5570'}">●</span> <a href="/task?id=${t.id}" style="color:var(--text);font-weight:700">${t.name}</a></td>
      <td class="mono" style="font-size:11px;color:var(--text2)">${addr.slice(0, 6)}…${addr.slice(-4)}</td>
      <td class="mono">${bal === null ? '—' : bal.toFixed(3) + ' ◎'}</td>
      <td style="font-size:12px;color:var(--text2)">${describeStrategy(t.strategy)}</td>
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
      <tr><th>Task</th><th>Wallet</th><th>Balance</th><th>Strategy</th><th>Realized PnL</th><th>Positions</th><th></th></tr>
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
      <label>Slippage % / Priority fee (SOL)</label>
      <div style="display:flex;gap:8px">
        <input type="number" name="slippage" min="1" max="99" value="${Math.round(s.slippageBps / 100)}" style="flex:1">
        <input type="number" name="priority_fee" step="0.00001" min="0" value="${s.priorityFeeLamports / 1e9}" style="flex:1">
      </div>
      <button type="submit">Save strategy</button>
    </div>
  </form>

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
      const task = taskManager.create(form.name, form.wallet_key, strategyFromForm(form));
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
    } else if (form.action === 'strategy') {
      taskManager.update(task.id, { name: form.name, strategy: strategyFromForm(form, task.strategy) });
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

    // POST /settings | /tasks | /task — collect body then handle
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

    if (pathname === '/api/live') {
      (async () => {
        const open = taskManager.openPositions().map(({ task, pos: p }) => ({
          taskId: task.id, taskName: task.name,
          mint: p.mint, symbol: p.symbol, entrySol: p.entrySol, entryPrice: p.entryPrice,
          entryMC: p.entryMC, entryTime: p.entryTime, remainingPct: p.remainingPct,
          totalSolReturned: p.totalSolReturned, trailingStopPrice: p.trailingStopPrice,
          peakMultiplier: p.peakMultiplier, exits: p.exits.length,
        }));
        let balance: number | null = null;
        try {
          // combined balance across enabled task wallets
          const bals = await Promise.all(taskManager.enabledTasks().map(t =>
            getSolBalance(taskManager.keypairFor(t)).catch(() => 0)));
          balance = bals.reduce((s, b) => s + b, 0);
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
    } else if (pathname === '/' || pathname === '/dashboard') {
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
      // Fetch real price via Jupiter quote API and update tracker data
      (async () => {
        try {
          // Quote: how many tokens for 0.1 SOL?
          const WSOL = 'So11111111111111111111111111111111111111112';
          const lamportsIn = 100_000_000; // 0.1 SOL
          const quoteRes = await fetch(
            `https://lite-api.jup.ag/swap/v1/quote?inputMint=${WSOL}&outputMint=${mint}&amount=${lamportsIn}&slippageBps=100`,
            { signal: AbortSignal.timeout(10_000) },
          );
          if (!quoteRes.ok) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Jupiter quote API returned ' + quoteRes.status }));
            return;
          }
          const quote: any = await quoteRes.json();
          const tokensOut = parseInt(quote.outAmount);
          if (!tokensOut || tokensOut <= 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No quote data from Jupiter for this mint' }));
            return;
          }
          // Derive price: SOL/token * SOL-USD = USD/token
          const solPerToken = (lamportsIn / 1e9) / tokensOut;
          // Get SOL price from DexScreener (cached)
          const solRes = await fetch(
            `https://api.dexscreener.com/tokens/v1/solana/${WSOL}`,
            { signal: AbortSignal.timeout(10_000) },
          );
          let solPriceUsd = 140; // fallback
          if (solRes.ok) {
            const solPairs: any[] = await solRes.json();
            const usdcPair = solPairs
              .filter((p: any) => p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT')
              .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
            if (usdcPair) solPriceUsd = parseFloat(usdcPair.priceUsd || '140');
          }
          const currentPriceUsd = solPerToken * solPriceUsd;

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
