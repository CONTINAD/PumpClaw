/** Runs deepHolderScan end to end against one mint. Prints the result object only. */
import { deepHolderScan } from '../src/deep-holders.js';
async function main() {
  const M = process.argv[2] || '5y2DQbAQQJJGM3TnQVezZUsAVECkGPcghQrdcV3epump';
  const t = Date.now();
  const d = await deepHolderScan(M);
  console.log('mint', M.slice(0, 10) + '…', '| elapsed', Date.now() - t, 'ms');
  console.log('result:', d === null ? 'NULL  <-- this is why nothing is stored' : JSON.stringify(d, null, 1));
}
main();
