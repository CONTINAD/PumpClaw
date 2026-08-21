/** Is this mint buildable by Jupiter at all? "Missing token program" is a mint-level
 *  error, so an owner that holds nothing still reproduces or clears it. Quote + build
 *  only — nothing signed, nothing sent, no key printed. */
async function main() {
  const mint = process.argv[2];
  const owner = process.argv[3] || 'BZQ81EhZFWzzA7Pecs43ihb6hRCZcQhj4QuAyrJJvQKC';
  const key = process.env.JUPITER_API_KEY;
  const SOL = 'So11111111111111111111111111111111111111112';
  for (const [label, host, hdr] of [
    ['FREE  lite-api.jup.ag', 'https://lite-api.jup.ag', {} as any],
    ['PAID  api.jup.ag (the bot’s path)', 'https://api.jup.ag', key ? { 'x-api-key': key } : null],
  ] as [string, string, any][]) {
    if (!hdr) { console.log(label, '-> no JUPITER_API_KEY in env, skipped'); continue; }
    const H = { 'Content-Type': 'application/json', ...hdr };
    for (const [dir, inMint, outMint, amt] of [
      ['SELL', mint, SOL, '1000000000'],
      ['BUY ', SOL, mint, '100000000'],
    ] as [string, string, string, string][]) {
      try {
        const qr = await fetch(`${host}/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amt}&slippageBps=1500`, { headers: H });
        const q: any = await qr.json();
        if (!qr.ok || q.error) { console.log(`${label} ${dir} quote ✗`, JSON.stringify(q).slice(0, 110)); continue; }
        const br = await fetch(`${host}/swap/v1/swap`, { method: 'POST', headers: H,
          body: JSON.stringify({ quoteResponse: q, userPublicKey: owner, wrapAndUnwrapSol: true }) });
        const b: any = await br.json();
        console.log(`${label} ${dir} quote ✓  build ${br.ok && !b.error ? '✓ ' + Buffer.from(b.swapTransaction, 'base64').length + 'b' : '✗ ' + JSON.stringify(b).slice(0, 120)}`);
      } catch (e: any) { console.log(`${label} ${dir} threw`, e.message); }
    }
  }
}
main();
