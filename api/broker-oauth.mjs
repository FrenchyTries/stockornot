/* ==========================================================================
   /api/broker-oauth — "Connect with Alpaca".

   Visited with ?env=paper|live, it sends the browser to Alpaca to approve the
   connection. Alpaca sends it back here with ?code=…, which is exchanged for
   an access token using the client secret, which is the step that cannot happen
   in a browser. The token is then sealed into the same cookie the key-based
   connection uses, and the visitor lands back on the cart.

   Only offered when ALPACA_CLIENT_ID and ALPACA_CLIENT_SECRET are set. The
   redirect URI to register with Alpaca is <site>/api/broker-oauth.
   ========================================================================== */

import crypto from "node:crypto";
import { query, parseCookies, cookie, clearCookie, redirect, origin } from "./_lib/http.mjs";
import { seal, unseal, secretConfigured } from "./_lib/seal.mjs";
import * as alpaca from "./_lib/alpaca.mjs";

const STATE = "son_broker_state";
const MAX_AGE = 60 * 60 * 24 * 30;

/* Constant-time, and safe on input of any shape: timingSafeEqual throws when
   the two byte lengths differ, which a state of multibyte characters with the
   right character count would otherwise trigger. */
function sameState(given, held) {
  const a = Buffer.from(String(given || "")), b = Buffer.from(String(held || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

const back = (req, outcome) => origin(req) + "/?broker=" + encodeURIComponent(outcome);

export default async function handler(req, res) {
  const q = query(req);
  const redirectUri = origin(req) + "/api/broker-oauth";

  if (!secretConfigured() || !alpaca.oauthConfigured()) return redirect(res, back(req, "unavailable"));

  /* ---- the return leg ---- */
  if (q.has("code") || q.has("error")) {
    const held = unseal(parseCookies(req)[STATE]);
    const clear = clearCookie(STATE);
    if (q.has("error")) return redirect(res, back(req, "declined"), [clear]);

    if (!held || typeof held.state !== "string" || !sameState(q.get("state"), held.state)) {
      return redirect(res, back(req, "expired"), [clear]);
    }

    try {
      const tok = await alpaca.exchangeCode({ code: q.get("code"), redirectUri });
      const conn = { via: "oauth", env: held.env, tok };
      await alpaca.account(conn);                 /* prove it works before keeping it */
      return redirect(res, back(req, "connected"), [
        clear,
        cookie("son_broker", seal(conn, MAX_AGE), { maxAge: MAX_AGE, sameSite: "Strict" })
      ]);
    } catch {
      return redirect(res, back(req, "failed"), [clear]);
    }
  }

  /* ---- the outbound leg ---- */
  const env = q.get("env") === "live" && alpaca.liveAllowed() ? "live" : "paper";
  const state = crypto.randomBytes(18).toString("base64url");
  /* Lax, not Strict: the return trip is a top-level navigation from Alpaca's
     domain, and a Strict cookie would not be sent with it. */
  return redirect(res, alpaca.authorizeUrl({ redirectUri, state, env }), [
    cookie(STATE, seal({ state, env }, 600), { maxAge: 600, sameSite: "Lax" })
  ]);
}
