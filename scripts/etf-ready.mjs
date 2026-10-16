/* ==========================================================================
   StockOrNot — are the funds ready for an app build?

   An app build carries the funds (data/etfs.json) only once every fund card
   is complete: App Review meeting "Not read" fees and "Not enough price
   history for a chart" on fund after fund is a build turned down as
   unfinished (docs/APP_STORE.md, "When to make the ETF build"). The rule is
   this file's, and scripts/build-app.mjs asks it before copying the funds
   in; until it passes, the build carries an empty list, as before the first
   ETF night.

   Only funds whose holdings have been read count: the app shows no other
   (lib/funds.mjs fundsToShow). Each of those needs
   - a fee (`er`, a number),
   - at least five closes in data/etf-closes.json, which its chart needs,
   - holdings no older than 200 days, which is a missed quarterly filing.

     node scripts/etf-ready.mjs     # the three lists, and whether a build carries the funds

   No dependencies.
   ========================================================================== */

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIN_CLOSES = 5;
const MAX_AGE_DAYS = 200;

/* etfs: data/etfs.json's list; closes: data/etf-closes.json's `closes`
   (ticker to list of closes). Each list names the funds that fail that
   check; `ready` is true when none does. */
export function etfReadiness(etfs, closes, now = Date.now()) {
  const read = (Array.isArray(etfs) ? etfs : []).filter((e) => e && e.nport && (e.hold || []).length);
  const failing = (bad) => read.filter(bad).map((e) => e.t);
  const noFee = failing((e) => typeof e.er !== "number");
  const fewCloses = failing((e) => ((closes || {})[e.t] || []).length < MIN_CLOSES);
  const outOfDate = failing((e) => !(now - Date.parse(e.nport.period) <= MAX_AGE_DAYS * 864e5));
  return { funds: read.length, noFee, fewCloses, outOfDate, ready: !noFee.length && !fewCloses.length && !outOfDate.length };
}

/* The same for the files in a folder laid out as the repository is: null
   when there is no data/etfs.json, which no build carries anyway. */
export function etfReadinessIn(root = ROOT, now = Date.now()) {
  const read = (f) => JSON.parse(readFileSync(path.join(root, f), "utf8"));
  let etfs;
  try { etfs = read("data/etfs.json").etfs; } catch (err) { if (err.code === "ENOENT") return null; throw err; }
  let closes = {};
  try { closes = read("data/etf-closes.json").closes; } catch (err) { if (err.code !== "ENOENT") throw err; }
  return etfReadiness(etfs, closes, now);
}

/* One line, for the build's output: which checks the funds fail. */
export function notReadyReason(r) {
  const n = (list, what) => (list.length ? [`${list.length} ${what}`] : []);
  return [...n(r.noFee, "with no fee"), ...n(r.fewCloses, `with fewer than ${MIN_CLOSES} closes`), ...n(r.outOfDate, "out of date")].join(", ");
}

function main() {
  const r = etfReadinessIn();
  if (!r) { console.log("There is no data/etfs.json yet: an app build carries no funds."); return; }
  const list = (l) => l.join(" ") || "none";
  console.log(r.funds + " funds with holdings");
  console.log("no fee: " + list(r.noFee));
  console.log(`fewer than ${MIN_CLOSES} closes: ` + list(r.fewCloses));
  console.log("out of date: " + list(r.outOfDate));
  console.log(r.ready ? "Ready: an app build carries the funds." : "Not ready: an app build leaves the funds out.");
}

/* the file's real path: argv keeps a symlinked path, import.meta.url does not */
const calledDirectly = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (calledDirectly) main();
