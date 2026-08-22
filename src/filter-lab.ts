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

  // ── From the DAS holder read, which is not capped at 20 wallets ──
  /** Distinct owner wallets holding the mint. */
  deepOwners?: number;
  /** Largest group of traced wallets sharing one funding wallet. */
  deepCluster?: number;
  /** That cluster as a share of traced wallets. */
  deepClusterPct?: number;
  /** Traced wallets in no cluster at all. */
  deepIndependent?: number;
  /** Distinct funders — a farm has few, an organic holder set has many. */
  deepFunders?: number;
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
// ── The fake-chart tell ──
  // Alex flagged $QUASI and $MLM as manufactured charts. Both had the same holder
  // profile: 100% and 90% fresh wallets, 0 and 2 veterans. Across 210 calls with a
  // real holder read, a fresh share at or above 90% crashes below 0.25x **90% of the
  // time** against 57% for everything else (p=0.0045) — and 90% go under 0.15x, so
  // they do not fade, they go to nothing.
  //
  // What makes this worth a rule rather than a note: their hit-2x rate is 50%,
  // exactly the base rate. The pump prints. It is a real-looking chart that cannot
  // be sold into, which is precisely why peakMultiplier cannot see the problem and
  // why every filter keyed to upside misses it.
  //
  // Note the shape is a cliff, not a slope. The 15-70% fresh band is the BEST part
  // of the sample (54-63% hit-2x, the lowest crash rates). Only the near-total
  // absence of experienced holders is toxic, which is why the existing 'fresh
  // wallets under 25%' candidate is pointed at the wrong end of it.
  { key: 'fake90', name: 'fresh-wallet share under 90%', group: 'fakechart', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.freshWallets ?? 0) / t < 0.90 : null; } },
  { key: 'fake75', name: 'fresh-wallet share under 75%', group: 'fakechart', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.freshWallets ?? 0) / t < 0.75 : null; } },
  { key: 'fake70', name: 'fresh-wallet share under 70%  [LIVE]', group: 'fakechart', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.freshWallets ?? 0) / t < 0.70 : null; } },
  { key: 'fake70s', name: 'fresh under 70% (10+ wallets traced)', group: 'fakechart', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t >= 10 ? (s.freshWallets ?? 0) / t < 0.70 : null; } },
  { key: 'fake60', name: 'fresh-wallet share under 60%', group: 'fakechart', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.freshWallets ?? 0) / t < 0.60 : null; } },
  { key: 'fake80', name: 'fresh-wallet share under 80%', group: 'fakechart', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.freshWallets ?? 0) / t < 0.80 : null; } },
  { key: 'vet3', name: 'at least 3 veteran holders', group: 'fakechart', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.veterans ?? 0) >= 3 : null; } },
  { key: 'vet5', name: 'at least 5 veteran holders', group: 'fakechart', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.veterans ?? 0) >= 5 : null; } },
  { key: 'freshBand', name: 'fresh share between 15% and 70%', group: 'fakechart', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); if (t <= 0) return null; const f = (s.freshWallets ?? 0) / t; return f >= 0.15 && f <= 0.70; } },
  { key: 'fakeVert', name: 'not (90% fresh AND 5m over +300%)', group: 'fakechart', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); if (t <= 0 || s.chg5m == null) return null; return !((s.freshWallets ?? 0) / t >= 0.90 && s.chg5m > 300); } },
  { key: 'fakeAll', name: 'not (90% fresh AND $0 liq)', group: 'fakechart', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); if (t <= 0) return null; return !((s.freshWallets ?? 0) / t >= 0.90 && s.liq <= 0); } },
// ── Depth past the twentieth wallet ──
  // These read the DAS holder scan, which has no 20-cap, so for the first time a rule
  // can say something about cluster sizes larger than the sample the bundle check can
  // hold. Every one of these is unmeasurable with getTokenLargestAccounts.
  //
  // Note these can only be scored on calls made after the DAS scan shipped. Testing
  // them against older coins is meaningless: those launches are dead and their holders
  // have long since sold, so today's holder set says nothing about call time.
  { key: 'dpOwn40', name: 'at least 40 owner wallets', group: 'depth', pass: s => (s.deepOwners != null ? s.deepOwners >= 40 : null) },
  { key: 'dpOwn80', name: 'at least 80 owner wallets', group: 'depth', pass: s => (s.deepOwners != null ? s.deepOwners >= 80 : null) },
  { key: 'dpOwn150', name: 'at least 150 owner wallets', group: 'depth', pass: s => (s.deepOwners != null ? s.deepOwners >= 150 : null) },
  { key: 'dpClu5', name: 'no funder cluster of 5+', group: 'depth', pass: s => (s.deepCluster != null ? s.deepCluster < 5 : null) },
  { key: 'dpClu10', name: 'no funder cluster of 10+', group: 'depth', pass: s => (s.deepCluster != null ? s.deepCluster < 10 : null) },
  { key: 'dpClu20', name: 'no funder cluster of 20+', group: 'depth', pass: s => (s.deepCluster != null ? s.deepCluster < 20 : null) },
  { key: 'dpCluPct', name: 'largest cluster under 25% of holders', group: 'depth', pass: s => (s.deepClusterPct != null ? s.deepClusterPct < 25 : null) },
  { key: 'dpCluPct50', name: 'largest cluster under 50% of holders', group: 'depth', pass: s => (s.deepClusterPct != null ? s.deepClusterPct < 50 : null) },
  { key: 'dpInd20', name: 'at least 20 independent holders', group: 'depth', pass: s => (s.deepIndependent != null ? s.deepIndependent >= 20 : null) },
  { key: 'dpInd50', name: 'at least 50 independent holders', group: 'depth', pass: s => (s.deepIndependent != null ? s.deepIndependent >= 50 : null) },
  { key: 'dpFund10', name: 'at least 10 distinct funders', group: 'depth', pass: s => (s.deepFunders != null ? s.deepFunders >= 10 : null) },
  { key: 'dpFundRatio', name: 'funders at least half of traced holders', group: 'depth', pass: s => { if (s.deepFunders == null || s.deepIndependent == null || s.deepCluster == null) return null; const t = s.deepIndependent + s.deepCluster; return t > 0 ? s.deepFunders / t >= 0.5 : null; } },
  // ──────────────────────────────────────────────────────────────────────────
  // Second wave — 112 candidates, none of which blocks anything.
  //
  // The first wave answered "is the chart healthy" from a handful of angles and
  // then ran out of ideas, which is why 84 usable candidates produced exactly one
  // usable axis: wallet composition. Chart-shape rules kept scoring the same way
  // because they were all reading the same three numbers.
  //
  // These deliberately spread across dimensions the first wave never touched —
  // trade PACE rather than volume, the SHAPE of the price path across three
  // timeframes rather than its direction, per-holder economics, absolute veteran
  // counts rather than shares, venue, and combinations anchored on the one signal
  // that has already earned its place. Each returns null on missing input so a
  // thin field is reported as "no opinion" rather than scored as a pass.
  // ──────────────────────────────────────────────────────────────────────────

  // ── Trade pace: how many hands, how fast, and which way ──
  { key: 'tr50',      name: 'at least 50 trades in 5m',            group: 'pace', pass: s => (s.buys5m + s.sells5m) >= 50 },
  { key: 'tr100',     name: 'at least 100 trades in 5m',           group: 'pace', pass: s => (s.buys5m + s.sells5m) >= 100 },
  { key: 'tr200',     name: 'at least 200 trades in 5m',           group: 'pace', pass: s => (s.buys5m + s.sells5m) >= 200 },
  { key: 'trCap500',  name: 'under 500 trades in 5m',              group: 'pace', pass: s => (s.buys5m + s.sells5m) < 500 },
  { key: 'trBand2',   name: '50-400 trades in 5m',                 group: 'pace', pass: s => { const t = s.buys5m + s.sells5m; return t >= 50 && t <= 400; } },
  { key: 'trPerMin',  name: 'over 20 trades a minute',             group: 'pace', pass: s => (s.buys5m + s.sells5m) / 5 > 20 },
  { key: 'trAccel2',  name: '5m trade pace over 2x the 1h pace',   group: 'pace', pass: s => { const h = (s.buys1h + s.sells1h) / 12; return h > 0 ? (s.buys5m + s.sells5m) > h * 2 : null; } },
  { key: 'trDecel',   name: '5m trade pace under the 1h pace',     group: 'pace', pass: s => { const h = (s.buys1h + s.sells1h) / 12; return h > 0 ? (s.buys5m + s.sells5m) < h : null; } },
  { key: 'buyAccel',  name: 'buys5m over 25% of buys1h',           group: 'pace', pass: s => s.buys1h > 0 ? s.buys5m / s.buys1h > 0.25 : null },
  { key: 'sellAccel', name: 'sells5m over 25% of sells1h',         group: 'pace', pass: s => s.sells1h > 0 ? s.sells5m / s.sells1h > 0.25 : null },
  { key: 'buyShare55',name: 'buys over 55% of 5m trades',          group: 'pace', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? s.buys5m / t > 0.55 : null; } },
  { key: 'buyShare65',name: 'buys over 65% of 5m trades',          group: 'pace', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? s.buys5m / t > 0.65 : null; } },
  { key: 'buyShareLo',name: 'buys under 75% of 5m trades',         group: 'pace', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? s.buys5m / t < 0.75 : null; } },
  { key: 'trPerHold', name: 'under 4 trades per owner',            group: 'pace', pass: s => (s.deepOwners ?? 0) > 0 ? (s.buys5m + s.sells5m) / s.deepOwners! < 4 : null },

  // ── Volume time-structure: is this the first hour, or a decaying one ──
  { key: 'v1h24hi',   name: '1h volume over half the 24h volume',  group: 'vshape', pass: s => s.vol24h > 0 ? s.vol1h / s.vol24h > 0.5 : null },
  { key: 'v1h24lo',   name: '1h volume under 80% of 24h volume',   group: 'vshape', pass: s => s.vol24h > 0 ? s.vol1h / s.vol24h < 0.8 : null },
  { key: 'vFirstHr',  name: 'first hour of trading (1h = 24h vol)',group: 'vshape', pass: s => s.vol24h > 0 ? s.vol1h / s.vol24h > 0.97 : null },
  { key: 'vDecay',    name: '5m rate under 1.5x the 1h rate',      group: 'vshape', pass: s => s.vol1h > 0 ? (s.vol5m * 12) / s.vol1h < 1.5 : null },
  { key: 'vSurge2',   name: '5m rate over 2x the 1h rate',         group: 'vshape', pass: s => s.vol1h > 0 ? (s.vol5m * 12) / s.vol1h > 2 : null },
  { key: 'v24mc1',    name: '24h volume over 1x MC',               group: 'vshape', pass: s => s.mc > 0 ? s.vol24h / s.mc > 1 : null },
  { key: 'v24mcCap',  name: '24h volume under 5x MC',              group: 'vshape', pass: s => s.mc > 0 ? s.vol24h / s.mc < 5 : null },
  { key: 'v5abs25',   name: 'over $25K volume in 5m',              group: 'vshape', pass: s => s.vol5m > 25000 },
  { key: 'v5abs50',   name: 'over $50K volume in 5m',              group: 'vshape', pass: s => s.vol5m > 50000 },
  { key: 'v5cap200',  name: 'under $200K volume in 5m',            group: 'vshape', pass: s => s.vol5m < 200000 },
  { key: 'v5band',    name: '$10K-$80K volume in 5m',              group: 'vshape', pass: s => s.vol5m >= 10000 && s.vol5m <= 80000 },

  // ── Price path across all three timeframes, not just one ──
  { key: 'allUp',     name: '5m, 1h and 6h all positive',          group: 'path', pass: s => s.chg5m > 0 && s.chg1h > 0 && s.chg6h > 0 },
  { key: 'notAllDown',name: 'not all three timeframes negative',   group: 'path', pass: s => !(s.chg5m < 0 && s.chg1h < 0 && s.chg6h < 0) },
  { key: 'roundTrip', name: '6h up but 1h down (giving it back)',  group: 'path', pass: s => !(s.chg6h > 50 && s.chg1h < 0) },
  { key: 'reclaim',   name: '1h down but 5m up (turning)',         group: 'path', pass: s => s.chg1h < 0 && s.chg5m > 0 },
  { key: 'coolUp',    name: '5m positive but under +50%',          group: 'path', pass: s => s.chg5m > 0 && s.chg5m < 50 },
  { key: 'chg6hCap',  name: '6h change under +1000%',              group: 'path', pass: s => s.chg6h < 1000 },
  { key: 'chg6hPos',  name: '6h change positive',                  group: 'path', pass: s => s.chg6h > 0 },
  { key: 'lead5',     name: '5m move larger than the 1h move',     group: 'path', pass: s => s.chg5m > s.chg1h },
  { key: 'lag5',      name: '5m move smaller than the 1h move',    group: 'path', pass: s => s.chg5m < s.chg1h },
  { key: 'chgRatio',  name: '5m is 10-60% of the 1h move',         group: 'path', pass: s => s.chg1h > 0 ? (s.chg5m / s.chg1h) >= 0.1 && (s.chg5m / s.chg1h) <= 0.6 : null },
  { key: 'flat5',     name: '5m change between -5% and +5%',       group: 'path', pass: s => s.chg5m >= -5 && s.chg5m <= 5 },
  { key: 'noSpike5',  name: '5m change under +200%',               group: 'path', pass: s => s.chg5m < 200 },
  { key: 'noDump6h',  name: '6h change above -50%',                group: 'path', pass: s => s.chg6h > -50 },

  // ── Liquidity, in relation to what is trading against it ──
  { key: 'lq5',       name: 'liquidity over $5K',                  group: 'liq3', pass: s => s.liq > 5000 },
  { key: 'lq50',      name: 'liquidity over $50K',                 group: 'liq3', pass: s => s.liq > 50000 },
  { key: 'lqCap100',  name: 'liquidity under $100K',               group: 'liq3', pass: s => s.liq > 0 ? s.liq < 100000 : null },
  { key: 'lqBand2',   name: 'liquidity $8K-$40K',                  group: 'liq3', pass: s => s.liq >= 8000 && s.liq <= 40000 },
  { key: 'lqVol5',    name: 'liquidity over 30% of 5m volume',     group: 'liq3', pass: s => s.vol5m > 0 ? s.liq / s.vol5m > 0.3 : null },
  { key: 'lqVol24',   name: 'liquidity over 10% of 24h volume',    group: 'liq3', pass: s => s.vol24h > 0 ? s.liq / s.vol24h > 0.1 : null },
  { key: 'lqPerOwn',  name: 'over $80 liquidity per owner',        group: 'liq3', pass: s => (s.deepOwners ?? 0) > 0 ? s.liq / s.deepOwners! > 80 : null },
  { key: 'lqMcTight', name: 'liq/MC between 0.15 and 0.35',        group: 'liq3', pass: s => s.mc > 0 ? (s.liq / s.mc) >= 0.15 && (s.liq / s.mc) <= 0.35 : null },
  { key: 'lqMcHi',    name: 'liq/MC over 0.25',                    group: 'liq3', pass: s => s.mc > 0 ? s.liq / s.mc > 0.25 : null },

  // ── Per-holder economics: what each wallet is worth and doing ──
  { key: 'mcPerOwnCap',name: 'under $400 MC per owner',            group: 'econ', pass: s => (s.deepOwners ?? 0) > 0 ? s.mc / s.deepOwners! < 400 : null },
  { key: 'mcPerOwnFl', name: 'over $60 MC per owner',              group: 'econ', pass: s => (s.deepOwners ?? 0) > 0 ? s.mc / s.deepOwners! > 60 : null },
  { key: 'mcPerOwnBd', name: '$60-$400 MC per owner',              group: 'econ', pass: s => (s.deepOwners ?? 0) > 0 ? (s.mc / s.deepOwners!) >= 60 && (s.mc / s.deepOwners!) <= 400 : null },
  { key: 'volPerOwn',  name: 'under $200 of 5m volume per owner',  group: 'econ', pass: s => (s.deepOwners ?? 0) > 0 ? s.vol5m / s.deepOwners! < 200 : null },
  { key: 'ownVsTr',    name: 'owners over 20% of the 5m trade count', group: 'econ', pass: s => { const t = s.buys5m + s.sells5m; return (s.deepOwners ?? 0) > 0 && t > 0 ? s.deepOwners! / t > 0.2 : null; } },
  { key: 'own100',     name: 'at least 100 owner wallets',         group: 'econ', pass: s => s.deepOwners != null ? s.deepOwners >= 100 : null },
  { key: 'own200',     name: 'at least 200 owner wallets',         group: 'econ', pass: s => s.deepOwners != null ? s.deepOwners >= 200 : null },
  { key: 'ownCap300',  name: 'under 300 owner wallets',            group: 'econ', pass: s => s.deepOwners != null ? s.deepOwners < 300 : null },
  { key: 'ownBand',    name: '80-400 owner wallets',               group: 'econ', pass: s => s.deepOwners != null ? s.deepOwners >= 80 && s.deepOwners <= 400 : null },

  // ── Graph shape beyond the single largest cluster ──
  { key: 'indShare50', name: 'independent wallets over 50% of traced', group: 'graph2', pass: s => { const t = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); return t > 0 ? (s.deepIndependent ?? 0) / t > 0.5 : null; } },
  { key: 'indShare70', name: 'independent wallets over 70% of traced', group: 'graph2', pass: s => { const t = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); return t > 0 ? (s.deepIndependent ?? 0) / t > 0.7 : null; } },
  { key: 'fundPerOwn', name: 'over 0.5 funders per owner',         group: 'graph2', pass: s => (s.deepOwners ?? 0) > 0 && s.deepFunders != null ? s.deepFunders / s.deepOwners! > 0.5 : null },
  { key: 'fund20b',    name: 'at least 20 distinct funders',       group: 'graph2', pass: s => s.deepFunders != null ? s.deepFunders >= 20 : null },
  { key: 'fund30b',    name: 'at least 30 distinct funders',       group: 'graph2', pass: s => s.deepFunders != null ? s.deepFunders >= 30 : null },
  { key: 'cluVsOwn',   name: 'largest cluster under 10% of owners',group: 'graph2', pass: s => (s.deepOwners ?? 0) > 0 && s.deepCluster != null ? s.deepCluster / s.deepOwners! < 0.1 : null },
  { key: 'sf5',        name: 'same-funder share under 5%',         group: 'graph2', pass: s => s.sameFunderPct != null ? s.sameFunderPct < 5 : null },
  { key: 'sf10',       name: 'same-funder share under 10%',        group: 'graph2', pass: s => s.sameFunderPct != null ? s.sameFunderPct < 10 : null },
  { key: 'sf20b',      name: 'same-funder share under 20%',        group: 'graph2', pass: s => s.sameFunderPct != null ? s.sameFunderPct < 20 : null },

  // ── Veterans and fresh wallets as COUNTS, not shares ──
  { key: 'vet10',     name: 'at least 10 veteran holders',         group: 'wallets', pass: s => s.veterans != null ? s.veterans >= 10 : null },
  { key: 'vet20',     name: 'at least 20 veteran holders',         group: 'wallets', pass: s => s.veterans != null ? s.veterans >= 20 : null },
  { key: 'vet30',     name: 'at least 30 veteran holders',         group: 'wallets', pass: s => s.veterans != null ? s.veterans >= 30 : null },
  { key: 'vetSh50',   name: 'veterans over 50% of traced',         group: 'wallets', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.veterans ?? 0) / t > 0.5 : null; } },
  { key: 'vetSh70',   name: 'veterans over 70% of traced',         group: 'wallets', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.veterans ?? 0) / t > 0.7 : null; } },
  { key: 'freshCap20',name: 'under 20 fresh wallets',              group: 'wallets', pass: s => s.freshWallets != null ? s.freshWallets < 20 : null },
  { key: 'freshCap40',name: 'under 40 fresh wallets',              group: 'wallets', pass: s => s.freshWallets != null ? s.freshWallets < 40 : null },
  { key: 'traced30',  name: 'at least 30 wallets traced',          group: 'wallets', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? t >= 30 : null; } },
  { key: 'traced50',  name: 'at least 50 wallets traced',          group: 'wallets', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? t >= 50 : null; } },
  { key: 'fvRatio1',  name: 'fresh:veteran under 1:1',             group: 'wallets', pass: s => (s.veterans ?? 0) > 0 ? (s.freshWallets ?? 0) / s.veterans! < 1 : null },
  { key: 'fvRatio05', name: 'fresh:veteran under 1:2',             group: 'wallets', pass: s => (s.veterans ?? 0) > 0 ? (s.freshWallets ?? 0) / s.veterans! < 0.5 : null },

  // ── Dev holdings at thresholds the first wave skipped ──
  { key: 'dev1',      name: 'dev holds under 1%',                  group: 'dev2', pass: s => s.devHoldPct != null ? s.devHoldPct < 1 : null },
  { key: 'dev10',     name: 'dev holds under 10%',                 group: 'dev2', pass: s => s.devHoldPct != null ? s.devHoldPct < 10 : null },
  { key: 'dev15',     name: 'dev holds under 15%',                 group: 'dev2', pass: s => s.devHoldPct != null ? s.devHoldPct < 15 : null },
  { key: 'devBand',   name: 'dev holds 0.5%-5% (skin, not control)', group: 'dev2', pass: s => s.devHoldPct != null ? s.devHoldPct >= 0.5 && s.devHoldPct <= 5 : null },
  { key: 'devZero',   name: 'dev holds essentially nothing',       group: 'dev2', pass: s => s.devHoldPct != null ? s.devHoldPct < 0.2 : null },

  // ── Age, including the revival case the volume gate keeps missing ──
  { key: 'ag30',      name: 'older than 30 min',                   group: 'age2', pass: s => s.ageMin > 30 },
  { key: 'ag60',      name: 'older than 1 hour',                   group: 'age2', pass: s => s.ageMin > 60 },
  { key: 'ag120',     name: 'older than 2 hours',                  group: 'age2', pass: s => s.ageMin > 120 },
  { key: 'agCap60',   name: 'under 1 hour old',                    group: 'age2', pass: s => s.ageMin < 60 },
  { key: 'agCap360',  name: 'under 6 hours old',                   group: 'age2', pass: s => s.ageMin < 360 },
  { key: 'agCapDay',  name: 'under 24 hours old',                  group: 'age2', pass: s => s.ageMin < 1440 },
  { key: 'agRevival', name: 'older than 24 hours (a revival)',     group: 'age2', pass: s => s.ageMin > 1440 },
  { key: 'agBand2',   name: '15-120 minutes old',                  group: 'age2', pass: s => s.ageMin >= 15 && s.ageMin <= 120 },
  { key: 'agBand3',   name: '2-30 minutes old',                    group: 'age2', pass: s => s.ageMin >= 2 && s.ageMin <= 30 },

  // ── Clock, at a finer grain than the first wave's two blocks ──
  { key: 'utcNight',  name: '00:00-05:59 UTC',                     group: 'clock2', pass: s => s.hourUtc != null ? s.hourUtc < 6 : null },
  { key: 'utcMorning',name: '06:00-11:59 UTC',                     group: 'clock2', pass: s => s.hourUtc != null ? s.hourUtc >= 6 && s.hourUtc < 12 : null },
  { key: 'utcArvo',   name: '12:00-17:59 UTC',                     group: 'clock2', pass: s => s.hourUtc != null ? s.hourUtc >= 12 && s.hourUtc < 18 : null },
  { key: 'utcLate',   name: '20:00-23:59 UTC',                     group: 'clock2', pass: s => s.hourUtc != null ? s.hourUtc >= 20 : null },
  { key: 'notArvo',   name: 'not 12:00-17:59 UTC',                 group: 'clock2', pass: s => s.hourUtc != null ? !(s.hourUtc >= 12 && s.hourUtc < 18) : null },

  // ── Venue ──
  { key: 'dexCurve',  name: 'still on the pump.fun curve',         group: 'venue', pass: s => s.dexId ? s.dexId === 'pumpfun' : null },
  { key: 'dexSwap',   name: 'migrated to pumpswap',                group: 'venue', pass: s => s.dexId ? s.dexId === 'pumpswap' : null },
  { key: 'dexOther',  name: 'neither pumpfun nor pumpswap',        group: 'venue', pass: s => s.dexId ? (s.dexId !== 'pumpfun' && s.dexId !== 'pumpswap') : null },

  // ── Socials at counts, since one link is trivially pasted ──
  { key: 'social2',   name: 'at least 2 socials',                  group: 'social2', pass: s => s.socials != null ? s.socials >= 2 : null },
  { key: 'social3',   name: 'all three socials',                   group: 'social2', pass: s => s.socials != null ? s.socials >= 3 : null },

  // ── Combinations anchored on the one axis that has already earned its place ──
  { key: 'nc1',  name: 'fresh <70% + at least 5 veterans',         group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && (s.veterans ?? 0) >= 5) : null; } },
  { key: 'nc2',  name: 'fresh <70% + liquidity over $10K',         group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.liq > 10000) : null; } },
  { key: 'nc3',  name: 'fresh <70% + 1h change positive',          group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.chg1h > 0) : null; } },
  { key: 'nc4',  name: 'at least 5 veterans + avg trade over $80', group: 'combo2', pass: s => { const t = s.buys5m + s.sells5m; return s.veterans != null && t > 0 ? (s.veterans >= 5 && s.vol5m / t > 80) : null; } },
  { key: 'nc5',  name: 'fresh <70% + MC $15K-$60K',                group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.mc >= 15000 && s.mc <= 60000) : null; } },
  { key: 'nc6',  name: 'fresh <70% + at least 100 owners',         group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 && s.deepOwners != null ? ((s.freshWallets ?? 0) / t < 0.7 && s.deepOwners >= 100) : null; } },
  { key: 'nc7',  name: 'independent >50% + at least 5 veterans',   group: 'combo2', pass: s => { const t = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); return t > 0 && s.veterans != null ? ((s.deepIndependent ?? 0) / t > 0.5 && s.veterans >= 5) : null; } },
  { key: 'nc8',  name: 'fresh <70% + buys over 55%',               group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const tr = s.buys5m + s.sells5m; return t > 0 && tr > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.buys5m / tr > 0.55) : null; } },
  { key: 'nc9',  name: 'has a social + fresh <70%',                group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 && s.socials != null ? ((s.freshWallets ?? 0) / t < 0.7 && s.socials >= 1) : null; } },
  { key: 'nc10', name: 'fresh <70% + 5m rate over the 1h rate',    group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 && s.vol1h > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && (s.vol5m * 12) / s.vol1h > 1) : null; } },
  { key: 'nc11', name: 'veterans >50% + liquidity over $10K',      group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? ((s.veterans ?? 0) / t > 0.5 && s.liq > 10000) : null; } },
  { key: 'nc12', name: 'fresh <70% + 1h change under +400%',       group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.chg1h < 400) : null; } },
  { key: 'nc13', name: 'fresh <70% + older than 5 min',            group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.ageMin > 5) : null; } },
  { key: 'nc14', name: 'at least 20 funders + fresh <70%',         group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 && s.deepFunders != null ? ((s.freshWallets ?? 0) / t < 0.7 && s.deepFunders >= 20) : null; } },
  { key: 'nc15', name: 'liq/MC 0.15-0.35 + fresh <70%',            group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 && s.mc > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && (s.liq / s.mc) >= 0.15 && (s.liq / s.mc) <= 0.35) : null; } },
  { key: 'nc16', name: 'trade pace rising + fresh <70%',           group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const h = (s.buys1h + s.sells1h) / 12; return t > 0 && h > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && (s.buys5m + s.sells5m) > h) : null; } },
  { key: 'nc17', name: 'fresh <70% + 24h volume over 1x MC',       group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 && s.mc > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.vol24h / s.mc > 1) : null; } },
  { key: 'nc18', name: 'over 100 owners + independent over 50%',   group: 'combo2', pass: s => { const t = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); return t > 0 && s.deepOwners != null ? (s.deepOwners >= 100 && (s.deepIndependent ?? 0) / t > 0.5) : null; } },
  { key: 'nc19', name: 'fresh <70% + dev under 5%',                group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 && s.devHoldPct != null ? ((s.freshWallets ?? 0) / t < 0.7 && s.devHoldPct < 5) : null; } },
  { key: 'nc20', name: 'at least 10 veterans + has a social',      group: 'combo2', pass: s => s.veterans != null && s.socials != null ? (s.veterans >= 10 && s.socials >= 1) : null },
  { key: 'nc21', name: 'fresh <70% + under 500 trades in 5m',      group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && (s.buys5m + s.sells5m) < 500) : null; } },
  { key: 'nc22', name: 'fresh <70% + avg trade over $80',          group: 'combo2', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const tr = s.buys5m + s.sells5m; return t > 0 && tr > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.vol5m / tr > 80) : null; } },
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
