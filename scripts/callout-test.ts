/** Fires the callout test route with dashboard auth derived from DASH_PASSWORD.
 *  Prints only the result; no secret is echoed. */
import { createHash } from 'crypto';
async function main() {
  const pw = process.env.DASH_PASSWORD;
  if (!pw) { console.log('DASH_PASSWORD not in env'); return; }
  const hash = createHash('sha256').update(pw).digest('hex');
  const q = process.argv.slice(2).join('&');
  const url = `https://pumpclaw-production.up.railway.app/api/callout-test${q ? '?' + q : ''}`;
  const r = await fetch(url, { headers: { Cookie: `dash_auth=${hash}`, 'User-Agent': 'Mozilla/5.0' } });
  console.log('HTTP', r.status);
  console.log(await r.text());
}
main();
