import test from "node:test";
import assert from "node:assert/strict";
import { mergeCarts, split, tombstone, sameCart, GONE_DAYS } from "../lib/cart.mjs";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const at = (h) => new Date(NOW - h * 36e5).toISOString();

test("a removal on one device is not undone by another device's older copy", () => {
  const remote = [{ t: "KO", addedAt: at(48), updatedAt: at(48), note: "" }];
  const local = [tombstone("KO", at(1))];
  const merged = mergeCarts(local, remote, NOW);
  assert.equal(split(merged).live.length, 0);
  assert.equal(split(merged).gone[0].t, "KO");
  /* and the other way round: the device still holding KO merges the tombstone */
  assert.equal(split(mergeCarts(remote, merged, NOW)).live.length, 0);
});

test("re-adding after a removal brings it back", () => {
  const merged = mergeCarts([{ t: "KO", addedAt: at(0.5), updatedAt: at(0.5) }], [tombstone("KO", at(1))], NOW);
  assert.deepEqual(split(merged).live.map((i) => i.t), ["KO"]);
});

test("the newer edit wins, whichever side it is on", () => {
  const older = { t: "KO", addedAt: at(48), updatedAt: at(10), note: "old", amount: 100 };
  const newer = { t: "KO", addedAt: at(48), updatedAt: at(2), note: "new", amount: null };
  assert.equal(mergeCarts([older], [newer], NOW)[0].note, "new");
  assert.equal(mergeCarts([newer], [older], NOW)[0].note, "new");
  assert.equal(mergeCarts([newer], [older], NOW)[0].amount, null);
});

test("ties prefer the local record and keep it as the same object", () => {
  const local = { t: "KO", addedAt: at(5), updatedAt: at(1), note: "mine" };
  const remote = { t: "KO", addedAt: at(5), updatedAt: at(1), note: "theirs" };
  const merged = mergeCarts([local], [remote], NOW);
  assert.equal(merged[0], local);
});

test("records from before updatedAt merge the old way", () => {
  const local = [{ t: "KO", addedAt: at(10), note: "" , amount: 50 }];
  const remote = [{ t: "KO", addedAt: at(20), priceAtAdd: 60, note: "kept" }];
  const [m] = mergeCarts(local, remote, NOW);
  assert.equal(m.addedAt, at(20));
  assert.equal(m.priceAtAdd, 60);
  assert.equal(m.note, "kept");
  assert.equal(m.amount, 50);
});

test("union of different companies, newest add first, tombstones last", () => {
  const merged = mergeCarts(
    [{ t: "A", addedAt: at(3), updatedAt: at(3) }, tombstone("Z", at(1))],
    [{ t: "B", addedAt: at(1), updatedAt: at(1) }],
    NOW
  );
  assert.deepEqual(merged.map((i) => i.t), ["B", "A", "Z"]);
});

test("old tombstones are dropped and junk rows are ignored", () => {
  const old = tombstone("OLD", at(24 * (GONE_DAYS + 1)));
  const merged = mergeCarts([old, null, 3, { n: "no ticker" }], [{ t: "" }, "x"], NOW);
  assert.deepEqual(merged, []);
});

test("sameCart notices a changed note, not just changed tickers", () => {
  const a = [{ t: "KO", note: "a", updatedAt: at(1) }];
  const b = [{ t: "KO", note: "b", updatedAt: at(1) }];
  assert.equal(sameCart(a, b), false);
  assert.equal(sameCart(a, [{ updatedAt: at(1), note: "a", t: "KO" }]), true);
  assert.equal(sameCart([], []), true);
});
