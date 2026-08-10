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
const MAX_HOLDERS = 15;      // cap API calls — top holders are what matter
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
  const empty: GraphResult = { checked: 0, hubPct: 0, hubAddress: '', peerLinkPct: 0, suspicious: false, details: 'graph check unavailable' };
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

  const hubPct = Math.round((hubMax / checked) * 100);
  const peerLinkPct = Math.round((peerLinked / checked) * 100);
  const suspicious = hubPct >= CONFIG.GRAPH_HUB_PCT || peerLinkPct >= CONFIG.GRAPH_PEER_PCT;

  const parts = [`graph ${hubMax}/${checked} same funder (${hubPct}%)`, `${peerLinked}/${checked} peer-linked (${peerLinkPct}%)`];
  if (suspicious) parts.push(`[WALLET GRAPH: ${hubAddress.slice(0, 8)}…]`);

  return { checked, hubPct, hubAddress, peerLinkPct, suspicious, details: parts.join(' | ') };
}
