import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');

export const CONFIG = {
  HELIUS_RPC: process.env.HELIUS_RPC || '',
  // Backup RPC endpoints (comma-separated) tried when the primary fails — e.g. a spare
  // Helius/Alchemy/QuickNode key. Empty = no fallback.
  RPC_FALLBACKS: (process.env.RPC_FALLBACKS || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || '',
  DISCORD_WEBHOOK_2: process.env.DISCORD_WEBHOOK_2 || 'https://discord.com/api/webhooks/1498748255478219012/A9lvI1Uo5QHkxuRQcm1yO96abLuLV99RLlRos9sULB_bk_shfyi6BpULq_eaUpQnbHt0',
  DISCORD_CALLER_ROLE_ID: process.env.DISCORD_CALLER_ROLE_ID || '1499104951912370437',
  // Bot account used to paste the bare CA (Rick-style trackers ignore webhook messages).
  // Comma-separated channel IDs — one per channel the CA should be pasted in.
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '',
  DISCORD_CALL_CHANNEL_IDS: (process.env.DISCORD_CALL_CHANNEL_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  // Message posted after each call. {mint} is replaced with the CA.
  CA_MESSAGE_TEMPLATE: process.env.CA_MESSAGE_TEMPLATE || '{mint}',
  // Separate webhook for trade activity (entries/exits) so the calls channel stays clean
  TRADES_WEBHOOK: process.env.TRADES_WEBHOOK || 'https://discord.com/api/webhooks/1536130988722098186/qDIDNixc4jzM1175SN9_9aj3XvwWo4qk4MQJ2bhbJFyappAnnCMtucME6T943eLPhvaE',
  // Discord application (slash commands — /mog PnL card)
  DISCORD_APP_ID: process.env.DISCORD_APP_ID || '1528962115778642090',
  DISCORD_APP_PUBLIC_KEY: process.env.DISCORD_APP_PUBLIC_KEY || '',
  DISCORD_BIG_MILESTONE_THRESHOLD: 10,  // ping caller role only on milestones >= this
  PUMPFUN_API: 'https://frontend-api-v3.pump.fun',
  DEXSCREENER_API: 'https://api.dexscreener.com',

  // Alerts — volume thresholds
  MIN_5M_VOLUME_MICRO_MC: 5_000,  // required 5m vol if MC < 20k
  MIN_5M_VOLUME_LOW_MC: 8_000,   // required 5m vol if MC 20k-50k
  MIN_5M_VOLUME_HIGH_MC: 15_000, // required 5m vol if MC >= 50k
  MICRO_MC_THRESHOLD: 20_000,    // MC cutoff for micro tier
  LOW_MC_THRESHOLD: 50_000,      // MC cutoff between low and high tiers
  SCAN_INTERVAL_MS: 30_000,

  // Performance tracking intervals (minutes after alert)
  PERFORMANCE_INTERVALS: [5, 15, 30, 60],

  // Milestone multipliers that trigger a success post
  MILESTONES: [2, 3, 5, 10, 20, 50, 100],

  // How often to check milestones for all tracked coins (ms)
  MILESTONE_CHECK_INTERVAL_MS: 15_000,

  // Leaderboard intervals: [label, postEveryMs, lookbackMs]
  LEADERBOARD_INTERVALS: [
    { label: '6 Hours', postEvery: 6 * 60 * 60 * 1000,   lookback: 6 * 60 * 60 * 1000 },
    { label: '12 Hours', postEvery: 12 * 60 * 60 * 1000,  lookback: 12 * 60 * 60 * 1000 },
    { label: '24 Hours', postEvery: 24 * 60 * 60 * 1000,  lookback: 24 * 60 * 60 * 1000 },
    { label: '7 Days',  postEvery: 7 * 24 * 60 * 60 * 1000, lookback: 7 * 24 * 60 * 60 * 1000 },
  ] as const,

  // Bundle detection
  BUNDLE_CHECK_ENABLED: true,
  BUNDLE_TOP_HOLDERS: 20,           // top holders checked (getTokenLargestAccounts caps at 20)
  BUNDLE_TIME_WINDOW_SEC: 300,      // 5 min narrow window for clustering
  BUNDLE_MAX_CLUSTER_PCT: 30,       // skip if 30%+ of fresh holders funded within same 5 min
  BUNDLE_HOUR_CLUSTER_PCT: 40,      // skip if 40%+ of fresh holders funded within same hour (Axiom "time-linked funding")
  BUNDLE_DAY_CLUSTER_PCT: 40,       // skip if 40%+ of fresh holders funded within same 24h
  BUNDLE_WIDE_CLUSTER_PCT: 60,      // skip if 60%+ of fresh holders funded within same 7-day window
  BUNDLE_MIN_FRESH_WALLETS: 5,      // hour/day/wide checks need at least this many fresh-wallet samples
  BUNDLE_LOW_BAL_HOLDERS: 20,       // check this many top holders for low SOL balance
  BUNDLE_LOW_BAL_SOL: 1,            // wallets with less than this SOL are "low balance"
  BUNDLE_LOW_BAL_PCT: 40,           // skip if 40%+ of top holders have < 1 SOL

  // Global fee / activity filter
  MIN_GLOBAL_FEES_SOL: 2,           // skip if estimated trading fees < 2 SOL
  MIN_GLOBAL_FEES_MC: 50_000,       // only apply fee check if MC >= this
  PUMPSWAP_FEE_RATE: 0.003,         // ~0.3% total pumpswap fee rate

  // Persistent data
  DATA_DIR,
  DATA_FILE: join(DATA_DIR, 'calls.json'),

  // Paper trading (simulated 1 SOL per call)
  PAPER_ENTRY_SOL: 1.0,
  PAPER_STOP_LOSS_PCT: 0.70,   // stop at -30% from entry — meme coins often dip before pumping, so don't cut too tight
  PAPER_TP1_MULT: 2,           // TP1 at 2X — sell 50%, move SL to break-even
  PAPER_TP1_SELL: 0.50,
  PAPER_TP2_MULT: 4,           // TP2 at 4X — sell 25%
  PAPER_TP2_SELL: 0.25,
  PAPER_TP3_MULT: 6,           // TP3 at 6X — sell 15%, activate trailing stop on remaining 10%
  PAPER_TP3_SELL: 0.15,
  PAPER_TRAILING_DROP: 0.35,   // trailing stop fires at -35% from ATH
  PAPER_DATA_FILE: join(DATA_DIR, 'trades.json'),

  // Monthly top 10 leaderboard — posted daily
  MONTHLY_LB_HOUR_UTC: 20,     // post at 20:00 UTC every day

  // Real trading
  TRADE_ENABLED: true,
  TRADE_ENTRY_PCT: 0.10,               // 10% of wallet balance per trade
  TRADE_MIN_ENTRY_SOL: 0.05,           // minimum 0.05 SOL per trade
  TRADE_SLIPPAGE_BPS: 3000,            // 30% slippage
  TRADE_PRIORITY_FEE_LAMPORTS: 100_000, // 0.0001 SOL priority fee
  TRADE_MIN_SOL_BALANCE: 0.05,         // don't trade if wallet SOL below this
  // Exit strategy: 'trailing' = always-on -45% trailing stop from entry, no TPs —
  // backtested 1.76X avg/call on 306 recorded calls vs 1.26X for the TP ladder
  // (fat tails: the 10X+ runners pay for everything). 'ladder' = legacy TP levels.
  TRADE_EXIT_STRATEGY: (process.env.TRADE_EXIT_STRATEGY || 'trailing') as 'trailing' | 'ladder',
  TRADE_STOP_LOSS_PCT: 0.75,           // ladder mode: stop at -25% from entry
  TRADE_TP1_MULT: 1.5, TRADE_TP1_SELL: 0.40,   // ladder: sell 40% at 1.5X
  TRADE_TP2_MULT: 2.5, TRADE_TP2_SELL: 0.30,   // ladder: sell 30% at 2.5X
  TRADE_TP3_MULT: 4,   TRADE_TP3_SELL: 0.20,   // ladder: sell 20% at 4X
  TRADE_TRAILING_DROP: 0.45,           // -45% from ATH (trailing mode: from entry; ladder: after TP3)
  TRADE_MONITOR_INTERVAL_MS: 2_000,   // check open positions every 2s
};

// ── Runtime settings overrides (dashboard /settings page) ───
// Persisted to DATA_DIR/settings.json and applied over CONFIG at boot AND live
// in-process on save (dashboard + trader share the process, so changes take
// effect immediately without a restart).

const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
export const SETTINGS_KEYS = [
  'TRADE_ENABLED', 'TRADE_EXIT_STRATEGY', 'TRADE_ENTRY_PCT',
  'TRADE_MIN_ENTRY_SOL', 'TRADE_TRAILING_DROP', 'TRADE_SLIPPAGE_BPS',
] as const;

export function loadSettingsOverrides(): void {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    for (const k of SETTINGS_KEYS) if (k in raw) (CONFIG as any)[k] = raw[k];
    console.log(`[Config] Applied settings overrides: ${Object.keys(raw).join(', ')}`);
  } catch { /* no overrides yet */ }
}

export function saveSettingsOverrides(patch: Record<string, any>): void {
  let cur: Record<string, any> = {};
  try { cur = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')); } catch {}
  for (const k of SETTINGS_KEYS) {
    if (k in patch) { cur[k] = patch[k]; (CONFIG as any)[k] = patch[k]; }
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(cur, null, 2));
}

loadSettingsOverrides();
