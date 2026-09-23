/* ==========================================================================
   The page's side of the brokerage connection.

   Every call goes to /api/broker on this site, never to the brokerage
   directly: the credentials sit in an HttpOnly cookie the page cannot read,
   and the function attaches them on the way through. On a host with no
   functions (the GitHub Pages mirror, or `python3 -m http.server`) the status
   call 404s and the cart simply says brokerage connections are not available
   here.
   ========================================================================== */

const BASE = "/api/broker";

async function call(action, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(BASE + "?action=" + action, {
      method,
      credentials: "same-origin",
      headers: body || method !== "GET"
        ? { "Content-Type": "application/json", "X-StockOrNot": "1" }
        : { "X-StockOrNot": "1" },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    return { ok: false, status: 0, error: "Could not reach the server." };
  }
  if (res.status === 404 && action === "status") return { ok: false, status: 404, unavailable: true };
  let json = null;
  try { json = await res.json(); } catch { /* an HTML error page */ }
  if (!res.ok) return { ok: false, status: res.status, error: json?.error || "Request failed (" + res.status + ")." };
  return { ok: true, status: res.status, data: json };
}

export const status     = () => call("status");
export const connect    = (keyId, secret, env) => call("connect", { method: "POST", body: { keyId, secret, env } });
export const disconnect = () => call("disconnect", { method: "POST", body: {} });
export const portfolio  = () => call("portfolio");
/* env is the environment the orders were reviewed under; the server refuses
   the batch if the connection has since changed. */
export const place      = (orders, env, confirmLive) =>
  call("orders", { method: "POST", body: { env, confirmLive: Boolean(confirmLive), orders } });
export const cancel     = (id) => call("cancel", { method: "POST", body: { id } });

export function oauthUrl(env) {
  return "/api/broker-oauth?env=" + encodeURIComponent(env === "live" ? "live" : "paper");
}

/* The brokerage refuses a second order with an id it has already seen. The
   page keeps one id per cart row and planned order (see orderKey in app.js),
   so pressing Place again, reopening the review, or retrying after an answer
   that never arrived all resend the same id and cannot buy twice. */
export function clientId(symbol) {
  const rand = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now())
    .replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
  return ("son_" + symbol.replace(/[^A-Za-z0-9]/g, "") + "_" + rand).slice(0, 48);
}

/* What a stored amount turns into, before anything is sent. Market orders go
   in dollars and may buy a fraction of a share; limit orders buy whole shares
   at or below the limit, so the dollar figure is a ceiling rather than exact.
   The same limits the server applies are applied here, so a row the server
   would refuse is shown as refused before anything is placed. */
export const MIN_NOTIONAL = 1;

export function planOrder(item, { type, limitPrice, price, env, maxLive }) {
  const amount = Number(item.amount);
  if (!(amount > 0)) return null;
  let plan;
  if (type === "limit") {
    const raw = Number(limitPrice) > 0 ? Number(limitPrice) : Number(price);
    if (!(raw > 0)) return { symbol: item.t, type, error: "No price to set a limit from." };
    /* Rounded down to what the brokerage accepts before anything is sized
       from it, so the order sent can never cost more than "up to" says. */
    const places = raw >= 1 ? 2 : 4;
    const lim = Math.floor(raw * 10 ** places + 1e-9) / 10 ** places;
    if (!(lim > 0)) return { symbol: item.t, type, error: "That limit is too small to place." };
    const qty = Math.floor(amount / lim);
    if (qty < 1) return { symbol: item.t, type, limitPrice: lim, error: "$" + amount.toFixed(2) + " does not cover one share at $" + lim.toFixed(places) + "." };
    plan = { symbol: item.t, side: "buy", type: "limit", qty, limitPrice: lim, cost: qty * lim, tif: "day" };
  } else {
    if (amount < MIN_NOTIONAL) return { symbol: item.t, type: "market", error: "Dollar orders start at $" + MIN_NOTIONAL + "." };
    plan = {
      symbol: item.t, side: "buy", type: "market", notional: +amount.toFixed(2), cost: +amount.toFixed(2),
      estShares: Number(price) > 0 ? amount / Number(price) : null
    };
  }
  if (env === "live" && maxLive !== undefined && maxLive !== null) {
    if (!(maxLive > 0)) return { ...plan, error: "Live orders are switched off on this site." };
    if (plan.cost > maxLive) return { ...plan, error: "Live orders are capped at $" + maxLive.toLocaleString("en-US") + " each on this site." };
  }
  return plan;
}

/* What makes two plans the same order: the same client id may only ever be
   sent for the same thing. */
export function planSignature(plan) {
  return plan.type === "limit" ? "l|" + plan.qty + "|" + plan.limitPrice : "m|" + plan.notional;
}
