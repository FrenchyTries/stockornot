/* ==========================================================================
   /api/news?t=TICKER — the last ten days of headlines for one company.

   News goes stale by the hour, so it cannot ride the nightly snapshot like
   everything else. This asks Finnhub on demand with the key held server-side
   (set FINNHUB_TOKEN in the Vercel project, the same key the Action uses) and
   lets the CDN keep each answer for half an hour, so a popular ticker costs
   one call per half hour however many people open it.
   ========================================================================== */

import { send, query } from "./_lib/http.mjs";
import universe from "../data/sp500.json" with { type: "json" };

/* Only the companies the site covers, and only one spelling of each request.
   The key is shared with the nightly refresh, so every call that misses the
   CDN cache spends from the same quota; "?t=ko", "?t=KO&x=1" and a ticker the
   site never shows would each be a fresh miss. */
const KNOWN = new Set(universe.companies.map((c) => c.t));

export default async function handler(req, res) {
  /* Only GET and HEAD: the CDN caches those, so a burst of requests for one
     ticker costs one call to Finnhub. Any other method would skip the cache
     and spend the shared quota (the nightly refresh uses the same key). */
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { error: "Use GET." }, { Allow: "GET, HEAD" });
  }
  const q = query(req);
  const t = String(q.get("t") || "").toUpperCase();
  if (!KNOWN.has(t)) return send(res, 404, { error: "Unknown ticker." }, { "Cache-Control": "public, max-age=3600, s-maxage=86400" });
  if ([...q.keys()].some((k) => k !== "t") || q.getAll("t").length !== 1 || q.get("t") !== t) {
    res.statusCode = 308;
    res.setHeader("Location", "/api/news?t=" + encodeURIComponent(t));
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.end();
  }

  const token = process.env.FINNHUB_TOKEN;
  if (!token) return send(res, 503, { error: "News is not set up on this server (FINNHUB_TOKEN is missing)." });

  const day = (ms) => new Date(Date.now() - ms).toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(t)}` +
              `&from=${day(10 * 864e5)}&to=${day(0)}&token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    /* A short cache on failure too: when the quota is spent, a burst of
       visitors should not each spend another call finding that out. */
    if (!r.ok) return send(res, 502, { error: "The news source did not answer." }, { "Cache-Control": "public, s-maxage=120" });
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
    return send(res, 502, { error: "The news source did not answer." }, { "Cache-Control": "public, s-maxage=120" });
  }
}
