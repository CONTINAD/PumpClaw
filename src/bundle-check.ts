import { CONFIG } from './config.js';
import { sendOpsAlert } from './discord.js';
import { checkWalletGraph } from './wallet-graph.js';

export interface BundleResult {
  safe: boolean;
  clusterPct: number;
  maxCluster: number;
  totalChecked: number;
  details: string;
  wideClusterPct?: number;   // cluster % using wider window (7 days)
  wideMaxCluster?: number;
  /**
   * Everything the check learned, kept rather than reduced to a yes/no.
   *
   * These numbers were computed on every call and discarded, which made it
   * impossible to ask the only question that matters over time: which of them
   * actually predicts a loss. A verdict tells you what was blocked; these tell
   * you whether the threshold was in the right place.
   */
  metrics?: {
    freshWallets: number;      // holders young enough to have a readable funding time
    veterans: number;          // high-activity holders, excluded from funding-time maths
    graphChecked: number;      // holders the wallet graph could resolve
    graphHubPct: number;       // share funded by one address
    graphPeerPct: number;      // share that funded each other
    devHoldPct?: number;       // largest non-pool wallet's share of supply
    cohortSpanDays?: number;   // spread of veteran activity spans
    sameFunderPct?: number;
    lowBalPct?: number;
    exchangeFundedPct?: number;
    /** Shadow only — recorded, never blocks. Wallets one funder created inside
     *  SLOT_CLUSTER_WINDOW slots of each other. */
    slotClusterSize?: number;
    slotClusterSpan?: number;
    slotClusterFunder?: string;
  };
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

// Primary + fallback endpoints. Sticky index: once an endpoint works we keep using
// it instead of re-burning a dead primary on every single request.
const RPC_ENDPOINTS = [CONFIG.HELIUS_RPC, ...CONFIG.RPC_FALLBACKS].filter(Boolean);
let rpcEndpointIdx = 0;

async function rpc(method: string, params: any[]): Promise<any> {
  let lastErr: Error | null = null;
  for (let i = 0; i < Math.max(RPC_ENDPOINTS.length, 1); i++) {
    const idx = (rpcEndpointIdx + i) % RPC_ENDPOINTS.length;
    try {
      const res = await fetch(RPC_ENDPOINTS[idx], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      // Non-JSON bodies ("max usage reached", HTML error pages) must surface readably
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch {
        throw new Error(`RPC ${method}: non-JSON response "${text.slice(0, 60)}"`);
      }
      if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
      rpcEndpointIdx = idx;
      return data.result;
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(`RPC ${method}: no endpoints configured`);
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
  /** Slot of that first transaction. Seconds are too coarse to separate wallets
   *  funded in one script from wallets funded in the same minute by chance. */
  fundingSlot: number | null;
  funderIsExchange: boolean;  // true if funder has 300+ txs (exchange hot wallet)
  veteran: boolean;           // 600+ txs — real funding time unknowable, excluded from clustering
  /** For veterans: days covered by the transactions we could fetch. Not the wallet's
   *  age — it is how fast the wallet burns through activity, which is a fingerprint.
   *  Cloned farm wallets share it; organic holders do not. */
  activitySpanDays?: number;
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
    const info: WalletInfo = { fundingTime: null, funder: null, fundingSlot: null, funderIsExchange: false, veteran: false };
    walletInfoCache.set(wallet, info);
    return info;
  }

  // Hit the pagination cap → veteran wallet. Its oldest fetched sig is NOT its funding
  // tx (just its ~600th most recent), so a fake-recent funding time would poison the
  // cluster analysis. Bundle/farm wallets are always fresh — veterans are just bots.
  if (sigBatches.length >= MAX_SIG_LIMIT * 2) {
    // Keep how far back those transactions reach. The comment above is right that
    // this is not a funding time — but it was wrong that farms are always fresh.
    // $TOADER was called with all 11 top holders sharing a 23-day activity span and
    // zero organic buyers, which no threshold here could see once this was discarded.
    const oldestSig = sigBatches[sigBatches.length - 1];
    const spanDays = oldestSig?.blockTime
      ? (Date.now() / 1000 - oldestSig.blockTime) / 86400 : undefined;
    const info: WalletInfo = { fundingTime: null, funder: null, fundingSlot: null, funderIsExchange: false, veteran: true, activitySpanDays: spanDays };
    walletInfoCache.set(wallet, info);
    return info;
  }

  const oldest = sigBatches[sigBatches.length - 1];
  const time = oldest?.blockTime ?? null;

  // Try to get the funder from the oldest transaction
  let funder: string | null = null;
  let fundingSlot: number | null = null;
  try {
    const txData = await rpc('getTransaction', [oldest.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    fundingSlot = typeof txData?.slot === 'number' ? txData.slot : null;
    const accounts: string[] = txData?.transaction?.message?.accountKeys?.map((a: any) => typeof a === 'string' ? a : a.pubkey) ?? [];
    // Funder = first account that isn't the wallet itself (usually the fee payer / sender)
    funder = accounts.find((a: string) => a !== wallet) ?? null;
  } catch { }

  const info: WalletInfo = { fundingTime: time, funder, fundingSlot, funderIsExchange: false, veteran: false };
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
  funderSlots: { funder: string; slot: number }[];  // funder + the slot it funded in
  exchangeFundedCount: number; // how many holders were funded by exchange-like wallets
  totalWithFunder: number;     // how many holders we could identify a funder for
  veteranCount: number;        // holders with 600+ txs (excluded from clustering)
  veteranSpans: number[];      // their activity spans, for cohort detection
}

async function getWalletDataBatched(wallets: string[]): Promise<BatchedWalletData> {
  const fundingTimes: number[] = [];
  const funders: string[] = [];
  const funderSlots: { funder: string; slot: number }[] = [];
  let exchangeFundedCount = 0;
  let totalWithFunder = 0;
  let veteranCount = 0;
  const veteranSpans: number[] = [];
  // 10-wallet batches with short gaps — sized for a paid Helius plan. The old
  // 5/300ms pacing added ~20s of latency per call under the free tier's limits.
  const BATCH_SIZE = 10;

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(w => getWalletInfo(w)));

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.veteran) {
          veteranCount++;
          if (typeof r.value.activitySpanDays === 'number') veteranSpans.push(r.value.activitySpanDays);
        }
        if (r.value.fundingTime !== null) fundingTimes.push(r.value.fundingTime);
        if (r.value.funder) {
          funders.push(r.value.funder);
          if (r.value.fundingSlot !== null) funderSlots.push({ funder: r.value.funder, slot: r.value.fundingSlot });
          totalWithFunder++;
          if (r.value.funderIsExchange) exchangeFundedCount++;
        }
      }
    }

    if (i + BATCH_SIZE < wallets.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  return { fundingTimes, funders, funderSlots, exchangeFundedCount, totalWithFunder, veteranCount, veteranSpans };
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
    if (result !== null) {
      consecutiveRpcFails = 0; // RPC worked — clear the alarm counter
      return result;
    }
    if (attempt < 2) {
      console.log(`[Bundle] Retrying ${mint.slice(0, 8)}... in 1.5s (attempt ${attempt} failed)`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Fail CLOSED — if we can't verify, don't buy
  console.error(`[Bundle] Check failed after 2 attempts for ${mint.slice(0, 8)}... — blocking alert`);
  noteRpcFailure();
  return { safe: false, clusterPct: 0, maxCluster: 0, totalChecked: 0, details: 'RPC failed — blocked (fail closed)' };
}

// ── RPC failure alarm ───────────────────────────────────────
// Fail-closed is correct per-coin, but a dead RPC key means EVERY coin gets silently
// blocked (this caused a multi-day call drought once). After 3 consecutive RPC-failed
// blocks, yell in Discord — at most once every 6 hours.
let consecutiveRpcFails = 0;
let lastRpcAlarmAt = 0;

function noteRpcFailure(): void {
  consecutiveRpcFails++;
  if (consecutiveRpcFails >= 3 && Date.now() - lastRpcAlarmAt > 6 * 60 * 60 * 1000) {
    lastRpcAlarmAt = Date.now();
    sendOpsAlert(
      `Bundle-check RPC has failed ${consecutiveRpcFails} times in a row — **ALL calls are being blocked** (fail closed). ` +
      `Check the Helius key usage/billing, or add a backup key via the RPC_FALLBACKS env var.`,
    ).catch(() => {});
  }
}

async function _checkBundleInner(mint: string): Promise<BundleResult | null> {
  // Kept across the whole check so the final result can report what was measured,
  // not just what was decided.
  let devHoldPct: number | undefined;
  let cohortSpan: number | undefined;
  try {
    // 1. Top token accounts
    const largest = await rpc('getTokenLargestAccounts', [mint]);
    const tokenAccts: { address: string }[] = (largest.value ?? []).slice(0, CONFIG.BUNDLE_TOP_HOLDERS);

    if (tokenAccts.length < 5) {
      return { safe: false, clusterPct: 0, maxCluster: 0, totalChecked: tokenAccts.length, details: 'too few holders — blocked (fail closed)' };
    }

    // 1b. Single-wallet supply concentration.
    //
    // The largest holder is the AMM pool (or the bonding curve pre-migration) and
    // is skipped — it holds most of the supply by construction. The wallet after
    // it is, on a fresh launch, usually the dev. If that one wallet can dump a
    // fifth of the supply, no exit strategy survives the decision; the stop fires
    // into a book that is already gone.
    //
    // Costs one extra RPC call per candidate, not one per holder: the balances
    // come back with getTokenLargestAccounts above, and only the supply is new.
    if (CONFIG.MAX_SINGLE_HOLDER_PCT > 0) {
      try {
        const supplyRes = await rpc('getTokenSupply', [mint]);
        const supply = parseFloat(supplyRes?.value?.uiAmountString ?? supplyRes?.value?.uiAmount ?? '0');
        const amounts = (largest.value ?? [])
          .map((a: any) => parseFloat(a?.uiAmountString ?? a?.uiAmount ?? '0'))
          .filter((n: number) => Number.isFinite(n) && n > 0)
          .sort((a: number, b: number) => b - a);
        if (supply > 0 && amounts.length >= 2) {
          const topNonPool = amounts[1];              // [0] is the pool
          const pctHeld = (topNonPool / supply) * 100;
          devHoldPct = pctHeld;
          if (pctHeld >= CONFIG.MAX_SINGLE_HOLDER_PCT) {
            return {
              safe: false, clusterPct: 0, maxCluster: 0, totalChecked: tokenAccts.length,
              details: `single wallet holds ${pctHeld.toFixed(1)}% of supply (max ${CONFIG.MAX_SINGLE_HOLDER_PCT}%) [DEV HOLDS]`,
            };
          }
        }
      } catch {
        // Supply lookup failed. Deliberately does NOT block — the checks below are
        // the real defence, and failing closed on a single optional call would turn
        // an RPC hiccup into a call drought.
      }
    }

    // 2. Resolve token accounts → owner wallets
    const ownerWallets = await resolveOwnerWallets(tokenAccts.map(a => a.address));

    if (ownerWallets.length < 3) {
      return { safe: false, clusterPct: 0, maxCluster: 0, totalChecked: ownerWallets.length, details: 'could not resolve owners — blocked (fail closed)' };
    }

    // 2b. SOL balance clustering — if too many holders have nearly identical balances,
    //     it's likely coordinated (exchange withdrawal farms all get same amount)
    // 2c. Low balance check — if too many top holders have < 1 SOL, likely throwaway wallets
    let balanceFail = false;
    let balanceClusterPct = 0;
    let balanceClusterMax = 0;
    let lowBalFail = false;
    let lowBalCount = 0;
    let lowBalChecked = 0;
    let lowBalPct = 0;
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
        balanceFail = balanceClusterPct >= 40; // 40%+ same-balance wallets = coordinated

        // Low balance check: top N holders with < threshold SOL
        const topN = balances.slice(0, CONFIG.BUNDLE_LOW_BAL_HOLDERS);
        lowBalChecked = topN.length;
        lowBalCount = topN.filter(b => b < CONFIG.BUNDLE_LOW_BAL_SOL).length;
        lowBalPct = lowBalChecked > 0 ? Math.round((lowBalCount / lowBalChecked) * 100) : 0;
        lowBalFail = lowBalPct >= CONFIG.BUNDLE_LOW_BAL_PCT;
      }
    } catch { /* non-critical, skip */ }

    // 3. Fetch wallet funding times + funder sources — throttled batches of 5 with caching
    const walletData = await getWalletDataBatched(ownerWallets);
    const { fundingTimes, funders, funderSlots, veteranCount, veteranSpans } = walletData;

    if (fundingTimes.length + veteranCount < 3) {
      return { safe: false, clusterPct: 0, maxCluster: 0, totalChecked: fundingTimes.length, details: 'insufficient wallet data — blocked (fail closed)' };
    }

    // Wallet-graph check — reads the actual transfer topology (who funded whom).
    // This is the only check that sees farms built from constantly-active wallets.
    const graph = CONFIG.GRAPH_CHECK_ENABLED
      ? await checkWalletGraph(ownerWallets)
      : { checked: 0, hubPct: 0, hubAddress: '', peerLinkPct: 0, suspicious: false, details: '' };

    if (graph.suspicious) {
      return {
        safe: false, clusterPct: 0, maxCluster: 0, totalChecked: fundingTimes.length,
        details: `${fundingTimes.length} fresh + ${veteranCount} veteran | ${graph.details}`,
      };
    }

    // All-veteran top holders = every funding-time window is 0/0 and reads as clean.
    // A clean wallet graph rescues these (real sniper-heavy launches); only block when
    // we have neither funding-time data NOR graph data to judge on.
    // Aged cohort: no organic buyers, and every veteran holder burns through its
    // history at the same rate. Checked before the unverifiable guard because the
    // graph having data does not rescue this — the graph reads funding that predates
    // the coordination by months.
    if (CONFIG.COHORT_SPAN_DAYS > 0 && fundingTimes.length === 0 && veteranSpans.length >= CONFIG.COHORT_MIN_VETERANS) {
      const lo = Math.min(...veteranSpans), hi = Math.max(...veteranSpans);
      const spread = hi - lo;
      cohortSpan = spread;
      if (spread <= CONFIG.COHORT_SPAN_DAYS) {
        return {
          safe: false, clusterPct: 0, maxCluster: 0, totalChecked: ownerWallets.length,
          details: `aged farm — ${veteranSpans.length} holders, no organic buyers, activity spans ` +
            `${lo.toFixed(0)}-${hi.toFixed(0)}d (${spread.toFixed(0)}d apart, max ${CONFIG.COHORT_SPAN_DAYS}) [AGED COHORT]`,
        };
      }
    }

    if (CONFIG.BUNDLE_BLOCK_UNVERIFIABLE && fundingTimes.length < CONFIG.BUNDLE_MIN_VERIFIABLE && graph.checked < 3) {
      return {
        safe: false, clusterPct: 0, maxCluster: 0, totalChecked: fundingTimes.length,
        details: `unverifiable — ${fundingTimes.length} fresh of ${ownerWallets.length} holders (${veteranCount} high-activity), no graph data [UNVERIFIABLE]`,
      };
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

    // 4b. SHADOW ONLY — measured and recorded, never blocks a call.
    //
    // JOEY was called and rugged 12 minutes later. Three holders had been funded by
    // one wallet in slots 437094456, 437094457 and 437094456 — nine days before the
    // launch, so every age test cleared them. They took ~1% each, sold together, and
    // the price went -98%. The same-funder test above scored that 22% against its 25%
    // threshold and passed it.
    //
    // The weakness is that the test is a *percentage of sampled holders*, so a real
    // cluster is diluted by however many organic holders land in the sample. Slot
    // adjacency does not dilute. Three wallets whose first transactions sit within a
    // few slots of each other, from one funder, is a script — not a coincidence at
    // any percentage.
    //
    // This cannot be validated against past calls: it has to read holders as they
    // were at call time, and for any coin more than a few hours old the launch
    // holders are long gone. Checked against JOEY after the dump it finds nothing,
    // because the wallets it is looking for already sold. So it runs alongside the
    // real filters and records what it would have done, and only becomes a blocking
    // rule once the log shows it firing on rugs and not on winners.
    let slotClusterSize = 0;
    let slotClusterFunder = '';
    let slotClusterSpan = 0;
    {
      const bySlotFunder = new Map<string, number[]>();
      for (const { funder, slot } of funderSlots) {
        const arr = bySlotFunder.get(funder) ?? [];
        arr.push(slot);
        bySlotFunder.set(funder, arr);
      }
      for (const [addr, slotsRaw] of bySlotFunder) {
        if (slotsRaw.length < CONFIG.SLOT_CLUSTER_MIN_WALLETS) continue;
        const slots = [...slotsRaw].sort((a, b) => a - b);
        // Widest run of wallets this funder created inside the slot window.
        for (let i = 0; i < slots.length; i++) {
          let j = i;
          while (j + 1 < slots.length && slots[j + 1] - slots[i] <= CONFIG.SLOT_CLUSTER_WINDOW) j++;
          const size = j - i + 1;
          if (size >= CONFIG.SLOT_CLUSTER_MIN_WALLETS && size > slotClusterSize) {
            slotClusterSize = size;
            slotClusterFunder = addr;
            slotClusterSpan = slots[j] - slots[i];
          }
        }
      }
      if (slotClusterSize > 0) {
        console.log(`[Bundle:SHADOW] ${mint.slice(0, 8)}… slot cluster — ${slotClusterSize} wallets ` +
          `from ${slotClusterFunder.slice(0, 8)}… within ${slotClusterSpan} slots (not blocking)`);
      }
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
    const maxCluster = fundingTimes.length >= 3 ? findMaxCluster(CONFIG.BUNDLE_TIME_WINDOW_SEC) : 0;
    const clusterPct = fundingTimes.length >= 3 ? Math.round((maxCluster / fundingTimes.length) * 100) : 0;

    // Hour / day / wide windows — "time-linked funding" (Axiom-style). Wallet farms get
    // funded over 10-60 min, which slips between the 5-min and 7-day windows.
    // Only run these with a decent fresh-wallet sample so tiny samples can't false-trip.
    const enoughFresh = fundingTimes.length >= CONFIG.BUNDLE_MIN_FRESH_WALLETS;
    const hourMaxCluster = enoughFresh ? findMaxCluster(3600) : 0;
    const hourClusterPct = enoughFresh ? Math.round((hourMaxCluster / fundingTimes.length) * 100) : 0;
    const dayMaxCluster = enoughFresh ? findMaxCluster(24 * 60 * 60) : 0;
    const dayClusterPct = enoughFresh ? Math.round((dayMaxCluster / fundingTimes.length) * 100) : 0;
    const wideMaxCluster = enoughFresh ? findMaxCluster(7 * 24 * 60 * 60) : 0;
    const wideClusterPct = enoughFresh ? Math.round((wideMaxCluster / fundingTimes.length) * 100) : 0;

    // Fail if ANY check triggers. Each window also needs 3+ wallets in the cluster —
    // 2 wallets funded the same day is a coincidence, a farm is never that small.
    const narrowFail = maxCluster >= 3 && clusterPct >= CONFIG.BUNDLE_MAX_CLUSTER_PCT;
    const hourFail = hourMaxCluster >= 3 && hourClusterPct >= CONFIG.BUNDLE_HOUR_CLUSTER_PCT;
    const dayFail = dayMaxCluster >= 3 && dayClusterPct >= CONFIG.BUNDLE_DAY_CLUSTER_PCT;
    const wideFail = wideMaxCluster >= 3 && wideClusterPct >= CONFIG.BUNDLE_WIDE_CLUSTER_PCT;
    const safe = !narrowFail && !hourFail && !dayFail && !wideFail && !sameFunderFail && !balanceFail && !lowBalFail;

    const reasons: string[] = [];
    reasons.push(`${fundingTimes.length} fresh + ${veteranCount} veteran`);
    if (graph.checked >= 3) reasons.push(graph.details);
    reasons.push(`${maxCluster}/${fundingTimes.length} in 5min (${clusterPct}%)`);
    reasons.push(`${hourMaxCluster}/${fundingTimes.length} in 1h (${hourClusterPct}%)`);
    reasons.push(`${dayMaxCluster}/${fundingTimes.length} in 24h (${dayClusterPct}%)`);
    reasons.push(`${wideMaxCluster}/${fundingTimes.length} in 7d (${wideClusterPct}%)`);
    if (funders.length >= 3) {
      reasons.push(`${sameFunderMax}/${funders.length} same funder (${sameFunderPct}%)`);
    }
    if (balanceClusterMax > 0) {
      reasons.push(`${balanceClusterMax} same bal (${balanceClusterPct}%)`);
    }
    if (lowBalChecked > 0) {
      reasons.push(`${lowBalCount}/${lowBalChecked} <${CONFIG.BUNDLE_LOW_BAL_SOL}SOL (${lowBalPct}%)`);
    }

    return {
      safe,
      clusterPct,
      maxCluster,
      wideClusterPct,
      wideMaxCluster,
      totalChecked: fundingTimes.length,
      metrics: {
        freshWallets: fundingTimes.length,
        veterans: veteranCount,
        graphChecked: graph.checked,
        graphHubPct: graph.hubPct,
        graphPeerPct: graph.peerLinkPct,
        devHoldPct,
        cohortSpanDays: cohortSpan,
        sameFunderPct,
        lowBalPct,
        slotClusterSize,
        slotClusterSpan: slotClusterSize > 0 ? slotClusterSpan : undefined,
        slotClusterFunder: slotClusterSize > 0 ? slotClusterFunder : undefined,
        exchangeFundedPct: walletData.totalWithFunder > 0
          ? Math.round(walletData.exchangeFundedCount / walletData.totalWithFunder * 100) : undefined,
      },
      details: reasons.join(' | ') + (narrowFail ? ' [NARROW FAIL]' : '') + (hourFail ? ' [TIME-LINKED 1H FAIL]' : '') + (dayFail ? ' [TIME-LINKED 24H FAIL]' : '') + (wideFail ? ' [WIDE FAIL]' : '') + (sameFunderFail ? ` [SAME FUNDER: ${topFunder.slice(0,8)}...]` : '') + (balanceFail ? ' [BALANCE CLUSTER]' : '') + (lowBalFail ? ' [LOW BAL HOLDERS]' : '')
        + (slotClusterSize > 0 ? ` [SHADOW SLOT-CLUSTER: ${slotClusterSize} wallets from ${slotClusterFunder.slice(0, 8)}… in ${slotClusterSpan} slots]` : ''),
    };
  } catch (err: any) {
    console.error(`[Bundle] Check failed for ${mint.slice(0, 8)}...: ${err.message}`);
    return null; // signal retry
  }
}
