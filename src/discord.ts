import { CONFIG } from './config.js';
import type { PumpFunCoin } from './pumpfun.js';
import type { MarketData } from './dexscreener.js';
import type { PerformanceSnapshot, CallRecord } from './tracker.js';
import type { PaperTrade, TradeExit } from './paper-trader.js';

// ── Formatting helpers ──────────────────────────────────────

export function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

export function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function age(createdTs?: number): string {
  if (!createdTs) return '';
  const diffMs = Date.now() - createdTs * 1000;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function timeSince(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function colorForPct(pct: number): number {
  if (pct >= 100) return 0x00ff88;
  if (pct >= 50) return 0x00cc66;
  if (pct >= 0) return 0x2ecc71;
  if (pct >= -20) return 0xff8c00;
  return 0xff4444;
}

function colorForMultiplier(mult: number): number {
  if (mult >= 50) return 0xff00ff;
  if (mult >= 20) return 0x9b59b6;
  if (mult >= 10) return 0xe91e63;
  if (mult >= 5) return 0x00e5ff;
  if (mult >= 3) return 0x00ff88;
  return 0x2ecc71;
}

function linkRow(mint: string): string {
  return [
    `[Pump.fun](https://pump.fun/${mint})`,
    `[DexScreener](https://dexscreener.com/solana/${mint})`,
    `[Birdeye](https://birdeye.so/token/${mint}?chain=solana)`,
    `[Photon](https://photon-sol.tinyastro.io/en/lp/${mint})`,
  ].join('  ·  ');
}

function buyRow(mint: string): string {
  return [
    `🐸 [**Buy on GMGN**](https://gmgn.ai/sol/token/TQ5emawd_${mint})`,
    `🔺 [**Buy on Axiom**](https://axiom.trade/t/${mint}/@noose?chain=sol)`,
  ].join('    ');
}

function buyButtons(mint: string) {
  return [
    {
      type: 1, // Action Row
      components: [
        {
          type: 2,    // Button
          style: 5,   // Link
          label: 'Buy on GMGN',
          url: `https://gmgn.ai/sol/token/TQ5emawd_${mint}`,
          emoji: { name: '🐸' },
        },
        {
          type: 2,
          style: 5,
          label: 'Buy on Axiom',
          url: `https://axiom.trade/t/${mint}/@noose?chain=sol`,
          emoji: { name: '🔺' },
        },
      ],
    },
  ];
}

// ── Alert embed (description-based) ────────────────────────

function buildAlertEmbed(
  coin: PumpFunCoin,
  market: MarketData,
  snapshots: PerformanceSnapshot[] = [],
) {
  const thumbnail = coin.image_uri || market.imageUrl;

  // ── Main stats block ──
  const lines: string[] = [];

  lines.push(`> **${fmtUsd(market.volume5m)}** 5m vol   ·   **${fmtUsd(market.marketCap)}** MC`);

  // Trades + change + liq (skip zeros)
  const tradeParts: string[] = [];
  if (market.buys5m + market.sells5m > 0) {
    tradeParts.push(`${market.buys5m} buys / ${market.sells5m} sells`);
  }
  if (market.priceChange5m !== 0) {
    tradeParts.push(`**${fmtPct(market.priceChange5m)}** 5m`);
  }
  if (market.liquidity > 0) {
    tradeParts.push(`${fmtUsd(market.liquidity)} liq`);
  }
  if (tradeParts.length > 0) {
    lines.push(`> ${tradeParts.join('   ·   ')}`);
  }

  // Volume + age + dex
  const infoParts: string[] = [];
  if (market.volume1h > 0) {
    infoParts.push(`${fmtUsd(market.volume1h)} 1h vol`);
  }
  const tokenAge = age(coin.created_timestamp);
  if (tokenAge) {
    infoParts.push(`${tokenAge} old`);
  }
  if (market.dexId) {
    infoParts.push(market.dexId);
  }
  if (infoParts.length > 0) {
    lines.push(`> ${infoParts.join('   ·   ')}`);
  }

  lines.push('');
  lines.push(linkRow(coin.mint));
  lines.push(buyRow(coin.mint));
  lines.push(`\`\`\`${coin.mint}\`\`\``);

  // ── Performance section ──
  if (snapshots.length > 0) {
    let bestPct = -Infinity;
    let bestLabel = '';

    const perfLines: string[] = [];
    for (const snap of snapshots) {
      const label = snap.intervalMin < 60 ? `${snap.intervalMin}m` : `${snap.intervalMin / 60}h`;
      const pricePct = ((snap.price - market.priceUsd) / market.priceUsd) * 100;
      const bar = pricePct >= 0 ? '🟩' : '🟥';
      const padLabel = label.padEnd(4);
      perfLines.push(`${bar}  \`${padLabel}\`  **${fmtPct(pricePct)}**  ·  MC ${fmtUsd(snap.marketCap)}`);
      if (pricePct > bestPct) {
        bestPct = pricePct;
        bestLabel = label;
      }
    }

    lines.push('');
    lines.push('**━━━━━  Performance  ━━━━━**');
    lines.push(perfLines.join('\n'));

    if (snapshots.length >= 2) {
      const emoji = bestPct >= 0 ? '🏆' : '📉';
      lines.push(`${emoji}  Best: **${fmtPct(bestPct)}** at ${bestLabel}`);
    }
  }

  // ── Footer ──
  const footerText =
    snapshots.length >= CONFIG.PERFORMANCE_INTERVALS.length
      ? '✅ Tracking complete'
      : `⏱ Tracking  ·  ${snapshots.length}/${CONFIG.PERFORMANCE_INTERVALS.length} updates`;

  // ── Color ──
  let color = 0xffd700;
  if (snapshots.length > 0) {
    const latest = snapshots[snapshots.length - 1];
    const latestPct = ((latest.price - market.priceUsd) / market.priceUsd) * 100;
    color = colorForPct(latestPct);
  }

  return {
    embeds: [{
      title: `🔔  ${coin.name}  ($${coin.symbol})`,
      description: lines.join('\n'),
      color,
      ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
      footer: { text: footerText },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ── Milestone embed ─────────────────────────────────────────

function buildMilestoneEmbed(rec: CallRecord, multiplier: number, currentPrice: number, currentMC: number) {
  const emoji = multiplier >= 10 ? '💎' : multiplier >= 5 ? '🔥' : '🚀';
  const thumbnail = rec.imageUri;

  const pctGain = ((currentPrice - rec.entryPrice) / rec.entryPrice) * 100;

  const lines: string[] = [];
  lines.push(`> **${multiplier}X** from our call  ·  **${fmtPct(pctGain)}**`);
  lines.push('');
  lines.push(`📊  ${fmtUsd(rec.entryMC)}  →  **${fmtUsd(currentMC)}** MC`);
  lines.push(`⏰  ${timeSince(rec.entryTime)} since call`);

  // Show milestone journey
  if (rec.hitMilestones.length > 0) {
    const journey = rec.hitMilestones
      .map(m => `**${m.multiplier}X**`)
      .join('  →  ');
    lines.push('');
    lines.push(`🏆  ${journey}`);
  }

  lines.push('');
  lines.push(linkRow(rec.mint));
  lines.push(buyRow(rec.mint));
  lines.push(`\`\`\`${rec.mint}\`\`\``);

  return {
    embeds: [{
      title: `${emoji}  ${rec.name} ($${rec.symbol}) hits ${multiplier}X!`,
      description: lines.join('\n'),
      color: colorForMultiplier(multiplier),
      ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
      footer: { text: `Peak: ${rec.peakMultiplier.toFixed(1)}X  ·  Entry MC ${fmtUsd(rec.entryMC)}` },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ── Leaderboard embed ───────────────────────────────────────

export interface LeaderboardEntry {
  rec: CallRecord;
  currentMC: number;
  multiplier: number;  // current multiplier
}

function buildLeaderboardEmbed(label: string, entries: LeaderboardEntry[]) {
  const medals = ['🥇', '🥈', '🥉', '4.', '5.', '6.', '7.', '8.', '9.', '10.'];

  // Rank by ATH multiplier (peak), not current
  const sorted = [...entries].sort((a, b) => b.rec.peakMultiplier - a.rec.peakMultiplier);
  const top = sorted.slice(0, 10);

  const profitable = entries.filter(e => e.rec.peakMultiplier >= 2).length;
  const avgPeak = entries.length > 0
    ? entries.reduce((s, e) => s + e.rec.peakMultiplier, 0) / entries.length
    : 0;

  const lines: string[] = [];

  if (top.length === 0) {
    lines.push('*No calls in this period*');
  } else {
    for (let i = 0; i < top.length; i++) {
      const e = top[i];
      const medal = medals[i] ?? `${i + 1}.`;
      const peak = e.rec.peakMultiplier;
      const peakStr = peak >= 1
        ? `**${peak.toFixed(1)}X**`
        : `**${peak.toFixed(2)}X**`;
      const bar = peak >= 1 ? '🟩' : '🟥';
      const athMC = e.rec.peakMC > 0 ? e.rec.peakMC : e.currentMC;
      lines.push(`${medal}  ${bar}  **$${e.rec.symbol}**  ·  ${peakStr} ATH  ·  ${fmtUsd(e.rec.entryMC)} → ${fmtUsd(athMC)}`);
    }

    if (entries.length > 10) {
      lines.push(`*... and ${entries.length - 10} more*`);
    }

    lines.push('');
    lines.push(`📊  **${entries.length}** calls  ·  **${profitable}** hit 2X+  ·  **${avgPeak.toFixed(1)}X** avg peak`);

    const best = top[0];
    if (best && best.rec.peakMultiplier >= 2) {
      lines.push(`🏆  Best: **$${best.rec.symbol}** peaked at **${best.rec.peakMultiplier.toFixed(1)}X**`);
    }
  }

  let color = 0x2f3136;
  if (avgPeak >= 3) color = 0x00ff88;
  else if (avgPeak >= 2) color = 0x00cc66;
  else if (avgPeak >= 1) color = 0xffd700;
  else color = 0xff4444;

  return {
    embeds: [{
      title: `📋  Top Calls — ${label}`,
      description: lines.join('\n'),
      color,
      footer: { text: `${entries.length} calls  ·  Ranked by ATH from entry` },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ── Trade exit embed ─────────────────────────────────────────

function buildTradeExitEmbed(trade: PaperTrade, exit: TradeExit) {
  const isWin = exit.reason !== 'stop_loss';
  const emoji = exit.reason === 'stop_loss' ? '🛑'
    : exit.reason === 'be_stop' ? '🔒'
    : exit.reason === 'trailing_stop' ? '🏁'
    : exit.reason === 'tp3' ? '🔥'
    : exit.reason === 'tp2' ? '🚀'
    : '💰';

  const pnlSoFar = trade.totalSolReturned - trade.entrySol;
  const pnlSign = pnlSoFar >= 0 ? '+' : '';

  const lines: string[] = [];
  lines.push(`> Sold **${(exit.pctSold * 100).toFixed(0)}%** of position at **${exit.multiplierAtExit.toFixed(2)}X**`);
  lines.push(`> Returned **+${exit.solReturned.toFixed(3)} SOL** from this exit`);
  lines.push('');
  lines.push(`📊  ${fmtUsd(trade.entryMC)} entry MC`);

  if (trade.status === 'closed') {
    const finalSign = (trade.finalPnlSol ?? 0) >= 0 ? '+' : '';
    lines.push(`💰  Final P&L: **${finalSign}${(trade.finalPnlSol ?? 0).toFixed(3)} SOL**`);
  } else {
    lines.push(`📈  Realized so far: **${pnlSign}${pnlSoFar.toFixed(3)} SOL**  ·  **${(trade.remainingPct * 100).toFixed(0)}%** still running`);
    if (trade.beStopArmed) {
      lines.push(`🔒  Stop loss moved to break-even`);
    }
    if (trade.trailingActive) {
      const trailingMult = (trade.trailingStopPrice / trade.entryPrice).toFixed(2);
      lines.push(`🏁  Trailing stop active at **${trailingMult}X**`);
    }
  }

  lines.push('');
  lines.push(linkRow(trade.mint));
  lines.push(`\`\`\`${trade.mint}\`\`\``);

  const color = isWin ? colorForMultiplier(exit.multiplierAtExit) : 0xff4444;

  const titlePnl = `${pnlSign}${pnlSoFar.toFixed(3)} SOL`;
  return {
    embeds: [{
      title: `${emoji}  $${trade.symbol} — ${exit.label}  (${titlePnl})`,
      description: lines.join('\n'),
      color,
      footer: { text: `Entry: ${CONFIG.PAPER_ENTRY_SOL} SOL  ·  ${trade.status === 'closed' ? 'Trade closed' : 'Position still open'}` },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ── Monthly leaderboard embed ────────────────────────────────

export interface MonthlyLeaderboardEntry {
  trade: PaperTrade;
  peakMultiplier: number;
  currentPnl: number;
}

/** Visual bar: ▓ filled, ░ empty */
function progressBar(value: number, max: number, width = 10): string {
  const filled = Math.round(Math.min(value / max, 1) * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

/** Simulated PnL for a CallRecord based on its peak multiplier (backtest estimate). */
function estimatePnl(peak: number): number {
  const sol = CONFIG.PAPER_ENTRY_SOL;
  // Walk through the TP ladder based on what peak was achieved
  let returned = 0;
  let remaining = 1.0;

  if (peak >= CONFIG.PAPER_TP1_MULT) {
    returned += CONFIG.PAPER_TP1_SELL * sol * CONFIG.PAPER_TP1_MULT;
    remaining -= CONFIG.PAPER_TP1_SELL;
  }
  if (peak >= CONFIG.PAPER_TP2_MULT) {
    returned += CONFIG.PAPER_TP2_SELL * sol * CONFIG.PAPER_TP2_MULT;
    remaining -= CONFIG.PAPER_TP2_SELL;
  }
  if (peak >= CONFIG.PAPER_TP3_MULT) {
    returned += CONFIG.PAPER_TP3_SELL * sol * CONFIG.PAPER_TP3_MULT;
    remaining -= CONFIG.PAPER_TP3_SELL;
    // Trailing stop would have caught the remaining at ~60% of ATH
    returned += remaining * sol * peak * (1 - CONFIG.PAPER_TRAILING_DROP);
    remaining = 0;
  }

  if (remaining > 0) {
    // Never hit 5X — price came back. Assume worst: SL hit.
    if (peak < CONFIG.PAPER_TP1_MULT) {
      returned += remaining * sol * CONFIG.PAPER_STOP_LOSS_PCT;  // -30% stop
    } else {
      // Hit 2X+ but not 5X — BE stop catches the rest
      returned += remaining * sol * 1.0;  // break-even on remaining
    }
  }

  return returned - sol;
}

function buildMonthlyLeaderboardEmbed(
  month: string,
  entries: MonthlyLeaderboardEntry[],
) {
  const sorted = [...entries].sort((a, b) => b.currentPnl - a.currentPnl);
  const top = sorted.slice(0, 10);
  const totalPnl = entries.reduce((s, e) => s + e.currentPnl, 0);
  const profitable = entries.filter(e => e.currentPnl > 0).length;
  const winRate = entries.length > 0 ? Math.round((profitable / entries.length) * 100) : 0;

  const lines: string[] = [];
  lines.push(`> **${entries.length}** calls tracked this month`);
  lines.push('');
  lines.push('**━━━━━━━━━  🏆  TOP 10  ━━━━━━━━━**');
  lines.push('');

  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  const maxPeak = top.length > 0 ? top[0].peakMultiplier : 1;

  for (let i = 0; i < top.length; i++) {
    const e = top[i];
    const medal = medals[i];
    const peak = e.peakMultiplier;
    const pnlSign = e.currentPnl >= 0 ? '+' : '';
    const bar = progressBar(peak, Math.max(maxPeak, 2), 12);
    const status = e.trade.status === 'open' ? '  🔴 *live*' : '';
    lines.push(`${medal}  **$${e.trade.symbol}**  ·  **${peak.toFixed(1)}X** ATH${status}`);
    lines.push(`      ${fmtUsd(e.trade.entryMC)} → ${fmtUsd(e.trade.entryMC * peak)} MC  ·  \`${bar}\`  ·  **${pnlSign}${e.currentPnl.toFixed(2)} SOL**`);
  }

  if (entries.length > 10) {
    lines.push('');
    lines.push(`*... and ${entries.length - 10} more calls*`);
  }

  // ── Stats section ──
  const hit2x = entries.filter(e => e.peakMultiplier >= 2).length;
  const hit5x = entries.filter(e => e.peakMultiplier >= 5).length;
  const hit10x = entries.filter(e => e.peakMultiplier >= 10).length;
  const avgPeak = entries.length > 0
    ? entries.reduce((s, e) => s + e.peakMultiplier, 0) / entries.length
    : 0;

  lines.push('');
  lines.push('**━━━━━━━━  📊  STATS  ━━━━━━━━━**');
  lines.push('');
  lines.push('```');
  lines.push(`  Total Calls     ${String(entries.length).padStart(6)}`);
  lines.push(`  Hit 2X+         ${String(hit2x).padStart(4)}  (${Math.round((hit2x / entries.length) * 100)}%)`);
  lines.push(`  Hit 5X+         ${String(hit5x).padStart(4)}  (${Math.round((hit5x / entries.length) * 100)}%)`);
  lines.push(`  Hit 10X+        ${String(hit10x).padStart(4)}  (${Math.round((hit10x / entries.length) * 100)}%)`);
  lines.push(`  Avg Peak        ${avgPeak.toFixed(1).padStart(5)}X`);
  lines.push(`  Win Rate (2X+)  ${String(winRate).padStart(4)}%`);
  lines.push('```');

  const totalSign = totalPnl >= 0 ? '+' : '';
  lines.push(`💰  Month P&L: **${totalSign}${totalPnl.toFixed(2)} SOL** simulated (1 SOL/trade)`);
  if (top.length > 0) {
    const best = top[0];
    lines.push(`🏆  Best: **$${best.trade.symbol}** peaked at **${best.peakMultiplier.toFixed(1)}X** (${pnlSign(best.currentPnl)}${best.currentPnl.toFixed(2)} SOL)`);
  }

  const color = totalPnl >= 5 ? 0x00ff88 : totalPnl >= 0 ? 0xffd700 : 0xff4444;

  return {
    embeds: [{
      title: `📅  ${month} — Monthly Report`,
      description: lines.join('\n'),
      color,
      footer: { text: `Simulated 1 SOL/trade  ·  Ranked by P&L  ·  ${new Date().toLocaleDateString('en-US', { timeZone: 'UTC' })}` },
      timestamp: new Date().toISOString(),
    }],
  };
}

function pnlSign(n: number): string {
  return n >= 0 ? '+' : '';
}

/** Build the monthly report from raw CallRecords (for months before paper trading started). */
function buildMonthlyReportFromCalls(
  month: string,
  calls: CallRecord[],
) {
  const sorted = [...calls].sort((a, b) => b.peakMultiplier - a.peakMultiplier);
  const top = sorted.slice(0, 10);

  const totalCalls = calls.length;
  const hit2x = calls.filter(c => c.peakMultiplier >= 2).length;
  const hit3x = calls.filter(c => c.peakMultiplier >= 3).length;
  const hit5x = calls.filter(c => c.peakMultiplier >= 5).length;
  const hit10x = calls.filter(c => c.peakMultiplier >= 10).length;
  const avgPeak = totalCalls > 0
    ? calls.reduce((s, c) => s + c.peakMultiplier, 0) / totalCalls
    : 0;
  const totalSimPnl = calls.reduce((s, c) => s + estimatePnl(c.peakMultiplier), 0);
  const profitable = calls.filter(c => estimatePnl(c.peakMultiplier) > 0).length;
  const winRate = totalCalls > 0 ? Math.round((profitable / totalCalls) * 100) : 0;
  const maxPeak = top.length > 0 ? top[0].peakMultiplier : 1;

  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

  const lines: string[] = [];
  lines.push(`> **${totalCalls}** calls tracked  ·  1 SOL per entry simulated`);
  lines.push('');
  lines.push('**━━━━━━━━━  🏆  TOP 10  ━━━━━━━━━**');
  lines.push('');

  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    const medal = medals[i];
    const peak = c.peakMultiplier;
    const pnl = estimatePnl(peak);
    const sign = pnl >= 0 ? '+' : '';
    const bar = progressBar(peak, Math.max(maxPeak, 2), 12);

    lines.push(`${medal}  **$${c.symbol}**  ·  **${peak.toFixed(1)}X** ATH`);
    lines.push(`      ${fmtUsd(c.entryMC)} → ${fmtUsd(c.peakMC)} MC  ·  \`${bar}\`  ·  **${sign}${pnl.toFixed(2)} SOL**`);
  }

  if (totalCalls > 10) {
    lines.push('');
    lines.push(`*... and ${totalCalls - 10} more calls*`);
  }

  // ── Stats ──
  lines.push('');
  lines.push('**━━━━━━━━  📊  STATS  ━━━━━━━━━**');
  lines.push('');
  lines.push('```');
  lines.push(`  Total Calls     ${String(totalCalls).padStart(6)}`);
  lines.push(`  Hit 2X+         ${String(hit2x).padStart(4)}  (${totalCalls > 0 ? Math.round((hit2x / totalCalls) * 100) : 0}%)`);
  lines.push(`  Hit 3X+         ${String(hit3x).padStart(4)}  (${totalCalls > 0 ? Math.round((hit3x / totalCalls) * 100) : 0}%)`);
  lines.push(`  Hit 5X+         ${String(hit5x).padStart(4)}  (${totalCalls > 0 ? Math.round((hit5x / totalCalls) * 100) : 0}%)`);
  lines.push(`  Hit 10X+        ${String(hit10x).padStart(4)}  (${totalCalls > 0 ? Math.round((hit10x / totalCalls) * 100) : 0}%)`);
  lines.push(`  Avg Peak        ${avgPeak.toFixed(1).padStart(5)}X`);
  lines.push(`  Win Rate (2X+)  ${String(winRate).padStart(4)}%`);
  lines.push('```');

  const totalSign = totalSimPnl >= 0 ? '+' : '';
  lines.push(`💰  Sim. P&L: **${totalSign}${totalSimPnl.toFixed(2)} SOL** from ${totalCalls} trades`);
  if (top.length > 0) {
    lines.push(`🏆  Best: **$${top[0].symbol}** peaked at **${top[0].peakMultiplier.toFixed(1)}X** (${fmtUsd(top[0].entryMC)} → ${fmtUsd(top[0].peakMC)})`);
  }

  const color = totalSimPnl >= 5 ? 0x00ff88 : totalSimPnl >= 0 ? 0xffd700 : 0xff4444;

  return {
    embeds: [{
      title: `📅  ${month} — Monthly Report`,
      description: lines.join('\n'),
      color,
      footer: { text: `Simulated 1 SOL/trade  ·  Ranked by ATH peak  ·  ${new Date().toLocaleDateString('en-US', { timeZone: 'UTC' })}` },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ── Public API ──────────────────────────────────────────────

export async function sendAlert(
  coin: PumpFunCoin,
  market: MarketData,
): Promise<string | null> {
  try {
    const body = buildAlertEmbed(coin, market);
    const res = await fetch(`${CONFIG.DISCORD_WEBHOOK}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[Discord] Send failed ${res.status}: ${await res.text()}`);
      return null;
    }
    const data: any = await res.json();
    return data.id ?? null;
  } catch (err: any) {
    console.error(`[Discord] Send error: ${err.message}`);
    return null;
  }
}

export async function updateWithPerformance(
  messageId: string,
  coin: PumpFunCoin,
  entryMarket: MarketData,
  snapshots: PerformanceSnapshot[],
): Promise<void> {
  try {
    const body = buildAlertEmbed(coin, entryMarket, snapshots);
    const res = await fetch(`${CONFIG.DISCORD_WEBHOOK}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[Discord] Update failed ${res.status}: ${await res.text()}`);
    }
  } catch (err: any) {
    console.error(`[Discord] Update error: ${err.message}`);
  }
}

export async function sendMilestoneAlert(
  rec: CallRecord,
  multiplier: number,
  currentPrice: number,
  currentMC: number,
): Promise<string | null> {
  try {
    const body = buildMilestoneEmbed(rec, multiplier, currentPrice, currentMC);
    const res = await fetch(`${CONFIG.DISCORD_WEBHOOK}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[Discord] Milestone send failed ${res.status}: ${await res.text()}`);
      return null;
    }
    const data: any = await res.json();
    return data.id ?? null;
  } catch (err: any) {
    console.error(`[Discord] Milestone send error: ${err.message}`);
    return null;
  }
}

export async function sendLeaderboard(label: string, entries: LeaderboardEntry[]): Promise<string | null> {
  try {
    const body = buildLeaderboardEmbed(label, entries);
    const res = await fetch(`${CONFIG.DISCORD_WEBHOOK}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[Discord] Leaderboard send failed ${res.status}: ${await res.text()}`);
      return null;
    }
    const data: any = await res.json();
    return data.id ?? null;
  } catch (err: any) {
    console.error(`[Discord] Leaderboard send error: ${err.message}`);
    return null;
  }
}

export async function sendTradeExit(trade: PaperTrade, exit: TradeExit): Promise<string | null> {
  try {
    const body = buildTradeExitEmbed(trade, exit);
    const res = await fetch(`${CONFIG.DISCORD_WEBHOOK}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[Discord] TradeExit send failed ${res.status}: ${await res.text()}`);
      return null;
    }
    const data: any = await res.json();
    return data.id ?? null;
  } catch (err: any) {
    console.error(`[Discord] TradeExit send error: ${err.message}`);
    return null;
  }
}

export async function sendMonthlyLeaderboard(
  month: string,
  entries: MonthlyLeaderboardEntry[],
): Promise<string | null> {
  try {
    const body = buildMonthlyLeaderboardEmbed(month, entries);
    const res = await fetch(`${CONFIG.DISCORD_WEBHOOK}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[Discord] MonthlyLB send failed ${res.status}: ${await res.text()}`);
      return null;
    }
    const data: any = await res.json();
    return data.id ?? null;
  } catch (err: any) {
    console.error(`[Discord] MonthlyLB send error: ${err.message}`);
    return null;
  }
}

/** Send a monthly report built from raw CallRecords. */
export async function sendMonthlyReportFromCalls(
  month: string,
  calls: CallRecord[],
): Promise<string | null> {
  try {
    const body = buildMonthlyReportFromCalls(month, calls);
    const res = await fetch(`${CONFIG.DISCORD_WEBHOOK}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[Discord] MonthlyReport send failed ${res.status}: ${await res.text()}`);
      return null;
    }
    const data: any = await res.json();
    return data.id ?? null;
  } catch (err: any) {
    console.error(`[Discord] MonthlyReport send error: ${err.message}`);
    return null;
  }
}
