/**
 * Does a coin have any real presence attached to it?
 *
 * A launch with no Twitter and no site is a launch nobody intends to support.
 * It costs nothing to attach one, so its absence is a signal rather than an
 * oversight.
 *
 * Source is pump.fun's v3 API, not DexScreener: DexScreener's info block is empty
 * for most fresh coins — measured 1 of 5 recent calls carrying any socials at all,
 * while pump.fun had the data for every one of them. Filtering on DexScreener
 * would have rejected almost everything for lack of data rather than lack of links.
 */
import { CONFIG } from './config.js';

export interface SocialInfo {
  twitter: boolean;
  website: boolean;
  telegram: boolean;
  count: number;
  known: boolean;   // false when the lookup failed — absence of data, not absence of links
}

const cache = new Map<string, SocialInfo>();

export async function checkSocials(mint: string): Promise<SocialInfo> {
  const hit = cache.get(mint);
  if (hit) return hit;
  try {
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(String(res.status));
    const d: any = await res.json();
    const twitter = !!(d.twitter && String(d.twitter).trim());
    const website = !!(d.website && String(d.website).trim());
    const telegram = !!(d.telegram && String(d.telegram).trim());
    const info: SocialInfo = {
      twitter, website, telegram,
      count: [twitter, website, telegram].filter(Boolean).length,
      known: true,
    };
    if (cache.size > 3000) cache.delete(cache.keys().next().value!);
    cache.set(mint, info);
    return info;
  } catch {
    // Deliberately NOT cached and NOT treated as "no links". A failed lookup means
    // we do not know, and blocking on that would turn a pump.fun outage into a
    // total call drought — the same failure that cost five days once already.
    return { twitter: false, website: false, telegram: false, count: 0, known: false };
  }
}
