import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadFundsFile } from "../lib/funds.mjs";

/* The iPhone app: its copy of the site (scripts/build-app.mjs) and the two
   response headers on the website it depends on. */

const ROOT = path.resolve(import.meta.dirname, "..");
const BUILD = path.join(ROOT, "scripts", "build-app.mjs");

const build = (out, env = {}) => spawnSync(process.execPath, [BUILD], {
  cwd: ROOT, encoding: "utf8", env: { ...process.env, CSP: "", ...env, APP_OUT: out }
});

async function listFiles(dir) {
  const all = [];
  const go = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await go(p); else all.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  await go(dir);
  return all;
}

test("the app's copy of the site passes its own checks, with modules as .js and no brokerage code", async (t) => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "stockornot-app-"));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const r = build(out);
  assert.equal(r.status, 0, r.stderr || r.stdout);

  const files = await listFiles(out);
  assert.deepEqual(files.filter((f) => f.endsWith(".mjs")), []);
  for (const f of ["index.html", "app.js", "styles.css", "lib/auth.js", "lib/broker.js", "lib/supabase-config.js",
    "fonts/inter-var.woff2", "data/snapshot.json"]) assert.ok(files.includes(f), f + " is missing");
  assert.ok(files.some((f) => f.startsWith("data/detail/")) && files.some((f) => f.startsWith("data/filings/")));
  /* an allowlist: none of what the website alone needs */
  for (const f of files) {
    assert.ok(!/^(stock\/|pricing|sw\.js|manifest|favicon|apple-touch-icon|og\.png|icons\/|data\/fundamentals|api\/|scripts\/|docs\/)/.test(f), f + " should not be in the app");
  }
  /* the funds go in once the nightly job has written them, and until then an
     empty list stands in for etfs.json, so the app's first read of its own
     copy is never a 404; the job's own working files never go in */
  const own = await fs.readFile(path.join(ROOT, "data", "etfs.json"), "utf8").catch(() => null);
  assert.equal(await fs.readFile(path.join(out, "data", "etfs.json"), "utf8"), own ?? JSON.stringify({ v: 1, etfs: [] }));
  assert.equal(files.includes("data/etf-closes.json"), await fs.stat(path.join(ROOT, "data", "etf-closes.json")).then(() => true, () => false));
  assert.ok(!files.includes("data/lei.json") && !files.includes("data/etf-list.json"));

  /* every module path names the .js copy, and nothing names an .mjs */
  for (const f of files.filter((x) => x.endsWith(".js"))) {
    const src = await fs.readFile(path.join(out, f), "utf8");
    assert.doesNotMatch(src, /(["'])\.{1,2}\/[^"']+\.mjs\1/, f);
  }
  const app = await fs.readFile(path.join(out, "app.js"), "utf8");
  assert.match(app, /from "\.\/lib\/auth\.js"/);
  assert.match(await fs.readFile(path.join(out, "lib", "auth.js"), "utf8"), /"\.\/vendor\/supabase-js-[\d.]+\.js"/);

  const broker = await fs.readFile(path.join(out, "lib", "broker.js"), "utf8");
  assert.equal(broker, await fs.readFile(path.join(ROOT, "mobile", "broker-stub.js"), "utf8"));
  assert.doesNotMatch(broker, /fetch\s*\(/);

  const html = await fs.readFile(path.join(out, "index.html"), "utf8");
  assert.match(html, /<html\b[^>]*\sdata-app[\s>]/);
  assert.doesNotMatch(html, /rel="manifest"|apple-touch-icon|apple-mobile-web-app/);
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, "no Content-Security-Policy <meta>");
  /* the website's policy, with the app's origin beside 'self' and the site
     added where data is fetched from; frame-ancestors does nothing in a meta */
  const vercel = JSON.parse(await fs.readFile(path.join(ROOT, "vercel.json"), "utf8"));
  const site = vercel.headers.find((h) => h.source === "/(.*)").headers.find((h) => h.key === "Content-Security-Policy").value;
  const got = new Map(csp[1].split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.ok(!got.has("frame-ancestors"));
  for (const d of site.split(";").map((x) => x.trim()).filter(Boolean)) {
    const [k, ...v] = d.split(/\s+/);
    if (k === "frame-ancestors") continue;
    for (const s of v) assert.ok(got.get(k)?.includes(s), `${k} lost ${s}`);
    if (v.includes("'self'")) assert.ok(got.get(k).includes("capacitor://localhost"), k);
  }
  assert.ok(got.get("connect-src").includes("https://stockornot.com"));
});

/* An app build that went to App Review without funds must never show them
   later, when the nightly job starts writing data/etfs.json on the website:
   the app asks the website only when its own copy has funds to show. */
test("the app shows funds only when the copy built into it has them", async () => {
  const fund = (t) => ({ t, kind: "etf", nport: { period: "2026-06-30" }, hold: [["AAPL", 100]], reading: "full" });
  const file = (etfs) => ({ ok: true, status: 200, json: async () => ({ v: 1, etfs }) });
  const missing = { ok: false, status: 404, json: async () => ({}) };
  const live = file([fund("VOO"), fund("IVV"), fund("SPY")]);
  const load = async (opts) => {
    const asked = [];
    const got = await loadFundsFile({
      inApp: opts.inApp,
      live: async () => { asked.push("live"); if (opts.live instanceof Error) throw opts.live; return opts.live; },
      bundled: async () => { asked.push("bundled"); if (opts.bundled instanceof Error) throw opts.bundled; return opts.bundled; }
    });
    return { etfs: got ? got.etfs.map((f) => f.t) : null, asked };
  };

  /* built without funds, or with too few to show: never the website's */
  for (const bundled of [missing, file([]), file([fund("VOO")]), file([{ t: "VOO", kind: "etf", nport: null, hold: [] }, fund("IVV")]), new Error("offline")]) {
    assert.deepEqual(await load({ inApp: true, bundled, live }), { etfs: null, asked: ["bundled"] });
  }
  /* built with funds: tonight's from the website, or its own when that fails */
  const own = file([fund("VOO"), fund("IVV")]);
  assert.deepEqual(await load({ inApp: true, bundled: own, live }), { etfs: ["VOO", "IVV", "SPY"], asked: ["bundled", "live"] });
  assert.deepEqual((await load({ inApp: true, bundled: own, live: new Error("offline") })).etfs, ["VOO", "IVV"]);
  assert.deepEqual((await load({ inApp: true, bundled: own, live: { ok: true, json: async () => { throw new SyntaxError("cut short"); } } })).etfs, ["VOO", "IVV"]);
  /* the website: its own file, as before */
  assert.deepEqual(await load({ inApp: false, bundled: missing, live }), { etfs: ["VOO", "IVV", "SPY"], asked: ["live"] });
  assert.deepEqual(await load({ inApp: false, bundled: missing, live: missing }), { etfs: null, asked: ["live"] });

  /* and app.js reads the funds through it, telling it whether it is the app */
  const app = await fs.readFile(path.join(ROOT, "app.js"), "utf8");
  assert.match(app, /funds\.loadFundsFile\(\{\s*inApp: native\.inApp,/);
});

test("the app build will not empty a folder that is not an earlier build", async (t) => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "stockornot-app-"));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  await fs.writeFile(path.join(out, "notes.txt"), "keep me");
  const r = build(out);
  assert.notEqual(r.status, 0);
  assert.equal(await fs.readFile(path.join(out, "notes.txt"), "utf8"), "keep me");
});

/* The app runs at capacitor://localhost and reads the live data and news
   from stockornot.com, which the browser allows only with this header. It
   must be on exactly those two paths, once (two values would be refused),
   and never on the brokerage: api/_lib/http.mjs fromOwnPage relies on no
   other origin being let in there. */
test("vercel.json lets the app read data and news, and nothing else", async () => {
  const vercel = JSON.parse(await fs.readFile(path.join(ROOT, "vercel.json"), "utf8"));
  /* Vercel's "(.*)" wildcard, read the way scripts/dev-server.mjs reads it */
  const rules = vercel.headers.map((r) => ({
    re: new RegExp("^" + r.source.split("(.*)").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.*)") + "$"),
    headers: r.headers
  }));
  const headersFor = (p) => rules.filter((r) => r.re.test(p)).flatMap((r) => r.headers);
  const cors = (p) => headersFor(p).filter((h) => /^access-control-/i.test(h.key));

  for (const p of ["/data/snapshot.json", "/data/track.json", "/data/detail/AAPL.json", "/data/filings/BRK.B.json", "/api/news"]) {
    assert.deepEqual(cors(p).map((h) => [h.key, h.value]), [["Access-Control-Allow-Origin", "capacitor://localhost"]], p);
  }
  for (const p of ["/api/broker", "/api/broker-oauth", "/", "/index.html", "/app.js", "/terms", "/stock/aapl"]) {
    assert.deepEqual(cors(p), [], p);
  }
  const all = vercel.headers.flatMap((r) => r.headers).filter((h) => /^access-control-/i.test(h.key));
  assert.equal(all.length, 2);
});

/* ------------------------------------------------------- app.js itself

   app.js is a page script, not a module: these take single functions (and
   `var` lines) out of it and run them in a context of their own, with what
   they touch stubbed. */
const APP = readFileSync(path.join(ROOT, "app.js"), "utf8");
function appCode(...names) {
  return names.map((n) => {
    const m = APP.match(new RegExp("^function " + n + "\\([^]*?\\n\\}\\n", "m")) || APP.match(new RegExp("^var " + n + " = [^\\n]*\\n", "m"));
    assert.ok(m, n + " is not in app.js");
    return m[0];
  }).join("\n");
}

/* The phone's reminders and the data they were built from, as the app keeps
   them: an offline launch, with only the copy in the app to go on, must
   still schedule when nothing was scheduled before, and must never replace
   a list built from newer data. */
test("reminders switched on offline are scheduled from the copy in the app, and never replace newer ones", async () => {
  const OLD = "2026-10-01T00:30:00Z", NEW = "2026-10-13T00:30:00Z";
  const setUp = ({ fromApp, stamp, updated }) => {
    const store = new Map(stamp ? [["ts.notifyData", stamp]] : []);
    const ctx = vm.createContext({
      lists: [], wanted: true, Promise,
      state: { all: [{ t: "AAPL" }], cart: [{ t: "AAPL" }], byTicker: {}, updated, snapshotFromApp: fromApp },
      earn: { reminders: () => [{ id: 20261015 }] },
      localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
      setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {},
      /* the Earnings sheet's switch and its note */
      $: (sel) => ctx.els[sel] || (ctx.els[sel] = { disabled: false, checked: false, textContent: "" }), els: {}
    });
    ctx.native = {
      canNotify: () => true, notifyWanted: () => ctx.wanted, setNotifyWanted: (on) => { ctx.wanted = on; },
      askNotify: () => Promise.resolve("granted"),
      reschedule: (list) => { ctx.lists.push(Array.from(list, (n) => n.id)); return Promise.resolve(true); }
    };
    vm.runInContext(appCode("reminderTimer", "NOTIFY_ON", "NOTIFY_DENIED", "NOTIFY_DATA", "scheduleReminders", "setLocalNotify"), ctx);
    const settle = () => new Promise((ok) => setImmediate(ok));
    return { ctx, store, settle, run: async () => { ctx.scheduleReminders(); await settle(); return { lists: ctx.lists.length, stamp: store.get("ts.notifyData") ?? null }; } };
  };
  const run = (o) => setUp(o).run();

  /* the copy in the app, nothing scheduled before: built from it */
  assert.deepEqual(await run({ fromApp: true, stamp: null, updated: OLD }), { lists: 1, stamp: OLD });
  /* the copy in the app, a list from the same or newer data: left alone */
  assert.deepEqual(await run({ fromApp: true, stamp: OLD, updated: OLD }), { lists: 0, stamp: OLD });
  assert.deepEqual(await run({ fromApp: true, stamp: NEW, updated: OLD }), { lists: 0, stamp: NEW });
  /* the copy in the app newer than the list (a new version of the app): replaces it */
  assert.deepEqual(await run({ fromApp: true, stamp: OLD, updated: NEW }), { lists: 1, stamp: NEW });
  /* the site's data replaces any list but one built from newer data */
  assert.deepEqual(await run({ fromApp: false, stamp: null, updated: NEW }), { lists: 1, stamp: NEW });
  assert.deepEqual(await run({ fromApp: false, stamp: NEW, updated: NEW }), { lists: 1, stamp: NEW });
  assert.deepEqual(await run({ fromApp: false, stamp: NEW, updated: OLD }), { lists: 0, stamp: NEW });

  /* off and on again, still offline: everything cancelled, then scheduled again from the copy */
  const t = setUp({ fromApp: true, stamp: OLD, updated: OLD });
  t.ctx.setLocalNotify(false);
  await t.settle();
  assert.deepEqual([t.ctx.lists.map((l) => l.length), t.store.has("ts.notifyData")], [[0], false]);
  t.ctx.setLocalNotify(true);
  await t.settle(); await t.settle();
  assert.deepEqual(t.ctx.lists, [[], [20261015]]);
  assert.equal(t.store.get("ts.notifyData"), OLD);
  assert.equal(t.ctx.els["#earnLocalNote"].textContent, t.ctx.NOTIFY_ON);
});

/* A code copied from the email can come with spaces round it, or split by a
   space or a dash. Nothing in the page may refuse it before app.js keeps the
   digits: no pattern, and room for the separators. */
test("the code field takes a pasted code with spaces or dashes in it", () => {
  const html = readFileSync(path.join(ROOT, "index.html"), "utf8");
  const form = html.match(/<form\b[^>]*\bid="authCodeStep"[^>]*>([^]*?)<\/form>/);
  assert.ok(form, "no #authCodeStep form");
  const input = form[1].match(/<input\b[^>]*\bid="authCode"[^>]*>/);
  assert.ok(input, "no #authCode field");
  const attr = (n) => (input[0].match(new RegExp("\\s" + n + "=\"([^\"]*)\"")) || [])[1];
  const checked = !/\bnovalidate\b/.test(form[0]);
  if (checked) {
    assert.equal(attr("pattern"), undefined, "a pattern refuses a code with a space in it");
    assert.doesNotMatch(input[0], /\srequired\b/);
  }
  assert.equal(attr("inputmode"), "numeric");
  for (const pasted of [" 123456 ", "123 456", "123-456", "1234-5678-90"]) {
    assert.ok(pasted.length <= Number(attr("maxlength")), JSON.stringify(pasted) + " is cut short");
  }
  /* and the submit keeps the digits, six to ten of them */
  assert.match(APP, /var code = \$\("#authCode"\)\.value\.replace\(\/\\D\/g, ""\);\s*\/\*[^*]*\*\/\s*if \(!\/\^\\d\{6,10\}\$\/\.test\(code\)\)/);
});

/* privacy.html says the note that a sign-in link was asked for goes once you
   are signed in. Every way of signing in on the page forgets it. */
test("each sign-in on the page forgets the note that a link was asked for", () => {
  for (const call of ["auth.verifyCode(pending, code)", "auth.signInForReview(pending, pass)"]) {
    const at = APP.indexOf(call + ".then(function (r) {");
    assert.ok(at > 0, call + " is not in app.js");
    const body = APP.slice(at, APP.indexOf("\n    });", at));
    assert.match(body, /if \(!r\.ok\) return authError\(r\.error\);[^]*\n\s*auth\.forgetAsked\(\);/, call);
  }
});

/* App Review's check 3 (docs/APP_STORE.md): nothing reads as unfinished. */
test("the cart's account line never says \"yet\"", () => {
  const said = [];
  const ctx = vm.createContext({
    state: { user: null, cartOwner: null },
    $: () => ({ hidden: false, set textContent(v) { said.push(v); }, classList: { toggle() {} } })
  });
  vm.runInContext(appCode("setSyncNote"), ctx);
  ctx.state.user = { id: "u1" };
  ctx.state.cartOwner = "someone else";
  ctx.setSyncNote();
  ctx.state.cartOwner = "u1";
  for (const status of ["saving", "saved", "offline"]) ctx.setSyncNote(status);
  assert.equal(said.length, 4);
  assert.deepEqual(new Set(said).size, 4);
  for (const s of said) assert.doesNotMatch(s, /\byet\b/i, s);
});

/* ...and nor do the site's pages the app opens in its Safari sheet */
test("the pages the app opens never say something is still to come", () => {
  for (const page of ["method.html", "privacy.html", "terms.html", "support.html"]) {
    const text = readFileSync(path.join(ROOT, page), "utf8").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    assert.doesNotMatch(text, /\b(?:not|no \w+) yet\b|\b(?:coming|opening) soon\b/i, page);
  }
});
