/**
 * Task manager — sneaker-bot-style trading tasks.
 * Each task = one wallet + one strategy + its own position book, all buying the
 * same PumpClaw call feed independently. Tasks are created/edited live from the
 * dashboard; strategy edits apply to open positions on the next price check.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG } from './config.js';
import { Trader, type RealExit, type RealPosition } from './trader.js';
import { STRATEGY_PRESETS, sanitizeStrategy, type Strategy } from './strategy.js';
import { walletSource, getWallet } from './wallet.js';
import { PUMPCLAW_SOURCE_ID } from './call-sources.js';
import { sendTradeActivity, sendOpsAlert } from './discord.js';

const TASKS_FILE = `${CONFIG.DATA_DIR}/tasks.json`;

export interface TradeTask {
  id: string;
  name: string;          // display label, e.g. "Main", "Alex aggressive", "Jake safe"
  walletKey: string;     // bs58 secret key — stored on the volume, never sent to the browser
  enabled: boolean;
  strategy: Strategy;
  createdAt: number;
  paper?: boolean;       // shadow task: simulated fills on live prices, no wallet needed
  source?: string;       // legacy single-source field (migrated into `sources`)
  sources?: string[];    // EXTRA call sources followed on top of PumpClaw's own calls
  webhook?: string;      // per-task Discord webhook — this task's fills post here
  noPumpclaw?: boolean;  // explicit opt-out of PumpClaw's own scanner (default: follow it)
}

export interface TaskExitEvent { task: TradeTask; exit: RealExit }

/** Appended to a sell notification: the POSITION's result, not just this slice.
 *  A partial exit returning 0.05 SOL looked like a loss when the trade was +0.37. */
function positionSummary(pos: RealPosition | undefined): string {
  if (!pos || pos.entrySol <= 0) return '';
  const net = pos.totalSolReturned - pos.entrySol;
  const mult = pos.totalSolReturned / pos.entrySol;
  if (pos.status === 'closed' || pos.remainingPct < 0.001) {
    return `\n**Position closed: ${net >= 0 ? '+' : ''}${net.toFixed(4)} SOL** (${mult.toFixed(2)}× on ${pos.entrySol} SOL in)`;
  }
  return `\n*so far ${pos.totalSolReturned.toFixed(4)} of ${pos.entrySol} SOL back · ${Math.round(pos.remainingPct * 100)}% still open*`;
}

/** A call a dip-entry task is waiting on: buy only if price falls to `target`. */
export interface PendingEntry {
  taskId: string;
  mint: string;
  symbol: string;
  name: string;
  callPrice: number;
  target: number;
  expiresAt: number;
  callMC?: number;      // market cap when the call landed
  targetMC?: number;    // the market cap the buy actually triggers at
}

const PENDING_FILE = `${CONFIG.DATA_DIR}/pending-entries.json`;

/** A check may hold a mint's lock this long before another is allowed through. */
const CHECK_LOCK_MS = 45_000;

class TaskManager {
  private tasks = new Map<string, TradeTask>();
  private traders = new Map<string, Trader>();
  private pending: PendingEntry[] = [];

  constructor() {
    this.load();
    this.loadPending();
    this.migrateLegacy();
    this.clearHoldClock();
    this.repairOrphanedTasks();
    this.seedShadowFleet();
    this.loadBuyLog();
  }

  // ── Pending dip entries ──
  private loadPending(): void {
    try { this.pending = JSON.parse(readFileSync(PENDING_FILE, 'utf-8')); } catch { this.pending = []; }
  }
  private savePending(): void {
    try { writeFileSync(PENDING_FILE, JSON.stringify(this.pending, null, 2)); } catch {}
  }
  pendingEntries(): PendingEntry[] {
    const now = Date.now();
    return this.pending.filter(p => p.expiresAt > now);
  }

  /**
   * Drop dip orders that have expired.
   *
   * They were only ever removed inside checkPendingEntries, which runs per-mint and
   * only while that coin is still being swept. A coin that fell out of tracking left
   * its dead orders in the array permanently — the file had grown to 220KB, and every
   * new call rewrote the whole thing. Filtering on read hid the growth rather than
   * stopping it.
   */
  prunePending(): number {
    const now = Date.now();
    const before = this.pending.length;
    this.pending = this.pending.filter(p => p.expiresAt > now);
    const dropped = before - this.pending.length;
    if (dropped > 0) {
      this.savePending();
      console.log(`[Tasks] Pruned ${dropped} expired dip order(s), ${this.pending.length} live`);
    }
    return dropped;
  }

  /** Fill or expire dip orders against a fresh price. Returns tasks that filled. */
  async checkPendingEntries(mint: string, price: number, mc: number): Promise<number> {
    const now = Date.now();
    const relevant = this.pending.filter(p => p.mint === mint);
    if (relevant.length === 0) return 0;

    let filled = 0;
    const keep: PendingEntry[] = [];
    for (const p of this.pending) {
      if (p.mint !== mint) { keep.push(p); continue; }
      if (p.expiresAt <= now) {
        console.log(`[Tasks] Dip order expired: $${p.symbol} never fell to ${p.target.toPrecision(4)}`);
        continue;
      }
      if (price > p.target) { keep.push(p); continue; }

      // A dip order had an upper bound and no lower one, so it filled at whatever
      // the price happened to be the moment it dropped through the target. On a coin
      // that gapped, that is the bottom of a rug rather than a pullback.
      //
      // $QUASI was called at $31,389 MC, fell 94% inside fifteen minutes, and every
      // dip task in the fleet filled at $1,844 MC. From that basis the dead-cat
      // bounce back toward the call price reads as a 16.4x, and the same single coin
      // then appears as a 40.94x "best trade" in twelve different dip strategies —
      // carrying 55% to 98% of each one's entire reported profit.
      //
      // The thesis behind a dip entry is "a healthy coin pulled back". Past a point
      // that thesis is simply false and the order should die with it, so a fill more
      // than DIP_MAX_OVERSHOOT below its own target is treated as a rug in progress
      // and the order is cancelled rather than filled.
      if (price < p.target * (1 - CONFIG.DIP_MAX_OVERSHOOT)) {
        console.log(`[Tasks] Dip order CANCELLED: $${p.symbol} gapped to ` +
          `${(price / p.callPrice).toFixed(3)}x of the call, far below its ${(p.target / p.callPrice).toFixed(2)}x target — ` +
          `that is a rug, not a dip`);
        continue;
      }

      const task = this.tasks.get(p.taskId);
      if (!task || !task.enabled) continue;
      try {
        const pos = await this.traderFor(task).buy(p.mint, p.symbol, p.name, price, mc);
        if (pos) {
          filled++;
          console.log(`[Tasks] ✅ Dip filled for "${task.name}": $${p.symbol} at ${((price / p.callPrice - 1) * 100).toFixed(0)}% from call`);
          if (!task.paper) {
            sendTradeActivity(task.name, 'buy', p.symbol, p.mint,
              `**${pos.entrySol} SOL** on a **${((1 - price / p.callPrice) * 100).toFixed(0)}% dip** from the call`,
              pos.entryTx).catch(() => {});
          }
        }
      } catch (err: any) {
        console.error(`[Tasks] Dip fill failed (${task.name}/${p.symbol}): ${err.message}`);
      }
    }
    this.pending = keep;
    this.savePending();
    return filled;
  }

  /** One shadow (paper) task per strategy preset — path-aware ground truth for the
   *  Strategy Lab's peak-model estimates. Runs every call on live prices, no funds. */
  /**
   * A task subscribed to nothing can never trade. That state was reachable by
   * editing a task without re-ticking the PumpClaw checkbox, and it is silent —
   * the task stays enabled and funded and simply never receives a call.
   */
  private repairOrphanedTasks(): void {
    let fixed = 0;
    for (const t of this.tasks.values()) {
      if (this.sourcesFor(t).length === 0) {
        t.noPumpclaw = false;
        fixed++;
        console.log(`[Tasks] "${t.name}" was subscribed to no sources — restored to PumpClaw`);
      }
    }
    if (fixed) this.save();
  }

  private seedShadowFleet(): void {
    const existing = new Set(this.all().filter(t => t.paper).map(t => t.strategy.preset));
    const missing = Object.keys(STRATEGY_PRESETS).filter(k => !existing.has(k));
    if (missing.length === 0) return;
    for (const key of missing) {
      const preset = STRATEGY_PRESETS[key];
      const id = `shadow-${key}`;
      const task: TradeTask = {
        id,
        name: `📄 ${preset.name}`,
        walletKey: bs58.encode(Keypair.generate().secretKey), // throwaway, never funded
        enabled: true,
        strategy: preset.make(),
        createdAt: Date.now(),
        paper: true,
      };
      this.tasks.set(id, task);
    }
    this.save();
    console.log(`[Tasks] Seeded ${missing.length} shadow task(s): ${missing.join(', ')}`);
  }

  // ── Persistence ──
  private load(): void {
    try {
      const data: TradeTask[] = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
      for (const t of data) {
        t.strategy = sanitizeStrategy(t.strategy);
        this.tasks.set(t.id, t);
      }
      if (data.length > 0) console.log(`[Tasks] Loaded ${data.length} task(s): ${data.map(t => t.name).join(', ')}`);
    } catch { /* no tasks yet */ }
  }

  private save(): void {
    mkdirSync(CONFIG.DATA_DIR, { recursive: true });
    writeFileSync(TASKS_FILE, JSON.stringify([...this.tasks.values()], null, 2));
  }

  /**
   * One-time: drop the hold clock from live tasks.
   *
   * MANIFEST carried maxHoldMin=5, which the code never defaults to — every
   * fallback is 0 — so it came from whatever preset the custom builder was seeded
   * with rather than from a decision. It was also the single most expensive setting
   * in the book: the time exit sits above the take-profit ladder, the trailing stop
   * and the stop loss, so once the clock expired it fired on every tick and, until
   * this was fixed, returned before any of them could be evaluated. $mRNA-4157
   * expired at 1.39x, ran to 4.99x with the 1.95x rung never once consulted, and
   * held 100% the whole way back down.
   *
   * A 5-minute clock also contradicts take-profits at 5.05x and 10.05x, which
   * essentially nothing reaches inside five minutes.
   *
   * Guarded by a marker file, so this runs exactly once. A clock set deliberately
   * after this deploy is never touched.
   */
  private clearHoldClock(): void {
    const marker = `${CONFIG.DATA_DIR}/.hold-clock-cleared`;
    if (existsSync(marker)) return;
    let changed = 0;
    for (const t of this.tasks.values()) {
      if (t.paper) continue;                       // the shadow fleet is a measurement tool, leave it
      const had = t.strategy.maxHoldMin ?? 0;
      if (had > 0) {
        t.strategy.maxHoldMin = 0;
        changed++;
        console.log(`[Tasks] Removed the ${had}m hold clock from "${t.name}" — the trail runs the trade now (one-time)`);
      }
    }
    try {
      mkdirSync(CONFIG.DATA_DIR, { recursive: true });
      writeFileSync(marker, new Date().toISOString());
    } catch { /* if the marker cannot be written, the guard below still stops a re-run this boot */ }
    if (changed) this.save();
  }

  /** One-time migration: fold the legacy single-wallet setup into a 'main' task
   *  so existing deployments keep trading without any manual step. */
  private migrateLegacy(): void {
    if (this.tasks.size > 0) return;
    if (walletSource() === 'none') return;
    try {
      const kp = getWallet();
      const key = bs58.encode(kp.secretKey);
      const strategy = STRATEGY_PRESETS.trailing45.make();
      strategy.entryPct = CONFIG.TRADE_ENTRY_PCT;
      strategy.minEntrySol = CONFIG.TRADE_MIN_ENTRY_SOL;
      strategy.slippageBps = CONFIG.TRADE_SLIPPAGE_BPS;
      strategy.trailingDrop = CONFIG.TRADE_TRAILING_DROP;
      const task: TradeTask = {
        id: 'main',
        name: 'Main',
        walletKey: key,
        enabled: CONFIG.TRADE_ENABLED,
        strategy,
        createdAt: Date.now(),
      };
      this.tasks.set(task.id, task);
      this.save();
      console.log(`[Tasks] Migrated legacy wallet into task "Main" (${kp.publicKey.toBase58().slice(0, 8)}…)`);
    } catch (err: any) {
      console.error(`[Tasks] Legacy migration skipped: ${err.message}`);
    }
  }

  // ── Accessors ──
  all(): TradeTask[] { return [...this.tasks.values()]; }

  /**
   * Drop a coin from every task's position history.
   * Paper tasks only by default: a real position moved actual money, and deleting
   * it makes the dashboard's P&L disagree with the wallet.
   */
  forgetMint(mint: string, includeReal = false): { tasks: number; paper: number; real: number } {
    let tasks = 0, paper = 0, real = 0;
    for (const t of this.tasks.values()) {
      if (!t.paper && !includeReal) continue;
      if (this.traderFor(t).forget(mint)) {
        tasks++;
        if (t.paper) paper++; else real++;
      }
    }
    return { tasks, paper, real };
  }
  get(id: string): TradeTask | undefined { return this.tasks.get(id); }

  keypairFor(task: TradeTask): Keypair {
    return Keypair.fromSecretKey(bs58.decode(task.walletKey));
  }

  traderFor(task: TradeTask): Trader {
    let tr = this.traders.get(task.id);
    if (!tr) {
      tr = new Trader(task.id, this.keypairFor(task), () => this.tasks.get(task.id)?.strategy ?? task.strategy, !!task.paper);
      this.traders.set(task.id, tr);
    }
    return tr;
  }

  // ── CRUD (dashboard) ──
  create(name: string, bs58Key: string, strategy: Partial<Strategy>, sources?: string[]): TradeTask {
    const kp = Keypair.fromSecretKey(bs58.decode(bs58Key.trim())); // validates the key
    const id = randomBytes(4).toString('hex');
    const task: TradeTask = {
      id,
      name: (name || `Task ${id}`).slice(0, 40),
      walletKey: bs58.encode(kp.secretKey),
      enabled: true,
      strategy: sanitizeStrategy(strategy),
      createdAt: Date.now(),
      sources: (sources ?? []).filter(s => s !== PUMPCLAW_SOURCE_ID),
      noPumpclaw: sources && sources.length > 0 ? !sources.includes(PUMPCLAW_SOURCE_ID) : false,
    };
    this.tasks.set(id, task);
    this.save();
    console.log(`[Tasks] Created "${task.name}" (${kp.publicKey.toBase58().slice(0, 8)}…) — ${task.strategy.preset} — sources:${(task.sources ?? []).join('+')}`);
    return task;
  }

  /** Add a user-built strategy to the paper fleet (no wallet, no money at risk). */
  createPaper(name: string, strategy: Partial<Strategy>): TradeTask {
    const id = `custom-${randomBytes(3).toString('hex')}`;
    const task: TradeTask = {
      id,
      name: `📄 ${name}`.slice(0, 42),
      walletKey: bs58.encode(Keypair.generate().secretKey),
      enabled: true,
      strategy: sanitizeStrategy(strategy),
      createdAt: Date.now(),
      paper: true,
      sources: [],
    };
    this.tasks.set(id, task);
    this.save();
    console.log(`[Tasks] Custom paper strategy added: ${task.name}`);
    return task;
  }

  /** Clone a task's full strategy onto a new wallet. */
  duplicate(id: string, name: string, bs58Key: string): TradeTask {
    const src = this.tasks.get(id);
    if (!src) throw new Error(`No task ${id}`);
    const copy = this.create(name || `${src.name} copy`, bs58Key, { ...src.strategy }, this.sourcesFor(src));
    console.log(`[Tasks] Duplicated "${src.name}" → "${copy.name}"`);
    return copy;
  }

  update(id: string, patch: { name?: string; enabled?: boolean; strategy?: Partial<Strategy>; source?: string; sources?: string[]; walletKey?: string; webhook?: string }): TradeTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`No task ${id}`);
    if (patch.webhook !== undefined) {
      const w = patch.webhook.trim();
      if (w && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(w)) {
        throw new Error('That does not look like a Discord webhook URL (expected https://discord.com/api/webhooks/...)');
      }
      task.webhook = w || undefined;
      console.log(`[Tasks] "${task.name}" webhook ${w ? 'set' : 'cleared'}`);
    }
    if (patch.walletKey) {
      const kp = Keypair.fromSecretKey(bs58.decode(patch.walletKey.trim())); // validates
      if (this.traderFor(task).getOpenPositions().length > 0) {
        throw new Error('Task has open positions — swapping wallets now would orphan them. Wait for exits (or pause + sell manually) first.');
      }
      task.walletKey = bs58.encode(kp.secretKey);
      this.traders.delete(task.id); // rebuild trader with the new keypair
      console.log(`[Tasks] "${task.name}" wallet replaced → ${kp.publicKey.toBase58()}`);
    }
    if (patch.name !== undefined) task.name = patch.name.slice(0, 40) || task.name;
    if (patch.enabled !== undefined) task.enabled = patch.enabled;
    if (patch.sources !== undefined) {
      // An empty list means the form submitted no source checkboxes — and unchecked
      // checkboxes are simply absent from an HTML form, so this happens on any edit
      // where the box was not re-ticked. Treating that as "unsubscribe from
      // everything" left a task enabled, funded, and permanently ineligible for any
      // call: it silently stopped trading after a rename. A task with no sources can
      // never do anything, so it is never what was meant. Default to PumpClaw.
      if (patch.sources.length === 0) {
        task.sources = [];
        task.noPumpclaw = false;
        console.log(`[Tasks] "${task.name}" edit submitted no sources — keeping it on PumpClaw`);
      } else {
        task.sources = patch.sources.filter(s => s !== PUMPCLAW_SOURCE_ID);
        task.noPumpclaw = !patch.sources.includes(PUMPCLAW_SOURCE_ID);
      }
      task.source = undefined; // superseded by the list + opt-out flag
    } else if (patch.source !== undefined) {
      task.sources = patch.source === PUMPCLAW_SOURCE_ID ? [] : [patch.source];
      task.source = undefined;
    }
    if (patch.strategy !== undefined) task.strategy = sanitizeStrategy({ ...task.strategy, ...patch.strategy });
    this.save();
    return task;
  }

  remove(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    const open = this.traderFor(task).getOpenPositions().length;
    if (open > 0) throw new Error(`Task "${task.name}" has ${open} open position(s) — disable it and wait for exits (or sell manually) before deleting.`);
    this.tasks.delete(id);
    this.traders.delete(id);
    this.save();
    // Keep the positions file as history (positions-<id>.json) — never delete trade records
  }

  /** Reconcile every real task's book against the chain. */
  /**
   * Mark every open PAPER position closed at the current market price.
   *
   * An open position is excluded from every statistic the fleet reports, so a
   * strategy that never closes its losers shows only its winners. Measured: with a
   * stop, 99% of trades close and 33% of those won; without one, 54% close and 48%
   * "won". That fifteen-point gap is the absent losers, not skill — and it is why
   * the leaderboard ranked no-stop strategies at the top for weeks.
   *
   * Closing them at market realises what is already true and makes every downstream
   * number honest. Paper only: real positions hold actual tokens and must be sold on
   * chain, never marked closed in a book.
   */
  private buyLogFile(): string { return `${CONFIG.DATA_DIR}/buy-log.json`; }

  private saveBuyLog(): void {
    try {
      mkdirSync(CONFIG.DATA_DIR, { recursive: true });
      writeFileSync(this.buyLogFile(), JSON.stringify(this.buyLog));
    } catch { /* diagnostic only — never break a trade over it */ }
  }

  loadBuyLog(): void {
    try {
      const rows = JSON.parse(readFileSync(this.buyLogFile(), 'utf-8'));
      if (Array.isArray(rows)) this.buyLog.push(...rows.slice(0, 200));
    } catch { /* none yet */ }
  }

  async closeAllPaper(priceOf: (mint: string) => number | undefined): Promise<{ closed: number; tasks: number; realisedSol: number; unpriced: number }> {
    let closed = 0, tasks = 0, realised = 0, unpriced = 0;
    for (const t of this.all()) {
      if (!t.paper) continue;   // guard: never touch a position backed by real tokens
      const trader = this.traderFor(t);
      let touched = 0;
      for (const pos of trader.getOpenPositions()) {
        const px = priceOf(pos.mint);
        if (!px || px <= 0) { unpriced++; continue; }
        const mult = pos.entryPrice > 0 ? px / pos.entryPrice : 0;
        const proceeds = pos.entrySol * pos.remainingPct * mult;
        pos.totalSolReturned = (pos.totalSolReturned ?? 0) + proceeds;
        pos.exits = [...(pos.exits ?? []), {
          reason: 'forced_close', label: 'Closed at market (bulk)',
          multiplierAtExit: +mult.toFixed(4), pctSold: pos.remainingPct,
          tokensSold: pos.tokensRemaining ?? 0, solReceived: +proceeds.toFixed(6),
          txSignature: 'paper-bulk-close', timestamp: Date.now(),
        }];
        pos.remainingPct = 0;
        pos.tokensRemaining = 0;
        pos.status = 'closed';
        pos.closedTime = Date.now();
        pos.finalPnlSol = +(pos.totalSolReturned - pos.entrySol).toFixed(6);
        realised += pos.finalPnlSol;
        closed++; touched++;
      }
      if (touched) { trader.persist(); tasks++; }
    }
    return { closed, tasks, realisedSol: +realised.toFixed(3), unpriced };
  }

  async reconcileAll(): Promise<{ task: string; fixed: string[]; orphans: string[]; ghosts: string[] }[]> {
    const out: { task: string; fixed: string[]; orphans: string[]; ghosts: string[] }[] = [];
    for (const t of this.all().filter(x => !x.paper)) {
      try {
        const r = await this.traderFor(t).reconcile();
        if (r.fixed.length || r.orphans.length || r.ghosts.length) out.push({ task: t.name, ...r });
      } catch (err: any) { console.error(`[Tasks] reconcile failed (${t.name}): ${err.message}`); }
    }
    return out;
  }

  /** Repair entry bases on every real task (runs at startup). */
  async repairAll(): Promise<void> {
    for (const t of this.all().filter(x => !x.paper)) {
      try { await this.traderFor(t).repairEntryBasis(); }
      catch (err: any) { console.error(`[Tasks] repair failed (${t.name}): ${err.message}`); }
    }
  }

  // ── Trading fan-out ──
  /** Sources a task follows. PumpClaw's own scanner is the base feed every task
   *  gets unless explicitly opted out — adding an external caller ADDS a lane,
   *  it never silently unsubscribes you from your own bot's calls. */
  sourcesFor(task: TradeTask): string[] {
    const extras = (task.sources?.length ? task.sources : task.source ? [task.source] : [])
      .filter(s => s !== PUMPCLAW_SOURCE_ID);
    return [...(task.noPumpclaw ? [] : [PUMPCLAW_SOURCE_ID]), ...extras];
  }

  enabledTasks(sourceId: string = PUMPCLAW_SOURCE_ID): TradeTask[] {
    return this.all().filter(t => t.enabled && this.sourcesFor(t).includes(sourceId));
  }

  /** Every enabled task regardless of source (dashboards, banners). */
  allEnabled(): TradeTask[] { return this.all().filter(t => t.enabled); }

  private lastNoFillAlert = 0;

  /** Rolling record of what each live task did with each call. */
  /**
   * Why each call did or did not become a trade.
   *
   * This was in memory only, so every restart wiped it — and a restart is usually a
   * deploy, which is exactly the moment the previous failures matter most. Twice
   * today the log was empty right after a fix and there was no way to tell whether
   * that meant "nothing failed" or "the evidence is gone".
   */
  readonly buyLog: { ts: number; task: string; symbol: string; mint: string; bought: boolean; reason: string | null }[] = [];
  private consecutiveMisses = new Map<string, number>();
  private lastMissAlert = new Map<string, number>();

  /**
   * Note whether a live task acted on a call, and shout if one stops acting.
   *
   * A task that is enabled and funded but never buys produces no error of any kind —
   * it simply does nothing, forever. Three separate faults hid in exactly that gap,
   * each found only because paper fills were compared against real ones by hand.
   */
  private noteBuyOutcome(task: TradeTask, symbol: string, mint: string, bought: boolean, reason: string | null): void {
    this.buyLog.unshift({ ts: Date.now(), task: task.name, symbol, mint, bought, reason });
    if (this.buyLog.length > 200) this.buyLog.pop();
    this.saveBuyLog();

    if (bought) { this.consecutiveMisses.set(task.id, 0); return; }
    const n = (this.consecutiveMisses.get(task.id) ?? 0) + 1;
    this.consecutiveMisses.set(task.id, n);
    console.log(`[Tasks] "${task.name}" did not buy $${symbol}: ${reason} (${n} in a row)`);

    // "Already holding" is a normal reason to pass, not a fault.
    if (reason === 'already holding this coin') return;

    // A failed swap is different from a declined one: the bot tried to spend real
    // money and could not. That is worth saying the first time, not the third.
    if (reason && reason.startsWith('swap failed')) {
      const last = this.lastMissAlert.get(task.id) ?? 0;
      if (Date.now() - last > 10 * 60_000) {
        this.lastMissAlert.set(task.id, Date.now());
        sendOpsAlert(
          `⚠️ **${task.name}** tried to buy **$${symbol}** and the swap failed.\n\`${reason}\``,
          CONFIG.TRADES_WEBHOOK,
        ).catch(() => {});
      }
      return;
    }

    if (n < 3) return;
    const last = this.lastMissAlert.get(task.id) ?? 0;
    if (Date.now() - last < 20 * 60_000) return;
    this.lastMissAlert.set(task.id, Date.now());
    sendOpsAlert(
      `⚠️ **${task.name}** has passed on **${n} calls in a row** — most recent: $${symbol}.\n` +
      `Reason given: \`${reason}\`\n` +
      `It is enabled but not trading. Check the balance and the task's sources.`,
      CONFIG.TRADES_WEBHOOK,
    ).catch(() => {});
  }

  /** Buy on all enabled tasks in parallel. Posts each fill to Discord. */
  async buyAll(mint: string, symbol: string, name: string, price: number, mc: number, sourceId: string = PUMPCLAW_SOURCE_ID): Promise<number> {
    const all = this.enabledTasks(sourceId);
    if (all.length === 0) return 0;

    // Dip-entry tasks don't buy the call — they queue an order below it.
    const tasks = all.filter(t => t.strategy.entryMode !== 'dip');
    const dipTasks = all.filter(t => t.strategy.entryMode === 'dip');
    for (const t of dipTasks) {
      if (this.traderFor(t).getPosition(mint)?.status === 'open') continue;
      if (this.pending.some(p => p.taskId === t.id && p.mint === mint)) continue;
      const dip = t.strategy.dipPct ?? 0.2;
      this.pending.push({
        taskId: t.id, mint, symbol, name,
        callPrice: price,
        target: price * (1 - dip),
        expiresAt: Date.now() + (t.strategy.dipWindowMin ?? 30) * 60_000,
        callMC: mc,
        targetMC: mc > 0 ? mc * (1 - dip) : undefined,
      });
      console.log(`[Tasks] ⏳ "${t.name}" waiting for $${symbol} to dip ${(dip * 100).toFixed(0)}%`);
    }
    if (dipTasks.length > 0) this.savePending();
    if (tasks.length === 0) return 0;

    const results = await Promise.allSettled(
      tasks.map(t => this.traderFor(t).buy(mint, symbol, name, price, mc)),
    );

    // Record what each REAL task did with this call. A live task quietly declining
    // is the failure mode that hid three separate bugs; it is now always stated.
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (t.paper) continue;
      const r = results[i];
      const bought = r.status === 'fulfilled' && r.value !== null;
      const why = r.status === 'rejected'
        ? `error: ${String((r as PromiseRejectedResult).reason).slice(0, 80)}`
        : (this.traderFor(t).lastSkip ?? 'unknown');
      this.noteBuyOutcome(t, symbol, mint, bought, bought ? null : why);
    }
    let bought = 0, realBought = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        bought++;
        if (!tasks[i].paper) {
          realBought++;
          const pos = r.value;
          sendTradeActivity(
            tasks[i].name, 'buy', symbol, mint,
            `**${pos.entrySol} SOL** at ${mc >= 1000 ? '$' + (mc / 1000).toFixed(1) + 'K' : '$' + mc.toFixed(0)} MC`,
            pos.entryTx, tasks[i].webhook,
          ).catch(() => {});
        }
      } else if (r.status === 'rejected') {
        console.error(`[Tasks] Buy error (${tasks[i].name}): ${r.reason?.message}`);
      }
    });
    // Every REAL task skipped (usually balance) — tell the owner, max once per 30 min.
    // Paper fills don't count: shadow tasks always fill and would mask a broke wallet.
    const realTasks = tasks.filter(t => !t.paper).length;
    if (realTasks > 0 && realBought === 0 && Date.now() - this.lastNoFillAlert > 30 * 60 * 1000) {
      this.lastNoFillAlert = Date.now();
      sendOpsAlert(`Call **$${symbol}** fired but **0/${realTasks} real task(s) bought** — most likely low wallet balance. Check the Tasks page.`, CONFIG.TRADES_WEBHOOK).catch(() => {});
    }
    return bought;
  }

  // Mints currently mid-check — the Jupiter loop and the DexScreener sweep overlap,
  // and a concurrent double-check could double-fire an exit (paper fills especially).
  private checking = new Map<string, number>();

  /** Check price triggers for one mint across all tasks. Returns exits tagged by task
   *  and posts each executed sell to Discord. */
  async checkAll(mint: string, price: number, mc: number): Promise<TaskExitEvent[]> {
    // The mutex used to be a bare Set with a try/finally. finally releases on an
    // error but never on a HANG, so one un-answered RPC call left a mint marked
    // "checking" forever and every later call for it returned instantly as a no-op —
    // including the stop watchdog's forced exit. Entries now expire, so a stuck
    // check degrades to a slow check instead of silently disabling that coin.
    const held = this.checking.get(mint);
    if (held !== undefined && Date.now() - held < CHECK_LOCK_MS) return [];
    if (held !== undefined) {
      console.error(`[Tasks] check lock on ${mint.slice(0, 8)} expired after ${CHECK_LOCK_MS}ms — forcing a fresh check`);
    }
    this.checking.set(mint, Date.now());
    try {
      return await this._checkAllInner(mint, price, mc);
    } finally {
      this.checking.delete(mint);
    }
  }

  private async _checkAllInner(mint: string, price: number, mc: number): Promise<TaskExitEvent[]> {
    const events: TaskExitEvent[] = [];
    for (const task of this.all()) {
      try {
        const exits = await this.traderFor(task).checkPosition(mint, price, mc);
        for (const exit of exits) {
          events.push({ task, exit });
          if (task.paper) continue; // shadow fills stay off Discord — dashboard only
          const pos = this.traderFor(task).getPosition(mint);
          sendTradeActivity(
            task.name, 'sell', pos?.symbol ?? mint.slice(0, 8), mint,
            `${exit.label} at **${exit.multiplierAtExit.toFixed(2)}X** → +${exit.solReceived.toFixed(4)} SOL${positionSummary(pos)}`,
            exit.txSignature, task.webhook,
          ).catch(() => {});
        }
      } catch (err: any) {
        console.error(`[Tasks] Check error (${task.name}/${mint.slice(0, 8)}): ${err.message}`);
      }
    }
    return events;
  }

  /** Close positions on tasks following `sourceId` because that caller posted a sell. */
  async mirrorExit(sourceId: string, mint: string, price: number, mc: number, label: string): Promise<number> {
    let closed = 0;
    for (const task of this.enabledTasks(sourceId)) {
      const trader = this.traderFor(task);
      if (!trader.getPosition(mint) || trader.getPosition(mint)?.status !== 'open') continue;
      try {
        const exits = await trader.checkPosition(mint, price, mc, label);
        for (const exit of exits) {
          closed++;
          if (!task.paper) {
            sendTradeActivity(
              task.name, 'sell', trader.getPosition(mint)?.symbol ?? mint.slice(0, 8), mint,
              `${label} at **${exit.multiplierAtExit.toFixed(2)}X** → **+${exit.solReceived.toFixed(4)} SOL**`,
              exit.txSignature, task.webhook,
            ).catch(() => {});
          }
        }
      } catch (err: any) {
        console.error(`[Tasks] Mirror exit failed (${task.name}/${mint.slice(0, 8)}): ${err.message}`);
      }
    }
    return closed;
  }

  /** Retry liquidation on every position whose stop fired but never cleared. */
  async panicSweep(): Promise<void> {
    for (const task of this.all()) {
      if (task.paper) continue;
      const trader = this.traderFor(task);
      for (const pos of trader.getStuckPositions()) {
        const exits = await trader.panicSell(pos.mint);
        for (const exit of exits) {
          sendTradeActivity(
            task.name, 'sell', pos.symbol, pos.mint,
            `${exit.label} → +${exit.solReceived.toFixed(4)} SOL${positionSummary(trader.getPosition(pos.mint))}`,
            exit.txSignature, task.webhook,
          ).catch(() => {});
        }
      }
    }
  }

  /** Every open position across all tasks, tagged with its task. */
  openPositions(): { task: TradeTask; pos: RealPosition }[] {
    const out: { task: TradeTask; pos: RealPosition }[] = [];
    for (const task of this.all()) {
      for (const pos of this.traderFor(task).getOpenPositions()) out.push({ task, pos });
    }
    return out;
  }
}

export const taskManager = new TaskManager();
