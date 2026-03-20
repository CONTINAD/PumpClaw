import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { CONFIG } from './config.js';

// ── Types ────────────────────────────────────────────────────

export interface TradeExit {
  reason: 'tp1' | 'tp2' | 'tp3' | 'trailing_stop' | 'stop_loss' | 'be_stop';
  label: string;
  multiplierAtExit: number;
  pctSold: number;         // fraction of the ORIGINAL 1 SOL position
  solReturned: number;     // SOL received for this partial exit
  timestamp: number;
  discordMessageId?: string;
}

export interface PaperTrade {
  mint: string;
  symbol: string;
  name: string;

  entrySol: number;        // always 1 SOL
  entryPrice: number;
  entryMC: number;
  entryTime: number;

  // Stop loss (starts at entry * 0.70, moves to entry after TP1)
  stopLossPrice: number;
  beStopArmed: boolean;    // has the SL been moved to break-even?

  // Position
  remainingPct: number;    // 1.0 = fully open, 0.0 = fully exited
  exits: TradeExit[];
  totalSolReturned: number;

  // TP flags
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;

  // Trailing stop (activates after TP3)
  trailingActive: boolean;
  trailingHighPrice: number;
  trailingStopPrice: number;

  // Final state
  status: 'open' | 'closed';
  closedTime?: number;
  finalPnlSol?: number;

  discordEntryMsgId?: string;
}

// ── Class ────────────────────────────────────────────────────

export class PaperTrader {
  private trades = new Map<string, PaperTrade>();

  constructor() {
    this.load();
  }

  /** Open a new simulated trade when a call alert is sent. */
  openTrade(
    mint: string,
    symbol: string,
    name: string,
    entryPrice: number,
    entryMC: number,
  ): PaperTrade {
    const trade: PaperTrade = {
      mint,
      symbol,
      name,
      entrySol: CONFIG.PAPER_ENTRY_SOL,
      entryPrice,
      entryMC,
      entryTime: Date.now(),
      stopLossPrice: entryPrice * CONFIG.PAPER_STOP_LOSS_PCT,
      beStopArmed: false,
      remainingPct: 1.0,
      exits: [],
      totalSolReturned: 0,
      tp1Hit: false,
      tp2Hit: false,
      tp3Hit: false,
      trailingActive: false,
      trailingHighPrice: 0,
      trailingStopPrice: 0,
      status: 'open',
    };
    this.trades.set(mint, trade);
    this.save();
    return trade;
  }

  hasTrade(mint: string): boolean {
    return this.trades.has(mint);
  }

  getTrade(mint: string): PaperTrade | undefined {
    return this.trades.get(mint);
  }

  getOpenTrades(): PaperTrade[] {
    return [...this.trades.values()].filter(t => t.status === 'open');
  }

  getAllTrades(): PaperTrade[] {
    return [...this.trades.values()];
  }

  /** Trades opened on or after the start of the current calendar month (UTC). */
  getMonthTrades(): PaperTrade[] {
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    return [...this.trades.values()].filter(t => t.entryTime >= monthStart);
  }

  /**
   * Evaluate current price against stop / TP levels.
   * Returns any exits that fired in this check.
   * Call this every time fresh price data is available for an open trade.
   */
  checkTrade(mint: string, currentPrice: number, currentMC: number): TradeExit[] {
    const trade = this.trades.get(mint);
    if (!trade || trade.status === 'closed' || trade.remainingPct < 0.001) return [];

    const mult = currentPrice / trade.entryPrice;
    const newExits: TradeExit[] = [];

    const recordExit = (
      reason: TradeExit['reason'],
      label: string,
      pctOfOriginal: number,
      multOverride?: number,
    ): TradeExit => {
      const actualPct = Math.min(pctOfOriginal, trade.remainingPct);
      const exitMult = multOverride ?? mult;
      const solReturned = actualPct * CONFIG.PAPER_ENTRY_SOL * exitMult;
      const e: TradeExit = {
        reason,
        label,
        multiplierAtExit: exitMult,
        pctSold: actualPct,
        solReturned,
        timestamp: Date.now(),
      };
      trade.exits.push(e);
      trade.totalSolReturned += solReturned;
      trade.remainingPct = Math.max(0, trade.remainingPct - actualPct);
      newExits.push(e);
      return e;
    };

    // ── Take profit levels ──────────────────────────────────

    // TP1 @ 2X: sell 40%, arm break-even stop
    if (!trade.tp1Hit && mult >= CONFIG.PAPER_TP1_MULT) {
      trade.tp1Hit = true;
      recordExit('tp1', `TP1 ${CONFIG.PAPER_TP1_MULT}X`, CONFIG.PAPER_TP1_SELL);
      if (!trade.beStopArmed) {
        trade.beStopArmed = true;
        trade.stopLossPrice = trade.entryPrice; // SL moves to break-even
      }
    }

    // TP2 @ 3X: sell 30%
    if (!trade.tp2Hit && mult >= CONFIG.PAPER_TP2_MULT) {
      trade.tp2Hit = true;
      recordExit('tp2', `TP2 ${CONFIG.PAPER_TP2_MULT}X`, CONFIG.PAPER_TP2_SELL);
    }

    // TP3 @ 5X: sell 20%, activate trailing stop on remaining 10%
    if (!trade.tp3Hit && mult >= CONFIG.PAPER_TP3_MULT) {
      trade.tp3Hit = true;
      recordExit('tp3', `TP3 ${CONFIG.PAPER_TP3_MULT}X`, CONFIG.PAPER_TP3_SELL);
      trade.trailingActive = true;
      trade.trailingHighPrice = currentPrice;
      trade.trailingStopPrice = currentPrice * (1 - CONFIG.PAPER_TRAILING_DROP);
    }

    // ── Update trailing stop high ──────────────────────────
    if (trade.trailingActive && currentPrice > trade.trailingHighPrice) {
      trade.trailingHighPrice = currentPrice;
      trade.trailingStopPrice = currentPrice * (1 - CONFIG.PAPER_TRAILING_DROP);
    }

    // ── Stop checks (only if position still open) ──────────

    if (trade.remainingPct >= 0.001) {
      // Trailing stop fires first if active
      if (trade.trailingActive && currentPrice <= trade.trailingStopPrice) {
        recordExit('trailing_stop', 'Trailing Stop', trade.remainingPct);
      }
      // Regular / break-even stop
      else if (currentPrice <= trade.stopLossPrice) {
        const reason = trade.beStopArmed ? 'be_stop' : 'stop_loss';
        const label = trade.beStopArmed ? 'Break-Even Stop' : 'Stop Loss −30%';
        recordExit(reason, label, trade.remainingPct);
      }
    }

    // Close trade if position fully exited
    if (trade.remainingPct < 0.001 && (trade.status as string) !== 'closed') {
      trade.status = 'closed';
      trade.closedTime = Date.now();
      trade.finalPnlSol = trade.totalSolReturned - trade.entrySol;
    }

    if (newExits.length > 0) this.save();
    return newExits;
  }

  /** Current PnL for a trade (realized exits + unrealized remaining). */
  currentPnl(mint: string, currentPrice?: number): number {
    const trade = this.trades.get(mint);
    if (!trade) return 0;
    if (trade.status === 'closed') return trade.finalPnlSol ?? 0;
    const currentMult = currentPrice ? currentPrice / trade.entryPrice : 1;
    const unrealized = trade.remainingPct * trade.entrySol * currentMult;
    return trade.totalSolReturned + unrealized - trade.entrySol;
  }

  // ── Persistence ──────────────────────────────────────────

  private save(): void {
    try {
      mkdirSync(dirname(CONFIG.PAPER_DATA_FILE), { recursive: true });
      const data = [...this.trades.values()];
      writeFileSync(CONFIG.PAPER_DATA_FILE, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error(`[PaperTrader] Save error: ${err.message}`);
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(CONFIG.PAPER_DATA_FILE, 'utf-8');
      const data: PaperTrade[] = JSON.parse(raw);
      for (const t of data) this.trades.set(t.mint, t);
      if (data.length > 0) {
        const open = data.filter(t => t.status === 'open').length;
        console.log(`[PaperTrader] Loaded ${data.length} trades (${open} open)`);
      }
    } catch {
      // File doesn't exist yet — that's fine
    }
  }
}
