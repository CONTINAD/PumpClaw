import { Connection, PublicKey } from '@solana/web3.js';
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const T22   = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
async function main() {
  const W = new PublicKey('7pC2TYBeg2ZiHvbCj65yyhj2dwRw3rmiLuVUD77GWbWL');
  const c = new Connection(process.env.HELIUS_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
  for (const [label, prog] of [['classic SPL', TOKEN], ['Token-2022', T22]] as const) {
    const r = await c.getParsedTokenAccountsByOwner(W, { programId: prog });
    const held = r.value.filter(a => Number(a.account.data.parsed.info.tokenAmount.amount) > 0);
    console.log(`${label}: ${r.value.length} accounts, ${held.length} holding a balance`);
    for (const a of held) {
      const i = a.account.data.parsed.info;
      console.log(`   ${i.mint}  ${Number(i.tokenAmount.uiAmount).toLocaleString()}`);
    }
    await new Promise(res => setTimeout(res, 250));
  }
  console.log(`SOL: ${(await c.getBalance(W)) / 1e9}`);
}
main().catch(e => { console.error(e.message); process.exit(1); });
