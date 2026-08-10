/**
 * External call sources — copy-trade another caller's Discord channel.
 * Polls a channel over REST, extracts contract addresses from message content,
 * embeds and known trade-link URLs, applies per-source filters (max MC, max coin
 * age), then hands qualifying mints to tasks subscribed to that source.
 *
 * Requires MESSAGE CONTENT INTENT on the app (privileged) — without it Discord
 * returns empty content/embeds for other authors' messages.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG } from './config.js';

const SOURCES_FILE = join(CONFIG.DATA_DIR, 'sources.json');

export interface CallSource {
  id: string;
  name: string;
  channelId: string;
  maxMc: number;         // skip calls above this market cap (0 = no cap)
  maxAgeHours: number;   // skip coins older than this (0 = no age limit)
  enabled: boolean;
  mirrorExits?: boolean; // when the caller posts a SELL for a coin we hold, exit too
}

/** Built-in source: PumpClaw's own scanner. Always present, not editable. */
export const PUMPCLAW_SOURCE_ID = 'pumpclaw';

const DEFAULT_SOURCES: CallSource[] = [
  { id: 'zeus', name: 'Zeus calls', channelId: '1490766730220535878', maxMc: 40_000, maxAgeHours: 24, enabled: true, mirrorExits: true },
];

class SourceRegistry {
  private sources = new Map<string, CallSource>();

  constructor() {
    try {
      const data: CallSource[] = JSON.parse(readFileSync(SOURCES_FILE, 'utf-8'));
      for (const s of data) this.sources.set(s.id, s);
    } catch {
      for (const s of DEFAULT_SOURCES) this.sources.set(s.id, s);
      this.save();
    }
  }

  private save(): void {
    mkdirSync(CONFIG.DATA_DIR, { recursive: true });
    writeFileSync(SOURCES_FILE, JSON.stringify([...this.sources.values()], null, 2));
  }

  all(): CallSource[] { return [...this.sources.values()]; }
  get(id: string): CallSource | undefined { return this.sources.get(id); }
  enabled(): CallSource[] { return this.all().filter(s => s.enabled); }

  update(id: string, patch: Partial<CallSource>): CallSource | undefined {
    const s = this.sources.get(id);
    if (!s) return undefined;
    Object.assign(s, patch, { id: s.id });
    this.save();
    return s;
  }
}

export const sourceRegistry = new SourceRegistry();

// ── Mint extraction ─────────────────────────────────────────

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
// Suffixed launchpad mints are unambiguous; plain base58 needs URL context
const SUFFIXED_RE = new RegExp(`${BASE58}{32,44}(?:pump|bonk|moon)`, 'g');
const LINK_RE = new RegExp(
  `(?:dexscreener\\.com/solana/|pump\\.fun/(?:coin/)?|gmgn\\.ai/sol/token/(?:[\\w]+_)?|axiom\\.trade/t/|photon-sol\\.tinyastro\\.io/en/lp/|bullx\\.io/terminal\\?[^ ]*address=|solscan\\.io/token/|birdeye\\.so/token/)(${BASE58}{32,44})`,
  'g',
);

/** Classify a caller's message. Callers like Signal Vault post BOTH entries and
 *  exits in the same channel — buying on a 'Sell!' message is exactly backwards. */
export type SignalKind = 'buy' | 'sell' | 'unknown';

export function classifySignal(msg: any): SignalKind {
  const chunks: string[] = [msg.content ?? ''];
  for (const e of msg.embeds ?? []) {
    for (const v of [e.title, e.description, e.author?.name, e.footer?.text]) {
      if (typeof v === 'string') chunks.push(v);
    }
    for (const f of e.fields ?? []) chunks.push(`${f.name ?? ''} ${f.value ?? ''}`);
  }
  const text = chunks.join(' ').toLowerCase();
  const sell = /\bsell(?:ing|s|!)?\b|\bexit(?:ed|ing)?\b|took profit|closed position|\bsold\b/.test(text);
  const buy = /\bbuy(?:ing|s|!)?\b|\bbought\b|\bentry\b|\bentered\b|\bape\b|\blong\b|new call/.test(text);
  if (sell && !buy) return 'sell';
  if (buy && !sell) return 'buy';
  if (buy && sell) return 'buy';   // ambiguous → treat as entry, filters still apply
  return 'unknown';                 // bare CA post = a call
}

/** Pull every plausible Solana mint out of a Discord message (content + embeds). */
export function extractMints(msg: any): string[] {
  const chunks: string[] = [];
  if (msg.content) chunks.push(msg.content);
  for (const e of msg.embeds ?? []) {
    for (const v of [e.title, e.description, e.url, e.author?.name, e.author?.url, e.footer?.text]) {
      if (typeof v === 'string') chunks.push(v);
    }
    for (const f of e.fields ?? []) {
      if (f.name) chunks.push(f.name);
      if (f.value) chunks.push(f.value);
    }
  }
  for (const c of msg.components ?? []) {
    for (const child of c.components ?? []) {
      if (child.url) chunks.push(child.url);
      if (child.label) chunks.push(child.label);
    }
  }

  const text = chunks.join('\n');
  const found = new Set<string>();
  for (const m of text.matchAll(SUFFIXED_RE)) found.add(m[0]);
  for (const m of text.matchAll(LINK_RE)) found.add(m[1]);
  return [...found];
}
