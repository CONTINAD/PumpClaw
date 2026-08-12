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

class TaskManager {
  private tasks = new Map<string, TradeTask>();
  private traders = new Map<string, Trader>();
  private pending: PendingEntry[] = [];

  constructor() {
    this.load();
    this.loadPending();
    this.migrateLegacy();
    this.seedShadowFleet();
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
      noPumpclaw: sources ? !sources.includes(PUMPCLAW_SOURCE_ID) : false,
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
      task.sources = patch.sources.filter(s => s !== PUMPCLAW_SOURCE_ID);
      task.noPumpclaw = !patch.sources.includes(PUMPCLAW_SOURCE_ID);
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
  private checking = new Set<string>();

  /** Check price triggers for one mint across all tasks. Returns exits tagged by task
   *  and posts each executed sell to Discord. */
  async checkAll(mint: string, price: number, mc: number): Promise<TaskExitEvent[]> {
    if (this.checking.has(mint)) return [];
    this.checking.add(mint);
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
