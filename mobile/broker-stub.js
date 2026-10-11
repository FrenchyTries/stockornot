/* ==========================================================================
   The iPhone app's lib/broker.

   scripts/build-app.mjs copies this over lib/broker.js in the app's copy of
   the site. The app places no orders and connects no brokerage, and Apple
   reviews what the app can do, so the code that could do either is left out
   rather than hidden: nothing here goes near the network, and a later change
   on the website cannot switch it back on inside an app already reviewed.

   It has every export of lib/broker.mjs (the build checks that), so app.js
   runs unchanged. status() gives the answer lib/broker.mjs gives where there
   is no /api/broker, which app.js already handles by leaving the brokerage
   out; every other call reports that it did nothing.
   ========================================================================== */

const nothing = () => Promise.resolve({ ok: false });

export const status      = () => Promise.resolve({ ok: false, status: 404, unavailable: true });
export const connect     = nothing;
export const disconnect  = nothing;
export const portfolio   = nothing;
export const place       = nothing;
export const cancel      = nothing;
export const oauthUrl    = () => "#";
export const clientId    = () => "";
export const MIN_NOTIONAL = 1;
export const planOrder   = () => null;
export const planSignature = () => "";
