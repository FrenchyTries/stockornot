import test from "node:test";
import assert from "node:assert/strict";
import { reminders, ALERT_DAYS, MAX_REMINDERS } from "../lib/earnings.mjs";

/* Everything here is in local time, as the phone schedules it, so the tests
   hold in any time zone the suite runs in. */
const NOW = new Date(2026, 9, 11, 12, 0, 0);          /* Sunday, October 11, noon */

const co = (t, date, more = {}) => ({ t, n: t + " Inc.", price: 100, earnings: { date, ...more } });
const book = (...stocks) => Object.fromEntries(stocks.map((s) => [s.t, s]));
const cart = (byTicker) => Object.keys(byTicker).map((t) => ({ t }));

test("fires at nine in the morning, local time, a week before the report", () => {
  const by = book(co("AAPL", "2026-10-29", { hour: "amc" }));
  const [r] = reminders(cart(by), by, { now: NOW });
  assert.equal(ALERT_DAYS, 7);
  assert.ok(r.at instanceof Date);
  assert.equal(r.at.getTime(), new Date(2026, 9, 22, 9, 0, 0).getTime());
  assert.equal(r.at.getHours(), 9);
  assert.equal(r.at.getMinutes(), 0);
});

test("a week before still means nine in the morning across a clock change", () => {
  /* US clocks go back on November 1, 2026; the reminder is October 29 */
  const by = book(co("KO", "2026-11-05"));
  const [r] = reminders(cart(by), by, { now: NOW });
  assert.equal(r.at.getDate(), 29);
  assert.equal(r.at.getHours(), 9);
});

test("drops reports already past, and reminders whose moment has gone", () => {
  const by = book(
    co("OLD", "2026-10-01"),          /* reported already */
    co("TODAY", "2026-10-18"),        /* its reminder was 9:00 this morning */
    co("NEXT", "2026-10-20")          /* Tuesday the 13th, 9:00: still ahead */
  );
  const out = reminders(cart(by), by, { now: NOW });
  assert.deepEqual(out.map((r) => r.title), ["NEXT reports in a week"]);
});

test("leaves out anything less than a minute away, which the phone would deliver at once", () => {
  const by = book(co("AAPL", "2026-10-20"));
  const nine = new Date(2026, 9, 13, 9, 0, 0).getTime();
  assert.equal(reminders(cart(by), by, { now: new Date(nine - 30e3) }).length, 0);
  assert.equal(reminders(cart(by), by, { now: new Date(nine - 120e3) }).length, 1);
});

test("one notification per day, with the day it fires as its yyyymmdd id", () => {
  const by = book(
    co("MSFT", "2026-10-28", { hour: "amc" }),
    co("AAPL", "2026-10-28", { hour: "bmo" }),
    co("NVDA", "2026-11-18")
  );
  const out = reminders(cart(by), by, { now: NOW });
  assert.deepEqual(out.map((r) => r.id), [20261021, 20261111]);
  assert.equal(out[0].title, "2 companies in your cart report in a week");
  assert.equal(out[0].body, "AAPL and MSFT report on Wednesday, October 28.");
  assert.equal(out[1].title, "NVDA reports in a week");
  assert.ok(Number.isInteger(out[0].id) && out[0].id < 2 ** 31);
});

test("a company in the cart twice is named once", () => {
  const by = book(co("AAPL", "2026-10-28"));
  const out = reminders([{ t: "AAPL" }, { t: "AAPL" }], by, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "AAPL reports in a week");
});

test("one company: what it is, when, and what the street expects", () => {
  const by = book(co("AAPL", "2026-10-29", { hour: "amc", q: 4, fy: 2026, epsEst: 1.23, revEst: 95.04e9 }));
  const [r] = reminders(cart(by), by, { now: NOW });
  assert.equal(r.title, "AAPL reports in a week");
  assert.equal(r.body,
    "AAPL Inc. reports Q4 2026 results on Thursday, October 29, after the close. " +
    "The street expects $1.23 a share on $95.0B in revenue.");
});

test("no time of day and no estimate still reads as a sentence", () => {
  const by = book(co("KO", "2026-10-29"));
  const [r] = reminders(cart(by), by, { now: NOW });
  assert.equal(r.body, "KO Inc. reports on Thursday, October 29. No consensus estimate published yet.");
});

test("a long list of companies on one day is shortened", () => {
  const ts = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const by = book(...ts.map((t) => co(t, "2026-10-28")));
  const [r] = reminders(cart(by), by, { now: NOW });
  assert.equal(r.title, "8 companies in your cart report in a week");
  assert.equal(r.body, "A, B, C, D, E, F and 2 more report on Wednesday, October 28.");
});

test("at most sixty, the soonest kept", () => {
  const day = (i) => new Date(Date.UTC(2026, 9, 20 + i)).toISOString().slice(0, 10);
  const by = book(...Array.from({ length: 80 }, (_, i) => co("T" + i, day(i))));
  const out = reminders(cart(by), by, { now: NOW, days: 120 });
  assert.equal(MAX_REMINDERS, 60);
  assert.equal(out.length, 60);
  assert.equal(out[0].id, 20261013);
  assert.ok(out.every((r, i) => i === 0 || r.at > out[i - 1].at));
});

test("only reports inside the window, and nothing without a date", () => {
  const by = book(co("FAR", "2027-06-01"), { t: "NONE", n: "None", earnings: null }, co("NEAR", "2026-10-28"));
  const out = reminders(cart(by), by, { now: NOW });
  assert.deepEqual(out.map((r) => r.title), ["NEAR reports in a week"]);
  assert.deepEqual(reminders([], by, { now: NOW }), []);
  assert.deepEqual(reminders(null, by, { now: NOW }), []);
});
