import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { CONFIG } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load wallet list ─────────────────────────────────────────

let smartWallets: string[] = [];
let loaded = false;

function loadWallets(): void {
  if (loaded) return;
  loaded = true;

  const filePath = join(__dirname, '..', 'wallets.txt');
  try {
    const raw = readFileSync(filePath, 'utf-8');
    smartWallets = raw
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'));
    console.log(`[WalletFilter] Loaded ${smartWallets.length} smart wallets`);
  } catch {
    console.warn('[WalletFilter] wallets.txt not found — filter disabled');
    smartWallets = [];
  }
}

/** Reload wallet list from disk (call if you update the file). */
export function reloadWallets(): void {
  loaded = false;
  loadWallets();
}

// ── RPC helper ───────────────────────────────────────────────

async function rpc(method: string, params: any[]): Promise<any> {
  const res = await fetch(CONFIG.HELIUS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data: any = await res.json();
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

// ── Check if any smart wallet holds a token ──────────────────

/**
 * Derives ATAs for all smart wallets + the given mint, then batch-checks
 * which ones exist and have a balance. Returns true if at least one
 * smart wallet holds the token.
 *
 * Uses getMultipleAccounts in batches of 100 — ~10-11 RPC calls for 1000 wallets.
 */
export async function checkSmartWallets(mint: string): Promise<{ held: boolean; holders: number; checked: number }> {
  loadWallets();

  if (smartWallets.length === 0) {
    return { held: true, holders: 0, checked: 0 }; // no list = skip filter
  }

  const mintPk = new PublicKey(mint);
  const BATCH = 100;
  let holders = 0;
  let checked = 0;

  // Derive all ATAs upfront
  const atas: PublicKey[] = [];
  for (const wallet of smartWallets) {
    try {
      const ownerPk = new PublicKey(wallet);
      const ata = await getAssociatedTokenAddress(mintPk, ownerPk, false, TOKEN_PROGRAM_ID);
      atas.push(ata);
    } catch {
      // Invalid pubkey — skip
    }
  }

  // Batch check ATAs
  for (let i = 0; i < atas.length; i += BATCH) {
    const batch = atas.slice(i, i + BATCH).map(a => a.toBase58());
    checked += batch.length;

    try {
      const result = await rpc('getMultipleAccounts', [batch, { encoding: 'jsonParsed' }]);
      for (const acc of result.value ?? []) {
        if (!acc) continue;
        const amount = acc.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        if (amount > 0) holders++;
      }
    } catch {
      // RPC error on this batch — continue with next
    }

    // Early exit — we found at least one holder
    if (holders > 0) break;

    // Small delay between batches to avoid rate limits
    if (i + BATCH < atas.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return { held: holders > 0, holders, checked };
}
