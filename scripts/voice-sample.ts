/** What the three wallets actually post. Prints only. */
import { calloutThesis } from '../src/pump-callout.js';
for (const [sym, mc] of [['MEMEFI', 124400], ['GLORP', 14200], ['BASKET', 1240000], ['Yoriko', 8900]] as [string, number][]) {
  console.log(`\n$${sym}  (${mc >= 1e6 ? '$' + (mc / 1e6).toFixed(1) + 'M' : '$' + (mc / 1000).toFixed(1) + 'K'})`);
  for (const t of ['MANIFEST', 'INSTANT 5 SOL Start', 'DIP 20% 5 SOL']) {
    console.log(`   ${t.padEnd(20)} "${calloutThesis(t, sym, mc)}"`);
  }
}
