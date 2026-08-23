/**
 * Rule miner — work backwards from the coins that ran.
 *
 * The filter lab answers "is this rule any good", which requires somebody to have
 * thought of the rule first. Every candidate in that file exists because I guessed
 * at it, and a guess can only be as good as whatever I happened to notice. Four
 * hundred and seventy-six guesses is a lot of guesses and still not a search.
 *
 * This inverts it. Take every coin with a graded outcome, take everything known
 * about it at call time, and ask the data which conditions the winners share. No
 * hypothesis goes in; the rules come out.
 *
 * ── Why it mines both halves ───────────────────────────────────────────────────
 *
 * Called coins alone would answer "of the coins I buy, which run" and could never
 * say anything about the ones the gates rejected — which is where the biggest
 * misses live. The Pygmy Shit reached 38x behind a BUNDLED rejection. A miner that
 * cannot see it cannot tell you the gate is too tight. So the pool is calls plus
 * rejections, roughly 4,400 observations against 419.
 *
 * ── Guarding against finding nothing ──────────────────────────────────────────
 *
 * With ~25 features cut into bands there are a few hundred conditions, and every
 * pair and triple of those is millions of rules. Search that hard against 4,400
 * coins and you will always find something that looks perfect and means nothing.
 * Three defences, in order of how much they matter:
 *
 *   1. TIME-SPLIT VALIDATION. Rules are mined on the older 70% of the data and
 *      scored again on the newer 30%, which the miner never saw. A rule that holds
 *      in both is worth reading. A rule that collapses is exactly the overfit this
 *      whole exercise is prone to, and it is labelled rather than hidden.
 *   2. SUPPORT FLOOR. A rule matching nine coins can show any lift at all. Nothing
 *      below MIN_SUPPORT is reported, in either window.
 *   3. BEAM, NOT EXHAUSTION. Conditions are ranked alone, then only the strongest
 *      are extended into pairs and triples. This searches far less than the full
 *      space on purpose — a smaller search finds fewer accidents.
 *
 * None of it makes a mined rule true. It makes the ones that survive worth the
 * cost of testing, which is the most a miner should claim.
 *
 * Nothing here can block a call. The output is scored beside the hand-written
 * candidates and stops there.
 */
import type { Snapshot } from './filter-lab.js';

export interface MinedObs {
  peak: number;
  taken: boolean;
  at: number;          // entryTime / skip timestamp, for the time split
  snap: Snapshot;
}

export interface Condition {
  /** Stable id, used to build the composite key. */
  id: string;
  /** How it reads on the page. */
  label: string;
  /** Which snapshot field it came from, so a rule never stacks two bands of one field. */
  field: string;
  test: (s: Snapshot) => boolean | null;
}

export interface Rule {
  key: string;
  label: string;
  conditions: string[];
  /** Coins matching the rule, in the window it was mined on. */
  support: number;
  /** Share of matches that reached the target. */
  precision: number;
  /** Precision divided by the base rate. Above 1 means better than picking at random. */
  lift: number;
  /** Share of ALL target-reaching coins the rule catches. */
  recall: number;
  /** Same three, recomputed on data the miner never saw. */
  holdoutSupport: number;
  holdoutPrecision: number;
  holdoutLift: number;
  /** Median peak of the coins it matches, out of sample. */
  holdoutMedianPeak: number;
  verdict: 'holds' | 'weakens' | 'collapses' | 'untested';
}

export interface MineResult {
  target: number;
  observations: number;
  trainCount: number;
  holdoutCount: number;
  baseRate: number;
  holdoutBaseRate: number;
  splitAt: number;
  rules: Rule[];
  singles: Rule[];
}

/** Below this many matches a rate is an anecdote. Applied to both windows. */
const MIN_SUPPORT = 30;
const MIN_HOLDOUT_SUPPORT = 12;
/** How many single conditions get carried forward into pairs and triples. */
const BEAM = 22;
/** A rule is only interesting if it beats the base rate by this much. */
const MIN_LIFT = 1.15;

/* ── Conditions ──────────────────────────────────────────────────────────────
 *
 * Every numeric field becomes a handful of threshold tests rather than one. The
 * thresholds are fixed rather than learned from quantiles on purpose: a boundary
 * chosen to fit the data is one more thing that can fit noise, and a rule reading
 * "liquidity over $10K" is worth more to a human than one reading "over $11,431".
 */
function num(field: string, get: (s: Snapshot) => number | null | undefined,
             cuts: number[], fmt: (v: number) => string, dir: 'over' | 'under' | 'both' = 'both'): Condition[] {
  const out: Condition[] = [];
  for (const c of cuts) {
    if (dir !== 'under') out.push({
      id: `${field}>${c}`, field, label: `${field} over ${fmt(c)}`,
      test: s => { const v = get(s); return v == null || !isFinite(v) ? null : v > c; },
    });
    if (dir !== 'over') out.push({
      id: `${field}<${c}`, field, label: `${field} under ${fmt(c)}`,
      test: s => { const v = get(s); return v == null || !isFinite(v) ? null : v < c; },
    });
  }
  return out;
}

const usd = (v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${v}`);
const pct = (v: number) => `${v}%`;
const raw = (v: number) => `${v}`;
const mins = (v: number) => `${v}m`;

export function buildConditions(): Condition[] {
  const trades = (s: Snapshot) => s.buys5m + s.sells5m;
  const C: Condition[] = [
    ...num('market cap',      s => s.mc,      [10000, 20000, 30000, 50000, 80000], usd),
    ...num('liquidity',       s => s.liq,     [5000, 10000, 15000, 25000], usd),
    ...num('5m volume',       s => s.vol5m,   [5000, 15000, 30000, 60000], usd),
    ...num('1h volume',       s => s.vol1h,   [20000, 60000, 150000], usd),
    ...num('token age',       s => s.ageMin,  [3, 10, 30, 120], mins),
    ...num('5m trades',       s => trades(s), [40, 100, 200, 400], raw),
    ...num('5m buys',         s => s.buys5m,  [25, 60, 150], raw),
    ...num('5m change',       s => s.chg5m,   [0, 20, 60, 150], pct),
    ...num('1h change',       s => s.chg1h,   [0, 50, 150, 400], pct),
    ...num('6h change',       s => s.chg6h,   [0, 100, 400], pct),
    ...num('veterans',        s => s.veterans, [3, 8, 15, 30], raw),
    ...num('fresh wallets',   s => s.freshWallets, [10, 25, 50], raw),
    ...num('owners',          s => s.deepOwners, [50, 120, 250], raw),
    ...num('independent',     s => s.deepIndependent, [30, 70, 120], raw),
    ...num('funders',         s => s.deepFunders, [8, 20, 40], raw),
    ...num('cluster share',   s => s.deepClusterPct, [5, 15, 30], pct),
    ...num('same-funder',     s => s.sameFunderPct, [3, 10, 25], pct),
    ...num('dev holds',       s => s.devHoldPct, [1, 5, 12], pct),
    ...num('socials',         s => s.socials, [0, 1], raw),
    // Derived — the ratios that carried the most signal in the hand-written set.
    ...num('fresh share',     s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t >= 10 ? ((s.freshWallets ?? 0) / t) * 100 : null; }, [30, 50, 70], pct),
    ...num('avg trade',       s => { const t = trades(s); return t > 0 ? s.vol5m / t : null; }, [30, 60, 120], usd),
    ...num('buy share',       s => { const t = trades(s); return t > 0 ? (s.buys5m / t) * 100 : null; }, [45, 55, 65], pct),
    ...num('liq over MC',     s => (s.mc > 0 ? (s.liq / s.mc) * 100 : null), [8, 15, 30], pct),
    ...num('vol over MC',     s => (s.mc > 0 ? (s.vol5m / s.mc) * 100 : null), [20, 60, 150], pct),
    ...num('pool turnover',   s => (s.liq > 0 ? (s.vol5m / s.liq) * 100 : null), [30, 100, 300], pct),
    ...num('5m share of 1h',  s => (s.vol1h > 0 ? (s.vol5m / s.vol1h) * 100 : null), [15, 30, 60], pct),
    ...num('hour of day',     s => (s.hourUtc ?? null), [4, 8, 12, 16, 20], v => `${v}:00 UTC`),
  ];
  // Categorical: the channel, which is the one thing about a coin that is not a number.
  for (const src of ['soltrenchtrending', 'solearlytrending', 'solwhaletrending', 'gem_tools_calls']) {
    C.push({ id: `src=${src}`, field: 'source', label: `called by ${src}`,
      test: s => (s.source ? s.source === src : null) });
  }
  C.push({ id: 'taken=1', field: 'taken', label: 'passed the live gates', test: () => null });
  return C.filter(c => c.id !== 'taken=1');
}

/* ── Scoring ─────────────────────────────────────────────────────────────── */

function score(rows: MinedObs[], tests: Condition[], target: number) {
  let match = 0, hit = 0;
  const peaks: number[] = [];
  for (const r of rows) {
    let ok = true;
    for (const c of tests) {
      const v = c.test(r.snap);
      if (v !== true) { ok = false; break; }   // null counts as "cannot say", which is not a match
    }
    if (!ok) continue;
    match++;
    peaks.push(r.peak);
    if (r.peak >= target) hit++;
  }
  peaks.sort((a, b) => a - b);
  return { match, hit, precision: match > 0 ? hit / match : 0, medianPeak: peaks.length ? peaks[Math.floor(peaks.length / 2)] : 0 };
}

function verdictFor(lift: number, holdoutLift: number, holdoutSupport: number): Rule['verdict'] {
  if (holdoutSupport < MIN_HOLDOUT_SUPPORT) return 'untested';
  if (holdoutLift >= lift * 0.75 && holdoutLift >= MIN_LIFT) return 'holds';
  if (holdoutLift >= 1.05) return 'weakens';
  return 'collapses';
}

/**
 * Mine rules for one target multiple.
 *
 * Order matters: singles first so the beam is honest about which conditions carry
 * signal alone, then pairs from the beam, then triples from the best pairs. A
 * condition that does nothing by itself can still matter in combination, and this
 * will miss those — that is the price of not searching millions of rules against
 * four thousand coins.
 */
export function mine(obs: MinedObs[], target: number): MineResult {
  const rows = obs.filter(o => isFinite(o.peak) && o.at > 0).sort((a, b) => a.at - b.at);
  const cut = Math.floor(rows.length * 0.7);
  const train = rows.slice(0, cut);
  const holdout = rows.slice(cut);
  const splitAt = holdout.length ? holdout[0].at : 0;

  const base = train.length ? train.filter(r => r.peak >= target).length / train.length : 0;
  const holdoutBase = holdout.length ? holdout.filter(r => r.peak >= target).length / holdout.length : 0;

  const conds = buildConditions();
  const mk = (tests: Condition[]): Rule | null => {
    const t = score(train, tests, target);
    if (t.match < MIN_SUPPORT) return null;
    const lift = base > 0 ? t.precision / base : 0;
    const h = score(holdout, tests, target);
    const hLift = holdoutBase > 0 ? h.precision / holdoutBase : 0;
    return {
      key: tests.map(c => c.id).join(' & '),
      label: tests.map(c => c.label).join('  +  '),
      conditions: tests.map(c => c.label),
      support: t.match,
      precision: t.precision,
      lift,
      recall: 0,
      holdoutSupport: h.match,
      holdoutPrecision: h.precision,
      holdoutLift: hLift,
      holdoutMedianPeak: h.medianPeak,
      verdict: verdictFor(lift, hLift, h.match),
    };
  };

  const singles: Rule[] = [];
  const beamPool: { rule: Rule; cond: Condition }[] = [];
  for (const c of conds) {
    const r = mk([c]);
    if (!r) continue;
    singles.push(r);
    if (r.lift >= MIN_LIFT) beamPool.push({ rule: r, cond: c });
  }
  singles.sort((a, b) => b.lift - a.lift);
  beamPool.sort((a, b) => b.rule.lift - a.rule.lift);
  const beam = beamPool.slice(0, BEAM);

  const pairs: { rule: Rule; tests: Condition[] }[] = [];
  for (let i = 0; i < beam.length; i++) {
    for (let j = i + 1; j < beam.length; j++) {
      // Two bands of the same field are either redundant or contradictory.
      if (beam[i].cond.field === beam[j].cond.field) continue;
      const tests = [beam[i].cond, beam[j].cond];
      const r = mk(tests);
      if (r && r.lift >= MIN_LIFT) pairs.push({ rule: r, tests });
    }
  }
  pairs.sort((a, b) => b.rule.lift - a.rule.lift);

  const triples: Rule[] = [];
  for (const p of pairs.slice(0, 30)) {
    for (const b of beam) {
      if (p.tests.some(t => t.field === b.cond.field)) continue;
      const tests = [...p.tests, b.cond];
      const r = mk(tests);
      if (r && r.lift >= MIN_LIFT) triples.push(r);
    }
  }

  const all = [...pairs.map(p => p.rule), ...triples];
  // One entry per condition set, regardless of the order they were found in.
  const seen = new Map<string, Rule>();
  for (const r of all) {
    const k = r.key.split(' & ').sort().join(' & ');
    const prev = seen.get(k);
    if (!prev || r.lift > prev.lift) seen.set(k, r);
  }
  const totalHits = train.filter(r => r.peak >= target).length || 1;
  const rules = [...seen.values()].map(r => ({ ...r, recall: (r.precision * r.support) / totalHits }));

  // A rule that survives the holdout beats a bigger in-sample number that does not.
  const rank = { holds: 0, weakens: 1, untested: 2, collapses: 3 } as const;
  rules.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (b.holdoutLift - a.holdoutLift) || (b.lift - a.lift));

  return {
    target,
    observations: rows.length,
    trainCount: train.length,
    holdoutCount: holdout.length,
    baseRate: base,
    holdoutBaseRate: holdoutBase,
    splitAt,
    rules: rules.slice(0, 40),
    singles: singles.slice(0, 25),
  };
}

/** Turn a mined rule back into something the filter lab can score. */
export function ruleToCandidate(r: Rule, target: number): { key: string; name: string; group: string; pass: (s: Snapshot) => boolean | null } {
  const conds = buildConditions();
  const byId = new Map(conds.map(c => [c.id, c]));
  const tests = r.key.split(' & ').map(id => byId.get(id)).filter(Boolean) as Condition[];
  return {
    key: `mined${target}_${r.key.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`,
    name: `[mined ${target}x] ${r.label}`,
    group: 'mined',
    pass: (s: Snapshot) => {
      let anyKnown = false;
      for (const t of tests) {
        const v = t.test(s);
        if (v === null) continue;
        anyKnown = true;
        if (!v) return false;
      }
      return anyKnown ? true : null;
    },
  };
}
