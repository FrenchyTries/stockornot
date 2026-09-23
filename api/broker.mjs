/* ==========================================================================
   /api/broker — the brokerage connection.

     GET  ?action=status      what is configured, whether this browser is
                              connected, and the account summary if so
     POST ?action=connect     { keyId, secret, env } — check the keys, then
                              keep them sealed in an HttpOnly cookie
     POST ?action=disconnect  forget the connection
     GET  ?action=portfolio   positions and the last 25 orders
     POST ?action=orders      { env, confirmLive, orders: [...] } — place a
                              batch, one by one, under the environment the
                              person reviewed them in and no other
     POST ?action=cancel      { id } — cancel an open order

   Nothing is stored on the server. See api/_lib/seal.mjs for why.
   ========================================================================== */

import { send, readJson, query, parseCookies, cookie, clearCookie, fromOwnPage } from "./_lib/http.mjs";
import { seal, unseal, secretConfigured } from "./_lib/seal.mjs";
import * as alpaca from "./_lib/alpaca.mjs";

const COOKIE = "son_broker";
const MAX_AGE = 60 * 60 * 24 * 30;
const MAX_BATCH = 50;

function connection(req) {
  const c = unseal(parseCookies(req)[COOKIE]);
  if (!c || (c.via !== "keys" && c.via !== "oauth")) return null;
  if (c.env === "live" && !alpaca.liveAllowed()) return null;
  return c;
}

function describe(conn) {
  return {
    configured: secretConfigured(),
    broker: alpaca.NAME,
    oauth: alpaca.oauthConfigured(),
    liveAllowed: alpaca.liveAllowed(),
    maxLiveOrder: alpaca.liveAllowed() ? alpaca.maxLiveOrder() : null,
    connected: Boolean(conn),
    env: conn?.env || null,
    via: conn?.via || null
  };
}

function fail(res, err) {
  const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  send(res, status === 401 ? 401 : status >= 500 ? 502 : status, { error: err?.message || "Something went wrong." });
}

export default async function handler(req, res) {
  const action = query(req).get("action") || "status";

  try {
    const conn = secretConfigured() ? connection(req) : null;

    if (action === "status" && req.method === "GET") {
      const out = describe(conn);
      if (conn) {
        try { out.account = await alpaca.account(conn); }
        catch (err) {
          /* revoked keys or a reset paper account: say so and drop the cookie */
          if (err.status === 401 || err.status === 403) {
            return send(res, 200, { ...describe(null), lost: err.message }, { "Set-Cookie": clearCookie(COOKIE) });
          }
          out.accountError = err.message;
        }
      }
      return send(res, 200, out);
    }

    /* everything below changes something or reads the account */
    if (req.method !== "GET" && !fromOwnPage(req)) return send(res, 403, { error: "Refused." });
    if (!secretConfigured()) {
      return send(res, 503, { error: "The brokerage connection is not set up on this server yet (BROKER_SECRET is missing)." });
    }

    if (action === "connect" && req.method === "POST") {
      const body = await readJson(req);
      const keyId = String(body?.keyId || "").trim();
      const secret = String(body?.secret || "").trim();
      const env = body?.env === "live" ? "live" : "paper";
      if (!/^[A-Za-z0-9]{8,64}$/.test(keyId) || !/^[A-Za-z0-9/+=_-]{16,128}$/.test(secret)) {
        return send(res, 400, { error: "Those do not look like Alpaca API keys. The key ID is about 20 capital letters and digits; the secret is about 40 characters." });
      }
      if (env === "live" && !alpaca.liveAllowed()) {
        return send(res, 403, { error: "Live trading is switched off on this site while it is in development. Use paper keys." });
      }
      const next = { via: "keys", env, k: keyId, s: secret };
      const account = await alpaca.account(next);
      return send(res, 200, { ...describe(next), account },
        { "Set-Cookie": cookie(COOKIE, seal(next, MAX_AGE), { maxAge: MAX_AGE, sameSite: "Strict" }) });
    }

    if (action === "disconnect" && req.method === "POST") {
      return send(res, 200, describe(null), { "Set-Cookie": clearCookie(COOKIE) });
    }

    if (!conn) return send(res, 401, { error: "No brokerage is connected in this browser." });

    if (action === "portfolio" && req.method === "GET") {
      const [positions, orders] = await Promise.all([alpaca.positions(conn), alpaca.orders(conn)]);
      return send(res, 200, { positions, orders });
    }

    if (action === "orders" && req.method === "POST") {
      const body = await readJson(req);
      const list = Array.isArray(body?.orders) ? body.orders : null;
      if (!list || !list.length) return send(res, 400, { error: "No orders to place." });
      if (list.length > MAX_BATCH) return send(res, 400, { error: `At most ${MAX_BATCH} orders at a time.` });

      /* The cookie is shared by every tab. If it now points somewhere other
         than where these orders were reviewed (live connected in another tab
         after this one showed Paper), refuse the lot rather than spend real
         money from a screen that never asked for the real-money confirmation. */
      if (body.env !== "paper" && body.env !== "live") {
        return send(res, 400, { error: "This page is out of date. Reload it and review the orders again." });
      }
      if (body.env !== conn.env) {
        return send(res, 409, { error: `This browser is now connected to ${conn.env === "live" ? "a live" : "a paper"} account. Check the orders again before placing.`, env: conn.env });
      }
      if (conn.env === "live" && body.confirmLive !== true) {
        return send(res, 400, { error: "Live orders need the real-money box ticked." });
      }

      /* Sequential on purpose: the brokerage checks buying power per order,
         and firing them in parallel makes which ones fail a race. */
      const results = [];
      for (const raw of list) {
        const built = alpaca.buildOrder(raw, conn.env);
        const symbol = String(raw?.symbol || "").toUpperCase();
        if (built.error) { results.push({ symbol, ok: false, error: built.error }); continue; }
        try {
          const placed = await alpaca.placeOrder(conn, built.order);
          results.push({ symbol, ok: true, order: placed, duplicate: Boolean(placed.duplicate) });
        } catch (err) {
          results.push({ symbol, ok: false, error: err.message });
          if (err.status === 401) break;
        }
      }
      return send(res, 200, { env: conn.env, results });
    }

    if (action === "cancel" && req.method === "POST") {
      const body = await readJson(req);
      await alpaca.cancelOrder(conn, body?.id);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "Unknown action." });
  } catch (err) {
    return fail(res, err);
  }
}
