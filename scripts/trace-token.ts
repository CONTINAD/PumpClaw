/** Does a wallet still hold this mint, and what did it do around a given time?
 *  Read-only. Nothing signed. */
import { Connection, PublicKey } from '@solana/web3.js';
async function main() {
  const [owner, mint] = process.argv.slice(2);
  const c = new Connection(process.env.HELIUS_RPC!, 'confirmed');
  const o = new PublicKey(owner), m = new PublicKey(mint);
  const accs = await c.getParsedTokenAccountsByOwner(o, { mint: m });
  console.log('token accounts for this mint:', accs.value.length);
  for (const a of accs.value) {
    console.log('  ', a.pubkey.toBase58().slice(0, 12) + '…',
      'amount', a.account.data.parsed.info.tokenAmount.amount);
  }
  const sigs = await c.getSignaturesForAddress(o, { limit: 30 });
  console.log('\nwallet SOL movements (last 30 tx):');
  for (const s of sigs) {
    const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) continue;
    const keys = (tx.transaction.message as any).staticAccountKeys ?? [];
    const i = keys.findIndex((k: any) => k.equals(o));
    const d = i >= 0 ? (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9 : 0;
    if (Math.abs(d) < 0.0005) continue;
    const when = s.blockTime ? new Date(s.blockTime * 1000).toISOString().slice(11, 19) : '?';
    const touched = (tx.meta.logMessages ?? []).some(l => l.includes(mint.slice(0, 20)));
    console.log(`  ${when}  ${d >= 0 ? '+' : ''}${d.toFixed(4)} SOL ${touched ? '  <-- THIS MINT' : ''}`);
  }
}
main();
