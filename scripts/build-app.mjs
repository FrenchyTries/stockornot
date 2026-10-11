/* ==========================================================================
   StockOrNot — the iPhone app's copy of the site
   --------------------------------------------------------------------------
   The app carries its interface inside itself and fetches only data from
   stockornot.com (lib/native.mjs). This assembles that interface in
   mobile/www, which `npx cap sync ios` then copies into the Xcode project.
   Like public/, it is build output: rebuilt every time, never committed.

     node scripts/build-app.mjs               # writes mobile/www
     APP_OUT=/tmp/www node scripts/build-app.mjs
     CSP=off node scripts/build-app.mjs       # without the <meta> CSP, to rule it out on a device

   As in build-pages.mjs, the copy is made from a list and nothing else, so a
   file the app does not need (pricing, stock/, the service worker) cannot end
   up in it. On the way it:
   - copies every .mjs as .js and rewrites the imports to match. Capacitor
     serves a bundled file with a type looked up from its extension, and has
     no entry for .mjs; a module served with the wrong type does not run.
   - puts mobile/broker-stub.js in place of lib/broker, so no brokerage code
     can reach the network from the app.
   - marks <html> with data-app, which lib/native.mjs and styles.css read.
   - adds the site's Content-Security-Policy as a <meta> tag. Bundled files
     come with no response headers, so without it the app would have none.
   Then it checks the result, and if anything is wrong it deletes the output
   and stops, so `cap sync` never copies a build that failed.

   No dependencies.
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT  = path.resolve(ROOT, process.env.APP_OUT || "mobile/www");
const CSP_OFF = process.env.CSP === "off";
const STUB = path.join(ROOT, "mobile", "broker-stub.js");

/* The origin Capacitor serves the bundled files from on iPhone, and the site
   the live data comes from. */
const APP_ORIGIN = "capacitor://localhost";
const SITE = "https://stockornot.com";

/* ------------------------------------------------------- what goes in */

const FILES = [
  "index.html", "app.js", "styles.css", "lib/supabase-config.js",
  "fonts/inter-var.woff2", "fonts/Inter-LICENSE.txt",
  "data/snapshot.json"
];
/* copied when they exist: the track record starts on the first nightly run */
const FILES_IF_ANY = ["data/track.json"];
/* What the card and the detail sheet read. Not data/fundamentals: only the
   nightly job reads that. With these the app opens offline, on the data of
   the day it was built. */
const DIRS = ["data/detail", "data/filings"];
/* every .mjs in these is copied as .js */
const MODULE_DIRS = ["lib", "lib/vendor"];

/* A quoted relative module path ending in .mjs: "./lib/auth.mjs" in an
   import, or the LIBRARY string lib/auth.mjs hands to import(). */
const MJS_SPECIFIER = /(["'])(\.{1,2}\/[^"']+)\.mjs\1/g;
const toJs = (src) => src.replace(MJS_SPECIFIER, "$1$2.js$1");

/* ------------------------------------------------------------ utilities */

const rel = (p) => (p.startsWith(ROOT + path.sep) ? path.relative(ROOT, p) : p);
const exists = (p) => fs.stat(p).then(() => true, () => false);

async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out); else out.push(p);
  }
  return out;
}

const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/* The output folder is deleted before every build, so refuse anything that
   could be more than an old build: the repository or a folder above it, a
   folder of the repository other than mobile/, the home folder, or a
   non-empty folder without the index.html and app.js of a build. */
async function checkOutDir() {
  const inside = (parent, p) => { const r = path.relative(parent, p); return !r.startsWith("..") && !path.isAbsolute(r); };
  const refuse = (why) => { throw new Error(`Refusing to build into ${OUT}: ${why}. Set APP_OUT to an empty folder.`); };
  if (inside(OUT, ROOT)) refuse("it holds the repository");
  if (inside(ROOT, OUT) && !inside(path.join(ROOT, "mobile"), OUT)) refuse("inside the repository, it must be under mobile/");
  if (OUT === path.join(ROOT, "mobile")) refuse("that is the app project itself");
  if (inside(OUT, os.homedir())) refuse("it holds the home folder");
  const entries = await fs.readdir(OUT).catch(() => []);
  if (entries.length && !(entries.includes("index.html") && entries.includes("app.js"))) refuse("it is not empty and holds no earlier build");
}

/* ----------------------------------------------- the Content-Security-Policy

   Built from the one vercel.json sends with every page, so the two cannot
   drift apart. frame-ancestors (and the reporting and sandbox directives) do
   nothing in a <meta> tag, so they are left out. 'self' gains the app's own
   origin, spelled out in case WebKit does not count capacitor:// as same
   origin, and connect-src gains the site, where the live data comes from. */
async function appCsp() {
  const vercel = JSON.parse(await fs.readFile(path.join(ROOT, "vercel.json"), "utf8"));
  const rule = (vercel.headers || []).find((r) => r.source === "/(.*)");
  const header = rule && rule.headers.find((h) => h.key.toLowerCase() === "content-security-policy");
  if (!header) throw new Error("vercel.json has no Content-Security-Policy on /(.*) to copy into the app.");
  const directives = header.value.split(";").map((d) => d.trim()).filter(Boolean)
    .filter((d) => !/^(frame-ancestors|report-uri|report-to|sandbox)\b/i.test(d))
    .map((d) => d.replace(/'self'/g, `'self' ${APP_ORIGIN}`));
  const i = directives.findIndex((d) => /^connect-src\b/i.test(d));
  if (i < 0) directives.push(`connect-src 'self' ${APP_ORIGIN} ${SITE}`);
  else if (!directives[i].split(/\s+/).includes(SITE)) {
    const words = directives[i].split(/\s+/);
    const at = words.indexOf(APP_ORIGIN);
    words.splice(at < 0 ? 1 : at + 1, 0, SITE);
    directives[i] = words.join(" ");
  }
  return directives.join("; ");
}

/* ------------------------------------------------------------ index.html */

function appIndex(html, csp) {
  let out = html.replace(/<html\b([^>]*)>/i, (tag, attrs) => (/\sdata-app\b/.test(attrs) ? tag : `<html${attrs} data-app>`));
  /* The icon, touch icon and manifest are for a browser's tab and home
     screen; the app has its own icon, and those files are not in it. */
  out = out.replace(/[ \t]*<link\b[^>]*\brel="(?:icon|shortcut icon|apple-touch-icon|manifest)"[^>]*>[ \t]*\r?\n?/gi, "");
  out = out.replace(/[ \t]*<meta\b[^>]*\bname="(?:apple-)?mobile-web-app-[^"]*"[^>]*>[ \t]*\r?\n?/gi, "");
  if (csp) {
    out = out.replace(/<meta\s+charset="utf-8"\s*\/?>/i,
      (tag) => `${tag}\n<meta http-equiv="Content-Security-Policy" content="${attr(csp)}" />`);
  }
  return out;
}

/* ---------------------------------------------------------------- checks */

/* Every check whose failure would ship a broken or unsafe app. Each problem
   is named; the build fails if there is any. */
async function check(csp) {
  const problems = [];
  const files = await walk(OUT);
  const scripts = files.filter((f) => f.endsWith(".js"));

  for (const f of files) if (f.endsWith(".mjs")) problems.push(`${path.relative(OUT, f)} is still .mjs`);

  for (const f of scripts) {
    const src = await fs.readFile(f, "utf8");
    const name = path.relative(OUT, f);
    /* any module path still ending in .mjs, relative or from the root */
    for (const m of src.matchAll(/(["'`])((?:\.{1,2})?\/[^"'`\s]*\.mjs)\1/g)) {
      problems.push(`${name} still names ${m[2]}`);
    }
    /* and every relative .js path it names (imports, the LIBRARY string)
       must be a file in the build */
    for (const m of src.matchAll(/(["'])(\.{1,2}\/[^"'\s]+\.js)\1/g)) {
      if (!(await exists(path.resolve(path.dirname(f), m[2])))) problems.push(`${name} names ${m[2]}, which is not in the build`);
    }
  }

  const stub = await fs.readFile(path.join(OUT, "lib", "broker.js"), "utf8").catch(() => "");
  if (!stub) problems.push("lib/broker.js is missing");
  if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|\bimport\s*\(/.test(stub)) problems.push("lib/broker.js can reach the network: it must be mobile/broker-stub.js");
  /* the stub has to keep up with lib/broker.mjs, or app.js would call a
     function that is not there */
  const names = (src) => new Set([...src.matchAll(/^export\s+(?:async\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  const want = names(await fs.readFile(path.join(ROOT, "lib", "broker.mjs"), "utf8"));
  const have = names(stub);
  for (const n of want) if (!have.has(n)) problems.push(`mobile/broker-stub.js does not export ${n}, which lib/broker.mjs does`);

  const html = await fs.readFile(path.join(OUT, "index.html"), "utf8");
  if (!/<html\b[^>]*\sdata-app\b/i.test(html)) problems.push("index.html: <html> has no data-app");
  const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
  if (csp && (!meta || meta[1] !== attr(csp))) problems.push("index.html: the Content-Security-Policy <meta> is missing");
  if (!csp && meta) problems.push("index.html: CSP=off, yet a Content-Security-Policy <meta> is there");

  /* Everything the page loads must be in the build. Links (<a href>) are not
     checked: lib/native.mjs opens them on the website, in Safari. */
  const local = (u) => u && !/^(#|https:|mailto:|tel:|data:)/i.test(u);
  const inBuild = (u, from) => {
    const clean = decodeURI(u.split(/[?#]/)[0]);
    return exists(clean.startsWith("/") ? path.join(OUT, clean) : path.resolve(from, clean));
  };
  for (const tag of html.matchAll(/<([a-z]+)\b[^>]*>/gi)) {
    const t = tag[0];
    const refs = [t.match(/\ssrc="([^"]*)"/i)?.[1]];
    if (tag[1].toLowerCase() === "link") refs.push(t.match(/\shref="([^"]*)"/i)?.[1]);
    for (const u of refs) if (local(u) && !(await inBuild(u, OUT))) problems.push(`index.html loads ${u}, which is not in the build`);
  }
  const css = await fs.readFile(path.join(OUT, "styles.css"), "utf8");
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    if (local(m[1]) && !(await inBuild(m[1], OUT))) problems.push(`styles.css loads ${m[1]}, which is not in the build`);
  }

  return { problems, files };
}

/* ------------------------------------------------------------------ main */

async function main() {
  await checkOutDir();
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  for (const f of FILES) {
    await fs.mkdir(path.dirname(path.join(OUT, f)), { recursive: true });
    await fs.copyFile(path.join(ROOT, f), path.join(OUT, f));
  }
  for (const f of FILES_IF_ANY) {
    try { await fs.copyFile(path.join(ROOT, f), path.join(OUT, f)); }
    catch (err) { if (err.code !== "ENOENT") throw err; }
  }
  for (const d of DIRS) await fs.cp(path.join(ROOT, d), path.join(OUT, d), { recursive: true });

  for (const d of MODULE_DIRS) {
    await fs.mkdir(path.join(OUT, d), { recursive: true });
    for (const e of await fs.readdir(path.join(ROOT, d), { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".mjs")) continue;
      const src = await fs.readFile(path.join(ROOT, d, e.name), "utf8");
      await fs.writeFile(path.join(OUT, d, e.name.replace(/\.mjs$/, ".js")), toJs(src));
    }
  }
  const appJs = path.join(OUT, "app.js");
  await fs.writeFile(appJs, toJs(await fs.readFile(appJs, "utf8")));

  await fs.copyFile(STUB, path.join(OUT, "lib", "broker.js"));

  const csp = CSP_OFF ? "" : await appCsp();
  const index = path.join(OUT, "index.html");
  await fs.writeFile(index, appIndex(await fs.readFile(index, "utf8"), csp));

  const { problems, files } = await check(csp);
  if (problems.length) {
    await fs.rm(OUT, { recursive: true, force: true });
    console.error(`The app build failed its checks, so ${rel(OUT)} was removed:`);
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }

  let bytes = 0;
  for (const f of files) bytes += (await fs.stat(f)).size;
  console.log(`Built the app's copy of the site in ${rel(OUT)}: ${files.length} files, ` +
    `${(bytes / 1048576).toFixed(1)} MB${CSP_OFF ? ", without the <meta> CSP (CSP=off)" : ""}.`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
