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
import type { PerformanceTracker } from './tracker.js';

/** The call records, handed over at boot. The tracker is constructed in index.ts
 *  rather than exported as a singleton, and a social post is not a good enough
 *  reason to change that on a live trading path — so it is registered here instead.
 *  Unset, every thesis simply falls back to its no-facts form. */
let calls: PerformanceTracker | null = null;
export function useCallRecords(t: PerformanceTracker): void { calls = t; }

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

/* ── Voices ────────────────────────────────────────────────────────────────────
 *
 * Rewritten after reading the callout board on a coin with 78k holders. Two things
 * were obvious there and wrong here:
 *
 *   1. pump.fun already renders Position / Net PNL / Spent / Avg entry underneath
 *      every callout. Leading with "bought at $14.2K" was posting a worse copy of
 *      a card the reader is already looking at. Nobody who does well there does it.
 *   2. The callouts that get read are a REASON, not a receipt — either a real
 *      observation, or three words. Never a restated statistic.
 *
 * So the thesis now spends its space on the one thing these wallets know that the
 * rest of that board does not: the holder graph was walked before the buy. Sixty
 * wallets traced, funding clusters resolved, fresh-versus-veteran split measured.
 * Real, checkable, and unique to this bot.
 *
 * The old rule still holds and is now easier to keep — every clause is emitted only
 * if the number behind it was actually measured. No invented conviction, no
 * analysis that did not run. A coin whose scan came back thin gets the short form,
 * which is also what half that board posts anyway.
 */
interface Facts {
  holders?: number;      // distinct owner wallets seen
  traced?: number;       // wallets whose funding history was actually walked
  freshPct?: number;     // share of traced wallets that are newly funded
  cluster?: number;      // largest set of traced wallets sharing one funder
  funders?: number;      // distinct funders across the traced set
  independent?: number;  // traced wallets in no cluster at all
  devPct?: number;       // largest non-pool wallet's share of supply
  dipPct?: number;       // how far under the call this task fills
}

/** Read back what the scan measured before this coin was bought. Everything here is
 *  optional by construction: the deep read resolves a second or two after the call
 *  record is written, so on the fastest buys some of it is legitimately not there
 *  yet, and a missing number must never become an invented one. */
function factsFor(mint: string, dipPct?: number): Facts {
  const f: Facts = {};
  if (dipPct) f.dipPct = Math.round(dipPct * 100);
  try {
    const rec = calls?.getByMint(mint);
    if (!rec) return f;
    const d = rec.entryDeepHolders;
    const h = rec.entryHolders;
    if (d?.owners) f.holders = d.owners;
    if (d?.traced && d.traced >= 10) {
      f.traced = d.traced;
      if (typeof d.largestCluster === 'number') f.cluster = d.largestCluster;
      if (d.funders) f.funders = d.funders;
      if (typeof d.independent === 'number') f.independent = d.independent;
      if (typeof d.fresh === 'number') f.freshPct = Math.round(d.fresh / d.traced * 100);
    } else if (h?.graphChecked && h.graphChecked >= 10) {
      f.traced = h.graphChecked;
      if (typeof h.freshWallets === 'number') {
        f.freshPct = Math.round(h.freshWallets / h.graphChecked * 100);
      }
    }
    if (typeof h?.devHoldPct === 'number' && h.devHoldPct > 0) f.devPct = Math.round(h.devHoldPct);
  } catch { /* the thesis is decoration; never let reading it matter */ }
  return f;
}

/** A candidate line. Returns null when the facts it would cite were not measured,
 *  which is what keeps the bot from ever writing a number it does not have. */
type Cand = (s: string, f: Facts) => string | null;

const VOICES: Record<string, Cand[]> = {
  // The analyst. This is the wallet with something to say that nobody else on the
  // board is saying, so it says it plainly and does not pad.
  MANIFEST: [
    (s, f) => f.traced && f.cluster !== undefined
      ? `walked the holder graph on $${s} before buying. ${f.traced} wallets traced, the biggest shared funder covers ${f.cluster} of them. farms don't look like that.` : null,
    (s, f) => f.holders && f.funders && f.traced
      ? `$${s} has ${f.holders} holders and ${f.funders} separate funders across the ${f.traced} i traced. that spread is the whole reason i took it.` : null,
    (s, f) => f.freshPct !== undefined && f.traced
      ? `${f.freshPct}% of the ${f.traced} wallets i traced on $${s} are freshly funded. under my cutoff so it cleared — most of what i scan now doesn't.` : null,
    (s, f) => f.independent !== undefined && f.traced
      ? `${f.independent} of ${f.traced} traced holders on $${s} aren't linked to any other wallet in the set. i check this on every call and it's rarer than it should be.` : null,
    (s, f) => f.devPct !== undefined
      ? `dev holds ${f.devPct}% of $${s}. ran the funding graph over the holders too, nothing clustered. starter position.` : null,
    s => `$${s} cleared every gate i run before entry — bundle, funding graph, fresh wallet share. taking a starter here.`,
  ],
  // Momentum. Buys the call itself and does not pretend to have done homework it
  // skipped. Shortest of the three on purpose; that board is full of three-word posts.
  INSTANT: [
    s => `no waiting on a pullback for $${s}. in on the call.`,
    (s, f) => f.holders
      ? `$${s} already ${f.holders} holders this early. not trying to time a better entry on that.` : null,
    s => `bought $${s} on sight. either works in the next ten minutes or it doesn't.`,
    s => `in on $${s}. laddering out on the way up, not marrying it.`,
    (s, f) => f.traced && f.cluster !== undefined && f.cluster <= 3
      ? `$${s} — holder graph came back clean, so no reason to sit on my hands. straight in.` : null,
    s => `took $${s} at the call price. on these, chasing beats missing.`,
  ],
  // Patience. Only ever fills under the call, so it has an actual entry story that
  // the position card cannot tell on its own.
  DIP: [
    (s, f) => f.dipPct
      ? `wasn't chasing $${s} at the call. waited for ${f.dipPct}% off and it came back.` : null,
    (s, f) => f.dipPct
      ? `$${s} retraced ${f.dipPct}% before i touched it. much better basis than buying the first candle.` : null,
    s => `let $${s} come to me instead of buying the top wick. filled on the way back down.`,
    (s, f) => f.dipPct && f.holders
      ? `sat out the first push on $${s} and bought ${f.dipPct}% lower with ${f.holders} holders already in it.` : null,
    (s, f) => f.dipPct && f.traced
      ? `$${s} passed the ${f.traced}-wallet holder scan, but i still don't pay call price. filled ${f.dipPct}% under.` : null,
    s => `only take these on a pullback. $${s} gave one.`,
  ],
};

function voiceFor(taskName: string): Cand[] {
  const n = taskName.toUpperCase();
  if (n.startsWith('DIP')) return VOICES.DIP;
  if (n.startsWith('INSTANT')) return VOICES.INSTANT;
  return VOICES.MANIFEST;
}

/** Pick a line. Rotates per task so one wallet doesn't repeat itself across buys and
 *  the three wallets don't land on matching phrasing for the same coin. Candidates
 *  whose facts are missing are skipped, and the last entry in every voice needs no
 *  facts at all, so there is always something to say. */
const voiceCursor = new Map<string, number>();
export function calloutThesis(
  taskName: string, symbol: string, mint: string, dipPct?: number,
): string {
  const f = factsFor(mint, dipPct);
  const cands = voiceFor(taskName);
  const start = voiceCursor.get(taskName) ?? Math.floor(Math.random() * cands.length);
  for (let n = 0; n < cands.length; n++) {
    const i = (start + n) % cands.length;
    const line = cands[i](symbol, f);
    if (line) { voiceCursor.set(taskName, i + 1); return line; }
  }
  return `in on $${symbol}.`;
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
