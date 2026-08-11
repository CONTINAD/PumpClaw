/**
 * PumpClaw HQ — the command center.
 * Server sends a static shell; everything is hydrated client-side from /api/*.
 * Aesthetic: phosphor terminal — angular display type, tabular mono data,
 * scanline + grain atmosphere, one hard accent (phosphor green) against near-black.
 */

export function buildHqHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PumpClaw HQ</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oxanium:wght@500;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --void:#04060a; --deep:#080c13; --panel:#0b1119; --line:#151d29; --line2:#1f2a3a;
  --txt:#c9d6e5; --dim:#6b7d94; --faint:#3d4a5c;
  --phos:#3dff9e; --phos-dim:#1f7d51; --amber:#ffb340; --blood:#ff3d5a; --ice:#4dd8ff; --violet:#a78bfa;
  --mono:'IBM Plex Mono',ui-monospace,monospace; --disp:'Oxanium',system-ui,sans-serif;
}
html,body{background:var(--void);color:var(--txt);font-family:var(--mono);font-size:13px;-webkit-font-smoothing:antialiased}
body{min-height:100vh;position:relative;overflow-x:hidden}
/* atmosphere: grain + scanlines + corner glow */
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:9998;
  background:repeating-linear-gradient(180deg,rgba(61,255,158,.024) 0 1px,transparent 1px 3px);mix-blend-mode:screen}
body::after{content:'';position:fixed;inset:0;pointer-events:none;z-index:9997;opacity:.35;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E")}
.glow{position:fixed;pointer-events:none;z-index:0;filter:blur(90px);opacity:.4}
.glow.a{top:-160px;left:-120px;width:520px;height:420px;background:radial-gradient(circle,rgba(61,255,158,.20),transparent 70%)}
.glow.b{bottom:-200px;right:-140px;width:600px;height:460px;background:radial-gradient(circle,rgba(77,216,255,.13),transparent 70%)}
.wrap{position:relative;z-index:1;max-width:1560px;margin:0 auto;padding:0 22px 70px}

/* ── status rail ── */
.rail{display:flex;align-items:center;gap:22px;padding:14px 22px;margin:0 -22px 20px;
  border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(8,12,19,.96),rgba(4,6,10,.6));
  backdrop-filter:blur(10px);position:sticky;top:0;z-index:50;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:11px;font-family:var(--disp);font-weight:800;font-size:19px;letter-spacing:.055em}
.brand .mk{width:26px;height:26px;border:1.5px solid var(--phos);border-radius:6px;display:grid;place-items:center;
  color:var(--phos);font-size:13px;box-shadow:0 0 16px rgba(61,255,158,.35) inset,0 0 12px rgba(61,255,158,.18)}
.brand em{font-style:normal;color:var(--phos);text-shadow:0 0 18px rgba(61,255,158,.55)}
.rail nav{display:flex;gap:3px;margin-left:auto;flex-wrap:wrap}
.rail nav a{padding:6px 13px;border-radius:5px;color:var(--dim);text-decoration:none;font-size:11.5px;
  letter-spacing:.09em;text-transform:uppercase;font-weight:500;border:1px solid transparent;transition:.16s}
.rail nav a:hover{color:var(--phos);border-color:var(--line2);background:rgba(61,255,158,.05)}
.pulse{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dim);letter-spacing:.09em;text-transform:uppercase}
.dot{width:7px;height:7px;border-radius:50%;background:var(--phos);box-shadow:0 0 10px var(--phos);animation:bp 2.2s ease-in-out infinite}
.dot.warn{background:var(--amber);box-shadow:0 0 10px var(--amber)}
.dot.dead{background:var(--blood);box-shadow:0 0 10px var(--blood)}
@keyframes bp{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.82)}}

/* ── kpi strip ── */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(212px,1fr));gap:13px;margin-bottom:20px}
.kpi{background:linear-gradient(165deg,var(--panel),var(--deep));border:1px solid var(--line);border-radius:11px;
  padding:16px 17px;position:relative;overflow:hidden;animation:rise .5s cubic-bezier(.2,.7,.3,1) both}
.kpi::after{content:'';position:absolute;top:0;left:0;right:0;height:1.5px;
  background:linear-gradient(90deg,transparent,var(--edge,var(--phos)),transparent);opacity:.75}
.kpi:nth-child(1){animation-delay:.04s}.kpi:nth-child(2){animation-delay:.09s}
.kpi:nth-child(3){animation-delay:.14s}.kpi:nth-child(4){animation-delay:.19s}.kpi:nth-child(5){animation-delay:.24s}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.kpi .lbl{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:9px;font-weight:600}
.kpi .val{font-family:var(--disp);font-size:32px;font-weight:800;line-height:1;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.kpi .sub{font-size:11px;color:var(--dim);margin-top:7px}
.kpi.ok .val{color:var(--phos);text-shadow:0 0 26px rgba(61,255,158,.35)}
.kpi.bad .val{color:var(--blood)}
.kpi.neutral .val{color:var(--txt)}
.kpi.info .val{color:var(--ice)}

/* ── panels ── */
.cols{display:grid;grid-template-columns:1.35fr 1fr;gap:15px;align-items:start}
@media(max-width:1080px){.cols{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:11px;margin-bottom:15px;overflow:hidden;
  animation:rise .55s cubic-bezier(.2,.7,.3,1) both .12s}
.panel h2{font-family:var(--disp);font-size:11.5px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;
  color:var(--dim);padding:13px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:9px;
  background:linear-gradient(180deg,rgba(21,29,41,.5),transparent)}
.panel h2 .tag{margin-left:auto;font-family:var(--mono);font-size:10px;letter-spacing:.06em;color:var(--faint);text-transform:none}
.panel h2 a{color:var(--phos);text-decoration:none;font-size:10px;letter-spacing:.06em}
.body{padding:14px 16px}
.body.flush{padding:0}

table{width:100%;border-collapse:collapse;font-size:12.5px}
th{font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);text-align:left;
  padding:9px 14px;font-weight:600;border-bottom:1px solid var(--line);background:rgba(11,17,25,.7)}
td{padding:9px 14px;border-bottom:1px solid rgba(21,29,41,.55);font-variant-numeric:tabular-nums}
tbody tr{transition:background .13s}
tbody tr:hover{background:rgba(61,255,158,.035)}
tbody tr:last-child td{border-bottom:none}
.num{text-align:right}
.up{color:var(--phos)}.down{color:var(--blood)}.warnc{color:var(--amber)}.dimc{color:var(--dim)}.ic{color:var(--ice)}
.sym{font-weight:600;color:var(--txt)}
.rank{color:var(--faint);font-size:11px;width:26px}
.chip{display:inline-block;padding:2px 7px;border-radius:4px;font-size:9.5px;letter-spacing:.06em;
  text-transform:uppercase;font-weight:600;border:1px solid}
.chip.dip{color:var(--amber);border-color:rgba(255,179,64,.32);background:rgba(255,179,64,.08)}
.chip.inst{color:var(--dim);border-color:var(--line2);background:rgba(107,125,148,.07)}
.chip.live{color:var(--phos);border-color:rgba(61,255,158,.32);background:rgba(61,255,158,.08)}
/* perf bar behind the avg cell */
.bar{position:relative;display:block;height:100%}
.bar i{position:absolute;left:0;top:50%;transform:translateY(-50%);height:16px;border-radius:3px;opacity:.16}
.bar span{position:relative;font-weight:600}
.empty{color:var(--faint);font-size:12px;padding:26px 16px;text-align:center;letter-spacing:.04em}
.foot{font-size:10.5px;color:var(--faint);padding:10px 16px;border-top:1px solid var(--line);line-height:1.6}
.split{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line)}
.split>div{background:var(--panel);padding:14px 16px}
.split .h{font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);margin-bottom:7px}
.split .v{font-family:var(--disp);font-size:25px;font-weight:800;font-variant-numeric:tabular-nums}
.split .n{font-size:10.5px;color:var(--dim);margin-top:4px}
/* skip bars */
.skips{display:flex;flex-direction:column;gap:8px}
.skip{display:grid;grid-template-columns:118px 1fr 40px;align-items:center;gap:11px;font-size:11.5px}
.skip .track{height:7px;background:rgba(21,29,41,.85);border-radius:4px;overflow:hidden}
.skip .fill{height:100%;border-radius:4px;transition:width .6s cubic-bezier(.2,.7,.3,1)}
.hourbars{display:flex;align-items:flex-end;gap:2px;height:54px}
.hourbars div{flex:1;background:linear-gradient(180deg,var(--phos),var(--phos-dim));border-radius:2px 2px 0 0;
  min-height:2px;opacity:.55;transition:.2s}
.hourbars div:hover{opacity:1}
</style>
</head>
<body>
<div class="glow a"></div><div class="glow b"></div>

<div class="rail">
  <div class="brand"><span class="mk">◤</span>PUMP<em>CLAW</em></div>
  <div class="pulse"><span class="dot" id="hb"></span><span id="hbtxt">connecting</span></div>
  <nav>
    <a href="/shadow">Strategies</a><a href="/tasks">Tasks</a><a href="/strategies">Lab</a>
    <a href="/settings">Settings</a><a href="/classic">Classic</a>
  </nav>
</div>

<div class="wrap">
  <div class="kpis" id="kpis"></div>

  <div class="cols">
    <div>
      <div class="panel">
        <h2>◆ Live Positions <span class="tag" id="postag"></span></h2>
        <div class="body flush" id="positions"><div class="empty">loading…</div></div>
      </div>
      <div class="panel">
        <h2>◆ Recent Calls <span class="tag" id="calltag"></span></h2>
        <div class="body flush" id="calls"><div class="empty">loading…</div></div>
      </div>
      <div class="panel">
        <h2>◆ Call Activity <span class="tag">by hour, UTC</span></h2>
        <div class="body"><div class="hourbars" id="hours"></div></div>
      </div>
    </div>

    <div>
      <div class="panel">
        <h2>◆ Strategy Leaderboard <a href="/shadow">ALL →</a></h2>
        <div class="body flush" id="strats"><div class="empty">loading…</div></div>
        <div class="foot">Paper trades at 1 SOL each on live prices. <span class="up">Green</span> clears the ~3% real-fee break-even.</div>
      </div>
      <div class="panel">
        <h2>◆ Entry Timing <span class="tag">the core question</span></h2>
        <div class="split" id="entrysplit"></div>
        <div class="foot" id="entrynote">Does waiting for a pullback beat buying the call?</div>
      </div>
      <div class="panel">
        <h2>◆ Filter Rejections <span class="tag">why coins get skipped</span></h2>
        <div class="body"><div class="skips" id="skips"></div></div>
      </div>
    </div>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
const fmtSol = n => (n >= 0 ? '+' : '') + n.toFixed(n >= 100 || n <= -100 ? 0 : 2);
const ago = ms => { const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.floor(m/60) + 'h ' + (m%60) + 'm' : Math.floor(m/1440) + 'd'; };
const mc = n => n >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n/1e3).toFixed(1) + 'K' : '$' + (n||0).toFixed(0);
const j = async u => { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return r.json(); };

function kpi(cls, lbl, val, sub, edge) {
  return '<div class="kpi ' + cls + '" style="--edge:' + edge + '"><div class="lbl">' + lbl + '</div>' +
    '<div class="val">' + val + '</div><div class="sub">' + sub + '</div></div>';
}

async function paint() {
  let data, shadow, live, skipped;
  try {
    [data, shadow, live, skipped] = await Promise.all([
      j('/api/data?range=24h'), j('/api/shadow?hours=24'), j('/api/live'), j('/api/skipped').catch(() => ({}))
    ]);
  } catch (e) {
    $('hb').className = 'dot dead'; $('hbtxt').textContent = 'offline'; return;
  }

  // ── heartbeat from the freshest call ──
  const cw = (data.callsWithPeaks || []).slice().sort((a,b) => b.entryTime - a.entryTime);
  const lastCall = cw[0] ? cw[0].entryTime : 0;
  const mins = lastCall ? (Date.now() - lastCall) / 60000 : 9999;
  $('hb').className = 'dot' + (mins > 180 ? ' dead' : mins > 90 ? ' warn' : '');
  $('hbtxt').textContent = lastCall ? 'last call ' + ago(lastCall) + ' ago' : 'no calls yet';

  // ── KPIs ──
  const totalCalls = data.overview.totalCalls || 0;
  const ms = data.milestoneCounts || {};
  const hit2 = ms['2'] || 0;
  const strat = (shadow.strategies || []).filter(s => s.trades >= 5).sort((a,b) => b.avgPerTrade - a.avgPerTrade);
  const best = strat[0];
  const fleetPnl = (shadow.strategies || []).reduce((s,x) => s + x.pnlSol, 0);
  const fleetTrades = (shadow.strategies || []).reduce((s,x) => s + x.trades, 0);
  const openReal = (live.open || []).filter(p => !p.taskName.startsWith('📄'));
  const bal = live.balance;

  $('kpis').innerHTML =
    kpi('neutral', 'Calls · 24h', totalCalls, hit2 + ' hit 2× · ' + (ms['5']||0) + ' hit 5× · ' + (ms['10']||0) + ' hit 10×', 'var(--ice)') +
    kpi(totalCalls ? 'ok' : 'neutral', 'Hit rate 2×', totalCalls ? Math.round(hit2/totalCalls*100) + '%' : '—', 'of calls doubled from entry', 'var(--phos)') +
    kpi(best && best.avgPerTrade > 0.03 ? 'ok' : best && best.avgPerTrade > 0 ? 'neutral' : 'bad',
        'Best strategy', best ? fmtSol(best.avgPerTrade) : '—',
        best ? best.strategy + ' · ' + best.trades + ' trades' : 'no data yet', 'var(--phos)') +
    kpi(fleetPnl >= 0 ? 'ok' : 'bad', 'Fleet PnL · 24h', fmtSol(fleetPnl) + ' ◎',
        fleetTrades + ' paper trades across ' + (shadow.strategies||[]).length + ' strategies', 'var(--violet)') +
    kpi(openReal.length ? 'info' : 'neutral', 'Wallet', (bal === null || bal === undefined ? '—' : bal.toFixed(3)) + ' ◎',
        openReal.length ? openReal.length + ' position(s) open' : 'no live positions', 'var(--amber)');

  // ── live positions (price-enriched) ──
  const open = live.open || [];
  $('postag').textContent = open.length + ' open';
  if (!open.length) {
    $('positions').innerHTML = '<div class="empty">no open positions — next qualifying call opens one</div>';
  } else {
    let px = {};
    try {
      const mints = [...new Set(open.map(p => p.mint))].slice(0, 30);
      const dex = await j('https://api.dexscreener.com/latest/dex/tokens/' + mints.join(','));
      for (const pr of (dex.pairs || [])) {
        const m = pr.baseToken && pr.baseToken.address;
        const v = +((pr.volume||{}).h24) || 0;
        if (m && (!px[m] || v > px[m].v)) px[m] = { p: +pr.priceUsd, v, mc: +pr.marketCap || 0 };
      }
    } catch (e) {}
    $('positions').innerHTML = '<table><thead><tr><th>Task</th><th>Coin</th><th class="num">Now</th>' +
      '<th class="num">Peak</th><th class="num">Stop</th><th class="num">Age</th></tr></thead><tbody>' +
      open.slice(0, 14).map(p => {
        const cur = px[p.mint] ? px[p.mint].p / p.entryPrice : null;
        const stop = p.trailingStopPrice > 0 ? p.trailingStopPrice / p.entryPrice : null;
        const paper = p.taskName.startsWith('📄');
        return '<tr><td>' + (paper ? '<span class="chip inst">paper</span> ' : '<span class="chip live">live</span> ') +
          '<span class="dimc">' + p.taskName.replace('📄 ','').slice(0,22) + '</span></td>' +
          '<td class="sym">$' + p.symbol.slice(0,10) + '</td>' +
          '<td class="num ' + (cur === null ? 'dimc' : cur >= 1 ? 'up' : 'down') + '">' + (cur === null ? '—' : cur.toFixed(2) + '×') + '</td>' +
          '<td class="num warnc">' + p.peakMultiplier.toFixed(2) + '×</td>' +
          '<td class="num dimc">' + (stop === null ? '—' : stop.toFixed(2) + '×') + '</td>' +
          '<td class="num dimc">' + ago(p.entryTime) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // ── recent calls ──
  $('calltag').textContent = cw.length + ' tracked · 24h';
  $('calls').innerHTML = !cw.length ? '<div class="empty">no calls in this window</div>' :
    '<table><thead><tr><th>Coin</th><th class="num">Entry MC</th><th class="num">Peak</th>' +
    '<th class="num">Peak MC</th><th class="num">Called</th></tr></thead><tbody>' +
    cw.slice(0, 12).map(c => {
      const pk = c.peakMultiplier;
      return '<tr><td class="sym">$' + c.symbol.slice(0,12) + '</td>' +
        '<td class="num dimc">' + mc(c.entryMC) + '</td>' +
        '<td class="num ' + (pk >= 2 ? 'up' : pk >= 1.2 ? 'warnc' : 'dimc') + '" style="font-weight:600">' + pk.toFixed(2) + '×</td>' +
        '<td class="num dimc">' + mc(c.peakMC) + '</td>' +
        '<td class="num dimc">' + ago(c.entryTime) + '</td></tr>';
    }).join('') + '</tbody></table>';

  // ── hourly activity ──
  const hd = data.hourlyDist || [];
  const hmax = Math.max(1, ...hd);
  $('hours').innerHTML = hd.map((n,i) => '<div style="height:' + Math.max(3, n/hmax*100) + '%" title="' + i + ':00 — ' + n + ' calls"></div>').join('');

  // ── strategy leaderboard ──
  const top = strat.slice(0, 9);
  const amax = Math.max(0.001, ...top.map(s => Math.abs(s.avgPerTrade)));
  $('strats').innerHTML = !top.length ? '<div class="empty">not enough closed trades yet</div>' :
    '<table><thead><tr><th></th><th>Strategy</th><th>Entry</th><th class="num">n</th>' +
    '<th class="num">Win</th><th class="num">Avg/trade</th></tr></thead><tbody>' +
    top.map((s,i) => {
      const dip = s.strategy.startsWith('Dip');
      const good = s.avgPerTrade >= 0.03;
      const w = Math.abs(s.avgPerTrade) / amax * 100;
      return '<tr><td class="rank">' + (i+1) + '</td>' +
        '<td class="sym" style="font-size:12px">' + s.strategy.replace(/^Dip /,'').slice(0,26) + '</td>' +
        '<td><span class="chip ' + (dip ? 'dip' : 'inst') + '">' + (dip ? s.strategy.match(/−\\d+%/) || 'dip' : 'instant') + '</span></td>' +
        '<td class="num dimc">' + s.trades + '</td>' +
        '<td class="num ' + (s.winPct >= 60 ? 'up' : 'dimc') + '">' + s.winPct + '%</td>' +
        '<td class="num"><span class="bar"><i style="width:' + w + '%;background:' + (good ? 'var(--phos)' : s.avgPerTrade >= 0 ? 'var(--amber)' : 'var(--blood)') + '"></i>' +
        '<span class="' + (good ? 'up' : s.avgPerTrade >= 0 ? 'warnc' : 'down') + '">' + fmtSol(s.avgPerTrade) + '</span></span></td></tr>';
    }).join('') + '</tbody></table>';

  // ── entry timing split ──
  const all = shadow.strategies || [];
  const grp = pred => { const r = all.filter(pred); const n = r.reduce((s,x) => s+x.trades, 0);
    return { n, avg: n ? r.reduce((s,x) => s+x.pnlSol, 0)/n : 0 }; };
  const dipG = grp(s => s.strategy.startsWith('Dip') && s.trades > 0);
  const instG = grp(s => !s.strategy.startsWith('Dip') && s.trades > 0);
  $('entrysplit').innerHTML =
    '<div><div class="h">Wait for a −20% dip</div><div class="v ' + (dipG.avg >= 0 ? 'up' : 'down') + '">' + fmtSol(dipG.avg) + '</div>' +
      '<div class="n">per trade · ' + dipG.n + ' trades</div></div>' +
    '<div><div class="h">Buy the call instantly</div><div class="v ' + (instG.avg >= 0 ? 'up' : 'down') + '">' + fmtSol(instG.avg) + '</div>' +
      '<div class="n">per trade · ' + instG.n + ' trades</div></div>';
  const edge = dipG.avg - instG.avg;
  $('entrynote').innerHTML = dipG.n < 20 || instG.n < 20 ? 'Gathering data — both groups need 20+ trades to compare.' :
    'Waiting for the pullback is worth <b class="' + (edge >= 0 ? 'up' : 'down') + '">' + fmtSol(edge) + ' SOL per trade</b>. ' +
    'Every call in the sample dipped ≥20% below the call price within 30 minutes.';

  // ── skip reasons ──
  const by = (skipped && skipped.byReason) || {};
  const keys = Object.keys(by).sort((a,b) => by[b]-by[a]);
  const smax = Math.max(1, ...keys.map(k => by[k]));
  const colors = { LOW_VOL:'var(--ice)', BUNDLED:'var(--blood)', LOW_LIQ:'var(--amber)', DUMP:'var(--violet)',
    HEAVY_SELLING:'var(--amber)', COOLING_OFF:'var(--dim)', LOW_ACTIVITY:'var(--dim)', LOW_FEES:'var(--dim)',
    RATE_CAP:'var(--violet)', FADED:'var(--amber)' };
  $('skips').innerHTML = !keys.length ? '<div class="empty">no rejections recorded yet</div>' :
    keys.map(k => '<div class="skip"><span class="dimc">' + k.replace(/_/g,' ').toLowerCase() + '</span>' +
      '<span class="track"><span class="fill" style="width:' + (by[k]/smax*100) + '%;background:' + (colors[k]||'var(--dim)') + '"></span></span>' +
      '<span class="num">' + by[k] + '</span></div>').join('');
}

paint();
setInterval(paint, 20000);
</script>
</body>
</html>`;
}
