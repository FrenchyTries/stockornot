import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { daysUntil, localDay, upcoming } from "../lib/earnings.mjs";
import { nyDate } from "../scripts/dates.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

/* Which day "today" is, for "reports tomorrow" and "in 7 days". The page
   counts on the viewer's own calendar, so these build their moments in
   local time; the nightly email counts on New York's. The file runs in New
   York's zone: on a UTC machine (this one, GitHub's runners) a UTC count,
   the old fault, would pass these unnoticed. */
process.env.TZ = "America/New_York";

const by = {
  BAC: { t: "BAC", n: "Bank of America", earnings: { date: "2026-10-14", hour: "bmo" } },
  ABT: { t: "ABT", n: "Abbott", earnings: { date: "2026-10-21", hour: "bmo" } }
};
const cart = [{ t: "BAC" }, { t: "ABT" }];

test("a report tomorrow is tomorrow all evening, until the viewer's own midnight", () => {
  /* 9pm, the hour the UTC count used to call it "today" in New York */
  assert.equal(daysUntil("2026-10-15", new Date(2026, 9, 14, 21, 0)), 1);
  assert.equal(daysUntil("2026-10-15", new Date(2026, 9, 14, 23, 59)), 1);
  assert.equal(daysUntil("2026-10-15", new Date(2026, 9, 15, 0, 1)), 0);
  assert.equal(daysUntil("2026-10-14", new Date(2026, 9, 14, 21, 0)), 0);
  assert.equal(daysUntil("2026-10-13", new Date(2026, 9, 14, 21, 0)), -1);
  assert.equal(daysUntil("2026-10-21", new Date(2026, 9, 14, 0, 0)), 7);
});

test("every hour of the weeks the clocks change counts whole calendar days", () => {
  for (const [from, to] of [[new Date(2026, 9, 28), new Date(2026, 10, 5)], [new Date(2027, 2, 10), new Date(2027, 2, 18)]]) {
    for (let at = from.getTime(); at < to.getTime(); at += 3600e3) {
      const now = new Date(at);
      for (let k = -1; k <= 8; k++) {
        const target = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + k, 12));
        assert.equal(daysUntil(target, now), k, `${target} from ${now}`);
      }
    }
  }
});

test("a YYYY-MM-DD in place of now counts from that date", () => {
  assert.equal(daysUntil("2026-10-14", "2026-10-13"), 1);
  assert.equal(daysUntil("2026-11-02", "2026-10-31"), 2);
  assert.equal(daysUntil("2027-03-15", "2027-03-14"), 1);
});

test("nothing readable, no count: null, never NaN", () => {
  const now = new Date(2026, 9, 14, 12);
  assert.equal(daysUntil("", now), null);
  assert.equal(daysUntil(null, now), null);
  assert.equal(daysUntil("garbage", now), null);
  assert.equal(daysUntil("2026-10-14", new Date(NaN)), null);
  assert.equal(daysUntil("2026-10-14", "junk"), null);
  assert.equal(daysUntil("2026-10-14", ""), null);
});

test("a moment's own date, and nothing (never today) for a missing one", () => {
  assert.equal(localDay(new Date(2026, 9, 14, 23, 59)), "2026-10-14");
  assert.equal(localDay(new Date(2026, 0, 5, 0, 0)), "2026-01-05");
  assert.equal(localDay(new Date(2026, 9, 14, 18, 30).toISOString()), "2026-10-14");
  assert.equal(localDay(new Date(2026, 9, 14, 18, 30).getTime()), "2026-10-14");
  for (const bad of [undefined, null, "", "junk", NaN]) assert.equal(localDay(bad), "", String(bad));
});

test("New York's date while the nightly email runs, after midnight UTC", () => {
  assert.equal(nyDate(new Date("2026-10-14T00:55:00Z")), "2026-10-13");   /* 8:55pm EDT */
  assert.equal(nyDate(new Date("2026-10-14T04:09:00Z")), "2026-10-14");   /* 12:09am EDT */
  assert.equal(nyDate(new Date("2026-12-02T04:40:00Z")), "2026-12-01");   /* 11:40pm EST */
  assert.equal(nyDate(new Date("2026-12-02T05:10:00Z")), "2026-12-02");
});

test("the email's window: tomorrow's report is a day away, and a week means seven New York days", () => {
  const tonight = nyDate(new Date("2026-10-14T00:55:00Z"));
  assert.deepEqual(upcoming(cart, by, { days: 7, today: tonight }).map((u) => [u.t, u.days]), [["BAC", 1]]);
  const nextNight = nyDate(new Date("2026-10-15T00:50:00Z"));
  assert.deepEqual(upcoming(cart, by, { days: 7, today: nextNight }).map((u) => [u.t, u.days]), [["BAC", 0], ["ABT", 7]]);
});

test("on the page, upcoming counts from the viewer's own date of now", () => {
  const evening = new Date(2026, 9, 13, 21, 30);
  assert.deepEqual(upcoming(cart, by, { days: 7, now: evening }).map((u) => [u.t, u.days]), [["BAC", 1]]);
  assert.deepEqual(upcoming(cart, by, { days: 7, now: new Date(2026, 9, 14, 9, 0) }).map((u) => [u.t, u.days]), [["BAC", 0], ["ABT", 7]]);
});

/* The email job itself, as the nightly runner starts it (in UTC), with the
   clock set and Supabase played by a stand-in: one reader with alerts on and
   BAC (Oct 14) and ABT (Oct 21) in the cart. Nothing leaves the machine. */
const STAND_IN = `const at = Date.parse(process.env.STUB_NOW);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [at])); }
  static now() { return at; }
};
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const first = u.searchParams.get("offset") !== "500";
  const body = u.pathname === "/rest/v1/alert_prefs" ? (first ? [{ user_id: "u1", days_before: 7 }] : [])
    : u.pathname === "/rest/v1/carts" ? (first ? [{ user_id: "u1", items: [{ t: "BAC" }, { t: "ABT" }] }] : [])
    : u.pathname.startsWith("/auth/v1/admin/users/") ? { email: "reader@example.invalid" }
    : [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
`;

test("the nightly email itself counts on New York's calendar on a UTC runner", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stockornot-alerts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const f of ["scripts/earnings-alerts.mjs", "scripts/dates.mjs", "lib/earnings.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  }
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data", "snapshot.json"), JSON.stringify({ stocks: Object.values(by) }));
  fs.writeFileSync(path.join(root, "stand-in.mjs"), STAND_IN);
  const subject = (now) => {
    const r = spawnSync(process.execPath, ["--import", path.join(root, "stand-in.mjs"), path.join(root, "scripts", "earnings-alerts.mjs")], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", STUB_NOW: now, DRY_RUN: "1", SUPABASE_URL: "http://supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "test" }
    });
    assert.equal(r.status, 0, r.stderr);
    return (r.stdout.match(/^Subject: (.*)$/m) || [])[1] || "";
  };
  assert.equal(subject("2026-10-14T00:55:00Z"), "BAC reports tomorrow");    /* 8:55pm EDT the evening before */
  assert.equal(subject("2026-10-14T04:30:00Z"), "2 companies in your cart report in the next week");   /* 12:30am, before the open */
  assert.equal(subject("2026-10-15T00:50:00Z"), "ABT reports in 7 days");   /* BAC has reported: left out */
});
