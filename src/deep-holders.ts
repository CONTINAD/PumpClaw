/**
 * The holder set past the twentieth wallet.
 *
 * `getTokenLargestAccounts` is a Solana core method with a hard cap of 20 results.
 * That cap, not a config choice, is why the bundle check has never been able to see
 * a funder cluster bigger than 20 — it cannot hold more than 20 wallets in the first
 * place. A launch that spreads across 31 wallets is invisible to it by construction.
 *
 * Helius's DAS `getTokenAccounts` has no such cap and pages properly. Measured on
 * $WISH: 159 unique owners in 343ms, against the 20 the core method returns.
 *
 * This is measurement only. It never blocks, never throws into the caller, and has
 * no vote in whether a coin is bought — `checkBundle` remains the sole decider. The
 * point is to find out whether deeper clustering predicts anything the existing
 * 20-wallet read does not, before anyone is tempted to act on it.
 *
 * Cost, measured at 145ms median per wallet with 10-wide batching:
 *   20 wallets ≈ 0.4s   ·   50 ≈ 1.1s   ·   100 ≈ 2.4s
 * against a scan that currently takes ~5s on a coin already 3 minutes old.
 */
import { CONFIG } from './config.js';
import { rpc, getWalletInfo } from './bundle-check.js';

export interface DeepHolders {
  /** Raw token accounts seen, before grouping by owner. */
  accounts: number;
  /** Distinct owner wallets — the number a human means by "holders". */
  owners: number;
  /** How many of those we actually traced (capped for latency). */
  traced: number;
  fresh: number;
  veterans: number;
  /** Largest set of traced wallets sharing one funding wallet. */
  largestCluster: number;
  /** That cluster as a share of traced wallets. */
  clusterPct: number;
  clusterFunder: string | null;
  /** Traced wallets not in any funder cluster of 2 or more. */
  independent: number;
  /** Distinct funders seen — a farm has few, an organic holder set has many. */
  funders: number;
  /** Wallets that could not be traced even after a retry, almost always rate limits. */
  failed: number;
  /** traced / (traced + failed). A cluster share measured on a third of the wallets
   *  is not a cluster share, so every consumer must be able to see the coverage. */
  coverage: number;
  ms: number;
}

const MAX_TRACE = 100;
const BATCH = 10;

/** How many pages of 1000 accounts to pull. One is plenty for a coin this young. */
const PAGES = 1;

export async function deepHolderScan(mint: string): Promise<DeepHolders | null> {
  if (!CONFIG.BUNDLE_CHECK_ENABLED) return null;
  const t0 = Date.now();
  try {
    const totals = new Map<string, bigint>();
    let accounts = 0;
    for (let page = 1; page <= PAGES; page++) {
      const res = await rpc('getTokenAccounts', { mint, limit: 1000, page });
      const list: any[] = res?.token_accounts ?? [];
      if (list.length === 0) break;
      accounts += list.length;
      for (const t of list) {
        if (!t?.owner) continue;
        let amt: bigint;
        try { amt = BigInt(t.amount ?? 0); } catch { amt = 0n; }
        totals.set(t.owner, (totals.get(t.owner) ?? 0n) + amt);
      }
      if (list.length < 1000) break;
    }
    if (totals.size === 0) return null;

    const ranked = [...totals.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
      .slice(1)                       // the pool / bonding curve
      .map(([owner]) => owner);

    const wallets = ranked.slice(0, MAX_TRACE);
    const funderCounts = new Map<string, number>();
    let fresh = 0, veterans = 0, traced = 0;

    // A rate-limited wallet is not an absent wallet. Dropping it silently shrinks the
    // denominator and inflates every cluster share computed from it, so failures are
    // retried once at a slower pace and whatever still fails is reported as failed
    // rather than quietly forgotten.
    const take = async (batch: string[], gapMs: number): Promise<string[]> => {
      const retry: string[] = [];
      const results = await Promise.allSettled(batch.map(w => getWalletInfo(w)));
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') { retry.push(batch[i]); return; }
        traced++;
        if (r.value.veteran) veterans++;
        else if (r.value.fundingTime !== null) fresh++;
        if (r.value.funder) {
          funderCounts.set(r.value.funder, (funderCounts.get(r.value.funder) ?? 0) + 1);
        }
      });
      if (gapMs) await new Promise(r => setTimeout(r, gapMs));
      return retry;
    };

    let pending: string[] = [];
    for (let i = 0; i < wallets.length; i += BATCH) {
      pending.push(...await take(wallets.slice(i, i + BATCH), i + BATCH < wallets.length ? 100 : 0));
    }
    // Second pass, half as wide and four times the gap. getWalletInfo caches, so a
    // wallet that succeeded first time is never re-fetched.
    let stillFailed = 0;
    for (let i = 0; i < pending.length; i += 5) {
      stillFailed += (await take(pending.slice(i, i + 5), 400)).length;
    }

    let largestCluster = 0;
    let clusterFunder: string | null = null;
    let clustered = 0;
    for (const [funder, n] of funderCounts) {
      if (n >= 2) clustered += n;
      if (n > largestCluster) { largestCluster = n; clusterFunder = funder; }
    }

    return {
      accounts,
      owners: totals.size,
      traced,
      fresh,
      veterans,
      largestCluster,
      clusterPct: traced > 0 ? Math.round(largestCluster / traced * 100) : 0,
      clusterFunder,
      independent: Math.max(0, traced - clustered),
      funders: funderCounts.size,
      failed: stillFailed,
      coverage: traced + stillFailed > 0 ? Math.round(traced / (traced + stillFailed) * 100) : 0,
      ms: Date.now() - t0,
    };
  } catch (err: any) {
    // Measurement must never be able to affect a trade. Swallow and report nothing.
    console.log(`[DeepHolders] ${mint.slice(0, 8)}… skipped: ${err?.message ?? err}`);
    return null;
  }
}
