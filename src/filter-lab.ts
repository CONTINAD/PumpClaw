/**
 * Filter Lab — candidate filters that reject nothing.
 *
 * The shadow fleet answers "which exit strategy would have made money" by running
 * strategies that never touch the wallet. This is the same idea pointed at the
 * other half of the problem: which ENTRY rule should we be applying.
 *
 * The design decision that matters: predicates are evaluated when the page is
 * READ, not when the coin is scanned. Every observation stores a market snapshot
 * instead, so a filter invented tomorrow is immediately measured against every
 * coin already seen rather than starting from n=0. Hard-coding pass/fail at scan
 * time would mean a month of waiting each time an idea changes by one threshold.
 *
 * Nothing here can block a buy. These are measurements.
 */

/** Everything a candidate filter is allowed to look at, frozen at observation time. */
export interface Snapshot {
  mc: number;
  liq: number;
  vol5m: number;
  vol1h: number;
  vol24h: number;
  buys5m: number;
  sells5m: number;
  buys1h: number;
  sells1h: number;
  chg5m: number;
  chg1h: number;
  chg6h: number;
  ageMin: number;
  dexId?: string;
  socials?: number;
  holders?: number;
  devHoldPct?: number;
  freshWallets?: number;
  veterans?: number;
  sameFunderPct?: number;
}

export interface Candidate {
  key: string;
  name: string;
  group: string;
  /** true = this filter would ALLOW the coin through. */
  pass: (s: Snapshot) => boolean | null;
}

const r = (a: number, b: number) => (b > 0 ? a / b : null);

/**
 * Thirty candidates across seven ideas. Thresholds are deliberately spread rather
 * than centred on a guess — the point is to find where an edge starts and stops,
 * and a single threshold per idea cannot show that.
 */
export const CANDIDATES: Candidate[] = [
  // ── Buy/sell pressure ── the live HEAVY_SELLING cut is 1.3; VC slid under it at 1.19
  { key: 'sr11', name: 'sell/buy 5m < 1.1', group: 'pressure', pass: s => { const x = r(s.sells5m, s.buys5m); return x === null ? null : x < 1.1; } },
  { key: 'sr10', name: 'sell/buy 5m < 1.0', group: 'pressure', pass: s => { const x = r(s.sells5m, s.buys5m); return x === null ? null : x < 1.0; } },
  { key: 'sr09', name: 'sell/buy 5m < 0.9', group: 'pressure', pass: s => { const x = r(s.sells5m, s.buys5m); return x === null ? null : x < 0.9; } },
  { key: 'sr1h', name: 'sell/buy 1h < 1.0', group: 'pressure', pass: s => { const x = r(s.sells1h, s.buys1h); return x === null ? null : x < 1.0; } },
  { key: 'srAcc', name: '5m pressure better than 1h', group: 'pressure', pass: s => { const a = r(s.sells5m, s.buys5m), b = r(s.sells1h, s.buys1h); return a === null || b === null ? null : a < b; } },

  // ── Volume relative to size ── the strongest hint from the 48h call sample
  { key: 'vm05', name: 'vol5m/MC > 0.5', group: 'volume', pass: s => { const x = r(s.vol5m, s.mc); return x === null ? null : x > 0.5; } },
  { key: 'vm10', name: 'vol5m/MC > 1.0', group: 'volume', pass: s => { const x = r(s.vol5m, s.mc); return x === null ? null : x > 1.0; } },
  { key: 'vm20', name: 'vol5m/MC > 2.0', group: 'volume', pass: s => { const x = r(s.vol5m, s.mc); return x === null ? null : x > 2.0; } },
  { key: 'vl30', name: 'vol5m/liq > 3', group: 'volume', pass: s => { const x = r(s.vol5m, s.liq); return x === null ? null : x > 3; } },
  { key: 'vacc', name: '5m vol pace > 1h pace', group: 'volume', pass: s => (s.vol1h > 0 ? s.vol5m > s.vol1h / 12 : null) },
  { key: 'v24', name: 'vol5m > 10% of 24h vol', group: 'volume', pass: s => (s.vol24h > 0 ? s.vol5m / s.vol24h > 0.1 : null) },

  // ── Liquidity depth ── decides the fill, which is where VC actually lost the money
  { key: 'lq10', name: 'liquidity > $10K', group: 'liquidity', pass: s => (s.liq > 0 ? s.liq > 10_000 : null) },
  { key: 'lq20', name: 'liquidity > $20K', group: 'liquidity', pass: s => (s.liq > 0 ? s.liq > 20_000 : null) },
  { key: 'lm15', name: 'liq/MC > 0.15', group: 'liquidity', pass: s => { const x = r(s.liq, s.mc); return x === null ? null : x > 0.15; } },
  { key: 'lm30', name: 'liq/MC > 0.30', group: 'liquidity', pass: s => { const x = r(s.liq, s.mc); return x === null ? null : x > 0.30; } },
  { key: 'lmCap', name: 'liq/MC between 0.1 and 0.5', group: 'liquidity', pass: s => { const x = r(s.liq, s.mc); return x === null ? null : x > 0.1 && x < 0.5; } },

  // ── Market cap bands ── the live ceiling is $100K and nothing tests the floor
  { key: 'mc15', name: 'MC > $15K', group: 'size', pass: s => (s.mc > 0 ? s.mc > 15_000 : null) },
  { key: 'mc25', name: 'MC > $25K', group: 'size', pass: s => (s.mc > 0 ? s.mc > 25_000 : null) },
  { key: 'mcLo', name: 'MC under $40K', group: 'size', pass: s => (s.mc > 0 ? s.mc < 40_000 : null) },
  { key: 'mcBand', name: 'MC $15K-$60K', group: 'size', pass: s => (s.mc > 0 ? s.mc > 15_000 && s.mc < 60_000 : null) },

  // ── Age ── "let it prove itself" vs "get there first"
  { key: 'ag2', name: 'older than 2 min', group: 'age', pass: s => (s.ageMin != null ? s.ageMin > 2 : null) },
  { key: 'ag5', name: 'older than 5 min', group: 'age', pass: s => (s.ageMin != null ? s.ageMin > 5 : null) },
  { key: 'ag15', name: 'older than 15 min', group: 'age', pass: s => (s.ageMin != null ? s.ageMin > 15 : null) },
  { key: 'agY', name: 'younger than 60 min', group: 'age', pass: s => (s.ageMin != null ? s.ageMin < 60 : null) },

  // ── Momentum shape ── is the move starting, or already made
  { key: 'up5', name: '5m change positive', group: 'momentum', pass: s => (s.chg5m != null ? s.chg5m > 0 : null) },
  { key: 'notRun', name: '5m change under +100%', group: 'momentum', pass: s => (s.chg5m != null ? s.chg5m < 100 : null) },
  { key: 'early', name: 'up on 5m but 1h under +200%', group: 'momentum', pass: s => (s.chg5m != null && s.chg1h != null ? s.chg5m > 0 && s.chg1h < 200 : null) },
  { key: 'noFade', name: '1h change positive', group: 'momentum', pass: s => (s.chg1h != null ? s.chg1h > 0 : null) },

  // ── Holder / launch quality ──
  { key: 'dev5', name: 'dev holds under 5%', group: 'quality', pass: s => (s.devHoldPct != null ? s.devHoldPct < 5 : null) },
  { key: 'fresh', name: 'fresh wallets under 25%', group: 'quality', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.freshWallets ?? 0) / t < 0.25 : null; } },
  { key: 'funder', name: 'same-funder under 10%', group: 'quality', pass: s => (s.sameFunderPct != null ? s.sameFunderPct < 10 : null) },
  { key: 'social', name: 'has at least one social', group: 'quality', pass: s => (s.socials != null ? s.socials > 0 : null) },
];

export function snapshotFrom(m: any, extra: Partial<Snapshot> = {}): Snapshot {
  return {
    mc: m?.marketCap ?? 0, liq: m?.liquidity ?? 0,
    vol5m: m?.volume5m ?? 0, vol1h: m?.volume1h ?? 0, vol24h: m?.volume24h ?? 0,
    buys5m: m?.buys5m ?? 0, sells5m: m?.sells5m ?? 0,
    buys1h: m?.buys1h ?? 0, sells1h: m?.sells1h ?? 0,
    chg5m: m?.priceChange5m ?? 0, chg1h: m?.priceChange1h ?? 0, chg6h: m?.priceChange6h ?? 0,
    ageMin: m?.pairCreatedAt ? Math.max(0, (Date.now() - m.pairCreatedAt) / 60_000) : 0,
    dexId: m?.dexId,
    ...extra,
  };
}
