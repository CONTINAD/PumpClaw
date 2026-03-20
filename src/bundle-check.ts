import { CONFIG } from './config.js';

export interface BundleResult {
  safe: boolean;
  clusterPct: number;
  maxCluster: number;
  totalChecked: number;
  details: string;
  wideClusterPct?: number;   // cluster % using wider window (7 days)
  wideMaxCluster?: number;
}

// ── Wallet funding time cache (survives across token checks) ──
// Key = wallet pubkey, Value = funding blockTime (or -1 for "unknown/failed")
const walletFundingCache = new Map<string, number>();
const CACHE_MAX_SIZE = 5000; // evict oldest when full

function cacheGet(wallet: string): number | undefined {
  return walletFundingCache.get(wallet);
}

function cacheSet(wallet: string, time: number): void {
  if (walletFundingCache.size >= CACHE_MAX_SIZE) {
    // evict first (oldest) entry
    const first = walletFundingCache.keys().next().value!;
    walletFundingCache.delete(first);
  }
  walletFundingCache.set(wallet, time);
}

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

/**
 * Resolves a list of SPL token account addresses to their owner wallet pubkeys.
 * Uses getMultipleAccountsInfo with jsonParsed encoding.
 */
async function resolveOwnerWallets(tokenAccounts: string[]): Promise<string[]> {
  // getMultipleAccountsInfo accepts up to 100 addresses at once
  const infos = await rpc('getMultipleAccounts', [
    tokenAccounts,
    { encoding: 'jsonParsed' },
  ]);

  const owners: string[] = [];
  const seen = new Set<string>();

  for (const info of infos.value ?? []) {
    const owner: string | undefined = info?.data?.parsed?.info?.owner;
    if (owner && !seen.has(owner)) {
      seen.add(owner);
      owners.push(owner);
    }
  }

  return owners;
}

/**
 * Find the approximate first time a wallet was funded with SOL.
 * We paginate getSignaturesForAddress newest-first; the very last sig is the oldest.
 * For bundle wallets (fresh, few txs) this resolves quickly.
 * If a wallet has > MAX_SIG_LIMIT transactions we assume it's a veteran wallet → skip.
 */
const MAX_SIG_LIMIT = 300; // bundle wallets are almost always brand-new

interface WalletInfo {
  fundingTime: number | null;
  funder: string | null;      // who sent the first SOL tx to this wallet
  funderIsExchange: boolean;  // true if funder has 300+ txs (exchange hot wallet)
}

// Cache stores both funding time and funder source
const walletInfoCache = new Map<string, WalletInfo>();

async function getWalletInfo(wallet: string): Promise<WalletInfo> {
  const cached = walletInfoCache.get(wallet);
  if (cached) return cached;

  const sigBatches: any[] = [];
  let before: string | undefined = undefined;

  for (let page = 0; page < 2; page++) {
    const params: any = { limit: MAX_SIG_LIMIT };
    if (before) params.before = before;

    const sigs: any[] = await rpc('getSignaturesForAddress', [wallet, params]);
    if (!sigs || sigs.length === 0) break;

    sigBatches.push(...sigs);

    if (sigs.length < MAX_SIG_LIMIT) break;
    before = sigs[sigs.length - 1].signature;
  }

  if (sigBatches.length === 0) {
    const info: WalletInfo = { fundingTime: null, funder: null, funderIsExchange: false };
    walletInfoCache.set(wallet, info);
    return info;
  }

  const oldest = sigBatches[sigBatches.length - 1];
  const time = oldest?.blockTime ?? null;

  // Try to get the funder from the oldest transaction
  let funder: string | null = null;
  try {
    const txData = await rpc('getTransaction', [oldest.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    const accounts: string[] = txData?.transaction?.message?.accountKeys?.map((a: any) => typeof a === 'string' ? a : a.pubkey) ?? [];
    // Funder = first account that isn't the wallet itself (usually the fee payer / sender)
    funder = accounts.find((a: string) => a !== wallet) ?? null;
  } catch { }

  const info: WalletInfo = { fundingTime: time, funder, funderIsExchange: false };
  walletInfoCache.set(wallet, info);

  // Also update the old cache for backwards compat
  cacheSet(wallet, time ?? -1);

  return info;
}

// Keep old function working for the batched fetcher
async function getWalletFundingTime(wallet: string): Promise<number | null> {
  const info = await getWalletInfo(wallet);
  return info.fundingTime;
}

/**
 * Fetch funding times for wallets in throttled batches of 5
 * to avoid hammering the RPC and getting rate limited.
 */
interface BatchedWalletData {
  fundingTimes: number[];
  funders: string[];           // funder address for each wallet
  exchangeFundedCount: number; // how many holders were funded by exchange-like wallets
  totalWithFunder: number;     // how many holders we could identify a funder for
}

async function getWalletDataBatched(wallets: string[]): Promise<BatchedWalletData> {
  const fundingTimes: number[] = [];
  const funders: string[] = [];
  let exchangeFundedCount = 0;
  let totalWithFunder = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(w => getWalletInfo(w)));

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.fundingTime !== null) fundingTimes.push(r.value.fundingTime);
        if (r.value.funder) {
          funders.push(r.value.funder);
          totalWithFunder++;
          if (r.value.funderIsExchange) exchangeFundedCount++;
        }
      }
    }

    if (i + BATCH_SIZE < wallets.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return { fundingTimes, funders, exchangeFundedCount, totalWithFunder };
}

/**
 * Check if a token's top holders show signs of bundling.
 *
 * Flow:
 *  1. getTokenLargestAccounts  → top token accounts by balance
 *  2. getMultipleAccountsInfo  → resolve each token account → owner wallet
 *  3. getSignaturesForAddress  → find each owner wallet's FIRST SOL transaction (wallet funding time)
 *  4. Cluster analysis         → if too many wallets were funded in the same short window → bundled
 */
export async function checkBundle(mint: string): Promise<BundleResult> {
  if (!CONFIG.BUNDLE_CHECK_ENABLED) {
    return { safe: true, clusterPct: 0, maxCluster: 0, totalChecked: 0, details: 'disabled' };
  }

  // Retry once on failure (rate limits, transient errors)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await _checkBundleInner(mint);
    if (result !== null) return result;
    if (attempt < 2) {
      console.log(`[Bundle] Retrying ${mint.slice(0, 8)}... in 3s (attempt ${attempt} failed)`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Fail CLOSED — if we can't verify, don't buy
  console.error(`[Bundle] Check failed after 2 attempts for ${mint.slice(0, 8)}... — blocking alert`);
  return { safe: false, clusterPct: 0, maxCluster: 0, totalChecked: 0, details: 'RPC failed — blocked (fail closed)' };
}

async function _checkBundleInner(mint: string): Promise<BundleResult | null> {
  try {
    // 1. Top token accounts
    const largest = await rpc('getTokenLargestAccounts', [mint]);
    const tokenAccts: { address: string }[] = (largest.value ?? []).slice(0, CONFIG.BUNDLE_TOP_HOLDERS);

    if (tokenAccts.length < 5) {
      return { safe: false, clusterPct: 0, maxCluster: 0, totalChecked: tokenAccts.length, details: 'too few holders — blocked (fail closed)' };
    }

    // 2. Resolve token accounts → owner wallets
    const ownerWallets = await resolveOwnerWallets(tokenAccts.map(a => a.address));

    if (ownerWallets.length < 3) {
      return { safe: false, clusterPct: 0, maxCluster: 0, totalChecked: ownerWallets.length, details: 'could not resolve owners — blocked (fail closed)' };
    }

    // 2b. SOL balance clustering — if too many holders have nearly identical balances,
    //     it's likely coordinated (exchange withdrawal farms all get same amount)
    let balanceFail = false;
    let balanceClusterPct = 0;
    let balanceClusterMax = 0;
    try {
      const balInfos = await rpc('getMultipleAccounts', [ownerWallets, { encoding: 'jsonParsed' }]);
      const balances: number[] = [];
      for (const acc of balInfos.value ?? []) {
        if (acc) balances.push((acc.lamports ?? 0) / 1e9);
      }
      if (balances.length >= 5) {
        // Bucket balances to nearest 0.1 SOL and find largest cluster
        // Count wallets with very low SOL (< 0.15) — exchange farm wallets
        // get a small fixed withdrawal and barely use them
        const buckets = new Map<number, number>();
        let microCount = 0;
        for (const b of balances) {
          const bucket = Math.round(b * 10) / 10; // round to 0.1
          buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
          if (b < 0.15) microCount++;
        }
        for (const count of buckets.values()) {
          if (count > balanceClusterMax) balanceClusterMax = count;
        }
        if (microCount > balanceClusterMax) balanceClusterMax = microCount;
        balanceClusterPct = Math.round((balanceClusterMax / balances.length) * 100);
        balanceFail = balanceClusterPct >= 35; // 35%+ micro-balance wallets = exchange farm
      }
    } catch { /* non-critical, skip */ }

    // 3. Fetch wallet funding times + funder sources — throttled batches of 5 with caching
    const walletData = await getWalletDataBatched(ownerWallets);
    const { fundingTimes, funders } = walletData;

    if (fundingTimes.length < 3) {
      return { safe: false, clusterPct: 0, maxCluster: 0, totalChecked: fundingTimes.length, details: 'insufficient wallet data — blocked (fail closed)' };
    }

    // 4a. Same-funder check: if too many holders were funded by the same source wallet
    //     (catches exchange-routed rug setups like OKX wallet farms)
    let sameFunderFail = false;
    let sameFunderPct = 0;
    let sameFunderMax = 0;
    let topFunder = '';
    if (funders.length >= 3) {
      const funderCounts = new Map<string, number>();
      for (const f of funders) {
        funderCounts.set(f, (funderCounts.get(f) ?? 0) + 1);
      }
      for (const [addr, count] of funderCounts) {
        if (count > sameFunderMax) {
          sameFunderMax = count;
          topFunder = addr;
        }
      }
      sameFunderPct = Math.round((sameFunderMax / funders.length) * 100);
      sameFunderFail = sameFunderPct >= 25; // 25%+ from same funder = skip
    }

    // 4b. Cluster analysis: largest group of wallets funded within the time window
    fundingTimes.sort((a, b) => a - b);

    // Helper: find largest cluster for a given window size (seconds)
    const findMaxCluster = (windowSec: number): number => {
      let max = 0;
      for (let i = 0; i < fundingTimes.length; i++) {
        let count = 0;
        for (let j = i; j < fundingTimes.length; j++) {
          if (fundingTimes[j] - fundingTimes[i] <= windowSec) {
            count++;
          } else {
            break;
          }
        }
        max = Math.max(max, count);
      }
      return max;
    };

    // Narrow window (5 min) — catches same-block bundles
    const maxCluster = findMaxCluster(CONFIG.BUNDLE_TIME_WINDOW_SEC);
    const clusterPct = Math.round((maxCluster / fundingTimes.length) * 100);

    // Wide window (7 days) — catches coordinated wallet farms
    const WIDE_WINDOW_SEC = 7 * 24 * 60 * 60; // 7 days
    const wideMaxCluster = findMaxCluster(WIDE_WINDOW_SEC);
    const wideClusterPct = Math.round((wideMaxCluster / fundingTimes.length) * 100);

    // Fail if ANY check triggers
    const narrowFail = clusterPct >= CONFIG.BUNDLE_MAX_CLUSTER_PCT;
    const wideFail = wideClusterPct >= CONFIG.BUNDLE_WIDE_CLUSTER_PCT;
    const safe = !narrowFail && !wideFail && !sameFunderFail && !balanceFail;

    const reasons: string[] = [];
    reasons.push(`${maxCluster}/${fundingTimes.length} in 5min (${clusterPct}%)`);
    reasons.push(`${wideMaxCluster}/${fundingTimes.length} in 7d (${wideClusterPct}%)`);
    if (funders.length >= 3) {
      reasons.push(`${sameFunderMax}/${funders.length} same funder (${sameFunderPct}%)`);
    }
    if (balanceClusterMax > 0) {
      reasons.push(`${balanceClusterMax} same bal (${balanceClusterPct}%)`);
    }

    return {
      safe,
      clusterPct,
      maxCluster,
      wideClusterPct,
      wideMaxCluster,
      totalChecked: fundingTimes.length,
      details: reasons.join(' | ') + (narrowFail ? ' [NARROW FAIL]' : '') + (wideFail ? ' [WIDE FAIL]' : '') + (sameFunderFail ? ` [SAME FUNDER: ${topFunder.slice(0,8)}...]` : '') + (balanceFail ? ' [BALANCE CLUSTER]' : ''),
    };
  } catch (err: any) {
    console.error(`[Bundle] Check failed for ${mint.slice(0, 8)}...: ${err.message}`);
    return null; // signal retry
  }
}
