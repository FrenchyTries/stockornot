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

/* ------------------------------------------------- deleting an account */

test("delete_my_account deletes only the caller, and only a signed-in caller can run it", async () => {
  const fs = await import("node:fs");
  const sql = fs.readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  const fn = sql.slice(sql.indexOf("create or replace function public.delete_my_account()"));
  const body = fn.slice(0, fn.indexOf("$$;"));
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = ''/);
  assert.match(body, /if auth\.uid\(\) is null then/);
  /* the one statement that deletes, and it is keyed on the caller */
  assert.deepEqual(body.match(/delete from [^;]+;/g), ["delete from auth.users where id = auth.uid();"]);
  assert.match(sql, /revoke all on function public\.delete_my_account\(\) from public, anon;/);
  assert.match(sql, /grant execute on function public\.delete_my_account\(\) to authenticated;/);
  /* people may read their own alert log, never write it */
  assert.match(sql, /create policy "read own alert log" on public\.alert_log for select using \(auth\.uid\(\) = user_id\);/);
  assert.match(sql, /revoke insert, update, delete on public\.alert_log from anon, authenticated;/);
});

test("live orders are buys only; paper sells still work", () => {
  const sell = { symbol: "AAPL", side: "sell", type: "limit", qty: 1, limitPrice: 0.01, clientId: id };
  /* a sell limited far below the market would look cheap to the cap */
  assert.match(buildOrder(sell, "live").error, /buys only/);
  assert.ok(buildOrder(sell, "paper").order);
  assert.ok(buildOrder({ symbol: "AAPL", side: "buy", type: "market", notional: 50, clientId: id }, "live").order);
});
