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
  maxHoldMin?: number;                  // hard time exit — sell the rest after N minutes
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
  maxHoldMin: 0,
  entryPct: 0.10,
  minEntrySol: 0.05,
  maxEntrySol: 0,
  slippageBps: 1500,
  priorityFeeLamports: 30_000,
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
    make: () => ({ ...BASE, preset: 'dip20tp2', entryMode: 'dip' as const, dipPct: 0.20, dipWindowMin: 30, tps: [{ mult: 2, sellPct: 1 }], trailingDrop: 0.9, trailingFrom: 'afterLastTp' as const, stopLossPct: 0.4, breakEvenAfterTp1: false }),
  },
  dip20tp2stop: {
    name: 'Dip −20% → TP 2X, stop −20%',
    desc: 'Same entry, hard −20% stop. Fewer wins, smaller losers (+9.8%/trade).',
    make: () => ({ ...BASE, preset: 'dip20tp2stop', entryMode: 'dip' as const, dipPct: 0.20, dipWindowMin: 30, tps: [{ mult: 2, sellPct: 1 }], trailingDrop: 0.9, trailingFrom: 'afterLastTp' as const, stopLossPct: 0.8, breakEvenAfterTp1: false }),
  },
  dip20split: {
    name: 'Dip −20% → 50%@1.3 + 50%@2',
    desc: 'Pullback entry, bank half early. Highest win rate at 60% (+5.5%/trade).',
    make: () => ({ ...BASE, preset: 'dip20split', entryMode: 'dip' as const, dipPct: 0.20, dipWindowMin: 30, tps: [{ mult: 1.3, sellPct: 0.5 }, { mult: 2, sellPct: 0.5 }], trailingDrop: 0.9, trailingFrom: 'afterLastTp' as const, stopLossPct: 0.7, breakEvenAfterTp1: true }),
  },
  instanttp15: {
    name: 'Instant → TP 1.5X',
    desc: 'No waiting, quick 1.5X scalp — best instant-entry variant (+3.8%/trade).',
    make: () => ({ ...BASE, preset: 'instanttp15', tps: [{ mult: 1.5, sellPct: 1 }], trailingDrop: 0.9, trailingFrom: 'afterLastTp' as const, stopLossPct: 0.7, breakEvenAfterTp1: false }),
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
  win?: number;                       // dip window in minutes (default 30)
  hold?: number;                      // hard time exit in minutes
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

  // ── time-boxed exits (what the most-maintained public bots actually ship) ──
  { key: 'inst5m',      name: 'Instant → hold 5m',       desc: 'Buy the call, sell everything after 5 minutes.',             hold: 5,  stop: .5 },
  { key: 'inst10m',     name: 'Instant → hold 10m',      desc: 'Buy the call, flat exit at 10 minutes.',                     hold: 10, stop: .5 },
  { key: 'inst3m',      name: 'Instant → hold 3m',       desc: 'Median time-to-peak is 2 min — exit right after it.',        hold: 3,  stop: .5 },
  { key: 'inst2m',      name: 'Instant → hold 2m',       desc: 'Exit at the measured median peak.',                          hold: 2,  stop: .6 },
  { key: 'inst5mtp15',  name: 'Instant → TP 1.5X or 5m', desc: 'Whichever comes first: 1.5X or five minutes.',               hold: 5,  tps: [[1.5, 1]], stop: .6 },
  { key: 'inst10mtp2',  name: 'Instant → TP 2X or 10m',  desc: 'Whichever comes first: 2X or ten minutes.',                  hold: 10, tps: [[2, 1]], stop: .6 },
  { key: 'dip20hold10', name: 'Dip −20% → hold 10m',     desc: 'Pullback entry, flat 10-minute exit.',              dip: .20, hold: 10, stop: .5 },
  { key: 'dip20hold5',  name: 'Dip −20% → hold 5m',      desc: 'Pullback entry, flat 5-minute exit.',               dip: .20, hold: 5,  stop: .5 },
  { key: 'dip20tp2h15', name: 'Dip −20% → 2X or 15m',    desc: 'Pullback entry, 2X target with a 15-min cutoff.',   dip: .20, hold: 15, tps: [[2, 1]], stop: .6 },
  { key: 'dip10hold10', name: 'Dip −10% → hold 10m',     desc: 'Shallow pullback, 10-minute exit.',                 dip: .10, hold: 10, stop: .5 },

  // ── shallow-target family (costs are ~3%, so small edges can still clear) ──
  { key: 'insttp12',    name: 'Instant → TP 1.2X',       desc: 'Tiny 20% scalp, tight stop.',                                tps: [[1.2, 1]], stop: .85 },
  { key: 'dip20tp12',   name: 'Dip −20% → TP 1.2X',      desc: 'Pullback entry, tiny scalp back to the call price.', dip: .20, tps: [[1.2, 1]], stop: .85 },
  { key: 'dip20tp125',  name: 'Dip −20% → TP 1.25X',     desc: 'Pullback entry, exit at roughly the call price.',   dip: .20, tps: [[1.25, 1]], stop: .8 },
  { key: 'insttp175',   name: 'Instant → TP 1.75X',      desc: 'Middle target between the 1.5X and 2X variants.',            tps: [[1.75, 1]], stop: .6 },
  { key: 'dip20tp175',  name: 'Dip −20% → TP 1.75X',     desc: 'Pullback entry, 1.75X target.',                     dip: .20, tps: [[1.75, 1]], stop: .6 },

  // ── deep-dip family (are the deepest pullbacks the real bargains?) ──
  { key: 'dip40tp2',    name: 'Dip −40% → TP 2X',        desc: 'Only buy a violent flush, then 2X.',                dip: .40, tps: [[2, 1]], stop: .5 },
  { key: 'dip40tp15',   name: 'Dip −40% → TP 1.5X',      desc: 'Violent flush entry, modest target.',               dip: .40, tps: [[1.5, 1]], stop: .6 },
  { key: 'dip30split',  name: 'Dip −30% → 50%@1.3+2X',   desc: 'Deep pullback, bank half early.',                   dip: .30, tps: [[1.3, .5], [2, .5]], stop: .7, be: true },
  { key: 'dip5tp15',    name: 'Dip −5% → TP 1.5X',       desc: 'Barely wait at all, quick target.',                 dip: .05, tps: [[1.5, 1]], stop: .7 },

  // ── stop-width sweep on the sim's best shape ──
  { key: 'dip20tp2s30', name: 'Dip −20% → 2X, stop −30%',desc: 'Same shape, mid-width stop.',                       dip: .20, tps: [[2, 1]], stop: .7 },
  { key: 'dip20tp2s40', name: 'Dip −20% → 2X, stop −40%',desc: 'Same shape, wider stop.',                           dip: .20, tps: [[2, 1]], stop: .6 },
  { key: 'dip20tp2ns',  name: 'Dip −20% → 2X, no stop',  desc: 'Pullback entry, ride it out to the target.',        dip: .20, tps: [[2, 1]], stop: .05 },
  { key: 'insttp2ns',   name: 'Instant → TP 2X, no stop',desc: 'Buy the call and never cut — the control case.',              tps: [[2, 1]], stop: .05 },

  // ── runner variants: bank most, leave a lottery ticket ──
  { key: 'dip20r90',    name: 'Dip −20% → 90%@2X + run', desc: 'Bank 90% at 2X, let 10% ride on a trail.',          dip: .20, tps: [[2, .9]], trail: .5, trailFrom: 'entry', stop: .6, be: true },
  { key: 'instr80',     name: 'Instant → 80%@1.5X + run',desc: 'Bank 80% at 1.5X, trail the rest.',                          tps: [[1.5, .8]], trail: .4, trailFrom: 'entry', stop: .7, be: true },
  { key: 'dip20lad3',   name: 'Dip −20% → 1.2/1.5/2/3',  desc: 'Four-rung ladder from a pullback entry.',           dip: .20, tps: [[1.2, .3], [1.5, .3], [2, .2], [3, .2]], stop: .7, be: true },
  { key: 'instlad4',    name: 'Instant → 1.2/1.5/2/3',   desc: 'Four-rung ladder from the call price.',                      tps: [[1.2, .3], [1.5, .3], [2, .2], [3, .2]], stop: .7, be: true },

  // ── tight trailing sweep ──
  { key: 'insttrail15', name: 'Instant → trail 15%',     desc: 'Very tight trail from the call price.',                      trail: .15, trailFrom: 'entry', stop: .85 },
  { key: 'insttrail20', name: 'Instant → trail 20%',     desc: 'Tight trail from the call price.',                           trail: .20, trailFrom: 'entry', stop: .8 },
  { key: 'dip20trail15',name: 'Dip −20% → trail 15%',    desc: 'Pullback entry, very tight trail.',                 dip: .20, trail: .15, trailFrom: 'entry', stop: .85 },
  { key: 'dip20trail20',name: 'Dip −20% → trail 20%',    desc: 'Pullback entry, tight trail.',                      dip: .20, trail: .20, trailFrom: 'entry', stop: .8 },
];

// ── Generation 2: the 50 most ROBUST combos from a 520-combination sweep over 42
// real minute-candle paths. Ranked by average PnL AFTER removing the top 3 trades,
// so tail-dependent flukes are excluded — only 57 of 520 survived that test.
const GRID2: Spec[] = [
  { key: 'v2d25tp14s50', name: 'Dip −25% → TP 1.4X · stop −50%', desc: 'Backtest robust-avg +0.1109, 75% win on 42 real paths.', dip: 0.25, tps: [[1.4, 1]], stop: 0.5 },
  { key: 'v2d30tp14s50', name: 'Dip −30% → TP 1.4X · stop −50%', desc: 'Backtest robust-avg +0.1045, 74% win on 42 real paths.', dip: 0.3, tps: [[1.4, 1]], stop: 0.5 },
  { key: 'v2d30tp15s50', name: 'Dip −30% → TP 1.5X · stop −50%', desc: 'Backtest robust-avg +0.0938, 67% win on 42 real paths.', dip: 0.3, tps: [[1.5, 1]], stop: 0.5 },
  { key: 'v2d10tp175s30', name: 'Dip −10% → TP 1.75X · stop −30%', desc: 'Backtest robust-avg +0.0860, 45% win on 42 real paths.', dip: 0.1, tps: [[1.75, 1]], stop: 0.7 },
  { key: 'v2d25tp13s50', name: 'Dip −25% → TP 1.3X · stop −50%', desc: 'Backtest robust-avg +0.0824, 80% win on 42 real paths.', dip: 0.25, tps: [[1.3, 1]], stop: 0.5 },
  { key: 'v2d15tp175s30', name: 'Dip −15% → TP 1.75X · stop −30%', desc: 'Backtest robust-avg +0.0601, 43% win on 42 real paths.', dip: 0.15, tps: [[1.75, 1]], stop: 0.7 },
  { key: 'v2d20tp2s30', name: 'Dip −20% → TP 2X · stop −30%', desc: 'Backtest robust-avg +0.0564, 36% win on 42 real paths.', dip: 0.2, tps: [[2, 1]], stop: 0.7 },
  { key: 'v2d30tp13s50', name: 'Dip −30% → TP 1.3X · stop −50%', desc: 'Backtest robust-avg +0.0564, 77% win on 42 real paths.', dip: 0.3, tps: [[1.3, 1]], stop: 0.5 },
  { key: 'v2d20tp13s50', name: 'Dip −20% → TP 1.3X · stop −50%', desc: 'Backtest robust-avg +0.0515, 76% win on 42 real paths.', dip: 0.2, tps: [[1.3, 1]], stop: 0.5 },
  { key: 'v2d25tp15s50', name: 'Dip −25% → TP 1.5X · stop −50%', desc: 'Backtest robust-avg +0.0512, 63% win on 42 real paths.', dip: 0.25, tps: [[1.5, 1]], stop: 0.5 },
  { key: 'v2d15tp175s20', name: 'Dip −15% → TP 1.75X · stop −20%', desc: 'Backtest robust-avg +0.0491, 36% win on 42 real paths.', dip: 0.15, tps: [[1.75, 1]], stop: 0.8 },
  { key: 'v2d22tp14s50', name: 'Dip −22% → TP 1.4X · stop −50%', desc: 'Backtest robust-avg +0.0489, 68% win on 42 real paths.', dip: 0.22, tps: [[1.4, 1]], stop: 0.5 },
  { key: 'v2d25tp13s40', name: 'Dip −25% → TP 1.3X · stop −40%', desc: 'Backtest robust-avg +0.0487, 73% win on 42 real paths.', dip: 0.25, tps: [[1.3, 1]], stop: 0.6 },
  { key: 'v2d22tp13s50', name: 'Dip −22% → TP 1.3X · stop −50%', desc: 'Backtest robust-avg +0.0463, 76% win on 42 real paths.', dip: 0.22, tps: [[1.3, 1]], stop: 0.5 },
  { key: 'v2d30tp14s40', name: 'Dip −30% → TP 1.4X · stop −40%', desc: 'Backtest robust-avg +0.0458, 64% win on 42 real paths.', dip: 0.3, tps: [[1.4, 1]], stop: 0.6 },
  { key: 'v2d20tp2s15', name: 'Dip −20% → TP 2X · stop −15%', desc: 'Backtest robust-avg +0.0429, 26% win on 42 real paths.', dip: 0.2, tps: [[2, 1]], stop: 0.85 },
  { key: 'v2d22tp2s20', name: 'Dip −22% → TP 2X · stop −20%', desc: 'Backtest robust-avg +0.0413, 29% win on 42 real paths.', dip: 0.22, tps: [[2, 1]], stop: 0.8 },
  { key: 'v2d20tp2s20', name: 'Dip −20% → TP 2X · stop −20%', desc: 'Backtest robust-avg +0.0343, 29% win on 42 real paths.', dip: 0.2, tps: [[2, 1]], stop: 0.8 },
  { key: 'v2d20tp14s50', name: 'Dip −20% → TP 1.4X · stop −50%', desc: 'Backtest robust-avg +0.0343, 67% win on 42 real paths.', dip: 0.2, tps: [[1.4, 1]], stop: 0.5 },
  { key: 'v2d25tp14s40', name: 'Dip −25% → TP 1.4X · stop −40%', desc: 'Backtest robust-avg +0.0331, 63% win on 42 real paths.', dip: 0.25, tps: [[1.4, 1]], stop: 0.6 },
  { key: 'v2d20tp12s50', name: 'Dip −20% → TP 1.2X · stop −50%', desc: 'Backtest robust-avg +0.0318, 83% win on 42 real paths.', dip: 0.2, tps: [[1.2, 1]], stop: 0.5 },
  { key: 'v2d18tp13s50', name: 'Dip −18% → TP 1.3X · stop −50%', desc: 'Backtest robust-avg +0.0318, 74% win on 42 real paths.', dip: 0.18, tps: [[1.3, 1]], stop: 0.5 },
  { key: 'v2d10tp175s40', name: 'Dip −10% → TP 1.75X · stop −40%', desc: 'Backtest robust-avg +0.0294, 45% win on 42 real paths.', dip: 0.1, tps: [[1.75, 1]], stop: 0.6 },
  { key: 'v2d10tp15s30', name: 'Dip −10% → TP 1.5X · stop −30%', desc: 'Backtest robust-avg +0.0269, 50% win on 42 real paths.', dip: 0.1, tps: [[1.5, 1]], stop: 0.7 },
  { key: 'v2d10tp175s20', name: 'Dip −10% → TP 1.75X · stop −20%', desc: 'Backtest robust-avg +0.0257, 33% win on 42 real paths.', dip: 0.1, tps: [[1.75, 1]], stop: 0.8 },
  { key: 'v2d10tp2s30', name: 'Dip −10% → TP 2X · stop −30%', desc: 'Backtest robust-avg +0.0244, 33% win on 42 real paths.', dip: 0.1, tps: [[2, 1]], stop: 0.7 },
  { key: 'v2d18tp2s30', name: 'Dip −18% → TP 2X · stop −30%', desc: 'Backtest robust-avg +0.0244, 33% win on 42 real paths.', dip: 0.18, tps: [[2, 1]], stop: 0.7 },
  { key: 'v2d20tp15s50', name: 'Dip −20% → TP 1.5X · stop −50%', desc: 'Backtest robust-avg +0.0220, 60% win on 42 real paths.', dip: 0.2, tps: [[1.5, 1]], stop: 0.5 },
  { key: 'v2d22tp14s40', name: 'Dip −22% → TP 1.4X · stop −40%', desc: 'Backtest robust-avg +0.0211, 61% win on 42 real paths.', dip: 0.22, tps: [[1.4, 1]], stop: 0.6 },
  { key: 'v2d25tp15s40', name: 'Dip −25% → TP 1.5X · stop −40%', desc: 'Backtest robust-avg +0.0201, 55% win on 42 real paths.', dip: 0.25, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'v2d20tp15s40', name: 'Dip −20% → TP 1.5X · stop −40%', desc: 'Backtest robust-avg +0.0195, 55% win on 42 real paths.', dip: 0.2, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'v2d20split122s30', name: 'Dip −20% → split1.2/2 stop −30%', desc: 'Backtest robust-avg +0.0183, 36% win on 42 real paths.', dip: 0.2, tps: [[1.2, 0.5], [2, 0.5]], stop: 0.7 },
  { key: 'v2d15tp175s15', name: 'Dip −15% → TP 1.75X · stop −15%', desc: 'Backtest robust-avg +0.0158, 29% win on 42 real paths.', dip: 0.15, tps: [[1.75, 1]], stop: 0.85 },
  { key: 'v2d18tp12s50', name: 'Dip −18% → TP 1.2X · stop −50%', desc: 'Backtest robust-avg +0.0146, 81% win on 42 real paths.', dip: 0.18, tps: [[1.2, 1]], stop: 0.5 },
  { key: 'v2d20split122s50', name: 'Dip −20% → split1.2/2 stop −50%', desc: 'Backtest robust-avg +0.0146, 40% win on 42 real paths.', dip: 0.2, tps: [[1.2, 0.5], [2, 0.5]], stop: 0.5 },
  { key: 'v2d20sc701325s50', name: 'Dip −20% → sc70@1.3+2.5 stop −50%', desc: 'Backtest robust-avg +0.0131, 76% win on 42 real paths.', dip: 0.2, tps: [[1.3, 0.7], [2.5, 0.3]], stop: 0.5 },
  { key: 'v2d22tp12s50', name: 'Dip −22% → TP 1.2X · stop −50%', desc: 'Backtest robust-avg +0.0109, 80% win on 42 real paths.', dip: 0.22, tps: [[1.2, 1]], stop: 0.5 },
  { key: 'v2d10tp15s20', name: 'Dip −10% → TP 1.5X · stop −20%', desc: 'Backtest robust-avg +0.0097, 40% win on 42 real paths.', dip: 0.1, tps: [[1.5, 1]], stop: 0.8 },
  { key: 'v2d20tp14s40', name: 'Dip −20% → TP 1.4X · stop −40%', desc: 'Backtest robust-avg +0.0097, 60% win on 42 real paths.', dip: 0.2, tps: [[1.4, 1]], stop: 0.6 },
  { key: 'v2d20tp175s30', name: 'Dip −20% → TP 1.75X · stop −30%', desc: 'Backtest robust-avg +0.0084, 38% win on 42 real paths.', dip: 0.2, tps: [[1.75, 1]], stop: 0.7 },
  { key: 'v2d30tp14s30', name: 'Dip −30% → TP 1.4X · stop −30%', desc: 'Backtest robust-avg +0.0084, 54% win on 42 real paths.', dip: 0.3, tps: [[1.4, 1]], stop: 0.7 },
  { key: 'v2d10tp15s15', name: 'Dip −10% → TP 1.5X · stop −15%', desc: 'Backtest robust-avg +0.0084, 36% win on 42 real paths.', dip: 0.1, tps: [[1.5, 1]], stop: 0.85 },
  { key: 'v2d30tp15s40', name: 'Dip −30% → TP 1.5X · stop −40%', desc: 'Backtest robust-avg +0.0084, 54% win on 42 real paths.', dip: 0.3, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'v2insttp15s30', name: 'Instant → TP 1.5X · stop −30%', desc: 'Backtest robust-avg +0.0072, 48% win on 42 real paths.', tps: [[1.5, 1]], stop: 0.7 },
  { key: 'v2d15tp15s30', name: 'Dip −15% → TP 1.5X · stop −30%', desc: 'Backtest robust-avg +0.0072, 48% win on 42 real paths.', dip: 0.15, tps: [[1.5, 1]], stop: 0.7 },
  { key: 'v2d20tp13s40', name: 'Dip −20% → TP 1.3X · stop −40%', desc: 'Backtest robust-avg +0.0072, 67% win on 42 real paths.', dip: 0.2, tps: [[1.3, 1]], stop: 0.6 },
  { key: 'v2d25tp12s50', name: 'Dip −25% → TP 1.2X · stop −50%', desc: 'Backtest robust-avg +0.0071, 80% win on 42 real paths.', dip: 0.25, tps: [[1.2, 1]], stop: 0.5 },
  { key: 'v2d10tp14s15', name: 'Dip −10% → TP 1.4X · stop −15%', desc: 'Backtest robust-avg +0.0060, 40% win on 42 real paths.', dip: 0.1, tps: [[1.4, 1]], stop: 0.85 },
  { key: 'v2d30tp13s40', name: 'Dip −30% → TP 1.3X · stop −40%', desc: 'Backtest robust-avg +0.0058, 67% win on 42 real paths.', dip: 0.3, tps: [[1.3, 1]], stop: 0.6 },
  { key: 'v2d10tp14s20', name: 'Dip −10% → TP 1.4X · stop −20%', desc: 'Backtest robust-avg +0.0047, 45% win on 42 real paths.', dip: 0.1, tps: [[1.4, 1]], stop: 0.8 },
];
GRID.push(...GRID2);

// ── Generation 3: structurally NEW mechanics, not parameter tweaks.
// Each family tests a different idea about how these coins behave.
const GRID3: Spec[] = [
  // (a) trail only AFTER a profit threshold — let it breathe first, then protect
  { key: 'g3_armtrail2',  name: 'Dip −20% → arm trail at 2X',    desc: 'No stop management until 2X, then trail 25%.',      dip: .20, tps: [[2, .01]], trail: .25, trailFrom: 'afterLastTp', stop: .6 },
  { key: 'g3_armtrail15', name: 'Dip −20% → arm trail at 1.5X',  desc: 'Trail only once it is up 50%.',                     dip: .20, tps: [[1.5, .01]], trail: .2, trailFrom: 'afterLastTp', stop: .6 },
  { key: 'g3_armtrailin', name: 'Instant → arm trail at 1.5X',   desc: 'Buy the call, protect only after +50%.',                       tps: [[1.5, .01]], trail: .2, trailFrom: 'afterLastTp', stop: .7 },
  // (b) banked-runner: take almost everything early, leave a lottery ticket with no stop
  { key: 'g3_bank95',     name: 'Dip −20% → 95%@1.3X + ticket',  desc: 'Bank 95% fast, let 5% ride free.',                  dip: .20, tps: [[1.3, .95]], stop: .5, be: true },
  { key: 'g3_bank90_15',  name: 'Dip −20% → 90%@1.5X + ticket',  desc: 'Bank 90% at 1.5X, 10% rides.',                      dip: .20, tps: [[1.5, .9]], stop: .5, be: true },
  { key: 'g3_bank80in',   name: 'Instant → 80%@1.3X + ticket',   desc: 'Bank 80% at 1.3X off the call, rest rides.',                  tps: [[1.3, .8]], stop: .6, be: true },
  // (c) time-boxed pullback entries — combine the two winning ideas
  { key: 'g3_dip20h3',    name: 'Dip −20% → hold 3m',            desc: 'Pullback entry, exit at the median peak time.',      dip: .20, hold: 3, stop: .5 },
  { key: 'g3_dip20h7',    name: 'Dip −20% → hold 7m',            desc: 'Pullback entry, 7-minute clock.',                    dip: .20, hold: 7, stop: .5 },
  { key: 'g3_dip20h20',   name: 'Dip −20% → hold 20m',           desc: 'Pullback entry, patient 20-minute clock.',           dip: .20, hold: 20, stop: .5 },
  { key: 'g3_dip25h10',   name: 'Dip −25% → hold 10m',           desc: 'Deeper pullback, 10-minute clock.',                  dip: .25, hold: 10, stop: .5 },
  { key: 'g3_dip20tp15h', name: 'Dip −20% → 1.5X or 8m',         desc: 'Target or clock, whichever lands first.',            dip: .20, hold: 8, tps: [[1.5, 1]], stop: .6 },
  { key: 'g3_dip25tp14h', name: 'Dip −25% → 1.4X or 12m',        desc: 'The robust backtest shape with a time cap.',         dip: .25, hold: 12, tps: [[1.4, 1]], stop: .5 },
  // (d) ultra-scalps — costs are ~3%, so test whether tiny edges survive
  { key: 'g3_dip20tp11',  name: 'Dip −20% → TP 1.1X',            desc: 'Ten percent scalp — barely clears fees.',            dip: .20, tps: [[1.1, 1]], stop: .9 },
  { key: 'g3_dip25tp115', name: 'Dip −25% → TP 1.15X',           desc: 'Tiny target from a deep pullback.',                  dip: .25, tps: [[1.15, 1]], stop: .85 },
  { key: 'g3_dip30tp12',  name: 'Dip −30% → TP 1.2X',            desc: 'Deep flush, small bounce target.',                   dip: .30, tps: [[1.2, 1]], stop: .8 },
  // (e) patient wide-stop hunters — survive the chop, aim high
  { key: 'g3_dip25tp4',   name: 'Dip −25% → TP 4X, stop −60%',   desc: 'Very wide stop, hunting a real runner.',             dip: .25, tps: [[4, 1]], stop: .4 },
  { key: 'g3_dip20tp5',   name: 'Dip −20% → TP 5X, stop −60%',   desc: 'Lottery target with room to breathe.',               dip: .20, tps: [[5, 1]], stop: .4 },
  { key: 'g3_dip30tp3',   name: 'Dip −30% → TP 3X, stop −55%',   desc: 'Deep entry, patient 3X target.',                     dip: .30, tps: [[3, 1]], stop: .45 },
  // (f) pyramid ladders — many small rungs vs few big ones
  { key: 'g3_pyr5',       name: 'Dip −20% → 5-rung ladder',      desc: '20% out at each of 1.2/1.4/1.7/2.2/3X.',             dip: .20, tps: [[1.2, .2], [1.4, .2], [1.7, .2], [2.2, .2], [3, .2]], stop: .6, be: true },
  { key: 'g3_pyr5in',     name: 'Instant → 5-rung ladder',       desc: 'Same ladder, no waiting.',                                    tps: [[1.2, .2], [1.4, .2], [1.7, .2], [2.2, .2], [3, .2]], stop: .6, be: true },
  { key: 'g3_frontload',  name: 'Dip −20% → 60%@1.2X + ladder',  desc: 'Heavy early exit, thin tail rungs.',                 dip: .20, tps: [[1.2, .6], [2, .2], [4, .2]], stop: .6, be: true },
  { key: 'g3_backload',   name: 'Dip −20% → 20%@1.3X + 80%@2.5X',desc: 'Light early, heavy late — the opposite bet.',        dip: .20, tps: [[1.3, .2], [2.5, .8]], stop: .6, be: true },
  // (g) no-stop patience vs tightest-possible stop, same entry — a clean A/B
  { key: 'g3_nostop14',   name: 'Dip −20% → 1.4X, no stop',      desc: 'Never cut, wait for 1.4X.',                          dip: .20, tps: [[1.4, 1]], stop: .02 },
  { key: 'g3_tight14',    name: 'Dip −20% → 1.4X, stop −8%',     desc: 'Same target, brutally tight stop.',                  dip: .20, tps: [[1.4, 1]], stop: .92 },
];
GRID.push(...GRID3);

// ── Generation 4: broad systematic coverage of the strategy space.
// Stratified across 8 mechanic families x 14 entry timings so no region is
// unexplored. With this many strategies the top of any leaderboard is luck —
// read the verdict badges (t-stat + robust average), not the raw ranking.
const GRID4: Spec[] = [
  { key: 'g4_it11s10', name: 'Instant → TP 1.1X, stop −10%', desc: 'Fixed 1.1× target from a call-price entry with a stop −10%.', tps: [[1.1, 1]], stop: 0.9 },
  { key: 'g4_it115s20', name: 'Instant → TP 1.15X, stop −20%', desc: 'Fixed 1.15× target from a call-price entry with a stop −20%.', tps: [[1.15, 1]], stop: 0.8 },
  { key: 'g4_it13s10', name: 'Instant → TP 1.3X, stop −10%', desc: 'Fixed 1.3× target from a call-price entry with a stop −10%.', tps: [[1.3, 1]], stop: 0.9 },
  { key: 'g4_it14s40', name: 'Instant → TP 1.4X, stop −40%', desc: 'Fixed 1.4× target from a call-price entry with a stop −40%.', tps: [[1.4, 1]], stop: 0.6 },
  { key: 'g4_it15s40', name: 'Instant → TP 1.5X, stop −40%', desc: 'Fixed 1.5× target from a call-price entry with a stop −40%.', tps: [[1.5, 1]], stop: 0.6 },
  { key: 'g4_it175s50', name: 'Instant → TP 1.75X, stop −50%', desc: 'Fixed 1.75× target from a call-price entry with a stop −50%.', tps: [[1.75, 1]], stop: 0.5 },
  { key: 'g4_it25s40', name: 'Instant → TP 2.5X, stop −40%', desc: 'Fixed 2.5× target from a call-price entry with a stop −40%.', tps: [[2.5, 1]], stop: 0.6 },
  { key: 'g4_it3s50', name: 'Instant → TP 3X, stop −50%', desc: 'Fixed 3× target from a call-price entry with a stop −50%.', tps: [[3, 1]], stop: 0.5 },
  { key: 'g4_it4s50', name: 'Instant → TP 4X, stop −50%', desc: 'Fixed 4× target from a call-price entry with a stop −50%.', tps: [[4, 1]], stop: 0.5 },
  { key: 'g4_d5t11s30', name: 'Dip −5% → TP 1.1X, stop −30%', desc: 'Fixed 1.1× target from a 5% pullback entry with a stop −30%.', dip: 0.05, tps: [[1.1, 1]], stop: 0.7 },
  { key: 'g4_d5t12s20', name: 'Dip −5% → TP 1.2X, stop −20%', desc: 'Fixed 1.2× target from a 5% pullback entry with a stop −20%.', dip: 0.05, tps: [[1.2, 1]], stop: 0.8 },
  { key: 'g4_d5t14s20', name: 'Dip −5% → TP 1.4X, stop −20%', desc: 'Fixed 1.4× target from a 5% pullback entry with a stop −20%.', dip: 0.05, tps: [[1.4, 1]], stop: 0.8 },
  { key: 'g4_d5t15s20', name: 'Dip −5% → TP 1.5X, stop −20%', desc: 'Fixed 1.5× target from a 5% pullback entry with a stop −20%.', dip: 0.05, tps: [[1.5, 1]], stop: 0.8 },
  { key: 'g4_d5t175s30', name: 'Dip −5% → TP 1.75X, stop −30%', desc: 'Fixed 1.75× target from a 5% pullback entry with a stop −30%.', dip: 0.05, tps: [[1.75, 1]], stop: 0.7 },
  { key: 'g4_d5t2s40', name: 'Dip −5% → TP 2X, stop −40%', desc: 'Fixed 2× target from a 5% pullback entry with a stop −40%.', dip: 0.05, tps: [[2, 1]], stop: 0.6 },
  { key: 'g4_d5t25s98', name: 'Dip −5% → TP 2.5X, no stop', desc: 'Fixed 2.5× target from a 5% pullback entry with a no stop.', dip: 0.05, tps: [[2.5, 1]], stop: 0.02 },
  { key: 'g4_d5t3s98', name: 'Dip −5% → TP 3X, no stop', desc: 'Fixed 3× target from a 5% pullback entry with a no stop.', dip: 0.05, tps: [[3, 1]], stop: 0.02 },
  { key: 'g4_d8t11s10', name: 'Dip −8% → TP 1.1X, stop −10%', desc: 'Fixed 1.1× target from a 8% pullback entry with a stop −10%.', dip: 0.08, tps: [[1.1, 1]], stop: 0.9 },
  { key: 'g4_d8t115s30', name: 'Dip −8% → TP 1.15X, stop −30%', desc: 'Fixed 1.15× target from a 8% pullback entry with a stop −30%.', dip: 0.08, tps: [[1.15, 1]], stop: 0.7 },
  { key: 'g4_d8t13s20', name: 'Dip −8% → TP 1.3X, stop −20%', desc: 'Fixed 1.3× target from a 8% pullback entry with a stop −20%.', dip: 0.08, tps: [[1.3, 1]], stop: 0.8 },
  { key: 'g4_d8t14s40', name: 'Dip −8% → TP 1.4X, stop −40%', desc: 'Fixed 1.4× target from a 8% pullback entry with a stop −40%.', dip: 0.08, tps: [[1.4, 1]], stop: 0.6 },
  { key: 'g4_d8t15s50', name: 'Dip −8% → TP 1.5X, stop −50%', desc: 'Fixed 1.5× target from a 8% pullback entry with a stop −50%.', dip: 0.08, tps: [[1.5, 1]], stop: 0.5 },
  { key: 'g4_d8t2s20', name: 'Dip −8% → TP 2X, stop −20%', desc: 'Fixed 2× target from a 8% pullback entry with a stop −20%.', dip: 0.08, tps: [[2, 1]], stop: 0.8 },
  { key: 'g4_d8t25s50', name: 'Dip −8% → TP 2.5X, stop −50%', desc: 'Fixed 2.5× target from a 8% pullback entry with a stop −50%.', dip: 0.08, tps: [[2.5, 1]], stop: 0.5 },
  { key: 'g4_d8t3s50', name: 'Dip −8% → TP 3X, stop −50%', desc: 'Fixed 3× target from a 8% pullback entry with a stop −50%.', dip: 0.08, tps: [[3, 1]], stop: 0.5 },
  { key: 'g4_d8t4s60', name: 'Dip −8% → TP 4X, stop −60%', desc: 'Fixed 4× target from a 8% pullback entry with a stop −60%.', dip: 0.08, tps: [[4, 1]], stop: 0.4 },
  { key: 'g4_d10t115s10', name: 'Dip −10% → TP 1.15X, stop −10%', desc: 'Fixed 1.15× target from a 10% pullback entry with a stop −10%.', dip: 0.1, tps: [[1.15, 1]], stop: 0.9 },
  { key: 'g4_d10t12s30', name: 'Dip −10% → TP 1.2X, stop −30%', desc: 'Fixed 1.2× target from a 10% pullback entry with a stop −30%.', dip: 0.1, tps: [[1.2, 1]], stop: 0.7 },
  { key: 'g4_d10t14s20', name: 'Dip −10% → TP 1.4X, stop −20%', desc: 'Fixed 1.4× target from a 10% pullback entry with a stop −20%.', dip: 0.1, tps: [[1.4, 1]], stop: 0.8 },
  { key: 'g4_d10t15s30', name: 'Dip −10% → TP 1.5X, stop −30%', desc: 'Fixed 1.5× target from a 10% pullback entry with a stop −30%.', dip: 0.1, tps: [[1.5, 1]], stop: 0.7 },
  { key: 'g4_d10t175s40', name: 'Dip −10% → TP 1.75X, stop −40%', desc: 'Fixed 1.75× target from a 10% pullback entry with a stop −40%.', dip: 0.1, tps: [[1.75, 1]], stop: 0.6 },
  { key: 'g4_d10t2s50', name: 'Dip −10% → TP 2X, stop −50%', desc: 'Fixed 2× target from a 10% pullback entry with a stop −50%.', dip: 0.1, tps: [[2, 1]], stop: 0.5 },
  { key: 'g4_d10t25s98', name: 'Dip −10% → TP 2.5X, no stop', desc: 'Fixed 2.5× target from a 10% pullback entry with a no stop.', dip: 0.1, tps: [[2.5, 1]], stop: 0.02 },
  { key: 'g4_d10t4s40', name: 'Dip −10% → TP 4X, stop −40%', desc: 'Fixed 4× target from a 10% pullback entry with a stop −40%.', dip: 0.1, tps: [[4, 1]], stop: 0.6 },
  { key: 'g4_d12t11s20', name: 'Dip −12% → TP 1.1X, stop −20%', desc: 'Fixed 1.1× target from a 12% pullback entry with a stop −20%.', dip: 0.12, tps: [[1.1, 1]], stop: 0.8 },
  { key: 'g4_d12t12s10', name: 'Dip −12% → TP 1.2X, stop −10%', desc: 'Fixed 1.2× target from a 12% pullback entry with a stop −10%.', dip: 0.12, tps: [[1.2, 1]], stop: 0.9 },
  { key: 'g4_d12t13s20', name: 'Dip −12% → TP 1.3X, stop −20%', desc: 'Fixed 1.3× target from a 12% pullback entry with a stop −20%.', dip: 0.12, tps: [[1.3, 1]], stop: 0.8 },
  { key: 'g4_d12t14s50', name: 'Dip −12% → TP 1.4X, stop −50%', desc: 'Fixed 1.4× target from a 12% pullback entry with a stop −50%.', dip: 0.12, tps: [[1.4, 1]], stop: 0.5 },
  { key: 'g4_d12t175s20', name: 'Dip −12% → TP 1.75X, stop −20%', desc: 'Fixed 1.75× target from a 12% pullback entry with a stop −20%.', dip: 0.12, tps: [[1.75, 1]], stop: 0.8 },
  { key: 'g4_d12t2s30', name: 'Dip −12% → TP 2X, stop −30%', desc: 'Fixed 2× target from a 12% pullback entry with a stop −30%.', dip: 0.12, tps: [[2, 1]], stop: 0.7 },
  { key: 'g4_d12t25s50', name: 'Dip −12% → TP 2.5X, stop −50%', desc: 'Fixed 2.5× target from a 12% pullback entry with a stop −50%.', dip: 0.12, tps: [[2.5, 1]], stop: 0.5 },
  { key: 'g4_d12t3s60', name: 'Dip −12% → TP 3X, stop −60%', desc: 'Fixed 3× target from a 12% pullback entry with a stop −60%.', dip: 0.12, tps: [[3, 1]], stop: 0.4 },
  { key: 'g4_d12t4s98', name: 'Dip −12% → TP 4X, no stop', desc: 'Fixed 4× target from a 12% pullback entry with a no stop.', dip: 0.12, tps: [[4, 1]], stop: 0.02 },
  { key: 'g4_d15t115s20', name: 'Dip −15% → TP 1.15X, stop −20%', desc: 'Fixed 1.15× target from a 15% pullback entry with a stop −20%.', dip: 0.15, tps: [[1.15, 1]], stop: 0.8 },
  { key: 'g4_d15t12s30', name: 'Dip −15% → TP 1.2X, stop −30%', desc: 'Fixed 1.2× target from a 15% pullback entry with a stop −30%.', dip: 0.15, tps: [[1.2, 1]], stop: 0.7 },
  { key: 'g4_d15t14s30', name: 'Dip −15% → TP 1.4X, stop −30%', desc: 'Fixed 1.4× target from a 15% pullback entry with a stop −30%.', dip: 0.15, tps: [[1.4, 1]], stop: 0.7 },
  { key: 'g4_d15t15s40', name: 'Dip −15% → TP 1.5X, stop −40%', desc: 'Fixed 1.5× target from a 15% pullback entry with a stop −40%.', dip: 0.15, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'g4_d15t175s50', name: 'Dip −15% → TP 1.75X, stop −50%', desc: 'Fixed 1.75× target from a 15% pullback entry with a stop −50%.', dip: 0.15, tps: [[1.75, 1]], stop: 0.5 },
  { key: 'g4_d15t2s50', name: 'Dip −15% → TP 2X, stop −50%', desc: 'Fixed 2× target from a 15% pullback entry with a stop −50%.', dip: 0.15, tps: [[2, 1]], stop: 0.5 },
  { key: 'g4_d15t3s40', name: 'Dip −15% → TP 3X, stop −40%', desc: 'Fixed 3× target from a 15% pullback entry with a stop −40%.', dip: 0.15, tps: [[3, 1]], stop: 0.6 },
  { key: 'g4_d15t4s50', name: 'Dip −15% → TP 4X, stop −50%', desc: 'Fixed 4× target from a 15% pullback entry with a stop −50%.', dip: 0.15, tps: [[4, 1]], stop: 0.5 },
  { key: 'g4_d18t11s30', name: 'Dip −18% → TP 1.1X, stop −30%', desc: 'Fixed 1.1× target from a 18% pullback entry with a stop −30%.', dip: 0.18, tps: [[1.1, 1]], stop: 0.7 },
  { key: 'g4_d18t12s10', name: 'Dip −18% → TP 1.2X, stop −10%', desc: 'Fixed 1.2× target from a 18% pullback entry with a stop −10%.', dip: 0.18, tps: [[1.2, 1]], stop: 0.9 },
  { key: 'g4_d18t13s30', name: 'Dip −18% → TP 1.3X, stop −30%', desc: 'Fixed 1.3× target from a 18% pullback entry with a stop −30%.', dip: 0.18, tps: [[1.3, 1]], stop: 0.7 },
  { key: 'g4_d18t15s20', name: 'Dip −18% → TP 1.5X, stop −20%', desc: 'Fixed 1.5× target from a 18% pullback entry with a stop −20%.', dip: 0.18, tps: [[1.5, 1]], stop: 0.8 },
  { key: 'g4_d18t175s30', name: 'Dip −18% → TP 1.75X, stop −30%', desc: 'Fixed 1.75× target from a 18% pullback entry with a stop −30%.', dip: 0.18, tps: [[1.75, 1]], stop: 0.7 },
  { key: 'g4_d18t2s30', name: 'Dip −18% → TP 2X, stop −30%', desc: 'Fixed 2× target from a 18% pullback entry with a stop −30%.', dip: 0.18, tps: [[2, 1]], stop: 0.7 },
  { key: 'g4_d18t25s60', name: 'Dip −18% → TP 2.5X, stop −60%', desc: 'Fixed 2.5× target from a 18% pullback entry with a stop −60%.', dip: 0.18, tps: [[2.5, 1]], stop: 0.4 },
  { key: 'g4_d18t3s98', name: 'Dip −18% → TP 3X, no stop', desc: 'Fixed 3× target from a 18% pullback entry with a no stop.', dip: 0.18, tps: [[3, 1]], stop: 0.02 },
  { key: 'g4_d20t11s10', name: 'Dip −20% → TP 1.1X, stop −10%', desc: 'Fixed 1.1× target from a 20% pullback entry with a stop −10%.', dip: 0.2, tps: [[1.1, 1]], stop: 0.9 },
  { key: 'g4_d20t115s20', name: 'Dip −20% → TP 1.15X, stop −20%', desc: 'Fixed 1.15× target from a 20% pullback entry with a stop −20%.', dip: 0.2, tps: [[1.15, 1]], stop: 0.8 },
  { key: 'g4_d20t13s10', name: 'Dip −20% → TP 1.3X, stop −10%', desc: 'Fixed 1.3× target from a 20% pullback entry with a stop −10%.', dip: 0.2, tps: [[1.3, 1]], stop: 0.9 },
  { key: 'g4_d20t14s40', name: 'Dip −20% → TP 1.4X, stop −40%', desc: 'Fixed 1.4× target from a 20% pullback entry with a stop −40%.', dip: 0.2, tps: [[1.4, 1]], stop: 0.6 },
  { key: 'g4_d20t15s40', name: 'Dip −20% → TP 1.5X, stop −40%', desc: 'Fixed 1.5× target from a 20% pullback entry with a stop −40%.', dip: 0.2, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'g4_d20t175s50', name: 'Dip −20% → TP 1.75X, stop −50%', desc: 'Fixed 1.75× target from a 20% pullback entry with a stop −50%.', dip: 0.2, tps: [[1.75, 1]], stop: 0.5 },
  { key: 'g4_d20t25s40', name: 'Dip −20% → TP 2.5X, stop −40%', desc: 'Fixed 2.5× target from a 20% pullback entry with a stop −40%.', dip: 0.2, tps: [[2.5, 1]], stop: 0.6 },
  { key: 'g4_d20t3s50', name: 'Dip −20% → TP 3X, stop −50%', desc: 'Fixed 3× target from a 20% pullback entry with a stop −50%.', dip: 0.2, tps: [[3, 1]], stop: 0.5 },
  { key: 'g4_d20t4s50', name: 'Dip −20% → TP 4X, stop −50%', desc: 'Fixed 4× target from a 20% pullback entry with a stop −50%.', dip: 0.2, tps: [[4, 1]], stop: 0.5 },
  { key: 'g4_d22t11s30', name: 'Dip −22% → TP 1.1X, stop −30%', desc: 'Fixed 1.1× target from a 22% pullback entry with a stop −30%.', dip: 0.22, tps: [[1.1, 1]], stop: 0.7 },
  { key: 'g4_d22t12s20', name: 'Dip −22% → TP 1.2X, stop −20%', desc: 'Fixed 1.2× target from a 22% pullback entry with a stop −20%.', dip: 0.22, tps: [[1.2, 1]], stop: 0.8 },
  { key: 'g4_d22t14s20', name: 'Dip −22% → TP 1.4X, stop −20%', desc: 'Fixed 1.4× target from a 22% pullback entry with a stop −20%.', dip: 0.22, tps: [[1.4, 1]], stop: 0.8 },
  { key: 'g4_d22t15s20', name: 'Dip −22% → TP 1.5X, stop −20%', desc: 'Fixed 1.5× target from a 22% pullback entry with a stop −20%.', dip: 0.22, tps: [[1.5, 1]], stop: 0.8 },
  { key: 'g4_d22t175s30', name: 'Dip −22% → TP 1.75X, stop −30%', desc: 'Fixed 1.75× target from a 22% pullback entry with a stop −30%.', dip: 0.22, tps: [[1.75, 1]], stop: 0.7 },
  { key: 'g4_d22t2s40', name: 'Dip −22% → TP 2X, stop −40%', desc: 'Fixed 2× target from a 22% pullback entry with a stop −40%.', dip: 0.22, tps: [[2, 1]], stop: 0.6 },
  { key: 'g4_d22t25s98', name: 'Dip −22% → TP 2.5X, no stop', desc: 'Fixed 2.5× target from a 22% pullback entry with a no stop.', dip: 0.22, tps: [[2.5, 1]], stop: 0.02 },
  { key: 'g4_d22t3s98', name: 'Dip −22% → TP 3X, no stop', desc: 'Fixed 3× target from a 22% pullback entry with a no stop.', dip: 0.22, tps: [[3, 1]], stop: 0.02 },
  { key: 'g4_d25t11s10', name: 'Dip −25% → TP 1.1X, stop −10%', desc: 'Fixed 1.1× target from a 25% pullback entry with a stop −10%.', dip: 0.25, tps: [[1.1, 1]], stop: 0.9 },
  { key: 'g4_d25t115s30', name: 'Dip −25% → TP 1.15X, stop −30%', desc: 'Fixed 1.15× target from a 25% pullback entry with a stop −30%.', dip: 0.25, tps: [[1.15, 1]], stop: 0.7 },
  { key: 'g4_d25t13s20', name: 'Dip −25% → TP 1.3X, stop −20%', desc: 'Fixed 1.3× target from a 25% pullback entry with a stop −20%.', dip: 0.25, tps: [[1.3, 1]], stop: 0.8 },
  { key: 'g4_d25t14s40', name: 'Dip −25% → TP 1.4X, stop −40%', desc: 'Fixed 1.4× target from a 25% pullback entry with a stop −40%.', dip: 0.25, tps: [[1.4, 1]], stop: 0.6 },
  { key: 'g4_d25t15s50', name: 'Dip −25% → TP 1.5X, stop −50%', desc: 'Fixed 1.5× target from a 25% pullback entry with a stop −50%.', dip: 0.25, tps: [[1.5, 1]], stop: 0.5 },
  { key: 'g4_d25t2s20', name: 'Dip −25% → TP 2X, stop −20%', desc: 'Fixed 2× target from a 25% pullback entry with a stop −20%.', dip: 0.25, tps: [[2, 1]], stop: 0.8 },
  { key: 'g4_d25t25s50', name: 'Dip −25% → TP 2.5X, stop −50%', desc: 'Fixed 2.5× target from a 25% pullback entry with a stop −50%.', dip: 0.25, tps: [[2.5, 1]], stop: 0.5 },
  { key: 'g4_d25t3s50', name: 'Dip −25% → TP 3X, stop −50%', desc: 'Fixed 3× target from a 25% pullback entry with a stop −50%.', dip: 0.25, tps: [[3, 1]], stop: 0.5 },
  { key: 'g4_d25t4s60', name: 'Dip −25% → TP 4X, stop −60%', desc: 'Fixed 4× target from a 25% pullback entry with a stop −60%.', dip: 0.25, tps: [[4, 1]], stop: 0.4 },
  { key: 'g4_d28t115s10', name: 'Dip −28% → TP 1.15X, stop −10%', desc: 'Fixed 1.15× target from a 28% pullback entry with a stop −10%.', dip: 0.28, tps: [[1.15, 1]], stop: 0.9 },
  { key: 'g4_d28t12s30', name: 'Dip −28% → TP 1.2X, stop −30%', desc: 'Fixed 1.2× target from a 28% pullback entry with a stop −30%.', dip: 0.28, tps: [[1.2, 1]], stop: 0.7 },
  { key: 'g4_d28t14s20', name: 'Dip −28% → TP 1.4X, stop −20%', desc: 'Fixed 1.4× target from a 28% pullback entry with a stop −20%.', dip: 0.28, tps: [[1.4, 1]], stop: 0.8 },
  { key: 'g4_d28t15s30', name: 'Dip −28% → TP 1.5X, stop −30%', desc: 'Fixed 1.5× target from a 28% pullback entry with a stop −30%.', dip: 0.28, tps: [[1.5, 1]], stop: 0.7 },
  { key: 'g4_d28t175s40', name: 'Dip −28% → TP 1.75X, stop −40%', desc: 'Fixed 1.75× target from a 28% pullback entry with a stop −40%.', dip: 0.28, tps: [[1.75, 1]], stop: 0.6 },
  { key: 'g4_d28t2s50', name: 'Dip −28% → TP 2X, stop −50%', desc: 'Fixed 2× target from a 28% pullback entry with a stop −50%.', dip: 0.28, tps: [[2, 1]], stop: 0.5 },
  { key: 'g4_d28t25s98', name: 'Dip −28% → TP 2.5X, no stop', desc: 'Fixed 2.5× target from a 28% pullback entry with a no stop.', dip: 0.28, tps: [[2.5, 1]], stop: 0.02 },
  { key: 'g4_d28t4s40', name: 'Dip −28% → TP 4X, stop −40%', desc: 'Fixed 4× target from a 28% pullback entry with a stop −40%.', dip: 0.28, tps: [[4, 1]], stop: 0.6 },
  { key: 'g4_d30t11s20', name: 'Dip −30% → TP 1.1X, stop −20%', desc: 'Fixed 1.1× target from a 30% pullback entry with a stop −20%.', dip: 0.3, tps: [[1.1, 1]], stop: 0.8 },
  { key: 'g4_d30t12s10', name: 'Dip −30% → TP 1.2X, stop −10%', desc: 'Fixed 1.2× target from a 30% pullback entry with a stop −10%.', dip: 0.3, tps: [[1.2, 1]], stop: 0.9 },
  { key: 'g4_d30t13s20', name: 'Dip −30% → TP 1.3X, stop −20%', desc: 'Fixed 1.3× target from a 30% pullback entry with a stop −20%.', dip: 0.3, tps: [[1.3, 1]], stop: 0.8 },
  { key: 'g4_d30t14s50', name: 'Dip −30% → TP 1.4X, stop −50%', desc: 'Fixed 1.4× target from a 30% pullback entry with a stop −50%.', dip: 0.3, tps: [[1.4, 1]], stop: 0.5 },
  { key: 'g4_d30t175s20', name: 'Dip −30% → TP 1.75X, stop −20%', desc: 'Fixed 1.75× target from a 30% pullback entry with a stop −20%.', dip: 0.3, tps: [[1.75, 1]], stop: 0.8 },
  { key: 'g4_d30t2s30', name: 'Dip −30% → TP 2X, stop −30%', desc: 'Fixed 2× target from a 30% pullback entry with a stop −30%.', dip: 0.3, tps: [[2, 1]], stop: 0.7 },
  { key: 'g4_d30t25s50', name: 'Dip −30% → TP 2.5X, stop −50%', desc: 'Fixed 2.5× target from a 30% pullback entry with a stop −50%.', dip: 0.3, tps: [[2.5, 1]], stop: 0.5 },
  { key: 'g4_d30t3s60', name: 'Dip −30% → TP 3X, stop −60%', desc: 'Fixed 3× target from a 30% pullback entry with a stop −60%.', dip: 0.3, tps: [[3, 1]], stop: 0.4 },
  { key: 'g4_d30t4s98', name: 'Dip −30% → TP 4X, no stop', desc: 'Fixed 4× target from a 30% pullback entry with a no stop.', dip: 0.3, tps: [[4, 1]], stop: 0.02 },
  { key: 'g4_d35t115s20', name: 'Dip −35% → TP 1.15X, stop −20%', desc: 'Fixed 1.15× target from a 35% pullback entry with a stop −20%.', dip: 0.35, tps: [[1.15, 1]], stop: 0.8 },
  { key: 'g4_d35t12s30', name: 'Dip −35% → TP 1.2X, stop −30%', desc: 'Fixed 1.2× target from a 35% pullback entry with a stop −30%.', dip: 0.35, tps: [[1.2, 1]], stop: 0.7 },
  { key: 'g4_d35t14s30', name: 'Dip −35% → TP 1.4X, stop −30%', desc: 'Fixed 1.4× target from a 35% pullback entry with a stop −30%.', dip: 0.35, tps: [[1.4, 1]], stop: 0.7 },
  { key: 'g4_d35t15s40', name: 'Dip −35% → TP 1.5X, stop −40%', desc: 'Fixed 1.5× target from a 35% pullback entry with a stop −40%.', dip: 0.35, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'g4_d35t175s50', name: 'Dip −35% → TP 1.75X, stop −50%', desc: 'Fixed 1.75× target from a 35% pullback entry with a stop −50%.', dip: 0.35, tps: [[1.75, 1]], stop: 0.5 },
  { key: 'g4_d35t2s50', name: 'Dip −35% → TP 2X, stop −50%', desc: 'Fixed 2× target from a 35% pullback entry with a stop −50%.', dip: 0.35, tps: [[2, 1]], stop: 0.5 },
  { key: 'g4_d35t3s40', name: 'Dip −35% → TP 3X, stop −40%', desc: 'Fixed 3× target from a 35% pullback entry with a stop −40%.', dip: 0.35, tps: [[3, 1]], stop: 0.6 },
  { key: 'g4_d35t4s50', name: 'Dip −35% → TP 4X, stop −50%', desc: 'Fixed 4× target from a 35% pullback entry with a stop −50%.', dip: 0.35, tps: [[4, 1]], stop: 0.5 },
  { key: 'g4_d40t11s30', name: 'Dip −40% → TP 1.1X, stop −30%', desc: 'Fixed 1.1× target from a 40% pullback entry with a stop −30%.', dip: 0.4, tps: [[1.1, 1]], stop: 0.7 },
  { key: 'g4_d40t12s10', name: 'Dip −40% → TP 1.2X, stop −10%', desc: 'Fixed 1.2× target from a 40% pullback entry with a stop −10%.', dip: 0.4, tps: [[1.2, 1]], stop: 0.9 },
  { key: 'g4_d40t13s30', name: 'Dip −40% → TP 1.3X, stop −30%', desc: 'Fixed 1.3× target from a 40% pullback entry with a stop −30%.', dip: 0.4, tps: [[1.3, 1]], stop: 0.7 },
  { key: 'g4_d40t15s20', name: 'Dip −40% → TP 1.5X, stop −20%', desc: 'Fixed 1.5× target from a 40% pullback entry with a stop −20%.', dip: 0.4, tps: [[1.5, 1]], stop: 0.8 },
  { key: 'g4_d40t175s30', name: 'Dip −40% → TP 1.75X, stop −30%', desc: 'Fixed 1.75× target from a 40% pullback entry with a stop −30%.', dip: 0.4, tps: [[1.75, 1]], stop: 0.7 },
  { key: 'g4_d40t2s30', name: 'Dip −40% → TP 2X, stop −30%', desc: 'Fixed 2× target from a 40% pullback entry with a stop −30%.', dip: 0.4, tps: [[2, 1]], stop: 0.7 },
  { key: 'g4_d40t25s60', name: 'Dip −40% → TP 2.5X, stop −60%', desc: 'Fixed 2.5× target from a 40% pullback entry with a stop −60%.', dip: 0.4, tps: [[2.5, 1]], stop: 0.4 },
  { key: 'g4_d40t3s98', name: 'Dip −40% → TP 3X, no stop', desc: 'Fixed 3× target from a 40% pullback entry with a no stop.', dip: 0.4, tps: [[3, 1]], stop: 0.02 },
  { key: 'g4_itr10', name: 'Instant → trail 10%', desc: 'Pure trailing stop 10% below the high, no fixed target.', trail: 0.1, trailFrom: 'entry', stop: 0.9 },
  { key: 'g4_itr30', name: 'Instant → trail 30%', desc: 'Pure trailing stop 30% below the high, no fixed target.', trail: 0.3, trailFrom: 'entry', stop: 0.7 },
  { key: 'g4_d5tr20', name: 'Dip −5% → trail 20%', desc: 'Pure trailing stop 20% below the high, no fixed target.', dip: 0.05, trail: 0.2, trailFrom: 'entry', stop: 0.8 },
  { key: 'g4_d8tr10', name: 'Dip −8% → trail 10%', desc: 'Pure trailing stop 10% below the high, no fixed target.', dip: 0.08, trail: 0.1, trailFrom: 'entry', stop: 0.9 },
  { key: 'g4_d8tr40', name: 'Dip −8% → trail 40%', desc: 'Pure trailing stop 40% below the high, no fixed target.', dip: 0.08, trail: 0.4, trailFrom: 'entry', stop: 0.6 },
  { key: 'g4_d10tr25', name: 'Dip −10% → trail 25%', desc: 'Pure trailing stop 25% below the high, no fixed target.', dip: 0.1, trail: 0.25, trailFrom: 'entry', stop: 0.75 },
  { key: 'g4_d12tr15', name: 'Dip −12% → trail 15%', desc: 'Pure trailing stop 15% below the high, no fixed target.', dip: 0.12, trail: 0.15, trailFrom: 'entry', stop: 0.85 },
  { key: 'g4_d12tr50', name: 'Dip −12% → trail 50%', desc: 'Pure trailing stop 50% below the high, no fixed target.', dip: 0.12, trail: 0.5, trailFrom: 'entry', stop: 0.5 },
  { key: 'g4_d15tr25', name: 'Dip −15% → trail 25%', desc: 'Pure trailing stop 25% below the high, no fixed target.', dip: 0.15, trail: 0.25, trailFrom: 'entry', stop: 0.75 },
  { key: 'g4_d18tr15', name: 'Dip −18% → trail 15%', desc: 'Pure trailing stop 15% below the high, no fixed target.', dip: 0.18, trail: 0.15, trailFrom: 'entry', stop: 0.85 },
  { key: 'g4_d18tr50', name: 'Dip −18% → trail 50%', desc: 'Pure trailing stop 50% below the high, no fixed target.', dip: 0.18, trail: 0.5, trailFrom: 'entry', stop: 0.5 },
  { key: 'g4_d20tr30', name: 'Dip −20% → trail 30%', desc: 'Pure trailing stop 30% below the high, no fixed target.', dip: 0.2, trail: 0.3, trailFrom: 'entry', stop: 0.7 },
  { key: 'g4_d22tr20', name: 'Dip −22% → trail 20%', desc: 'Pure trailing stop 20% below the high, no fixed target.', dip: 0.22, trail: 0.2, trailFrom: 'entry', stop: 0.8 },
  { key: 'g4_d25tr10', name: 'Dip −25% → trail 10%', desc: 'Pure trailing stop 10% below the high, no fixed target.', dip: 0.25, trail: 0.1, trailFrom: 'entry', stop: 0.9 },
  { key: 'g4_d25tr40', name: 'Dip −25% → trail 40%', desc: 'Pure trailing stop 40% below the high, no fixed target.', dip: 0.25, trail: 0.4, trailFrom: 'entry', stop: 0.6 },
  { key: 'g4_d28tr20', name: 'Dip −28% → trail 20%', desc: 'Pure trailing stop 20% below the high, no fixed target.', dip: 0.28, trail: 0.2, trailFrom: 'entry', stop: 0.8 },
  { key: 'g4_d30tr10', name: 'Dip −30% → trail 10%', desc: 'Pure trailing stop 10% below the high, no fixed target.', dip: 0.3, trail: 0.1, trailFrom: 'entry', stop: 0.9 },
  { key: 'g4_d30tr40', name: 'Dip −30% → trail 40%', desc: 'Pure trailing stop 40% below the high, no fixed target.', dip: 0.3, trail: 0.4, trailFrom: 'entry', stop: 0.6 },
  { key: 'g4_d35tr25', name: 'Dip −35% → trail 25%', desc: 'Pure trailing stop 25% below the high, no fixed target.', dip: 0.35, trail: 0.25, trailFrom: 'entry', stop: 0.75 },
  { key: 'g4_d40tr15', name: 'Dip −40% → trail 15%', desc: 'Pure trailing stop 15% below the high, no fixed target.', dip: 0.4, trail: 0.15, trailFrom: 'entry', stop: 0.85 },
  { key: 'g4_d40tr50', name: 'Dip −40% → trail 50%', desc: 'Pure trailing stop 50% below the high, no fixed target.', dip: 0.4, trail: 0.5, trailFrom: 'entry', stop: 0.5 },
  { key: 'g4_iarm15tr25', name: 'Instant → arm 25% trail at 1.5X', desc: 'Hold through noise, then trail 25% once it reaches 1.5×.', tps: [[1.5, 0.01]], trail: 0.25, trailFrom: 'afterLastTp', stop: 0.6 },
  { key: 'g4_iarm3tr15', name: 'Instant → arm 15% trail at 3X', desc: 'Hold through noise, then trail 15% once it reaches 3×.', tps: [[3, 0.01]], trail: 0.15, trailFrom: 'afterLastTp', stop: 0.6 },
  { key: 'g4_d15arm13tr25', name: 'Dip −15% → arm 25% trail at 1.3X', desc: 'Hold through noise, then trail 25% once it reaches 1.3×.', dip: 0.15, tps: [[1.3, 0.01]], trail: 0.25, trailFrom: 'afterLastTp', stop: 0.6 },
  { key: 'g4_d15arm2tr15', name: 'Dip −15% → arm 15% trail at 2X', desc: 'Hold through noise, then trail 15% once it reaches 2×.', dip: 0.15, tps: [[2, 0.01]], trail: 0.15, trailFrom: 'afterLastTp', stop: 0.6 },
  { key: 'g4_d15arm3tr35', name: 'Dip −15% → arm 35% trail at 3X', desc: 'Hold through noise, then trail 35% once it reaches 3×.', dip: 0.15, tps: [[3, 0.01]], trail: 0.35, trailFrom: 'afterLastTp', stop: 0.6 },
  { key: 'g4_d20arm15tr25', name: 'Dip −20% → arm 25% trail at 1.5X', desc: 'Hold through noise, then trail 25% once it reaches 1.5×.', dip: 0.2, tps: [[1.5, 0.01]], trail: 0.25, trailFrom: 'afterLastTp', stop: 0.6 },
  { key: 'g4_d20arm3tr15', name: 'Dip −20% → arm 15% trail at 3X', desc: 'Hold through noise, then trail 15% once it reaches 3×.', dip: 0.2, tps: [[3, 0.01]], trail: 0.15, trailFrom: 'afterLastTp', stop: 0.6 },
  { key: 'g4_d25arm13tr35', name: 'Dip −25% → arm 35% trail at 1.3X', desc: 'Hold through noise, then trail 35% once it reaches 1.3×.', dip: 0.25, tps: [[1.3, 0.01]], trail: 0.35, trailFrom: 'afterLastTp', stop: 0.6 },
  { key: 'g4_d25arm2tr25', name: 'Dip −25% → arm 25% trail at 2X', desc: 'Hold through noise, then trail 25% once it reaches 2×.', dip: 0.25, tps: [[2, 0.01]], trail: 0.25, trailFrom: 'afterLastTp', stop: 0.6 },
  { key: 'g4_ih2', name: 'Instant → hold 2m', desc: 'Exit everything after 2 minutes regardless of price.', hold: 2, stop: 0.5 },
  { key: 'g4_ih8', name: 'Instant → hold 8m', desc: 'Exit everything after 8 minutes regardless of price.', hold: 8, stop: 0.5 },
  { key: 'g4_ih30', name: 'Instant → hold 30m', desc: 'Exit everything after 30 minutes regardless of price.', hold: 30, stop: 0.5 },
  { key: 'g4_d5h3', name: 'Dip −5% → hold 3m', desc: 'Exit everything after 3 minutes regardless of price.', dip: 0.05, hold: 3, stop: 0.5 },
  { key: 'g4_d5h12', name: 'Dip −5% → hold 12m', desc: 'Exit everything after 12 minutes regardless of price.', dip: 0.05, hold: 12, stop: 0.5 },
  { key: 'g4_d5h45', name: 'Dip −5% → hold 45m', desc: 'Exit everything after 45 minutes regardless of price.', dip: 0.05, hold: 45, stop: 0.5 },
  { key: 'g4_d8h5', name: 'Dip −8% → hold 5m', desc: 'Exit everything after 5 minutes regardless of price.', dip: 0.08, hold: 5, stop: 0.5 },
  { key: 'g4_d8h20', name: 'Dip −8% → hold 20m', desc: 'Exit everything after 20 minutes regardless of price.', dip: 0.08, hold: 20, stop: 0.5 },
  { key: 'g4_d10h2', name: 'Dip −10% → hold 2m', desc: 'Exit everything after 2 minutes regardless of price.', dip: 0.1, hold: 2, stop: 0.5 },
  { key: 'g4_d10h12', name: 'Dip −10% → hold 12m', desc: 'Exit everything after 12 minutes regardless of price.', dip: 0.1, hold: 12, stop: 0.5 },
  { key: 'g4_d10h45', name: 'Dip −10% → hold 45m', desc: 'Exit everything after 45 minutes regardless of price.', dip: 0.1, hold: 45, stop: 0.5 },
  { key: 'g4_d12h5', name: 'Dip −12% → hold 5m', desc: 'Exit everything after 5 minutes regardless of price.', dip: 0.12, hold: 5, stop: 0.5 },
  { key: 'g4_d12h20', name: 'Dip −12% → hold 20m', desc: 'Exit everything after 20 minutes regardless of price.', dip: 0.12, hold: 20, stop: 0.5 },
  { key: 'g4_d15h2', name: 'Dip −15% → hold 2m', desc: 'Exit everything after 2 minutes regardless of price.', dip: 0.15, hold: 2, stop: 0.5 },
  { key: 'g4_d15h8', name: 'Dip −15% → hold 8m', desc: 'Exit everything after 8 minutes regardless of price.', dip: 0.15, hold: 8, stop: 0.5 },
  { key: 'g4_d15h30', name: 'Dip −15% → hold 30m', desc: 'Exit everything after 30 minutes regardless of price.', dip: 0.15, hold: 30, stop: 0.5 },
  { key: 'g4_d18h3', name: 'Dip −18% → hold 3m', desc: 'Exit everything after 3 minutes regardless of price.', dip: 0.18, hold: 3, stop: 0.5 },
  { key: 'g4_d18h12', name: 'Dip −18% → hold 12m', desc: 'Exit everything after 12 minutes regardless of price.', dip: 0.18, hold: 12, stop: 0.5 },
  { key: 'g4_d20h2', name: 'Dip −20% → hold 2m', desc: 'Exit everything after 2 minutes regardless of price.', dip: 0.2, hold: 2, stop: 0.5 },
  { key: 'g4_d20h8', name: 'Dip −20% → hold 8m', desc: 'Exit everything after 8 minutes regardless of price.', dip: 0.2, hold: 8, stop: 0.5 },
  { key: 'g4_d20h30', name: 'Dip −20% → hold 30m', desc: 'Exit everything after 30 minutes regardless of price.', dip: 0.2, hold: 30, stop: 0.5 },
  { key: 'g4_d22h3', name: 'Dip −22% → hold 3m', desc: 'Exit everything after 3 minutes regardless of price.', dip: 0.22, hold: 3, stop: 0.5 },
  { key: 'g4_d22h12', name: 'Dip −22% → hold 12m', desc: 'Exit everything after 12 minutes regardless of price.', dip: 0.22, hold: 12, stop: 0.5 },
  { key: 'g4_d22h45', name: 'Dip −22% → hold 45m', desc: 'Exit everything after 45 minutes regardless of price.', dip: 0.22, hold: 45, stop: 0.5 },
  { key: 'g4_d25h5', name: 'Dip −25% → hold 5m', desc: 'Exit everything after 5 minutes regardless of price.', dip: 0.25, hold: 5, stop: 0.5 },
  { key: 'g4_d25h20', name: 'Dip −25% → hold 20m', desc: 'Exit everything after 20 minutes regardless of price.', dip: 0.25, hold: 20, stop: 0.5 },
  { key: 'g4_d28h2', name: 'Dip −28% → hold 2m', desc: 'Exit everything after 2 minutes regardless of price.', dip: 0.28, hold: 2, stop: 0.5 },
  { key: 'g4_d28h12', name: 'Dip −28% → hold 12m', desc: 'Exit everything after 12 minutes regardless of price.', dip: 0.28, hold: 12, stop: 0.5 },
  { key: 'g4_d28h45', name: 'Dip −28% → hold 45m', desc: 'Exit everything after 45 minutes regardless of price.', dip: 0.28, hold: 45, stop: 0.5 },
  { key: 'g4_d30h5', name: 'Dip −30% → hold 5m', desc: 'Exit everything after 5 minutes regardless of price.', dip: 0.3, hold: 5, stop: 0.5 },
  { key: 'g4_d30h20', name: 'Dip −30% → hold 20m', desc: 'Exit everything after 20 minutes regardless of price.', dip: 0.3, hold: 20, stop: 0.5 },
  { key: 'g4_d35h2', name: 'Dip −35% → hold 2m', desc: 'Exit everything after 2 minutes regardless of price.', dip: 0.35, hold: 2, stop: 0.5 },
  { key: 'g4_d35h8', name: 'Dip −35% → hold 8m', desc: 'Exit everything after 8 minutes regardless of price.', dip: 0.35, hold: 8, stop: 0.5 },
  { key: 'g4_d35h30', name: 'Dip −35% → hold 30m', desc: 'Exit everything after 30 minutes regardless of price.', dip: 0.35, hold: 30, stop: 0.5 },
  { key: 'g4_d40h3', name: 'Dip −40% → hold 3m', desc: 'Exit everything after 3 minutes regardless of price.', dip: 0.4, hold: 3, stop: 0.5 },
  { key: 'g4_d40h12', name: 'Dip −40% → hold 12m', desc: 'Exit everything after 12 minutes regardless of price.', dip: 0.4, hold: 12, stop: 0.5 },
  { key: 'g4_it13h5', name: 'Instant → 1.3X or 5m', desc: 'Whichever comes first: a 1.3× target or a 5-minute clock.', hold: 5, tps: [[1.3, 1]], stop: 0.6 },
  { key: 'g4_it15h5', name: 'Instant → 1.5X or 5m', desc: 'Whichever comes first: a 1.5× target or a 5-minute clock.', hold: 5, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'g4_it2h5', name: 'Instant → 2X or 5m', desc: 'Whichever comes first: a 2× target or a 5-minute clock.', hold: 5, tps: [[2, 1]], stop: 0.6 },
  { key: 'g4_it3h5', name: 'Instant → 3X or 5m', desc: 'Whichever comes first: a 3× target or a 5-minute clock.', hold: 5, tps: [[3, 1]], stop: 0.6 },
  { key: 'g4_d10t13h5', name: 'Dip −10% → 1.3X or 5m', desc: 'Whichever comes first: a 1.3× target or a 5-minute clock.', dip: 0.1, hold: 5, tps: [[1.3, 1]], stop: 0.6 },
  { key: 'g4_d10t15h5', name: 'Dip −10% → 1.5X or 5m', desc: 'Whichever comes first: a 1.5× target or a 5-minute clock.', dip: 0.1, hold: 5, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'g4_d10t2h5', name: 'Dip −10% → 2X or 5m', desc: 'Whichever comes first: a 2× target or a 5-minute clock.', dip: 0.1, hold: 5, tps: [[2, 1]], stop: 0.6 },
  { key: 'g4_d10t3h5', name: 'Dip −10% → 3X or 5m', desc: 'Whichever comes first: a 3× target or a 5-minute clock.', dip: 0.1, hold: 5, tps: [[3, 1]], stop: 0.6 },
  { key: 'g4_d15t13h5', name: 'Dip −15% → 1.3X or 5m', desc: 'Whichever comes first: a 1.3× target or a 5-minute clock.', dip: 0.15, hold: 5, tps: [[1.3, 1]], stop: 0.6 },
  { key: 'g4_d15t15h5', name: 'Dip −15% → 1.5X or 5m', desc: 'Whichever comes first: a 1.5× target or a 5-minute clock.', dip: 0.15, hold: 5, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'g4_d15t2h5', name: 'Dip −15% → 2X or 5m', desc: 'Whichever comes first: a 2× target or a 5-minute clock.', dip: 0.15, hold: 5, tps: [[2, 1]], stop: 0.6 },
  { key: 'g4_d15t3h5', name: 'Dip −15% → 3X or 5m', desc: 'Whichever comes first: a 3× target or a 5-minute clock.', dip: 0.15, hold: 5, tps: [[3, 1]], stop: 0.6 },
  { key: 'g4_d20t13h5', name: 'Dip −20% → 1.3X or 5m', desc: 'Whichever comes first: a 1.3× target or a 5-minute clock.', dip: 0.2, hold: 5, tps: [[1.3, 1]], stop: 0.6 },
  { key: 'g4_d20t15h5', name: 'Dip −20% → 1.5X or 5m', desc: 'Whichever comes first: a 1.5× target or a 5-minute clock.', dip: 0.2, hold: 5, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'g4_d20t2h5', name: 'Dip −20% → 2X or 5m', desc: 'Whichever comes first: a 2× target or a 5-minute clock.', dip: 0.2, hold: 5, tps: [[2, 1]], stop: 0.6 },
  { key: 'g4_d20t3h5', name: 'Dip −20% → 3X or 5m', desc: 'Whichever comes first: a 3× target or a 5-minute clock.', dip: 0.2, hold: 5, tps: [[3, 1]], stop: 0.6 },
  { key: 'g4_d25t13h5', name: 'Dip −25% → 1.3X or 5m', desc: 'Whichever comes first: a 1.3× target or a 5-minute clock.', dip: 0.25, hold: 5, tps: [[1.3, 1]], stop: 0.6 },
  { key: 'g4_d25t15h5', name: 'Dip −25% → 1.5X or 5m', desc: 'Whichever comes first: a 1.5× target or a 5-minute clock.', dip: 0.25, hold: 5, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'g4_d25t2h5', name: 'Dip −25% → 2X or 5m', desc: 'Whichever comes first: a 2× target or a 5-minute clock.', dip: 0.25, hold: 5, tps: [[2, 1]], stop: 0.6 },
  { key: 'g4_d25t3h5', name: 'Dip −25% → 3X or 5m', desc: 'Whichever comes first: a 3× target or a 5-minute clock.', dip: 0.25, hold: 5, tps: [[3, 1]], stop: 0.6 },
  { key: 'g4_d30t13h5', name: 'Dip −30% → 1.3X or 5m', desc: 'Whichever comes first: a 1.3× target or a 5-minute clock.', dip: 0.3, hold: 5, tps: [[1.3, 1]], stop: 0.6 },
  { key: 'g4_d30t15h5', name: 'Dip −30% → 1.5X or 5m', desc: 'Whichever comes first: a 1.5× target or a 5-minute clock.', dip: 0.3, hold: 5, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'g4_d30t2h5', name: 'Dip −30% → 2X or 5m', desc: 'Whichever comes first: a 2× target or a 5-minute clock.', dip: 0.3, hold: 5, tps: [[2, 1]], stop: 0.6 },
  { key: 'g4_d30t3h5', name: 'Dip −30% → 3X or 5m', desc: 'Whichever comes first: a 3× target or a 5-minute clock.', dip: 0.3, hold: 5, tps: [[3, 1]], stop: 0.6 },
  { key: 'g4_isp12_2w30', name: 'Instant → 30%@1.2X + 70%@2X', desc: 'Bank 30% at 1.2× and the rest at 2×.', tps: [[1.2, 0.3], [2, 0.7]], stop: 0.6, be: true },
  { key: 'g4_isp13_2w30', name: 'Instant → 30%@1.3X + 70%@2X', desc: 'Bank 30% at 1.3× and the rest at 2×.', tps: [[1.3, 0.3], [2, 0.7]], stop: 0.6, be: true },
  { key: 'g4_isp13_25w50', name: 'Instant → 50%@1.3X + 50%@2.5X', desc: 'Bank 50% at 1.3× and the rest at 2.5×.', tps: [[1.3, 0.5], [2.5, 0.5]], stop: 0.6, be: true },
  { key: 'g4_isp15_25w70', name: 'Instant → 70%@1.5X + 30%@2.5X', desc: 'Bank 70% at 1.5× and the rest at 2.5×.', tps: [[1.5, 0.7], [2.5, 0.30000000000000004]], stop: 0.6, be: true },
  { key: 'g4_isp15_3w70', name: 'Instant → 70%@1.5X + 30%@3X', desc: 'Bank 70% at 1.5× and the rest at 3×.', tps: [[1.5, 0.7], [3, 0.30000000000000004]], stop: 0.6, be: true },
  { key: 'g4_isp2_4w30', name: 'Instant → 30%@2X + 70%@4X', desc: 'Bank 30% at 2× and the rest at 4×.', tps: [[2, 0.3], [4, 0.7]], stop: 0.6, be: true },
  { key: 'g4_d10sp12_2w50', name: 'Dip −10% → 50%@1.2X + 50%@2X', desc: 'Bank 50% at 1.2× and the rest at 2×.', dip: 0.1, tps: [[1.2, 0.5], [2, 0.5]], stop: 0.6, be: true },
  { key: 'g4_d10sp13_2w50', name: 'Dip −10% → 50%@1.3X + 50%@2X', desc: 'Bank 50% at 1.3× and the rest at 2×.', dip: 0.1, tps: [[1.3, 0.5], [2, 0.5]], stop: 0.6, be: true },
  { key: 'g4_d10sp13_25w70', name: 'Dip −10% → 70%@1.3X + 30%@2.5X', desc: 'Bank 70% at 1.3× and the rest at 2.5×.', dip: 0.1, tps: [[1.3, 0.7], [2.5, 0.30000000000000004]], stop: 0.6, be: true },
  { key: 'g4_d10sp15_3w30', name: 'Dip −10% → 30%@1.5X + 70%@3X', desc: 'Bank 30% at 1.5× and the rest at 3×.', dip: 0.1, tps: [[1.5, 0.3], [3, 0.7]], stop: 0.6, be: true },
  { key: 'g4_d10sp175_4w50', name: 'Dip −10% → 50%@1.75X + 50%@4X', desc: 'Bank 50% at 1.75× and the rest at 4×.', dip: 0.1, tps: [[1.75, 0.5], [4, 0.5]], stop: 0.6, be: true },
  { key: 'g4_d10sp2_4w50', name: 'Dip −10% → 50%@2X + 50%@4X', desc: 'Bank 50% at 2× and the rest at 4×.', dip: 0.1, tps: [[2, 0.5], [4, 0.5]], stop: 0.6, be: true },
  { key: 'g4_d15sp12_2w70', name: 'Dip −15% → 70%@1.2X + 30%@2X', desc: 'Bank 70% at 1.2× and the rest at 2×.', dip: 0.15, tps: [[1.2, 0.7], [2, 0.30000000000000004]], stop: 0.6, be: true },
  { key: 'g4_d15sp13_25w30', name: 'Dip −15% → 30%@1.3X + 70%@2.5X', desc: 'Bank 30% at 1.3× and the rest at 2.5×.', dip: 0.15, tps: [[1.3, 0.3], [2.5, 0.7]], stop: 0.6, be: true },
  { key: 'g4_d15sp15_25w30', name: 'Dip −15% → 30%@1.5X + 70%@2.5X', desc: 'Bank 30% at 1.5× and the rest at 2.5×.', dip: 0.15, tps: [[1.5, 0.3], [2.5, 0.7]], stop: 0.6, be: true },
  { key: 'g4_d15sp15_3w50', name: 'Dip −15% → 50%@1.5X + 50%@3X', desc: 'Bank 50% at 1.5× and the rest at 3×.', dip: 0.15, tps: [[1.5, 0.5], [3, 0.5]], stop: 0.6, be: true },
  { key: 'g4_d15sp175_4w70', name: 'Dip −15% → 70%@1.75X + 30%@4X', desc: 'Bank 70% at 1.75× and the rest at 4×.', dip: 0.15, tps: [[1.75, 0.7], [4, 0.30000000000000004]], stop: 0.6, be: true },
  { key: 'g4_d15sp2_4w70', name: 'Dip −15% → 70%@2X + 30%@4X', desc: 'Bank 70% at 2× and the rest at 4×.', dip: 0.15, tps: [[2, 0.7], [4, 0.30000000000000004]], stop: 0.6, be: true },
  { key: 'g4_d20sp13_2w30', name: 'Dip −20% → 30%@1.3X + 70%@2X', desc: 'Bank 30% at 1.3× and the rest at 2×.', dip: 0.2, tps: [[1.3, 0.3], [2, 0.7]], stop: 0.6, be: true },
  { key: 'g4_d20sp13_25w50', name: 'Dip −20% → 50%@1.3X + 50%@2.5X', desc: 'Bank 50% at 1.3× and the rest at 2.5×.', dip: 0.2, tps: [[1.3, 0.5], [2.5, 0.5]], stop: 0.6, be: true },
  { key: 'g4_d20sp15_25w70', name: 'Dip −20% → 70%@1.5X + 30%@2.5X', desc: 'Bank 70% at 1.5× and the rest at 2.5×.', dip: 0.2, tps: [[1.5, 0.7], [2.5, 0.30000000000000004]], stop: 0.6, be: true },
  { key: 'g4_d20sp15_3w70', name: 'Dip −20% → 70%@1.5X + 30%@3X', desc: 'Bank 70% at 1.5× and the rest at 3×.', dip: 0.2, tps: [[1.5, 0.7], [3, 0.30000000000000004]], stop: 0.6, be: true },
  { key: 'g4_d20sp2_4w30', name: 'Dip −20% → 30%@2X + 70%@4X', desc: 'Bank 30% at 2× and the rest at 4×.', dip: 0.2, tps: [[2, 0.3], [4, 0.7]], stop: 0.6, be: true },
  { key: 'g4_d25sp12_2w50', name: 'Dip −25% → 50%@1.2X + 50%@2X', desc: 'Bank 50% at 1.2× and the rest at 2×.', dip: 0.25, tps: [[1.2, 0.5], [2, 0.5]], stop: 0.6, be: true },
  { key: 'g4_d25sp13_2w50', name: 'Dip −25% → 50%@1.3X + 50%@2X', desc: 'Bank 50% at 1.3× and the rest at 2×.', dip: 0.25, tps: [[1.3, 0.5], [2, 0.5]], stop: 0.6, be: true },
  { key: 'g4_d25sp13_25w70', name: 'Dip −25% → 70%@1.3X + 30%@2.5X', desc: 'Bank 70% at 1.3× and the rest at 2.5×.', dip: 0.25, tps: [[1.3, 0.7], [2.5, 0.30000000000000004]], stop: 0.6, be: true },
  { key: 'g4_d25sp15_3w30', name: 'Dip −25% → 30%@1.5X + 70%@3X', desc: 'Bank 30% at 1.5× and the rest at 3×.', dip: 0.25, tps: [[1.5, 0.3], [3, 0.7]], stop: 0.6, be: true },
  { key: 'g4_d25sp175_4w50', name: 'Dip −25% → 50%@1.75X + 50%@4X', desc: 'Bank 50% at 1.75× and the rest at 4×.', dip: 0.25, tps: [[1.75, 0.5], [4, 0.5]], stop: 0.6, be: true },
  { key: 'g4_d25sp2_4w50', name: 'Dip −25% → 50%@2X + 50%@4X', desc: 'Bank 50% at 2× and the rest at 4×.', dip: 0.25, tps: [[2, 0.5], [4, 0.5]], stop: 0.6, be: true },
  { key: 'g4_d30sp12_2w70', name: 'Dip −30% → 70%@1.2X + 30%@2X', desc: 'Bank 70% at 1.2× and the rest at 2×.', dip: 0.3, tps: [[1.2, 0.7], [2, 0.30000000000000004]], stop: 0.6, be: true },
  { key: 'g4_d30sp13_25w30', name: 'Dip −30% → 30%@1.3X + 70%@2.5X', desc: 'Bank 30% at 1.3× and the rest at 2.5×.', dip: 0.3, tps: [[1.3, 0.3], [2.5, 0.7]], stop: 0.6, be: true },
  { key: 'g4_d30sp15_25w30', name: 'Dip −30% → 30%@1.5X + 70%@2.5X', desc: 'Bank 30% at 1.5× and the rest at 2.5×.', dip: 0.3, tps: [[1.5, 0.3], [2.5, 0.7]], stop: 0.6, be: true },
  { key: 'g4_d30sp15_3w50', name: 'Dip −30% → 50%@1.5X + 50%@3X', desc: 'Bank 50% at 1.5× and the rest at 3×.', dip: 0.3, tps: [[1.5, 0.5], [3, 0.5]], stop: 0.6, be: true },
  { key: 'g4_d30sp175_4w70', name: 'Dip −30% → 70%@1.75X + 30%@4X', desc: 'Bank 70% at 1.75× and the rest at 4×.', dip: 0.3, tps: [[1.75, 0.7], [4, 0.30000000000000004]], stop: 0.6, be: true },
  { key: 'g4_ibank12_80', name: 'Instant → 80%@1.2X + free tail', desc: 'Take 80% off at 1.2× and let the remainder ride with no stop.', tps: [[1.2, 0.8]], stop: 0.02, be: true },
  { key: 'g4_ibank13_85', name: 'Instant → 85%@1.3X + free tail', desc: 'Take 85% off at 1.3× and let the remainder ride with no stop.', tps: [[1.3, 0.85]], stop: 0.02, be: true },
  { key: 'g4_ibank15_75', name: 'Instant → 75%@1.5X + free tail', desc: 'Take 75% off at 1.5× and let the remainder ride with no stop.', tps: [[1.5, 0.75]], stop: 0.02, be: true },
  { key: 'g4_d15bank12_80', name: 'Dip −15% → 80%@1.2X + free tail', desc: 'Take 80% off at 1.2× and let the remainder ride with no stop.', dip: 0.15, tps: [[1.2, 0.8]], stop: 0.02, be: true },
  { key: 'g4_d15bank13_85', name: 'Dip −15% → 85%@1.3X + free tail', desc: 'Take 85% off at 1.3× and let the remainder ride with no stop.', dip: 0.15, tps: [[1.3, 0.85]], stop: 0.02, be: true },
  { key: 'g4_d15bank15_75', name: 'Dip −15% → 75%@1.5X + free tail', desc: 'Take 75% off at 1.5× and let the remainder ride with no stop.', dip: 0.15, tps: [[1.5, 0.75]], stop: 0.02, be: true },
  { key: 'g4_d20bank12_80', name: 'Dip −20% → 80%@1.2X + free tail', desc: 'Take 80% off at 1.2× and let the remainder ride with no stop.', dip: 0.2, tps: [[1.2, 0.8]], stop: 0.02, be: true },
  { key: 'g4_d20bank13_85', name: 'Dip −20% → 85%@1.3X + free tail', desc: 'Take 85% off at 1.3× and let the remainder ride with no stop.', dip: 0.2, tps: [[1.3, 0.85]], stop: 0.02, be: true },
  { key: 'g4_d20bank15_75', name: 'Dip −20% → 75%@1.5X + free tail', desc: 'Take 75% off at 1.5× and let the remainder ride with no stop.', dip: 0.2, tps: [[1.5, 0.75]], stop: 0.02, be: true },
  { key: 'g4_d20bank2_90', name: 'Dip −20% → 90%@2X + free tail', desc: 'Take 90% off at 2× and let the remainder ride with no stop.', dip: 0.2, tps: [[2, 0.9]], stop: 0.02, be: true },
  { key: 'g4_d25bank13_85', name: 'Dip −25% → 85%@1.3X + free tail', desc: 'Take 85% off at 1.3× and let the remainder ride with no stop.', dip: 0.25, tps: [[1.3, 0.85]], stop: 0.02, be: true },
  { key: 'g4_d25bank15_75', name: 'Dip −25% → 75%@1.5X + free tail', desc: 'Take 75% off at 1.5× and let the remainder ride with no stop.', dip: 0.25, tps: [[1.5, 0.75]], stop: 0.02, be: true },
  { key: 'g4_iladeven3s30', name: 'Instant → even3 ladder, stop −30%', desc: 'Scale out across 3 rungs (1.3×/2×/3×).', tps: [[1.3, 0.34], [2, 0.33], [3, 0.33]], stop: 0.7, be: true },
  { key: 'g4_iladeven4s30', name: 'Instant → even4 ladder, stop −30%', desc: 'Scale out across 4 rungs (1.2×/1.5×/2×/3×).', tps: [[1.2, 0.25], [1.5, 0.25], [2, 0.25], [3, 0.25]], stop: 0.7, be: true },
  { key: 'g4_iladeven5s30', name: 'Instant → even5 ladder, stop −30%', desc: 'Scale out across 5 rungs (1.2×/1.4×/1.7×/2.2×/3×).', tps: [[1.2, 0.2], [1.4, 0.2], [1.7, 0.2], [2.2, 0.2], [3, 0.2]], stop: 0.7, be: true },
  { key: 'g4_iladfronts50', name: 'Instant → front ladder, stop −50%', desc: 'Scale out across 3 rungs (1.2×/1.6×/2.5×).', tps: [[1.2, 0.5], [1.6, 0.3], [2.5, 0.2]], stop: 0.5, be: true },
  { key: 'g4_iladbacks50', name: 'Instant → back ladder, stop −50%', desc: 'Scale out across 3 rungs (1.3×/2×/3.5×).', tps: [[1.3, 0.2], [2, 0.3], [3.5, 0.5]], stop: 0.5, be: true },
  { key: 'g4_d10ladeven3s30', name: 'Dip −10% → even3 ladder, stop −30%', desc: 'Scale out across 3 rungs (1.3×/2×/3×).', dip: 0.1, tps: [[1.3, 0.34], [2, 0.33], [3, 0.33]], stop: 0.7, be: true },
  { key: 'g4_d10ladeven4s30', name: 'Dip −10% → even4 ladder, stop −30%', desc: 'Scale out across 4 rungs (1.2×/1.5×/2×/3×).', dip: 0.1, tps: [[1.2, 0.25], [1.5, 0.25], [2, 0.25], [3, 0.25]], stop: 0.7, be: true },
  { key: 'g4_d10ladeven5s30', name: 'Dip −10% → even5 ladder, stop −30%', desc: 'Scale out across 5 rungs (1.2×/1.4×/1.7×/2.2×/3×).', dip: 0.1, tps: [[1.2, 0.2], [1.4, 0.2], [1.7, 0.2], [2.2, 0.2], [3, 0.2]], stop: 0.7, be: true },
  { key: 'g4_d10ladfronts50', name: 'Dip −10% → front ladder, stop −50%', desc: 'Scale out across 3 rungs (1.2×/1.6×/2.5×).', dip: 0.1, tps: [[1.2, 0.5], [1.6, 0.3], [2.5, 0.2]], stop: 0.5, be: true },
  { key: 'g4_d10ladbacks50', name: 'Dip −10% → back ladder, stop −50%', desc: 'Scale out across 3 rungs (1.3×/2×/3.5×).', dip: 0.1, tps: [[1.3, 0.2], [2, 0.3], [3.5, 0.5]], stop: 0.5, be: true },
  { key: 'g4_d10ladwides50', name: 'Dip −10% → wide ladder, stop −50%', desc: 'Scale out across 3 rungs (1.5×/3×/6×).', dip: 0.1, tps: [[1.5, 0.4], [3, 0.3], [6, 0.3]], stop: 0.5, be: true },
  { key: 'g4_d15ladeven4s30', name: 'Dip −15% → even4 ladder, stop −30%', desc: 'Scale out across 4 rungs (1.2×/1.5×/2×/3×).', dip: 0.15, tps: [[1.2, 0.25], [1.5, 0.25], [2, 0.25], [3, 0.25]], stop: 0.7, be: true },
  { key: 'g4_d15ladeven5s30', name: 'Dip −15% → even5 ladder, stop −30%', desc: 'Scale out across 5 rungs (1.2×/1.4×/1.7×/2.2×/3×).', dip: 0.15, tps: [[1.2, 0.2], [1.4, 0.2], [1.7, 0.2], [2.2, 0.2], [3, 0.2]], stop: 0.7, be: true },
  { key: 'g4_d15ladfronts50', name: 'Dip −15% → front ladder, stop −50%', desc: 'Scale out across 3 rungs (1.2×/1.6×/2.5×).', dip: 0.15, tps: [[1.2, 0.5], [1.6, 0.3], [2.5, 0.2]], stop: 0.5, be: true },
  { key: 'g4_d15ladbacks50', name: 'Dip −15% → back ladder, stop −50%', desc: 'Scale out across 3 rungs (1.3×/2×/3.5×).', dip: 0.15, tps: [[1.3, 0.2], [2, 0.3], [3.5, 0.5]], stop: 0.5, be: true },
  { key: 'g4_d15ladwides50', name: 'Dip −15% → wide ladder, stop −50%', desc: 'Scale out across 3 rungs (1.5×/3×/6×).', dip: 0.15, tps: [[1.5, 0.4], [3, 0.3], [6, 0.3]], stop: 0.5, be: true },
  { key: 'g4_d20ladeven4s30', name: 'Dip −20% → even4 ladder, stop −30%', desc: 'Scale out across 4 rungs (1.2×/1.5×/2×/3×).', dip: 0.2, tps: [[1.2, 0.25], [1.5, 0.25], [2, 0.25], [3, 0.25]], stop: 0.7, be: true },
  { key: 'g4_d20ladeven5s30', name: 'Dip −20% → even5 ladder, stop −30%', desc: 'Scale out across 5 rungs (1.2×/1.4×/1.7×/2.2×/3×).', dip: 0.2, tps: [[1.2, 0.2], [1.4, 0.2], [1.7, 0.2], [2.2, 0.2], [3, 0.2]], stop: 0.7, be: true },
  { key: 'g4_d20ladfronts50', name: 'Dip −20% → front ladder, stop −50%', desc: 'Scale out across 3 rungs (1.2×/1.6×/2.5×).', dip: 0.2, tps: [[1.2, 0.5], [1.6, 0.3], [2.5, 0.2]], stop: 0.5, be: true },
  { key: 'g4_d20ladbacks50', name: 'Dip −20% → back ladder, stop −50%', desc: 'Scale out across 3 rungs (1.3×/2×/3.5×).', dip: 0.2, tps: [[1.3, 0.2], [2, 0.3], [3.5, 0.5]], stop: 0.5, be: true },
  { key: 'g4_d20ladwides50', name: 'Dip −20% → wide ladder, stop −50%', desc: 'Scale out across 3 rungs (1.5×/3×/6×).', dip: 0.2, tps: [[1.5, 0.4], [3, 0.3], [6, 0.3]], stop: 0.5, be: true },
  { key: 'g4_d25ladeven4s30', name: 'Dip −25% → even4 ladder, stop −30%', desc: 'Scale out across 4 rungs (1.2×/1.5×/2×/3×).', dip: 0.25, tps: [[1.2, 0.25], [1.5, 0.25], [2, 0.25], [3, 0.25]], stop: 0.7, be: true },
  { key: 'g4_d25ladeven5s30', name: 'Dip −25% → even5 ladder, stop −30%', desc: 'Scale out across 5 rungs (1.2×/1.4×/1.7×/2.2×/3×).', dip: 0.25, tps: [[1.2, 0.2], [1.4, 0.2], [1.7, 0.2], [2.2, 0.2], [3, 0.2]], stop: 0.7, be: true },
  { key: 'g4_d25ladfronts50', name: 'Dip −25% → front ladder, stop −50%', desc: 'Scale out across 3 rungs (1.2×/1.6×/2.5×).', dip: 0.25, tps: [[1.2, 0.5], [1.6, 0.3], [2.5, 0.2]], stop: 0.5, be: true },
  { key: 'g4_d25ladbacks50', name: 'Dip −25% → back ladder, stop −50%', desc: 'Scale out across 3 rungs (1.3×/2×/3.5×).', dip: 0.25, tps: [[1.3, 0.2], [2, 0.3], [3.5, 0.5]], stop: 0.5, be: true },
  { key: 'g4_d25ladwides50', name: 'Dip −25% → wide ladder, stop −50%', desc: 'Scale out across 3 rungs (1.5×/3×/6×).', dip: 0.25, tps: [[1.5, 0.4], [3, 0.3], [6, 0.3]], stop: 0.5, be: true },
  { key: 'g4_d30ladeven4s30', name: 'Dip −30% → even4 ladder, stop −30%', desc: 'Scale out across 4 rungs (1.2×/1.5×/2×/3×).', dip: 0.3, tps: [[1.2, 0.25], [1.5, 0.25], [2, 0.25], [3, 0.25]], stop: 0.7, be: true },
  { key: 'g4_d30ladeven5s30', name: 'Dip −30% → even5 ladder, stop −30%', desc: 'Scale out across 5 rungs (1.2×/1.4×/1.7×/2.2×/3×).', dip: 0.3, tps: [[1.2, 0.2], [1.4, 0.2], [1.7, 0.2], [2.2, 0.2], [3, 0.2]], stop: 0.7, be: true },
  { key: 'g4_d30ladfronts50', name: 'Dip −30% → front ladder, stop −50%', desc: 'Scale out across 3 rungs (1.2×/1.6×/2.5×).', dip: 0.3, tps: [[1.2, 0.5], [1.6, 0.3], [2.5, 0.2]], stop: 0.5, be: true },
  { key: 'g4_d30ladbacks50', name: 'Dip −30% → back ladder, stop −50%', desc: 'Scale out across 3 rungs (1.3×/2×/3.5×).', dip: 0.3, tps: [[1.3, 0.2], [2, 0.3], [3.5, 0.5]], stop: 0.5, be: true },
];
GRID.push(...GRID4);

// ── GRID5 (200) ─────────────────────────────────────────────
//
// Built around one thing the previous 419 could not answer: every existing dip
// strategy hardcoded a 30-minute window, so "how long should we wait for the dip"
// has never been tested. A long window keeps buying knives that are still falling
// — the fill happens at the bottom of a window only in hindsight. These vary the
// window from 3 to 15 minutes as a first-class axis.
//
// The other families target gaps rather than adding grid points:
//   B  break-even after TP1 — barely represented, and the cheapest way to turn a
//      winner that round-trips into a scratch instead of a loss ($Lego went 1.7x
//      then gave it all back to a -50% trailer).
//   C  fast scalps — hold minutes, not hours, on the theory that a call's edge
//      decays quickly.
//   D  asymmetric ladders — bank most of the position early, let a free tail run.
//      $Plumber did 124x; a 5% tail costs almost nothing and pays for many losses.
//   E  instant entry, tight stop — the direct counterpoint to dip entry. If the
//      dip families win, this is the control that proves it.
const GRID5: Spec[] = [];

// ── A: short dip windows (60) ──
for (const dip of [0.08, 0.12, 0.15, 0.20, 0.25]) {
  for (const win of [3, 5, 8, 10]) {
    for (const [tag, tps, trail, stop] of [
      ['q', [[1.4, 0.9], [3, 0.1]] as [number, number][], undefined, 0.6],
      ['r', [[1.8, 0.8], [4, 0.2]] as [number, number][], undefined, 0.55],
      ['t', [] as [number, number][], 0.3, 0.5],
    ] as [string, [number, number][], number | undefined, number][]) {
      const d = Math.round(dip * 100);
      GRID5.push({
        key: `w${win}d${d}${tag}`,
        name: `Dip −${d}% in ${win}m → ${tag === 't' ? 'trail 30%' : tps.map(x => `${x[0]}X`).join('/')}`,
        desc: `Only buys if the pullback arrives within ${win} minutes — a dip that takes longer is a downtrend, not an entry.`,
        dip, win, tps: tps.length ? tps : undefined, trail, stop,
      });
    }
  }
}

// ── B: break-even after TP1 (30) ──
for (const [dip, win] of [[undefined, undefined], [0.10, 5], [0.15, 8], [0.20, 10]] as [number | undefined, number | undefined][]) {
  for (const tp1 of [1.3, 1.5, 1.75, 2.0, 2.5]) {
    for (const sell of [0.5, 0.7]) {
      if (GRID5.length >= 90) break;
      const tag = dip ? `d${Math.round(dip * 100)}w${win}` : 'inst';
      GRID5.push({
        key: `be${String(tp1).replace('.', '')}s${Math.round(sell * 100)}${tag}`,
        name: `${dip ? `Dip −${Math.round(dip * 100)}% ${win}m` : 'Instant'} → ${Math.round(sell * 100)}%@${tp1}X, then break-even`,
        desc: `Takes ${Math.round(sell * 100)}% at ${tp1}X and moves the stop to entry, so the rest cannot become a loss.`,
        dip, win, tps: [[tp1, sell], [tp1 * 3, 1 - sell]], stop: 0.6, be: true,
      });
    }
  }
}

// ── C: fast scalps (30) ──
for (const hold of [1, 2, 3, 5, 8]) {
  for (const tp of [1.15, 1.25, 1.4]) {
    for (const dipCfg of [undefined, 0.10] as (number | undefined)[]) {
      GRID5.push({
        key: `sc${hold}m${String(tp).replace('.', '')}${dipCfg ? 'd' : 'i'}`,
        name: `${dipCfg ? 'Dip −10% 5m' : 'Instant'} → ${tp}X or ${hold}m`,
        desc: `Takes ${tp}X quickly or leaves after ${hold} minutes — treats the call's edge as short-lived.`,
        dip: dipCfg, win: dipCfg ? 5 : undefined, hold, tps: [[tp, 1]], stop: 0.7,
      });
    }
  }
}

// ── D: asymmetric ladders with a free tail (40) ──
for (const front of [0.75, 0.85, 0.9, 0.95]) {
  for (const tp1 of [1.3, 1.5, 1.8, 2.2, 3.0]) {
    for (const tail of [8, 20] as number[]) {
      GRID5.push({
        key: `tl${Math.round(front * 100)}_${String(tp1).replace('.', '')}_${tail}`,
        name: `${Math.round(front * 100)}%@${tp1}X + ${Math.round((1 - front) * 100)}% tail to ${tail}X`,
        desc: `Banks the position at ${tp1}X and lets a small free tail ride to ${tail}X — one runner pays for many losers.`,
        tps: [[tp1, front], [tail, 1 - front]], stop: 0.55,
      });
    }
  }
}

// ── E: instant entry, tight stop (40) ──
for (const stop of [0.8, 0.85, 0.9]) {
  for (const tp of [1.2, 1.35, 1.5, 1.8, 2.2, 3.0, 4.0]) {
    GRID5.push({
      key: `it${String(tp).replace('.', '')}s${Math.round((1 - stop) * 100)}`,
      name: `Instant → ${tp}X, stop −${Math.round((1 - stop) * 100)}%`,
      desc: `No waiting, cut fast. The control against every dip-entry family.`,
      tps: [[tp, 1]], stop,
    });
  }
}
for (const trail of [0.15, 0.2, 0.25, 0.3, 0.35]) {
  for (const arm of [1.3, 1.6, 2.0, 2.5] as number[]) {
    GRID5.push({
      key: `ar${Math.round(trail * 100)}_${String(arm).replace('.', '')}`,
      name: `Arm ${Math.round(trail * 100)}% trail after ${arm}X`,
      desc: `Runs a hard stop until ${arm}X, then switches to a ${Math.round(trail * 100)}% trail — protects the move without capping it.`,
      tps: [[arm, 0.001]], trail, trailFrom: 'afterLastTp', stop: 0.6,
    });
  }
}

GRID.push(...GRID5);

// ── GRID6: controlled dip-window sweep (56) ─────────────────
//
// Everything above varies several things at once, which tells you a strategy is
// good but not WHY. Here the exit shape is held identical and only the dip depth
// and window move, so the comparison is clean: if a 5-minute window beats a
// 30-minute one at the same depth and same exit, the window is doing the work.
//
// The long windows are deliberately included as controls. Without 20/30/45 in the
// set there is nothing to beat, and "short windows are better" stays an opinion.
const GRID6: Spec[] = [];
for (const dip of [0.10, 0.15, 0.20, 0.25]) {
  for (const win of [3, 5, 10, 15, 20, 30, 45]) {
    const d = Math.round(dip * 100);
    // Shape 1: bank most at 1.6X, small tail. Shape 2: pure 25% trail.
    GRID6.push({
      key: `sw${d}_${win}a`,
      name: `SWEEP −${d}% / ${win}m → 85%@1.6X`,
      desc: `Window sweep, identical exit. Only the ${win}-minute wait differs.`,
      dip, win, tps: [[1.6, 0.85], [6, 0.15]], stop: 0.55,
    });
    GRID6.push({
      key: `sw${d}_${win}b`,
      name: `SWEEP −${d}% / ${win}m → trail 25%`,
      desc: `Window sweep, identical exit. Only the ${win}-minute wait differs.`,
      dip, win, trail: 0.25, stop: 0.5,
    });
  }
}
GRID.push(...GRID6);

// ── GRID7 (instant entry, 186) ──────────────────────────────
//
// The fleet was 506 dip strategies to 170 instant, and 95 of those 170 used a
// -40% stop — the band the data says loses (-0.0056/trade against +0.0315 for
// -0 to -20%). So the entry mode that actually fills was both under-represented
// and mostly configured in the losing region.
//
// A dip strategy that never fills has no edge; it just has no trades. Four winners
// on 08-12 (FROG 6.5x, TOADER 5.4x, Ace 2.9x, ELEPHANT 2.7x) went straight up and
// the 20% dip order caught none of them.
//
// These concentrate where instant entry has actually worked: tight stops, modest
// targets, and short holds. Best live instant performers were 1.8X/-15%, 1.8X/-20%
// and a flat 2-minute clock.
const GRID7: Spec[] = [];

// A. tight-stop take-profit grid (54)
for (const tp of [1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0, 2.2, 2.5]) {
  for (const st of [8, 12, 15, 18, 20, 25]) {
    GRID7.push({
      key: `ix${String(tp).replace('.', '')}s${st}`,
      name: `Instant → ${tp}X, stop −${st}%`,
      desc: `Buys the call, takes ${tp}X, cuts at −${st}%. Tight stops are where instant entry has worked.`,
      tps: [[tp, 1]], stop: (100 - st) / 100,
    });
  }
}

// B. fast clock exits (28)
for (const hold of [1, 2, 3, 4, 5, 7, 10]) {
  for (const tp of [0, 1.2, 1.35, 1.5]) {
    GRID7.push({
      key: `ixc${hold}_${String(tp).replace('.', '')}`,
      name: tp ? `Instant → ${tp}X or ${hold}m` : `Instant → hold ${hold}m`,
      desc: `Half of all doublers get there within 11 minutes, so a short clock may capture the move without waiting for a target.`,
      hold, tps: tp ? [[tp, 1]] : undefined, stop: 0.8,
    });
  }
}

// C. break-even after the first take (30)
for (const tp of [1.2, 1.3, 1.4, 1.5, 1.6]) {
  for (const sell of [0.5, 0.7, 0.85]) {
    for (const st of [12, 20]) {
      GRID7.push({
        key: `ixb${String(tp).replace('.', '')}_${Math.round(sell * 100)}_${st}`,
        name: `Instant → ${Math.round(sell * 100)}%@${tp}X, then break-even (stop −${st}%)`,
        desc: `Banks most of it early and moves the stop to entry, so the remainder cannot turn into a loss.`,
        tps: [[tp, sell], [tp * 4, 1 - sell]], stop: (100 - st) / 100, be: true,
      });
    }
  }
}

// D. tight trailing from entry (24)
for (const tr of [8, 10, 12, 15, 18, 20, 25, 30]) {
  for (const st of [20, 30, 40]) {
    GRID7.push({
      key: `ixt${tr}_${st}`,
      name: `Instant → trail ${tr}%, stop −${st}%`,
      desc: `No target — rides with a ${tr}% trail. Tests whether a tight trail beats a fixed exit on instant entry.`,
      trail: tr / 100, trailFrom: 'entry', stop: (100 - st) / 100,
    });
  }
}

// E. bank most early, leave a runner (50)
for (const tp of [1.2, 1.3, 1.4, 1.5, 1.75]) {
  for (const front of [0.6, 0.75, 0.85, 0.95]) {
    for (const tail of [3, 10]) {
      if (GRID7.length >= 186) break;
      GRID7.push({
        key: `ixr${String(tp).replace('.', '')}_${Math.round(front * 100)}_${tail}`,
        name: `Instant → ${Math.round(front * 100)}%@${tp}X + ${Math.round((1 - front) * 100)}% to ${tail}X`,
        desc: `Takes the likely move and leaves a free runner. One 100X pays for a lot of small losses.`,
        tps: [[tp, front], [tail, 1 - front]], stop: 0.8,
      });
    }
  }
}

GRID.push(...GRID7);

// ── GRID8 (1055) ────────────────────────────────────────────
//
// The fleet was 852 strategies but not 852 *shapes*. Counted by structure rather
// than by key, most of the space was untouched:
//
//   3+ rung ladders        38 of 852   — the shape of a scale-out was never tested
//   trailing from entry   108 of 852   — 712 sat at 0.9, which is trailing switched off
//   any time exit         134 of 852   — a clock is the only exit that cannot be gamed
//   moonbag tails          52 of 852   — $Plumber ran 124x and nothing was left in it
//   break-even             156 of 852
//   dip window <= 10min   119 of 506   — 371 still waited the 30 minutes we know is bad
//
// So this is not more grid points on the axes already covered. Each family below
// fills a region the fleet could not previously answer questions about.
const GRID8: Spec[] = [];
const n = (x: number) => String(x).replace('.', '').replace('-', '');

// ── A. Ladder shape (216) ───────────────────────────────────
// Same rungs, different weightings. Front-loaded banks early and gives up the tail;
// back-loaded is the opposite bet; barbell takes profit twice and skips the middle.
// Nothing in the fleet distinguished these, so "ladders work" was never a testable
// claim — only "this one ladder worked".
const SHAPES3: [string, number[]][] = [
  ['front', [0.5, 0.3, 0.2]], ['even', [0.34, 0.33, 0.33]],
  ['back', [0.2, 0.3, 0.5]], ['barbell', [0.45, 0.1, 0.45]],
];
const SPANS3: [string, number[]][] = [
  ['tight', [1.2, 1.5, 2]], ['mid', [1.3, 1.8, 2.5]], ['wide', [1.5, 2.5, 4]],
  ['far', [2, 3, 5]], ['even', [1.4, 2, 3]],
];
for (const [sn, sh] of SHAPES3) {
  for (const [pn, sp] of SPANS3) {
    for (const [en, dip] of [['i', 0], ['d15', 0.15], ['d25', 0.25]] as [string, number][]) {
      for (const st of [15, 25, 40]) {
        GRID8.push({
          key: `g8L3${sn}${pn}${en}s${st}`,
          name: `${dip ? `Dip −${dip * 100}%` : 'Instant'} → ${sn} ladder ${sp.join('/')}X, stop −${st}%`,
          desc: `Three rungs at ${sp.join('/')}X weighted ${sh.map(x => Math.round(x * 100)).join('/')}%. Isolates ladder shape from ladder targets.`,
          dip: dip || undefined, win: dip ? 10 : undefined,
          tps: sp.map((m, i) => [m, sh[i]] as [number, number]),
          stop: (100 - st) / 100, be: true,
        });
      }
    }
  }
}
const SHAPES4: [string, number[]][] = [
  ['front', [0.4, 0.3, 0.2, 0.1]], ['even', [0.25, 0.25, 0.25, 0.25]], ['back', [0.1, 0.2, 0.3, 0.4]],
];
const SPANS4: [string, number[]][] = [
  ['tight', [1.2, 1.5, 2, 3]], ['mid', [1.3, 1.8, 2.5, 4]], ['wide', [1.5, 2, 3, 5]],
];
for (const [sn, sh] of SHAPES4) {
  for (const [pn, sp] of SPANS4) {
    for (const [en, dip] of [['i', 0], ['d20', 0.20]] as [string, number][]) {
      for (const st of [15, 30]) {
        GRID8.push({
          key: `g8L4${sn}${pn}${en}s${st}`,
          name: `${dip ? `Dip −${dip * 100}%` : 'Instant'} → ${sn} 4-rung ${sp.join('/')}X, stop −${st}%`,
          desc: `Four rungs weighted ${sh.map(x => Math.round(x * 100)).join('/')}%. Tests whether more rungs beat fewer at the same span.`,
          dip: dip || undefined, win: dip ? 10 : undefined,
          tps: sp.map((m, i) => [m, sh[i]] as [number, number]),
          stop: (100 - st) / 100, be: true,
        });
      }
    }
  }
}

// ── B. Trailing from entry (144) ────────────────────────────
// Only 108 of 852 ever trailed from entry, and the live task runs −50%, which both
// datasets call the worst band. This sweeps the width properly, with and without a
// take-profit ahead of it, so "how wide should the trail be" gets a real answer.
for (const tr of [8, 12, 15, 20, 25, 30, 35, 40, 50]) {
  for (const [en, dip] of [['i', 0], ['d10', 0.10], ['d20', 0.20], ['d30', 0.30]] as [string, number][]) {
    for (const [tn, tp] of [['0', null], ['15', [1.5, 0.5]], ['2', [2, 0.5]], ['3', [3, 0.3]]] as [string, number[] | null][]) {
      GRID8.push({
        key: `g8T${tr}${en}t${tn}`,
        name: `${dip ? `Dip −${dip * 100}%` : 'Instant'} → ${tp ? `${Math.round(tp[1] * 100)}%@${tp[0]}X + ` : ''}trail ${tr}%`,
        desc: `Trailing ${tr}% from entry${tp ? `, after banking ${Math.round(tp[1] * 100)}% at ${tp[0]}X` : ' with no take-profit'}. Width sweep — the fleet barely covered this.`,
        dip: dip || undefined, win: dip ? 10 : undefined,
        tps: tp ? [[tp[0], tp[1]]] : undefined,
        trail: tr / 100, trailFrom: 'entry', stop: (100 - tr) / 100,
      });
    }
  }
}

// ── C. Short dip windows (125) ──────────────────────────────
// 371 of 506 dip strategies waited 30 minutes. A dip that takes 25 minutes is a
// downtrend, and four winners on 08-12 went straight up and filled none of them.
// These give the order 1-8 minutes to fill and then stand down.
for (const dp of [10, 15, 20, 25, 30]) {
  for (const w of [1, 2, 3, 5, 8]) {
    for (const [xn, x] of [
      ['tp15', { tps: [[1.5, 1]] as [number, number][], stop: 0.8 }],
      ['tp2', { tps: [[2, 1]] as [number, number][], stop: 0.75 }],
      ['tp3', { tps: [[3, 1]] as [number, number][], stop: 0.7 }],
      ['tr20', { trail: 0.20, trailFrom: 'entry' as const, stop: 0.8 }],
      ['h5', { hold: 5, stop: 0.8 }],
    ] as [string, Partial<Spec>][]) {
      GRID8.push({
        key: `g8W${dp}_${w}${xn}`,
        name: `Dip −${dp}% in ${w}m → ${xn === 'tr20' ? 'trail 20%' : xn === 'h5' ? 'hold 5m' : xn.replace('tp', '') + 'X'}`,
        desc: `Fills only if the pullback arrives within ${w} minute${w === 1 ? '' : 's'}, then stands down. A dip that takes longer is a downtrend, not an entry.`,
        dip: dp / 100, win: w, ...x,
      });
    }
  }
}

// ── D. Time-boxed exits (128) ───────────────────────────────
// 718 of 852 had no clock at all. A time exit is the one rule a coin cannot game:
// it does not care about the shape of the candle, only that the edge has decayed.
for (const h of [1, 2, 3, 5, 8, 12, 20, 30]) {
  for (const [tn, tp] of [['0', 0], ['13', 1.3], ['16', 1.6], ['2', 2.0]] as [string, number][]) {
    for (const st of [12, 25]) {
      for (const [en, dip] of [['i', 0], ['d15', 0.15]] as [string, number][]) {
        GRID8.push({
          key: `g8C${h}_${tn}s${st}${en}`,
          name: `${dip ? `Dip −15%` : 'Instant'} → ${tp ? `${tp}X or ` : ''}${h}m, stop −${st}%`,
          desc: `Hard ${h}-minute clock${tp ? ` with a ${tp}X target ahead of it` : ''}. The exit a coin cannot game.`,
          dip: dip || undefined, win: dip ? 8 : undefined,
          hold: h, tps: tp ? [[tp, 1]] : undefined, stop: (100 - st) / 100,
        });
      }
    }
  }
}

// ── E. Moonbag tails (90) ───────────────────────────────────
// Only 52 strategies left anything running. $Plumber peaked at 124x and $FABUTOLLAH
// at 125x; a 5% tail costs almost nothing per trade and is the only way those pay.
for (const bank of [0.70, 0.80, 0.85, 0.90, 0.95]) {
  for (const at of [1.3, 1.5, 2.0]) {
    for (const tail of [5, 10, 25]) {
      for (const [en, dip] of [['i', 0], ['d20', 0.20]] as [string, number][]) {
        GRID8.push({
          key: `g8M${Math.round(bank * 100)}_${n(at)}_${tail}${en}`,
          name: `${dip ? 'Dip −20%' : 'Instant'} → ${Math.round(bank * 100)}%@${at}X + ${Math.round((1 - bank) * 100)}% to ${tail}X`,
          desc: `Banks ${Math.round(bank * 100)}% at ${at}X and leaves ${Math.round((1 - bank) * 100)}% running to ${tail}X. The cheap way to still be in a 100x.`,
          dip: dip || undefined, win: dip ? 10 : undefined,
          tps: [[at, bank], [tail, 1 - bank]], stop: 0.8, be: true,
        });
      }
    }
  }
}

// ── F. Break-even mechanics (120) ───────────────────────────
// The cheapest way to stop a winner round-tripping into a loss. $Lego hit 1.7x and
// gave all of it back. Sweeps how much to bank first and how tight to run before it.
for (const tp1 of [1.15, 1.25, 1.35, 1.5, 1.7]) {
  for (const sell of [0.4, 0.6, 0.75, 0.9]) {
    for (const st of [10, 15, 25]) {
      for (const [en, dip] of [['i', 0], ['d15', 0.15]] as [string, number][]) {
        GRID8.push({
          key: `g8B${n(tp1)}_${Math.round(sell * 100)}s${st}${en}`,
          name: `${dip ? 'Dip −15%' : 'Instant'} → ${Math.round(sell * 100)}%@${tp1}X then break-even (stop −${st}%)`,
          desc: `Takes ${Math.round(sell * 100)}% at ${tp1}X and moves the stop to entry, so the rest cannot become a loss.`,
          dip: dip || undefined, win: dip ? 8 : undefined,
          tps: [[tp1, sell], [tp1 * 5, 1 - sell]], stop: (100 - st) / 100, be: true,
        });
      }
    }
  }
}

// ── G. Asymmetric lottery (100) ─────────────────────────────
// Tight stop, far target. Wrong most of the time by design — the question is whether
// the hit rate clears the cost, which no strategy in the fleet was shaped to answer.
for (const st of [8, 10, 12, 15, 20]) {
  for (const tgt of [3, 5, 8, 12, 20]) {
    for (const [pn, parts] of [
      ['f', [[tgt, 1]] as [number, number][]],
      ['r', [[tgt * 0.4, 0.7], [tgt, 0.3]] as [number, number][]],
    ] as [string, [number, number][]][]) {
      for (const [en, dip] of [['i', 0], ['d20', 0.20]] as [string, number][]) {
        GRID8.push({
          key: `g8A${st}_${tgt}${pn}${en}`,
          name: `${dip ? 'Dip −20%' : 'Instant'} → ${tgt}X${pn === 'r' ? ' (70% early)' : ''}, stop −${st}%`,
          desc: `Cuts at −${st}% and holds for ${tgt}X. Loses often by design; only worth it if the tail pays for all of them.`,
          dip: dip || undefined, win: dip ? 10 : undefined,
          tps: parts, stop: (100 - st) / 100,
        });
      }
    }
  }
}

// ── H. Micro scalps (60) ────────────────────────────────────
// Round-trip cost is roughly 3%, so these are deliberately close to the noise floor.
// Included to find where the edge stops covering the fee rather than to be traded blind.
for (const tp of [1.08, 1.12, 1.15, 1.20, 1.25]) {
  for (const st of [5, 8, 10, 15]) {
    for (const [en, dip] of [['i', 0], ['d10', 0.10], ['d20', 0.20]] as [string, number][]) {
      GRID8.push({
        key: `g8S${n(tp)}s${st}${en}`,
        name: `${dip ? `Dip −${dip * 100}%` : 'Instant'} → ${tp}X, stop −${st}%`,
        desc: `A ${Math.round((tp - 1) * 100)}% scalp against a −${st}% stop. Costs are ~3%, so this measures where the edge stops covering the fee.`,
        dip: dip || undefined, win: dip ? 5 : undefined,
        tps: [[tp, 1]], stop: (100 - st) / 100,
      });
    }
  }
}

// ── I. Trail armed after the first take (72) ────────────────
// Distinct from B: run a hard stop until the first target, then switch to trailing.
// Tight early where most losses happen, loose later where the tails live.
for (const tp1 of [1.3, 1.5, 2.0]) {
  for (const sell of [0.3, 0.5]) {
    for (const tr of [15, 25, 40]) {
      for (const st of [15, 30]) {
        for (const [en, dip] of [['i', 0], ['d20', 0.20]] as [string, number][]) {
          GRID8.push({
            key: `g8R${n(tp1)}_${Math.round(sell * 100)}t${tr}s${st}${en}`,
            name: `${dip ? 'Dip −20%' : 'Instant'} → ${Math.round(sell * 100)}%@${tp1}X then trail ${tr}%`,
            desc: `Hard −${st}% stop until ${tp1}X, then ${tr}% trailing on the rest. Tight where losses happen, loose where tails live.`,
            dip: dip || undefined, win: dip ? 10 : undefined,
            tps: [[tp1, sell]], trail: tr / 100, trailFrom: 'afterLastTp',
            stop: (100 - st) / 100, be: true,
          });
        }
      }
    }
  }
}

GRID.push(...GRID8);

// ── GRID9 (213) ─────────────────────────────────────────────
//
// Targeted rather than broad. The fleet's own results point at two traits, and the
// fleet is nearly empty exactly where they meet.
//
// Strategies whose stop is effectively off (-95%) are the only group that makes
// money: 10 of 13 profitable, +0.1134/trade, against 150 of 1264 and -0.0882 for
// everything else. An 11% base rate does not produce 10 of 13 by luck. The reading
// is not "stops are bad" — it is that a stop tight enough to fire on memecoin noise
// gets hit on the way to the target, and the dip entry has already bought the
// discount the stop was there to protect.
//
// And the deepest dip band is the only positive one: dip 31-45% averages +0.0356
// with a median total of +2.44 SOL, while every shallower band is negative.
//
// Coverage where those meet was:
//
//   dip >= 35%                    26 of 1907
//   dip >= 45%                     0
//   stop off (>= 90%)             25 of 1907
//   dip >= 35% AND stop off        1
//   dip >= 35% + free tail         0
//   stop between -61% and -89%     0        (a complete hole)
//
// One strategy is not a result. This is not another thousand — a thousand more
// would only raise the noise bar, which is already t≈3.9. It is 213 placed where
// the fleet cannot currently answer the question it is being asked.
const GRID9: Spec[] = [];
const n9 = (x: number) => String(x).replace('.', '');

// ── A. Deep dip sweep, 45-70% (75) ──────────────────────────
// Nothing beyond -40% exists. A -60% pullback on a coin that recovers is the
// cheapest entry available; the question is how often it recovers at all, and
// right now the fleet cannot say.
for (const dp of [45, 50, 55, 60, 70]) {
  for (const tgt of [1.5, 2, 2.5, 3, 4]) {
    for (const [sn, st] of [['off', 0.05], ['s60', 0.40], ['s75', 0.25]] as [string, number][]) {
      GRID9.push({
        key: `g9D${dp}_${n9(tgt)}${sn}`,
        name: `Dip −${dp}% → ${tgt}X${sn === 'off' ? ', no stop' : `, stop −${Math.round((1 - st) * 100)}%`}`,
        desc: `Waits for a −${dp}% flush before buying. Deeper than anything the fleet has tested; the −31-45% band is the only positive one so far.`,
        dip: dp / 100, win: 15, tps: [[tgt, 1]], stop: st,
      });
    }
  }
}

// ── B. The stop-width hole, -60% to -95% (60) ───────────────
// The fleet jumps straight from -60% to -95% with nothing in between, so "how wide
// is wide enough" has no answer. Swept across entry depths so the result is not
// confounded with the entry.
for (const [sn, st] of [['s60', 0.40], ['s70', 0.30], ['s80', 0.20], ['off', 0.05]] as [string, number][]) {
  for (const dp of [0, 10, 20, 30, 40]) {
    for (const tgt of [1.5, 2, 3]) {
      GRID9.push({
        key: `g9S${sn}_${dp}_${n9(tgt)}`,
        name: `${dp ? `Dip −${dp}%` : 'Instant'} → ${tgt}X, ${sn === 'off' ? 'no stop' : `stop −${Math.round((1 - st) * 100)}%`}`,
        desc: `Fills the −60% to −95% gap in stop width. Strategies with the stop effectively off are the only profitable group so far, and nothing sits between them and −60%.`,
        dip: dp ? dp / 100 : undefined, win: dp ? 15 : undefined,
        tps: [[tgt, 1]], stop: st,
      });
    }
  }
}

// ── C. Deep dip + free tail (48) ────────────────────────────
// Zero of these exist. "Dip −25% → 75%@1.5X + free tail" runs +0.1440 at an 86% win
// rate, and a deep entry should make the tail cheaper still — the bank leg covers
// the trade sooner, so the runner costs less to hold.
for (const dp of [35, 40, 50, 60]) {
  for (const at of [1.5, 2, 2.5]) {
    for (const tail of [5, 10]) {
      for (const bank of [0.8, 0.9]) {
        GRID9.push({
          key: `g9T${dp}_${n9(at)}_${tail}_${Math.round(bank * 100)}`,
          name: `Dip −${dp}% → ${Math.round(bank * 100)}%@${at}X + ${Math.round((1 - bank) * 100)}% to ${tail}X`,
          desc: `Deep entry, banks ${Math.round(bank * 100)}% at ${at}X, leaves the rest running to ${tail}X. No deep-dip strategy currently leaves anything running.`,
          dip: dp / 100, win: 15,
          tps: [[at, bank], [tail, 1 - bank]], stop: 0.05, be: true,
        });
      }
    }
  }
}

// ── D. How long is a deep dip worth waiting for? (30) ───────
// Short windows won on shallow dips, but a −55% flush plausibly needs longer to
// arrive. That is an assumption until it is swept, so sweep it.
for (const dp of [35, 45, 55]) {
  for (const w of [3, 5, 10, 20, 30]) {
    for (const tgt of [2, 3]) {
      GRID9.push({
        key: `g9W${dp}_${w}_${n9(tgt)}`,
        name: `Dip −${dp}% in ${w}m → ${tgt}X, no stop`,
        desc: `A −${dp}% flush inside ${w} minutes. Short windows beat long ones on shallow dips; whether that survives at this depth is untested.`,
        dip: dp / 100, win: w, tps: [[tgt, 1]], stop: 0.05,
      });
    }
  }
}

GRID.push(...GRID9);

// ── GRID10 (214) ────────────────────────────────────────────
//
// Targeted at holes, not breadth. Two regions in the fleet beat the base rate by an
// order of magnitude, and the obvious combination of them does not exist:
//
//   instant + hold <= 3 min     23 of 48 clear fees (47%)   base rate 3%
//   dip 30-45% + trail 10-20%    6 of 15 clear fees (40%)   base rate 3%
//   hold <= 3 min WITH a trail   0 strategies
//   trail 12-16% + a time cap    0 strategies
//
// Both regions are also what the captured price paths independently predict: median
// time-to-peak is 3 minutes and median pre-peak dip is 0.712x. A short clock and a
// trail are two ways of saying the same thing — leave while the move is still
// happening — and nothing tests them together.
//
// No single strategy in the fleet clears the noise bar (best t=2.72 against 3.90 for
// 1,982 candidates) and adding more raises that bar. These are placed to make the
// two regions decidable, not to find a new leader.
const GRID10: Spec[] = [];
const n10 = (x: number) => String(x).replace('.', '');

// ── A. Short clock crossed with a trail (48) ────────────────
// The gap that matters most: a clock caps how long the edge is given to decay, a
// trail caps how much of a move is given back. They fail in different ways, so a
// coin that peaks at 90 seconds and one that grinds up for ten minutes are handled
// by different halves.
for (const hold of [1, 2, 3, 5]) {
  for (const tr of [8, 10, 12, 15, 20]) {
    for (const [en, dip] of [['i', 0], ['d20', 0.20]] as [string, number][]) {
      if (GRID10.length >= 48) break;
      GRID10.push({
        key: `gA${hold}t${tr}${en}`,
        name: `${dip ? 'Dip −20%' : 'Instant'} → trail ${tr}% or ${hold}m`,
        desc: `Trails at ${tr}% and closes at ${hold} minute${hold === 1 ? '' : 's'} regardless. Median time-to-peak is 3 minutes; a clock and a trail cap different failures and nothing in the fleet combines them.`,
        dip: dip || undefined, win: dip ? 10 : undefined,
        hold, trail: tr / 100, trailFrom: 'entry', stop: (100 - tr) / 100,
      });
    }
  }
}

// ── B. The contested trail band, with a cap (40) ────────────
// 12-16% is where the fleet's sampled prices and the true-candle simulator disagree
// most — one says tighter is better, the other says this band. Neither has a version
// with a time cap, which is the cheapest way to stop that argument mattering.
for (const tr of [12, 13, 14, 15, 16]) {
  for (const hold of [2, 3, 5, 10]) {
    for (const [en, dip] of [['i', 0], ['d30', 0.30]] as [string, number][]) {
      if (GRID10.filter(g => g.key.startsWith('gB')).length >= 40) break;
      GRID10.push({
        key: `gB${tr}h${hold}${en}`,
        name: `${dip ? 'Dip −30%' : 'Instant'} → trail ${tr}%, cap ${hold}m`,
        desc: `The band where the two measurement methods disagree, with a ${hold}-minute cap so the disagreement matters less.`,
        dip: dip || undefined, win: dip ? 10 : undefined,
        hold, trail: tr / 100, trailFrom: 'entry', stop: (100 - tr) / 100,
      });
    }
  }
}

// ── C. Deep dip × tight trail, properly covered (72) ────────
// The strongest region in the fleet and the thinnest — fifteen strategies carrying
// a 40% clear rate. A deep entry buys the discount a stop would otherwise have to
// protect, which is why the tight trail survives here and not on instant entries.
for (const dp of [30, 35, 40, 45]) {
  for (const tr of [8, 10, 12, 15, 18, 20]) {
    for (const [tn, tp] of [['0', 0], ['15', 1.5], ['2', 2]] as [string, number][]) {
      GRID10.push({
        key: `gC${dp}t${tr}${tn}`,
        name: `Dip −${dp}% → ${tp ? `50%@${tp}X + ` : ''}trail ${tr}%`,
        desc: `Deep entry with a tight trail — the fleet's best region at 40% clearing fees, and only fifteen strategies covering it.`,
        dip: dp / 100, win: 12,
        tps: tp ? [[tp, 0.5]] : undefined,
        trail: tr / 100, trailFrom: 'entry', stop: (100 - tr) / 100,
      });
    }
  }
}

// ── D. Short clock × stop width (54) ────────────────────────
// Extends the family that actually produced the survivors — eleven of the
// twenty-one were instant with a 1-3 minute clock and a stop of 12% or 25%. Nothing
// sits between those two stop widths, and nothing pairs the clock with a target.
for (const hold of [1, 2, 3]) {
  for (const st of [10, 12, 15, 18, 20, 25]) {
    for (const [tn, tp] of [['0', 0], ['16', 1.6], ['2', 2]] as [string, number][]) {
      GRID10.push({
        key: `gD${hold}s${st}${tn}`,
        name: `Instant → ${tp ? `${tp}X or ` : ''}${hold}m, stop −${st}%`,
        desc: `The shape that produced most of the fleet's survivors, filled in between the −12% and −25% stops that were tested and the gap between them that was not.`,
        hold, tps: tp ? [[tp, 1]] : undefined, stop: (100 - st) / 100,
      });
    }
  }
}

// ── E. Bank early, trail wide (24) ──────────────────────────
// A wide trail cannot profit on its own: it exits at peak x (1 - trail), so a 45%
// trail needs a 1.82x peak just to break even and the median call peaks at 1.65x.
// Every pure-trail setting at 30% or wider is negative across the fleet.
//
// The way a wide trail earns its keep is to stop being the thing that books the
// profit. Sell most of the position into the first real move, then let a loose
// trail carry a small remainder as a free option on the coins that keep going.
// This sweeps how much to bank and how early, at trails that stay 30% or wider.
for (const [tn, tp] of [['125', 1.25], ['14', 1.4], ['16', 1.6], ['18', 1.8]] as [string, number][]) {
  for (const sell of [40, 60, 80]) {
    for (const tr of [30, 45]) {
      GRID10.push({
        key: `gE${tn}s${sell}t${tr}`,
        name: `${sell}% @ ${tp}X → trail ${tr}%`,
        desc: `Books ${sell}% of the position at ${tp}X and lets the rest ride a ${tr}% trail. Tests whether a wide trail is workable once it is no longer responsible for booking the gain.`,
        tps: [[tp, sell / 100]], trail: tr / 100, stop: 0.75,
      });
    }
  }
}

// ── F. Two-stage ladders, wide trail (8) ────────────────────
// The live ladder puts its first rung at 1.55x and only 10% of the position on it,
// so 90% is still exposed when the coin turns. These move the weight forward.
for (const [key, label, tps] of [
  ['a', '40% @ 1.3X + 30% @ 2X', [[1.3, 0.40] as [number, number], [2.0, 0.30] as [number, number]]],
  ['b', '50% @ 1.4X + 25% @ 2.5X', [[1.4, 0.50] as [number, number], [2.5, 0.25] as [number, number]]],
  ['c', '30% @ 1.25X + 40% @ 1.8X', [[1.25, 0.30] as [number, number], [1.8, 0.40] as [number, number]]],
  ['d', '50% @ 1.5X + 25% @ 3X', [[1.5, 0.50] as [number, number], [3.0, 0.25] as [number, number]]],
] as [string, string, [number, number][]][]) {
  for (const tr of [30, 45]) {
    GRID10.push({
      key: `gF${key}t${tr}`,
      name: `${label} → trail ${tr}%`,
      desc: `Weight moved to the front of the ladder so the trail only ever manages a remainder. The live ladder risks 90% of the position past its first rung.`,
      tps, trail: tr / 100, stop: 0.75,
    });
  }
}

// ── G. Break-even after the first rung (8) ──────────────────
// Once the first TP has landed the position is playing with house money, and a stop
// pulled up to entry converts every survivor into at-worst-flat. Costs some winners
// that dip and recover; the question is whether it costs more than it saves.
for (const [tn, tp] of [['13', 1.3], ['15', 1.5]] as [string, number][]) {
  for (const sell of [40, 60]) {
    for (const tr of [30, 45]) {
      GRID10.push({
        key: `gG${tn}s${sell}t${tr}`,
        name: `${sell}% @ ${tp}X, BE stop → trail ${tr}%`,
        desc: `Sells ${sell}% at ${tp}X and pulls the stop to entry. The remainder can then only end flat or up, at the cost of being shaken out by a normal retrace.`,
        tps: [[tp, sell / 100]], trail: tr / 100, stop: 0.75, be: true,
      });
    }
  }
}

// ── H. Clock plus a wide trail (6) ──────────────────────────
// 99% of these coins peak inside five minutes and the median is at 0.54x by minute
// fifteen. A clock is a blunt instrument but it is pointed at a real fact.
for (const hold of [3, 5, 10]) {
  for (const tr of [30, 45]) {
    GRID10.push({
      key: `gH${hold}t${tr}`,
      name: `60% @ 1.4X → trail ${tr}%, ${hold}m clock`,
      desc: `Banks 60% at 1.4X, trails the rest, and closes anything still open after ${hold} minutes. Built on the measurement that the top is almost always inside the first five.`,
      tps: [[1.4, 0.60]], trail: tr / 100, stop: 0.75, hold,
    });
  }
}

// ── I. Dip entry with an early bank (6) ─────────────────────
// Every dip-entry family in the fleet beats every instant-entry family, and the
// decay curve says why: the median coin is at 0.85x five minutes after the call, so
// an instant fill is close to the worst price available in its life.
for (const dip of [20, 30]) {
  for (const tr of [30, 45]) {
    GRID10.push({
      key: `gI${dip}t${tr}`,
      name: `Dip −${dip}% → 50% @ 1.3X + trail ${tr}%`,
      desc: `Waits for a −${dip}% dip, banks half at 1.3X from that lower basis, trails the rest at ${tr}%. Fills on roughly two thirds of calls; the rest cost nothing.`,
      dip: dip / 100, win: 30, tps: [[1.3, 0.50]], trail: tr / 100, stop: 0.75,
    });
  }
}
for (const dip of [20, 30]) {
  GRID10.push({
    key: `gI${dip}x`,
    name: `Dip −${dip}% → 70% @ 1.5X + trail 30%`,
    desc: `The same entry with more banked and later. Tests whether the dip basis buys enough room to wait for a bigger first rung.`,
    dip: dip / 100, win: 30, tps: [[1.5, 0.70]], trail: 0.30, stop: 0.75,
  });
}

// ── J. Stop width under an early-bank ladder (5) ────────────
// Stop width has never been swept while a front-loaded ladder was running. A tight
// stop should be cheaper here, because the ladder has already taken risk off.
for (const st of [15, 20, 25, 35, 50]) {
  GRID10.push({
    key: `gJs${st}`,
    name: `60% @ 1.4X → trail 30%, stop −${st}%`,
    desc: `Holds the ladder and the trail fixed and moves only the stop, so the stop's contribution can be read on its own.`,
    tps: [[1.4, 0.60]], trail: 0.30, stop: (100 - st) / 100,
  });
}

GRID.push(...GRID10);







for (const g of GRID) {
  STRATEGY_PRESETS[g.key] = {
    name: g.name,
    desc: g.desc,
    make: () => ({
      ...BASE,
      preset: g.key,
      entryMode: g.dip ? ('dip' as const) : ('instant' as const),
      dipPct: g.dip ?? 0.2,
      dipWindowMin: g.win ?? 30,
      maxHoldMin: g.hold ?? 0,
      tps: (g.tps ?? []).map(([mult, sellPct]) => ({ mult, sellPct })),
      // No trail configured => keep trailing OFF (armed only after TPs) so stopLossPct
      // is the real stop. Otherwise trailing-from-entry would override it.
      trailingDrop: g.trail ?? 0.9,
      trailingFrom: g.trail ? (g.trailFrom ?? ('entry' as const)) : ('afterLastTp' as const),
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
    maxHoldMin: clamp(s.maxHoldMin, 0, 1440, 0),
    tps,
    trailingDrop,
    trailingFrom: s.trailingFrom === 'afterLastTp' ? 'afterLastTp' : 'entry',
    // If trailing runs from entry it IS the stop, so keep the two consistent —
    // otherwise a strategy advertising "stop −20%" silently runs at −80%.
    stopLossPct: s.trailingFrom === 'entry'
      ? Math.max(clamp(s.stopLossPct, 0.05, 0.99, 1 - trailingDrop), 1 - trailingDrop)
      : clamp(s.stopLossPct, 0.05, 0.99, 1 - trailingDrop),
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
