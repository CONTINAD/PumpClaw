import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');

export const CONFIG = {
  HELIUS_RPC: process.env.HELIUS_RPC || '',
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || '',
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
  MILESTONE_CHECK_INTERVAL_MS: 60_000,

  // Leaderboard intervals: [label, postEveryMs, lookbackMs]
  LEADERBOARD_INTERVALS: [
    { label: '1 Hour',  postEvery: 1 * 60 * 60 * 1000,   lookback: 1 * 60 * 60 * 1000 },
    { label: '6 Hours', postEvery: 6 * 60 * 60 * 1000,   lookback: 6 * 60 * 60 * 1000 },
    { label: '12 Hours', postEvery: 12 * 60 * 60 * 1000,  lookback: 12 * 60 * 60 * 1000 },
    { label: '24 Hours', postEvery: 24 * 60 * 60 * 1000,  lookback: 24 * 60 * 60 * 1000 },
    { label: '7 Days',  postEvery: 7 * 24 * 60 * 60 * 1000, lookback: 7 * 24 * 60 * 60 * 1000 },
  ] as const,

  // Bundle detection
  BUNDLE_CHECK_ENABLED: true,
  BUNDLE_TOP_HOLDERS: 50,           // check this many top holders
  BUNDLE_TIME_WINDOW_SEC: 300,      // 5 min narrow window for clustering
  BUNDLE_MAX_CLUSTER_PCT: 40,       // skip if 40%+ of holders in narrow window
  BUNDLE_WIDE_CLUSTER_PCT: 75,      // skip if 75%+ of holders funded within same 7-day window

  // Global fee / activity filter
  MIN_GLOBAL_FEES_SOL: 2,           // skip if estimated trading fees < 2 SOL
  MIN_GLOBAL_FEES_MC: 50_000,       // only apply fee check if MC >= this
  PUMPSWAP_FEE_RATE: 0.003,         // ~0.3% total pumpswap fee rate

  // Persistent data
  DATA_DIR,
  DATA_FILE: join(DATA_DIR, 'calls.json'),

  // Paper trading (simulated 1 SOL per call)
  PAPER_ENTRY_SOL: 1.0,
  PAPER_STOP_LOSS_PCT: 0.70,   // stop at -30% from entry (price = entry * 0.70)
  PAPER_TP1_MULT: 2,           // TP1 at 2X — sell 40%, move SL to break-even
  PAPER_TP1_SELL: 0.40,
  PAPER_TP2_MULT: 3,           // TP2 at 3X — sell 30%
  PAPER_TP2_SELL: 0.30,
  PAPER_TP3_MULT: 5,           // TP3 at 5X — sell 20%, activate trailing stop
  PAPER_TP3_SELL: 0.20,
  PAPER_TRAILING_DROP: 0.35,   // trailing stop fires at -35% from ATH (remaining 10%)
  PAPER_DATA_FILE: join(DATA_DIR, 'trades.json'),

  // Monthly top 10 leaderboard — posted daily
  MONTHLY_LB_HOUR_UTC: 20,     // post at 20:00 UTC every day

  // Real trading
  TRADE_ENABLED: true,
  TRADE_ENTRY_PCT: 0.20,               // 20% of wallet balance per trade
  TRADE_MIN_ENTRY_SOL: 0.05,           // minimum 0.05 SOL per trade
  TRADE_SLIPPAGE_BPS: 3000,            // 30% slippage
  TRADE_PRIORITY_FEE_LAMPORTS: 100_000, // 0.0001 SOL priority fee
  TRADE_MIN_SOL_BALANCE: 0.05,         // don't trade if wallet SOL below this
  TRADE_STOP_LOSS_PCT: 0.75,           // stop at -25% from entry
  TRADE_TP1_MULT: 1.5, TRADE_TP1_SELL: 0.40,   // sell 40% at 1.5X
  TRADE_TP2_MULT: 2.5, TRADE_TP2_SELL: 0.30,   // sell 30% at 2.5X
  TRADE_TP3_MULT: 4,   TRADE_TP3_SELL: 0.20,   // sell 20% at 4X
  TRADE_TRAILING_DROP: 0.35,           // -35% from ATH on remaining 10%
  TRADE_MONITOR_INTERVAL_MS: 2_000,   // check open positions every 2s
};
