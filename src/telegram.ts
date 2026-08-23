/**
 * Scrapes public Telegram channel pages for "New Trending" posts.
 * Each post contains the token name and contract address (CA) embedded
 * in the Soul_Sniper_Bot link.
 *
 * Format in HTML:
 *   <a href="...Soul_Sniper_Bot?start=15_etb_{CA}"><b>Token Name</b></a><b> New </b>
 *   <a href="...solearlytrending"><b>Trending</b></a>
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * Channels to scrape, in order. Comma-separated via TG_CHANNELS.
 *
 * One channel was one point of failure and one ceiling: every winner the bot could
 * possibly catch had to appear there first. Measured against the page contents,
 * these overlap only 31-39% and together surface roughly three times as many mints
 * as any one of them alone (20 -> 44 on a single page load). They share the
 * Soul_Sniper link format, so the parser below reads them unchanged.
 *
 * solearlytrending is out, on Alex's call, after 68 graded calls said so:
 *
 *   hit 2x, all time         34%   (soltrenchtrending 46%)
 *   hit 2x, 08-20 onward     22%   (soltrenchtrending 42%)
 *   hit 2x when it was the
 *   only channel to post it  15%   over 33 calls
 *
 * It did not degrade because the market did — soltrench held near 45% through the
 * same three days, on the same scanner, behind the same gates, while this one fell
 * from 47% to 22%. Its posting volume never changed, so it is picking worse rather
 * than picking more. Removing it drops call volume about 28% and lifts the
 * source-tagged hit rate from 42% to 45%; keeping only soltrench and gem reaches 47%.
 *
 * soltrenchtrending is out too, on Alex's call, once the audit could compare all four
 * channels through the same gates on their own outcomes. It was the highest-volume
 * source and the worst one:
 *
 *                          calls   hit 2x        never reach TP1      SOL/call
 *   soltrenchtrending        117    31.6%   53.8%  [44.8-62.6]        +0.0794
 *   solwhaletrending          49    67.3%   24.5%  [14.6-38.1]        +0.3850
 *
 * Those intervals do not overlap. More than half of every trench call never reached
 * the first take-profit, which with this ladder is a guaranteed loss, and it supplied
 * 51% of the calls for 26% of the value. It is not a sample-size story either: across
 * three equal time slices its SOL/call ran +0.1250, +0.0953, +0.0544 while whale held
 * +0.4035, +0.3287, +0.4095, and whale still returns +0.3037/call with its three
 * biggest winners deleted.
 *
 * This cuts call volume to roughly a third, which is the trade being made knowingly:
 * while the exit is giving back every runner it touches, each extra call is a fresh
 * chance to pay the trail rather than a fresh chance to win.
 *
 * Nothing here is permanent. The channel audit keeps recording every post from every
 * channel whether or not it is scraped, so putting it back is a one-line change and
 * the evidence for doing so will be on the /channels page when it exists.
 */
const TG_CHANNELS: string[] = (process.env.TG_CHANNELS
  ?? 'solwhaletrending,gem_tools_calls')
  .split(',').map(s => s.trim()).filter(Boolean);

/**
 * Not every channel writes a call the same way, and most of what a channel posts is
 * not a call at all.
 *
 * gem_tools_calls is mostly a tracking feed — 18 of 20 posts are updates on coins it
 * already called ("$BOLLOCKS x22") or whale alerts at $600-800K market cap, an order
 * of magnitude above our entry ceiling. Treating every mint it mentions as a call
 * would enter coins nine hours after the move and repeatedly re-enter the same one.
 *
 * Only the entry format counts:  🚀 $SYM (Name) | <mint>
 */
const CHANNEL_FORMATS: Record<string, RegExp> = {
  // Entry posts read "$SYM (Name) <mint> GTscore: ⭐☆☆☆☆". The GTscore suffix is the
  // reliable marker — it appears on calls and on nothing else, while the "x22" update
  // posts and whale alerts carry no mint at all. Anchoring on the mint's position
  // relative to a name would also match the preview card of an update.
  gem_tools_calls: /([1-9A-HJ-NP-Za-km-z]{32,44})\s*GTscore/g,
};

export function tgChannels(): string[] { return [...TG_CHANNELS]; }

const tgUrl = (ch: string) => `https://t.me/s/${ch}`;

// Proxy list: "host:port:user:pass" — loaded from PROXY_LIST env var (comma-separated)
const PROXY_LIST: string[] = (process.env.PROXY_LIST ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

let proxyIndex = 0;

/* ── Proxy failure memory ────────────────────────────────────────────────────
 *
 * A proxy that answers CONNECT with 407 has rejected the credentials, and it will
 * reject them again on the next attempt and every attempt after that. The loop
 * below had no memory of this: three attempts per channel, a two-second sleep
 * between each, repeated for every channel on every cycle, forever.
 *
 * The cost is not the failure — the direct fallback works and no post is lost —
 * it is the time. Seven channels at three dead attempts plus their sleeps pushed
 * one scan cycle past the point where it finished at all: the scanner went from a
 * poll every 45-170s to no completed poll in 41 minutes, and the call pipeline
 * stalled behind it while every component reported itself healthy.
 *
 * So the pool is benched after a run of failures and the scrape goes straight to
 * direct, which is what it was going to do anyway three attempts later. One probe
 * after the cooldown decides whether the credentials came back. The same shape as
 * the RPC sick-bench and the candle capture's miss memory, for the same reason. */
const PROXY_FAIL_LIMIT = 3;
const PROXY_BENCH_MS = 10 * 60_000;
let proxyFails = 0;
let proxyBenchedUntil = 0;

function proxiesUsable(): boolean {
  return PROXY_LIST.length > 0 && Date.now() >= proxyBenchedUntil;
}

function noteProxyFailure(): void {
  proxyFails++;
  if (proxyFails >= PROXY_FAIL_LIMIT && Date.now() >= proxyBenchedUntil) {
    proxyBenchedUntil = Date.now() + PROXY_BENCH_MS;
    console.log(`[Telegram] Proxy pool benched for ${PROXY_BENCH_MS / 60_000} min after ` +
      `${proxyFails} consecutive failures — scraping direct until it is worth another try`);
  }
}

function noteProxySuccess(): void {
  if (proxyFails > 0 || proxyBenchedUntil > 0) console.log('[Telegram] Proxy answered again — unbenched');
  proxyFails = 0;
  proxyBenchedUntil = 0;
}

function getNextProxy(): string | null {
  if (PROXY_LIST.length === 0) return null;
  const proxy = PROXY_LIST[proxyIndex % PROXY_LIST.length];
  proxyIndex++;
  return proxy;
}

/** Fetch a URL through an HTTP CONNECT proxy (for HTTPS targets). */
function fetchViaProxy(targetUrl: string, proxyStr: string, ua: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const [host, port, user, pass] = proxyStr.split(':');
    const target = new URL(targetUrl);
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');

    const timeout = setTimeout(() => reject(new Error('Proxy timeout (15s)')), 15_000);

    const req = http.request({
      host,
      port: parseInt(port),
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    });

    req.on('connect', (_res, socket) => {
      if (_res.statusCode !== 200) {
        clearTimeout(timeout);
        reject(new Error(`CONNECT failed: ${_res.statusCode}`));
        return;
      }

      const tlsReq = https.request({
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: 'GET',
        socket,
        agent: false,
        headers: {
          'Host': target.hostname,
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      }, (tlsRes) => {
        let body = '';
        tlsRes.on('data', (chunk: Buffer) => { body += chunk; });
        tlsRes.on('end', () => {
          clearTimeout(timeout);
          resolve({ status: tlsRes.statusCode ?? 0, body });
        });
      });

      tlsReq.on('error', (err) => { clearTimeout(timeout); reject(err); });
      tlsReq.end();
    });

    req.on('error', (err) => { clearTimeout(timeout); reject(err); });
    req.end();
  });
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
];

export interface TrendingPost {
  /** Token contract address (mint) */
  mint: string;
  /** Token name as shown in the post */
  name: string;
  /** Telegram message ID (for dedup) */
  messageId: string;
}

// Regex to extract CA + name from the Soul_Sniper_Bot link followed by "New ... Trending"
const POST_PATTERN =
  /Soul_Sniper_Bot\?start=\w+_([A-Za-z0-9]{30,50}(?:pump|bonk))[^>]*>[^<]*<b[^>]*>[\u200e\u200f]?([^<]+)<\/b><\/a><b>\s*New\s*<\/b>/g;

// Regex to extract Telegram message IDs (for dedup between scrapes)
const msgIdPattern = (ch: string) => new RegExp(`data-post="${ch}/(\\d+)"`, 'g');

/**
 * Scrape the public Telegram channel page and return all "New Trending" posts
 * currently visible (usually last ~20 messages).
 * Retries up to 3 times with different User-Agents on failure.
 */
/**
 * Scrape every configured channel and merge the results.
 *
 * messageId is prefixed with the channel because Telegram numbers messages per
 * channel — two channels both have a message 1234, and an unprefixed id would make
 * the deduper treat one channel's post as already seen because the other had a post
 * with that number. That silently drops calls, and it drops more of them the more
 * channels are added.
 *
 * The same mint from two channels is deduped to the first that reported it, so an
 * overlapping feed adds coverage without adding duplicate calls. One channel
 * failing is logged and skipped rather than taking the others down with it.
 */
export async function scrapeAllChannels(): Promise<TrendingPost[]> {
  const seen = new Set<string>();
  const out: TrendingPost[] = [];
  for (const ch of TG_CHANNELS) {
    try {
      const posts = await scrapeTrendingPosts(ch);
      let added = 0;
      for (const p of posts) {
        if (seen.has(p.mint)) continue;
        seen.add(p.mint);
        out.push({ ...p, messageId: `${ch}:${p.messageId}` });
        added++;
      }
      console.log(`[Telegram] ${ch}: ${posts.length} posts, ${added} new mints`);
    } catch (err: any) {
      console.error(`[Telegram] ${ch} failed: ${err.message} — continuing with the others`);
    }
  }
  return out;
}

export async function scrapeTrendingPosts(channel: string = TG_CHANNELS[0]): Promise<TrendingPost[]> {
  let lastErr: Error | null = null;
  const TG_URL = tgUrl(channel);
  const MSG_ID_PATTERN = msgIdPattern(channel);

  // Attempts 1-3 rotate proxies (when configured); attempt 4 always goes DIRECT.
  // Paid proxies expire — without this fallback, dead proxies silently kill the
  // whole call pipeline even when the host's own IP can reach t.me fine.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const proxy = attempt < 3 && proxiesUsable() ? getNextProxy() : null;
      if (attempt === 3 && proxiesUsable()) {
        console.log('[Telegram] All proxy attempts failed — falling back to direct fetch');
      }

      let html: string;
      if (proxy) {
        const [pHost, pPort] = proxy.split(':');
        console.log(`[Telegram] Scraping via proxy ${pHost}:${pPort} (attempt ${attempt + 1})`);
        const proxyRes = await fetchViaProxy(TG_URL, proxy, ua);
        if (proxyRes.status !== 200) {
          console.error(`[Telegram] HTTP ${proxyRes.status} via proxy (attempt ${attempt + 1})`);
          lastErr = new Error(`HTTP ${proxyRes.status}`);
          noteProxyFailure();
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        noteProxySuccess();
        html = proxyRes.body;
      } else {
        const res = await fetch(TG_URL, {
          headers: {
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          console.error(`[Telegram] HTTP ${res.status} (attempt ${attempt + 1})`);
          lastErr = new Error(`HTTP ${res.status}`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        html = await res.text();
      }

      // Decode common HTML entities
      const decoded = html
        .replace(/&lrm;/g, '\u200e')
        .replace(/&rlm;/g, '\u200f')
        .replace(/&#036;/g, '$')
        .replace(/&amp;/g, '&')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&quot;/g, '"');

      // Collect all message IDs on the page (ordered)
      const msgIds: string[] = [];
      for (const m of decoded.matchAll(MSG_ID_PATTERN)) {
        msgIds.push(m[1]);
      }

      // Extract New Trending posts
      const posts: TrendingPost[] = [];
      const seen = new Set<string>();

      // A channel with its own entry format is parsed by that; everything else uses
      // the Soul_Sniper link the trending channels share.
      const custom = CHANNEL_FORMATS[channel];
      const matches = custom
        ? [...decoded.matchAll(custom)].map(m => ({ mint: m[1], name: m[1].slice(0, 8), index: m.index }))
        : [...decoded.matchAll(POST_PATTERN)].map(m => ({
            mint: m[1], name: m[2].replace(/[\u200e\u200f]/g, '').trim(), index: m.index,
          }));

      for (const m of matches) {
        const mint = m.mint;
        const name = m.name;

        if (seen.has(mint)) continue;
        seen.add(mint);

        // Find nearest message ID for this match position
        const matchPos = m.index!;
        let closestMsgId = 'unknown';
        let bestDist = Infinity;
        for (const mid of msgIds) {
          const midPos = decoded.indexOf(`data-post="${channel}/${mid}"`);
          if (midPos >= 0 && midPos < matchPos && matchPos - midPos < bestDist) {
            bestDist = matchPos - midPos;
            closestMsgId = mid;
          }
        }

        posts.push({ mint, name, messageId: closestMsgId });
      }

      return posts;
    } catch (err: any) {
      lastErr = err;
      // A throw on a proxy attempt is the proxy failing — a refused CONNECT, a
      // timeout, a reset. Direct-fetch attempts must not bench the pool.
      if (attempt < 3 && proxiesUsable()) noteProxyFailure();
      console.error(`[Telegram] Scrape error (attempt ${attempt + 1}): ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.error(`[Telegram] All 4 attempts (3 proxy + 1 direct) failed: ${lastErr?.message}`);

  // Fallback: try direct fetch without proxy
  if (PROXY_LIST.length > 0) {
    try {
      console.log(`[Telegram] Falling back to direct fetch (no proxy)`);
      const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const res = await fetch(TG_URL, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const html = await res.text();
        const decoded = html
          .replace(/&lrm;/g, '\u200e')
          .replace(/&rlm;/g, '\u200f')
          .replace(/&#036;/g, '$')
          .replace(/&amp;/g, '&')
          .replace(/&gt;/g, '>')
          .replace(/&lt;/g, '<')
          .replace(/&quot;/g, '"');

        const msgIds: string[] = [];
        for (const m of decoded.matchAll(MSG_ID_PATTERN)) {
          msgIds.push(m[1]);
        }

        const posts: TrendingPost[] = [];
        const seen = new Set<string>();
        for (const m of decoded.matchAll(POST_PATTERN)) {
          const mint = m[1];
          const name = m[2].replace(/[\u200e\u200f]/g, '').trim();
          if (seen.has(mint)) continue;
          seen.add(mint);
          const matchPos = m.index!;
          let closestMsgId = 'unknown';
          let bestDist = Infinity;
          for (const mid of msgIds) {
            const midPos = decoded.indexOf(`data-post="${channel}/${mid}"`);
            if (midPos >= 0 && midPos < matchPos && matchPos - midPos < bestDist) {
              bestDist = matchPos - midPos;
              closestMsgId = mid;
            }
          }
          posts.push({ mint, name, messageId: closestMsgId });
        }

        console.log(`[Telegram] Direct fetch succeeded: ${posts.length} posts`);
        return posts;
      }
      console.error(`[Telegram] Direct fetch failed: HTTP ${res.status}`);
    } catch (err: any) {
      console.error(`[Telegram] Direct fetch error: ${err.message}`);
    }
  }

  return [];
}
