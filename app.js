/* =====================================================================
 * Trader — app layer: data fetching, scan orchestration, UI, PWA glue.
 * Uses Engine (engine.js) for all math. Runs fully client-side; data is
 * fetched from the user's own browser via Twelve Data (free key) or a
 * built-in DEMO generator so the app works before a key is added.
 * ===================================================================== */
'use strict';

const $ = (id) => document.getElementById(id);
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};

const DEFAULT_UNIVERSE = [
  // US — most liquid large caps (also tradable on Trade Republic)
  ['AAPL','XNAS','Apple'], ['MSFT','XNAS','Microsoft'], ['NVDA','XNAS','NVIDIA'],
  ['AMZN','XNAS','Amazon'], ['GOOGL','XNAS','Alphabet'], ['META','XNAS','Meta'],
  ['TSLA','XNAS','Tesla'], ['AMD','XNAS','AMD'], ['AVGO','XNAS','Broadcom'],
  ['NFLX','XNAS','Netflix'], ['JPM','XNYS','JPMorgan'], ['V','XNYS','Visa'],
  // Germany — Xetra
  ['SAP','XETR','SAP'], ['SIE','XETR','Siemens'], ['ALV','XETR','Allianz'],
  ['DTE','XETR','Dt. Telekom'], ['MBG','XETR','Mercedes-Benz'], ['BMW','XETR','BMW'],
  ['RHM','XETR','Rheinmetall'], ['ADS','XETR','Adidas'], ['BAS','XETR','BASF'],
  // Rest of EU
  ['ASML','XAMS','ASML'], ['MC','XPAR','LVMH'], ['OR','XPAR','L’Oréal'],
  ['TTE','XPAR','TotalEnergies'], ['AIR','XPAR','Airbus'],
];

const CFG = {
  get capital() { return +LS.get('cfg.capital', 10000); },
  get riskPct() { return +LS.get('cfg.riskPct', 1); },
  get apiKey() { return LS.get('cfg.apiKey', '') || ''; },
  get universe() { return LS.get('cfg.universe', DEFAULT_UNIVERSE); },
  get pollMin() { return Math.max(1, +LS.get('cfg.pollMin', 5)); },
  get moverPct() { return +LS.get('cfg.moverPct', 3); },
};

const today = () => new Date().toISOString().slice(0, 10);

/* ---------------- market hours (EU Xetra + US NYSE) ---------------- */
function exchangeNow(tz) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => p.find((x) => x.type === t).value;
  const wd = get('weekday');
  const mins = (+get('hour')) * 60 + (+get('minute'));
  const weekend = (wd === 'Sat' || wd === 'Sun');
  return { mins, weekend };
}
function marketStatus() {
  const eu = exchangeNow('Europe/Berlin');   // Xetra 09:00–17:30
  const us = exchangeNow('America/New_York'); // NYSE 09:30–16:00
  const euOpen = !eu.weekend && eu.mins >= 540 && eu.mins < 1050;
  const usOpen = !us.weekend && us.mins >= 570 && us.mins < 960;
  let label;
  if (euOpen && usOpen) label = 'EU + US open';
  else if (euOpen) label = 'EU open · US closed';
  else if (usOpen) label = 'US open · EU closed';
  else {
    // pre-market hint
    const euPre = !eu.weekend && eu.mins < 540;
    label = euPre ? 'Pre-market (EU opens 09:00 CET)' : 'Markets closed';
  }
  return { euOpen, usOpen, anyOpen: euOpen || usOpen, label };
}

/* ---------------- data layer ---------------- */
async function fetchDaily(sym, mic, key) {
  const cacheKey = `bars:${sym}.${mic}:${today()}`;
  const cached = LS.get(cacheKey, null);
  if (cached) return cached;

  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}` +
    `&mic_code=${encodeURIComponent(mic)}&interval=1day&outputsize=220&order=ASC&apikey=${encodeURIComponent(key)}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.status === 'error' || !j.values) {
    throw new Error(j.message || ('No data for ' + sym));
  }
  const bars = j.values.map((v) => ({
    date: v.datetime,
    o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +(v.volume || 0),
  })).filter((b) => b.c > 0);
  LS.set(cacheKey, bars);
  return bars;
}

// Deterministic demo bars (seeded by symbol) so the app shows realistic
// cards with NO api key. Clearly labelled DEMO in the UI.
function demoBars(sym) {
  let seed = 0; for (const c of sym) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const drift = (rnd() - 0.45) * 0.0016;       // per-symbol trend bias
  const vol = 0.008 + rnd() * 0.02;
  let p = 40 + rnd() * 360;
  const bars = [];
  for (let i = 0; i < 220; i++) {
    const shock = (rnd() - 0.5) * 2 * vol;
    p = Math.max(1, p * (1 + drift + shock));
    const hi = p * (1 + Math.abs(rnd() * vol));
    const lo = p * (1 - Math.abs(rnd() * vol));
    bars.push({ date: 'demo' + i, o: p, h: hi, l: lo, c: p, v: 5e5 * (0.6 + rnd() * 1.4) });
  }
  return bars;
}

/* ---------------- scan ---------------- */
let scanning = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runScan() {
  if (scanning) return;
  scanning = true;
  const key = CFG.apiKey;
  const demo = !key;
  const univ = CFG.universe;
  const cfg = { capital: CFG.capital, riskPct: CFG.riskPct };
  const prog = $('prog'); prog.classList.add('show');
  const bar = prog.querySelector('i');
  $('scanBtn').disabled = true; $('scanBtn').textContent = 'Scanning…';

  const results = [];
  for (let i = 0; i < univ.length; i++) {
    const [sym, mic, name] = univ[i];
    bar.style.width = Math.round(((i + 1) / univ.length) * 100) + '%';
    try {
      const bars = demo ? demoBars(sym) : await fetchDaily(sym, mic, key);
      const m = Engine.analyze(bars);
      if (!m) continue;
      const dec = Engine.evaluate(m, cfg);
      dec.sym = sym; dec.mic = mic; dec.name = name;
      results.push(dec);
    } catch (e) {
      results.push({ sym, mic, name, side: 'ERR', setup: e.message, score: -999, reasons: [] });
    }
    // rate-limit live calls: free tier = 8/min -> ~8s spacing
    if (!demo && i < univ.length - 1) await sleep(8000);
  }

  results.sort((a, b) => b.score - a.score);
  const payload = { date: today(), at: Date.now(), demo, results };
  LS.set('lastScan', payload);
  render(payload);

  prog.classList.remove('show'); bar.style.width = '0';
  $('scanBtn').disabled = false; $('scanBtn').textContent = '↻ Run morning scan';
  scanning = false;
  toast(demo ? 'Demo scan complete — add an API key for live data' : 'Live scan complete');
}

/* ---------------- render ---------------- */
function fmt(x, d) { return x == null ? '—' : (+x).toLocaleString(undefined, { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }

function card(d) {
  const cls = d.side === 'BUY' ? 'buy' : d.side === 'AVOID' ? 'avoid' : 'neutral';
  let plan = '';
  if (d.plan) {
    const s = d.plan.sizing || {};
    plan = `<div class="plan">
      <div><div class="k">Entry</div><div class="v">${fmt(d.plan.entry,2)}</div></div>
      <div><div class="k">Stop</div><div class="v red">${fmt(d.plan.stop,2)}<span style="font-size:10px"> -${d.plan.stopPct}%</span></div></div>
      <div><div class="k">Target</div><div class="v green">${fmt(d.plan.target,2)}<span style="font-size:10px"> +${d.plan.targetPct}%</span></div></div>
      <div><div class="k">Size</div><div class="v">${fmt(s.shares,0)} sh</div></div>
    </div>
    <div class="metrics">
      <span>Position €${fmt(s.posValue,0)} (${s.posPct}% of cap)</span>
      <span>Risk €${fmt(s.riskAmt,0)}</span>
      <span>R:R 1:${d.plan.rr}</span>
    </div>`;
  }
  const reasons = (d.reasons || []).map((r) => `<span>${r}</span>`).join('');
  const metrics = d.side === 'ERR' ? '' : `<div class="metrics">
    <span>RSI ${d.rsi14 ?? '—'}</span>
    <span>ATR ${d.atrPct ?? '—'}%</span>
    <span>20d ${d.ret20 >= 0 ? '+' : ''}${d.ret20 ?? '—'}%</span>
    <span>3mo ${d.ret63 >= 0 ? '+' : ''}${d.ret63 ?? '—'}%</span>
    <span>Vol ${d.volRatio ?? '—'}x</span>
    <span>Score ${d.score}</span>
  </div>`;
  const tag = d.side === 'ERR' ? `<span class="tag avoid">ERROR</span>` :
    `<span class="tag ${cls}">${d.side}</span>`;
  return `<div class="card ${cls}">
    <div class="row1">
      <div class="sym">${d.sym}<span class="exch">${d.name || ''} · ${d.mic}</span></div>
      <div>${d.side !== 'ERR' ? `<span class="px">${fmt(d.price,2)}</span> ` : ''}${tag}</div>
    </div>
    <div class="setup">${d.setup || ''}</div>
    ${plan}
    <div class="reasons">${reasons}</div>
    ${metrics}
  </div>`;
}

function render(payload) {
  const res = payload.results || [];
  const buys = res.filter((d) => d.side === 'BUY');
  const avoids = res.filter((d) => d.side === 'AVOID' || d.side === 'ERR');
  $('buyList').innerHTML = buys.length ? buys.map(card).join('') :
    `<div class="empty">No clean buy setups today — that's a valid answer. Standing aside beats forcing trades.</div>`;
  $('avoidList').innerHTML = avoids.length ? avoids.map(card).join('') :
    `<div class="empty">Nothing flagged to avoid.</div>`;
  $('buyCount').textContent = buys.length;
  $('avoidCount').textContent = avoids.length;

  const when = new Date(payload.at);
  $('srcLbl').textContent = (payload.demo ? '⚠ DEMO data' : 'Live data') +
    ' · scanned ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ---------------- header / status ---------------- */
function paintStatus() {
  const ms = marketStatus();
  const dot = $('mktDot');
  dot.className = 'dot ' + (ms.anyOpen ? 'open' : 'closed');
  $('mktStatus').textContent = ms.label;
  $('dateLbl').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  $('capLbl').textContent = 'Capital €' + fmt(CFG.capital, 0) + ' · ' + CFG.riskPct + '% risk';
}

/* ---------------- settings ---------------- */
function openSettings() {
  $('capInput').value = CFG.capital;
  $('riskInput').value = CFG.riskPct;
  $('pollInput').value = CFG.pollMin;
  $('moverInput').value = CFG.moverPct;
  $('keyInput').value = CFG.apiKey;
  $('univInput').value = CFG.universe.map((u) => u.join(',')).join('\n');
  $('settingsDlg').showModal();
}
function saveSettings() {
  LS.set('cfg.capital', +$('capInput').value || 10000);
  LS.set('cfg.riskPct', +$('riskInput').value || 1);
  LS.set('cfg.pollMin', Math.max(1, +$('pollInput').value || 5));
  LS.set('cfg.moverPct', +$('moverInput').value || 3);
  LS.set('cfg.apiKey', $('keyInput').value.trim());
  const lines = $('univInput').value.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(',').map((x) => x.trim())).filter((a) => a.length >= 2);
  if (lines.length) LS.set('cfg.universe', lines.map((a) => [a[0], a[1], a[2] || a[0]]));
  $('settingsDlg').close();
  paintStatus();
  toast('Saved');
}

/* ---------------- notifications (best-effort, on-device) ---------------- */
async function setupAlerts() {
  if (!('Notification' in window)) { toast('Notifications not supported on this browser'); return; }
  let perm = Notification.permission;
  if (perm !== 'granted') perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications blocked — enable in browser settings'); return; }
  LS.set('alerts.on', true);
  toast('Morning alerts on (08:15 CET, while app installed)');
  scheduleDailyCheck();
}
function scheduleDailyCheck() {
  if (!LS.get('alerts.on', false)) return;
  // Fire a reminder around the EU pre-open if not already scanned today.
  setInterval(() => {
    const eu = exchangeNow('Europe/Berlin');
    const last = LS.get('lastScan', null);
    const scannedToday = last && last.date === today();
    if (!eu.weekend && eu.mins >= 495 && eu.mins <= 540 && !scannedToday &&
        Notification.permission === 'granted' && !LS.get('notified:' + today(), false)) {
      LS.set('notified:' + today(), true);
      new Notification('Trader — morning scan', { body: 'Open to get today’s buy/sell signals before the open.', icon: 'icon.svg' });
    }
  }, 60 * 1000);
}

/* =====================================================================
 * INTRADAY LIVE MONITOR
 * While the app is open during market hours, polls live quotes for the
 * monitored set (morning BUY candidates by default) and fires an alert the
 * moment a setup TRIGGERS, a STOP is hit, a TARGET is reached, or a name
 * makes a big intraday move. State is per-symbol-per-day so each alert
 * fires once. Designed to stay inside the free API tier.
 * ===================================================================== */
const Live = {
  on: false, timer: null, quotes: {}, lastPoll: 0,

  // which symbols to watch: morning BUY candidates + any with a saved plan
  watchSet() {
    const last = LS.get('lastScan', null);
    if (!last) return [];
    return last.results
      .filter((d) => d.side === 'BUY' && d.plan)
      .map((d) => ({ sym: d.sym, mic: d.mic, name: d.name, plan: d.plan, metrics: d.metrics, setup: d.setup }));
  },

  async start() {
    if (this.on) return this.stop();
    const watch = this.watchSet();
    if (!watch.length) { toast('Run a morning scan first — nothing to monitor'); return; }
    this.on = true;
    $('liveWrap').style.display = '';
    $('liveBtn').textContent = '■ Stop monitor';
    $('liveBtn').classList.add('primary');
    $('liveState').textContent = 'live';
    await this.poll();
    const ms = CFG.pollMin * 60 * 1000;
    this.timer = setInterval(() => this.poll(), ms);
  },

  stop() {
    this.on = false;
    clearInterval(this.timer); this.timer = null;
    $('liveBtn').textContent = '▶ Live monitor';
    $('liveBtn').classList.remove('primary');
    $('liveState').textContent = 'off';
  },

  async poll() {
    const watch = this.watchSet();
    if (!watch.length) return;
    const key = CFG.apiKey;
    const demo = !key;
    const ms = marketStatus();
    try {
      const q = demo ? this.demoQuotes(watch) : await fetchQuotes(watch, key);
      this.quotes = q;
      for (const w of watch) this.checkTriggers(w, q[w.sym], ms);
      this.lastPoll = Date.now();
      $('liveMeta').textContent =
        (demo ? 'SIMULATED' : 'live') + ' · ' + (ms.anyOpen ? ms.label : 'market closed') +
        ' · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      $('liveMeta').textContent = 'error: ' + e.message;
    }
    this.render(watch);
  },

  // fire-once-per-day alert bookkeeping
  fired(symKey) { return LS.get('fired:' + today() + ':' + symKey, false); },
  markFired(symKey) { LS.set('fired:' + today() + ':' + symKey, true); },

  checkTriggers(w, qt, ms) {
    if (!qt || qt.price == null) return;
    const p = qt.price, plan = w.plan;
    const ctx = {
      state: LS.get('lstat:' + today() + ':' + w.sym, 'armed'),
      fired: {
        entry: this.fired(w.sym + ':entry'), stop: this.fired(w.sym + ':stop'),
        tgt: this.fired(w.sym + ':tgt'), mover: this.fired(w.sym + ':mover'),
      },
      marketOpen: ms.anyOpen,
      moverPct: CFG.moverPct,
      uptrend: !!(w.metrics && w.metrics.uptrend),
    };
    const r = Engine.triggerCheck(plan, p, qt.changePct, ctx);
    if (!r.event) return;
    LS.set('lstat:' + today() + ':' + w.sym, r.state);
    if (r.event === 'STOP') {
      this.markFired(w.sym + ':stop');
      this.alert(`🛑 ${w.sym} STOP hit`, `Price ${p} ≤ stop ${plan.stop}. Exit if holding.`);
    } else if (r.event === 'TARGET') {
      this.markFired(w.sym + ':tgt');
      this.alert(`🎯 ${w.sym} TARGET reached`, `Price ${p} ≥ target ${plan.target}. Take profit or trail your stop.`);
    } else if (r.event === 'ENTRY') {
      this.markFired(w.sym + ':entry');
      this.alert(`✅ ${w.sym} ENTRY triggered (${w.setup || 'setup'})`,
        `Now ${p}. Buy ${plan.sizing.shares} sh · stop ${plan.stop} · target ${plan.target} · risk €${plan.sizing.riskAmt}.`);
    } else if (r.event === 'MOVER') {
      this.markFired(w.sym + ':mover');
      this.alert(`⚡ ${w.sym} moving ${qt.changePct > 0 ? '+' : ''}${qt.changePct.toFixed(1)}%`,
        `Intraday momentum in an uptrend — watch for continuation.`);
    }
  },

  alert(title, body) {
    toast(title);
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body, icon: 'icon.svg', tag: title }); } catch (e) {}
    }
  },

  // demo: random-walk each plan's entry so the gauge/alerts animate
  demoQuotes(watch) {
    const q = {};
    for (const w of watch) {
      const base = LS.get('demoq:' + w.sym, w.plan.entry);
      const drift = (Math.random() - 0.48) * 0.012;
      const np = Math.max(0.01, base * (1 + drift));
      LS.set('demoq:' + w.sym, np);
      q[w.sym] = { price: +np.toFixed(2), changePct: +((np / w.plan.entry - 1) * 100).toFixed(2) };
    }
    return q;
  },

  render(watch) {
    $('liveList').innerHTML = watch.map((w) => {
      const qt = this.quotes[w.sym] || {};
      const p = qt.price, plan = w.plan;
      const st = LS.get('lstat:' + today() + ':' + w.sym, 'armed');
      const lo = plan.stop, hi = plan.target;
      const pct = p == null ? 0 : Math.max(0, Math.min(1, (p - lo) / (hi - lo)));
      const entryPct = Math.max(0, Math.min(1, (plan.entry - lo) / (hi - lo)));
      const up = (qt.changePct || 0) >= 0;
      const stLabel = { armed: 'ARMED', trig: 'TRIGGERED', stop: 'STOP HIT', tgt: 'TARGET' }[st] || 'ARMED';
      const stCls = { armed: 'armed', trig: 'trig', stop: 'stop', tgt: 'tgt' }[st] || 'armed';
      return `<div class="card buy">
        <div class="row1"><div class="sym">${w.sym}<span class="exch">${w.name} · ${w.mic}</span></div>
          <span class="lstat ${stCls}">${stLabel}</span></div>
        <div class="live">
          <div class="lpx">${p == null ? '—' : fmt(p, 2)}</div>
          <div class="chg ${up ? 'up' : 'down'}">${qt.changePct == null ? '' : (up ? '+' : '') + qt.changePct + '%'}</div>
          <div class="gauge">
            <div class="seg" style="left:0;width:${entryPct * 100}%;background:rgba(255,92,108,.10)"></div>
            <div class="seg" style="left:${entryPct * 100}%;right:0;background:rgba(31,209,122,.10)"></div>
            <div class="mark" style="left:${entryPct * 100}%"></div>
            <div class="mark" style="left:${pct * 100}%;background:${up ? 'var(--buy)' : 'var(--avoid)'};width:3px"></div>
            <div class="lab" style="left:2px">stop ${fmt(plan.stop, 2)}</div>
            <div class="lab" style="right:2px">tgt ${fmt(plan.target, 2)}</div>
          </div>
        </div>
        <div class="metrics"><span>entry ${fmt(plan.entry, 2)}</span><span>${plan.sizing.shares} sh</span>
          <span>risk €${fmt(plan.sizing.riskAmt, 0)}</span><span>R:R 1:${plan.rr}</span></div>
      </div>`;
    }).join('');
  },
};

// Fetch live quotes grouped by MIC to minimise requests. Returns {SYM:{price,changePct}}
async function fetchQuotes(watch, key) {
  const byMic = {};
  for (const w of watch) (byMic[w.mic] = byMic[w.mic] || []).push(w.sym);
  const out = {};
  for (const mic of Object.keys(byMic)) {
    const syms = byMic[mic].join(',');
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(syms)}` +
      `&mic_code=${encodeURIComponent(mic)}&apikey=${encodeURIComponent(key)}`;
    const r = await fetch(url);
    const j = await r.json();
    const rows = (byMic[mic].length === 1) ? { [byMic[mic][0]]: j } : j;
    for (const sym of byMic[mic]) {
      const d = rows[sym];
      if (d && d.close != null) {
        out[sym] = { price: +d.close, changePct: d.percent_change != null ? +d.percent_change : null };
      }
    }
    await sleep(400); // be gentle with rate limit
  }
  return out;
}

/* ---------------- misc ---------------- */
let toastT;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------- boot ---------------- */
function boot() {
  paintStatus();
  setInterval(paintStatus, 60 * 1000);
  $('scanBtn').onclick = runScan;
  $('settingsBtn').onclick = openSettings;
  $('saveSettings').onclick = saveSettings;
  $('resetUniv').onclick = () => { $('univInput').value = DEFAULT_UNIVERSE.map((u) => u.join(',')).join('\n'); };
  $('notifyBtn').onclick = setupAlerts;
  $('liveBtn').onclick = () => Live.start();

  const last = LS.get('lastScan', null);
  if (last) render(last);
  scheduleDailyCheck();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
document.addEventListener('DOMContentLoaded', boot);
