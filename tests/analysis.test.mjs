import test from "node:test";
import assert from "node:assert/strict";
import { pct, pctPlain, inputs, rankAmong, scoreStock, prosAndCons, buildScoreContext, rangeSummary, valuation } from "../lib/analysis.mjs";
import { beatRecord, insiderSummary, financialChecks, historyChecks, buildSectorStats, sectorView, nearestPeers } from "../lib/insight.mjs";
import { CHECK_ICONS } from "../lib/icons.mjs";

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
  const checks = financialChecks(s, scoreStock(s));
  const labels = checks.flatMap((g) => g.rows.map((r) => r[0]));
  for (const label of ["Price / book", "ROE", "Debt / equity"]) assert.ok(!labels.includes(label), label);
  /* with no long-term debt in the filings, the thin equity itself is the warning */
  const noDebt = base({ pb: 40, roe: 150, de: 30, fin: { ...base().fin, equity: 3e8, debt: null } });
  assert.match(financialChecks(noDebt, scoreStock(noDebt)).find((g) => g.id === "balance").answer.text, /^Stretched/);
});

test("the 52-week range is said as distance from the high and the low", () => {
  const r = rangeSummary({ price: 486.4, lo: 349.2, hi: 553.72 });
  assert.equal(r.text, "12% below its 52-week high and 39% above its low.");
  assert.equal(r.zone, "Mid-range");
  assert.equal(rangeSummary({ price: 553.5, lo: 349.2, hi: 553.72 }).zone, "At its 52-week high");
  assert.equal(rangeSummary({ price: 380, lo: 349.2, hi: 553.72 }).zone, "Near the low");
  assert.equal(rangeSummary({ price: 10, lo: 349.2, hi: 553.72 }), null);
  assert.doesNotMatch(prosAndCons(base({ r52: -45, r13: -25, price: 41 })).cons.join(" "), /of the way up/);
});

test("the financials are five questions, each answered from its own figures", () => {
  const s = base({ nm: 12, fin: { ...base().fin, revenuePrev: 4.5e9, netIncomePrev: 4e8 } });
  const checks = financialChecks(s, scoreStock(s));
  assert.deepEqual(checks.map((g) => g.id), ["growth", "cash", "margins", "balance", "value"]);
  const by = Object.fromEntries(checks.map((g) => [g.id, g]));
  assert.equal(by.growth.answer.text, "Slowly");                /* +6% */
  assert.equal(by.cash.answer.text, "Yes");                     /* 8% of revenue */
  assert.equal(by.margins.answer.text, "Yes, improving");       /* 8.9% → 12% */
  assert.equal(by.balance.answer.text, "Yes, the debt is manageable");   /* 2.5 years */
  for (const g of checks) assert.ok(g.question.endsWith("?"), g.id);
});

test("every check has a line icon, and no emoji is left standing in for one", () => {
  const s = base({ fin: { ...base().fin, revenuePrev: 4.5e9, netIncomePrev: 4e8 } });
  for (const g of financialChecks(s, scoreStock(s))) {
    assert.match(CHECK_ICONS[g.icon] || "", /^<svg [^>]*aria-hidden="true"/, g.id);
  }
});

test("a bank's cash flow and debt are not judged, and its revenue jump is not used", () => {
  const bank = base({ s: "Financials", rg: 110, rg5: 7 });
  const by = Object.fromEntries(financialChecks(bank, scoreStock(bank)).map((g) => [g.id, g]));
  assert.equal(by.growth.answer.text, "Slowly");               /* judged on the 7% five-year figure */
  assert.equal(by.cash.answer.tone, "none");
  assert.equal(by.balance.answer.tone, "none");
});

test("the five-year table groups the filings under the checks", () => {
  const h = { revenue: { 2025: 110, 2024: 100 }, ocf: { 2025: 30, 2024: 20 }, capex: { 2025: 10, 2024: 5 },
    netIncome: { 2025: 11, 2024: 8 }, cash: { 2025: 50 }, debt: { 2025: 20 }, shares: { 2025: 1, 2024: 2 } };
  const hc = historyChecks(h);
  assert.deepEqual(hc.groups.map((g) => g.title), ["Revenue growth", "Free cash flow", "Profit margins", "Debt vs. cash"]);
  const rows = Object.fromEntries(hc.groups.flatMap((g) => g.rows).map((r) => [r.label, r.cells]));
  assert.deepEqual(rows["Change on the year"], ["+10%", "—"]);
  assert.deepEqual(rows["Free cash flow"], ["$20", "$15"]);
  assert.deepEqual(rows["Net cash (debt)"], ["$30", "—"]);
  assert.ok(!rows["Diluted shares"]);
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

const valueCheck = (s) => financialChecks(s, scoreStock(s)).find((g) => g.id === "value");

test("the same P/E is cheap for a fast grower and expensive for a slow one", () => {
  const fin = { ...base().fin, fcf: 3.5e8 };
  const fast = base({ pe: 30, rg: 25, rg5: 25, eg5: 25, dy: 0, fin });
  const slow = base({ pe: 30, rg: 2, rg5: 2, eg5: 2, dy: 0, fin });
  assert.equal(valuation(fast).fair, 8 + 1.5 * 25);
  assert.equal(valuation(slow).fair, 8 + 1.5 * 2);
  assert.equal(valueCheck(fast).answer.text, "Yes, it looks cheap");
  assert.equal(valueCheck(slow).answer.text, "No, expensive");
  assert.ok(scoreStock(fast).factors.value > scoreStock(slow).factors.value + 30);
  assert.match(prosAndCons(fast).pros.join(" "), /Reasonably priced for its growth: 30\.0× earnings, where 25% a year of growth would justify about 46×/);
  assert.match(prosAndCons(slow).cons.join(" "), /Expensive for its growth/);
  /* growth past 25% a year counts as 25% */
  assert.equal(valuation(base({ rg: 60, rg5: 50, eg5: 80, dy: 0 })).fair, 8 + 1.5 * 25);
});

test("a REIT is priced on operating cash flow, with its growth capped and no dividend counted", () => {
  const v = valuation(base({ s: "Real Estate", pe: 40, rg: 20, rg5: 20, dy: 4, fin: { ...base().fin, ocf: 6e8 } }));
  assert.equal(v.kind, "ocf");
  assert.equal(v.growth, 8);
  assert.equal(v.fair, 20);                       /* 8 + 1.5 × 8, the dividend left out */
  assert.ok(v.cash.ratio < 1 && v.earnings.ratio === 2);
  assert.ok(v.raw >= 48, "the cash lens carries a REIT: " + v.raw);
});

test("a bank is priced on book value against its return on equity; a payment network is not", () => {
  const bank = base({ s: "Financials", pe: 12, roe: 15, pb: 1.5, fin: { ...base().fin, assets: 1e11, equity: 1e10 } });
  const v = valuation(bank);
  assert.equal(v.kind, "book");
  assert.equal(v.book.fair, 1.5);
  assert.equal(v.cash, null);
  const rows = valueCheck(bank).rows.map((r) => r[0]);
  assert.ok(rows.includes("Fair P/B for its ROE") && !rows.includes("P/FCF"), rows.join(", "));
  /* little balance sheet and a 60% return on it: the franchise earns the money, not the book */
  const network = base({ s: "Financials", pe: 30, roe: 60, pb: 18, rg5: 10, eg5: 12, fin: { ...base().fin, assets: 1e10, equity: 4e9 } });
  assert.equal(valuation(network).book, null);
  assert.equal(valuation(network).raw, valuation(network).earnings.score);
  assert.match(valueCheck(network).why, /judged on earnings alone/);
});

test("a utility is priced on earnings alone, so its negative free cash flow is not held against it", () => {
  const s = base({ s: "Utilities", pe: 18, fin: { ...base().fin, fcf: -5e8 } });
  const v = valuation(s);
  assert.equal(v.cash, null);
  assert.equal(v.raw, v.earnings.score);
  assert.equal(valueCheck(s).answer.text, "Yes, about fair");
  assert.ok(!valueCheck(s).rows.some((r) => r[0] === "P/FCF"));
});

test("a loss has no earnings to price, and the check says so", () => {
  const s = base({ pe: null, nm: -10 });
  assert.equal(valuation(s).earnings.none, true);
  const c = valueCheck(s);
  assert.equal(c.answer.text, "Hard to say: no earnings to price");
  assert.match(c.why, /At 25\.0× free cash flow it trades above the 19× that/);
});

test("when earnings and cash flow disagree, the check says which is which", () => {
  const c = valueCheck(base({ pe: 40, fin: { ...base().fin, fcf: 2e9 } }));
  assert.equal(c.answer.text, "Mixed: dear on earnings, cheap on cash");
  assert.match(c.why, /well above the 19×.*well below that same mark/);
});
