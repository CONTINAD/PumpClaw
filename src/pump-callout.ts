/**
 * Post a callout to pump.fun after a real buy.
 *
 * pump.fun pays for calls that do well, and every task here buys coins minutes
 * before anyone else looks at them. The endpoints came out of pump.fun's own
 * bundle, and the whole chain has been run by hand once — callout c1486fb9 on
 * $MEMEFI came back 201 with userId GKre7a…Yypd, which is MANIFEST's own wallet:
 *
 *   POST {privy}/api/v1/siws/init          { address } -> { nonce }
 *   POST {privy}/api/v1/siws/authenticate  { message, signature, ... } -> token
 *   GET  /callout/eligibility/{mint}       can this account call this coin
 *   POST /callout/create                   { coinMint, thesis?, version: 2 }
 *                                          -> { callout: { calloutId } }
 *
 * The account has to BE the wallet. pump.fun checks the position of whoever posts,
 * and the coins sit in the task wallets — an owner's separate login can never
 * qualify, no matter whose cookie is used. That was the wrong turn taken first here:
 * a browser session was pasted in, and it 401'd not because it was stale but because
 * that account held none of the coin. Each task signs in as itself instead.
 *
 * NOTHING HERE MAY AFFECT A TRADE. postCallout has no throwing path — every branch
 * returns a result object. It is called after the buy has settled, is not awaited,
 * and is off unless CALLOUT_ENABLED is set. A callout is worth nothing next to an
 * exit that did not fire because a social API was slow.
 */
import { CONFIG } from './config.js';
import type { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';

const BASE = 'https://frontend-api-v3.pump.fun';
const PRIVY = 'https://auth.privy.io';
/** pump.fun's Privy app. Verified: /siws/init returns a nonce for this id and 400s
 *  with "Invalid Privy app ID" for every other candidate tried. */
const PRIVY_APP_ID = process.env.PRIVY_APP_ID ?? 'cm1p2gzot03fzqty5xzgjgthq';
const MAX_THESIS = 2000;          // CALLOUT_REPLY_MAX_LENGTH in their bundle
const TIMEOUT_MS = 8000;

export interface CalloutResult {
  ok: boolean;
  calloutId?: string;
  skipped?: string;
  error?: string;
  status?: number;
}

/* ── Sign in with Solana ───────────────────────────────────────────────────── */

const sessions = new Map<string, { token: string; expires: number }>();

/**
 * Privy's SIWS template, byte for byte from their bundle.
 *
 * A signature covers exact bytes. A stray space, a reordered line, a different
 * newline and it is a 401 with nothing in the response to debug from, so this is
 * deliberately literal rather than built from a nice little formatter.
 */
function siwsMessage(address: string, nonce: string): string {
  return `pump.fun wants you to sign in with your Solana account:\n${address}\n\n`
    + `You are proving you own ${address}.\n\n`
    + `URI: https://pump.fun\nVersion: 1\nChain ID: mainnet\n`
    + `Nonce: ${nonce}\nIssued At: ${new Date().toISOString()}\nResources:\n- https://privy.io`;
}

async function privyPost(path: string, body: unknown): Promise<any> {
  const r = await fetch(PRIVY + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'privy-app-id': PRIVY_APP_ID,
      Origin: 'https://pump.fun',
      Referer: 'https://pump.fun/',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`privy ${path} ${r.status}: ${text.slice(0, 140)}`);
  return JSON.parse(text);
}

/** Log one task wallet in. Tokens are cached and reused until near expiry — a login
 *  per buy would be both slow and a good way to get rate limited. */
async function signIn(taskName: string, kp: Keypair): Promise<string> {
  const address = kp.publicKey.toBase58();
  const cached = sessions.get(address);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;

  const { nonce } = await privyPost('/api/v1/siws/init', { address });
  if (!nonce) throw new Error('privy returned no nonce');

  const message = siwsMessage(address, nonce);
  // base64, not base58. Their SDK does Buffer.from(sig).toString('base64'); signing
  // is the one place where guessing the encoding costs a 400 that says only
  // "Invalid SIWS message and/or nonce" and points at neither.
  const signature = Buffer.from(
    nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey),
  ).toString('base64');

  const auth = await privyPost('/api/v1/siws/authenticate', {
    message,
    signature,
    walletClientType: 'phantom',
    connectorType: 'solana_adapter',
    mode: 'login-or-sign-up',
  });
  const token: string | undefined =
    auth?.token ?? auth?.identity_token ?? auth?.privy_access_token ?? auth?.access_token;
  if (!token) throw new Error('no token in privy response: ' + JSON.stringify(auth).slice(0, 140));

  // Privy access tokens run about an hour. Refresh well before the edge so a buy
  // never lands on an expiry.
  sessions.set(address, { token, expires: Date.now() + 45 * 60_000 });
  console.log(`[Callout] ${taskName} signed in as ${address.slice(0, 6)}…${address.slice(-4)}`);
  return token;
}

/* ── Posting ───────────────────────────────────────────────────────────────── */

async function call(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      Origin: 'https://pump.fun',
      Referer: 'https://pump.fun/',
      Authorization: `Bearer ${token}`,
      Cookie: `privy-token=${token}`,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Their API answers "You're replying too fast" — one per wallet per minute. */
const lastPost = new Map<string, number>();
const MIN_GAP_MS = 60_000;

export async function postCallout(
  taskName: string, mint: string, thesis?: string, force = false,
  keypair?: Keypair,
): Promise<CalloutResult> {
  try {
    // `force` is for the test route only, so one wallet can be proven by hand
    // without arming every task's live buys at the same time.
    if (!force && !CONFIG.CALLOUT_ENABLED) return { ok: false, skipped: 'CALLOUT_ENABLED is off' };
    if (!keypair) return { ok: false, skipped: 'no keypair for this task' };

    const since = Date.now() - (lastPost.get(taskName) ?? 0);
    if (!force && since < MIN_GAP_MS) {
      return { ok: false, skipped: `rate limited, ${Math.ceil((MIN_GAP_MS - since) / 1000)}s to go` };
    }

    const token = await signIn(taskName, keypair);

    // Eligibility first. It is a GET, it costs nothing, and there are only three
    // create attempts per coin — spending one on a guaranteed rejection is waste.
    // It also reports the position pump.fun can see, which is the thing that
    // actually decides this, so a refusal here says why.
    try {
      const el = await call(`/callout/eligibility/${encodeURIComponent(mint)}`, token);
      if (el.status === 401) {
        sessions.delete(keypair.publicKey.toBase58());   // force a fresh login next time
        return { ok: false, error: 'unauthorised after sign-in', status: 401 };
      }
      if (el.ok) {
        const j: any = await el.json().catch(() => null);
        const verdict = j?.preflight?.create?.verdict;
        if (j?.eligible === false || (verdict && verdict !== 'ELIGIBLE')) {
          return { ok: false, skipped: `not eligible: ${verdict ?? 'unknown'}` };
        }
      }
    } catch { /* advisory only — a failure to check must not block the attempt */ }

    const body: Record<string, unknown> = { coinMint: mint, version: 2 };
    if (thesis?.trim()) body.thesis = thesis.trim().slice(0, MAX_THESIS);

    const res = await call('/callout/create', token, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      if (res.status === 401) sessions.delete(keypair.publicKey.toBase58());
      return { ok: false, status: res.status, error: txt.slice(0, 200) || `HTTP ${res.status}` };
    }
    const json: any = await res.json().catch(() => null);
    const id = json?.callout?.calloutId;
    lastPost.set(taskName, Date.now());
    if (!id) return { ok: false, error: 'no calloutId in response', status: res.status };
    return { ok: true, calloutId: String(id) };
  } catch (err: any) {
    // Never throws. The caller is a trading path.
    return { ok: false, error: String(err?.message ?? err).slice(0, 160) };
  }
}

/** Which tasks can post, for the health endpoint and the test route. Every real task
 *  can, now that signing in is the wallet's own job rather than a pasted cookie. */
export function calloutStatus(names: string[]): { enabled: boolean; appId: string; tasks: string[] } {
  return { enabled: CONFIG.CALLOUT_ENABLED, appId: PRIVY_APP_ID.slice(0, 8) + '…', tasks: names };
}
