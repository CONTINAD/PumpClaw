/**
 * Discord slash-command interactions — /mog <ca> PnL card.
 * Served over HTTP (the dashboard server hosts POST /interactions), signature-verified
 * with the app's Ed25519 public key. No gateway connection needed.
 */
import { createPublicKey, verify as cryptoVerify } from 'crypto';
import { readFileSync } from 'fs';
import { CONFIG } from './config.js';
import { fmtUsd } from './discord.js';
import { renderPnlCard, renderLeaderboardCard, type BoardEntry } from './pnl-card.js';
import type { CallRecord } from './tracker.js';

// ── Signature verification (Ed25519, no external deps) ──────

export function verifyInteractionSignature(signatureHex: string, timestamp: string, rawBody: string): boolean {
  if (!CONFIG.DISCORD_APP_PUBLIC_KEY || !signatureHex || !timestamp) return false;
  try {
    // Wrap the raw 32-byte key in a DER SPKI header so node crypto accepts it
    const der = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(CONFIG.DISCORD_APP_PUBLIC_KEY, 'hex'),
    ]);
    const key = createPublicKey({ key: der as any, format: 'der', type: 'spki' });
    return (cryptoVerify as any)(null, Buffer.from(timestamp + rawBody), key, Buffer.from(signatureHex, 'hex')) === true;
  } catch {
    return false;
  }
}

// ── /mog PnL card ───────────────────────────────────────────

function loadCalls(): CallRecord[] {
  try { return JSON.parse(readFileSync(CONFIG.DATA_FILE, 'utf-8')); } catch { return []; }
}

function gainBar(mult: number): string {
  // 10-segment bar scaled to 10X (full bar = 10X+)
  const filled = Math.max(0, Math.min(10, Math.round(mult)));
  const block = mult >= 1 ? '🟩' : '🟥';
  return block.repeat(Math.max(filled, 1)) + '⬛'.repeat(10 - Math.max(filled, 1));
}

function cardColor(mult: number): number {
  if (mult >= 50) return 0xff00ff;
  if (mult >= 10) return 0xe91e63;
  if (mult >= 5) return 0x00e5ff;
  if (mult >= 2) return 0x00ff88;
  if (mult >= 1) return 0xffd700;
  return 0xff4444;
}

async function buildMogCard(ca: string): Promise<any> {
  const mint = ca.trim().replace(/[^A-Za-z0-9]/g, '');
  const rec = loadCalls().find(c => c.mint === mint);
  if (!rec) {
    return {
      content: `❌ \`${mint.slice(0, 12)}…\` isn't a PumpClaw call — /mog only flexes coins we called.`,
      flags: 64, // ephemeral
    };
  }

  // Live data (best effort, keep under Discord's 3s deadline)
  let currentMC = 0, currentPrice = 0;
  try {
    const res = await fetch(`${CONFIG.DEXSCREENER_API}/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(2000) });
    const d: any = await res.json();
    const pair = (d.pairs ?? []).sort((a: any, b: any) => (+b.volume?.h24 || 0) - (+a.volume?.h24 || 0))[0];
    if (pair) { currentMC = +pair.marketCap || +pair.fdv || 0; currentPrice = +pair.priceUsd || 0; }
  } catch { /* card falls back to stored data */ }

  const peakMult = Math.max(rec.peakMultiplier ?? 1, currentPrice > 0 && rec.entryPrice > 0 ? currentPrice / rec.entryPrice : 0);
  const curMult = currentPrice > 0 && rec.entryPrice > 0 ? currentPrice / rec.entryPrice : null;
  const peakPct = (peakMult - 1) * 100;
  const peakMC = Math.max(rec.peakMC ?? 0, currentMC);
  const since = Date.now() - rec.entryTime;
  const mins = Math.floor(since / 60_000);
  const ageStr = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${Math.floor(mins / 1440)}d`;

  const emoji = peakMult >= 10 ? '💎' : peakMult >= 5 ? '🔥' : peakMult >= 2 ? '🚀' : peakMult >= 1 ? '📈' : '💀';
  const colorCode = peakMult >= 1 ? '2;32' : '2;31'; // ansi green / red

  const lines: string[] = [];
  lines.push('```ansi');
  lines.push(`[${colorCode}m[1m  ${peakMult.toFixed(2)}X   ${peakPct >= 0 ? '+' : ''}${peakPct.toFixed(1)}%[0m`);
  lines.push('```');
  lines.push(gainBar(peakMult));
  lines.push('');
  lines.push(`📊  **${fmtUsd(rec.entryMC)}**  →  **${fmtUsd(peakMC)}** MC *(peak)*`);
  if (curMult !== null && currentMC > 0) {
    lines.push(`${curMult >= 1 ? '🟢' : '🔴'}  now **${curMult.toFixed(2)}X**  ·  MC ${fmtUsd(currentMC)}`);
  }
  lines.push(`⏰  called **${ageStr}** ago`);
  lines.push('');
  lines.push(`[DexScreener](https://dexscreener.com/solana/${mint})  ·  [Pump.fun](https://pump.fun/${mint})`);
  lines.push(`\`${mint}\``);

  return {
    embeds: [{
      author: { name: 'PumpClaw · PnL', icon_url: 'https://pump.fun/icon.png' },
      title: `${emoji}  ${rec.name}  ($${rec.symbol})`,
      description: lines.join('\n'),
      color: cardColor(peakMult),
      ...(rec.imageUri ? { thumbnail: { url: rec.imageUri } } : {}),
      footer: { text: `PumpClaw called at ${fmtUsd(rec.entryMC)} MC  ·  peak ${peakMult.toFixed(2)}X` },
      timestamp: new Date(rec.entryTime).toISOString(),
    }],
  };
}


// ── /mogboard leaderboard ───────────────────────────────────

/**
 * Windows the board can be asked for.
 *
 * Four options meant the shortest question you could ask was "the last 24 hours",
 * which on a 40-call day averages a good hour into a bad one and on a 4-call night
 * is mostly empty. The short end is where the board actually gets used — right after
 * a run, to see what just happened — so that is where the resolution went.
 *
 * 'today' is not a duration: it is midnight UTC to now. It answers a different
 * question from '24h' ("how has the session gone" vs "the last day") and the two
 * disagree most of the time, which is the point of having both.
 */
const WINDOWS: Record<string, { label: string; ms: number; sinceMidnight?: boolean }> = {
  '1h':    { label: 'last hour',      ms: 3600_000 },
  '3h':    { label: 'last 3 hours',   ms: 3 * 3600_000 },
  '6h':    { label: 'last 6 hours',   ms: 6 * 3600_000 },
  '12h':   { label: 'last 12 hours',  ms: 12 * 3600_000 },
  'today': { label: 'today (UTC)',    ms: 0, sinceMidnight: true },
  '24h':   { label: 'last 24 hours',  ms: 24 * 3600_000 },
  '3d':    { label: 'last 3 days',    ms: 3 * 24 * 3600_000 },
  '7d':    { label: 'last 7 days',    ms: 7 * 24 * 3600_000 },
  '30d':   { label: 'last 30 days',   ms: 30 * 24 * 3600_000 },
  'all':   { label: 'all time',       ms: Number.MAX_SAFE_INTEGER },
};

const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

/** Pad to a visual width — Discord's ansi block is monospaced. */
function pad(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + ' '.repeat(width - str.length);
}

function selectBoard(window: string) {
  const win = WINDOWS[window] ?? WINDOWS['24h'];
  const cutoff = win.sinceMidnight
    ? Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
    : win.ms === Number.MAX_SAFE_INTEGER ? 0 : Date.now() - win.ms;
  const inWindow = loadCalls().filter(c => c.entryTime >= cutoff);
  if (inWindow.length === 0) return null;

  const ranked = [...inWindow].sort((a, b) => (b.peakMultiplier ?? 1) - (a.peakMultiplier ?? 1));
  // Aggregates over the whole window, not just the podium — the top 5 alone
  // would flatter any window, however bad the rest of it was.
  const doubles = inWindow.filter(c => (c.peakMultiplier ?? 1) >= 2).length;
  const median = [...inWindow].sort((a, b) => (a.peakMultiplier ?? 1) - (b.peakMultiplier ?? 1))
    [Math.floor(inWindow.length / 2)]?.peakMultiplier ?? 1;
  return { win, inWindow, ranked, top: ranked.slice(0, 5), doubles, median };
}

function buildLeaderboard(window: string): any {
  const sel = selectBoard(window);
  if (!sel) {
    const win = WINDOWS[window] ?? WINDOWS['24h'];
    return { content: `No PumpClaw calls in the ${win.label}.`, flags: 64 };
  }
  const { win, inWindow, ranked, top, doubles, median } = sel;
  const best = ranked[0]?.peakMultiplier ?? 1;

  const rows: string[] = ['```ansi'];
  top.forEach((c, i) => {
    const mult = c.peakMultiplier ?? 1;
    const pct = (mult - 1) * 100;
    // green for a winner, red for a call that never went up
    const color = mult >= 2 ? '2;32' : mult >= 1 ? '2;33' : '2;31';
    const bold = i === 0 ? '\u001b[1m' : '';
    rows.push(`\u001b[${color}m${bold}${pad(`${i + 1}. $${c.symbol}`, 18)}` +
      `${pad(`${mult.toFixed(2)}X`, 9)}${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%\u001b[0m`);
  });
  rows.push('```');

  const detail = top.map((c, i) => {
    const mult = c.peakMultiplier ?? 1;
    return `${MEDALS[i]}  **$${c.symbol}** · ${fmtUsd(c.entryMC)} → **${fmtUsd(c.peakMC ?? c.entryMC)}**  ` +
      `\`${mult.toFixed(2)}X\``;
  }).join('\n');

  return {
    embeds: [{
      author: { name: 'PumpClaw · Leaderboard' },
      title: `🏆  Top 5 mogs — ${win.label}`,
      description: [
        rows.join('\n'),
        detail,
        '',
        `📊  **${inWindow.length}** calls  ·  **${doubles}** hit 2X+ (${Math.round(doubles / inWindow.length * 100)}%)  ` +
        `·  median **${median.toFixed(2)}X**`,
      ].join('\n'),
      color: cardColor(best),
      ...(top[0]?.imageUri ? { thumbnail: { url: top[0].imageUri } } : {}),
      footer: { text: `Ranked by peak multiple since the call  ·  ${win.label}` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/** Render the PNG card and attach it to the deferred interaction response. */
async function followUpWithCard(token: string, mint: string): Promise<void> {
  const url = `https://discord.com/api/v10/webhooks/${CONFIG.DISCORD_APP_ID}/${token}/messages/@original`;
  try {
    const rec = loadCalls().find(c => c.mint === mint)!;

    // Live refresh for peak (best effort)
    let currentMC = 0, currentPrice = 0;
    try {
      const res = await fetch(`${CONFIG.DEXSCREENER_API}/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(2500) });
      const d: any = await res.json();
      const pair = (d.pairs ?? []).sort((a: any, b: any) => (+b.volume?.h24 || 0) - (+a.volume?.h24 || 0))[0];
      if (pair) { currentMC = +pair.marketCap || +pair.fdv || 0; currentPrice = +pair.priceUsd || 0; }
    } catch {}

    const peakMult = Math.max(rec.peakMultiplier ?? 1, currentPrice > 0 && rec.entryPrice > 0 ? currentPrice / rec.entryPrice : 0);
    const peakMC = Math.max(rec.peakMC ?? 0, currentMC);

    const png = await renderPnlCard({ rec, peakMult, peakMC, imageUrl: rec.imageUri });

    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ attachments: [{ id: 0, filename: 'pumpclaw-pnl.png' }] }));
    fd.append('files[0]', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'pumpclaw-pnl.png');
    const res = await fetch(url, { method: 'PATCH', body: fd });
    if (!res.ok) console.error(`[Interactions] Card follow-up failed ${res.status}: ${await res.text()}`);
  } catch (err: any) {
    console.error(`[Interactions] Card render error: ${err.message}`);
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `Card generation failed: ${err.message}` }),
    }).catch(() => {});
  }
}

/**
 * Render the leaderboard PNG and attach it to the deferred response.
 *
 * Deferred rather than inline: five coin images are fetched to draw the card, and
 * that will not reliably finish inside Discord's 3-second window.
 */
async function followUpWithBoard(token: string, window: string): Promise<void> {
  const url = `https://discord.com/api/v10/webhooks/${CONFIG.DISCORD_APP_ID}/${token}/messages/@original`;
  try {
    const sel = selectBoard(window);
    if (!sel) {
      const win = WINDOWS[window] ?? WINDOWS['24h'];
      await fetch(url, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `No PumpClaw calls in the ${win.label}.` }),
      });
      return;
    }

    // Refresh peaks against the live market so a coin still running is not
    // ranked on a stale high-water mark.
    const entries: BoardEntry[] = await Promise.all(sel.top.map(async rec => {
      let peakMult = rec.peakMultiplier ?? 1;
      let peakMC = rec.peakMC ?? rec.entryMC;
      let imageUrl = rec.imageUri;
      try {
        const res = await fetch(`${CONFIG.DEXSCREENER_API}/latest/dex/tokens/${rec.mint}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(2500),
        });
        const d: any = await res.json();
        const pair = (d.pairs ?? [])
          .filter((p: any) => p.baseToken?.address === rec.mint && (p.liquidity?.usd ?? 0) >= 500)
          .sort((a: any, b: any) => (+b.volume?.h24 || 0) - (+a.volume?.h24 || 0))[0];
        if (pair) {
          const price = +pair.priceUsd || 0;
          const mc = +pair.marketCap || +pair.fdv || 0;
          if (price > 0 && rec.entryPrice > 0) peakMult = Math.max(peakMult, price / rec.entryPrice);
          if (mc > 0) peakMC = Math.max(peakMC, mc);
          if (!imageUrl && pair.info?.imageUrl) imageUrl = pair.info.imageUrl;
        }
      } catch { /* stored values are good enough */ }
      return { rec, peakMult, peakMC, imageUrl };
    }));
    entries.sort((a, b) => b.peakMult - a.peakMult);

    const png = await renderLeaderboardCard({
      entries,
      windowLabel: sel.win.label,
      totalCalls: sel.inWindow.length,
      doubles: sel.doubles,
      median: sel.median,
    });

    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ attachments: [{ id: 0, filename: 'pumpclaw-leaderboard.png' }] }));
    fd.append('files[0]', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'pumpclaw-leaderboard.png');
    const res = await fetch(url, { method: 'PATCH', body: fd });
    if (!res.ok) console.error(`[Interactions] Board follow-up failed ${res.status}: ${await res.text()}`);
  } catch (err: any) {
    console.error(`[Interactions] Board render error: ${err.message}`);
    // Fall back to the text board rather than leaving a dead "thinking..." message.
    await fetch(url, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildLeaderboard(window)),
    }).catch(() => {});
  }
}

/** Handle a verified interaction payload. Returns the JSON response body. */
export async function handleInteraction(payload: any): Promise<any> {
  if (payload.type === 1) return { type: 1 }; // PING → PONG

  if (payload.type === 2 && payload.data?.name === 'mog') {
    const ca = String(payload.data.options?.find((o: any) => o.name === 'ca')?.value ?? '');
    const mint = ca.trim().replace(/[^A-Za-z0-9]/g, '');
    const rec = loadCalls().find(c => c.mint === mint);
    if (!rec) {
      return { type: 4, data: { content: `❌ \`${mint.slice(0, 12)}…\` isn't a PumpClaw call — /mog only flexes coins we called.`, flags: 64 } };
    }
    // Defer, then attach the rendered PNG (image responses can't be inlined)
    followUpWithCard(payload.token, mint).catch(() => {});
    return { type: 5 }; // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  }

  if (payload.type === 2 && payload.data?.name === 'mogboard') {
    const win = String(payload.data.options?.find((o: any) => o.name === 'timeframe')?.value ?? '24h');
    followUpWithBoard(payload.token, win).catch(() => {});
    return { type: 5 }; // DEFERRED — the card needs longer than 3s to draw
  }

  return { type: 4, data: { content: 'Unknown command', flags: 64 } };
}

/** Idempotent slash-command registration (needs DISCORD_BOT_TOKEN). Called at startup. */
export async function registerSlashCommands(): Promise<void> {
  if (!CONFIG.DISCORD_BOT_TOKEN || !CONFIG.DISCORD_APP_ID) return;
  const cmd = [{
    name: 'mog',
    description: 'PnL flex card for a coin PumpClaw called',
    options: [{
      type: 3, name: 'ca', description: 'Contract address of the called coin', required: true,
    }],
  }, {
    name: 'mogboard',
    description: 'Top 5 PumpClaw calls by peak multiple',
    options: [{
      type: 3, name: 'timeframe', description: 'How far back to rank (default 24h)', required: false,
      choices: [
        { name: 'Last hour', value: '1h' },
        { name: 'Last 3 hours', value: '3h' },
        { name: 'Last 6 hours', value: '6h' },
        { name: 'Last 12 hours', value: '12h' },
        { name: 'Today (since UTC midnight)', value: 'today' },
        { name: 'Last 24 hours', value: '24h' },
        { name: 'Last 3 days', value: '3d' },
        { name: 'Last 7 days', value: '7d' },
        { name: 'Last 30 days', value: '30d' },
        { name: 'All time', value: 'all' },
      ],
    }],
  }];
  const targets: { label: string; url: string }[] = [
    { label: 'global', url: `https://discord.com/api/v10/applications/${CONFIG.DISCORD_APP_ID}/commands` },
  ];
  // Register to the guild as well. Global commands can take an hour to reach
  // clients; the guild copy is live immediately, so a new command works the
  // moment it deploys instead of looking broken until Discord catches up.
  if (CONFIG.DISCORD_GUILD_ID) {
    targets.push({
      label: `guild ${CONFIG.DISCORD_GUILD_ID}`,
      url: `https://discord.com/api/v10/applications/${CONFIG.DISCORD_APP_ID}/guilds/${CONFIG.DISCORD_GUILD_ID}/commands`,
    });
  }

  for (const t of targets) {
    try {
      const res = await fetch(t.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}` },
        body: JSON.stringify(cmd),
      });
      if (res.ok) console.log(`[Interactions] ${cmd.map(c => '/' + c.name).join(' + ')} registered (${t.label})`);
      else console.error(`[Interactions] Registration failed for ${t.label} ${res.status}: ${await res.text()}`);
    } catch (err: any) {
      console.error(`[Interactions] Registration error for ${t.label}: ${err.message}`);
    }
  }
}
