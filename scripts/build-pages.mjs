/* ==========================================================================
   StockOrNot — static company pages
   --------------------------------------------------------------------------
   The app is one URL, which gives a search engine exactly one page to index.
   This writes a real HTML page per company from the same snapshot the app
   uses — text in the markup, not assembled by JavaScript afterwards — plus a
   directory page, a sitemap and robots.txt.

   Runs after scripts/refresh.mjs in the same Action. No API calls, no key.
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import {
  num, money, cap, price, pct, pctPlain, x, dateShort, rangePos,
  FACTORS, scoreStock, scoreLabel, prosAndCons, buildScoreContext,
  splitAdjustShares, shareCountNote
} from "../lib/analysis.mjs";

const ROOT   = path.resolve(import.meta.dirname, "..");
const DATA   = path.join(ROOT, "data");
const OUTDIR = path.join(ROOT, "stock");
const SITE   = process.env.SITE_ORIGIN || "https://stockornot.com";

/* ------------------------------------------------------------- utilities */

const esc = (v) =>
  String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const slug = (ticker) => ticker.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const safeName = (ticker) => ticker.replace(/[^A-Z0-9.]/gi, "_");

async function readJSON(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

/* ------------------------------------------------------------- fragments */

function head(title, description, canonical, extra = "") {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta name="color-scheme" content="dark" />
<meta name="theme-color" content="#0d0d0d" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta name="twitter:card" content="summary" />
<link rel="icon" href="/favicon.svg" />
<link rel="stylesheet" href="/styles.css" />
${extra}
</head>
<body class="docpage">
<header class="topbar">
  <a class="brand" href="/">
    <svg class="logo" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="22" fill="#151514"/><path d="M20 66 L40 44 L56 58 L80 30" stroke="#3987e5" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span>Stock<b>OrNot</b></span>
  </a>
  <div class="topbar-actions">
    <a class="ghost-btn" href="/stock/"><span>All companies</span></a>
    <a class="ghost-btn accent has-items" href="/"><span>Open the deck</span></a>
  </div>
</header>
<main class="doc">`;
}

const foot = (updated) => `</main>
<footer class="sitefoot">
  <p><b>Not investment advice.</b> Every figure here comes from Finnhub or the company's own
  SEC filings and may be stale, mis-parsed or wrong. Read the actual filing before you buy anything.
  <a href="/method">How the score works</a>.</p>
  <p class="muted">${updated ? "Data refreshed " + esc(dateShort(updated.slice(0, 10))) + ". " : ""}Market data by
    <a href="https://finnhub.io" rel="noopener">Finnhub</a> · filings from
    <a href="https://www.sec.gov/edgar" rel="noopener">SEC EDGAR</a> ·
    <a href="/">StockOrNot</a></p>
</footer>
</body>
</html>`;

function statTable(rows) {
  return `<table class="doc-table"><tbody>${rows
    .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join("")}</tbody></table>`;
}

function historyTable(history) {
  if (!history || !history.revenue) return "";
  const years = Object.keys(history.revenue).map(Number).sort((a, b) => b - a).slice(0, 5);
  if (!years.length) return "";

  const rows = [
    ["revenue", "Revenue"], ["grossProfit", "Gross profit"], ["opIncome", "Operating income"],
    ["netIncome", "Net income"], ["ocf", "Operating cash flow"], ["capex", "Capital expenditure"],
    ["assets", "Total assets"], ["liabs", "Total liabilities"], ["equity", "Shareholder equity"],
    ["cash", "Cash"], ["debt", "Long-term debt"]
  ].filter(([k]) => history[k]);

  const body = rows.map(([k, label]) =>
    `<tr><th scope="row">${esc(label)}</th>${years
      .map((y) => `<td>${esc(money(history[k][y]))}</td>`).join("")}</tr>`).join("");

  let derived = "";
  if (history.ocf && history.capex) {
    derived += `<tr class="is-derived"><th scope="row">Free cash flow</th>${years.map((y) => {
      const o = history.ocf[y], c = history.capex[y];
      return `<td>${esc(num(o) && num(c) ? money(o - c) : "—")}</td>`;
    }).join("")}</tr>`;
  }
  for (const [k, label] of [["grossProfit", "Gross margin"], ["opIncome", "Operating margin"], ["netIncome", "Net margin"]]) {
    if (!history[k]) continue;
    derived += `<tr class="is-derived"><th scope="row">${esc(label)}</th>${years.map((y) => {
      const v = history[k][y], r = history.revenue[y];
      return `<td>${esc(num(v) && num(r) && r !== 0 ? ((v / r) * 100).toFixed(1) + "%" : "—")}</td>`;
    }).join("")}</tr>`;
  }
  const adjShares = splitAdjustShares(history.shares).shares;
  if (adjShares) {
    derived += `<tr><th scope="row">Diluted shares</th>${years
      .map((y) => `<td>${esc(num(adjShares[y]) ? money(adjShares[y], false) : "—")}</td>`).join("")}</tr>`;
  }

  const note = shareCountNote(history.shares);

  return `<div class="table-scroll"><table class="fin-table">
<thead><tr><th></th>${years.map((y) => `<th>FY${y}</th>`).join("")}</tr></thead>
<tbody>${body}${derived}</tbody></table></div>` +
    (note ? `<p class="fin-note">${esc(note)}</p>` : "");
}

/* ------------------------------------------------------------- one company */

/* Every company is scored partly against its own sector, so the pages need
   the whole snapshot in view. Set once in main(). */
let CTX = null;

function companyPage(s, filing, deep, siblings, updated) {
  const res = scoreStock(s, CTX);
  const label = scoreLabel(res.overall);
  const pc = prosAndCons(s, CTX);
  const pos = rangePos(s);
  const url = `${SITE}/stock/${slug(s.t)}`;

  const title = `${s.n} (${s.t}): financials, earnings date and 10-K summary`;
  const description =
    `${s.n} (${s.t}) at ${price(s.price)}, ${cap(s.mc)} market cap. ` +
    (num(s.pe) && s.pe > 0 ? `${x(s.pe)} earnings, ` : "") +
    (num(s.rg) ? `revenue ${pct(s.rg)} year over year, ` : "") +
    `plus the balance sheet as filed and what the 10-K lists as risks.`;

  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Corporation",
    name: s.n,
    tickerSymbol: s.t,
    url,
    identifier: s.cik ? `CIK${s.cik}` : undefined,
    sameAs: s.cik
      ? [`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${s.cik}&type=10-K`]
      : undefined
  };

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "All companies", item: `${SITE}/stock/` },
      { "@type": "ListItem", position: 2, name: `${s.n} (${s.t})`, item: url }
    ]
  };

  const extra =
    `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>\n` +
    `<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>`;

  const dir = !num(s.change) ? "flat" : s.change > 0.005 ? "up" : s.change < -0.005 ? "down" : "flat";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "–";

  const earnings = s.earnings && s.earnings.date
    ? `<p class="doc-lead">Next reports on <b>${esc(dateShort(s.earnings.date))}</b>` +
      (s.earnings.hour === "bmo" ? ", before the open" : s.earnings.hour === "amc" ? ", after the close" : "") +
      (num(s.earnings.epsEst) ? `, with analysts expecting $${s.earnings.epsEst.toFixed(2)} in earnings per share` : "") +
      `.</p>`
    : `<p class="doc-lead">No earnings date is scheduled in the next few months.</p>`;

  const factorRows = FACTORS.map((f) => {
    const v = res.factors[f.id];
    return `<tr><th scope="row">${esc(f.label)}<span class="fl-blurb">${esc(f.blurb)}</span></th>` +
           `<td>${num(v) ? Math.round(v) : "n/a"}</td></tr>`;
  }).join("");

  const list = (items, cls) => items.length
    ? `<ul class="doc-list ${cls}">${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
    : `<p class="block-note">${cls === "pro" ? "Nothing in the numbers stands out as a strength."
        : "Nothing in these numbers stands out as a concern. That is not the same as no risk: read the risk factors below."}</p>`;

  return head(title + " | StockOrNot", description, url, extra) + `
<nav class="crumbs"><a href="/stock/">All companies</a> <span>/</span> <span>${esc(s.t)}</span></nav>

<h1>${esc(s.n)} <span class="h1-ticker">(${esc(s.t)})</span></h1>
<p class="doc-sub">${esc(s.s)} · ${esc(cap(s.mc))} market cap${s.cik ? ` · SEC CIK ${esc(s.cik)}` : ""}</p>

<div class="doc-hero">
  <div class="hero-price">
    <span class="hero-num">${esc(price(s.price))}</span>
    <span class="delta ${dir}"><span class="arrow">${arrow}</span><span>${esc(pct(s.change, 2))} on the day</span></span>
    <span class="hero-asof">as of ${esc(dateShort((updated || "").slice(0, 10)))}</span>
  </div>
  <div class="hero-score">
    <span class="hero-score-num">${num(res.overall) ? res.overall : "—"}</span>
    <span class="hero-score-lab">${esc(label.word)}<br><span class="muted">fundamentals score out of 100</span></span>
  </div>
</div>

${earnings}

<h2>The case for ${esc(s.t)}</h2>
${list(pc.pros, "pro")}

<h2>The case against</h2>
${list(pc.cons, "con")}

<h2>What the score is made of</h2>
<p class="block-note">Each factor is a curve over reported figures, blended by weight. It describes the
last filing and the current price. It is not a forecast.</p>
<table class="doc-table factor-table"><tbody>${factorRows}</tbody></table>

<h2>Key numbers</h2>
${statTable([
  ["Price / earnings", num(s.pe) && s.pe > 0 ? x(s.pe) : "n/a"],
  ["Price / book", num(s.pb) && s.pb > 0 ? x(s.pb, 2) : "n/a"],
  ["Price / sales", num(s.ps) && s.ps > 0 ? x(s.ps, 1) : "n/a"],
  ["Revenue growth (YoY)", pct(s.rg)],
  ["EPS growth (YoY)", pct(s.eg)],
  ["Gross margin", pctPlain(s.gm, 0)],
  ["Operating margin", pctPlain(s.om, 0)],
  ["Net margin", pctPlain(s.nm, 0)],
  ["Return on equity", pctPlain(s.roe, 0)],
  ["Debt / equity", num(s.de) ? x(s.de, 2) : "n/a"],
  ["Current ratio", num(s.cr) ? s.cr.toFixed(2) : "n/a"],
  ["Dividend yield", num(s.dy) && s.dy > 0 ? pctPlain(s.dy, 2) : "none"],
  ["Beta", num(s.beta) ? s.beta.toFixed(2) : "n/a"],
  ["52-week range", num(s.lo) && num(s.hi) ? `${price(s.lo)} – ${price(s.hi)}` : "n/a"],
  ["Position in that range", pos === null ? "n/a" : Math.round(pos * 100) + "% of the way up"],
  ["3-month return", pct(s.r13)],
  ["1-year return", pct(s.r52)]
])}

${deep && deep.history && deep.history.revenue ? `<h2>Five years of financials, as filed</h2>
<p class="block-note">Pulled from ${esc(s.n)}'s XBRL filings on SEC EDGAR. Italic rows are derived from the rows above.</p>
${historyTable(deep.history)}` : ""}

${filing && filing.business ? `<h2>What ${esc(s.n)} says it does</h2>
<p class="doc-quote">${esc(filing.business)}</p>` : ""}

${filing && filing.risks && filing.risks.length ? `<h2>Risk factors ${esc(s.t)} lists in its 10-K</h2>
<ul class="doc-list risk">${filing.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}

<h2>Filings</h2>
<div class="filing-links">
${s.sec && s.sec.tenK && s.sec.tenK.url ? `<a class="filing-link" href="${esc(s.sec.tenK.url)}" rel="noopener">10-K filed ${esc(dateShort(s.sec.tenK.date))}</a>` : ""}
${s.sec && s.sec.tenQ && s.sec.tenQ.url ? `<a class="filing-link" href="${esc(s.sec.tenQ.url)}" rel="noopener">10-Q filed ${esc(dateShort(s.sec.tenQ.date))}</a>` : ""}
<a class="filing-link" href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&amp;CIK=${esc(s.cik || s.t)}&amp;type=10-K&amp;dateb=&amp;owner=include&amp;count=40" rel="noopener">All filings on EDGAR</a>
</div>

<div class="doc-cta">
  <a class="primary-btn" href="/?t=${esc(s.t)}">Open ${esc(s.t)} in the deck</a>
</div>

${siblings.length ? `<h2>Other ${esc(s.s)} companies</h2>
<div class="peer-grid">${siblings.map((p) =>
  `<a class="peer" href="/stock/${slug(p.t)}"><b>${esc(p.t)}</b><span>${esc(p.n)}</span></a>`).join("")}</div>` : ""}
` + foot(updated);
}

/* ------------------------------------------------------------- the index */

function indexPage(stocks, updated) {
  const bySector = {};
  for (const s of stocks) (bySector[s.s] ||= []).push(s);
  const sectors = Object.keys(bySector).sort();

  const body = sectors.map((sec) => {
    const rows = bySector[sec]
      .slice()
      .sort((a, b) => (b.mc || 0) - (a.mc || 0))
      .map((s) => {
        const res = scoreStock(s, CTX);
        return `<tr>
<th scope="row"><a href="/stock/${slug(s.t)}"><b>${esc(s.t)}</b> <span>${esc(s.n)}</span></a></th>
<td>${esc(price(s.price))}</td>
<td>${esc(cap(s.mc))}</td>
<td>${num(res.overall) ? res.overall : "—"}</td>
</tr>`;
      }).join("");
    return `<h2 id="${slug(sec)}">${esc(sec)} <span class="count">${bySector[sec].length}</span></h2>
<div class="table-scroll"><table class="doc-table list">
<thead><tr><th>Company</th><th>Price</th><th>Market cap</th><th>Score</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
  }).join("\n");

  const title = "Every S&P 500 company: financials, earnings dates and 10-K summaries | StockOrNot";
  const description =
    `All ${stocks.length} companies in the S&P 500, each with its valuation, margins, balance sheet ` +
    `as filed, next earnings date and the risk factors from its own 10-K.`;

  return head(title, description, `${SITE}/stock/`) + `
<h1>Every company in the S&amp;P 500</h1>
<p class="doc-sub">${stocks.length} companies, grouped by sector. Each page carries the valuation,
five years of financials as filed, the next earnings date and the risk factors from the company's own 10-K.</p>
<nav class="sector-nav">${sectors.map((sec) => `<a href="#${slug(sec)}">${esc(sec)}</a>`).join("")}</nav>
${body}
` + foot(updated);
}

/* ------------------------------------------------------------------ main */

async function main() {
  const snap = await readJSON(path.join(DATA, "snapshot.json"));
  CTX = buildScoreContext(snap?.stocks || []);
  if (!snap?.stocks?.length) {
    console.error("No snapshot to build from. Run scripts/refresh.mjs first.");
    process.exit(1);
  }

  await fs.mkdir(OUTDIR, { recursive: true });

  /* clear out pages for companies that have left the index */
  const keep = new Set(snap.stocks.map((s) => slug(s.t) + ".html"));
  keep.add("index.html");
  for (const f of await fs.readdir(OUTDIR).catch(() => [])) {
    if (f.endsWith(".html") && !keep.has(f)) await fs.unlink(path.join(OUTDIR, f));
  }

  const bySector = {};
  for (const s of snap.stocks) (bySector[s.s] ||= []).push(s);

  let written = 0;
  for (const s of snap.stocks) {
    const [filing, deep] = await Promise.all([
      readJSON(path.join(DATA, "filings", safeName(s.t) + ".json")),
      readJSON(path.join(DATA, "detail", safeName(s.t) + ".json"))
    ]);
    const siblings = (bySector[s.s] || [])
      .filter((p) => p.t !== s.t)
      .sort((a, b) => (b.mc || 0) - (a.mc || 0))
      .slice(0, 12);

    const html = companyPage(s, filing?.detail || null, deep, siblings, snap.updated);
    await fs.writeFile(path.join(OUTDIR, slug(s.t) + ".html"), html);
    written++;
  }

  await fs.writeFile(path.join(OUTDIR, "index.html"), indexPage(snap.stocks, snap.updated));

  /* ---- sitemap + robots ---- */
  const today = (snap.updated || new Date().toISOString()).slice(0, 10);
  const urls = [
    { loc: `${SITE}/`, pri: "1.0", freq: "daily" },
    { loc: `${SITE}/stock/`, pri: "0.9", freq: "daily" },
    { loc: `${SITE}/method`, pri: "0.8", freq: "monthly" },
    ...snap.stocks.map((s) => ({ loc: `${SITE}/stock/${slug(s.t)}`, pri: "0.7", freq: "daily" }))
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join("\n")}
</urlset>`;
  await fs.writeFile(path.join(ROOT, "sitemap.xml"), sitemap);

  await fs.writeFile(path.join(ROOT, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

  console.log(`Built ${written} company pages + index, sitemap with ${urls.length} URLs.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
