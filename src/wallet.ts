import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import bs58 from 'bs58';
import { CONFIG } from './config.js';

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

/** Get a shared Solana RPC connection. */
export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(CONFIG.HELIUS_RPC, 'confirmed');
  }
  return _connection;
}

/** Get the bot wallet's SOL balance. */
export async function getSolBalance(keypair?: Keypair): Promise<number> {
  const conn = getConnection();
  const wallet = keypair ?? getWallet();
  const lamports = await conn.getBalance(wallet.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

/** Get token balance (raw smallest units) for the bot wallet. Checks both SPL Token and Token-2022. */
export async function getTokenBalance(mint: string, keypair?: Keypair): Promise<number> {
  const conn = getConnection();
  const wallet = keypair ?? getWallet();
  const mintPk = new PublicKey(mint);

  // Try standard SPL Token first, then Token-2022
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = await getAssociatedTokenAddress(mintPk, wallet.publicKey, false, programId);
      const info = await conn.getTokenAccountBalance(ata);
      const amount = parseInt(info.value.amount);
      if (amount > 0) return amount;
    } catch {
      // Account doesn't exist under this program — try next
    }
  }
  return 0;
}

/** Get token balance as a human-readable number (accounting for decimals). Checks both SPL Token and Token-2022. */
export async function getTokenBalanceUi(mint: string): Promise<number> {
  const conn = getConnection();
  const wallet = getWallet();
  const mintPk = new PublicKey(mint);

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = await getAssociatedTokenAddress(mintPk, wallet.publicKey, false, programId);
      const info = await conn.getTokenAccountBalance(ata);
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
      const res = await conn.getParsedTokenAccountsByOwner(owner, { programId });
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
      const info = await conn.getTokenAccountBalance(ata);
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
