/* ==========================================================================
   Alpaca, the one brokerage wired up so far.

   Chosen because it is built to be driven by software: a documented REST API,
   OAuth for third-party apps, fractional shares and dollar-amount orders, and
   a free paper-trading account that behaves like the real one with pretend
   money. Paper is the default everywhere below. Live trading stays refused
   until BROKER_ALLOW_LIVE=1 is set on the server, and even then each live
   order is capped by BROKER_MAX_ORDER_USD.

   A connection is { via: "keys", env, k, s } or { via: "oauth", env, tok }.
   Adding another brokerage means another file shaped like this one.
   ========================================================================== */

export const NAME = "Alpaca";

const BASE = {
  paper: () => process.env.ALPACA_PAPER_URL || "https://paper-api.alpaca.markets",
  live:  () => process.env.ALPACA_LIVE_URL  || "https://api.alpaca.markets"
};

export const OAUTH = {
  authorize: () => process.env.ALPACA_AUTHORIZE_URL || "https://app.alpaca.markets/oauth/authorize",
  token:     () => process.env.ALPACA_TOKEN_URL     || "https://api.alpaca.markets/oauth/token",
  scope: "account:write trading"
};

export const liveAllowed = () => process.env.BROKER_ALLOW_LIVE === "1";
export const oauthConfigured = () => Boolean(process.env.ALPACA_CLIENT_ID && process.env.ALPACA_CLIENT_SECRET);
export const maxLiveOrder = () => Number(process.env.BROKER_MAX_ORDER_USD) || 5000;

function headers(conn) {
  const h = { Accept: "application/json" };
  if (conn.via === "oauth") h.Authorization = `Bearer ${conn.tok}`;
  else { h["APCA-API-KEY-ID"] = conn.k; h["APCA-API-SECRET-KEY"] = conn.s; }
  return h;
}

export class BrokerError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function call(conn, method, path, body) {
  const base = (BASE[conn.env] || BASE.paper)();
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { ...headers(conn), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    throw new BrokerError("Could not reach " + NAME + ". Try again in a moment.", 502);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = json?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new BrokerError(res.status === 401
        ? NAME + " did not accept these credentials."
        : NAME + " refused: " + msg, res.status);
    }
    throw new BrokerError(msg, res.status);
  }
  return json;
}

const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/* ------------------------------------------------------------------- reads */

export async function account(conn) {
  const [a, clock] = await Promise.all([
    call(conn, "GET", "/v2/account"),
    call(conn, "GET", "/v2/clock").catch(() => null)
  ]);
  return {
    number: a.account_number ? "•••" + String(a.account_number).slice(-4) : null,
    status: a.status,
    currency: a.currency || "USD",
    cash: n(a.cash),
    buyingPower: n(a.non_marginable_buying_power) ?? n(a.buying_power),
    equity: n(a.equity) ?? n(a.portfolio_value),
    lastEquity: n(a.last_equity),
    tradingBlocked: Boolean(a.trading_blocked || a.account_blocked),
    patternDayTrader: Boolean(a.pattern_day_trader),
    clock: clock ? { isOpen: Boolean(clock.is_open), nextOpen: clock.next_open, nextClose: clock.next_close } : null
  };
}

export async function positions(conn) {
  const rows = await call(conn, "GET", "/v2/positions");
  return (rows || []).map((p) => ({
    symbol: p.symbol,
    qty: n(p.qty),
    avgPrice: n(p.avg_entry_price),
    price: n(p.current_price),
    value: n(p.market_value),
    cost: n(p.cost_basis),
    pl: n(p.unrealized_pl),
    plPct: n(p.unrealized_plpc) !== null ? n(p.unrealized_plpc) * 100 : null
  }));
}

export async function orders(conn) {
  const rows = await call(conn, "GET", "/v2/orders?status=all&limit=25&direction=desc");
  return (rows || []).map(shapeOrder);
}

function shapeOrder(o) {
  return {
    id: o.id,
    clientId: o.client_order_id,
    symbol: o.symbol,
    side: o.side,
    type: o.type || o.order_type,
    qty: n(o.qty),
    notional: n(o.notional),
    limitPrice: n(o.limit_price),
    filledQty: n(o.filled_qty),
    filledAvg: n(o.filled_avg_price),
    status: o.status,
    submittedAt: o.submitted_at || o.created_at,
    filledAt: o.filled_at
  };
}

/* ------------------------------------------------------------------ writes */

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,48}$/;

/** Checks one requested order and turns it into Alpaca's shape. Returns
    { error } instead of throwing so one bad row does not sink the batch. */
export function buildOrder(o, env) {
  if (!o || typeof o !== "object") return { error: "Not an order." };
  const symbol = String(o.symbol || "").toUpperCase();
  if (!SYMBOL.test(symbol)) return { error: "Not a ticker this site knows." };
  const side = o.side === "sell" ? "sell" : o.side === "buy" ? "buy" : null;
  if (!side) return { error: "Side must be buy or sell." };
  const type = o.type === "limit" ? "limit" : "market";
  const clientId = CLIENT_ID.test(String(o.clientId || "")) ? String(o.clientId) : undefined;

  const out = { symbol, side, type, client_order_id: clientId };
  let cost;

  if (type === "market") {
    const notional = Number(o.notional);
    const qty = Number(o.qty);
    if (isFinite(notional) && notional > 0) {
      if (notional < 1) return { error: "Dollar orders start at $1." };
      out.notional = notional.toFixed(2);
      cost = notional;
    } else if (isFinite(qty) && qty > 0) {
      out.qty = String(+qty.toFixed(6));
      cost = null;                      /* unknown until filled */
    } else return { error: "Give an amount in dollars or shares." };
    out.time_in_force = "day";          /* the only one fractional orders take */
  } else {
    const qty = Number(o.qty), limit = Number(o.limitPrice);
    if (!(isFinite(limit) && limit > 0)) return { error: "A limit order needs a limit price." };
    if (!(isFinite(qty) && qty > 0)) return { error: "A limit order needs a number of shares." };
    out.qty = String(+qty.toFixed(6));
    out.limit_price = limit >= 1 ? limit.toFixed(2) : limit.toFixed(4);
    const whole = Number.isInteger(+out.qty);
    out.time_in_force = whole && o.tif === "gtc" ? "gtc" : "day";
    cost = qty * limit;
  }

  if (env === "live") {
    const cap = maxLiveOrder();
    if (cost === null) return { error: "Live orders must be sized in dollars or carry a limit price." };
    if (cost > cap) return { error: `Live orders are capped at $${cap.toLocaleString("en-US")} each on this site.` };
  } else if (cost !== null && cost > 10_000_000) {
    return { error: "That is more than any paper account holds." };
  }
  return { order: out };
}

export async function placeOrder(conn, order) {
  return shapeOrder(await call(conn, "POST", "/v2/orders", order));
}

export async function cancelOrder(conn, id) {
  if (!/^[0-9a-f-]{16,64}$/i.test(String(id))) throw new BrokerError("Not an order id.", 400);
  await call(conn, "DELETE", "/v2/orders/" + encodeURIComponent(id));
  return true;
}

/* ------------------------------------------------------------------- oauth */

export function authorizeUrl({ redirectUri, state, env }) {
  const u = new URL(OAUTH.authorize());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", process.env.ALPACA_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", OAUTH.scope);
  u.searchParams.set("env", env);
  return u.toString();
}

export async function exchangeCode({ code, redirectUri }) {
  const res = await fetch(OAUTH.token(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: process.env.ALPACA_CLIENT_ID,
      client_secret: process.env.ALPACA_CLIENT_SECRET,
      redirect_uri: redirectUri
    }),
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    throw new BrokerError(json?.message || json?.error_description || "The sign-in with " + NAME + " did not complete.", res.status || 502);
  }
  return json.access_token;
}
