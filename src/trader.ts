/**
 * Real trading orchestration: buy on alert, sell on TP/SL triggers.
 * Wraps Jupiter swaps with balance checks, error handling, and position tracking.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Keypair } from '@solana/web3.js';
import { CONFIG } from './config.js';
import { getSolBalance, getSolBalanceFresh, getTokenBalance, closeTokenAccount, getConnection, mintDecimals } from './wallet.js';
import { getSolPrice } from './dexscreener.js';
import { jupiterBuy, jupiterSell, jupiterGetPrice, type SwapResult, type SwapOpts } from './jupiter.js';
import { STRATEGY_PRESETS, type Strategy } from './strategy.js';
import { sendOpsAlert } from './discord.js';
import { CONFIG as CFG } from './config.js';

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

  // Once a stop condition fires, this stays true until the position is flat — the
  // panic seller keeps hammering regardless of what price feeds say afterwards.
  stopTriggered?: boolean;

  // Entry audit — proves the recorded basis came from the chain, not a quote.
  quotedPrice?: number;      // what the feed said when we decided to buy
  quotedTokens?: number;     // what Jupiter's quote promised
  fillSlipPct?: number;      // (fill / quote - 1) * 100
  entrySource?: 'chain' | 'quote';

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
  private sellFailCounts = new Map<string, number>();
  /**
   * Earliest time a further sell may be attempted for a mint.
   *
   * A failed exit used to retry on the very next loop tick, four times a second,
   * forever. Against a shared rate limit that is not persistence, it is a denial of
   * service aimed at ourselves: the retries keep the quota empty, so the sell can
   * never land and no other trade can either. Spacing them costs nothing — the
   * blocker on a failing sell is never that we asked too rarely.
   */
  private nextSellAttempt = new Map<string, number>();
  /**
   * Failures counted for PACING only.
   *
   * Deliberately separate from sellFailCounts, which escalates slippage. Being
   * refused by Jupiter is not evidence that the market will not fill us, so a rate
   * limit must not widen slippage — but it must still slow the retries down.
   */
  private sellAttemptFails = new Map<string, number>();
  private tpFailCounts = new Map<string, number>();

  /**
   * Why the last buy attempt did not open a position.
   *
   * Every skip in the buy path used to be a bare `return null`, so a live task
   * declining a call was indistinguishable from one that was never asked. Three
   * separate faults hid behind that on 2026-08-13 — an unsubscribed task, a
   * sizing config nobody could see, and a balance read 48 minutes stale — and each
   * took a fresh investigation because the bot never said what it did.
   */
  lastSkip: string | null = null;
  private lastSellFailAlert = new Map<string, number>();

  /**
   * @param taskId    stable id — 'main' keeps the legacy positions.json
   * @param keypair   task wallet; null = legacy singleton wallet (env/volume)
   * @param getStrategy live strategy provider — dashboard edits apply instantly
   */
  constructor(
    private taskId: string = 'main',
    private keypair: Keypair | null = null,
    private getStrategy: () => Strategy = () => STRATEGY_PRESETS.trailing45.make(),
    private paper: boolean = false,
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
    this.lastSkip = null;
    if (!CONFIG.TRADE_ENABLED) { this.lastSkip = 'trading disabled'; return null; }

    // Skip if we already have an open position for this mint
    const existing = this.positions.get(mint);
    if (existing && existing.status === 'open') {
      this.lastSkip = 'already holding this coin';
      console.log(`[Trader] Already have open position for $${symbol}, skipping`);
      return null;
    }

    // Paper task: simulate a flat 1 SOL fill at current price — no wallet, no Jupiter.
    // Same position book + exit engine as real trades, so the PATH (dips included)
    // is what decides the outcome. This is the ground truth the peak-model lab lacks.
    if (this.paper) {
      const entrySol = 1.0;
      const strat0 = this.getStrategy();
      const tokens = currentPrice > 0 ? entrySol / currentPrice : 0;
      if (tokens <= 0) return null;
      const position: RealPosition = {
        mint, symbol, name,
        entrySol,
        entryPrice: currentPrice,
        entryMC: currentMC,
        entryTime: Date.now(),
        entryTx: 'paper',
        tokensReceived: tokens,
        // tighter of the trailing floor and the configured stop (same rule as live)
        stopLossPrice: strat0.trailingFrom === 'entry'
          ? currentPrice * Math.max(1 - strat0.trailingDrop, strat0.stopLossPct)
          : currentPrice * strat0.stopLossPct,
        beStopArmed: false,
        remainingPct: 1.0,
        tokensRemaining: tokens,
        exits: [],
        totalSolReturned: 0,
        tpHits: strat0.tps.map(() => false),
        tp1Hit: false, tp2Hit: false, tp3Hit: false,
        peakMultiplier: 1,
        trailingActive: strat0.trailingFrom === 'entry',
        trailingHighPrice: strat0.trailingFrom === 'entry' ? currentPrice : 0,
        trailingStopPrice: strat0.trailingFrom === 'entry' ? currentPrice * (1 - strat0.trailingDrop) : 0,
        status: 'open',
      };
      this.positions.set(mint, position);
      this.save();
      console.log(`[Trader:${this.taskId}] 📄 Paper buy $${symbol} @ ${currentPrice}`);
      return position;
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
          this.lastSkip = `balance lookup failed: ${err.message}`;
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

    // Need at least enough for the entry + a tiny bit for tx fees (~0.005 SOL).
    //
    // Before giving up, re-read at the freshest commitment available. The shared
    // connection has served a balance 48 minutes stale, and that skipped a call
    // without a trace: a stale read and an empty wallet look identical here.
    if (balance! < entrySol + 0.005) {
      const fresh = await getSolBalanceFresh(this.kp()).catch(() => balance!);
      if (fresh > balance!) {
        console.log(`[Trader] Balance read was stale (${balance!.toFixed(4)} -> ${fresh.toFixed(4)} SOL) — recomputing entry`);
        balance = fresh;
        const raw2 = Math.floor(balance * entryPct * 1000) / 1000;
        entrySol = Math.max(raw2, strat.minEntrySol);
        if (strat.maxEntrySol > 0) entrySol = Math.min(entrySol, strat.maxEntrySol);
      }
    }
    if (balance! < entrySol + 0.005) {
      this.lastSkip = `balance ${balance!.toFixed(4)} SOL < entry ${entrySol} + fees`;
      console.log(`[Trader] Balance too low for entry: ${balance!.toFixed(4)} SOL (need ${entrySol} + fees)`);
      return null;
    }

    // Never open a second entry into a coin we already hold.
    //
    // On 08-13 three coins were each bought 4-7 times within seconds, in a
    // descending ladder — 0.047, 0.023, 0.027, 0.005 SOL — which is entryPct
    // recomputed against a balance the previous buy had already reduced. The buys
    // were landing; the confirmations were not. openPosition returned null, so no
    // position was recorded, so the next scan saw an unheld coin and bought it
    // again. That drained the wallet to zero.
    //
    // A wallet that already holds the mint is the ground truth no bookkeeping error
    // can contradict. If the read itself fails we proceed rather than block, since
    // refusing to trade on an unreadable balance would stop every call during a
    // rate-limit spell.
    const preHeld = await getTokenBalance(mint, this.kp()).catch(() => -1);
    if (preHeld > 0) {
      this.lastSkip = `already holding ${preHeld} tokens of ${symbol} with no open position — ` +
        `a previous buy landed without confirming; not buying again`;
      // The reconciler reports untracked bags but does not adopt them, so this one
      // needs a person. Saying so is the point: silently declining to buy would look
      // identical to the filters rejecting the coin.
      console.error(`[Trader] ⚠ ${symbol}: wallet already holds ${preHeld} tokens but no position is recorded — ` +
        `a previous buy landed without confirming. Refusing a second entry. This bag is UNMANAGED ` +
        `(no stop, no take-profit) until it is adopted or sold by hand.`);
      return null;
    }

    let lastBuyError: string | null = null;
    // Execute buy with retry + confirmation check
    let result: SwapResult | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[Trader] Buying $${symbol} with ${entrySol} SOL (${(entryPct * 100).toFixed(0)}% of ${balance!.toFixed(4)} SOL)${attempt > 1 ? ` [RETRY #${attempt}]` : ''}...`);
        result = await jupiterBuy(mint, entrySol, { ...this.swapOpts(), urgency: 'normal', maxTipLamports: Math.floor(entrySol * 1e9 * 0.01) });
        break;
      } catch (err: any) {
        // Keep the real reason. "swap failed after 3 attempts" is not a diagnosis —
        // it discards the one string that says whether this was a blockhash expiry,
        // an RPC rejection, a timeout or a bad route, and without it the next
        // investigation starts from nothing again.
        lastBuyError = err.message;
        console.error(`[Trader] Buy failed for $${symbol} (attempt ${attempt}): ${err.message}`);

        // Check if tokens arrived despite the error (tx may have gone through).
        //
        // This single read is the only thing standing between "retry the buy" and
        // "buy it twice", and it is the read most likely to be refused at exactly
        // this moment — the same rate limit that broke the confirmation breaks the
        // check. One attempt, swallowed by a catch, made a double entry the default
        // outcome of a bad minute. Re-read with backoff instead.
        let tokenBal = -1;
        for (let probe = 0; probe < 4 && tokenBal < 0; probe++) {
          await new Promise(r => setTimeout(r, 1500 * (probe + 1)));
          tokenBal = await getTokenBalance(mint, this.kp()).catch(() => -1);
        }
        if (tokenBal < 0) {
          // Never got a readable answer. Spending again on a maybe is how one bad
          // minute becomes four entries, so stop here and let the reconciler adopt
          // whatever actually landed.
          lastBuyError = `${err.message} — and the balance was unreadable afterwards, ` +
            `so the buy was not retried (it may have landed)`;
          console.error(`[Trader] ⛔ ${symbol}: buy unconfirmed and balance unreadable — not retrying, to avoid a double entry`);
          break;
        }
        try {
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
      this.lastSkip = `swap failed after 3 attempts: ${lastBuyError ?? 'no error captured'}`;
      console.error(`[Trader] ❌ Buy FAILED after 3 attempts for $${symbol}`);
      return null;
    }

    // The price we were quoted is NOT the price we filled at. Between the trigger
    // and execution the market moves — a dip order can fill on the bounce. Derive
    // the true entry from the swap itself so every downstream rule (TPs, stops,
    // P&L) is measured against what we actually paid.
    let fillPrice = currentPrice;
    let fillMC = currentMC;
    let realTokens = result.outputAmount;
    try {
      // Jupiter's quote.outAmount is what it EXPECTED to deliver, not what arrived.
      // On $Layoo the quote said ~852K tokens and 614K landed — a 28% gap. Always
      // read the wallet.
      await new Promise(r => setTimeout(r, 2500));
      const onChain = await getTokenBalance(mint, this.kp());
      if (onChain > 0) {
        if (Math.abs(onChain / result.outputAmount - 1) > 0.03) {
          console.log(`[Trader:${this.taskId}] Quote said ${result.outputAmount} tokens, received ${onChain} ` +
            `(${((onChain / result.outputAmount - 1) * 100).toFixed(1)}%) — using the real amount`);
        }
        realTokens = onChain;
      }
    } catch { /* fall back to the quote */ }
    try {
      const decimals = await mintDecimals(mint);
      const tokensUi = realTokens / Math.pow(10, decimals);
      const solUsd = await getSolPrice();
      if (tokensUi > 0 && solUsd > 0) {
        const derived = (entrySol * solUsd) / tokensUi;
        // sanity: ignore absurd values (bad decimals, weird routes)
        if (derived > 0 && derived < currentPrice * 5 && derived > currentPrice / 5) {
          fillPrice = derived;
          fillMC = currentMC * (derived / currentPrice);
          const slipPct = (derived / currentPrice - 1) * 100;
          if (Math.abs(slipPct) > 3) {
            console.log(`[Trader:${this.taskId}] Fill was ${slipPct > 0 ? '+' : ''}${slipPct.toFixed(1)}% vs quote — entry recorded at the real fill (${fillMC.toFixed(0)} MC, not ${currentMC.toFixed(0)})`);
          }
        }
      }
    } catch { /* keep the quoted price */ }

    const position: RealPosition = {
      mint,
      symbol,
      name,
      entrySol,
      entryPrice: fillPrice,
      entryMC: fillMC,
      quotedPrice: currentPrice,
      quotedTokens: result.outputAmount,
      fillSlipPct: currentPrice > 0 ? +((fillPrice / currentPrice - 1) * 100).toFixed(2) : 0,
      entrySource: realTokens !== result.outputAmount ? 'chain' : 'quote',
      entryTime: Date.now(),
      entryTx: result.txSignature,
      tokensReceived: realTokens,
      // Use the TIGHTER of the trailing floor and the configured stop. Previously
      // trailing-from-entry silently replaced stopLossPct, so a strategy advertising
      // a -20% stop could actually run at -80%.
      stopLossPrice: strat.trailingFrom === 'entry'
        ? fillPrice * Math.max(1 - strat.trailingDrop, strat.stopLossPct)
        : fillPrice * strat.stopLossPct,
      beStopArmed: false,
      remainingPct: 1.0,
      tokensRemaining: realTokens,
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
      trailingHighPrice: strat.trailingFrom === 'entry' ? fillPrice : 0,
      trailingStopPrice: strat.trailingFrom === 'entry' ? fillPrice * (1 - strat.trailingDrop) : 0,
      status: 'open',
    };

    this.positions.set(mint, position);
    this.save();

    console.log(`[Trader] ✅ Bought ${realTokens} tokens of $${symbol} for ${entrySol} SOL — entry ${fillMC.toFixed(0)} MC ` +
      `(${position.entrySource}, ${position.fillSlipPct! >= 0 ? '+' : ''}${position.fillSlipPct}% vs quote) tx ${result.txSignature.slice(0, 16)}…`);
    if (Math.abs(position.fillSlipPct ?? 0) > 10) {
      sendOpsAlert(`⚠️ **$${symbol}** filled **${position.fillSlipPct}%** away from the quoted price ` +
        `(expected ${currentMC.toFixed(0)} MC, got ${fillMC.toFixed(0)} MC). All targets and the stop are keyed to the real fill.`,
        CFG.TRADES_WEBHOOK).catch(() => {});
    }
    return position;
  }

  /**
   * Check price against TP/SL levels and execute sells.
   * Returns any exits that fired.
   */
  /**
   * Positions with a check in flight. A sell takes seconds; the loop ticks in
   * milliseconds. remainingPct is not reduced until the swap returns, so every tick
   * in between sees the full position still open and is entitled to sell it again.
   *
   * At a one-second tick that was two overlapping sells. At 250ms it is eight. This
   * is the same failure that bought $SAFETOAD twice, pointing the other way, and it
   * has to be closed before the loop is allowed to run faster.
   */
  private checking = new Set<string>();

  async checkPosition(mint: string, currentPrice: number, currentMC: number, forceExitLabel?: string): Promise<RealExit[]> {
    const pos = this.positions.get(mint);
    if (!pos || pos.status !== 'open' || pos.remainingPct < 0.001) return [];
    if (this.checking.has(mint)) return [];   // a sell is already in flight for this position
    this.checking.add(mint);
    try {
      return await this.checkPositionInner(mint, currentPrice, currentMC, forceExitLabel);
    } finally {
      this.checking.delete(mint);
    }
  }

  private async checkPositionInner(mint: string, currentPrice: number, currentMC: number, forceExitLabel?: string): Promise<RealExit[]> {
    const pos = this.positions.get(mint);
    if (!pos || pos.status !== 'open' || pos.remainingPct < 0.001) return [];

    const mult = currentPrice / pos.entryPrice;
    const newExits: RealExit[] = [];
    let stateChanged = false;

    const strat = this.getStrategy();

    // Track peak multiplier
    if (mult > (pos.peakMultiplier ?? 1)) {
      pos.peakMultiplier = mult;
      stateChanged = true;
    }

    // ── Ratchet the trailing stop BEFORE any exit branch can return ──
    //
    // This lived below the take-profit ladder, which puts it after the time exit's
    // `return`. That is invisible while exits succeed. Once the clock passes,
    // checkPositionInner returns at the time exit on every tick and never reaches
    // the ratchet again — so the trailing high freezes at whatever it held the
    // moment the clock expired.
    //
    // $mRNA-4157 ran to 4.02x with its high stuck at the 1.39x it had at minute 5.
    // Its trail therefore sat at 0.766x instead of 2.21x, and when the coin gave the
    // whole move back there was no level for the auditor to fire on. Peak said 4.02x
    // and the stop said 0.77x, about the same position, at the same instant.
    //
    // State must be current before it is acted on, so it is updated first.
    if (pos.trailingActive && currentPrice > pos.trailingHighPrice) {
      pos.trailingHighPrice = currentPrice;
      stateChanged = true;
    }
    if (pos.trailingActive) {
      pos.trailingStopPrice = pos.trailingHighPrice * (1 - strat.trailingDrop);
    }

    // Helper to execute a partial sell
    /**
     * @param fillMult  For PAPER fills: the multiple the trigger actually sits at
     *   (a TP level, or the stop price). Without this, paper sells used the observed
     *   price at check time — so when the feed gapped, every strategy whose trigger
     *   had been breached filled at the SAME price and all exit levels became
     *   indistinguishable. Real fills ignore this and use the actual swap result.
     */
    const executeSell = async (
      reason: RealExit['reason'],
      label: string,
      pctOfOriginal: number,
      fillMult?: number,
    ): Promise<RealExit | null> => {
      const isFullExit = pctOfOriginal >= pos.remainingPct - 0.001;
      const actualPct = Math.min(pctOfOriginal, pos.remainingPct);

      if (this.paper) {
        // Fill at the TRIGGER level (never better than what the observed price
        // offers), minus a flat 2% haircut. Using the trigger keeps strategies
        // comparable instead of collapsing them onto whatever print the feed
        // happened to show. Gap risk beyond the trigger is deliberately not
        // modelled — real fills on a collapsing coin are worse than this.
        let effMult = mult;
        if (fillMult !== undefined) {
          effMult = fillMult;
          // Gap penalty: if the observed price is already well below the trigger, the
          // market was falling fast and a real fill lands worse than the trigger.
          // Charge slippage proportional to the gap, capped at 20%.
          if (mult < fillMult && fillMult > 0) {
            const gap = (fillMult - mult) / fillMult;
            effMult = fillMult * (1 - Math.min(0.2, gap * 0.5));
          }
        }
        const solReceived = pos.entrySol * actualPct * effMult * 0.98;
        const exit: RealExit = {
          reason, label, multiplierAtExit: effMult, pctSold: actualPct,
          tokensSold: pos.tokensReceived * actualPct, solReceived,
          txSignature: 'paper', timestamp: Date.now(),
        };
        pos.exits.push(exit);
        pos.totalSolReturned += solReceived;
        pos.remainingPct = Math.max(0, pos.remainingPct - actualPct);
        pos.tokensRemaining = Math.max(0, pos.tokensRemaining - exit.tokensSold);
        newExits.push(exit);
        console.log(`[Trader:${this.taskId}] 📄 Paper sell $${pos.symbol} ${label} at ${mult.toFixed(2)}X → ${solReceived.toFixed(3)} SOL`);
        return exit;
      }

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

      // Attempt sell with retry: if first attempt fails, wait 5s, verify balance, retry.
      // Stop-type exits escalate slippage — when a stop fires the priority is OUT,
      // not price. A 30% cap that fails during a rug is not a stop-loss.
      const isStopExit = reason === 'trailing_stop' || reason === 'stop_loss' || reason === 'be_stop' || reason === 'profit_protect';

      // Back off between failed attempts rather than hammering. Returning early
      // spends no quote at all, which is the point: it leaves the budget for the
      // attempt that is actually due.
      const notBefore = this.nextSellAttempt.get(mint) ?? 0;
      if (Date.now() < notBefore) return null;

      let rateLimited = false;
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
          const opts = this.swapOpts();
          const fails = this.sellFailCounts.get(mint) ?? 0;
          // Bid to land. A stop that misses its slot is the expensive failure, so
          // it outbids everything; each retry outbids the attempt before it.
          opts.urgency = isStopExit ? 'critical' : 'high';
          opts.attempt = attempt + fails;
          opts.maxTipLamports = Math.floor(pos.entrySol * actualPct * 1e9 * 0.01);
          if (isStopExit) {
            // failure count for this mint escalates slippage: 50% → 90%
            if (attempt > 1 || fails > 0) opts.slippageBps = Math.max(opts.slippageBps ?? 3000, fails >= 2 ? 9000 : 5000);
          }
          console.log(`[Trader] Selling ${finalSellAmount} tokens of $${pos.symbol} (${label})${attempt > 1 ? ` [RETRY #${attempt}]` : ''} slip:${(opts.slippageBps ?? 3000) / 100}%...`);
          const result = await jupiterSell(mint, finalSellAmount, opts);

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
          this.sellFailCounts.delete(mint);
          this.nextSellAttempt.delete(mint);   // a landed sell clears the backoff
        this.sellAttemptFails.delete(mint);

          // Verify on-chain that the tokens actually left. Jupiter can report success
          // on a tx that later fails; without this the book says "sold" while the
          // wallet still holds the bag and nothing manages it.
          if (CFG.VERIFY_SELLS && isFullExit) {
            try {
              await new Promise(r => setTimeout(r, 2500));
              const left = await getTokenBalance(mint, this.kp());
              if (left > finalSellAmount * 0.02) {
                console.error(`[Trader] ⚠ Sell reported success but ${left} tokens remain for $${pos.symbol} — reopening position`);
                pos.remainingPct = Math.max(pos.remainingPct, left / Math.max(1, pos.tokensReceived));
                pos.tokensRemaining = left;
                pos.stopTriggered = true;   // panic seller will keep working on it
                this.save();
              }
            } catch { /* balance check failed — panic loop still covers it */ }
          }

          console.log(`[Trader] ✅ ${label}: sold ${finalSellAmount} tokens → ${solReceived.toFixed(4)} SOL (tx: ${result.txSignature.slice(0, 16)}...)`);
          return exit;
        } catch (err: any) {
          rateLimited = /\(429\)|rate limit/i.test(err?.message ?? '');
          console.error(`[Trader] Sell failed for $${pos.symbol} (${label}) attempt ${attempt}: ${err.message}`);
          if (attempt < 2) {
            console.log(`[Trader] Retrying $${pos.symbol} sell in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }

      console.error(`[Trader] ⚠ Sell FAILED after 2 attempts for $${pos.symbol} (${label}) — will retry next check cycle`);
      // Pace every retry, whatever the cause. 5s, 10s, 20s, 40s, then once a minute.
      // Still 12 attempts a minute at the floor — plenty to catch a recovering route,
      // and little enough that a position which cannot exit stops starving the ones
      // that can.
      const paceFails = (this.sellAttemptFails.get(mint) ?? 0) + 1;
      this.sellAttemptFails.set(mint, paceFails);
      const backoffMs = Math.min(60_000, 5_000 * Math.pow(2, paceFails - 1));
      this.nextSellAttempt.set(mint, Date.now() + backoffMs);

      // Slippage escalation answers a market that will not fill us. A 429 is the API
      // declining to answer at all, which says nothing about liquidity — so it must
      // not widen the tolerance. 175 rate-limited retries had already walked
      // $mRNA-4157 to the 95% ceiling, leaving a profitable position with essentially
      // no protection the moment a quote finally landed.
      const failCount = (this.sellFailCounts.get(mint) ?? 0) + (rateLimited ? 0 : 1);
      if (!rateLimited) this.sellFailCounts.set(mint, failCount);
      console.error(`[Trader] $${pos.symbol} (${label}) next sell attempt in ${Math.round(backoffMs / 1000)}s ` +
        `(${rateLimited ? 'rate-limited — slippage held' : `fail #${failCount}`})`);
      // A stop sell that keeps failing means the position is bleeding uncontrolled —
      // yell in Discord (once per 5 min per mint) so a human can intervene.
      // A time exit that cannot fill strands the position exactly as badly as a
      // stop that cannot fill, but only stop-type exits alerted — so $mRNA-4157 sat
      // 56 minutes past a 5-minute clock in silence. Any full exit that keeps
      // failing is a stranded position and gets shouted about.
      if ((isStopExit || isFullExit) && paceFails >= 2) {
        const last = this.lastSellFailAlert.get(mint) ?? 0;
        if (Date.now() - last > 5 * 60 * 1000) {
          this.lastSellFailAlert.set(mint, Date.now());
          sendOpsAlert(
            `**${label}** sell for **$${pos.symbol}** [${this.taskId}] has FAILED ${paceFails}x` +
            `${rateLimited ? ' — every attempt RATE LIMITED, not a liquidity problem' : ' — position bleeding below its stop'}. ` +
            `Consider selling manually: https://dexscreener.com/solana/${mint}`,
            CFG.TRADES_WEBHOOK,
          ).catch(() => {});
        }
      }
      return null;
    };

    // Forced exit (e.g. the source caller posted a sell) — dump the rest at market
    if (forceExitLabel) {
      await executeSell('source_exit', forceExitLabel, pos.remainingPct);
      if (pos.remainingPct < 0.001 && pos.status === 'open') {
        pos.status = 'closed';
        pos.closedTime = Date.now();
        pos.finalPnlSol = pos.totalSolReturned - pos.entrySol;
        if (!this.paper) closeTokenAccount(mint, this.kp()).catch(() => {});
      }
      this.save();
      return newExits;
    }

    // ── Take profit levels (generalized: any number of TPs from the strategy) ──

    // ── Circuit breaker ── independent of strategy config. If a real position is
    // down more than the hard limit, get out. This is the backstop for every way a
    // configured stop can fail to fire.
    if (!this.paper && mult <= (1 - CFG.TRADE_MAX_LOSS_PCT) && pos.remainingPct >= 0.001) {
      pos.stopTriggered = true;
      this.save();
      console.error(`[Trader:${this.taskId}] 🚨 CIRCUIT BREAKER $${pos.symbol} at ${mult.toFixed(3)}X — forcing exit`);
      const cbExit = await executeSell('circuit_breaker', `Circuit breaker −${Math.round(CFG.TRADE_MAX_LOSS_PCT * 100)}% at ${mult.toFixed(2)}X`, pos.remainingPct);
      if (pos.remainingPct < 0.001 && pos.status === 'open') {
        pos.status = 'closed';
        pos.closedTime = Date.now();
        pos.finalPnlSol = pos.totalSolReturned - pos.entrySol;
        closeTokenAccount(mint, this.kp()).catch(() => {});
      }
      this.save();
      if (cbExit) return newExits;   // same rule: a failed breaker must not disarm the stop below
    }

    // Hard time exit — the most-maintained public bots exit on a clock, not a price.
    if (strat.maxHoldMin && strat.maxHoldMin > 0) {
      const heldMin = (Date.now() - pos.entryTime) / 60_000;
      if (heldMin >= strat.maxHoldMin && pos.remainingPct >= 0.001) {
        const timeExit = await executeSell('time_exit', `Time exit ${strat.maxHoldMin}m at ${mult.toFixed(2)}X`, pos.remainingPct);
        if (pos.remainingPct < 0.001 && pos.status === 'open') {
          pos.status = 'closed';
          pos.closedTime = Date.now();
          pos.finalPnlSol = pos.totalSolReturned - pos.entrySol;
          if (!this.paper) closeTokenAccount(mint, this.kp()).catch(() => {});
        }
        this.save();
        // Only stop here if the clock actually got us out.
        //
        // This returned unconditionally, which retired every other exit for the rest
        // of the position's life — the take-profit ladder, the trailing stop and the
        // stop loss all sit below this line, and once heldMin passes maxHoldMin the
        // condition above is true on every tick forever.
        //
        // $mRNA-4157 expired its 5-minute clock at 1.39x, so no TP had armed yet.
        // It then ran to 4.99x with the ladder never once evaluated, and had the
        // price kept falling it would have held all the way to the -65% circuit
        // breaker — the only exit above this line. A failed exit must never disarm
        // the exits that might still work.
        if (timeExit) return newExits;
      }
    }
    if (!pos.tpHits || pos.tpHits.length !== strat.tps.length) {
      // Position opened under a different strategy shape (or legacy file) —
      // rebuild flags, preserving legacy tp1..tp3 hits where they line up
      pos.tpHits = strat.tps.map((_, i) => [pos.tp1Hit, pos.tp2Hit, pos.tp3Hit][i] ?? false);
    }

    for (let i = 0; i < strat.tps.length; i++) {
      const tp = strat.tps[i];
      if (!pos.tpHits[i] && mult >= tp.mult) {
        // Mark the level hit only once the sell actually lands. Marking first meant
        // a failed sell retired the level permanently: the position kept 100% of
        // its size, never retried, and rode a taken profit back down to the stop.
        const exit = await executeSell(`tp${i + 1}`, `TP${i + 1} ${tp.mult}X`, tp.sellPct, tp.mult);
        if (exit) {
          pos.tpHits[i] = true;
          if (i < 3) (pos as any)[`tp${i + 1}Hit`] = true;
          if (i === 0 && strat.breakEvenAfterTp1 && !pos.beStopArmed) {
            pos.beStopArmed = true;
            pos.stopLossPrice = pos.entryPrice;
          }
        } else if (!this.paper) {
          const fails = (this.tpFailCounts.get(mint) ?? 0) + 1;
          this.tpFailCounts.set(mint, fails);
          console.error(`[Trader] ⚠ TP${i + 1} sell FAILED for $${pos.symbol} at ${mult.toFixed(2)}X ` +
            `(attempt ${fails}) — level stays armed, retrying next cycle`);
          if (fails === 2 || fails % 10 === 0) {
            sendOpsAlert(`**$${pos.symbol}** hit **TP${i + 1} (${tp.mult}X)** but the sell has failed ` +
              `${fails}x — still holding ${Math.round(pos.remainingPct * 100)}%. Sell manually if it persists: ` +
              `https://pump.fun/${mint}`, CFG.TRADES_WEBHOOK).catch(() => {});
          }
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

    // The ratchet itself now runs at the top of this function, before any exit can
    // return. Only the afterLastTp arming above can newly activate trailing at this
    // point, so all that is left is to price the stop it just armed.
    if (pos.trailingActive) {
      pos.trailingStopPrice = pos.trailingHighPrice * (1 - strat.trailingDrop);
    }

    const ladderMode = strat.trailingFrom === 'afterLastTp';

    // ── Executable price near the stop ──
    //
    // DexScreener publishes a smoothed aggregate. A dip that happens and recovers
    // inside its update window never appears, so the bot can poll every second and
    // still miss a stop that genuinely traded — which is exactly what happened to
    // $Doodle: the market printed 0.567x and the feed never showed below 0.855x.
    //
    // Jupiter quotes the price the position would actually SELL into. It is the
    // truth for an exit, but too slow to poll constantly — so it is consulted only
    // when the position is near its stop, which is the only time accuracy matters.
    //
    // The direction here is deliberate and was got wrong before: this takes the
    // LOWER of the two prices, so a second opinion can only ever make the stop fire
    // sooner. An earlier version let a higher quote veto the stop entirely, and that
    // blocked a real exit while the coin bled. A second opinion may add a reason to
    // sell; it must never remove one.
    if (!this.paper && pos.remainingPct >= 0.001) {
      const stopLevel = Math.max(pos.stopLossPrice, pos.trailingActive ? pos.trailingStopPrice : 0);
      if (stopLevel > 0 && currentPrice <= stopLevel * 1.4) {
        try {
          const solUsd = await getSolPrice();
          const jup = await jupiterGetPrice(mint, solUsd, true);   // urgent: this decides a sell
          // Ignore an absurd quote; a broken reading must not trigger a sale either.
          if (jup && jup.priceUsd > 0 && jup.priceUsd > currentPrice / 5 && jup.priceUsd < currentPrice * 5) {
            if (jup.priceUsd < currentPrice) {
              console.log(`[Trader] $${pos.symbol} near stop — feed ${currentPrice.toExponential(3)}, ` +
                `executable ${jup.priceUsd.toExponential(3)}; acting on the executable price`);
              currentPrice = jup.priceUsd;
            }
          }
        } catch { /* feed price stands — never block the stop on a failed lookup */ }
      }
    }

    // ── Stop checks ──
    if (pos.remainingPct >= 0.001) {
      if (pos.trailingActive && currentPrice <= pos.trailingStopPrice) {
        pos.stopTriggered = true; this.save();
        await executeSell('trailing_stop', `Trailing Stop −${(strat.trailingDrop * 100).toFixed(0)}% (ATH ${(pos.trailingHighPrice / pos.entryPrice).toFixed(1)}X)`, pos.remainingPct,
          pos.entryPrice > 0 ? pos.trailingStopPrice / pos.entryPrice : undefined);
      } else if (ladderMode && (pos.peakMultiplier ?? 1) >= 1.5 && mult <= 1.0) {
        // Profit protection (ladder only): was up 50%+ but dumped back to break-even.
        // In trailing mode this would be a hidden TP that contradicts letting winners breathe.
        await executeSell('profit_protect', `Profit Protect (peaked ${pos.peakMultiplier.toFixed(1)}X)`, pos.remainingPct);
      } else if (currentPrice <= pos.stopLossPrice) {
        pos.stopTriggered = true; this.save();
        const reason = pos.beStopArmed ? 'be_stop' : 'stop_loss';
        const label = pos.beStopArmed ? 'Break-Even Stop' : `Stop Loss −${((1 - strat.stopLossPct) * 100).toFixed(0)}%`;
        await executeSell(reason, label, pos.remainingPct,
          pos.entryPrice > 0 ? pos.stopLossPrice / pos.entryPrice : undefined);
      }
    }

    // Close if fully exited
    if (pos.remainingPct < 0.001 && pos.status === 'open') {
      pos.status = 'closed';
      pos.closedTime = Date.now();
      pos.finalPnlSol = pos.totalSolReturned - pos.entrySol;

      // Close token account to reclaim rent SOL (fire and forget)
      if (!this.paper) closeTokenAccount(mint, this.kp()).catch(err =>
        console.log(`[Trader] Token account close skipped for $${pos.symbol}: ${err.message}`),
      );
    }

    // Persist ratchets too — before this, trailing state only saved on exits, so a
    // restart mid-pump silently reset the stop back to entry level.
    if (newExits.length > 0 || stateChanged) this.save();
    return newExits;
  }

  /**
   * Liquidate a position whose stop already fired, independent of price feeds.
   * Escalates slippage AND priority fee with each failure, and falls back to
   * progressively smaller chunks — thin liquidity often rejects the full size
   * but accepts a quarter of it. Returns any exits that cleared.
   */
  async panicSell(mint: string): Promise<RealExit[]> {
    const pos = this.positions.get(mint);
    if (!pos || pos.status !== 'open' || pos.remainingPct < 0.001) return [];
    if (this.paper) return [];

    const strat = this.getStrategy();
    const fails = this.sellFailCounts.get(mint) ?? 0;
    const slippageBps = Math.min(9500, 5000 + fails * 1000);
    // Escalate the fee, but never spend more than 2% of the position on landing one tx.
    // Measured median landed priority fee is ~2k lamports; 5M on a 0.03 SOL clip is 16%.
    const feeCeiling = Math.max(50_000, Math.floor(pos.entrySol * 1e9 * 0.02));
    const priorityFeeLamports = Math.min(feeCeiling, Math.max(strat.priorityFeeLamports, 100_000) * (1 + fails * 2));

    let lastPanicErr = '';
    let onChain = pos.tokensRemaining;
    try { onChain = await getTokenBalance(mint, this.kp()); } catch { /* use tracked */ }

    if (onChain <= 0) {
      console.log(`[Panic:${this.taskId}] $${pos.symbol} has no tokens on-chain — closing record`);
      pos.remainingPct = 0;
      pos.tokensRemaining = 0;
      pos.status = 'closed';
      pos.closedTime = Date.now();
      pos.finalPnlSol = pos.totalSolReturned - pos.entrySol;
      this.save();
      return [];
    }

    // Try full size first, then halves — a smaller clip often routes when the full one won't
    const attempts = fails >= 2 ? [1, 0.5, 0.25] : fails >= 1 ? [1, 0.5] : [1];
    for (const frac of attempts) {
      const amount = Math.floor(onChain * frac);
      if (amount <= 0) continue;
      try {
        // No explicit priority fee here: passing one opts out of Jito, and the
        // panic seller is precisely the transaction that most needs to land.
        console.log(`[Panic:${this.taskId}] Selling ${(frac * 100).toFixed(0)}% of $${pos.symbol} — slip ${slippageBps / 100}%, critical bid (retry ${fails + 1})`);
        const result = await jupiterSell(mint, amount, {
          keypair: this.kp(), slippageBps, urgency: 'critical', attempt: fails + 1,
          maxTipLamports: Math.floor(pos.entrySol * pos.remainingPct * frac * 1e9 * 0.01),
        });
        const solReceived = result.outputAmount / 1e9;
        const soldPct = pos.remainingPct * frac;
        const exitMult = pos.entrySol > 0 && soldPct > 0 ? solReceived / (pos.entrySol * soldPct) : 0;
        const exit: RealExit = {
          reason: 'panic_exit',
          // Above entry this is just a stop that fired late — calling it a "panic"
          // made a profitable 2.4x exit read like an emergency.
          label: exitMult >= 1
            ? `Stop exit at ${exitMult.toFixed(2)}X${frac < 1 ? ` (${(frac * 100).toFixed(0)}%)` : ''}`
            : `Emergency exit at ${exitMult.toFixed(2)}X${frac < 1 ? ` (${(frac * 100).toFixed(0)}%)` : ''}`,
          multiplierAtExit: pos.entrySol > 0 ? (solReceived / (pos.entrySol * soldPct)) : 0,
          pctSold: soldPct,
          tokensSold: amount,
          solReceived,
          txSignature: result.txSignature,
          timestamp: Date.now(),
        };
        pos.exits.push(exit);
        pos.totalSolReturned += solReceived;
        pos.remainingPct = Math.max(0, pos.remainingPct - soldPct);
        pos.tokensRemaining = Math.max(0, onChain - amount);
        this.sellFailCounts.delete(mint);
        this.nextSellAttempt.delete(mint);   // a landed sell clears the backoff
        this.sellAttemptFails.delete(mint);
        if (pos.remainingPct < 0.001) {
          pos.status = 'closed';
          pos.closedTime = Date.now();
          pos.finalPnlSol = pos.totalSolReturned - pos.entrySol;
          pos.stopTriggered = false;
          closeTokenAccount(mint, this.kp()).catch(() => {});
        }
        this.save();
        console.log(`[Panic:${this.taskId}] ✅ Cleared ${(frac * 100).toFixed(0)}% of $${pos.symbol} → ${solReceived.toFixed(4)} SOL`);
        return [exit];
      } catch (err: any) {
        lastPanicErr = err?.message ?? '';
        console.error(`[Panic:${this.taskId}] ${(frac * 100).toFixed(0)}% sell failed for $${pos.symbol}: ${err.message}`);
      }
    }

    // Same rule as executeSell: only a genuine fill failure may widen slippage.
    const panicRateLimited = /\(429\)|rate limit/i.test(lastPanicErr);
    const n = fails + (panicRateLimited ? 0 : 1);
    if (!panicRateLimited) this.sellFailCounts.set(mint, n);
    const panicPace = (this.sellAttemptFails.get(mint) ?? 0) + 1;
    this.sellAttemptFails.set(mint, panicPace);
    if (panicPace === 3 || panicPace % 10 === 0) {
      const last = this.lastSellFailAlert.get(mint) ?? 0;
      if (Date.now() - last > 5 * 60 * 1000) {
        this.lastSellFailAlert.set(mint, Date.now());
        sendOpsAlert(
          `🆘 **$${pos.symbol}** [${this.taskId}] — stop fired but the sell has failed **${panicPace}x**` +
          `${panicRateLimited ? ' (RATE LIMITED — the quote API is refusing us, the market is fine)' : ''}. Still holding ${(pos.remainingPct * 100).toFixed(0)}%. ` +
          `Retrying with higher slippage/fees; sell manually if you can: https://pump.fun/${mint}`,
          CFG.TRADES_WEBHOOK,
        ).catch(() => {});
      }
    }
    return [];
  }

  /**
   * Reconcile every open position against the chain. The book is a claim; the
   * wallet is the truth. Corrects token counts, detects positions the wallet no
   * longer holds, and finds orphaned bags the book never recorded.
   */
  async reconcile(): Promise<{ fixed: string[]; orphans: string[]; ghosts: string[] }> {
    const fixed: string[] = [], orphans: string[] = [], ghosts: string[] = [];
    if (this.paper) return { fixed, orphans, ghosts };
    const tracked = new Set<string>();

    for (const pos of this.positions.values()) {
      if (pos.status !== 'open') continue;
      tracked.add(pos.mint);
      try {
        const onChain = await getTokenBalance(pos.mint, this.kp());
        // (a) book says we hold it, wallet says we don't → it was sold elsewhere
        if (onChain <= 0 && pos.remainingPct >= 0.001) {
          pos.remainingPct = 0;
          pos.tokensRemaining = 0;
          pos.status = 'closed';
          pos.closedTime = Date.now();
          pos.finalPnlSol = pos.totalSolReturned - pos.entrySol;
          ghosts.push(pos.symbol);
          this.flush();
          continue;
        }
        // (b) counts drifted → trust the wallet
        if (onChain > 0 && Math.abs(onChain / Math.max(1, pos.tokensRemaining) - 1) > 0.03) {
          pos.tokensRemaining = onChain;
          if (pos.tokensReceived > 0) pos.remainingPct = Math.min(1, onChain / pos.tokensReceived);
          fixed.push(`${pos.symbol} tokens→${onChain}`);
          this.flush();
        }
      } catch { /* transient RPC — try next pass */ }
    }

    // (c) tokens in the wallet that no open position claims — unmanaged bags
    try {
      const { getTokenHoldings } = await import('./wallet.js');
      for (const h of await getTokenHoldings(this.kp())) {
        if (!tracked.has(h.mint) && h.uiAmount > 0) orphans.push(`${h.mint.slice(0, 8)}…`);
      }
    } catch { /* skip */ }

    return { fixed, orphans, ghosts };
  }

  /** Positions whose stop fired but that still hold tokens. */
  getStuckPositions(): RealPosition[] {
    return [...this.positions.values()].filter(p => p.status === 'open' && p.stopTriggered && p.remainingPct >= 0.001);
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

  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  /** Debounced write. Paper tasks tolerate a short delay; real tasks flush at once
   *  so a crash can never lose a live position record. */
  /** Drop a position from this task's history and persist immediately. */
  forget(mint: string): boolean {
    const had = this.positions.delete(mint);
    if (had) { this.dirty = true; this.flushNow(); }
    return had;
  }

  /** Force an immediate write, bypassing the debounce. */
  private flushNow(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.flush();
  }

  /** Persist after a caller mutated positions directly — the bulk paper close
   *  writes to many traders and each needs flushing once, not per position. */
  persist(): void { this.save(); }

  private save(): void {
    if (!this.paper) { this.flush(); return; }
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; if (this.dirty) this.flush(); }, 4000);
  }

  private flush(): void {
    this.dirty = false;
    try {
      mkdirSync(dirname(this.positionsFile), { recursive: true });
      const data = [...this.positions.values()];
      writeFileSync(this.positionsFile, JSON.stringify(data));
    } catch (err: any) {
      console.error(`[Trader] Save error: ${err.message}`);
    }
  }

  /** Recompute a position's entry from what we actually received on-chain.
   *  Positions opened before the fill-price fix recorded the TRIGGER price, so
   *  their stops and targets were keyed to a basis they never paid. */
  async repairEntryBasis(): Promise<void> {
    if (this.paper) return;
    const strat = this.getStrategy();
    for (const pos of this.positions.values()) {
      if (pos.status !== 'open' || pos.entryTx === 'paper' || pos.tokensReceived <= 0) continue;
      try {
        const decimals = await mintDecimals(pos.mint);
        // Prefer the wallet's actual balance — the stored figure came from a quote.
        // Only valid while the position is untouched; after partial sells it's stale.
        let rawTokens = pos.tokensReceived;
        if (pos.remainingPct > 0.999) {
          const onChain = await getTokenBalance(pos.mint, this.kp()).catch(() => 0);
          if (onChain > 0) {
            if (Math.abs(onChain / pos.tokensReceived - 1) > 0.03) {
              console.log(`[Trader:${this.taskId}] $${pos.symbol}: stored ${pos.tokensReceived} tokens, wallet holds ${onChain}`);
            }
            rawTokens = onChain;
            pos.tokensReceived = onChain;
            pos.tokensRemaining = onChain;
          }
        }
        const tokensUi = rawTokens / Math.pow(10, decimals);
        const solUsd = await getSolPrice();
        if (tokensUi <= 0 || solUsd <= 0) continue;
        const real = (pos.entrySol * solUsd) / tokensUi;
        if (!(real > 0) || Math.abs(real / pos.entryPrice - 1) < 0.05) continue;   // already right

        const oldEntry = pos.entryPrice;
        pos.entryPrice = real;
        pos.entryMC = pos.entryMC * (real / oldEntry);
        // Prices observed in the market stay as they are; levels defined relative to
        // ENTRY get recomputed against the true basis.
        pos.stopLossPrice = real * (strat.trailingFrom === 'entry'
          ? Math.max(1 - strat.trailingDrop, strat.stopLossPct)
          : strat.stopLossPct);
        if (pos.trailingHighPrice > 0) {
          pos.peakMultiplier = pos.trailingHighPrice / real;
          if (pos.trailingActive) {
            pos.trailingStopPrice = Math.max(pos.trailingHighPrice * (1 - strat.trailingDrop), pos.stopLossPrice);
          }
        } else {
          pos.peakMultiplier = Math.max(1, pos.peakMultiplier * (oldEntry / real));
        }
        console.log(`[Trader:${this.taskId}] Repaired $${pos.symbol} entry: ${oldEntry.toExponential(3)} → ${real.toExponential(3)} ` +
          `(MC ${pos.entryMC.toFixed(0)}), stop now ${(pos.stopLossPrice / real).toFixed(3)}x`);
        this.flush();
      } catch { /* leave as-is */ }
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
