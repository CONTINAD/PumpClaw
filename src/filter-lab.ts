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

  // ──────────────────────────────────────────────────────────────────────────
  // Third wave — 111 candidates. Still nothing here blocks.
  //
  // The second wave spent every field in the snapshot, so this one spends the
  // relationships BETWEEN them. Turnover asks how many times the pool changes
  // hands rather than how much volume there was. Impact asks how much price that
  // volume bought — the same $30K moves a real book 3% and a hollow one 300%.
  // Netflow counts buyers instead of dividing them, because 20 net buyers out of
  // 40 and out of 400 are different coins with the same ratio. Trend measures
  // every metric against its own one-hour baseline, so "busy" becomes "busier
  // than it was", which is the only version of busy that predicts anything.
  //
  // The grid is deliberately unglamorous: finer thresholds on the axes that have
  // already earned attention. fake70 beat fake80 on a threshold move alone, which
  // is the whole argument for measuring 40/50/55/65 rather than guessing again.
  // ──────────────────────────────────────────────────────────────────────────

  // ── Turnover: how many times the pool changes hands ──
  { key: 'to05',     name: 'pool turns over under 0.5x in 5m',      group: 'turnover', pass: s => s.liq > 0 ? s.vol5m / s.liq < 0.5 : null },
  { key: 'to1',      name: 'pool turns over under 1x in 5m',        group: 'turnover', pass: s => s.liq > 0 ? s.vol5m / s.liq < 1 : null },
  { key: 'to2',      name: 'pool turns over under 2x in 5m',        group: 'turnover', pass: s => s.liq > 0 ? s.vol5m / s.liq < 2 : null },
  { key: 'to5',      name: 'pool turns over under 5x in 5m',        group: 'turnover', pass: s => s.liq > 0 ? s.vol5m / s.liq < 5 : null },
  { key: 'toFloor',  name: 'pool turns over at least 0.2x in 5m',   group: 'turnover', pass: s => s.liq > 0 ? s.vol5m / s.liq > 0.2 : null },
  { key: 'toBand',   name: 'turnover between 0.2x and 2x in 5m',    group: 'turnover', pass: s => s.liq > 0 ? (s.vol5m / s.liq) >= 0.2 && (s.vol5m / s.liq) <= 2 : null },
  { key: 'to24',     name: '24h turnover under 20x the pool',       group: 'turnover', pass: s => s.liq > 0 ? s.vol24h / s.liq < 20 : null },
  { key: 'toTrend',  name: '5m turnover rate under the 1h rate',    group: 'turnover', pass: s => s.liq > 0 && s.vol1h > 0 ? (s.vol5m * 12) < s.vol1h : null },
  { key: 'liqPerTr', name: 'over $40 of liquidity per 5m trade',    group: 'turnover', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 && s.liq > 0 ? s.liq / t > 40 : null; } },

  // ── Impact: how much price that volume actually bought ──
  { key: 'imEasy',     name: 'over 5% of move per 1x of MC traded',   group: 'impact', pass: s => { const tv = s.mc > 0 ? s.vol5m / s.mc : 0; return tv > 0 ? Math.abs(s.chg5m) / tv > 5 : null; } },
  { key: 'imHard',     name: 'under 20% of move per 1x of MC traded', group: 'impact', pass: s => { const tv = s.mc > 0 ? s.vol5m / s.mc : 0; return tv > 0 ? Math.abs(s.chg5m) / tv < 20 : null; } },
  { key: 'imBand',     name: '2-30% of move per 1x of MC traded',     group: 'impact', pass: s => { const tv = s.mc > 0 ? s.vol5m / s.mc : 0; const r = tv > 0 ? Math.abs(s.chg5m) / tv : -1; return r >= 0 ? r >= 2 && r <= 30 : null; } },
  { key: 'imDeep',     name: 'under 3% of MC traded per 1% of move',  group: 'impact', pass: s => { const c = Math.abs(s.chg5m); return c > 0 && s.mc > 0 ? (s.vol5m / s.mc * 100) / c < 3 : null; } },
  { key: 'mcVol05',    name: 'MC over half the 5m volume',            group: 'impact', pass: s => s.vol5m > 0 ? s.mc / s.vol5m > 0.5 : null },
  { key: 'mcVol2',     name: 'MC over 2x the 5m volume',              group: 'impact', pass: s => s.vol5m > 0 ? s.mc / s.vol5m > 2 : null },
  { key: 'volShock',   name: '5m volume over 30% of MC',              group: 'impact', pass: s => s.mc > 0 ? s.vol5m / s.mc > 0.3 : null },
  { key: 'volCalm',    name: '5m volume under 10% of MC',             group: 'impact', pass: s => s.mc > 0 ? s.vol5m / s.mc < 0.1 : null },
  { key: 'chgPerTr',   name: 'under 0.5% of 5m move per trade',       group: 'impact', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? Math.abs(s.chg5m) / t < 0.5 : null; } },
  { key: 'chgPerTrHi', name: 'over 0.05% of 5m move per trade',       group: 'impact', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? Math.abs(s.chg5m) / t > 0.05 : null; } },

  // ── Netflow: buyers counted, not divided ──
  { key: 'nfPos',     name: 'more buys than sells in 5m',            group: 'netflow', pass: s => (s.buys5m + s.sells5m) > 0 ? s.buys5m > s.sells5m : null },
  { key: 'nf20',      name: 'at least 20 net buyers in 5m',          group: 'netflow', pass: s => (s.buys5m + s.sells5m) > 0 ? (s.buys5m - s.sells5m) >= 20 : null },
  { key: 'nf50',      name: 'at least 50 net buyers in 5m',          group: 'netflow', pass: s => (s.buys5m + s.sells5m) > 0 ? (s.buys5m - s.sells5m) >= 50 : null },
  { key: 'nfCap200',  name: 'under 200 net buyers (not a stampede)', group: 'netflow', pass: s => (s.buys5m + s.sells5m) > 0 ? (s.buys5m - s.sells5m) < 200 : null },
  { key: 'nf1h',      name: 'more buys than sells over the hour',    group: 'netflow', pass: s => (s.buys1h + s.sells1h) > 0 ? s.buys1h > s.sells1h : null },
  { key: 'nf1h50',    name: 'at least 50 net buyers over the hour',  group: 'netflow', pass: s => (s.buys1h + s.sells1h) > 0 ? (s.buys1h - s.sells1h) >= 50 : null },
  { key: 'nfShare10', name: 'net buyers over 10% of 5m trades',      group: 'netflow', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? (s.buys5m - s.sells5m) / t > 0.1 : null; } },
  { key: 'nfShare30', name: 'net buyers over 30% of 5m trades',      group: 'netflow', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? (s.buys5m - s.sells5m) / t > 0.3 : null; } },
  { key: 'sellsCap',  name: 'under 150 sells in 5m',                 group: 'netflow', pass: s => (s.buys5m + s.sells5m) > 0 ? s.sells5m < 150 : null },
  { key: 'buysFloor', name: 'at least 30 buys in 5m',                group: 'netflow', pass: s => (s.buys5m + s.sells5m) > 0 ? s.buys5m >= 30 : null },

  // ── Trend: each metric against its own one-hour baseline ──
  { key: 'tdSize',     name: '5m average trade larger than the 1h average',  group: 'trend', pass: s => { const a = s.buys5m + s.sells5m, b = s.buys1h + s.sells1h; return a > 0 && b > 0 && s.vol1h > 0 ? (s.vol5m / a) > (s.vol1h / b) : null; } },
  { key: 'tdSizeDown', name: '5m average trade smaller than the 1h average', group: 'trend', pass: s => { const a = s.buys5m + s.sells5m, b = s.buys1h + s.sells1h; return a > 0 && b > 0 && s.vol1h > 0 ? (s.vol5m / a) < (s.vol1h / b) : null; } },
  { key: 'tdBuyUp',    name: 'buy share rising against the hour',            group: 'trend', pass: s => { const a = s.buys5m + s.sells5m, b = s.buys1h + s.sells1h; return a > 0 && b > 0 ? (s.buys5m / a) > (s.buys1h / b) : null; } },
  { key: 'tdBuyDown',  name: 'buy share falling against the hour',           group: 'trend', pass: s => { const a = s.buys5m + s.sells5m, b = s.buys1h + s.sells1h; return a > 0 && b > 0 ? (s.buys5m / a) < (s.buys1h / b) : null; } },
  { key: 'tdVolUp',    name: '5m volume rate above the 1h rate',             group: 'trend', pass: s => s.vol1h > 0 ? (s.vol5m * 12) > s.vol1h : null },
  { key: 'tdVolCalm',  name: '5m volume rate under 3x the 1h rate',          group: 'trend', pass: s => s.vol1h > 0 ? (s.vol5m * 12) < s.vol1h * 3 : null },
  { key: 'tdMomUp',    name: '5m move faster than the hour average',         group: 'trend', pass: s => s.chg1h !== 0 ? s.chg5m > s.chg1h / 12 : null },
  { key: 'tdMomCalm',  name: '5m move under 3x the hour average',            group: 'trend', pass: s => s.chg1h > 0 ? s.chg5m < (s.chg1h / 12) * 3 : null },
  { key: 'tdPaceBand', name: '5m trade pace 0.5-3x the 1h pace',             group: 'trend', pass: s => { const h = (s.buys1h + s.sells1h) / 12; const n = s.buys5m + s.sells5m; return h > 0 ? (n / h) >= 0.5 && (n / h) <= 3 : null; } },
  { key: 'tdAll',      name: 'volume, pace and buy share all rising',        group: 'trend', pass: s => { const a = s.buys5m + s.sells5m, b = s.buys1h + s.sells1h, h = b / 12; return a > 0 && b > 0 && s.vol1h > 0 ? ((s.vol5m * 12) > s.vol1h && a > h && (s.buys5m / a) > (s.buys1h / b)) : null; } },

  // ── Grid: finer thresholds on axes that already earned attention ──
  { key: 'gF40', name: 'fresh-wallet share under 40%', group: 'grid', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.freshWallets ?? 0) / t < 0.40 : null; } },
  { key: 'gF50', name: 'fresh-wallet share under 50%', group: 'grid', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.freshWallets ?? 0) / t < 0.50 : null; } },
  { key: 'gF55', name: 'fresh-wallet share under 55%', group: 'grid', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.freshWallets ?? 0) / t < 0.55 : null; } },
  { key: 'gF65', name: 'fresh-wallet share under 65%', group: 'grid', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? (s.freshWallets ?? 0) / t < 0.65 : null; } },
  { key: 'gV7',  name: 'at least 7 veteran holders',   group: 'grid', pass: s => s.veterans != null ? s.veterans >= 7 : null },
  { key: 'gV15', name: 'at least 15 veteran holders',  group: 'grid', pass: s => s.veterans != null ? s.veterans >= 15 : null },
  { key: 'gV25', name: 'at least 25 veteran holders',  group: 'grid', pass: s => s.veterans != null ? s.veterans >= 25 : null },
  { key: 'gV40', name: 'at least 40 veteran holders',  group: 'grid', pass: s => s.veterans != null ? s.veterans >= 40 : null },
  { key: 'gI30', name: 'independent wallets over 30% of traced', group: 'grid', pass: s => { const t = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); return t > 0 ? (s.deepIndependent ?? 0) / t > 0.3 : null; } },
  { key: 'gI40', name: 'independent wallets over 40% of traced', group: 'grid', pass: s => { const t = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); return t > 0 ? (s.deepIndependent ?? 0) / t > 0.4 : null; } },
  { key: 'gI60', name: 'independent wallets over 60% of traced', group: 'grid', pass: s => { const t = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); return t > 0 ? (s.deepIndependent ?? 0) / t > 0.6 : null; } },
  { key: 'gI80', name: 'independent wallets over 80% of traced', group: 'grid', pass: s => { const t = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); return t > 0 ? (s.deepIndependent ?? 0) / t > 0.8 : null; } },
  { key: 'gL3',  name: 'liquidity over $3K',   group: 'grid', pass: s => s.liq > 3000 },
  { key: 'gL7',  name: 'liquidity over $7K',   group: 'grid', pass: s => s.liq > 7000 },
  { key: 'gL15', name: 'liquidity over $15K',  group: 'grid', pass: s => s.liq > 15000 },
  { key: 'gL25', name: 'liquidity over $25K',  group: 'grid', pass: s => s.liq > 25000 },
  { key: 'gL30', name: 'liquidity over $30K',  group: 'grid', pass: s => s.liq > 30000 },
  { key: 'gL75', name: 'liquidity over $75K',  group: 'grid', pass: s => s.liq > 75000 },
  { key: 'gM5',  name: 'MC over $5K',   group: 'grid', pass: s => s.mc > 5000 },
  { key: 'gM10', name: 'MC over $10K',  group: 'grid', pass: s => s.mc > 10000 },
  { key: 'gM20', name: 'MC over $20K',  group: 'grid', pass: s => s.mc > 20000 },
  { key: 'gM30', name: 'MC under $30K', group: 'grid', pass: s => s.mc > 0 ? s.mc < 30000 : null },
  { key: 'gM50', name: 'MC under $50K', group: 'grid', pass: s => s.mc > 0 ? s.mc < 50000 : null },
  { key: 'gM75', name: 'MC under $75K', group: 'grid', pass: s => s.mc > 0 ? s.mc < 75000 : null },
  { key: 'gM90', name: 'MC under $90K', group: 'grid', pass: s => s.mc > 0 ? s.mc < 90000 : null },
  { key: 'gA1',  name: 'older than 1 minute',   group: 'grid', pass: s => s.ageMin > 1 },
  { key: 'gA3',  name: 'older than 3 minutes',  group: 'grid', pass: s => s.ageMin > 3 },
  { key: 'gA8',  name: 'older than 8 minutes',  group: 'grid', pass: s => s.ageMin > 8 },
  { key: 'gA45', name: 'older than 45 minutes', group: 'grid', pass: s => s.ageMin > 45 },
  { key: 'gA90', name: 'older than 90 minutes', group: 'grid', pass: s => s.ageMin > 90 },
  { key: 'gA180',name: 'older than 3 hours',    group: 'grid', pass: s => s.ageMin > 180 },
  { key: 'gA720',name: 'older than 12 hours',   group: 'grid', pass: s => s.ageMin > 720 },
  { key: 'gW2',  name: 'over $2K volume in 5m',    group: 'grid', pass: s => s.vol5m > 2000 },
  { key: 'gW5',  name: 'over $5K volume in 5m',    group: 'grid', pass: s => s.vol5m > 5000 },
  { key: 'gW15', name: 'over $15K volume in 5m',   group: 'grid', pass: s => s.vol5m > 15000 },
  { key: 'gW30', name: 'over $30K volume in 5m',   group: 'grid', pass: s => s.vol5m > 30000 },
  { key: 'gW100',name: 'under $100K volume in 5m', group: 'grid', pass: s => s.vol5m > 0 ? s.vol5m < 100000 : null },
  { key: 'gT25', name: 'at least 25 trades in 5m',  group: 'grid', pass: s => (s.buys5m + s.sells5m) >= 25 },
  { key: 'gT75', name: 'at least 75 trades in 5m',  group: 'grid', pass: s => (s.buys5m + s.sells5m) >= 75 },
  { key: 'gT150',name: 'at least 150 trades in 5m', group: 'grid', pass: s => (s.buys5m + s.sells5m) >= 150 },
  { key: 'gT300',name: 'under 300 trades in 5m',    group: 'grid', pass: s => (s.buys5m + s.sells5m) > 0 ? (s.buys5m + s.sells5m) < 300 : null },
  { key: 'gD01', name: 'dev holds under 0.1%', group: 'grid', pass: s => s.devHoldPct != null ? s.devHoldPct < 0.1 : null },
  { key: 'gD3',  name: 'dev holds under 3%',   group: 'grid', pass: s => s.devHoldPct != null ? s.devHoldPct < 3 : null },
  { key: 'gD7',  name: 'dev holds under 7%',   group: 'grid', pass: s => s.devHoldPct != null ? s.devHoldPct < 7 : null },
  { key: 'gD20', name: 'dev holds under 20%',  group: 'grid', pass: s => s.devHoldPct != null ? s.devHoldPct < 20 : null },
  { key: 'gS3',  name: 'same-funder share under 3%',  group: 'grid', pass: s => s.sameFunderPct != null ? s.sameFunderPct < 3 : null },
  { key: 'gS15', name: 'same-funder share under 15%', group: 'grid', pass: s => s.sameFunderPct != null ? s.sameFunderPct < 15 : null },
  { key: 'gS30', name: 'same-funder share under 30%', group: 'grid', pass: s => s.sameFunderPct != null ? s.sameFunderPct < 30 : null },
  { key: 'gN5',  name: 'at least 5 distinct funders',  group: 'grid', pass: s => s.deepFunders != null ? s.deepFunders >= 5 : null },
  { key: 'gN10', name: 'at least 10 distinct funders', group: 'grid', pass: s => s.deepFunders != null ? s.deepFunders >= 10 : null },
  { key: 'gN15', name: 'at least 15 distinct funders', group: 'grid', pass: s => s.deepFunders != null ? s.deepFunders >= 15 : null },
  { key: 'gN40', name: 'at least 40 distinct funders', group: 'grid', pass: s => s.deepFunders != null ? s.deepFunders >= 40 : null },

  // ── Three-condition combinations ──
  { key: 'tc1',  name: 'fresh<70% + 5 veterans + liq over $10K',       group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && (s.veterans ?? 0) >= 5 && s.liq > 10000) : null; } },
  { key: 'tc2',  name: 'fresh<70% + 1h positive + pace rising',        group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const h = (s.buys1h + s.sells1h) / 12; return t > 0 && h > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.chg1h > 0 && (s.buys5m + s.sells5m) > h) : null; } },
  { key: 'tc3',  name: 'fresh<70% + MC $15-60K + buys over 55%',       group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const tr = s.buys5m + s.sells5m; return t > 0 && tr > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.mc >= 15000 && s.mc <= 60000 && s.buys5m / tr > 0.55) : null; } },
  { key: 'tc4',  name: '10 veterans + independent>50% + a social',     group: 'combo3', pass: s => { const t = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); return t > 0 && s.veterans != null && s.socials != null ? (s.veterans >= 10 && (s.deepIndependent ?? 0) / t > 0.5 && s.socials >= 1) : null; } },
  { key: 'tc5',  name: 'fresh<70% + older than 5m + 1h under +400%',   group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.ageMin > 5 && s.chg1h < 400) : null; } },
  { key: 'tc6',  name: 'fresh<70% + avg trade>$80 + liq over $10K',    group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const tr = s.buys5m + s.sells5m; return t > 0 && tr > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.vol5m / tr > 80 && s.liq > 10000) : null; } },
  { key: 'tc7',  name: '100 owners + fresh<70% + 20 funders',          group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 && s.deepOwners != null && s.deepFunders != null ? (s.deepOwners >= 100 && (s.freshWallets ?? 0) / t < 0.7 && s.deepFunders >= 20) : null; } },
  { key: 'tc8',  name: 'fresh<70% + turnover 0.2-2x + 1h positive',    group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 && s.liq > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && (s.vol5m / s.liq) >= 0.2 && (s.vol5m / s.liq) <= 2 && s.chg1h > 0) : null; } },
  { key: 'tc9',  name: 'veterans>50% + liq over $10K + MC under $60K', group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? ((s.veterans ?? 0) / t > 0.5 && s.liq > 10000 && s.mc > 0 && s.mc < 60000) : null; } },
  { key: 'tc10', name: 'fresh<70% + 20 net buyers + pace rising',      group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const h = (s.buys1h + s.sells1h) / 12; return t > 0 && h > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && (s.buys5m - s.sells5m) >= 20 && (s.buys5m + s.sells5m) > h) : null; } },
  { key: 'tc11', name: 'fresh<70% + not parabolic + not dumping',      group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.chg1h < 400 && s.chg5m > -25) : null; } },
  { key: 'tc12', name: 'a social + 5 veterans + liq over $10K',        group: 'combo3', pass: s => s.socials != null && s.veterans != null ? (s.socials >= 1 && s.veterans >= 5 && s.liq > 10000) : null },
  { key: 'tc13', name: 'fresh<70% + $10-80K volume + buys over 55%',   group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const tr = s.buys5m + s.sells5m; return t > 0 && tr > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && s.vol5m >= 10000 && s.vol5m <= 80000 && s.buys5m / tr > 0.55) : null; } },
  { key: 'tc14', name: 'independent>50% + 20 funders + 80 owners',     group: 'combo3', pass: s => { const t = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); return t > 0 && s.deepFunders != null && s.deepOwners != null ? ((s.deepIndependent ?? 0) / t > 0.5 && s.deepFunders >= 20 && s.deepOwners >= 80) : null; } },
  { key: 'tc15', name: 'fresh<70% + dev under 5% + older than 5m',     group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 && s.devHoldPct != null ? ((s.freshWallets ?? 0) / t < 0.7 && s.devHoldPct < 5 && s.ageMin > 5) : null; } },
  { key: 'tc16', name: '10 veterans + 1h positive + turnover under 2x',group: 'combo3', pass: s => s.veterans != null && s.liq > 0 ? (s.veterans >= 10 && s.chg1h > 0 && s.vol5m / s.liq < 2) : null },
  { key: 'tc17', name: 'fresh<70% + liq/MC 0.15-0.35 + buys over 55%', group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const tr = s.buys5m + s.sells5m; return t > 0 && tr > 0 && s.mc > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && (s.liq / s.mc) >= 0.15 && (s.liq / s.mc) <= 0.35 && s.buys5m / tr > 0.55) : null; } },
  { key: 'tc18', name: 'fresh<70% + trade size rising + 1h positive',  group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const a = s.buys5m + s.sells5m, b = s.buys1h + s.sells1h; return t > 0 && a > 0 && b > 0 && s.vol1h > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && (s.vol5m / a) > (s.vol1h / b) && s.chg1h > 0) : null; } },
  { key: 'tc19', name: 'fresh<70% + under 500 trades + avg over $80',  group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const tr = s.buys5m + s.sells5m; return t > 0 && tr > 0 ? ((s.freshWallets ?? 0) / t < 0.7 && tr < 500 && s.vol5m / tr > 80) : null; } },
  { key: 'tc20', name: 'veterans>50% + independent>50% + 20 funders',  group: 'combo3', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const d = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); return t > 0 && d > 0 && s.deepFunders != null ? ((s.veterans ?? 0) / t > 0.5 && (s.deepIndependent ?? 0) / d > 0.5 && s.deepFunders >= 20) : null; } },

  // ──────────────────────────────────────────────────────────────────────────
  // Fourth wave — 112 candidates, and a change of SHAPE rather than of subject.
  //
  // Everything so far has been "is this number good", then "is this ratio good",
  // then "is this ratio better than its own baseline". All of it was one-sided and
  // all of it was AND. These are built differently on purpose:
  //
  //   per-minute   normalise by the coin's own lifetime, not by a fixed window —
  //                $20K in five minutes means one thing at age 3 and another at 300
  //   interaction  products rather than ratios, because liquidity AND veterans is a
  //                different claim from liquidity PER veteran
  //   path         the full ordering of 5m/1h/6h as a taxonomy, so accelerating,
  //                decelerating and reversing are separable rather than averaged
  //   agreement    do independent signals CONCUR — a coin whose volume, holders and
  //                price disagree is being pushed by one of them
  //   corner       exclude a specific bad two-dimensional corner instead of
  //                requiring both dimensions to be good
  //   extreme      nothing about it is in an outlier band. Boring as a thesis
  //   data quality whether we know enough to have an opinion at all, which is a
  //                different question from whether the coin is good
  //   implied      quantities the snapshot never states: MC an hour ago, dollars
  //                added per trade, what the move is worth per holder
  //   or-combos    the first predicates in this file joined by OR — "either of these
  //                two things is enough" is not reachable by any AND rule
  // ──────────────────────────────────────────────────────────────────────────

  // ── Per minute of the coin's own life ──
  { key: 'pmVol1k',  name: 'over $1K of 5m volume per minute of age',  group: 'permin', pass: s => s.ageMin > 0 ? (s.vol5m / 5) / 1 > 1000 && s.vol24h / s.ageMin > 1000 : null },
  { key: 'pmVolAge', name: 'over $500 of 24h volume per minute of age',group: 'permin', pass: s => s.ageMin > 0 ? s.vol24h / s.ageMin > 500 : null },
  { key: 'pmVolCap', name: 'under $20K of 24h volume per minute of age',group: 'permin', pass: s => s.ageMin > 0 ? s.vol24h / s.ageMin < 20000 : null },
  { key: 'pmMc',     name: 'over $300 of MC per minute of age',        group: 'permin', pass: s => s.ageMin > 0 ? s.mc / s.ageMin > 300 : null },
  { key: 'pmMcCap',  name: 'under $20K of MC per minute of age',       group: 'permin', pass: s => s.ageMin > 0 && s.mc > 0 ? s.mc / s.ageMin < 20000 : null },
  { key: 'pmOwn',    name: 'over 1 owner gained per minute of age',    group: 'permin', pass: s => s.ageMin > 0 && s.deepOwners != null ? s.deepOwners / s.ageMin > 1 : null },
  { key: 'pmOwnCap', name: 'under 40 owners per minute of age',        group: 'permin', pass: s => s.ageMin > 0 && s.deepOwners != null ? s.deepOwners / s.ageMin < 40 : null },
  { key: 'pmTr',     name: 'over 5 lifetime trades per minute of age', group: 'permin', pass: s => s.ageMin > 0 ? (s.buys1h + s.sells1h) / Math.min(s.ageMin, 60) > 5 : null },
  { key: 'pmLiq',    name: 'over $200 of liquidity per minute of age', group: 'permin', pass: s => s.ageMin > 0 ? s.liq / s.ageMin > 200 : null },
  { key: 'pmChg',    name: 'under 20% of 6h move per minute of age',   group: 'permin', pass: s => s.ageMin > 0 ? Math.abs(s.chg6h) / s.ageMin < 20 : null },
  { key: 'pmYoungHot',name: 'young and busy: under 30m with $10K+ in 5m', group: 'permin', pass: s => s.ageMin < 30 && s.vol5m > 10000 },
  { key: 'pmOldAlive',name: 'over an hour old and still doing $5K in 5m', group: 'permin', pass: s => s.ageMin > 60 ? s.vol5m > 5000 : null },

  // ── Interaction: products, not ratios ──
  { key: 'ixLiqVet',  name: 'liquidity x veterans over 100K',          group: 'interact', pass: s => s.veterans != null ? s.liq * s.veterans > 100000 : null },
  { key: 'ixLiqOwn',  name: 'liquidity x owners over 1M',              group: 'interact', pass: s => s.deepOwners != null ? s.liq * s.deepOwners > 1000000 : null },
  { key: 'ixVolOwn',  name: '5m volume x owners over 1M',              group: 'interact', pass: s => s.deepOwners != null ? s.vol5m * s.deepOwners > 1000000 : null },
  { key: 'ixVetInd',  name: 'veterans x independent wallets over 100', group: 'interact', pass: s => s.veterans != null && s.deepIndependent != null ? s.veterans * s.deepIndependent > 100 : null },
  { key: 'ixFundOwn', name: 'funders x owners over 1000',              group: 'interact', pass: s => s.deepFunders != null && s.deepOwners != null ? s.deepFunders * s.deepOwners > 1000 : null },
  { key: 'ixLiqTr',   name: 'liquidity x trade count over 500K',       group: 'interact', pass: s => s.liq * (s.buys5m + s.sells5m) > 500000 },
  { key: 'ixMcLiq',   name: 'MC x liquidity over 200M',                group: 'interact', pass: s => s.mc * s.liq > 200000000 },
  { key: 'ixVolVet',  name: '5m volume x veterans over 200K',          group: 'interact', pass: s => s.veterans != null ? s.vol5m * s.veterans > 200000 : null },
  { key: 'ixSocVet',  name: 'socials x veterans over 5',               group: 'interact', pass: s => s.socials != null && s.veterans != null ? s.socials * s.veterans > 5 : null },
  { key: 'ixAgeOwn',  name: 'age x owners over 500',                   group: 'interact', pass: s => s.deepOwners != null ? s.ageMin * s.deepOwners > 500 : null },
  { key: 'ixLowBoth', name: 'not both thin: liq x owners under 20M',   group: 'interact', pass: s => s.deepOwners != null ? s.liq * s.deepOwners < 20000000 : null },
  { key: 'ixVolLiq',  name: '5m volume x liquidity over 50M',          group: 'interact', pass: s => s.vol5m * s.liq > 50000000 },

  // ── Path taxonomy: the full ordering of 5m / 1h / 6h ──
  { key: 'pthAccel',  name: 'accelerating: 5m > 1h > 6h',              group: 'path2', pass: s => s.chg5m > s.chg1h && s.chg1h > s.chg6h },
  { key: 'pthDecel',  name: 'decelerating: 5m < 1h < 6h',              group: 'path2', pass: s => s.chg5m < s.chg1h && s.chg1h < s.chg6h },
  { key: 'pthTurnUp', name: 'turning up: 5m > 1h, 1h < 6h',            group: 'path2', pass: s => s.chg5m > s.chg1h && s.chg1h < s.chg6h },
  { key: 'pthTurnDn', name: 'turning down: 5m < 1h, 1h > 6h',          group: 'path2', pass: s => s.chg5m < s.chg1h && s.chg1h > s.chg6h },
  { key: 'pthSteady', name: 'all three within 30 points of each other',group: 'path2', pass: s => Math.max(s.chg5m, s.chg1h, s.chg6h) - Math.min(s.chg5m, s.chg1h, s.chg6h) < 30 },
  { key: 'pthWild',   name: 'the three legs span over 200 points',     group: 'path2', pass: s => Math.max(s.chg5m, s.chg1h, s.chg6h) - Math.min(s.chg5m, s.chg1h, s.chg6h) > 200 },
  { key: 'pth6hLead', name: 'the 6h leg is the largest',               group: 'path2', pass: s => s.chg6h >= s.chg1h && s.chg6h >= s.chg5m },
  { key: 'pth5mLead', name: 'the 5m leg is the largest',               group: 'path2', pass: s => s.chg5m >= s.chg1h && s.chg5m >= s.chg6h },
  { key: 'pthMidUp',  name: 'the hour did the work, not the minute',   group: 'path2', pass: s => s.chg1h > 0 ? s.chg1h > s.chg5m * 2 : null },
  { key: 'pthNoRev',  name: 'no leg reverses the others',              group: 'path2', pass: s => (s.chg5m >= 0 && s.chg1h >= 0 && s.chg6h >= 0) || (s.chg5m <= 0 && s.chg1h <= 0 && s.chg6h <= 0) },
  { key: 'pthGiveBk', name: 'not giving it back: 6h over +100%, 1h under -20%', group: 'path2', pass: s => !(s.chg6h > 100 && s.chg1h < -20) },
  { key: 'pthFresh',  name: '6h equals 1h (the coin is under an hour old)', group: 'path2', pass: s => Math.abs(s.chg6h - s.chg1h) < 0.01 },

  // ── Agreement: do independent signals concur ──
  { key: 'agrVolPr',  name: 'volume and price agree (both up or both quiet)', group: 'agree', pass: s => s.vol1h > 0 ? !((s.vol5m * 12 > s.vol1h * 2) && s.chg5m < 0) : null },
  { key: 'agrBuyPr',  name: 'buy pressure and price agree',            group: 'agree', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? !((s.buys5m / t > 0.6) && s.chg5m < -5) : null; } },
  { key: 'agrSellPr', name: 'sell pressure and price agree',           group: 'agree', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? !((s.sells5m / t > 0.6) && s.chg5m > 5) : null; } },
  { key: 'agrOwnVol', name: 'owner count and volume agree',            group: 'agree', pass: s => s.deepOwners != null ? !(s.vol5m > 20000 && s.deepOwners < 50) : null },
  { key: 'agrLiqVol', name: 'liquidity and volume agree',              group: 'agree', pass: s => s.liq > 0 ? !(s.vol5m > s.liq * 5) : null },
  { key: 'agrVetOwn', name: 'veteran count and owner count agree',     group: 'agree', pass: s => s.veterans != null && s.deepOwners != null ? !(s.deepOwners > 200 && s.veterans < 5) : null },
  { key: 'agrAgeOwn', name: 'age and owner count agree',               group: 'agree', pass: s => s.deepOwners != null ? !(s.ageMin < 5 && s.deepOwners > 300) : null },
  { key: 'agrMcLiq',  name: 'market cap and liquidity agree',          group: 'agree', pass: s => s.mc > 0 && s.liq > 0 ? !(s.mc > 50000 && s.liq < 5000) : null },
  { key: 'agrTrVol',  name: 'trade count and volume agree',            group: 'agree', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? !(t > 300 && s.vol5m < 15000) : null; } },
  { key: 'agrAll3',   name: 'volume, holders and price all pointing up', group: 'agree', pass: s => s.deepOwners != null && s.vol1h > 0 ? ((s.vol5m * 12) > s.vol1h && s.deepOwners >= 50 && s.chg5m > 0) : null },
  { key: 'agrNone',   name: 'no signal contradicts another',           group: 'agree', pass: s => { const t = s.buys5m + s.sells5m; if (t === 0 || s.liq <= 0) return null; return !((s.buys5m / t > 0.6 && s.chg5m < -5) || (s.sells5m / t > 0.6 && s.chg5m > 5) || (s.vol5m > s.liq * 5)); } },
  { key: 'agrFreshPr',name: 'a fresh-wallet majority is not also pumping', group: 'agree', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? !((s.freshWallets ?? 0) / t > 0.7 && s.chg5m > 50) : null; } },

  // ── Corners: exclude one bad two-dimensional region ──
  { key: 'cnrHiMcLoLiq', name: 'not high MC on thin liquidity',        group: 'corner', pass: s => s.mc > 0 && s.liq > 0 ? !(s.mc > 60000 && s.liq / s.mc < 0.1) : null },
  { key: 'cnrHiVolFewOwn',name: 'not heavy volume with few owners',     group: 'corner', pass: s => s.deepOwners != null ? !(s.vol5m > 30000 && s.deepOwners < 80) : null },
  { key: 'cnrManyTrTiny',name: 'not hundreds of trades at tiny size',  group: 'corner', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? !(t > 250 && s.vol5m / t < 60) : null; } },
  { key: 'cnrOldDead',   name: 'not old and dead',                     group: 'corner', pass: s => !(s.ageMin > 120 && s.vol5m < 2000) },
  { key: 'cnrYoungHuge', name: 'not minutes old at a huge cap',        group: 'corner', pass: s => s.mc > 0 ? !(s.ageMin < 10 && s.mc > 150000) : null },
  { key: 'cnrFreshRun',  name: 'not a fresh-wallet crowd on a vertical',group: 'corner', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 ? !((s.freshWallets ?? 0) / t > 0.6 && s.chg1h > 200) : null; } },
  { key: 'cnrClusterRun',name: 'not a clustered holder set on a vertical',group: 'corner', pass: s => s.deepClusterPct != null ? !(s.deepClusterPct > 25 && s.chg1h > 200) : null },
  { key: 'cnrDevRun',    name: 'not a heavy dev bag on a vertical',    group: 'corner', pass: s => s.devHoldPct != null ? !(s.devHoldPct > 5 && s.chg1h > 200) : null },
  { key: 'cnrSellDump',  name: 'not heavy selling into a falling price',group: 'corner', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? !(s.sells5m / t > 0.55 && s.chg5m < -10) : null; } },
  { key: 'cnrThinRun',   name: 'not a vertical on under $8K of liquidity',group: 'corner', pass: s => s.liq > 0 ? !(s.liq < 8000 && s.chg1h > 150) : null },
  { key: 'cnrNoVetRun',  name: 'not a vertical with under 3 veterans', group: 'corner', pass: s => s.veterans != null ? !(s.veterans < 3 && s.chg1h > 150) : null },
  { key: 'cnrLoOwnHiMc', name: 'not a high cap with under 60 owners',  group: 'corner', pass: s => s.deepOwners != null && s.mc > 0 ? !(s.mc > 60000 && s.deepOwners < 60) : null },
  { key: 'cnrCoolHiMc',  name: 'not a high cap that is already cooling',group: 'corner', pass: s => s.mc > 0 && s.vol1h > 0 ? !(s.mc > 60000 && (s.vol5m * 12) < s.vol1h * 0.5) : null },
  { key: 'cnrFundFew',   name: 'not many owners from very few funders',group: 'corner', pass: s => s.deepFunders != null && s.deepOwners != null ? !(s.deepOwners > 100 && s.deepFunders < 8) : null },
  { key: 'cnrNoSocRun',  name: 'not a vertical with no socials',       group: 'corner', pass: s => s.socials != null ? !(s.socials === 0 && s.chg1h > 200) : null },
  { key: 'cnrDeadVol',   name: 'not volume against a dead price',      group: 'corner', pass: s => !(s.vol5m > 20000 && Math.abs(s.chg5m) < 2) },
  { key: 'cnrGapUp',     name: 'not a one-leg gap: 5m over +150% and 1h under +50%', group: 'corner', pass: s => !(s.chg5m > 150 && s.chg1h < 50) },
  { key: 'cnrLatePump',  name: 'not hours old and only now vertical',  group: 'corner', pass: s => !(s.ageMin > 360 && s.chg1h > 200) },

  // ── Extreme: nothing about it is an outlier. Boring as a thesis ──
  { key: 'xtrMc',     name: 'MC in the ordinary band $5K-$120K',       group: 'extreme', pass: s => s.mc > 0 ? s.mc >= 5000 && s.mc <= 120000 : null },
  { key: 'xtrLiq',    name: 'liquidity in the ordinary band $4K-$80K', group: 'extreme', pass: s => s.liq > 0 ? s.liq >= 4000 && s.liq <= 80000 : null },
  { key: 'xtrVol',    name: '5m volume in the ordinary band $3K-$120K',group: 'extreme', pass: s => s.vol5m > 0 ? s.vol5m >= 3000 && s.vol5m <= 120000 : null },
  { key: 'xtrChg',    name: '5m move between -30% and +150%',          group: 'extreme', pass: s => s.chg5m >= -30 && s.chg5m <= 150 },
  { key: 'xtrChg1h',  name: '1h move between -50% and +500%',          group: 'extreme', pass: s => s.chg1h >= -50 && s.chg1h <= 500 },
  { key: 'xtrTr',     name: 'trade count in the ordinary band 30-400', group: 'extreme', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? t >= 30 && t <= 400 : null; } },
  { key: 'xtrAge',    name: 'age in the ordinary band 2-240 minutes',  group: 'extreme', pass: s => s.ageMin >= 2 && s.ageMin <= 240 },
  { key: 'xtrOwn',    name: 'owners in the ordinary band 40-500',      group: 'extreme', pass: s => s.deepOwners != null ? s.deepOwners >= 40 && s.deepOwners <= 500 : null },
  { key: 'xtrNoneWild',name: 'MC, liquidity and volume all ordinary',  group: 'extreme', pass: s => s.mc > 0 && s.liq > 0 && s.vol5m > 0 ? (s.mc >= 5000 && s.mc <= 120000 && s.liq >= 4000 && s.liq <= 80000 && s.vol5m >= 3000 && s.vol5m <= 120000) : null },
  { key: 'xtrCalmAll',name: 'ordinary size and no extreme move',       group: 'extreme', pass: s => s.mc > 0 ? (s.mc >= 5000 && s.mc <= 120000 && s.chg5m >= -30 && s.chg5m <= 150 && s.chg1h <= 500) : null },

  // ── Data quality: do we know enough to have an opinion ──
  { key: 'dqCore',    name: 'MC, liquidity and volume all present',    group: 'dataq', pass: s => s.mc > 0 && s.liq > 0 && s.vol5m > 0 },
  { key: 'dqTrades',  name: 'trade counts present on both windows',    group: 'dataq', pass: s => (s.buys5m + s.sells5m) > 0 && (s.buys1h + s.sells1h) > 0 },
  { key: 'dqHolders', name: 'holder data resolved at all',             group: 'dataq', pass: s => ((s.freshWallets ?? 0) + (s.veterans ?? 0)) > 0 },
  { key: 'dqDeep',    name: 'the deep holder read resolved',           group: 'dataq', pass: s => (s.deepOwners ?? 0) > 0 },
  { key: 'dqAge',     name: 'a real pair-creation time is known',      group: 'dataq', pass: s => s.ageMin > 0 },
  { key: 'dqAll',     name: 'every core field present — full picture', group: 'dataq', pass: s => s.mc > 0 && s.liq > 0 && s.vol5m > 0 && s.ageMin > 0 && ((s.freshWallets ?? 0) + (s.veterans ?? 0)) > 0 && (s.deepOwners ?? 0) > 0 },
  { key: 'dqCover',   name: 'traced wallets cover 20%+ of owners',     group: 'dataq', pass: s => (s.deepOwners ?? 0) > 0 ? (((s.freshWallets ?? 0) + (s.veterans ?? 0)) / s.deepOwners!) > 0.2 : null },
  { key: 'dqNoZero',  name: 'no core field is suspiciously zero',      group: 'dataq', pass: s => !(s.liq === 0 && s.vol5m > 5000) },

  // ── Implied: quantities the snapshot never states ──
  { key: 'iplMcWas',  name: 'MC an hour ago was over $8K',             group: 'implied', pass: s => s.mc > 0 && s.chg1h > -100 ? s.mc / (1 + s.chg1h / 100) > 8000 : null },
  { key: 'iplMcWasCap',name: 'MC an hour ago was under $60K',          group: 'implied', pass: s => s.mc > 0 && s.chg1h > -100 ? s.mc / (1 + s.chg1h / 100) < 60000 : null },
  { key: 'iplAdd',    name: 'over $10K added to MC in the hour',       group: 'implied', pass: s => s.mc > 0 && s.chg1h > -100 ? s.mc - s.mc / (1 + s.chg1h / 100) > 10000 : null },
  { key: 'iplAddCap', name: 'under $150K added to MC in the hour',     group: 'implied', pass: s => s.mc > 0 && s.chg1h > -100 ? (s.mc - s.mc / (1 + s.chg1h / 100)) < 150000 : null },
  { key: 'iplAddPerTr',name: 'over $50 of MC added per 1h trade',      group: 'implied', pass: s => { const t = s.buys1h + s.sells1h; return t > 0 && s.mc > 0 && s.chg1h > -100 ? (s.mc - s.mc / (1 + s.chg1h / 100)) / t > 50 : null; } },
  { key: 'iplMovePerOwn',name: 'over $100 of hourly move per owner',   group: 'implied', pass: s => (s.deepOwners ?? 0) > 0 && s.mc > 0 && s.chg1h > -100 ? Math.abs(s.mc - s.mc / (1 + s.chg1h / 100)) / s.deepOwners! > 100 : null },
  { key: 'iplVolPerAdd',name: 'over 2x volume for every dollar of MC added', group: 'implied', pass: s => { const add = s.mc > 0 && s.chg1h > -100 ? s.mc - s.mc / (1 + s.chg1h / 100) : 0; return add > 0 ? s.vol1h / add > 2 : null; } },
  { key: 'iplHardWon',name: 'under 20x volume per dollar of MC added', group: 'implied', pass: s => { const add = s.mc > 0 && s.chg1h > -100 ? s.mc - s.mc / (1 + s.chg1h / 100) : 0; return add > 0 ? s.vol1h / add < 20 : null; } },
  { key: 'iplHolder', name: 'implied average holder position over $80',group: 'implied', pass: s => (s.deepOwners ?? 0) > 0 && s.mc > 0 ? (s.mc - s.liq) / s.deepOwners! > 80 : null },
  { key: 'iplHolderCap',name: 'implied average holder position under $2K', group: 'implied', pass: s => (s.deepOwners ?? 0) > 0 && s.mc > 0 ? (s.mc - s.liq) / s.deepOwners! < 2000 : null },
  { key: 'iplFloat',  name: 'liquidity is over 8% of the float',       group: 'implied', pass: s => s.mc > 0 ? s.liq / s.mc > 0.08 : null },
  { key: 'iplExit',   name: 'the pool could absorb 20 average holders',group: 'implied', pass: s => (s.deepOwners ?? 0) > 0 && s.mc > 0 ? s.liq > ((s.mc - s.liq) / s.deepOwners!) * 20 : null },

  // ── Either-or: a shape no AND rule can reach ──
  { key: 'orcVetOrInd', name: '5 veterans OR independent over 50%',    group: 'orcombo', pass: s => { const t = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); const a = s.veterans != null ? s.veterans >= 5 : null; const b = t > 0 ? (s.deepIndependent ?? 0) / t > 0.5 : null; return a === null && b === null ? null : (a === true || b === true); } },
  { key: 'orcSocOrVet', name: 'a social OR 10 veterans',               group: 'orcombo', pass: s => { const a = s.socials != null ? s.socials >= 1 : null; const b = s.veterans != null ? s.veterans >= 10 : null; return a === null && b === null ? null : (a === true || b === true); } },
  { key: 'orcLiqOrOwn', name: 'liq over $15K OR 150 owners',           group: 'orcombo', pass: s => { const b = s.deepOwners != null ? s.deepOwners >= 150 : null; if (s.liq <= 0 && b === null) return null; return s.liq > 15000 || b === true; } },
  { key: 'orcFreshOrVet',name: 'fresh under 50% OR 10 veterans',       group: 'orcombo', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); if (t === 0) return null; return ((s.freshWallets ?? 0) / t < 0.5) || ((s.veterans ?? 0) >= 10); } },
  { key: 'orcMomOrDepth',name: '1h positive OR 100 owners',            group: 'orcombo', pass: s => { const b = s.deepOwners != null ? s.deepOwners >= 100 : null; return s.chg1h > 0 || b === true; } },
  { key: 'orcBuyOrSize', name: 'buys over 60% OR average trade over $100', group: 'orcombo', pass: s => { const t = s.buys5m + s.sells5m; return t > 0 ? (s.buys5m / t > 0.6 || s.vol5m / t > 100) : null; } },
  { key: 'orcFundOrInd', name: '20 funders OR independent over 60%',   group: 'orcombo', pass: s => { const t = (s.deepIndependent ?? 0) + (s.deepCluster ?? 0); const a = s.deepFunders != null ? s.deepFunders >= 20 : null; const b = t > 0 ? (s.deepIndependent ?? 0) / t > 0.6 : null; return a === null && b === null ? null : (a === true || b === true); } },
  { key: 'orcAgeOrLiq',  name: 'older than 15m OR liq over $20K',      group: 'orcombo', pass: s => s.ageMin > 15 || s.liq > 20000 },
  { key: 'orcNotBoth',   name: 'not both a fresh majority and thin liquidity', group: 'orcombo', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); return t > 0 && s.liq > 0 ? !((s.freshWallets ?? 0) / t > 0.6 && s.liq < 8000) : null; } },
  { key: 'orcNotBoth2',  name: 'not both clustered and thin',          group: 'orcombo', pass: s => s.deepClusterPct != null && s.liq > 0 ? !(s.deepClusterPct > 25 && s.liq < 8000) : null },
  { key: 'orcAnyDepth',  name: 'any depth signal at all is strong',    group: 'orcombo', pass: s => { const vals = [s.veterans != null ? s.veterans >= 10 : null, s.deepOwners != null ? s.deepOwners >= 150 : null, s.deepFunders != null ? s.deepFunders >= 25 : null]; return vals.every(v => v === null) ? null : vals.some(v => v === true); } },
  { key: 'orcTwoOfThree',name: 'at least two of: 5 veterans, a social, liq over $10K', group: 'orcombo', pass: s => { const vals = [s.veterans != null ? s.veterans >= 5 : null, s.socials != null ? s.socials >= 1 : null, s.liq > 0 ? s.liq > 10000 : null]; const known = vals.filter(v => v !== null); return known.length < 2 ? null : known.filter(v => v === true).length >= 2; } },
  { key: 'orcTwoQuality',name: 'at least two of: fresh<60%, 1h positive, avg trade over $80', group: 'orcombo', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const tr = s.buys5m + s.sells5m; const vals = [t > 0 ? (s.freshWallets ?? 0) / t < 0.6 : null, s.chg1h !== 0 ? s.chg1h > 0 : null, tr > 0 ? s.vol5m / tr > 80 : null]; const known = vals.filter(v => v !== null); return known.length < 2 ? null : known.filter(v => v === true).length >= 2; } },
  { key: 'orcAllButOne', name: 'no more than one of five quality checks fails', group: 'orcombo', pass: s => { const t = (s.freshWallets ?? 0) + (s.veterans ?? 0); const tr = s.buys5m + s.sells5m; const vals = [t > 0 ? (s.freshWallets ?? 0) / t < 0.7 : null, s.liq > 0 ? s.liq > 10000 : null, s.chg1h !== 0 ? s.chg1h > 0 : null, tr > 0 ? s.buys5m / tr > 0.5 : null, s.deepOwners != null ? s.deepOwners >= 80 : null]; const known = vals.filter(v => v !== null); return known.length < 3 ? null : known.filter(v => v === false).length <= 1; } },
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
