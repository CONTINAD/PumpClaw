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
  { key: 'v2d25tp14s50', name: 'Dip −25% → tp1.4 stop −50%', desc: 'Backtest robust-avg +0.1109, 75% win on 42 real paths.', dip: 0.25, tps: [[1.4, 1]], stop: 0.5 },
  { key: 'v2d30tp14s50', name: 'Dip −30% → tp1.4 stop −50%', desc: 'Backtest robust-avg +0.1045, 74% win on 42 real paths.', dip: 0.3, tps: [[1.4, 1]], stop: 0.5 },
  { key: 'v2d30tp15s50', name: 'Dip −30% → tp1.5 stop −50%', desc: 'Backtest robust-avg +0.0938, 67% win on 42 real paths.', dip: 0.3, tps: [[1.5, 1]], stop: 0.5 },
  { key: 'v2d10tp175s30', name: 'Dip −10% → tp1.75 stop −30%', desc: 'Backtest robust-avg +0.0860, 45% win on 42 real paths.', dip: 0.1, tps: [[1.75, 1]], stop: 0.7 },
  { key: 'v2d25tp13s50', name: 'Dip −25% → tp1.3 stop −50%', desc: 'Backtest robust-avg +0.0824, 80% win on 42 real paths.', dip: 0.25, tps: [[1.3, 1]], stop: 0.5 },
  { key: 'v2d15tp175s30', name: 'Dip −15% → tp1.75 stop −30%', desc: 'Backtest robust-avg +0.0601, 43% win on 42 real paths.', dip: 0.15, tps: [[1.75, 1]], stop: 0.7 },
  { key: 'v2d20tp2s30', name: 'Dip −20% → tp2 stop −30%', desc: 'Backtest robust-avg +0.0564, 36% win on 42 real paths.', dip: 0.2, tps: [[2, 1]], stop: 0.7 },
  { key: 'v2d30tp13s50', name: 'Dip −30% → tp1.3 stop −50%', desc: 'Backtest robust-avg +0.0564, 77% win on 42 real paths.', dip: 0.3, tps: [[1.3, 1]], stop: 0.5 },
  { key: 'v2d20tp13s50', name: 'Dip −20% → tp1.3 stop −50%', desc: 'Backtest robust-avg +0.0515, 76% win on 42 real paths.', dip: 0.2, tps: [[1.3, 1]], stop: 0.5 },
  { key: 'v2d25tp15s50', name: 'Dip −25% → tp1.5 stop −50%', desc: 'Backtest robust-avg +0.0512, 63% win on 42 real paths.', dip: 0.25, tps: [[1.5, 1]], stop: 0.5 },
  { key: 'v2d15tp175s20', name: 'Dip −15% → tp1.75 stop −20%', desc: 'Backtest robust-avg +0.0491, 36% win on 42 real paths.', dip: 0.15, tps: [[1.75, 1]], stop: 0.8 },
  { key: 'v2d22tp14s50', name: 'Dip −22% → tp1.4 stop −50%', desc: 'Backtest robust-avg +0.0489, 68% win on 42 real paths.', dip: 0.22, tps: [[1.4, 1]], stop: 0.5 },
  { key: 'v2d25tp13s40', name: 'Dip −25% → tp1.3 stop −40%', desc: 'Backtest robust-avg +0.0487, 73% win on 42 real paths.', dip: 0.25, tps: [[1.3, 1]], stop: 0.6 },
  { key: 'v2d22tp13s50', name: 'Dip −22% → tp1.3 stop −50%', desc: 'Backtest robust-avg +0.0463, 76% win on 42 real paths.', dip: 0.22, tps: [[1.3, 1]], stop: 0.5 },
  { key: 'v2d30tp14s40', name: 'Dip −30% → tp1.4 stop −40%', desc: 'Backtest robust-avg +0.0458, 64% win on 42 real paths.', dip: 0.3, tps: [[1.4, 1]], stop: 0.6 },
  { key: 'v2d20tp2s15', name: 'Dip −20% → tp2 stop −15%', desc: 'Backtest robust-avg +0.0429, 26% win on 42 real paths.', dip: 0.2, tps: [[2, 1]], stop: 0.85 },
  { key: 'v2d22tp2s20', name: 'Dip −22% → tp2 stop −20%', desc: 'Backtest robust-avg +0.0413, 29% win on 42 real paths.', dip: 0.22, tps: [[2, 1]], stop: 0.8 },
  { key: 'v2d20tp2s20', name: 'Dip −20% → tp2 stop −20%', desc: 'Backtest robust-avg +0.0343, 29% win on 42 real paths.', dip: 0.2, tps: [[2, 1]], stop: 0.8 },
  { key: 'v2d20tp14s50', name: 'Dip −20% → tp1.4 stop −50%', desc: 'Backtest robust-avg +0.0343, 67% win on 42 real paths.', dip: 0.2, tps: [[1.4, 1]], stop: 0.5 },
  { key: 'v2d25tp14s40', name: 'Dip −25% → tp1.4 stop −40%', desc: 'Backtest robust-avg +0.0331, 63% win on 42 real paths.', dip: 0.25, tps: [[1.4, 1]], stop: 0.6 },
  { key: 'v2d20tp12s50', name: 'Dip −20% → tp1.2 stop −50%', desc: 'Backtest robust-avg +0.0318, 83% win on 42 real paths.', dip: 0.2, tps: [[1.2, 1]], stop: 0.5 },
  { key: 'v2d18tp13s50', name: 'Dip −18% → tp1.3 stop −50%', desc: 'Backtest robust-avg +0.0318, 74% win on 42 real paths.', dip: 0.18, tps: [[1.3, 1]], stop: 0.5 },
  { key: 'v2d10tp175s40', name: 'Dip −10% → tp1.75 stop −40%', desc: 'Backtest robust-avg +0.0294, 45% win on 42 real paths.', dip: 0.1, tps: [[1.75, 1]], stop: 0.6 },
  { key: 'v2d10tp15s30', name: 'Dip −10% → tp1.5 stop −30%', desc: 'Backtest robust-avg +0.0269, 50% win on 42 real paths.', dip: 0.1, tps: [[1.5, 1]], stop: 0.7 },
  { key: 'v2d10tp175s20', name: 'Dip −10% → tp1.75 stop −20%', desc: 'Backtest robust-avg +0.0257, 33% win on 42 real paths.', dip: 0.1, tps: [[1.75, 1]], stop: 0.8 },
  { key: 'v2d10tp2s30', name: 'Dip −10% → tp2 stop −30%', desc: 'Backtest robust-avg +0.0244, 33% win on 42 real paths.', dip: 0.1, tps: [[2, 1]], stop: 0.7 },
  { key: 'v2d18tp2s30', name: 'Dip −18% → tp2 stop −30%', desc: 'Backtest robust-avg +0.0244, 33% win on 42 real paths.', dip: 0.18, tps: [[2, 1]], stop: 0.7 },
  { key: 'v2d20tp15s50', name: 'Dip −20% → tp1.5 stop −50%', desc: 'Backtest robust-avg +0.0220, 60% win on 42 real paths.', dip: 0.2, tps: [[1.5, 1]], stop: 0.5 },
  { key: 'v2d22tp14s40', name: 'Dip −22% → tp1.4 stop −40%', desc: 'Backtest robust-avg +0.0211, 61% win on 42 real paths.', dip: 0.22, tps: [[1.4, 1]], stop: 0.6 },
  { key: 'v2d25tp15s40', name: 'Dip −25% → tp1.5 stop −40%', desc: 'Backtest robust-avg +0.0201, 55% win on 42 real paths.', dip: 0.25, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'v2d20tp15s40', name: 'Dip −20% → tp1.5 stop −40%', desc: 'Backtest robust-avg +0.0195, 55% win on 42 real paths.', dip: 0.2, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'v2d20split122s30', name: 'Dip −20% → split1.2/2 stop −30%', desc: 'Backtest robust-avg +0.0183, 36% win on 42 real paths.', dip: 0.2, tps: [[1.2, 0.5], [2, 0.5]], stop: 0.7 },
  { key: 'v2d15tp175s15', name: 'Dip −15% → tp1.75 stop −15%', desc: 'Backtest robust-avg +0.0158, 29% win on 42 real paths.', dip: 0.15, tps: [[1.75, 1]], stop: 0.85 },
  { key: 'v2d18tp12s50', name: 'Dip −18% → tp1.2 stop −50%', desc: 'Backtest robust-avg +0.0146, 81% win on 42 real paths.', dip: 0.18, tps: [[1.2, 1]], stop: 0.5 },
  { key: 'v2d20split122s50', name: 'Dip −20% → split1.2/2 stop −50%', desc: 'Backtest robust-avg +0.0146, 40% win on 42 real paths.', dip: 0.2, tps: [[1.2, 0.5], [2, 0.5]], stop: 0.5 },
  { key: 'v2d20sc701325s50', name: 'Dip −20% → sc70@1.3+2.5 stop −50%', desc: 'Backtest robust-avg +0.0131, 76% win on 42 real paths.', dip: 0.2, tps: [[1.3, 0.7], [2.5, 0.3]], stop: 0.5 },
  { key: 'v2d22tp12s50', name: 'Dip −22% → tp1.2 stop −50%', desc: 'Backtest robust-avg +0.0109, 80% win on 42 real paths.', dip: 0.22, tps: [[1.2, 1]], stop: 0.5 },
  { key: 'v2d10tp15s20', name: 'Dip −10% → tp1.5 stop −20%', desc: 'Backtest robust-avg +0.0097, 40% win on 42 real paths.', dip: 0.1, tps: [[1.5, 1]], stop: 0.8 },
  { key: 'v2d20tp14s40', name: 'Dip −20% → tp1.4 stop −40%', desc: 'Backtest robust-avg +0.0097, 60% win on 42 real paths.', dip: 0.2, tps: [[1.4, 1]], stop: 0.6 },
  { key: 'v2d20tp175s30', name: 'Dip −20% → tp1.75 stop −30%', desc: 'Backtest robust-avg +0.0084, 38% win on 42 real paths.', dip: 0.2, tps: [[1.75, 1]], stop: 0.7 },
  { key: 'v2d30tp14s30', name: 'Dip −30% → tp1.4 stop −30%', desc: 'Backtest robust-avg +0.0084, 54% win on 42 real paths.', dip: 0.3, tps: [[1.4, 1]], stop: 0.7 },
  { key: 'v2d10tp15s15', name: 'Dip −10% → tp1.5 stop −15%', desc: 'Backtest robust-avg +0.0084, 36% win on 42 real paths.', dip: 0.1, tps: [[1.5, 1]], stop: 0.85 },
  { key: 'v2d30tp15s40', name: 'Dip −30% → tp1.5 stop −40%', desc: 'Backtest robust-avg +0.0084, 54% win on 42 real paths.', dip: 0.3, tps: [[1.5, 1]], stop: 0.6 },
  { key: 'v2insttp15s30', name: 'Instant → tp1.5 stop −30%', desc: 'Backtest robust-avg +0.0072, 48% win on 42 real paths.', tps: [[1.5, 1]], stop: 0.7 },
  { key: 'v2d15tp15s30', name: 'Dip −15% → tp1.5 stop −30%', desc: 'Backtest robust-avg +0.0072, 48% win on 42 real paths.', dip: 0.15, tps: [[1.5, 1]], stop: 0.7 },
  { key: 'v2d20tp13s40', name: 'Dip −20% → tp1.3 stop −40%', desc: 'Backtest robust-avg +0.0072, 67% win on 42 real paths.', dip: 0.2, tps: [[1.3, 1]], stop: 0.6 },
  { key: 'v2d25tp12s50', name: 'Dip −25% → tp1.2 stop −50%', desc: 'Backtest robust-avg +0.0071, 80% win on 42 real paths.', dip: 0.25, tps: [[1.2, 1]], stop: 0.5 },
  { key: 'v2d10tp14s15', name: 'Dip −10% → tp1.4 stop −15%', desc: 'Backtest robust-avg +0.0060, 40% win on 42 real paths.', dip: 0.1, tps: [[1.4, 1]], stop: 0.85 },
  { key: 'v2d30tp13s40', name: 'Dip −30% → tp1.3 stop −40%', desc: 'Backtest robust-avg +0.0058, 67% win on 42 real paths.', dip: 0.3, tps: [[1.3, 1]], stop: 0.6 },
  { key: 'v2d10tp14s20', name: 'Dip −10% → tp1.4 stop −20%', desc: 'Backtest robust-avg +0.0047, 45% win on 42 real paths.', dip: 0.1, tps: [[1.4, 1]], stop: 0.8 },
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
