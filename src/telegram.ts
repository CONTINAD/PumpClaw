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
 * these three overlap only 31-39% and together surface roughly three times as many
 * mints as solearlytrending alone (20 -> 44 on a single page load).
 *
 * The two additions use the same Soul_Sniper link format, so the parser below reads
 * them unchanged — they were chosen for that as much as for their coverage.
 */
const TG_CHANNELS: string[] = (process.env.TG_CHANNELS
  ?? 'solearlytrending,soltrenchtrending,solwhaletrending')
  .split(',').map(s => s.trim()).filter(Boolean);

export function tgChannels(): string[] { return [...TG_CHANNELS]; }

const tgUrl = (ch: string) => `https://t.me/s/${ch}`;

// Proxy list: "host:port:user:pass" — loaded from PROXY_LIST env var (comma-separated)
const PROXY_LIST: string[] = (process.env.PROXY_LIST ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

let proxyIndex = 0;

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
      const proxy = attempt < 3 ? getNextProxy() : null;
      if (attempt === 3 && PROXY_LIST.length > 0) {
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
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          continue;
        }
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

      for (const m of decoded.matchAll(POST_PATTERN)) {
        const mint = m[1];
        const name = m[2].replace(/[\u200e\u200f]/g, '').trim();

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
