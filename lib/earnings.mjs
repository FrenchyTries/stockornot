/* ==========================================================================
   Who reports soon, and what the street expects them to hit.

   Shared by the page (the "reporting soon" panel, the calendar file and, in
   the iPhone app, the reminders) and by scripts/earnings-alerts.mjs (the
   email a week ahead), so they all say the same thing about the same
   company. No DOM in here.
   ========================================================================== */

const num = (v) => typeof v === "number" && isFinite(v);

export const ALERT_DAYS = 7;

/** Whole days from today (UTC) to an ISO date. */
export function daysUntil(iso, now = new Date()) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(d)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((d - today) / 864e5);
}

export function money(v) {
  if (!num(v)) return "—";
  const a = Math.abs(v), sign = v < 0 ? "\u2212" : "";
  if (a >= 1e12) return sign + "$" + (a / 1e12).toFixed(2) + "T";
  if (a >= 1e9)  return sign + "$" + (a / 1e9).toFixed(a >= 1e11 ? 0 : 1) + "B";
  if (a >= 1e6)  return sign + "$" + (a / 1e6).toFixed(0) + "M";
  return sign + "$" + a.toFixed(0);
}

export const eps = (v) => (num(v) ? (v < 0 ? "\u2212" : "") + "$" + Math.abs(v).toFixed(2) : "—");

export function whenWord(hour) {
  return hour === "bmo" ? "before the open" : hour === "amc" ? "after the close" : hour === "dmh" ? "during market hours" : "";
}

export function quarterLabel(e) {
  return e && num(e.q) && num(e.fy) ? "Q" + e.q + " " + e.fy : "";
}

/** Cart companies with a report date inside the window, soonest first. */
export function upcoming(items, byTicker, { days = ALERT_DAYS, now = new Date() } = {}) {
  const out = [];
  for (const item of items || []) {
    const s = byTicker[item.t];
    const e = s && s.earnings;
    if (!e || !e.date) continue;
    const d = daysUntil(e.date, now);
    if (d === null || d < 0 || d > days) continue;
    out.push({ t: s.t, n: s.n, date: e.date, days: d, hour: e.hour || null,
               epsEst: num(e.epsEst) ? e.epsEst : null, revEst: num(e.revEst) ? e.revEst : null,
               q: e.q ?? null, fy: e.fy ?? null, price: s.price });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.t.localeCompare(b.t));
}

/** One sentence: what they are expected to hit. */
export function expectation(e) {
  const parts = [];
  if (num(e.epsEst)) parts.push(eps(e.epsEst) + " a share");
  if (num(e.revEst)) parts.push(money(e.revEst) + " in revenue");
  return parts.length ? "The street expects " + parts.join(" on ") + "." : "No consensus estimate published yet.";
}

/* "Thursday, October 22", the way the email writes a report date. */
const dateLong = (iso) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

function tickerList(ts, shown = 6) {
  const head = ts.length > shown ? ts.slice(0, shown) : ts.slice(0, -1);
  const tail = ts.length > shown ? ts.length - shown + " more" : ts[ts.length - 1];
  return head.length ? head.join(", ") + " and " + tail : tail;
}

/* iOS keeps at most 64 scheduled notifications for an app. */
export const MAX_REMINDERS = 60;

/** The iPhone app's reminders, scheduled on the phone: nine in the morning,
    local time, ALERT_DAYS before each report in the cart, the same moment as
    the first alarm in the calendar file. Reports on the same day share one
    notification, whose id is the day it fires as yyyymmdd, so scheduling the
    list again replaces each one rather than adding a second. A reminder that
    would fire within the next minute is left out: the phone would deliver it
    at once. Soonest first, at most MAX_REMINDERS.
    Returns [{ id, at: Date, title, body }]. */
export function reminders(items, byTicker, { now = new Date(), days = 120 } = {}) {
  const soon = now.getTime() + 60e3;
  const byDay = new Map();
  for (const r of upcoming(items, byTicker, { days, now })) {
    const [y, m, d] = r.date.split("-").map(Number);
    const at = new Date(y, m - 1, d - ALERT_DAYS, 9, 0, 0);
    if (!(at.getTime() > soon)) continue;
    const id = at.getFullYear() * 10000 + (at.getMonth() + 1) * 100 + at.getDate();
    if (!byDay.has(id)) byDay.set(id, { id, at, rows: [] });
    const day = byDay.get(id);
    if (!day.rows.some((x) => x.t === r.t)) day.rows.push(r);
  }
  return [...byDay.values()].slice(0, MAX_REMINDERS).map(({ id, at, rows }) => {
    if (rows.length === 1) {
      const r = rows[0], q = quarterLabel(r), when = whenWord(r.hour);
      return {
        id, at,
        title: r.t + " reports in a week",
        body: (r.n || r.t) + " reports" + (q ? " " + q + " results" : "") + " on " + dateLong(r.date) +
          (when ? ", " + when : "") + ". " + expectation(r)
      };
    }
    return {
      id, at,
      title: rows.length + " companies in your cart report in a week",
      body: tickerList(rows.map((r) => r.t)) + " report on " + dateLong(rows[0].date) + "."
    };
  });
}

/** How the last few quarters went, from the deep file's surprise history. */
export function track(analyst, n = 4) {
  const rows = ((analyst && analyst.earnings) || []).filter((e) => num(e.actual) && num(e.estimate)).slice(0, n);
  if (!rows.length) return "";
  const beats = rows.filter((e) => e.actual >= e.estimate).length;
  return "Beat the estimate in " + beats + " of the last " + rows.length + " quarters.";
}

/* ================================================================ ICS =====
   An all-day event on the report date with two reminders: nine in the
   morning a week before, and nine the morning before. Apple Calendar and
   Outlook keep the reminders from the file; Google Calendar drops imported
   reminders and applies its own defaults. */

function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/* Lines longer than 75 octets must be folded; continuation lines start with a
   space. Fold on characters, never inside a multi-byte one. */
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "", size = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (size + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; size = 0; }
    cur += ch; size += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const ymd = (iso) => iso.replace(/-/g, "");
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function nextDay(iso) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** rows: [{ t, n, date, hour, epsEst, revEst, q, fy }] */
export function toIcs(rows, { site = "https://stockornot.com", now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//StockOrNot//Earnings//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:StockOrNot earnings"
  ];
  for (const r of rows) {
    const when = whenWord(r.hour);
    const q = quarterLabel(r);
    const expect = expectation(r);
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + slug(r.t) + "-" + ymd(r.date) + "@stockornot",
      "DTSTAMP:" + stamp,
      "DTSTART;VALUE=DATE:" + ymd(r.date),
      "DTEND;VALUE=DATE:" + ymd(nextDay(r.date)),
      "SUMMARY:" + esc(r.t + " reports" + (q ? " " + q : "") + (when ? " " + when : "")),
      "DESCRIPTION:" + esc((r.n || r.t) + " reports" + (q ? " " + q + " results" : " earnings") +
        (when ? " " + when : "") + ".\n" + expect + "\nNot investment advice."),
      "URL:" + site + "/stock/" + slug(r.t),
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM", "ACTION:DISPLAY",
      "DESCRIPTION:" + esc(r.t + " reports in a week. " + expect),
      "TRIGGER:-P6DT15H", "END:VALARM",
      "BEGIN:VALARM", "ACTION:DISPLAY",
      "DESCRIPTION:" + esc(r.t + " reports tomorrow" + (when ? " " + when : "") + ". " + expect),
      "TRIGGER:-PT15H", "END:VALARM",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
