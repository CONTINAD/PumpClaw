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
  /** UTC hour the coin was observed. Time-of-day showed a 14-point spread across
   *  303 calls and nothing in the system could express a rule about it. */
  hourUtc?: number;
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
// ══════════════════════════════════════════════════════════════════════════
  // Second wave. The first thirty were guesses spread across seven ideas; these
  // come out of a sweep of 41 signals over 303 graded calls, so each one is here
  // because something in the data pointed at it.
  // ══════════════════════════════════════════════════════════════════════════

  // ── The dead band ──
  // Sell/buy pressure is the strongest signal in the call set and it is NOT
  // monotonic. Coins arriving between 0.85 and 0.95 hit 2x 34% of the time; the
  // band immediately above hits 69%. Fitted on the first half of the sample and
  // reproduced at -22.4pt on the second half it had never seen.
  { key: 'dz1h', name: 'sell/buy 1h outside 0.85-0.95', group: 'deadband', pass: s => { const x = r(s.sells1h, s.buys1h); return x === null ? null : !(x > 0.85 && x <= 0.95); } },
  { key: 'dz5m', name: 'sell/buy 5m outside 0.85-0.95', group: 'deadband', pass: s => { const x = r(s.sells5m, s.buys5m); return x === null ? null : !(x > 0.85 && x <= 0.95); } },
  { key: 'dzBoth', name: 'both windows outside the dead band', group: 'deadband', pass: s => { const a = r(s.sells1h, s.buys1h), b = r(s.sells5m, s.buys5m); return a === null || b === null ? null : !(a > 0.85 && a <= 0.95) && !(b > 0.85 && b <= 0.95); } },
  { key: 'dzWide', name: 'sell/buy 1h outside 0.80-1.00', group: 'deadband', pass: s => { const x = r(s.sells1h, s.buys1h); return x === null ? null : !(x > 0.80 && x <= 1.00); } },
  { key: 'dzNarrow', name: 'sell/buy 1h outside 0.88-0.93', group: 'deadband', pass: s => { const x = r(s.sells1h, s.buys1h); return x === null ? null : !(x > 0.88 && x <= 0.93); } },

  // ── The good side of the band ──
  // 0.95-1.05 was the best bucket in the whole sweep at 69%. These test how far
  // above it the edge runs, which the live HEAVY_SELLING cut at 1.3 hides.
  { key: 'hot95', name: 'sell/buy 1h >= 0.95', group: 'pressure2', pass: s => { const x = r(s.sells1h, s.buys1h); return x === null ? null : x >= 0.95; } },
  { key: 'hot90', name: 'sell/buy 1h >= 0.90', group: 'pressure2', pass: s => { const x = r(s.sells1h, s.buys1h); return x === null ? null : x >= 0.90; } },
  { key: 'hot100', name: 'sell/buy 1h >= 1.00', group: 'pressure2', pass: s => { const x = r(s.sells1h, s.buys1h); return x === null ? null : x >= 1.00; } },
  { key: 'hotBand', name: 'sell/buy 1h in 0.95-1.30', group: 'pressure2', pass: s => { const x = r(s.sells1h, s.buys1h); return x === null ? null : x >= 0.95 && x <= 1.30; } },
  { key: 'calm70', name: 'sell/buy 1h <= 0.70 (barely sold yet)', group: 'pressure2', pass: s => { const x = r(s.sells1h, s.buys1h); return x === null ? null : x <= 0.70; } },
  { key: 'barbell', name: 'sell/buy 1h >= 0.95 OR <= 0.70', group: 'pressure2', pass: s => { const x = r(s.sells1h, s.buys1h); return x === null ? null : x >= 0.95 || x <= 0.70; } },

  // ── Churn ──
  // Volume many times the market cap in an hour is not interest, it is the same
  // money going round. vol1h/MC above 2.9 marked the worst calls in the sweep.
  { key: 'ch29', name: '1h volume/MC <= 2.9', group: 'churn', pass: s => { const x = r(s.vol1h, s.mc); return x === null ? null : x <= 2.9; } },
  { key: 'ch15', name: '1h volume/MC <= 1.5', group: 'churn', pass: s => { const x = r(s.vol1h, s.mc); return x === null ? null : x <= 1.5; } },
  { key: 'ch50', name: '1h volume/MC <= 5.0', group: 'churn', pass: s => { const x = r(s.vol1h, s.mc); return x === null ? null : x <= 5.0; } },
  { key: 'chBand', name: '1h volume/MC between 0.3 and 2.9', group: 'churn', pass: s => { const x = r(s.vol1h, s.mc); return x === null ? null : x >= 0.3 && x <= 2.9; } },
  { key: 'vm5cap', name: 'vol5m/MC between 0.5 and 2.2', group: 'churn', pass: s => { const x = r(s.vol5m, s.mc); return x === null ? null : x >= 0.5 && x <= 2.2; } },

  // ── The wash signature ──
  // Sugar and MMC both printed five-figure volume against $0 reported liquidity
  // and realised 0.885x and 0.667x. Their charts were fiction. This is the cheapest
  // test for it, and the liquidity floor at index.ts:491 lets $0 straight through.
  { key: 'washNo', name: 'not (volume with $0 liquidity)', group: 'wash', pass: s => (s.vol5m > 0 ? s.liq > 0 : null) },
  { key: 'washFresh', name: 'not ($0 liq AND fresh-wallet majority)', group: 'wash', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); if (t <= 0) return null; return !(s.liq <= 0 && (s.freshWallets ?? 0) / t > 0.5); } },
  { key: 'realLiq', name: 'liquidity at least 5% of MC', group: 'wash', pass: s => { const x = r(s.liq, s.mc); return x === null ? null : x >= 0.05; } },

  // ── Liquidity, as a band rather than a floor ──
  // >$10K scored +0.670 edge and >$20K scored -0.464. That is not a floor, it is
  // a window, and no live filter can express one.
  { key: 'lqWin', name: 'liquidity $10K-$20K', group: 'liquidity2', pass: s => (s.liq > 0 ? s.liq >= 10_000 && s.liq <= 20_000 : null) },
  { key: 'lq15', name: 'liquidity >= $15K', group: 'liquidity2', pass: s => (s.liq > 0 ? s.liq >= 15_000 : null) },
  { key: 'lqWide', name: 'liquidity $8K-$30K', group: 'liquidity2', pass: s => (s.liq > 0 ? s.liq >= 8_000 && s.liq <= 30_000 : null) },

  // ── Trade shape ──
  // Average trade size separates a coin being accumulated from one being farmed
  // by a script running hundreds of dust trades.
  { key: 'avgTr', name: 'avg 5m trade > $40', group: 'shape', pass: s => { const n = s.buys5m + s.sells5m; return n > 0 ? s.vol5m / n > 40 : null; } },
  { key: 'avgTrBig', name: 'avg 5m trade > $80', group: 'shape', pass: s => { const n = s.buys5m + s.sells5m; return n > 0 ? s.vol5m / n > 80 : null; } },
  { key: 'notFarm', name: 'under 400 trades in 5m', group: 'shape', pass: s => (s.buys5m + s.sells5m > 0 ? s.buys5m + s.sells5m < 400 : null) },
  { key: 'trPace', name: '5m trade pace > 1h pace', group: 'shape', pass: s => { const h = s.buys1h + s.sells1h; return h > 0 ? (s.buys5m + s.sells5m) * 12 > h : null; } },
  { key: 'trCalm', name: 'under 1200 trades in 1h', group: 'shape', pass: s => (s.buys1h + s.sells1h > 0 ? s.buys1h + s.sells1h < 1200 : null) },

  // ── Holder mix ──
  // Fresh-wallet majority reads as a bundle signature and predicted BETTER outcomes
  // (+15.2pt on calls with a real holder read). Counterintuitive enough to measure
  // properly rather than argue about.
  { key: 'fr30', name: 'fresh-wallet share > 30%', group: 'holders', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.freshWallets ?? 0) / t > 0.30 : null; } },
  { key: 'fr50', name: 'fresh-wallet share > 50%', group: 'holders', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.freshWallets ?? 0) / t > 0.50 : null; } },
  { key: 'vetLite', name: 'under 12 veteran holders', group: 'holders', pass: s => (s.veterans != null ? s.veterans < 12 : null) },
  { key: 'dev2', name: 'dev holds under 2%', group: 'holders', pass: s => (s.devHoldPct != null ? s.devHoldPct < 2 : null) },
  { key: 'funder20', name: 'same-funder under 20%', group: 'holders', pass: s => (s.sameFunderPct != null ? s.sameFunderPct < 20 : null) },

  // ── Time of day ──
  // 18:00-23:59 UTC hit 2x 60% against 46% for the rest of the day, independent of
  // the pressure signal. Half-replicated on holdout, so it is measured, not trusted.
  { key: 'evening', name: '18:00-23:59 UTC', group: 'clock', pass: s => (s.hourUtc != null ? s.hourUtc >= 18 : null) },
  { key: 'usHours', name: '14:00-23:59 UTC (US day)', group: 'clock', pass: s => (s.hourUtc != null ? s.hourUtc >= 14 : null) },
  { key: 'notDead', name: 'not 10:00-16:59 UTC', group: 'clock', pass: s => (s.hourUtc != null ? s.hourUtc < 10 || s.hourUtc >= 17 : null) },

  // ── Momentum, shaped ──
  { key: 'mom5band', name: '5m change between +10% and +150%', group: 'momentum2', pass: s => (s.chg5m != null ? s.chg5m >= 10 && s.chg5m <= 150 : null) },
  { key: 'mom1hAlive', name: '1h change above +8%', group: 'momentum2', pass: s => (s.chg1h != null ? s.chg1h > 8 : null) },
  { key: 'notParabolic', name: '1h change under +400%', group: 'momentum2', pass: s => (s.chg1h != null ? s.chg1h < 400 : null) },
  { key: 'freshMove', name: '5m move is most of the 1h move', group: 'momentum2', pass: s => (s.chg1h != null && s.chg5m != null && s.chg1h > 0 ? s.chg5m / s.chg1h > 0.4 : null) },

  // ── Stacked rules ──
  // The two that survived walk-forward independently, and the pairing that scored
  // best of any combination tested (66.7% hit-2x against a 50.2% base).
  { key: 'cmbA', name: 'dead band clear + churn cap', group: 'combo', pass: s => { const x = r(s.sells1h, s.buys1h), c = r(s.vol1h, s.mc); return x === null || c === null ? null : !(x > 0.85 && x <= 0.95) && c <= 2.9; } },
  { key: 'cmbB', name: 'sell/buy >= 0.95 + churn cap', group: 'combo', pass: s => { const x = r(s.sells1h, s.buys1h), c = r(s.vol1h, s.mc); return x === null || c === null ? null : x >= 0.95 && c <= 2.9; } },
  { key: 'cmbC', name: 'dead band clear + real liquidity', group: 'combo', pass: s => { const x = r(s.sells1h, s.buys1h); return x === null ? null : !(x > 0.85 && x <= 0.95) && s.liq > 0; } },
  { key: 'cmbD', name: 'dead band clear + evening + churn cap', group: 'combo', pass: s => { const x = r(s.sells1h, s.buys1h), c = r(s.vol1h, s.mc); if (x === null || c === null || s.hourUtc == null) return null; return !(x > 0.85 && x <= 0.95) && c <= 2.9 && s.hourUtc >= 18; } },
  { key: 'cmbE', name: 'sell/buy >= 0.95 + liq $10-20K', group: 'combo', pass: s => { const x = r(s.sells1h, s.buys1h); if (x === null || s.liq <= 0) return null; return x >= 0.95 && s.liq >= 10_000 && s.liq <= 20_000; } },
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
    hourUtc: new Date().getUTCHours(),
    ...extra,
  };
}
