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

   Everything degrades. If the config is blank, if the CDN is unreachable, if
   Supabase is down, if the user never signs in — the cart falls back to
   localStorage and the app works exactly as it did before any of this existed.
   ========================================================================== */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

/* An exact version, not "@2": a floating tag would ship each new release (and
   everything esm.sh bundles with it) to this page unreviewed. Bump on purpose.
   The Content-Security-Policy in vercel.json allows scripts from esm.sh only. */
const CDN = "https://esm.sh/@supabase/supabase-js@2.116.0";

export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/* supabase-js keys its stored session by project ref. Deriving it here lets the
   page know a session probably exists before the library has finished loading
   off the CDN, so the header can say "signing you in" instead of flashing
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
  if (/otp_expired|expired|invalid/i.test(code + " " + desc)) return "That sign-in link has expired or was already used. Send yourself a new one.";
  return desc.replace(/\+/g, " ") || "That sign-in link did not work. Send yourself a new one.";
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
   for the library, and a CDN outage cannot stop the deck from rendering. */
export function getClient() {
  if (!isConfigured()) return Promise.resolve(null);
  if (client) return Promise.resolve(client);
  if (clientPromise) return clientPromise;

  clientPromise = import(/* @vite-ignore */ CDN)
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
export async function sendCode(email) {
  const c = await getClient();
  if (!c) return { ok: false, error: "Sign-in is not available right now." };
  const { error } = await c.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: typeof location !== "undefined" ? location.origin : undefined
    }
  });
  return error ? { ok: false, error: friendly(error) } : { ok: true };
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
