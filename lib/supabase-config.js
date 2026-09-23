/* ==========================================================================
   Supabase connection details.

   Both values below are meant to be public. The anon key is a "publishable"
   key — it identifies the project, it does not grant access. What actually
   guards the data is row-level security on the table, which is why the schema
   in supabase/schema.sql turns RLS on and writes a policy for every operation.
   Without those policies this key would let anyone read every cart, so do not
   skip that step.

   The service_role key is the opposite: it bypasses RLS entirely. It must
   never appear in this file, in this repo, or anywhere the browser can reach.
   Nothing in the browser needs it. The one thing that does is the nightly
   earnings-alert job (scripts/earnings-alerts.mjs), which reads it from the
   SUPABASE_SERVICE_ROLE_KEY GitHub Actions secret and sends it nowhere else.

   Until both values are filled in, sign-in stays hidden and the app behaves
   exactly as it does today — carts live in the browser and nothing is sent
   anywhere.
   ========================================================================== */

export const SUPABASE_URL = "https://ghtojgetgwjwrzkfxzhk.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_2TcMn1GuFo1yK7UbA6-itQ_AwaEmnEd";
