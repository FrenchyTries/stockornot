/* ==========================================================================
   StockOrNot — daily data refresh
   --------------------------------------------------------------------------
   Runs in GitHub Actions, never in the browser. Builds data/snapshot.json from:

     Finnhub   quotes, ratios, 52-week range, upcoming earnings dates
     SEC XBRL  balance sheet + cash flow, pulled via the `frames` API
               (one request per concept covers every filer at once)
     SEC EDGAR each company's real latest 10-K and 10-Q — filing dates, links,
               the business description and the risk-factor headings

   10-Ks are cached under data/filings/<TICKER>.json and only re-downloaded when
   a new accession number appears, so after the first run this is a couple of
   documents a day rather than five hundred.

   Env:
     FINNHUB_TOKEN    required — repo secret, never shipped to the browser
     SEC_USER_AGENT   optional — SEC asks for "Name contact@example.com"
     LIMIT            optional — only process the first N companies (for testing)
     SKIP_FILINGS     optional — set to 1 to skip 10-K downloads
   ========================================================================== */

import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractFundamentals, FUNDAMENTALS_VERSION } from "./fundamentals.mjs";
import { parseTenK } from "./tenk.mjs";
import { sessionDate } from "./dates.mjs";

const ROOT       = path.resolve(import.meta.dirname, "..");
const DATA       = path.join(ROOT, "data");
const FILING_DIR = path.join(DATA, "filings");
const DETAIL_DIR = path.join(DATA, "detail");
const FUND_DIR   = path.join(DATA, "fundamentals");

/* Where the APIs live. Overridable only so the whole pipeline can be run
   against local mock servers; production never sets these. Links written
   into the data always point at the real sec.gov. */
const FINNHUB_API = process.env.FINNHUB_API || "https://finnhub.io/api/v1";
const SEC_DATA    = process.env.SEC_DATA    || "https://data.sec.gov";
const SEC_WWW     = process.env.SEC_WWW     || "https://www.sec.gov";
const secFetchUrl = (u) => u.replace(/^https:\/\/www\.sec\.gov/, SEC_WWW);

const TOKEN = process.env.FINNHUB_TOKEN;
const UA    = process.env.SEC_USER_AGENT || "StockOrNot open-source project contact@example.com";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 0;
const SKIP_FILINGS = process.env.SKIP_FILINGS === "1";

/* Bump when the 10-K parser changes so cached extractions are redone once. */
const PARSER_VERSION = 4;

/* A parser change re-reads every cached filing. Spread that over several
   nights instead of one very long run; new 10-Ks are always read at once. */
const REPARSE_BUDGET = 150;

/* Recommendation trends move monthly, so a slice of the index each night keeps
   every company under a week old without doubling the run time. */
const ANALYST_TTL_DAYS = 6;
const ANALYST_MISS_TTL = 2;    /* a ticker that came back empty waits this long */
const ANALYST_BUDGET   = 520;  /* high enough to fill the whole index in one run */

/* S&P 500 companies report quarterly, so a "next report" further out than
   this is the one after next. */
const FAR_REPORT_DAYS = 100;

/* Five years of daily closes. */
const MAX_CLOSES = 1300;

/* Every ticker starts stale, so the first run fetches all 501. Left at a flat
   TTL they would then all come due again on the same day, spiking one run a
   week. A fixed per-ticker offset spreads the re-fetches instead: each run
   picks up roughly a tenth of the index. */
function analystTtl(ticker) {
  let h = 0;
  for (let i = 0; i < ticker.length; i++) h = (h * 31 + ticker.charCodeAt(i)) >>> 0;
  return ANALYST_TTL_DAYS + (h % 6);   /* 6-11 days */
}

/* ----------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A warning that quotes a reply stays one line, as in etfs.mjs. An error
   from a reply that was not JSON quotes it, line breaks and all, and the
   Actions runner takes a line that starts with "::", or "##[" anywhere in
   one, as a workflow command. */
const oneLine = (s) => String(s).replace(/[^\S ]|[\x00-\x1f\x7f-\x9f]/g, " ").replace(/##\[/g, "# #[");

/** Simple fixed-rate gate: at most `perSec` starts each second. */
function limiter(perSec) {
  const gap = 1000 / perSec;
  let next = 0;
  return async function gate() {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await sleep(at - now);
  };
}

const finnhubGate = limiter(50 / 60);  /* free tier allows 60/min; stay under */
const secGate     = limiter(8);        /* SEC asks for <= 10 requests/second  */

/* Every request has a deadline: one host that accepts a connection and never
   answers must not hold the whole run past its three-hour limit. */
const TIMEOUT_MS = 30_000;
const MAX_TEXT = 25e6;      /* larger than any real 10-K; anything bigger is skipped */

async function getJSON(url, { headers = {}, gate, tries = 3, label = "" } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (gate) await gate();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 429) { await sleep(2000 * attempt); continue; }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === tries) {
        console.warn(`  ! ${label || url}: ${oneLine(err.message)}`);
        return null;
      }
      await sleep(700 * attempt);
    }
  }
  /* Rate-limited on every try. Said in the log like any other failure: the
     Finnhub key is shared with /api/news, so a busy evening can do this. */
  console.warn(`  ! ${label || url}: rate-limited (HTTP 429) ${tries} times`);
  return null;
}

async function getText(url, { headers = {}, gate, label = "" } = {}) {
  if (gate) await gate();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get("content-length")) > MAX_TEXT) throw new Error("too large, skipped");
    const text = await res.text();
    if (text.length > MAX_TEXT) throw new Error("too large, skipped");
    return text;
  } catch (err) {
    console.warn(`  ! ${label || url}: ${oneLine(err.message)}`);
    return null;
  }
}

const finnhub = (p) =>
  getJSON(`${FINNHUB_API}${p}${p.includes("?") ? "&" : "?"}token=${TOKEN}`,
          { gate: finnhubGate, label: `finnhub ${p.split("?")[0]}` });

const sec = (url, label) => getJSON(url, { headers: { "User-Agent": UA }, gate: secGate, label });

const numOrNull = (v) => (typeof v === "number" && isFinite(v) ? v : null);

function pickMetric(m, ...keys) {
  for (const k of keys) {
    const v = m?.[k];
    if (typeof v === "number" && isFinite(v)) return v;
  }
  return null;
}

/* ------------------------------------------------- ratios kept for a while

   Every Finnhub figure on a row but the quote comes from one /stock/metric
   call. When that call fails (a 5xx, or 429s on the key /api/news shares),
   the row used to go out with every one of them blank: a night of that,
   tried on a copy, left 476 of 501 companies without a score. Last night's
   figures are kept instead, put back under the first name the row reads
   each one from, so the share-class and EPS checks below still apply to
   them. For a week at most: a company whose ratios stop coming for good
   loses them, and the audit names it. */

const RATIO_CARRY_DAYS = 7;

/* snapshot field -> the Finnhub name its pickMetric() call tries first */
export const METRIC_NAMES = {
  mc: "marketCapitalization", pe: "peTTM", pb: "pbQuarterly", ps: "psTTM", roe: "roeTTM", roa: "roaTTM",
  nm: "netProfitMarginTTM", gm: "grossMarginTTM", om: "operatingMarginTTM", rg: "revenueGrowthTTMYoy",
  rg5: "revenueGrowth5Y", eg: "epsGrowthTTMYoy", beta: "beta", lo: "52WeekLow", hi: "52WeekHigh",
  dy: "dividendYieldIndicatedAnnual", payout: "payoutRatioTTM", de: "totalDebt/totalEquityQuarterly",
  cr: "currentRatioQuarterly", r13: "13WeekPriceReturnDaily", r26: "26WeekPriceReturnDaily",
  r52: "52WeekPriceReturnDaily", pef: "forwardPE", pfcf: "pfcfShareTTM", evEbitda: "evEbitdaTTM",
  qr: "quickRatioQuarterly", ic: "netInterestCoverageTTM", eg5: "epsGrowth5Y", dg5: "dividendGrowthRate5Y",
  ytd: "yearToDatePriceReturnDaily", rs52: "priceRelativeToS&P50052Week", vol: "10DayAverageTradingVolume"
};

/** Last night's row `was` as a /stock/metric answer, and the session its
    figures are from: the row's own ratiosFrom when they were already kept
    over, else that snapshot's session. Null when there is nothing to keep,
    or the figures are more than RATIO_CARRY_DAYS older than session `on`. */
/** True when a /stock/metric answer has none of the figures a row reads: a
    failed request (null), an empty answer, or one whose every such figure
    is null. Finnhub's answer has about a hundred other keys, which do not
    count. */
export function noRatios(metricRes) {
  return !metricRes || !Object.values(METRIC_NAMES).some((n) => numOrNull(metricRes.metric?.[n]) !== null);
}

export function carriedRatios(was, wasSession, on) {
  if (!was) return null;
  const from = typeof was.ratiosFrom === "string" ? was.ratiosFrom : wasSession;
  if (typeof from !== "string" || !((new Date(on) - new Date(from)) / 864e5 <= RATIO_CARRY_DAYS)) return null;
  const metric = {};
  for (const [k, name] of Object.entries(METRIC_NAMES)) if (numOrNull(was[k]) !== null) metric[name] = was[k];
  return Object.keys(metric).length ? { metric, from } : null;
}

/* ------------------------------------------------------ SEC XBRL via frames
   One request returns a given concept for every filer that reported it, so a
   handful of calls covers all 500 companies. */

const HISTORY_YEARS = 5;

const FRAME_CONCEPTS = [
  { key: "revenue",   tags: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"], kind: "duration" },
  { key: "netIncome", tags: ["NetIncomeLoss"],                                     kind: "duration" },
  { key: "ocf",       tags: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], kind: "duration" },
  { key: "capex",     tags: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"], kind: "duration" },
  { key: "assets",    tags: ["Assets"],                                            kind: "instant"  },
  { key: "liabs",     tags: ["Liabilities"],                                       kind: "instant"  },
  { key: "equity",    tags: ["StockholdersEquity"],                                kind: "instant"  },
  { key: "cash",      tags: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], kind: "instant" },
  { key: "debt",      tags: ["LongTermDebtNoncurrent", "LongTermDebt"],            kind: "instant"  },
  { key: "grossProfit", tags: ["GrossProfit"],                                      kind: "duration" },
  { key: "opIncome",  tags: ["OperatingIncomeLoss"],                                kind: "duration" },
  { key: "shares",    tags: ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"], kind: "duration", unit: "shares" }
];

async function loadFrames(years) {
  /* cik -> { revenue: {2024: n, 2023: n}, ... } */
  const byCik = new Map();
  for (const concept of FRAME_CONCEPTS) {
    for (const year of years) {
      let filled = 0;
      for (const tag of concept.tags) {
        const period = concept.kind === "instant" ? `CY${year}Q4I` : `CY${year}`;
        const unit = concept.unit || "USD";
        const url = `${SEC_DATA}/api/xbrl/frames/us-gaap/${tag}/${unit}/${period}.json`;
        const json = await sec(url, `frames ${tag} ${period}`);
        if (!json?.data) continue;
        for (const row of json.data) {
          const cik = String(row.cik).padStart(10, "0");
          let rec = byCik.get(cik);
          if (!rec) { rec = {}; byCik.set(cik, rec); }
          rec[concept.key] ||= {};
          if (rec[concept.key][year] === undefined && numOrNull(row.val) !== null) {
            rec[concept.key][year] = row.val;
            filled++;
          }
        }
        /* keep going through the alternate tags — each only fills gaps the
           earlier ones left, and filers are far from consistent about which
           revenue concept they use */
      }
      console.log(`  frames ${concept.key} ${year}: ${filled} filers`);
    }
  }
  return byCik;
}

/* ------------------------------------------------ financials, per company

   The frames above are kept only as a fallback. The real source is each
   company's own companyfacts, read by scripts/fundamentals.mjs, which knows
   the company's fiscal calendar (see the header of that file for why the
   frames got it wrong). The result is cached per 10-K accession, so a company
   is fetched once when it files its annual report and not again for a year. */

async function fundamentalsFor(c, tenK, safeName) {
  const file = path.join(FUND_DIR, safeName + ".json");
  let cached = null;
  try { cached = JSON.parse(await fs.readFile(file, "utf8")); } catch { /* first run */ }
  /* A cached reading with operating cash flow but no capital spending, and
     no list of what the company tags instead, is read once more so the list
     is there (see capexCandidates in fundamentals.mjs). Only those companies,
     not the whole cache. */
  const owesCandidates = cached?.out && cached.out.fin && cached.out.fin.ocf != null &&
    cached.out.fin.capex == null && !cached.out.capexCandidates;
  if (cached?.out && cached.v === FUNDAMENTALS_VERSION && tenK && cached.accession === tenK.accession && !owesCandidates) {
    return { out: cached.out, how: "cached" };
  }

  const json = await sec(`${SEC_DATA}/api/xbrl/companyfacts/CIK${c.cik}.json`, `companyfacts ${c.t}`);
  const out = json ? extractFundamentals(json, { latestPeriod: tenK?.period || null }) : null;
  if (out) {
    /* Right after a filing the facts API can lag the submissions index by a
       few hours. Only tie the cache to the accession once the newest period
       is actually in the facts, or tonight's stale read would stick for a year. */
    await fs.writeFile(file, JSON.stringify({
      accession: out.current && tenK ? tenK.accession : null,
      v: FUNDAMENTALS_VERSION, at: new Date().toISOString(), out
    }));
    return { out, how: "fetched" };
  }
  /* SEC unreachable tonight, or nothing parseable: yesterday's figures are
     still the right ones, just not refreshed. */
  if (cached?.out) return { out: cached.out, how: "stale" };
  return null;
}

/* There used to be a weekly chart fetched here from Yahoo, with Stooq behind
   it. Neither ever answered the Action's runners: every company logged
   "stooq <T>: fetch failed", and the snapshot counted one chart in 501.
   It is gone. The chart is drawn from our own nightly closes below. */

/* ----------------------------------------------------- what the street thinks */

async function analystView(ticker) {
  /* Insider sentiment rides the same rotation: it is monthly data too, and one
     more call on a tenth of the index a night costs a few seconds. */
  const since = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);
  const [recs, surprises, insiderRes] = await Promise.all([
    finnhub(`/stock/recommendation?symbol=${encodeURIComponent(ticker)}`),
    finnhub(`/stock/earnings?symbol=${encodeURIComponent(ticker)}`),
    finnhub(`/stock/insider-sentiment?symbol=${encodeURIComponent(ticker)}&from=${since}&to=${until}`)
  ]);

  const trend = Array.isArray(recs)
    ? recs.slice(0, 6).map((r) => ({
        period: r.period,
        strongBuy: r.strongBuy || 0, buy: r.buy || 0, hold: r.hold || 0,
        sell: r.sell || 0, strongSell: r.strongSell || 0
      }))
    : [];

  const earnings = Array.isArray(surprises)
    ? surprises.slice(0, 8).map((e) => ({
        period: e.period,
        actual: numOrNull(e.actual),
        estimate: numOrNull(e.estimate),
        surprisePct: numOrNull(e.surprisePercent)
      })).filter((e) => e.actual !== null)
    : [];

  /* Newest month first, at most six. MSPR runs -100 (all selling) to +100. */
  const months = Array.isArray(insiderRes?.data)
    ? insiderRes.data
        .filter((r) => numOrNull(r.mspr) !== null)
        .map((r) => ({ ym: `${r.year}-${String(r.month).padStart(2, "0")}`, mspr: +r.mspr.toFixed(2), change: numOrNull(r.change) }))
        .sort((a, b) => (a.ym < b.ym ? 1 : -1))
        .slice(0, 6)
    : [];

  return (trend.length || earnings.length)
    ? { trend, earnings, insider: months.length ? { months } : null }
    : null;
}

/* ------------------------------------------------------------ EDGAR filings */

function filingFromSubmissions(sub, cik, form) {
  const rec = sub?.filings?.recent;
  if (!rec?.form) return null;
  const i = rec.form.indexOf(form);
  if (i === -1) return null;
  const accRaw = rec.accessionNumber[i];
  const acc = accRaw.replace(/-/g, "");
  const doc = rec.primaryDocument[i];
  const bare = String(Number(cik));
  return {
    accession: accRaw,
    date: rec.filingDate[i],
    period: rec.reportDate[i] || null,
    url: doc ? `https://www.sec.gov/Archives/edgar/data/${bare}/${acc}/${doc}` : null,
    index: `https://www.sec.gov/Archives/edgar/data/${bare}/${acc}/`
  };
}

/* undefined: could not download (try again tomorrow); null: downloaded but
   nothing readable in it (remember that, do not retry). */
async function fetchFilingDetail(ticker, tenK) {
  if (!tenK?.url) return undefined;
  const raw = await getText(secFetchUrl(tenK.url), { headers: { 'User-Agent': UA }, gate: secGate, label: `10-K ${ticker}` });
  if (!raw) return undefined;
  if (raw.length < 5000) return null;
  const read = parseTenK(raw);
  return read ? { ...read, source: tenK.url } : null;
}

/* ------------------------------------------------------- renamed tickers

   data/sp500.json is maintained by hand, so a company that changes its ticker
   (Fiserv, Marsh McLennan) silently vanished from the deck for weeks. When a
   quote fails, ask the SEC which tickers the company's CIK trades under now
   and try those before giving up. Loaded only if something fails to quote. */

let secTickers = null;
const TICKER = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;
async function tickersForCik(cik) {
  if (!secTickers) {
    const j = await getJSON(`${SEC_WWW}/files/company_tickers.json`,
      { headers: { "User-Agent": UA }, gate: secGate, label: "SEC ticker list" });
    secTickers = new Map();
    for (const r of Object.values(j || {})) {
      const key = String(r.cik_str).padStart(10, "0");
      if (!secTickers.has(key)) secTickers.set(key, []);
      secTickers.get(key).push(String(r.ticker).toUpperCase().replace(/-/g, "."));
    }
  }
  return secTickers.get(cik) || [];
}

/** The symbol a company that failed to quote now trades under, or null.
    Only a real rename: the SEC no longer lists the old ticker for the CIK,
    and the new one is not another class already in the index (Alphabet,
    Fox and News Corp list both classes under one CIK and Berkshire lists A
    and B, so one failed quote turned GOOGL into a second GOOG, and Berkshire
    into its Class A at hundreds of thousands of dollars a share). A company
    still listed under its own ticker is skipped for the night instead. Only
    a well-formed ticker: it becomes a file name and part of a page. */
export function renamedTo(ticker, listed, known) {
  if (listed.includes(ticker)) return null;
  return listed.find((t) => t !== ticker && TICKER.test(t) && !known.has(t)) || null;
}

/* A quarterly EPS figure fifty times the company's own trailing annual EPS
   is another share class's (Berkshire B has carried Class A's ~$8,467
   estimate against ~$44 of annual EPS, 190×). Genuine outliers, companies
   whose trailing EPS is depressed by a one-off charge, sit under 10×. */
function plausibleEps(v, annualEps) {
  if (typeof v !== "number" || !isFinite(v)) return true;
  if (typeof annualEps !== "number" || !isFinite(annualEps) || annualEps <= 0) return true;
  return Math.abs(v) <= Math.max(annualEps * 50, 5);
}

/** The tickers sp500.json lists after another with the same CIK: Alphabet C,
    Fox B, News Corp B. Finnhub gives every class of a company one 52-week
    range, the first class's (News Corp B was shown A's $31.66 high while it
    traded at $32.58), so these publish none. */
export function laterClasses(companies) {
  const seen = new Set(), later = new Set();
  for (const c of companies) {
    if (!c.cik) continue;
    if (seen.has(c.cik)) later.add(c.t);
    else seen.add(c.cik);
  }
  return later;
}

/** The session tonight's prices are from: the one most quotes are stamped
    with (the later one on a tie), or `fallback` when no quote had a stamp.
    Not the run's own date: the job also runs on market holidays and gets the
    last session's prices back, which filed under the holiday read as that
    day's move and close, and as a day of trading in the track record. */
export function quotedSession(counts, fallback) {
  let best = null;
  for (const [session, n] of counts)
    if (best === null || n > counts.get(best) || (n === counts.get(best) && session > best)) best = session;
  return best ?? fallback;
}

/* ------------------------------------------------------------------ pipeline */

async function main() {
  const started = Date.now();
  const universe = JSON.parse(await fs.readFile(path.join(DATA, "sp500.json"), "utf8"));
  let companies = universe.companies;
  if (LIMIT) companies = companies.slice(0, LIMIT);
  console.log(`Refreshing ${companies.length} companies\n`);

  /* --- upcoming earnings, one bulk call ---------------------------------- */
  const today = new Date();
  const runSession = sessionDate(today);
  const horizon = new Date(today.getTime() + 200 * 864e5);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const cal = await finnhub(`/calendar/earnings?from=${fmt(today)}&to=${fmt(horizon)}`);
  const earnings = new Map();
  const todayStr = fmt(today);

  /* Finnhub returns calendar rows in no particular order and a company can have
     several scheduled dates in the window — keep the soonest one that has not
     already happened, or the card advertises next February's report. */
  /* The scheduled run starts after the close, so anything dated today has
     already reported; carrying it for another day made every view disagree
     about whether it was "next". A manual run earlier in the day keeps it
     unless the actuals are already in. */
  const afterClose = today.getUTCHours() >= 21;
  const remember = (row) => {
    /* Vendor text ends up on the page, so only well-formed values get in. */
    if (typeof row?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date < todayStr) return;
    if (row.date === todayStr && (afterClose || numOrNull(row.epsActual) !== null)) return;
    const held = earnings.get(row.symbol);
    if (held && held.date <= row.date) return;
    earnings.set(row.symbol, {
      date: row.date,
      epsEst: numOrNull(row.epsEstimate),
      revEst: numOrNull(row.revenueEstimate),
      hour: ["bmo", "amc", "dmh"].includes(row.hour) ? row.hour : null,
      /* the fiscal quarter being reported, e.g. Q3 2026 — not the calendar one */
      q: numOrNull(row.quarter), fy: numOrNull(row.year)
    });
  };

  for (const e of cal?.earningsCalendar || []) remember(e);
  console.log(`Earnings calendar: ${earnings.size} symbols\n`);

  /* --- SEC XBRL frames ---------------------------------------------------- */
  const year = today.getUTCFullYear();
  console.log("Loading SEC XBRL frames...");
  const frames = await loadFrames(Array.from({ length: HISTORY_YEARS }, (_, i) => year - 1 - i));
  console.log(`Frames cover ${frames.size} filers\n`);

  await fs.mkdir(FILING_DIR, { recursive: true });
  await fs.mkdir(DETAIL_DIR, { recursive: true });
  let analystSpent = 0, analystOk = 0, analystEmpty = 0;

  const stocks = [];
  const skipped = [];
  let filingsFetched = 0, filingsCached = 0, reparsed = 0;
  const fundCount = { fetched: 0, cached: 0, stale: 0, frames: 0 };
  await fs.mkdir(FUND_DIR, { recursive: true });

  const renamed = [];
  const inIndex = new Set(universe.companies.map((x) => x.t));   /* every class, even on a LIMIT run */
  const later = laterClasses(universe.companies);
  const quoteSessions = new Map();     /* session -> how many quotes are stamped with it */

  /* Last night's snapshot. Its ratios, for a company whose /stock/metric
     call fails tonight (see carriedRatios). And its filing links, by CIK,
     for a company whose SEC submissions index does not load tonight (a
     rate-limit block, a 5xx, a timeout): only a downloaded index changes
     the links, as the financials stay when companyfacts fails, and the
     cached 10-K reading below still matches them. */
  const prior = await fs.readFile(path.join(DATA, "snapshot.json"), "utf8").then(JSON.parse).catch(() => null);
  const priorSession = prior?.session || (prior?.updated ? sessionDate(prior.updated) : null);
  const priorRows = new Map((prior?.stocks || []).filter((s) => s?.t).map((s) => [s.t, s]));
  const priorSec = new Map((prior?.stocks || []).filter((s) => s?.cik && s.sec).map((s) => [s.cik, s.sec]));
  const ratiosCarried = [], ratiosLost = [];
  let filingsCarried = 0;

  const market = (t) => Promise.all([
    finnhub(`/quote?symbol=${encodeURIComponent(t)}`),
    finnhub(`/stock/metric?metric=all&symbol=${encodeURIComponent(t)}`)
  ]);
  const quoted = (q) => q && numOrNull(q.c) && q.c !== 0;

  for (let i = 0; i < companies.length; i++) {
    let c = companies[i];
    const tag = `[${String(i + 1).padStart(3)}/${companies.length}] ${c.t}`;
    /* One company's malformed record (a bad timestamp, a null in an array)
       is that company skipped tonight, not all 500 frozen until someone
       edits the code. The audit still fails the run if too many go. */
    try {
      /* -- market data -- */
      let [quote, metricRes] = await market(c.t);

      if (!quoted(quote)) {
        const alt = renamedTo(c.t, await tickersForCik(c.cik), inIndex);
        const retry = alt ? await market(alt) : null;
        if (retry && quoted(retry[0])) {
          console.log(`${tag}  now trades as ${alt}: update data/sp500.json`);
          renamed.push({ from: c.t, to: alt });
          c = { ...c, t: alt };
          [quote, metricRes] = retry;
        } else {
          console.log(`${tag}  skipped (no quote)`);
          skipped.push(c.t);
          continue;
        }
      }
      const safeName = c.t.replace(/[^A-Z0-9.]/gi, "_");
      /* a failed request, or an answer with no figures in it: last night's
         figures, for a while */
      const failed = noRatios(metricRes);
      const carried = failed ? carriedRatios(priorRows.get(c.t), priorSession, runSession) : null;
      if (carried) ratiosCarried.push(c.t);
      else if (failed) ratiosLost.push(c.t);
      const m = carried?.metric || metricRes?.metric || {};

      /* The bulk calendar only carries dates that are already announced, which is
         a minority of the index at any moment. Ask per symbol for the rest, and
         also whenever the bulk answer is more than ~100 days out: a company
         that reports every quarter has a nearer date the bulk call skipped,
         and keeping the far one meant no alert for the real report. */
      const held = earnings.get(c.t);
      if (!held || (new Date(held.date) - today) / 864e5 > FAR_REPORT_DAYS) {
        const one = await finnhub(`/calendar/earnings?symbol=${encodeURIComponent(c.t)}&from=${fmt(today)}&to=${fmt(horizon)}`);
        for (const row of one?.earningsCalendar || []) remember({ ...row, symbol: c.t });
      }

      /* -- SEC filing history -- */
      const sub = await sec(`${SEC_DATA}/submissions/CIK${c.cik}.json`, `submissions ${c.t}`);
      let tenK = sub ? filingFromSubmissions(sub, c.cik, "10-K") : null;
      let tenQ = sub ? filingFromSubmissions(sub, c.cik, "10-Q") : null;
      const was = !sub && priorSec.get(c.cik);
      if (was && (was.tenK || was.tenQ)) {
        tenK = was.tenK || null;
        tenQ = was.tenQ || null;
        filingsCarried++;
      }

      /* -- 10-K contents, cached by accession -- */
      let detail = null;
      const cachePath = path.join(FILING_DIR, safeName + ".json");
      if (tenK) {
        let cached = null;
        try { cached = JSON.parse(await fs.readFile(cachePath, "utf8")); } catch { /* first run */ }
        const sameFiling = cached?.accession === tenK.accession;
        if (sameFiling && cached.v === PARSER_VERSION) {
          detail = cached.detail;
          filingsCached++;
        } else if (sameFiling && (SKIP_FILINGS || reparsed >= REPARSE_BUDGET)) {
          /* older parser's reading of the right filing; re-read on a later night */
          detail = cached.detail;
          filingsCached++;
        } else if (!SKIP_FILINGS) {
          if (sameFiling) reparsed++;
          const read = await fetchFilingDetail(c.t, tenK);
          if (read !== undefined) {
            /* Written even when nothing could be read, tied to this accession, so
               the page never shows last year's text under this year's link and a
               filing that cannot be parsed is not downloaded again every night. */
            detail = read;
            await fs.writeFile(cachePath, JSON.stringify({ accession: tenK.accession, v: PARSER_VERSION, detail }));
            filingsFetched++;
          }
        }
      }

      /* ---- financials: the company's own filings, frames only as a fallback ---- */
      const fund = await fundamentalsFor(c, tenK, safeName);
      let fin, history, finFy, sharesRestated = false;
      if (fund) {
        fundCount[fund.how]++;
        ({ fin, history, fy: finFy } = fund.out);
        sharesRestated = !!fund.out.sharesRestated;
      } else {
        fundCount.frames++;
        const f = frames.get(c.cik) || {};
        const yr = (k) => f[k]?.[year - 1] ?? null;
        const prev = (k) => f[k]?.[year - 2] ?? null;
        finFy = year - 1;
        const ocf = yr("ocf"), capex = yr("capex");
        fin = {
          revenue: yr("revenue"), revenuePrev: prev("revenue"),
          netIncome: yr("netIncome"), netIncomePrev: prev("netIncome"),
          assets: yr("assets"), liabs: yr("liabs"), equity: yr("equity"),
          cash: yr("cash"), debt: yr("debt"),
          ocf, capex,
          fcf: ocf !== null && capex !== null ? ocf - capex : null,
          fy: finFy
        };
        history = {};
        for (const concept of FRAME_CONCEPTS) {
          const row = {};
          for (let k = 0; k < HISTORY_YEARS; k++) {
            const v = f[concept.key]?.[finFy - k];
            if (v !== undefined && v !== null) row[finFy - k] = v;
          }
          if (Object.keys(row).length) history[concept.key] = row;
        }
      }

      /* Average profit and revenue over the years on file (three at least), for
         companies whose profits follow commodity prices: lib/analysis.mjs reads
         them on half the latest year and half this average. */
      if (fin) {
        const yrs = Object.keys(history?.netIncome || {}).filter((y) => numOrNull(history.revenue?.[y]) !== null);
        if (yrs.length >= 3) {
          fin.niAvg = Math.round(yrs.reduce((a, y) => a + history.netIncome[y], 0) / yrs.length);
          fin.revAvg = Math.round(yrs.reduce((a, y) => a + history.revenue[y], 0) / yrs.length);
          fin.avgYears = yrs.length;
        }
      }

      /* ---- price history and the analyst view, written per company ---- */
      const detailPath = path.join(DETAIL_DIR, safeName + ".json");
      let priorDetail = null;
      try { priorDetail = JSON.parse(await fs.readFile(detailPath, "utf8")); } catch { /* first run */ }

      /* No weekly chart is kept either. CRH's detail file held one ending
         2026-10-08; carried forward, it would outrank the nightly closes
         (lib/insight.mjs priceSeries) and hold its chart, trend and drawdown
         at that date for good. */
      const chart = null;

      /* Our own record of the close, one point per session. This is what the
         price chart is drawn from; it grows by a point a night. */
      const session = quote.t ? sessionDate(new Date(quote.t * 1000)) : runSession;
      if (quote.t && session) quoteSessions.set(session, (quoteSessions.get(session) || 0) + 1);
      const closes = (priorDetail?.closes || []).filter((p) => p[0] !== session);
      if (session && numOrNull(quote.c)) closes.push([session, +quote.c.toFixed(4)]);
      closes.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (closes.length > MAX_CLOSES) closes.splice(0, closes.length - MAX_CLOSES);

      const ageOf = (stamp) => (stamp ? (Date.now() - new Date(stamp)) / 864e5 : Infinity);
      let analyst   = priorDetail?.analyst || null;
      let analystAt = priorDetail?.analystAt || null;
      let analystMissAt = priorDetail?.analystMissAt || null;

      /* Two clocks: fresh data ages out after its jittered TTL, and a ticker that
         came back empty backs off for a couple of days instead of being retried
         every single run — which is what quietly ate the old budget. */
      const missCooled = ageOf(analystMissAt) > ANALYST_MISS_TTL;
      const due = missCooled && (analyst ? ageOf(analystAt) > analystTtl(c.t) : true);

      if (due && analystSpent < ANALYST_BUDGET) {
        const fresh = await analystView(c.t);
        analystSpent++;
        if (fresh) {
          analyst = fresh; analystAt = new Date().toISOString(); analystMissAt = null;
          analystOk++;
        } else {
          analystMissAt = new Date().toISOString();
          analystEmpty++;
          console.warn(`  ! ${c.t}: analyst view came back empty`);
        }
      }

      /* Share-class sanity: another class's price range or per-share figures
         (Berkshire B carried Class A's) are dropped rather than published,
         and a later class of a company has no range of its own (laterClasses). */
      const px = numOrNull(quote.c);
      const peNow = pickMetric(m, "peTTM", "peBasicExclExtraTTM", "peAnnual");
      const annualEps = px && peNow && peNow > 0 ? px / peNow : null;
      let lo = pickMetric(m, "52WeekLow"), hi = pickMetric(m, "52WeekHigh");
      if (later.has(companies[i].t)) lo = hi = null;
      if (lo !== null && hi !== null && px && (px < lo * 0.5 || px > hi * 2)) {
        console.warn(`  ! ${c.t}: 52-week range ${lo}–${hi} does not fit a ${px} price; dropped`);
        lo = hi = null;
      }
      let nextReport = earnings.get(c.t) || null;
      if (nextReport && !plausibleEps(nextReport.epsEst, annualEps)) {
        console.warn(`  ! ${c.t}: EPS estimate ${nextReport.epsEst} is implausible against ${annualEps?.toFixed(2)} trailing; dropped`);
        nextReport = { ...nextReport, epsEst: null, revEst: null };
      }
      if (analyst?.earnings?.length) {
        const kept = analyst.earnings.filter((e) => plausibleEps(e.actual, annualEps) && plausibleEps(e.estimate, annualEps));
        if (kept.length !== analyst.earnings.length) {
          console.warn(`  ! ${c.t}: dropped ${analyst.earnings.length - kept.length} implausible EPS surprise rows`);
          analyst = { ...analyst, earnings: kept };
        }
      }

      await fs.writeFile(detailPath, JSON.stringify({
        t: c.t, updated: new Date().toISOString(),
        fy: finFy, history, sharesRestated, chart, closes, analyst, analystAt, analystMissAt
      }));

      stocks.push({
        t: c.t, n: c.n, s: c.s, cik: c.cik,

        price:  numOrNull(quote.c),
        change: numOrNull(quote.dp),
        open:   numOrNull(quote.o),
        prev:   numOrNull(quote.pc),

        mc:   pickMetric(m, "marketCapitalization"),
        pe:   peNow,
        pb:   pickMetric(m, "pbQuarterly", "pbAnnual"),
        ps:   pickMetric(m, "psTTM", "psAnnual"),
        roe:  pickMetric(m, "roeTTM", "roeRfy"),
        roa:  pickMetric(m, "roaTTM", "roaRfy"),
        nm:   pickMetric(m, "netProfitMarginTTM", "netProfitMarginAnnual"),
        gm:   pickMetric(m, "grossMarginTTM", "grossMarginAnnual"),
        om:   pickMetric(m, "operatingMarginTTM", "operatingMarginAnnual"),
        rg:   pickMetric(m, "revenueGrowthTTMYoy", "revenueGrowthQuarterlyYoy"),
        rg5:  pickMetric(m, "revenueGrowth5Y"),
        eg:   pickMetric(m, "epsGrowthTTMYoy", "epsGrowthQuarterlyYoy"),
        beta: pickMetric(m, "beta"),
        lo, hi,
        dy:   pickMetric(m, "dividendYieldIndicatedAnnual", "currentDividendYieldTTM"),
        payout: pickMetric(m, "payoutRatioTTM", "payoutRatioAnnual"),
        de:   pickMetric(m, "totalDebt/totalEquityQuarterly", "totalDebt/totalEquityAnnual"),
        cr:   pickMetric(m, "currentRatioQuarterly", "currentRatioAnnual"),
        r13:  pickMetric(m, "13WeekPriceReturnDaily"),
        r26:  pickMetric(m, "26WeekPriceReturnDaily"),
        r52:  pickMetric(m, "52WeekPriceReturnDaily"),

        /* more figures for the card's number grid. Forward P/E, five-year EPS
           growth and interest cover also feed the score (value, growth and
           stability), and the gap to the S&P 500 sets off one of the cons; the
           rest are shown only. */
        pef:      pickMetric(m, "forwardPE", "peForward", "forwardPeTTM"),
        pfcf:     pickMetric(m, "pfcfShareTTM", "pfcfShareAnnual"),
        evEbitda: pickMetric(m, "evEbitdaTTM", "evEbitdaAnnual", "currentEv/ebitdaTTM"),
        qr:       pickMetric(m, "quickRatioQuarterly", "quickRatioAnnual"),
        ic:       pickMetric(m, "netInterestCoverageTTM", "netInterestCoverageAnnual"),
        eg5:      pickMetric(m, "epsGrowth5Y"),
        dg5:      pickMetric(m, "dividendGrowthRate5Y"),
        ytd:      pickMetric(m, "yearToDatePriceReturnDaily"),
        rs52:     pickMetric(m, "priceRelativeToS&P50052Week"),
        vol:      pickMetric(m, "10DayAverageTradingVolume", "3MonthAverageTradingVolume"),
        /* only when the figures above are an earlier night's (carriedRatios) */
        ...(carried ? { ratiosFrom: carried.from } : {}),

        earnings: nextReport,

        fin,

        /* the 10-K prose lives in data/filings/<TICKER>.json and is lazy-loaded by
           the page — keeping it out of the snapshot keeps first paint fast */
        sec: {
          tenK: tenK && { date: tenK.date, period: tenK.period, url: tenK.url, index: tenK.index, accession: tenK.accession },
          tenQ: tenQ && { date: tenQ.date, period: tenQ.period, url: tenQ.url, index: tenQ.index },
          detail: !!(detail?.business || detail?.risks?.length)
        },

        /* deep data lives in data/detail/<TICKER>.json, opened on tap */
        /* chart: price history to draw, counted as priceSeries and
           audit.mjs count it (five closes at least) */
        deep: { chart: closes.length >= 5, analyst: !!analyst, years: Object.keys(history.revenue || {}).length }
      });

    } catch (err) {
      console.warn(`${tag}  skipped (${oneLine(err.message)})`);
      skipped.push(c.t);
      continue;
    }

    if ((i + 1) % 25 === 0 || i === companies.length - 1) {
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`${tag}  ok  (${stocks.length} built, ${mins} min elapsed)`);
    }
  }

  const withFilings = stocks.filter((s) => s.sec.detail).length;
  const withCharts = stocks.filter((s) => s.deep.chart).length;
  const withAnalyst = stocks.filter((s) => s.deep.analyst).length;
  const snapSession = quotedSession(quoteSessions, runSession);
  const snapshot = {
    updated: new Date().toISOString(),
    session: snapSession,
    universe: "S&P 500",
    counts: {
      companies: stocks.length,
      skipped: skipped.length,
      withEarningsDate: stocks.filter((s) => s.earnings).length,
      withFilings,
      withFinancials: stocks.filter((s) => s.fin.revenue !== null).length,
      withCharts, withAnalyst
    },
    skipped,
    renamed,
    stocks
  };

  /* A LIMIT run only touches the companies it processed. Merging rather than
     replacing means a six-company smoke test can never wipe the other 495 —
     which is exactly what it did once before this guard existed. */
  if (LIMIT) {
    const prior = await fs.readFile(path.join(DATA, "snapshot.json"), "utf8")
      .then(JSON.parse).catch(() => null);
    if (prior?.stocks?.length) {
      const fresh = new Map(stocks.map((s) => [s.t, s]));
      snapshot.stocks = prior.stocks.map((s) => fresh.get(s.t) || s);
      for (const s of stocks) if (!prior.stocks.some((p) => p.t === s.t)) snapshot.stocks.push(s);
      /* yesterday's skips, minus the tickers this run just looked at again */
      const looked = new Set(companies.map((c) => c.t));
      snapshot.skipped = [...new Set([...(prior.skipped || []).filter((t) => !looked.has(t)), ...skipped])];
      const all = snapshot.stocks;
      snapshot.counts = {
        companies: all.length,
        skipped: snapshot.skipped.length,
        withEarningsDate: all.filter((s) => s.earnings).length,
        withFilings: all.filter((s) => s.sec?.detail).length,
        withFinancials: all.filter((s) => s.fin?.revenue !== null && s.fin?.revenue !== undefined).length,
        withCharts: all.filter((s) => s.deep?.chart).length,
        withAnalyst: all.filter((s) => s.deep?.analyst).length,
        partialRun: stocks.length
      };
      console.log(`Limited run: merged ${stocks.length} companies into the existing ${prior.stocks.length}.`);
    }
  }

  /* Only on a night that needed it, so an ordinary night's counts are as
     before. The audit warns on it: a lasting SEC refusal must still show. */
  if (filingsCarried) snapshot.counts.filingsCarried = filingsCarried;

  await fs.writeFile(path.join(DATA, "snapshot.json"), JSON.stringify(snapshot));
  console.log(
    `\nDone in ${((Date.now() - started) / 60000).toFixed(1)} min\n` +
    `  ${stocks.length} companies, ${skipped.length} skipped${skipped.length ? ` (${skipped.join(", ")})` : ""}\n` +
    `  ${snapshot.counts.withFinancials} with SEC financials, ${withFilings} with 10-K contents\n` +
    `  ${withCharts} with a price chart, ${withAnalyst} with an analyst view
` +
    `  analyst calls: ${analystSpent} attempted, ${analystOk} returned data, ${analystEmpty} came back empty
` +
    `  10-Ks: ${filingsFetched} downloaded, ${filingsCached} from cache, ` +
      `${filingsCarried} kept last night's links (their SEC submissions index did not load)
` +
    `  ratios: ${ratiosCarried.length + ratiosLost.length} failed to load (Finnhub /stock/metric), ` +
      `${ratiosCarried.length} kept from an earlier night, ${ratiosLost.length} left blank${ratiosLost.length ? ` (${ratiosLost.slice(0, 25).join(", ")}${ratiosLost.length > 25 ? ", …" : ""})` : ""}
` +
    `  financials: ${fundCount.fetched} fetched, ${fundCount.cached} cached, ${fundCount.stale} carried over, ${fundCount.frames} from frames` +
    (snapSession !== runSession ? `\n  filed under the ${snapSession} session, the one most quotes are stamped with, not the run's date (${runSession})` : "")
  );
}

/* Pure pieces are exported for tests; the refresh runs only when this file
   is called directly. */
/* the file's real path: argv keeps a symlinked path, import.meta.url does not */
const calledDirectly = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (calledDirectly) {
  if (!TOKEN) {
    console.error("FINNHUB_TOKEN is not set. Add it under Settings -> Secrets and variables -> Actions.");
    process.exit(1);
  }
  main().catch((err) => { console.error(err); process.exit(1); });
}
