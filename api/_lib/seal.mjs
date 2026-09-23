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

export function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

export function unseal(token) {
  if (!token || !secretConfigured()) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const out = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    return JSON.parse(out);
  } catch {
    return null;              /* tampered, truncated, or sealed under an old secret */
  }
}
