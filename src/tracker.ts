import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { CONFIG } from './config.js';
import type { PumpFunCoin } from './pumpfun.js';
import type { MarketData } from './dexscreener.js';

// ── Types ───────────────────────────────────────────────────

export interface PerformanceSnapshot {
  intervalMin: number;
  price: number;
  marketCap: number;
  volume5m: number;
  timestamp: number;
}

export interface MilestoneHit {
  multiplier: number;
  price: number;
  marketCap: number;
  timestamp: number;
  discordMessageId?: string;
}

export interface CallRecord {
  mint: string;
  name: string;
  symbol: string;
  imageUri?: string;

  // Entry data (at time of alert)
  entryPrice: number;
  entryMC: number;
  entryVolume5m: number;
  entryTime: number;
  alertMessageId: string;

  // Rich entry features (all optional for back-compat with old records).
  // Used for correlation analysis to figure out which signals predict winners.
  entryVolume1h?: number;
  entryVolume24h?: number;
  entryLiquidity?: number;
  entryBuys5m?: number;
  entrySells5m?: number;
  entryBuys1h?: number;
  entrySells1h?: number;
  entryPriceChange5m?: number;
  entryPriceChange1h?: number;
  entryPriceChange6h?: number;
  entryDexId?: string;
  entryAgeMin?: number;          // token age at call time (minutes since pair creation)
  entrySmartHolders?: number;    // # smart wallets holding at call time
  entryBundleSafe?: boolean;     // bundle check verdict

  // Performance snapshots (5m, 15m, 30m, 1h — edits original message)
  snapshots: PerformanceSnapshot[];
  nextSnapshotIndex: number;
  snapshotsComplete: boolean;

  // Milestone tracking (2x, 3x, 5x, 10x… — sends new messages)
  hitMilestones: MilestoneHit[];
  peakMultiplier: number;
  peakPrice: number;
  peakMC: number;
}

// ── Tracker ─────────────────────────────────────────────────

export class PerformanceTracker {
  private calls = new Map<string, CallRecord>();

  constructor() {
    this.load();
  }

  /** Has this coin ever been alerted? */
  hasBeenCalled(mint: string): boolean {
    return this.calls.has(mint);
  }

  /** Register a new call. Returns the CallRecord. */
  add(
    coin: PumpFunCoin,
    market: MarketData,
    alertMessageId: string,
    extra?: { smartHolders?: number; bundleSafe?: boolean },
  ): CallRecord {
    const ageMin = market.pairCreatedAt > 0
      ? Math.floor((Date.now() - market.pairCreatedAt) / 60_000)
      : undefined;
    const rec: CallRecord = {
      mint: coin.mint,
      name: coin.name,
      symbol: coin.symbol,
      imageUri: coin.image_uri,
      entryPrice: market.priceUsd,
      entryMC: market.marketCap,
      entryVolume5m: market.volume5m,
      entryTime: Date.now(),
      alertMessageId,
      // Rich features for correlation
      entryVolume1h: market.volume1h,
      entryVolume24h: market.volume24h,
      entryLiquidity: market.liquidity,
      entryBuys5m: market.buys5m,
      entrySells5m: market.sells5m,
      entryBuys1h: market.buys1h,
      entrySells1h: market.sells1h,
      entryPriceChange5m: market.priceChange5m,
      entryPriceChange1h: market.priceChange1h,
      entryPriceChange6h: market.priceChange6h,
      entryDexId: market.dexId,
      entryAgeMin: ageMin,
      entrySmartHolders: extra?.smartHolders,
      entryBundleSafe: extra?.bundleSafe,
      // Tracking state
      snapshots: [],
      nextSnapshotIndex: 0,
      snapshotsComplete: false,
      hitMilestones: [],
      peakMultiplier: 1,
      peakPrice: market.priceUsd,
      peakMC: market.marketCap,
    };
    this.calls.set(coin.mint, rec);
    this.save();
    return rec;
  }

  // ── Performance snapshots ──

  getCallsNeedingSnapshot(): CallRecord[] {
    const now = Date.now();
    const result: CallRecord[] = [];
    for (const rec of this.calls.values()) {
      if (rec.snapshotsComplete) continue;
      const nextInterval = CONFIG.PERFORMANCE_INTERVALS[rec.nextSnapshotIndex];
      if (nextInterval === undefined) {
        rec.snapshotsComplete = true;
        continue;
      }
      const elapsedMin = (now - rec.entryTime) / 60_000;
      if (elapsedMin >= nextInterval) {
        result.push(rec);
      }
    }
    return result;
  }

  recordSnapshot(mint: string, snapshot: PerformanceSnapshot): void {
    const rec = this.calls.get(mint);
    if (!rec) return;
    rec.snapshots.push(snapshot);
    rec.nextSnapshotIndex++;
    if (rec.nextSnapshotIndex >= CONFIG.PERFORMANCE_INTERVALS.length) {
      rec.snapshotsComplete = true;
    }
    // Update peak
    const mult = snapshot.price / rec.entryPrice;
    if (mult > rec.peakMultiplier) {
      rec.peakMultiplier = mult;
      rec.peakPrice = snapshot.price;
      rec.peakMC = snapshot.marketCap;
    }
    this.save();
  }

  // ── Milestone tracking ──

  /** Get all calls. */
  getActiveCalls(): CallRecord[] {
    return [...this.calls.values()];
  }

  getByMint(mint: string): CallRecord | undefined {
    return this.calls.get(mint);
  }

  /** Update peak if current price is higher. Call this every time we have fresh price data. */
  updatePeak(mint: string, currentPrice: number, currentMC: number): void {
    const rec = this.calls.get(mint);
    if (!rec || rec.entryPrice === 0) return;
    const mult = currentPrice / rec.entryPrice;
    // Sanity check: if new mult jumps >50X above current peak in a single update,
    // it's almost certainly bad DexScreener data (legit moons show intermediate ticks)
    if (mult > rec.peakMultiplier * 50 && rec.peakMultiplier > 1) {
      console.warn(`[Tracker] Rejected suspicious peak for $${rec.symbol}: ${mult.toFixed(1)}X vs current ${rec.peakMultiplier.toFixed(1)}X — likely bad data`);
      return;
    }
    if (mult > rec.peakMultiplier) {
      rec.peakMultiplier = mult;
      rec.peakPrice = currentPrice;
      rec.peakMC = currentMC;
      this.save();
    }
  }

  /**
   * Check current price against entry and return any NEW milestones hit.
   * Updates the record in place.
   */
  checkMilestones(mint: string, currentPrice: number, currentMC: number): MilestoneHit[] {
    const rec = this.calls.get(mint);
    if (!rec || rec.entryPrice === 0) return [];

    const multiplier = currentPrice / rec.entryPrice;

    // Reject suspicious data (same guard as updatePeak)
    if (multiplier > rec.peakMultiplier * 50 && rec.peakMultiplier > 1) {
      return [];
    }

    // Update peak
    if (multiplier > rec.peakMultiplier) {
      rec.peakMultiplier = multiplier;
      rec.peakPrice = currentPrice;
      rec.peakMC = currentMC;
    }

    // Always save updated peak
    this.save();

    // Check each milestone
    const alreadyHit = new Set(rec.hitMilestones.map(m => m.multiplier));
    const newHits: MilestoneHit[] = [];

    for (const target of CONFIG.MILESTONES) {
      if (multiplier >= target && !alreadyHit.has(target)) {
        const hit: MilestoneHit = {
          multiplier: target,
          price: currentPrice,
          marketCap: currentMC,
          timestamp: Date.now(),
        };
        rec.hitMilestones.push(hit);
        newHits.push(hit);
      }
    }

    if (newHits.length > 0) {
      this.save();
    }

    return newHits;
  }

  /** Update the Discord alert message ID (e.g. after initial 'pending' placeholder). */
  setDiscordMsgId(mint: string, msgId: string): void {
    const rec = this.calls.get(mint);
    if (!rec) return;
    rec.alertMessageId = msgId;
    this.save();
  }

  /** Store the Discord message ID for a sent milestone alert. */
  setMilestoneMessageId(mint: string, multiplier: number, msgId: string): void {
    const rec = this.calls.get(mint);
    if (!rec) return;
    const hit = rec.hitMilestones.find(m => m.multiplier === multiplier);
    if (hit) hit.discordMessageId = msgId;
    this.save();
  }

  // ── Persistence ──

  private save(): void {
    try {
      mkdirSync(dirname(CONFIG.DATA_FILE), { recursive: true });
      const data = [...this.calls.values()];
      writeFileSync(CONFIG.DATA_FILE, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error(`[Tracker] Save error: ${err.message}`);
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(CONFIG.DATA_FILE, 'utf-8');
      const data: CallRecord[] = JSON.parse(raw);
      for (const rec of data) {
        this.calls.set(rec.mint, rec);
      }
      if (data.length > 0) {
        console.log(`[Tracker] Loaded ${data.length} previous calls from disk`);
      }
    } catch {
      // File doesn't exist yet — that's fine
    }
  }

  // ── Leaderboard ──

  /** Get all calls made within the given lookback window (ms). */
  getCallsSince(lookbackMs: number): CallRecord[] {
    const cutoff = Date.now() - lookbackMs;
    return [...this.calls.values()].filter(r => r.entryTime >= cutoff);
  }

  // ── Stats ──

  get size(): number {
    return this.calls.size;
  }

  get activeSnapshotCount(): number {
    let n = 0;
    for (const r of this.calls.values()) {
      if (!r.snapshotsComplete) n++;
    }
    return n;
  }
}
