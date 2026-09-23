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
export const place      = (orders) => call("orders", { method: "POST", body: { orders } });
export const cancel     = (id) => call("cancel", { method: "POST", body: { id } });

export function oauthUrl(env) {
  return "/api/broker-oauth?env=" + encodeURIComponent(env === "live" ? "live" : "paper");
}

/* A fresh id per order, per review. The brokerage refuses a second order with
   an id it has already seen, so a double-tap on "Place" cannot buy twice. */
export function clientId(symbol) {
  const rand = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now())
    .replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
  return ("son_" + symbol.replace(/[^A-Za-z0-9]/g, "") + "_" + rand).slice(0, 48);
}

/* What a stored amount turns into, before anything is sent. Market orders go
   in dollars and may buy a fraction of a share; limit orders buy whole shares
   at or below the limit, so the dollar figure is a ceiling rather than exact. */
export function planOrder(item, { type, limitPrice, price }) {
  const amount = Number(item.amount);
  if (!(amount > 0)) return null;
  if (type === "limit") {
    const lim = Number(limitPrice) > 0 ? Number(limitPrice) : Number(price);
    if (!(lim > 0)) return { symbol: item.t, error: "No price to set a limit from." };
    const qty = Math.floor(amount / lim);
    if (qty < 1) return { symbol: item.t, error: "$" + amount.toFixed(2) + " does not cover one share at $" + lim.toFixed(2) + "." };
    return { symbol: item.t, side: "buy", type: "limit", qty, limitPrice: +lim.toFixed(lim >= 1 ? 2 : 4), cost: qty * lim, tif: "day" };
  }
  return {
    symbol: item.t, side: "buy", type: "market", notional: +amount.toFixed(2), cost: amount,
    estShares: Number(price) > 0 ? amount / Number(price) : null
  };
}
