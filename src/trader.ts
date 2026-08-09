/**
 * Real trading orchestration: buy on alert, sell on TP/SL triggers.
 * Wraps Jupiter swaps with balance checks, error handling, and position tracking.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Keypair } from '@solana/web3.js';
import { CONFIG } from './config.js';
import { getSolBalance, getTokenBalance, closeTokenAccount } from './wallet.js';
import { jupiterBuy, jupiterSell, type SwapResult, type SwapOpts } from './jupiter.js';
import { STRATEGY_PRESETS, type Strategy } from './strategy.js';

// ── Types ────────────────────────────────────────────────────

export interface RealExit {
  reason: string;  // 'tp1'..'tpN' | 'trailing_stop' | 'stop_loss' | 'be_stop' | 'profit_protect'
  label: string;
  multiplierAtExit: number;
  pctSold: number;
  tokensSold: number;
  solReceived: number;
  txSignature: string;
  timestamp: number;
}

export interface RealPosition {
  mint: string;
  symbol: string;
  name: string;

  entrySol: number;
  entryPrice: number;
  entryMC: number;
  entryTime: number;
  entryTx: string;
  tokensReceived: number;

  // Stop loss
  stopLossPrice: number;
  beStopArmed: boolean;

  // Position tracking
  remainingPct: number;        // 1.0 → 0.0
  tokensRemaining: number;
  exits: RealExit[];
  totalSolReturned: number;

  // TP flags — tpHits is the generalized form (one per strategy TP level);
  // tp1Hit..tp3Hit kept for backward compat with old position files
  tpHits?: boolean[];
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;

  // Peak tracking (for profit protection)
  peakMultiplier: number;

  // Trailing stop
  trailingActive: boolean;
  trailingHighPrice: number;
  trailingStopPrice: number;

  // State
  status: 'open' | 'closed' | 'error';
  closedTime?: number;
  finalPnlSol?: number;
  error?: string;
}

// ── Trader class ─────────────────────────────────────────────

export class Trader {
  private positions = new Map<string, RealPosition>();
  private positionsFile: string;

  /**
   * @param taskId    stable id — 'main' keeps the legacy positions.json
   * @param keypair   task wallet; null = legacy singleton wallet (env/volume)
   * @param getStrategy live strategy provider — dashboard edits apply instantly
   */
  constructor(
    private taskId: string = 'main',
    private keypair: Keypair | null = null,
    private getStrategy: () => Strategy = () => STRATEGY_PRESETS.trailing45.make(),
  ) {
    this.positionsFile = taskId === 'main'
      ? `${CONFIG.DATA_DIR}/positions.json`
      : `${CONFIG.DATA_DIR}/positions-${taskId}.json`;
    this.load();
  }

  private kp(): Keypair | undefined { return this.keypair ?? undefined; }

  private swapOpts(): SwapOpts {
    const s = this.getStrategy();
    return { keypair: this.kp(), slippageBps: s.slippageBps, priorityFeeLamports: s.priorityFeeLamports };
  }

  /**
   * Execute a real buy via Jupiter.
   * Returns the position or null if the buy failed / was skipped.
   */
  async buy(
    mint: string,
    symbol: string,
    name: string,
    currentPrice: number,
    currentMC: number,
  ): Promise<RealPosition | null> {
    if (!CONFIG.TRADE_ENABLED) return null;

    // Skip if we already have an open position for this mint
    const existing = this.positions.get(mint);
    if (existing && existing.status === 'open') {
      console.log(`[Trader] Already have open position for $${symbol}, skipping`);
      return null;
    }

    // Check SOL balance and calculate entry size
    let balance: number;
    for (let balAttempt = 1; balAttempt <= 3; balAttempt++) {
      try {
        balance = await getSolBalance(this.kp());
        break;
      } catch (err: any) {
        console.error(`[Trader] Balance check failed (attempt ${balAttempt}): ${err.message}`);
        if (balAttempt < 3) {
          await new Promise(r => setTimeout(r, 2000));
        } else {
          return null;
        }
      }
    }

    // Entry sizing from the task's strategy (was a hardcoded 15% that ignored config)
    const strat = this.getStrategy();
    const entryPct = strat.entryPct;
    const rawEntry = Math.floor(balance! * entryPct * 1000) / 1000;
    let entrySol = Math.max(rawEntry, strat.minEntrySol);
    if (strat.maxEntrySol > 0) entrySol = Math.min(entrySol, strat.maxEntrySol);

    // Need at least enough for the entry + a tiny bit for tx fees (~0.005 SOL)
    if (balance! < entrySol + 0.005) {
      console.log(`[Trader] Balance too low for entry: ${balance!.toFixed(4)} SOL (need ${entrySol} + fees)`);
      return null;
    }

    // Execute buy with retry + confirmation check
    let result: SwapResult | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[Trader] Buying $${symbol} with ${entrySol} SOL (${(entryPct * 100).toFixed(0)}% of ${balance!.toFixed(4)} SOL)${attempt > 1 ? ` [RETRY #${attempt}]` : ''}...`);
        result = await jupiterBuy(mint, entrySol, this.swapOpts());
        break;
      } catch (err: any) {
        console.error(`[Trader] Buy failed for $${symbol} (attempt ${attempt}): ${err.message}`);

        // Check if tokens arrived despite the error (tx may have gone through)
        try {
          const tokenBal = await getTokenBalance(mint, this.kp());
          if (tokenBal > 0) {
            console.log(`[Trader] ⚠ Buy error but tokens detected (${tokenBal}) — treating as success`);
            result = {
              txSignature: 'confirmed-via-balance-check',
              inputAmount: Math.floor(entrySol * 1e9),
              outputAmount: tokenBal,
              priceImpactPct: 0,
            };
            break;
          }
        } catch { /* ignore balance check error */ }

        if (attempt < 3) {
          console.log(`[Trader] Retrying buy for $${symbol} in 3s...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    if (!result) {
      console.error(`[Trader] ❌ Buy FAILED after 3 attempts for $${symbol}`);
      return null;
    }

    const position: RealPosition = {
      mint,
      symbol,
      name,
      entrySol,
      entryPrice: currentPrice,
      entryMC: currentMC,
      entryTime: Date.now(),
      entryTx: result.txSignature,
      tokensReceived: result.outputAmount,
      // trailing-from-entry: the trailing stop IS the stop — the fixed SL sits at the
      // same level so it can't fire first and neuter the wide trailing stop
      stopLossPrice: strat.trailingFrom === 'entry'
        ? currentPrice * (1 - strat.trailingDrop)
        : currentPrice * strat.stopLossPct,
      beStopArmed: false,
      remainingPct: 1.0,
      tokensRemaining: result.outputAmount,
      exits: [],
      totalSolReturned: 0,
      tpHits: strat.tps.map(() => false),
      tp1Hit: false,
      tp2Hit: false,
      tp3Hit: false,
      peakMultiplier: 1,
      // trailing-from-entry strategies arm the trailing stop immediately —
      // initial stop = entry × (1 − drop), ratchets up with every new ATH
      trailingActive: strat.trailingFrom === 'entry',
      trailingHighPrice: strat.trailingFrom === 'entry' ? currentPrice : 0,
      trailingStopPrice: strat.trailingFrom === 'entry' ? currentPrice * (1 - strat.trailingDrop) : 0,
      status: 'open',
    };

    this.positions.set(mint, position);
    this.save();

    console.log(`[Trader] ✅ Bought ${result.outputAmount} tokens of $${symbol} for ${entrySol} SOL (tx: ${result.txSignature.slice(0, 16)}...)`);
    return position;
  }

  /**
   * Check price against TP/SL levels and execute sells.
   * Returns any exits that fired.
   */
  async checkPosition(mint: string, currentPrice: number, currentMC: number): Promise<RealExit[]> {
    const pos = this.positions.get(mint);
    if (!pos || pos.status !== 'open' || pos.remainingPct < 0.001) return [];

    const mult = currentPrice / pos.entryPrice;
    const newExits: RealExit[] = [];

    // Track peak multiplier
    if (mult > (pos.peakMultiplier ?? 1)) {
      pos.peakMultiplier = mult;
    }

    // Helper to execute a partial sell
    const executeSell = async (
      reason: RealExit['reason'],
      label: string,
      pctOfOriginal: number,
    ): Promise<RealExit | null> => {
      const isFullExit = pctOfOriginal >= pos.remainingPct - 0.001;
      const actualPct = Math.min(pctOfOriginal, pos.remainingPct);
      const tokensToSell = Math.floor(pos.tokensReceived * actualPct);

      if (tokensToSell <= 0) return null;

      // Verify we actually hold enough tokens
      let actualBalance: number;
      try {
        actualBalance = await getTokenBalance(mint, this.kp());
      } catch {
        actualBalance = pos.tokensRemaining;
      }

      // On final sell, use full on-chain balance to sweep dust
      const sellAmount = isFullExit ? actualBalance : Math.min(tokensToSell, actualBalance);
      if (sellAmount <= 0) {
        console.log(`[Trader] No tokens to sell for $${pos.symbol} ${label}`);
        // Close the position since we have no tokens
        pos.remainingPct = 0;
        pos.tokensRemaining = 0;
        pos.status = 'closed';
        pos.closedTime = Date.now();
        pos.finalPnlSol = pos.totalSolReturned - pos.entrySol;
        this.save();
        // Close token account to reclaim rent
        closeTokenAccount(mint, this.kp()).catch(() => {});
        return null;
      }

      // Attempt sell with retry: if first attempt fails, wait 5s, verify balance, retry
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const tokensNow = attempt === 1 ? sellAmount : await getTokenBalance(mint, this.kp());
          if (tokensNow <= 0) {
            console.log(`[Trader] Verified $${pos.symbol} tokens already sold (balance = 0)`);
            pos.remainingPct = 0;
            pos.tokensRemaining = 0;
            return null;
          }

          const finalSellAmount = attempt === 1 ? sellAmount : tokensNow;
          console.log(`[Trader] Selling ${finalSellAmount} tokens of $${pos.symbol} (${label})${attempt > 1 ? ` [RETRY #${attempt}]` : ''}...`);
          const result = await jupiterSell(mint, finalSellAmount, this.swapOpts());

          const solReceived = result.outputAmount / 1e9;
          const exit: RealExit = {
            reason,
            label,
            multiplierAtExit: mult,
            pctSold: actualPct,
            tokensSold: finalSellAmount,
            solReceived,
            txSignature: result.txSignature,
            timestamp: Date.now(),
          };

          pos.exits.push(exit);
          pos.totalSolReturned += solReceived;
          pos.remainingPct = Math.max(0, pos.remainingPct - actualPct);
          pos.tokensRemaining = Math.max(0, pos.tokensRemaining - finalSellAmount);
          newExits.push(exit);

          console.log(`[Trader] ✅ ${label}: sold ${finalSellAmount} tokens → ${solReceived.toFixed(4)} SOL (tx: ${result.txSignature.slice(0, 16)}...)`);
          return exit;
        } catch (err: any) {
          console.error(`[Trader] Sell failed for $${pos.symbol} (${label}) attempt ${attempt}: ${err.message}`);
          if (attempt < 2) {
            console.log(`[Trader] Retrying $${pos.symbol} sell in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }

      console.error(`[Trader] ⚠ Sell FAILED after 2 attempts for $${pos.symbol} (${label}) — will retry next check cycle`);
      return null;
    };

    // ── Take profit levels (generalized: any number of TPs from the strategy) ──
    const strat = this.getStrategy();
    if (!pos.tpHits || pos.tpHits.length !== strat.tps.length) {
      // Position opened under a different strategy shape (or legacy file) —
      // rebuild flags, preserving legacy tp1..tp3 hits where they line up
      pos.tpHits = strat.tps.map((_, i) => [pos.tp1Hit, pos.tp2Hit, pos.tp3Hit][i] ?? false);
    }

    for (let i = 0; i < strat.tps.length; i++) {
      const tp = strat.tps[i];
      if (!pos.tpHits[i] && mult >= tp.mult) {
        pos.tpHits[i] = true;
        if (i < 3) (pos as any)[`tp${i + 1}Hit`] = true;
        await executeSell(`tp${i + 1}`, `TP${i + 1} ${tp.mult}X`, tp.sellPct);
        if (i === 0 && strat.breakEvenAfterTp1 && !pos.beStopArmed) {
          pos.beStopArmed = true;
          pos.stopLossPrice = pos.entryPrice;
        }
      }
    }

    // Arm trailing after the last TP (ladder-style strategies)
    const allTpsHit = strat.tps.length > 0 && pos.tpHits.every(Boolean);
    if (strat.trailingFrom === 'afterLastTp' && allTpsHit && !pos.trailingActive) {
      pos.trailingActive = true;
      pos.trailingHighPrice = currentPrice;
      pos.trailingStopPrice = currentPrice * (1 - strat.trailingDrop);
    }

    // ── Update trailing stop high (drop % is live-editable per task) ──
    if (pos.trailingActive && currentPrice > pos.trailingHighPrice) {
      pos.trailingHighPrice = currentPrice;
    }
    if (pos.trailingActive) {
      pos.trailingStopPrice = pos.trailingHighPrice * (1 - strat.trailingDrop);
    }

    const ladderMode = strat.trailingFrom === 'afterLastTp';

    // ── Stop checks ──
    if (pos.remainingPct >= 0.001) {
      if (pos.trailingActive && currentPrice <= pos.trailingStopPrice) {
        await executeSell('trailing_stop', `Trailing Stop −${(strat.trailingDrop * 100).toFixed(0)}% (ATH ${(pos.trailingHighPrice / pos.entryPrice).toFixed(1)}X)`, pos.remainingPct);
      } else if (ladderMode && (pos.peakMultiplier ?? 1) >= 1.5 && mult <= 1.0) {
        // Profit protection (ladder only): was up 50%+ but dumped back to break-even.
        // In trailing mode this would be a hidden TP that contradicts letting winners breathe.
        await executeSell('profit_protect', `Profit Protect (peaked ${pos.peakMultiplier.toFixed(1)}X)`, pos.remainingPct);
      } else if (currentPrice <= pos.stopLossPrice) {
        const reason = pos.beStopArmed ? 'be_stop' : 'stop_loss';
        const label = pos.beStopArmed ? 'Break-Even Stop' : `Stop Loss −${((1 - strat.stopLossPct) * 100).toFixed(0)}%`;
        await executeSell(reason, label, pos.remainingPct);
      }
    }

    // Close if fully exited
    if (pos.remainingPct < 0.001 && pos.status === 'open') {
      pos.status = 'closed';
      pos.closedTime = Date.now();
      pos.finalPnlSol = pos.totalSolReturned - pos.entrySol;

      // Close token account to reclaim rent SOL (fire and forget)
      closeTokenAccount(mint, this.kp()).catch(err =>
        console.log(`[Trader] Token account close skipped for $${pos.symbol}: ${err.message}`),
      );
    }

    if (newExits.length > 0) this.save();
    return newExits;
  }

  getPosition(mint: string): RealPosition | undefined {
    return this.positions.get(mint);
  }

  getOpenPositions(): RealPosition[] {
    return [...this.positions.values()].filter(p => p.status === 'open');
  }

  getAllPositions(): RealPosition[] {
    return [...this.positions.values()];
  }

  // ── Persistence ──

  private save(): void {
    try {
      mkdirSync(dirname(this.positionsFile), { recursive: true });
      const data = [...this.positions.values()];
      writeFileSync(this.positionsFile, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error(`[Trader] Save error: ${err.message}`);
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(this.positionsFile, 'utf-8');
      const data: RealPosition[] = JSON.parse(raw);
      for (const p of data) this.positions.set(p.mint, p);
      if (data.length > 0) {
        const open = data.filter(p => p.status === 'open').length;
        console.log(`[Trader:${this.taskId}] Loaded ${data.length} positions (${open} open)`);
      }
    } catch {
      // File doesn't exist yet
    }
  }
}
