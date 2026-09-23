/* ==========================================================================
   Sealed cookies.

   The brokerage credentials are kept in the visitor's own browser rather than
   in a database, so there is nothing on the server to breach. They are
   encrypted with AES-256-GCM under BROKER_SECRET before they leave the
   function, and the cookie is HttpOnly, so the page's JavaScript can never
   read them back: a script injected into the page could at worst ask this
   function to act, not walk off with the keys.
   ========================================================================== */

import crypto from "node:crypto";

export function secretConfigured() {
  return typeof process.env.BROKER_SECRET === "string" && process.env.BROKER_SECRET.length >= 32;
}

function key() {
  return crypto.createHash("sha256").update(String(process.env.BROKER_SECRET)).digest();
}

/* Every sealed value carries its own expiry, checked on the way back in. The
   cookie's Max-Age only asks the browser to forget it; a copy lifted from the
   browser would otherwise keep working until the keys were revoked. */
export function seal(obj, maxAgeSeconds) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const payload = { ...obj, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds };
  const body = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

export function unseal(token) {
  if (!token || !secretConfigured()) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const out = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
    if (!out || typeof out.exp !== "number" || out.exp < Date.now() / 1000) return null;
    return out;
  } catch {
    return null;              /* tampered, truncated, expired, or sealed under an old secret */
  }
}
