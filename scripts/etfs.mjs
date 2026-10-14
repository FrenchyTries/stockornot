/* ==========================================================================
   StockOrNot — the nightly ETF data
   --------------------------------------------------------------------------
   Runs in GitHub Actions after the company data has passed its audit (see
   .github/workflows/refresh.yml and docs/ETFS.md). Reads the hand-kept
   data/etf-list.json and writes three files, all data only:

     data/etfs.json        one record per fund: price, holdings matched to
                           our companies, cost, concentration, sector mix
     data/etf-closes.json  our own record of each fund's closing price, one
                           point per session, the way company charts are made
     data/lei.json         LEI -> CIK pairs learned from the S&P 500 trackers'
                           own filings. Only this job writes it; hand fixes go
                           in etf-list.json's leiFix, so a fix merged during
                           the two-hour run is never overwritten by it.

   Sources: the SEC (holdings from Form NPORT-P, expense ratios from the
   shareholder reports' inline XBRL) and the Finnhub key the company data
   already uses. Nothing from Yahoo, Stooq or any issuer's website, and no
   CUSIP or ISIN is ever read or written (scripts/nport.mjs).

   It must never cost the night's company data, so:
     - past 150 minutes into the job it does nothing; otherwise it gives
       itself the smaller of 12 minutes and the time left less 10;
     - SEC work comes first, leaving Finnhub's 60-a-minute window time to
       clear after the refresh step's last calls, and it has a deadline of
       its own, which even a request the SEC holds open does not outlive, so
       Finnhub's share of the step stays Finnhub's;
     - every file is written whole or not at all (.tmp, then rename);
     - yesterday's etfs.json stays if tonight priced or read far fewer funds
       (for five days at most: a drop that lasts becomes the new normal), and
       no first file is written without most funds' holdings.

   Pure pieces are exported for tests; main() runs only when this file is
   called directly, as track.mjs does. It cannot import refresh.mjs, which
   exits without a token and runs on load, so it has its own small gate.

   Env:
     FINNHUB_TOKEN    repo secret; without it prices are skipped
     SEC_USER_AGENT   SEC asks for "Name contact@example.com"
     JOB_STARTED      the job's start, in seconds (refresh.yml's first step)
     ETF_SKIP_PRICES  1 to skip Finnhub, for local runs without a key
     SEC_WWW, SEC_DATA, FINNHUB_API   only to point the job at mock servers
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sessionDate } from "./dates.mjs";
import {
  parseNport, checkFiling, matchHoldings, seedLeis, spreadOf, mixOf, readingOf, nameIndexOf
} from "./nport.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "..", "data");

/* --- time: refresh.yml's job limit is 180 minutes ------------------------ */
const JOB_LIMIT_MIN = 180;
const LATE_MIN = 150;      /* later than this, the step leaves everything as it was */
const STEP_MIN = 12;       /* inside the step's own 15-minute timeout */
const MARGIN_MIN = 10;     /* left for the pages check and the commit */

/* --- SEC cadence ---------------------------------------------------------- */
const CHECK_TTL = 6;               /* each fund asked every 6-11 days... */
const SEASON = [50, 80];           /* ...and every 2 days this many days after a quarter's end, */
const SEASON_TTL = 2;              /* when its next filing is due */
const REREAD_DAYS = 30;            /* re-read the same filing monthly, for index changes and renames */
const ER_TTL = 30;                 /* expense ratios: one look every 30-39 days */
const ER_BUDGET = 6;               /* shareholder-report downloads a night, at most */

const MAX_CLOSES = 1300;           /* five years of sessions, as for companies */
const MAX_TEXT = 25e6;             /* as refresh.mjs: anything larger is skipped */
const TIMEOUT_MS = 30_000;
const TICKER = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;
const LEI = /^[A-Z0-9]{18}[0-9]{2}$/;
const DAY = 864e5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Everything the job prints is one line, whatever it quotes. The Actions
   runner reads the log a line at a time and takes a line that starts with
   "::" as a workflow command, and "##[" anywhere in a line as the older form
   of one, so text from the SEC or Finnhub (a holding's name, an error
   quoting a reply that was not JSON) must never start one. */
const oneLine = (s) => String(s).replace(/[^\S ]|[\x00-\x1f\x7f-\x9f]/g, " ").replace(/##\[/g, "# #[");
const log = (s) => console.log(oneLine(s));
const warn = (s) => console.warn(oneLine(s));

const numOrNull = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const today = (now) => new Date(now).toISOString().slice(0, 10);
const days = (from, to) => (Date.parse(to) - Date.parse(from)) / DAY;
const bare = (cik) => String(Number(cik));
const noDash = (acc) => acc.replace(/-/g, "");

/* A fixed per-fund offset, as refresh.mjs's analystTtl, so the 53 funds do
   not all come due on the same night. */
function hashOf(t) {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return h;
}

/* ------------------------------------------------------------- the guard */

/**
 * How long tonight's ETF work may take. `started` is JOB_STARTED (seconds
 * since 1970). Late in the job it returns skip, and the company data commits
 * without waiting for funds. Without a start time (a local run) the step
 * just gets its own 12 minutes.
 */
export function timeGuard(started, now = Date.now()) {
  const s = Number(started);
  if (!started || !Number.isFinite(s) || s <= 0) return { skip: false, elapsed: null, budgetMs: STEP_MIN * 60e3 };
  const elapsed = (now - (s < 1e12 ? s * 1000 : s)) / 60e3;
  const budget = Math.min(STEP_MIN, JOB_LIMIT_MIN - elapsed - MARGIN_MIN);
  if (elapsed > LATE_MIN || budget <= 0) return { skip: true, elapsed, budgetMs: 0 };
  return { skip: false, elapsed, budgetMs: budget * 60e3 };
}

/* -------------------------------------------------------------- the list */

/**
 * Checks the hand-kept list. A fund is refused, and left out tonight, for a
 * malformed ticker, a duplicate, a ticker that is also an S&P 500 company
 * (the two kinds must never share an identity), or malformed SEC IDs. An
 * expense ratio is only taken with the SEC document it came from.
 */
export function loadList(raw, sp500Tickers = new Set()) {
  if (!raw || !Array.isArray(raw.funds)) throw new Error("data/etf-list.json has no funds list");
  const funds = [], refused = [], notes = [];
  const seen = new Set();
  for (const f of raw.funds) {
    const t = f?.t;
    const why =
      typeof t !== "string" || !TICKER.test(t) ? "malformed ticker" :
      seen.has(t) ? "listed twice" :
      sp500Tickers.has(t) ? "also an S&P 500 company" :
      typeof f.n !== "string" || !f.n.trim() ? "no name" :
      !/^\d{10}$/.test(f.trust || "") ? "malformed trust CIK" :
      f.series != null && !/^S\d{9}$/.test(f.series) ? "malformed series ID" :
      f.class != null && !/^C\d{9}$/.test(f.class) ? "malformed class ID" : null;
    if (why) { refused.push({ t: typeof t === "string" ? t : String(t), why }); continue; }
    seen.add(t);
    let { er = null, erUrl = null, erAsOf = null } = f;
    if (er !== null && !(typeof er === "number" && er >= 0 && er < 3 &&
        typeof erUrl === "string" && erUrl.startsWith("https://www.sec.gov/") &&
        /^\d{4}-\d{2}-\d{2}$/.test(erAsOf || ""))) {
      notes.push(`${t}: expense ratio ignored, it needs a number, an sec.gov URL and a date`);
      er = erUrl = erAsOf = null;
    }
    funds.push({
      t, n: f.n.trim(), issuer: f.issuer || null, trust: f.trust,
      series: f.series || null, class: f.class || null,
      seed: f.seed === true, uit: f.uit === true,
      er, erUrl: er === null ? null : erUrl, erAsOf: er === null ? null : erAsOf,
      since: Number.isInteger(f.since) ? f.since : null
    });
  }
  const leiFix = new Map();
  for (const [lei, cik] of Object.entries(raw.leiFix || {})) {
    if (!LEI.test(lei) || !(cik === null || /^\d{10}$/.test(cik))) { notes.push(`leiFix ${lei}: ignored, malformed`); continue; }
    leiFix.set(lei, cik);
  }
  return { funds, refused, leiFix, notes };
}

/* --------------------------------------------------------- SEC: when to ask */

/** The end of the month `quarters` quarters after a YYYY-MM-DD period end. */
export function nextPeriod(period, quarters = 1) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m + 3 * quarters, 0)).toISOString().slice(0, 10);
}

/**
 * Whether to ask the SEC tonight if the fund has a new N-PORT. Every 6-11
 * days, spread by ticker; every 2 days while a later quarter's filing is due
 * (50-80 days after that quarter ends, whichever quarter it is, in case one
 * was missed); and every night until one has been read. main() passes no
 * `checked` for a fund with no holdings and no filing found, so it is asked
 * again the next night; one whose filing was refused waits its 6-11 days,
 * since asking sooner would only find the same filing.
 */
export function due(fund, { checked = null, period = null } = {}, on) {
  if (!checked) return true;
  const since = days(checked, on);
  if (since >= CHECK_TTL + (hashOf(fund.t) % 6)) return true;
  if (period && since >= SEASON_TTL) {
    for (let q = 1; q <= 8; q++) {
      const after = days(nextPeriod(period, q), on);
      if (after < SEASON[0]) break;
      if (after <= SEASON[1]) return true;
    }
  }
  return false;
}

/**
 * Whether last night's reading of the same filing is out of date: a hand
 * fix now names one of its unmatched holdings, a ticker it used has left
 * tonight's snapshot (a rename or an index change), or, when the fund is
 * due anyway, it was read more than a month ago. `absent` holds tickers still
 * on our list whose company simply failed to quote tonight: they are back
 * tomorrow, and fifty funds must not be read again for one missing quote.
 */
export function needsReread(rec, { leiToCik, cikToTicker, tickerSet, absent = new Set() }, isDue, on) {
  if (!rec?.nport?.accession) return false;
  if ((rec.hold || []).some(([t]) => !tickerSet.has(t) && !absent.has(t))) return true;
  if ((rec.out || []).some(([lei]) => lei && leiToCik.has(lei) && cikToTicker.has(leiToCik.get(lei)))) return true;
  return isDue && (!rec.nport.read || days(rec.nport.read, on) >= REREAD_DAYS);
}

/* ---------------------------------------------------- SEC: reading answers */

/**
 * Filing rows from a browse-edgar HTML page: [{form, accession, filed}],
 * newest first. This page, with the series ID in the CIK slot, lists that
 * one series' filings (as edgartools reads it). Its Atom feed is not used:
 * the series page's own feed link points at the whole trust.
 */
export function filingsFromBrowse(html) {
  const rows = [];
  for (const tr of String(html || "").split(/<tr\b/i).slice(1)) {
    const form = /<td nowrap="nowrap">([^<]+)<\/td>/i.exec(tr);
    const acc = /Acc-no:(?:\s|&nbsp;)*(\d{10}-\d{2}-\d{6})/i.exec(tr);
    if (!form || !acc) continue;
    const filed = /<td>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>/.exec(tr);
    rows.push({ form: form[1].trim(), accession: acc[1], filed: filed ? filed[1] : null });
  }
  return rows;
}

/** The newest filing of exactly this form in a data.sec.gov submissions file. */
export function filingFromSubmissions(sub, form) {
  const r = sub?.filings?.recent;
  if (!r?.form) return null;
  const i = r.form.indexOf(form);
  if (i === -1) return null;
  return { form, accession: r.accessionNumber[i], filed: r.filingDate?.[i] || null, period: r.reportDate?.[i] || null };
}

/**
 * Expense ratios from a shareholder report's XBRL instance (the SEC's
 * extracted *_htm.xml of an N-CSR or N-CSRS). Each share class reports
 * oef:ExpenseRatioPct as a fraction (0.0094 is 0.94%) in a context whose one
 * dimension names the class (C000025034). Returns percentages by class, the
 * report's type and its period end. Values outside 0-3% are dropped as
 * misread.
 */
export function readExpenseRatios(xml) {
  const text = String(xml || "");
  const pfx = (uri) => (new RegExp(`xmlns:(\\w+)="http://xbrl\\.sec\\.gov/${uri}/\\d{4}"`).exec(text) || [])[1] || uri;
  const oef = pfx("oef"), dei = pfx("dei");
  const ctx = new Map();
  for (const m of text.matchAll(/<(?:\w+:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?context>/g)) {
    const members = [...m[2].matchAll(/<(?:\w+:)?explicitMember\b[^>]*\bdimension="([^"]+)"[^>]*>([^<]+)</g)].map((x) => [x[1], x[2].trim()]);
    const end = (/<(?:\w+:)?(?:endDate|instant)>\s*([^<\s]+)\s*</.exec(m[2]) || [])[1] || "";
    ctx.set(m[1], { members, end });
  }
  const best = {};
  for (const m of text.matchAll(new RegExp(`<${oef}:ExpenseRatioPct\\b([^>]*)>([^<]+)</${oef}:ExpenseRatioPct>`, "g"))) {
    const ref = (/\bcontextRef="([^"]+)"/.exec(m[1]) || [])[1];
    const c = ctx.get(ref);
    if (!c || c.members.length !== 1 || !/(ClassAxis|LegalEntityAxis)$/.test(c.members[0][0])) continue;
    const id = (/(C\d{9})/.exec(c.members[0][1]) || [])[1];
    const v = Number(m[2]);
    if (!id || !Number.isFinite(v)) continue;
    const pct = Math.round(v * 1e6) / 1e4;
    if (!(pct > 0 && pct <= 3)) continue;
    if (!best[id] || c.end > best[id].end) best[id] = { pct, end: c.end };
  }
  const fact = (name) => {
    const m = new RegExp(`<${dei}:${name}\\b[^>]*>\\s*([^<]+?)\\s*</${dei}:${name}>`).exec(text);
    return m ? m[1] : null;
  };
  return {
    type: fact("DocumentType"),
    period: fact("DocumentPeriodEndDate"),
    byClass: Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.pct]))
  };
}

/* ------------------------------------------------------- tonight's output */

/** Adds tonight's close to a fund's list: one point per session, sorted, capped. */
export function mergeCloses(list, session, close) {
  const out = (list || []).filter((p) => p[0] !== session);
  if (session && numOrNull(close)) out.push([session, +close.toFixed(4)]);
  out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (out.length > MAX_CLOSES) out.splice(0, out.length - MAX_CLOSES);
  return out;
}

const KEEP_SHARE = 0.9;     /* of yesterday's priced funds, and of its funds with holdings */
const FIRST_SHARE = 0.8;    /* of the listed funds, with holdings, before a first file */
const GIVE_WAY_DAYS = 5;    /* a kept file older than this gives way to a drop that lasts */

/**
 * Whether tonight's etfs.json may replace yesterday's.
 *
 * The first file turns the ETF side on, so it must have holdings for at
 * least 80% of the listed funds: an SEC that did not answer the runners
 * would otherwise put fifty empty cards on the site. Prices are not asked
 * for, since Finnhub's free tier may not quote ETFs at all (docs/ETFS.md).
 *
 * After that it must have priced at least 90% as many funds as yesterday
 * did, and kept holdings for at least 90% as many, both counted over the
 * funds still on the list (so taking funds off the list is not a "drop").
 * The idea of audit.mjs: yesterday's good data beats tonight's broken data.
 *
 * But a drop that lasts is not one bad night. Once the file being kept is
 * more than five days older than tonight's session (three sessions or so),
 * tonight's is written anyway, with a warning, and is the next night's
 * baseline. Without that, one fund source going quiet for good would freeze
 * every fund, and the SEC bookkeeping with them, with the step still green.
 */
export function shouldReplace(prev, next) {
  const c = next.counts;
  /* a file of empty records would show the ETF screens with nothing in them */
  if (!c.priced && !c.withHoldings) return { ok: false, why: "nothing was priced or read tonight" };
  if (!prev?.etfs?.length) {
    if (c.withHoldings < c.listed * FIRST_SHARE)
      return { ok: false, why: `only ${c.withHoldings} of ${c.listed} funds with holdings, too few for a first file` };
    return { ok: true, why: "first night" };
  }
  const listed = new Set(next.etfs.map((r) => r.t));
  const kept = prev.etfs.filter((r) => listed.has(r.t));
  const priced = kept.filter((r) => numOrNull(r.price) !== null && !r.stale).length;
  const held = kept.filter((r) => r.hold?.length).length;
  const drop =
    c.priced < priced * KEEP_SHARE ? `only ${c.priced} funds priced against ${priced} yesterday` :
    c.withHoldings < held * KEEP_SHARE ? `only ${c.withHoldings} funds with holdings against ${held} yesterday` : null;
  if (!drop) return { ok: true, why: null };
  const age = prev.session && next.session ? days(prev.session, next.session) : 0;
  if (age > GIVE_WAY_DAYS) return { ok: true, why: `${drop}, but the file kept is ${age} days old`, warn: true };
  return { ok: false, why: drop };
}

/* Every file whole or not at all: a step killed by its timeout leaves a
   .tmp behind, which the commit step never picks up. */
async function writeAtomic(file, value) {
  await fs.writeFile(file + ".tmp", JSON.stringify(value));
  await fs.rename(file + ".tmp", file);
}

async function readJSON(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

/* ------------------------------------------------------------- network */

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

/* After this many failures in a row a host is taken to be down for the night:
   an outage must not spend the whole budget on retries, one fund at a time. */
const DOWN_AFTER = 8;

/* Each host stops at its own deadline: the SEC at the end of its share of
   the step, Finnhub at the end of the step. A request never outlives its
   host's deadline either, so an SEC that accepts a connection and never
   answers is cut off on time, not 30 or 60 seconds later on Finnhub's. */
function makeNet({ ua, finnhubApi, token, perMin, deadline, secDeadline = deadline }) {
  const host = (perSec, name, end) => ({ gate: limiter(perSec), name, end, failures: 0, down: false });
  const SEC = host(8, "SEC", secDeadline);                 /* SEC asks for <= 10 a second */
  const FINNHUB = host(perMin / 60, "Finnhub", deadline);  /* the free tier allows 60 a minute */
  const late = (via) => Date.now() >= via.end;

  async function get(url, { via, json, label, big }) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (late(via) || via.down) return undefined;
      await via.gate();
      if (late(via)) return undefined;
      try {
        const wait = Math.min(big ? TIMEOUT_MS * 2 : TIMEOUT_MS, via.end - Date.now());
        const res = await fetch(url, { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(Math.max(1, wait)) });
        if (res.status === 429) { await res.body?.cancel(); await sleep(2000 * attempt); continue; }
        if (res.status === 404) { await res.body?.cancel(); via.failures = 0; return null; }
        if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
        if (Number(res.headers.get("content-length")) > MAX_TEXT) { await res.body?.cancel(); via.failures = 0; warn(`  ! ${label}: too large, skipped`); return undefined; }
        const text = await res.text();
        via.failures = 0;
        if (text.length > MAX_TEXT) { warn(`  ! ${label}: too large, skipped`); return undefined; }
        return json ? JSON.parse(text) : text;
      } catch (err) {
        if (attempt === 3 || late(via)) {
          /* a reply that was not JSON is quoted in the message: one line */
          warn(`  ! ${label}: ${err.message}`);
          if (++via.failures >= DOWN_AFTER && !via.down) {
            via.down = true;
            warn(`  ! ${via.name} failed ${DOWN_AFTER} times in a row: not asking it again tonight`);
          }
          return undefined;
        }
        await sleep(700 * attempt);
      }
    }
    return undefined;
  }

  return {
    sec: (url, label, opts = {}) => get(url, { via: SEC, label, ...opts }),
    finnhub: (p) => get(`${finnhubApi}${p}${p.includes("?") ? "&" : "?"}token=${token}`,
      { via: FINNHUB, json: true, label: `finnhub ${p.split("?")[0]}` })
  };
}

/* -------------------------------------------------------------- pipeline */

export async function main(opts = {}) {
  const env = opts.env || process.env;
  const data = opts.data || DATA;
  const now = opts.now || Date.now();
  const SEC_WWW = env.SEC_WWW || "https://www.sec.gov";
  const SEC_DATA = env.SEC_DATA || "https://data.sec.gov";
  const skipPrices = env.ETF_SKIP_PRICES === "1" || !env.FINNHUB_TOKEN;

  const guard = timeGuard(env.JOB_STARTED, now);
  if (guard.skip) {
    log(`ETFs: skipped tonight, the job is already ${Math.round(guard.elapsed)} minutes in. Yesterday's files stay.`);
    return { skipped: true };
  }
  /* opts.budgetMs is for tests only, in place of the guard's 12 minutes */
  const deadline = Date.now() + (opts.budgetMs ?? guard.budgetMs);

  const sp500 = await readJSON(path.join(data, "sp500.json"));
  const list = loadList(await readJSON(path.join(data, "etf-list.json")),
    new Set((sp500?.companies || []).map((c) => c.t)));
  for (const note of list.notes) warn(`  ! ${note}`);
  for (const r of list.refused) warn(`  ! ${r.t}: refused (${r.why})`);

  /* The SEC's share of the step ends early enough for Finnhub's two calls a
     fund at its rate a minute, and 20 seconds over */
  const perMin = Number(env.FINNHUB_PER_MIN) || 50;
  const secDeadline = deadline - (skipPrices ? 0 : (list.funds.length * 2 * 60e3) / perMin + 20e3);

  const snap = await readJSON(path.join(data, "snapshot.json"));
  const stocks = snap?.stocks || [];
  const prev = await readJSON(path.join(data, "etfs.json"));
  const prevBy = new Map((prev?.etfs || []).map((r) => [r.t, r]));
  const prevCloses = (await readJSON(path.join(data, "etf-closes.json")))?.closes || {};
  const leiFile = (await readJSON(path.join(data, "lei.json"))) || { v: 1, byLei: {} };
  const byLei = { ...(leiFile.byLei || {}) };
  let leiAdded = 0;

  const on = today(now);
  const runSession = sessionDate(new Date(now));
  const net = makeNet({
    ua: env.SEC_USER_AGENT || "StockOrNot open-source project contact@example.com",
    finnhubApi: env.FINNHUB_API || "https://finnhub.io/api/v1",
    token: env.FINNHUB_TOKEN, perMin, deadline, secDeadline
  });

  /* What a holding can be matched to: tonight's companies, so renames the
     refresh step just applied (FI -> FISV) are already in. */
  const cikToTicker = new Map(), tickerToCik = new Map(), sectorOf = new Map();
  for (const s of stocks) {
    if (!s.cik) continue;
    if (!cikToTicker.has(s.cik)) cikToTicker.set(s.cik, s.t);
    tickerToCik.set(s.t, s.cik);
    sectorOf.set(s.t, s.s);
  }
  const tickerSet = new Set(tickerToCik.keys());
  const leiToCik = new Map(Object.entries(byLei).map(([lei, v]) => [lei, v.cik]));
  for (const [lei, cik] of list.leiFix) leiToCik.set(lei, cik);
  const fullIndex = stocks.length >= 400;

  /* Names: our list's own, and the SEC's conformed titles for the same CIKs,
     which are written the way filings name holdings ("HONEYWELL
     INTERNATIONAL INC", not "Honeywell"). Loaded once, and only on a night
     that reads a filing. */
  let nameIndex = null;
  async function names() {
    if (nameIndex) return nameIndex;
    const pairs = stocks.map((s) => [s.n, s.cik]);
    const ct = await net.sec(`${SEC_WWW}/files/company_tickers.json`, "SEC ticker list", { json: true });
    for (const r of Object.values(ct || {})) {
      const cik = String(r?.cik_str ?? "").padStart(10, "0");
      if (cikToTicker.has(cik) && r.title) pairs.push([r.title, cik]);
    }
    return (nameIndex = nameIndexOf(pairs));
  }

  const records = new Map();
  const skipped = [...list.refused];
  const counts = { checked: 0, downloaded: 0, reread: 0, erRead: 0 };

  /* Each fund starts as yesterday's reading, carried forward; tonight's work
     replaces what it can. A fund whose series changed in the list starts
     clean. */
  for (const f of list.funds) {
    const p = prevBy.get(f.t);
    const same = p && p.trust === f.trust && (p.series || null) === f.series;
    records.set(f.t, {
      holdings: same && p.nport ? {
        nport: p.nport, equity: p.equity, other: p.other, cover: p.cover, reading: p.reading,
        hold: p.hold, out: p.out, spread: p.spread, mix: p.mix
      } : null,
      prev: same ? p : null,
      price: null,
      er: same && p.erSrc && p.erSrc !== "list" ? { er: p.er, erUrl: p.erUrl, erAsOf: p.erAsOf, erSrc: p.erSrc } : null,
      erCheck: same ? p.erCheck || null : null,
      /* a filing we refused, remembered so it is not downloaded every night */
      miss: same ? p.nportMiss || null : null
    });
  }

  /* ---- 1. SEC: new N-PORTs, seed funds first so their LEIs serve the rest */
  const order = [...list.funds].sort((a, b) => Number(b.seed) - Number(a.seed));

  async function latestNport(f) {
    if (f.series) {
      const html = await net.sec(`${SEC_WWW}/cgi-bin/browse-edgar?action=getcompany&CIK=${f.series}&type=NPORT-P&dateb=&owner=include&start=0&count=10`,
        `N-PORT list ${f.t}`);
      if (typeof html !== "string") return html;     /* undefined: could not ask; null: no such series */
      return filingsFromBrowse(html).find((r) => r.form === "NPORT-P") || null;
    }
    const sub = await net.sec(`${SEC_DATA}/submissions/CIK${f.trust}.json`, `submissions ${f.t}`, { json: true });
    return sub ? filingFromSubmissions(sub, "NPORT-P") : sub;
  }

  /* true: read; a string: refused, and why; undefined: not downloaded tonight */
  async function readFiling(f, found, rec) {
    const url = `https://www.sec.gov/Archives/edgar/data/${bare(f.trust)}/${noDash(found.accession)}/primary_doc.xml`;
    const xml = await net.sec(url.replace("https://www.sec.gov", SEC_WWW), `N-PORT ${f.t}`, { big: true });
    if (typeof xml !== "string") return undefined;
    counts.downloaded++;
    const parsed = parseNport(xml);
    const held = rec.holdings?.nport;
    const why = checkFiling(parsed, f) ||
      (held?.period && parsed.period && parsed.period < held.period && held.accession !== found.accession
        ? `newest N-PORT is for ${parsed.period}, older than the ${held.period} one we have` : null);
    if (why) return why;
    const index = await names();
    if (f.seed) {
      const fresh = seedLeis(parsed.holdings, index, { known: new Set(leiToCik.keys()), from: `${f.t} ${parsed.period}` });
      for (const [lei, v] of Object.entries(fresh)) { byLei[lei] = v; leiToCik.set(lei, v.cik); leiAdded++; }
    }
    const m = matchHoldings(parsed.holdings, { leiToCik, cikToTicker, tickerToCik, nameIndex: index });
    const classes = Object.keys(parsed.rtn);
    rec.holdings = {
      nport: {
        period: parsed.period, filed: found.filed || held?.filed || null, accession: found.accession, url,
        assets: parsed.netAssets, assetsScope: classes.length > 1 ? "series" : "fund",
        count: parsed.holdings.filter((h) => h.cat === "EC" || h.cat === "EP").length,
        rtn: parsed.rtn[f.class || ""] || (classes.length === 1 ? parsed.rtn[classes[0]] : null),
        name: parsed.seriesName && parsed.seriesName !== "N/A" ? parsed.seriesName : null,
        checked: on, read: on
      },
      equity: m.equity, other: m.other, cover: m.cover, reading: readingOf(m),
      hold: m.hold, out: m.out, spread: spreadOf(m.parts),
      mix: mixOf(m.hold, (t) => sectorOf.get(t))
    };
    return true;
  }

  if (fullIndex) {
    const absent = new Set((sp500?.companies || []).filter((c) => !tickerSet.has(c.t) && !cikToTicker.has(c.cik)).map((c) => c.t));
    const match = { leiToCik, cikToTicker, tickerSet, absent };
    for (const f of order) {
      if (Date.now() > secDeadline) break;
      const rec = records.get(f.t);
      const held = rec.holdings?.nport;
      /* no holdings and no filing found: asked again every night, not every
         6-11 days; only a refused filing's date holds a fund back */
      const isDue = due(f, { checked: held?.checked || (rec.miss?.acc ? rec.miss.at : null), period: held?.period }, on);
      let found = null;
      if (isDue) {
        found = await latestNport(f);
        if (found === undefined) continue;                 /* SEC unreachable: ask again tomorrow */
        counts.checked++;
        if (found === null) {
          if (rec.holdings) {
            /* the SEC no longer lists the filing we read: the holdings stay,
               until they are too old to read by (lib/funds.mjs), and the
               fund is named in skipped so the owner sees it */
            rec.holdings.nport = { ...held, checked: on };
            skipped.push({ t: f.t, why: "no N-PORT found, older holdings kept" });
          } else {
            rec.miss = { at: on, acc: null, why: "no N-PORT found" };
            skipped.push({ t: f.t, why: rec.miss.why });
          }
          continue;
        }
        if (found.accession === rec.miss?.acc) {          /* refused before: not again */
          rec.miss = { ...rec.miss, at: on };
          if (rec.holdings) rec.holdings.nport = { ...held, checked: on };
          skipped.push({ t: f.t, why: rec.miss.why });
          continue;
        }
      }
      let result = null;
      if (found && found.accession !== held?.accession) {
        result = await readFiling(f, found, rec);
      } else if (held && needsReread(rec.holdings, match, isDue, on)) {
        counts.reread++;
        result = await readFiling(f, { accession: held.accession, filed: held.filed }, rec);
      }
      if (result === true) { rec.miss = null; continue; }
      if (typeof result === "string") {
        rec.miss = { at: on, acc: found?.accession || held.accession, why: result };
        skipped.push({ t: f.t, why: result });
      }
      if (isDue && result !== undefined && rec.holdings) rec.holdings.nport = { ...rec.holdings.nport, checked: on };
    }

    /* ---- expense ratios, read from the shareholder reports for funds the
       list has no hand-typed figure for; a hand figure always wins. A check
       is only marked done once something was actually read, so a failed
       download is tried again the next night. */
    const reports = new Map();
    let erDownloads = 0;
    for (const f of list.funds) {
      if (Date.now() > secDeadline) break;
      const rec = records.get(f.t);
      if (f.er !== null || !f.class) continue;
      const last = rec.erCheck;
      if (last?.at && days(last.at, on) < ER_TTL + (hashOf(f.t) % 10)) continue;
      const html = await net.sec(`${SEC_WWW}/cgi-bin/browse-edgar?action=getcompany&CIK=${f.series || f.class}&type=N-CSR&dateb=&owner=include&start=0&count=10`,
        `shareholder reports ${f.t}`);
      if (typeof html !== "string") continue;
      const row = filingsFromBrowse(html).find((r) => r.form === "N-CSR" || r.form === "N-CSRS");
      if (!row) { rec.erCheck = { at: on, acc: null }; continue; }
      if (row.accession === last?.acc) { rec.erCheck = { ...last, at: on }; continue; }
      if (!reports.has(row.accession)) {
        if (erDownloads >= ER_BUDGET) continue;
        const dir = `${SEC_WWW}/Archives/edgar/data/${bare(f.trust)}/${noDash(row.accession)}`;
        const index = await net.sec(`${dir}/index.json`, `report index ${f.t}`, { json: true });
        if (index === undefined) continue;
        /* the SEC's extracted XBRL instance of an inline-XBRL report */
        const docs = (index?.directory?.item || []).map((i) => i?.name).filter((n) => /_htm\.xml$/i.test(n || "")).slice(0, 3);
        const merged = { type: null, period: null, byClass: {}, complete: true };
        for (const doc of docs) {
          if (erDownloads >= ER_BUDGET) { merged.complete = false; break; }
          erDownloads++;
          const xml = await net.sec(`${dir}/${doc}`, `shareholder report ${f.t}`, { big: true });
          if (typeof xml !== "string") { merged.complete = false; continue; }
          const r = readExpenseRatios(xml);
          merged.type ||= r.type;
          merged.period ||= r.period;
          Object.assign(merged.byClass, r.byClass);
        }
        reports.set(row.accession, merged);
      }
      const r = reports.get(row.accession);
      const pct = r.byClass[f.class];
      if (pct === undefined) {
        if (r.complete) rec.erCheck = { at: on, acc: row.accession };
        continue;
      }
      counts.erRead++;
      rec.erCheck = { at: on, acc: row.accession };
      rec.er = {
        er: pct,
        erUrl: `https://www.sec.gov/Archives/edgar/data/${bare(f.trust)}/${noDash(row.accession)}/${row.accession}-index.htm`,
        erAsOf: r.period || row.filed,
        erSrc: r.type === "N-CSRS" || row.form === "N-CSRS" ? "N-CSRS" : "N-CSR"
      };
    }
  } else {
    warn(`  ! snapshot has ${stocks.length} companies, not the full index: holdings carried over unread`);
  }

  /* ---- 2. Finnhub: price, day move, 52-week range, returns, beta ------- */
  const closes = {};
  for (const f of list.funds) if (prevCloses[f.t]?.length) closes[f.t] = prevCloses[f.t];
  let priced = 0;
  if (!skipPrices) {
    for (const f of list.funds) {
      if (Date.now() > deadline - 15e3) { warn("  ! out of time: the rest keep yesterday's prices"); break; }
      const [q, mres] = await Promise.all([
        net.finnhub(`/quote?symbol=${encodeURIComponent(f.t)}`),
        net.finnhub(`/stock/metric?metric=all&symbol=${encodeURIComponent(f.t)}`)
      ]);
      const px = numOrNull(q?.c);
      if (!px) { skipped.push({ t: f.t, why: "no quote" }); continue; }
      const m = mres?.metric || {};
      const pick = (...keys) => { for (const k of keys) if (numOrNull(m[k]) !== null) return m[k]; return null; };
      let lo = pick("52WeekLow"), hi = pick("52WeekHigh");
      if (lo !== null && hi !== null && (px < lo * 0.5 || px > hi * 2)) lo = hi = null;
      records.get(f.t).price = {
        price: px, change: numOrNull(q.dp), open: numOrNull(q.o), prev: numOrNull(q.pc), lo, hi,
        r13: pick("13WeekPriceReturnDaily"), r26: pick("26WeekPriceReturnDaily"), r52: pick("52WeekPriceReturnDaily"),
        ytd: pick("yearToDatePriceReturnDaily"), beta: pick("beta")
      };
      const session = q.t ? sessionDate(new Date(q.t * 1000)) : runSession;
      closes[f.t] = mergeCloses(closes[f.t], session, px);
      priced++;
    }
  }

  /* ---- 3. the records: no cik, s or mc, ever (docs/ETFS.md) ------------- */
  const PRICE = ["price", "change", "open", "prev", "lo", "hi", "r13", "r26", "r52", "ytd", "beta"];
  const MOVE = new Set(["change", "open", "prev"]);
  const etfs = list.funds.map((f) => {
    const rec = records.get(f.t);
    const out = { t: f.t, n: f.n, kind: "etf", issuer: f.issuer, trust: f.trust, series: f.series, since: f.since };
    /* A fund not quoted tonight keeps its last price, range, returns and
       beta, and `stale` names the session they are from. Its day's move is
       not kept: it was that session's, and a screen would call it today's. */
    const p = rec.price || rec.prev;
    for (const k of PRICE) out[k] = p && (rec.price || !MOVE.has(k)) ? numOrNull(p[k]) : null;
    if (!rec.price && rec.prev && numOrNull(rec.prev.price) !== null) out.stale = rec.prev.stale || prev?.session || null;
    const er = f.er !== null ? { er: f.er, erUrl: f.erUrl, erAsOf: f.erAsOf, erSrc: "list" } : rec.er;
    Object.assign(out, er || { er: null, erUrl: null, erAsOf: null, erSrc: null });
    if (rec.erCheck) out.erCheck = rec.erCheck;
    const h = rec.holdings;
    Object.assign(out, h || { nport: null, equity: null, other: null, cover: null, reading: "none", hold: [], out: [], spread: null, mix: null });
    if (rec.miss) out.nportMiss = rec.miss;
    return out;
  });

  const next = {
    v: 1, updated: new Date().toISOString(), session: runSession,
    counts: {
      listed: etfs.length, priced,
      withHoldings: etfs.filter((r) => r.hold?.length).length,
      full: etfs.filter((r) => r.reading === "full").length,
      partial: etfs.filter((r) => r.reading === "partial").length
    },
    skipped, etfs
  };

  const verdict = shouldReplace(prev, next);
  const refused = prev?.etfs?.length ? "kept yesterday's etfs.json" : "no etfs.json written yet";
  if (verdict.ok) await writeAtomic(path.join(data, "etfs.json"), next);
  if (priced) await writeAtomic(path.join(data, "etf-closes.json"), { v: 1, updated: next.updated, closes });
  if (leiAdded) await writeAtomic(path.join(data, "lei.json"), { v: 1, byLei });

  const unmatched = new Map();
  for (const r of etfs) for (const [lei, name, pct] of r.out || []) {
    if (pct < 0.5) continue;
    const key = lei || name;
    if (!unmatched.has(key) || unmatched.get(key).pct < pct) unmatched.set(key, { name, t: r.t, pct });
  }
  const um = [...unmatched.values()].sort((a, b) => b.pct - a.pct).slice(0, 12)
    .map((u) => `${u.name} (${u.t} ${u.pct.toFixed(1)}%)`);
  const why = new Map();
  for (const s of skipped) why.set(s.why, [...(why.get(s.why) || []), s.t]);
  log(
    `ETFs: ${next.counts.listed} listed, ${priced} priced, ${next.counts.withHoldings} with holdings, ` +
    `${next.counts.full} read in full, ${next.counts.partial} partly; SEC ${counts.checked} checked, ` +
    `${counts.downloaded} N-PORTs read, ${counts.erRead} expense ratios read, ${leiAdded} LEIs learned; ` +
    `${verdict.ok ? (verdict.why ? `written (${verdict.why})` : "written") : `${refused} (${verdict.why})`}; ` +
    `unmatched ≥0.5%: ${um.length ? um.join(", ") : "none"}` +
    (why.size ? `; skipped: ${[...why].map(([w, ts]) => `${w}: ${ts.join(" ")}`).join("; ")}` : "")
  );
  /* The step is continue-on-error and stays green whatever happens here, so
     a refusal, or a drop let through, is also put on the run's summary page
     as a warning, where the owner sees it without opening the log. */
  if (!verdict.ok || verdict.warn)
    log(`::warning title=ETF data::${verdict.ok ? "etfs.json written" : refused}: ${verdict.why}`);
  return { written: verdict.ok, next };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(oneLine(err?.stack || err)); process.exit(1); });
}
