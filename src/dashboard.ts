import { readFileSync } from 'fs';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
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
  let positions: RealPosition[] = loadJSON(join(CONFIG.DATA_DIR, 'positions.json'));

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

function buildHTML(data: ReturnType<typeof buildDashboardData>, activeRange: TimeRange = 'all'): string {
  const d = data;
  const o = d.overview;

  // win/loss bar helper
  const wrBar = (w: number, l: number, color: string) => {
    const total = w + l;
    const pct = total > 0 ? (w / total * 100) : 0;
    return `<div style="display:flex;align-items:center;gap:8px;margin-top:6px">
      <div style="flex:1;height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:2px"></div>
      </div>
      <span style="font-size:11px;color:#888;min-width:36px">${pct.toFixed(0)}%</span>
    </div>`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>5min Vol Dashboard</title>
<script src="/chart.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0b0f19;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
code,td,th,.mono{font-family:'SF Mono',SFMono-Regular,ui-monospace,'DejaVu Sans Mono',Menlo,Consolas,monospace}
a{color:#58a6ff;text-decoration:none}

.wrap{max-width:1360px;margin:0 auto;padding:28px 32px 48px}

/* header */
.hdr{display:flex;align-items:baseline;gap:12px;margin-bottom:4px}
.hdr h1{font-size:20px;font-weight:600;color:#e6edf3;letter-spacing:-0.3px}
.hdr .sep{color:#30363d}
.hdr .ts{font-size:12px;color:#484f58}
.nav{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #21262d;padding:10px 0 12px;margin-bottom:24px;font-size:13px;color:#484f58}
.nav-left{display:flex;gap:20px}
.nav-left span{color:#c9d1d9;font-weight:500}
.tf{display:flex;gap:2px;background:#161b22;border:1px solid #21262d;border-radius:6px;padding:2px}
.tf-btn{display:block;padding:4px 10px;border-radius:4px;font-size:11px;font-weight:500;color:#8b949e;text-decoration:none;transition:all 0.15s}
.tf-btn:hover{color:#c9d1d9;background:rgba(255,255,255,0.04)}
.tf-active{background:#21262d;color:#e6edf3}

/* stat row */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:#21262d;border:1px solid #21262d;border-radius:8px;overflow:hidden;margin-bottom:24px}
.st{background:#0d1117;padding:14px 16px}
.st .k{font-size:11px;color:#484f58;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px}
.st .v{font-size:22px;font-weight:600;font-family:'SF Mono',SFMono-Regular,ui-monospace,monospace;letter-spacing:-0.5px}
.st .d{font-size:11px;color:#484f58;margin-top:3px}
.g{color:#3fb950}.r{color:#f85149}.b{color:#58a6ff}.o{color:#d29922}.p{color:#bc8cff}

/* cards */
.row{display:grid;gap:16px;margin-bottom:16px}
.r2{grid-template-columns:1fr 1fr}
.r1{grid-template-columns:1fr}
.c{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:16px 20px;overflow:hidden}
.c h3{font-size:13px;font-weight:500;color:#e6edf3;margin-bottom:14px}
.ch{position:relative;height:280px}
.ch.lg{height:360px}

/* tables */
.tbl{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:7px 10px;color:#484f58;font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #21262d;white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid rgba(33,38,45,0.5);white-space:nowrap}
tbody tr:hover td{background:rgba(88,166,255,0.04)}

.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:500;line-height:16px}
.tag-g{background:rgba(63,185,80,0.12);color:#3fb950}
.tag-r{background:rgba(248,81,73,0.12);color:#f85149}
.tag-b{background:rgba(88,166,255,0.12);color:#58a6ff}
.tag-p{background:rgba(188,140,255,0.12);color:#bc8cff}
.tag-o{background:rgba(210,153,34,0.12);color:#d29922}
.dim{color:#484f58}

@media(max-width:900px){.r2{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.wrap{padding:16px}}
</style>
</head>
<body>
<div class="wrap">

<div class="hdr">
  <h1>5min Vol</h1>
  <span class="sep">/</span>
  <span class="ts mono">${new Date().toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span>
</div>

<div class="nav">
  <div class="nav-left">
    <span>${o.totalCalls} calls</span>
    <span>${o.totalPaperTrades} paper</span>
    <span>${o.totalRealPositions} real</span>
    <span class="dim">${o.openPaperTrades + o.openRealPositions} open</span>
  </div>
  <div class="tf">
    ${(['1h','6h','12h','24h','7d','all'] as TimeRange[]).map(r =>
      `<a href="/?range=${r}" class="tf-btn${activeRange===r?' tf-active':''}">${RANGE_LABELS[r]}</a>`
    ).join('')}
  </div>
</div>

<!-- ── stats ── -->
<div class="stats">
  <div class="st">
    <div class="k">Real PnL</div>
    <div class="v ${o.totalRealPnl>=0?'g':'r'}">${o.totalRealPnl>=0?'+':''}${o.totalRealPnl.toFixed(4)}</div>
    <div class="d">SOL &middot; ${o.realROI>=0?'+':''}${o.realROI.toFixed(1)}% ROI</div>
  </div>
  <div class="st">
    <div class="k">Real W/L</div>
    <div class="v">${o.realWins}<span class="dim" style="font-size:14px;font-weight:400"> / ${o.realLosses}</span></div>
    ${wrBar(o.realWins, o.realLosses, '#3fb950')}
  </div>
  <div class="st">
    <div class="k">Paper PnL</div>
    <div class="v ${o.totalPaperPnl>=0?'b':'r'}">${o.totalPaperPnl>=0?'+':''}${o.totalPaperPnl.toFixed(2)}</div>
    <div class="d">SOL &middot; avg ${o.avgPaperPnl>=0?'+':''}${o.avgPaperPnl.toFixed(3)}/trade</div>
  </div>
  <div class="st">
    <div class="k">Paper W/L</div>
    <div class="v">${o.paperWins}<span class="dim" style="font-size:14px;font-weight:400"> / ${o.paperLosses}</span></div>
    ${wrBar(o.paperWins, o.paperLosses, '#58a6ff')}
  </div>
  <div class="st">
    <div class="k">Best Real</div>
    <div class="v g" style="font-size:16px">${o.bestReal?'$'+o.bestReal.symbol:'--'}</div>
    <div class="d">${o.bestReal?(o.bestReal.pnl>=0?'+':'')+o.bestReal.pnl.toFixed(4)+' SOL':''}</div>
  </div>
  <div class="st">
    <div class="k">Worst Real</div>
    <div class="v r" style="font-size:16px">${o.worstReal?'$'+o.worstReal.symbol:'--'}</div>
    <div class="d">${o.worstReal?o.worstReal.pnl.toFixed(4)+' SOL':''}</div>
  </div>
  <div class="st">
    <div class="k">Real TP1 Rate</div>
    <div class="v">${d.tpHitRates.real.total>0?(d.tpHitRates.real.tp1/d.tpHitRates.real.total*100).toFixed(0):'0'}%</div>
    <div class="d">${d.tpHitRates.real.tp1}/${d.tpHitRates.real.total} trades</div>
  </div>
  <div class="st">
    <div class="k">Invested</div>
    <div class="v" style="font-size:16px">${o.totalRealInvested.toFixed(2)}</div>
    <div class="d">SOL total</div>
  </div>
</div>

<!-- ── charts row 1 ── -->
<div class="row r2">
  <div class="c"><h3>Cumulative PnL</h3><div class="ch lg"><canvas id="cumPnlChart"></canvas></div></div>
  <div class="c"><h3>Per-Trade PnL (Real)</h3><div class="ch lg"><canvas id="tradePnlChart"></canvas></div></div>
</div>

<div class="row r2">
  <div class="c"><h3>TP Hit Rates</h3><div class="ch"><canvas id="tpChart"></canvas></div></div>
  <div class="c"><h3>Exit Reasons</h3><div class="ch"><canvas id="exitChart"></canvas></div></div>
</div>

<div class="row r2">
  <div class="c"><h3>Peak Multiplier Distribution</h3><div class="ch"><canvas id="peakChart"></canvas></div></div>
  <div class="c"><h3>Milestones</h3><div class="ch"><canvas id="milestoneChart"></canvas></div></div>
</div>

<div class="row r2">
  <div class="c"><h3>Win Rate by Entry MC</h3><div class="ch"><canvas id="mcChart"></canvas></div></div>
  <div class="c"><h3>Calls by Hour</h3><div class="ch"><canvas id="hourlyChart"></canvas></div></div>
</div>

<div class="row r1">
  <div class="c"><h3>Daily PnL</h3><div class="ch lg"><canvas id="dailyPnlChart"></canvas></div></div>
</div>

<!-- ── top runners ── -->
<div class="c" style="margin-bottom:16px">
  <h3>Top Runners</h3>
  <div class="tbl">
  <table>
    <thead><tr><th>#</th><th>Token</th><th>Entry MC</th><th>Peak</th><th>Peak MC</th><th>Milestones</th><th>Date</th></tr></thead>
    <tbody>
    ${d.callsWithPeaks.slice(0,30).map((c,i)=>`<tr>
      <td class="dim">${i+1}</td>
      <td><strong>$${esc(c.symbol)}</strong> <span class="dim">${esc(c.name)}</span></td>
      <td class="dim">$${fmtK(c.entryMC)}</td>
      <td class="${c.peakMultiplier>=2?'g':c.peakMultiplier>=1.5?'b':'dim'}">${c.peakMultiplier.toFixed(1)}x</td>
      <td class="dim">$${fmtK(c.peakMC)}</td>
      <td>${c.milestones.length?c.milestones.map(m=>`<span class="tag tag-g">${m}x</span>`).join(' '):'<span class="dim">--</span>'}</td>
      <td class="dim">${new Date(c.entryTime).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</td>
    </tr>`).join('')}
    </tbody>
  </table>
  </div>
</div>

<!-- ── real positions ── -->
<div class="c" style="margin-bottom:16px">
  <h3>Real Positions</h3>
  <div class="tbl">
  <table>
    <thead><tr><th>#</th><th>Token</th><th>In</th><th>Out</th><th>PnL</th><th>Peak</th><th>TP1</th><th>TP2</th><th>TP3</th><th>Exit</th><th>Date</th></tr></thead>
    <tbody>
    ${d.positions.map((pos,i)=>{const pnl=pos.finalPnlSol??0;const last=pos.exits[pos.exits.length-1];return`<tr>
      <td class="dim">${i+1}</td>
      <td><strong>$${esc(pos.symbol)}</strong></td>
      <td class="dim">${pos.entrySol.toFixed(3)}</td>
      <td class="dim">${pos.totalSolReturned.toFixed(4)}</td>
      <td class="${pnl>=0?'g':'r'}">${pnl>=0?'+':''}${pnl.toFixed(4)}</td>
      <td class="${(pos.peakMultiplier??1)>=1.5?'g':'dim'}">${(pos.peakMultiplier??1).toFixed(2)}x</td>
      <td>${pos.tp1Hit?'<span class="tag tag-g">Y</span>':'<span class="dim">-</span>'}</td>
      <td>${pos.tp2Hit?'<span class="tag tag-g">Y</span>':'<span class="dim">-</span>'}</td>
      <td>${pos.tp3Hit?'<span class="tag tag-g">Y</span>':'<span class="dim">-</span>'}</td>
      <td>${last?formatExitReason(last.reason):'<span class="dim">-</span>'}</td>
      <td class="dim">${new Date(pos.closedTime??pos.entryTime).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</td>
    </tr>`}).join('')}
    </tbody>
  </table>
  </div>
</div>

</div>

<script>
Chart.defaults.color='#484f58';
Chart.defaults.borderColor='#21262d';
Chart.defaults.font.family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
Chart.defaults.font.size=11;
Chart.defaults.plugins.tooltip.backgroundColor='#161b22';
Chart.defaults.plugins.tooltip.borderColor='#30363d';
Chart.defaults.plugins.tooltip.borderWidth=1;
Chart.defaults.plugins.tooltip.cornerRadius=6;
Chart.defaults.plugins.tooltip.padding=10;
Chart.defaults.plugins.legend.labels.usePointStyle=true;
Chart.defaults.plugins.legend.labels.padding=14;
Chart.defaults.plugins.legend.labels.boxWidth=8;
Chart.defaults.elements.bar.borderRadius=3;
Chart.defaults.elements.bar.borderSkipped=false;
Chart.defaults.elements.line.tension=0.3;
Chart.defaults.elements.point.radius=0;
Chart.defaults.elements.point.hoverRadius=4;

const G='#3fb950',R='#f85149',B='#58a6ff',P='#bc8cff',O='#d29922',C='#39d2c0',PK='#f778ba';
const grid={color:'rgba(33,38,45,0.8)'};
const noGrid={display:false};

// cumulative pnl
(function(){
  const c=document.getElementById('cumPnlChart').getContext('2d');
  const gb=c.createLinearGradient(0,0,0,360);gb.addColorStop(0,B+'30');gb.addColorStop(1,B+'00');
  const gg=c.createLinearGradient(0,0,0,360);gg.addColorStop(0,G+'30');gg.addColorStop(1,G+'00');
  new Chart(c,{type:'line',data:{
    labels:${JSON.stringify(d.paperPnlTimeline.map(p=>new Date(p.time).toLocaleDateString('en-US',{month:'short',day:'numeric'})))},
    datasets:[
      {label:'Paper',data:${JSON.stringify(d.paperPnlTimeline.map(p=>+p.pnl.toFixed(3)))},borderColor:B,backgroundColor:gb,fill:true,borderWidth:2},
      {label:'Real',data:${JSON.stringify(d.realPnlTimeline.map(p=>({x:new Date(p.time).toLocaleDateString('en-US',{month:'short',day:'numeric'}),y:+p.pnl.toFixed(4)})))},borderColor:G,backgroundColor:gg,fill:true,borderWidth:2}
    ]},options:{responsive:true,maintainAspectRatio:false,interaction:{intersect:false,mode:'index'},scales:{y:{grid,ticks:{callback:v=>(v>=0?'+':'')+v}},x:{grid:noGrid,ticks:{maxTicksLimit:8}}}}});
})();

// per-trade pnl
new Chart(document.getElementById('tradePnlChart'),{type:'bar',data:{
  labels:${JSON.stringify(d.realPnlBars.map(p=>'$'+p.symbol))},
  datasets:[{data:${JSON.stringify(d.realPnlBars.map(p=>+p.pnl.toFixed(4)))},
    backgroundColor:${JSON.stringify(d.realPnlBars.map(p=>p.pnl>=0?'#3fb95060':'#f8514960'))},
    borderColor:${JSON.stringify(d.realPnlBars.map(p=>p.pnl>=0?'#3fb950':'#f85149'))},
    borderWidth:1}]},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{afterLabel:function(c){const p=${JSON.stringify(d.realPnlBars.map(p=>p.peakMult))};return'Peak: '+p[c.dataIndex].toFixed(1)+'x';}}}},scales:{y:{grid,ticks:{callback:v=>(v>=0?'+':'')+v}},x:{grid:noGrid,ticks:{maxRotation:45,minRotation:45}}}}});

// tp rates
new Chart(document.getElementById('tpChart'),{type:'bar',data:{
  labels:['TP1','TP2','TP3'],
  datasets:[
    {label:'Paper',data:[${[1,2,3].map(n=>{const k='tp'+n as 'tp1'|'tp2'|'tp3';return d.tpHitRates.paper.total>0?(d.tpHitRates.paper[k]/d.tpHitRates.paper.total*100).toFixed(1):'0'}).join(',')}],backgroundColor:B+'50',borderColor:B,borderWidth:1},
    {label:'Real',data:[${[1,2,3].map(n=>{const k='tp'+n as 'tp1'|'tp2'|'tp3';return d.tpHitRates.real.total>0?(d.tpHitRates.real[k]/d.tpHitRates.real.total*100).toFixed(1):'0'}).join(',')}],backgroundColor:G+'50',borderColor:G,borderWidth:1}
  ]},options:{responsive:true,maintainAspectRatio:false,scales:{y:{beginAtZero:true,max:100,grid,ticks:{callback:v=>v+'%'}},x:{grid:noGrid}}}});

// exit reasons
new Chart(document.getElementById('exitChart'),{type:'doughnut',data:{
  labels:${JSON.stringify(Object.keys(d.realExitReasons).map(formatExitReasonJS))},
  datasets:[{data:${JSON.stringify(Object.values(d.realExitReasons))},
    backgroundColor:[R+'aa',O+'aa',G+'aa',B+'aa',P+'aa',C+'aa',PK+'aa'],borderColor:'#0d1117',borderWidth:2}]},
  options:{responsive:true,maintainAspectRatio:false,cutout:'55%',plugins:{legend:{position:'right'}}}});

// peak dist
new Chart(document.getElementById('peakChart'),{type:'bar',data:{
  labels:${JSON.stringify(d.peakBuckets.map(b=>b.label))},
  datasets:[{data:${JSON.stringify(d.peakBuckets.map(b=>b.count))},
    backgroundColor:${JSON.stringify(d.peakBuckets.map((_,i)=>i===0?'#f8514950':['#d2992250','#58a6ff50','#3fb95050','#bc8cff50','#39d2c050','#f778ba50'][i-1]))},
    borderColor:${JSON.stringify(d.peakBuckets.map((_,i)=>i===0?'#f85149':['#d29922','#58a6ff','#3fb950','#bc8cff','#39d2c0','#f778ba'][i-1]))},
    borderWidth:1}]},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid},x:{grid:noGrid}}}});

// milestones
new Chart(document.getElementById('milestoneChart'),{type:'bar',data:{
  labels:${JSON.stringify(d.milestoneTargets.map(m=>m+'x'))},
  datasets:[{label:'Count',data:${JSON.stringify(d.milestoneTargets.map(m=>d.milestoneCounts[m]))},
    backgroundColor:G+'40',borderColor:G,borderWidth:1},
    {label:'% of calls',data:${JSON.stringify(d.milestoneTargets.map(m=>o.totalCalls>0?+(d.milestoneCounts[m]/o.totalCalls*100).toFixed(1):0))},
    type:'line',borderColor:C,borderWidth:2,pointRadius:3,pointBackgroundColor:C,yAxisID:'y1'}]},
  options:{responsive:true,maintainAspectRatio:false,scales:{y:{beginAtZero:true,grid},y1:{beginAtZero:true,position:'right',grid:noGrid,ticks:{callback:v=>v+'%'}},x:{grid:noGrid}}}});

// mc
new Chart(document.getElementById('mcChart'),{type:'bar',data:{
  labels:${JSON.stringify(d.mcBuckets.map(b=>b.label))},
  datasets:[
    {label:'Total',data:${JSON.stringify(d.mcBuckets.map(b=>b.count))},backgroundColor:B+'40',borderColor:B,borderWidth:1},
    {label:'2x+',data:${JSON.stringify(d.mcBuckets.map(b=>b.winners))},backgroundColor:G+'50',borderColor:G,borderWidth:1},
    {label:'Win%',data:${JSON.stringify(d.mcBuckets.map(b=>b.count>0?+(b.winners/b.count*100).toFixed(1):0))},type:'line',borderColor:O,borderWidth:2,pointRadius:3,pointBackgroundColor:O,yAxisID:'y1'}
  ]},options:{responsive:true,maintainAspectRatio:false,scales:{y:{beginAtZero:true,grid},y1:{beginAtZero:true,position:'right',grid:noGrid,ticks:{callback:v=>v+'%'}},x:{grid:noGrid}}}});

// hourly
new Chart(document.getElementById('hourlyChart'),{type:'bar',data:{
  labels:${JSON.stringify(Array.from({length:24},(_,i)=>i+':00'))},
  datasets:[{data:${JSON.stringify(d.hourlyDist)},backgroundColor:P+'30',borderColor:P,borderWidth:1}]},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid},x:{grid:noGrid}}}});

// daily
const dd=${JSON.stringify(Object.entries(d.dailyPnl).sort(([a],[b])=>a.localeCompare(b)))};
new Chart(document.getElementById('dailyPnlChart'),{type:'bar',data:{
  labels:dd.map(d=>d[0]),
  datasets:[
    {label:'Paper',data:dd.map(d=>+d[1].paper.toFixed(3)),backgroundColor:dd.map(d=>d[1].paper>=0?B+'50':B+'20'),borderColor:B,borderWidth:1},
    {label:'Real',data:dd.map(d=>+d[1].real.toFixed(4)),backgroundColor:dd.map(d=>d[1].real>=0?G+'50':R+'50'),borderColor:dd.map(d=>d[1].real>=0?G:R),borderWidth:1}
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

const PORT = 3000;

// Pre-load Chart.js once at startup
const chartJsSource = readFileSync(join(__dirname, 'chart.min.js'), 'utf-8');

function parseRange(url: string): TimeRange {
  const match = url.match(/[?&]range=([^&]+)/);
  const val = match?.[1] ?? 'all';
  return (val in RANGE_MS) ? val as TimeRange : 'all';
}

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  const pathname = url.split('?')[0];

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
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║       5min Vol Scanner — Dashboard                ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  API:        http://localhost:${PORT}/api/data`);
  console.log('');
  console.log('  Refresh the page to get latest data.');
  console.log('');
});
