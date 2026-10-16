/* The site's pages, opened from the iPhone app.

   The app opens Terms, Privacy, Support, How the score works, the track
   record and the company pages in a Safari sheet, at their address on the
   website with ?app=1 (lib/native.mjs routeLinks). The website's deck at /
   has no place in that sheet: it looks just like the app, yet offers the
   brokerage and, once it is on sale, membership, which the app leaves out
   for App Review (docs/APP_STORE.md). So with ?app=1 nothing on the page
   leads there: "Open the deck" and the like are gone, the logo is no longer
   a link, and every other link on the site keeps ?app=1, so the next page
   does the same.

   A plain script in <head>, not a module, so a tap made while the page is
   still loading is caught too. (A file rather than an inline script, so the
   page's Content-Security-Policy can refuse inline scripts outright.) */
(() => {
  if (new URLSearchParams(location.search).get("app") !== "1") return;

  /* the deck, at any of its addresses, and the pricing page it leads to */
  const DECK = /^\/(?:index(?:\.html)?|pricing(?:\.html)?)?$/;
  const target = (a) => { try { return new URL(a.getAttribute("href"), location.href); } catch { return null; } };
  const ours = (u) => u && u.origin === location.origin;
  const toDeck = (a) => { const u = target(a); return ours(u) && DECK.test(u.pathname); };

  document.addEventListener("click", (ev) => {
    const a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
    if (a && toDeck(a)) ev.preventDefault();
  }, true);

  document.addEventListener("DOMContentLoaded", () => {
    for (const a of document.querySelectorAll("a[href]")) {
      const u = target(a);
      if (!ours(u)) continue;
      if (!DECK.test(u.pathname)) {
        u.searchParams.set("app", "1");
        a.setAttribute("href", u.pathname + u.search + u.hash);
      } else if (a.classList.contains("brand")) {
        a.removeAttribute("href");
      } else if (a.className) {
        /* a button ("Open the deck") or a backlink, and the box it sat in
           when that held nothing else */
        const box = a.parentNode;
        a.remove();
        if (box && box !== document.body && !box.children.length && !box.textContent.trim()) box.remove();
      } else {
        a.replaceWith(...a.childNodes);    /* a link in a sentence keeps its words */
      }
    }
  });
})();
