/**
 * Backtest: simulate the paper trading strategy across all historical calls.
 * Usage: npx tsx src/backtest.ts
 */
import { readFileSync } from 'fs';
import { CONFIG } from './config.js';
import type { CallRecord } from './tracker.js';

// Load calls
const raw = readFileSync(CONFIG.DATA_FILE, 'utf-8');
const calls: CallRecord[] = JSON.parse(raw);

// Exclude suspected fakes
const EXCLUDE = ['Community', 'Devious'];
const filtered = calls.filter(c => !EXCLUDE.includes(c.symbol) && !EXCLUDE.includes(c.name));

console.log(`Total calls: ${calls.length}`);
console.log(`Excluded: ${EXCLUDE.join(', ')} (${calls.length - filtered.length} removed)`);
console.log(`Backtesting: ${filtered.length} calls\n`);

function estimatePnl(peak: number): { pnl: number; detail: string } {
  const sol = CONFIG.PAPER_ENTRY_SOL;
  let returned = 0;
  let remaining = 1.0;
  const parts: string[] = [];

  if (peak >= CONFIG.PAPER_TP1_MULT) {
    const sell = CONFIG.PAPER_TP1_SELL;
    const got = sell * sol * CONFIG.PAPER_TP1_MULT;
    returned += got;
    remaining -= sell;
    parts.push(`TP1(2X): +${got.toFixed(3)}`);
  }
  if (peak >= CONFIG.PAPER_TP2_MULT) {
    const sell = CONFIG.PAPER_TP2_SELL;
    const got = sell * sol * CONFIG.PAPER_TP2_MULT;
    returned += got;
    remaining -= sell;
    parts.push(`TP2(3X): +${got.toFixed(3)}`);
  }
  if (peak >= CONFIG.PAPER_TP3_MULT) {
    const sell = CONFIG.PAPER_TP3_SELL;
    const got = sell * sol * CONFIG.PAPER_TP3_MULT;
    returned += got;
    remaining -= sell;
    parts.push(`TP3(5X): +${got.toFixed(3)}`);
    // Trailing stop catches remaining at ~60% of ATH
    const trailGot = remaining * sol * peak * (1 - CONFIG.PAPER_TRAILING_DROP);
    returned += trailGot;
    parts.push(`Trail(${(peak * 0.6).toFixed(1)}X): +${trailGot.toFixed(3)}`);
    remaining = 0;
  }

  if (remaining > 0) {
    if (peak < CONFIG.PAPER_TP1_MULT) {
      // Never hit 2X — hit -30% stop loss
      const got = remaining * sol * CONFIG.PAPER_STOP_LOSS_PCT;
      returned += got;
      parts.push(`SL(-30%): +${got.toFixed(3)}`);
    } else {
      // Hit 2X+ but not 5X — break-even stop on rest
      const got = remaining * sol * 1.0;
      returned += got;
      parts.push(`BE-Stop: +${got.toFixed(3)}`);
    }
    remaining = 0;
  }

  return { pnl: returned - sol, detail: parts.join(' | ') };
}

// ── Run backtest ──
let totalPnl = 0;
let wins = 0;
let losses = 0;
let totalInvested = 0;

interface Result {
  symbol: string;
  name: string;
  peak: number;
  entryMC: number;
  peakMC: number;
  pnl: number;
  detail: string;
}

const results: Result[] = [];

for (const c of filtered) {
  const { pnl, detail } = estimatePnl(c.peakMultiplier);
  totalPnl += pnl;
  totalInvested += CONFIG.PAPER_ENTRY_SOL;
  if (pnl > 0) wins++;
  else losses++;
  results.push({
    symbol: c.symbol,
    name: c.name,
    peak: c.peakMultiplier,
    entryMC: c.entryMC,
    peakMC: c.peakMC,
    pnl,
    detail,
  });
}

// Sort by PnL
results.sort((a, b) => b.pnl - a.pnl);

// ── Top 15 winners ──
console.log('═══════════════════════════════════════════════════════');
console.log('  TOP 15 WINNERS');
console.log('═══════════════════════════════════════════════════════');
for (const r of results.slice(0, 15)) {
  const pnlStr = r.pnl >= 0 ? `+${r.pnl.toFixed(3)}` : r.pnl.toFixed(3);
  console.log(`  ${pnlStr} SOL  ${r.peak.toFixed(1).padStart(6)}X  $${r.symbol.padEnd(14)}  $${(r.entryMC / 1000).toFixed(1)}K → $${(r.peakMC / 1000).toFixed(1)}K`);
  console.log(`           ${r.detail}`);
}

// ── Bottom 10 losers ──
console.log('\n═══════════════════════════════════════════════════════');
console.log('  BOTTOM 10 LOSERS');
console.log('═══════════════════════════════════════════════════════');
for (const r of results.slice(-10).reverse()) {
  const pnlStr = r.pnl.toFixed(3);
  console.log(`  ${pnlStr} SOL  ${r.peak.toFixed(2).padStart(6)}X  $${r.symbol.padEnd(14)}  $${(r.entryMC / 1000).toFixed(1)}K → $${(r.peakMC / 1000).toFixed(1)}K`);
}

// ── Summary ──
const avgPnl = totalPnl / filtered.length;
const winRate = Math.round((wins / filtered.length) * 100);
const hit2x = filtered.filter(c => c.peakMultiplier >= 2).length;
const hit3x = filtered.filter(c => c.peakMultiplier >= 3).length;
const hit5x = filtered.filter(c => c.peakMultiplier >= 5).length;
const hit10x = filtered.filter(c => c.peakMultiplier >= 10).length;
const avgPeak = filtered.reduce((s, c) => s + c.peakMultiplier, 0) / filtered.length;

// Biggest single loss
const worstLoss = results[results.length - 1];

console.log('\n═══════════════════════════════════════════════════════');
console.log('  BACKTEST RESULTS');
console.log('═══════════════════════════════════════════════════════');
console.log(`  Calls:           ${filtered.length}`);
console.log(`  Total Invested:  ${totalInvested.toFixed(0)} SOL`);
console.log(`  Total Returned:  ${(totalInvested + totalPnl).toFixed(2)} SOL`);
console.log(`  Net P&L:         ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} SOL`);
console.log(`  ROI:             ${((totalPnl / totalInvested) * 100).toFixed(1)}%`);
console.log(`  Avg P&L/Trade:   ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(3)} SOL`);
console.log(`  Win Rate:        ${winRate}% (${wins}W / ${losses}L)`);
console.log(`  Avg Peak:        ${avgPeak.toFixed(2)}X`);
console.log(`  Hit 2X+:         ${hit2x} (${Math.round((hit2x / filtered.length) * 100)}%)`);
console.log(`  Hit 3X+:         ${hit3x} (${Math.round((hit3x / filtered.length) * 100)}%)`);
console.log(`  Hit 5X+:         ${hit5x} (${Math.round((hit5x / filtered.length) * 100)}%)`);
console.log(`  Hit 10X+:        ${hit10x} (${Math.round((hit10x / filtered.length) * 100)}%)`);
console.log(`  Worst Loss:      ${worstLoss.pnl.toFixed(3)} SOL ($${worstLoss.symbol})`);
console.log(`  Best Win:        +${results[0].pnl.toFixed(2)} SOL ($${results[0].symbol} — ${results[0].peak.toFixed(1)}X)`);
console.log('═══════════════════════════════════════════════════════');
