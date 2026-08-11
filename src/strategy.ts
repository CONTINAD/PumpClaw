/**
 * Generalized exit-strategy engine.
 * A strategy is a list of take-profit levels plus a trailing stop that is either
 * active from entry (pure trailing / hybrids) or armed after the last TP (ladder).
 * Every Strategy Lab preset is expressible here, and every field is editable
 * per-task at runtime from the dashboard.
 */

export interface TakeProfit {
  mult: number;     // trigger multiplier from entry (e.g. 2 = 2X)
  sellPct: number;  // fraction of ORIGINAL position to sell (0-1)
}

export interface Strategy {
  preset: string;                       // preset key or 'custom'
  // Entry timing. Every call in the sample dipped >=20% below the call price within
  // 30 min — buying the spike is buying a local top. 'dip' waits for a pullback.
  entryMode?: 'instant' | 'dip';
  dipPct?: number;                      // e.g. 0.20 = buy 20% below the call price
  dipWindowMin?: number;                // give up if the dip never comes
  tps: TakeProfit[];                    // ascending by mult; [] = pure trailing
  trailingDrop: number;                 // 0.05-0.90 — % drop from ATH that exits
  trailingFrom: 'entry' | 'afterLastTp';
  stopLossPct: number;                  // ladder-style initial stop (0.75 = -25%); ignored when trailingFrom=entry
  breakEvenAfterTp1: boolean;           // move stop to entry after first TP
  entryPct: number;                     // fraction of wallet balance per trade
  minEntrySol: number;
  maxEntrySol: number;                  // 0 = no cap
  slippageBps: number;
  priorityFeeLamports: number;
}

const BASE = {
  entryMode: 'instant' as const,
  dipPct: 0.20,
  dipWindowMin: 30,
  entryPct: 0.10,
  minEntrySol: 0.05,
  maxEntrySol: 0,
  slippageBps: 3000,
  priorityFeeLamports: 100_000,
};

export const STRATEGY_PRESETS: Record<string, { name: string; desc: string; make: () => Strategy }> = {
  trailing45: {
    name: '−45% trailing',
    desc: 'No TPs. Trailing stop from entry, exits 45% below ATH. Max tail exposure.',
    make: () => ({ ...BASE, preset: 'trailing45', tps: [], trailingDrop: 0.45, trailingFrom: 'entry', stopLossPct: 0.55, breakEvenAfterTp1: false }),
  },
  trailing35: {
    name: '−35% trailing',
    desc: 'No TPs. Tighter trailing from entry — best avg on historical calls.',
    make: () => ({ ...BASE, preset: 'trailing35', tps: [], trailingDrop: 0.35, trailingFrom: 'entry', stopLossPct: 0.65, breakEvenAfterTp1: false }),
  },
  trailing55: {
    name: '−55% trailing',
    desc: 'No TPs. Very loose trailing — survives deep dips, gives back the most.',
    make: () => ({ ...BASE, preset: 'trailing55', tps: [], trailingDrop: 0.55, trailingFrom: 'entry', stopLossPct: 0.45, breakEvenAfterTp1: false }),
  },
  ladder: {
    name: 'TP ladder 1.5/2.5/4',
    desc: 'Sell 40/30/20% at 1.5/2.5/4X, BE stop after TP1, trail last 10%.',
    make: () => ({ ...BASE, preset: 'ladder', tps: [{ mult: 1.5, sellPct: 0.4 }, { mult: 2.5, sellPct: 0.3 }, { mult: 4, sellPct: 0.2 }], trailingDrop: 0.45, trailingFrom: 'afterLastTp', stopLossPct: 0.75, breakEvenAfterTp1: true }),
  },
  hyb3: {
    name: '40% @ 3X + trail',
    desc: 'Bank 40% at 3X, trail the remaining 60% at −45% from entry.',
    make: () => ({ ...BASE, preset: 'hyb3', tps: [{ mult: 3, sellPct: 0.4 }], trailingDrop: 0.45, trailingFrom: 'entry', stopLossPct: 0.55, breakEvenAfterTp1: false }),
  },
  dip20tp2: {
    name: 'Dip −20% → TP 2X',
    desc: 'Wait for a 20% pullback, then flat 2X take-profit. Best on 42 real paths (+11.8%/trade).',
    make: () => ({ ...BASE, preset: 'dip20tp2', entryMode: 'dip' as const, dipPct: 0.20, dipWindowMin: 30, tps: [{ mult: 2, sellPct: 1 }], trailingDrop: 0.6, trailingFrom: 'entry' as const, stopLossPct: 0.4, breakEvenAfterTp1: false }),
  },
  dip20tp2stop: {
    name: 'Dip −20% → TP 2X, stop −20%',
    desc: 'Same entry, hard −20% stop. Fewer wins, smaller losers (+9.8%/trade).',
    make: () => ({ ...BASE, preset: 'dip20tp2stop', entryMode: 'dip' as const, dipPct: 0.20, dipWindowMin: 30, tps: [{ mult: 2, sellPct: 1 }], trailingDrop: 0.8, trailingFrom: 'entry' as const, stopLossPct: 0.8, breakEvenAfterTp1: false }),
  },
  dip20split: {
    name: 'Dip −20% → 50%@1.3 + 50%@2',
    desc: 'Pullback entry, bank half early. Highest win rate at 60% (+5.5%/trade).',
    make: () => ({ ...BASE, preset: 'dip20split', entryMode: 'dip' as const, dipPct: 0.20, dipWindowMin: 30, tps: [{ mult: 1.3, sellPct: 0.5 }, { mult: 2, sellPct: 0.5 }], trailingDrop: 0.7, trailingFrom: 'entry' as const, stopLossPct: 0.7, breakEvenAfterTp1: true }),
  },
  instanttp15: {
    name: 'Instant → TP 1.5X',
    desc: 'No waiting, quick 1.5X scalp — best instant-entry variant (+3.8%/trade).',
    make: () => ({ ...BASE, preset: 'instanttp15', tps: [{ mult: 1.5, sellPct: 1 }], trailingDrop: 0.7, trailingFrom: 'entry' as const, stopLossPct: 0.7, breakEvenAfterTp1: false }),
  },
  hyb2: {
    name: '50% @ 2X + trail',
    desc: 'Bank 50% at 2X, trail the remaining half at −45% from entry.',
    make: () => ({ ...BASE, preset: 'hyb2', tps: [{ mult: 2, sellPct: 0.5 }], trailingDrop: 0.45, trailingFrom: 'entry', stopLossPct: 0.55, breakEvenAfterTp1: false }),
  },
};

// ── Test fleet ──────────────────────────────────────────────
// A grid spanning entry timing × exit shape, so a day of live paper trading
// tells us which region of the space actually works instead of guessing.

type Spec = {
  key: string; name: string; desc: string;
  dip?: number;                       // undefined = instant entry
  tps?: [number, number][];
  trail?: number;
  trailFrom?: 'entry' | 'afterLastTp';
  stop?: number;                      // fraction of entry (0.8 = -20%)
  be?: boolean;
};

const GRID: Spec[] = [
  // ── dip-entry family (the sim's winners) ──
  { key: 'dip10tp2',    name: 'Dip −10% → TP 2X',        desc: 'Shallow pullback entry, flat 2X exit.',            dip: .10, tps: [[2, 1]], stop: .5 },
  { key: 'dip15tp2',    name: 'Dip −15% → TP 2X',        desc: 'Mid pullback entry, flat 2X exit.',                dip: .15, tps: [[2, 1]], stop: .5 },
  { key: 'dip25tp2',    name: 'Dip −25% → TP 2X',        desc: 'Deeper pullback entry, flat 2X exit.',             dip: .25, tps: [[2, 1]], stop: .5 },
  { key: 'dip30tp2',    name: 'Dip −30% → TP 2X',        desc: 'Deepest pullback entry, flat 2X exit.',            dip: .30, tps: [[2, 1]], stop: .5 },
  { key: 'dip20tp13',   name: 'Dip −20% → TP 1.3X',      desc: 'Pullback entry, fast scalp.',                      dip: .20, tps: [[1.3, 1]], stop: .7 },
  { key: 'dip20tp15',   name: 'Dip −20% → TP 1.5X',      desc: 'Pullback entry, quick 1.5X.',                      dip: .20, tps: [[1.5, 1]], stop: .7 },
  { key: 'dip20tp3',    name: 'Dip −20% → TP 3X',        desc: 'Pullback entry, greedy 3X target.',                dip: .20, tps: [[3, 1]], stop: .5 },
  { key: 'dip20trail25',name: 'Dip −20% → trail 25%',    desc: 'Pullback entry, tight trailing stop.',             dip: .20, trail: .25, trailFrom: 'entry', stop: .75 },
  { key: 'dip20trail35',name: 'Dip −20% → trail 35%',    desc: 'Pullback entry, medium trailing stop.',            dip: .20, trail: .35, trailFrom: 'entry', stop: .65 },
  { key: 'dip20run',    name: 'Dip −20% → 70%@2X + run', desc: 'Bank most at 2X, trail the rest.',                 dip: .20, tps: [[2, .7]], trail: .4, trailFrom: 'entry', stop: .6, be: true },
  { key: 'dip20lad',    name: 'Dip −20% → 1.3/1.8/2.5',  desc: 'Pullback entry, tight scale-out ladder.',          dip: .20, tps: [[1.3, .4], [1.8, .3], [2.5, .3]], stop: .7, be: true },
  { key: 'dip10split',  name: 'Dip −10% → 50%@1.3+2X',   desc: 'Shallow dip, bank half early.',                    dip: .10, tps: [[1.3, .5], [2, .5]], stop: .7, be: true },
  { key: 'dip20split25',name: 'Dip −20% → 50%@1.5+2.5X', desc: 'Pullback entry, wider split.',                     dip: .20, tps: [[1.5, .5], [2.5, .5]], stop: .7, be: true },
  { key: 'dip20tight',  name: 'Dip −20% → TP 2X stop 10',desc: 'Pullback entry, very tight −10% stop.',            dip: .20, tps: [[2, 1]], stop: .9 },
  // ── instant-entry family (control group) ──
  { key: 'insttp13',    name: 'Instant → TP 1.3X',       desc: 'Buy the call, scalp 30%.',                                   tps: [[1.3, 1]], stop: .7 },
  { key: 'insttp2',     name: 'Instant → TP 2X',         desc: 'Buy the call, hold for 2X.',                                 tps: [[2, 1]], stop: .5 },
  { key: 'insttp15s',   name: 'Instant → TP 1.5X stop20',desc: 'Buy the call, 1.5X target, −20% stop.',                      tps: [[1.5, 1]], stop: .8 },
  { key: 'instsplit',   name: 'Instant → 50%@1.3+2X',    desc: 'Buy the call, bank half at 1.3X.',                           tps: [[1.3, .5], [2, .5]], stop: .7, be: true },
  { key: 'insttrail25', name: 'Instant → trail 25%',     desc: 'Buy the call, tight trailing stop.',                         trail: .25, trailFrom: 'entry', stop: .75 },
  { key: 'instlad',     name: 'Instant → 1.3/1.8/2.5',   desc: 'Buy the call, tight scale-out ladder.',                      tps: [[1.3, .4], [1.8, .3], [2.5, .3]], stop: .7, be: true },
];

for (const g of GRID) {
  STRATEGY_PRESETS[g.key] = {
    name: g.name,
    desc: g.desc,
    make: () => ({
      ...BASE,
      preset: g.key,
      entryMode: g.dip ? ('dip' as const) : ('instant' as const),
      dipPct: g.dip ?? 0.2,
      dipWindowMin: 30,
      tps: (g.tps ?? []).map(([mult, sellPct]) => ({ mult, sellPct })),
      trailingDrop: g.trail ?? 0.9,          // 0.9 = effectively no trailing when unset
      trailingFrom: g.trailFrom ?? ('entry' as const),
      stopLossPct: g.stop ?? 0.5,
      breakEvenAfterTp1: !!g.be,
    }),
  };
}

/** Clamp + sanity-fix a strategy coming from user input. */
export function sanitizeStrategy(s: Partial<Strategy>): Strategy {
  const base = STRATEGY_PRESETS.trailing45.make();
  const clamp = (v: any, lo: number, hi: number, dflt: number) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const tps = Array.isArray(s.tps)
    ? s.tps
        .map(tp => ({ mult: clamp(tp.mult, 1.05, 1000, 2), sellPct: clamp(tp.sellPct, 0.01, 1, 0.25) }))
        .sort((a, b) => a.mult - b.mult)
        .slice(0, 6)
    : base.tps;
  const totalSell = tps.reduce((sum, tp) => sum + tp.sellPct, 0);
  if (totalSell > 1) {
    for (const tp of tps) tp.sellPct = tp.sellPct / totalSell; // normalize to 100%
  }
  const trailingDrop = clamp(s.trailingDrop, 0.05, 0.9, base.trailingDrop);
  return {
    preset: typeof s.preset === 'string' ? s.preset : 'custom',
    entryMode: s.entryMode === 'dip' ? 'dip' : 'instant',
    dipPct: clamp(s.dipPct, 0.02, 0.8, 0.20),
    dipWindowMin: clamp(s.dipWindowMin, 1, 240, 30),
    tps,
    trailingDrop,
    trailingFrom: s.trailingFrom === 'afterLastTp' ? 'afterLastTp' : 'entry',
    stopLossPct: clamp(s.stopLossPct, 0.05, 0.99, 1 - trailingDrop),
    breakEvenAfterTp1: !!s.breakEvenAfterTp1,
    entryPct: clamp(s.entryPct, 0.01, 1, base.entryPct),
    minEntrySol: clamp(s.minEntrySol, 0.01, 100, base.minEntrySol),
    maxEntrySol: clamp(s.maxEntrySol, 0, 1000, 0),
    slippageBps: Math.round(clamp(s.slippageBps, 100, 9900, base.slippageBps)),
    priorityFeeLamports: Math.round(clamp(s.priorityFeeLamports, 0, 10_000_000, base.priorityFeeLamports)),
  };
}

/** Deterministic payout of 1 SOL entry for a coin that peaks at P (Strategy Lab model). */
export function simulateStrategy(s: Strategy, P: number): number {
  let proceeds = 0, remaining = 1, hitAny = false;
  for (const tp of s.tps) {
    if (P >= tp.mult) { proceeds += tp.sellPct * tp.mult; remaining -= tp.sellPct; hitAny = true; } else break;
  }
  const allHit = s.tps.length === 0 || P >= s.tps[s.tps.length - 1].mult;
  if (remaining > 1e-9) {
    let exitMult: number;
    if (s.trailingFrom === 'entry') {
      exitMult = Math.max(P * (1 - s.trailingDrop), 1 - s.trailingDrop);
      if (hitAny && s.breakEvenAfterTp1) exitMult = Math.max(exitMult, 1);
    } else if (allHit && s.tps.length > 0) {
      exitMult = Math.max(P * (1 - s.trailingDrop), s.breakEvenAfterTp1 && hitAny ? 1 : s.stopLossPct);
    } else if (hitAny) {
      exitMult = s.breakEvenAfterTp1 ? 1 : s.stopLossPct;
    } else {
      exitMult = s.stopLossPct;
    }
    proceeds += remaining * exitMult;
  }
  return proceeds;
}

export function describeStrategy(s: Strategy): string {
  const parts: string[] = [];
  for (const tp of s.tps) parts.push(`${Math.round(tp.sellPct * 100)}%@${tp.mult}X`);
  parts.push(`trail −${Math.round(s.trailingDrop * 100)}%${s.trailingFrom === 'entry' ? ' (entry)' : ' (after TPs)'}`);
  return parts.join(' · ');
}
