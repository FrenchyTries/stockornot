/* ==========================================================================
   Small helpers shared by the serverless functions under api/.

   Written against plain Node req/res so the same handlers run on Vercel and
   under scripts/dev-server.mjs without a framework in between. Files in an
   underscore folder are not deployed as functions of their own.
   ========================================================================== */

export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function redirect(res, location, cookies = []) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  if (cookies.length) res.setHeader("Set-Cookie", cookies);
  res.end();
}

/* Vercel parses the body for us and exposes it as req.body; the local dev
   server does not. Accept either, and never more than 64KB. */
export async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
    try { return JSON.parse(String(req.body)); } catch { return null; }
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 65536) return null;
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

export function query(req) {
  return new URL(req.url, "http://x").searchParams;
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

export function cookie(name, value, { maxAge, path = "/api", sameSite = "Lax" } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

export const clearCookie = (name, path = "/api") => cookie(name, "", { maxAge: 0, path });

export function origin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0] ||
    (req.socket?.encrypted ? "https" : "http");
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

/* Anything that changes state must come from this site's own pages. A custom
   header cannot be attached to a cross-site request without a CORS preflight,
   which these functions never grant, so a forged form post or image tag from
   another origin is turned away before it reaches the brokerage. */
export function fromOwnPage(req) {
  if (req.headers["x-stockornot"] !== "1") return false;
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === (req.headers["x-forwarded-host"] || req.headers.host); }
  catch { return false; }
}
