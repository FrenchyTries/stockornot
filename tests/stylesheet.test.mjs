import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/* Layout and legibility rules in styles.css that a change elsewhere in the
   file could quietly undo. Read as text: each rule is a selector and its
   declarations, comments left out. */

const ROOT = path.resolve(import.meta.dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2], at: m.index }));
const rule = (sel) => RULES.find((r) => r.sel === sel);
const token = (name) => CSS.match(new RegExp(name + ":\\s*(#[0-9a-f]{6})"))[1];

/* WCAG contrast of two #rrggbb colours */
function contrast(a, b) {
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test("white words sit on fills dark enough to read (4.5:1), never on the bright accent", () => {
  assert.ok(contrast(token("--accent-fill"), "#ffffff") >= 4.5);
  assert.ok(contrast(token("--accent-fill-hover"), "#ffffff") >= 4.5);
  assert.ok(contrast(token("--bad-fill"), "#ffffff") >= 4.5);
  for (const r of RULES.filter((x) => /color:\s*#fff\b/.test(x.body))) {
    assert.doesNotMatch(r.body, /background:\s*var\(--(accent|bad)\)/, r.sel);
  }
  /* the lighter analyst segments take the page's dark colour for their numbers */
  const dark = rule(".rec-seg.rec-b, .rec-seg.rec-s, .rec-seg.rec-ss");
  assert.ok(dark && /color:\s*var\(--bg\)/.test(dark.body));
  for (const band of ["rec-b", "rec-s", "rec-ss"]) {
    const fill = RULES.find((x) => x.sel.includes(".rec-seg." + band + " ") || x.sel.endsWith(".rec-seg." + band)).body.match(/#[0-9a-f]{6}/)[0];
    assert.ok(contrast(fill, token("--bg")) >= 4.5, band);
  }
});

test("between 361 and 380px the deck's buttons give up padding, and the 360 rule still wins below that", () => {
  const narrow = CSS.indexOf("@media (max-width: 380px) { .deck-btn { padding: 0 12px; } }");
  const narrowest = CSS.indexOf("@media (max-width: 360px) {", CSS.indexOf(".deck-btn span"));
  assert.ok(narrow > 0 && narrowest > narrow);
});

test("a card's z-index orders it within the deck only, never above the header or the tab bar", () => {
  assert.match(rule(".deck").body, /isolation:\s*isolate/);
});

test("the swap picker's rows stay inside the list, and a long name wraps there", () => {
  assert.match(rule(".pick-list").body, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.doesNotMatch(rule(".search-hit span").body, /nowrap|ellipsis/);
});

test("a control reached with the keyboard is scrolled clear of the header and the tab bar", () => {
  const html = rule("html");
  assert.match(html.body, /scroll-padding-top:\s*var\(--topbar-full\)/);
  assert.match(html.body, /scroll-padding-bottom:\s*calc\(var\(--tabbar-h\)/);
});

test("the Stocks | ETFs chips and the holding tickers are taller to tap than they look, with no layout change", () => {
  for (const sel of [".kind-switch .chip::after", ".hold-t:not(:disabled)::after"]) {
    const r = rule(sel);
    assert.ok(r, sel);
    assert.match(r.body, /position:\s*absolute/);
    assert.match(r.body, /top:\s*-8px/);
    assert.match(r.body, /bottom:\s*-8px/);
  }
  /* the deck reserves the switch's height, so the chip itself keeps it */
  assert.doesNotMatch(rule(".kind-switch .chip").body, /height/);
});

test("a sheet with no note in its header keeps its close button in the corner", () => {
  assert.match(rule(".sheet-head h2 + .icon-btn").body, /margin-left:\s*auto/);
});

test("every backdrop-filter has the -webkit- one beside it (Safari before 18, the iPhone app's iOS 16)", () => {
  const plain = RULES.filter((r) => /(^|[;\s])backdrop-filter:/.test(r.body));
  assert.ok(plain.length >= 3);
  for (const r of plain) {
    const want = r.body.match(/(?:^|[;\s])backdrop-filter:\s*([^;]+);/)[1].trim();
    const prefixed = r.body.match(/-webkit-backdrop-filter:\s*([^;]+);/);
    assert.ok(prefixed && prefixed[1].trim() === want, r.sel);
  }
});
