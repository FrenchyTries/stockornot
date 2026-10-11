import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

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
