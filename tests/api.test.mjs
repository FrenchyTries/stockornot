import test from "node:test";
import assert from "node:assert/strict";
import { buildOrder, maxLiveBatch } from "../api/_lib/alpaca.mjs";
import { parseCookies } from "../api/_lib/http.mjs";
import news from "../api/news.mjs";

const id = "abcdef12-3456";

test("an order without a client id is refused, so a retry can never buy twice", () => {
  assert.match(buildOrder({ symbol: "AAPL", side: "buy", type: "market", notional: 50 }, "paper").error, /out of date/);
  assert.ok(buildOrder({ symbol: "AAPL", side: "buy", type: "market", notional: 50, clientId: id }, "paper").order);
});

test("a limit price is rounded toward the cautious side, and the cap is checked on what is sent", () => {
  const buy = buildOrder({ symbol: "F", side: "buy", type: "limit", qty: 4975, limitPrice: 1.00501, clientId: id }, "paper");
  assert.equal(buy.order.limit_price, "1.00");
  const sell = buildOrder({ symbol: "F", side: "sell", type: "limit", qty: 10, limitPrice: 1.00501, clientId: id }, "paper");
  assert.equal(sell.order.limit_price, "1.01");
  process.env.BROKER_MAX_ORDER_USD = "5000";
  /* typed as $4,999.92 at $1.00501, sent at $1.00: under the cap */
  assert.ok(buildOrder({ symbol: "F", side: "buy", type: "limit", qty: 4975, limitPrice: 1.00501, clientId: id }, "live").order);
  /* a sub-cent price that used to round up to twice the cap */
  assert.ok(buildOrder({ symbol: "F", side: "buy", type: "limit", qty: 1e8, limitPrice: 0.00005, clientId: id }, "live").error);
  delete process.env.BROKER_MAX_ORDER_USD;
});

test("a live batch has a cap of its own, the per-order cap unless set wider", () => {
  delete process.env.BROKER_MAX_BATCH_USD;
  process.env.BROKER_MAX_ORDER_USD = "5000";
  assert.equal(maxLiveBatch(), 5000);
  process.env.BROKER_MAX_BATCH_USD = "$12,000";
  assert.equal(maxLiveBatch(), 12000);
  process.env.BROKER_MAX_BATCH_USD = "lots";
  assert.equal(maxLiveBatch(), 0);
  delete process.env.BROKER_MAX_BATCH_USD;
  delete process.env.BROKER_MAX_ORDER_USD;
});

test("the first cookie of a name wins, so one planted at a wider path cannot override ours", () => {
  const c = parseCookies({ headers: { cookie: "son_broker=ours; other=1; son_broker=planted; __proto__=x" } });
  assert.equal(c.son_broker, "ours");
  assert.equal(c.other, "1");
  assert.equal(Object.getPrototypeOf(c), null);
});

test("the news proxy answers GET and HEAD only, so nobody can skip the cache", async () => {
  let status, headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; }, end() {}, set statusCode(v) { status = v; }, get statusCode() { return status; } };
  await news({ method: "POST", url: "/api/news?t=AAPL", headers: {} }, res);
  assert.equal(status, 405);
  assert.equal(headers.Allow, "GET, HEAD");
});
