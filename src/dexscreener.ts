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
}

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

    for (const pair of pairs) {
      const parsed = parsePair(pair);
      if (!parsed) continue;
      const existing = result.get(parsed.mint);
      // Keep pair with highest 5m volume
      if (!existing || parsed.volume5m > existing.volume5m) {
        result.set(parsed.mint, parsed);
      }
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
