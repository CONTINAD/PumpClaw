/** Runs the bubble-map check against a mint's holders. Read-only, nothing signed. */
import { rpc } from '../src/bundle-check.js';
import { checkWalletGraph } from '../src/wallet-graph.js';
async function main() {
  const mint = process.argv[2];
  const das = await rpc('getTokenAccounts', { mint, limit: 1000, page: 1 });
  const list: any[] = das?.token_accounts ?? [];
  const owners = [...new Set(list.map(t => t.owner as string))].filter(Boolean).slice(1, 61);
  console.log(`holders seen: ${owners.length}`);
  const t = Date.now();
  const g = await checkWalletGraph(owners);
  console.log(`elapsed ${Date.now() - t}ms`);
  console.log(JSON.stringify(g, null, 1));
}
main();
