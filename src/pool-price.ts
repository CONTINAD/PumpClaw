/**
 * Live pool price, pushed from the chain.
 *
 * DexScreener reports an aggregate that lags the market — measured 8.76% off a
 * live pool on one of our own positions, and stale through a 45-second stretch
 * where the real price moved 1.36e-5 → 1.50e-5 → 1.42e-5. A stop set 15% below
 * entry has most of its margin eaten by an error that size.
 *
 * An AMM pool holds two vaults. Price is simply quote reserve ÷ base reserve, and
 * Solana will push us the new balances the moment anyone trades. One subscription
 * per position, no polling, no rate limit, and it is the number the pool will
 * actually fill against rather than someone's average of recent trades.
 *
 * This is strictly additive: callers fall back to their existing feed whenever a
 * subscription is missing, stale, or structurally implausible. It can never block
 * an exit — the failure mode is "no opinion", never "wrong opinion" or "hang".
 */
import { PublicKey } from '@solana/web3.js';
import { getConnection } from './wallet.js';
import { getSolPrice } from './dexscreener.js';
import { CONFIG } from './config.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const WSOL = 'So11111111111111111111111111111111111111112';

interface Watch {
  mint: string;
  pool: string;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  subs: number[];
  baseDec: number;
  quoteDec: number;
  baseRaw: bigint;
  quoteRaw: bigint;
  /** Price in SOL per token — SOL/USD is applied at read time so a stale
   *  conversion rate can never be baked into a stored price. */
  priceSol: number;
  ts: number;
  updates: number;
}

/**
 * Token account balance from a raw account buffer: u64 little-endian at offset 64.
 * Token-2022 keeps the same base layout and appends extensions, so one decode
 * serves both programs.
 *
 * Reading this out of the pushed buffer rather than issuing an RPC call is the
 * whole point — a busy coin fires several times a second across two vaults, and
 * calling out on each one turns a push feed back into a rate-limited poll.
 */
function decodeAmount(data: Buffer): bigint | null {
  if (!data || data.length < 72) return null;
  try { return data.readBigUInt64LE(64); } catch { return null; }
}

const watches = new Map<string, Watch>();
const pending = new Set<string>();

/**
 * AMMs whose price really is quote reserve ÷ base reserve.
 *
 * Meteora's DLMM is deliberately excluded: it is bin-based, so its vault ratio is
 * not a price at all. Subscribing to one read 500-600% off the real market, which
 * is exactly the kind of confidently-wrong number a stop must never see.
 */
const CONSTANT_PRODUCT = new Set(['pumpswap', 'raydium', 'pumpfun', 'orca']);

/**
 * How far reserve maths may sit from the venue's own quote before we refuse the pool.
 *
 * Deliberately tight. PumpSwap vaults accumulate creator and protocol fees that are
 * not part of the tradeable curve, so the base vault overstates reserves and the
 * ratio understates price. Measured against Jupiter's executable quote: one pool
 * matched to -0.0%, another was 16.7% low, a third 31.2% low. The error is always
 * downward, which would trip a stop early — the single worst way to be wrong.
 *
 * Pools that pass are the ones where the maths provably holds; the rest fall back
 * to the existing feed. Accepting a pool is a claim we can defend, not a hope.
 */
const ACCEPT_TOLERANCE = 0.08;

/** Drop a watch once drift exceeds this — fees accrue, so passing once is not forever. */
const DRIFT_LIMIT = 0.12;

/** Resolve a mint's deepest constant-product pool and its two vaults. */
async function resolveVaults(mint: string): Promise<{ pool: string; base: PublicKey; quote: PublicKey; refPrice: number } | null> {
  const res = await fetch(`${CONFIG.DEXSCREENER_API}/latest/dex/tokens/${mint}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000),
  });
  const d: any = await res.json();
  const pools = (d.pairs ?? []).filter((p: any) =>
    p.chainId === 'solana' && p.baseToken?.address === mint
    && (p.liquidity?.usd ?? 0) >= 500
    && CONSTANT_PRODUCT.has(String(p.dexId ?? '').toLowerCase()));
  if (!pools.length) return null;
  pools.sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const pool = new PublicKey(pools[0].pairAddress);
  const refPrice = +pools[0].priceUsd || 0;

  const conn = getConnection();
  // Pump.fun's newer mints are Token-2022 while the SOL side stays classic SPL,
  // so both programs have to be checked or the base vault is simply missing.
  let base: PublicKey | null = null, quote: PublicKey | null = null;
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
    const accts = await conn.getTokenAccountsByOwner(pool, { programId }, 'confirmed').catch(() => null);
    for (const a of accts?.value ?? []) {
      const parsed: any = await conn.getParsedAccountInfo(a.pubkey, 'confirmed').catch(() => null);
      const info = (parsed?.value?.data as any)?.parsed?.info;
      if (!info) continue;
      if (info.mint === mint) base = a.pubkey;
      else if (info.mint === WSOL) quote = a.pubkey;
    }
  }
  if (!base || !quote) return null;
  return { pool: pools[0].pairAddress, base, quote, refPrice };
}

/** Recompute from whatever raw reserves we currently hold. Pure, no I/O. */
function recompute(w: Watch): void {
  if (w.baseRaw <= 0n || w.quoteRaw <= 0n) return;
  const q = Number(w.quoteRaw) / Math.pow(10, w.quoteDec);
  const b = Number(w.baseRaw) / Math.pow(10, w.baseDec);
  if (!(q > 0) || !(b > 0)) return;
  const p = q / b;
  if (!Number.isFinite(p) || p <= 0) return;
  w.priceSol = p;
  w.ts = Date.now();
  w.updates++;
}

/** Begin watching a mint. Idempotent and safe to call on every loop tick. */
export async function watchMint(mint: string): Promise<void> {
  if (!CONFIG.POOL_PRICE_ENABLED) return;
  if (watches.has(mint) || pending.has(mint)) return;
  pending.add(mint);
  try {
    const v = await resolveVaults(mint);
    if (!v) return;
    const conn = getConnection();
    // Decimals are fixed for the life of the mint — read once, never again.
    const [qBal, bBal] = await Promise.all([
      conn.getTokenAccountBalance(v.quote, 'confirmed'),
      conn.getTokenAccountBalance(v.base, 'confirmed'),
    ]);
    const w: Watch = {
      mint, pool: v.pool, baseVault: v.base, quoteVault: v.quote, subs: [],
      baseDec: bBal.value.decimals, quoteDec: qBal.value.decimals,
      baseRaw: BigInt(bBal.value.amount), quoteRaw: BigInt(qBal.value.amount),
      priceSol: 0, ts: 0, updates: 0,
    };
    recompute(w);
    w.updates = w.priceSol > 0 ? 1 : 0;

    // Structural check: our reserve maths must agree with the venue's own quoted
    // price for this pool at subscribe time. A whitelist only covers AMMs we have
    // seen; this catches any pool whose layout is not what we assume, before a
    // single wrong number can reach a stop.
    const solUsd = await getSolPrice().catch(() => 0);
    const seeded = w.priceSol * solUsd;
    if (v.refPrice > 0 && seeded > 0 && Math.abs(seeded / v.refPrice - 1) > ACCEPT_TOLERANCE) {
      console.log(`[PoolPrice] refusing $${mint.slice(0, 8)} — reserve maths says ${seeded.toExponential(3)} ` +
        `but the pool quotes ${v.refPrice.toExponential(3)}; layout not understood`);
      return;
    }

    // Decode the reserve straight out of the pushed buffer — no RPC per trade.
    w.subs.push(conn.onAccountChange(v.quote, (acc) => {
      const amt = decodeAmount(acc.data as Buffer);
      if (amt !== null) { w.quoteRaw = amt; recompute(w); }
    }, 'confirmed'));
    w.subs.push(conn.onAccountChange(v.base, (acc) => {
      const amt = decodeAmount(acc.data as Buffer);
      if (amt !== null) { w.baseRaw = amt; recompute(w); }
    }, 'confirmed'));
    watches.set(mint, w);
    console.log(`[PoolPrice] watching $${mint.slice(0, 8)} via ${v.pool.slice(0, 8)} (${w.priceSol > 0 ? 'seeded' : 'awaiting first trade'})`);
  } catch (err: any) {
    console.log(`[PoolPrice] could not watch ${mint.slice(0, 8)}: ${err.message}`);
  } finally {
    pending.delete(mint);
  }
}

/** Stop watching — called when a position closes so subscriptions do not pile up. */
export function unwatchMint(mint: string): void {
  const w = watches.get(mint);
  if (!w) return;
  const conn = getConnection();
  for (const id of w.subs) conn.removeAccountChangeListener(id).catch(() => {});
  watches.delete(mint);
}

/** Drop every watch whose mint is not in `keep`. */
export function pruneWatches(keep: Set<string>): void {
  for (const mint of [...watches.keys()]) if (!keep.has(mint)) unwatchMint(mint);
}

/**
 * Current pool price in USD, or null when there is no trustworthy reading.
 * Null is the honest answer whenever the subscription is young or gone quiet —
 * callers keep using their existing feed rather than acting on a guess.
 */
export async function poolPriceUsd(mint: string, maxAgeMs = 120_000): Promise<number | null> {
  const w = watches.get(mint);
  if (!w || w.priceSol <= 0 || !w.updates) return null;
  if (Date.now() - w.ts > maxAgeMs) return null;
  const solUsd = await getSolPrice().catch(() => 0);
  if (!(solUsd > 0)) return null;
  const px = w.priceSol * solUsd;
  return Number.isFinite(px) && px > 0 ? px : null;
}

/**
 * Re-check every watch against the venue's quoted price and drop any that has
 * drifted. Fees accumulate in the vaults over a pool's life, so a pool that was
 * accurate at subscribe time can quietly stop being accurate.
 */
export async function revalidate(): Promise<void> {
  const solUsd = await getSolPrice().catch(() => 0);
  if (!(solUsd > 0)) return;
  for (const w of [...watches.values()]) {
    try {
      const res = await fetch(`${CONFIG.DEXSCREENER_API}/latest/dex/tokens/${w.mint}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000),
      });
      const d: any = await res.json();
      const p = (d.pairs ?? []).find((x: any) => x.pairAddress === w.pool);
      const ref = +p?.priceUsd || 0;
      const ours = w.priceSol * solUsd;
      if (ref > 0 && ours > 0 && Math.abs(ours / ref - 1) > DRIFT_LIMIT) {
        console.log(`[PoolPrice] dropping $${w.mint.slice(0, 8)} — drifted to ` +
          `${((ours / ref - 1) * 100).toFixed(1)}% off the pool's own quote`);
        unwatchMint(w.mint);
      }
    } catch { /* leave it; the staleness check still guards reads */ }
  }
}

export function watchStats(): { mint: string; updates: number; ageMs: number }[] {
  return [...watches.values()].map(w => ({
    mint: w.mint, updates: w.updates, ageMs: w.ts ? Date.now() - w.ts : -1,
  }));
}
