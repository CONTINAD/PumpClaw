/**
 * Wallet-graph analysis — the "bubble map" check.
 *
 * Funding-time clustering is blind to farms built from active wallets: they trade
 * constantly, so their first transaction is ancient and tells us nothing. What a
 * bubble map actually shows is the TRANSFER GRAPH — one wallet fanning SOL out to
 * dozens of holders (a hub), or holders sending SOL to each other (peer links).
 * This reads that graph directly from Helius' enhanced transaction API.
 */
import { CONFIG } from './config.js';

export interface GraphResult {
  checked: number;        // holders we got transfer data for
  hubPct: number;         // % of holders funded by the single most common source
  hubAddress: string;
  peerLinkPct: number;    // % of holders that received SOL from another holder
  /** Largest set of holders reachable from one another through funding transfers,
   *  at any number of hops. This is the number a bubble map shows as one blob. */
  clusterSize: number;
  clusterPct: number;
  suspicious: boolean;
  details: string;
}

// Exchange hot wallets legitimately fund many unrelated users — not a farm signal.
const KNOWN_EXCHANGES = new Set([
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',  // Binance
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',  // Binance 2
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S',  // Coinbase
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',  // Coinbase 2
  '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD',  // OKX
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2',  // Bybit
  'u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w',   // Gate
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm',  // Kraken
]);

const MIN_FUND_SOL = 0.01;   // ignore dust/fee refunds
// Was 15. The holder read now returns up to 60 wallets via DAS, and sampling a
// quarter of them is how $BTC passed: 58 holders, 56 of them aged wallets that all
// exited together, and the graph check reported "0/14 peer-linked" because it never
// looked at wallets 15 through 58. A bubble map showed one connected blob.
const MAX_HOLDERS = Number(process.env.GRAPH_MAX_HOLDERS ?? 50);
const TX_LIMIT = 30;

function heliusKey(): string {
  const m = CONFIG.HELIUS_RPC.match(/api-key=([\w-]+)/);
  return m?.[1] ?? '';
}

/** Recent SOL senders for one wallet (excluding itself). */
async function fundingSources(wallet: string, key: string): Promise<string[]> {
  // No type filter — funding frequently arrives inside SWAP/other tx types, and
  // filtering to TRANSFER returned nothing for active farm wallets.
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${key}&limit=${TX_LIMIT}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const txs: any[] = await res.json();
    if (!Array.isArray(txs)) return [];
    const sources = new Set<string>();
    for (const tx of txs) {
      for (const t of tx.nativeTransfers ?? []) {
        if (t.toUserAccount === wallet && t.amount >= MIN_FUND_SOL * 1e9) {
          const from = t.fromUserAccount;
          if (from && from !== wallet && !KNOWN_EXCHANGES.has(from)) sources.add(from);
        }
      }
    }
    return [...sources];
  } catch {
    return [];
  }
}

/**
 * Detect farm topology across a token's top holders.
 * hubPct    — one address funded this share of holders (star pattern)
 * peerLink  — holders funding each other (connected cluster)
 */
export async function checkWalletGraph(holders: string[]): Promise<GraphResult> {
  const key = heliusKey();
  const empty: GraphResult = { checked: 0, hubPct: 0, hubAddress: '', peerLinkPct: 0, clusterSize: 0, clusterPct: 0, suspicious: false, details: 'graph check unavailable' };
  if (!key || holders.length === 0) return empty;

  const targets = holders.slice(0, MAX_HOLDERS);
  const holderSet = new Set(targets);
  const sourcesByHolder = new Map<string, string[]>();

  for (let i = 0; i < targets.length; i += 8) {
    const batch = targets.slice(i, i + 8);
    const results = await Promise.allSettled(batch.map(w => fundingSources(w, key)));
    results.forEach((r, j) => {
      if (r.status === 'fulfilled' && r.value.length > 0) sourcesByHolder.set(batch[j], r.value);
    });
    if (i + 8 < targets.length) await new Promise(r => setTimeout(r, 120));
  }

  const checked = sourcesByHolder.size;
  if (checked < 3) return { ...empty, checked, details: `graph: only ${checked} holder(s) with transfer data` };

  // Hub: how many distinct holders share a single funding source
  const hubCounts = new Map<string, number>();
  let peerLinked = 0;
  for (const [holder, sources] of sourcesByHolder) {
    for (const s of sources) hubCounts.set(s, (hubCounts.get(s) ?? 0) + 1);
    if (sources.some(s => holderSet.has(s) && s !== holder)) peerLinked++;
  }

  let hubAddress = '', hubMax = 0;
  for (const [addr, n] of hubCounts) {
    if (n > hubMax) { hubMax = n; hubAddress = addr; }
  }

  // ── Connected components, which is what a bubble map actually draws ───────────
  //
  // hubPct finds a star: one address funding many holders. peerLink finds a direct
  // edge: holder A funded by holder B. A farm defeats both by funding in a chain —
  // A pays B, B pays C, C pays D — because then every wallet has a different
  // immediate funder and no holder is funded directly by another that we sampled.
  // $BTC scored 0% on both while every wallet sat in one blob on a bubble map.
  //
  // Union-find over holders AND their funders, so two holders are joined when they
  // share a funder or when one funded the other, transitively and at any depth. A
  // non-holder intermediary still merges the two sides because both attach to it.
  // Exchanges are excluded — they legitimately connect thousands of strangers.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    if (r !== x) { r = find(r); parent.set(x, r); }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const [holder, sources] of sourcesByHolder) {
    if (!parent.has(holder)) parent.set(holder, holder);
    for (const src of sources) {
      if (KNOWN_EXCHANGES.has(src)) continue;
      if (!parent.has(src)) parent.set(src, src);
      union(holder, src);
    }
  }
  const compSize = new Map<string, number>();
  for (const holder of sourcesByHolder.keys()) {
    const r = find(holder);
    compSize.set(r, (compSize.get(r) ?? 0) + 1);
  }
  let clusterSize = 0;
  for (const n of compSize.values()) if (n > clusterSize) clusterSize = n;
  const clusterPct = Math.round((clusterSize / checked) * 100);

  const hubPct = Math.round((hubMax / checked) * 100);
  const peerLinkPct = Math.round((peerLinked / checked) * 100);
  // A component only means something once it is several wallets deep — on a small
  // sample two holders sharing one funder is noise, not a farm.
  const clustered = clusterSize >= 4 && clusterPct >= CONFIG.GRAPH_CLUSTER_PCT;
  const suspicious = hubPct >= CONFIG.GRAPH_HUB_PCT || peerLinkPct >= CONFIG.GRAPH_PEER_PCT || clustered;

  const parts = [
    `graph ${hubMax}/${checked} same funder (${hubPct}%)`,
    `${peerLinked}/${checked} peer-linked (${peerLinkPct}%)`,
    `largest cluster ${clusterSize}/${checked} (${clusterPct}%)`,
  ];
  if (suspicious) {
    parts.push(clustered && hubPct < CONFIG.GRAPH_HUB_PCT
      ? `[WALLET GRAPH: one cluster of ${clusterSize}]`
      : `[WALLET GRAPH: ${hubAddress.slice(0, 8)}…]`);
  }

  return { checked, hubPct, hubAddress, peerLinkPct, clusterSize, clusterPct, suspicious, details: parts.join(' | ') };
}
