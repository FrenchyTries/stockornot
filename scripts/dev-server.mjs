/* ==========================================================================
   Local development server.

   `python3 -m http.server` still works for the deck, but it cannot run the
   functions under api/, so the brokerage connection and the news panel stay
   dark. This serves the same static files the way Vercel does (clean URLs
   included) and hands /api/<name> to api/<name>.mjs, which is all the
   Vercel runtime does too.

     BROKER_SECRET=$(openssl rand -hex 32) node scripts/dev-server.mjs
     # open http://localhost:8080

   Optional env, exactly as on Vercel: FINNHUB_TOKEN, ALPACA_CLIENT_ID,
   ALPACA_CLIENT_SECRET, BROKER_ALLOW_LIVE, BROKER_MAX_ORDER_USD. PORT picks
   the port.
   ========================================================================== */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT) || 8080;

/* The response headers vercel.json declares (the Content-Security-Policy
   among them), applied here too so a page that breaks under them breaks
   locally first. Sources use Vercel's "(.*)" wildcard; later matches win. */
const HEADER_RULES = JSON.parse(await fs.readFile(path.join(ROOT, "vercel.json"), "utf8")).headers || [];
const headerRules = HEADER_RULES.map((r) => ({
  re: new RegExp("^" + r.source.split("(.*)").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.*)") + "$"),
  headers: r.headers
}));
function applyHeaders(res, pathname) {
  for (const r of headerRules) if (r.re.test(pathname)) for (const h of r.headers) res.setHeader(h.key, h.value);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
  ".ics": "text/calendar; charset=utf-8", ".woff2": "font/woff2"
};

async function serveFile(res, file, status = 200) {
  try {
    const body = await fs.readFile(file);
    res.writeHead(status, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
    return true;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  let url, p;
  try {
    url = new URL(req.url, "http://localhost");
    p = decodeURIComponent(url.pathname);
  } catch {
    /* "/%ff" or "//": answer it rather than let the rejection end the process */
    res.writeHead(400); return res.end();
  }
  applyHeaders(res, p);

  if (p.startsWith("/api/")) {
    const name = p.slice(5).replace(/\/+$/, "");
    if (!/^[a-z0-9-]+$/.test(name)) { res.writeHead(404); return res.end(); }
    try {
      const mod = await import(pathToFileURL(path.join(ROOT, "api", name + ".mjs")).href);
      return await mod.default(req, res);
    } catch (err) {
      if (err.code === "ERR_MODULE_NOT_FOUND") { res.writeHead(404); return res.end("no such function"); }
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      return res.end();
    }
  }

  /* never serve the functions' source or anything dotted */
  if (p.split("/").some((seg) => seg.startsWith(".") || seg === "api" || seg === "node_modules")) {
    res.writeHead(404); return res.end();
  }
  /* trailingSlash: false — Vercel redirects /stock/ to /stock */
  if (p.length > 1 && p.endsWith("/")) {
    res.writeHead(308, { Location: p.replace(/\/+$/, "") + url.search });
    return res.end();
  }
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

  if (await serveFile(res, file)) return;
  if (!path.extname(file) && await serveFile(res, file + ".html")) return;               /* cleanUrls */
  if (!path.extname(file) && await serveFile(res, path.join(file, "index.html"))) return; /* directory index */
  if (await serveFile(res, path.join(ROOT, "404.html"), 404)) return;                   /* as Vercel does */
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, async () => {
  console.log(`StockOrNot on http://localhost:${PORT}`);
  /* the company pages are build output, not in git: Vercel builds them on deploy */
  if (!(await fs.stat(path.join(ROOT, "stock", "index.html")).catch(() => null))) {
    console.log("  The company pages are not built yet, so /stock will 404. Run: node scripts/build-pages.mjs");
  }
  if (!process.env.BROKER_SECRET) console.log("  BROKER_SECRET is not set, so the brokerage connection will say it is not configured.");
  if (!process.env.FINNHUB_TOKEN) console.log("  FINNHUB_TOKEN is not set, so the news panel will stay empty.");
});
