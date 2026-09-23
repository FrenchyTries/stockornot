/* ==========================================================================
   StockOrNot — the second look
   --------------------------------------------------------------------------
   Figures that help when picking, shown beside the score rather than inside
   it: ratios worked out from numbers already in the snapshot, where a company
   sits against the rest of its sector, its nearest peers, what the street has
   been saying and what the price chart shows. Everything here is derived from
   data the page already has; nothing is predicted.

   Half of each factor in the score is already a rank within the sector (see
   lib/analysis.mjs). The sector view shows the raw figures behind that: the
   same number, set against companies that actually do similar things, using
   the same pools and the same exclusions as the score, so one figure never
   gets two different ranks on one screen.
   ========================================================================== */

import { num, money, pct, pctPlain, x, inputs, PEER_METRICS, rankAmong } from "./analysis.mjs";

/* --------------------------------------------------------- derived ratios */

export function derived(s) {
  const f = s.fin || {};
  return {
    /* Lynch's shortcut: the P/E divided by the growth rate that justifies it.
       Only meaningful when both are positive and growth is not a one-off
       rebound from a terrible year. */
    peg: inputs(s).peg,
    /* a bank's "free cash flow" is mostly lending and deposits moving */
    fcfYield: inputs(s).fcfYield,
    earnYield: num(s.pe) && s.pe > 0 ? 100 / s.pe : null,
    netCash: num(f.cash) && num(f.debt) ? f.cash - f.debt : null,
    niGrowth: num(f.netIncome) && num(f.netIncomePrev) && f.netIncomePrev > 0
      ? ((f.netIncome - f.netIncomePrev) / f.netIncomePrev) * 100 : null
  };
}

/* ----------------------------------------------------- the grouped numbers

   Each row is [label, value, hint, optional]. An optional row belongs to a
   field the daily refresh only started collecting recently, so until it has
   run it is left out rather than printed as a column of "n/a". */

export function numberGroups(s) {
  const d = derived(s);
  const k = inputs(s);
  const pos = (v) => num(v) && v > 0;
  const opt = true;
  /* "n/m": not meaningful. Printed rather than hidden, so the gap is explained. */
  const nm = k.negEquity ? "n/m (negative equity)" : "n/m (equity a sliver of assets)";

  return [
    { title: "Valuation", rows: [
      ["P/E",            pos(s.pe) ? x(s.pe) : "n/a", "Price divided by the last twelve months of earnings per share."],
      ["Forward P/E",    pos(s.pef) ? x(s.pef) : null, "Price divided by next year's expected earnings.", opt],
      ["PEG",            num(d.peg) ? d.peg.toFixed(2) : "n/a", "P/E divided by EPS growth. Under 1 means the price looks low for the growth; over 2 means growth is well paid for."],
      ["Price / book",   k.pbOk ? x(s.pb, 2) : pos(s.pb) && (k.negEquity || k.thinEquity) ? nm : "n/a", "Price against the net assets on the balance sheet. Left out when those net assets are negative or tiny."],
      ["Price / sales",  pos(s.ps) ? x(s.ps, 1) : "n/a", "Market cap against a year of revenue."],
      ["Price / FCF",    pos(s.pfcf) ? x(s.pfcf, 1) : null, "Price against free cash flow per share.", opt],
      ["EV / EBITDA",    pos(s.evEbitda) ? x(s.evEbitda, 1) : null, "Whole-company value, debt included, against operating earnings before depreciation.", opt],
      ["FCF yield",      num(d.fcfYield) ? pctPlain(d.fcfYield, 1) : k.financial ? "n/m (financial)" : "n/a", "Last year's free cash flow as a share of today's market cap. The cash return if the business paid it all out. Not meaningful for banks and insurers, whose cash flow is mostly lending and deposits."]
    ]},
    { title: "Growth", rows: [
      ["Revenue, 1yr",   k.rgSuspect ? pct(s.rg) + "*" : pct(s.rg), k.rgSuspect
        ? "Revenue over the last twelve months against the twelve before. *Far out of line with the five-year trend, which in the Financials sector is usually interest income swinging with rates; the score and the sector ranks use the five-year figure instead."
        : "Revenue over the last twelve months against the twelve before."],
      ["Revenue, 5yr",   num(s.rg5) ? pct(s.rg5) + "/yr" : "n/a", "Average yearly revenue growth over five years."],
      ["EPS, 1yr",       pct(s.eg), "Earnings per share against a year earlier."],
      ["EPS, 5yr",       num(s.eg5) ? pct(s.eg5) + "/yr" : null, "Average yearly EPS growth over five years.", opt],
      ["Net income",     num(d.niGrowth) ? pct(d.niGrowth) : "n/a", "Last full year's net income against the year before, as filed."]
    ]},
    { title: "Profitability", rows: [
      ["Gross margin",   pctPlain(s.gm, 0), "What is left of each dollar of sales after the direct cost of making it."],
      ["Op. margin",     pctPlain(s.om, 0), "What is left after running the business as well."],
      ["Net margin",     pctPlain(s.nm, 0), "What is left after interest and tax."],
      ["ROE",            k.roeOk || !num(s.roe) ? pctPlain(s.roe, 0) : nm, "Profit as a share of shareholders' equity. Left out when equity is negative or tiny, where it reads in the hundreds of percent."],
      ["ROA",            pctPlain(s.roa, 0), "Profit as a share of everything the company owns. Harder to flatter with debt than ROE."]
    ]},
    { title: "Balance sheet", rows: [
      ["Debt / equity",  num(s.de) && (k.negEquity || k.thinEquity) ? nm : num(s.de) ? x(s.de, 2) : "n/a", "Total debt against shareholders' equity. Left out when equity is negative or tiny, where it reads in the hundreds."],
      ["Current ratio",  num(s.cr) ? s.cr.toFixed(2) : "n/a", "Current assets over bills due within the year."],
      ["Quick ratio",    num(s.qr) ? s.qr.toFixed(2) : null, "Like the current ratio, without counting inventory.", opt],
      ["Interest cover", num(s.ic) ? x(s.ic, 1) : null, "Operating profit over interest paid. Under 3× is thin.", opt],
      [num(d.netCash) && d.netCash < 0 ? "Net debt" : "Net cash",
                         num(d.netCash) ? money(Math.abs(d.netCash)) : "n/a", "Cash on hand minus long-term debt, from the last annual filing."]
    ]},
    { title: "Dividend", rows: [
      ["Yield",          pos(s.dy) ? pctPlain(s.dy, 2) : "none", "Indicated annual dividend over today's price."],
      ["Payout ratio",   pos(s.dy) && num(s.payout) ? pctPlain(s.payout, 0) : pos(s.dy) ? "n/a" : "—", "Share of earnings paid out. Above 80% leaves little room if profits dip."],
      ["Growth, 5yr",    num(s.dg5) && pos(s.dy) ? pct(s.dg5) + "/yr" : null, "Average yearly growth of the dividend over five years.", opt]
    ]},
    { title: "Price", rows: [
      ["Beta",           num(s.beta) ? s.beta.toFixed(2) : "n/a", "How hard it moves with the market. 1 moves with it; 2 moves twice as far."],
      ["3mo return",     pct(s.r13), "Price change over thirteen weeks."],
      ["6mo return",     pct(s.r26), "Price change over twenty-six weeks."],
      ["1yr return",     pct(s.r52), "Price change over fifty-two weeks."],
      ["Year to date",   num(s.ytd) ? pct(s.ytd) : null, "Price change since the first trading day of the year.", opt],
      ["vs S&P 500, 1yr", num(s.rs52) ? pct(s.rs52) : null, "One-year return minus the index's. Positive means it beat the market.", opt],
      ["Avg volume",     num(s.vol) && s.vol > 0 ? money(s.vol * 1e6, false) + "/day" : null, "Shares traded on an average day over the last ten sessions.", opt]
    ]}
  ].map((g) => ({ title: g.title, rows: g.rows.filter((r) => !(r[3] && r[1] === null)) }))
   .filter((g) => g.rows.length);
}

/* ============================================================ SECTORS =====
   Built once per snapshot: for each sector and each metric, the sorted
   values. A percentile is then a binary search rather than a scan. */

/* The card's rows, in order. Each reads its figure from the score's own
   getter (lib/analysis.mjs PEER_METRICS), so the exclusions match: ROE only
   where equity makes it meaningful and ROA in its place otherwise, no bank
   revenue artefacts, bank cash flow or bank debt, no debt-to-equity on
   negative or thin equity. Dividend and one-year return are not in the score. */
const peer = (key) => PEER_METRICS.find((m) => m.key === key).get;

export const SECTOR_METRICS = [
  { id: "pe",   label: "P/E",           get: peer("pe"),   fmt: (v) => x(v),           lower: true,  verb: "cheaper than" },
  { id: "ps",   label: "Price / sales", get: peer("ps"),   fmt: (v) => x(v, 1),        lower: true,  verb: "cheaper than" },
  { id: "fcfy", label: "FCF yield",     get: peer("fcfy"), fmt: (v) => pctPlain(v, 1), lower: false, verb: "higher than" },
  { id: "rg",   label: "Revenue growth",get: peer("rg"),   fmt: (v) => pct(v),         lower: false, verb: "faster than" },
  { id: "nm",   label: "Net margin",    get: peer("nm"),   fmt: (v) => pctPlain(v, 0), lower: false, verb: "wider than" },
  { id: "roe",  label: "ROE",           get: peer("roe"),  fmt: (v) => pctPlain(v, 0), lower: false, verb: "higher than" },
  { id: "roa",  label: "ROA",           get: peer("roa"),  fmt: (v) => pctPlain(v, 1), lower: false, verb: "higher than" },
  { id: "de",   label: "Debt / equity", get: peer("de"),   fmt: (v) => x(v, 2),        lower: true,  verb: "less indebted than" },
  { id: "dy",   label: "Dividend yield",get: (s) => (num(s.dy) ? s.dy : 0),            fmt: (v) => (v > 0 ? pctPlain(v, 2) : "none"), lower: false, verb: "pays more than" },
  { id: "r52",  label: "1yr return",    get: (s) => (num(s.r52) ? s.r52 : null),       fmt: (v) => pct(v),         lower: false, verb: "ahead of" }
];

/* One entry per company: a second share class (GOOG beside GOOGL) has the
   same filings and figures, and would otherwise be counted twice and turn up
   as its own closest peer. */
export function buildSectorStats(stocks) {
  const bySector = new Map();
  for (const s of stocks) {
    if (!s.s) continue;
    let rec = bySector.get(s.s);
    if (!rec) { rec = { count: 0, members: [], values: {}, own: new Map() }; bySector.set(s.s, rec); }
    const id = s.cik || s.t;
    if (rec.own.has(id)) continue;
    const own = {};
    rec.own.set(id, own);
    rec.count++;
    rec.members.push(s);
    for (const m of SECTOR_METRICS) {
      const v = m.get(s);
      if (num(v)) { (rec.values[m.id] ||= []).push(v); own[m.id] = v; }
    }
  }
  for (const rec of bySector.values()) {
    for (const id of Object.keys(rec.values)) rec.values[id].sort((a, b) => a - b);
  }
  return bySector;
}

function median(sorted) {
  if (!sorted?.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One row per metric that both this company and at least four other
    companies in its sector report. `share` is the share of those others it
    beats; ties count for neither side. */
export function sectorView(s, stats) {
  const rec = stats?.get(s.s);
  if (!rec) return null;
  const own = rec.own.get(s.cik || s.t) || {};
  const rows = [];
  for (const m of SECTOR_METRICS) {
    const v = m.get(s);
    const all = rec.values[m.id];
    if (!num(v) || !all || all.length < 5) continue;
    const r = rankAmong(all, v, m.lower, own[m.id]);
    if (!r) continue;
    rows.push({
      id: m.id, label: m.label,
      value: m.fmt(v), median: m.fmt(median(all)),
      share: r.beats,                            /* 0-100, higher is the "better" end */
      text: m.verb + " " + r.beats + "%",
      peers: r.others                            /* the other companies it was ranked against */
    });
  }
  return { sector: s.s, count: rec.count, rows };
}

/** The companies closest in size within the sector, largest first. */
export function nearestPeers(s, stats, n = 5) {
  const rec = stats?.get(s.s);
  if (!rec || !num(s.mc)) return [];
  const logMc = Math.log(s.mc);
  return rec.members
    .filter((p) => p.t !== s.t && !(s.cik && p.cik === s.cik) && num(p.mc) && p.mc > 0)
    .map((p) => ({ p, d: Math.abs(Math.log(p.mc) - logMc) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((e) => e.p)
    .sort((a, b) => b.mc - a.mc);
}

/* ============================================================ THE STREET */

/** Latest month of ratings, as shares of the whole, plus the direction since
    the month before. */
export function consensus(analyst) {
  const trend = analyst?.trend || [];
  const now = trend[0];
  if (!now) return null;
  const buy = (now.strongBuy || 0) + (now.buy || 0);
  const hold = now.hold || 0;
  const sell = (now.sell || 0) + (now.strongSell || 0);
  const total = buy + hold + sell;
  if (!total) return null;

  let shift = null;
  const then = trend[1];
  if (then) {
    const tb = (then.strongBuy || 0) + (then.buy || 0);
    const tt = tb + (then.hold || 0) + (then.sell || 0) + (then.strongSell || 0);
    if (tt) shift = Math.round((buy / total) * 100) - Math.round((tb / tt) * 100);
  }
  return {
    period: now.period, total, buy, hold, sell,
    buyPct: Math.round((buy / total) * 100),
    holdPct: Math.round((hold / total) * 100),
    sellPct: Math.round((sell / total) * 100),
    shift
  };
}

/** How often reported EPS has come in at or above the estimate. */
export function beatRecord(analyst, n = 4) {
  const rows = (analyst?.earnings || [])
    .filter((e) => num(e.actual) && num(e.estimate))
    .slice(0, n);
  if (!rows.length) return null;
  const beats = rows.filter((e) => e.actual >= e.estimate).length;
  /* One aggregate surprise, not a mean of percentages: a quarter with an
     estimate near zero turns a two-cent miss into -400% and swamps the rest.
     With any estimate that small there is no honest single figure at all. */
  const sumEst = rows.reduce((a, e) => a + Math.abs(e.estimate), 0);
  const tiny = rows.some((e) => Math.abs(e.estimate) < 0.05);
  return {
    beats, of: rows.length,
    avgSurprise: !tiny && sumEst > 0
      ? ((rows.reduce((a, e) => a + e.actual, 0) - rows.reduce((a, e) => a + e.estimate, 0)) / sumEst) * 100
      : null,
    last: rows[0]
  };
}

/** Insiders' monthly share purchase ratio, averaged over the months present.
    Finnhub's MSPR runs from -100 (all selling) to +100 (all buying). Months
    with no insider trades are simply absent, so `months` counts months with
    trades, and `when` says so rather than implying an unbroken run. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ymLabel = (ym) => { const [y, m] = String(ym || "").split("-"); return MONTHS[Number(m) - 1] ? MONTHS[Number(m) - 1] + " " + y : String(ym || ""); };

export function insiderSummary(insider) {
  const rows = (insider?.months || []).filter((m) => num(m.mspr));
  if (!rows.length) return null;
  const avg = rows.reduce((a, m) => a + m.mspr, 0) / rows.length;
  const net = rows.reduce((a, m) => a + (num(m.change) ? m.change : 0), 0);
  const yms = rows.map((m) => m.ym).filter(Boolean).sort();
  const n = rows.length;
  return {
    months: n, mspr: avg, netShares: net,
    when: !yms.length ? (n === 1 ? "in one month" : "in " + n + " months")
      : n === 1 ? "in " + ymLabel(yms[0])
      : "in " + n + " months with trades since " + ymLabel(yms[0]),
    word: avg > 20 ? "net buying" : avg < -20 ? "net selling" : "mixed"
  };
}

/* ============================================================== CHART */

/** The best price series available: a weekly history from an outside
    source when one worked, otherwise the daily closes recorded each night. */
export function priceSeries(deep) {
  if (Array.isArray(deep?.chart) && deep.chart.length >= 20) return deep.chart;
  if (Array.isArray(deep?.closes) && deep.closes.length >= 5) return deep.closes;
  return null;
}

/** Trend, drawdown and volatility for whatever window is on screen. The
    series may be weekly or daily; the spacing decides which moving average
    and which annualisation apply. */
export function chartStats(points) {
  if (!Array.isArray(points) || points.length < 10) return null;
  const closes = points.map((p) => p[1]);
  const last = closes[closes.length - 1];
  const gaps = [];
  for (let i = 1; i < points.length; i++) gaps.push((new Date(points[i][0]) - new Date(points[i - 1][0])) / 864e5);
  gaps.sort((a, b) => a - b);
  const weekly = gaps[gaps.length >> 1] >= 5;
  const perYear = weekly ? 52 : 252;
  const maLen = weekly ? 40 : 200;

  let vsMa = null, maLabel = null;
  const useLen = closes.length >= maLen ? maLen : closes.length >= 50 && !weekly ? 50 : 0;
  if (useLen) {
    const win = closes.slice(-useLen);
    const ma = win.reduce((a, b) => a + b, 0) / win.length;
    vsMa = ((last - ma) / ma) * 100;
    maLabel = useLen === maLen ? "200 days" : "50 days";
  }

  let peak = closes[0], worst = 0, worstAt = null;
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] > peak) peak = closes[i];
    const dd = (closes[i] - peak) / peak;
    if (dd < worst) { worst = dd; worstAt = points[i][0]; }
  }

  let volatility = null;
  if (closes.length >= 20) {
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
    volatility = sd * Math.sqrt(perYear) * 100;
  }

  return { vsMa, maLabel, maxDrawdown: worst * 100, maxDrawdownAt: worstAt, volatility };
}
