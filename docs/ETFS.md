# ETFs: where the data comes from and how to look after it

*The nightly job reads about fifty US stock ETFs alongside the S&P 500. This
page is for whoever keeps that running: what it reads, what it writes, what
the files mean, and the half hour a quarter the hand-kept list needs.*

## In short

- **The list of funds is kept by hand** in `data/etf-list.json`, the way
  `data/sp500.json` is. The job never edits it.
- **Every weekday night**, after the company data has passed its audit,
  `scripts/etfs.mjs` reads each fund's holdings from its SEC filing (Form
  NPORT-P), its expense ratio from its shareholder report, and its price from
  Finnhub, with the same key the companies use.
- **It writes three files**, all data, all in the night's one data commit:
  `data/etfs.json`, `data/etf-closes.json` and `data/lei.json`. Never edit
  or commit them by hand; the job owns them.
- **It can never cost the night's company data.** It runs after the audit,
  skips itself when the job is already late, stops itself within 12
  minutes, and a failure lets the commit go ahead (see "Safety" below).
- **Nothing shows until there is data.** The Stocks | ETFs switch stays
  hidden while `data/etfs.json` is missing, so the site looks as it did
  before until the first night has run, and a copy of the app shows funds
  only if it was built with the file (`lib/funds.mjs` `loadFundsFile`). The
  job writes that first file only once it has read the holdings of at least
  80% of the listed funds (see "Safety"). Until then the website and any
  build of the app carry an empty list in its place (`scripts/build-pages.mjs`,
  `scripts/build-app.mjs`), so nothing logs a 404 for it.

## Sources and licences, field by field

| What | Where from | Licence | How often |
|---|---|---|---|
| Which funds, and their SEC IDs (trust CIK, series, class) | `data/etf-list.json`, by hand, from the SEC's `company_tickers_mf.json` (open-end funds) and `company_tickers.json` (SPY and DIA) | Public domain | Each quarter, by hand |
| Holdings, net assets, monthly returns | Form NPORT-P `primary_doc.xml` | Public domain | When a new filing appears, about 60 days after each fiscal quarter |
| Expense ratio | The fund's shareholder report (N-CSR or N-CSRS), inline XBRL `oef:ExpenseRatioPct` for its share class. Or typed by hand in the list, with the SEC document it came from | Public domain | Looked at every 30-39 days |
| Price, day's move, 52-week range, returns, beta | Finnhub `/quote` and `/stock/metric`, the same calls and meanings as for companies | Finnhub free tier: personal, non-commercial (`PAYWALL.md`) | Nightly |
| Closing prices | Our own record of each night's quote | As above | Nightly |
| Matching a holding to one of our companies | The holding's LEI, or the ticker the filing gives, or its name against our list and the SEC's company titles | LEIs are public (GLEIF, CC0); the rest is SEC public domain | Every time a filing is read |

**Never used:**

- **CUSIPs and ISINs.** CUSIP Global Services licenses them, an ISIN
  contains a CUSIP, and this repository is public. `scripts/nport.mjs` never
  reads those elements, nothing the job writes carries one, and the test
  fixtures have them taken out. Bloomberg identifiers go the same way.
- **Yahoo, Stooq and issuer websites.** The first two never answered the
  Action's runners and have no commercial licence; issuers' terms need
  written permission.
- **Finnhub's ETF endpoints** (holdings, profile). They are a paid bundle,
  and the SEC filings give the same holdings for free.

## The files

### `data/etf-list.json` (by hand)

```json
{"v":1,
 "leiFix":{},
 "funds":[
  {"t":"VOO","n":"Vanguard S&P 500 ETF","issuer":"Vanguard","trust":"0000036405","series":"S000002839","class":"C000092055","seed":true,"er":null,"erUrl":null,"erAsOf":null,"since":2010},
  {"t":"SPY","n":"SPDR S&P 500 ETF Trust","issuer":"State Street","trust":"0000884394","series":null,"class":null,"seed":true,"uit":true,"er":null,"erUrl":null,"erAsOf":null,"since":1993}
 ]}
```

- `trust` is the registrant's CIK. Many funds share one (all eleven Select
  Sector SPDRs are CIK 1064641), which is why a fund record never carries it
  as `cik`: in the app `cik` means "this company", and eleven funds would
  become one.
- `series` and `class` come from the SEC's ticker file. `series: null`
  means the CIK files for this one fund only (SPY and DIA, which are unit
  investment trusts), so the job finds its N-PORT through the CIK's
  submissions file instead of by series.
- `seed: true` marks the S&P 500 trackers. Only their holdings may teach the
  job new LEIs.
- `er`, `erUrl`, `erAsOf`: a fee typed by hand, in percent a year (0.0945
  means 0.0945%), with the sec.gov address of the document it was copied
  from and that document's date. All three or none: a fee without its
  source is ignored. **Never type one from memory or from an issuer's
  website.** Leave it `null` and the job reads it from the shareholder
  report; the hand figure always wins over what the job reads.
- `leiFix`: `{"<LEI>": "<10-digit CIK>"}` points a holding at one of our
  companies; `{"<LEI>": null}` says it is not one of ours, even if its name
  looks like it. Hand fixes live here and never in `lei.json`, because the
  commit step lays the job's own files over whatever is on `main`, and a
  fix merged during the two-hour run would be undone.
- **When a `leiFix` takes effect.** A fix is applied when a fund's filing is
  read, and the fund's figures change only then:
  - A fix that points one of a fund's unmatched holdings (its `out` list)
    at one of our companies has every such fund read again the next night.
  - Any other fix waits for each fund's next reading: a `null` that takes a
    company back out, one that moves an LEI the job already matched to
    another company, or one for a holding too small to be in `out`. That
    reading comes with the fund's next new N-PORT or its monthly re-read,
    so within about 40 days.
  - Nothing makes it sooner. Taking the fund off the list and putting it
    back is no shortcut: it costs two days' pull requests and empties the
    fund's price history in `etf-closes.json`.

The job refuses, and leaves out for the night, a fund with a malformed
ticker, a ticker listed twice, a ticker that is also an S&P 500 company, or
malformed IDs. The refusals are in `skipped` in `etfs.json`.

### `data/etfs.json` (the job)

```json
{"v":1,"updated":"2026-10-15T00:53:10Z","session":"2026-10-14",
 "counts":{"listed":53,"priced":51,"withHoldings":48,"full":41,"partial":5},
 "skipped":[{"t":"SCHB","why":"N-PORT series mismatch"}],
 "etfs":[{"t":"XLK","n":"State Street Technology Select Sector SPDR ETF","kind":"etf","issuer":"State Street",
   "trust":"0001064641","series":"S000006415","since":1998,
   "price":250.1,"change":0.4,"open":249.2,"prev":249.1,"lo":180.3,"hi":260.2,"r13":6.2,"r26":11.8,"r52":15.1,"ytd":13.4,"beta":1.2,
   "er":0.08,"erUrl":"https://www.sec.gov/Archives/edgar/data/1064641/…-index.htm","erAsOf":"2025-09-30","erSrc":"N-CSR",
   "nport":{"period":"2026-03-31","filed":"2026-05-28","accession":"0001410368-26-055331",
            "url":"https://www.sec.gov/Archives/edgar/data/1064641/000141036826055331/primary_doc.xml",
            "assets":84198427150.26,"assetsScope":"fund","count":73,"rtn":[-0.04,-3.56,-4.07],
            "name":"State Street(R) Technology Select Sector SPDR(R) ETF","checked":"2026-10-14","read":"2026-10-14"},
   "equity":99.91,"other":0.09,"cover":100,"reading":"full",
   "hold":[["NVDA",15.512],["AAPL",13.638],["MSFT",10.061]],
   "out":[],
   "spread":{"effN":15.47,"top10":61.44,"big1":15.5,"big1T":"NVDA"},
   "mix":{"Information Technology":100,"Outside the S&P 500":0}}]}
```

(The holdings figures are XLK's real ones from that filing; the price and fee
are made up for the example.)

- **No record ever has `cik`, `s` or `mc`.** With `s` the scoring code would
  score a fund as if it were a company, and `cik` is a company's identity.
- **Price fields** mean exactly what they mean on a company record. When
  tonight's quote failed, the price, 52-week range, returns and beta are
  kept from the last night the fund was quoted, and `stale` holds the
  session they belong to. The day's move (`change`, `open`, `prev`) is not
  kept: it was that session's move, and a screen would show it as today's.
- **`nport`**: `period` is the date the holdings are as of (the filing's
  `repPdDate`; its `repPdEnd` is the fiscal year end, often months later).
  `assets` is the fund's net assets; `assetsScope` is `"series"` when the
  series has several share classes and the figure covers them all (VOO's
  includes the Admiral shares), else `"fund"`. `count` is the number of
  equity holdings, `rtn` the class's three monthly total returns in percent,
  `name` the series name as filed. `checked` is the last night the SEC was
  asked for a newer filing, `read` the last night this one was read.
- **`equity`** is the percent of net assets in stocks (common and
  preferred), **`other`** the rest: cash, money-market funds, futures,
  securities-lending collateral. **`cover`** is the percent of the equity we
  matched to S&P 500 companies.
- **`reading`**: `"full"` when `cover` is at least 80 and `other` at most 10
  (the line at which a fund gets a number), `"partial"` from 30% cover,
  `"none"` below that or with no holdings.
- **`hold`**: every matched company as `[ticker, % of equity]`, share
  classes merged (GOOGL and GOOG count once, under the first ticker our list
  gives). **`out`**: unmatched holdings of 0.1% of equity or more, as
  `[LEI or null, name, % of equity]`, for a hand fix if one is ours.
- **`spread`**: `effN` is the effective number of holdings (1 divided by the
  sum of squared weights; 50 equal holdings make 50), `top10` the ten
  largest positions' share, `big1` and `big1T` the largest one (its ticker,
  or its name as filed when it is not one of our companies), all over every
  equity position. The screens show `effN` and `top10` as whole numbers,
  so they are kept to two decimals: kept to one, XLK's 15.47 became 15.5
  and showed as "about 16". `big1` is shown to one decimal and kept to one.
- **`mix`**: sector weights of the matched holdings, plus "Outside the
  S&P 500", to one decimal and adding up to exactly 100: each is rounded
  down to a tenth, and the tenths still missing go to the largest
  remainders. Rounded one by one, they could add up to 99.9 or 100.2.
- **`er`** as above, with **`erSrc`** saying where it came from: `"list"`
  (typed by hand), `"N-CSR"` or `"N-CSRS"` (read from that report, `erAsOf`
  being its period end). The shareholder report's figure is the ratio the
  fund actually charged over that period, so a fee cut shows up at the next
  report.
- Bookkeeping the screens can ignore: `erCheck` (when the job last looked
  for a shareholder report, and which one it read) and `nportMiss` (a filing
  it refused, so it is not downloaded again every night).

### `data/etf-closes.json` (the job)

`{"v":1,"updated":"…","closes":{"XLK":[["2026-10-14",250.1],…]}}`: one close
per session per fund, sorted, at most 1,300 (five years), the same way the
companies' closes are kept. All funds share one file so that the nightly
commit grows by three files, not fifty (`docs/LESSONS.md`).

### `data/lei.json` (the job)

`{"v":1,"byLei":{"HWUPKR0MPOU8FGXBT394":{"cik":"0000320193","via":"name","from":"IVV 2026-06-30"}}}`:
LEIs the job learned from an S&P 500 tracker's own filing, where a holding's
name matched exactly one of our companies. It only ever adds. A wrong one is
overridden with `leiFix`, never edited here; such a fix reaches each fund at
its next reading, within about 40 days (see `leiFix` above).

## How a fund is read

1. **Is there a newer filing?** Each fund is asked about once every 6-11
   days (spread by ticker so they do not all come due on one night), every
   2 days while its next quarter's filing is due (50-80 days after the
   quarter ends), and every night until one has been read (a fund whose
   filing was refused waits its 6-11 days instead: asked sooner, the SEC
   would only list the same filing). For a series,
   the job reads browse-edgar's HTML page with the series ID in the CIK slot
   and takes the newest `NPORT-P` (not an `NPORT-P/A` amendment). The Atom
   feed is not used: on the series page, its link points at the whole trust.
   For SPY and DIA it reads the CIK's submissions file.
2. **Download and check.** `primary_doc.xml` is downloaded only when the
   accession number is new, or when last night's reading is out of date: a
   ticker it used has left tonight's snapshot (a rename), a `leiFix` now
   names one of its unmatched holdings, or it was read more than a month
   ago (see "When a `leiFix` takes effect" above for the fixes that wait).
   The filing is refused if it names another series, comes from
   another registrant (SPY, DIA), is a final filing, or its weights do not
   sum to 90-110%. A refused filing is remembered in `nportMiss`. A fund
   whose filings list no longer shows any N-PORT keeps the holdings it has,
   and is named in `skipped` as "no N-PORT found, older holdings kept"; past
   200 days they are too old to read it by, and its card says "Out of date".
3. **Match.** Stock holdings only. First the LEI (via `lei.json` and
   `leiFix`), then a ticker the filing gives if it is one of tonight's, then
   the name: reduced to the words that identify it ("Procter & Gamble
   Co/The" and "PROCTER & GAMBLE Co" both become "procter & gamble") and
   accepted only when it points at exactly one company, checked against our
   list's names and the SEC's titles for the same CIKs. Checked on real
   filings: all 30 of DIA's holdings and all 73 of XLK's match, Chevron
   included, which DIA's filing lists with no LEI.
4. **Expense ratios.** For a fund with no hand-typed fee, about once a
   month: browse-edgar for the series' newest `N-CSR` or `N-CSRS`, that
   filing's `index.json`, and the SEC's extracted XBRL instance (`*_htm.xml`).
   The fee is the `oef:ExpenseRatioPct` fact whose context names the fund's
   class; anything outside 0-3% is taken as misread. At most six of these
   XBRL files are downloaded a night, and funds in one report share it.
5. **Prices** come last, from Finnhub at 50 calls a minute, after the SEC
   work, so the refresh step's last calls have left Finnhub's window.

## Safety

- **Time.** The workflow's first step writes `JOB_STARTED`. More than 150
  minutes into the 180-minute job, the ETF step does nothing. Otherwise it
  allows itself the smaller of 12 minutes and the time left less 10, inside
  its own 15-minute timeout, and leaves Finnhub's two minutes at the end of
  that. The SEC's share has a deadline of its own, and no SEC request
  outlives it: an SEC that accepts requests and never answers is cut off
  there, and Finnhub keeps its two minutes. A host that fails eight times
  in a row is not asked again that night.
- **Failure.** `continue-on-error: true`: whatever happens in the step, the
  company data commits. Every file is written to `.tmp` and renamed, so a
  killed step leaves yesterday's file whole.
- **Refusal.** Tonight's `etfs.json` does not replace yesterday's when it
  priced fewer than 90% as many funds as yesterday, or kept holdings for
  fewer than 90% as many (both counted over the funds still listed), and
  it is never written at all when nothing was priced or read.
- **A drop that lasts.** A refusal holds for five days at most. Once the
  file being kept is more than five days older than tonight's session
  (about three sessions), tonight's is written anyway and becomes the next
  night's baseline: if Finnhub stops quoting some funds for good, those
  funds keep their last price marked `stale`, and every other fund, and the
  SEC bookkeeping, carry on. Without this one lasting drop would freeze
  every fund indefinitely.
- **The first file.** There is no yesterday to compare with, so the first
  `etfs.json` is written only when at least 80% of the listed funds have
  holdings. An SEC that does not answer the runners would otherwise turn
  the ETF side on over fifty empty cards. Prices are not required: if
  Finnhub's free tier does not quote ETFs, the funds still show, without a
  price.
- **Warnings.** Every refusal, and every drop let through after five days,
  also prints a `::warning::` line, which GitHub shows on the run's summary
  page. The step itself stays green either way (it is `continue-on-error`).
- **Commit size.** Three files, inside the night's one data-only commit.
  No new workflow, schedule or secret.
- **Limited test runs** (`limit` set) skip the step.

**Cost.** A normal night is about two minutes: 106 Finnhub calls at 50 a
minute and a handful of SEC requests. The first night downloads every
fund's N-PORT (VTI's, the largest, should be about 4 MB) and up to six
shareholder-report XBRL files, a few minutes in all; the rest of the fees
follow over the next nights.

## How to tell it works

Read the next scheduled data commit's `data/etfs.json`: `counts`, `skipped`
and the `out` lists, and the step's one summary line in the log, which
reads like this (the numbers here are only an example):

    ETFs: 53 listed, 51 priced, 48 with holdings, 41 read in full, 5 partly; SEC 53 checked, 53 N-PORTs read, 6 expense ratios read, 410 LEIs learned; written (first night); unmatched ≥0.5%: …

On a night the file is not written, that line ends in `kept yesterday's
etfs.json (…)` or, before the first file, `no etfs.json written yet (…)`,
with the reason, and the run's summary page shows the same as a warning.
If `data/etfs.json` is not in the first night's commit, that warning says
why.

Do not start a manual run to check (CLAUDE.md rule 14).

Not yet known, and settled by the first nights:

- whether Finnhub's free tier quotes ETFs (if not, every fund is skipped
  with "no quote"; holdings and fees still work);
- whether browse-edgar's series page answers the runners as it does for
  edgartools (if not, open-end funds show "no N-PORT found" or nothing,
  and no first file is written: the warning reads "only 2 of 53 funds
  with holdings, too few for a first file", or 0 or 1 of 53 if its errors
  shut the SEC off for the night before SPY and DIA were read);
- how large the trusts' shareholder-report XBRL files are (anything over
  25 MB is skipped and the fee stays empty until typed by hand).

## Adding or changing a fund

1. Find its ticker in the SEC's `company_tickers_mf.json` (open-end funds:
   CIK, series, class) or `company_tickers.json` (unit investment trusts:
   CIK only). Copy the IDs exactly; never guess them.
2. Add a line to `funds` in `data/etf-list.json`. Keep to US stock funds
   that mostly hold S&P 500 companies: no bond, international, small-cap,
   commodity, crypto, leveraged, inverse or options-income funds.
3. Leave `er` null unless you are copying it from an SEC document, with its
   address and date.
4. Run `node --test tests/*.test.mjs` (one test checks the real list).
5. It goes in that day's pull request. The fund appears after the next
   nightly run.

To try the job locally without a key, run it into a scratch folder, never
into `data/`:

    mkdir -p /tmp/etf-data && cp data/sp500.json data/snapshot.json data/etf-list.json /tmp/etf-data/
    ETF_SKIP_PRICES=1 node -e 'import("./scripts/etfs.mjs").then((m) => m.main({ data: "/tmp/etf-data" }))'

## The quarterly half hour

Once a quarter, in that day's pull request:

1. **Renames and conversions.** Check each ticker against the SEC's
   `company_tickers_mf.json`. SPLG became SPYM on 2025-10-31 (series
   S000006983 under CIK 1064642; a different, newer fund also used to be
   listed as SPYM). QQQ became an open-end fund in December 2025; the
   SEC's June 2026 ticker file lists it as series S000101292, class
   C000271435. A record whose
   `nport.name` no longer fits its `n` is a sign something changed.
2. **Closures and mergers.** A final N-PORT shows in `skipped` as "final
   N-PORT". Take the fund off the list.
3. **Fees.** SPY and DIA file no shareholder report the job can read, so
   their fees are typed by hand from their prospectus on sec.gov, with its
   address and date. Check that any other hand-typed fee is still the
   current one.
4. **Unmatched holdings.** Look at the `out` lists. An S&P 500 company in
   one of them needs a `leiFix` entry (the funds holding it are read again
   the next night); anything else is correctly outside.
5. **`skipped`.** Anything there for more than a few nights needs a look,
   "no N-PORT found, older holdings kept" in particular: that fund's
   holdings stop being read in full once they are 200 days old.
6. **Launch years** (`since`) were typed from general knowledge when the
   list was made. Check any that a card leans on against the prospectus.

## Where the test fixtures come from

`tests/fixtures/` holds real SEC documents, trimmed, with every CUSIP, ISIN
and other vendor identifier taken out:

- `nport-xlk.xml`: XLK's NPORT-P 0001410368-26-055331 (holdings as of
  2026-03-31), 8 of its 76 holdings, including two money-market positions,
  a future with a negative weight and Sandisk with no LEI;
- `nport-dia.xml`: DIA's NPORT-P 0001752724-25-158219, all 30 holdings;
- `sec-titles-dia.json`: the SEC's `company_tickers.json` rows for those 30;
- `browse-ivv.html`: browse-edgar's page for IVV's series S000004310;
- `ncsr-instance.xml`: the XBRL instance of an N-CSR (Alger Portfolios,
  0001133228-26-002293), three share classes and their expense ratios.

The N-PORTs and the ticker rows are SEC responses recorded in OpenBB's test
suite; the browse page and the N-CSR are from edgartools' test fixtures.
