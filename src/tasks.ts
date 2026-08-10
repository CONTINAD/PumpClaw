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
  noPumpclaw?: boolean;  // explicit opt-out of PumpClaw's own scanner (default: follow it)
}

export interface TaskExitEvent { task: TradeTask; exit: RealExit }

class TaskManager {
  private tasks = new Map<string, TradeTask>();
  private traders = new Map<string, Trader>();

  constructor() {
    this.load();
    this.migrateLegacy();
    this.seedShadowFleet();
  }

  /** One shadow (paper) task per strategy preset — path-aware ground truth for the
   *  Strategy Lab's peak-model estimates. Runs every call on live prices, no funds. */
  private seedShadowFleet(): void {
    if (this.all().some(t => t.paper)) return;
    for (const [key, preset] of Object.entries(STRATEGY_PRESETS)) {
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
    console.log(`[Tasks] Seeded shadow fleet: ${Object.keys(STRATEGY_PRESETS).length} paper tasks (one per preset)`);
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

  update(id: string, patch: { name?: string; enabled?: boolean; strategy?: Partial<Strategy>; source?: string; sources?: string[]; walletKey?: string }): TradeTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`No task ${id}`);
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
    const tasks = this.enabledTasks(sourceId);
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
            pos.entryTx,
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
            `${exit.label} at **${exit.multiplierAtExit.toFixed(2)}X** → **+${exit.solReceived.toFixed(4)} SOL**`,
            exit.txSignature,
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
              exit.txSignature,
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
            `${exit.label} → **+${exit.solReceived.toFixed(4)} SOL**`,
            exit.txSignature,
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
