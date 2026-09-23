# StockOrNot

Every company in the S&P 500, one card at a time. Each card puts the whole
picture in front of you — price, valuation, growth, margins, the balance sheet
as filed, the next earnings date, and what the company's own 10-K says about its
business and its risks — with the arguments for and against it laid out. Then you
decide: swipe right and it goes in your cart, left and it's gone.

**→ [Open it](https://stockornot.com)**

> **Not investment advice.** Everything here is public data, presented plainly.
> It can be stale, mis-parsed or wrong. Read the actual filing before you buy.

---

## The idea

Most stock screeners either dump a spreadsheet on you or hand you a rating and
expect you to trust it. This does neither. There is **no score and no verdict** —
just the numbers a company reports, arranged so you can read them in about
fifteen seconds, and a pros/cons list where every line names the figure that
triggered it:

> ✓ Generated $108B of free cash flow in FY2025 — 28% of revenue.
> ✗ Very expensive at 62.4× earnings — years of growth are already in the price.

You can disagree with any threshold. The fact underneath it is still there, and
the raw number is in the table below it.

---

## What's on a card

| Section | What it holds |
|---|---|
| **Header** | Price, day move, market cap, position in the 52-week range |
| **Earnings** | Next reporting date, before/after the bell, consensus EPS |
| **For / against** | Up to six of each, derived from thresholds on the real figures |
| **The numbers** | P/E, P/B, P/S, revenue and EPS growth, three margin lines, ROE, debt/equity, current ratio, yield, beta, 3-month and 1-year returns |
| **Last full year, as filed** | Revenue, net income, operating cash flow, capex, free cash flow, cash, long-term debt, equity — straight from XBRL |
| **Straight from the 10-K** | The company's own description of what it does, the risk factors it lists, and links to the filing itself |
| **What the street says** | Share of analysts rating it buy / hold / sell and how that moved on the month, how often it has beaten the EPS estimate, and whether insiders are net buying or selling |
| **Against its sector** | P/E, price/sales, FCF yield, revenue growth, net margin, ROE, debt and 1-year return set beside the sector median, with where it ranks ("cheaper than 63%") |

"The numbers" is grouped into valuation, growth, profitability, balance sheet,
dividend and price, and now includes PEG, free-cash-flow yield, ROA, net cash or
net debt, payout ratio, five-year revenue growth and the six-month return. Hover
any figure for a one-line explanation. Forward P/E, price/FCF, EV/EBITDA, quick
ratio, interest cover, five-year EPS and dividend growth, year-to-date, return
against the S&P 500 and average volume appear once the nightly refresh has
collected them.

Tapping a card opens the full record, which adds the **next report** (EPS and
revenue expected, last quarter's result, the beat record, a calendar button),
trend and drawdown under the price chart, the **closest peers** by size,
month-by-month **insider sentiment**, and the last ten days of **headlines**.

Scroll the card to read it all. Drag it sideways, use <kbd>←</kbd> / <kbd>→</kbd>,
or hit the buttons. <kbd>↑</kbd> / <kbd>↓</kbd> scroll.

## The cart

Swiping right stores the ticker, the price at the moment you added it, and a note
field. The cart shows what each pick has done since — so it doubles as a record
of what you were thinking and when. Export to CSV whenever.

Each company in the cart also takes a **dollar amount**, or type one total into
*Split evenly*. With a brokerage connected, **Review orders** turns those amounts
into orders: market orders in dollars (fractional shares) or limit orders in whole
shares, checked against the account's buying power, confirmed, then placed.

The cart lives in `localStorage`, and follows you between devices if you sign in.

> **While StockOrNot is in development there are no limits.** `DEV_UNLIMITED` in
> `lib/tier.mjs` gives every visitor unlimited companies and cart slots. Set it to
> `false` to bring the tiers in [PAYWALL.md](PAYWALL.md) back.

---

## Connecting a brokerage

[Alpaca](https://alpaca.markets) is the brokerage wired up so far. It is built to
be driven by software, supports dollar-amount orders, and has a free **paper**
account that trades with pretend money. Paper is the default and the only mode
allowed until you say otherwise.

The page never talks to the brokerage directly. It calls `/api/broker` on this
site (a Vercel serverless function), which keeps the credentials sealed with
AES-GCM in an **HttpOnly cookie** in your own browser: nothing is stored on the
server, the page's scripts cannot read the keys back, and *Disconnect* deletes
them. Orders carry a unique client ID, so a double-tap cannot buy twice.

Set these in **Vercel → Project → Settings → Environment Variables**:

| Variable | Needed for | |
|---|---|---|
| `BROKER_SECRET` | everything | 32+ random characters, e.g. `openssl rand -hex 32`. Encrypts the cookie. Changing it disconnects everyone. |
| `ALPACA_CLIENT_ID`, `ALPACA_CLIENT_SECRET` | "Connect with Alpaca" | Register an OAuth app with Alpaca and set its redirect URI to `https://<your site>/api/broker-oauth`. Without these, people paste API keys instead. |
| `BROKER_ALLOW_LIVE` | real money | Leave unset during development. `1` allows live accounts. |
| `BROKER_MAX_ORDER_USD` | real money | Per-order cap on live accounts. Defaults to 5000. |
| `FINNHUB_TOKEN` | headlines | The same key the Action uses. Powers `/api/news`, cached at the edge for 30 minutes per ticker. |

To try it: open a paper account at alpaca.markets, create API keys on the paper
dashboard, then in the cart choose *Connect* and paste them.

Another brokerage means another file shaped like `api/_lib/alpaca.mjs`.

---

## Earnings alerts

Anything in your cart that reports within **seven days** gets a heads-up with
what the street expects it to hit: EPS and, once the refresh has collected it,
revenue. Three ways to hear about it:

1. **On the site.** A banner under the top bar whenever something in the cart is
   inside the window, and *Cart → Earnings dates* for the next 45 days with each
   company's beat record.
2. **In your calendar.** *Add to my calendar* downloads an `.ics` file with every
   report date, set to remind you at 9am a week before and 9am the day before.
   Apple Calendar and Outlook keep those reminders. Google Calendar applies its
   own defaults instead.
3. **By email.** Signed-in users can switch on *Email me seven days before…*. The
   nightly Action runs `scripts/earnings-alerts.mjs` after publishing the data,
   and sends each company once per report date. To enable it:
   - run the new tables at the end of `supabase/schema.sql` in the Supabase SQL editor
   - add repository secrets `SUPABASE_SERVICE_ROLE_KEY` and `RESEND_API_KEY` ([resend.com](https://resend.com))
   - optionally set a repository variable `ALERT_FROM`, e.g. `StockOrNot <alerts@stockornot.com>`, on a domain Resend has verified

   Until those exist the step logs that it skipped and the Action stays green.
   `DRY_RUN=1 node scripts/earnings-alerts.mjs` prints what would be sent.

---

## How the data gets here

A static site can't fetch this itself — SEC blocks cross-origin requests for
filings and XBRL, and an API key in client-side JavaScript is a public API key.
So the work happens in a **GitHub Action** that runs every weekday evening,
after the close (22:20 UTC):

```
.github/workflows/refresh.yml  →  scripts/refresh.mjs  →  scripts/audit.mjs  →  scripts/build-pages.mjs
```

Which does:

1. **Finnhub** — `/quote` and `/stock/metric` per company, plus a bulk
   `/calendar/earnings` call for upcoming report dates, and a per-company call
   whenever the bulk answer is missing or more than ~100 days out. Rate-limited
   to stay inside the free tier's 60 calls/minute. A ticker that stops quoting
   is looked up by CIK in the SEC's ticker list, so a renamed company is found
   under its new symbol.
2. **SEC EDGAR submissions** — the latest 10-K and 10-Q per company: accession
   number, filing date, period, direct link.
3. **SEC companyfacts** — each company's own XBRL facts, read by
   `scripts/fundamentals.mjs` on the company's own fiscal calendar (a June
   year-end is FY2026 when the company says so), with balance sheets dated at
   the fiscal year end and share counts on the latest 10-K's split basis.
   Cached in `data/fundamentals/` per 10-K accession, so a company is fetched
   once a year. The SEC's calendar-year `frames` are kept only as a fallback.
4. **The 10-K itself** — downloaded and parsed by `scripts/tenk.mjs` for Item 1
   (Business) and the Item 1A risk-factor headings. Cached under
   `data/filings/<TICKER>.json` and keyed by accession number, so a filing is
   only downloaded once; after a parser change, 150 cached filings a night are
   re-read.
5. **Closing prices** — each night's close is appended to
   `data/detail/<TICKER>.json`, which is what the price chart draws.
   `scripts/backfill-closes.mjs` rebuilt the earlier sessions from this
   repository's own history.

Output lands in `data/snapshot.json` (market data, ~1MB), `data/detail/*.json`
(history, chart, analysts) and `data/filings/*.json` (10-K prose, lazy-loaded per
card). `scripts/audit.mjs` checks the result before anything is committed, and
refuses to publish a snapshot that is worse than yesterday's.

### Setting it up on your own fork

1. Get a free key at [finnhub.io/register](https://finnhub.io/register).
2. **Settings → Secrets and variables → Actions → New repository secret**,
   named `FINNHUB_TOKEN`.
3. Optionally set a repository *variable* `SEC_USER_AGENT` to
   `Your Name your@email.com` — SEC asks that automated requests identify themselves.
4. **Actions → Refresh market data → Run workflow.** First run takes 30–60
   minutes because it downloads every 10-K; later runs are a few minutes.

The key never reaches the browser. That is the entire reason the pipeline works
this way.

Handy inputs when running it manually: `limit` (only process the first N
companies) and `skip_filings` (set to `1` to skip 10-K downloads).

---

## Running locally

```bash
git clone https://github.com/respectking/stockornot.git
cd stockornot
BROKER_SECRET=$(openssl rand -hex 32) node scripts/dev-server.mjs
# open http://localhost:8080
```

`scripts/dev-server.mjs` serves the static files the way Vercel does and runs the
functions under `api/`, so the brokerage connection works locally. Pass any of the
environment variables above the same way. `python3 -m http.server 8080` still
works for the deck alone, but the cart will say placing orders needs the live site.

The pipeline's parsers have fixture tests that need no network:

```bash
node --test tests/*.test.mjs
```

The page needs `data/snapshot.json` to show anything; if it's missing you get a
setup screen instead. To build one yourself:

```bash
FINNHUB_TOKEN=xxx LIMIT=20 SKIP_FILINGS=1 node scripts/refresh.mjs
```

---

## The screens

Each one is a single rule, applied to the latest snapshot:

| Screen | Rule |
|---|---|
| Low P/E | trailing P/E below 15 and positive |
| Fast growing | revenue growth ≥ 15% year over year |
| High margin | net margin ≥ 18% |
| Pays 2%+ | indicated dividend yield ≥ 2% |
| Net cash | cash on hand exceeds long-term debt |
| Near 52wk low | price in the bottom quarter of its 52-week range |
| Earnings < 30d | next report within 30 days |
| Mega caps | market cap ≥ $200B |

Plus sector filters and a search box. Companies you have swiped are hidden until
you ask for them back.

---

## Known limits

- **The constituent list is a static file.** `data/sp500.json` is a point-in-time
  snapshot of the index. Companies that join or leave won't be picked up until
  someone edits it; tickers Finnhub can't price are logged as `skipped` in the
  snapshot and dropped from the deck.
- **10-K parsing is heuristic.** Finding "Item 1A" in a document that has no
  consistent markup across 500 filers means some companies parse cleanly and
  others don't. When parsing fails the card says so and links to the filing.
- **Ratios come from Finnhub, financials from SEC.** They cover different periods
  (trailing twelve months vs last fiscal year), so a margin in "The numbers"
  won't always reconcile with "Last full year, as filed". Both are labelled.
- **The pros and cons are thresholds, not analysis.** They have no view on
  management, competition, or anything that happened after the last filing.

---

## Design notes

Dark, one accent hue. Up and down moves carry a ▲/▼ glyph and a signed number as
well as colour, so nothing depends on colour alone. `prefers-reduced-motion` and
`forced-colors` are honoured. The swipe gesture locks to an axis on the first
8px of movement, so dragging sideways swipes and dragging vertically scrolls the
card.

No framework, no build step. Three files, some JSON, and three small serverless
functions under `api/` for the parts that need a secret: the brokerage and the news.

## Licence

MIT — see [LICENSE](LICENSE).
