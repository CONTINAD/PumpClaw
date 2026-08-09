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
  hyb2: {
    name: '50% @ 2X + trail',
    desc: 'Bank 50% at 2X, trail the remaining half at −45% from entry.',
    make: () => ({ ...BASE, preset: 'hyb2', tps: [{ mult: 2, sellPct: 0.5 }], trailingDrop: 0.45, trailingFrom: 'entry', stopLossPct: 0.55, breakEvenAfterTp1: false }),
  },
};

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
