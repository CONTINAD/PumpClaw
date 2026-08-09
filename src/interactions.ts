/**
 * Discord slash-command interactions — /mog <ca> PnL card.
 * Served over HTTP (the dashboard server hosts POST /interactions), signature-verified
 * with the app's Ed25519 public key. No gateway connection needed.
 */
import { createPublicKey, verify as cryptoVerify } from 'crypto';
import { readFileSync } from 'fs';
import { CONFIG } from './config.js';
import { fmtUsd } from './discord.js';
import { renderPnlCard } from './pnl-card.js';
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
  }];
  try {
    const res = await fetch(`https://discord.com/api/v10/applications/${CONFIG.DISCORD_APP_ID}/commands`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify(cmd),
    });
    if (res.ok) console.log('[Interactions] /mog slash command registered');
    else console.error(`[Interactions] Command registration failed ${res.status}: ${await res.text()}`);
  } catch (err: any) {
    console.error(`[Interactions] Command registration error: ${err.message}`);
  }
}
