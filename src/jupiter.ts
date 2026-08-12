import { VersionedTransaction, type Keypair } from '@solana/web3.js';
import { getWallet, getConnection } from './wallet.js';
import { CONFIG } from './config.js';

/** Per-call swap options — task wallets pass their own keypair + params.
 *  Omitted fields fall back to the legacy singleton wallet / global CONFIG. */
export interface SwapOpts {
  keypair?: Keypair;
  slippageBps?: number;
  priorityFeeLamports?: number;
}

const JUPITER_QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP = 'https://lite-api.jup.ag/swap/v1/swap';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Rate limiter for Jupiter quote API ──
// Jupiter free tier allows ~30 req/min. We space out non-buy quote calls.
let _lastQuoteTime = 0;
const QUOTE_MIN_GAP_MS = 1200; // ~50 quotes/min — near Jupiter lite-tier ceiling

async function rateLimitedQuote(): Promise<void> {
  const now = Date.now();
  const wait = QUOTE_MIN_GAP_MS - (now - _lastQuoteTime);
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

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Jupiter quote failed (${res.status}): ${text}`);
      }

      return res.json();
    } catch (err: any) {
      lastErr = err;
      console.log(`[Jupiter] Quote attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    }
  }

  throw lastErr!;
}

/** Get a serialized swap transaction from Jupiter. */
async function getSwapTransaction(
  quoteResponse: any,
  userPublicKey: string,
  priorityFeeLamports?: number,
): Promise<string> {
  const res = await fetch(JUPITER_SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: false,
      prioritizationFeeLamports: priorityFeeLamports ?? CONFIG.TRADE_PRIORITY_FEE_LAMPORTS,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jupiter swap failed (${res.status}): ${text}`);
  }

  const data: any = await res.json();
  return data.swapTransaction;
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
async function signAndSend(swapTxBase64: string, keypair?: Keypair): Promise<string> {
  const wallet = keypair ?? getWallet();
  const connection = getConnection();

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, 'base64'));
  tx.sign([wallet]);
  const rawTx = tx.serialize();
  const txBlockhash = tx.message.recentBlockhash;

  const txSig = await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 5 });

  const settled = async (): Promise<'ok' | 'pending' | string> => {
    try {
      const st = await connection.getSignatureStatuses([txSig]);
      const s = st.value[0];
      if (!s) return 'pending';
      if (s.err) return `on-chain failure: ${JSON.stringify(s.err)}`;
      if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return 'ok';
      return 'pending';
    } catch { return 'pending'; }
  };

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
    connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
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

  const swapTx = await getSwapTransaction(quote, wallet.publicKey.toBase58(), opts.priorityFeeLamports);
  console.log(`[Jupiter] Sending buy tx...`);
  const txSig = await signAndSend(swapTx, opts.keypair);
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
export async function jupiterGetPrice(mint: string, solPriceUsd?: number): Promise<{ priceUsd: number; priceNative: number } | null> {
  try {
    // Rate limit price-check quotes so they don't starve buy/sell quotes
    await rateLimitedQuote();

    // Quote: how many tokens do I get for 0.1 SOL?
    const lamportsIn = 100_000_000; // 0.1 SOL
    const params = new URLSearchParams({
      inputMint: WSOL_MINT,
      outputMint: mint,
      amount: String(lamportsIn),
      slippageBps: '100',
    });
    const res = await fetch(`${JUPITER_QUOTE}?${params}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const quote: any = await res.json();

    const tokensOut = parseInt(quote.outAmount);
    if (!tokensOut || tokensOut <= 0) return null;

    // priceNative = SOL per token = (SOL spent) / (tokens received)
    const solSpent = lamportsIn / 1e9; // 0.1
    // Need token decimals — derive from the quote's output decimal context
    // The outAmount is in raw units, so price = SOL / rawTokens
    const priceNative = solSpent / tokensOut;

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

  const swapTx = await getSwapTransaction(quote, wallet.publicKey.toBase58(), opts.priorityFeeLamports);
  console.log(`[Jupiter] Sending sell tx...`);
  const txSig = await signAndSend(swapTx, opts.keypair);
  console.log(`[Jupiter] ✅ Sell confirmed: ${txSig}`);

  return {
    txSignature: txSig,
    inputAmount: tokenAmount,
    outputAmount: parseInt(quote.outAmount),
    priceImpactPct: priceImpact,
  };
}
