/**
 * Scrapes @solearlytrending Telegram channel for "New Trending" posts.
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

const TG_URL = 'https://t.me/s/solearlytrending';

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
const MSG_ID_PATTERN = /data-post="solearlytrending\/(\d+)"/g;

/**
 * Scrape the public Telegram channel page and return all "New Trending" posts
 * currently visible (usually last ~20 messages).
 * Retries up to 3 times with different User-Agents on failure.
 */
export async function scrapeTrendingPosts(): Promise<TrendingPost[]> {
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const proxy = getNextProxy();

      let html: string;
      if (proxy) {
        const [pHost, pPort] = proxy.split(':');
        console.log(`[Telegram] Scraping via proxy ${pHost}:${pPort} (attempt ${attempt + 1})`);
        const proxyRes = await fetchViaProxy(TG_URL, proxy, ua);
        if (proxyRes.status !== 200) {
          console.error(`[Telegram] HTTP ${proxyRes.status} via proxy (attempt ${attempt + 1})`);
          lastErr = new Error(`HTTP ${proxyRes.status}`);
          if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
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
          if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
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
          const midPos = decoded.indexOf(`data-post="solearlytrending/${mid}"`);
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
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.error(`[Telegram] All 3 proxy attempts failed: ${lastErr?.message}`);

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
            const midPos = decoded.indexOf(`data-post="solearlytrending/${mid}"`);
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
