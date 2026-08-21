/**
 * Post a callout to pump.fun after a real buy.
 *
 * pump.fun pays for calls that do well, and these tasks buy coins minutes before
 * anyone else looks at them. The whole chain has been run end to end:
 *
 *   POST /auth/login   { address, signature, timestamp } -> Set-Cookie: auth_token
 *   GET  /callout/eligibility/{mint}                     -> can this wallet call it
 *   POST /callout/create { coinMint, thesis?, version: 2 } -> { callout: { calloutId } }
 *
 * The signed message is `Sign in to pump.fun: <timestamp>`, signed by the wallet and
 * sent base58. That is all the auth there is. An earlier version of this file went
 * through Privy's SIWS flow — that flow does work and does return a session, but
 * pump.fun does not accept Privy tokens on its own API, so it was a detour and is
 * gone. The token it does issue lasts 30 days.
 *
 * The account has to BE the wallet: pump.fun checks the position of whoever posts,
 * and the coins sit in the task wallets. An owner's separate browser login can never
 * qualify no matter how fresh its cookie is — that was the second detour, and the
 * 401 it produced looked like an expiry when it was really an account holding none
 * of the coin.
 *
 * NOTHING HERE MAY AFFECT A TRADE. postCallout has no throwing path — every branch
 * returns a result object. It runs after the buy has settled, is not awaited, and
 * stays off until CALLOUT_ENABLED is set. A callout is worth nothing next to an exit
 * that did not fire because a social API was slow.
 */
import { CONFIG } from './config.js';
import type { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const BASE = 'https://frontend-api-v3.pump.fun';
const MAX_THESIS = 2000;          // CALLOUT_REPLY_MAX_LENGTH in their bundle
const TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

export interface CalloutResult {
  ok: boolean;
  calloutId?: string;
  skipped?: string;
  error?: string;
  status?: number;
}

/* ── Sign in ───────────────────────────────────────────────────────────────── */

const sessions = new Map<string, { cookie: string; expires: number }>();

/** Log a wallet in and keep the cookie. Tokens run 30 days; this refreshes daily so
 *  an expiry can never land in the middle of a buy. */
async function signIn(taskName: string, kp: Keypair): Promise<string> {
  const address = kp.publicKey.toBase58();
  const cached = sessions.get(address);
  if (cached && cached.expires > Date.now()) return cached.cookie;

  const timestamp = Date.now();
  const message = `Sign in to pump.fun: ${timestamp}`;
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));

  const r = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json',
               origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': UA },
    body: JSON.stringify({ address, signature, timestamp }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`login ${r.status}: ${text.slice(0, 140)}`);

  // The token arrives as Set-Cookie and is not in the body, which only echoes the
  // decoded claims.
  const raw = r.headers.get('set-cookie') ?? '';
  const m = raw.match(/auth_token=([^;]+)/);
  if (!m) throw new Error('login ok but no auth_token cookie');

  const cookie = `auth_token=${m[1]}`;
  sessions.set(address, { cookie, expires: Date.now() + 24 * 3600_000 });
  console.log(`[Callout] ${taskName} signed in as ${address.slice(0, 6)}…${address.slice(-4)}`);
  return cookie;
}

/* ── Posting ───────────────────────────────────────────────────────────────── */

async function call(path: string, cookie: string, init?: RequestInit): Promise<Response> {
  return fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json', accept: 'application/json',
      origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': UA,
      Cookie: cookie,
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
    // `force` is for the test route, so one wallet can be proven by hand without
    // arming every task's live buys at the same time.
    if (!force && !CONFIG.CALLOUT_ENABLED) return { ok: false, skipped: 'CALLOUT_ENABLED is off' };
    if (!keypair) return { ok: false, skipped: 'no keypair for this task' };

    const since = Date.now() - (lastPost.get(taskName) ?? 0);
    if (!force && since < MIN_GAP_MS) {
      return { ok: false, skipped: `rate limited, ${Math.ceil((MIN_GAP_MS - since) / 1000)}s to go` };
    }

    const cookie = await signIn(taskName, keypair);

    // Eligibility first. It is a GET, it costs nothing, and there are only three
    // create attempts per coin — spending one on a guaranteed rejection is waste.
    // Its verdict also names the real reason, which is the position pump.fun can see.
    try {
      const el = await call(`/callout/eligibility/${encodeURIComponent(mint)}`, cookie);
      if (el.status === 401) {
        sessions.delete(keypair.publicKey.toBase58());   // re-login next attempt
        return { ok: false, error: 'unauthorised after sign-in', status: 401 };
      }
      if (el.ok) {
        const j: any = await el.json().catch(() => null);
        const verdict = j?.preflight?.create?.verdict;
        if (j?.eligible === false || (verdict && verdict !== 'ELIGIBLE')) {
          return { ok: false, skipped: `not eligible: ${verdict ?? 'unknown'}` };
        }
      }
    } catch { /* advisory only — failing to check must not block the attempt */ }

    const body: Record<string, unknown> = { coinMint: mint, version: 2 };
    if (thesis?.trim()) body.thesis = thesis.trim().slice(0, MAX_THESIS);

    const res = await call('/callout/create', cookie, { method: 'POST', body: JSON.stringify(body) });
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

/** Every real task can post — signing in is the wallet's own job, nothing to configure. */
export function calloutStatus(names: string[]): { enabled: boolean; tasks: string[]; signedIn: number } {
  return { enabled: CONFIG.CALLOUT_ENABLED, tasks: names, signedIn: sessions.size };
}
