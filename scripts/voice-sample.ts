/** Print what each wallet would actually post, using a stubbed call record so the
 *  fact-bearing lines are exercised rather than falling through to the short form. */
import { calloutThesis, useCallRecords } from '../src/pump-callout.js';

const scan = (o: any) => ({
  getByMint: () => ({
    entryDeepHolders: { owners: o.owners, traced: o.traced, fresh: o.fresh,
                        largestCluster: o.cluster, funders: o.funders,
                        independent: o.independent },
    entryHolders: { devHoldPct: o.dev },
  }),
} as any);

const COINS = [
  { sym: 'GLORP', owners: 214, traced: 60, fresh: 9,  cluster: 2, funders: 41, independent: 52, dev: 3 },
  { sym: 'BIRDO', owners: 88,  traced: 47, fresh: 14, cluster: 3, funders: 29, independent: 38, dev: 5 },
];

for (const c of COINS) {
  useCallRecords(scan(c));
  console.log(`\n$${c.sym} — ${c.owners} holders, ${c.traced} traced, ${c.cluster} biggest cluster\n`);
  for (const [task, dip] of [['MANIFEST', undefined], ['INSTANT', undefined], ['DIP 20%', 0.2]] as const) {
    for (let n = 0; n < 3; n++) {
      console.log(`  ${(n === 0 ? task : '').padEnd(10)} ${calloutThesis(task, c.sym, 'x', dip)}`);
    }
    console.log('');
  }
}
