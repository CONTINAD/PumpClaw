/**
 * Run one channel-audit pass by hand and print the table.
 *
 * The bot does this every 20 minutes on its own — this is for looking at the answer
 * now, or for auditing a channel that is not in the scrape list yet:
 *
 *   npx tsx scripts/channel-backtest.ts                       # configured channels
 *   npx tsx scripts/channel-backtest.ts pumpfunnewpairs,foo    # try candidates
 *
 * The logic lives in src/channel-audit.ts so this and the bot cannot drift apart.
 */
import { auditPass, loadObs } from '../src/channel-audit.js';
import { tgChannels } from '../src/telegram.js';

const channels = process.argv[2] ? process.argv[2].split(',').map(s => s.trim()).filter(Boolean) : tgChannels();
console.log(`channels: ${channels.join(', ')}`);

const before = loadObs().length;
const { recorded, measured, pending } = await auditPass(channels, 40);
console.log(`recorded ${recorded} new, measured ${measured}, ${pending} awaiting age (${before} known before this run)\n`);

const obs = loadObs();
console.log(`${'channel'.padEnd(22)}${'n'.padStart(5)}${'died'.padStart(7)}${'1.5x'.padStart(7)}${'2x'.padStart(7)}${'5x'.padStart(7)}${'median'.padStart(9)}${'best'.padStart(8)}`);
for (const ch of channels) {
  const peaks = obs.filter(o => o.channel === ch && o.peak !== undefined).map(o => o.peak!).sort((a, b) => a - b);
  if (!peaks.length) { console.log(`${ch.padEnd(22)}    0   nothing measured yet`); continue; }
  const pct = (f: (p: number) => boolean) => `${Math.round(peaks.filter(f).length / peaks.length * 100)}%`;
  console.log(ch.padEnd(22) + String(peaks.length).padStart(5) +
    pct(p => p < 0.5).padStart(7) + pct(p => p >= 1.5).padStart(7) +
    pct(p => p >= 2).padStart(7) + pct(p => p >= 5).padStart(7) +
    `${peaks[Math.floor(peaks.length / 2)].toFixed(2)}x`.padStart(9) +
    `${peaks[peaks.length - 1].toFixed(1)}x`.padStart(8));
}
console.log(`\n"died" is a peak under 0.5x. Compare on median, not best — best is one coin,`);
console.log(`and picking a channel by its luckiest post picks the luckiest channel.`);
const thin = channels.filter(ch => obs.filter(o => o.channel === ch && o.peak !== undefined).length < 20);
if (thin.length) console.log(`\nSTILL THIN (<20 measured): ${thin.join(', ')}`);
