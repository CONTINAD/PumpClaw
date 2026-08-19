/**
 * What is this coin actually worth right now.
 *
 * $Hyper was recorded at $8,024 market cap and filled at $5,137 — DexScreener had
 * not indexed the pool yet (it reported $0 liquidity) and its price was 56% high.
 * The fill itself was fine, because Jupiter priced the swap; what was wrong was
 * everything downstream that trusted the call record. Peak multiples, entry basis
 * and every filter statistic were measured against a number the coin never traded
 * at, and they were wrong in the direction that flatters nothing — a 1.56x head
 * start recorded as 1.00x.
 *
 * Measured on four real calls, against Jupiter's own quote as ground truth:
 *   DexScreener  -0.9% to -6.0% on settled coins, 56% out on an unindexed one
 *   Birdeye      +0.3% to -1.9%, but 429s at roughly 1 req/sec
 *   Jupiter      by definition correct: it is the price the swap executes at
 *
 * So Jupiter leads. It cannot be wrong about execution, and it is the same call
 * the buy path makes anyway. Birdeye is a second opinion when configured, and
 * DexScreener keeps the jobs it is genuinely good at — volume, transaction counts
 * and liquidity — which no quote can provide.
 */
import { CONFIG } from './config.js';

const BIRDEYE_KEY = (process.env.BIRDEYE_API_KEY ?? '').trim();
export const BIRDEYE_ON = BIRDEYE_KEY.length > 0;

const WSOL = 'So11111111111111111111111111111111111111112';
const JUP_KEY = (process.env.JUPITER_API_KEY ?? '').trim();
const JUP_BASE = JUP_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';

export interface PriceRead {
  priceUsd: number;
  source: 'jupiter' | 'birdeye' | 'dexscreener' | 'none';
  /** How far the fallbacks sat from the chosen price, when both were available. */
  disagreePct?: number;
}

/** The price a buy would actually execute at, sized like a real entry. */
async function jupiterExecPrice(mint: string, solUsd: number, solIn = 0.1): Promise<number | null> {
  try {
    const lamports = Math.floor(solIn * 1e9);
    const res = await fetch(`${JUP_BASE}/swap/v1/quote?inputMint=${WSOL}&outputMint=${mint}&amount=${lamports}&slippageBps=100`,
      { headers: JUP_KEY ? { 'x-api-key': JUP_KEY } : {}, signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    const q: any = await res.json();
    const out = Number(q.outAmount);
    if (!(out > 0)) return null;
    // outAmount is raw; decimals come from the quote itself so this stays correct
    // for the token-2022 mints that do not use 6.
    const dec = Number(q.outputMintDecimals ?? 6);
    const tokens = out / Math.pow(10, dec);
    return tokens > 0 ? (solIn * solUsd) / tokens : null;
  } catch { return null; }
}

async function birdeyePrice(mint: string): Promise<number | null> {
  if (!BIRDEYE_ON) return null;
  try {
    const res = await fetch(`https://public-api.birdeye.so/defi/price?address=${mint}`,
      { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }, signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;          // 429 is normal here; it is a second opinion, not a dependency
    const j: any = await res.json();
    const v = Number(j?.data?.value);
    return v > 0 ? v : null;
  } catch { return null; }
}

/**
 * Best available price, preferring the one the market will honour.
 *
 * dexPrice is passed in rather than fetched because the caller already has it —
 * re-requesting would double the DexScreener load for no new information.
 */
export async function truePrice(mint: string, solUsd: number, dexPrice?: number): Promise<PriceRead> {
  const [jup, bird] = await Promise.all([jupiterExecPrice(mint, solUsd), birdeyePrice(mint)]);
  const chosen = jup ?? bird ?? (dexPrice && dexPrice > 0 ? dexPrice : 0);
  const source: PriceRead['source'] = jup ? 'jupiter' : bird ? 'birdeye' : dexPrice ? 'dexscreener' : 'none';
  let disagreePct: number | undefined;
  const other = jup ? (bird ?? dexPrice) : dexPrice;
  if (chosen > 0 && other && other > 0) disagreePct = (other / chosen - 1) * 100;
  return { priceUsd: chosen, source, disagreePct };
}
