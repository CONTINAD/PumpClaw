/** Sanity-check every /mogboard window against the real call log. */
import { readFileSync } from 'fs';
import { CONFIG } from '../src/config.js';
const calls = JSON.parse(readFileSync(`${CONFIG.DATA_DIR}/calls.json`, 'utf-8'));
const W: Record<string, { label: string; ms: number; sinceMidnight?: boolean }> = {
  '1h': { label: 'last hour', ms: 3600_000 },
  '3h': { label: 'last 3 hours', ms: 3 * 3600_000 },
  '6h': { label: 'last 6 hours', ms: 6 * 3600_000 },
  '12h': { label: 'last 12 hours', ms: 12 * 3600_000 },
  'today': { label: 'today (UTC)', ms: 0, sinceMidnight: true },
  '24h': { label: 'last 24 hours', ms: 24 * 3600_000 },
  '3d': { label: 'last 3 days', ms: 3 * 24 * 3600_000 },
  '7d': { label: 'last 7 days', ms: 7 * 24 * 3600_000 },
  '30d': { label: 'last 30 days', ms: 30 * 24 * 3600_000 },
  'all': { label: 'all time', ms: Number.MAX_SAFE_INTEGER },
};
for (const [k, win] of Object.entries(W)) {
  const now = new Date();
  const cutoff = win.sinceMidnight
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    : win.ms === Number.MAX_SAFE_INTEGER ? 0 : Date.now() - win.ms;
  const inW = calls.filter((c: any) => c.entryTime >= cutoff);
  const d2 = inW.filter((c: any) => (c.peakMultiplier ?? 1) >= 2).length;
  const best = inW.length ? Math.max(...inW.map((c: any) => c.peakMultiplier ?? 1)) : 0;
  console.log(`${k.padEnd(6)} ${win.label.padEnd(20)} ${String(inW.length).padStart(4)} calls  ` +
    `${String(d2).padStart(3)} hit 2x  best ${best.toFixed(2)}x  ${inW.length ? '' : '(board says: no calls)'}`);
}
