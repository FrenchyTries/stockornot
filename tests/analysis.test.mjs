import test from "node:test";
import assert from "node:assert/strict";
import { pct, pctPlain, inputs, rankAmong, scoreStock, prosAndCons, buildScoreContext } from "../lib/analysis.mjs";
import { beatRecord, insiderSummary, numberGroups, buildSectorStats, sectorView, nearestPeers } from "../lib/insight.mjs";

test("values that round to zero print as zero", () => {
  assert.equal(pct(-0.04), "0.0%");
  assert.equal(pct(0.04, 0), "0%");
  assert.equal(pctPlain(-0.2, 0), "0%");
  assert.equal(pct(2.5), "+2.5%");
});

test("ranks count ties for neither side and leave out the company's own value", () => {
  const pool = [1, 2, 2, 3, 4];
  /* the company is the 2 in the pool: of the other 4, one is lower, two are higher, one ties */
  assert.deepEqual(rankAmong(pool, 2, false, 2), { beats: 25, beatenBy: 50, others: 4 });
  /* a sister share class whose twin is the 4 in the pool, own value 4.1 */
  assert.deepEqual(rankAmong(pool, 4.1, false, 4), { beats: 100, beatenBy: 0, others: 4 });
});

const base = (over) => ({
  t: "AAA", n: "A", s: "Industrials", cik: "1", price: 50, lo: 40, hi: 60, mc: 10000,
  pe: 16, ps: 2, pb: 3, roe: 18, roa: 7, nm: 10, gm: 40, rg: 6, rg5: 6, eg: 8, beta: 1, dy: 1.5, de: 0.5,
  r13: 2, r52: 5, fin: { revenue: 5e9, netIncome: 5e8, assets: 1e10, equity: 4e9, fcf: 4e8, ocf: 8e8, debt: 2e9, cash: 5e8, fy: 2025 },
  ...over
});

test("a P/E that disagrees with a negative margin is not praised", () => {
  const s = base({ nm: -6 });
  assert.equal(inputs(s).profitClash, true);
  assert.equal(inputs(s).losing, false);
  const pc = prosAndCons(s);
  assert.ok(!pc.pros.some((p) => /earnings/.test(p) && /priced|Cheap/i.test(p)), pc.pros.join(" | "));
  assert.ok(scoreStock(s).notes.some((n) => /P\/E .* says it made money/.test(n)));
});

test("a loss in the last filing does not outvote a profitable trailing year", () => {
  const s = base({ fin: { ...base().fin, netIncome: -1e8 } });
  assert.equal(inputs(s).losing, false);
});

test("thin equity drops price-to-book, ROE and debt-to-equity everywhere", () => {
  const s = base({ pb: 40, roe: 150, de: 30, fin: { ...base().fin, equity: 3e8 } });
  const k = inputs(s);
  assert.equal(k.thinEquity, true);
  assert.equal(k.pbOk, false);
  assert.equal(k.deOk, false);
  const pc = prosAndCons(s);
  assert.ok(!pc.pros.concat(pc.cons).some((p) => /book value|shareholder equity|× equity/.test(p)), pc.pros.concat(pc.cons).join(" | "));
  const rows = numberGroups(s).flatMap((g) => g.rows);
  for (const label of ["Price / book", "ROE", "Debt / equity"]) {
    assert.match(rows.find((r) => r[0] === label)[1], /^n\/m/, label);
  }
});

test("equity is worked out from assets and liabilities when it was not tagged", () => {
  const s = base({ fin: { ...base().fin, equity: null, assets: 1e10, liabs: 1.05e10 } });
  assert.equal(inputs(s).negEquity, true);
});

test("price-to-book between 1 and 1.3 is 'close to', not 'below', book value", () => {
  const pros = prosAndCons(base({ pb: 1.2 })).pros.join(" ");
  assert.match(pros, /close to what the balance sheet says/);
  assert.doesNotMatch(pros, /below what/);
});

test("a small revenue drop reads as a drop, not as flat or growing", () => {
  const cons = prosAndCons(base({ rg: -3.5, ps: 8 })).cons.join(" | ");
  assert.match(cons, /Revenue slipped 3\.5%/);
  assert.match(cons, /with revenue falling 3\.5%/);
  assert.doesNotMatch(cons, /flat at -|growing only -/);
});

test("share classes count once, rank alike and are not each other's peer", () => {
  const stocks = [];
  for (let i = 0; i < 12; i++) stocks.push(base({ t: "C" + i, cik: "c" + i, pe: 10 + i, mc: 1000 * (i + 1) }));
  stocks.push(base({ t: "GOOGL", cik: "g", pe: 15.5, mc: 6000 }), base({ t: "GOOG", cik: "g", pe: 15.5, mc: 6000 }));
  const stats = buildSectorStats(stocks);
  assert.equal(stats.get("Industrials").count, 13);
  const a = sectorView(stocks.at(-2), stats).rows.find((r) => r.id === "pe");
  const b = sectorView(stocks.at(-1), stats).rows.find((r) => r.id === "pe");
  assert.deepEqual([a.text, a.peers], [b.text, b.peers]);
  assert.equal(a.peers, 12);
  assert.ok(!nearestPeers(stocks.at(-1), stats, 5).some((p) => p.cik === "g"));
  const ctx = buildScoreContext(stocks);
  assert.equal(scoreStock(stocks.at(-2), ctx).overall, scoreStock(stocks.at(-1), ctx).overall);
});

test("every weak factor keeps a line explaining it within the six", () => {
  /* weak on almost everything, with plenty of heavier cons competing */
  const s = base({ pe: 80, ps: 20, rg: -30, rg5: -5, eg: -40, nm: 1, gm: 12, roe: 2, roa: 0.5, r52: -45, r13: -25,
    price: 41, beta: 2.6, dy: 9, payout: 150, cr: 0.6, ic: 1.2 });
  const score = scoreStock(s);
  const weak = Object.entries(score.factors).filter(([, v]) => v !== null && v < 42).map(([id]) => id);
  assert.ok(weak.length >= 3, JSON.stringify(score.factors));
  const cons = prosAndCons(s).cons;
  assert.equal(cons.length, 6);
  const words = { value: /earnings|sales|value/i, growth: /revenue|earnings per share|growth/i, quality: /margin|profit|return on/i,
    moment: /52-week|past year|price trend/i, stable: /beta|swing|debt|interest|yield|stability/i };
  for (const id of weak) assert.ok(cons.some((c) => words[id].test(c)), id + " unexplained: " + cons.join(" | "));
});

test("the beat record gives one aggregate surprise, or none when an estimate is tiny", () => {
  const rows = [{ actual: 1.1, estimate: 1 }, { actual: 0.9, estimate: 1 }, { actual: 1.2, estimate: 1 }];
  assert.equal(Math.round(beatRecord({ earnings: rows }).avgSurprise), 7);
  assert.equal(beatRecord({ earnings: [...rows, { actual: 0.05, estimate: 0.01 }] }).avgSurprise, null);
});

test("insider months say how many months had trades, not 'the last N'", () => {
  const s = insiderSummary({ months: [{ ym: "2026-08", mspr: -40 }, { ym: "2026-03", mspr: -30 }] });
  assert.equal(s.when, "in 2 months with trades since Mar 2026");
  assert.equal(insiderSummary({ months: [{ ym: "2026-08", mspr: 10 }] }).when, "in Aug 2026");
});
