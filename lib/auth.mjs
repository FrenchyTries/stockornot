/* ==========================================================================
   Accounts and cart sync.

   The whole point of StockOrNot is that it is a pile of static files — no
   server, nothing to run, nothing to attack. Accounts do not change that.
   Supabase provides Postgres and auth over HTTPS, the browser talks to it
   directly, and row-level security means the database itself refuses to hand
   one person another person's cart. There is still no server here.

   Sign-in is a magic link: they type an email, they get a code, they are in.
   No passwords are chosen, stored, transmitted or reset, which removes an
   entire category of things that go wrong.

   Everything degrades. If the config is blank, if the library fails to load,
   if Supabase is down, if the user never signs in — the cart falls back to
   localStorage and the app works exactly as it did before any of this existed.
   ========================================================================== */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

/* An exact version, served from this site (see the header of the file): no
   CDN can change what runs here, and the Content-Security-Policy in
   vercel.json allows scripts from this site only. Bump on purpose. */
const LIBRARY = "./vendor/supabase-js-2.116.0.mjs";

export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/* supabase-js keys its stored session by project ref. Deriving it here lets the
   page know a session probably exists before the library has finished
   loading, so the header can say "signing you in" instead of flashing
   "Sign in" at somebody who is already signed in. */
const PROJECT_REF = (SUPABASE_URL.match(/https:\/\/([^.]+)\./) || [])[1] || "";
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

export function hasStoredSession() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const v = JSON.parse(raw);
    /* a stale token still counts: the library refreshes it on load */
    return Boolean(v && (v.access_token || v.refresh_token));
  } catch { return false; }
}

/* What went wrong with a sign-in link, when it did: Supabase sends the
   browser back with #error_description=… for a link that expired or was
   already used. */
export function callbackError() {
  const read = (str) => new URLSearchParams(String(str || "").replace(/^[#?]/, ""));
  const h = read(location.hash), q = read(location.search);
  const code = h.get("error_code") || q.get("error_code") || "";
  const desc = h.get("error_description") || q.get("error_description") || "";
  if (!code && !desc) return null;
  /* Only our own words: the description is whatever the link said, and a
     crafted link could make the real sign-in dialog show any text at all. */
  if (/otp_expired|expired|invalid/i.test(code + " " + desc)) return "That sign-in link has expired or was already used. Send yourself a new one.";
  return "That sign-in link did not work. Send yourself a new one.";
}

/* A note, on this device, that a sign-in email was just asked for. A link that
   arrives without one is either opened on another device or sent by someone
   else for their own account, to collect what you add to "your" cart; either
   way the page says whose account it is and offers to sign out. */
const ASKED = "ts.linkAsked";
const ASKED_FOR_MS = 24 * 3600e3;

function noteAsked(email) {
  try { localStorage.setItem(ASKED, JSON.stringify({ email: String(email).toLowerCase(), at: Date.now() })); } catch { /* storage off */ }
}

export function linkWasAsked(email) {
  try {
    const a = JSON.parse(localStorage.getItem(ASKED) || "null");
    return Boolean(a && a.email === String(email || "").toLowerCase() && Date.now() - a.at < ASKED_FOR_MS);
  } catch { return false; }
}

/* True when this page load is the return leg of a sign-in link. */
export function isAuthCallback() {
  const h = location.hash || "", q = location.search || "";
  return h.includes("access_token") || h.includes("error_description") || /[?&]code=/.test(q);
}

/* Tokens in the address bar are ugly and get copied into bug reports and
   shared links. Once the session is stored, take them back out. */
export function tidyUrl() {
  if (!isAuthCallback()) return;
  const search = location.search.replace(/[?&](code|error|error_code|error_description)=[^&]*/g, "").replace(/^&/, "?");
  try { history.replaceState({}, document.title, location.pathname + search); }
  catch { /* not worth failing a sign-in over */ }
}

let client = null;
let clientPromise = null;

/* Loaded on demand rather than at boot: someone who never signs in never pays
   for the library, and a failure to load it cannot stop the deck from rendering. */
export function getClient() {
  if (!isConfigured()) return Promise.resolve(null);
  if (client) return Promise.resolve(client);
  if (clientPromise) return clientPromise;

  clientPromise = import(LIBRARY)
    .then(({ createClient }) => {
      client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: window.localStorage,
          storageKey: STORAGE_KEY,

          /* The default is PKCE, which signs you in only in the browser that
             asked for the link: requesting it stores a one-time verifier, and
             the link is useless without it. Mail apps routinely open links
             somewhere else - a different profile, an in-app browser, the phone
             instead of the laptop - and then the account gets created but the
             session never lands, which is exactly the "logged in, then thrown
             out" behaviour this had. Implicit flow returns the tokens in the
             link itself, so it works wherever the link is opened. */
          flowType: "implicit"
        }
      });
      return client;
    })
    .catch((err) => {
      console.warn("Sign-in unavailable — could not load the auth library.", err);
      clientPromise = null;
      return null;
    });

  return clientPromise;
}

/* ------------------------------------------------------------------ session */

export async function currentUser() {
  const c = await getClient();
  if (!c) return null;
  try {
    const { data } = await c.auth.getSession();
    return data?.session?.user || null;
  } catch { return null; }
}

export async function onAuthChange(cb) {
  const c = await getClient();
  if (!c) return () => {};
  const { data } = c.auth.onAuthStateChange((_event, session) => cb(session?.user || null));
  return () => data?.subscription?.unsubscribe();
}

/* Sends the sign-in email. Supabase creates the account on first use, so there
   is no separate sign-up path to build or explain.

   What arrives depends on the email template, and on the free tier the template
   is not editable — it ships a clickable link. Once custom SMTP is connected
   the template unlocks and can carry a six-digit code instead. Rather than
   picking one and rewriting this later, we send emailRedirectTo so the link
   works, and the dialog also accepts a code. Both paths land in the same place
   and neither needs a code change when the sending setup changes. */
/* The terms a new account agrees to, by the date on terms.html. Change it
   whenever that page changes. Supabase keeps it, with the time, on an account
   when the account is created (it ignores it for one that already exists). */
export const TERMS_VERSION = "2026-10-07";

export async function sendCode(email) {
  const c = await getClient();
  if (!c) return { ok: false, error: "Sign-in is not available right now." };
  const { error } = await c.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: typeof location !== "undefined" ? location.origin : undefined,
      data: { terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() }
    }
  });
  if (error) return { ok: false, error: friendly(error) };
  noteAsked(email);
  return { ok: true };
}

export async function verifyCode(email, token) {
  const c = await getClient();
  if (!c) return { ok: false, error: "Sign-in is not available right now." };
  const { data, error } = await c.auth.verifyOtp({ email, token, type: "email" });
  return error ? { ok: false, error: friendly(error) } : { ok: true, user: data?.user || null };
}

/* This browser only. The library's default ("global") would also end the
   session on the person's phone and laptop, which then fail to save quietly
   until their access token runs out. */
export async function signOut() {
  const c = await getClient();
  if (c) { try { await c.auth.signOut({ scope: "local" }); } catch { /* already gone */ } }
}

/* Everything the database keeps about the signed-in person, as it stands:
   the account itself, the saved cart, alert settings and the alerts sent.
   Each table only ever returns the caller's own rows. */
export async function myData() {
  const c = await getClient();
  if (!c) return { ok: false, error: "Sign-in is not available right now." };
  const { data: u } = await c.auth.getUser();
  const user = u?.user;
  if (!user) return { ok: false, error: "Sign in first." };
  const [cart, prefs, log] = await Promise.all([
    c.from("carts").select("*").eq("user_id", user.id).maybeSingle(),
    c.from("alert_prefs").select("*").eq("user_id", user.id).maybeSingle(),
    c.from("alert_log").select("ticker, report_date, sent_at").eq("user_id", user.id)
  ]);
  if (cart.error || prefs.error) return { ok: false, error: "That did not load. Try again in a moment." };
  return {
    ok: true,
    data: {
      account: {
        id: user.id, email: user.email, created_at: user.created_at, last_sign_in_at: user.last_sign_in_at,
        terms_version: user.user_metadata?.terms_version || null,
        terms_accepted_at: user.user_metadata?.terms_accepted_at || null
      },
      cart: cart.data || null,
      alert_settings: prefs.data || null,
      alerts_sent: log.error ? "not readable until the database update in supabase/schema.sql is run" : log.data
    }
  };
}

/* Deletes the signed-in account and everything attached to it, through
   delete_my_account() in supabase/schema.sql, then ends the session here. */
export async function deleteAccount() {
  const c = await getClient();
  if (!c) return { ok: false, error: "Sign-in is not available right now." };
  const { error } = await c.rpc("delete_my_account");
  if (error) {
    const missing = error.code === "PGRST202" || /could not find the function/i.test(error.message || "");
    return { ok: false, error: missing
      ? "Deleting from here is not switched on yet. Write to hello@stockornot.com from this address and it is done within 30 days."
      : "That did not go through. Try again, or write to hello@stockornot.com from this address." };
  }
  try { await c.auth.signOut({ scope: "local" }); } catch { /* the session went with the account */ }
  return { ok: true };
}

function friendly(error) {
  const m = String(error?.message || "").toLowerCase();
  if (m.includes("invalid") && m.includes("token")) return "That code is not right. Check it and try again.";
  if (m.includes("expired")) return "That code has expired. Send a new one.";
  if (m.includes("rate") || m.includes("too many")) return "Too many sign-in emails just now. Try again in a few minutes.";
  if (m.includes("email")) return "That does not look like a working email address.";
  return error?.message || "Something went wrong. Try again.";
}

/* --------------------------------------------------------------- cart sync

   One row per person holding the whole cart as JSON, tombstones included (see
   lib/cart.mjs for how copies are merged). A cart is a short list that only
   its owner edits, so per-item rows would buy precision nobody needs and cost
   a round trip per keystroke in the notes field.

   fetchCart separates "no cart saved yet" ({ ok: true, items: [] }) from
   "could not ask" ({ ok: false }). The page never writes a cart it could not
   first read, so a failed read can never overwrite what the account holds. */

export async function fetchCart() {
  const c = await getClient();
  if (!c) return { ok: false };
  const user = await currentUser();
  if (!user) return { ok: false };
  try {
    const { data, error } = await c.from("carts").select("items").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    return { ok: true, userId: user.id, items: Array.isArray(data?.items) ? data.items : [] };
  } catch (err) {
    console.warn("Could not read your saved cart.", err);
    return { ok: false };
  }
}

export async function pushCart(items, userId) {
  const c = await getClient();
  if (!c) return false;
  const user = await currentUser();
  if (!user || (userId && user.id !== userId)) return false;
  try {
    const { error } = await c.from("carts").upsert(
      { user_id: user.id, items, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn("Could not save your cart.", err);
    return false;
  }
}

/* ------------------------------------------------------------ alert prefs

   Whether to email this person before anything in their cart reports. One
   row, theirs only (see supabase/schema.sql); the nightly job reads it with
   the service key. A missing table is the likeliest failure, so say that
   plainly rather than a Postgres error code. */

export async function fetchAlertPrefs() {
  const c = await getClient();
  const user = c && await currentUser();
  if (!user) return { ok: false, error: "Sign in first." };
  try {
    const { data, error } = await c.from("alert_prefs").select("email, days_before").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    return { ok: true, data: data || { email: false, days_before: 7 } };
  } catch (err) {
    return { ok: false, error: prefsError(err) };
  }
}

export async function saveAlertPrefs(prefs) {
  const c = await getClient();
  const user = c && await currentUser();
  if (!user) return { ok: false, error: "Sign in first." };
  try {
    const { error } = await c.from("alert_prefs").upsert(
      { user_id: user.id, email: !!prefs.email, days_before: prefs.days_before || 7, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
    if (error) throw error;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: prefsError(err) };
  }
}

function prefsError(err) {
  const m = String(err?.message || err?.code || "");
  if (/alert_prefs|does not exist|42P01|PGRST205|schema cache/i.test(m)) {
    return "Email alerts are not switched on yet: the alert_prefs table from supabase/schema.sql has not been created.";
  }
  console.warn("alert prefs:", err);
  return "Could not reach your account just now. Try again in a moment.";
}
