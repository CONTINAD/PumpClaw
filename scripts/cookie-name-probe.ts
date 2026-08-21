/** The cookie value is known but its NAME is not. Try the plausible names against a
 *  harmless GET and report which one stops returning 401. Value never printed. */
async function main() {
  const raw = (process.env.PUMP_COOKIE_MANIFEST ?? '').trim();
  if (!raw || raw.length < 24) { console.log('no usable cookie in env'); return; }
  const mint = '86JF1S58ZNT7rHhpgjzDuNxcC1PMYkECDuoRQoj5Scy5';
  const shapes: [string, Record<string,string>][] = [
    ['Authorization: Bearer', { Authorization: `Bearer ${raw}` }],
    ['auth_token cookie',     { Cookie: `auth_token=${raw}` }],
    ['x-auth-token header',   { 'x-auth-token': raw }],
    ['both bearer+cookie',    { Authorization: `Bearer ${raw}`, Cookie: `auth_token=${raw}` }],
  ];
  console.log('value is %d chars, starts %s…\n', raw.length, raw.slice(0, 6));
  for (const [label, hdr] of shapes) {
    try {
      const r = await fetch(`https://frontend-api-v3.pump.fun/callout/eligibility/${mint}`, {
        headers: { ...hdr, 'User-Agent': 'Mozilla/5.0',
                   Origin: 'https://pump.fun', Referer: 'https://pump.fun/' },
        signal: AbortSignal.timeout(8000),
      });
      const body = (await r.text()).slice(0, 90);
      console.log(`${label.padEnd(24)} ${r.status}  ${body}`);
    } catch (e: any) { console.log(`${label.padEnd(24)} threw ${String(e.message).slice(0, 40)}`); }
  }
}
main();
