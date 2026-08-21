import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import bs58 from 'bs58';
import { CONFIG } from './config.js';


/**
 * Bound an RPC call in time.
 *
 * @solana/web3.js Connection methods have NO timeout. If the endpoint accepts the
 * socket and never answers, the await never settles and never throws — the caller
 * is stuck forever. On 2026-08-12 that stranded a live position for 8 hours: a
 * balance lookup hung inside the 1-second position loop, the loop is sequential so
 * it stopped entirely, and every exit for every position stopped with it while the
 * scanner carried on looking healthy.
 *
 * A rejection is always recoverable — callers already catch and retry. A hang is
 * not recoverable by anything.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Default ceiling for a single RPC round trip in the trading path. */
const RPC_TIMEOUT_MS = 12_000;

const WALLET_FILE = join(CONFIG.DATA_DIR, 'wallet.json');

let _wallet: Keypair | null = null;
let _connection: Connection | null = null;

/** Get or create the bot's trading wallet. */
export function getWallet(): Keypair {
  if (_wallet) return _wallet;

  // Priority 1: env var (for Railway / cloud deploys)
  if (process.env.WALLET_PRIVATE_KEY) {
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    console.log(`[Wallet] Loaded wallet from env: ${_wallet.publicKey.toBase58()}`);
  } else if (existsSync(WALLET_FILE)) {
    // Priority 2: local file
    const data = JSON.parse(readFileSync(WALLET_FILE, 'utf-8'));
    _wallet = Keypair.fromSecretKey(Uint8Array.from(data.secretKey));
    console.log(`[Wallet] Loaded wallet: ${_wallet.publicKey.toBase58()}`);
  } else {
    // Priority 3: generate new
    _wallet = Keypair.generate();
    mkdirSync(dirname(WALLET_FILE), { recursive: true });
    writeFileSync(WALLET_FILE, JSON.stringify({
      publicKey: _wallet.publicKey.toBase58(),
      secretKey: Array.from(_wallet.secretKey),
    }, null, 2));
    console.log(`[Wallet] Generated new wallet: ${_wallet.publicKey.toBase58()}`);
    console.log(`[Wallet] ⚠️  Fund this wallet with SOL before trading!`);
  }

  return _wallet;
}

/** Where the active wallet comes from (settings UI shows this). */
export function walletSource(): 'env' | 'file' | 'none' {
  if (process.env.WALLET_PRIVATE_KEY) return 'env';
  if (existsSync(WALLET_FILE)) return 'file';
  return 'none';
}

/** Replace the trading wallet from a bs58 private key (dashboard settings page).
 *  Write-only: validates, persists to the volume, swaps the in-memory keypair.
 *  Returns the public address. Throws if the env var takes priority. */
export function setWalletFromKey(bs58Key: string): string {
  if (process.env.WALLET_PRIVATE_KEY) {
    throw new Error('WALLET_PRIVATE_KEY env var is set and takes priority — remove it in Railway to manage the wallet from here.');
  }
  const kp = Keypair.fromSecretKey(bs58.decode(bs58Key.trim()));
  mkdirSync(dirname(WALLET_FILE), { recursive: true });
  writeFileSync(WALLET_FILE, JSON.stringify({
    publicKey: kp.publicKey.toBase58(),
    secretKey: Array.from(kp.secretKey),
  }, null, 2));
  _wallet = kp;
  console.log(`[Wallet] Wallet replaced via settings: ${kp.publicKey.toBase58()}`);
  return kp.publicKey.toBase58();
}

/**
 * Hand out endpoints in rotation rather than pinning every read to the primary.
 *
 * Helius enforces a per-second cap and answers over it with 429 + Retry-After: 1.
 * Measured against the live key while the bot was running, roughly a third of
 * additional reads were refused — the primary sits at its cap under normal load,
 * so a balance check before a buy or a decimals lookup mid-exit arrives at a bucket
 * that is already empty. A second key has its own bucket. Sends were already
 * spread across the pool; reads were not, which left the backup idle while the
 * primary stayed pinned.
 *
 * Every call site is an independent point read, and blockhash validity is global
 * state, so no caller depends on being handed the same node twice.
 */
let _rr = 0;
/** Endpoint index → time its cooldown expires. */
const _sick = new Map<number, number>();
const SICK_MS = 20_000;

/**
 * Endpoints in rotation, healthy ones first.
 *
 * Plain round-robin assumes the endpoints are interchangeable. Measured, they are
 * not: the primary key refuses roughly 40% of reads with 429 while the second key
 * answers everything, and splitting the load did not change that — whatever is
 * consuming that key's budget is not this bot's read volume. Rotating blindly
 * would keep handing half of all reads to the endpoint least able to serve them.
 *
 * A failure benches an endpoint for 20 seconds rather than removing it, so a key
 * that recovers comes back on its own and a key that degrades later is demoted
 * without anyone having to notice which one it was. If every endpoint is benched
 * they are all used anyway — a degraded read beats no read.
 */
function rotation(): Connection[] {
  const pool = connectionPool();
  const now = Date.now();
  const idx = pool.map((_, i) => i);
  const healthy = idx.filter(i => (_sick.get(i) ?? 0) <= now);
  const benched = idx.filter(i => (_sick.get(i) ?? 0) > now);
  const order = healthy.length ? healthy : idx;
  // When nothing is healthy, `order` is already every endpoint — appending the
  // benched list again would return each one twice and make a total outage take
  // two full rounds of timeouts to report, which is the worst moment to be slow.
  const tail = healthy.length ? benched : [];
  const off = _rr++ % order.length;
  return [...order.slice(off), ...order.slice(0, off), ...tail].map(i => pool[i]);
}

function markSick(conn: Connection): void {
  const i = connectionPool().indexOf(conn);
  if (i >= 0) _sick.set(i, Date.now() + SICK_MS);
}
function markWell(conn: Connection): void {
  const i = connectionPool().indexOf(conn);
  if (i >= 0) _sick.delete(i);
}

/** Health snapshot for /api/health — a pool quietly down to one live node is worth seeing. */
export function poolHealth(): { endpoints: number; healthy: number; hosts: string[] } {
  const pool = connectionPool();
  const now = Date.now();
  return {
    endpoints: pool.length,
    healthy: pool.filter((_, i) => (_sick.get(i) ?? 0) <= now).length,
    hosts: [CONFIG.HELIUS_RPC, ...CONFIG.RPC_FALLBACKS].filter(Boolean).map(maskRpc),
  };
}

export function getConnection(): Connection {
  const order = rotation();
  if (order.length === 0) throw new Error('no RPC endpoints configured');
  return order[0];
}

/**
 * Run a read against the pool, moving to the next endpoint on failure.
 *
 * Retrying the same endpoint after a 429 means waiting out its second. A different
 * key answers now, which matters when the read is the balance check standing
 * between a call and a buy.
 */
export async function rpcRead<T>(fn: (c: Connection) => Promise<T>, label: string, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
  const order = rotation();
  if (order.length === 0) throw new Error('no RPC endpoints configured');
  let last: any;
  for (const conn of order) {
    try { const r = await withTimeout(fn(conn), timeoutMs, label); markWell(conn); return r; }
    catch (e: any) { last = e; markSick(conn); }
  }
  throw new Error(`${label}: all ${order.length} endpoint(s) failed — ${String(last?.message ?? last).slice(0, 100)}`);
}

/** Get the bot wallet's SOL balance. */
export async function getSolBalance(keypair?: Keypair): Promise<number> {
  const wallet = keypair ?? getWallet();
  const lamports = await rpcRead(c => c.getBalance(wallet.publicKey), 'getBalance');
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Balance read at the freshest commitment the node will give.
 *
 * The shared connection runs at 'confirmed', and on 2026-08-13 it served a figure
 * 48 minutes out of date — 0.0265 SOL against a real 0.2395. The buy path decided
 * it could not afford the entry and skipped a call, silently, because a stale read
 * and a genuinely empty wallet are indistinguishable at the point of decision.
 *
 * Used as a second opinion only when a balance is about to block a trade.
 */
export async function getSolBalanceFresh(keypair?: Keypair): Promise<number> {
  const wallet = keypair ?? getWallet();
  const endpoints = [CONFIG.HELIUS_RPC, ...CONFIG.RPC_FALLBACKS].filter(Boolean);
  for (const url of endpoints) {
    try {
      const conn = new Connection(url, 'processed');
      const lamports = await withTimeout(conn.getBalance(wallet.publicKey, 'processed'), 8000, 'getBalance(fresh)');
      return lamports / LAMPORTS_PER_SOL;
    } catch { /* try the next endpoint */ }
  }
  return getSolBalance(keypair);
}

/** Get token balance (raw smallest units) for the bot wallet. Checks both SPL Token and Token-2022. */
export async function getTokenBalance(mint: string, keypair?: Keypair): Promise<number> {
  const wallet = keypair ?? getWallet();
  const mintPk = new PublicKey(mint);
  let rpcFailure: any = null;

  // Try standard SPL Token first, then Token-2022
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = await getAssociatedTokenAddress(mintPk, wallet.publicKey, false, programId);
      const info = await rpcRead(c => c.getTokenAccountBalance(ata), 'getTokenAccountBalance');
      const amount = parseInt(info.value.amount);
      if (amount > 0) return amount;
    } catch (e: any) {
      if (!isMissingAccount(e)) rpcFailure = e;
    }
  }
  // A rate-limited read and an empty wallet both used to arrive here as 0, and a
  // caller cannot tell "you hold nothing" from "nobody would tell me". Reported as
  // 0 to a sell path, that silently cancels the sell on a position we still hold.
  if (rpcFailure) throw new Error(`token balance unreadable for ${mint.slice(0, 8)}: ${String(rpcFailure.message ?? rpcFailure).slice(0, 90)}`);
  return 0;
}

/**
 * True when the error means the token account genuinely does not exist.
 *
 * That is a real zero. Anything else — 429, timeout, transport failure — is an
 * unknown balance and must not be rounded down to nothing.
 */
function isMissingAccount(e: any): boolean {
  const m = String(e?.message ?? e).toLowerCase();
  return m.includes('could not find account') || m.includes('invalid param')
      || m.includes('account does not exist') || m.includes('failed to get token account');
}

/** Get token balance as a human-readable number (accounting for decimals). Checks both SPL Token and Token-2022. */
export async function getTokenBalanceUi(mint: string): Promise<number> {
  const conn = getConnection();
  const wallet = getWallet();
  const mintPk = new PublicKey(mint);

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = await getAssociatedTokenAddress(mintPk, wallet.publicKey, false, programId);
      const info = await rpcRead(c => c.getTokenAccountBalance(ata), 'getTokenAccountBalance');
      const amount = info.value.uiAmount ?? 0;
      if (amount > 0) return amount;
    } catch {
      // Account doesn't exist under this program — try next
    }
  }
  return 0;
}

export interface TokenHolding {
  mint: string;
  amountRaw: number;
  uiAmount: number;
  decimals: number;
}

/** Every SPL token this wallet actually holds on-chain (both token programs).
 *  This is ground truth — position records can drift on failed sells/dust. */
export async function getTokenHoldings(keypair?: Keypair): Promise<TokenHolding[]> {
  const conn = getConnection();
  const owner = (keypair ?? getWallet()).publicKey;
  const out: TokenHolding[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const res = await withTimeout(conn.getParsedTokenAccountsByOwner(owner, { programId }), RPC_TIMEOUT_MS, 'getParsedTokenAccountsByOwner');
      for (const { account } of res.value) {
        const info: any = (account.data as any).parsed?.info;
        const amt = info?.tokenAmount;
        if (amt && (amt.uiAmount ?? 0) > 0) {
          out.push({ mint: info.mint, amountRaw: parseInt(amt.amount), uiAmount: amt.uiAmount, decimals: amt.decimals });
        }
      }
    } catch { /* program scan failed — skip */ }
  }
  return out;
}

/** Close token account to reclaim rent SOL. Checks both SPL Token and Token-2022. */
export async function closeTokenAccount(mint: string, keypair?: Keypair): Promise<string | null> {
  const conn = getConnection();
  const wallet = keypair ?? getWallet();
  const mintPk = new PublicKey(mint);

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = await getAssociatedTokenAddress(mintPk, wallet.publicKey, false, programId);
      // Check account exists and has 0 balance
      const info = await withTimeout(conn.getTokenAccountBalance(ata), RPC_TIMEOUT_MS, 'getTokenAccountBalance');
      const amount = parseInt(info.value.amount);
      if (amount > 0) continue; // still has tokens, skip

      const tx = new Transaction().add(
        createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey, [], programId),
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [wallet]);
      console.log(`[Wallet] Closed token account for ${mint.slice(0, 8)}... → reclaimed rent SOL (tx: ${sig.slice(0, 16)}...)`);
      return sig;
    } catch {
      // Account doesn't exist or close failed — try next
    }
  }
  return null;
}

const decimalsCache = new Map<string, number>();

/**
 * SPL mint decimals — pump.fun is 6, but never assume.
 * Lives here rather than in trader so jupiter can use it without a circular import.
 * Decimals are immutable for a mint, so the cache never expires.
 */
export async function mintDecimals(mint: string): Promise<number> {
  const hit = decimalsCache.get(mint);
  if (hit !== undefined) return hit;
  try {
    const info: any = await rpcRead(c => c.getParsedAccountInfo(new PublicKey(mint)), 'getParsedAccountInfo(mint)');
    const d = info?.value?.data?.parsed?.info?.decimals;
    const v = typeof d === 'number' ? d : 6;
    decimalsCache.set(mint, v);
    return v;
  } catch {
    // Not cached on failure — a transient RPC error must not pin a wrong value
    // for the life of the process.
    return 6;
  }
}

const supplyCache = new Map<string, number>();

/**
 * Circulating supply for a mint, cached for the process lifetime.
 *
 * Supply is fixed once a pump.fun token launches, so one lookup covers it forever.
 * Used to derive market cap as price x supply rather than trusting DexScreener's
 * marketCap field, which is sampled independently of its price field and drifts up
 * to ~10% from it on a fast-moving coin — enough that a reported cap and the price
 * a trade was made at can describe different moments.
 */
export async function mintSupply(mint: string): Promise<number> {
  const hit = supplyCache.get(mint);
  if (hit !== undefined) return hit;
  try {
    const info: any = await rpcRead(c => c.getTokenSupply(new PublicKey(mint)), 'getTokenSupply');
    const v = parseFloat(info?.value?.uiAmountString ?? info?.value?.uiAmount ?? '0');
    if (v > 0) { supplyCache.set(mint, v); return v; }
  } catch { /* fall through */ }
  return 0;   // not cached — a transient failure must not pin zero forever
}

// ── Multi-endpoint broadcast ────────────────────────────────

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
let _pool: Connection[] | null = null;

/** Every configured endpoint, primary first. */
export function connectionPool(): Connection[] {
  if (_pool) return _pool;
  const urls = [CONFIG.HELIUS_RPC, ...CONFIG.RPC_FALLBACKS].filter(Boolean);
  _pool = urls.map(u => new Connection(u, 'confirmed'));
  console.log(`[Wallet] RPC pool: ${_pool.length} endpoint(s)`);
  return _pool;
}

/**
 * Drop the cached pool so the next call rebuilds from current CONFIG.
 *
 * Endpoints are editable from the settings page, and a change that needs a
 * redeploy to take effect is a change that gets made during an outage and helps
 * nobody until the outage is over.
 */
export function resetConnectionPool(): void { _pool = null; }

/**
 * Check that an endpoint is real, reachable and actually on mainnet.
 *
 * A backup that does not work is worse than no backup, because it reads as
 * protection on the settings page while failing at the only moment it matters.
 * A typo, an expired key and a devnet URL all look identical until a trade needs
 * them, so each one is proven here instead.
 */
export async function probeRpcEndpoint(url: string): Promise<{ ok: boolean; slot?: number; ms?: number; error?: string }> {
  const t0 = Date.now();
  try {
    const conn = new Connection(url, 'confirmed');
    const [slot, genesis] = await Promise.all([
      withTimeout(conn.getSlot(), 8_000, 'getSlot'),
      withTimeout(conn.getGenesisHash(), 8_000, 'getGenesisHash').catch(() => MAINNET_GENESIS),
    ]);
    if (genesis !== MAINNET_GENESIS) return { ok: false, error: 'not mainnet — wrong cluster' };
    return { ok: true, slot, ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 110) };
  }
}

/** Mask an endpoint for display — host stays legible, the API key does not. */
export function maskRpc(url: string): string {
  try {
    const u = new URL(url);
    const key = u.searchParams.get('api-key') ?? u.searchParams.get('apikey');
    const tail = key ? `?api-key=…${key.slice(-4)}`
      : u.pathname.length > 8 ? `/…${u.pathname.slice(-4)}` : '';
    return u.host + tail;
  } catch { return url.slice(0, 24) + '…'; }
}

/**
 * Submit a signed transaction to every endpoint at once and take the first
 * signature returned.
 *
 * A single endpoint is a single point of failure at the worst possible moment.
 * $vorq's buy failed three times without a transaction ever reaching the chain,
 * and with one endpoint there is no way to tell a network-wide problem from that
 * one node having a bad minute — the trade is simply lost either way.
 *
 * Broadcasting is safe: the same signed transaction has the same signature
 * everywhere, so the network deduplicates it. Sending to five nodes cannot execute
 * it five times.
 *
 * Throws only if every endpoint rejected it, and carries the reasons.
 */
export async function broadcastTransaction(rawTx: Uint8Array): Promise<string> {
  const pool = connectionPool();
  if (pool.length === 0) throw new Error('no RPC endpoints configured');
  const errors: string[] = [];
  const attempts = pool.map(conn =>
    withTimeout(conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 3 }), 12_000, 'sendRawTransaction')
      .catch((e: any) => { errors.push(String(e.message).slice(0, 80)); return null; }));
  const results = await Promise.all(attempts);
  const sig = results.find((r): r is string => typeof r === 'string' && r.length > 0);
  if (sig) return sig;
  throw new Error(`all ${pool.length} endpoint(s) rejected: ${errors.join(' | ')}`);
}

/** Poll for a signature across the pool — one lagging node cannot hide a landed tx. */
export async function anySignatureStatus(sig: string): Promise<'ok' | 'pending' | string> {
  const pool = connectionPool();
  const checks = pool.map(conn =>
    withTimeout(conn.getSignatureStatuses([sig]), 8000, 'getSignatureStatuses')
      .then(r => r.value[0]).catch(() => null));
  const results = await Promise.all(checks);
  for (const st of results) {
    if (!st) continue;
    if (st.err) return `on-chain failure: ${JSON.stringify(st.err)}`;
    if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'ok';
  }
  return 'pending';
}

/**
 * What a sale actually returned, read back off the chain.
 *
 * The reconciler closes a position when the wallet no longer holds the token, and
 * it has no proceeds to record because it did not make the sale — so it books the
 * remainder at zero and the trade reads as a total loss. That is a floor, not a
 * measurement, and on DIP's $MENSA it was wrong by 0.45 SOL: the book said -0.3710
 * on a trade that actually returned +0.4524.
 *
 * The proceeds are not unknowable, only unobserved. Every sale is on chain. This
 * walks the wallet's recent signatures, keeps the transactions that touched this
 * mint, and sums the wallet's own SOL deltas across them — which is the amount that
 * genuinely landed, fees already netted out, because that is what a balance delta
 * is.
 *
 * Bounded deliberately: a short signature window and a time cutoff, so a sale of
 * the same coin from days ago can never be attributed to today's position. Returns
 * null when it cannot tell, and the caller keeps booking zero — a wrong number
 * confidently recorded would be worse than the honest floor it replaces.
 */
export async function recoverSaleProceeds(
  mint: string, keypair?: Keypair, sinceMs = 30 * 60_000, maxSigs = 25,
): Promise<{ sol: number; txs: number } | null> {
  const kp = keypair ?? getWallet();
  const owner = kp.publicKey.toBase58();
  const cutoff = Math.floor((Date.now() - sinceMs) / 1000);
  try {
    const sigs = await rpcRead(
      c => c.getSignaturesForAddress(kp.publicKey, { limit: maxSigs }), 'sigs-for-recover');
    const recent = sigs.filter(s => !s.err && (s.blockTime ?? 0) >= cutoff);
    if (recent.length === 0) return null;

    let sol = 0, txs = 0;
    for (const s of recent) {
      let tx;
      try {
        tx = await rpcRead(c => c.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
        }), 'tx-for-recover');
      } catch { continue; }
      if (!tx?.meta) continue;

      // Only transactions that moved THIS token. A balance entry for the mint on
      // either side is the cheapest reliable test, and it excludes the unrelated
      // buys and sells that sit between these signatures.
      const touched = [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]
        .some(b => b.mint === mint);
      if (!touched) continue;

      const keys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
      const i = keys.indexOf(owner);
      if (i < 0) continue;
      const delta = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
      // A sale pays SOL in. A buy pays it out, and must never be counted as proceeds.
      if (delta > 0) { sol += delta; txs++; }
    }
    return txs > 0 ? { sol, txs } : null;
  } catch {
    return null;   // no second opinion available; the caller keeps its floor
  }
}
