/**
 * The filter fleet — what the shadow fleet is for strategies, this is for filters.
 *
 * The strategy side has 2,400 configurations grinding against every call, so a
 * question like "is a 45% trail worse than 25%" answers itself. The filter side had
 * 476 candidates scored ONE AT A TIME, which cannot answer "which COMBINATION is
 * best" — and that is the question worth asking, because no single filter has ever
 * reached 50% without halving the winners.
 *
 * So: enumerate combinations, score them all against the whole history, rank them.
 *
 * The catch, and the reason this file is more careful than it looks. Searching
 * thousands of combinations over a few hundred coins finds a 75% rule EVERY TIME,
 * including when the outcomes are replaced with random noise — measured, not
 * assumed: shuffling the labels and re-running the identical search produced a
 * median best of 76.2% against 75.0% on the real data. A fleet that ranked
 * combinations without accounting for that would confidently recommend a
 * coincidence, and it would do it in a table that looks exactly like a discovery.
 *
 * Every combination is therefore scored against a NOISE FLOOR built by re-running
 * the same enumeration on shuffled outcomes. Anything under that floor is what the
 * search finds by luck at this sample size, and is reported as such.
 */
import { CANDIDATES, type Candidate, type Snapshot } from './filter-lab.js';

export interface FleetObs { snap: Snapshot; peak: number; ts: number; }

export interface FleetRow {
  keys: string[];
  name: string;
  groups: string[];
  trainN: number; trainRate: number;
  testN: number; testRate: number;
  testLo: number; testHi: number;
  lift: number;
  aboveNoise: boolean;
}

export interface FleetResult {
  target: number;
  n: number; trainN: number; testN: number;
  baseTrain: number; baseTest: number;
  noiseFloor: number;
  nullRuns: number[];
  rows: FleetRow[];
  singles: FleetRow[];
}

const MIN_TRAIN = 40;
const MIN_TEST = 18;
const TOP_SINGLES = 55;
const NULL_RUNS = 8;

/** Wilson score interval — honest at the small counts a filter combination produces. */
function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Deterministic shuffle so a page reload does not move the noise floor around. */
function shuffled(src: Uint8Array, seed: number): Uint8Array {
  const a = src.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

export function runFleet(obs: FleetObs[], target = 2): FleetResult {
  const rows = obs.slice().sort((a, b) => a.ts - b.ts);
  const n = rows.length;
  const split = Math.floor(n * 0.7);

  const win = new Uint8Array(n);
  for (let i = 0; i < n; i++) win[i] = rows[i].peak >= target ? 1 : 0;

  // Each candidate becomes a pass-vector once. Everything after this is array AND,
  // which is what makes enumerating thousands of combinations cheap enough to do
  // on a page load rather than in a script somebody has to remember to run.
  const vecs: { c: Candidate; v: Uint8Array; nTr: number }[] = [];
  for (const c of CANDIDATES) {
    const v = new Uint8Array(n);
    let nTr = 0, nTe = 0;
    for (let i = 0; i < n; i++) {
      let ok: boolean | null = null;
      try { ok = c.pass(rows[i].snap); } catch { ok = null; }
      // null = this candidate cannot judge this coin. Treated as a pass so a
      // missing metric never masquerades as a rejection.
      v[i] = ok === false ? 0 : 1;
      if (v[i]) { if (i < split) nTr++; else nTe++; }
    }
    if (nTr >= MIN_TRAIN && nTe >= MIN_TEST && nTr < split) vecs.push({ c, v, nTr });
  }

  const score = (v: Uint8Array, w: Uint8Array, lo: number, hi: number) => {
    let k = 0, m = 0;
    for (let i = lo; i < hi; i++) if (v[i]) { m++; if (w[i]) k++; }
    return { k, m, rate: m ? k / m : -1 };
  };

  const baseTr = score(new Uint8Array(n).fill(1), win, 0, split);
  const baseTe = score(new Uint8Array(n).fill(1), win, split, n);

  /** Best TRAIN rate any enumerated combination reaches against a given outcome
   *  vector. Run on the real outcomes it is the headline; run on shuffled ones it
   *  is the noise floor. Identical code path both times, which is the point. */
  const bestFor = (w: Uint8Array): number => {
    const singles = vecs
      .map(x => ({ x, r: score(x.v, w, 0, split).rate }))
      .sort((a, b) => b.r - a.r)
      .slice(0, TOP_SINGLES);
    let best = singles.length ? singles[0].r : 0;
    for (let i = 0; i < singles.length; i++) {
      for (let j = i + 1; j < singles.length; j++) {
        if (singles[i].x.c.group === singles[j].x.c.group) continue;
        const v = new Uint8Array(n);
        for (let t = 0; t < n; t++) v[t] = singles[i].x.v[t] & singles[j].x.v[t];
        const a = score(v, w, 0, split);
        if (a.m < MIN_TRAIN) continue;
        const b = score(v, w, split, n);
        if (b.m < MIN_TEST) continue;
        if (a.rate > best) best = a.rate;
      }
    }
    return best;
  };

  const nullRuns: number[] = [];
  for (let r = 0; r < NULL_RUNS; r++) nullRuns.push(bestFor(shuffled(win, 9781 + r * 7919)));
  nullRuns.sort((a, b) => a - b);
  // 90th percentile of the null, not the median: the floor should sit where luck
  // stops, not where it typically lands.
  const noiseFloor = nullRuns[Math.min(nullRuns.length - 1, Math.floor(nullRuns.length * 0.9))];

  const mk = (keys: string[], names: string[], groups: string[], v: Uint8Array): FleetRow | null => {
    const a = score(v, win, 0, split), b = score(v, win, split, n);
    if (a.m < MIN_TRAIN || b.m < MIN_TEST) return null;
    const [lo, hi] = wilson(b.k, b.m);
    return {
      keys, name: names.join(' + '), groups,
      trainN: a.m, trainRate: a.rate, testN: b.m, testRate: b.rate,
      testLo: lo, testHi: hi,
      lift: b.rate - baseTe.rate,
      aboveNoise: a.rate > noiseFloor && lo > baseTe.rate,
    };
  };

  const top = vecs
    .map(x => ({ x, r: score(x.v, win, 0, split).rate }))
    .sort((a, b) => b.r - a.r)
    .slice(0, TOP_SINGLES);

  const singles = top.map(t => mk([t.x.c.key], [t.x.c.name], [t.x.c.group], t.x.v))
    .filter((r): r is FleetRow => r !== null);

  const out: FleetRow[] = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      if (top[i].x.c.group === top[j].x.c.group) continue;
      const v = new Uint8Array(n);
      for (let t = 0; t < n; t++) v[t] = top[i].x.v[t] & top[j].x.v[t];
      const row = mk(
        [top[i].x.c.key, top[j].x.c.key],
        [top[i].x.c.name, top[j].x.c.name],
        [top[i].x.c.group, top[j].x.c.group], v);
      if (row) out.push(row);
    }
  }
  out.sort((a, b) => b.trainRate - a.trainRate);

  // Triples, grown only from pairs that already cleared the floor. Extending a pair
  // that is already noise just produces a longer piece of noise.
  const seeds = out.filter(r => r.aboveNoise).slice(0, 20);
  const byKey = new Map(vecs.map(v => [v.c.key, v]));
  for (const s of seeds) {
    const vs = s.keys.map(k => byKey.get(k)!).filter(Boolean);
    if (vs.length !== s.keys.length) continue;
    for (const t3 of top) {
      if (s.groups.includes(t3.x.c.group)) continue;
      const v = new Uint8Array(n);
      for (let t = 0; t < n; t++) v[t] = vs[0].v[t] & vs[1].v[t] & t3.x.v[t];
      const row = mk([...s.keys, t3.x.c.key],
        [...s.name.split(' + '), t3.x.c.name],
        [...s.groups, t3.x.c.group], v);
      if (row) out.push(row);
    }
  }
  out.sort((a, b) => (b.aboveNoise ? 1 : 0) - (a.aboveNoise ? 1 : 0) || b.testRate - a.testRate);

  return {
    target, n, trainN: split, testN: n - split,
    baseTrain: baseTr.rate, baseTest: baseTe.rate,
    noiseFloor, nullRuns, rows: out.slice(0, 60), singles: singles.slice(0, 25),
  };
}
