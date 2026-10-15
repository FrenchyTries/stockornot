import test from "node:test";
import assert from "node:assert/strict";
import { isoWeek, dayRatios, step, advance, notCounted } from "../scripts/track.mjs";

test("weeks are ISO weeks, Monday to Sunday", () => {
  assert.equal(isoWeek("2026-10-05"), "2026-W41");   /* a Monday */
  assert.equal(isoWeek("2026-10-11"), "2026-W41");   /* its Sunday */
  assert.equal(isoWeek("2026-10-12"), "2026-W42");
  assert.equal(isoWeek("2027-01-01"), "2026-W53");   /* a Friday that belongs to the old year */
});

test("a split or a bad print is set aside for the day, not counted", () => {
  const r = dayRatios({ A: 100, B: 100, C: 100, D: 100 }, { A: 102, B: 50, C: 99, E: 10 });
  assert.deepEqual(Object.keys(r).sort(), ["A", "C"]);
  assert.equal(step(["A", "C"], r), (1.02 + 0.99) / 2);
  assert.equal(step(["B", "Z"], r), 1);               /* nobody moved: flat */
});

test("a smaller split is set aside when the quote's previous close is restated for it", () => {
  const last = { A: 150, B: 120, C: 125, R: 100, N: 100, F: 100, U: 150 };
  const prices = { A: 102, B: 90.9, C: 100, R: 150, N: 97.5, F: 75, U: 102 };
  /* A 3-for-2 and 2% up, B 4-for-3 and 1% up, C 5-for-4, R 2-for-3 (reverse):
     their previous close is restated. N and F are real falls, and U a 3-for-2
     the feed did not restate, which counts as it always did. */
  const prevs = { A: 100, B: 90, C: 100, R: 150, N: 100, F: 100, U: 150 };
  assert.deepEqual(dayRatios(last, prices, prevs), { N: 0.975, F: 0.75, U: 0.68 });
  /* without previous closes, nothing changes */
  assert.deepEqual(Object.keys(dayRatios(last, prices)).sort(), ["A", "B", "C", "F", "N", "R", "U"]);
});

const company = (t, i, price) => ({ t, n: t, s: i % 2 ? "Industrials" : "Health Care", cik: "c" + i, price, lo: price * 0.8, hi: price * 1.2, mc: 10000,
  pe: 40 - i * 0.05, ps: 2, pb: 3, roe: 5 + i * 0.05, roa: 7, nm: 2 + i * 0.05, gm: 40, rg: i * 0.05, rg5: i * 0.04, eg: 8, beta: 2 - i * 0.003, dy: 1.5, de: 0.5,
  r13: 2, r52: -20 + i * 0.1, fin: { revenue: 5e9, netIncome: 5e8, assets: 1e10, equity: 4e9, fcf: 4e8, ocf: 8e8, debt: 2e9, cash: 5e8, fy: 2025 } });

test("each week's picks are followed forward, and a re-run of a night changes nothing", () => {
  const snap = { stocks: Array.from({ length: 500 }, (_, i) => company("T" + i, i, 100)) };
  let t = advance(null, snap, "2026-10-05");
  assert.equal(t.groups.length, 1);
  const g = t.groups[0];
  assert.ok(g.members.top.length > 80 && g.members.top.length < 120, g.members.top.length);
  assert.ok(g.members.bottom.length > 80 && g.members.bottom.length < 120, g.members.bottom.length);
  assert.ok(!g.members.top.some((x) => g.members.bottom.includes(x)));

  /* the next day every top pick rises 2% and everything else is flat */
  const top = new Set(g.members.top);
  const next = { stocks: snap.stocks.map((s) => ({ ...s, price: top.has(s.t) ? 102 : 100 })) };
  t = advance(t, next, "2026-10-06");
  assert.equal(t.groups.length, 1);                    /* same week, same group */
  assert.equal(t.groups[0].top, 1.02);
  assert.equal(t.groups[0].bottom, 1);
  assert.ok(Math.abs(t.groups[0].index - (1 + 0.02 * top.size / 500)) < 1e-6);
  assert.equal(t.groups[0].days, 1);
  const again = JSON.stringify(t);
  assert.equal(JSON.stringify(advance(t, next, "2026-10-06")), again);

  /* a new week starts a new group at 1, and the old one keeps going */
  t = advance(t, next, "2026-10-12");
  assert.equal(t.groups.length, 2);
  assert.deepEqual([t.groups[1].top, t.groups[1].days], [1, 0]);
  assert.equal(t.groups[0].days, 2);
});

test("a 3-for-2 split in a group is not counted as its loss", () => {
  const snap = { stocks: Array.from({ length: 500 }, (_, i) => company("T" + i, i, 150)) };
  let t = advance(null, snap, "2026-10-05");
  const victim = t.groups[0].members.top[0];
  /* the snapshot carries each quote's previous close as prev */
  const next = { stocks: snap.stocks.map((s) => (s.t === victim ? { ...s, price: 100, prev: 100 } : { ...s, prev: 150 })) };
  t = advance(t, next, "2026-10-06");
  assert.deepEqual([t.groups[0].top, t.groups[0].index, t.groups[0].days], [1, 1, 1]);
});

test("a 2-for-1 split on a day the stock rose is not counted either", () => {
  /* 150 split to 75, then up 25% to 93.75: inside the 40% band */
  assert.deepEqual(dayRatios({ X: 150, Y: 150 }, { X: 93.75, Y: 150 }, { X: 75, Y: 150 }), { Y: 1 });
});

test("after a missed night, a real fall of a split's size is counted", () => {
  const snap = { stocks: Array.from({ length: 500 }, (_, i) => company("T" + i, i, 150)) };
  let t = advance(null, snap, "2026-10-05");
  const victim = t.groups[0].members.top[0];
  /* 2026-10-06 was never counted: tonight's previous closes are that day's,
     not the last ones counted; the victim fell by a third on the 6th */
  const next = { stocks: snap.stocks.map((s) => (s.t === victim ? { ...s, price: 100, prev: 100 } : { ...s, price: 150, prev: 151 })) };
  t = advance(t, next, "2026-10-07");
  const n = t.groups[0].members.top.length;
  assert.ok(Math.abs(t.groups[0].top - (n - 1 + 2 / 3) / n) < 1e-6, String(t.groups[0].top));
});

test("a limited test run is never counted, though it merges into a full snapshot", () => {
  const full = Array.from({ length: 501 }, (_, i) => ({ t: "T" + i, price: 100 }));
  assert.equal(notCounted({ stocks: full, counts: { companies: 501 } }), null);
  assert.match(notCounted({ stocks: full, counts: { companies: 501, partialRun: 6 } }), /limited run of 6 companies/);
  /* a limited run whose companies all failed to quote */
  assert.match(notCounted({ stocks: full, counts: { companies: 501, partialRun: 0 } }), /limited run of 0 companies/);
  assert.match(notCounted({ stocks: full.slice(0, 6), counts: { companies: 6 } }), /^6 companies is not the full index/);
  assert.match(notCounted({}), /^0 companies/);
});
