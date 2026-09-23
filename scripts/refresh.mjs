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
import path from "node:path";

const ROOT       = path.resolve(import.meta.dirname, "..");
const DATA       = path.join(ROOT, "data");
const FILING_DIR = path.join(DATA, "filings");
const DETAIL_DIR = path.join(DATA, "detail");

const TOKEN = process.env.FINNHUB_TOKEN;
const UA    = process.env.SEC_USER_AGENT || "StockOrNot open-source project contact@example.com";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 0;
const SKIP_FILINGS = process.env.SKIP_FILINGS === "1";

/* Bump when the 10-K parser changes so cached extractions are redone once. */
const PARSER_VERSION = 3;

/* Recommendation trends move monthly, so a slice of the index each night keeps
   every company under a week old without doubling the run time. */
const ANALYST_TTL_DAYS = 6;
const ANALYST_MISS_TTL = 2;    /* a ticker that came back empty waits this long */
const ANALYST_BUDGET   = 520;  /* high enough to fill the whole index in one run */

/* Every ticker starts stale, so the first run fetches all 501. Left at a flat
   TTL they would then all come due again on the same day, spiking one run a
   week. A fixed per-ticker offset spreads the re-fetches instead: each run
   picks up roughly a tenth of the index. */
function analystTtl(ticker) {
  let h = 0;
  for (let i = 0; i < ticker.length; i++) h = (h * 31 + ticker.charCodeAt(i)) >>> 0;
  return ANALYST_TTL_DAYS + (h % 6);   /* 6-11 days */
}

if (!TOKEN) {
  console.error("FINNHUB_TOKEN is not set. Add it under Settings -> Secrets and variables -> Actions.");
  process.exit(1);
}

/* ----------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const chartGate   = limiter(5);        /* charts are optional, so pace them and
                                          never let retries stall the run */

async function getJSON(url, { headers = {}, gate, tries = 3, label = "" } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (gate) await gate();
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) { await sleep(2000 * attempt); continue; }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === tries) {
        console.warn(`  ! ${label || url}: ${err.message}`);
        return null;
      }
      await sleep(700 * attempt);
    }
  }
  return null;
}

async function getText(url, { headers = {}, gate, label = "" } = {}) {
  if (gate) await gate();
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    console.warn(`  ! ${label || url}: ${err.message}`);
    return null;
  }
}

const finnhub = (p) =>
  getJSON(`https://finnhub.io/api/v1${p}${p.includes("?") ? "&" : "?"}token=${TOKEN}`,
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
        const url = `https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/${unit}/${period}.json`;
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

/* Frames are organised by calendar year, so a filer whose fiscal year ends in
   August or November shows up in none of them. For those, ask for the concept
   directly and take the most recent annual figure they actually reported. */
async function conceptFallback(cik, concept) {
  for (const tag of concept.tags) {
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`;
    const json = await sec(url, `concept ${tag}`);
    const units = json?.units?.[concept.unit || "USD"];
    if (!units?.length) continue;

    const annual = units.filter((u) => {
      if (u.form !== "10-K" || !u.end) return false;
      if (concept.kind === "instant") return !u.start;
      if (!u.start) return false;
      const days = (new Date(u.end) - new Date(u.start)) / 864e5;
      return days > 300 && days < 400;          /* a full year, not a quarter */
    });
    if (!annual.length) continue;

    annual.sort((a, b) => (a.end < b.end ? 1 : -1));
    const byYear = {};
    for (const u of annual) {
      const y = Number(u.end.slice(0, 4));
      if (byYear[y] === undefined) byYear[y] = numOrNull(u.val);
    }
    const latest = annual[0];
    const latestYear = Number(latest.end.slice(0, 4));
    return {
      value: numOrNull(latest.val),
      prior: byYear[latestYear - 1] ?? null,
      series: byYear,
      fy: latestYear
    };
  }
  return null;
}

/* --------------------------------------------------- price history (Stooq)
   Finnhub paywalls its candle endpoint. Stooq serves free daily OHLC as CSV and
   has no CORS headers — which does not matter here, because this runs on a
   server rather than in the browser. Weekly closes keep the file small enough
   to ship one per company. */

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* Yahoo's chart endpoint gives weekly closes in one request and needs no key.
   Stooq is the backstop; between them almost every ticker resolves. */
async function fromYahoo(ticker) {
  const sym = ticker.replace(/\./g, '-');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1wk`;
  const json = await getJSON(url, { headers: { 'User-Agent': BROWSER_UA }, gate: chartGate, tries: 1, label: `yahoo ${ticker}` });
  const res = json?.chart?.result?.[0];
  const stamps = res?.timestamp;
  const closes = res?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(stamps) || !Array.isArray(closes)) return null;

  const points = [];
  for (let i = 0; i < stamps.length; i++) {
    const c = closes[i];
    if (typeof c !== 'number' || !isFinite(c) || c <= 0) continue;
    points.push([new Date(stamps[i] * 1000).toISOString().slice(0, 10), +c.toFixed(2)]);
  }
  return points.length > 20 ? points : null;
}

async function fromStooq(ticker) {
  const sym = ticker.toLowerCase().replace(/\./g, '-') + '.us';
  const csv = await getText(`https://stooq.com/q/d/l/?s=${sym}&i=w`, {
    headers: { 'User-Agent': BROWSER_UA }, gate: chartGate, label: `stooq ${ticker}`
  });
  if (!csv || csv.length < 200 || /No data|Exceeded/i.test(csv.slice(0, 120))) return null;

  const lines = csv.trim().split(/\r?\n/);
  const head = lines[0].toLowerCase().split(',');
  const iDate = head.indexOf('date'), iClose = head.indexOf('close');
  if (iDate === -1 || iClose === -1) return null;

  const cutoff = new Date(Date.now() - 5.2 * 365 * 864e5).toISOString().slice(0, 10);
  const points = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const date = cols[iDate], close = Number(cols[iClose]);
    if (!date || date < cutoff || !isFinite(close) || close <= 0) continue;
    points.push([date, +close.toFixed(2)]);
  }
  return points.length > 20 ? points : null;
}

async function priceHistory(ticker) {
  return (await fromYahoo(ticker)) || (await fromStooq(ticker));
}

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

const stripTags = (html) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&#8217;|&rsquo;/gi, "’")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#8212;|&mdash;/gi, "—").replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

/* 10-K markup is wildly inconsistent between filers. Normalising the invisible
   whitespace entities first is what makes "Item&#160;1A." findable at all. */
function normalizeHtml(html) {
  return html.replace(/&nbsp;|&#160;|&#xa0;|&#xA0;/g, " ");
}

/* Build a regex for an Item heading that tolerates tags and entities appearing
   between every single token — "Item", "1A", the punctuation and the word. */
function itemRe(number, word, flags) {
  const gap = "(?:\\s|<[^>]*>)*";
  return new RegExp(`item${gap}${number}${gap}[.:\\-—]?${gap}${word}`, flags);
}

/** Slice the HTML between two Item headings, skipping the table of contents. */
function sliceItem(html, startRe, endRe, minLen = 1500) {
  const starts = [...html.matchAll(startRe)].map((m) => m.index);
  if (!starts.length) return null;
  /* the ToC mention comes first and is followed almost immediately by the next
     item, so prefer the start with the longest run of content after it */
  let best = null;
  for (const s of starts) {
    const rest = html.slice(s);
    const e = rest.search(endRe);
    const len = e === -1 ? rest.length : e;
    if (len > minLen && (!best || len > best.len)) best = { s, len };
  }
  if (!best) return null;
  return html.slice(best.s, best.s + Math.min(best.len, 1200000));
}

const BOILERPLATE = /^(table of contents|part\s+[ivx]+|item\s+\d|risk factors?|forward-looking|see also|index)/i;

function usableHeading(text) {
  if (text.length < 35 || text.length > 230) return false;
  if (!/[a-z]/.test(text)) return false;              /* skip ALL-CAPS chrome */
  if (BOILERPLATE.test(text)) return false;
  if (!/\s/.test(text)) return false;
  return true;
}

/** Risk-factor headings: bold/italic tags, or spans styled bold. */
function headingsFrom(chunk) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const text = stripTags(raw);
    if (!usableHeading(text)) return;
    const key = text.toLowerCase().slice(0, 60);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text.replace(/\s*[.;:]\s*$/, ""));
  };

  let m;
  const tagRe = /<(b|strong|em|i)[^>]*>([\s\S]{0,800}?)<\/\1>/gi;
  while ((m = tagRe.exec(chunk)) !== null && out.length < 14) push(m[2]);

  if (out.length < 3) {
    /* many filers style headings inline instead of using <b> */
    const styleRe = /<(span|p|div)[^>]*style="[^"]*font-(?:weight|style)\s*:\s*(?:bold|700|800|italic)[^"]*"[^>]*>([\s\S]{0,800}?)<\/\1>/gi;
    while ((m = styleRe.exec(chunk)) !== null && out.length < 14) push(m[2]);
  }

  if (out.length < 3) {
    /* last resort: pull sentences that actually state a risk */
    const text = stripTags(chunk);
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      const t = s.trim().replace(/\s*[.;:]\s*$/, "");
      if (t.length < 60 || t.length > 230) continue;
      if (!/\b(could|may|might|risk|adversely|failure|unable|depend)\b/i.test(t)) continue;
      if (BOILERPLATE.test(t)) continue;
      const key = t.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= 10) break;
    }
  }

  return out;
}

async function fetchFilingDetail(ticker, tenK) {
  if (!tenK?.url) return null;
  const raw = await getText(tenK.url, { headers: { 'User-Agent': UA }, gate: secGate, label: `10-K ${ticker}` });
  if (!raw || raw.length < 5000) return null;
  const html = normalizeHtml(raw);

  const bizChunk = sliceItem(html, itemRe('1', 'business', 'gi'), itemRe('1a', 'risk', 'i'));

  /* Three passes, each looser than the last. Filers are inconsistent enough
     that no single pattern finds the risk section in all 500 documents. */
  let riskChunk =
    sliceItem(html, itemRe('1a', 'risk', 'gi'), itemRe('(?:1b|2)', '[a-z]', 'i')) ||
    sliceItem(html, /risk\s*factors/gi, itemRe('(?:1b|2)', '[a-z]', 'i'), 800) ||
    sliceItem(html, itemRe('1a', 'risk', 'gi'), /item(?:\s|<[^>]*>)*(?:1b|2)/i, 800);

  if (!riskChunk) {
    /* nothing bounded the section — take a slab after the last heading and let
       the heading filter sort it out */
    const hits = [...html.matchAll(/risk\s*factors/gi)].map((m) => m.index);
    if (hits.length) riskChunk = html.slice(hits[hits.length - 1], hits[hits.length - 1] + 300000);
  }

  let business = null;
  if (bizChunk) {
    const text = stripTags(bizChunk)
      .replace(/^item\s*1\s*[.:\-—]?\s*business[\s.:-]*/i, '')
      .replace(/^general[\s.:-]*/i, '');
    business = text.slice(0, 950).replace(/\s+\S*$/, '') + (text.length > 950 ? '…' : '');
    if (business.length < 120) business = null;
  }

  const risks = riskChunk ? headingsFrom(riskChunk) : [];

  if (!business && !risks.length) return null;
  return { business, risks, source: tenK.url };
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
  const horizon = new Date(today.getTime() + 200 * 864e5);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const cal = await finnhub(`/calendar/earnings?from=${fmt(today)}&to=${fmt(horizon)}`);
  const earnings = new Map();
  const todayStr = fmt(today);

  /* Finnhub returns calendar rows in no particular order and a company can have
     several scheduled dates in the window — keep the soonest one that has not
     already happened, or the card advertises next February's report. */
  const remember = (row) => {
    if (!row?.date || row.date < todayStr) return;
    const held = earnings.get(row.symbol);
    if (held && held.date <= row.date) return;
    earnings.set(row.symbol, {
      date: row.date,
      epsEst: numOrNull(row.epsEstimate),
      revEst: numOrNull(row.revenueEstimate),
      hour: row.hour || null,
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
  let analystSpent = 0, chartsOk = 0, analystOk = 0, analystEmpty = 0;

  const stocks = [];
  const skipped = [];
  let filingsFetched = 0, filingsCached = 0, fellBack = 0;

  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    const tag = `[${String(i + 1).padStart(3)}/${companies.length}] ${c.t}`;
    const safeName = c.t.replace(/[^A-Z0-9.]/gi, "_");

    /* -- market data -- */
    const [quote, metricRes] = await Promise.all([
      finnhub(`/quote?symbol=${encodeURIComponent(c.t)}`),
      finnhub(`/stock/metric?metric=all&symbol=${encodeURIComponent(c.t)}`)
    ]);

    if (!quote || !numOrNull(quote.c) || quote.c === 0) {
      console.log(`${tag}  skipped (no quote)`);
      skipped.push(c.t);
      continue;
    }
    const m = metricRes?.metric || {};

    /* The bulk calendar only carries dates that are already announced, which is
       a minority of the index at any moment. Ask per symbol for the rest. */
    if (!earnings.has(c.t)) {
      const one = await finnhub(`/calendar/earnings?symbol=${encodeURIComponent(c.t)}&from=${fmt(today)}&to=${fmt(horizon)}`);
      for (const row of one?.earningsCalendar || []) remember({ ...row, symbol: c.t });
    }

    /* -- SEC filing history -- */
    const sub = await sec(`https://data.sec.gov/submissions/CIK${c.cik}.json`, `submissions ${c.t}`);
    const tenK = sub ? filingFromSubmissions(sub, c.cik, "10-K") : null;
    const tenQ = sub ? filingFromSubmissions(sub, c.cik, "10-Q") : null;

    /* -- 10-K contents, cached by accession -- */
    let detail = null;
    const cachePath = path.join(FILING_DIR, safeName + ".json");
    if (tenK) {
      let cached = null;
      try { cached = JSON.parse(await fs.readFile(cachePath, "utf8")); } catch { /* first run */ }
      if (cached?.accession === tenK.accession && cached.v === PARSER_VERSION) {
        detail = cached.detail;
        filingsCached++;
      } else if (!SKIP_FILINGS) {
        detail = await fetchFilingDetail(c.t, tenK);
        if (detail) {
          await fs.writeFile(cachePath, JSON.stringify({ accession: tenK.accession, v: PARSER_VERSION, detail }));
          filingsFetched++;
        }
      }
    }

    const f = frames.get(c.cik) || {};
    let yr = (k) => f[k]?.[year - 1] ?? null;
    let prev = (k) => f[k]?.[year - 2] ?? null;
    let finFy = year - 1;

    /* A filer with a non-calendar fiscal year appears in no CY frame. Ask for
       its concepts directly rather than showing a card with no financials. */
    const directSeries = {};
    if (yr("revenue") === null) {
      const direct = {};
      for (const concept of FRAME_CONCEPTS) {
        const hit = await conceptFallback(c.cik, concept);
        if (hit) {
          direct[concept.key] = hit;
          if (hit.series) directSeries[concept.key] = hit.series;
          finFy = hit.fy || finFy;
        }
      }
      if (Object.keys(direct).length) {
        yr = (k) => direct[k]?.value ?? f[k]?.[year - 1] ?? null;
        prev = (k) => direct[k]?.prior ?? f[k]?.[year - 2] ?? null;
        fellBack++;
      }
    }

    const ocf = yr("ocf"), capex = yr("capex");

    /* ---- multi-year history for the detail sheet ---- */
    const histYears = Array.from({ length: HISTORY_YEARS }, (_, k) => finFy - k);
    const history = {};
    for (const concept of FRAME_CONCEPTS) {
      const row = {};
      for (const y of histYears) {
        const v = directSeries[concept.key]?.[y] ?? f[concept.key]?.[y];
        if (v !== undefined && v !== null) row[y] = v;
      }
      if (Object.keys(row).length) history[concept.key] = row;
    }

    /* ---- price history and the analyst view, written per company ---- */
    const detailPath = path.join(DETAIL_DIR, safeName + ".json");
    let priorDetail = null;
    try { priorDetail = JSON.parse(await fs.readFile(detailPath, "utf8")); } catch { /* first run */ }

    const chart = (await priceHistory(c.t)) || priorDetail?.chart || null;
    if (chart) chartsOk++;

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

    await fs.writeFile(detailPath, JSON.stringify({
      t: c.t, updated: new Date().toISOString(),
      fy: finFy, history, chart, analyst, analystAt, analystMissAt
    }));

    stocks.push({
      t: c.t, n: c.n, s: c.s, cik: c.cik,

      price:  numOrNull(quote.c),
      change: numOrNull(quote.dp),
      open:   numOrNull(quote.o),
      prev:   numOrNull(quote.pc),

      mc:   pickMetric(m, "marketCapitalization"),
      pe:   pickMetric(m, "peTTM", "peBasicExclExtraTTM", "peAnnual"),
      peF:  pickMetric(m, "peNormalizedAnnual"),
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
      lo:   pickMetric(m, "52WeekLow"),
      hi:   pickMetric(m, "52WeekHigh"),
      dy:   pickMetric(m, "dividendYieldIndicatedAnnual", "currentDividendYieldTTM"),
      payout: pickMetric(m, "payoutRatioTTM", "payoutRatioAnnual"),
      de:   pickMetric(m, "totalDebt/totalEquityQuarterly", "totalDebt/totalEquityAnnual"),
      cr:   pickMetric(m, "currentRatioQuarterly", "currentRatioAnnual"),
      r4:   pickMetric(m, "4WeekPriceReturnDaily"),
      r13:  pickMetric(m, "13WeekPriceReturnDaily"),
      r26:  pickMetric(m, "26WeekPriceReturnDaily"),
      r52:  pickMetric(m, "52WeekPriceReturnDaily"),

      /* second-look figures: shown on the card, not used by the score */
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

      earnings: earnings.get(c.t) || null,

      fin: {
        revenue:  yr("revenue"),  revenuePrev:  prev("revenue"),
        netIncome: yr("netIncome"), netIncomePrev: prev("netIncome"),
        assets: yr("assets"), liabs: yr("liabs"), equity: yr("equity"),
        cash: yr("cash"), debt: yr("debt"),
        ocf, capex,
        fcf: ocf !== null && capex !== null ? ocf - capex : null,
        fy: finFy
      },

      /* the 10-K prose lives in data/filings/<TICKER>.json and is lazy-loaded by
         the page — keeping it out of the snapshot keeps first paint fast */
      sec: {
        tenK: tenK && { date: tenK.date, period: tenK.period, url: tenK.url, index: tenK.index },
        tenQ: tenQ && { date: tenQ.date, period: tenQ.period, url: tenQ.url, index: tenQ.index },
        detail: !!(detail?.business || detail?.risks?.length)
      },

      /* deep data lives in data/detail/<TICKER>.json, opened on tap */
      deep: { chart: !!chart, analyst: !!analyst, years: Object.keys(history.revenue || {}).length }
    });

    if ((i + 1) % 25 === 0 || i === companies.length - 1) {
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`${tag}  ok  (${stocks.length} built, ${mins} min elapsed)`);
    }
  }

  const withFilings = stocks.filter((s) => s.sec.detail).length;
  const withCharts = stocks.filter((s) => s.deep.chart).length;
  const withAnalyst = stocks.filter((s) => s.deep.analyst).length;
  const snapshot = {
    updated: new Date().toISOString(),
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
      snapshot.counts.companies = snapshot.stocks.length;
      snapshot.counts.partialRun = stocks.length;
      snapshot.skipped = prior.skipped || [];
      console.log(`Limited run: merged ${stocks.length} companies into the existing ${prior.stocks.length}.`);
    }
  }

  await fs.writeFile(path.join(DATA, "snapshot.json"), JSON.stringify(snapshot));
  console.log(
    `\nDone in ${((Date.now() - started) / 60000).toFixed(1)} min\n` +
    `  ${stocks.length} companies, ${skipped.length} skipped${skipped.length ? ` (${skipped.join(", ")})` : ""}\n` +
    `  ${snapshot.counts.withFinancials} with SEC financials, ${withFilings} with 10-K contents\n` +
    `  ${withCharts} with a price chart, ${withAnalyst} with an analyst view
` +
    `  analyst calls: ${analystSpent} attempted, ${analystOk} returned data, ${analystEmpty} came back empty
` +
    `  10-Ks: ${filingsFetched} downloaded, ${filingsCached} from cache
` +
    `  ${fellBack} companies needed a direct XBRL lookup (non-calendar fiscal year)`
  );
}

main().catch((err) => { console.error(err); process.exit(1); });
