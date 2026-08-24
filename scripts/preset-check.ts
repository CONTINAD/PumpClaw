import { STRATEGY_PRESETS, sanitizeStrategy, describeStrategy } from '../src/strategy.js';
const k = process.argv[2] ?? 'instant2x1m';
const raw = STRATEGY_PRESETS[k];
if (!raw) { console.error('no such preset'); process.exit(1); }
const s = sanitizeStrategy(raw.make());
console.log('name :', raw.name);
console.log('desc :', raw.desc);
console.log('after sanitize:');
console.log(JSON.stringify({ preset: s.preset, entryMode: s.entryMode, tps: s.tps,
  maxHoldMin: s.maxHoldMin, stopLossPct: s.stopLossPct, trailingDrop: s.trailingDrop,
  trailingFrom: s.trailingFrom, breakEvenAfterTp1: s.breakEvenAfterTp1,
  entryPct: s.entryPct, minEntrySol: s.minEntrySol, maxEntrySol: s.maxEntrySol }, null, 1));
console.log('reads as:', describeStrategy(s));
