import test from "node:test";
import assert from "node:assert/strict";
import * as web from "../lib/native.mjs";

/* lib/native.mjs reads `document` and `Capacitor` once, when it loads. Each
   situation below gets its own copy of the module (a different query string
   is a different module) loaded under the globals that situation has: Node
   as it is, the website, the app build opened in a browser, and the app on
   a phone with its plugins. */
async function load(tag, globals) {
  const saved = {};
  for (const [k, v] of Object.entries(globals)) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); globalThis[k] = v; }
  try { return await import("../lib/native.mjs?" + tag); }
  finally {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
}

/* Just enough of a document: the <html> flag, listeners, and links. */
function fakeDocument({ app = false } = {}) {
  const listeners = {};
  const made = [];
  return {
    listeners, made,
    documentElement: { hasAttribute: (n) => app && n === "data-app" },
    addEventListener: (type, fn, capture) => { (listeners[type] = listeners[type] || []).push({ fn, capture }); },
    createElement: (tag) => {
      const el = { tag, clicked: 0, removed: false, click() { this.clicked++; }, remove() { this.removed = true; } };
      made.push(el);
      return el;
    },
    body: { appendChild() {} }
  };
}

/* A plugin whose methods record their calls and answer with `answers[name]`
   (a value, or a function of the argument). */
function fakePlugin(log, plugin, answers = {}) {
  return new Proxy({}, {
    get: (_, method) => (...args) => {
      log.push([plugin + "." + String(method), args[0]]);
      const a = answers[method];
      return typeof a === "function" ? a(...args) : Promise.resolve(a);
    }
  });
}

/* A link as the click listener sees it. */
function link(href, attrs = {}) {
  const a = { getAttribute: (n) => (n === "href" ? href : attrs[n] ?? null), hasAttribute: (n) => n in attrs };
  return { closest: (sel) => (sel === "a[href]" ? a : null) };
}
function click(doc, target) {
  const ev = { target, prevented: false, preventDefault() { this.prevented = true; } };
  for (const l of doc.listeners.click || []) l.fn(ev);
  return ev.prevented;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/* ------------------------------------------------------------------ Node */

test("imports in Node with nothing to talk to", () => {
  assert.equal(web.inApp, false);
  assert.equal(web.SITE, "https://stockornot.com");
  assert.equal(web.apiUrl("/api/news?t=AAPL"), "/api/news?t=AAPL");
  assert.equal(web.canShare, false);
  assert.equal(web.canNotify(), false);
  assert.deepEqual(Object.keys(web).sort(), [
    "SITE", "apiUrl", "askNotify", "cameFromApp", "canNotify", "canShare", "dataFetch", "dragEnd", "dragStart",
    "inApp", "notifyPermission", "notifyWanted", "onNotificationTap", "onResume", "openUrl",
    "prune", "reschedule", "routeLinks", "saveFile", "setNotifyWanted", "share", "tap", "tick"
  ]);
});

test("the website fetches data from its root, whatever address the page is at", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (...args) => { calls.push(args); return json({ ok: 1 }); });
  const init = { cache: "no-cache" };
  const r = await web.dataFetch("data/snapshot.json", init);
  assert.deepEqual(await r.json(), { ok: 1 });
  assert.equal(calls.length, 1);
  /* not "data/…": offline, the home-screen copy shows the deck at /stock/aapl too */
  assert.equal(calls[0][0], "/data/snapshot.json");
  assert.equal(calls[0][1], init);
  await web.dataFetch("./data/etfs.json");
  assert.equal(calls[1][0], "/data/etfs.json");
});

test("without plugins, every native feature does nothing and says so", async () => {
  assert.equal(web.tap(true), undefined);
  web.dragStart(); web.tick(); web.dragEnd();
  assert.equal(await web.share({ title: "x", url: "https://stockornot.com/" }), "failed");
  assert.equal(await web.saveFile("a.csv", "text/csv", "a,b"), "failed");
  assert.equal(await web.notifyPermission(), "denied");
  assert.equal(await web.askNotify(), "denied");
  assert.equal(await web.reschedule([{ id: 1, at: new Date(Date.now() + 864e5), title: "t", body: "b" }]), false);
  web.onNotificationTap(() => assert.fail("no plugin, no taps"));
  web.onResume(() => {});
  web.routeLinks();
  assert.equal(web.notifyWanted(), false);
  web.setNotifyWanted(true);                    /* no localStorage in Node: ignored */
});

/* --------------------------------------------------------------- website */

test("on the website a file still downloads through a link", async () => {
  const doc = fakeDocument();
  const m = await load("website", { document: doc });
  assert.equal(m.inApp, false);
  const urls = [];
  const restore = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = (blob) => { urls.push(blob); return "blob:test/1"; };
  URL.revokeObjectURL = () => {};
  try {
    assert.equal(await m.saveFile("stockornot-cart.csv", "text/csv;charset=utf-8", "\ufeffa,b"), "downloaded");
  } finally { URL.createObjectURL = restore.create; URL.revokeObjectURL = restore.revoke; }
  const a = doc.made[0];
  assert.equal(a.href, "blob:test/1");
  assert.equal(a.download, "stockornot-cart.csv");
  assert.equal(a.clicked, 1);
  assert.equal(a.removed, true);
  assert.equal(urls[0].type, "text/csv;charset=utf-8");
  assert.deepEqual([...new Uint8Array(await urls[0].arrayBuffer())], [0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62], "the byte-order mark survives");
  m.routeLinks();
  assert.equal(doc.listeners.click, undefined, "links are left to the browser");
});

/* ----------------------------------------------- the app build, no plugins */

const app = await load("app", { document: fakeDocument({ app: true }) });

test("the app asks the website for data, then falls back to its own copy", async (t) => {
  assert.equal(app.inApp, true);
  assert.equal(app.apiUrl("/api/news?t=KO"), "https://stockornot.com/api/news?t=KO");

  const calls = [];
  let site = () => json({ from: "site" });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push([url, init]);
    return String(url).startsWith("https://") ? site() : json({ from: "bundle" });
  });

  const live = await app.dataFetch("data/snapshot.json", { cache: "no-cache" });
  assert.deepEqual(await live.json(), { from: "site" });
  assert.equal(app.cameFromApp("data/snapshot.json"), false);
  assert.equal(calls[0][0], "https://stockornot.com/data/snapshot.json");
  assert.equal(calls[0][1].cache, undefined, "the default cache mode, so no preflight");
  assert.ok(calls[0][1].signal, "with a deadline");

  site = () => { throw new TypeError("Load failed"); };
  calls.length = 0;
  const offline = await app.dataFetch("data/detail/AAPL.json", { cache: "no-cache" });
  assert.deepEqual(await offline.json(), { from: "bundle" });
  assert.deepEqual(calls[1], ["/data/detail/AAPL.json", { cache: "no-cache" }]);
  assert.equal(app.cameFromApp("data/detail/AAPL.json"), true, "remembered as the copy in the app");
  site = () => json({ from: "site" });
  await app.dataFetch("data/detail/AAPL.json");
  assert.equal(app.cameFromApp("data/detail/AAPL.json"), false, "until the site answers again");
  site = () => { throw new TypeError("Load failed"); };

  site = () => json({ error: "nope" }, 500);
  const refused = await app.dataFetch("data/track.json");
  assert.deepEqual(await refused.json(), { from: "bundle" });
});

test("when neither has the file, the site's own answer comes back", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).startsWith("https://")) return json({}, 404);
    throw new TypeError("not in the app");
  });
  const r = await app.dataFetch("data/track.json");
  assert.equal(r.status, 404);
});

test("a site that is too slow, even halfway through the body, gives way to the copy in the app", async (t) => {
  /* the deadline's timer, caught rather than waited for */
  const timers = [];
  t.mock.method(globalThis, "setTimeout", (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  const stalled = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{\"par")); } }), { status: 200 });
  for (const site of [() => new Promise(() => {}), async () => stalled()]) {
    t.mock.method(globalThis, "fetch", async (url) => (String(url).startsWith("https://") ? site() : json({ from: "bundle" })));
    timers.length = 0;
    const pending = app.dataFetch("data/snapshot.json");
    await new Promise((r) => setImmediate(r));
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 6000);
    timers[0].fn();
    assert.deepEqual(await (await pending).json(), { from: "bundle" });
  }
});

test("the app build in a browser has no plugins, and nothing breaks", async () => {
  assert.equal(app.canNotify(), false);
  assert.equal(await app.share({ text: "x" }), "failed");
  app.tap(false);
});

/* ------------------------------------------------- the app on the phone */

const log = [];
const heard = {};
const answers = {
  Share: { share: { activityType: "com.apple.UIKit.activity.Mail" } },
  Filesystem: { writeFile: (o) => Promise.resolve({ uri: "file:///cache/" + o.path }) },
  LocalNotifications: {
    getPending: { notifications: [{ id: 20261013 }, { id: 1 }] },
    checkPermissions: { display: "prompt" },
    requestPermissions: { display: "granted" },
    /* the bridge's own addListener answers at once, not with a promise */
    addListener: (eventName, fn) => { heard[eventName] = fn; return { remove() {} }; }
  },
  Browser: {},
  Haptics: { impact: () => Promise.reject(new Error("no haptics engine")) }
};
const plugins = Object.fromEntries(Object.keys(answers).map((name) => [name, fakePlugin(log, name, answers[name])]));
const phoneDoc = fakeDocument({ app: true });
const phone = await load("phone", {
  document: phoneDoc,
  Capacitor: { isNativePlatform: () => true, Plugins: plugins }
});
const calls = (prefix) => log.filter(([name]) => name.startsWith(prefix));

test("haptics: a tap for a commit, and a selection that opens and closes around a drag", async () => {
  log.length = 0;
  phone.tap(true); phone.tap(false);
  phone.dragStart(); phone.tick(); phone.dragEnd();
  await new Promise((r) => setImmediate(r));             /* the rejected impact stays quiet */
  assert.deepEqual(calls("Haptics"), [
    ["Haptics.impact", { style: "MEDIUM" }], ["Haptics.impact", { style: "LIGHT" }],
    ["Haptics.selectionStart", undefined], ["Haptics.selectionChanged", undefined], ["Haptics.selectionEnd", undefined]
  ]);
});

test("share: shared, cancelled or failed", async () => {
  assert.equal(phone.canShare, true);
  const o = { title: "KO on StockOrNot", text: "Coca-Cola", url: "https://stockornot.com/stock/ko" };
  assert.equal(await phone.share(o), "shared");
  assert.deepEqual(log.at(-1), ["Share.share", o]);
  answers.Share.share = () => Promise.reject(new Error("Share canceled"));
  assert.equal(await phone.share(o), "cancelled");
  answers.Share.share = () => Promise.reject(new Error("Can't share while sharing is in progress"));
  assert.equal(await phone.share(o), "failed");
  answers.Share.share = () => { throw new Error("bridge gone"); };
  assert.equal(await phone.share(o), "failed");
  answers.Share.share = { activityType: "" };
});

test("saveFile writes to the cache folder, hands the file to the share sheet, then deletes it", async () => {
  log.length = 0;
  assert.equal(await phone.saveFile("stockornot-cart-2026-10-11.csv", "text/csv", "\ufeffa,b"), "shared");
  assert.deepEqual(log, [
    ["Filesystem.writeFile", { path: "stockornot-cart-2026-10-11.csv", data: "\ufeffa,b", directory: "CACHE", encoding: "utf8" }],
    ["Share.share", { title: "stockornot-cart-2026-10-11.csv", files: ["file:///cache/stockornot-cart-2026-10-11.csv"] }],
    ["Filesystem.deleteFile", { path: "stockornot-cart-2026-10-11.csv", directory: "CACHE" }]
  ]);
  /* a cancelled share leaves nothing behind either */
  log.length = 0;
  answers.Share.share = () => Promise.reject(new Error("Share canceled"));
  assert.equal(await phone.saveFile("a.json", "application/json", "{}"), "cancelled");
  assert.deepEqual(log.at(-1), ["Filesystem.deleteFile", { path: "a.json", directory: "CACHE" }]);
  answers.Share.share = {};
  const write = answers.Filesystem.writeFile;
  answers.Filesystem.writeFile = () => Promise.reject(new Error("disk full"));
  assert.equal(await phone.saveFile("a.json", "application/json", "{}"), "failed");
  answers.Filesystem.writeFile = write;
  assert.equal(phoneDoc.made.length, 0, "no download link in the app");
});

test("reschedule clears what is pending and schedules only what is still ahead", async () => {
  log.length = 0;
  const ahead = new Date(Date.now() + 864e5);
  const rows = [
    { id: 20261013, at: ahead, title: "AAPL reports in a week", body: "…" },
    { id: 20261012, at: new Date(Date.now() + 30e3), title: "too soon", body: "" },
    { id: 20261001, at: "2026-10-01T09:00:00", title: "not a Date", body: "" }
  ];
  assert.equal(await phone.reschedule(rows), true);
  assert.deepEqual(calls("LocalNotifications").map(([n]) => n),
    ["LocalNotifications.getPending", "LocalNotifications.cancel", "LocalNotifications.schedule"]);
  assert.deepEqual(log[1][1], { notifications: [{ id: 20261013 }, { id: 1 }] });
  const sent = log[2][1].notifications;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 20261013);
  assert.ok(sent[0].schedule.at instanceof Date, "a real Date, as the plugin requires");
  assert.deepEqual(sent[0].extra, { open: "earnings" });

  /* nothing pending, nothing due: neither cancel nor schedule, which both refuse an empty list */
  log.length = 0;
  answers.LocalNotifications.getPending = { notifications: [] };
  assert.equal(await phone.reschedule([]), true);
  assert.deepEqual(log.map(([n]) => n), ["LocalNotifications.getPending"]);

  answers.LocalNotifications.getPending = () => Promise.reject(new Error("not allowed"));
  assert.equal(await phone.reschedule(rows), false);
});

test("overlapping reschedules run one after the other", async () => {
  log.length = 0;
  let release;
  answers.LocalNotifications.getPending = () => new Promise((r) => { release = () => r({ notifications: [] }); });
  const at = new Date(Date.now() + 864e5);
  const first = phone.reschedule([{ id: 1, at, title: "a", body: "" }]);
  const second = phone.reschedule([{ id: 2, at, title: "b", body: "" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(log.length, 1, "the second waits for the first");
  answers.LocalNotifications.getPending = { notifications: [{ id: 1 }] };
  release();
  await Promise.all([first, second]);
  assert.deepEqual(log.map(([n, a]) => n.split(".")[1] + (a && a.notifications ? ":" + a.notifications.map((x) => x.id) : "")),
    ["getPending", "schedule:1", "getPending", "cancel:1", "schedule:2"]);
});

test("prune cancels only the reminders whose companies have all left the cart", async () => {
  log.length = 0;
  answers.LocalNotifications.getPending = { notifications: [] };
  const at = new Date(Date.now() + 864e5);
  await phone.reschedule([{ id: 20261016, at, t: ["XOM"], title: "XOM reports in a week", body: "" }]);
  assert.deepEqual(log.at(-1)[1].notifications[0].extra, { open: "earnings", t: ["XOM"] }, "the companies go with it");

  log.length = 0;
  answers.LocalNotifications.getPending = { notifications: [
    { id: 20261016, extra: { open: "earnings", t: ["XOM"] } },
    { id: 20261021, extra: { open: "earnings", t: ["MSFT", "XOM"] } },
    { id: 20261101, extra: { open: "earnings" } }
  ] };
  assert.equal(await phone.prune(["MSFT"]), true);
  assert.deepEqual(log.map(([n]) => n), ["LocalNotifications.getPending", "LocalNotifications.cancel"]);
  assert.deepEqual(log[1][1], { notifications: [{ id: 20261016 }] });

  /* nothing gone: no cancel, which refuses an empty list */
  log.length = 0;
  assert.equal(await phone.prune(["MSFT", "XOM"]), true);
  assert.deepEqual(log.map(([n]) => n), ["LocalNotifications.getPending"]);

  answers.LocalNotifications.getPending = () => Promise.reject(new Error("not allowed"));
  assert.equal(await phone.prune([]), false);
  answers.LocalNotifications.getPending = { notifications: [] };
});

test("permission and the person's own choice are kept apart", async () => {
  assert.equal(phone.canNotify(), true);
  assert.equal(await phone.notifyPermission(), "prompt");
  assert.equal(await phone.askNotify(), "granted");

  const store = new Map();
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k)
  } });
  try {
    assert.equal(phone.notifyWanted(), false);
    phone.setNotifyWanted(true);
    assert.equal(phone.notifyWanted(), true);
    assert.equal(store.get("ts.notify"), "1");
    phone.setNotifyWanted(false);
    assert.equal(phone.notifyWanted(), false);
    assert.equal(store.has("ts.notify"), false);
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved); else delete globalThis.localStorage;
  }
});

test("a tapped reminder reaches the page; a dismissed one does not", () => {
  log.length = 0;
  const got = [];
  phone.onNotificationTap((extra) => got.push(extra));
  assert.deepEqual(log[0], ["LocalNotifications.addListener", "localNotificationActionPerformed"]);
  const fire = heard.localNotificationActionPerformed;
  fire({ actionId: "tap", notification: { id: 20261013, extra: { open: "earnings" } } });
  fire({ actionId: "dismiss", notification: { id: 20261013, extra: { open: "earnings" } } });
  fire({ actionId: "tap", notification: { id: 7 } });
  assert.deepEqual(got, [{ open: "earnings" }, null]);
});

test("the app coming back to the front is heard on the document", () => {
  const fn = () => {};
  phone.onResume(fn);
  assert.equal(phoneDoc.listeners.resume[0].fn, fn);
});

test("links leave for a Safari sheet on the website; tabs, anchors and mail stay", () => {
  log.length = 0;
  phone.routeLinks();
  assert.equal(phoneDoc.listeners.click[0].capture, true);

  assert.equal(click(phoneDoc, link("/terms", { target: "_blank" })), true);
  assert.equal(click(phoneDoc, link("https://www.sec.gov/edgar")), true);
  assert.deepEqual(calls("Browser").map(([, a]) => a.url), ["https://stockornot.com/terms", "https://www.sec.gov/edgar"]);
  assert.equal(calls("Browser")[0][1].toolbarColor, "#0b0c0e");

  for (const [href, attrs] of [["#cart", { "data-view": "" }], ["#", {}], ["mailto:hello@stockornot.com", {}],
    ["tel:+15550100", {}], ["blob:capacitor://localhost/1", {}], ["/x.csv", { download: "" }]]) {
    assert.equal(click(phoneDoc, link(href, attrs)), false, href);
  }
  assert.equal(click(phoneDoc, { closest: () => null }), false);
  assert.equal(calls("Browser").length, 2);
});
