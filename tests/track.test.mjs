import test from "node:test";
import assert from "node:assert/strict";
import { isoWeek, dayRatios, step, advance } from "../scripts/track.mjs";

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
