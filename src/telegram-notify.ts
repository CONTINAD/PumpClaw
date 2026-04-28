import { CONFIG } from './config.js';
import type { PumpFunCoin } from './pumpfun.js';
import type { MarketData } from './dexscreener.js';
import type { PerformanceSnapshot, CallRecord } from './tracker.js';
import type { PaperTrade, TradeExit } from './paper-trader.js';
import type { LeaderboardEntry, MonthlyLeaderboardEntry } from './discord.js';
import { fmtUsd, fmtPct } from './discord.js';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

function tgEnabled(): boolean {
  return TG_BOT_TOKEN.length > 0 && TG_CHAT_ID.length > 0;
}

async function sendTg(text: string, imageUrl?: string): Promise<void> {
  if (!tgEnabled()) return;

  try {
    if (imageUrl) {
      const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          photo: imageUrl,
          caption: text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (res.ok) return;
      // Photo failed (maybe URL is bad) — fall through to text-only
    }

    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err: any) {
    console.error(`[Telegram] Send error: ${err.message}`);
  }
}

// ── Helpers ──

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

function links(mint: string): string {
  return [
    `<a href="https://pump.fun/${mint}">Pump.fun</a>`,
    `<a href="https://dexscreener.com/solana/${mint}">DexScreener</a>`,
    `<a href="https://gmgn.ai/sol/token/${mint}">GMGN</a>`,
    `<a href="https://axiom.trade/t/${mint}/@noose?chain=sol">Axiom</a>`,
    `<a href="https://trade.padre.gg/trade/solana/${mint}?rk=cache">Terminal</a>`,
  ].join('  ·  ');
}

// ── Startup message ──

export async function tgSendStartup(calls: CallRecord[]): Promise<void> {
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  const recent = calls.filter(c => c.entryTime >= sixHoursAgo);

  const lines: string[] = [];
  lines.push('🟢 <b>PumpClaw Online</b>');
  lines.push('');

  if (recent.length === 0) {
    lines.push('No calls in the last 6 hours.');
  } else {
    const sorted = [...recent].sort((a, b) => b.peakMultiplier - a.peakMultiplier);
    const top = sorted.slice(0, 5);
    const hit2x = recent.filter(c => c.peakMultiplier >= 2).length;
    const hit5x = recent.filter(c => c.peakMultiplier >= 5).length;
    const avgPeak = recent.reduce((s, c) => s + c.peakMultiplier, 0) / recent.length;

    lines.push(`<b>Last 6 Hours</b>`);
    lines.push(`${recent.length} calls  ·  ${hit2x} hit 2X+  ·  ${hit5x} hit 5X+  ·  ${avgPeak.toFixed(1)}X avg peak`);
    lines.push('');

    const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
    for (let i = 0; i < top.length; i++) {
      const c = top[i];
      const medal = medals[i];
      const icon = c.peakMultiplier >= 2 ? '🟩' : '🟥';
      lines.push(`${medal} ${icon} <b>$${c.symbol}</b>  ·  <b>${c.peakMultiplier.toFixed(1)}X</b> ATH  ·  ${fmtUsd(c.entryMC)} → ${fmtUsd(c.peakMC)}`);
    }
  }

  await sendTg(lines.join('\n'));
}

// ── Alert ──

export async function tgSendAlert(coin: PumpFunCoin, market: MarketData): Promise<void> {
  const lines: string[] = [];
  lines.push(`🔔 <b>${coin.name} ($${coin.symbol})</b>`);
  lines.push('');
  lines.push(`<b>${fmtUsd(market.volume5m)}</b> 5m vol  ·  <b>${fmtUsd(market.marketCap)}</b> MC`);

  const parts: string[] = [];
  if (market.buys5m + market.sells5m > 0) parts.push(`${market.buys5m}B/${market.sells5m}S`);
  if (market.priceChange5m !== 0) parts.push(`<b>${fmtPct(market.priceChange5m)}</b> 5m`);
  if (market.liquidity > 0) parts.push(`${fmtUsd(market.liquidity)} liq`);
  if (parts.length > 0) lines.push(parts.join('  ·  '));

  const infoParts: string[] = [];
  if (market.volume1h > 0) infoParts.push(`${fmtUsd(market.volume1h)} 1h vol`);
  const tokenAge = age(coin.created_timestamp);
  if (tokenAge) infoParts.push(`${tokenAge} old`);
  if (market.dexId) infoParts.push(market.dexId);
  if (infoParts.length > 0) lines.push(infoParts.join('  ·  '));

  lines.push('');
  lines.push(`<code>${coin.mint}</code>`);
  lines.push('');
  lines.push(links(coin.mint));

  await sendTg(lines.join('\n'), coin.image_uri || market.imageUrl);
}

// ── Alert with performance update ──

export async function tgUpdateAlert(
  coin: PumpFunCoin,
  entryMarket: MarketData,
  snapshots: PerformanceSnapshot[],
): Promise<void> {
  const lines: string[] = [];
  lines.push(`📊 <b>${coin.name} ($${coin.symbol}) — Update</b>`);
  lines.push('');
  lines.push(`Entry: <b>${fmtUsd(entryMarket.marketCap)}</b> MC`);
  lines.push('');

  for (const snap of snapshots) {
    const label = snap.intervalMin < 60 ? `${snap.intervalMin}m` : `${snap.intervalMin / 60}h`;
    const pricePct = ((snap.price - entryMarket.priceUsd) / entryMarket.priceUsd) * 100;
    const icon = pricePct >= 0 ? '🟩' : '🟥';
    lines.push(`${icon} <b>${label}</b>  <b>${fmtPct(pricePct)}</b>  ·  MC ${fmtUsd(snap.marketCap)}`);
  }

  lines.push('');
  lines.push(`<code>${coin.mint}</code>`);

  await sendTg(lines.join('\n'));
}

// ── Milestone ──

export async function tgSendMilestone(
  rec: CallRecord,
  multiplier: number,
  currentPrice: number,
  currentMC: number,
): Promise<void> {
  const emoji = multiplier >= 10 ? '💎' : multiplier >= 5 ? '🔥' : '🚀';
  // Use the peak (or current if higher) — coin often dips back before alert fires
  const peakPrice = Math.max(rec.peakPrice ?? 0, currentPrice);
  const peakMC = Math.max(rec.peakMC ?? 0, currentMC);
  const peakMult = Math.max(rec.peakMultiplier ?? multiplier, multiplier);
  const peakPctGain = ((peakPrice - rec.entryPrice) / rec.entryPrice) * 100;

  const lines: string[] = [];
  lines.push(`${emoji} <b>${rec.name} ($${rec.symbol}) hits ${multiplier}X!</b>`);
  lines.push('');
  lines.push(`<b>${multiplier}X</b> from call  ·  Peak: <b>${peakMult.toFixed(1)}X</b> (${fmtPct(peakPctGain)})`);
  lines.push(`📊 ${fmtUsd(rec.entryMC)} → <b>${fmtUsd(peakMC)}</b> MC <i>(top)</i>`);
  lines.push(`⏰ ${timeSince(rec.entryTime)} since call`);

  if (rec.hitMilestones.length > 0) {
    const journey = rec.hitMilestones.map(m => `<b>${m.multiplier}X</b>`).join(' → ');
    lines.push(`🏆 ${journey}`);
  }

  lines.push('');
  lines.push(`<code>${rec.mint}</code>`);
  lines.push('');
  lines.push(links(rec.mint));

  await sendTg(lines.join('\n'), rec.imageUri);
}

// ── Leaderboard ──

export async function tgSendLeaderboard(label: string, entries: LeaderboardEntry[]): Promise<void> {
  const sorted = [...entries].sort((a, b) => b.rec.peakMultiplier - a.rec.peakMultiplier);
  const top = sorted.slice(0, 10);
  const medals = ['🥇', '🥈', '🥉', '4.', '5.', '6.', '7.', '8.', '9.', '10.'];

  const profitable = entries.filter(e => e.rec.peakMultiplier >= 2).length;
  const avgPeak = entries.length > 0
    ? entries.reduce((s, e) => s + e.rec.peakMultiplier, 0) / entries.length
    : 0;

  const lines: string[] = [];
  lines.push(`📋 <b>Top Calls — ${label}</b>`);
  lines.push('');

  if (top.length === 0) {
    lines.push('<i>No calls in this period</i>');
  } else {
    for (let i = 0; i < top.length; i++) {
      const e = top[i];
      const medal = medals[i] ?? `${i + 1}.`;
      const peak = e.rec.peakMultiplier;
      const icon = peak >= 1 ? '🟩' : '🟥';
      const athMC = e.rec.peakMC > 0 ? e.rec.peakMC : e.currentMC;
      lines.push(`${medal} ${icon} <b>$${e.rec.symbol}</b>  ·  <b>${peak.toFixed(1)}X</b> ATH  ·  ${fmtUsd(e.rec.entryMC)} → ${fmtUsd(athMC)}`);
    }

    lines.push('');
    lines.push(`📊 <b>${entries.length}</b> calls  ·  <b>${profitable}</b> hit 2X+  ·  <b>${avgPeak.toFixed(1)}X</b> avg peak`);
  }

  await sendTg(lines.join('\n'));
}

// ── Trade exit ──

export async function tgSendTradeExit(trade: PaperTrade, exit: TradeExit): Promise<void> {
  const emoji = exit.reason === 'stop_loss' ? '🛑'
    : exit.reason === 'be_stop' ? '🔒'
    : exit.reason === 'trailing_stop' ? '🏁'
    : exit.reason === 'tp3' ? '🔥'
    : exit.reason === 'tp2' ? '🚀'
    : '💰';

  const pnlSoFar = trade.totalSolReturned - trade.entrySol;
  const pnlSign = pnlSoFar >= 0 ? '+' : '';

  const lines: string[] = [];
  lines.push(`${emoji} <b>$${trade.symbol} — ${exit.label}</b>  (${pnlSign}${pnlSoFar.toFixed(3)} SOL)`);
  lines.push('');
  lines.push(`Sold <b>${(exit.pctSold * 100).toFixed(0)}%</b> at <b>${exit.multiplierAtExit.toFixed(2)}X</b>`);
  lines.push(`+${exit.solReturned.toFixed(3)} SOL from this exit`);

  if (trade.status === 'closed') {
    const finalSign = (trade.finalPnlSol ?? 0) >= 0 ? '+' : '';
    lines.push(`💰 Final P&L: <b>${finalSign}${(trade.finalPnlSol ?? 0).toFixed(3)} SOL</b>`);
  } else {
    lines.push(`📈 Realized: <b>${pnlSign}${pnlSoFar.toFixed(3)} SOL</b>  ·  <b>${(trade.remainingPct * 100).toFixed(0)}%</b> still running`);
  }

  lines.push('');
  lines.push(`<code>${trade.mint}</code>`);

  await sendTg(lines.join('\n'));
}

// ── Monthly report ──

export async function tgSendMonthlyReport(month: string, entries: MonthlyLeaderboardEntry[]): Promise<void> {
  const sorted = [...entries].sort((a, b) => b.currentPnl - a.currentPnl);
  const top = sorted.slice(0, 10);
  const totalPnl = entries.reduce((s, e) => s + e.currentPnl, 0);
  const medals = ['🥇', '🥈', '🥉', '4.', '5.', '6.', '7.', '8.', '9.', '10.'];

  const lines: string[] = [];
  lines.push(`📅 <b>${month} — Monthly Report</b>`);
  lines.push(`<b>${entries.length}</b> calls tracked`);
  lines.push('');

  for (let i = 0; i < top.length; i++) {
    const e = top[i];
    const medal = medals[i];
    const pnlSign = e.currentPnl >= 0 ? '+' : '';
    lines.push(`${medal} <b>$${e.trade.symbol}</b>  ·  <b>${e.peakMultiplier.toFixed(1)}X</b> ATH  ·  <b>${pnlSign}${e.currentPnl.toFixed(2)} SOL</b>`);
  }

  const totalSign = totalPnl >= 0 ? '+' : '';
  lines.push('');
  lines.push(`💰 Month P&L: <b>${totalSign}${totalPnl.toFixed(2)} SOL</b>`);

  await sendTg(lines.join('\n'));
}
