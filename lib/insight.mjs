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

/* ------------------------------------------------------ the five checks

   The financials, cut to the five questions that matter when picking, each
   with a one-line answer and only the figures behind it:

     📈 Revenue growth   is the business growing?
     💰 Free cash flow   is it generating real cash?
     🧮 Profit margins   is profitability improving?
     🏦 Debt vs. cash    is the balance sheet healthy?
     📊 Valuation        is the stock price reasonable?

   Each group is { id, icon, title, question, answer, note, rows }. An answer
   is { text, tone } with tone good | mid | bad | none, or null when the
   figures to answer it are missing. Rows are [label, value, hint, wide]; a
   figure the nightly refresh does not collect for this company is left out
   rather than shown as a column of "n/a". The answers use
   the same rules as the score and the pros and cons: bank revenue jumps,
   bank cash flow and bank debt are never judged, and the valuation answer is
   the score's own value factor, sector half included. */

const answer = (text, tone) => ({ text, tone });
const orNa = (v, fmt) => (num(v) ? fmt(v) : "n/a");

export function financialChecks(s, score) {
  const f = s.fin || {};
  const k = inputs(s);
  const fy = f.fy ? "FY" + f.fy : "last year";
  const fyPrev = f.fy ? "FY" + (f.fy - 1) : "the year before";
  const out = [];

  /* ---- 📈 revenue growth ---- */
  const fyGrowth = num(f.revenue) && num(f.revenuePrev) && f.revenuePrev > 0
    ? ((f.revenue - f.revenuePrev) / f.revenuePrev) * 100 : null;
  /* a bank's one-year figure is an interest-income artefact; judge it on five years */
  const g = num(k.rg) ? s.rg : k.rgSuspect ? s.rg5 : num(fyGrowth) ? fyGrowth : null;
  out.push({
    id: "growth", icon: "📈", title: "Revenue growth", question: "Is the business growing?",
    answer: !num(g) ? null
      : g >= 8 ? answer("Yes", "good")
      : g >= 1 ? answer("Slowly", "mid")
      : g > -2 ? answer("No, flat", "mid")
      : answer("No, shrinking", "bad"),
    rows: [
      ["Last 12 months", num(s.rg) ? pct(s.rg) + (k.rgSuspect ? "*" : "") : "n/a", k.rgSuspect
        ? "Revenue over the last twelve months against the twelve before. *Far out of line with the five-year trend, which in the Financials sector is usually interest income swinging with rates, so the answer uses the five-year figure."
        : "Revenue over the last twelve months against the twelve before."],
      ["Over 5 years", num(s.rg5) ? pct(s.rg5) + " a year" : "n/a", "Average yearly revenue growth over five years."],
      [fy + " revenue", num(f.revenue) ? money(f.revenue) + (num(fyGrowth) ? " (" + pct(fyGrowth, 0) + ")" : "") : "n/a",
        "Revenue for the last full fiscal year as filed with the SEC, and the change on the year before."]
    ]
  });

  /* ---- 💰 free cash flow ---- */
  const fcfMargin = !k.financial && num(f.fcf) && num(f.revenue) && f.revenue > 0 ? (f.fcf / f.revenue) * 100 : null;
  let cashAnswer = null;
  if (k.financial) cashAnswer = answer("Not meaningful for a financial company", "none");
  else if (num(f.fcf)) {
    cashAnswer = f.fcf <= 0 ? answer("No, it is burning cash", "bad")
      : num(k.cashConv) && k.cashConv < 0.5 ? answer("Less than its profits suggest", "mid")
      : num(fcfMargin) && fcfMargin >= 15 ? answer("Yes, plenty", "good")
      : num(fcfMargin) && fcfMargin >= 5 ? answer("Yes", "good")
      : answer("A little", "mid");
  }
  out.push({
    id: "cash", icon: "💰", title: "Free cash flow", question: "Is it generating real cash?",
    answer: cashAnswer,
    rows: k.financial ? [] : [
      [fy + " free cash flow", num(f.fcf) ? money(f.fcf) : "n/a", "Cash from operations minus capital spending, from the last annual filing."],
      ["Of revenue", num(fcfMargin) ? pctPlain(fcfMargin, 0) : "n/a", "Free cash flow as a share of revenue: how much of each dollar of sales ends up as spare cash."],
      ["Of profit", num(k.cashConv) ? pctPlain(k.cashConv * 100, 0) : "n/a", "Free cash flow as a share of net income. Well under 100% means reported profit is not arriving as cash."]
    ]
  });

  /* ---- 🧮 profit margins ----
     The trend runs from the year before the last annual filing to the latest
     figure there is: the trailing twelve months where the provider has them,
     the last filing otherwise. A bank's trailing margin rests on the same
     distorted revenue the score throws away, so banks use the filings only. */
  const nmNow = num(f.netIncome) && num(f.revenue) && f.revenue > 0 ? (f.netIncome / f.revenue) * 100 : null;
  const nmPrev = num(f.netIncomePrev) && num(f.revenuePrev) && f.revenuePrev > 0 ? (f.netIncomePrev / f.revenuePrev) * 100 : null;
  const ttm = num(s.nm) && !k.rgSuspect ? s.nm : null;
  const latest = num(ttm) ? ttm : nmNow;
  const drift = num(latest) && num(nmPrev) ? latest - nmPrev : null;
  const trail = [num(nmPrev) ? pctPlain(nmPrev, 1) : null, num(nmNow) ? pctPlain(nmNow, 1) : null, num(ttm) ? pctPlain(ttm, 1) : null];
  const trailLabel = [fyPrev, fy, "last 12 months"].filter((_, i) => trail[i] !== null).join(" → ");
  out.push({
    id: "margins", icon: "🧮", title: "Profit margins", question: "Is profitability improving?",
    answer: !num(drift) ? null
      : drift >= 1 ? answer(latest < 0 ? "Improving, still at a loss" : "Yes, improving", latest < 0 ? "mid" : "good")
      : drift <= -1 ? answer("No, slipping", "bad")
      : answer("Holding steady", "mid"),
    rows: [
      ["Gross margin", orNa(s.gm, (v) => pctPlain(v, 0)), "What is left of each dollar of sales after the direct cost of making it, over the last twelve months."],
      ["Operating margin", orNa(s.om, (v) => pctPlain(v, 0)), "What is left after running the business as well, over the last twelve months."],
      /* the trend row ends on the latest net margin, so it replaces the plain one */
      ...(trail.filter(Boolean).length >= 2
        ? [["Net margin, " + trailLabel, trail.filter(Boolean).join(" → "),
            "Net income over revenue: the year before the last annual filing, that filing, and the last twelve months. The answer above compares the first with the latest.", true]]
        : [["Net margin", orNa(s.nm, (v) => pctPlain(v, 0)), "What is left after interest and tax, over the last twelve months."]])
    ]
  });

  /* ---- 🏦 debt vs. cash ---- */
  const netCash = num(f.cash) && num(f.debt) ? f.cash - f.debt : null;
  let balAnswer = null;
  if (k.financial) balAnswer = answer("Not judged for a financial company", "none");
  else if (num(f.cash) && num(f.debt) && f.cash >= f.debt) balAnswer = answer("Yes, more cash than debt", "good");
  else if (k.debtYears === Infinity) balAnswer = answer("No, debt and no cash flow to pay it", "bad");
  else if (num(k.debtYears)) {
    balAnswer = k.debtYears <= 3 && !k.negEquity ? answer("Yes, the debt is manageable", "good")
      : k.debtYears <= 5 && !k.negEquity ? answer("Mostly, with some debt to carry", "mid")
      : answer("Stretched", "bad");
  } else if (k.negEquity) balAnswer = answer("Stretched: it owes more than it owns", "bad");
  else if (k.thinEquity) balAnswer = answer("Stretched: little equity under a lot of assets", "bad");
  /* no long-term debt tagged in the filings: fall back to the provider's
     debt-to-equity, as the score does */
  const deFallback = !k.financial && !num(f.debt) && k.deOk;
  if (!balAnswer && deFallback) {
    balAnswer = s.de < 0.5 ? answer("Yes, little debt", "good")
      : s.de < 1.5 ? answer("Mostly, with some debt to carry", "mid")
      : answer("Stretched", "bad");
  }
  out.push({
    id: "balance", icon: "🏦", title: "Debt vs. cash", question: "Is the balance sheet healthy?",
    answer: balAnswer,
    note: k.financial ? "For banks, insurers and brokers, borrowing is the business, so debt is not judged for anything in the Financials sector." : null,
    rows: [
      ["Cash", num(f.cash) ? money(f.cash) : "n/a", "Cash and equivalents at the last fiscal year end, as filed."],
      ["Long-term debt", num(f.debt) ? money(f.debt) : "n/a", "Long-term debt at the last fiscal year end, as filed."],
      [num(netCash) && netCash < 0 ? "Net debt" : "Net cash", num(netCash) ? money(Math.abs(netCash)) : "n/a", "Cash minus long-term debt."],
      ...(k.financial ? [] : [["Years to repay", num(k.debtYears) ? k.debtYears.toFixed(1) + " yrs" : k.debtYears === Infinity ? "no cash flow" : "n/a",
        "How many years of operating cash flow it would take to pay off the long-term debt. Under 3 is comfortable."]]),
      ...(deFallback ? [["Debt / equity", x(s.de, 2), "Total debt against shareholders' equity, from the market-data provider, used because the filings do not tag long-term debt."]] : [])
    ]
  });

  /* ---- 📊 valuation ---- */
  const v = score?.factors?.value;
  const pfcf = num(k.fcfYield) && k.fcfYield > 0 ? 100 / k.fcfYield : null;
  const noEarnings = !(num(s.pe) && s.pe > 0) && k.losing;
  out.push({
    id: "value", icon: "📊", title: "Valuation", question: "Is the stock price reasonable?",
    answer: !num(v) ? null
      : noEarnings && v < 48 ? answer("Hard to say: no earnings to price", "bad")
      : v >= 62 ? answer("Yes, it looks cheap", "good")
      : v >= 48 ? answer("Yes, about fair", "good")
      : v >= 42 ? answer("A bit pricey", "mid")
      : answer("No, expensive", "bad"),
    note: num(v) ? "Value part of the score: " + Math.round(v) + "/100, against fixed yardsticks and the rest of the sector." : null,
    rows: [
      ["P/E", num(s.pe) && s.pe > 0 ? x(s.pe) : k.losing ? "n/a (a loss)" : "n/a", "Price divided by the last twelve months of earnings per share."],
      ["Forward P/E", num(s.pef) && s.pef > 0 ? x(s.pef) : null, "Price divided by next year's expected earnings."],
      ["P/FCF", num(pfcf) ? x(pfcf, 1) : k.financial ? "n/m" : "n/a", "Market value divided by last year's free cash flow. The cash version of the P/E."],
      ["PEG", num(k.peg) ? k.peg.toFixed(2) : "n/a", "P/E divided by EPS growth. Under 1 means the price looks low for the growth; over 2 means growth is well paid for."],
      ["Price / sales", num(s.ps) && s.ps > 0 ? x(s.ps, 1) : "n/a", "Market value against a year of revenue."],
      ["EV / EBITDA", num(s.evEbitda) && s.evEbitda > 0 ? x(s.evEbitda, 1) : null, "Whole-company value, debt included, against operating earnings before depreciation."]
    ]
  });

  for (const g of out) g.rows = g.rows.filter((r) => r[1] !== null);
  return out;
}

/**
 * Five years of the filings, grouped under the same checks (valuation has no
 * history in the filings, so four groups). { years, groups: [{ icon, title,
 * rows: [{ label, cells, derived }] }] } or null. `derived` marks a row
 * worked out from the others rather than read from the filing.
 */
export function historyChecks(h) {
  if (!h || !Object.values(h).some((r) => r && typeof r === "object")) return null;
  /* every year any row has, not just revenue's: a company whose revenue tag
     changed would otherwise lose its latest years from the table */
  const all = [...new Set(Object.values(h).filter((r) => r && typeof r === "object")
    .flatMap((r) => Object.keys(r)))].map(Number).sort((a, b) => b - a);
  const years = all.slice(0, 5);
  if (!years.length) return null;
  const at = (k, y) => (h[k] && num(h[k][y]) ? h[k][y] : null);
  const ratio = (a, b) => (num(a) && num(b) && b !== 0 ? (a / b) * 100 : null);
  const fcf = (y) => (num(at("ocf", y)) && num(at("capex", y)) ? at("ocf", y) - at("capex", y) : null);
  const row = (label, fn, fmt, derived = false) => {
    const vals = years.map(fn);
    return vals.some(num) ? { label, derived, cells: vals.map((v) => (num(v) ? fmt(v) : "—")) } : null;
  };
  const m = (v) => money(v);
  const p1 = (v) => pctPlain(v, 1);

  const groups = [
    { icon: "📈", title: "Revenue growth", rows: [
      row("Revenue", (y) => at("revenue", y), m),
      row("Change on the year", (y) => { const a = at("revenue", y), b = at("revenue", y - 1); return num(a) && num(b) && b > 0 ? ((a - b) / b) * 100 : null; }, (v) => pct(v, 0), true)
    ]},
    { icon: "💰", title: "Free cash flow", rows: [
      row("Free cash flow", fcf, m, true),
      row("Of revenue", (y) => ratio(fcf(y), at("revenue", y)), (v) => pctPlain(v, 0), true)
    ]},
    { icon: "🧮", title: "Profit margins", rows: [
      row("Gross margin", (y) => ratio(at("grossProfit", y), at("revenue", y)), p1, true),
      row("Operating margin", (y) => ratio(at("opIncome", y), at("revenue", y)), p1, true),
      row("Net margin", (y) => ratio(at("netIncome", y), at("revenue", y)), p1, true)
    ]},
    { icon: "🏦", title: "Debt vs. cash", rows: [
      row("Cash", (y) => at("cash", y), m),
      row("Long-term debt", (y) => at("debt", y), m),
      row("Net cash (debt)", (y) => (num(at("cash", y)) && num(at("debt", y)) ? at("cash", y) - at("debt", y) : null), m, true)
    ]}
  ].map((g) => ({ ...g, rows: g.rows.filter(Boolean) })).filter((g) => g.rows.length);
  return groups.length ? { years, groups } : null;
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
