/**
 * Channel backtest — is a Telegram channel worth scraping?
 *
 * Adding a source was justified on coverage: three channels surface ~3x the mints
 * of one. Coverage is not quality. A channel that posts twice as many coins and
 * whose coins die twice as often has made the bot worse while looking busier.
 *
 * For every mint a channel posted, this reconstructs what the coin actually did
 * from the post onward — GeckoTerminal minute candles, the same source the live
 * backtester uses — and reports hit rate, median peak and death rate per channel.
 *
 *   npx tsx scripts/channel-backtest.ts                  # all configured channels
 *   npx tsx scripts/channel-backtest.ts a,b,c            # specific handles
 *
 * The honest caveat is in the output: t.me/s only serves ~20 recent posts, so each
 * run sees a small and recent sample. Run it repeatedly over days and the samples
 * accumulate in the cache file rather than being thrown away.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = join(__dirname, '..', 'data', 'channel-backtest.json');

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
const SNIPER = /Soul_Sniper_Bot\?start=\d+_\w+_([1-9A-HJ-NP-Za-km-z]{32,44})/g;
const PUMPMINT = /\b([1-9A-HJ-NP-Za-km-z]{28,40}pump)\b/g;

interface Obs { channel: string; mint: string; postedAt: number; peak?: number; entry?: number; checked?: number; ageAtCheckMin?: number; }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * GeckoTerminal's free tier rate-limits hard, and a 429 is indistinguishable from
 * "no data" once the body is discarded — the first run of this script recorded
 * three quarters of its coins as unmeasurable when they were simply refused.
 */
async function gtFetch(url: string, tries = 4): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (r?.ok) return r.json();
    if (r?.status === 429) { await sleep(6000 * (i + 1)); continue; }
    return null;
  }
  return null;
}

/** Posts with their timestamps, so "what happened after" has a start point. */
async function scrape(channel: string): Promise<{ mint: string; postedAt: number }[]> {
  const res = await fetch(`https://t.me/s/${channel}`, { headers: UA, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Each message block carries its own datetime; associate a mint with the block it sits in.
  const blocks = html.split('tgme_widget_message ').slice(1);
  const out: { mint: string; postedAt: number }[] = [];
  for (const b of blocks) {
    const dt = b.match(/datetime="([^"]+)"/)?.[1];
    if (!dt) continue;
    const ts = Date.parse(dt);
    if (!Number.isFinite(ts)) continue;
    const mints = new Set([...b.matchAll(SNIPER)].map(m => m[1]).concat([...b.matchAll(PUMPMINT)].map(m => m[1])));
    for (const m of mints) out.push({ mint: m, postedAt: ts });
  }
  return out;
}

/** What the coin did after it was posted, from minute candles. */
async function outcome(mint: string, postedAt: number): Promise<{ entry: number; peak: number } | null> {
  const ds: any = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { headers: UA, signal: AbortSignal.timeout(15_000) })
    .then(r => r.json()).catch(() => null);
  const pairs = (ds?.pairs ?? []).filter((p: any) => p.chainId === 'solana' && p.baseToken?.address === mint);
  if (!pairs.length) return { entry: 1, peak: 0 };   // no pool at all — the coin is gone
  const pair = pairs.sort((a: any, b: any) => (+b.volume?.h24 || 0) - (+a.volume?.h24 || 0))[0];

  const before = Math.floor(postedAt / 1000) + 6 * 3600;
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair.pairAddress}`
    + `/ohlcv/minute?aggregate=1&before_timestamp=${before}&limit=400&currency=usd`;
  const gt: any = await gtFetch(url);
  const list: number[][] = gt?.data?.attributes?.ohlcv_list ?? [];
  const after = list.map(r => ({ ts: r[0] * 1000, h: r[2], o: r[1], c: r[4] }))
    .filter(c => c.ts >= postedAt - 60_000)
    .sort((a, b) => a.ts - b.ts);
  if (after.length < 3) return null;                 // not enough history to judge
  const entry = after[0].o || after[0].c;
  if (!(entry > 0)) return null;
  return { entry, peak: Math.max(...after.map(c => c.h)) / entry };
}

const channels = (process.argv[2] ?? 'solearlytrending,soltrenchtrending,solwhaletrending')
  .split(',').map(s => s.trim()).filter(Boolean);

let cache: Obs[] = [];
try { cache = JSON.parse(readFileSync(CACHE, 'utf-8')); } catch { /* first run */ }
const seen = new Set(cache.map(o => `${o.channel}:${o.mint}`));

console.log(`channels: ${channels.join(', ')}`);
console.log(`cache: ${cache.length} observations from previous runs\n`);

let tooYoung = 0;
for (const ch of channels) {
  let posts: { mint: string; postedAt: number }[] = [];
  try { posts = await scrape(ch); } catch (e: any) { console.log(`  ${ch}: scrape failed — ${e.message}`); continue; }
  // Same mint posted twice is one coin, not two observations. Keep the earliest.
  const byMint = new Map<string, { mint: string; postedAt: number }>();
  for (const p of posts.sort((a, b) => a.postedAt - b.postedAt)) if (!byMint.has(p.mint)) byMint.set(p.mint, p);
  const fresh = [...byMint.values()].filter(p => !seen.has(`${ch}:${p.mint}`));
  for (const p of fresh) {
    cache.push({ channel: ch, mint: p.mint, postedAt: p.postedAt });   // pending
    seen.add(`${ch}:${p.mint}`);
  }
  console.log(`${ch}: ${posts.length} posts on page, ${fresh.length} newly recorded`);
}

// ── phase 2: measure anything that has now aged enough ──
//
// The page only ever shows about an hour of posts, so nothing on it is old enough
// to judge. Recording and measuring have to be separate passes or the tool can only
// ever measure coins that have not finished moving, which understates every peak
// and does so unevenly. Run this periodically and the dataset builds itself.
const MIN_AGE_MIN = 120;
const pending = cache.filter(o => o.peak === undefined && (Date.now() - o.postedAt) / 60_000 >= MIN_AGE_MIN);
tooYoung = cache.filter(o => o.peak === undefined && (Date.now() - o.postedAt) / 60_000 < MIN_AGE_MIN).length;
console.log(`\n${pending.length} recorded posts are now old enough to measure (${tooYoung} still too young)\n`);

for (const o of pending) {
  const ageMin = (Date.now() - o.postedAt) / 60_000;
  const r = await outcome(o.mint, o.postedAt);
  if (r) {
    o.entry = r.entry; o.peak = r.peak; o.checked = Date.now(); o.ageAtCheckMin = Math.round(ageMin);
    process.stdout.write(`  ${o.channel.slice(0, 14).padEnd(14)} ${o.mint.slice(0, 8)}… peak ${r.peak.toFixed(2)}x\n`);
  }
  await sleep(4000);   // GeckoTerminal is free; 429s cost more than the wait
}

mkdirSync(dirname(CACHE), { recursive: true });
writeFileSync(CACHE, JSON.stringify(cache));

console.log(`\n${'='.repeat(72)}`);
const measured = cache.filter(o => o.peak !== undefined).length;
console.log(`RESULTS — ${measured} measured, ${cache.length - measured} recorded and awaiting age\n`);
console.log(`${'channel'.padEnd(22)}${'n'.padStart(5)}${'died'.padStart(7)}${'1.5x'.padStart(7)}${'2x'.padStart(7)}${'5x'.padStart(7)}${'median'.padStart(9)}${'best'.padStart(8)}`);
for (const ch of channels) {
  const rs = cache.filter(o => o.channel === ch && o.peak !== undefined);
  if (!rs.length) { console.log(`${ch.padEnd(22)}    0   (nothing measured yet)`); continue; }
  const peaks = rs.map(o => o.peak!).sort((a, b) => a - b);
  const pct = (f: (p: number) => boolean) => `${Math.round(peaks.filter(f).length / peaks.length * 100)}%`;
  console.log(
    ch.padEnd(22) +
    String(rs.length).padStart(5) +
    pct(p => p < 0.5).padStart(7) +
    pct(p => p >= 1.5).padStart(7) +
    pct(p => p >= 2).padStart(7) +
    pct(p => p >= 5).padStart(7) +
    `${peaks[Math.floor(peaks.length / 2)].toFixed(2)}x`.padStart(9) +
    `${peaks[peaks.length - 1].toFixed(1)}x`.padStart(8));
}
console.log(`\n"died" is peak under 0.5x — it never even recovered half. "median" is what a`);
console.log(`typical post reached, which is the number a trader experiences; the best column`);
console.log(`is one coin and should not be used to choose between channels.`);
if (tooYoung) console.log(`\n${tooYoung} recorded posts are still under 2h old — run again later and they will be measured.`);
const thin = channels.filter(ch => cache.filter(o => o.channel === ch && o.peak !== undefined).length < 20);
if (thin.length) console.log(`\nSTILL THIN (<20 posts): ${thin.join(', ')} — re-run over several days before trusting these.`);
