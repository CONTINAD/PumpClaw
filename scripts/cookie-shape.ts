/** Reports the SHAPE of each PUMP_COOKIE_* — never the value. */
function main() {
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('PUMP_COOKIE_')) continue;
    const t = (v ?? '').trim();
    const pairs = t.split(';').map(s => s.trim()).filter(Boolean);
    const names = pairs.map(p => (p.includes('=') ? p.split('=')[0] : '(bare value, no name=)'));
    console.log(`${k}:`);
    console.log(`   length ${t.length}, ${pairs.length} pair(s)`);
    console.log(`   names: ${names.join(', ').slice(0, 200)}`);
    console.log(`   starts with: ${t.slice(0, 12)}…`);
  }
}
main();
