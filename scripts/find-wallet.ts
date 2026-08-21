/** Read-only. Finds the full pubkey of the trading wallet by looking at who traded
 *  a coin the bot bought, then prints its recent SOL movements. Nothing signed. */
import { Connection, PublicKey } from '@solana/web3.js';
async function main() {
  const mint = process.argv[2];
  const prefix = process.argv[3] || 'GKre7a';
  const suffix = process.argv[4] || 'Yypd';
  const c = new Connection(process.env.HELIUS_RPC!, 'confirmed');
  let sigs: any[] = [];
  let before: string | undefined;
  for (let page = 0; page < 6; page++) {
    const b = await c.getSignaturesForAddress(new PublicKey(mint), { limit: 200, before });
    if (!b.length) break;
    sigs = sigs.concat(b); before = b[b.length - 1].signature;
  }
  console.log('scanning', sigs.length, 'transactions on this mint');
  let owner: PublicKey | null = null;
  for (const s of sigs) {
    const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    const keys0 = tx.transaction.message.staticAccountKeys ?? [];
    for (const k of keys0) {
      const b = k.toBase58();
      if (b.startsWith(prefix) && b.endsWith(suffix)) { owner = k; break; }
    }
    if (owner) break;
  }
  if (!owner) { console.log('could not find a wallet matching', prefix + '…' + suffix, 'in the last 60 txs of this mint'); return; }
  console.log('TRADING WALLET:', owner.toBase58());
  console.log('solscan: https://solscan.io/account/' + owner.toBase58());
  console.log('balance now:', (await c.getBalance(owner)) / 1e9, 'SOL\n');
  const own = await c.getSignaturesForAddress(owner, { limit: 15 });
  console.log('last 15 transactions on that wallet:');
  for (const s of own) {
    const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) { console.log('  (unloadable)', s.signature.slice(0, 12)); continue; }
    const keys = tx.transaction.message.staticAccountKeys ?? [];
    const i = keys.findIndex((k: any) => k.equals(owner!));
    const d = i >= 0 ? (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9 : 0;
    const logs = (tx.meta.logMessages ?? []).join(' ');
    const kind = /Jupiter|jup|Whirl|Raydium|pump/i.test(logs) ? 'swap' : 'TRANSFER';
    const when = s.blockTime ? new Date(s.blockTime * 1000).toISOString().slice(11, 19) : '?';
    console.log(`  ${when}  ${d >= 0 ? '+' : ''}${d.toFixed(4)} SOL  ${kind.padEnd(9)} ${s.signature.slice(0, 20)}…`);
  }
}
main();
