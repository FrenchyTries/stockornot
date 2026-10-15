/* ==========================================================================
   Track record — what the score picked, followed forward

   Once a week, on the first run of each ISO week, the top fifth of the
   S&P 500 by score (80 and up) and the bottom fifth (under 20) are written
   down. From then on every run moves each group, and every company in the
   index together, by that day's price changes. Nothing is backfilled: the
   record starts the first night this runs and only goes forward, so it is not
   a backtest and cannot be tuned after the fact.

   Each group is equal-weighted and rebalanced daily: its day is the average
   of its members' price changes. Prices are the snapshot's closes, without
   dividends or trading costs. A one-day fall of 40% or more, or a rise of
   two thirds or more, is set aside for that day rather than counted: that
   is how a 2-for-1 or larger split usually shows up, and it also sets aside
   the rare real crash. Any split (3-for-2, 4-for-3, 2-for-1 and the rest, or
   the reverse) is also set aside when the quote's previous close has been
   restated for it, on a night that follows the last one counted. A company
   that leaves the index simply stops counting. A limited test run (LIMIT)
   is never counted.

   Writes data/track.json. Run after refresh.mjs and the audit. Exported
   pieces are pure, for tests.
   ========================================================================== */

import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildScoreContext, scoreStock, SCORE_VERSION } from "../lib/analysis.mjs";
import { sessionDate } from "./dates.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "..", "data");
const OUT = path.join(DATA, "track.json");

const TOP = 80, BOTTOM = 20;    /* the top and bottom fifths, as scoreLabel names them */
const MAX_DAY = 0.4;            /* a one-day fall of 40% or more, or rise of two thirds, is set aside */
const FULL_INDEX = 400;         /* a smoke-test run with fewer companies is not counted */
/* the usual split shapes, both ways; a large one inside the band when the day also moved */
const SPLIT_SHAPES = [3 / 2, 4 / 3, 5 / 4, 2, 3, 4, 5, 10, 2 / 3, 3 / 4, 4 / 5, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10];

/** "2026-W41": the ISO week a YYYY-MM-DD date falls in. */
export function isoWeek(date) {
  /* the week belongs to the year its Thursday falls in */
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 864e5 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Each company's price change since the last run, splits and bad prints set
 * aside. `prevs` holds tonight's quotes' previous closes, by ticker.
 */
export function dayRatios(last, prices, prevs = {}) {
  const out = {};
  for (const [t, p] of Object.entries(prices)) {
    const q = last?.[t];
    if (!(q > 0 && p > 0)) continue;
    const r = p / q;
    if (r <= 1 - MAX_DAY || r >= 1 / (1 - MAX_DAY)) continue;
    /* A 3-for-2, 4-for-3 or 5-for-4 split is a smaller step than that. The
       quote's previous close is restated for a split, so it then disagrees
       with last night's close by the split's shape; on an ordinary night the
       two are the same. A feed that does not restate it leaves this as it was. */
    const pc = prevs[t];
    if (pc > 0 && SPLIT_SHAPES.some((k) => Math.abs(q / pc / k - 1) < 0.01)) continue;
    out[t] = r;
  }
  return out;
}

/** A group's day: the average of its members' changes, or flat if none moved. */
export function step(members, ratios) {
  const rs = members.map((t) => ratios[t]).filter((r) => r !== undefined);
  return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 1;
}

/** The top and bottom fifths by score, each company once (one share class). */
export function picks(stocks) {
  const ctx = buildScoreContext(stocks);
  const seen = new Set();
  const top = [], bottom = [];
  for (const s of stocks) {
    const id = s.cik || s.t;
    if (seen.has(id)) continue;
    seen.add(id);
    const o = scoreStock(s, ctx).overall;
    if (o === null) continue;
    if (o >= TOP) top.push(s.t);
    else if (o < BOTTOM) bottom.push(s.t);
  }
  return { top: top.sort(), bottom: bottom.sort() };
}

const round = (v) => Math.round(v * 1e6) / 1e6;

/**
 * One night. Moves every group by today's changes, then starts a new group if
 * this is the first run of a new week. Running twice for the same session
 * changes nothing.
 */
export function advance(track, snap, session) {
  const prices = {}, prevs = {};
  for (const s of snap.stocks) if (s.price > 0) { prices[s.t] = s.price; if (s.prev > 0) prevs[s.t] = s.prev; }
  const t = track?.session ? track : { started: session, session: null, last: {}, groups: [] };
  if (t.session === session) return t;

  if (t.session) {
    /* Tonight's previous closes say whether last night was the last one
       counted: then nearly all of them are last night's closes. After a
       missed night most are not, and a real move of 20% or 25% on the day
       missed would look like a restated split, so they are not used. */
    const both = Object.keys(prevs).filter((x) => t.last?.[x] > 0);
    const same = both.filter((x) => Math.abs(prevs[x] / t.last[x] - 1) < 0.0005).length;
    const ratios = dayRatios(t.last, prices, both.length && same > both.length / 2 ? prevs : {});
    const all = step(Object.keys(ratios), ratios);
    for (const g of t.groups) {
      g.top = round(g.top * step(g.members.top, ratios));
      g.bottom = round(g.bottom * step(g.members.bottom, ratios));
      g.index = round(g.index * all);
      g.days += 1;
      g.through = session;
    }
  }

  const week = isoWeek(session);
  if (!t.groups.length || t.groups[t.groups.length - 1].week !== week) {
    t.groups.push({ week, start: session, through: session, days: 0, method: SCORE_VERSION,
      top: 1, bottom: 1, index: 1, members: picks(snap.stocks) });
  }
  t.session = session;
  t.last = prices;
  return t;
}

/**
 * Why tonight's snapshot is not counted, or null if it is. A limited run
 * (LIMIT) merges its few fresh rows into yesterday's full snapshot, so it
 * never looks short; refresh.mjs marks it partialRun. Counted, it would file
 * a whole day under a few prices, and that evening's full run, the same
 * session, would then change nothing.
 */
export function notCounted(snap) {
  if (snap?.counts?.partialRun !== undefined) return `a limited run of ${snap.counts.partialRun} companies is not the full index`;
  if (!snap?.stocks || snap.stocks.length < FULL_INDEX) return `${snap?.stocks?.length || 0} companies is not the full index`;
  return null;
}

async function main() {
  const snap = JSON.parse(await fs.readFile(path.join(DATA, "snapshot.json"), "utf8"));
  const why = notCounted(snap);
  if (why) {
    console.log(`Track record: ${why}, so tonight is not counted.`);
    return;
  }
  const session = snap.session || sessionDate(snap.updated);
  if (!session) throw new Error("The snapshot has no date to file tonight under.");
  let track = null;
  try { track = JSON.parse(await fs.readFile(OUT, "utf8")); } catch { /* the first night */ }
  const next = advance(track, snap, session);
  await fs.writeFile(OUT + ".tmp", JSON.stringify(next));
  await fs.rename(OUT + ".tmp", OUT);
  const g = next.groups[next.groups.length - 1];
  console.log(`Track record through ${session}: ${next.groups.length} weekly group(s); this week's has ` +
    `${g.members.top.length} in the top fifth and ${g.members.bottom.length} in the bottom.`);
}

/* the file's real path: argv keeps a symlinked path, import.meta.url does not */
const calledDirectly = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (calledDirectly) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
