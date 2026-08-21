/**
 * Post a callout to pump.fun after a real buy.
 *
 * pump.fun pays for calls that do well, and every task here buys coins minutes
 * before anyone else looks at them. The endpoints came out of pump.fun's own
 * bundle, so the contract is exact rather than guessed:
 *
 *   GET  /callout/eligibility/{mint}   is this wallet allowed to call this coin
 *   POST /callout/create               { coinMint, thesis?, version: 2 }
 *                                      -> { callout: { calloutId } }
 *
 * Auth is a session cookie, obtained by signing in on pump.fun in a browser and
 * pasting the cookie into a per-task env var. The alternative — having the bot
 * perform the Privy SIWS handshake itself — is the better long-term shape, but it
 * could not be built or verified from here, and shipping an untested auth flow that
 * fails silently on every buy is worse than a cookie that visibly expires.
 *
 * NOTHING HERE MAY AFFECT A TRADE. It is called fire-and-forget after a buy has
 * already settled, every path swallows its own errors, and it is off unless both a
 * cookie and CALLOUT_ENABLED are present. A callout is worth nothing next to an
 * exit that did not fire because a social API was slow.
 */
import { CONFIG } from './config.js';

const BASE = 'https://frontend-api-v3.pump.fun';
const MAX_THESIS = 2000;          // CALLOUT_REPLY_MAX_LENGTH in their bundle
const TIMEOUT_MS = 8000;

/** Cookie per task name, from env. Absent means this task simply does not post. */
/** A real pump.fun session cookie is long. Railway will not store an empty variable,
 *  so the slots are seeded with a placeholder, and a half-pasted cookie is a thing
 *  that happens — both would otherwise 401 on every single buy forever. Anything
 *  this short is treated as "not configured" instead. */
const MIN_COOKIE_LEN = 24;
function looksLikeCookie(v: string | undefined): boolean {
  const t = (v ?? '').trim();
  return t.length >= MIN_COOKIE_LEN && !/^(unset|paste|todo|changeme|placeholder)/i.test(t);
}

function cookieFor(taskName: string): string | null {
  const key = 'PUMP_COOKIE_' + taskName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  const direct = process.env[key];
  if (looksLikeCookie(direct)) return direct!.trim();
  // Convenience: PUMP_COOKIE_MANIFEST also matches a task called "MANIFEST 2".
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('PUMP_COOKIE_') || !looksLikeCookie(v)) continue;
    const val = (v ?? '').trim();
    const want = k.slice('PUMP_COOKIE_'.length);
    if (key.slice('PUMP_COOKIE_'.length).startsWith(want)) return val;
  }
  return null;
}

export interface CalloutResult {
  ok: boolean;
  calloutId?: string;
  skipped?: string;
  error?: string;
  status?: number;
}

async function call(path: string, cookie: string, init?: RequestInit): Promise<Response> {
  return fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      Origin: 'https://pump.fun',
      Referer: 'https://pump.fun/',
      Cookie: cookie,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Rate limit: their API says "You're replying too fast" — one per wallet per minute. */
const lastPost = new Map<string, number>();
const MIN_GAP_MS = 60_000;

export async function postCallout(
  taskName: string, mint: string, thesis?: string,
): Promise<CalloutResult> {
  try {
    if (!CONFIG.CALLOUT_ENABLED) return { ok: false, skipped: 'CALLOUT_ENABLED is off' };
    const cookie = cookieFor(taskName);
    if (!cookie) return { ok: false, skipped: `no PUMP_COOKIE_* for "${taskName}"` };

    const since = Date.now() - (lastPost.get(taskName) ?? 0);
    if (since < MIN_GAP_MS) return { ok: false, skipped: `rate limited, ${Math.ceil((MIN_GAP_MS - since) / 1000)}s to go` };

    // Eligibility first. It is a GET, it costs nothing, and posting into a coin this
    // wallet cannot call just burns the rate limit on a guaranteed rejection.
    try {
      const el = await call(`/callout/eligibility/${encodeURIComponent(mint)}`, cookie);
      if (el.status === 401) return { ok: false, error: 'session expired — refresh the cookie', status: 401 };
      if (el.ok) {
        const j: any = await el.json().catch(() => null);
        if (j && j.eligible === false) {
          return { ok: false, skipped: `not eligible: ${j.reason ?? 'no reason given'}` };
        }
      }
    } catch { /* eligibility is advisory; a failure here should not block the attempt */ }

    const body: Record<string, unknown> = { coinMint: mint, version: 2 };
    if (thesis?.trim()) body.thesis = thesis.trim().slice(0, MAX_THESIS);

    const res = await call('/callout/create', cookie, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
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

/** Which tasks are configured, for the health endpoint and the test route. */
export function calloutStatus(names: string[]): { enabled: boolean; configured: string[]; missing: string[] } {
  const configured: string[] = [], missing: string[] = [];
  for (const n of names) (cookieFor(n) ? configured : missing).push(n);
  return { enabled: CONFIG.CALLOUT_ENABLED, configured, missing };
}
