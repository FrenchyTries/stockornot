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
   dividends or trading costs. A split shows up as a one-day move of 40% or
   more; any such move is set aside for that day rather than counted, which
   also sets aside the rare real crash. A company that leaves the index simply
   stops counting.

   Writes data/track.json. Run after refresh.mjs and the audit. Exported
   pieces are pure, for tests.
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildScoreContext, scoreStock, SCORE_VERSION } from "../lib/analysis.mjs";
import { sessionDate } from "./dates.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "..", "data");
const OUT = path.join(DATA, "track.json");

const TOP = 80, BOTTOM = 20;    /* the top and bottom fifths, as scoreLabel names them */
const MAX_DAY = 0.4;            /* a one-day move of 40% or more is set aside */
const FULL_INDEX = 400;         /* a smoke-test run with fewer companies is not counted */

/** "2026-W41": the ISO week a YYYY-MM-DD date falls in. */
export function isoWeek(date) {
  /* the week belongs to the year its Thursday falls in */
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 864e5 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Each company's price change since the last run, splits and bad prints set aside. */
export function dayRatios(last, prices) {
  const out = {};
  for (const [t, p] of Object.entries(prices)) {
    const q = last?.[t];
    if (!(q > 0 && p > 0)) continue;
    const r = p / q;
    if (r <= 1 - MAX_DAY || r >= 1 / (1 - MAX_DAY)) continue;
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
  const prices = {};
  for (const s of snap.stocks) if (s.price > 0) prices[s.t] = s.price;
  const t = track?.session ? track : { started: session, session: null, last: {}, groups: [] };
  if (t.session === session) return t;

  if (t.session) {
    const ratios = dayRatios(t.last, prices);
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

async function main() {
  const snap = JSON.parse(await fs.readFile(path.join(DATA, "snapshot.json"), "utf8"));
  if (!snap?.stocks || snap.stocks.length < FULL_INDEX) {
    console.log(`Track record: ${snap?.stocks?.length || 0} companies is not the full index, so tonight is not counted.`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
