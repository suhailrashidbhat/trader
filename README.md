# Trader — Morning Day-Trading Signals (PWA)

A self-contained web app (installable on your iPhone) that scans an EU + US stock
universe each morning and produces a ranked **buy / avoid** watchlist with exact
**entry, stop, target, and position size** — sized to risk a fixed % of your capital.
Everything runs on your device. No server, no account, no auto-trading.

## Why this design
- **Trade Republic has no public API**, so the app can't read your portfolio or place
  orders. It's a research/signal tool — *you* place every trade manually.
- The data sandbox is locked down, so a "background server that emails you" isn't
  reliable. A client-side PWA fetches data from your own browser and never breaks.

## The strategy (proven, not gimmick)
For each stock it computes SMA 20/50/200, RSI(14), ATR(14), relative strength
(1- and 3-month returns), and volume vs 20-day average, then:
- **BUY** only in a confirmed uptrend (price > SMA50 > SMA200) on either a
  **breakout** (new 20-day high on volume) or a **healthy pullback** to the rising
  SMA20 (RSI ~40–58). Over-extended names (RSI > 78) are *not* chased.
- **AVOID / EXIT** for downtrends or 20-day breakdowns.
- **Risk sizing**: stop = entry − 1.5×ATR, target = 2R, shares chosen so the loss at
  the stop equals **1% of your capital** (moderate). This is the part most retail
  traders skip — and it's what keeps you alive.

> No strategy wins most individual trades. The edge is positive expectancy across
> many trades with strict risk control. Most active retail day traders lose money.
> This is **not financial advice**. Use the stop, every time.

## Setup (2 minutes)
1. **Get a free data key** at https://twelvedata.com/pricing (free tier: 8 calls/min,
   800/day — plenty for a daily scan).
2. Open the app, tap **⚙ Settings**, paste the key, set your **capital** and **risk %**,
   adjust the **universe** if you like, **Save**.
3. Tap **↻ Run morning scan**. With no key it runs in **DEMO** mode so you can see it work.

## Intraday live monitor (real-time triggers)
Tap **▶ Live monitor** after a morning scan. While the app is open during market
hours it polls live quotes for the day's BUY candidates and fires an instant alert
(toast + notification) the moment something happens:
- **✅ ENTRY triggered** — price confirms at/above the planned entry (won't chase >2% past it).
- **🛑 STOP hit** — price hits your stop; exit if holding.
- **🎯 TARGET reached** — price hits the 2R target; take profit or trail.
- **⚡ Big mover** — an uptrend name moves more than your threshold (default 3%) intraday.

Each alert fires once per day. A live gauge shows where price sits between stop and
target. Poll interval and mover threshold are in **Settings** (keep poll ≥ 5 min to
stay inside the free API tier — it watches only the BUY shortlist, ~hundreds of calls/day).

> The monitor runs while the app is open/installed and in the foreground. A pure
> client-side app can't poll with the app fully closed — that needs the hosted
> backend in the roadmap below.

## Install on iPhone (home-screen app + alerts)
The app must be served over **https** for install + notifications. Pick one (all free):

**A. Netlify Drop — fastest, ~60 seconds, no account needed**
1. Go to https://app.netlify.com/drop
2. Drag this whole `Trader` folder onto the page.
3. You get an instant `https://…netlify.app` URL. Open it in Safari → Share → **Add to Home Screen**.

**B. GitHub Pages — permanent, free**
1. Create a repo at https://github.com/new (e.g. `trader`), Public.
2. **Add file → Upload files** → drag in every file from this folder
   (`index.html, app.js, engine.js, sw.js, manifest.webmanifest, icon.svg, .nojekyll`) → Commit.
3. **Settings → Pages →** Source = `Deploy from a branch`, Branch = `main` / root → Save.
4. After a minute it's live at `https://<you>.github.io/trader/`. Open in Safari → Add to Home Screen.
   (The included `.nojekyll` file ensures Pages serves everything correctly.)

**C. Cloudflare Pages** — connect the GitHub repo from step B, or drag-drop at
https://pages.cloudflare.com (Direct Upload). Same result.

Then tap **🔔 Alerts** for a morning reminder (~08:15 CET) and **▶ Live monitor** during the session.

> **Why I can't click "deploy" for you:** I have no GitHub connector, the Cloudflare
> tools I can reach are read-only (no Pages/Worker deploy), and my sandbox is firewalled
> off from github.com / cloudflare. The drag-drop steps above take under a minute and you
> keep full control of the account. If you'd rather, I can walk you through it live in your browser.

### Honest limit on notifications
True *background push* (a buzz with no app open) needs a push server, which a pure
client-side app can't do. The built-in alert reminds you to open the app when it's
running/installed. If you want real background push + a daily email, that requires a
small hosted backend — say the word and I'll add one (Cloudflare Worker + cron).

## Files
- `index.html` — UI + styles
- `engine.js` — all strategy math (unit-tested: RSI matches StockCharts reference, ATR/SMA/sizing exact)
- `app.js` — data fetching, scan, rendering, PWA glue
- `sw.js`, `manifest.webmanifest`, `icon.svg` — PWA install + offline shell

## Roadmap (ask me to build any of these)
- Backtesting tab (prove the strategy's historical expectancy on your universe).
- Intraday real-time alerts when a setup triggers during the session.
- Hosted backend for true push notifications + a daily morning email.
- Sector/region filters, shortable-list awareness, earnings-date avoidance.
