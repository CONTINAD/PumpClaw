/**
 * Channel audit — does a Telegram channel earn its place in the scrape list?
 *
 * Coverage justified adding channels: three surface ~3x the mints of one. Coverage
 * is not quality. A channel posting twice as many coins that die twice as often has
 * made the bot worse while looking busier.
 *
 * Measures every mint a channel posts, not only the ones that survive our filters,
 * so it answers a different question from /api/channels: that page grades our calls,
 * this grades the feed itself.
 *
 * Recording and measuring are deliberately separate passes. t.me serves about twenty
 * posts spanning roughly an hour, so nothing on the page is ever old enough to judge —
 * measuring on sight would understate every peak, and unevenly, since channels post at
 * different rates.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG } from './config.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
const SNIPER = /Soul_Sniper_Bot\?start=\d+_\w+_([1-9A-HJ-NP-Za-km-z]{32,44})/g;
const PUMPMINT = /\b([1-9A-HJ-NP-Za-km-z]{28,40}pump)\b/g;
const MIN_AGE_MIN = 120;

export interface ChannelObs {
  channel: string; mint: string; postedAt: number;
  entry?: number; peak?: number; checked?: number; ageAtCheckMin?: number;
  /** Deepest point after the post. A peak is a maximum and cannot go below 1, so a
   *  "died" rate computed from it is structurally near-zero — which is exactly what
   *  the channel table showed (0-1% across every feed, for memecoins). The trough is
   *  the number that says whether a coin actually went to nothing. */
  trough?: number;
  /** Measurement version. v1 allowed a candle from up to 60s before the post, which
   *  gave fast movers an entry price from before they moved — 5 of 6 sampled rows
   *  were inflated, mean 3.40x against a corrected 2.95x. v1 rows are re-measured
   *  rather than mixed with v2 ones, because the bias is largest exactly on the
   *  coins that decide whether a channel looks good. */
  v?: number;
}
const MEASURE_VERSION = 2;

const FILE = () => join(CONFIG.DATA_DIR, 'channel-audit.json');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function loadObs(): ChannelObs[] {
  try { return JSON.parse(readFileSync(FILE(), 'utf-8')); } catch { return []; }
}
function saveObs(o: ChannelObs[]): void {
  try { mkdirSync(CONFIG.DATA_DIR, { recursive: true }); writeFileSync(FILE(), JSON.stringify(o)); } catch { /* non-critical */ }
}

/** GeckoTerminal rate-limits hard, and a swallowed 429 reads as "no data" — which
 *  once turned three quarters of a sample into phantom unmeasurables. */
async function gtFetch(url: string, tries = 4): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (r?.ok) return r.json();
    if (r?.status === 429) { await sleep(6000 * (i + 1)); continue; }
    return null;
  }
  return null;
}

async function scrape(channel: string): Promise<{ mint: string; postedAt: number }[]> {
  const res = await fetch(`https://t.me/s/${channel}`, { headers: UA, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const out: { mint: string; postedAt: number }[] = [];
  for (const b of html.split('tgme_widget_message ').slice(1)) {
    const dt = b.match(/datetime="([^"]+)"/)?.[1];
    if (!dt) continue;
    const ts = Date.parse(dt);
    if (!Number.isFinite(ts)) continue;
    for (const m of new Set([...b.matchAll(SNIPER)].map(x => x[1]).concat([...b.matchAll(PUMPMINT)].map(x => x[1])))) {
      out.push({ mint: m, postedAt: ts });
    }
  }
  return out;
}

async function outcome(mint: string, postedAt: number): Promise<{ entry: number; peak: number; trough: number } | null> {
  const ds: any = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { headers: UA, signal: AbortSignal.timeout(15_000) })
    .then(r => r.json()).catch(() => null);
  const pairs = (ds?.pairs ?? []).filter((p: any) => p.chainId === 'solana' && p.baseToken?.address === mint);
  if (!pairs.length) return { entry: 1, peak: 0, trough: 0 };   // no pool left — the coin is gone, which is an outcome
  const pair = pairs.sort((a: any, b: any) => (+b.volume?.h24 || 0) - (+a.volume?.h24 || 0))[0];
  const before = Math.floor(postedAt / 1000) + 6 * 3600;
  const gt = await gtFetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair.pairAddress}`
    + `/ohlcv/minute?aggregate=1&before_timestamp=${before}&limit=400&currency=usd`);
  // Strictly after the post.
  //
  // A minute candle stamped T covers [T, T+60s), so the candle containing the post
  // opened up to a minute before it. Allowing that candle in was meant to avoid
  // clock skew and instead handed fast movers an entry price from before they moved:
  // one coin was recorded at 2.68e-05 from this channel and 1.07e-04 from another
  // three minutes later, against our own reading of 8.99e-05 in between. Its peak
  // came out at 169x against a truer 42x.
  //
  // The bias is not random — it is largest on the coins that move fastest, which are
  // exactly the ones that decide whether a channel looks good.
  const after = ((gt?.data?.attributes?.ohlcv_list ?? []) as number[][])
    .map(r => ({ ts: r[0] * 1000, h: r[2], l: r[3], o: r[1], c: r[4] }))
    .filter(c => c.ts >= postedAt)
    .sort((a, b) => a.ts - b.ts);
  if (after.length < 3) return null;
  const entry = after[0].o || after[0].c;
  if (!(entry > 0)) return null;
  return {
    entry,
    peak: Math.max(...after.map(c => c.h)) / entry,
    trough: Math.min(...after.map(c => c.l)) / entry,
  };
}

/** One pass: record what is on the pages, then measure whatever has aged enough. */
export async function auditPass(channels: string[], budget = 25): Promise<{ recorded: number; measured: number; pending: number }> {
  const obs = loadObs();
  const seen = new Set(obs.map(o => `${o.channel}:${o.mint}`));
  let recorded = 0;

  for (const ch of channels) {
    let posts: { mint: string; postedAt: number }[];
    try { posts = await scrape(ch); }
    catch (err: any) { console.error(`[ChannelAudit] ${ch}: ${err.message}`); continue; }
    const byMint = new Map<string, { mint: string; postedAt: number }>();
    for (const p of posts.sort((a, b) => a.postedAt - b.postedAt)) if (!byMint.has(p.mint)) byMint.set(p.mint, p);
    for (const p of byMint.values()) {
      if (seen.has(`${ch}:${p.mint}`)) continue;
      obs.push({ channel: ch, mint: p.mint, postedAt: p.postedAt });
      seen.add(`${ch}:${p.mint}`);
      recorded++;
    }
  }

  // Unmeasured rows first, then v1 rows needing correction.
  const fresh = obs.filter(o => o.peak === undefined && (Date.now() - o.postedAt) / 60_000 >= MIN_AGE_MIN);
  const stale = obs.filter(o => o.peak !== undefined && (o.v ?? 1) < MEASURE_VERSION);
  const due = [...fresh, ...stale].slice(0, budget);
  let measured = 0;
  for (const o of due) {
    const r = await outcome(o.mint, o.postedAt);
    if (r) {
      o.entry = r.entry; o.peak = r.peak; o.trough = r.trough; o.checked = Date.now(); o.v = MEASURE_VERSION;
      o.ageAtCheckMin = Math.round((Date.now() - o.postedAt) / 60_000);
      measured++;
    }
    await sleep(4000);
  }

  // A month is enough to judge a channel and keeps the file small.
  const cut = Date.now() - 30 * 86400_000;
  saveObs(obs.filter(o => o.postedAt >= cut).slice(-6000));
  const pending = obs.filter(o => o.peak === undefined).length;
  if (recorded || measured) console.log(`[ChannelAudit] recorded ${recorded}, measured ${measured}, ${pending} pending`);
  return { recorded, measured, pending };
}
