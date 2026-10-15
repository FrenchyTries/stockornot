import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { buildScoreContext, scoreStock, STYLES, DEFAULT_STYLE } from "../lib/analysis.mjs";
import { buildSectorStats } from "../lib/insight.mjs";
import { upcoming } from "../lib/earnings.mjs";
import {
  readFund, readFunds, holdingsReading, companyScores, mergeFunds, cleanFund, overlap, costScore, spreadScore,
  spreadOf, fmtEr, tenYearCost, largestFunds, isFund, COST_KNOTS, NO_COST_WEIGHTS, FUND_FACTORS, EFFN_KNOTS, TOP10_KNOTS,
  whyNotRead, inBrief, holdingsAge, fundsToShow, deckOrder, costRead, companyName, MAX_HOLDINGS_AGE
} from "../lib/funds.mjs";

/* The fund reading (lib/funds.mjs) and the guards that keep funds out of
   everything built for companies. */

const ROOT = path.resolve(import.meta.dirname, "..");
const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "snapshot.json"), "utf8"));
const ctx = buildScoreContext(snap.stocks);

/* one share class per company, as the nightly job matches holdings */
const companies = (() => {
  const seen = new Set(), out = [];
  for (const s of snap.stocks) { const id = s.cik || s.t; if (!seen.has(id)) { seen.add(id); out.push(s); } }
  return out;
})();

/* holdings 100 days old, so a fund reads in full whatever day the tests run */
const daysAgo = (n, from = new Date()) => new Date(from.getTime() - n * 864e5).toISOString().slice(0, 10);
const fund = (over = {}) => ({
  t: "TEST", n: "Test Fund", kind: "etf", issuer: "Test", since: 2010, price: 100, er: 0.03,
  nport: { period: daysAgo(100), filed: daysAgo(40), assets: 5e10, assetsScope: "series", count: 2 },
  equity: 99.9, other: 0.1, cover: 100, reading: "full", hold: [], out: [], mix: {}, ...over
});
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, a + " is not " + b);

test("holdings read through the company scores, with what we cannot see counted as 50", () => {
  /* 80% of the fund in companies averaging 90: 0.8 x 90 + 0.2 x 50 = 82 */
  const scores = new Map([["A", { score: 90 }], ["B", { score: 90 }]]);
  const h = holdingsReading(fund({ hold: [["A", 50], ["B", 30]] }), scores);
  near(h.m, 90);
  near(h.c, 0.8);
  near(h.value, 82);
  near(h.unseen, 20);
  /* a matched company with no score counts as unseen, not as zero */
  const h2 = holdingsReading(fund({ hold: [["A", 80], ["Z", 20]] }), new Map([["A", { score: 90 }], ["Z", { score: null }]]));
  near(h2.value, 82);
  assert.equal(holdingsReading(fund({ hold: [["Z", 100]] }), new Map()), null);
});

test("an equal-weight fund of the whole index reads 50 under every style", () => {
  const w = 100 / companies.length;
  const eq = fund({ hold: companies.map((s) => [s.t, w]) });
  for (const st of STYLES) {
    const scores = companyScores(ctx, st.id, snap.stocks);
    const h = holdingsReading(eq, scores);
    /* every company's score is a place among the rest, so the average is the middle */
    assert.equal(h.value.toFixed(1), "50.0", st.id);
  }
});

test("a one-company fund reads as that company's own score", () => {
  const s = companies.find((c) => c.t === "AAPL");
  const one = fund({ hold: [["AAPL", 100]] });
  for (const st of STYLES) {
    const r = readFund(one, ctx, st.id, { companies: snap.stocks });
    near(r.hold.value, scoreStock(s, ctx, st.id).overall);
  }
});

test("the reading is 0.40 holdings, 0.35 cost and 0.25 spread, on fixed curves", () => {
  assert.deepEqual(FUND_FACTORS.map((f) => [f.id, f.weight]), [["hold", 0.40], ["cost", 0.35], ["spread", 0.25]]);
  /* the fee curve's own points, and fixed: no fund moves another's */
  for (const [er, v] of COST_KNOTS) near(costScore(er), v);
  near(costScore(0.03), 94);
  assert.equal(costScore(null), null);
  const sp = { effN: 40, top10: 40 };
  near(spreadScore(sp), (60 + 58) / 2);

  const f = fund({ hold: [["AAPL", 60], ["MSFT", 40]] });
  const r = readFund(f, ctx, DEFAULT_STYLE, { companies: snap.stocks });
  const [h, c, s] = r.factors.map((x) => x.score);
  near(r.blend, 0.40 * h + 0.35 * c + 0.25 * s);
  assert.equal(r.overall, Math.round(r.blend));
  near(c, costScore(0.03));
  near(s, spreadScore(spreadOf(f.hold)));
  /* the same fund beside a hundred others reads the same: no place among funds */
  const crowd = Array.from({ length: 100 }, (_, i) => fund({ t: "F" + i, er: i / 50, hold: [["XOM", 100]] }));
  near(readFund(f, ctx, DEFAULT_STYLE, { companies: snap.stocks, funds: crowd }).blend, r.blend);
});

test("without an expense ratio the reading is 0.6 holdings and 0.4 spread, and says cost is not read", () => {
  const f = fund({ er: null, hold: [["AAPL", 60], ["MSFT", 40]] });
  const r = readFund(f, ctx, DEFAULT_STYLE, { companies: snap.stocks });
  const [h, c, s] = r.factors;
  assert.equal(c.score, null);
  assert.equal(c.weight, 0);
  assert.match(c.why, /^Cost not read:/);
  near(r.blend, NO_COST_WEIGHTS.hold * h.score + NO_COST_WEIGHTS.spread * s.score);
  near(NO_COST_WEIGHTS.hold + NO_COST_WEIGHTS.spread, 1);
  assert.ok(r.notes.some((n) => /^Cost not read:/.test(n)));
  assert.ok(Number.isInteger(r.overall));
});

test("only a fund read in full gets a number", () => {
  const hold = [["AAPL", 60], ["MSFT", 40]];
  assert.ok(Number.isInteger(readFund(fund({ hold }), ctx, DEFAULT_STYLE, { companies: snap.stocks }).overall));
  for (const reading of ["partial", "none", undefined, "anything"]) {
    const r = readFund(fund({ hold, reading, cover: 62 }), ctx, DEFAULT_STYLE, { companies: snap.stocks });
    assert.equal(r.overall, null, String(reading));
    assert.equal(r.blend, null);
    /* the parts that can be read still are */
    assert.ok(r.factors.every((x) => typeof x.score === "number"));
    assert.ok(r.cons.length >= 1, "a fund we could not read is never 'nothing stands out'");
  }
  const none = readFund(fund({ hold: [], nport: null, cover: null, reading: "none" }), ctx, DEFAULT_STYLE, { companies: snap.stocks });
  assert.equal(none.overall, null);
  assert.match(none.cons.join(" "), /No holdings filing/);
});

test("a style changes what it owns and nothing else, and each style is worked out once", () => {
  const capWeighted = (() => {
    const total = companies.reduce((a, s) => a + (s.mc > 0 ? s.mc : 0), 0);
    return companies.filter((s) => s.mc > 0).map((s) => [s.t, (s.mc / total) * 100]);
  })();
  const list = [fund({ t: "BIG", hold: capWeighted }), fund({ t: "TWIN", er: 0.0945, hold: capWeighted })];
  const bal = readFunds(list, ctx, "balanced", snap.stocks);
  const mom = readFunds(list, ctx, "momentum", snap.stocks);
  assert.equal(readFunds(list, ctx, "balanced", snap.stocks), bal, "cached per style");
  assert.notEqual(mom, bal);
  const [hb, cb, sb] = bal.get("BIG").factors.map((f) => f.score);
  const [hm, cm, sm] = mom.get("BIG").factors.map((f) => f.score);
  assert.notEqual(Math.round(hb), Math.round(hm));
  near(cb, cm);
  near(sb, sm);
  assert.equal(bal.get("BIG").style, "balanced");
  assert.equal(mom.get("BIG").style, "momentum");
  /* identical holdings: the cheaper one reads higher, and the dearer is told so */
  assert.ok(bal.get("BIG").blend > bal.get("TWIN").blend);
  assert.deepEqual(bal.get("BIG").place, { rank: 1, of: 2 });
  assert.match(bal.get("TWIN").cons.join(" "), /Owns the same companies as BIG \(100% overlap\), which costs 0\.03%/);
  /* a new snapshot (a new context) is read afresh */
  assert.notEqual(readFunds(list, buildScoreContext(snap.stocks), "balanced", snap.stocks), bal);
});

test("no fund ever reaches the score context or the sector statistics", () => {
  /* the worst case: a fund record that arrived carrying a sector and a CIK */
  const bad = { t: "XLK", n: "Tech fund", kind: "etf", s: "Information Technology", cik: "0001064641", mc: 9e7,
    price: 290, pe: 30, ps: 8, roe: 30, nm: 25, rg: 12 };
  const withFund = buildScoreContext(snap.stocks.concat([bad]));
  assert.ok(!withFund.stocks.some(isFund));
  assert.equal(withFund.stocks.length, ctx.stocks.length);
  assert.equal(withFund.sectors.get("Information Technology").n, ctx.sectors.get("Information Technology").n);
  const stats = buildSectorStats(snap.stocks.concat([bad]));
  assert.ok(!stats.get("Information Technology").members.some(isFund));
  /* and a cleaned record has nothing that could put it there */
  const clean = cleanFund(bad);
  assert.equal(clean.s, undefined);
  assert.equal(clean.cik, undefined);
  assert.equal(clean.mc, undefined);
  assert.equal(clean.kind, "etf");
});

test("a fund never takes a company's place in the ticker index", () => {
  const apple = snap.stocks.find((s) => s.t === "AAPL");
  const byTicker = { AAPL: apple };
  const kept = mergeFunds(byTicker, [
    { t: "AAPL", n: "A fund calling itself AAPL", kind: "etf", hold: [] },
    { t: "VOO", n: "Vanguard S&P 500 ETF", kind: "etf", cik: "0000036405", s: "Financials", mc: 1, hold: [["AAPL", 7], ["MSFT", 6]] },
    { t: "VOO", n: "A second VOO", kind: "etf" },
    { t: "lower", kind: "etf" }, { t: "SPY", kind: "stock" }, null, "VOO"
  ]);
  assert.equal(byTicker.AAPL, apple);
  assert.deepEqual(kept.map((f) => f.t), ["VOO"]);
  assert.equal(byTicker.VOO.n, "Vanguard S&P 500 ETF");
  assert.equal(byTicker.VOO.cik, undefined);
  assert.equal(byTicker.VOO.s, undefined);
  assert.equal(byTicker.VOO.mc, undefined);
  /* a reload replaces the fund's own entry, still never the company's */
  mergeFunds(byTicker, [{ t: "VOO", n: "Vanguard S&P 500 ETF, tomorrow", kind: "etf" }]);
  assert.equal(byTicker.VOO.n, "Vanguard S&P 500 ETF, tomorrow");
  assert.equal(byTicker.AAPL, apple);
});

test("overlap is the sum over common holdings of the smaller weight", () => {
  const a = { hold: [["A", 50], ["B", 30], ["C", 20]] };
  const b = { hold: [["A", 40], ["B", 40], ["D", 20]] };
  near(overlap(a, b), 70);
  near(overlap(b, a), 70);
  near(overlap(a, a), 100);
  near(overlap(a, { hold: [["X", 100]] }), 0);
  assert.equal(overlap(a, { hold: [] }), null);
  assert.equal(overlap(a, null), null);
});

test("funds stay out of the earnings notice, the reminders and the Earnings sheet", () => {
  const soon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const byTicker = {
    KO: { t: "KO", n: "Coca-Cola", earnings: { date: soon } },
    /* even a fund record that somehow carried a date */
    VOO: { t: "VOO", n: "Vanguard S&P 500 ETF", kind: "etf", earnings: { date: soon } }
  };
  const cart = [{ t: "KO" }, { t: "VOO", kind: "etf" }, { t: "SPY", kind: "etf" }];
  assert.deepEqual(upcoming(cart, byTicker, { days: 7 }).map((u) => u.t), ["KO"]);
});

test("fees and their cost read as filed", () => {
  assert.equal(fmtEr(0.03), "0.03%");
  assert.equal(fmtEr(0.0945), "0.0945%");
  assert.equal(fmtEr(0.2), "0.20%");
  assert.equal(fmtEr(1), "1.00%");
  /* $10,000 at 7% for ten years, against the same with no fee */
  assert.equal(Math.round(tenYearCost(0.03)), 55);
  assert.equal(Math.round(tenYearCost(0.35)), 634);
  assert.deepEqual(largestFunds([
    { t: "S", nport: { assets: 1 } }, { t: "L", nport: { assets: 3 } }, { t: "M", nport: { assets: 2 } }, { t: "N", nport: null }
  ], 2, ["L"]).map((f) => f.t), ["M", "S"]);
});

/* A copy of the repository to build in, without what the builds write or
   do not read, so a build can be run with fund files present or missing
   whatever the repository holds tonight. */
function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stockornot-funds-"));
  const skip = new Set([".git", "node_modules", "public", "stock", "mobile", "marketing", "track.html", "sitemap.xml", "robots.txt"]);
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !skip.has(path.relative(ROOT, src).split(path.sep)[0]) });
  fs.mkdirSync(path.join(dir, "mobile"));
  fs.copyFileSync(path.join(ROOT, "mobile", "broker-stub.js"), path.join(dir, "mobile", "broker-stub.js"));
  return dir;
}
const run = (root, script, env = {}) => spawnSync(process.execPath, [path.join(root, "scripts", script)], {
  cwd: root, encoding: "utf8", env: { ...process.env, CSP: "", ...env }
});

test("the website, the app and the home-screen copy carry the fund files once they exist", (t) => {
  /* the home-screen copy: sw.js itself, run as a browser would run it */
  const keep = vm.runInNewContext(fs.readFileSync(path.join(ROOT, "sw.js"), "utf8") + ";KEEP",
    { self: { addEventListener() {}, location: { origin: "https://stockornot.com" } } });
  for (const p of ["/data/etfs.json", "/data/etf-closes.json", "/data/snapshot.json", "/data/track.json", "/lib/funds.mjs"]) assert.equal(keep(p), true, p);
  for (const p of ["/data/lei.json", "/data/etf-list.json", "/data/detail/AAPL.json"]) assert.equal(keep(p), false, p);

  /* the website and the app, built from a copy holding the fund files and
     the job's own working files beside them */
  const root = copyRepo();
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "stockornot-funds-app-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(app, { recursive: true, force: true }); });
  const files = {
    "data/etfs.json": JSON.stringify({ v: 1, session: "2026-10-14", etfs: [fund({ t: "AAA", hold: [["AAPL", 100]] })] }),
    "data/etf-closes.json": JSON.stringify({ v: 1, closes: { AAA: [["2026-10-14", 100]] } }),
    "data/lei.json": JSON.stringify({ v: 1, lei: {} })
  };
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(root, f), body);
  assert.ok(fs.existsSync(path.join(root, "data", "etf-list.json")));

  let r = run(root, "build-pages.mjs");
  assert.equal(r.status, 0, r.stderr || r.stdout);
  r = run(root, "build-app.mjs", { APP_OUT: app });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  for (const out of [path.join(root, "public"), app]) {
    for (const f of ["data/etfs.json", "data/etf-closes.json"]) assert.equal(fs.readFileSync(path.join(out, f), "utf8"), files[f], out + " " + f);
    /* never the job's own working files */
    for (const f of ["data/lei.json", "data/etf-list.json"]) assert.ok(!fs.existsSync(path.join(out, f)), out + " " + f);
  }

  /* before the first night each carries an empty list in its place, so it
     never shows funds and never logs a 404 for the file */
  for (const f of ["data/etfs.json", "data/etf-closes.json"]) fs.rmSync(path.join(root, f));
  r = run(root, "build-pages.mjs");
  assert.equal(r.status, 0, r.stderr || r.stdout);
  r = run(root, "build-app.mjs", { APP_OUT: app });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  for (const out of [path.join(root, "public"), app]) {
    assert.equal(fs.readFileSync(path.join(out, "data", "etfs.json"), "utf8"), JSON.stringify({ v: 1, etfs: [] }), out);
    assert.ok(!fs.existsSync(path.join(out, "data", "etf-closes.json")), out);
  }
});

test("the method page's fund weights and curves match lib/funds.mjs", () => {
  const html = fs.readFileSync(path.join(ROOT, "method.html"), "utf8");
  const sec = html.slice(html.indexOf('<h2 id="funds">'));
  assert.ok(sec.length < html.length, "method.html has no fund section");
  for (const f of FUND_FACTORS) {
    const row = sec.split("\n").find((l) => l.includes(`<tr><td>${f.label}</td>`));
    assert.ok(row, "no row for " + f.label);
    const cells = [...row.matchAll(/<td class="num">([^<]*)/g)].map((m) => m[1] === "&ndash;" ? 0 : Number(m[1]));
    assert.deepEqual(cells, [f.weight, NO_COST_WEIGHTS[f.id]], f.label);
  }
  const head = sec.match(/<thead><tr><th class="num">Fee<\/th>(.*?)<\/tr><\/thead>/)[1];
  const body = sec.match(/<tbody><tr><th>Score<\/th>(.*?)<\/tr><\/tbody>/)[1];
  const fees = [...head.matchAll(/>([\d.]+)</g)].map((m) => Number(m[1]));
  const scores = [...body.matchAll(/>(\d+)</g)].map((m) => Number(m[1]));
  assert.deepEqual(fees.map((v, i) => [v, scores[i]]), COST_KNOTS);
  /* the two spread curves, given in words: every knot is named, and only
     the knots, so a reader can work out any fund's figure from the page */
  const para = sec.slice(sec.indexOf("<strong>How spread out</strong> is")).split("</p>")[0].replace(/\s+/g, " ");
  const [first, second] = para.split("The second is");
  assert.ok(second, "the paragraph names two curves");
  const pairs = (txt, re) => [...txt.matchAll(re)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.deepEqual(pairs(first, /\b(\d+) reads (\d+)\b/g), EFFN_KNOTS);
  assert.deepEqual(pairs(second, /\b(\d+)% (?:of the fund )?reads (\d+)\b/g), TOP10_KNOTS);
});

/* ------------------------------------------------ after the review */

test("a reading without its fee is never ranked against those with one", () => {
  const hold = [["AAPL", 60], ["MSFT", 40]];
  const list = [fund({ t: "LOW", er: 0.03, hold }), fund({ t: "DEAR", er: 0.60, hold }), fund({ t: "NOFEE", er: null, hold })];
  const m = readFunds(list, ctx, DEFAULT_STYLE, snap.stocks);
  /* 60/40 without the fee: higher than the fund charging 0.60%, yet unranked */
  assert.ok(m.get("NOFEE").blend > m.get("DEAR").blend);
  assert.equal(m.get("NOFEE").place, undefined);
  assert.deepEqual([m.get("LOW").place, m.get("DEAR").place], [{ rank: 1, of: 2 }, { rank: 2, of: 2 }]);
  assert.deepEqual(list.map((f) => costRead(m.get(f.t))), [true, true, false]);
  assert.match(m.get("NOFEE").notes.join(" "), /not ranked against those whose fee has been/);
});

test("a fund whose holdings were never read says so, and one read with nothing matched says that", () => {
  const never = readFund(fund({ nport: null, hold: [], cover: null, reading: "none" }), ctx, DEFAULT_STYLE, { companies: snap.stocks });
  assert.equal(never.factors[0].why, "Its holdings have not been read.");
  assert.equal(never.factors[2].why, "Its holdings have not been read.");
  const nothing = readFund(fund({ hold: [["ZZZZ9", 100]], cover: 0, reading: "none" }), ctx, DEFAULT_STYLE, { companies: snap.stocks });
  assert.equal(nothing.factors[0].why, "None of its holdings could be matched to a company we score.");
});

test("'the average dollar' is said only of a fund we can score all of", () => {
  const scores = companyScores(ctx, DEFAULT_STYLE, snap.stocks);
  const best = [...scores.values()].filter((v) => typeof v.score === "number").sort((a, b) => b.score - a.score)[0].s.t;
  const all = readFund(fund({ hold: [[best, 100]] }), ctx, DEFAULT_STYLE, { companies: snap.stocks });
  assert.match(all.pros.join(" "), /The average dollar here is in a company that screens ahead of \d+% of the S&P 500\./);
  /* 85% scored: the line is about that 85%, not the average dollar */
  const most = readFund(fund({ hold: [[best, 85], ["ZZZZ9", 15]], cover: 85 }), ctx, DEFAULT_STYLE, { companies: snap.stocks });
  assert.equal(most.overall !== null, true);
  assert.match(most.pros.join(" "), /The 85% we can score is, on average, in companies that screen ahead of \d+% of the S&P 500\./);
  assert.doesNotMatch(most.pros.concat(most.cons).join(" "), /average dollar/);
});

test("holdings past 200 days old are not read in full, and the card says why", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const hold = [["AAPL", 60], ["MSFT", 40]];
  const fresh = fund({ hold, nport: { period: daysAgo(MAX_HOLDINGS_AGE, now), assets: 5e10, count: 2 } });
  const stale = fund({ t: "OLD", hold, nport: { period: "2025-04-30", assets: 5e10, count: 2 } });
  assert.equal(holdingsAge(fresh, now), MAX_HOLDINGS_AGE);
  assert.equal(holdingsAge(fund({ nport: null }), now), null);
  assert.ok(Number.isInteger(readFund(fresh, ctx, DEFAULT_STYLE, { companies: snap.stocks, now }).overall));
  const r = readFund(stale, ctx, DEFAULT_STYLE, { companies: snap.stocks, now });
  assert.equal(r.overall, null);
  assert.equal(r.blend, null);
  assert.equal(r.notes[0], "Its newest holdings we have are from Apr 30, 2025, too old to read it by.");
  assert.equal(whyNotRead(stale, now), r.notes[0]);
  assert.equal(r.cons[0], r.notes[0]);
  assert.deepEqual(r.brief, { word: "Out of date", detail: "Holdings of Apr 2025" });
  /* and it is not ranked */
  const m = readFunds([stale, fund({ t: "NEW", hold })], ctx, DEFAULT_STYLE, snap.stocks);
  assert.deepEqual([m.get("OLD").place, m.get("NEW").place], [undefined, { rank: 1, of: 1 }]);
});

test("a holding filed under one share class is named as the company", () => {
  assert.equal(companyName("Alphabet (Class A)"), "Alphabet");
  assert.equal(companyName("Fox Corporation (Class B)"), "Fox Corporation");
  assert.equal(companyName("Apple"), "Apple");
  const googl = snap.stocks.find((s) => s.t === "GOOGL");
  if (!googl) return;
  const r = readFund(fund({ hold: [["GOOGL", 60], ["AAPL", 40]] }), ctx, DEFAULT_STYLE, { companies: snap.stocks });
  assert.ok(r.cons.includes("One company, " + companyName(googl.n) + ", is 60.0% of it."), r.cons.join(" | "));
  assert.doesNotMatch(r.cons.join(" "), /\(Class [A-Z]\)/);
});

test("only funds whose holdings were read get a card, and two at least", () => {
  const read = (t) => fund({ t, hold: [["AAPL", 100]] });
  const unread = [fund({ t: "NOPE", nport: null, hold: [], cover: null, reading: "none" }), fund({ t: "EMPTY", hold: [] })];
  assert.deepEqual(fundsToShow([read("A1"), read("B1")].concat(unread)).map((f) => f.t), ["A1", "B1"]);
  /* one left is no ETF side at all, and a company's ticker never counts */
  assert.deepEqual(fundsToShow([read("A1")].concat(unread)), []);
  assert.deepEqual(fundsToShow([read("A1"), read("A1")]), []);
  assert.deepEqual(fundsToShow([read("A1"), read("AAPL")], { AAPL: snap.stocks.find((s) => s.t === "AAPL") }), []);
  assert.deepEqual(fundsToShow(null), []);
});

test("a fund with no number says what it is in its place, never an empty score", () => {
  const hold = [["AAPL", 60], ["MSFT", 40]];
  const at = (over) => readFund(fund({ hold, ...over }), ctx, DEFAULT_STYLE, { companies: snap.stocks });
  assert.equal(at({}).brief, null);
  assert.deepEqual(at({ reading: "partial", cover: 62 }).brief, { word: "Partly read", detail: "62% matched" });
  assert.deepEqual(at({ reading: "partial", cover: 95, other: 18 }).brief, { word: "Partly read", detail: "18% cash and other" });
  assert.deepEqual(at({ reading: "none", cover: 12 }).brief, { word: "Holdings only", detail: "12% matched" });
  assert.deepEqual(inBrief(fund({ nport: null, hold: [], cover: null, reading: "none" })), { word: "Not read", detail: "No holdings filing" });
});

test("the ETF deck shows the funds read in full first, each group largest first", () => {
  const hold = [["AAPL", 60], ["MSFT", 40]];
  const f = (t, assets, over = {}) => fund({ t, hold, nport: { period: daysAgo(100), assets, count: 2 }, ...over });
  const list = [f("PSMALL", 9e9, { reading: "partial", cover: 60 }), f("FSMALL", 1e9), f("PBIG", 9e11, { reading: "partial", cover: 60 }),
    f("FBIG", 5e11), f("NOSIZE", null), f("FMID", 2e10, { er: null })];
  const order = deckOrder(list, readFunds(list, ctx, DEFAULT_STYLE, snap.stocks)).map((x) => x.t);
  assert.deepEqual(order, ["FBIG", "FMID", "FSMALL", "NOSIZE", "PBIG", "PSMALL"]);
});

/* ------------------------------------------------ the deck and the switch

   app.js is a page script, not a module: these take single functions (and
   `var` lines) out of it and run them in a context of their own, with what
   they touch stubbed. */
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
function appCode(...names) {
  return names.map((n) => {
    const m = APP.match(new RegExp("^function " + n + "\\([^]*?\\n\\}\\n", "m")) || APP.match(new RegExp("^var " + n + " = [^\\n]*\\n", "m"));
    assert.ok(m, n + " is not in app.js");
    return m[0];
  }).join("\n");
}

test("on the website the deck waits three seconds at most for the funds; in the app, for its own deadline", async () => {
  let clock = 0, timers = [];
  const ctx = vm.createContext({
    native: { inApp: false }, Promise,
    Date: { now: () => clock },
    setTimeout: (fn, ms, ...args) => { timers.push({ fire: () => fn(...args), ms }); }
  });
  vm.runInContext(appCode("FUNDS_WAIT_MS", "fundsInTime"), ctx);
  assert.equal(ctx.FUNDS_WAIT_MS, 3000);
  const never = new Promise(() => {});
  const file = { v: 1, etfs: [] };

  /* the snapshot in after 300 ms, the file still out: 2.7 s more, then none */
  clock = 300;
  const late = ctx.fundsInTime(never, 3000);
  assert.equal(timers.at(-1).ms, 2700);
  timers.at(-1).fire();
  assert.equal(await late, null);
  /* in before the time is up: the file */
  const soon = ctx.fundsInTime(new Promise((ok) => setTimeout(ok, 5, file)), 3000);
  assert.equal(await soon, file);
  /* in before a snapshot that took longer than the three seconds: still the
     file, though the time was up when the snapshot came */
  clock = 5000;
  timers = [];
  ctx.setTimeout = (fn, ms, ...args) => { timers.push({ ms }); fn(...args); };
  assert.equal(await ctx.fundsInTime(Promise.resolve(file), 3000), file);
  assert.equal(timers.at(-1).ms, 0);
  /* the app: no race of its own (lib/native.mjs has the deadline, and the
     copy in the app answers when the site does not) */
  ctx.native.inApp = true;
  assert.equal(ctx.fundsInTime(never, 0), never);

  /* and init asks for the funds at once and gives them their time from then */
  assert.match(APP, /var fundsFile = fetchFunds\(\), fundsBy = Date\.now\(\) \+ FUNDS_WAIT_MS;/);
  assert.match(APP, /fundsInTime\(fundsFile, fundsBy\)\.then\(function \(file\) \{ useFunds\(file\);/);
  assert.doesNotMatch(APP, /fundsFile\.then/);
});

test("going to the funds and back finds the company deck as it was left, Undo included", () => {
  const ctx = vm.createContext({
    state: {
      all: ["A", "B", "C", "D", "E"].map((t) => ({ t })), funds: ["F1", "F2", "F3"].map((t) => ({ t, kind: "etf" })),
      kind: "stocks", deck: [], cursor: 0, history: [], showSeen: false, busy: false
    },
    seenSet: new Set(), LS: { kind: "ts.deckKind" }, saved: [],
    save: (k, v) => ctx.saved.push([k, v]), renderKinds() {}, renderDeck() {},
    shuffle: (a) => a.slice().reverse(),
    funds: { deckOrder: (pool) => pool, readFunds: () => new Map() }
  });
  vm.runInContext(appCode("deckKind", "deckPool", "buildDeck", "leftDecks", "chooseKind"), ctx);
  const { state, seenSet } = ctx;
  /* copied out, so arrays made in the context compare with these */
  const now = () => ({ deck: [...state.deck], cursor: state.cursor, undo: Array.from(state.history, (h) => h.t) });
  ctx.buildDeck();
  assert.deepEqual(now(), { deck: ["E", "D", "C", "B", "A"], cursor: 0, undo: [] });
  /* two companies swiped */
  state.cursor = 2;
  state.history.push({ t: "E", action: "pass", added: false }, { t: "D", action: "add", added: true });
  seenSet.add("E"); seenSet.add("D");

  ctx.chooseKind("etfs");
  assert.deepEqual(now(), { deck: ["F1", "F2", "F3"], cursor: 0, undo: [] });
  assert.deepEqual(ctx.saved.at(-1), ["ts.deckKind", "etfs"]);
  state.cursor = 1;
  state.history.push({ t: "F1", action: "pass", added: false });
  seenSet.add("F1");
  /* B passed on meanwhile from a fund's list of holdings */
  seenSet.add("B");

  ctx.chooseKind("stocks");
  assert.deepEqual(now(), { deck: ["E", "D", "C", "A"], cursor: 2, undo: ["E", "D"] });
  ctx.chooseKind("etfs");
  assert.deepEqual(now(), { deck: ["F1", "F2", "F3"], cursor: 1, undo: ["F1"] });
  /* the same kind again, or a choice while a card is flying: nothing */
  ctx.chooseKind("etfs");
  state.busy = true;
  ctx.chooseKind("stocks");
  assert.deepEqual(now(), { deck: ["F1", "F2", "F3"], cursor: 1, undo: ["F1"] });
});

/* the phone rule and the forced-colours block, read from styles.css */
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
function cssBlocks(query) {
  const out = [];
  for (let i = CSS.indexOf(query); i >= 0; i = CSS.indexOf(query, i + 1)) {
    let depth = 0, j = CSS.indexOf("{", i);
    const from = j;
    for (; j < CSS.length; j++) { if (CSS[j] === "{") depth++; else if (CSS[j] === "}" && --depth === 0) break; }
    out.push(CSS.slice(from + 1, j));
  }
  return out;
}

test("on an upright phone the deck's floor gives up the switch's and the notice's height, as the deck does", () => {
  const upright = cssBlocks("@media (max-width: 700px) and (orientation: portrait)").join("\n");
  const floor = upright.match(/\.deck \{[^}]*min-height:([^;]+);/);
  assert.ok(floor, "no floor for the deck on an upright phone");
  assert.match(floor[1], /var\(--notice-h, 0px\)/);
  assert.match(floor[1], /var\(--kinds-h, 0px\)/);
  /* worked through for a 320 x 568 screen with the switch (46px) and a
     three-line notice (120px): the deck's own height is 178px, and the
     floor must not push it past that by more than the 21px the buttons
     have to spare above the tab bar */
  const px = floor[1].replace(/var\(--notice-h, 0px\)/g, "120px").replace(/var\(--kinds-h, 0px\)/g, "46px");
  const value = Function("return " + px.replace(/calc\(/g, "(").replace(/max\(/g, "Math.max(").replace(/px/g, ""))();
  assert.ok(value <= 178 + 21, "floor " + value + "px");
  /* with neither, the card keeps the 260px it had */
  assert.equal(Function("return " + floor[1].replace(/var\([^)]*\)/g, "0px").replace(/calc\(/g, "(").replace(/max\(/g, "Math.max(").replace(/px/g, ""))(), 260);
});

test("in forced colours the chosen Stocks | ETFs chip is still marked", () => {
  /* the switch marks its choice with is-on, beside aria-pressed */
  assert.match(appCode("setKindChips"), /c\.classList\.toggle\("is-on", on\);\s*c\.setAttribute\("aria-pressed", on \? "true" : "false"\);/);
  /* background and inset shadow are gone in forced colours, so an outline */
  const forced = cssBlocks("@media (forced-colors: active)").join("\n");
  const rule = forced.split("}").find((r) => /\.chip\.is-on\b/.test(r));
  assert.ok(rule, "no forced-colours rule for .chip.is-on");
  assert.match(rule, /outline:\s*\d+px solid Highlight/);
  /* and a keyboard's focus on the chosen chip still shows: the focus ring
     goes back outside it, clear of the inset line that marks the choice */
  const focus = forced.split("}").find((r) => /\.chip\.is-on:focus-visible/.test(r));
  assert.ok(focus, "focus on the chosen chip looks the same as no focus");
  assert.match(focus, /outline-offset:\s*[1-9]\d*px/);
});
