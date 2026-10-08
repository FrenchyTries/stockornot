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
expect you to trust it. This tries to do neither. Each card carries a
**fundamentals score** from 1 to 99 with a plain label ("Screens well",
"Mixed", "Screens poorly") and its rank in its sector ("#2 of 73 in Tech"), but
the score shows its working: five factors (value, growth, profitability,
momentum, stability), each half a curve over the reported figures and half a
rank among the company's own sector, blended by weight. The score is where that
blend places the company in the S&P 500: 90 means ahead of 90% of the index.
The notes say what was left out and why. The [track record](https://stockornot.com/track)
follows each week's top and bottom fifth forward from October 2026, so whether
the score means anything gets an honest answer over time. [How the score works](https://stockornot.com/method)
lists every threshold. It describes the last filing and today's price; it does
not forecast anything.

Beside it sits a pros/cons list where every line names the figure that
triggered it:

> ✓ Generated $108B of free cash flow in FY2025, 28% of revenue.
> ✗ Very expensive at 62.4× earnings. Years of growth are already in the price.

You can disagree with any threshold. The fact underneath it is still there, and
the raw number is in the table below it.

---

## What's on a card

| Section | What it holds |
|---|---|
| **Header** | Price, day move, market cap and the score with its label |
| **52-week range** | Where the price sits, in words: "12% below its 52-week high and 39% above its low", with a bar between the low and the high |
| **Earnings** | Next reporting date, before/after the bell, consensus EPS |
| **For / against** | Up to six of each, derived from thresholds on the real figures and ranks within the sector. The card shows four of each; the full record shows them all |
| **The financials** | Five questions, each answered in a word or two with only the figures behind it: 📈 **revenue growth** (is the business growing?), 💰 **free cash flow** (is it generating real cash?), 🧮 **profit margins** (is profitability improving?), 🏦 **debt vs. cash** (is the balance sheet healthy?) and 📊 **valuation** (is the price reasonable? P/E, P/FCF, PEG, price/sales) |
| **Straight from the 10-K** | The company's own description of what it does, the risk factors it lists, and links to the filing itself |
| **What the street says** | Share of analysts rating it buy / hold / sell and how that moved on the month, how often it has beaten the EPS estimate, and whether insiders are net buying or selling |
| **Against its sector** | The first six of P/E, price/sales, FCF yield, revenue growth, net margin, ROE (ROA where equity is negative or tiny), debt/equity, dividend yield and 1-year return that the company reports, beside the sector median, with where it ranks among the other companies in the sector ("cheaper than 63%"). The full record shows every row |

The answers use the same rules as the score: a bank's revenue jump, cash flow and
debt are never judged, and "is the price reasonable?" reads the same multiples,
against the same growth, as the value part of the score. Hover any figure for a one-line explanation.

Tapping a card opens the full record, which adds five years of the filings under
the same checks, the **next report** (EPS and
revenue expected, last quarter's result, the beat record, a calendar button),
trend and drawdown under the price chart, the **closest peers** by size,
month-by-month **insider sentiment**, and the last ten days of **headlines**.

On a phone, *Add to Home Screen* installs it as an app with its own icon, and
it opens with no signal on the last data it saw (`sw.js`, network first, so
nobody online is ever shown a stale page). The App Store version is planned in
[`docs/APP_STORE.md`](docs/APP_STORE.md).

Scroll the card to read it all. Drag it sideways, press **Not for me** or
**Add to cart** under the deck, or use <kbd>←</kbd> / <kbd>→</kbd>. The round
button between them, or <kbd>Z</kbd>, takes back the last swipe: the company
returns to the top, and leaves the cart again if that swipe put it there.
<kbd>↑</kbd> / <kbd>↓</kbd> scroll, and <kbd>Enter</kbd> opens the full record.

## The tabs

Five tabs run along the bottom of a phone, and across the middle of the header
on a wide screen, with the deck in the middle:

| Tab | What it holds |
|---|---|
| **Track** | The track record: each week's top and bottom fifth by score, followed forward against the whole index (`data/track.json`, the same table as `/track`) |
| **Compare** | Two companies head to head: the score and its factors, then the figures behind the five checks (growth, margins, cash and debt, valuation, price), with the stronger figure on each row marked. It opens on the two largest companies; tap either to swap it for any other, from the cart, the largest, or by ticker or name |
| **Deck** | The cards |
| **Cart** | The cart, below |
| **Account** | Signing in, earnings alerts, the brokerage, membership and the site's pages |

Each tab has its own address (`/#cart`, `/#compare`…), so the Back button steps
between them and a link opens the same one. The arrow keys swipe only while the
deck is showing.

## Scoring styles

The score can be read in six styles, chosen under Account (or *Try another
style* under any score). Each weights the same five factors the way an investor
has written that it matters: **Balanced** (the standard score), **Quality at a
fair price** (after Warren Buffett), **Deep value, out of favour** (after Michael
Burry, where a fallen price counts in its favour), **Growth at a reasonable
price** (after Peter Lynch), **Defensive** (after Benjamin Graham) and **Growth
and momentum** (after William O'Neil). Only the weights change, and the score is
still a place among the 500, ranked under that style (`STYLES` in
`lib/analysis.mjs`; the weights are on the method page, and a test keeps the
two in step). The choice is kept in the browser. The track record and the
company pages use Balanced. None of these investors is affiliated with
StockOrNot.

## Your data

Creating an account asks for a tick agreeing to the terms; the version and the
time are kept on the account (`TERMS_VERSION` in `lib/auth.mjs`, to change
with `terms.html`). Signed in, Account has **Download my data** (a JSON file of
everything kept: the account, the saved cart, alert settings and alerts sent)
and **Delete my account**, which asks once more and then deletes the account
and everything attached to it through `delete_my_account()` in
`supabase/schema.sql`. That function, and the policy that lets people read
their own alert log, take effect once the schema file is run again in
Supabase's SQL editor; until then the button says to write in instead.

## The cart

Swiping right stores the ticker, the price at the moment you added it, and a note
field. The cart shows what each pick has done since — so it doubles as a record
of what you were thinking and when. Export to CSV whenever.

Each company in the cart also takes a **dollar amount**, or type one total into
*Split evenly*. With a brokerage connected, **Review orders** turns those amounts
into orders: market orders in dollars (fractional shares) or limit orders in whole
shares, checked against the account's buying power, confirmed, then placed.

The cart lives in `localStorage`, and follows you between devices if you sign in.
Every edit is stamped, and a removal leaves a small marker instead of vanishing,
so copies in other tabs, other devices and the account merge by whichever change
came last (`lib/cart.mjs`): a company removed on your phone stays removed on your
laptop. Signing in with a cart the account does not have asks before adding it,
naming the account. Signing out saves one last time, then clears the cart and its
notes from that browser.

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
them. The sealed value also carries its own 30-day expiry, so a copy lifted from
a browser stops working on its own. To cut off access everywhere, revoke the key
(or the app) in the Alpaca dashboard as well.

Each cart row keeps one client order ID per planned order, stored with the cart.
The brokerage refuses an ID it has already seen, so a double-tap, reopening the
review, retrying after an answer that never arrived, or placing the same row
from a second device cannot buy twice; a repeat comes back as "already placed".
A row that went through has its amount cleared and shows what was sent. Orders
are only ever placed under the account type (paper or live) the review showed:
if the connection changes in another tab, the batch is refused.

Set these in **Vercel → Project → Settings → Environment Variables**:

| Variable | Needed for | |
|---|---|---|
| `BROKER_SECRET` | everything | 32+ random characters, e.g. `openssl rand -hex 32`. Encrypts the cookie. Changing it disconnects everyone. |
| `ALPACA_CLIENT_ID`, `ALPACA_CLIENT_SECRET` | "Connect with Alpaca" | Register an OAuth app with Alpaca and set its redirect URI to `https://<your site>/api/broker-oauth`. Without these, people paste API keys instead. |
| `BROKER_ALLOW_LIVE` | real money | Leave unset during development. `1` allows live accounts. |
| `BROKER_MAX_ORDER_USD` | real money | Per-order cap on live accounts. Defaults to 5000 when unset. `2000` and `$2,000` both work; `0` or anything unreadable refuses every live order. |
| `BROKER_MAX_BATCH_USD` | real money | Cap on one live batch, all its orders added together. Defaults to `BROKER_MAX_ORDER_USD`. The review sheet says so before anything is sent. Live orders are buys only. |
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
   - run `supabase/schema.sql` again in the Supabase SQL editor (it is safe to re-run; it adds the alert tables and a check that each saved cart is a list)
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

Output lands in `data/snapshot.json` (market data, ~0.6MB), `data/detail/*.json`
(history, daily closes, analysts), `data/filings/*.json` (10-K prose, lazy-loaded
per card) and `data/fundamentals/` (the cached XBRL figures). `scripts/audit.mjs`
checks the result before anything is committed, and refuses to publish a
snapshot that is worse than yesterday's. Only data is committed.

The site itself is served by Vercel, which also runs the functions under `api/`.
**Vercel builds the 500 company pages, the sitemap and robots.txt on every
deploy** (`buildCommand` in `vercel.json`), from whatever data is committed.
The build then copies the site, and only the site, into `public/`, which is
what Vercel serves (`outputDirectory: "public"`): a fixed list in
`scripts/build-pages.mjs`, so the project's notes, scripts and database schema
are never published beside it. `STATIC=public node scripts/dev-server.mjs`
serves that folder locally, to check nothing the site needs was left off.
They are build output and are never committed; `.gitignore` keeps them out.
The nightly job builds them too, but only to check they still build.
[docs/LESSONS.md](docs/LESSONS.md) explains why.

### Deploying without GitHub

If GitHub is ever unavailable, Vercel can be deployed to directly from any copy
of the code. Vercel runs the same build, so the result is identical:

```bash
npx vercel link --yes --project stockornot --scope moneymoney2 --token "$VERCEL_TOKEN"
npx vercel deploy --prod --token "$VERCEL_TOKEN"
```

`VERCEL_TOKEN` comes from vercel.com/account/tokens. The environment variables
the functions need live on the Vercel project, not in the code, so nothing else
has to be set.

### Setting it up on your own fork

1. Get a free key at [finnhub.io/register](https://finnhub.io/register).
2. **Settings → Secrets and variables → Actions → New repository secret**,
   named `FINNHUB_TOKEN`.
3. Optionally set a repository *variable* `SEC_USER_AGENT` to
   `Your Name your@email.com` — SEC asks that automated requests identify themselves.
4. **Actions → Refresh market data → Run workflow.** Every run takes 30 minutes
   or more: each company needs at least two Finnhub calls (more when its
   analyst data is due), roughly 1,000 to 1,500 a night, paced at 50 a minute
   to stay under the free tier's 60. The first run also downloads every 10-K,
   which can stretch it past an hour.

The key never reaches the browser. That is the entire reason the pipeline works
this way.

Handy inputs when running it manually: `limit` (only process the first N
companies) and `skip_filings` (set to `1` to skip 10-K downloads).

---

## Running locally

```bash
git clone https://github.com/FrenchyTries/stockornot.git
cd stockornot
node scripts/build-pages.mjs        # the company pages, as Vercel builds them
BROKER_SECRET=$(openssl rand -hex 32) node scripts/dev-server.mjs
# open http://localhost:8080
```

`scripts/dev-server.mjs` serves the static files the way Vercel does, with the
response headers from `vercel.json` (the Content-Security-Policy included, so a
page that breaks under it breaks locally first), and runs the functions under
`api/`, so the brokerage connection works locally. Pass any of the
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

## Known limits

- **The constituent list is a static file.** `data/sp500.json` is a point-in-time
  snapshot of the index. Companies that join or leave won't be picked up until
  someone edits it; tickers Finnhub can't price are logged as `skipped` in the
  snapshot and dropped from the deck.
- **10-K parsing is heuristic.** Finding "Item 1A" in a document that has no
  consistent markup across 500 filers means some companies parse cleanly and
  others don't. When parsing fails the card says so and links to the filing.
- **Ratios come from Finnhub, financials from SEC.** They cover different periods
  (trailing twelve months vs last fiscal year), so a trailing margin won't
  always reconcile with the fiscal-year figures beside it. Every figure says
  which period it covers.
- **The pros and cons are thresholds, not analysis.** They have no view on
  management, competition, or anything that happened after the last filing.
- **Financials are one bucket.** Debt, free cash flow and cash conversion are
  left out of the score for every company in the Financials sector, because for
  banks, insurers and brokers borrowing is the business. That also covers
  payment networks and exchanges, which the sector label cannot tell apart.
- **No screens or search yet.** The deck is every company in random order;
  swiped ones stay hidden until you ask for them back.

---

## Design notes

One system for every page, in `styles.css`: the deck, the dialogs, the company
pages, and the method, pricing, privacy and not-found pages. Dark and quiet, set in
[Inter](https://rsms.me/inter/) (served from `fonts/`, SIL Open Font License),
with hairline rules instead of boxes inside boxes, one accent colour, and the
five financial checks marked with small line icons (`lib/icons.mjs`). Up and down
moves carry a ▲/▼ glyph and a signed number as well as colour, so nothing depends
on colour alone. `prefers-reduced-motion` and `forced-colors` are honoured. The
swipe gesture locks to an axis on the first 8px of movement, so dragging sideways
swipes and dragging vertically scrolls the card.

Motion is there to say what just happened, and nothing moves on its own:
the next two cards show at the bottom of the deck, the button on the side a card
is dragged towards lights up with it, an undone card flies back in from the side
it left by, a company's score counts up the first time it reaches the top, and
a removal from the cart folds the row away and offers an **Undo**. With reduced
motion all of it is instant.

The link preview (`og.png`), the home-screen icon and the store screenshots
are all captured from the running site by `marketing/capture.cjs`, so they
change when the design does rather than drifting from it.

No framework, no build step. Plain HTML, CSS and JavaScript, some JSON, and three
small serverless functions under `api/` for the parts that need a secret: the
brokerage and the news.

## Licence

MIT — see [LICENSE](LICENSE).
