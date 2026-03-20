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

  if (existsSync(WALLET_FILE)) {
    const data = JSON.parse(readFileSync(WALLET_FILE, 'utf-8'));
    _wallet = Keypair.fromSecretKey(Uint8Array.from(data.secretKey));
    console.log(`[Wallet] Loaded wallet: ${_wallet.publicKey.toBase58()}`);
  } else {
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

/** Get a shared Solana RPC connection. */
export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(CONFIG.HELIUS_RPC, 'confirmed');
  }
  return _connection;
}

/** Get the bot wallet's SOL balance. */
export async function getSolBalance(): Promise<number> {
  const conn = getConnection();
  const wallet = getWallet();
  const lamports = await conn.getBalance(wallet.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

/** Get token balance (raw smallest units) for the bot wallet. Checks both SPL Token and Token-2022. */
export async function getTokenBalance(mint: string): Promise<number> {
  const conn = getConnection();
  const wallet = getWallet();
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

/** Close token account to reclaim rent SOL. Checks both SPL Token and Token-2022. */
export async function closeTokenAccount(mint: string): Promise<string | null> {
  const conn = getConnection();
  const wallet = getWallet();
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
