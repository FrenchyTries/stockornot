/* The nightly ETF data: scripts/nport.mjs (reading N-PORT, matching holdings)
   and scripts/etfs.mjs (the job). Fixtures in tests/fixtures/ are real SEC
   documents, trimmed, with every <cusip>, <isin> and other vendor identifier
   taken out (this repository is public and CUSIPs are licensed):

     nport-xlk.xml       SELECT SECTOR SPDR TRUST, series S000006415 (XLK),
                         NPORT-P 0001410368-26-055331, holdings as of
                         2026-03-31; 8 of its 76 holdings kept
     nport-dia.xml       SPDR DOW JONES INDUSTRIAL AVERAGE ETF TRUST (DIA),
                         NPORT-P 0001752724-25-158219, all 30 holdings
     sec-titles-dia.json the SEC's company_tickers.json rows for those 30
     browse-ivv.html     browse-edgar's page for series S000004310 (IVV)
     ncsr-instance.xml   the XBRL instance of an N-CSR (Alger Portfolios,
                         0001133228-26-002293), three share classes

   The two N-PORTs and the ticker rows come from OpenBB's recorded SEC
   responses (openbb_platform/providers/sec/tests/record), the browse page
   and the N-CSR from edgartools' (tests/fixtures, tests/cassettes). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  parseNport, checkFiling, matchHoldings, seedLeis, spreadOf, mixOf, readingOf, normName, nameIndexOf, decode
} from "../scripts/nport.mjs";
import {
  timeGuard, loadList, due, needsReread, nextPeriod, filingsFromBrowse, filingFromSubmissions,
  readExpenseRatios, mergeCloses, shouldReplace, main
} from "../scripts/etfs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");
const fixture = (f) => fs.readFile(path.join(FIX, f), "utf8");

/* Every key of every object in a value, however deep. */
function keysOf(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

/* ------------------------------------------------- an inline N-PORT, by hand
   The identifier values are placeholders, not real CUSIPs or ISINs: the
   point is that the parser never reads those elements at all. */

const holding = ({ name, lei = "N/A", title = name, pct, cat = "EC", ticker = null, extra = "" }) => `
      <invstOrSec>
        <name>${name}</name>
        <lei>${lei}</lei>
        <title>${title}</title>
        <cusip>XXXXXXXXX</cusip>
        <identifiers>
          <isin value="XX0000000000"/>${ticker ? `\n          <ticker value="${ticker}"/>` : ""}
        </identifiers>
        <balance>100.00000000</balance>
        <units>NS</units>
        <curCd>USD</curCd>
        <valUSD>1000.00000000</valUSD>
        <pctVal>${pct}</pctVal>
        <payoffProfile>Long</payoffProfile>
        <assetCat>${cat}</assetCat>
        <issuerCat>CORP</issuerCat>
        <invCountry>US</invCountry>${extra}
      </invstOrSec>`;

const APPLE = "HWUPKR0MPOU8FGXBT394", ALPHABET = "5493006MHB84DD0ZWV18", NESTLE = "KY37LUS27QQX7BB93L28";

function nportXml({ series = "S000004310", cik = "0001100663", final = "N", holdings, period = "2026-06-30" } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?><edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
  <headerData><submissionType>NPORT-P</submissionType></headerData>
  <formData>
    <genInfo>
      <regName>A TEST TRUST</regName>
      <regCik>${cik}</regCik>
      <seriesName>A Test S&amp;P 500 ETF</seriesName>${series ? `\n      <seriesId>${series}</seriesId>` : ""}
      <repPdEnd>2027-03-31</repPdEnd>
      <repPdDate>${period}</repPdDate>
      <isFinalFiling>${final}</isFinalFiling>
    </genInfo>
    <fundInfo>
      <totAssets>1000000000.00</totAssets>
      <netAssets>990000000.00</netAssets>
      <returnInfo>
        <monthlyTotReturns>
          <monthlyTotReturn classId="C000012040" rtn1="1.10000000" rtn2="-0.50000000" rtn3="2.00000000"/>
        </monthlyTotReturns>
      </returnInfo>
    </fundInfo>
    <invstOrSecs>${holdings.map(holding).join("")}
    </invstOrSecs>
  </formData>
</edgarSubmission>`;
}

const INLINE = [
  { name: "Apple Inc", lei: APPLE, pct: 40 },
  { name: "Alphabet Inc", lei: ALPHABET, title: "Alphabet Inc Class A", pct: 20 },
  { name: "Alphabet Inc", lei: ALPHABET, title: "Alphabet Inc Class C", pct: 15 },
  { name: "Chevron Corp", pct: 10 },                                    /* LEI "N/A", as DIA's real filing has it */
  { name: "Nestle SA", lei: NESTLE, pct: 9 },                          /* not one of ours */
  { name: "Unknown Holdings Corp", pct: 1, ticker: "ZZZZ" },          /* "N/A", no name or ticker we know */
  { name: "State Street Global Advisors", lei: "549300BZ5TGIFZUZDZ37", title: "State Street Institutional US Government Money Market Fund", pct: 5.2, cat: "STIV" },
  { name: "Chicago Mercantile Exchange", lei: "SNZ2OJLFK8MNNCLQOF39", title: "E-MINI S&P 500 DEC26", pct: -0.2, cat: "DE",
    extra: "\n        <derivativeInfo><futrDeriv derivCat=\"FUT\"><counterparties><counterpartyName>Chicago Mercantile Exchange</counterpartyName><counterpartyLei>SNZ2OJLFK8MNNCLQOF39</counterpartyLei></counterparties></futrDeriv></derivativeInfo>" }
];

/* Tonight's companies, as the snapshot gives them. */
const STOCKS = [
  { t: "AAPL", n: "Apple", s: "Information Technology", cik: "0000320193" },
  { t: "GOOGL", n: "Alphabet (Class A)", s: "Communication Services", cik: "0001652044" },
  { t: "GOOG", n: "Alphabet (Class C)", s: "Communication Services", cik: "0001652044" },
  { t: "CVX", n: "Chevron", s: "Energy", cik: "0000093410" }
];

function lookups(stocks = STOCKS, extraNames = []) {
  const cikToTicker = new Map(), tickerToCik = new Map();
  for (const s of stocks) { if (!cikToTicker.has(s.cik)) cikToTicker.set(s.cik, s.t); tickerToCik.set(s.t, s.cik); }
  const nameIndex = nameIndexOf([...stocks.map((s) => [s.n, s.cik]), ...extraNames]);
  return { cikToTicker, tickerToCik, tickerSet: new Set(tickerToCik.keys()), nameIndex };
}

/* --------------------------------------------------------------- parsing */

test("1. an N-PORT is read without its CUSIPs or ISINs", () => {
  const p = parseNport(nportXml({ holdings: INLINE }));
  assert.equal(p.seriesId, "S000004310");
  assert.equal(p.regCik, "0001100663");
  assert.equal(p.seriesName, "A Test S&P 500 ETF");
  assert.equal(p.period, "2026-06-30");          /* repPdDate, not the fiscal year end */
  assert.equal(p.fyEnd, "2027-03-31");
  assert.equal(p.netAssets, 990000000);
  assert.equal(p.isFinal, false);
  assert.deepEqual(p.rtn, { C000012040: [1.1, -0.5, 2] });
  assert.equal(p.holdings.length, 8);
  const [apple, a, c, chevron, , unknown, stiv, future] = p.holdings;
  assert.deepEqual(apple, { name: "Apple Inc", lei: APPLE, title: "Apple Inc", ticker: null, pct: 40, cat: "EC" });
  assert.equal(a.lei, c.lei);
  assert.equal(chevron.lei, null);               /* "N/A" is no LEI */
  assert.equal(unknown.ticker, "ZZZZ");
  assert.equal(stiv.cat, "STIV");
  assert.equal(future.cat, "DE");
  assert.equal(future.pct, -0.2);
  assert.equal(future.lei, "SNZ2OJLFK8MNNCLQOF39");
  const keys = keysOf(p);
  assert.ok(!keys.has("cusip") && !keys.has("isin"), [...keys].join(","));
  assert.ok(!JSON.stringify(p).includes("XXXXXXXXX") && !JSON.stringify(p).includes("XX0000000000"));
});

test("SEC text is read as one line, so it can never start a line of the job's log", () => {
  /* the Actions runner takes a log line starting with "::" as a command */
  assert.equal(decode("Acme&#10;::error title=x::injected"), "Acme ::error title=x::injected");
  assert.equal(decode(" A\r\n\tB&#x0D;&#13;&#x85;C\u2028D&#11;\u0000E  "), "A B C D E");
  assert.equal(decode("Procter &amp; Gamble  Co/The"), "Procter & Gamble Co/The");
  const p = parseNport(nportXml({ holdings: [
    { name: "Acme&#10;::error title=x::injected", pct: 50 },
    { name: "Widget\r\n::warning::Corp", title: "Widget&#13;&#10;Corp", pct: 50 }
  ] }));
  assert.deepEqual(p.holdings.map((h) => h.name), ["Acme ::error title=x::injected", "Widget ::warning::Corp"]);
  assert.equal(p.holdings[1].title, "Widget Corp");
});

test("a real N-PORT (XLK, trimmed) reads as it was filed", async () => {
  const xml = await fixture("nport-xlk.xml");
  assert.ok(!/<cusip>|<isin\b|<other\b/.test(xml), "the fixture itself carries no identifiers");
  const p = parseNport(xml);
  assert.equal(p.seriesId, "S000006415");
  assert.equal(p.regCik, "0001064641");
  assert.equal(p.period, "2026-03-31");
  assert.equal(p.fyEnd, "2026-09-30");
  assert.equal(p.netAssets, 84198427150.26);
  assert.deepEqual(p.rtn, { C000017601: [-0.04, -3.56, -4.07] });
  assert.deepEqual(p.holdings.map((h) => h.cat), ["EC", "EC", "STIV", "EC", "EC", "EC", "STIV", "DE"]);
  const sandisk = p.holdings.find((h) => h.name === "Sandisk Corp/DE");
  assert.equal(sandisk.lei, null);
  const future = p.holdings.find((h) => h.cat === "DE");
  assert.ok(future.pct < 0);
  assert.equal(future.title, "XAK TECHNOLOGY JUN26");
  assert.ok(p.holdings.every((h) => h.ticker === null));
  /* trimmed to 8 holdings, so the weights no longer sum to 100 */
  assert.match(checkFiling(p, { series: "S000006415", trust: "0001064641" }), /sum/);
});

test("a real unit-trust N-PORT (DIA) has no series and passes on its registrant", async () => {
  const p = parseNport(await fixture("nport-dia.xml"));
  assert.equal(p.seriesId, null);
  assert.equal(p.period, "2025-04-30");
  assert.deepEqual(p.rtn, { "": [-1.4, -4.07, -3.1] });
  assert.equal(p.holdings.length, 30);
  assert.ok(p.holdings.every((h) => h.cat === "EC"));
  assert.equal(p.holdings.find((h) => h.name === "Chevron Corp").lei, null);
  assert.equal(checkFiling(p, { series: null, trust: "0001041130" }), null);
  assert.equal(checkFiling(p, { series: null, trust: "0000884394" }), "N-PORT from another registrant");

  /* and every one of its 30 holdings matches a company, by name, through
     the SEC's titles: Chevron included, whose LEI the filing leaves out */
  const sp = JSON.parse(await fs.readFile(path.join(HERE, "..", "data", "sp500.json"), "utf8")).companies;
  const titles = Object.values(JSON.parse(await fixture("sec-titles-dia.json")))
    .map((r) => [r.title, String(r.cik_str).padStart(10, "0")]);
  const m = matchHoldings(p.holdings, lookups(sp, titles));
  assert.equal(m.cover, 100);
  assert.equal(m.hold.length, 30);
  assert.ok(m.hold.some(([t]) => t === "CVX"));
  assert.deepEqual(m.out, []);
});

/* -------------------------------------------------------------- matching */

test("2. holdings match by LEI, ticker and name; classes merge; cash and futures stay outside", () => {
  const p = parseNport(nportXml({ holdings: INLINE }));
  const L = lookups();
  const leiToCik = new Map([[APPLE, "0000320193"], [ALPHABET, "0001652044"]]);
  const m = matchHoldings(p.holdings, { ...L, leiToCik });
  /* equity is everything but the money-market fund and the future */
  assert.equal(m.equity, 95);
  assert.equal(m.other, 5);
  /* Apple 40 + Alphabet 35 + Chevron 10 of 95 */
  assert.equal(m.cover, 89.5);
  assert.deepEqual(m.hold.map(([t]) => t), ["AAPL", "GOOGL", "CVX"]);
  assert.equal(m.hold[1][1], +(35 / 95 * 100).toFixed(3));
  assert.deepEqual(m.via, { lei: 3, ticker: 0, name: 1 });
  /* the unknown "N/A" holding and Nestle are listed for a hand fix */
  assert.deepEqual(m.out.map(([lei, name]) => [lei, name]), [[NESTLE, "Nestle SA"], [null, "Unknown Holdings Corp"]]);
  assert.equal(readingOf(m), "full");

  /* a ticker the filing gives counts when it is one of tonight's */
  const t = matchHoldings([{ name: "Some Name", lei: null, ticker: "AAPL", pct: 50, cat: "EC" }, { name: "x", pct: 50, cat: "EC" }], L);
  assert.deepEqual(t.via, { lei: 0, ticker: 1, name: 0 });
  assert.equal(t.cover, 50);
  assert.equal(readingOf(t), "partial");

  /* a hand fix of null says "not ours", even when the name would match */
  const blocked = matchHoldings([{ name: "Apple Inc", lei: APPLE, pct: 100, cat: "EC" }], { ...L, leiToCik: new Map([[APPLE, null]]) });
  assert.equal(blocked.cover, 0);
  assert.equal(readingOf(blocked), "none");

  /* the lines the reading is drawn at: the app takes "full" as given and
     shows a number for it, so each edge is pinned */
  const H = [["A", 1]];
  assert.equal(readingOf({ cover: 80, other: 10, hold: H }), "full");
  assert.equal(readingOf({ cover: 79.9, other: 0, hold: H }), "partial");
  assert.equal(readingOf({ cover: 100, other: 10.1, hold: H }), "partial");
  assert.equal(readingOf({ cover: 30, other: 0, hold: H }), "partial");
  assert.equal(readingOf({ cover: 29.9, other: 0, hold: H }), "none");
  assert.equal(readingOf({ cover: 100, other: 0, hold: [] }), "none");
});

test("3. LEIs are learned only on an exact, single name match, and never over a hand fix", () => {
  const p = parseNport(nportXml({ holdings: INLINE }));
  const { nameIndex } = lookups();
  const found = seedLeis(p.holdings, nameIndex, { known: new Set(), from: "IVV 2026-06-30" });
  assert.deepEqual(found, {
    [APPLE]: { cik: "0000320193", via: "name", from: "IVV 2026-06-30" },
    [ALPHABET]: { cik: "0001652044", via: "name", from: "IVV 2026-06-30" }
  });
  /* a name that points at two companies adds nothing */
  const twice = nameIndexOf([["Apple", "0000320193"], ["Apple Inc.", "0000000001"]]);
  assert.deepEqual(seedLeis(p.holdings, twice, {}), {});
  /* one LEI on two holdings whose names are two different companies is
     learned for neither, whichever comes last */
  const clash = [
    { name: "Apple Inc", lei: APPLE, pct: 50, cat: "EC" },
    { name: "Chevron Corp", lei: APPLE, pct: 50, cat: "EC" }
  ];
  assert.deepEqual(seedLeis(clash, nameIndex, {}), {});
  assert.deepEqual(seedLeis([...clash, { name: "Apple Inc", lei: APPLE, pct: 1, cat: "EC" }], nameIndex, {}), {});
  /* an LEI fixed by hand (or already known) is left alone */
  assert.deepEqual(Object.keys(seedLeis(p.holdings, nameIndex, { known: new Set([APPLE]) })), [ALPHABET]);
  /* and the hand fix wins when matching */
  const L = lookups();
  const m = matchHoldings(p.holdings, { ...L, leiToCik: new Map([[APPLE, "0000093410"]]) });
  assert.equal(m.hold.find(([t]) => t === "CVX")[1], +(50 / 95 * 100).toFixed(3));
});

test("names are reduced the same way on both sides", () => {
  assert.equal(normName("Procter & Gamble Co/The"), normName("PROCTER & GAMBLE Co"));
  assert.equal(normName("McDonald's Corp"), normName("MCDONALDS CORP"));
  assert.equal(normName("Berkshire Hathaway Inc/DE"), "berkshire hathaway");
  assert.equal(normName("Alphabet Inc Class C"), "alphabet");
  assert.equal(normName("JPMorgan Chase & Co"), "jpmorgan chase");
});

/* ----------------------------------------------------------------- shape */

test("4. spread: n equal holdings are n effective holdings", () => {
  const eq = Array.from({ length: 50 }, (_, i) => ["T" + i, 2]);
  assert.deepEqual(spreadOf(eq), { effN: 50, top10: 20, big1: 2, big1T: "T0" });
  const s = spreadOf([["A", 50], ["B", 30], ["C", 20]]);
  assert.equal(s.effN, +(1 / (0.25 + 0.09 + 0.04)).toFixed(2));
  assert.deepEqual([s.top10, s.big1, s.big1T], [100, 50, "A"]);
  assert.deepEqual(spreadOf([]), { effN: null, top10: null, big1: null, big1T: null });

  /* The screens show effN and top10 as whole numbers, so they are kept to
     two decimals. Kept to one, XLK's 15.472 was 15.5 and showed as "about
     16"; a top ten of 61.46% was 61.5 and showed as 62%. */
  const xlk = spreadOf([...Array.from({ length: 15 }, (_, i) => ["T" + i, 1]), ["U", 0.27]]);
  assert.equal(xlk.effN, 15.47);
  assert.equal(Math.round(xlk.effN), 15);
  const ten = spreadOf([...Array.from({ length: 10 }, (_, i) => ["A" + i, 6.146]), ...Array.from({ length: 20 }, (_, i) => ["B" + i, 1.927])]);
  assert.equal(ten.top10, 61.46);
  assert.equal(Math.round(ten.top10), 61);
  assert.equal(ten.big1, 6.1);          /* shown to one decimal, kept to one */

  const mix = mixOf([["AAPL", 40], ["GOOGL", 35], ["CVX", 10]], (t) => STOCKS.find((x) => x.t === t)?.s);
  assert.deepEqual(mix, { "Information Technology": 40, "Communication Services": 35, Energy: 10, "Outside the S&P 500": 15 });
});

/* A sector mix in whole tenths of a percent, summed exactly. */
const tenthsOf = (mix) => Object.values(mix).reduce((a, v) => a + Math.round(v * 10), 0);

test("the sector mix adds up to exactly 100, each part within a tenth of its share", () => {
  const sectorOf = (t) => t.slice(0, 1);
  /* rounded one by one these were 99.9 and 100.2 */
  assert.deepEqual(mixOf([["A", 100 / 3], ["B", 100 / 3], ["C", 100 / 3]], sectorOf),
    { A: 33.4, B: 33.3, C: 33.3, "Outside the S&P 500": 0 });
  assert.deepEqual(mixOf([["A", 24.96], ["B", 24.96], ["C", 24.96], ["D", 24.96]], sectorOf),
    { A: 25, B: 25, C: 25, D: 24.9, "Outside the S&P 500": 0.1 });
  /* 498 equal weights kept to three decimals sum to 100.098 (RSP): shared
     out over their own total, with nothing outside */
  const rsp = Array.from({ length: 498 }, (_, i) => ["ABCDEFGHIJK"[i % 11] + i, 0.201]);
  const r = mixOf(rsp, sectorOf);
  assert.equal(tenthsOf(r), 1000);
  assert.equal(r["Outside the S&P 500"], 0);
  /* no holdings at all: everything is outside */
  assert.deepEqual(mixOf([], sectorOf), { "Outside the S&P 500": 100 });

  /* and on a thousand made-up funds, whatever their weights */
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let n = 0; n < 1000; n++) {
    const k = 1 + Math.floor(rnd() * 40);
    const raw = Array.from({ length: k }, () => rnd() ** 3);
    const total = raw.reduce((a, x) => a + x, 0);
    const inside = rnd() < 0.3 ? 100 + rnd() * 0.1 : 30 + rnd() * 70;
    const hold = raw.map((x, i) => ["ABCDEFGHIJK"[i % 11] + i, Math.round((x / total) * inside * 1000) / 1000]).filter((h) => h[1] > 0);
    const m = mixOf(hold, sectorOf);
    assert.equal(tenthsOf(m), 1000, JSON.stringify(m));
    const sum = hold.reduce((a, h) => a + h[1], 0);
    const exact = {};
    for (const [t, w] of hold) exact[sectorOf(t)] = (exact[sectorOf(t)] || 0) + (w * 100) / Math.max(100, sum);
    exact["Outside the S&P 500"] = Math.max(0, 100 - sum);
    assert.deepEqual(Object.keys(m).sort(), Object.keys(exact).sort());
    for (const [s, v] of Object.entries(m)) {
      assert.ok(Math.abs(v - exact[s]) < 0.1 + 1e-9 && v >= 0 && v === Math.round(v * 10) / 10, `${s}: ${v} for ${exact[s]}`);
    }
  }
});

test("5. a filing for another series, one that does not add up, or a final one is refused", () => {
  const fund = { t: "IVV", series: "S000004310", trust: "0001100663" };
  const ok = parseNport(nportXml({ holdings: INLINE }));
  assert.equal(checkFiling(ok, fund), null);
  assert.equal(checkFiling(parseNport(nportXml({ series: "S000004311", holdings: INLINE })), fund), "N-PORT series mismatch");
  assert.equal(checkFiling(parseNport(nportXml({ series: null, holdings: INLINE })), fund), "N-PORT series mismatch");
  const short = INLINE.map((h) => ({ ...h, pct: h.pct * 0.85 }));
  assert.match(checkFiling(parseNport(nportXml({ holdings: short })), fund), /sum to 85\.0%/);
  /* collateral can lift the total a little past 100, not to 111 */
  const lifted = INLINE.map((h) => ({ ...h, pct: h.pct * 1.11 }));
  assert.match(checkFiling(parseNport(nportXml({ holdings: lifted })), fund), /sum to 111\.0%/);
  const edge = INLINE.map((h) => ({ ...h, pct: h.pct * 1.09 }));
  assert.equal(checkFiling(parseNport(nportXml({ holdings: edge })), fund), null);
  assert.match(checkFiling(parseNport(nportXml({ final: "Y", holdings: INLINE })), fund), /final/);
});

/* ----------------------------------------------------------------- the job */

test("6. the list refuses an S&P 500 ticker, a malformed one, a duplicate, and an untraced fee", () => {
  const raw = { v: 1, leiFix: { [APPLE]: "0000320193", BAD: "1", [NESTLE]: null }, funds: [
    { t: "VOO", n: "Vanguard S&P 500 ETF", trust: "0000036405", series: "S000002839", class: "C000092055", er: 0.03, erUrl: "https://www.sec.gov/x", erAsOf: "2026-04-29" },
    { t: "AAPL", n: "Not a fund", trust: "0000320193", series: null, class: null },
    { t: "voo2", n: "Lower case", trust: "0000036405", series: null, class: null },
    { t: "VOO", n: "Twice", trust: "0000036405", series: "S000002839", class: "C000092055" },
    { t: "IVV", n: "iShares Core S&P 500 ETF", trust: "0001100663", series: "S000004310", class: "C000012040", er: 0.03, erUrl: null, erAsOf: null },
    { t: "QQQ", n: "Invesco QQQ", trust: "1067839", series: null, class: null }
  ] };
  const l = loadList(raw, new Set(["AAPL", "MSFT"]));
  assert.deepEqual(l.funds.map((f) => f.t), ["VOO", "IVV"]);
  assert.deepEqual(l.refused, [
    { t: "AAPL", why: "also an S&P 500 company" },
    { t: "voo2", why: "malformed ticker" },
    { t: "VOO", why: "listed twice" },
    { t: "QQQ", why: "malformed trust CIK" }
  ]);
  assert.equal(l.funds[0].er, 0.03);
  assert.equal(l.funds[1].er, null);              /* a fee with no SEC document behind it is dropped */
  assert.deepEqual([...l.leiFix], [[APPLE, "0000320193"], [NESTLE, null]]);
  assert.throws(() => loadList({}), /no funds/);
});

test("the real list is well formed, apart from the S&P 500 and with no fee typed from memory", async () => {
  const raw = JSON.parse(await fs.readFile(path.join(HERE, "..", "data", "etf-list.json"), "utf8"));
  const sp = JSON.parse(await fs.readFile(path.join(HERE, "..", "data", "sp500.json"), "utf8")).companies;
  const l = loadList(raw, new Set(sp.map((c) => c.t)));
  assert.equal(l.refused.length, 0, JSON.stringify(l.refused));
  assert.equal(l.funds.length, 53);
  assert.deepEqual(l.funds.filter((f) => f.seed).map((f) => f.t), ["VOO", "IVV", "SPY", "SPYM"]);
  assert.deepEqual(l.funds.filter((f) => !f.series).map((f) => f.t), ["SPY", "DIA"]);
  const spym = l.funds.find((f) => f.t === "SPYM");
  assert.deepEqual([spym.trust, spym.series, spym.class], ["0001064642", "S000006983", "C000019036"]);
  /* A fee without its sec.gov source and date, or a malformed leiFix, is
     dropped by loadList with only a note in the night's log: here it fails. */
  assert.deepEqual(l.notes, [], JSON.stringify(l.notes));
  assert.ok(!/cusip|isin/i.test(JSON.stringify(raw)));
});

test("7. yesterday's file stays when far fewer funds are priced or read, for five days at most", () => {
  const rec = (t, priced = true, held = true) => ({ t, price: priced ? 100 : null, hold: held ? [["AAPL", 1]] : [] });
  const next = (n, h = n) => ({ session: "2026-10-15", etfs: Array.from({ length: 51 }, (_, i) => rec("F" + i)), counts: { listed: 51, priced: n, withHoldings: h } });
  /* the first file turns the ETF side on, so most funds must have their
     holdings; prices are not asked for, as Finnhub may not quote ETFs */
  assert.deepEqual(shouldReplace(null, next(0, 41)), { ok: true, why: "first night" });
  assert.deepEqual(shouldReplace(null, next(51, 40)), { ok: false, why: "only 40 of 51 funds with holdings, too few for a first file" });
  /* an SEC that never answered: fifty priced cards with nothing in them */
  assert.equal(shouldReplace({ etfs: [] }, next(51, 0)).ok, false);
  /* not even on the first night is a file of empty records written */
  assert.deepEqual(shouldReplace(null, next(0, 0)), { ok: false, why: "nothing was priced or read tonight" });
  const prev = { session: "2026-10-14", etfs: Array.from({ length: 51 }, (_, i) => rec("F" + i)) };
  assert.equal(shouldReplace(prev, next(40)).ok, false);
  assert.match(shouldReplace(prev, next(40)).why, /40 funds priced against 51/);
  assert.equal(shouldReplace(prev, next(46)).ok, true);
  assert.equal(shouldReplace(prev, next(51, 40)).ok, false);
  /* a price carried over from an earlier night does not count as priced */
  const stale = { etfs: prev.etfs.map((r, i) => (i < 20 ? { ...r, stale: "2026-10-12" } : r)) };
  assert.equal(shouldReplace(stale, next(31, 51)).ok, true);
  assert.equal(shouldReplace(stale, next(27, 51)).ok, false);
  /* funds taken off the list are not a drop */
  const fewer = { etfs: prev.etfs.slice(0, 30), counts: { priced: 30, withHoldings: 30 } };
  assert.equal(shouldReplace(prev, fewer).ok, true);

  /* A drop that lasts: once the file kept is more than five days older than
     tonight's session, tonight's is written anyway, with a warning, and the
     drop is the next night's baseline. Otherwise every fund froze for good. */
  const kept = (session) => ({ ...prev, session });
  assert.deepEqual(shouldReplace(kept("2026-10-10"), next(40)), { ok: false, why: "only 40 funds priced against 51 yesterday" });
  assert.deepEqual(shouldReplace(kept("2026-10-09"), next(40)),
    { ok: true, why: "only 40 funds priced against 51 yesterday, but the file kept is 6 days old", warn: true });
  assert.deepEqual(shouldReplace(kept("2026-10-09"), next(51, 40)),
    { ok: true, why: "only 40 funds with holdings against 51 yesterday, but the file kept is 6 days old", warn: true });
  /* an old file with no drop is replaced the ordinary way, with nothing to warn of */
  assert.deepEqual(shouldReplace(kept("2026-09-01"), next(51)), { ok: true, why: null });
  /* and the age never lets an empty night through */
  assert.equal(shouldReplace(kept("2026-09-01"), next(0, 0)).ok, false);
});

test("8. closes: one per session, sorted, at most 1,300", () => {
  let c = mergeCloses([["2026-10-13", 10], ["2026-10-09", 9]], "2026-10-12", 11);
  assert.deepEqual(c, [["2026-10-09", 9], ["2026-10-12", 11], ["2026-10-13", 10]]);
  c = mergeCloses(c, "2026-10-13", 12.345678);
  assert.deepEqual(c.at(-1), ["2026-10-13", 12.3457]);
  assert.equal(c.length, 3);
  assert.deepEqual(mergeCloses(c, "2026-10-14", null), c);
  const long = Array.from({ length: 1300 }, (_, i) => [new Date(Date.UTC(2020, 0, 1) + i * 864e5).toISOString().slice(0, 10), i]);
  const capped = mergeCloses(long, "2030-01-01", 1);
  assert.equal(capped.length, 1300);
  assert.deepEqual(capped[0], long[1]);
  assert.deepEqual(capped.at(-1), ["2030-01-01", 1]);
});

test("9. the time guard: late in the job it skips, otherwise 12 minutes or the time left less 10", () => {
  const start = 1_800_000_000;   /* seconds, as `date +%s` writes it */
  const at = (min) => (start + min * 60) * 1000;
  assert.equal(timeGuard(String(start), at(151)).skip, true);
  assert.deepEqual(timeGuard(String(start), at(100)), { skip: false, elapsed: 100, budgetMs: 12 * 60e3 });
  assert.equal(timeGuard(String(start), at(150)).budgetMs, 12 * 60e3);
  assert.equal(timeGuard(String(start), at(0)).budgetMs, 12 * 60e3);
  assert.deepEqual(timeGuard(undefined, at(500)), { skip: false, elapsed: null, budgetMs: 12 * 60e3 });
  assert.equal(timeGuard("garbage", at(1)).skip, false);
});

test("when to ask the SEC, and when last night's reading is out of date", () => {
  const f = { t: "VOO" };
  assert.equal(due(f, {}, "2026-10-14"), true);
  assert.equal(due(f, { checked: "2026-10-13", period: "2026-03-31" }, "2026-10-14"), false);
  assert.equal(due(f, { checked: "2026-10-01", period: "2026-03-31" }, "2026-10-14"), true);
  /* the June quarter's filing is due 50-80 days after June 30 */
  assert.equal(nextPeriod("2026-03-31"), "2026-06-30");
  assert.equal(nextPeriod("2025-11-30"), "2026-02-28");
  assert.equal(due(f, { checked: "2026-08-24", period: "2026-03-31" }, "2026-08-26"), true);
  assert.equal(due(f, { checked: "2026-08-25", period: "2026-03-31" }, "2026-08-26"), false);
  /* the June filing was missed; the September one is due in late November */
  assert.equal(nextPeriod("2026-03-31", 2), "2026-09-30");
  assert.equal(due(f, { checked: "2026-11-21", period: "2026-03-31" }, "2026-11-23"), true);
  assert.equal(due(f, { checked: "2026-10-12", period: "2026-03-31" }, "2026-10-14"), false);

  const L = { leiToCik: new Map([[NESTLE, "0000320193"]]), cikToTicker: new Map([["0000320193", "AAPL"]]), tickerSet: new Set(["AAPL"]) };
  const rec = { nport: { accession: "a", read: "2026-10-01" }, hold: [["AAPL", 50]], out: [] };
  assert.equal(needsReread(rec, L, false, "2026-10-14"), false);
  assert.equal(needsReread({ ...rec, hold: [["FI", 50]] }, L, false, "2026-10-14"), true);       /* a rename */
  /* a company that only failed to quote tonight is not a reason */
  assert.equal(needsReread({ ...rec, hold: [["FI", 50]] }, { ...L, absent: new Set(["FI"]) }, false, "2026-10-14"), false);
  assert.equal(needsReread({ ...rec, out: [[NESTLE, "Nestle SA", 9]] }, L, false, "2026-10-14"), true);
  assert.equal(needsReread({ ...rec, nport: { accession: "a", read: "2026-09-01" } }, L, true, "2026-10-14"), true);
});

test("browse-edgar rows (a real page): the newest original N-PORT, not its amendment", async () => {
  const rows = filingsFromBrowse(await fixture("browse-ivv.html"));
  assert.deepEqual(rows.map((r) => r.form), ["497J", "NPORT-P/A", "N-CSR", "NPORT-P", "NPORT-P", "N-CSRS"]);
  assert.deepEqual(rows.find((r) => r.form === "NPORT-P"), { form: "NPORT-P", accession: "0002071691-26-012459", filed: "2026-05-28" });
  assert.equal(rows.find((r) => r.form === "N-CSR" || r.form === "N-CSRS").accession, "0001100663-26-000037");
  assert.deepEqual(filingsFromBrowse("<p>No matching Ticker Symbol.</p>"), []);

  const sub = { filings: { recent: { form: ["N-CSR", "NPORT-P", "NPORT-P"], accessionNumber: ["1", "0001752724-25-158219", "3"], filingDate: ["x", "2025-06-27", "y"], reportDate: ["", "2025-04-30", ""] } } };
  assert.deepEqual(filingFromSubmissions(sub, "NPORT-P"), { form: "NPORT-P", accession: "0001752724-25-158219", filed: "2025-06-27", period: "2025-04-30" });
  assert.equal(filingFromSubmissions({}, "NPORT-P"), null);
});

test("expense ratios from a real shareholder report's XBRL", async () => {
  const r = readExpenseRatios(await fixture("ncsr-instance.xml"));
  assert.deepEqual(r, { type: "N-CSR", period: "2025-12-31", byClass: { C000025034: 0.94, C000025033: 1.19, C000025024: 0.81 } });

  /* a context with a second dimension is not a class's own figure, and a
     fraction that reads as more than 3% is a misread */
  const odd = `<xbrl xmlns:oef="http://xbrl.sec.gov/oef/2025" xmlns:dei="http://xbrl.sec.gov/dei/2025">
    <context id="a"><entity><segment><xbrldi:explicitMember dimension="oef:ClassAxis">x:C000000001Member</xbrldi:explicitMember><xbrldi:explicitMember dimension="srt:ProductOrServiceAxis">x:OtherMember</xbrldi:explicitMember></segment></entity><period><endDate>2025-12-31</endDate></period></context>
    <context id="b"><entity><segment><xbrldi:explicitMember dimension="oef:ClassAxis">x:C000000002Member</xbrldi:explicitMember></segment></entity><period><endDate>2025-12-31</endDate></period></context>
    <context id="c"><entity><segment><xbrldi:explicitMember dimension="dei:LegalEntityAxis">x:C000000003Member</xbrldi:explicitMember></segment></entity><period><endDate>2025-06-30</endDate></period></context>
    <context id="d"><entity><segment><xbrldi:explicitMember dimension="dei:LegalEntityAxis">x:C000000003Member</xbrldi:explicitMember></segment></entity><period><endDate>2025-12-31</endDate></period></context>
    <oef:ExpenseRatioPct contextRef="a" unitRef="pure">0.0010</oef:ExpenseRatioPct>
    <oef:ExpenseRatioPct contextRef="b" unitRef="pure">0.94</oef:ExpenseRatioPct>
    <oef:ExpenseRatioPct contextRef="c" unitRef="pure">0.0005</oef:ExpenseRatioPct>
    <oef:ExpenseRatioPct contextRef="d" unitRef="pure">0.000945</oef:ExpenseRatioPct>
  </xbrl>`;
  assert.deepEqual(readExpenseRatios(odd).byClass, { C000000003: 0.0945 });
});

/* ------------------------------------------------- 10. the whole night, end to end */

/* `hits` holds every request's path and query, `agents` the User-Agent each
   one was sent with. A reply of null never answers: the request is held
   open until the client gives up or the server closes. */
async function mockSec(handlers) {
  const hits = [], agents = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    hits.push(u.pathname + u.search);
    agents.push(req.headers["user-agent"]);
    for (const [test, reply] of handlers) {
      if (test(u)) {
        const answer = reply(u);
        if (!answer) return;
        const [status, body, type] = answer;
        res.writeHead(status, { "Content-Type": type || "text/plain" });
        return res.end(body);
      }
    }
    res.writeHead(404); res.end("not here");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, hits, agents,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); }
  };
}

/* A scratch data folder holding tonight's companies (the real S&P 500 list,
   as the snapshot gives it) and the fund list given. */
async function scratchData(funds) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "etfs-"));
  const sp = JSON.parse(await fs.readFile(path.join(HERE, "..", "data", "sp500.json"), "utf8"));
  await fs.writeFile(path.join(dir, "sp500.json"), JSON.stringify(sp));
  await fs.writeFile(path.join(dir, "snapshot.json"), JSON.stringify({ stocks: sp.companies.map(({ t, n, s, cik }) => ({ t, n, s, cik, price: 100, mc: 1 })) }));
  await writeList(dir, funds);
  return dir;
}

const writeList = (dir, funds, leiFix = {}) =>
  fs.writeFile(path.join(dir, "etf-list.json"), JSON.stringify({ v: 1, leiFix, funds }));

/* browse-edgar's series page, as filingsFromBrowse reads it */
const browsePage = (rows) => `<html><body><table class="tableFile2">${rows.map(([form, acc, filed]) =>
  `<tr><td nowrap="nowrap">${form}</td><td nowrap="nowrap"><a href="#">Documents</a></td><td class="small">Acc-no:&nbsp;${acc}&nbsp;(40 Act)</td><td>${filed}</td><td></td></tr>`).join("")}</table></body></html>`;

/* main() with its one summary line (and any warning) caught, and its
   per-fund notes silenced */
async function quietly(run) {
  const log = console.log, warn = console.warn;
  const lines = [];
  console.log = (s) => lines.push(String(s));
  console.warn = () => {};
  try { return { result: await run(), lines }; } finally { console.log = log; console.warn = warn; }
}

const IVV_FUND = { t: "IVV", n: "iShares Core S&P 500 ETF", issuer: "iShares", trust: "0001100663", series: "S000004310", class: "C000012040", seed: true, er: null, erUrl: null, erAsOf: null, since: 2000 };
const DIA_FUND = { t: "DIA", n: "SPDR Dow Jones Industrial Average ETF Trust", issuer: "State Street", trust: "0001041130", series: null, class: null, uit: true, er: null, erUrl: null, erAsOf: null, since: 1998 };

/* The SEC and Finnhub as IVV and DIA see them: IVV's real browse page, the
   inline N-PORT above as its filing and its fee in an N-CSR; DIA's real
   N-PORT through its CIK's submissions file. Only IVV is quoted, at
   `quote.price`, always for the session of 2026-10-14. */
async function ivvAndDia(quote) {
  const browse = await fixture("browse-ivv.html");
  const dia = await fixture("nport-dia.xml");
  const titles = await fixture("sec-titles-dia.json");
  const ivv = nportXml({ holdings: INLINE });
  const instance = `<?xml version="1.0"?><xbrl xmlns:oef="http://xbrl.sec.gov/oef/2025" xmlns:dei="http://xbrl.sec.gov/dei/2025">
    <context id="DefaultContext"><entity></entity><period><endDate>2026-03-31</endDate></period></context>
    <context id="FY_C000012040"><entity><segment><xbrldi:explicitMember dimension="oef:ClassAxis">ishares:C000012040Member</xbrldi:explicitMember></segment></entity><period><endDate>2026-03-31</endDate></period></context>
    <dei:DocumentType contextRef="DefaultContext">N-CSR</dei:DocumentType>
    <dei:DocumentPeriodEndDate contextRef="DefaultContext">2026-03-31</dei:DocumentPeriodEndDate>
    <oef:ExpenseRatioPct contextRef="FY_C000012040" unitRef="pure">0.0003</oef:ExpenseRatioPct></xbrl>`;
  const session = Date.parse("2026-10-14T20:00:00Z") / 1000;
  return [
    [(u) => u.pathname === "/cgi-bin/browse-edgar" && u.searchParams.get("CIK") === "S000004310", () => [200, browse, "text/html"]],
    [(u) => u.pathname === "/Archives/edgar/data/1100663/000207169126012459/primary_doc.xml", () => [200, ivv, "text/xml"]],
    [(u) => u.pathname === "/Archives/edgar/data/1100663/000110066326000037/index.json",
      () => [200, JSON.stringify({ directory: { item: [{ name: "ivv-ncsr.htm" }, { name: "ivv-ncsr_htm.xml" }] } }), "application/json"]],
    [(u) => u.pathname === "/Archives/edgar/data/1100663/000110066326000037/ivv-ncsr_htm.xml", () => [200, instance, "text/xml"]],
    [(u) => u.pathname === "/submissions/CIK0001041130.json", () => [200, JSON.stringify({ filings: { recent: {
      form: ["N-CEN", "NPORT-P"], accessionNumber: ["0001752724-25-100000", "0001752724-25-158219"],
      filingDate: ["2025-07-01", "2025-06-27"], reportDate: ["", "2025-04-30"] } } }), "application/json"]],
    [(u) => u.pathname === "/Archives/edgar/data/1041130/000175272425158219/primary_doc.xml", () => [200, dia, "text/xml"]],
    [(u) => u.pathname === "/files/company_tickers.json", () => [200, titles, "application/json"]],
    [(u) => u.pathname === "/quote" && u.searchParams.get("symbol") === "IVV",
      () => [200, JSON.stringify({ c: quote.price, dp: 0.4, o: 598, pc: 598.1, t: session }), "application/json"]],
    [(u) => u.pathname === "/quote", () => [200, JSON.stringify({ c: 0, d: null, dp: null, t: 0 }), "application/json"]],
    [(u) => u.pathname === "/stock/metric", () => [200, JSON.stringify({ metric: { "52WeekLow": 480, "52WeekHigh": 615, beta: 1, "13WeekPriceReturnDaily": 6.2 } }), "application/json"]]
  ];
}

const envFor = (server) => ({ SEC_WWW: server.url, SEC_DATA: server.url, FINNHUB_API: server.url, FINNHUB_TOKEN: "test", FINNHUB_PER_MIN: "6000", SEC_USER_AGENT: "test test@example.com" });
const NIGHT1 = Date.parse("2026-10-15T00:30:00Z");

test("10. a whole night against mock SEC and Finnhub servers writes all three files, and the next nights read nothing twice", async () => {
  const dir = await scratchData([IVV_FUND, DIA_FUND]);
  const quote = { price: 600.5 };
  const server = await mockSec(await ivvAndDia(quote));
  const env = envFor(server);
  const read = async (f) => JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
  const night = (n, more = {}) => quietly(() => main({ data: dir, env: { ...env, ...more }, now: NIGHT1 + n * 864e5 }));
  try {
    const { result: r, lines } = await night(0);
    assert.equal(r.written, true);

    const etfs = await read("etfs.json");
    assert.equal(etfs.v, 1);
    assert.equal(etfs.session, "2026-10-14");
    assert.deepEqual(etfs.counts, { listed: 2, priced: 1, withHoldings: 2, full: 2, partial: 0 });
    assert.deepEqual(etfs.skipped, [{ t: "DIA", why: "no quote" }]);
    for (const k of ["cik", "s", "mc", "cusip", "isin"]) assert.ok(!keysOf(etfs).has(k), `no "${k}" anywhere`);

    const [i, d] = etfs.etfs;
    assert.equal(i.kind, "etf");
    assert.equal(d.kind, "etf");
    assert.deepEqual([i.price, i.change, i.lo, i.hi, i.r13, i.beta], [600.5, 0.4, 480, 615, 6.2, 1]);
    assert.equal(i.nport.accession, "0002071691-26-012459");     /* the original, not the amendment above it */
    assert.equal(i.nport.period, "2026-06-30");
    assert.equal(i.nport.url, "https://www.sec.gov/Archives/edgar/data/1100663/000207169126012459/primary_doc.xml");
    assert.deepEqual(i.nport.rtn, [1.1, -0.5, 2]);
    assert.deepEqual(i.hold.map(([t]) => t), ["AAPL", "GOOGL", "CVX"]);
    assert.deepEqual(i.out.map(([lei]) => lei), [NESTLE, null]);
    assert.equal(i.reading, "full");
    /* to one decimal, adding up to exactly 100: rounded one by one, 99.9 */
    assert.deepEqual(i.mix, { "Information Technology": 42.1, "Communication Services": 36.9, Energy: 10.5, "Outside the S&P 500": 10.5 });
    assert.deepEqual([i.er, i.erSrc, i.erAsOf], [0.03, "N-CSR", "2026-03-31"]);
    assert.equal(i.erUrl, "https://www.sec.gov/Archives/edgar/data/1100663/000110066326000037/0001100663-26-000037-index.htm");

    assert.equal(d.price, null);
    assert.equal(d.nport.period, "2025-04-30");
    assert.equal(d.nport.count, 30);
    assert.equal(d.nport.assetsScope, "fund");
    assert.deepEqual(d.nport.rtn, [-1.4, -4.07, -3.1]);
    assert.equal(d.cover, 100);
    assert.equal(d.hold.length, 30);
    assert.equal(d.er, null);
    assert.equal(d.spread.effN > 20 && d.spread.effN < 30, true, String(d.spread.effN));
    assert.equal(tenthsOf(d.mix), 1000);

    /* only the S&P 500 tracker taught us LEIs: Apple's, not Honeywell's from DIA */
    const lei = await read("lei.json");
    assert.deepEqual(lei.byLei[APPLE], { cik: "0000320193", via: "name", from: "IVV 2026-06-30" });
    assert.equal(lei.byLei.ISRPG12PN4EIEOEMW547, undefined);

    const closes = await read("etf-closes.json");
    assert.deepEqual(closes.closes, { IVV: [["2026-10-14", 600.5]] });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^ETFs: 2 listed, 1 priced, 2 with holdings, 2 read in full, 0 partly; .*written \(first night\); unmatched ≥0\.5%: Nestle SA \(IVV 9\.5%\)/);

    /* the next night: nothing new is due, so nothing is downloaded again,
       and no shareholder report is looked for (that is once a month) */
    const docs = () => server.hits.filter((h) => h.includes("primary_doc") || h.includes("_htm.xml")).length;
    const browsed = () => server.hits.filter((h) => h.startsWith("/cgi-bin/browse-edgar")).length;
    const before = docs(), looked = browsed();
    quote.price = 603;
    assert.equal((await night(1)).result.written, true);
    assert.equal(docs(), before);
    assert.equal(browsed(), looked);
    const two = await read("etfs.json");
    assert.equal(two.session, "2026-10-14");    /* the session the quote is stamped with, not the run's date */
    assert.equal(two.etfs[0].price, 603);
    assert.deepEqual(two.etfs[0].hold, i.hold);
    assert.equal(two.etfs[0].er, 0.03);
    assert.deepEqual(two.etfs[1].hold, d.hold);
    assert.equal((await read("etf-closes.json")).closes.IVV.length, 1);  /* same quote session: replaced */

    /* a night with no prices keeps yesterday's file (40 of 51 is the same
       rule), says so on the run's summary page as well as in the log, and
       never writes an empty closes file */
    const three = await night(2, { ETF_SKIP_PRICES: "1" });
    assert.equal(three.result.written, false);
    assert.match(three.lines[0], /kept yesterday's etfs\.json \(only 0 funds priced against 1 yesterday\)/);
    assert.equal(three.lines[1], "::warning title=ETF data::kept yesterday's etfs.json: only 0 funds priced against 1 yesterday");
    assert.equal((await read("etfs.json")).updated, two.updated);
    /* the file it would have written keeps IVV's last price, range, returns
       and beta, marked with their session, and drops that session's day move */
    const i3 = three.result.next.etfs[0];
    assert.deepEqual([i3.price, i3.lo, i3.hi, i3.r13, i3.beta, i3.stale], [603, 480, 615, 6.2, 1, "2026-10-14"]);
    assert.deepEqual([i3.change, i3.open, i3.prev], [null, null, null]);

    /* a hand fix and a hand-typed fee: IVV's filing is read again for the
       fix, Nestle (now pointed at Apple) leaves the unmatched list, and the
       typed fee wins over the one read from the report */
    await writeList(dir, [{ ...IVV_FUND, er: 0.0299, erAsOf: "2026-03-31",
      erUrl: "https://www.sec.gov/Archives/edgar/data/1100663/000110066326000037/0001100663-26-000037-index.htm" }, DIA_FUND], { [NESTLE]: "0000320193" });
    const ivvRead = () => server.hits.filter((h) => h === "/Archives/edgar/data/1100663/000207169126012459/primary_doc.xml").length;
    const once = ivvRead();
    const four = await night(3);
    assert.equal(four.result.written, true);
    assert.equal(ivvRead(), once + 1);
    const i4 = four.result.next.etfs[0];
    assert.deepEqual(i4.out.map(([lei, name]) => [lei, name]), [[null, "Unknown Holdings Corp"]]);
    assert.deepEqual(i4.hold[0], ["AAPL", +(49 / 95 * 100).toFixed(3)]);
    assert.deepEqual([i4.er, i4.erSrc, i4.erAsOf], [0.0299, "list", "2026-03-31"]);
    assert.deepEqual([i4.price, i4.change, i4.stale], [603, 0.4, undefined]);

    /* every SEC request said who is asking, and every Finnhub one carried
       the key and not the SEC's contact, which is for the SEC only */
    assert.ok(server.hits.some((h) => h.startsWith("/quote?")));
    server.hits.forEach((h, n) => {
      if (/^\/(quote|stock\/metric)\?/.test(h)) {
        assert.match(h, /[?&]token=test(&|$)/, h);
        assert.notEqual(server.agents[n], env.SEC_USER_AGENT, h);
      } else assert.equal(server.agents[n], env.SEC_USER_AGENT, h);
    });

    /* and late in the job it does nothing at all */
    const late = await quietly(() => main({ data: dir, env: { ...env, JOB_STARTED: String(Math.floor(Date.now() / 1000) - 151 * 60) } }));
    assert.deepEqual(late.result, { skipped: true });
    assert.match(late.lines[0], /skipped tonight/);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("11. what a night leaves for the next: a new fund with no N-PORT yet is asked again the next night, a refused filing is downloaded once, and holdings whose filing vanished are kept and named", async () => {
  const dir = await scratchData([IVV_FUND, DIA_FUND]);
  /* NEWF's series has no N-PORT yet; MISF's newest is another series' portfolio */
  const NEWF = { t: "NEWF", n: "A Fund With No Filing Yet", issuer: "Test", trust: "0000000101", series: "S000000101", class: null, er: null, erUrl: null, erAsOf: null, since: 2026 };
  const MISF = { t: "MISF", n: "A Fund Served Another Series", issuer: "Test", trust: "0000000102", series: "S000000102", class: null, er: null, erUrl: null, erAsOf: null, since: 2026 };
  const MISF_DOC = "/Archives/edgar/data/102/000000010226000001/primary_doc.xml";
  /* from night 14 the SEC's list for IVV's series shows no N-PORT at all */
  let ivvGone = false;
  const server = await mockSec([
    [(u) => ivvGone && u.pathname === "/cgi-bin/browse-edgar" && u.searchParams.get("CIK") === "S000004310" && u.searchParams.get("type") === "NPORT-P",
      () => [200, browsePage([]), "text/html"]],
    [(u) => u.pathname === "/cgi-bin/browse-edgar" && u.searchParams.get("CIK") === "S000000101", () => [200, browsePage([]), "text/html"]],
    [(u) => u.pathname === "/cgi-bin/browse-edgar" && u.searchParams.get("CIK") === "S000000102",
      () => [200, browsePage([["NPORT-P", "0000000102-26-000001", "2026-08-27"]]), "text/html"]],
    [(u) => u.pathname === MISF_DOC, () => [200, nportXml({ series: "S000009999", cik: "0000000102", holdings: INLINE }), "text/xml"]],
    ...(await ivvAndDia({ price: 600.5 }))
  ]);
  const env = envFor(server);
  const night = (n) => quietly(() => main({ data: dir, env, now: NIGHT1 + n * 864e5 }));
  const asked = (series) => server.hits.filter((h) => h.startsWith("/cgi-bin/browse-edgar") && h.includes(`CIK=${series}&type=NPORT-P`)).length;
  const fetched = () => server.hits.filter((h) => h === MISF_DOC).length;
  const rec = async (t) => JSON.parse(await fs.readFile(path.join(dir, "etfs.json"), "utf8")).etfs.find((r) => r.t === t);
  try {
    assert.equal((await night(0)).result.written, true);

    /* the two join the list the next day */
    await writeList(dir, [IVV_FUND, DIA_FUND, NEWF, MISF]);
    assert.equal((await night(1)).result.written, true);
    assert.deepEqual((await rec("NEWF")).nportMiss, { at: "2026-10-16", acc: null, why: "no N-PORT found" });
    assert.deepEqual((await rec("MISF")).nportMiss, { at: "2026-10-16", acc: "0000000102-26-000001", why: "N-PORT series mismatch" });
    assert.deepEqual([asked("S000000101"), asked("S000000102"), fetched()], [1, 1, 1]);

    /* the night after, NEWF is asked again; MISF, whose filing was refused, waits its 6-11 days */
    assert.equal((await night(2)).result.written, true);
    assert.deepEqual([asked("S000000101"), asked("S000000102"), fetched()], [2, 1, 1]);

    /* thirteen days after the refusal MISF is due: the SEC still lists the
       same filing, and it is not downloaded again. IVV is due too, and its
       filing is gone from the list: it keeps its holdings, and says so */
    ivvGone = true;
    const later = await night(14);
    assert.equal(later.result.written, true);
    assert.deepEqual([asked("S000000101"), asked("S000000102"), fetched()], [3, 2, 1]);
    assert.deepEqual((await rec("MISF")).nportMiss, { at: "2026-10-29", acc: "0000000102-26-000001", why: "N-PORT series mismatch" });
    assert.ok(later.result.next.skipped.some((s) => s.t === "MISF" && s.why === "N-PORT series mismatch"));
    assert.ok(later.result.next.skipped.some((s) => s.t === "IVV" && s.why === "no N-PORT found, older holdings kept"));
    const ivv = await rec("IVV");
    assert.ok(ivv.hold.length > 0 && ivv.nport.checked === "2026-10-29" && !ivv.nportMiss);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("12. at most six shareholder-report files are downloaded a night; a fund past that waits for the next", async () => {
  /* three funds in three trusts, each report in three XBRL files: the first
     two reports take the night's six, and the third is not touched */
  const funds = ["A", "B", "C"].map((x, k) => ({
    t: `FEE${x}`, n: `Fee Test Fund ${x}`, issuer: "Test", trust: `000000020${k + 1}`, series: `S00000020${k + 1}`, class: `C00000020${k + 1}`,
    er: null, erUrl: null, erAsOf: null, since: 2026
  }));
  const acc = (k) => `000000020${k}-26-00000${k}`;
  const instance = (k) => `<?xml version="1.0"?><xbrl xmlns:oef="http://xbrl.sec.gov/oef/2025" xmlns:dei="http://xbrl.sec.gov/dei/2025">
    <context id="c"><entity><segment><xbrldi:explicitMember dimension="oef:ClassAxis">t:C00000020${k}Member</xbrldi:explicitMember></segment></entity><period><endDate>2026-06-30</endDate></period></context>
    <oef:ExpenseRatioPct contextRef="c" unitRef="pure">0.000${Number(k) + 4}</oef:ExpenseRatioPct></xbrl>`;
  const dir = await scratchData(funds);
  const server = await mockSec([
    [(u) => u.pathname === "/cgi-bin/browse-edgar" && u.searchParams.get("type") === "NPORT-P", () => [200, browsePage([]), "text/html"]],
    [(u) => u.pathname === "/cgi-bin/browse-edgar" && u.searchParams.get("type") === "N-CSR",
      (u) => { const k = u.searchParams.get("CIK").slice(-1); return [200, browsePage([["N-CSR", acc(k), "2026-08-29"]]), "text/html"]; }],
    [(u) => /\/index\.json$/.test(u.pathname),
      () => [200, JSON.stringify({ directory: { item: [1, 2, 3].map((n) => ({ name: `r${n}_htm.xml` })) } }), "application/json"]],
    [(u) => /_htm\.xml$/.test(u.pathname), (u) => [200, instance(/\/data\/20(\d)\//.exec(u.pathname)[1]), "text/xml"]]
  ]);
  try {
    const { result, lines } = await quietly(() => main({ data: dir, env: { ...envFor(server), ETF_SKIP_PRICES: "1" }, now: NIGHT1 }));
    assert.equal(server.hits.filter((h) => h.endsWith("_htm.xml")).length, 6);
    assert.deepEqual(result.next.etfs.map((r) => [r.t, r.er, r.erCheck?.acc ?? null]),
      [["FEEA", 0.05, acc(1)], ["FEEB", 0.06, acc(2)], ["FEEC", null, null]]);
    /* no holdings and no prices: nothing is written, not even a first file,
       and the run's summary page says so */
    assert.equal(result.written, false);
    assert.match(lines[0], /; no etfs\.json written yet \(nothing was priced or read tonight\);/);
    assert.equal(lines[1], "::warning title=ETF data::no etfs.json written yet: nothing was priced or read tonight");
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("13. an SEC that takes requests and never answers is cut off at its own deadline, and Finnhub keeps its time", { timeout: 60_000 }, async () => {
  const dir = await scratchData([IVV_FUND, DIA_FUND]);
  const server = await mockSec([
    [(u) => !["/quote", "/stock/metric"].includes(u.pathname), () => null],
    ...(await ivvAndDia({ price: 600.5 }))
  ]);
  try {
    /* A 20.5-second step: the SEC's share ends 20 seconds, and Finnhub's four
       calls at 6,000 a minute, before its end, so half a second in. Before,
       each SEC request ran its own 30 seconds, past the whole step, and no
       fund was priced. */
    const t0 = Date.now();
    const { result } = await quietly(() => main({ data: dir, env: envFor(server), now: NIGHT1, budgetMs: 20_500 }));
    const took = Date.now() - t0;
    assert.ok(server.hits.some((h) => h.startsWith("/cgi-bin/browse-edgar")), "the SEC was asked");
    assert.ok(took < 5000, `took ${took} ms`);
    assert.equal(result.next.counts.priced, 1);          /* IVV; DIA is not quoted by this mock */
    assert.deepEqual([result.next.etfs[0].t, result.next.etfs[0].price], ["IVV", 600.5]);
    /* no holdings, so no first file, and the night's closes are kept */
    assert.equal(result.written, false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "etf-closes.json"), "utf8")).closes, { IVV: [["2026-10-14", 600.5]] });
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("14. nothing the SEC or Finnhub sends becomes a workflow command in the job's log", async () => {
  const dir = await scratchData([IVV_FUND]);
  /* two unmatched holdings whose names carry a newline and a command, one
     written as &#10;, one as it stands; a report index and a Finnhub reply
     that are not JSON, which an error message quotes. The runner also
     takes "##[" anywhere in a line as the older form of a command. */
  const holdings = [
    ...INLINE.filter((h) => h.lei !== NESTLE),
    { name: "Nestle SA&#10;::error title=x::from a name", lei: NESTLE, pct: 6 },
    { name: "Roche Holding AG\r\n::warning::from a name ##[error]too", pct: 3 }
  ];
  const ivv = nportXml({ holdings });
  const base = await ivvAndDia({ price: 600.5 });
  const server = await mockSec([
    [(u) => u.pathname === "/Archives/edgar/data/1100663/000207169126012459/primary_doc.xml", () => [200, ivv, "text/xml"]],
    [(u) => u.pathname === "/Archives/edgar/data/1100663/000110066326000037/index.json", () => [200, "##[error]from the SEC", "application/json"]],
    [(u) => u.pathname === "/stock/metric", () => [200, "\n::error::from Finnhub", "application/json"]],
    ...base
  ]);
  const said = [];
  const log = console.log, warn = console.warn;
  console.log = console.warn = (...a) => said.push(a.join(" "));
  let result;
  try {
    result = await main({ data: dir, env: envFor(server), now: NIGHT1 });
  } finally {
    console.log = log; console.warn = warn;
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
  assert.equal(result.written, true);
  /* the runner reads the log a line at a time: \n, \r and \r\n end one */
  const lines = said.join("\n").split(/\r\n|\r|\n/);
  assert.equal(lines.length, said.length, JSON.stringify(said));
  assert.deepEqual(lines.filter((l) => l.trimStart().startsWith("::") || l.includes("##[")), []);
  /* still all there, on one line each */
  assert.ok(said.includes(`  ! report index IVV: Unexpected token '#', "# #[error]f"... is not valid JSON`), JSON.stringify(said));
  assert.ok(said.includes(`  ! finnhub /stock/metric: Unexpected token ':', " ::error::f"... is not valid JSON`), JSON.stringify(said));
  const summary = lines.find((l) => l.startsWith("ETFs: "));
  assert.match(summary, /unmatched ≥0\.5%: Nestle SA ::error title=x::from a name \(IVV 6\.\d%\), Roche Holding AG ::warning::from a name # #\[error\]too \(IVV 3\.\d%\)/);
  /* and the names are written the same way */
  assert.deepEqual(result.next.etfs[0].out.map(([, name]) => name),
    ["Nestle SA ::error title=x::from a name", "Roche Holding AG ::warning::from a name ##[error]too", "Unknown Holdings Corp"]);
});

test("the company job's warnings keep a reply on one line the same way", async () => {
  /* the helper is read from refresh.mjs's source, and must be the one this
     job uses */
  const src = await fs.readFile(path.join(HERE, "..", "scripts", "refresh.mjs"), "utf8");
  const def = src.match(/^const oneLine = (.*);$/m);
  assert.ok(def, "refresh.mjs prints replies as they come");
  const ours = await fs.readFile(path.join(HERE, "..", "scripts", "etfs.mjs"), "utf8");
  assert.ok(ours.includes(def[0]), "refresh.mjs and etfs.mjs keep a line differently");
  const oneLine = Function("return " + def[1])();
  assert.equal(oneLine(`Unexpected token ':', "\n::error::x ##[error]y"... is not valid JSON`),
    `Unexpected token ':', " ::error::x # #[error]y"... is not valid JSON`);
  /* and every error message it prints goes through it */
  assert.equal(src.match(/\$\{err\.message\}/g), null);
});

test("a night without the SEC's ticker list reads no filing, and the next night reads them in full", async () => {
  /* Our short names alone miss companies we score (DIA's IBM, Honeywell,
     Amazon), and a reading stands for a month: so none is made that night */
  const dir = await scratchData([IVV_FUND, DIA_FUND]);
  let down = true;
  const server = await mockSec([
    [(u) => down && u.pathname === "/files/company_tickers.json", () => [503, "busy", "text/plain"]],
    ...(await ivvAndDia({ price: 600.5 }))
  ]);
  const night = (n) => quietly(() => main({ data: dir, env: { ...envFor(server), ETF_SKIP_PRICES: "1" }, now: NIGHT1 + n * 864e5 }));
  const docs = () => server.hits.filter((h) => h.includes("primary_doc")).length;
  const rec = (r, t) => r.next.etfs.find((x) => x.t === t);
  try {
    /* the first night: nothing read, so no first file, and no LEI learned */
    const one = await night(0);
    assert.equal(one.result.written, false);
    assert.equal(docs(), 0);
    assert.match(one.lines[0], /0 N-PORTs read, .*; no etfs\.json written yet \(nothing was priced or read tonight\)/);
    await assert.rejects(fs.access(path.join(dir, "lei.json")));

    /* the next night the list is back: both read in full, the first file written */
    down = false;
    const two = await night(1);
    assert.equal(two.result.written, true);
    const d = rec(two.result, "DIA");
    assert.deepEqual([d.cover, d.out, d.nport.read], [100, [], "2026-10-16"]);
    assert.equal(rec(two.result, "IVV").nport.read, "2026-10-16");

    /* a later night without it: a re-read a hand fix asks for waits a night,
       and the reading it has stays as it was */
    await writeList(dir, [IVV_FUND, DIA_FUND], { [NESTLE]: "0000320193" });
    down = true;
    const before = docs();
    const three = await night(2);
    assert.equal(three.result.written, true);
    assert.equal(docs(), before);
    const i3 = rec(three.result, "IVV");
    assert.equal(i3.nport.read, "2026-10-16");
    assert.ok(i3.out.some(([lei]) => lei === NESTLE));
    down = false;
    const i4 = rec((await night(3)).result, "IVV");
    assert.equal(i4.nport.read, "2026-10-18");
    assert.ok(!i4.out.some(([lei]) => lei === NESTLE));
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a night's session is the one its quotes are stamped with, else the companies'", async () => {
  /* the run on a market holiday: the clock says 2026-10-15, the prices are
     2026-10-14's, as the companies' snapshot says */
  const dir = await scratchData([IVV_FUND]);
  const snap = JSON.parse(await fs.readFile(path.join(dir, "snapshot.json"), "utf8"));
  await fs.writeFile(path.join(dir, "snapshot.json"), JSON.stringify({ ...snap, session: "2026-10-14" }));
  const server = await mockSec(await ivvAndDia({ price: 600.5 }));
  const night = (more) => quietly(() => main({ data: dir, env: { ...envFor(server), ...more }, now: NIGHT1 + 864e5 }));
  try {
    assert.equal((await night({})).result.next.session, "2026-10-14");                       /* IVV's quote */
    assert.equal((await night({ ETF_SKIP_PRICES: "1" })).result.next.session, "2026-10-14");  /* the companies' */
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
