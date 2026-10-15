/* The nightly refresh's own rules (scripts/refresh.mjs): what a failed
   request keeps from last night, which session the prices are filed under,
   what counts as a renamed ticker, and which share class has no 52-week
   range of its own. The run itself needs the network; these do not. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { renamedTo, quotedSession, carriedRatios, laterClasses, METRIC_NAMES, noRatios } from "../scripts/refresh.mjs";
import { sessionDate } from "../scripts/dates.mjs";

test("a failed quote is a rename only when the SEC dropped the old ticker for a new one", () => {
  const known = new Set(["GOOGL", "GOOG", "BRK.B", "FOXA", "FOX", "FI"]);
  /* one failed quote for a company the SEC lists under two classes */
  assert.equal(renamedTo("GOOGL", ["GOOGL", "GOOG"], known), null);
  assert.equal(renamedTo("BRK.B", ["BRK.B", "BRK.A"], known), null);
  /* the other class is in the index already, even with the old one gone */
  assert.equal(renamedTo("FOX", ["FOXA"], known), null);
  /* a real rename */
  assert.equal(renamedTo("FI", ["FISV"], known), "FISV");
  /* the ticker list did not load, or only a malformed symbol is on it */
  assert.equal(renamedTo("FI", [], known), null);
  assert.equal(renamedTo("FI", ["FI$V"], known), null);
});

test("prices are filed under the session their quotes are stamped with, not the run's date", () => {
  /* Thanksgiving 2026: the 22:20 UTC run, and Wednesday's 16:00 ET quotes */
  const run = sessionDate(new Date("2026-11-26T22:20:00Z"));
  assert.equal(run, "2026-11-26");
  const stamp = sessionDate(new Date("2026-11-25T21:00:00Z"));
  assert.equal(quotedSession(new Map([[stamp, 499], ["2026-11-20", 2]]), run), "2026-11-25");
  /* an ordinary night is the run's own date, as before */
  assert.equal(quotedSession(new Map([["2026-10-14", 501]]), "2026-10-14"), "2026-10-14");
  /* no quote had a stamp; a tie goes to the later session */
  assert.equal(quotedSession(new Map(), run), run);
  assert.equal(quotedSession(new Map([["2026-10-13", 3], ["2026-10-14", 3]]), "x"), "2026-10-14");
});

test("a failed /stock/metric call keeps last night's ratios, for a week at most", () => {
  const was = { t: "AAPL", price: 250, mc: 3.7e6, pe: 38.2, lo: 169.2, hi: 260.1, dy: null, rs52: 4.1 };
  const kept = carriedRatios(was, "2026-10-13", "2026-10-14");
  assert.deepEqual(kept, {
    from: "2026-10-13",
    metric: { marketCapitalization: 3.7e6, peTTM: 38.2, "52WeekLow": 169.2, "52WeekHigh": 260.1, "priceRelativeToS&P50052Week": 4.1 }
  });
  /* already kept over: the date stays the one the figures are from */
  assert.equal(carriedRatios({ ...was, ratiosFrom: "2026-10-07" }, "2026-10-13", "2026-10-14").from, "2026-10-07");
  assert.equal(carriedRatios({ ...was, ratiosFrom: "2026-10-06" }, "2026-10-13", "2026-10-14"), null);
  /* nothing to keep */
  assert.equal(carriedRatios(undefined, "2026-10-13", "2026-10-14"), null);
  assert.equal(carriedRatios({ t: "X", price: 5, mc: null }, "2026-10-13", "2026-10-14"), null);
  assert.equal(carriedRatios(was, undefined, "2026-10-14"), null);
});

test("every ratio is kept under the name the row reads it from first", () => {
  /* the row in refresh.mjs reads each field with pickMetric(m, "first", ...);
     a kept figure has to come back under that first name or it is lost */
  const src = fs.readFileSync(new URL("../scripts/refresh.mjs", import.meta.url), "utf8");
  const read = {};
  for (const [, field, name] of src.matchAll(/^\s+(\w+):\s+pickMetric\(m, "([^"]+)"/gm)) read[field] = name;
  const pe = /const peNow = pickMetric\(m, "([^"]+)"/.exec(src);
  const range = /let lo = pickMetric\(m, "([^"]+)"\), hi = pickMetric\(m, "([^"]+)"\)/.exec(src);
  Object.assign(read, { pe: pe[1], lo: range[1], hi: range[2] });
  assert.ok(Object.keys(read).length >= 30, Object.keys(read).length);
  assert.deepEqual(METRIC_NAMES, read);
});

test("only the first class of a company listed in sp500.json keeps Finnhub's 52-week range", () => {
  assert.deepEqual([...laterClasses([
    { t: "GOOGL", cik: "1" }, { t: "GOOG", cik: "1" }, { t: "BRK.B", cik: "2" }, { t: "X" }, { t: "Y" }
  ])], ["GOOG"]);
  /* Finnhub's one range per company is the first-listed class's (News Corp
     A's, shown on B); a change to this list wants that checked again */
  const universe = JSON.parse(fs.readFileSync(new URL("../data/sp500.json", import.meta.url), "utf8"));
  assert.deepEqual([...laterClasses(universe.companies)].sort(), ["FOX", "GOOG", "NWS"]);
});

test("an answer with none of the figures a row reads counts as failed", () => {
  assert.equal(noRatios(null), true);
  assert.equal(noRatios({}), true);
  assert.equal(noRatios({ metric: {} }), true);
  assert.equal(noRatios({ metric: Object.fromEntries(Object.values(METRIC_NAMES).map((n) => [n, null])) }), true);
  /* a number only in a field no row reads */
  assert.equal(noRatios({ metric: { bookValuePerShareAnnual: 4.2 } }), true);
  assert.equal(noRatios({ metric: { peTTM: 21.5 } }), false);
});
