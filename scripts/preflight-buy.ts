/**
 * Dry-run the buy path against a real coin, without spending anything.
 *
 * $HOMES failed on "Jupiter quote failed (429)" and nothing had exercised that path
 * between the throttle being changed and a real call arriving. The buy path is the
 * one piece of this system that only ever runs when money is at stake, which is the
 * worst possible time to discover it is broken.
 *
 * Everything short of signing is real: a live quote at the actual entry size, a real
 * swap-transaction build, and a check that it fits in a transaction. It stops before
 * signing — no key is loaded and nothing is broadcast.
 *
 *   npx tsx scripts/preflight-buy.ts              # newest call
 *   npx tsx scripts/preflight-buy.ts <mint>       # a specific coin
 *   npx tsx scripts/preflight-buy.ts <mint> 0.11  # and a specific size
 */
const BASE = 'https://pumpclaw-production.up.railway.app';
const UA = { 'User-Agent': 'Mozilla/5.0' };
// Follow the same tier the bot follows. This hardcoded the free host, so once
// JUPITER_API_KEY went live the preflight was exercising a different endpoint,
// with different limits, from the one that actually trades — a dry run that no
// longer rehearses the real thing is worse than none, because it reports green.
// Note the key lives in Railway; run this with JUPITER_API_KEY set locally to
// rehearse the paid path, otherwise it honestly reports that it tested the free one.
const JUP_KEY = (process.env.JUPITER_API_KEY ?? '').trim();
const JUP_BASE = JUP_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
const jupHeaders = (extra: Record<string, string> = {}) =>
  JUP_KEY ? { 'x-api-key': JUP_KEY, ...extra } : extra;
const QUOTE = `${JUP_BASE}/swap/v1/quote`;
const SWAP = `${JUP_BASE}/swap/v1/swap`;
const WSOL = 'So11111111111111111111111111111111111111112';
// Any valid pubkey works for building — the transaction is never signed or sent.
const DUMMY = '11111111111111111111111111111112';

let mint = process.argv[2];
let sol = parseFloat(process.argv[3] ?? '');

const live: any = await (await fetch(`${BASE}/api/live`, { headers: UA })).json();
const task = (live.realTasks ?? [])[0];
if (!Number.isFinite(sol)) {
  sol = task ? Math.max(live.balance * task.entryPct, task.minEntrySol) : 0.11;
}
if (!mint) {
  const ex: any = await (await fetch(`${BASE}/api/export-all`, { headers: UA })).json();
  const newest = ex.calls.sort((a: any, b: any) => b.entryTime - a.entryTime)[0];
  mint = newest?.mint;
  console.log(`using newest call: $${newest?.symbol}`);
}
if (!mint) { console.log('no mint to test'); process.exit(1); }

const slippage = 1500;
console.log(`mint       ${mint}`);
console.log(`size       ${sol.toFixed(4)} SOL  (${task ? `${(task.entryPct * 100).toFixed(0)}% of ${live.balance.toFixed(4)}` : 'default'})`);
console.log(`slippage   ${slippage / 100}%`);
console.log(`jupiter    ${JUP_BASE.replace('https://', '')}  ${JUP_KEY ? '(paid, key set locally)' : '(FREE tier — no local JUPITER_API_KEY, so this is NOT the path the bot uses)'}\n`);

let fail = 0;
const t0 = Date.now();

// ── 1. quote ──
const qUrl = `${QUOTE}?inputMint=${WSOL}&outputMint=${mint}&amount=${Math.floor(sol * 1e9)}&slippageBps=${slippage}`;
const qRes = await fetch(qUrl, { headers: jupHeaders(), signal: AbortSignal.timeout(15_000) });
const qMs = Date.now() - t0;
if (!qRes.ok) {
  const body = await qRes.text();
  console.log(`✗ QUOTE   HTTP ${qRes.status} in ${qMs}ms — ${body.slice(0, 120)}`);
  if (qRes.status === 429) console.log('  RATE LIMITED — this is what killed the $HOMES buy.');
  process.exit(1);
}
const quote: any = await qRes.json();
console.log(`✓ QUOTE   ${qMs}ms   out ${Number(quote.outAmount).toLocaleString()} raw   ` +
            `impact ${(+quote.priceImpactPct * 100).toFixed(2)}%   ${quote.routePlan?.length ?? 0} hop(s)`);
if (+quote.priceImpactPct > 0.15) { console.log(`  ⚠ price impact over 15% at this size`); fail++; }

// ── 2. build the swap transaction ──
const t1 = Date.now();
const sRes = await fetch(SWAP, {
  method: 'POST',
  headers: jupHeaders({ 'Content-Type': 'application/json' }),
  body: JSON.stringify({ quoteResponse: quote, userPublicKey: DUMMY, wrapAndUnwrapSol: true }),
  signal: AbortSignal.timeout(15_000),
});
const sMs = Date.now() - t1;
if (!sRes.ok) {
  console.log(`✗ BUILD   HTTP ${sRes.status} in ${sMs}ms — ${(await sRes.text()).slice(0, 160)}`);
  if (!JUP_KEY) {
    // A free-tier build failure says nothing about the bot. Measured on $CASY: the
    // buy build returned "Missing token program" on lite-api and succeeded on the
    // paid host in the same second, with the coin held live. Reporting that as a
    // failed preflight is a false alarm on the exact path that matters.
    console.log('\n  ⚠ This ran on the FREE host. The bot builds against api.jup.ag with a key,');
    console.log('    which resolves mints the free tier does not. This result is INCONCLUSIVE.');
    console.log('    Re-run against the real path before treating it as a fault:');
    console.log('      railway run -s PumpClaw npx tsx scripts/preflight-buy.ts');
  }
  process.exit(1);
}
const swap: any = await sRes.json();
const raw = Buffer.from(swap.swapTransaction, 'base64');
console.log(`✓ BUILD   ${sMs}ms   ${raw.length} bytes   blockhash ${swap.lastValidBlockHeight ? 'present' : 'MISSING'}`);
// Solana's hard cap. A route that builds but does not fit fails at broadcast, which
// is a far more confusing place to find out.
if (raw.length > 1232) { console.log(`  ✗ over the 1232-byte transaction limit — would fail at send`); fail++; }

// ── 3. the sell path, on the same coin ──
const t2 = Date.now();
const sellUrl = `${QUOTE}?inputMint=${mint}&outputMint=${WSOL}&amount=${quote.outAmount}&slippageBps=${slippage}`;
const sellRes = await fetch(sellUrl, { headers: jupHeaders(), signal: AbortSignal.timeout(15_000) });
if (!sellRes.ok) {
  console.log(`✗ SELL QUOTE  HTTP ${sellRes.status} in ${Date.now() - t2}ms — exit route unavailable`);
  fail++;
} else {
  const sq: any = await sellRes.json();
  const back = Number(sq.outAmount) / 1e9;
  const roundTrip = (1 - back / sol) * 100;
  console.log(`✓ SELL    ${Date.now() - t2}ms   ${back.toFixed(4)} SOL back   round-trip cost ${roundTrip.toFixed(2)}%`);
  if (roundTrip > 6) { console.log(`  ⚠ round trip over 6% — the edge is ~3%, this coin would not be worth trading`); fail++; }
}

console.log(`\n${fail === 0 ? '✓ buy path is healthy end to end (nothing signed, nothing sent)'
                            : `✗ ${fail} problem(s) — a real buy would likely fail or lose money`}`);
process.exit(fail === 0 ? 0 : 1);
