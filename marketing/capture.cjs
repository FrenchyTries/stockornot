/* ==========================================================================
   Store screenshots, captured from the running site.

     node scripts/dev-server.mjs                        # serves on :8080
     NODE_PATH=$(npm root -g) node marketing/capture.cjs

   Needs Playwright (npm i -g playwright). CHROMIUM_PATH points it at a
   browser binary if it cannot find its own; BASE at another server.

   Writes
     marketing/raw/01-05       the bare screens
     marketing/appstore-01-04  framed for a store listing, 1290 x 2796
     marketing/app-icon-1024   the store icon
     og.png                    the link preview every page names, 1200 x 630
     apple-touch-icon.png      the home-screen icon, 180 x 180

   The cart is seeded with three companies at their real closing prices on the
   day they are shown as added, read from data/detail, so every number in the
   shots is one the app itself produced.
   ========================================================================== */

const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.BASE || "http://localhost:8080";
const RAW = path.join(__dirname, "raw");

const FRAMES = [
  { file: "01-deck",  top: "Every S&amp;P 500 company,", accent: "one card at a time" },
  { file: "02-score", top: "A score you can",            accent: "argue with" },
  { file: "03-books", top: "Five questions, answered",   accent: "from the filings" },
  { file: "04-cart",  top: "Swipe right to keep",        accent: "what caught your eye" }
];

/* [ticker, date added, planned amount, note]; the price is that day's close */
const CART = [
  ["AAPL", "2026-08-24", 500, "Services margin keeps climbing"],
  ["V",    "2026-09-02", 250, ""],
  ["KO",   "2026-09-10", 250, "Dividend, and not much else to worry about"]
];

function seededCart() {
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "snapshot.json"), "utf8"));
  return CART.map(([t, day, amount, note]) => {
    const s = snap.stocks.find((x) => x.t === t);
    const closes = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "detail", t + ".json"), "utf8")).closes;
    const [date, close] = closes.find((r) => r[0] >= day);
    const at = date + "T15:00:00.000Z";
    return { t, n: s.n, sector: s.s, addedAt: at, updatedAt: at, priceAtAdd: close, amount, note };
  });
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  /* no focus ring from a dialog that opened itself */
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForTimeout(500);
}

async function phoneShots(browser) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });
  await ctx.route("https://esm.sh/**", (r) => r.abort());   /* signed-out, as a first visit */
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.evaluate((cart) => localStorage.setItem("ts.cart", JSON.stringify(cart)), seededCart());

  const card = async (t) => {
    await page.goto(`${BASE}/?t=${t}`);
    await page.waitForSelector(".card:not(.is-behind)");
    await settle(page);
  };

  await card("NVDA");
  await page.screenshot({ path: path.join(RAW, "01-deck.png") });

  await card("COST");
  await page.click(".card:not(.is-behind) .more-btn");
  await page.waitForSelector("#dlgDetail[open] #detailBody section");
  await settle(page);
  await page.screenshot({ path: path.join(RAW, "02-score.png") });

  await card("META");
  await page.$eval(".card:not(.is-behind) .c-checks", (e) => {
    const s = e.closest(".card-scroll"); s.scrollTop = e.offsetTop - 12;
  });
  await settle(page);
  await page.screenshot({ path: path.join(RAW, "03-books.png") });

  await card("NVDA");
  await page.click("#btnCart");
  await page.waitForSelector("#dlgCart[open]");
  await settle(page);
  await page.screenshot({ path: path.join(RAW, "04-cart.png") });
  await ctx.close();
}

async function desktopShot(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  await ctx.route("https://esm.sh/**", (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.evaluate((cart) => localStorage.setItem("ts.cart", JSON.stringify(cart)), seededCart());
  await page.goto(BASE + "/?t=NVDA");
  await page.waitForSelector(".card:not(.is-behind)");
  await settle(page);
  await page.screenshot({ path: path.join(RAW, "05-desktop.png") });
  await ctx.close();
}

const LOGO = '<svg viewBox="0 0 100 100"><rect width="100" height="100" rx="24" fill="#4c8dff"/><path d="M22 64 L41 45 L56 57 L78 33" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FONT_FACE = `@font-face { font-family: Inter; src: url("file://${path.join(ROOT, "fonts", "inter-var.woff2")}") format("woff2"); font-weight: 100 900; }`;

/* the link preview: the real card beside the name and what the site does */
async function ogImage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 2 });
  await ctx.route("https://esm.sh/**", (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(BASE + "/?t=MSFT");
  const card = await page.waitForSelector(".card:not(.is-behind)");
  await settle(page);
  const cardPng = path.join(RAW, ".og-card.png");
  await card.screenshot({ path: cardPng });
  await ctx.close();

  await renderHtml(browser, 1200, 630, path.join(ROOT, "og.png"), `<style>
${FONT_FACE}
html, body { margin: 0; }
body { width: 1200px; height: 630px; overflow: hidden; position: relative; font-family: Inter, sans-serif; color: #eceef1;
  background: radial-gradient(900px 520px at 0% 0%, rgba(76,141,255,.16), transparent 60%), #0b0c0e; -webkit-font-smoothing: antialiased; }
.brand { position: absolute; left: 72px; top: 64px; display: flex; align-items: center; gap: 14px; font-size: 28px; font-weight: 500; letter-spacing: -0.02em; }
.brand b { font-weight: 700; }
.brand svg { width: 48px; height: 48px; }
h1 { position: absolute; left: 72px; top: 178px; width: 560px; margin: 0; font-size: 62px; line-height: 1.04; font-weight: 700; letter-spacing: -0.035em; }
h1 span { color: #8ab4ff; }
p { position: absolute; left: 72px; top: 336px; width: 520px; margin: 0; font-size: 23px; line-height: 1.45; color: #b3b9c2; letter-spacing: -0.01em; }
.url { position: absolute; left: 72px; bottom: 60px; font-size: 19px; color: #7d848e; font-weight: 500; }
.card { position: absolute; right: 72px; top: 64px; width: 440px; border-radius: 14px; box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 0 0 1px #23272e; }
.fade { position: absolute; right: 60px; bottom: 0; width: 470px; height: 90px; background: linear-gradient(transparent, #0b0c0e); }
</style>
<div class="brand">${LOGO}<span>Stock<b>OrNot</b></span></div>
<h1>Read the numbers, <span>then swipe.</span></h1>
<p>Every S&amp;P 500 company, one card at a time. The score, the filings and the case both ways.</p>
<div class="url">stockornot.com</div>
<img class="card" src="file://${cardPng}">
<div class="fade"></div>`);
  fs.unlinkSync(cardPng);
}

/* square and full-bleed: iOS and the stores round the corners themselves */
async function icons(browser) {
  const html = `<style>html, body { margin: 0; } svg { display: block; width: 100vw; height: 100vh; }</style>
<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#4c8dff"/><path d="M22 64 L41 45 L56 57 L78 33" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  await renderHtml(browser, 180, 180, path.join(ROOT, "apple-touch-icon.png"), html);
  await renderHtml(browser, 1024, 1024, path.join(__dirname, "app-icon-1024.png"), html);
}

async function renderHtml(browser, width, height, out, body) {
  const tmp = path.join(RAW, ".render.html");
  fs.writeFileSync(tmp, `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`);
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto("file://" + tmp);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  await page.screenshot({ path: out });
  await page.close();
  fs.unlinkSync(tmp);
}

function frameHtml(f) {
  const shot = "file://" + path.join(RAW, f.file + ".png");
  return `<style>
${FONT_FACE}
html, body { margin: 0; }
body { width: 1290px; height: 2796px; overflow: hidden; font-family: Inter, sans-serif; -webkit-font-smoothing: antialiased;
  background: radial-gradient(1300px 900px at 50% -10%, rgba(76,141,255,.20), transparent 65%), #0b0c0e; }
h1 { margin: 0; padding: 150px 60px 0; text-align: center; font-size: 96px; line-height: 1.08; font-weight: 700;
  letter-spacing: -0.035em; color: #eceef1; }
h1 span { display: block; color: #8ab4ff; }
.device { position: absolute; left: 140px; top: 470px; width: 1010px; height: 2190px; padding: 14px; border-radius: 96px;
  background: #16181c; box-shadow: 0 0 0 2px #2a2e35, 0 60px 160px rgba(0,0,0,.6); }
.device img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; border-radius: 82px; }
</style><h1>${f.top}<span>${f.accent}</span></h1>
<div class="device"><img src="${shot}"></div>`;
}

async function framed(browser) {
  for (const f of FRAMES) {
    await renderHtml(browser, 1290, 2796, path.join(__dirname, `appstore-${f.file}.png`), frameHtml(f));
  }
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    await phoneShots(browser);
    await desktopShot(browser);
    await framed(browser);
    await ogImage(browser);
    await icons(browser);
  } finally {
    await browser.close();
  }
  console.log("Wrote marketing/raw/01-05, marketing/appstore-01-04, marketing/app-icon-1024.png, og.png and apple-touch-icon.png.");
})().catch((err) => { console.error(err); process.exit(1); });
