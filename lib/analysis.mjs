/* ==========================================================================
   StockOrNot — shared analysis
   --------------------------------------------------------------------------
   The scoring rules, the pros-and-cons rules and the number formatting all
   live here so the swipe card and the static company pages can never drift
   apart. Loaded as an ES module by both the browser app and the page builder.

   Nothing in this file predicts anything. The score is a weighted average of
   five factor scores, each a piecewise curve over a reported figure, and the
   pros and cons are thresholds that state the number that triggered them.
   ========================================================================== */

/* ------------------------------------------------------------- primitives */

export function num(v) { return typeof v === "number" && isFinite(v); }
export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/** Piecewise-linear mapping through a list of [input, output] knots. */
export function curve(v, knots) {
  if (!num(v)) return null;
  if (v <= knots[0][0]) return knots[0][1];
  const last = knots[knots.length - 1];
  if (v >= last[0]) return last[1];
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1], b = knots[i];
    if (v <= b[0]) return a[1] + ((v - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
  }
  return last[1];
}

export function mean(list) {
  const vals = list.filter(num);
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

/* ------------------------------------------------------------ formatting */

export function money(v, currency) {
  if (!num(v)) return "—";
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  let s;
  if (a >= 1e12)     s = (a / 1e12).toFixed(a >= 1e13 ? 1 : 2) + "T";
  else if (a >= 1e9) s = (a / 1e9).toFixed(a >= 1e11 ? 0 : 1) + "B";
  else if (a >= 1e6) s = (a / 1e6).toFixed(a >= 1e8 ? 0 : 1) + "M";
  else if (a >= 1e3) s = (a / 1e3).toFixed(0) + "K";
  else               s = a.toFixed(0);
  return sign + (currency === false ? "" : "$") + s;
}

/** Finnhub reports market cap in millions. */
export function cap(v) { return num(v) ? money(v * 1e6) : "—"; }

export function price(v) {
  if (!num(v)) return "—";
  const d = v >= 1000 ? 0 : v >= 1 ? 2 : 4;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function pct(v, d = 1) { return num(v) ? (v > 0 ? "+" : "") + v.toFixed(d) + "%" : "—"; }
export function pctPlain(v, d = 1) { return num(v) ? v.toFixed(d) + "%" : "—"; }
export function x(v, d = 1) { return num(v) ? v.toFixed(d) + "×" : "—"; }

export function dateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T12:00:00Z" : ""));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Where the price sits in its 52-week band, 0–1. */
export function rangePos(s) {
  if (!num(s.lo) || !num(s.hi) || s.hi <= s.lo || !num(s.price)) return null;
  /* A price far outside its own 52-week range means the range belongs to a
     different share class (Berkshire B was given Class A's). */
  if (s.price < s.lo * 0.8 || s.price > s.hi * 1.25) return null;
  return clamp((s.price - s.lo) / (s.hi - s.lo), 0, 1);
}

/* ============================================================== SCORING ===
   Five factors, each 0–100. Every factor is read twice: once against fixed
   thresholds near long-run market norms, and once against the other companies
   in the same sector, and the two are averaged. The fixed half stops a whole
   sector from looking cheap just because its neighbours are too; the sector
   half stops a grocer being marked down for a grocer's margins.

   A factor built from one or two figures is pulled toward the middle, and a
   missing factor is dropped with the remaining weights rescaled.
   ======================================================================== */

export const FACTORS = [
  { id: "value",   label: "Value",         weight: 0.22, blurb: "what you pay for the earnings, sales, assets and cash" },
  { id: "growth",  label: "Growth",        weight: 0.22, blurb: "how fast revenue and earnings are moving, this year and over five" },
  { id: "quality", label: "Profitability", weight: 0.24, blurb: "how much of the revenue becomes profit, and how much of that is cash" },
  { id: "moment",  label: "Momentum",      weight: 0.18, blurb: "how the price has behaved lately" },
  { id: "stable",  label: "Stability",     weight: 0.14, blurb: "how violently it moves, what it owes and what it pays you" }
];

const PE_KNOTS = [[5, 92], [10, 84], [16, 70], [25, 52], [40, 34], [70, 16], [120, 8]];
const FINANCIALS = "Financials";
const SECTOR_MIN = 8;          /* fewer peers than this and the sector half is skipped */

/* The figures behind the score, with the traps taken out. Each of these was
   producing a confidently wrong answer before:
     - negative equity (buybacks funded by debt) made ROE read 200–700% and
       price-to-book meaningless, and both were scored as strengths;
     - a company losing money had no P/E, so value was judged on sales and
       book alone and came out looking cheap;
     - the provider's debt/equity is sometimes near zero for companies with
       billions of long-term debt in their own filings;
     - bank "revenue" swings 100%+ with rates, which is not growth. */
export function inputs(s) {
  const f = s.fin || {};
  const financial = s.s === FINANCIALS;
  const negEquity = num(f.equity) && f.equity < 0;
  const thinEquity = num(f.equity) && num(f.assets) && f.assets > 0 && f.equity >= 0 && f.equity / f.assets < 0.08 && !financial;
  const mcap = num(s.mc) && s.mc > 0 ? s.mc * 1e6 : null;
  const losing = (num(s.pe) && s.pe <= 0) || (num(s.nm) && s.nm < 0) || (num(f.netIncome) && f.netIncome < 0);

  let debtYears = null;               /* years of operating cash flow to repay long-term debt */
  if (!financial && num(f.debt)) {
    if (f.debt <= 0) debtYears = 0;
    else if (num(f.ocf)) debtYears = f.ocf > 0 ? f.debt / f.ocf : Infinity;
  }
  /* A bank's one-year "revenue" in the provider's data can jump 60–180% while
     its five-year trend sits near 5%: that is how interest income is booked,
     not growth. Use the five-year figure alone when the two disagree that much. */
  const rgSuspect = financial && num(s.rg) && num(s.rg5) && Math.abs(s.rg - s.rg5) > 30;

  return {
    financial, negEquity, thinEquity, losing, debtYears, rgSuspect,
    roeOk: num(s.roe) && !negEquity && !thinEquity,
    fcfYield: !financial && num(f.fcf) && mcap ? (f.fcf / mcap) * 100 : null,
    cashConv: !financial && num(f.fcf) && num(f.netIncome) && f.netIncome > 0 ? f.fcf / f.netIncome : null,
    peg: num(s.pe) && s.pe > 0 && num(s.eg) && s.eg > 0 && s.eg < 150 ? s.pe / s.eg : null,
    rg: num(s.rg) && !rgSuspect ? clamp(s.rg, -40, 60) : null,
    eg: num(s.eg) ? clamp(s.eg, -80, 120) : null
  };
}

/* [score, number of figures behind it] */
function factorValue(s, k) {
  const pe = num(s.pe) && s.pe > 0 ? curve(s.pe, PE_KNOTS) : k.losing ? 10 : null;
  const pef = num(s.pef) && s.pef > 0 ? curve(s.pef, PE_KNOTS) : null;
  const pb = !k.negEquity && num(s.pb) && s.pb > 0
    ? curve(s.pb, [[0.8, 90], [1.5, 78], [3, 64], [6, 48], [12, 32], [30, 14], [60, 8]]) : null;
  const ps = num(s.ps) && s.ps > 0
    ? curve(s.ps, [[0.5, 88], [1.5, 76], [3, 62], [6, 46], [12, 28], [25, 12]]) : null;
  const fy = curve(k.fcfYield, [[-6, 4], [0, 22], [2, 40], [4, 56], [6, 70], [9, 84], [14, 93]]);
  return [mean([pe, pe, pef, pb, ps, fy]), [pe, pef, pb, ps, fy].filter(num).length];
}

function factorGrowth(s, k) {
  const rg = curve(k.rg, [[-20, 4], [-5, 22], [0, 34], [5, 50], [12, 66], [25, 82], [45, 93], [60, 96]]);
  const eg = curve(k.eg, [[-50, 4], [-15, 22], [0, 36], [10, 54], [25, 70], [50, 85], [100, 94]]);
  const r5 = curve(s.rg5, [[-8, 8], [0, 30], [5, 50], [10, 68], [20, 85], [35, 94]]);
  const e5 = curve(s.eg5, [[-15, 8], [0, 32], [8, 52], [15, 70], [25, 85], [40, 94]]);
  /* one year of revenue is noisy; five years of it counts double */
  return [mean([rg, eg, r5, r5, e5]), [rg, eg, r5, e5].filter(num).length];
}

function factorQuality(s, k) {
  const f = s.fin || {};
  const roe = k.roeOk ? curve(s.roe, [[-20, 3], [0, 16], [6, 36], [12, 54], [20, 70], [35, 84], [60, 93]]) : null;
  const roa = k.financial ? null : curve(s.roa, [[-10, 3], [0, 18], [3, 38], [6, 54], [10, 68], [16, 82], [25, 92]]);
  const nm = curve(s.nm, [[-20, 3], [0, 18], [4, 34], [9, 50], [16, 66], [26, 80], [40, 92]]);
  const gm = curve(s.gm, [[10, 25], [25, 42], [40, 58], [55, 72], [70, 84], [85, 92]]);
  /* profit that never turns into cash is the commonest way good-looking
     margins mislead */
  const cash = curve(k.cashConv, [[-0.5, 5], [0, 18], [0.5, 42], [0.8, 60], [1, 70], [1.3, 80]]);
  const loss = num(f.netIncome) && f.netIncome < 0 && !num(s.nm) ? 8 : null;
  return [mean([roe, roa, nm, nm, gm, cash, loss]), [roe, roa, nm, gm, cash, loss].filter(num).length];
}

function factorMomentum(s) {
  const pos = rangePos(s);
  const inRange = pos === null ? null : pos * 100;
  const r13 = curve(s.r13, [[-30, 6], [-12, 24], [-3, 40], [3, 55], [10, 70], [22, 85], [45, 94]]);
  const r52 = curve(s.r52, [[-45, 6], [-18, 26], [-4, 42], [6, 57], [18, 72], [40, 86], [80, 94]]);
  return [mean([inRange, r13, r52]), [inRange, r13, r52].filter(num).length];
}

function factorStability(s, k) {
  const beta = curve(s.beta, [[0.4, 92], [0.7, 82], [1.0, 66], [1.3, 50], [1.8, 32], [2.5, 16], [3.5, 8]]);
  let band = null;
  if (num(s.lo) && num(s.hi) && s.hi > 0) {
    band = curve((s.hi - s.lo) / s.hi, [[0.15, 90], [0.28, 74], [0.42, 56], [0.6, 38], [0.8, 20]]);
  }
  const div = num(s.dy) ? curve(s.dy, [[0, 44], [1.5, 58], [3, 70], [5, 74], [9, 58]]) : null;
  /* Leverage from the company's own filings where possible. Banks run on
     borrowed money by design, so their debt is left out rather than scored. */
  let debt = null;
  if (!k.financial) {
    if (k.negEquity) debt = 14;
    else if (num(k.debtYears) || k.debtYears === Infinity) {
      debt = curve(Math.min(k.debtYears, 20), [[0, 90], [1, 82], [2.5, 66], [4, 50], [6, 32], [10, 14]]);
    } else if (num(s.de) && s.de >= 0) {
      debt = curve(s.de, [[0.2, 88], [0.6, 72], [1.2, 56], [2.5, 34], [5, 16]]);
    }
  }
  const cover = num(s.ic) && !k.financial ? curve(s.ic, [[0, 6], [1.5, 20], [3, 40], [6, 62], [12, 80], [25, 90]]) : null;
  return [mean([beta, band, div, debt, cover]), [beta, band, div, debt, cover].filter(num).length];
}

/** Each factor against fixed thresholds only, before the sector half. */
export function rawFactors(s) {
  const k = inputs(s);
  const out = {}, count = {};
  [["value", factorValue(s, k)], ["growth", factorGrowth(s, k)], ["quality", factorQuality(s, k)],
   ["moment", factorMomentum(s)], ["stable", factorStability(s, k)]].forEach(([id, [v, n]]) => {
    /* one figure is an anecdote: pull it a third of the way to the middle */
    out[id] = num(v) ? 50 + (v - 50) * Math.min(1, 0.55 + 0.15 * n) : null;
    count[id] = n;
  });
  return { factors: out, count, k };
}

/* ------------------------------------------------------- sector context */

/* The raw metrics the pros and cons compare against peers. */
const PEER_METRICS = [
  { key: "pe",   lower: true,  get: (s) => (num(s.pe) && s.pe > 0 ? s.pe : null) },
  { key: "ps",   lower: true,  get: (s) => (num(s.ps) && s.ps > 0 ? s.ps : null) },
  { key: "fcfy", lower: false, get: (s) => inputs(s).fcfYield },
  { key: "rg",   lower: false, get: (s) => { const k = inputs(s); return num(k.rg) ? s.rg : null; } },
  { key: "nm",   lower: false, get: (s) => (num(s.nm) ? s.nm : null) },
  { key: "ret",  lower: false, get: (s) => { const k = inputs(s); return k.roeOk ? s.roe : k.financial ? null : (num(s.roa) ? s.roa : null); } }
];

/** Built once per snapshot and handed to scoreStock and prosAndCons. Without
    it they fall back to the fixed thresholds alone. */
export function buildScoreContext(stocks) {
  const sectors = new Map();
  for (const s of stocks || []) {
    if (!s || !s.s) continue;
    let rec = sectors.get(s.s);
    if (!rec) { rec = { n: 0, factors: {}, metrics: {} }; sectors.set(s.s, rec); }
    rec.n++;
    const { factors } = rawFactors(s);
    for (const f of FACTORS) if (num(factors[f.id])) (rec.factors[f.id] ||= []).push(factors[f.id]);
    for (const m of PEER_METRICS) { const v = m.get(s); if (num(v)) (rec.metrics[m.key] ||= []).push(v); }
  }
  for (const rec of sectors.values()) {
    for (const a of Object.values(rec.factors)) a.sort((x, y) => x - y);
    for (const a of Object.values(rec.metrics)) a.sort((x, y) => x - y);
  }
  return { sectors };
}

function countBelow(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  return lo;
}
function countAbove(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= v) lo = m + 1; else hi = m; }
  return sorted.length - lo;
}

/** 0–100, mid-rank: where v sits among the sorted values, ties split. */
function midRank(sorted, v) {
  const below = countBelow(sorted, v), above = countAbove(sorted, v);
  return ((below + (sorted.length - below - above) / 2) / sorted.length) * 100;
}

/* Share of the *other* companies in the sector this one beats on a metric,
   0–100, with "beats" meaning cheaper for a price ratio and higher otherwise. */
function peerShare(ctx, s, key, v) {
  const m = PEER_METRICS.find((p) => p.key === key);
  const arr = ctx?.sectors?.get(s.s)?.metrics[key];
  if (!m || !arr || arr.length < SECTOR_MIN || !num(v)) return null;
  const beaten = m.lower ? countAbove(arr, v) : countBelow(arr, v);
  return Math.round((beaten / (arr.length - 1)) * 100);
}

export function scoreStock(s, ctx) {
  const { factors: raw, k } = rawFactors(s);
  const sec = ctx?.sectors?.get(s.s);
  const factors = {};
  let total = 0, wsum = 0;
  for (const f of FACTORS) {
    let v = raw[f.id];
    const peers = sec?.factors[f.id];
    /* Momentum stays absolute: whether the price is rising is a market-wide
       question, and a sector falling together is not a reason to prefer the
       one falling slowest. */
    if (num(v) && f.id !== "moment" && peers && peers.length >= SECTOR_MIN) v = (v + midRank(peers, v)) / 2;
    factors[f.id] = num(v) ? v : null;
    if (num(v)) { total += v * f.weight; wsum += f.weight; }
  }

  const notes = [];
  if (k.negEquity) notes.push("Shareholder equity is negative, so return on equity and price-to-book are left out.");
  else if (k.thinEquity) notes.push("Equity is a sliver of assets, so return on assets stands in for return on equity.");
  if (k.losing) notes.push("It is losing money, which counts against value rather than being skipped.");
  if (k.rgSuspect) notes.push("Its one-year revenue change (" + pct(s.rg, 0) + ") is out of line with its five-year trend (" + pct(s.rg5, 0) + " a year), which for a bank is usually how interest income is booked, so only the five-year figure is used.");
  if (k.financial) notes.push("As a financial company, its debt and cash flow are not scored: borrowing is the business.");
  if (sec && sec.n >= SECTOR_MIN) notes.push("Each factor except momentum is half fixed thresholds, half rank among the " + sec.n + " " + s.s + " companies.");

  return {
    factors, raw,
    overall: wsum >= 0.5 ? Math.round(total / wsum) : null,
    notes
  };
}

/** A word for the number. Deliberately about screening, not about buying. */
export function scoreLabel(score) {
  if (!num(score)) return { word: "No score", tone: "none" };
  if (score >= 70) return { word: "Screens strongly", tone: "high" };
  if (score >= 58) return { word: "Screens well",     tone: "good" };
  if (score >= 45) return { word: "Mixed",            tone: "mid"  };
  if (score >= 33) return { word: "Screens poorly",   tone: "low"  };
  return { word: "Screens badly", tone: "bad" };
}

/* ====================================================== PROS AND CONS =====
   Every line names the figure that set it off. The old list had generous
   thresholds for strengths and strict ones for worries, so half the index
   showed six pros and one in six showed no cons at all, including companies
   the score itself marked as middling. Now the thresholds are closer to
   symmetric, the traps above are handled, peers are consulted, and any
   factor the score marks down is always explained on the "against" side. */

const WEAK_FACTOR = 42;        /* below this, the factor gets a con of its own */

export function prosAndCons(s, ctx) {
  const pros = [], cons = [];
  const f = s.fin || {};
  const k = inputs(s);
  const pos = rangePos(s);
  const score = scoreStock(s, ctx);
  const add = (arr, w, factor, key, text) => arr.push({ w, factor, key, text });
  const has = (arr, key) => arr.some((p) => p.key === key);

  /* ---- valuation ---- */
  if (num(s.pe) && s.pe > 0) {
    if (s.pe < 13)      add(pros, 8, "value", "pe", `Cheap on earnings at ${x(s.pe)}, well under the market's usual 20×.`);
    else if (s.pe < 18) add(pros, 5, "value", "pe", `Reasonably priced at ${x(s.pe)} earnings.`);
    else if (s.pe > 55) add(cons, 9, "value", "pe", `Very expensive at ${x(s.pe)} earnings. Years of growth are already in the price.`);
    else if (s.pe > 30) add(cons, 6, "value", "pe", `Pricey at ${x(s.pe)} earnings, against a long-run market average nearer 20×.`);
  }
  if (num(k.peg)) {
    if (k.peg < 1 && s.pe < 40) add(pros, 5, "value", "peg", `A PEG of ${k.peg.toFixed(2)}: a P/E of ${x(s.pe)} is low for EPS growing ${pctPlain(s.eg, 0)}.`);
    else if (k.peg > 3 && s.pe > 20 && !has(cons, "pe")) add(cons, 5, "value", "peg", `A PEG of ${k.peg.toFixed(1)}: a P/E of ${x(s.pe)} is a lot to pay for EPS growing ${pctPlain(s.eg, 0)}.`);
  } else if (num(s.pe) && s.pe > 22 && num(s.eg) && s.eg <= 0 && !has(cons, "pe")) {
    add(cons, 6, "value", "peg", `Priced at ${x(s.pe)} earnings while earnings per share are shrinking (${pct(s.eg)}).`);
  }
  if (!k.negEquity && num(s.pb) && s.pb > 0 && s.pb < 1.3) add(pros, 6, "value", "pb", `Trades at ${x(s.pb, 2)} book value, below what the balance sheet says it owns.`);
  if (!k.negEquity && num(s.pb) && s.pb > 20)              add(cons, 5, "value", "pb", `Priced at ${x(s.pb, 0)} book value. Very little hard asset backing here.`);
  if (num(s.ps) && s.ps > 12) add(cons, 6, "value", "ps", `Priced at ${x(s.ps)} sales, which leaves no room for a stumble.`);
  else if (num(s.ps) && s.ps > 6 && num(s.rg) && s.rg < 10) add(cons, 5, "value", "ps", `Priced at ${x(s.ps)} sales with revenue growing only ${pct(s.rg)}.`);
  if (num(k.fcfYield)) {
    if (k.fcfYield >= 7)                     add(pros, 6, "value", "fcfy", `Free cash flow of ${pctPlain(k.fcfYield)} of its market value a year: a lot of cash for the price.`);
    else if (k.fcfYield > 0 && k.fcfYield < 1.5) add(cons, 4, "value", "fcfy", `Free cash flow is only ${pctPlain(k.fcfYield)} of its market value, a thin cash return for the price.`);
  }

  /* ---- growth ---- */
  if (num(s.rg) && !k.rgSuspect) {
    if (s.rg >= 80)      add(pros, 5, "growth", "rg", `Revenue up ${pctPlain(s.rg, 0)} on the year. A jump that size is often a deal or an accounting change, so check the filing.`);
    else if (s.rg >= 20) add(pros, 9, "growth", "rg", `Revenue up ${pctPlain(s.rg)} on the year.`);
    else if (s.rg >= 8)  add(pros, 6, "growth", "rg", `Revenue growing ${pctPlain(s.rg)} year over year.`);
    else if (s.rg < -5)  add(cons, 8, "growth", "rg", `Revenue fell ${pctPlain(Math.abs(s.rg))} year over year.`);
    else if (s.rg < 1)   add(cons, 5, "growth", "rg", `Revenue is flat at ${pct(s.rg)} on the year.`);
    else if (s.rg < 3)   add(cons, 3, "growth", "rg", `Revenue grew only ${pctPlain(s.rg)}, roughly the pace of inflation.`);
  }
  if (num(s.rg5)) {
    if (s.rg5 >= 10) add(pros, 5, "growth", "rg5", `Has compounded revenue at ${pctPlain(s.rg5)} a year over five years.`);
    else if (s.rg5 < 0) add(cons, 5, "growth", "rg5", `Revenue has shrunk ${pctPlain(Math.abs(s.rg5))} a year over five years.`);
    if (num(k.rg) && s.rg5 >= 8 && s.rg < s.rg5 - 8 && !has(cons, "rg")) {
      add(cons, 5, "growth", "slow", `Growth is slowing: revenue up ${pct(s.rg)} this year against ${pctPlain(s.rg5)} a year over five.`);
    }
  }
  if (num(s.eg)) {
    if (s.eg >= 25)       add(pros, 6, "growth", "eg", `Earnings per share up ${pctPlain(s.eg)}.`);
    else if (s.eg <= -20) add(cons, 7, "growth", "eg", `Earnings per share down ${pctPlain(Math.abs(s.eg))}.`);
    else if (s.eg <= -5)  add(cons, 5, "growth", "eg", `Earnings per share fell ${pctPlain(Math.abs(s.eg))}.`);
  }

  /* ---- profitability ---- */
  if (k.roeOk) {
    if (s.roe >= 60)      add(pros, 7, "quality", "ret", `Earns ${pctPlain(s.roe, 0)} on shareholder equity, a figure flattered by a small equity base.`);
    else if (s.roe >= 25) add(pros, 8, "quality", "ret", `Earns ${pctPlain(s.roe, 0)} back on shareholder equity.`);
    else if (s.roe >= 15) add(pros, 5, "quality", "ret", `Return on equity of ${pctPlain(s.roe, 0)}.`);
    else if (s.roe < 0)   add(cons, 9, "quality", "ret", `Losing money. Return on equity is ${pctPlain(s.roe, 0)}.`);
    else if (s.roe < 8)   add(cons, 5, "quality", "ret", `Return on equity of only ${pctPlain(s.roe, 0)}.`);
  } else if (!k.financial && num(s.roa)) {
    if (s.roa >= 10)     add(pros, 6, "quality", "ret", `Earns ${pctPlain(s.roa, 0)} a year on everything it owns (return on assets).`);
    else if (s.roa < 2)  add(cons, 5, "quality", "ret", `Return on assets of only ${pctPlain(s.roa, 1)}.`);
  }
  if (k.negEquity) {
    add(cons, 5, "stable", "equity", `Owes more than it owns: shareholder equity is ${money(f.equity)}, usually the result of buybacks funded with debt. ROE and price-to-book mean little here.`);
  }
  if (num(s.nm)) {
    if (s.nm >= 20)     add(pros, 7, "quality", "nm", `${pctPlain(s.nm, 0)} of revenue drops through to net profit.`);
    else if (s.nm < 0)  add(cons, 9, "quality", "nm", `Unprofitable, with a net margin of ${pctPlain(s.nm)}.`);
    else if (s.nm < 4)  add(cons, 5, "quality", "nm", `Net margin of ${pctPlain(s.nm)} leaves very little room for error.`);
  }
  if (num(s.gm) && s.gm >= 55) add(pros, 4, "quality", "gm", `Gross margin of ${pctPlain(s.gm, 0)} absorbs cost shocks.`);

  /* ---- cash and balance sheet, straight from the filings ---- */
  if (!k.financial) {
    if (num(f.fcf) && num(f.revenue) && f.revenue > 0) {
      const conv = (f.fcf / f.revenue) * 100;
      if (f.fcf > 0 && conv >= 15)  add(pros, 8, "quality", "fcf", `Generated ${money(f.fcf)} of free cash flow in FY${f.fy}, ${conv.toFixed(0)}% of revenue.`);
      else if (f.fcf > 0)           add(pros, 3, "quality", "fcf", `Free cash flow was positive in FY${f.fy} at ${money(f.fcf)}.`);
      else if (f.fcf < -1e6)        add(cons, 8, "quality", "fcf", `Burned ${money(Math.abs(f.fcf))} of free cash in FY${f.fy}.`);
    }
    if (num(k.cashConv) && k.cashConv < 0.5 && !has(cons, "fcf")) {
      add(cons, 5, "quality", "conv", `Only ${Math.max(0, Math.round(k.cashConv * 100))}% of FY${f.fy}'s ${money(f.netIncome)} profit arrived as free cash.`);
    }

    if (k.debtYears === Infinity) {
      add(cons, 7, "stable", "debt", `Carries ${money(f.debt)} of long-term debt with no operating cash flow to pay it down.`);
    } else if (num(k.debtYears) && k.debtYears > 5) {
      add(cons, 6, "stable", "debt", `Long-term debt of ${money(f.debt)} would take ${k.debtYears.toFixed(0)} years of operating cash flow to repay.`);
    } else if (num(f.cash) && num(f.debt) && f.debt > f.cash * 5 && f.debt > 1e9) {
      add(cons, 4, "stable", "debt", `Long-term debt of ${money(f.debt)} against ${money(f.cash)} of cash.`);
    }
    if (num(f.cash) && num(f.debt) && f.cash > f.debt && !k.negEquity) {
      add(pros, 7, "stable", "cash", `Holds more cash (${money(f.cash)}) than long-term debt (${money(f.debt)}).`);
    }
    if (num(s.de) && !k.negEquity && !has(cons, "debt")) {
      const trulyNone = !num(f.debt) || !num(f.cash) || f.debt <= f.cash * 0.25;
      if (s.de < 0.05 && trulyNone)       add(pros, 5, "stable", "de", "Carries essentially no debt.");
      else if (s.de < 0.4 && trulyNone)   add(pros, 5, "stable", "de", `Barely leveraged. Debt is ${x(s.de, 2)} equity.`);
      else if (s.de > 2.5)                add(cons, 6, "stable", "de", `Heavily leveraged. Debt is ${x(s.de, 1)} equity.`);
    }
    if (num(s.cr)) {
      if (s.cr >= 2)     add(pros, 3, "stable", "cr", `Current assets cover the near-term bills ${s.cr.toFixed(1)} times over.`);
      else if (s.cr < 1) add(cons, 5, "stable", "cr", `Current liabilities exceed current assets (ratio ${s.cr.toFixed(2)}).`);
    }
    if (num(s.ic) && s.ic < 3) add(cons, 6, "stable", "ic", `Operating profit covers its interest bill only ${s.ic.toFixed(1)} times.`);
  }

  /* ---- dividend ---- */
  if (num(s.dy) && s.dy > 0) {
    if (s.dy > 8)         add(cons, 6, "stable", "dy", `A yield of ${pctPlain(s.dy)} is usually the market pricing in a cut.`);
    else if (s.dy >= 2.5) add(pros, 6, "stable", "dy", `Pays a ${pctPlain(s.dy)} dividend while you wait.`);
    else if (s.dy >= 1)   add(pros, 3, "stable", "dy", `Pays a modest ${pctPlain(s.dy)} dividend.`);
    if (k.losing)                          add(cons, 6, "stable", "payout", "Pays a dividend while losing money.");
    else if (num(s.payout) && s.payout > 80) add(cons, 5, "stable", "payout", `Dividend takes ${pctPlain(s.payout, 0)} of earnings, leaving little cushion.`);
  }

  /* ---- price behaviour ----
     Matches the momentum factor: a falling price counts against, a rising
     one for. Cheap-after-a-fall is the value factor's job, not this one. */
  if (pos !== null) {
    if (pos <= 0.2) add(cons, 5, "moment", "range", `Near the bottom of its 52-week range, ${Math.round((1 - s.price / s.hi) * 100)}% below the high. Falling prices usually have a reason; find it first.`);
    else if (pos >= 0.9) add(pros, 3, "moment", "range", `Within ${Math.max(1, Math.round((1 - s.price / s.hi) * 100))}% of its 52-week high: the trend is up.`);
  }
  if (num(s.beta)) {
    if (s.beta < 0.8)      add(pros, 4, "stable", "beta", `Moves less than the market (beta ${s.beta.toFixed(2)}).`);
    else if (s.beta > 1.5) add(cons, 5, "stable", "beta", `Swings harder than the market (beta ${s.beta.toFixed(2)}).`);
  }
  if (num(s.r52)) {
    if (s.r52 <= -20)     add(cons, 6, "moment", "r52", `Down ${pctPlain(Math.abs(s.r52))} over the past year.`);
    else if (s.r52 >= 40) add(pros, 3, "moment", "r52", `Up ${pctPlain(s.r52)} over the past year.`);
  }
  if (num(s.rs52) && s.rs52 <= -20 && !has(cons, "r52")) {
    add(cons, 4, "moment", "rs52", `Trailed the S&P 500 by ${Math.abs(s.rs52).toFixed(0)} points over the past year.`);
  }

  /* ---- against the sector ---- */
  const label = { pe: "P/E", ps: "Price/sales", fcfy: "Free-cash-flow yield", rg: "Revenue growth", nm: "Net margin", ret: k.roeOk ? "Return on equity" : "Return on assets" };
  const fmt = { pe: (v) => x(v), ps: (v) => x(v, 1), fcfy: (v) => pctPlain(v, 1), rg: (v) => pct(v), nm: (v) => pctPlain(v, 0), ret: (v) => pctPlain(v, 0) };
  const worse = { pe: "higher than", ps: "higher than", fcfy: "lower than", rg: "slower than", nm: "thinner than", ret: "lower than" };
  const better = { pe: "lower than", ps: "lower than", fcfy: "higher than", rg: "faster than", nm: "wider than", ret: "higher than" };
  const factorOf = { pe: "value", ps: "value", fcfy: "value", rg: "growth", nm: "quality", ret: "quality" };
  for (const m of PEER_METRICS) {
    const v = m.get(s);
    const share = peerShare(ctx, s, m.key, v);
    if (share === null) continue;
    if (share <= 15 && !has(cons, m.key)) {
      add(cons, 4, factorOf[m.key], m.key, `${label[m.key]} of ${fmt[m.key](v)} is ${worse[m.key]} ${100 - share}% of ${s.s} companies.`);
    } else if (share >= 85 && !has(pros, m.key)) {
      add(pros, 3, factorOf[m.key], m.key, `${label[m.key]} of ${fmt[m.key](v)} is ${better[m.key]} ${share}% of ${s.s} companies.`);
    }
  }

  /* ---- whatever the score marked down, say so ---- */
  const area = { value: "value", growth: "growth", quality: "profitability", moment: "the price trend", stable: "stability" };
  const detail = {
    value:   () => [num(s.pe) && s.pe > 0 ? x(s.pe) + " earnings" : k.losing ? "no earnings to pay for" : null,
                    num(s.ps) ? x(s.ps, 1) + " sales" : null,
                    num(k.fcfYield) ? pctPlain(k.fcfYield, 1) + " free-cash yield" : null],
    growth:  () => [num(k.rg) ? "revenue " + pct(s.rg) : null, num(s.eg) ? "EPS " + pct(s.eg) : null,
                    num(s.rg5) ? pct(s.rg5) + " a year over five years" : null],
    quality: () => [num(s.nm) ? "net margin " + pctPlain(s.nm) : null, num(s.gm) ? "gross margin " + pctPlain(s.gm, 0) : null,
                    num(k.cashConv) ? Math.round(k.cashConv * 100) + "% of profit turned to cash" : null],
    moment:  () => [num(s.r52) ? pct(s.r52) + " over a year" : null, num(s.r13) ? pct(s.r13) + " over three months" : null,
                    pos !== null ? Math.round(pos * 100) + "% of the way up its 52-week range" : null],
    stable:  () => [num(s.beta) ? "beta " + s.beta.toFixed(2) : null,
                    num(k.debtYears) ? k.debtYears.toFixed(1) + " years of cash flow to clear its debt" : k.negEquity ? "negative equity" : null,
                    num(s.hi) && num(s.lo) && s.hi > 0 ? "a " + Math.round((1 - s.lo / s.hi) * 100) + "% swing over the year" : null]
  };
  const tail = (id, v) => " (" + Math.round(v) + "/100): " + detail[id]().filter(Boolean).join(", ") + ".";
  const why = (id, v) => area[id].charAt(0).toUpperCase() + area[id].slice(1) + " is weak" + tail(id, v);
  const weakest = (id, v) => "Its weakest area is " + area[id] + tail(id, v);
  for (const fct of FACTORS) {
    const v = score.factors[fct.id];
    if (num(v) && v < WEAK_FACTOR && !cons.some((c) => c.factor === fct.id)) add(cons, 4, fct.id, "weak-" + fct.id, why(fct.id, v));
  }

  /* No list of cons comes back empty just because nothing crossed a line.
     Every company has a weakest point; if it is below the sector's middle,
     or the score's lowest factor is only middling, name it, at low weight. */
  if (cons.length < 2) {
    let worst = null;
    for (const m of PEER_METRICS) {
      const v = m.get(s);
      const share = peerShare(ctx, s, m.key, v);
      if (share !== null && share < 50 && !has(cons, m.key) && (!worst || share < worst.share)) worst = { m, v, share };
    }
    if (worst) {
      const key = worst.m.key;
      add(cons, 2, factorOf[key], key, `Weakest against its peers: ${label[key].toLowerCase()} of ${fmt[key](worst.v)} is ${worse[key]} ${100 - worst.share}% of ${s.s} companies.`);
    }
  }
  if (cons.length < 2) {
    const lowest = FACTORS.filter((fct) => num(score.factors[fct.id]) && !has(cons, "weak-" + fct.id))
      .sort((a, b) => score.factors[a.id] - score.factors[b.id])[0];
    if (lowest && score.factors[lowest.id] < 60) {
      add(cons, 2, lowest.id, "weak-" + lowest.id, weakest(lowest.id, score.factors[lowest.id]));
    }
  }

  const byWeight = (a, b) => b.w - a.w;
  return {
    pros: pros.sort(byWeight).slice(0, 6).map((p) => p.text),
    cons: cons.sort(byWeight).slice(0, 6).map((p) => p.text)
  };
}

/* ------------------------------------------------------ share-count splits

   SEC frames report each year's share count the way that year's filing stated
   it, and later filings restate prior years for any split that has happened
   since. Pull five years from the frames and you get a series with one foot in
   each convention: Amphenol's 2021 sits at 626M as originally filed while 2022
   onward sit near 1.24B, restated for the 2:1. Read literally that series says
   the share count doubled — so the page told you your stake had been diluted
   104%, when in truth it grew about 2% and the rest was a split.

   A split is recognisable: an adjacent-year ratio that lands on a clean factor.
   Real issuance does not arrive within a few percent of exactly 2.0. Walk the
   series newest to oldest and restate every year onto the newest year's basis. */

const SPLIT_FACTORS = [2, 3, 4, 5, 1.5, 2.5, 10];

function splitFactor(ratio) {
  for (const k of SPLIT_FACTORS) {
    if (Math.abs(ratio - k) / k < 0.03) return k;
    if (Math.abs(ratio - 1 / k) * k < 0.03) return 1 / k;   /* reverse split */
  }
  return null;
}

/* When the refresh built the series from the company's own restatements
   (detail.sharesRestated), every year is already on today's basis and none of
   the guessing below applies: a merger that doubled the share count is real
   dilution and must be reported as such, not "adjusted" away. */
export function splitAdjustShares(shares, { restated = false } = {}) {
  if (!shares) return { shares: null, adjusted: false };
  if (restated) return { shares, adjusted: false, restated: true };
  const years = Object.keys(shares).map(Number)
    .filter((y) => num(shares[y]) && shares[y] > 0)
    .sort((a, b) => a - b);
  if (years.length < 2) return { shares, adjusted: false };

  const out = {};
  const newest = years[years.length - 1];
  out[newest] = shares[newest];

  let factor = 1, adjusted = false, unexplained = false;
  for (let i = years.length - 1; i > 0; i--) {
    const ratio = shares[years[i]] / shares[years[i - 1]];
    const hit = splitFactor(ratio);
    if (hit) { factor *= hit; adjusted = true; }
    else if (ratio > 2.5 || ratio < 0.4) unexplained = true;   /* 50:1 splits, unit errors */
    out[years[i - 1]] = shares[years[i - 1]] * factor;
  }
  return { shares: out, adjusted, unexplained };
}

/* The sentence under the table. Split-adjusted, and it no longer calls a 2%
   drift over five years "dilution". */
export function shareCountNote(shares, opts = {}) {
  const { shares: adj, adjusted, unexplained } = splitAdjustShares(shares, opts);
  if (!adj) return null;
  /* A jump the guesswork cannot explain (a 50:1 split, a unit error) would
     be announced as 4,000% dilution. Say nothing rather than that. */
  if (unexplained) return null;
  const years = Object.keys(adj).map(Number).sort((a, b) => a - b);
  if (years.length < 2) return null;

  const oldest = adj[years[0]], newest = adj[years[years.length - 1]];
  if (!num(oldest) || !num(newest) || oldest <= 0) return null;

  const change = ((newest - oldest) / oldest) * 100;
  const gap = years[years.length - 1] - years[0];
  const span = gap + (gap === 1 ? " year" : " years");
  const tail = adjusted ? " Counts are restated for stock splits so the years compare." : "";

  if (Math.abs(change) < 3)
    return "Share count is essentially flat over " + span + "." + tail;
  if (change < 0)
    return "Share count is down " + Math.abs(change).toFixed(1) + "% over " + span +
           ". Buybacks have been shrinking the pie." + tail;
  if (change < 10)
    return "Share count is up " + change.toFixed(1) + "% over " + span +
           ". Mild issuance." + tail;
  return "Share count is up " + change.toFixed(1) + "% over " + span +
         ". Your slice has been diluted." + tail;
}
