/* =====================================================================
 * Trader — Strategy Engine (proven, non-gimmick day/swing logic)
 * Pure functions only. Runs in the browser (<script src>) AND in Node
 * (require) so the math can be unit-tested. No DOM, no network here.
 * =====================================================================
 *
 * Design philosophy (what actually has an edge, per published research):
 *   - Trade WITH the trend (Hurst/Jegadeesh-Titman momentum).
 *   - Buy strength on relative-strength leaders, or buy controlled
 *     pullbacks inside an uptrend (Connors/Linda Raschke style).
 *   - Size by RISK, not by gut: fixed-fractional 1% risk per trade.
 *   - Stops and targets defined by volatility (ATR), never arbitrary.
 *   - Avoid over-extended names (blow-off RSI) and downtrends.
 * No strategy wins "most of the time" on every trade; the edge is a
 * positive expectancy across many trades with disciplined risk.
 * ===================================================================== */

(function (root) {
  'use strict';

  // ---------- basic series helpers ----------
  const num = (x) => (x === null || x === undefined || isNaN(x) ? null : +x);

  function sma(values, period, endIdx) {
    endIdx = endIdx === undefined ? values.length - 1 : endIdx;
    if (endIdx - period + 1 < 0) return null;
    let s = 0;
    for (let i = endIdx - period + 1; i <= endIdx; i++) s += values[i];
    return s / period;
  }

  function ema(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    // seed with SMA of first `period`
    let e = 0;
    for (let i = 0; i < period; i++) e += values[i];
    e /= period;
    for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
    return e;
  }

  // Wilder's RSI
  function rsi(closes, period) {
    period = period || 14;
    if (closes.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch >= 0) gain += ch; else loss -= ch;
    }
    let avgG = gain / period, avgL = loss / period;
    for (let i = period + 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      const g = ch > 0 ? ch : 0;
      const l = ch < 0 ? -ch : 0;
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
    }
    if (avgL === 0) return 100;
    const rs = avgG / avgL;
    return 100 - 100 / (1 + rs);
  }

  // Wilder's ATR from OHLC bars [{h,l,c}]
  function atr(bars, period) {
    period = period || 14;
    if (bars.length < period + 1) return null;
    const tr = [];
    for (let i = 1; i < bars.length; i++) {
      const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    // seed
    let a = 0;
    for (let i = 0; i < period; i++) a += tr[i];
    a /= period;
    for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
    return a;
  }

  function highest(values, period, endIdx) {
    endIdx = endIdx === undefined ? values.length - 1 : endIdx;
    if (endIdx - period + 1 < 0) return null;
    let m = -Infinity;
    for (let i = endIdx - period + 1; i <= endIdx; i++) m = Math.max(m, values[i]);
    return m;
  }
  function lowest(values, period, endIdx) {
    endIdx = endIdx === undefined ? values.length - 1 : endIdx;
    if (endIdx - period + 1 < 0) return null;
    let m = Infinity;
    for (let i = endIdx - period + 1; i <= endIdx; i++) m = Math.min(m, values[i]);
    return m;
  }

  function pctReturn(closes, lookback) {
    const n = closes.length;
    if (n < lookback + 1) return null;
    const a = closes[n - 1 - lookback], b = closes[n - 1];
    if (!a) return null;
    return (b / a - 1) * 100;
  }

  // ---------- analysis: turn a bar series into metrics ----------
  // bars: ascending array of {date,o,h,l,c,v}
  function analyze(bars) {
    if (!bars || bars.length < 60) return null;
    const closes = bars.map((b) => b.c);
    const vols = bars.map((b) => b.v || 0);
    const n = closes.length;
    const price = closes[n - 1];

    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const sma200 = closes.length >= 200 ? sma(closes, 200) : sma(closes, Math.min(150, n));
    const sma20prev = sma(closes, 20, n - 6); // 5 bars ago -> slope
    const rsi14 = rsi(closes, 14);
    const atr14 = atr(bars, 14);
    const atrPct = atr14 ? (atr14 / price) * 100 : null;
    const hi20 = highest(closes, 20, n - 2);   // prior 20-day high (excl today)
    const lo20 = lowest(closes, 20, n - 2);
    const hi55 = highest(closes, 55, n - 2);
    const avgVol20 = sma(vols, 20);
    const volRatio = avgVol20 ? vols[n - 1] / avgVol20 : null;

    const ret1 = pctReturn(closes, 1);
    const ret5 = pctReturn(closes, 5);
    const ret20 = pctReturn(closes, 20);
    const ret63 = pctReturn(closes, 63);   // ~3 months (relative strength)
    const ret126 = pctReturn(closes, 126); // ~6 months

    const sma20Slope = sma20 && sma20prev ? (sma20 - sma20prev) / sma20prev * 100 : null;
    const distFrom20ATR = atr14 ? (price - sma20) / atr14 : null; // + above, - below

    const uptrend = sma50 != null && sma200 != null && price > sma50 && sma50 > sma200;
    const downtrend = sma50 != null && sma200 != null && price < sma50 && sma50 < sma200;

    return {
      price, sma20, sma50, sma200, sma20Slope,
      rsi14, atr14, atrPct, hi20, lo20, hi55,
      volRatio, avgVol20,
      ret1, ret5, ret20, ret63, ret126,
      distFrom20ATR, uptrend, downtrend,
      lastDate: bars[n - 1].date,
    };
  }

  // ---------- position sizing: fixed-fractional risk ----------
  // riskPct e.g. 1 = risk 1% of capital on the trade.
  function sizePosition(entry, stop, capital, riskPct) {
    const riskAmt = capital * (riskPct / 100);
    const perShare = Math.abs(entry - stop);
    if (perShare <= 0) return null;
    const shares = Math.floor(riskAmt / perShare);
    const posValue = shares * entry;
    return {
      riskAmt: round(riskAmt, 2),
      perShare: round(perShare, 4),
      shares,
      posValue: round(posValue, 2),
      posPct: round((posValue / capital) * 100, 1),
    };
  }

  function round(x, d) {
    if (x == null) return null;
    const p = Math.pow(10, d || 2);
    return Math.round(x * p) / p;
  }

  // ---------- the signal model ----------
  // Returns a graded decision for one symbol.
  // cfg: { riskPct, capital, atrStopMult, targetR }
  function evaluate(m, cfg) {
    cfg = cfg || {};
    const riskPct = cfg.riskPct != null ? cfg.riskPct : 1;     // moderate
    const capital = cfg.capital != null ? cfg.capital : 10000;
    const atrStopMult = cfg.atrStopMult != null ? cfg.atrStopMult : 1.5;
    const targetR = cfg.targetR != null ? cfg.targetR : 2;      // 2R target

    if (!m) return null;
    const reasons = [];
    let score = 0;
    let side = 'NEUTRAL';
    let setup = '';

    // ---- relative-strength / momentum component (max ~35) ----
    if (m.ret63 != null) {
      const rsPts = clamp(m.ret63, -20, 25);   // 3-month momentum
      score += rsPts;
      if (m.ret63 > 5) reasons.push(`3-mo momentum +${m.ret63.toFixed(1)}%`);
    }
    if (m.ret20 != null && m.ret20 > 0) score += clamp(m.ret20 * 0.4, 0, 8);

    // ---- trend component (max ~25) ----
    if (m.uptrend) {
      score += 18;
      reasons.push('Uptrend (price > SMA50 > SMA200)');
      if (m.sma20Slope > 0) { score += 5; }
    } else if (m.downtrend) {
      score -= 22;
      reasons.push('Downtrend (price < SMA50 < SMA200)');
    } else {
      score -= 4;
    }

    // ---- volume confirmation (max ~8) ----
    if (m.volRatio != null) {
      if (m.volRatio > 1.5) { score += 8; reasons.push(`Volume surge ${m.volRatio.toFixed(1)}x avg`); }
      else if (m.volRatio > 1.1) score += 3;
      else if (m.volRatio < 0.6) score -= 2;
    }

    // ---- volatility sanity (penalize extreme chop) ----
    if (m.atrPct != null && m.atrPct > 6) { score -= 6; reasons.push(`High volatility ${m.atrPct.toFixed(1)}% ATR`); }

    // ---- setup detection (defines entry style) ----
    const nearBreakout = m.hi20 != null && m.price >= m.hi20 * 0.998;
    const pullbackOk = m.uptrend && m.rsi14 != null && m.rsi14 >= 38 && m.rsi14 <= 58 &&
                       m.distFrom20ATR != null && m.distFrom20ATR > -1.2 && m.distFrom20ATR < 0.6;
    const overextended = m.rsi14 != null && m.rsi14 > 78;
    const breakdown = m.lo20 != null && m.price <= m.lo20 * 1.002;

    // ---- decide side ----
    if (m.uptrend && !overextended && (nearBreakout || pullbackOk)) {
      side = 'BUY';
      setup = nearBreakout ? 'Breakout / 20-day high' : 'Pullback in uptrend';
      if (nearBreakout) { score += 10; reasons.push('Breaking 20-day high'); }
      if (pullbackOk) { score += 8; reasons.push('Healthy pullback to rising SMA20'); }
    } else if (overextended) {
      side = 'AVOID';
      setup = 'Over-extended (blow-off risk)';
      reasons.push(`RSI ${m.rsi14.toFixed(0)} — over-extended, wait for pullback`);
      score -= 8;
    } else if (m.downtrend || breakdown) {
      side = 'AVOID';
      setup = breakdown ? 'Breaking down (20-day low)' : 'Downtrend — exit/avoid longs';
      if (breakdown) reasons.push('Breaking 20-day low');
    } else {
      side = 'NEUTRAL';
      setup = 'No clean setup — stand aside';
    }

    // ---- build trade plan for BUY ----
    let plan = null;
    if (side === 'BUY' && m.atr14) {
      const entry = round(m.price, 2);
      const stop = round(entry - atrStopMult * m.atr14, 2);
      const risk = entry - stop;
      const target = round(entry + targetR * risk, 2);
      const sizing = sizePosition(entry, stop, capital, riskPct);
      plan = {
        entry, stop, target,
        rr: targetR,
        stopPct: round((risk / entry) * 100, 2),
        targetPct: round(((target - entry) / entry) * 100, 2),
        sizing,
      };
    }

    return {
      side, setup,
      score: round(score, 1),
      reasons,
      rsi14: round(m.rsi14, 1),
      atrPct: round(m.atrPct, 2),
      ret20: round(m.ret20, 1),
      ret63: round(m.ret63, 1),
      volRatio: round(m.volRatio, 2),
      price: round(m.price, 2),
      plan,
      metrics: m,
    };
  }

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  // ---------- intraday trigger state machine (pure) ----------
  // Decide what (if anything) just triggered for one monitored name.
  //   plan   : {entry,stop,target,...}
  //   price  : current live price
  //   changePct: intraday % change (or null)
  //   ctx    : { state, fired:{entry,stop,tgt,mover}, marketOpen, moverPct, uptrend }
  // Returns { event: null|'STOP'|'TARGET'|'ENTRY'|'MOVER', state: <newState> }
  // Priority: STOP > TARGET > ENTRY > MOVER. Each event fires once (guarded by `fired`).
  function triggerCheck(plan, price, changePct, ctx) {
    ctx = ctx || {};
    const fired = ctx.fired || {};
    let state = ctx.state || 'armed';
    if (price == null || !plan) return { event: null, state };

    if (price <= plan.stop && !fired.stop) return { event: 'STOP', state: 'stop' };
    if (price >= plan.target && !fired.tgt) return { event: 'TARGET', state: 'tgt' };
    if (state === 'armed' && ctx.marketOpen && !fired.entry &&
        price >= plan.entry && price <= plan.entry * 1.02) {
      return { event: 'ENTRY', state: 'trig' };
    }
    const thr = ctx.moverPct != null ? ctx.moverPct : 3;
    if (changePct != null && Math.abs(changePct) >= thr && ctx.uptrend && !fired.mover) {
      return { event: 'MOVER', state };
    }
    return { event: null, state };
  }

  // ---------- public API ----------
  const Engine = {
    sma, ema, rsi, atr, highest, lowest, pctReturn,
    analyze, evaluate, sizePosition, round, clamp, triggerCheck,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : this);
