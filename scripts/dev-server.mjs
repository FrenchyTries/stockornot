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

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
  ".ics": "text/calendar; charset=utf-8"
};

async function serveFile(res, file) {
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
    return true;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let p = decodeURIComponent(url.pathname);

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
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

  if (await serveFile(res, file)) return;
  if (!path.extname(file) && await serveFile(res, file + ".html")) return;   /* cleanUrls */
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`StockOrNot on http://localhost:${PORT}`);
  if (!process.env.BROKER_SECRET) console.log("  BROKER_SECRET is not set, so the brokerage connection will say it is not configured.");
  if (!process.env.FINNHUB_TOKEN) console.log("  FINNHUB_TOKEN is not set, so the news panel will stay empty.");
});
