import { CONFIG } from './config.js';

export interface PumpFunCoin {
  mint: string;
  name: string;
  symbol: string;
  image_uri?: string;
  usd_market_cap?: number;
  market_cap?: number;
  creator?: string;
  created_timestamp?: number;
  complete?: boolean;
  is_currently_live?: boolean;
  king_of_the_hill_timestamp?: number;
  website?: string;
  twitter?: string;
  telegram?: string;
  description?: string;
  raydium_pool?: string;
  pump_swap_pool?: string;
  total_supply?: number;
  ath_market_cap?: number;
  program?: string;
  /** true only if the coin came from the /coins/trending endpoint */
  isTrendingPaid: boolean;
}

const HEADERS: Record<string, string> = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};

// Use v3 — v2 returns 503
const API_BASE = 'https://frontend-api-v3.pump.fun';

let loggedSample = false;

function parseCoin(raw: any, trendingPaid: boolean): PumpFunCoin {
  return {
    mint: raw.mint,
    name: raw.name || 'Unknown',
    symbol: raw.symbol || '???',
    image_uri: raw.image_uri || raw.profile_image || raw.icon || raw.thumbnail || undefined,
    usd_market_cap: raw.usd_market_cap ?? undefined,
    market_cap: raw.market_cap ?? undefined,
    creator: raw.creator ?? undefined,
    created_timestamp: raw.created_timestamp
      ? raw.created_timestamp > 1e12
        ? Math.floor(raw.created_timestamp / 1000) // ms → s
        : raw.created_timestamp
      : undefined,
    complete: raw.complete ?? undefined,
    is_currently_live: raw.is_currently_live ?? undefined,
    king_of_the_hill_timestamp: raw.king_of_the_hill_timestamp ?? undefined,
    website: raw.website ?? undefined,
    twitter: raw.twitter ?? undefined,
    telegram: raw.telegram ?? undefined,
    description: raw.description ?? undefined,
    raydium_pool: raw.raydium_pool ?? undefined,
    pump_swap_pool: raw.pump_swap_pool ?? undefined,
    total_supply: raw.total_supply ?? undefined,
    ath_market_cap: raw.ath_market_cap ?? undefined,
    program: raw.program ?? undefined,
    isTrendingPaid: trendingPaid,
  };
}

function extractCoins(data: any, trendingPaid: boolean): PumpFunCoin[] {
  let rawList: any[];
  if (Array.isArray(data)) {
    rawList = data;
  } else if (data?.coins && Array.isArray(data.coins)) {
    rawList = data.coins;
  } else if (data?.data && Array.isArray(data.data)) {
    rawList = data.data;
  } else if (data?.results && Array.isArray(data.results)) {
    rawList = data.results;
  } else {
    return [];
  }

  // Log sample coin structure once for debugging
  if (!loggedSample && rawList.length > 0) {
    loggedSample = true;
    const keys = Object.keys(rawList[0]);
    console.log(`[PumpFun] Coin fields (${keys.length}): ${keys.join(', ')}`);
    const trendingKeys = keys.filter(k =>
      /trend|promot|boost|feature|slot|paid|adverti|sponsor/i.test(k),
    );
    if (trendingKeys.length > 0) {
      console.log(`[PumpFun] Trending fields found: ${trendingKeys.join(', ')}`);
      for (const k of trendingKeys) {
        console.log(`  → ${k}: ${JSON.stringify(rawList[0][k])}`);
      }
    }
  }

  return rawList.filter((r: any) => r.mint).map(r => parseCoin(r, trendingPaid));
}

async function tryFetch(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.length === 0) return null; // empty body
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────

/**
 * Fetch coins that have **paid SOL for trending** on Pump.fun.
 * Returns empty array when no coins are currently paying.
 */
export async function fetchTrendingCoins(): Promise<PumpFunCoin[]> {
  const urls = [
    `${API_BASE}/coins/trending?limit=50&offset=0&includeNsfw=false`,
    `${API_BASE}/coins/trending`,
  ];

  for (const url of urls) {
    const data = await tryFetch(url);
    if (data) {
      const coins = extractCoins(data, true);
      if (coins.length > 0) {
        console.log(`[PumpFun] ✅ ${coins.length} trending-paid coins found`);
        return coins;
      }
    }
  }

  return []; // no trending coins right now
}

/**
 * Fetch a broad set of active Pump.fun coins for volume monitoring.
 * These are NOT confirmed as trending-paid — used as a secondary scan pool.
 */
export async function fetchActiveCoins(): Promise<PumpFunCoin[]> {
  const seen = new Set<string>();
  const all: PumpFunCoin[] = [];

  const endpoints = [
    `${API_BASE}/coins/king-of-the-hill?includeNsfw=false`,
    `${API_BASE}/coins/currently-live?limit=50&offset=0&includeNsfw=false`,
    `${API_BASE}/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false`,
    `${API_BASE}/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false`,
  ];

  for (const url of endpoints) {
    const data = await tryFetch(url);
    if (!data) continue;

    const coins = extractCoins(data, false);
    for (const c of coins) {
      if (!seen.has(c.mint)) {
        seen.add(c.mint);
        all.push(c);
      }
    }
  }

  return all;
}

/**
 * Fetch details for a single coin.
 */
export async function fetchCoinDetails(mint: string): Promise<PumpFunCoin | null> {
  const data = await tryFetch(`${API_BASE}/coins/${mint}`);
  return data ? parseCoin(data, false) : null;
}
