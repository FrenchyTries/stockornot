/* ==========================================================================
   The iPhone app's side of the page.

   The app ships this same interface inside it (scripts/build-app.mjs) and
   marks <html> with data-app. Everything that has to behave differently
   there goes through this file, so app.js asks one question ("in the app?")
   and never touches Capacitor itself.

   The native features are Capacitor plugins, reached through the
   window.Capacitor.Plugins object the app injects before any script runs.
   There is no bundler, so nothing here imports @capacitor/core. Every call
   is feature-detected and fails quietly: a missing plugin, a refused
   permission or a native error leaves the page working as it does on the
   website.

   No imports, and nothing at load that needs a browser, so Node can import
   it (the tests do).
   ========================================================================== */

const doc = typeof document !== "undefined" ? document : null;
const Cap = globalThis.Capacitor;

export const SITE = "https://stockornot.com";

/* Set by the app build, so it is true in the app and nowhere else. */
export const inApp = Boolean(doc && doc.documentElement && doc.documentElement.hasAttribute("data-app"));

/* Running inside the native shell, with plugins behind it. The app build can
   also be opened in an ordinary browser to test it; then this is false, the
   plugins are absent and each feature takes its website path. */
const native = Boolean(Cap && typeof Cap.isNativePlatform === "function" && Cap.isNativePlatform());
const P = native ? Cap.Plugins || {} : {};

/* Calls a plugin method. A missing plugin and a synchronous throw both come
   back as a rejected promise, so callers have one failure path. */
async function call(name, method, arg) {
  const plugin = P[name];
  if (!plugin || typeof plugin[method] !== "function") throw new Error(name + "." + method + " is not available");
  return plugin[method](arg);
}
const quietly = (name, method, arg) => call(name, method, arg).catch(() => null);

/* iOS rejects with "Share canceled" when the sheet is dismissed; the web
   share sheet throws an AbortError. Neither is a failure. */
const wasCancelled = (e) => Boolean(e) && (e.name === "AbortError" || /cancel/i.test(String(e.message || e)));

/* ------------------------------------------------------------------- data

   The app holds a copy of data/ from the day it was built, and asks the
   website for today's. The site's answer must arrive in full within a few
   seconds; otherwise, or if it is refused or not OK, the copy in the app
   answers instead, so the app always opens. The site is asked with the
   default cache mode, whatever the caller passed, so the request is beyond
   doubt a simple GET with no preflight; the site's max-age is short anyway. */

const LIVE_MS = 6000;

/* A deadline that works on every WebKit the app supports: AbortSignal.timeout
   is newer than some of them. The race settles it even if the abort is
   ignored. */
function withDeadline(ms, work) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => { if (ctl) ctl.abort(); reject(new Error("timed out")); }, ms);
  });
  return Promise.race([work(ctl ? ctl.signal : undefined), late]).finally(() => clearTimeout(timer));
}

/* The data files whose last answer came from the copy built into the app
   rather than from the site. */
const fromApp = new Set();
export const cameFromApp = (path) => fromApp.has(String(path).replace(/^\.?\//, ""));

/* path: "data/…json". */
export async function dataFetch(path, init) {
  const file = String(path).replace(/^\.?\//, "");
  /* The website asks from its root, whatever address the deck was opened
     at: offline, the home-screen copy answers /stock/aapl with the deck
     (sw.js), where a relative path would ask for /stock/data/… */
  if (!inApp) return fetch("/" + file, init);
  fromApp.delete(file);
  let live = null;
  try {
    live = await withDeadline(LIVE_MS, async (signal) => {
      const r = await fetch(SITE + "/" + file, signal ? { signal } : undefined);
      if (!r.ok) return r;
      /* The whole body inside the deadline. Handing back a response whose body
         is still arriving would let a stalled download fail later, in the
         caller, where the copy in the app can no longer step in. */
      const body = await r.blob();
      return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
    });
    if (live.ok) return live;
  } catch { /* offline, too slow, or refused: the copy in the app */ }
  try {
    const copy = await fetch("/" + file, init);
    if (copy.ok) fromApp.add(file);
    return copy;
  } catch (err) {
    /* Not in the app either (a file newer than the build): the site's own
       answer, a 404 say, tells the caller more than a network error. */
    if (live) return live;
    throw err;
  }
}

/* The site's API, which the app reaches by its full address. */
export const apiUrl = (p) => (inApp ? SITE + p : p);

/* ---------------------------------------------------------------- haptics

   A tap when a card is kept or passed, firmer for Keep. While a card is
   dragged, a tick each time it crosses the line where letting go commits:
   iOS only ticks between selectionStart and selectionEnd, so a drag opens
   and closes the selection. */

const haptic = (method, arg) => { if (P.Haptics) quietly("Haptics", method, arg); };

export const tap = (add) => haptic("impact", { style: add ? "MEDIUM" : "LIGHT" });
export const dragStart = () => haptic("selectionStart");
export const tick = () => haptic("selectionChanged");
export const dragEnd = () => haptic("selectionEnd");

/* ---------------------------------------------------------------- sharing */

export const canShare = Boolean(P.Share) || Boolean(typeof navigator !== "undefined" && navigator.share);

/* o: { title, text, url }. Returns "shared", "cancelled" or "failed". */
export async function share(o) {
  try {
    if (P.Share) await call("Share", "share", o);
    else if (typeof navigator !== "undefined" && navigator.share) await navigator.share(o);
    else return "failed";
    return "shared";
  } catch (e) {
    return wasCancelled(e) ? "cancelled" : "failed";
  }
}

/* A file the person keeps: the cart as CSV, a calendar, their data.

   A download link does nothing inside the app, so there the file is written
   to the app's cache folder and handed to the share sheet, which offers Save
   to Files, Mail and the rest. On the website it downloads as before.
   Returns "shared", "cancelled", "failed" or "downloaded". */
export async function saveFile(name, mime, text) {
  if (P.Filesystem && P.Share) {
    const path = String(name).replace(/[\\/:]/g, "-");
    try {
      const { uri } = await call("Filesystem", "writeFile", {
        path, data: String(text), directory: "CACHE", encoding: "utf8"
      });
      await call("Share", "share", { title: name, files: [uri] });
      return "shared";
    } catch (e) {
      return wasCancelled(e) ? "cancelled" : "failed";
    } finally {
      /* The share sheet has taken its copy by the time it answers. The file
         holds the account's data, so it does not stay behind on the phone. */
      try { await call("Filesystem", "deleteFile", { path, directory: "CACHE" }); } catch { /* never written */ }
    }
  }
  /* inside the app with no plugins, or in Node: there is nowhere for it to go */
  if (native || !doc || typeof URL === "undefined" || !URL.createObjectURL) return "failed";
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = doc.createElement("a");
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return "downloaded";
}

/* ------------------------------------------------------------------ links

   The app's own pages are its tabs. Everything else (the method, terms and
   privacy pages, filings, news) belongs to the web, and opens in a Safari
   sheet over the app. Without this, a link to /terms would point at the
   app's own address, where there is no such page, and iOS hands links that
   leave the app to Safari outright. */

export function openUrl(url) {
  if (P.Browser) return quietly("Browser", "open", { url, toolbarColor: "#0b0c0e" });
  if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
}

/* One listener, in the capture phase so it sees a link before anything
   else does. Tab links, in-page links, mail and phone links and downloads
   are left alone; any other link opens on the website. */
export function routeLinks() {
  if (!inApp || !doc) return;
  doc.addEventListener("click", (ev) => {
    const a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
    if (!a || a.hasAttribute("data-view") || a.hasAttribute("download")) return;
    const raw = a.getAttribute("href");
    if (!raw || raw[0] === "#" || /^(mailto|tel|sms):/i.test(raw)) return;
    let url;
    try { url = new URL(raw, SITE + "/"); } catch { return; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    ev.preventDefault();
    openUrl(url.href);
  }, true);
}

/* ---------------------------------------------------------- notifications

   Earnings reminders, scheduled on the phone itself: no push service, no
   server, nothing sent anywhere. The person's choice is kept here, apart
   from the system permission, so turning the switch off keeps them off even
   though iOS still allows them. */

const NOTIFY_KEY = "ts.notify";
const LN = () => P.LocalNotifications;

export const canNotify = () => Boolean(LN());

export function notifyWanted() {
  try { return localStorage.getItem(NOTIFY_KEY) === "1"; } catch { return false; }
}

export function setNotifyWanted(on) {
  try { on ? localStorage.setItem(NOTIFY_KEY, "1") : localStorage.removeItem(NOTIFY_KEY); } catch { /* storage off */ }
}

/* "granted", "denied" or "prompt" (not asked yet). */
export async function notifyPermission() {
  try { return (await call("LocalNotifications", "checkPermissions")).display || "denied"; } catch { return "denied"; }
}

/* Shows the iOS prompt the first time; after that iOS answers without asking. */
export async function askNotify() {
  try { return (await call("LocalNotifications", "requestPermissions")).display || "denied"; } catch { return "denied"; }
}

/* rows: [{ id, at: Date, t, title, body }] from earnings.reminders().

   Replaces everything pending with these. The app schedules nothing else,
   and starting from empty means a company taken out of the cart, or a date
   that moved, loses its old reminder. `at` must be a real Date: the plugin
   reads it as a date, not a string. A date in the past would be delivered
   at once, so anything not at least a minute away is dropped. iOS keeps at
   most 64 per app.

   Calls run one after another: two overlapping runs could each clear the
   old list and then both schedule, leaving a reminder the newer list had
   removed. Returns true when the phone holds the new list. */
let queue = Promise.resolve();

export function reschedule(rows) {
  const run = () => replacePending(rows);
  queue = queue.then(run, run);
  return queue;
}

async function replacePending(rows) {
  if (!LN()) return false;
  try {
    const pending = await call("LocalNotifications", "getPending");
    const old = (pending && pending.notifications) || [];
    /* the plugin refuses an empty list */
    if (old.length) await call("LocalNotifications", "cancel", { notifications: old.map((n) => ({ id: n.id })) });
    const soon = Date.now() + 60e3;
    const due = (rows || []).filter((r) => r && r.at instanceof Date && r.at.getTime() > soon).slice(0, 60);
    if (due.length) {
      await call("LocalNotifications", "schedule", {
        notifications: due.map((r) => ({ id: r.id, title: r.title, body: r.body, schedule: { at: r.at },
          /* the companies go with it, for prune below */
          extra: r.t ? { open: "earnings", t: r.t } : { open: "earnings" } }))
      });
    }
    return true;
  } catch {
    return false;
  }
}

/* tickers: what is in the cart now. Cancels each pending reminder none of
   whose companies is still there, and leaves every other one as it is,
   dates and all. For a session on data too old to build the list from
   (see app.js scheduleReminders): its dates must not replace newer ones,
   but a company taken out of the cart still loses its reminder. A
   reminder that names no companies is left alone. A day shared with a
   company still in the cart keeps its old title and body, which still name
   the company taken out, until a launch that reaches the site rebuilds the
   list. Queued with reschedule, so the two never overlap. Returns true when
   it ran. */
export function prune(tickers) {
  const run = () => prunePending(tickers);
  queue = queue.then(run, run);
  return queue;
}

async function prunePending(tickers) {
  if (!LN()) return false;
  try {
    const keep = new Set(tickers || []);
    const pending = await call("LocalNotifications", "getPending");
    const gone = ((pending && pending.notifications) || []).filter((n) => {
      const t = n && n.extra && Array.isArray(n.extra.t) ? n.extra.t : [];
      return t.length > 0 && !t.some((x) => keep.has(x));
    });
    /* the plugin refuses an empty list */
    if (gone.length) await call("LocalNotifications", "cancel", { notifications: gone.map((n) => ({ id: n.id })) });
    return true;
  } catch {
    return false;
  }
}

/* fn(extra) when a reminder is tapped. A tap that launched the app is held
   by the plugin until this listener exists. */
export function onNotificationTap(fn) {
  const ln = LN();
  if (!ln || typeof ln.addListener !== "function") return;
  try {
    const handle = ln.addListener("localNotificationActionPerformed", (e) => {
      if (e && e.actionId === "dismiss") return;
      fn((e && e.notification && e.notification.extra) || null);
    });
    /* the plugin answers with a promise; a refusal there must not surface as
       an unhandled rejection */
    if (handle && typeof handle.catch === "function") handle.catch(() => {});
  } catch { /* no reminders to open, then */ }
}

/* The app coming back to the foreground; the native side fires "resume" on
   the document. */
export function onResume(fn) {
  if (native && doc) doc.addEventListener("resume", fn);
}
