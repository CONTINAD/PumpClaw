/**
 * Jito block-engine submission and tip sizing.
 *
 * A transaction sent to a normal RPC competes for a slot on priority fee alone.
 * Under load that is how a stop-loss ends up sitting in a queue while the coin
 * keeps falling. Jito routes the transaction to validators running its block
 * engine, and a tip buys inclusion directly.
 *
 * Tips are sized from Jito's own published landed-tip percentiles rather than a
 * hardcoded number, so a quiet network costs a fraction of a cent and a busy one
 * automatically pays what is actually landing. Getting out of a losing position
 * is worth far more than the tip, so exits bid higher than entries.
 */
import { CONFIG } from './config.js';

/** What this transaction is worth paying to land. */
export type Urgency = 'normal' | 'high' | 'critical';

const TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';

/** Endpoints are tried in order; the first to accept the transaction wins. */
const BLOCK_ENGINES = [
  'https://mainnet.block-engine.jito.wtf/api/v1/transactions',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions',
];

// Floors, in lamports. Even when the network is dead quiet we pay at least this,
// because the downside of not landing dwarfs a fraction of a cent.
const FLOOR: Record<Urgency, number> = {
  normal: 5_000,       // entries — a missed buy costs the spread, nothing more
  high: 20_000,        // take-profits
  critical: 100_000,   // stops and panic exits
};

// Which published percentile each urgency targets. These percentiles swing hard
// with congestion — the 99th ran 280k lamports one minute and millions the next —
// so retries escalate from a sane base rather than starting at the top.
const PERCENTILE: Record<Urgency, string> = {
  normal: 'landed_tips_50th_percentile',
  high: 'landed_tips_75th_percentile',
  critical: 'landed_tips_95th_percentile',
};

/** Absolute ceiling on one transaction (0.002 SOL ≈ $0.15). */
const TIP_CAP = 2_000_000;

let cache: { at: number; data: Record<string, number> } = { at: 0, data: {} };

async function tipFloor(): Promise<Record<string, number>> {
  if (Date.now() - cache.at < 60_000 && cache.data) return cache.data;
  try {
    const res = await fetch(TIP_FLOOR_URL, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(String(res.status));
    const body: any = await res.json();
    const row = Array.isArray(body) ? body[0] : body;
    if (row && typeof row === 'object') {
      cache = { at: Date.now(), data: row };
      return row;
    }
  } catch { /* fall through to floors */ }
  return cache.data ?? {};
}

/**
 * Tip for this transaction, in lamports.
 * @param attempt 1-based retry count — each retry outbids the last, since a
 *                transaction that already failed to land needs to try harder.
 */
export async function tipLamports(urgency: Urgency, attempt = 1, maxTip?: number): Promise<number> {
  const floors = await tipFloor();
  const pct = floors[PERCENTILE[urgency]];
  // Published values are in SOL.
  const fromNetwork = typeof pct === 'number' && pct > 0 ? Math.round(pct * 1e9) : 0;
  const base = Math.max(FLOOR[urgency], fromNetwork);
  const escalated = Math.round(base * Math.pow(2, Math.max(0, attempt - 1)));
  // A tip is insurance on the trade, so it is bounded by what the trade is worth.
  // Paying $0.30 to land a $19 exit is not protection, it is a leak. The floor
  // still applies — below it the transaction may never land at all, and an
  // unlandable stop is worth less than the tip either way.
  const ceiling = Math.max(FLOOR[urgency], Math.min(TIP_CAP, maxTip ?? TIP_CAP));
  return Math.min(ceiling, escalated);
}

/**
 * Submit a signed transaction to the Jito block engine.
 * Returns the signature on acceptance, or null if no engine took it — callers
 * always also broadcast through the normal RPC, so null is a soft failure.
 */
export async function sendViaJito(rawTxBase64: string): Promise<string | null> {
  if (!CONFIG.JITO_ENABLED) return null;
  for (const url of BLOCK_ENGINES) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'sendTransaction',
          params: [rawTxBase64, { encoding: 'base64' }],
        }),
      });
      const body: any = await res.json().catch(() => null);
      if (res.ok && body?.result) return body.result as string;
    } catch { /* try the next engine */ }
  }
  return null;
}
