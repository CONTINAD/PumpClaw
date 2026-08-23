/** Smoke test: run the fleet against exported production data, no server needed. */
import { readFileSync } from 'fs';
import { runFleet, type FleetObs } from '../src/filter-fleet.js';
import { snapshotFrom } from '../src/filter-lab.js';

const d = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const obs: FleetObs[] = [];
for (const c of d.calls) {
  if (typeof c.peakMultiplier !== 'number' || !c.entryTime) continue;
  const h = c.entryHolders ?? {}, dh = c.entryDeepHolders ?? {};
  obs.push({ peak: c.peakMultiplier, ts: c.entryTime, snap: snapshotFrom({}, {
    mc: c.entryMC ?? 0, liq: c.entryLiquidity ?? 0,
    vol5m: c.entryVolume5m ?? 0, vol1h: c.entryVolume1h ?? 0, vol24h: c.entryVolume24h ?? 0,
    buys5m: c.entryBuys5m ?? 0, sells5m: c.entrySells5m ?? 0,
    buys1h: c.entryBuys1h ?? 0, sells1h: c.entrySells1h ?? 0,
    chg5m: c.entryPriceChange5m ?? 0, chg1h: c.entryPriceChange1h ?? 0, chg6h: c.entryPriceChange6h ?? 0,
    ageMin: c.entryAgeMin ?? 0, dexId: c.entryDexId,
    socials: typeof c.entrySocials === 'number' ? c.entrySocials : undefined,
    freshWallets: h.freshWallets, veterans: h.veterans,
    devHoldPct: h.devHoldPct, sameFunderPct: h.sameFunderPct,
    hourUtc: new Date(c.entryTime).getUTCHours(),
    deepOwners: dh.owners, deepCluster: dh.largestCluster, deepClusterPct: dh.clusterPct,
    deepIndependent: dh.independent, deepFunders: dh.funders, source: c.source,
  }) });
}
// skips too — this is what the live page feeds it, and the confound screen only
// engages when both populations are present.
for (const k of d.skips ?? []) {
  if (typeof k.peakMultiplier !== 'number' || !k.snap || !k.timestamp) continue;
  obs.push({ peak: k.peakMultiplier, ts: k.timestamp, taken: false, snap: snapshotFrom({}, k.snap) as any });
}
for (const o of obs) if (o.taken === undefined) (o as any).taken = true;
console.log(`observations: ${obs.length} (${obs.filter(o => o.taken).length} calls, ${obs.filter(o => !o.taken).length} skips)`);

const t0 = Date.now();
const f = runFleet(obs, 2);
console.log(`n=${f.n}  train=${f.trainN} test=${f.testN}  base ${(f.baseTest*100).toFixed(0)}%`);
console.log(`noise floor ${(f.noiseFloor*100).toFixed(1)}%  from runs ${f.nullRuns.map(x=>(x*100).toFixed(0)+'%').join(' ')}`);
console.log(`combos returned ${f.rows.length}, above noise: ${f.rows.filter(r=>r.aboveNoise).length}`);
console.log(`SCREENED OUT (${f.dropped.length}): ${f.dropped.slice(0,8).join(' | ')}`);
console.log(`deep-read candidate still present? ${f.rows.some(r=>r.name.includes('deep holder read')) ? 'YES — BUG' : 'no'}`);
console.log(`ran in ${Date.now()-t0}ms\n`);
for (const r of f.rows.slice(0, 8))
  console.log(`  ${r.aboveNoise?'SIG ':'    '}${r.name.slice(0,62).padEnd(62)} tr ${String(r.trainN).padStart(3)} ${(r.trainRate*100).toFixed(0)}%  te ${String(r.testN).padStart(3)} ${(r.testRate*100).toFixed(0)}% [${(r.testLo*100).toFixed(0)}-${(r.testHi*100).toFixed(0)}]`);
