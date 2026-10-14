/* ==========================================================================
   StockOrNot — reading a fund's N-PORT
   --------------------------------------------------------------------------
   Every registered fund, ETFs organised as unit investment trusts included,
   files Form NPORT-P with the SEC: its holdings as of the last month of each
   fiscal quarter, made public about 60 days later. This file reads that XML
   and matches the holdings to the companies we score. Pure functions, no
   network and no dependencies: scripts/etfs.mjs downloads, this reads, the
   same split as refresh.mjs and tenk.mjs.

   It lives in scripts/, not lib/, so it is never published or bundled into
   the app (only lib/ is: build-pages.mjs, build-app.mjs).

   It never reads a holding's <cusip>, <isin> or any other vendor identifier.
   CUSIPs are licensed, an ISIN contains one, and this repository is public:
   nothing the job writes may carry them. A holding is identified by its LEI
   (the global legal-entity number, public under CC0), by a ticker the filing
   itself gives, or by its name.
   ========================================================================== */

/* ------------------------------------------------------------- XML helpers */

const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/* Decoded text is always one line: any run of whitespace or control
   characters, a newline written as &#10; included, becomes one space. A
   holding's name is printed in the job's log, and the Actions runner takes a
   line that starts with "::" as a workflow command. */
export function decode(text) {
  return String(text)
    .replace(/&#(\d+);/g, (m, d) => { const n = Number(d); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "; })
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { const n = parseInt(h, 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "; })
    .replace(/&([a-z]+);/gi, (m, name) => ENTITY[name.toLowerCase()] ?? m)
    .replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ")
    .trim();
}

/* The text of the first <tag> in a block, decoded, or null. Element names in
   N-PORT are unique enough within one holding that the first one is the
   holding's own: nested derivative details use other names
   (counterpartyName, counterpartyLei). */
function tag(block, name) {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  return m ? decode(m[1]) : null;
}

function inner(xml, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : "";
}

function attrs(text) {
  const out = {};
  for (const m of text.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) out[m[1]] = decode(m[2]);
  return out;
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round = (v, places) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/* An LEI is 18 letters or digits and two check digits. Filers write "N/A"
   when the issuer has none, or did not look it up. */
const LEI = /^[A-Z0-9]{18}[0-9]{2}$/;

/* ------------------------------------------------------------------ parse */

/**
 * The parts of an NPORT-P primary_doc.xml this project uses.
 *
 * period is repPdDate, the date the holdings are as of. repPdEnd is the
 * fund's fiscal year end, which is often months after the holdings date
 * (SELECT SECTOR SPDR TRUST: repPdEnd 2026-09-30, repPdDate 2026-03-31).
 *
 * rtn maps each share class to its three monthly total returns, in percent.
 * A unit investment trust has no classes, so its one row is under "".
 */
export function parseNport(xml) {
  const text = String(xml || "");
  const gen = inner(text, "genInfo");
  const fund = inner(text, "fundInfo");

  const rtn = {};
  for (const m of fund.matchAll(/<monthlyTotReturn\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    rtn[a.classId || ""] = [num(a.rtn1), num(a.rtn2), num(a.rtn3)];
  }

  const holdings = [];
  for (const m of text.matchAll(/<invstOrSec>([\s\S]*?)<\/invstOrSec>/g)) {
    const h = m[1];
    const lei = (tag(h, "lei") || "").toUpperCase();
    /* only the ticker element inside <identifiers>; the ISIN and "other"
       identifiers beside it are deliberately not read */
    const ids = inner(h, "identifiers");
    const tick = /<ticker\b[^>]*\bvalue="([^"]*)"/.exec(ids);
    holdings.push({
      name: tag(h, "name") || "",
      lei: LEI.test(lei) ? lei : null,
      title: tag(h, "title") || "",
      ticker: tick ? decode(tick[1]).toUpperCase() : null,
      pct: num(tag(h, "pctVal")),
      cat: tag(h, "assetCat") || (/<assetConditional\b[^>]*\bassetCat="([^"]+)"/.exec(h) || [])[1] || null
    });
  }

  return {
    seriesId: tag(gen, "seriesId"),
    seriesName: tag(gen, "seriesName"),
    regCik: tag(gen, "regCik"),
    period: tag(gen, "repPdDate"),
    fyEnd: tag(gen, "repPdEnd"),
    netAssets: num(tag(fund, "netAssets")),
    isFinal: tag(gen, "isFinalFiling") === "Y",
    rtn,
    holdings
  };
}

/** Why a parsed filing must not be used for this fund, or null if it may. */
export function checkFiling(parsed, fund) {
  if (!parsed || !parsed.holdings) return "unreadable N-PORT";
  if (parsed.isFinal) return "final N-PORT: the fund is closing or merging";
  if (fund.series) {
    /* browse-edgar answers by series, but a mix-up has served another
       series' portfolio before (edgartools GH #888), so the filing must name
       the series we asked for */
    if (parsed.seriesId !== fund.series) return "N-PORT series mismatch";
  } else if (parsed.regCik !== fund.trust) {
    return "N-PORT from another registrant";
  }
  if (!parsed.holdings.length) return "N-PORT lists no holdings";
  const sum = parsed.holdings.reduce((a, h) => a + (h.pct || 0), 0);
  /* Securities-lending collateral can lift the total a few points past 100,
     with the matching liability elsewhere; much more than that, or much less
     than 100, is a filing we cannot read the way we think we can. */
  if (!(sum >= 90 && sum <= 110)) return `N-PORT weights sum to ${sum.toFixed(1)}%`;
  return null;
}

/* ------------------------------------------------------------------ names */

/* Words that differ between how a filing names a company and how the SEC or
   our list does ("Procter & Gamble Co/The", "PROCTER & GAMBLE Co",
   "Procter & Gamble"). Checked against all 498 companies' names and SEC
   titles: no two companies collide once these are gone. */
const DROP = new Set([
  "inc", "incorporated", "corp", "corporation", "co", "cos", "company", "companies",
  "plc", "ltd", "limited", "the", "class", "common", "stock", "shares", "ordinary",
  "sa", "ag", "nv", "se", "holdings", "holding", "group", "new", "a", "b", "c"
]);

/** A company name reduced to the words that identify it. */
export function normName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/['’`]/g, "")                  /* "McDonald's" and "MCDONALDS" */
    /* SEC suffixes such as "/DE/", "/MD", "/The" */
    .replace(/[\/\\][a-z]{2,3}[\/\\]?(?=\s|$)/g, " ")
    .replace(/\band\b/g, "&")
    .replace(/[^a-z0-9&]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "&" && !DROP.has(w))
    .join(" ");
}

/** normName -> Set of CIKs, from any number of [name, cik] pairs. */
export function nameIndexOf(pairs) {
  const idx = new Map();
  for (const [name, cik] of pairs) {
    const k = normName(name);
    if (!k || !cik) continue;
    if (!idx.has(k)) idx.set(k, new Set());
    idx.get(k).add(cik);
  }
  return idx;
}

function byName(nameIndex, name) {
  const hit = nameIndex?.get(normName(name));
  return hit && hit.size === 1 ? [...hit][0] : null;
}

/* ---------------------------------------------------------------- matching */

const EQUITY = new Set(["EC", "EP"]);   /* common and preferred equity */
const OUT_MIN = 0.1;                     /* unmatched holdings listed from 0.1% of equity */

/**
 * Matches a fund's equity holdings to tonight's companies.
 *
 * In order: the holding's LEI in the LEI map (lei.json with the hand fixes
 * in etf-list.json laid over it; a fix of null says "not one of ours"), then
 * a ticker the filing gives if it is in tonight's snapshot, then the exact
 * normalised name when it points at one company only. Share classes merge by
 * CIK, so GOOGL and GOOG count once, under the first ticker the snapshot
 * lists for that company.
 *
 * Every percentage returned is of the fund's equity holdings (common and
 * preferred stock), not of its net assets: cash, money-market funds, futures
 * and collateral sit outside that base and are reported as `other`.
 */
export function matchHoldings(holdings, { leiToCik = new Map(), cikToTicker = new Map(), tickerToCik = new Map(), nameIndex = new Map() } = {}) {
  let equity = 0, matched = 0;
  const byCik = new Map();
  const unmatched = new Map();
  const via = { lei: 0, ticker: 0, name: 0 };

  for (const h of holdings || []) {
    if (!EQUITY.has(h.cat) || !(h.pct > 0)) continue;
    equity += h.pct;
    let cik = null, how = null;
    const fixed = h.lei && leiToCik.has(h.lei);
    if (fixed) {
      cik = leiToCik.get(h.lei);
      if (cik) how = "lei";
    }
    if (!fixed) {
      const t = h.ticker ? h.ticker.replace(/[\/\-\s]/g, ".") : null;
      if (t && tickerToCik.has(t)) { cik = tickerToCik.get(t); how = "ticker"; }
      else if ((cik = byName(nameIndex, h.name))) how = "name";
    }
    if (cik && cikToTicker.has(cik)) {
      via[how]++;
      matched += h.pct;
      byCik.set(cik, (byCik.get(cik) || 0) + h.pct);
    } else {
      const key = h.lei || normName(h.name) || h.name;
      const u = unmatched.get(key) || { lei: h.lei, name: h.name, pct: 0 };
      u.pct += h.pct;
      unmatched.set(key, u);
    }
  }

  const share = (pct) => (equity > 0 ? (pct / equity) * 100 : 0);
  const hold = [...byCik].map(([cik, pct]) => [cikToTicker.get(cik), round(share(pct), 3)])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const rest = [...unmatched.values()].sort((a, b) => b.pct - a.pct);
  const out = rest.filter((u) => share(u.pct) >= OUT_MIN).map((u) => [u.lei, u.name, round(share(u.pct), 3)]);

  return {
    hold, out,
    equity: round(equity, 2),
    other: round(100 - equity, 2),
    cover: equity > 0 ? round((matched / equity) * 100, 1) : 0,
    /* every equity position, companies merged, for the concentration
       figures; one we cannot match goes by its name, so a largest holding
       outside the index is named, never shown as an LEI */
    parts: [...hold, ...rest.map((u) => [u.name || u.lei, share(u.pct)])],
    via
  };
}

/**
 * New LEI -> CIK entries from an S&P 500 tracker's holdings. Only funds
 * marked `seed` call this: they hold the index and little else, so a name
 * that matches one of our companies exactly is that company. An LEI that is
 * already known, or fixed by hand, is left alone; an LEI whose holdings point
 * at two different companies is skipped.
 */
export function seedLeis(holdings, nameIndex, { known = new Set(), from = "" } = {}) {
  const found = {};
  const clash = new Set();
  for (const h of holdings || []) {
    if (!h.lei || !EQUITY.has(h.cat) || known.has(h.lei) || clash.has(h.lei)) continue;
    const cik = byName(nameIndex, h.name);
    if (!cik) continue;
    if (found[h.lei] && found[h.lei].cik !== cik) {
      clash.add(h.lei);
      delete found[h.lei];
      continue;
    }
    found[h.lei] = { cik, via: "name", from };
  }
  return found;
}

/* -------------------------------------------------------------- the shape */

/**
 * How spread out a fund is, from [label, weight] pairs (any scale): the
 * effective number of holdings (1 / the sum of squared weights, so n equal
 * holdings give n), the top ten's share, and the largest holding.
 *
 * The screens show effN and top10 as whole numbers, so they are kept to two
 * decimals: kept to one, XLK's 15.47 became 15.5 and showed as "about 16".
 * big1 is shown to one decimal, and kept to one.
 */
export function spreadOf(parts) {
  const w = (parts || []).filter((p) => p[1] > 0).sort((a, b) => b[1] - a[1]);
  const total = w.reduce((a, p) => a + p[1], 0);
  if (!total) return { effN: null, top10: null, big1: null, big1T: null };
  const f = w.map((p) => p[1] / total);
  return {
    effN: round(1 / f.reduce((a, x) => a + x * x, 0), 2),
    top10: round(f.slice(0, 10).reduce((a, x) => a + x, 0) * 100, 2),
    big1: round(f[0] * 100, 1),
    big1T: w[0][0]
  };
}

const OUTSIDE = "Outside the S&P 500";

/**
 * Sector weights of the matched holdings, plus what sits outside the index,
 * to one decimal and adding up to exactly 100. Rounded one by one they could
 * show 99.9 or 100.2; instead each is rounded down to a tenth, and the tenths
 * still missing go to the largest remainders (a tie to the larger sector).
 * Holdings' weights are kept to three decimals, so 498 equal ones can sum to
 * 100.098: the parts are shared out over their own total, never over more
 * than 100.
 */
export function mixOf(hold, sectorOf) {
  const mix = {};
  let inside = 0;
  for (const [t, pct] of hold || []) {
    const s = sectorOf(t) || "Other";
    mix[s] = (mix[s] || 0) + pct;
    inside += pct;
  }
  const parts = [...Object.entries(mix).sort((a, b) => b[1] - a[1]), [OUTSIDE, Math.max(0, 100 - inside)]];
  /* whole hundred-thousandths of a percent, so the sharing out is exact */
  const units = parts.map(([, pct]) => Math.max(0, Math.round(pct * 1e5)));
  const total = units.reduce((a, u) => a + u, 0);
  const tenths = units.map((u) => Math.floor((u * 1000) / total));
  const left = units.map((u, i) => [u * 1000 - tenths[i] * total, i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let n = 1000 - tenths.reduce((a, x) => a + x, 0), k = 0; n > 0; n--, k++) tenths[left[k][1]]++;
  return Object.fromEntries(parts.map(([s], i) => [s, tenths[i] / 10]));
}

/** "full" when we can read at least 80% of the equity and the fund is at
    least 90% equity; "partial" from 30%; "none" below that. */
export function readingOf({ cover, other, hold }) {
  if (!hold?.length) return "none";
  if (cover >= 80 && other <= 10) return "full";
  if (cover >= 30) return "partial";
  return "none";
}
