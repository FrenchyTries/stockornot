/* ==========================================================================
   StockOrNot — earnings alerts by email
   --------------------------------------------------------------------------
   Runs in the nightly Action straight after the snapshot is published. For
   everyone who switched alerts on, it finds the companies in their saved cart
   that report within their window (seven days unless they chose otherwise),
   drops any already emailed for that report date, and sends one short email
   listing what each is expected to hit.

   "First evening inside the window" rather than "exactly seven days out", so
   a missed run, a date the company moved, or a stock added three days before
   its report still gets its one email instead of none.

   Env:
     SUPABASE_SERVICE_ROLE_KEY  required — repo secret. Reads carts and prefs
                                past row-level security; never in the browser
     RESEND_API_KEY             required to send — repo secret (resend.com)
     ALERT_FROM                 optional — "StockOrNot <alerts@yourdomain>",
                                a sender Resend has verified
     SUPABASE_URL               optional — defaults to lib/supabase-config.js
     SITE_ORIGIN                optional — links in the email
     DRY_RUN=1                  print what would be sent, send nothing

   With no service key the job says so and exits cleanly, so the Action keeps
   passing on forks that have not set any of this up.
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import { upcoming, expectation, track, whenWord, quarterLabel, eps, money } from "../lib/earnings.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");

/* lib/supabase-config.js is an ES module with a .js name, which Node only
   imports under "type": "module". The URL is all that is needed, so read it. */
const CONFIG_URL = await fs.readFile(path.join(ROOT, "lib", "supabase-config.js"), "utf8")
  .then((t) => (t.match(/SUPABASE_URL\s*=\s*"([^"]*)"/) || [])[1] || "")
  .catch(() => "");

const URL_  = (process.env.SUPABASE_URL || CONFIG_URL || "").replace(/\/+$/, "");
const KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND = process.env.RESEND_API_KEY;
const FROM  = process.env.ALERT_FROM || "StockOrNot <alerts@stockornot.com>";
const SITE  = (process.env.SITE_ORIGIN || "https://stockornot.com").replace(/\/+$/, "");
const DRY   = process.env.DRY_RUN === "1";

if (!URL_ || !KEY) {
  console.log("Earnings alerts: SUPABASE_SERVICE_ROLE_KEY is not set, skipping.");
  process.exit(0);
}
if (!RESEND && !DRY) {
  console.log("Earnings alerts: RESEND_API_KEY is not set, skipping. (DRY_RUN=1 previews without it.)");
  process.exit(0);
}

/* ------------------------------------------------------------- supabase */

const admin = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function rest(pathAndQuery, init = {}) {
  const res = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: { ...admin, Accept: "application/json", ...(init.headers || {}) }
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${pathAndQuery.split("?")[0]}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 || res.headers.get("content-length") === "0" ? null : res.json().catch(() => null);
}

async function emailOf(userId) {
  const res = await fetch(`${URL_}/auth/v1/admin/users/${userId}`, { headers: admin });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.email || u?.user?.email || null;
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/* ---------------------------------------------------------------- email */

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function dateLong(iso) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

function compose(due, details, days) {
  const subject = due.length === 1
    ? `${due[0].t} reports ${due[0].days <= 1 ? (due[0].days === 0 ? "today" : "tomorrow") : "in " + due[0].days + " days"}` +
      (due[0].epsEst !== null ? `: street expects ${eps(due[0].epsEst)} a share` : "")
    : `${due.length} companies in your cart report ${days <= 7 ? "this week" : "in the next " + days + " days"}`;

  const rows = due.map((u) => {
    const when = [dateLong(u.date), whenWord(u.hour)].filter(Boolean).join(", ");
    const q = quarterLabel(u);
    return { u, when, q, expect: expectation(u), track: track(details[u.t]?.analyst) };
  });

  const text = [
    subject + ".", "",
    ...rows.flatMap((r) => [
      `${r.u.t}  ${r.u.n}${r.q ? "  (" + r.q + ")" : ""}`,
      `  ${r.when}`,
      `  ${r.expect}`,
      ...(r.track ? [`  ${r.track}`] : []),
      `  ${SITE}/stock/${slug(r.u.t)}`, ""
    ]),
    "You are getting this because earnings alerts are on for your StockOrNot cart.",
    `Turn them off under Cart > Earnings dates at ${SITE}.`,
    "Not investment advice."
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,sans-serif;color:#16150f">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:24px 24px 16px;border:1px solid #e4e2dc">
<p style="margin:0 0 4px;font-size:13px;color:#78756a">StockOrNot · earnings alert</p>
<h1 style="margin:0 0 18px;font-size:20px;line-height:1.3">${esc(subject)}</h1>
${rows.map((r) => `<div style="border-top:1px solid #e4e2dc;padding:14px 0">
  <p style="margin:0;font-size:17px"><b>${esc(r.u.t)}</b> <span style="color:#4a483f">${esc(r.u.n)}${r.q ? " · " + esc(r.q) : ""}</span></p>
  <p style="margin:4px 0 0;font-size:14px;color:#4a483f">${esc(r.when)}</p>
  <table role="presentation" style="margin:10px 0 0;border-collapse:collapse;font-size:14px">
    <tr><td style="padding:2px 16px 2px 0;color:#78756a">EPS expected</td><td style="font-weight:600">${esc(eps(r.u.epsEst))}</td></tr>
    <tr><td style="padding:2px 16px 2px 0;color:#78756a">Revenue expected</td><td style="font-weight:600">${esc(money(r.u.revEst))}</td></tr>
  </table>
  ${r.track ? `<p style="margin:8px 0 0;font-size:13px;color:#4a483f">${esc(r.track)}</p>` : ""}
  <p style="margin:10px 0 0;font-size:14px"><a href="${SITE}/?t=${encodeURIComponent(r.u.t)}" style="color:#1a4f8a">Open the card</a></p>
</div>`).join("")}
<p style="margin:14px 0 0;font-size:12px;color:#78756a;border-top:1px solid #e4e2dc;padding-top:12px">
You are getting this because earnings alerts are on for your cart. Turn them off under Cart &rsaquo; Earnings dates at
<a href="${SITE}" style="color:#78756a">${esc(SITE.replace(/^https?:\/\//, ""))}</a>. Not investment advice.</p>
</div></body></html>`;

  return { subject, text, html };
}

async function send(to, mail) {
  if (DRY) {
    console.log(`\n--- would send to ${to} ---\nSubject: ${mail.subject}\n\n${mail.text}\n`);
    return true;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject: mail.subject, html: mail.html, text: mail.text })
  });
  if (!res.ok) { console.warn(`  ! send to user failed: HTTP ${res.status} ${await res.text()}`); return false; }
  return true;
}

/* ----------------------------------------------------------------- main */

async function main() {
  const snap = JSON.parse(await fs.readFile(path.join(DATA, "snapshot.json"), "utf8"));
  const byTicker = Object.fromEntries(snap.stocks.map((s) => [s.t, s]));

  const prefs = await rest("alert_prefs?select=user_id,days_before&email=eq.true");
  if (!prefs?.length) { console.log("Earnings alerts: nobody has them switched on."); return; }

  const ids = prefs.map((p) => p.user_id);
  const carts = new Map(), logged = new Set();
  const today = new Date().toISOString().slice(0, 10);
  for (const part of chunks(ids, 80)) {
    const list = `(${part.join(",")})`;
    for (const c of await rest(`carts?select=user_id,items&user_id=in.${list}`) || []) carts.set(c.user_id, c.items || []);
    for (const l of await rest(`alert_log?select=user_id,ticker,report_date&report_date=gte.${today}&user_id=in.${list}`) || []) {
      logged.add(`${l.user_id}|${l.ticker}|${l.report_date}`);
    }
  }

  const details = {};
  async function detail(t) {
    if (details[t] !== undefined) return details[t];
    try { details[t] = JSON.parse(await fs.readFile(path.join(DATA, "detail", t.replace(/[^A-Z0-9.]/gi, "_") + ".json"), "utf8")); }
    catch { details[t] = null; }
    return details[t];
  }

  let sent = 0, companies = 0, failed = 0;
  for (const p of prefs) {
    const items = carts.get(p.user_id) || [];
    const due = upcoming(items, byTicker, { days: p.days_before || 7 })
      .filter((u) => !logged.has(`${p.user_id}|${u.t}|${u.date}`));
    if (!due.length) continue;

    const to = await emailOf(p.user_id);
    if (!to) { console.warn(`  ! no email address for a user with alerts on`); continue; }
    for (const u of due) await detail(u.t);

    if (await send(to, compose(due, details, p.days_before || 7))) {
      sent++; companies += due.length;
      if (!DRY) {
        await rest("alert_log", {
          method: "POST",
          headers: { "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify(due.map((u) => ({ user_id: p.user_id, ticker: u.t, report_date: u.date })))
        });
      }
    } else failed++;
  }
  console.log(`Earnings alerts: ${sent} email${sent === 1 ? "" : "s"} covering ${companies} report${companies === 1 ? "" : "s"}` +
    (failed ? `, ${failed} failed` : "") + (DRY ? " (dry run, nothing sent)" : "") + ".");
}

main().catch((err) => { console.error("Earnings alerts failed:", err.message); process.exit(1); });
