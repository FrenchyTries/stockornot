/* ==========================================================================
   /api/news?t=TICKER — the last ten days of headlines for one company.

   News goes stale by the hour, so it cannot ride the nightly snapshot like
   everything else. This asks Finnhub on demand with the key held server-side
   (set FINNHUB_TOKEN in the Vercel project, the same key the Action uses) and
   lets the CDN keep each answer for half an hour, so a popular ticker costs
   one call per half hour however many people open it.
   ========================================================================== */

import { send, query } from "./_lib/http.mjs";

const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;

export default async function handler(req, res) {
  const t = String(query(req).get("t") || "").toUpperCase();
  if (!TICKER.test(t)) return send(res, 400, { error: "Unknown ticker." });

  const token = process.env.FINNHUB_TOKEN;
  if (!token) return send(res, 503, { error: "News is not set up on this server (FINNHUB_TOKEN is missing)." });

  const day = (ms) => new Date(Date.now() - ms).toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(t)}` +
              `&from=${day(10 * 864e5)}&to=${day(0)}&token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return send(res, 502, { error: "The news source did not answer." });
    const rows = await r.json();

    /* Finnhub repeats a story once per wire that carries it. Keep the first. */
    const seen = new Set();
    const items = (Array.isArray(rows) ? rows : [])
      .filter((n) => n && n.headline && /^https?:\/\//.test(n.url || ""))
      .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
      .filter((n) => {
        const k = n.headline.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 8)
      .map((n) => ({
        headline: String(n.headline).slice(0, 240),
        summary: String(n.summary || "").slice(0, 400),
        source: String(n.source || ""),
        url: n.url,
        at: n.datetime ? new Date(n.datetime * 1000).toISOString() : null
      }));

    return send(res, 200, { t, items }, {
      "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=3600"
    });
  } catch {
    return send(res, 502, { error: "The news source did not answer." });
  }
}
