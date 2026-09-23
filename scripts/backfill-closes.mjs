/* ==========================================================================
   Rebuild each company's daily closes from the repository's own history.

   Every nightly commit of data/snapshot.json holds that session's closing
   price for every company. The refresh now records those into
   data/detail/<TICKER>.json as it goes; this fills in the sessions from
   before it did. Safe to re-run: existing points are kept, and where a
   session was committed more than once the latest commit wins.

     node scripts/backfill-closes.mjs      (needs full git history:
                                            git fetch --unshallow)
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sessionDate } from "./dates.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DETAIL = path.join(ROOT, "data", "detail");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const commits = git("log", "--reverse", "--format=%H", "--", "data/snapshot.json").trim().split("\n").filter(Boolean);
const byTicker = new Map();        /* ticker -> Map(session -> close) */
let used = 0;

for (const sha of commits) {
  let snap;
  try { snap = JSON.parse(git("show", `${sha}:data/snapshot.json`)); } catch { continue; }
  const session = snap.session || (snap.updated && sessionDate(snap.updated));
  if (!session || !Array.isArray(snap.stocks)) continue;
  used++;
  for (const s of snap.stocks) {
    if (typeof s.price !== "number" || !isFinite(s.price) || s.price <= 0) continue;
    if (!byTicker.has(s.t)) byTicker.set(s.t, new Map());
    byTicker.get(s.t).set(session, +s.price.toFixed(4));       /* later commits overwrite */
  }
}

let files = 0, added = 0;
for (const [t, series] of byTicker) {
  const file = path.join(DETAIL, t.replace(/[^A-Z0-9.]/gi, "_") + ".json");
  let detail;
  try { detail = JSON.parse(await fs.readFile(file, "utf8")); } catch { continue; }
  const have = new Map((detail.closes || []).map((p) => [p[0], p[1]]));
  for (const [d, v] of series) if (!have.has(d)) { have.set(d, v); added++; }
  detail.closes = [...have.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  await fs.writeFile(file, JSON.stringify(detail));
  files++;
}
console.log(`${used} snapshots read, ${added} closes added across ${files} companies`);
