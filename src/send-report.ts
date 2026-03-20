/**
 * One-time script: fetch fresh prices for ALL calls, update ATH peaks, send monthly report.
 * Usage: npx tsx src/send-report.ts
 */
import { PerformanceTracker } from './tracker.js';
import { fetchBatchMarketData } from './dexscreener.js';
import { sendMonthlyReportFromCalls, fmtUsd } from './discord.js';

async function main() {
  const tracker = new PerformanceTracker();
  const allCalls = tracker.getActiveCalls();
  console.log(`Loaded ${allCalls.length} calls`);

  // ── Fetch fresh prices and update ATH peaks ──
  console.log('Fetching fresh prices from DexScreener...');
  const mints = allCalls.map(c => c.mint);
  const marketData = await fetchBatchMarketData(mints);
  console.log(`Got live data for ${marketData.size} / ${mints.length} tokens`);

  let updatedCount = 0;
  for (const rec of allCalls) {
    const m = marketData.get(rec.mint);
    if (!m || m.priceUsd === 0) continue;
    const mult = m.priceUsd / rec.entryPrice;
    if (mult > rec.peakMultiplier) {
      const oldPeak = rec.peakMultiplier;
      tracker.updatePeak(rec.mint, m.priceUsd, m.marketCap);
      updatedCount++;
      console.log(`  ↑ $${rec.symbol}: ${oldPeak.toFixed(2)}X → ${mult.toFixed(2)}X`);
    }
  }
  console.log(`Updated ${updatedCount} peak values with live data`);

  // ── Filter to current month (March 2026) ──
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthCalls = allCalls.filter(c => c.entryTime >= monthStart);
  console.log(`\nMarch calls: ${monthCalls.length}`);

  // Show top 10 in console
  const sorted = [...monthCalls].sort((a, b) => b.peakMultiplier - a.peakMultiplier);
  console.log('\nTop 10 by ATH peak:');
  for (const c of sorted.slice(0, 10)) {
    console.log(`  ${c.peakMultiplier.toFixed(2)}X  $${c.symbol.padEnd(14)} ${fmtUsd(c.entryMC)} → ${fmtUsd(c.peakMC)}`);
  }

  // ── Send to Discord ──
  const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  console.log(`\nSending ${monthLabel} report to Discord...`);
  const msgId = await sendMonthlyReportFromCalls(monthLabel, monthCalls);

  if (msgId) {
    console.log(`✅ Report sent (message ID: ${msgId})`);
  } else {
    console.error('❌ Failed to send report');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
