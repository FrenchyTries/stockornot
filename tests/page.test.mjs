import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { num, cap, pct, pctPlain, x, inputs } from "../lib/analysis.mjs";

/* Pieces of the page script: the deck's stack, Undo and the passed-on deck,
   and the full record's peer table. app.js is a page script, not a module:
   these take single functions (and `var` lines) out of it and run them in a
   context of their own, with what they touch stubbed. */

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
function appCode(...names) {
  return names.map((n) => {
    const m = APP.match(new RegExp("^function " + n + "\\([^]*?\\n\\}\\n", "m")) || APP.match(new RegExp("^var " + n + " = [^\\n]*\\n", "m"));
    assert.ok(m, n + " is not in app.js");
    return m[0];
  }).join("\n");
}

/* just enough of an element for the deck and a table */
function fakeNode(tag, cls, text) {
  const attrs = {};
  return {
    tag, className: cls || "", text: text == null ? "" : String(text), children: [], style: {}, inert: false,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null),
    appendChild(c) { this.children.push(c); return c; }, addEventListener() {}
  };
}
const textOf = (n) => n.text + n.children.map(textOf).join("");

/* A deck of A and B with A on top, and a cart that addToCart stamps with a
   new time on every add. */
function deck() {
  let clock = Date.UTC(2026, 9, 14);
  const toasts = [], restored = [];
  const ctx = vm.createContext({
    state: { byTicker: { A: { t: "A" }, B: { t: "B" } }, cart: [], cartGone: [], history: [], deck: ["A", "B"], cursor: 0, busy: false },
    cards: [], counted: null, toasts, restored, num,
    native: { tap() {} }, window: { innerWidth: 400 },
    cartLib: { tombstone: (t) => ({ t, deletedAt: "gone" }) },
    addToCart(s) {
      if (ctx.cartItem(s.t)) return false;
      ctx.state.cart.unshift({ t: s.t, addedAt: new Date(clock += 1000).toISOString(), note: "" });
      return true;
    },
    el: fakeNode, $: () => fakeNode("div"),
    stackTransform: (d) => "depth " + d, pressed() {}, markSeen() {}, unmarkSeen() {}, persistCart() {},
    renderCartCount() {}, renderEarnNotice() {}, renderDeck() {}, stillMotion: () => true,
    setTimeout: (fn) => fn(),
    showToast: (text, label, onAction) => toasts.push({ text, onAction }),
    restoreToCart: (item) => restored.push(item)
  });
  vm.runInContext(appCode("HISTORY_MAX", "cardShell", "cartItem", "removeFromCart", "commit", "undo"), ctx);
  /* the deck as renderDeck leaves it: A on top, B behind */
  const put = () => {
    ctx.cards = ctx.state.deck.slice(ctx.state.cursor, ctx.state.cursor + 2)
      .map((t, depth) => ({ node: ctx.cardShell(depth), ticker: t, depth }));
  };
  put();
  return { ctx, put, toasts, restored, inCart: () => ctx.state.cart.map((i) => i.t).join(",") };
}

test("a card behind the top one takes no Tab stop, and the one that comes up does", () => {
  const { ctx } = deck();
  const [top, behind] = ctx.cards;
  assert.equal(top.node.inert, false);
  assert.equal(behind.node.inert, true);
  /* the stamps say nothing to a screen reader: they only show in a drag */
  assert.equal(top.node.innerHTML.match(/class="stamp [a-z]+" aria-hidden="true"/g).length, 2);
  ctx.commit("pass");
  assert.equal(behind.node.inert, false);
  assert.equal(behind.node.getAttribute("aria-hidden"), "false");
});

test("Undo takes out only the cart record its swipe made, and never a note without a way back", () => {
  /* swiped right and taken back: out of the cart, quietly */
  let d = deck();
  d.ctx.commit("add");
  assert.equal(d.inCart(), "A");
  d.ctx.undo();
  assert.equal(d.inCart(), "");
  assert.equal(d.toasts.length, 0);

  /* a note or an amount written since: out, with the cart's own Undo */
  for (const typed of [{ note: "margins recover" }, { amount: 750 }]) {
    d = deck();
    d.ctx.commit("add");
    Object.assign(d.ctx.cartItem("A"), typed);
    d.ctx.undo();
    assert.equal(d.inCart(), "");
    assert.equal(d.toasts.length, 1);
    assert.equal(d.toasts[0].text, "A is out of your cart");
    d.toasts[0].onAction();
    assert.equal(d.restored.length, 1);
    assert.deepEqual({ ...d.restored[0] }, { ...d.restored[0], ...typed, t: "A" });
  }

  /* taken out of the cart and added again from somewhere else: that later
     record is not the swipe's to take back */
  d = deck();
  d.ctx.commit("add");
  d.ctx.removeFromCart("A");
  d.ctx.addToCart({ t: "A" });
  d.ctx.undo();
  assert.equal(d.inCart(), "A");

  /* a pass taken back leaves the cart alone */
  d = deck();
  d.ctx.addToCart({ t: "A" });
  d.ctx.commit("pass");
  d.ctx.undo();
  assert.equal(d.inCart(), "A");
});

test("\"Show the ones I passed on\" leaves out what is in the cart, and so does the deck left for the funds", () => {
  const ctx = vm.createContext({
    state: {
      all: ["A", "B", "C", "D", "E"].map((t) => ({ t })), funds: ["F1", "F2"].map((t) => ({ t, kind: "etf" })),
      kind: "stocks", deck: [], cursor: 0, history: [], showSeen: true, busy: false, cart: [{ t: "B" }]
    },
    seenSet: new Set(["A", "B", "C", "D", "E", "F1", "F2"]), LS: { kind: "ts.deckKind" },
    save() {}, renderKinds() {}, renderDeck() {},
    shuffle: (a) => a.slice().reverse(),
    funds: { deckOrder: (pool) => pool, readFunds: () => new Map() }
  });
  vm.runInContext(appCode("deckKind", "deckPool", "buildDeck", "cartItem", "leftDecks", "chooseKind"), ctx);
  const { state } = ctx;
  ctx.buildDeck();
  assert.equal(state.deck.join(","), "E,D,C,A");
  /* one swiped, then over to the funds, where D goes in the cart */
  state.cursor = 1;
  ctx.chooseKind("etfs");
  state.cart.push({ t: "D" });
  ctx.chooseKind("stocks");
  assert.equal(state.deck.join(","), "E,C,A");
  assert.equal(state.cursor, 1);
  /* "Go through them again" still means all of them */
  state.showSeen = false;
  ctx.seenSet.clear();
  ctx.buildDeck();
  assert.equal(state.deck.join(","), "E,D,C,B,A");
});

test("the peer table marks a bank's one-year revenue jump as the card does, and says why once", () => {
  const ctx = vm.createContext({ el: fakeNode, num, cap, pct, pctPlain, x, inputs, openDetail() {} });
  vm.runInContext(appCode("buildPeers"), ctx);
  const bank = { t: "JPM", n: "JPMorgan", s: "Financials", mc: 890000, pe: 13.7, rg: 109, rg5: 8, nm: 33, r52: 9 };
  const card = { t: "V", n: "Visa", s: "Financials", mc: 600000, pe: 30, rg: 14.4, rg5: 11, nm: 50, r52: 12 };
  const tech = { t: "AAPL", n: "Apple", s: "Information Technology", mc: 3e6, pe: 30, rg: 109, rg5: 8, nm: 25, r52: 5 };

  const said = textOf(ctx.buildPeers(card, [bank]));
  assert.match(said, /\+109\.0%\*/);
  assert.match(said, /\+14\.4%(?!\*)/);
  assert.equal(said.match(/\*Far out of line with the five-year trend/g).length, 1);
  /* a jump outside the Financials sector is not the same artefact */
  const plain = textOf(ctx.buildPeers(tech, [card]));
  assert.doesNotMatch(plain, /\*/);
});
