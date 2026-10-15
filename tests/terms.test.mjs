import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { TERMS_VERSION } from "../lib/auth.mjs";

/* The terms page, and what a new account records about agreeing to it. */

const ROOT = path.resolve(import.meta.dirname, "..");
const text = (page) => readFileSync(path.join(ROOT, page), "utf8").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

/* An account keeps the version of the terms it agreed to, so the version has
   to name the terms on the page: when terms.html changes, its date moves, and
   TERMS_VERSION in lib/auth.mjs moves with it. */
test("the terms version kept on new accounts is the date on the terms page", () => {
  const m = text("terms.html").match(/Last updated (\w+) (\d{1,2}), (\d{4})/);
  assert.ok(m, "terms.html says when it was last updated");
  const month = MONTHS.indexOf(m[1]) + 1;
  assert.ok(month > 0, m[1]);
  assert.equal(`${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`, TERMS_VERSION);
});

/* The site and the app publish fund readings beside the company scores, so
   the pages that say what StockOrNot is cover funds as well. */
test("the terms and the support page say StockOrNot covers funds too", () => {
  for (const page of ["terms.html", "support.html"]) {
    assert.match(text(page), /companies' and funds' public filings/, page);
  }
  assert.match(text("terms.html"), /fund and index names and tickers belong to their owners/);
});
