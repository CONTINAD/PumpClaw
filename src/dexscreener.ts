import { CONFIG } from './config.js';

export interface MarketData {
  mint: string;
  priceUsd: number;
  priceNative: number;
  volume5m: number;
  volume1h: number;
  volume6h: number;
  volume24h: number;
  marketCap: number;
  fdv: number;
  liquidity: number;
  liquiditySol: number;
  buys5m: number;
  sells5m: number;
  buys1h: number;
  sells1h: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  pairAddress: string;
  pairUrl: string;
  dexId: string;
  pairCreatedAt: number;
  imageUrl?: string;
  /** How many tradeable pairs backed this quote, and whether they agreed. */
  pairCount?: number;
  priceConfidence?: 'high' | 'low';
}

/**
 * Minimum liquidity for a pair's price to be believed.
 *
 * Post-migration the pump.fun bonding-curve pair sticks around forever reporting
 * its final price (~$3.1e-5 for EVERY graduated coin) with $0 liquidity, and
 * Meteora leaves dust pairs holding $1-2. Those are not prices, they are
 * fossils — but they are real DexScreener rows, so they used to win the pick
 * whenever the live pair happened to have no trades in the last 5 minutes.
 */
const MIN_TRUSTED_LIQ = 500;

function parsePair(pair: any): MarketData | null {
  const mint = pair.baseToken?.address;
  if (!mint) return null;

  return {
    mint,
    priceUsd: parseFloat(pair.priceUsd || '0'),
    priceNative: parseFloat(pair.priceNative || '0'),
    volume5m: pair.volume?.m5 ?? 0,
    volume1h: pair.volume?.h1 ?? 0,
    volume6h: pair.volume?.h6 ?? 0,
    volume24h: pair.volume?.h24 ?? 0,
    marketCap: pair.marketCap ?? pair.fdv ?? 0,
    fdv: pair.fdv ?? 0,
    liquidity: pair.liquidity?.usd ?? 0,
    liquiditySol: pair.liquidity?.quote ?? 0,
    buys5m: pair.txns?.m5?.buys ?? 0,
    sells5m: pair.txns?.m5?.sells ?? 0,
    buys1h: pair.txns?.h1?.buys ?? 0,
    sells1h: pair.txns?.h1?.sells ?? 0,
    priceChange5m: pair.priceChange?.m5 ?? 0,
    priceChange1h: pair.priceChange?.h1 ?? 0,
    priceChange6h: pair.priceChange?.h6 ?? 0,
    priceChange24h: pair.priceChange?.h24 ?? 0,
    pairAddress: pair.pairAddress || '',
    pairUrl: pair.url || '',
    dexId: pair.dexId || 'unknown',
    pairCreatedAt: pair.pairCreatedAt ?? 0,
    imageUrl: pair.info?.imageUrl ?? undefined,
  };
}

/**
 * Choose which pair's price to believe for a token.
 *
 * Order of preference:
 *   1. Pairs with real liquidity — dead bonding curves and dust pairs are dropped.
 *   2. Among those, the one actually trading (highest 5m volume).
 *   3. When nothing has traded in 5 minutes, the deepest pool — never insertion order.
 *
 * Also flags the quote 'low' confidence when the liquid pairs disagree by >25%,
 * so callers can require a second opinion before acting on it.
 */
export function pickPair(all: MarketData[]): MarketData | null {
  if (!all.length) return null;
  const dedup = new Map<string, MarketData>();
  for (const p of all) if (p.priceUsd > 0) dedup.set(p.pairAddress || Math.random().toString(), p);
  const usable = [...dedup.values()];
  if (!usable.length) return null;

  let pool = usable.filter(p => p.liquidity >= MIN_TRUSTED_LIQ);
  // Nothing meets the bar (very early coin) — fall back to the deepest thing there is,
  // but never to a zero-liquidity fossil if any pool holds anything at all.
  if (!pool.length) {
    const anyLiq = usable.filter(p => p.liquidity > 0);
    pool = anyLiq.length ? anyLiq : usable;
  }

  const traded = pool.filter(p => p.volume5m > 0);
  const ranked = (traded.length ? traded : pool).sort((a, b) =>
    (b.volume5m - a.volume5m) || (b.liquidity - a.liquidity));
  const best = ranked[0];

  // Do the liquid pairs agree? Compare against the deepest pool as reference.
  const deep = [...pool].sort((a, b) => b.liquidity - a.liquidity)[0];
  const disagree = deep && deep.priceUsd > 0
    ? Math.abs(best.priceUsd / deep.priceUsd - 1) > 0.25 : false;

  return { ...best, pairCount: pool.length, priceConfidence: disagree ? 'low' : 'high' };
}

/**
 * Batch-fetch market data from DexScreener for up to 30 tokens at a time.
 * Returns a Map keyed by mint address — keeps only the highest-5m-volume pair per token.
 */
export async function fetchBatchMarketData(mints: string[]): Promise<Map<string, MarketData>> {
  const result = new Map<string, MarketData>();
  if (mints.length === 0) return result;

  // DexScreener supports comma-separated addresses, max 30
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += 30) {
    chunks.push(mints.slice(i, i + 30));
  }

  for (const chunk of chunks) {
    const addresses = chunk.join(',');

    // Query BOTH endpoints in PARALLEL and merge — v1 sometimes only returns
    // the launchlab pair for bonk tokens while legacy has the active raydium pair
    const [v1Result, legacyResult] = await Promise.allSettled([
      fetch(`${CONFIG.DEXSCREENER_API}/tokens/v1/solana/${addresses}`, { signal: AbortSignal.timeout(10_000) })
        .then(async r => r.ok ? r.json() : []),
      fetch(`${CONFIG.DEXSCREENER_API}/latest/dex/tokens/${addresses}`, { signal: AbortSignal.timeout(10_000) })
        .then(async r => r.ok ? r.json() : { pairs: [] }),
    ]);

    const pairs: any[] = [];
    if (v1Result.status === 'fulfilled') {
      const v1 = v1Result.value;
      pairs.push(...(Array.isArray(v1) ? v1 : v1?.pairs ?? []));
    }
    if (legacyResult.status === 'fulfilled') {
      pairs.push(...(legacyResult.value?.pairs ?? []));
    }

    // Group every pair per mint first — picking a winner one-at-a-time made the
    // choice depend on API response order whenever 5m volumes tied at zero.
    const byMint = new Map<string, MarketData[]>();
    for (const pair of pairs) {
      const parsed = parsePair(pair);
      if (!parsed) continue;
      const list = byMint.get(parsed.mint);
      if (list) list.push(parsed); else byMint.set(parsed.mint, [parsed]);
    }
    for (const [mint, all] of byMint) {
      const chosen = pickPair(all);
      if (chosen) result.set(mint, chosen);
    }

    // Small delay between chunks to avoid rate limits
    if (chunks.length > 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return result;
}

/**
 * Fetch market data for a single token.
 */
export async function fetchSingleMarketData(mint: string): Promise<MarketData | null> {
  const map = await fetchBatchMarketData([mint]);
  return map.get(mint) ?? null;
}

/**
 * Get current SOL price in USD (cached for 5 min).
 * Uses DexScreener SOL/USDC pair on Raydium.
 */
let _solPriceCache: { price: number; ts: number } = { price: 0, ts: 0 };

export async function getSolPrice(): Promise<number> {
  if (_solPriceCache.price > 0 && Date.now() - _solPriceCache.ts < 5 * 60 * 1000) {
    return _solPriceCache.price;
  }

  try {
    const res = await fetch(
      `${CONFIG.DEXSCREENER_API}/tokens/v1/solana/So11111111111111111111111111111111111111112`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (res.ok) {
      const pairs: any[] = await res.json();
      // Find the highest-liquidity USDC pair
      const usdcPair = pairs
        .filter((p: any) => p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT')
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (usdcPair) {
        const price = parseFloat(usdcPair.priceUsd || '0');
        if (price > 0) {
          _solPriceCache = { price, ts: Date.now() };
          return price;
        }
      }
    }
  } catch {}

  // Fallback: return cached or rough estimate
  return _solPriceCache.price > 0 ? _solPriceCache.price : 140;
}
