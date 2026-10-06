/* ==========================================================================
   Data audit — the gate between a finished refresh and a live page.

   This exists because a wrong number reached stockornot.com and a person found
   it before the pipeline did. Amphenol's five-year share count mixed as-filed
   and split-restated figures, so the page announced a 104% dilution that never
   happened. Nothing in the run objected. Separately, a six-company smoke test
   once overwrote all 501 rows and the commit sailed through.

   So: every check here is either something that already went wrong, or the same
   shape of thing one step away. Findings are graded.

     fail  — do not publish. Yesterday's correct data beats today's broken data.
     warn  — publish, but say so in the log.

   Run after refresh.mjs and before the commit step. Exit code 1 blocks the
   commit; the previous snapshot stays live.
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "..", "data");
const SNAP = path.join(DATA, "snapshot.json");

const num = (v) => typeof v === "number" && isFinite(v);

/* --------------------------------------------------------------- findings */

const findings = [];
const add = (level, code, msg, tickers) =>
  findings.push({ level, code, msg, tickers: tickers ? tickers.slice(0, 25) : undefined,
                  count: tickers ? tickers.length : undefined });

/* ------------------------------------------------- yesterday, for comparison
   The Action checks the repo out, so the committed snapshot is one git call
   away. Locally there may be no git history, and that is not an error — the
   day-over-day checks simply do not run. */

function previousSnapshot() {
  try {
    const raw = execSync("git show HEAD:data/snapshot.json", {
      cwd: path.join(HERE, ".."), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"]
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ checks */

function checkCoverage(snap, prev) {
  const n = snap.stocks.length;
  if (n === 0) return add("fail", "empty", "The snapshot contains no companies at all.");
  if (n < 50) add("fail", "tiny", `Only ${n} companies in the snapshot — expected the full index.`);

  if (!prev?.stocks?.length) return;
  const before = prev.stocks.length;
  const lost = before - n;
  /* The limit-run wipe looked exactly like this: 501 rows became 8 and the
     commit went through unchallenged. */
  if (lost > 0 && lost / before > 0.05)
    add("fail", "coverage-drop",
        `Company count fell from ${before} to ${n} (${((lost / before) * 100).toFixed(1)}% of the index vanished).`);
  else if (lost > 0)
    add("warn", "coverage-dip", `Company count fell from ${before} to ${n}.`);

  const now = new Set(snap.stocks.map((s) => s.t));
  const gone = prev.stocks.map((s) => s.t).filter((t) => !now.has(t));
  if (gone.length && gone.length / before <= 0.05)
    add("warn", "tickers-dropped", `${gone.length} tickers present yesterday are missing today.`, gone);
}

function checkPrices(snap, prev) {
  const noPrice = snap.stocks.filter((s) => !num(s.price) || s.price <= 0).map((s) => s.t);
  if (noPrice.length / snap.stocks.length > 0.1)
    add("fail", "prices-missing",
        `${noPrice.length} of ${snap.stocks.length} companies have no usable price.`, noPrice);
  else if (noPrice.length)
    add("warn", "prices-missing", `${noPrice.length} companies have no usable price.`, noPrice);

  /* A 52-week band that excludes the price, or inverts, means one of the three
     numbers is wrong — and the card draws a position marker from all three. */
  const badBand = snap.stocks.filter((s) =>
    num(s.lo) && num(s.hi) && (s.lo > s.hi || (num(s.price) && (s.price < s.lo * 0.9 || s.price > s.hi * 1.1)))
  ).map((s) => s.t);
  if (badBand.length) add("warn", "range-inconsistent",
    `${badBand.length} companies have a 52-week range that disagrees with the price.`, badBand);

  if (!prev?.stocks?.length) return;
  const before = new Map(prev.stocks.map((s) => [s.t, s]));
  const jumped = [];
  for (const s of snap.stocks) {
    const p = before.get(s.t);
    if (!p || !num(p.price) || !num(s.price) || p.price <= 0) continue;
    const move = Math.abs(s.price / p.price - 1);
    /* Index members do move 25% in a day, rarely. A split we have not handled
       moves them exactly 50% or 100%, which is the case worth catching. */
    if (move > 0.25) jumped.push(`${s.t} ${p.price}→${s.price}`);
  }
  if (jumped.length > snap.stocks.length * 0.2)
    add("fail", "prices-shifted",
        `${jumped.length} companies moved more than 25% since the last run — the quote feed is suspect.`, jumped);
  else if (jumped.length)
    add("warn", "price-jump", `${jumped.length} companies moved more than 25% since the last run.`, jumped);
}

function checkFundamentals(snap) {
  const suspect = { negRevenue: [], hugeMargin: [], negEquityRatio: [], impossiblePe: [], noCapex: [] };

  for (const s of snap.stocks) {
    const f = s.fin || {};
    if (num(f.revenue) && f.revenue < 0) suspect.negRevenue.push(s.t);
    /* Margins are derived from two XBRL tags. A wrong tag pairing shows up here
       long before anyone reads the table. */
    if (num(s.nm) && (s.nm > 100 || s.nm < -500)) suspect.hugeMargin.push(`${s.t} ${s.nm.toFixed(0)}%`);
    if (num(s.gm) && (s.gm > 100 || s.gm < -100)) suspect.hugeMargin.push(`${s.t} gm ${s.gm.toFixed(0)}%`);
    if (num(s.pe) && Math.abs(s.pe) > 5000) suspect.impossiblePe.push(`${s.t} ${s.pe.toFixed(0)}`);
    /* Operating cash flow but no capital spending: free cash flow cannot be
       worked out, and the score has to fall back on operating cash. Banks
       and insurers are not expected to report it. */
    if (s.s !== "Financials" && num(f.ocf) && !num(f.capex)) suspect.noCapex.push(s.t);
    if (num(f.assets) && num(f.liabs) && num(f.equity) && f.assets > 0) {
      /* assets = liabilities + equity, give or take minority interests */
      const gap = Math.abs(f.assets - (f.liabs + f.equity)) / f.assets;
      if (gap > 0.15) suspect.negEquityRatio.push(`${s.t} ${(gap * 100).toFixed(0)}% off`);
    }
  }

  if (suspect.negRevenue.length)
    add("warn", "negative-revenue", `${suspect.negRevenue.length} companies report negative revenue.`, suspect.negRevenue);
  if (suspect.hugeMargin.length)
    add("warn", "margin-out-of-range", `${suspect.hugeMargin.length} margins fall outside any plausible range.`, suspect.hugeMargin);
  if (suspect.impossiblePe.length)
    add("warn", "pe-extreme", `${suspect.impossiblePe.length} P/E ratios are absurd.`, suspect.impossiblePe);
  if (suspect.noCapex.length)
    add("warn", "capex-missing",
        `${suspect.noCapex.length} companies report operating cash flow but no capital spending, so free cash ` +
        `flow is missing. data/fundamentals/<ticker>.json lists, under capexCandidates, the tags each one ` +
        `does report that look like capital spending.`, suspect.noCapex);
  if (suspect.negEquityRatio.length)
    add("warn", "balance-sheet-gap",
        `${suspect.negEquityRatio.length} balance sheets do not add up (assets vs liabilities + equity). ` +
        `Usually the equity tag is parent-only and the company carries large noncontrolling interests — ` +
        `common in asset managers. Worth checking before assuming a parsing bug.`,
        suspect.negEquityRatio);
}

function checkCompleteness(snap, prev) {
  const total = snap.stocks.length;
  const missing = {
    financials: snap.stocks.filter((s) => !num(s.fin?.revenue)).map((s) => s.t),
    earnings:   snap.stocks.filter((s) => !s.earnings?.date).map((s) => s.t),
    filings:    snap.stocks.filter((s) => !s.sec?.detail).map((s) => s.t)
  };

  for (const [what, list] of Object.entries(missing)) {
    if (list.length / total > 0.15)
      add("fail", `${what}-missing`, `${list.length} of ${total} companies have no ${what}.`, list);
    else if (list.length)
      add("warn", `${what}-missing`, `${list.length} companies have no ${what}.`, list);
  }

  /* Coverage that silently erodes run over run is the failure mode nobody
     notices, because each individual day looks fine. */
  if (prev?.counts) {
    for (const k of ["withFinancials", "withFilings", "withEarningsDate"]) {
      const now = snap.counts?.[k], was = prev.counts?.[k];
      if (num(now) && num(was) && was > 0 && (was - now) / was > 0.05)
        add("warn", "coverage-eroding", `${k} fell from ${was} to ${now} since the last run.`);
    }
  }
}

/* Split-shaped jumps in the share history. The display now restates these, but
   a company appearing here that has not actually split means the extraction
   picked up two different filing conventions — worth knowing either way. */
async function checkShareHistory(snap) {
  const hits = [];
  for (const s of snap.stocks) {
    let d;
    try {
      const safe = s.t.replace(/[^A-Z0-9.]/gi, "_");
      d = JSON.parse(await fs.readFile(path.join(DATA, "detail", safe + ".json"), "utf8"));
    } catch { continue; }
    const sh = d?.history?.shares;
    if (!sh) continue;
    const years = Object.keys(sh).map(Number).filter((y) => num(sh[y]) && sh[y] > 0).sort((a, b) => a - b);
    for (let i = 1; i < years.length; i++) {
      const r = sh[years[i]] / sh[years[i - 1]];
      if (r > 1.4 || r < 0.7) { hits.push(`${s.t} FY${years[i - 1]}→FY${years[i]} ×${r.toFixed(2)}`); break; }
    }
  }
  if (hits.length)
    add("warn", "share-count-step",
        `${hits.length} companies show a step change in share count (split, or mixed filing conventions).`, hits);
}

async function checkDeepFiles(snap) {
  let charts = 0, analysts = 0, present = 0;
  for (const s of snap.stocks) {
    const safe = s.t.replace(/[^A-Z0-9.]/gi, "_");
    try {
      const d = JSON.parse(await fs.readFile(path.join(DATA, "detail", safe + ".json"), "utf8"));
      present++;
      if (d.chart?.length >= 20 || d.closes?.length >= 5) charts++;
      if (d.analyst) analysts++;
    } catch { /* counted by absence */ }
  }
  const total = snap.stocks.length;
  if (present / total < 0.9)
    add("fail", "detail-missing", `Only ${present} of ${total} companies have a detail file.`);
  if (charts / total < 0.8)
    add("warn", "charts-missing", `Only ${charts} of ${total} companies have price history to chart.`);
  if (analysts / total < 0.8)
    add("warn", "analyst-missing", `Only ${analysts} of ${total} companies have an analyst view.`);
  return { present, charts, analysts };
}

function checkFreshness(snap) {
  if (!snap.updated) return add("warn", "no-timestamp", "The snapshot has no updated timestamp.");
  const hours = (Date.now() - new Date(snap.updated)) / 36e5;
  if (!isFinite(hours)) add("warn", "bad-timestamp", `Unparseable timestamp: ${snap.updated}`);
  else if (hours > 6) add("warn", "stale", `The snapshot says it was built ${hours.toFixed(1)} hours ago.`);

  const past = snap.stocks.filter((s) => {
    const d = s.earnings?.date;
    return d && new Date(d + "T12:00:00Z") < new Date(Date.now() - 3 * 864e5);
  }).map((s) => s.t);
  if (past.length > snap.stocks.length * 0.1)
    add("warn", "earnings-past", `${past.length} companies still show an earnings date in the past.`, past);
}

/* The figures that were publicly wrong before this check existed: REIT and
   bank revenue that was a small sub-line ("FCF 1337% of revenue"), a
   utility's 2018 numbers labelled FY2025, report dates six months out, and
   Berkshire B's Class A estimate. Each is a warning with the tickers named;
   the refresh itself now avoids them, so any hit here is a regression. */
function checkPlausibility(snap) {
  const bad = { revenue: [], income: [], stale: [], far: [], eps: [] };
  const today = Date.now();
  for (const s of snap.stocks) {
    const f = s.fin || {};
    if (num(f.revenue) && f.revenue > 0 && num(s.mc) && num(s.ps) && s.ps > 0) {
      const implied = (s.mc * 1e6) / s.ps;
      const ratio = f.revenue / implied;
      if (ratio > 3 || ratio < 1 / 3) bad.revenue.push(`${s.t} filed ${(f.revenue / 1e9).toFixed(1)}B vs ~${(implied / 1e9).toFixed(1)}B`);
    }
    if (num(f.netIncome) && num(f.revenue) && f.revenue > 0 && f.netIncome > f.revenue) bad.income.push(s.t);
    const k = s.sec?.tenK?.period;
    if (f.end && k && Math.abs(new Date(f.end) - new Date(k)) / 864e5 > 20) bad.stale.push(`${s.t} ${f.end} vs 10-K ${k}`);
    const d = s.earnings?.date;
    if (d && (new Date(d + "T12:00:00Z") - today) / 864e5 > 100) bad.far.push(`${s.t} ${d}`);
    const e = s.earnings?.epsEst;
    if (num(e) && num(s.pe) && s.pe > 0 && num(s.price) && Math.abs(e) > Math.max((s.price / s.pe) * 50, 5)) bad.eps.push(`${s.t} ${e}`);
  }
  if (bad.revenue.length) add("warn", "revenue-implausible", `${bad.revenue.length} companies' filed revenue is more than 3× off what their price/sales implies.`, bad.revenue);
  if (bad.income.length) add("warn", "income-exceeds-revenue", `${bad.income.length} companies report net income above revenue.`, bad.income);
  if (bad.stale.length) add("warn", "financials-not-latest", `${bad.stale.length} companies' financials are not from their latest 10-K.`, bad.stale);
  if (bad.far.length) add("warn", "earnings-far", `${bad.far.length} companies show a next report more than 100 days out; they report quarterly.`, bad.far);
  if (bad.eps.length) add("warn", "eps-implausible", `${bad.eps.length} EPS estimates are implausible for the share price.`, bad.eps);

  /* A ticker that stops quoting is dropped from the deck. It used to go
     unmentioned for weeks (Fiserv, Marsh McLennan) once the first night
     had passed. */
  if (snap.skipped?.length) add("warn", "skipped", `${snap.skipped.length} tickers in data/sp500.json could not be priced and are not in the deck.`, snap.skipped);
  if (snap.renamed?.length) add("warn", "renamed", `${snap.renamed.length} tickers were found under a new symbol. Update data/sp500.json.`,
    snap.renamed.map((r) => `${r.from}→${r.to}`));
}

/* -------------------------------------------------------------------- main */

const snap = JSON.parse(await fs.readFile(SNAP, "utf8"));
if (!Array.isArray(snap.stocks)) {
  console.error("snapshot.json has no stocks array — refusing to publish.");
  process.exit(1);
}

const prev = previousSnapshot();
console.log(prev?.stocks?.length
  ? `Comparing ${snap.stocks.length} companies against the ${prev.stocks.length} committed previously.\n`
  : `No previous snapshot in git — running standalone checks on ${snap.stocks.length} companies.\n`);

checkCoverage(snap, prev);
checkPrices(snap, prev);
checkFundamentals(snap);
checkCompleteness(snap, prev);
checkFreshness(snap);
checkPlausibility(snap);
await checkShareHistory(snap);
const deep = await checkDeepFiles(snap);

/* ------------------------------------------------------------------ report */

const fails = findings.filter((f) => f.level === "fail");
const warns = findings.filter((f) => f.level === "warn");

const report = {
  ranAt: new Date().toISOString(),
  snapshotUpdated: snap.updated || null,
  companies: snap.stocks.length,
  deep,
  verdict: fails.length ? "blocked" : warns.length ? "published with warnings" : "clean",
  findings
};
await fs.writeFile(path.join(DATA, "audit.json"), JSON.stringify(report, null, 2));

for (const f of findings) {
  console.log(`${f.level === "fail" ? "FAIL" : "warn"}  [${f.code}] ${f.msg}`);
  if (f.tickers?.length) {
    const shown = f.tickers.join(", ");
    console.log(`        ${shown}${f.count > f.tickers.length ? ` … and ${f.count - f.tickers.length} more` : ""}`);
  }
}

console.log(
  `\n${snap.stocks.length} companies checked — ${fails.length} blocking, ${warns.length} warnings.\n` +
  `${deep.present} detail files, ${deep.charts} with charts, ${deep.analysts} with an analyst view.`
);

if (fails.length) {
  console.error(
    `\nRefusing to publish. The previous snapshot stays live, which is the right ` +
    `outcome — stale correct data beats fresh broken data. Fix the cause and re-run.`
  );
  process.exit(1);
}
console.log(warns.length ? "\nPublishing with warnings." : "\nClean.");
