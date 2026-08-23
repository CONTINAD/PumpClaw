/** Constrained search: maximise hit-rate subject to KEEPING at least X% of calls.
 *  The volume floor is what makes this honest — you cannot cherry-pick 40 lucky
 *  coins when the rule has to keep 280 of them. */
import { readFileSync } from 'fs';
import { CANDIDATES, snapshotFrom, type Snapshot } from '../src/filter-lab.js';

const d = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const KEEP = parseFloat(process.argv[3] ?? '0.62');

type Row = { snap: Snapshot; peak: number; ts: number };
const rows: Row[] = [];
for (const c of d.calls) {
  if (typeof c.peakMultiplier !== 'number' || !c.entryTime) continue;
  const h = c.entryHolders ?? {}, dh = c.entryDeepHolders ?? {};
  rows.push({ peak: c.peakMultiplier, ts: c.entryTime, snap: snapshotFrom({}, {
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
  }) as Snapshot });
}
rows.sort((a, b) => a.ts - b.ts);
const N = rows.length, split = Math.floor(N * 0.7);
const win = rows.map(r => (r.peak >= 2 ? 1 : 0));

const vecs = CANDIDATES.map(c => {
  const v = rows.map(r => { try { return c.pass(r.snap) === false ? 0 : 1; } catch { return 1; } });
  return { c, v };
});

const stat = (v: number[], w: number[], lo: number, hi: number) => {
  let k = 0, m = 0;
  for (let i = lo; i < hi; i++) if (v[i]) { m++; if (w[i]) k++; }
  return { k, m, rate: m ? k / m : 0 };
};
const wilson = (k: number, n: number): [number, number] => {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, den = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / den;
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [c - h, c + h];
};

/** Best achievable rate subject to the volume floor, for a given outcome vector. */
function best(w: number[], collect = false) {
  const need = Math.floor(split * KEEP);
  const ok = vecs.filter(x => stat(x.v, w, 0, split).m >= need);
  const singles = ok.map(x => ({ x, s: stat(x.v, w, 0, split) })).sort((a, b) => b.s.rate - a.s.rate);
  const out: any[] = [];
  let top = 0;
  for (const s of singles.slice(0, 40)) {
    top = Math.max(top, s.s.rate);
    if (collect) out.push({ names: [s.x.c.name], v: s.x.v });
  }
  for (let i = 0; i < Math.min(40, singles.length); i++) {
    for (let j = i + 1; j < Math.min(40, singles.length); j++) {
      if (singles[i].x.c.group === singles[j].x.c.group) continue;
      const v = rows.map((_, t) => singles[i].x.v[t] & singles[j].x.v[t]);
      const a = stat(v, w, 0, split);
      if (a.m < need) continue;
      top = Math.max(top, a.rate);
      if (collect) out.push({ names: [singles[i].x.c.name, singles[j].x.c.name], v });
    }
  }
  return collect ? out : top;
}

const baseTr = stat(rows.map(() => 1), win, 0, split);
const baseTe = stat(rows.map(() => 1), win, split, N);
console.log(`${N} calls · train ${split} @ ${(baseTr.rate*100).toFixed(1)}% · test ${N-split} @ ${(baseTe.rate*100).toFixed(1)}%`);
console.log(`constraint: keep >= ${(KEEP*100).toFixed(0)}% of calls\n`);

const real = best(win) as number;
const nulls: number[] = [];
let seed = 12345;
for (let r = 0; r < 10; r++) {
  const sh = win.slice();
  for (let i = sh.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1); const t = sh[i]; sh[i] = sh[j]; sh[j] = t;
  }
  nulls.push(best(sh) as number);
}
nulls.sort((a, b) => a - b);
const beat = nulls.filter(x => x >= real).length;
console.log(`best rate meeting the floor:  REAL ${(real*100).toFixed(1)}%`);
console.log(`shuffled nulls: ${nulls.map(x => (x*100).toFixed(1)+'%').join(' ')}`);
console.log(`null median ${(nulls[5]*100).toFixed(1)}%  max ${(nulls[9]*100).toFixed(1)}%   p = ${((beat+1)/11).toFixed(2)}`);
console.log(real > nulls[9] ? '=> REAL SIGNAL — beats every shuffle\n' : '=> under the noise ceiling\n');

const cands = best(win, true) as any[];
const scored = cands.map(c => {
  const a = stat(c.v, win, 0, split), b = stat(c.v, win, split, N);
  const [lo, hi] = wilson(b.k, b.m);
  return { names: c.names, a, b, lo, hi };
}).filter(x => x.b.m >= 25).sort((x, y) => y.a.rate - x.a.rate);

console.log(`${'rule'.padEnd(58)}| ${'keep'.padStart(5)} ${'train'.padStart(6)} | ${'keep'.padStart(5)} ${'TEST'.padStart(6)} ${'95% CI'.padStart(13)}`);
const seen = new Set<string>();
let shown = 0;
for (const s of scored) {
  const key = s.names.slice().sort().join('|');
  if (seen.has(key)) continue; seen.add(key);
  const kp = (s.a.m / split * 100).toFixed(0), kp2 = (s.b.m / (N - split) * 100).toFixed(0);
  console.log(`${s.names.join(' + ').slice(0,58).padEnd(58)}| ${(kp+'%').padStart(5)} ${(s.a.rate*100).toFixed(1).padStart(5)}% | ${(kp2+'%').padStart(5)} ${(s.b.rate*100).toFixed(1).padStart(5)}% ${((s.lo*100).toFixed(0)+'-'+(s.hi*100).toFixed(0)+'%').padStart(13)}`);
  if (++shown >= 14) break;
}
