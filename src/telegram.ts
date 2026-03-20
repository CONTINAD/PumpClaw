/**
 * Scrapes @solearlytrending Telegram channel for "New Trending" posts.
 * Each post contains the token name and contract address (CA) embedded
 * in the Soul_Sniper_Bot link.
 *
 * Format in HTML:
 *   <a href="...Soul_Sniper_Bot?start=15_etb_{CA}"><b>Token Name</b></a><b> New </b>
 *   <a href="...solearlytrending"><b>Trending</b></a>
 */

const TG_URL = 'https://t.me/s/solearlytrending';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

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
  /Soul_Sniper_Bot\?start=\w+_([A-Za-z0-9]{30,50}pump)[^>]*>[^<]*<b[^>]*>[\u200e\u200f]?([^<]+)<\/b><\/a><b>\s*New\s*<\/b>/g;

// Regex to extract Telegram message IDs (for dedup between scrapes)
const MSG_ID_PATTERN = /data-post="solearlytrending\/(\d+)"/g;

/**
 * Scrape the public Telegram channel page and return all "New Trending" posts
 * currently visible (usually last ~20 messages).
 */
export async function scrapeTrendingPosts(): Promise<TrendingPost[]> {
  try {
    const res = await fetch(TG_URL, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[Telegram] HTTP ${res.status} from ${TG_URL}`);
      return [];
    }

    const html = await res.text();

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
      // (approximate — find the closest data-post before this match)
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
    console.error(`[Telegram] Scrape error: ${err.message}`);
    return [];
  }
}
