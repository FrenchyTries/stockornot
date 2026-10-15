import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as cartLib from "../lib/cart.mjs";
import { createClient } from "../lib/vendor/supabase-js-2.116.0.mjs";
import { friendly } from "../lib/auth.mjs";

/* Sign-in errors as the person reads them. Each one is made by the real
   sign-in library from an answer Supabase gives (or from no answer at all),
   so the error's name, status and code are the ones the page gets. */

const json = (status, body, headers = {}) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
const offline = (words) => () => Promise.reject(new TypeError(words));
const down = () => Promise.resolve(new Response("<html>503</html>", { status: 503, statusText: "Service Unavailable", headers: { "content-type": "text/html" } }));
/* GoTrue's older shape, and the 2024-01-01 one */
const gotrue = (status, code, msg) => json(status, { code: status, error_code: code, msg });
const gotrue24 = (status, code, message) => json(status, { code, message }, { "x-supabase-api-version": "2024-01-01" });

async function errorFrom(answer, call) {
  const c = createClient("https://x.supabase.co", "k", {
    global: { fetch: answer },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const email = "someone@example.com";
  const { error } = call === "send" ? await c.auth.signInWithOtp({ email })
    : call === "code" ? await c.auth.verifyOtp({ email, token: "123456", type: "email" })
    : await c.auth.signInWithPassword({ email, password: "x" });
  assert.ok(error, "no error came back");
  return friendly(error, call === "send");
}

const NO_CONNECTION = "No connection. Try again when you are online.";
const NOT_SENT = "The sign-in email could not be sent just now. Try again later, or write to hello@stockornot.com.";
const NOT_ANSWERING = "Sign-in is not answering just now. Try again in a few minutes.";
const BAD_CODE = "That code is wrong, expired or already used. Check it, or send yourself a new one.";
const BAD_ADDRESS = "That does not look like a working email address.";
const SWITCHED_OFF = "Sign-in by email is not available right now. Try again later.";

test("sign-in errors say what happened and what to do", async () => {
  const table = [
    /* no answer: the browser's own words never reach the page */
    ["send", offline("Failed to fetch"), NO_CONNECTION],
    ["code", offline("Load failed"), NO_CONNECTION],
    ["password", offline("NetworkError when attempting to fetch resource."), NO_CONNECTION],
    /* Supabase down: not a connection problem; on sending, the email did not go */
    ["send", down, NOT_SENT],
    ["code", down, NOT_ANSWERING],
    ["password", down, NOT_ANSWERING],
    /* the email could not go: never "not a working email address" */
    ["send", gotrue(500, "unexpected_failure", "Error sending magic link email"), NOT_SENT],
    ["send", gotrue(500, "unexpected_failure", "Error sending confirmation email"), NOT_SENT],
    ["send", gotrue(400, "email_address_not_authorized", "Email address \"someone@example.com\" cannot be used as it is not authorized"), NOT_SENT],
    /* a mistyped, an expired and a used code get the same answer from Supabase */
    ["code", gotrue(403, "otp_expired", "Token has expired or is invalid"), BAD_CODE],
    ["code", gotrue24(403, "otp_expired", "Token has expired or is invalid"), BAD_CODE],
    /* App Review's password */
    ["password", gotrue(400, "invalid_credentials", "Invalid login credentials"), "That password is not right. It is in the App Review notes."],
    ["password", gotrue(400, "email_not_confirmed", "Email not confirmed"), "This account is not confirmed, so it cannot sign in. Write to hello@stockornot.com."],
    /* too many */
    ["send", gotrue(429, "over_email_send_rate_limit", "email rate limit exceeded"), "Too many sign-in emails just now. Try again in a few minutes."],
    ["send", gotrue(429, "over_email_send_rate_limit", "For security purposes, you can only request this after 42 seconds."),
      "For security purposes, you can only request this after 42 seconds."],
    /* a real bad address */
    ["send", gotrue(400, "validation_failed", "Unable to validate email address: invalid format"), BAD_ADDRESS],
    ["send", gotrue24(400, "email_address_invalid", "Email address \"x@y\" is invalid"), BAD_ADDRESS],
    /* switched off in Supabase */
    ["send", gotrue(422, "email_provider_disabled", "Email logins are disabled"), SWITCHED_OFF],
    ["send", gotrue(422, "signup_disabled", "Signups not allowed for this instance"), SWITCHED_OFF],
    /* anything else keeps Supabase's words */
    ["code", gotrue(400, "something_new", "Something new went wrong"), "Something new went wrong"]
  ];
  for (const [call, answer, said] of table) {
    assert.equal(await errorFrom(answer, call), said, call + " " + String(answer));
  }
});

/* lib/auth.mjs as the page runs it, with this browser's storage and the
   network stubbed (and the library's complaints about the network kept out
   of the test output). Each run gets its own copy of the module. */
const STORAGE_KEY = "sb-ghtojgetgwjwrzkfxzhk-auth-token";
let copy = 0;
async function page({ stored, answer }) {
  const store = new Map(stored ? [[STORAGE_KEY, JSON.stringify(stored)]] : []);
  const saved = { window: globalThis.window, fetch: globalThis.fetch };
  const said = { warn: console.warn, error: console.error };
  console.warn = console.error = () => {};
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    }
  };
  globalThis.fetch = (url, init) => answer(new URL(String(url)), init);
  const auth = await import("../lib/auth.mjs?page" + copy++);
  return { auth, store, done: () => { Object.assign(globalThis, saved); Object.assign(console, said); } };
}

const user = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", email: "me@example.com", created_at: "2026-10-01T00:00:00Z", user_metadata: {} };
const session = (expiresIn) => {
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  return { access_token: "a.b.c", token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "rt", user };
};
const rows = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

test("storedUser() reads a session kept in this browser without the network", async () => {
  /* an access token that has run out, offline: the library reports nobody */
  const p = await page({ stored: session(-7200), answer: () => Promise.reject(new TypeError("Load failed")) });
  try {
    assert.equal(p.auth.storedUser()?.email, "me@example.com");
    assert.equal(p.auth.hasStoredSession(), true);
  } finally { p.done(); }
  const none = await page({ stored: null, answer: () => Promise.reject(new TypeError("Load failed")) });
  try { assert.equal(none.auth.storedUser(), null); } finally { none.done(); }
  /* half a session (no refresh token, no user) is nobody's */
  const half = await page({ stored: { access_token: "a.b.c" }, answer: () => Promise.reject(new TypeError("Load failed")) });
  try { assert.equal(half.auth.storedUser(), null); } finally { half.done(); }
});

test("Download my data: offline is not \"Sign in first.\", and the alerts note is only for someone who could have had one", async () => {
  /* signed in, no connection */
  let p = await page({ stored: session(3600), answer: () => Promise.reject(new TypeError("Failed to fetch")) });
  try { assert.deepEqual(await p.auth.myData(), { ok: false, error: NO_CONNECTION }); } finally { p.done(); }

  /* not signed in at all */
  p = await page({ stored: null, answer: () => Promise.reject(new TypeError("Failed to fetch")) });
  try { assert.deepEqual(await p.auth.myData(), { ok: false, error: "Sign in first." }); } finally { p.done(); }

  /* signed in and answering: the note about sent alerts depends on alert settings */
  const answering = (prefs, log) => (u) => {
    if (u.pathname === "/auth/v1/user") return rows(user);
    if (u.pathname === "/rest/v1/carts") return rows([]);
    if (u.pathname === "/rest/v1/alert_prefs") return rows(prefs ? [prefs] : []);
    if (u.pathname === "/rest/v1/alert_log") return rows(log);
    return Promise.reject(new Error("unexpected " + u.pathname));
  };
  for (const [prefs, log, note] of [
    [null, [], false],                                         /* never had settings: never had an alert */
    [{ email: true, days_before: 7 }, [], true],               /* might have had one the log cannot show */
    [{ email: true, days_before: 7 }, [{ ticker: "AAPL", report_date: "2026-10-30", sent_at: "2026-10-23T22:00:00Z" }], false]
  ]) {
    p = await page({ stored: session(3600), answer: answering(prefs, log) });
    try {
      const r = await p.auth.myData();
      assert.equal(r.ok, true, r.error);
      assert.equal("alerts_sent_note" in r.data, note, JSON.stringify(r.data));
      if (note) assert.doesNotMatch(r.data.alerts_sent_note, /schema|supabase/i);
    } finally { p.done(); }
  }
});

test("signing out forgets the session here even when the library could not", async () => {
  /* An access token that has run out, offline: the library cannot refresh
     it, so it will not sign out and keeps the session. It retries for half a
     minute first; each try here moves its clock on 15 seconds instead. */
  const now = Date.now;
  let ahead = 0;
  Date.now = () => now() + ahead;
  const p = await page({ stored: session(-7200), answer: () => { ahead += 15000; return Promise.reject(new TypeError("Load failed")); } });
  try {
    await p.auth.signOut();
    assert.equal(p.store.has(STORAGE_KEY), false);
    assert.equal(p.auth.storedUser(), null);
  } finally { p.done(); Date.now = now; }
});

/* app.js is a page script, not a module: these take single functions (and
   `var` lines) out of it and run them with what they touch stubbed, as
   tests/app.test.mjs does. */
const APP = readFileSync(path.join(import.meta.dirname, "..", "app.js"), "utf8");
function appCode(...names) {
  return names.map((n) => {
    const m = APP.match(new RegExp("^function " + n + "\\([^]*?\\n\\}\\n", "m")) || APP.match(new RegExp("^var " + n + " = [^\\n]*\\n", "m"));
    assert.ok(m, n + " is not in app.js");
    return m[0];
  }).join("\n");
}

/* Signing out in one tab while another is open: the other tab hears that the
   owner changed before it hears the cart emptied, and must not keep (or later
   write back) the signed-out account's cart and notes. */
test("signing out in another tab empties this tab's cart, whatever order the changes arrive in", () => {
  const store = new Map();
  const ctx = vm.createContext({
    cartLib, JSON, Set,
    LS: { cart: "ts.cart", seen: "ts.seen", owner: "ts.cartOwner" },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    state: { cart: [], cartGone: [], cartOwner: null, seen: [] },
    seenSet: new Set(), cartChanged() {}, scheduleSync() {}
  });
  vm.runInContext(appCode("load", "save", "cartRecords", "setCart", "persistCart", "onStorage"), ctx);
  const mine = [{ t: "AAPL", note: "my private note", added: "2026-10-14T10:00:00Z" }];
  const tickers = () => ctx.state.cart.map((i) => i.t);

  /* this tab: signed in as u1, the cart is u1's */
  store.set("ts.cartOwner", JSON.stringify("u1"));
  store.set("ts.cart", JSON.stringify(mine));
  ctx.state.cartOwner = "u1";
  ctx.setCart(mine);

  /* the other tab signs out: the owner arrives while the old cart is still stored */
  store.set("ts.cartOwner", JSON.stringify(""));
  ctx.onStorage({ key: "ts.cartOwner" });
  assert.deepEqual(tickers(), []);
  store.set("ts.cart", "[]");
  ctx.onStorage({ key: "ts.cart" });
  assert.deepEqual(tickers(), []);
  /* the next Keep here writes only what was kept here */
  ctx.state.cart.push({ t: "MSFT", added: "2026-10-14T11:00:00Z" });
  ctx.persistCart();
  assert.deepEqual(JSON.parse(store.get("ts.cart")).map((i) => i.t), ["MSFT"]);

  /* a sign-in in the other tab still brings that account's cart here */
  store.set("ts.cart", JSON.stringify(mine));
  store.set("ts.cartOwner", JSON.stringify("u2"));
  ctx.onStorage({ key: "ts.cartOwner" });
  assert.deepEqual(tickers(), ["AAPL"]);
  /* and a Keep there, same owner, is merged in */
  store.set("ts.cart", JSON.stringify(mine.concat({ t: "NVDA", added: "2026-10-14T12:00:00Z" })));
  ctx.onStorage({ key: "ts.cart" });
  assert.deepEqual(tickers().sort(), ["AAPL", "NVDA"]);
});

/* "Turn them off" in an alert email, opened where nobody is signed in. */
test("the alerts-off link, signed out: no unticked box, and the sign-in it asks for switches them off", async () => {
  const made = (tag, cls, text) => ({
    tag, text, kids: [], on: {},
    set innerHTML(v) { this.kids = []; }, appendChild(k) { this.kids.push(k); },
    get textContent() { return this.text ?? this.kids.map((k) => k.textContent ?? k.text).join(""); },
    set textContent(v) { this.text = v; this.kids = []; },
    addEventListener(type, fn) { this.on[type] = fn; }
  });
  const els = { "#earnEmail": { checked: false, indeterminate: false, disabled: false }, "#earnEmailNote": made("p"), "#dlgEarnings": {}, "#dlgOwner": { open: false } };
  const saved = [], opened = [];
  const ctx = vm.createContext({
    Date, state: { user: null, authPending: false },
    $: (s) => els[s], el: made, document: { createTextNode: (t) => ({ text: t }) },
    closeDialog() {}, openAuth() { opened.push("account"); }, openEarnings() { opened.push("earnings"); },
    whenLoaded: (fn) => fn(), earn: { ALERT_DAYS: 7 },
    auth: {
      isConfigured: () => true,
      saveAlertPrefs: (p) => { saved.push(p); return Promise.resolve({ ok: true }); },
      fetchAlertPrefs: () => new Promise(() => {})
    }
  });
  vm.runInContext(appCode("alertsOffLink", "alertsOffAt", "ALERTS_OFF_FOR_MS", "renderEmailToggle", "alertsOffAfterSignIn"), ctx);
  const box = els["#earnEmail"], note = els["#earnEmailNote"];

  /* opened from the deck: as before */
  ctx.renderEmailToggle();
  assert.deepEqual([box.checked, box.indeterminate, box.disabled], [false, false, true]);
  assert.match(note.textContent, /^Sign in so there is an address to send it to/);

  /* from the link: this browser cannot know, so the box says neither on nor off */
  vm.runInContext("alertsOffLink = true", ctx);
  ctx.renderEmailToggle();
  assert.deepEqual([box.checked, box.indeterminate, box.disabled], [false, true, true]);
  assert.match(note.textContent, /cannot tell whether your alerts are on/);
  assert.match(note.textContent, /reply "unsubscribe"/);

  /* a sign-in nobody asked for from that note changes nothing */
  ctx.alertsOffAfterSignIn({ id: "u1" });
  assert.deepEqual(saved, []);

  /* its Sign in, then the sign-in: off, and the sheet shows it */
  note.kids.find((k) => k.tag === "button").on.click();
  assert.deepEqual(opened, ["account"]);
  ctx.state.user = { id: "u1", email: "me@example.com" };
  ctx.alertsOffAfterSignIn(ctx.state.user);
  await new Promise((ok) => setImmediate(ok));
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ email: false, days_before: 7 }]);
  assert.deepEqual(opened, ["account", "earnings"]);
  /* once only */
  ctx.alertsOffAfterSignIn(ctx.state.user);
  assert.equal(saved.length, 1);

  /* signed in, the box shows the account's setting, never a dash */
  ctx.renderEmailToggle();
  assert.equal(box.indeterminate, false);

  /* a sign-in more than an hour after the note's Sign in does not switch them off */
  ctx.state.user = null;
  ctx.renderEmailToggle();
  note.kids.find((k) => k.tag === "button").on.click();
  vm.runInContext("alertsOffAt -= ALERTS_OFF_FOR_MS + 1", ctx);
  ctx.alertsOffAfterSignIn({ id: "u1" });
  await new Promise((ok) => setImmediate(ok));
  assert.equal(saved.length, 1);
});
