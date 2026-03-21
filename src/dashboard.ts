import { readFileSync, writeFileSync, statSync, existsSync } from 'fs';
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

  // Compute derived display values
  const realWinPct = (o.realWins + o.realLosses) > 0 ? (o.realWins / (o.realWins + o.realLosses) * 100) : 0;
  const paperWinPct = (o.paperWins + o.paperLosses) > 0 ? (o.paperWins / (o.paperWins + o.paperLosses) * 100) : 0;
  const tp1Pct = d.tpHitRates.real.total > 0 ? (d.tpHitRates.real.tp1 / d.tpHitRates.real.total * 100) : 0;
  const tp2Pct = d.tpHitRates.real.total > 0 ? (d.tpHitRates.real.tp2 / d.tpHitRates.real.total * 100) : 0;
  const tp3Pct = d.tpHitRates.real.total > 0 ? (d.tpHitRates.real.tp3 / d.tpHitRates.real.total * 100) : 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
.brand-icon{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#ff3b5c,#ff9f40);display:flex;align-items:center;justify-content:center;box-shadow:0 0 12px rgba(255,59,92,0.3)}
.brand-icon svg{width:18px;height:18px}
.brand h1{font-size:16px;font-weight:600;color:#fff;letter-spacing:-0.3px}
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
  background:var(--bg1);border:1px solid var(--border);border-radius:12px;padding:24px 28px;
  position:relative;overflow:hidden;
}
.hero-card::before{
  content:'';position:absolute;top:0;left:0;right:0;height:2px;
}
.hero-real::before{background:linear-gradient(90deg,var(--green),var(--cyan))}
.hero-paper::before{background:linear-gradient(90deg,var(--blue),var(--purple))}
.hero-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:10px}
.hero-val{font-size:36px;font-weight:700;font-family:'JetBrains Mono','SF Mono',monospace;letter-spacing:-1.5px;line-height:1.1}
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
}

@media(max-width:1100px){.metrics{grid-template-columns:repeat(3,1fr)}.hero{grid-template-columns:1fr}}
@media(max-width:900px){.r2{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}.wrap{padding:0 16px 40px}.topbar{padding:12px 16px}}
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
    <div class="dot"></div>
    <span class="mono" style="font-size:11px">${new Date().toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}</span>
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
  </div>
</div>

<!-- ── hero PnL ── -->
<div class="hero">
  <div class="hero-card hero-real">
    <div class="hero-label">Real Trading P&L</div>
    <div class="hero-val ${o.totalRealPnl>=0?'g':'r'}">${o.totalRealPnl>=0?'+':''}${o.totalRealPnl.toFixed(4)} <span style="font-size:16px;font-weight:500;opacity:0.6">SOL</span></div>
    <div class="hero-sub">
      <span>ROI <span class="hero-pct ${o.realROI>=0?'pct-g':'pct-r'}">${o.realROI>=0?'+':''}${o.realROI.toFixed(1)}%</span></span>
      <span>W/L: <strong style="color:var(--green)">${o.realWins}</strong>/<strong style="color:var(--red)">${o.realLosses}</strong></span>
      <span>Win Rate: <strong style="color:#fff">${realWinPct.toFixed(0)}%</strong></span>
      <span>Avg: <strong class="${o.avgRealPnl>=0?'g':'r'}">${o.avgRealPnl>=0?'+':''}${o.avgRealPnl.toFixed(4)}</strong></span>
    </div>
  </div>
  <div class="hero-card hero-paper">
    <div class="hero-label">Paper Trading P&L</div>
    <div class="hero-val ${o.totalPaperPnl>=0?'b':'r'}">${o.totalPaperPnl>=0?'+':''}${o.totalPaperPnl.toFixed(2)} <span style="font-size:16px;font-weight:500;opacity:0.6">SOL</span></div>
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
    <div class="k">Invested</div>
    <div class="v">${o.totalRealInvested.toFixed(3)}</div>
    <div class="d">SOL deployed</div>
  </div>
  <div class="m">
    <div class="k">Best Trade</div>
    <div class="v g" style="font-size:14px">${o.bestReal?'$'+o.bestReal.symbol:'--'}</div>
    <div class="d">${o.bestReal?(o.bestReal.pnl>=0?'+':'')+o.bestReal.pnl.toFixed(4)+' SOL':'no trades'}</div>
  </div>
  <div class="m">
    <div class="k">Worst Trade</div>
    <div class="v r" style="font-size:14px">${o.worstReal?'$'+o.worstReal.symbol:'--'}</div>
    <div class="d">${o.worstReal?o.worstReal.pnl.toFixed(4)+' SOL':'no trades'}</div>
  </div>
  <div class="m">
    <div class="k">TP1 Hit Rate</div>
    <div class="v">${tp1Pct.toFixed(0)}%</div>
    <div class="bar"><div class="bar-fill" style="width:${tp1Pct}%;background:var(--green)"></div></div>
  </div>
  <div class="m">
    <div class="k">TP2 Hit Rate</div>
    <div class="v">${tp2Pct.toFixed(0)}%</div>
    <div class="bar"><div class="bar-fill" style="width:${tp2Pct}%;background:var(--blue)"></div></div>
  </div>
  <div class="m">
    <div class="k">TP3 Hit Rate</div>
    <div class="v">${tp3Pct.toFixed(0)}%</div>
    <div class="bar"><div class="bar-fill" style="width:${tp3Pct}%;background:var(--purple)"></div></div>
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

<div class="section-title">Top Runners</div>

<div class="card" style="margin-bottom:16px;padding:0;overflow:hidden">
  <div class="tbl">
  <table>
    <thead><tr><th>#</th><th>Token</th><th>Entry MC</th><th>Peak</th><th>Peak MC</th><th>Milestones</th><th>Date</th></tr></thead>
    <tbody>
    ${d.callsWithPeaks.length === 0 ? '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text3)">No calls in this range</td></tr>' : ''}
    ${d.callsWithPeaks.slice(0,30).map((c,i)=>`<tr>
      <td class="dim">${i+1}</td>
      <td><strong style="color:#fff">$${esc(c.symbol)}</strong> <span class="dim">${esc(c.name)}</span></td>
      <td class="mono dim">$${fmtK(c.entryMC)}</td>
      <td class="mono ${c.peakMultiplier>=2?'g':c.peakMultiplier>=1.5?'b':'dim'}" style="font-weight:600">${c.peakMultiplier.toFixed(1)}x</td>
      <td class="mono dim">$${fmtK(c.peakMC)}</td>
      <td>${c.milestones.length?c.milestones.map(m=>`<span class="tag tag-g">${m}x</span>`).join(' '):'<span class="dim">--</span>'}</td>
      <td class="dim">${new Date(c.entryTime).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</td>
    </tr>`).join('')}
    </tbody>
  </table>
  </div>
</div>

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
