import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEV_UNLIMITED } from "../lib/tier.mjs";

/* The company pages, /stock and the sitemap, as scripts/build-pages.mjs
   writes them, from a small made-up snapshot in a scratch copy, so nothing
   here depends on tonight's data. */

const ROOT = path.resolve(import.meta.dirname, "..");

const company = (t, over) => ({
  t, n: t + " Inc", s: "Industrials", cik: "c" + t, price: 50, change: 1, lo: 40, hi: 60, mc: 10000,
  pe: 16, ps: 2, pb: 3, roe: 18, roa: 7, nm: 10, gm: 40, rg: 6, rg5: 6, eg: 8, beta: 1, dy: 1.5, de: 0.5,
  r13: 2, r52: 5, fin: { revenue: 5e9, netIncome: 5e8, assets: 1e10, equity: 4e9, fcf: 4e8, ocf: 8e8, debt: 2e9, cash: 5e8, fy: 2025 },
  sec: { tenK: { url: "https://www.sec.gov/x.htm", date: "2026-02-01", accession: "A-" + t } },
  ...over
});

/* Builds the site in a copy holding only what the build reads and
   publishes, with this snapshot and these 10-K readings as its data. */
function build(t, snapshot, filings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stockornot-pages-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const skip = new Set([".git", "node_modules", "public", "stock", "mobile", "marketing", "data", "docs", "tests",
    "supabase", "api", "track.html", "sitemap.xml", "robots.txt"]);
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !skip.has(path.relative(ROOT, src).split(path.sep)[0]) });
  for (const d of ["data/detail", "data/filings"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, "data", "snapshot.json"), JSON.stringify(snapshot));
  for (const [tk, detail] of Object.entries(filings)) {
    fs.writeFileSync(path.join(dir, "data", "filings", tk + ".json"), JSON.stringify({ accession: "A-" + tk, v: 4, detail }));
  }
  const r = spawnSync(process.execPath, [path.join(dir, "scripts", "build-pages.mjs")], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return (f) => fs.readFileSync(path.join(dir, "public", f), "utf8");
}

test("company pages, /stock and the sitemap say what the pages show", (t) => {
  const read = build(t, {
    /* Friday's close, refreshed at 8:33 pm in New York, which is Saturday in UTC */
    updated: "2026-10-10T00:33:44Z",
    session: "2026-10-09",
    stocks: [
      company("NEG", { earnings: { date: "2026-10-29", hour: "bmo", epsEst: -1.3032 } }),
      company("POS", { earnings: { date: "2026-10-29", epsEst: 2.02 } }),
      company("BIZ"),
      company("NONE"),
      /* one company, two listings */
      company("GOOGL", { s: "Communication Services", cik: "1652044" }),
      company("GOOG", { s: "Communication Services", cik: "1652044" }),
      company("META", { s: "Communication Services" })
    ]
  }, {
    NEG: { business: "Makes things.", risks: ["Demand may fall."] },
    POS: { business: "Makes things.", risks: ["Demand may fall."] },
    BIZ: { business: "Makes things.", risks: [] },
    NONE: null
  });

  /* a negative estimate reads as the card writes it */
  assert.match(read("stock/neg.html"), /analysts expecting −\$1\.30 in earnings per share/);
  assert.match(read("stock/pos.html"), /analysts expecting \$2\.02 in earnings per share/);
  assert.doesNotMatch(read("stock/neg.html"), /\$-/);

  /* the title and description promise the 10-K's text only where it was read */
  const title = (f) => read(f).match(/<title>([^<]*)/)[1];
  const description = (f) => read(f).match(/<meta name="description" content="([^"]*)"/)[1];
  assert.match(title("stock/neg.html"), /10-K summary/);
  assert.match(description("stock/neg.html"), /what the 10-K lists as risks\.$/);
  assert.match(title("stock/biz.html"), /10-K summary/);
  assert.match(description("stock/biz.html"), /balance sheet as filed\.$/);
  assert.doesNotMatch(title("stock/none.html"), /10-K/);
  assert.match(description("stock/none.html"), /balance sheet as filed\.$/);
  assert.match(read("stock/none.html"), /could not be read automatically/);
  assert.doesNotMatch(read("stock/neg.html"), /could not be read automatically/);

  /* /stock counts companies, as the sector ranks do, and lists every ticker */
  const index = read("stock/index.html");
  assert.match(index, /Communication Services <span class="count">2<\/span>/);
  assert.match(index, /href="\/stock\/goog"/);
  assert.match(index, /6 companies, grouped by sector \(7 listings/);
  assert.match(description("stock/index.html"), /^6 S&amp;P 500 companies/);

  /* the refresh is dated on New York's calendar, the day of the close beside it */
  assert.match(read("stock/pos.html"), /close of Oct 9, 2026/);
  for (const f of ["stock/pos.html", "stock/index.html", "track.html"]) assert.match(read(f), /Data refreshed Oct 9, 2026\./, f);

  /* every page the app can open in its Safari sheet loads in-app.js in its
     <head>, which takes the website's deck off it there, and the file is
     published beside them */
  for (const f of ["stock/pos.html", "stock/index.html", "track.html", "terms.html", "privacy.html", "support.html", "method.html", "404.html"]) {
    assert.match(read(f).split("</head>")[0], /<script src="\/in-app\.js"><\/script>/, f);
  }
  assert.match(read("in-app.js"), /app=1/);

  /* /pricing stays published for the hidden Membership row, but out of the
     sitemap while membership is closed; back in it once it opens (PAYWALL.md) */
  if (DEV_UNLIMITED) assert.doesNotMatch(read("sitemap.xml"), /pricing/);
  else assert.match(read("sitemap.xml"), /\/pricing</, "membership is open: put /pricing back in the sitemap (PAYWALL.md)");
  assert.match(read("sitemap.xml"), /\/stock\/goog</);
  assert.ok(read("pricing.html").length > 0);
});

test("the pricing page says it is not open before it shows a tier", () => {
  const html = fs.readFileSync(path.join(ROOT, "pricing.html"), "utf8");
  if (!DEV_UNLIMITED) {
    /* membership is open: the page and the terms no longer say it is closed (PAYWALL.md) */
    assert.doesNotMatch(html.replace(/\s+/g, " "), /Not open yet|Nothing is for sale|none of the limits on this page applies/);
    return;
  }
  const notice = html.indexOf('id="notLive"');
  assert.ok(notice > 0 && notice < html.indexOf('class="tiers"'), "the notice comes before the tiers");
  const text = html.slice(notice, html.indexOf("</div>", notice)).replace(/\s+/g, " ");
  assert.match(text, /Not open yet/);
  assert.match(text, /Nothing is for sale/);
  assert.match(text, /none of the limits on this page applies/);
  /* the terms say the same */
  assert.match(fs.readFileSync(path.join(ROOT, "terms.html"), "utf8").replace(/\s+/g, " "), /There is no paid membership today\. Everything StockOrNot offers is free/);
});
