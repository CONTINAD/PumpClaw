import { VersionedTransaction } from '@solana/web3.js';
import { getWallet, getConnection } from './wallet.js';
import { CONFIG } from './config.js';

const JUPITER_QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP = 'https://lite-api.jup.ag/swap/v1/swap';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Rate limiter for Jupiter quote API ──
// Jupiter free tier allows ~30 req/min. We space out non-buy quote calls.
let _lastQuoteTime = 0;
const QUOTE_MIN_GAP_MS = 2500; // 2.5s between price-check quotes

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
      prioritizationFeeLamports: CONFIG.TRADE_PRIORITY_FEE_LAMPORTS,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jupiter swap failed (${res.status}): ${text}`);
  }

  const data: any = await res.json();
  return data.swapTransaction;
}

/** Sign and send a Jupiter swap transaction. */
async function signAndSend(swapTxBase64: string): Promise<string> {
  const wallet = getWallet();
  const connection = getConnection();

  const txBuf = Buffer.from(swapTxBase64, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const rawTx = tx.serialize();
  const txSig = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    maxRetries: 2,
  });

  // Confirm the transaction
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    signature: txSig,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  }, 'confirmed');

  return txSig;
}

/**
 * Buy a token with SOL via Jupiter.
 * @param mint - Token mint address
 * @param solAmount - Amount of SOL to spend
 */
export async function jupiterBuy(mint: string, solAmount: number): Promise<SwapResult> {
  const lamports = Math.floor(solAmount * 1e9);
  const wallet = getWallet();

  console.log(`[Jupiter] Getting quote: ${solAmount} SOL → $${mint.slice(0, 8)}...`);
  const quote = await getQuote(WSOL_MINT, mint, lamports, CONFIG.TRADE_SLIPPAGE_BPS);

  const priceImpact = parseFloat(quote.priceImpactPct ?? '0');
  console.log(`[Jupiter] Quote: ${quote.outAmount} tokens, impact: ${(priceImpact * 100).toFixed(2)}%`);

  const swapTx = await getSwapTransaction(quote, wallet.publicKey.toBase58());
  console.log(`[Jupiter] Sending buy tx...`);
  const txSig = await signAndSend(swapTx);
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
export async function jupiterSell(mint: string, tokenAmount: number): Promise<SwapResult> {
  const wallet = getWallet();

  console.log(`[Jupiter] Getting quote: ${tokenAmount} tokens → SOL`);
  const quote = await getQuote(mint, WSOL_MINT, tokenAmount, CONFIG.TRADE_SLIPPAGE_BPS);

  const priceImpact = parseFloat(quote.priceImpactPct ?? '0');
  const solOut = parseInt(quote.outAmount) / 1e9;
  console.log(`[Jupiter] Quote: ${solOut.toFixed(6)} SOL out, impact: ${(priceImpact * 100).toFixed(2)}%`);

  const swapTx = await getSwapTransaction(quote, wallet.publicKey.toBase58());
  console.log(`[Jupiter] Sending sell tx...`);
  const txSig = await signAndSend(swapTx);
  console.log(`[Jupiter] ✅ Sell confirmed: ${txSig}`);

  return {
    txSignature: txSig,
    inputAmount: tokenAmount,
    outputAmount: parseInt(quote.outAmount),
    priceImpactPct: priceImpact,
  };
}
