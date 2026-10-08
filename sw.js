/* ==========================================================================
   StockOrNot — service worker

   Lets the site go on a home screen as an app, and open with no signal using
   the last copy it saw. Network first, always: anyone online gets today's
   page, today's scripts and today's prices, exactly as without this file.
   Only when the network fails does it answer from what it kept.

   It keeps only what the app needs to open: the page, its styles, scripts
   and font, the snapshot and the track record. Company pages, charts, news
   and the brokerage are never kept, and nothing from another site is touched.
   ========================================================================== */

const CACHE = "stockornot-v1";
const SHELL = ["/", "/styles.css", "/app.js", "/favicon.svg", "/fonts/inter-var.woff2", "/data/snapshot.json"];
/* the track record too, once it exists; it is not in SHELL, which must all load */
const KEEP = (path) => SHELL.includes(path) || path.startsWith("/lib/") || path === "/data/track.json";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const nav = req.mode === "navigate";
  /* the deck itself, whatever ?t= it was opened with, and its files */
  const keep = nav ? url.pathname === "/" : KEEP(url.pathname);
  if (!keep && !nav) return;                 /* not ours: straight to the network */
  const key = nav ? "/" : url.pathname;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (keep && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      /* offline: the kept copy, and any page at all falls back to the deck */
      .catch(() => caches.match(key).then((hit) => hit || Response.error()))
  );
});
