/* ==========================================================================
   Line icons for the five financial checks.

   One stroke weight, one 24px grid, drawn to sit beside text at 15–16px.
   Plain SVG strings so the deck (app.js) and the static pages
   (scripts/build-pages.mjs) show exactly the same marks. They carry no text
   and are always rendered aria-hidden beside a heading that says the same.
   ========================================================================== */

const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;

export const CHECK_ICONS = {
  /* revenue growth: a line stepping up to an arrow */
  growth: svg('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
  /* free cash flow: a banknote */
  cash: svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>'),
  /* profit margins: a percent sign */
  margins: svg('<path d="M18.5 5.5l-13 13"/><circle cx="7" cy="7" r="2.4"/><circle cx="17" cy="17" r="2.4"/>'),
  /* debt vs. cash: a balance */
  balance: svg('<path d="M12 4v16M7 20h10M5 7h14"/><path d="M5 7l-3 6a3 3 0 0 0 6 0z"/><path d="M19 7l-3 6a3 3 0 0 0 6 0z"/>'),
  /* valuation: a price tag */
  value: svg('<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.4"/>')
};
