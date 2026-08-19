import { VersionedTransaction, type Keypair } from '@solana/web3.js';
import { getWallet, getConnection, mintDecimals, broadcastTransaction, anySignatureStatus } from './wallet.js';
import { CONFIG } from './config.js';
import { tipLamports, sendViaJito, type Urgency } from './jito.js';


/** Per-call swap options — task wallets pass their own keypair + params.
 *  Omitted fields fall back to the legacy singleton wallet / global CONFIG. */
export interface SwapOpts {
  keypair?: Keypair;
  slippageBps?: number;
  priorityFeeLamports?: number;
  /** How much this transaction is worth paying to land. Exits bid higher. */
  urgency?: Urgency;
  /** 1-based retry count — each attempt outbids the last. */
  attempt?: number;
  /** Upper bound on the Jito tip, normally a small % of the position's value. */
  maxTipLamports?: number;
}

// ── Jupiter tier ────────────────────────────────────────────────────────────
// Set JUPITER_API_KEY in Railway to move off the free tier. Nothing else needs
// touching: the base URL, the auth header and the throttle all follow from
// whether the key is present.
//
//   free (no key)   lite-api.jup.ag   1 req/sec
//   Developer $25   api.jup.ag        10 req/sec
//
// The free ceiling is what cost four buys and stranded a position on the first
// live night: one request a second has to cover background price checks AND the
// quotes that decide a trade, so the two starve each other under any load.
const JUP_API_KEY = (process.env.JUPITER_API_KEY ?? '').trim();
export const JUP_PAID = JUP_API_KEY.length > 0;
const JUP_BASE = JUP_PAID ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
const JUPITER_QUOTE = `${JUP_BASE}/swap/v1/quote`;
const JUPITER_SWAP = `${JUP_BASE}/swap/v1/swap`;

/** Auth header on every call, or nothing at all on the free tier. */
function jupHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return JUP_PAID ? { 'x-api-key': JUP_API_KEY, ...extra } : extra;
}

console.log(`[Jupiter] ${JUP_PAID ? 'PAID key detected — api.jup.ag' : 'no key — free tier lite-api.jup.ag (1 req/sec)'}`);
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Rate limiter for Jupiter quote API ──
// Jupiter free tier allows ~30 req/min. We space out non-buy quote calls.
let _lastQuoteTime = 0;
// Measured, not guessed: 30 concurrent quotes returned in 258ms with zero 429s,
// and a sustained 1/sec for 12s never failed. The old 1200ms gap was roughly ten
// times more conservative than the endpoint actually requires, and it sat directly
// in the stop path — a position near its stop waited over a second for the one
// price that decides whether to sell.
// Two budgets, because they compete and only one of them is a trade.
//
// This was 150ms with urgent traffic bypassing the throttle entirely, which permits
// roughly 400 requests a minute against a free tier that allows about 60. It cost a
// real buy: $HOMES, a $15K call from the channel that has been producing the
// winners, failed all three attempts on "Jupiter quote failed (429)".
//
// The bypass did not help, it hurt. Background checks ate the quota and the urgent
// request that skipped the queue arrived at an endpoint already refusing us — there
// is no priority lane on someone else's rate limit, only a shared budget.
//
// The original reason for lowering it has also gone. It was lowered to speed up
// exits back when exits were priced from Jupiter; exits now read the pool
// subscription at 250ms and do not touch this path at all.
// Gaps are set by the ceiling we actually have. On the free tier the background
// budget has to stay small so a trade quote can still get through; with 10 req/sec
// both fit comfortably, and the tighter background gap is the real prize — it is
// how quickly the bot notices a stop.
const QUOTE_GAP_BACKGROUND_MS = JUP_PAID ? 400 : 1500;   // 2.5/sec vs ~40/min
const QUOTE_GAP_URGENT_MS = JUP_PAID ? 120 : 200;        // 8.3/sec, under the 10/sec cap

async function rateLimitedQuote(urgent = false): Promise<void> {
  const gap = urgent ? QUOTE_GAP_URGENT_MS : QUOTE_GAP_BACKGROUND_MS;
  const wait = gap - (Date.now() - _lastQuoteTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastQuoteTime = Date.now();
}

export interface SwapResult {
  txSignature: string;
  inputAmount: number;     // raw units
  outputAmount: number;    // raw units
  priceImpactPct: number;
}

export { WSOL_MINT };

/** Get a Jupiter quote for a swap. */
async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number,
): Promise<any> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
  });

  const url = `${JUPITER_QUOTE}?${params}`;
  let lastErr: Error | null = null;

  // A 429 needs waiting out, not retrying into. Three attempts a second apart
  // against a rate limit are three refusals — which is exactly how $HOMES was lost,
  // the log reading "swap failed after 3 attempts" as though the route were bad.
  // Backoff separately and for longer on 429, and say which it was.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // The trade path was never throttled. rateLimitedQuote was wired into the two
      // read-only price helpers only, so every buy and sell went straight to fetch.
      // That is survivable until a position cannot exit: the time exit re-fires on
      // each 250ms loop tick, and each attempt spends up to four unthrottled quotes
      // here plus a second trader-level attempt on top. One stuck sell is then
      // issuing tens of quotes a second and exhausting the very quota it needs —
      // which is exactly how $mRNA-4157 held for an hour while $INT and $MRK were
      // both refused with 429s. Trades take the urgent budget, but bounded.
      await rateLimitedQuote(true);
      const res = await fetch(url, {
        headers: jupHeaders(),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const text = await res.text();
        const e: any = new Error(`Jupiter quote failed (${res.status}): ${text}`);
        e.status = res.status;
        throw e;
      }

      return res.json();
    } catch (err: any) {
      lastErr = err;
      const limited = err?.status === 429;
      console.log(`[Jupiter] Quote attempt ${attempt + 1} failed${limited ? ' (RATE LIMITED)' : ''}: ${err.message}`);
      if (attempt < 3) {
        // Rate limits clear on their own clock; a bad route will not improve either
        // way, so the long wait is only spent when it can actually help.
        await new Promise(r => setTimeout(r, limited ? 1200 * (attempt + 1) : 600));
      }
    }
  }

  throw lastErr!;
}

/**
 * Get a serialized swap transaction from Jupiter.
 *
 * The old call passed a flat lamport number, which Jupiter spreads as a compute
 * -budget price — on a quiet quote that came out at 224 lamports, nowhere near
 * enough to win a slot under load. Now the fee is sized per transaction: a Jito
 * tip when enabled, otherwise Jupiter's own live priority estimate.
 */
async function getSwapTransaction(
  quoteResponse: any,
  userPublicKey: string,
  opts: SwapOpts = {},
): Promise<{ tx: string; tipUsed: number; viaJito: boolean }> {
  const urgency: Urgency = opts.urgency ?? 'normal';
  const attempt = opts.attempt ?? 1;

  let prioritization: any;
  let tipUsed = 0;
  const viaJito = CONFIG.JITO_ENABLED && !opts.priorityFeeLamports;

  if (viaJito) {
    tipUsed = await tipLamports(urgency, attempt, opts.maxTipLamports);
    prioritization = { jitoTipLamports: tipUsed };
  } else if (opts.priorityFeeLamports) {
    prioritization = opts.priorityFeeLamports;
  } else {
    // No Jito: still let Jupiter price the fee against the live network instead
    // of a constant that is wrong most of the time.
    prioritization = {
      priorityLevelWithMaxLamports: {
        priorityLevel: urgency === 'critical' ? 'veryHigh' : urgency === 'high' ? 'high' : 'medium',
        maxLamports: urgency === 'critical' ? 2_000_000 : 500_000,
      },
    };
  }

  const res = await fetch(JUPITER_SWAP, {
    method: 'POST',
    headers: jupHeaders({ 'Content-Type': 'application/json' }),
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: false,
      prioritizationFeeLamports: prioritization,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jupiter swap failed (${res.status}): ${text}`);
  }
  const data: any = await res.json();
  return { tx: data.swapTransaction, tipUsed, viaJito };
}

/**
 * Sign, send, and actually confirm a Jupiter swap.
 *
 * The previous version confirmed against a blockhash fetched AFTER sending, so it
 * waited on a deadline unrelated to the transaction, threw on any confirmation
 * hiccup, and never rebroadcast — a dropped transaction simply never landed and
 * the caller recorded a failure. On a take-profit that retired the level for good.
 *
 * Now: confirm against the transaction's own blockhash, rebroadcast while that
 * blockhash is alive, and re-check the signature once more before giving up, so a
 * transaction that landed at the edge is reported as the success it was.
 */
async function signAndSend(swapTxBase64: string, keypair?: Keypair, viaJito = false): Promise<string> {
  const wallet = keypair ?? getWallet();
  const connection = getConnection();

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, 'base64'));
  tx.sign([wallet]);
  const rawTx = tx.serialize();
  const txBlockhash = tx.message.recentBlockhash;

  // Broadcast to every configured endpoint and to Jito at once. The transaction is
  // already signed, so its signature is identical everywhere and the network
  // deduplicates it — five nodes cannot execute it five times. One endpoint having
  // a bad minute previously lost the trade outright with no way to tell that apart
  // from a network-wide problem.
  const b64 = Buffer.from(rawTx).toString('base64');
  if (viaJito) sendViaJito(b64).catch(() => {});
  const txSig = await broadcastTransaction(rawTx);

  // Ask every endpoint — one lagging node must not hide a transaction that landed.
  const settled = () => anySignatureStatus(txSig).catch(() => 'pending' as const);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const r = await settled();
    if (r === 'ok') return txSig;
    if (r !== 'pending') throw new Error(r);

    let alive = true;
    try {
      alive = (await connection.isBlockhashValid(txBlockhash, { commitment: 'confirmed' })).value;
    } catch { /* RPC hiccup — keep waiting rather than abandon a live tx */ }

    if (!alive) {
      // The window closed. It may still have landed on the final slot.
      await new Promise(r => setTimeout(r, 1500));
      if (await settled() === 'ok') return txSig;
      throw new Error(`blockhash expired before confirmation (${txSig})`);
    }

    // Keep it in front of the leader; validators drop transactions under load.
    broadcastTransaction(rawTx).catch(() => {});
    if (viaJito) sendViaJito(b64).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
  }

  if (await settled() === 'ok') return txSig;
  throw new Error(`confirmation timed out after 90s (${txSig})`);
}

/**
 * Buy a token with SOL via Jupiter.
 * @param mint - Token mint address
 * @param solAmount - Amount of SOL to spend
 */
export async function jupiterBuy(mint: string, solAmount: number, opts: SwapOpts = {}): Promise<SwapResult> {
  const lamports = Math.floor(solAmount * 1e9);
  const wallet = opts.keypair ?? getWallet();

  console.log(`[Jupiter] Getting quote: ${solAmount} SOL → $${mint.slice(0, 8)}...`);
  const quote = await getQuote(WSOL_MINT, mint, lamports, opts.slippageBps ?? CONFIG.TRADE_SLIPPAGE_BPS);

  const priceImpact = parseFloat(quote.priceImpactPct ?? '0');
  console.log(`[Jupiter] Quote: ${quote.outAmount} tokens, impact: ${(priceImpact * 100).toFixed(2)}%`);

  const built = await getSwapTransaction(quote, wallet.publicKey.toBase58(), { ...opts, urgency: opts.urgency ?? 'normal' });
  console.log(`[Jupiter] Sending buy tx${built.viaJito ? ` via Jito (tip ${built.tipUsed} lamports)` : ''}...`);
  const txSig = await signAndSend(built.tx, opts.keypair, built.viaJito);
  console.log(`[Jupiter] ✅ Buy confirmed: ${txSig}`);

  return {
    txSignature: txSig,
    inputAmount: lamports,
    outputAmount: parseInt(quote.outAmount),
    priceImpactPct: priceImpact,
  };
}

/**
 * Fast price check: get a Jupiter quote to see what tokens are worth in SOL.
 * No transaction — just a quote. Returns SOL value or null on error.
 */
export async function jupiterQuoteSol(mint: string, tokenAmount: number): Promise<number | null> {
  try {
    await rateLimitedQuote();
    const params = new URLSearchParams({
      inputMint: mint,
      outputMint: WSOL_MINT,
      amount: String(tokenAmount),
      slippageBps: '100',
    });
    const res = await fetch(`${JUPITER_QUOTE}?${params}`, {
      headers: jupHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const quote: any = await res.json();
    return parseInt(quote.outAmount) / 1e9;
  } catch {
    return null;
  }
}

/**
 * Get the current price of a token via Jupiter quote API.
 * Quotes a small SOL buy (0.1 SOL) to derive the token's SOL-native price,
 * then converts to USD using the provided SOL price.
 *
 * This replaces the Jupiter Price API v2 which now requires auth.
 */
export async function jupiterGetPrice(mint: string, solPriceUsd?: number, urgent = false): Promise<{ priceUsd: number; priceNative: number } | null> {
  try {
    // Rate limit price-check quotes so they don't starve buy/sell quotes —
    // unless this is an exit decision, which must not queue behind anything.
    await rateLimitedQuote(urgent);

    // Quote: how many tokens do I get for 0.1 SOL?
    const lamportsIn = 100_000_000; // 0.1 SOL
    const params = new URLSearchParams({
      inputMint: WSOL_MINT,
      outputMint: mint,
      amount: String(lamportsIn),
      slippageBps: '100',
    });
    const res = await fetch(`${JUPITER_QUOTE}?${params}`, {
      headers: jupHeaders(),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const quote: any = await res.json();

    const tokensOut = parseInt(quote.outAmount);
    if (!tokensOut || tokensOut <= 0) return null;

    // outAmount is in RAW units, so it must be scaled by the mint's decimals before
    // it means anything as a price. Without this the result is 10^decimals too
    // small — a factor of a million on a 6-decimal token. That went unnoticed for
    // as long as the only caller compared it one-directionally and the absurdly
    // low value could never win; the moment the comparison became two-sided it
    // started overwriting good prices, reporting live coins at -100% and market
    // caps of a few cents.
    const decimals = await mintDecimals(mint);
    const uiTokens = tokensOut / Math.pow(10, decimals);
    if (!(uiTokens > 0)) return null;

    // priceNative = SOL per token = (SOL spent) / (tokens received)
    const solSpent = lamportsIn / 1e9; // 0.1
    const priceNative = solSpent / uiTokens;

    // Convert to USD if SOL price provided
    const priceUsd = solPriceUsd ? priceNative * solPriceUsd : 0;

    return { priceUsd, priceNative };
  } catch {
    return null;
  }
}

/**
 * Sell a token for SOL via Jupiter.
 * @param mint - Token mint address
 * @param tokenAmount - Raw token amount (smallest units) to sell
 */
export async function jupiterSell(mint: string, tokenAmount: number, opts: SwapOpts = {}): Promise<SwapResult> {
  const wallet = opts.keypair ?? getWallet();

  console.log(`[Jupiter] Getting quote: ${tokenAmount} tokens → SOL`);
  const quote = await getQuote(mint, WSOL_MINT, tokenAmount, opts.slippageBps ?? CONFIG.TRADE_SLIPPAGE_BPS);

  const priceImpact = parseFloat(quote.priceImpactPct ?? '0');
  const solOut = parseInt(quote.outAmount) / 1e9;
  console.log(`[Jupiter] Quote: ${solOut.toFixed(6)} SOL out, impact: ${(priceImpact * 100).toFixed(2)}%`);

  const built = await getSwapTransaction(quote, wallet.publicKey.toBase58(), { ...opts, urgency: opts.urgency ?? 'high' });
  console.log(`[Jupiter] Sending sell tx${built.viaJito ? ` via Jito (tip ${built.tipUsed} lamports)` : ''}...`);
  const txSig = await signAndSend(built.tx, opts.keypair, built.viaJito);
  console.log(`[Jupiter] ✅ Sell confirmed: ${txSig}`);

  return {
    txSignature: txSig,
    inputAmount: tokenAmount,
    outputAmount: parseInt(quote.outAmount),
    priceImpactPct: priceImpact,
  };
}
