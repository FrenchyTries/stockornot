/* ==========================================================================
   Who can see what.

   Three steps, deliberately. A visitor gets enough companies to understand
   what the thing is. Signing in costs them an email and buys a bigger
   allowance; the address is used for the account and nothing else without
   asking, as the sign-in dialog promises. Paying removes the count entirely.
   Screens and search are flagged below for members but are not built yet.

     signed out    5 companies
     free account  10 companies
     member        all of them, plus the things below

   The count is of distinct companies looked at, not swipes, so flicking back
   and forth over the same five does not burn the allowance.

   IMPORTANT, and the reason this file is only half the job: enforcing this in
   the browser stops nobody who can open developer tools, and data/snapshot.json
   is a public URL. This layer decides what the interface offers. It is not a
   security boundary and must not be mistaken for one. The boundary is the
   server, and building it is a separate piece of work — see PAYWALL.md.
   ========================================================================== */

/* While StockOrNot is in development every visitor is treated as a member:
   no company allowance, no cart cap, every feature on. The tiers below are
   kept intact so launching the paywall is a one-line change back to false. */
export const DEV_UNLIMITED = true;

export const LIMITS = {
  anon:   5,
  free:   10,
  member: Infinity
};

/* What each tier is allowed to do. Read by the app to decide whether to render
   a control at all, rather than rendering it and then apologising. */
export const FEATURES = {
  anon:   { cart: 3,        search: false, screens: false, fullDetail: false, alerts: false, exportCsv: false },
  free:   { cart: 10,       search: false, screens: false, fullDetail: false, alerts: false, exportCsv: true  },
  member: { cart: Infinity, search: true,  screens: true,  fullDetail: true,  alerts: true,  exportCsv: true  }
};

export const PRICE = {
  monthly: 9,
  yearly:  79,          /* two months free, and it halves the churn */
  currency: "USD"
};

export const TIER_LABEL = { anon: "Visitor", free: "Free account", member: "Member" };

/* --------------------------------------------------------------- helpers */

export function limitFor(tier) {
  if (DEV_UNLIMITED) return LIMITS.member;
  return LIMITS[tier] ?? LIMITS.anon;
}

export function featuresFor(tier) {
  if (DEV_UNLIMITED) return FEATURES.member;
  return FEATURES[tier] ?? FEATURES.anon;
}

/* How many distinct companies this person has opened. Kept separate from the
   swipe history so that clearing the deck to go round again does not hand out
   a fresh allowance. */
const VIEWED_KEY = "ts.viewed";

export function loadViewed() {
  try {
    const raw = window.localStorage.getItem(VIEWED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

export function recordViewed(set, ticker) {
  if (!ticker || set.has(ticker)) return false;
  set.add(ticker);
  try { window.localStorage.setItem(VIEWED_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
  return true;
}

/* True when this company is inside the allowance. Companies already counted
   stay visible for good: taking back something someone has already read is a
   worse experience than never having shown it. */
export function withinAllowance(viewed, ticker, tier) {
  const limit = limitFor(tier);
  if (limit === Infinity) return true;
  if (viewed.has(ticker)) return true;
  return viewed.size < limit;
}

export function remainingFor(viewed, tier) {
  const limit = limitFor(tier);
  return limit === Infinity ? Infinity : Math.max(0, limit - viewed.size);
}

/* --------------------------------------------------- tier from the account

   Reads one row. A missing row, an expired row or any error all mean "free",
   which is the safe direction to fail in: a paying customer briefly seeing a
   prompt is a support email, the reverse is giving the product away. */

export async function tierFor(client, user) {
  if (!user) return "anon";
  if (!client) return "free";
  try {
    const { data, error } = await client
      .from("subscriptions")
      .select("status, current_period_end")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error || !data) return "free";

    const live = data.status === "active" || data.status === "trialing";
    const notExpired = !data.current_period_end ||
      new Date(data.current_period_end) > new Date();
    return live && notExpired ? "member" : "free";
  } catch {
    return "free";
  }
}
