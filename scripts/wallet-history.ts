/** Read-only audit of the trading wallet: recent SOL movements, swap vs transfer.
 *  Nothing is signed, nothing is sent, no secret is read or printed. */
import { Connection, PublicKey } from '@solana/web3.js';
async function main() {
  const owner = new PublicKey(process.argv[2]);
  const c = new Connection(process.env.HELIUS_RPC!, 'confirmed');
  console.log('wallet  ', owner.toBase58());
  console.log('solscan  https://solscan.io/account/' + owner.toBase58());
  console.log('balance ', (await c.getBalance(owner)) / 1e9, 'SOL\n');
  const sigs = await c.getSignaturesForAddress(owner, { limit: 25 });
  console.log('time      SOL change   type       signature');
  for (const s of sigs) {
    const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) { console.log('  (unloadable)', s.signature.slice(0, 16)); continue; }
    const keys = (tx.transaction.message as any).staticAccountKeys ?? [];
    const i = keys.findIndex((k: any) => k.equals(owner));
    const d = i >= 0 ? (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9 : 0;
    const logs = (tx.meta.logMessages ?? []).join(' ');
    const swap = /Jupiter|JUP|Whirlpool|Raydium|pump|Meteora/i.test(logs);
    const when = s.blockTime ? new Date(s.blockTime * 1000).toISOString().slice(11, 19) : '?';
    console.log(`${when}  ${(d >= 0 ? '+' : '') + d.toFixed(4)}`.padEnd(22) + `${swap ? 'swap' : '>> TRANSFER'}`.padEnd(13) + s.signature.slice(0, 24) + '…');
  }
}
main();
