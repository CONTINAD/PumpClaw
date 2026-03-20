/**
 * Real trading orchestration: buy on alert, sell on TP/SL triggers.
 * Wraps Jupiter swaps with balance checks, error handling, and position tracking.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { CONFIG } from './config.js';
import { getSolBalance, getTokenBalance, closeTokenAccount } from './wallet.js';
import { jupiterBuy, jupiterSell, type SwapResult } from './jupiter.js';

const POSITIONS_FILE = `${CONFIG.DATA_DIR}/positions.json`;

// ── Types ────────────────────────────────────────────────────

export interface RealExit {
  reason: 'tp1' | 'tp2' | 'tp3' | 'trailing_stop' | 'stop_loss' | 'be_stop' | 'profit_protect';
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

  // TP flags
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

  constructor() {
    this.load();
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

    // Check SOL balance and calculate entry size (5% of balance)
    let balance: number;
    try {
      balance = await getSolBalance();
    } catch (err: any) {
      console.error(`[Trader] Balance check failed: ${err.message}`);
      return null;
    }

    if (balance < CONFIG.TRADE_MIN_SOL_BALANCE) {
      console.log(`[Trader] Balance too low: ${balance.toFixed(4)} SOL (min ${CONFIG.TRADE_MIN_SOL_BALANCE})`);
      return null;
    }

    const rawEntry = Math.floor(balance * CONFIG.TRADE_ENTRY_PCT * 1000) / 1000; // round down to 3 decimals
    const entrySol = Math.max(rawEntry, CONFIG.TRADE_MIN_ENTRY_SOL);
    if (balance - entrySol < CONFIG.TRADE_MIN_SOL_BALANCE) {
      console.log(`[Trader] Not enough balance for min entry: ${balance.toFixed(4)} SOL - ${entrySol} SOL would leave < ${CONFIG.TRADE_MIN_SOL_BALANCE}`);
      return null;
    }

    // Execute buy
    let result: SwapResult;
    try {
      console.log(`[Trader] Buying $${symbol} with ${entrySol} SOL (${(CONFIG.TRADE_ENTRY_PCT * 100).toFixed(0)}% of ${balance.toFixed(4)} SOL, min ${CONFIG.TRADE_MIN_ENTRY_SOL})...`);
      result = await jupiterBuy(mint, entrySol);
    } catch (err: any) {
      console.error(`[Trader] Buy failed for $${symbol}: ${err.message}`);
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
      stopLossPrice: currentPrice * CONFIG.TRADE_STOP_LOSS_PCT,
      beStopArmed: false,
      remainingPct: 1.0,
      tokensRemaining: result.outputAmount,
      exits: [],
      totalSolReturned: 0,
      tp1Hit: false,
      tp2Hit: false,
      tp3Hit: false,
      peakMultiplier: 1,
      trailingActive: false,
      trailingHighPrice: 0,
      trailingStopPrice: 0,
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
        actualBalance = await getTokenBalance(mint);
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
        closeTokenAccount(mint).catch(() => {});
        return null;
      }

      // Attempt sell with retry: if first attempt fails, wait 5s, verify balance, retry
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const tokensNow = attempt === 1 ? sellAmount : await getTokenBalance(mint);
          if (tokensNow <= 0) {
            console.log(`[Trader] Verified $${pos.symbol} tokens already sold (balance = 0)`);
            pos.remainingPct = 0;
            pos.tokensRemaining = 0;
            return null;
          }

          const finalSellAmount = attempt === 1 ? sellAmount : tokensNow;
          console.log(`[Trader] Selling ${finalSellAmount} tokens of $${pos.symbol} (${label})${attempt > 1 ? ` [RETRY #${attempt}]` : ''}...`);
          const result = await jupiterSell(mint, finalSellAmount);

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

    // ── Take profit levels ──

    // TP1 @ 2X: sell 40%, arm break-even stop
    if (!pos.tp1Hit && mult >= CONFIG.TRADE_TP1_MULT) {
      pos.tp1Hit = true;
      await executeSell('tp1', `TP1 ${CONFIG.TRADE_TP1_MULT}X`, CONFIG.TRADE_TP1_SELL);
      if (!pos.beStopArmed) {
        pos.beStopArmed = true;
        pos.stopLossPrice = pos.entryPrice;
      }
    }

    // TP2 @ 3X: sell 30%
    if (!pos.tp2Hit && mult >= CONFIG.TRADE_TP2_MULT) {
      pos.tp2Hit = true;
      await executeSell('tp2', `TP2 ${CONFIG.TRADE_TP2_MULT}X`, CONFIG.TRADE_TP2_SELL);
    }

    // TP3 @ 5X: sell 20%, activate trailing stop
    if (!pos.tp3Hit && mult >= CONFIG.TRADE_TP3_MULT) {
      pos.tp3Hit = true;
      await executeSell('tp3', `TP3 ${CONFIG.TRADE_TP3_MULT}X`, CONFIG.TRADE_TP3_SELL);
      pos.trailingActive = true;
      pos.trailingHighPrice = currentPrice;
      pos.trailingStopPrice = currentPrice * (1 - CONFIG.TRADE_TRAILING_DROP);
    }

    // ── Update trailing stop high ──
    if (pos.trailingActive && currentPrice > pos.trailingHighPrice) {
      pos.trailingHighPrice = currentPrice;
      pos.trailingStopPrice = currentPrice * (1 - CONFIG.TRADE_TRAILING_DROP);
    }

    // ── Stop checks ──
    if (pos.remainingPct >= 0.001) {
      if (pos.trailingActive && currentPrice <= pos.trailingStopPrice) {
        await executeSell('trailing_stop', 'Trailing Stop', pos.remainingPct);
      } else if ((pos.peakMultiplier ?? 1) >= 1.5 && mult <= 1.0) {
        // Profit protection: was up 50%+ but dumped back to break-even
        await executeSell('profit_protect', `Profit Protect (peaked ${pos.peakMultiplier.toFixed(1)}X)`, pos.remainingPct);
      } else if (currentPrice <= pos.stopLossPrice) {
        const reason = pos.beStopArmed ? 'be_stop' : 'stop_loss';
        const label = pos.beStopArmed ? 'Break-Even Stop' : `Stop Loss −${((1 - CONFIG.TRADE_STOP_LOSS_PCT) * 100).toFixed(0)}%`;
        await executeSell(reason, label, pos.remainingPct);
      }
    }

    // Close if fully exited
    if (pos.remainingPct < 0.001 && pos.status === 'open') {
      pos.status = 'closed';
      pos.closedTime = Date.now();
      pos.finalPnlSol = pos.totalSolReturned - pos.entrySol;

      // Close token account to reclaim rent SOL (fire and forget)
      closeTokenAccount(mint).catch(err =>
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

  // ── Persistence ──

  private save(): void {
    try {
      mkdirSync(dirname(POSITIONS_FILE), { recursive: true });
      const data = [...this.positions.values()];
      writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error(`[Trader] Save error: ${err.message}`);
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(POSITIONS_FILE, 'utf-8');
      const data: RealPosition[] = JSON.parse(raw);
      for (const p of data) this.positions.set(p.mint, p);
      if (data.length > 0) {
        const open = data.filter(p => p.status === 'open').length;
        console.log(`[Trader] Loaded ${data.length} positions (${open} open)`);
      }
    } catch {
      // File doesn't exist yet
    }
  }
}
