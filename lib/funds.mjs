/* ==========================================================================
   StockOrNot — reading a fund

   An exchange-traded fund is not a company, and nothing here treats it as
   one. A fund gets its own reading from three things, each on a fixed scale:

     What it owns    0.40   the holdings-weighted average of our own company
                            scores, under the scoring style chosen, over the
                            part of the fund we can match to a company we
                            score. The part we cannot see counts as average
                            (50), so a fund cannot read well on the slice it
                            happens to show us.
     What it costs   0.35   the expense ratio, on a fixed curve. Fees are the
                            best-evidenced predictor in the research behind
                            this, and a published fee is not an anecdote, so
                            it is never pulled toward the middle.
     How spread out  0.25   the effective number of holdings (one over the
                            sum of the squared weights) and the weight of the
                            largest ten.

   The reading is that blend. It is never a place among the 500 companies,
   and never a place among the funds we chose to cover either: that place
   would move every time a fund was added. A fund gets a number only when the
   nightly job read it in full (data/etfs.json "reading": at least 80% of its
   stock holdings matched to companies we score, and at most 10% in cash,
   money-market funds or futures), from holdings no more than 200 days old.
   Without an expense ratio the other two carry it, 60 and 40, and the card
   says the cost has not been read; such a reading is weighed differently,
   so it is never ranked against the funds whose fee has been read.

   A fund whose holdings have never been read has nothing to show but a
   price, so the page leaves it out until they are (fundsToShow), and with
   fewer than two funds left there is no ETF side at all.

   What it owns is our company score counted a second time. A fund full of
   the companies our screen likes this year reads well for that reason alone;
   method.html says so, and so does the full record.

   Fund records carry no cik, s or mc. A trust's CIK is shared by many funds
   (all eleven Select Sector SPDRs have one), and the deck, Compare and the
   score context all take a cik for "the same company". Without s a fund can
   never enter the score context or the sector statistics either, and both
   also skip anything marked kind "etf".

   Loaded by app.js in the browser and by the tests in Node; no DOM here.
   ========================================================================== */

import { num, clamp, curve, mean, scoreStock, scoreLabel, styleById, DEFAULT_STYLE, inputs, money, pctPlain, x, dateShort } from "./analysis.mjs";

/* Which version of the fund reading produced a number. Change it whenever
   the curves or the weights change. */
export const FUND_VERSION = "2026-10";

export const FUND_FACTORS = [
  { id: "hold",   label: "What it owns",   weight: 0.40, blurb: "its holdings, read through our company scores" },
  { id: "cost",   label: "What it costs",  weight: 0.35, blurb: "the expense ratio, taken every year whatever the fund does" },
  { id: "spread", label: "How spread out", weight: 0.25, blurb: "how many companies really carry it" }
];
/* No expense ratio read yet: the other two carry the reading between them,
   in the same proportion as before. */
export const NO_COST_WEIGHTS = { hold: 0.6, cost: 0, spread: 0.4 };

/* % a year -> score. 0.03% (VOO, IVV) reads 94, SPY's 0.0945% about 81, the
   0.35% where plain index fees end about 50, a typical thematic 0.75% 24. */
export const COST_KNOTS = [[0.02, 96], [0.05, 90], [0.10, 80], [0.20, 66], [0.35, 50], [0.50, 38], [0.75, 24], [1.00, 14], [1.50, 6]];
/* The S&P 500 by market value behaves like about 40 equal holdings. */
export const EFFN_KNOTS = [[3, 6], [6, 18], [10, 30], [20, 46], [40, 60], [80, 72], [150, 82], [300, 90], [500, 94]];
export const TOP10_KNOTS = [[10, 90], [20, 80], [30, 68], [40, 58], [50, 48], [60, 38], [75, 24], [90, 12]];

export const OUTSIDE = "Outside the S&P 500";
const SECTOR_FUND = 60;        /* this much in one sector and it is a sector fund */
const WEAK_FACTOR = 42;        /* below this, the factor gets a con of its own (as for companies) */
const MAX_ITEMS = 6;
const READINGS = ["full", "partial", "none"];
/* Holdings older than this mean filings were missed: a quarter's holdings
   are public about 60 days after it ends, so the newest are at most about
   155 days old when all is well. Past it a fund is not read in full. */
export const MAX_HOLDINGS_AGE = 200;     /* days */
/* the fewest funds worth a Stocks | ETFs switch, and a fund Compare */
export const MIN_FUNDS = 2;

export const isFund = (s) => Boolean(s) && s.kind === "etf";

/* No holdings filing read at all: no filing, or one that gave us nothing. */
const neverRead = (fund) => !fund.nport || (!(fund.hold || []).length && !num(fund.cover));

/** How many days old its holdings are, from the period of its last N-PORT;
    null without one. */
export function holdingsAge(fund, now = new Date()) {
  const t = fund && fund.nport && typeof fund.nport.period === "string" ? Date.parse(fund.nport.period + "T00:00:00Z") : NaN;
  return Number.isFinite(t) ? Math.floor((now.getTime() - t) / 864e5) : null;
}
const tooOld = (fund, now) => (holdingsAge(fund, now) ?? 0) > MAX_HOLDINGS_AGE;

/* ------------------------------------------------------------ the records */

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;

/** A record from data/etfs.json, made safe to put beside the companies:
    marked kind "etf", stripped of cik, s and mc whatever the file held, its
    holdings sorted largest first. null for anything that is not a fund. */
export function cleanFund(rec) {
  if (!rec || typeof rec !== "object" || typeof rec.t !== "string" || !TICKER.test(rec.t)) return null;
  if (rec.kind !== undefined && rec.kind !== "etf") return null;
  const f = { ...rec, kind: "etf" };
  delete f.cik; delete f.s; delete f.mc;
  f.hold = (Array.isArray(rec.hold) ? rec.hold : [])
    .filter((h) => Array.isArray(h) && typeof h[0] === "string" && num(h[1]) && h[1] > 0)
    .map((h) => [h[0], h[1]])
    .sort((a, b) => b[1] - a[1]);
  f.out = (Array.isArray(rec.out) ? rec.out : []).filter((o) => Array.isArray(o) && num(o[2]));
  if (!READINGS.includes(f.reading)) f.reading = "none";
  if (typeof f.n !== "string" || !f.n) f.n = f.t;
  return f;
}

/** The funds from data/etfs.json, cleaned and added to the ticker index
    beside the companies. A fund never takes a company's place: a ticker the
    index already holds for a company stays the company's, and that fund is
    left out. Returns the funds kept, in file order. */
export function mergeFunds(byTicker, records) {
  const out = [], seen = new Set();
  for (const rec of Array.isArray(records) ? records : []) {
    const f = cleanFund(rec);
    if (!f || seen.has(f.t)) continue;
    const there = byTicker[f.t];
    if (there && !isFund(there)) continue;
    seen.add(f.t);
    byTicker[f.t] = f;
    out.push(f);
  }
  return out;
}

/** The records from data/etfs.json that get a card. A fund whose holdings
    have never been read would show nothing but its price, so it waits until
    they are; a ticker that is a company's is left out, as mergeFunds leaves
    it. With fewer than MIN_FUNDS left, none: no switch, no fund Compare. */
export function fundsToShow(records, byTicker) {
  const out = [], seen = new Set();
  for (const rec of Array.isArray(records) ? records : []) {
    const f = cleanFund(rec);
    if (!f || !f.nport || !f.hold.length) continue;
    const there = byTicker && byTicker[f.t];
    if (there && !isFund(there)) continue;
    out.push(rec);
    seen.add(f.t);
  }
  return seen.size >= MIN_FUNDS ? out : [];
}

/** data/etfs.json, or null. On the website, the file itself. In the app,
    the live file only when the copy built into the app has funds to show,
    so a build made before there were any never grows an ETF side App Review
    did not see; a live file that arrived but cannot be read leaves that
    copy. `live` and `bundled` each fetch the file and resolve to a Response. */
export async function loadFundsFile({ inApp, live, bundled }) {
  const read = async (r) => {
    if (!r || !r.ok) throw new Error("http " + (r && r.status));
    const j = await r.json();
    if (!j || !Array.isArray(j.etfs)) throw new Error("empty");
    return j;
  };
  try {
    if (!inApp) return await Promise.resolve().then(live).then(read);
    const own = await Promise.resolve().then(bundled).then(read).catch(() => null);
    if (!own || !fundsToShow(own.etfs).length) return null;
    return await Promise.resolve().then(live).then(read).catch(() => own);
  } catch (err) {
    return null;
  }
}

/* ----------------------------------------------------- company scores, cached

   Every company's score under one style, the number on its own card, worked
   out once per score context and style. `companies` is every company record
   (both share classes, so a holding filed under GOOG finds its score); the
   first list given for a context is the one kept. */
const scoreCache = new WeakMap();

export function companyScores(ctx, styleId, companies) {
  if (!ctx) return new Map();
  const st = styleById(styleId).id;
  let byStyle = scoreCache.get(ctx);
  if (!byStyle) { byStyle = new Map(); scoreCache.set(ctx, byStyle); }
  let m = byStyle.get(st);
  if (m) return m;
  m = new Map();
  for (const s of companies || ctx.stocks || []) {
    if (!s || !s.t || isFund(s) || m.has(s.t)) continue;
    const v = scoreStock(s, ctx, st).overall;
    m.set(s.t, { score: num(v) ? v : null, s });
  }
  byStyle.set(st, m);
  return m;
}

/* -------------------------------------------------------------- the parts */

/** What it owns: the weighted average of the holdings' scores (m) over the
    share of the fund's stock holdings we can score (c), with the rest at 50.
    Weights are % of the fund's stock holdings. `bands` is how much of it
    sits in each of the five score words, plus "none" for what we cannot
    score, so an average of 99 and 1 cannot hide both. */
export function holdingsReading(fund, scores) {
  let scored = 0, sum = 0, matched = 0;
  const bands = { high: 0, good: 0, mid: 0, low: 0, bad: 0, none: 0 };
  for (const [t, w] of fund.hold || []) {
    matched += w;
    const v = scores.get(t)?.score;
    if (!num(v)) continue;
    scored += w;
    sum += w * v;
    bands[scoreLabel(v).tone] += w;
  }
  if (!(scored > 0)) return null;
  const c = clamp(scored / 100, 0, 1);
  const m = sum / scored;
  bands.none = Math.max(0, 100 - (bands.high + bands.good + bands.mid + bands.low + bands.bad));
  return { value: c * m + (1 - c) * 50, m, c, scored: Math.min(100, scored), matched: Math.min(100, matched), unseen: Math.max(0, 100 - scored), bands };
}

/** Effective number of holdings, the largest ten and the largest one, from
    the holdings themselves, for a record the job wrote without them. */
export function spreadOf(hold) {
  const list = (hold || []).filter((h) => num(h[1]) && h[1] > 0).slice().sort((a, b) => b[1] - a[1]);
  if (!list.length) return null;
  const ws = list.map((h) => h[1] / 100);
  const hhi = ws.reduce((a, w) => a + w * w, 0);
  return {
    effN: hhi > 0 ? 1 / hhi : null,
    top10: ws.slice(0, 10).reduce((a, w) => a + w, 0) * 100,
    big1: ws[0] * 100,
    big1T: list[0][0]
  };
}

export const costScore = (er) => (num(er) && er >= 0 ? curve(er, COST_KNOTS) : null);

export function spreadScore(sp) {
  if (!sp) return null;
  return mean([curve(sp.effN, EFFN_KNOTS), curve(sp.top10, TOP10_KNOTS)]);
}

/** Its largest sector, as [name, % of its stock holdings], leaving out the
    part outside the S&P 500. */
export function topSector(fund) {
  let best = null;
  for (const [k, v] of Object.entries(fund.mix || {})) {
    if (k === OUTSIDE || !num(v)) continue;
    if (!best || v > best[1]) best = [k, v];
  }
  return best;
}
export const isSectorFund = (fund) => (topSector(fund)?.[1] ?? 0) >= SECTOR_FUND;

/** Its companies taken together, weighted as the fund holds them, over the
    holdings we can match: P/E as a harmonic mean (a loss counts as no
    earnings, so one company at 400x cannot drag it), the dividend yield
    (a yield the provider's own figures dispute counts as unseen), and the
    share losing money. Shown, never scored. */
export function lookThrough(fund, scores) {
  let wPe = 0, ep = 0, wDy = 0, dy = 0, wLoss = 0, loss = 0;
  for (const [t, w] of fund.hold || []) {
    const s = scores.get(t)?.s;
    if (!s) continue;
    const k = inputs(s);
    if (num(s.pe) && s.pe > 0 && !k.losing) { wPe += w; ep += w / s.pe; }
    else if (k.losing) { wPe += w; }
    if (!k.dyDisputed) { wDy += w; dy += w * (num(k.dy) ? k.dy : 0); }
    wLoss += w;
    if (k.losing) loss += w;
  }
  return {
    pe: wPe > 0 && ep > 0 ? wPe / ep : null,
    dy: wDy > 0 ? dy / wDy : null,
    losing: wLoss > 0 ? (loss / wLoss) * 100 : null,
    base: wLoss
  };
}

/* The S&P 500 itself, by market value, one share class per company: the
   yardstick for "its companies together" and the sector mix. */
const indexCache = new WeakMap();

export function indexProfile(companies) {
  if (!Array.isArray(companies)) return null;
  let hit = indexCache.get(companies);
  if (hit) return hit;
  const seen = new Set(), pool = [];
  for (const s of companies) {
    if (!s || isFund(s) || !num(s.mc) || s.mc <= 0) continue;
    const id = s.cik || s.t;
    if (seen.has(id)) continue;
    seen.add(id);
    pool.push(s);
  }
  const total = pool.reduce((a, s) => a + s.mc, 0);
  const mix = {};
  const hold = pool.map((s) => [s.t, (s.mc / total) * 100]);
  for (const s of pool) if (s.s) mix[s.s] = (mix[s.s] || 0) + (s.mc / total) * 100;
  const scores = new Map(companies.filter((s) => s && !isFund(s)).map((s) => [s.t, { s }]));
  hit = { mix, look: total > 0 ? lookThrough({ hold }, scores) : null };
  indexCache.set(companies, hit);
  return hit;
}

/** How much two funds hold in common: the sum, over the companies both
    hold, of the smaller of the two weights. 100 means the same companies at
    the same weights. Over what each fund's filing let us match, as % of its
    stock holdings; null when either has no holdings read. */
export function overlap(a, b) {
  const ha = a?.hold || [], hb = b?.hold || [];
  if (!ha.length || !hb.length) return null;
  const wa = new Map();
  for (const [t, w] of ha) wa.set(t, (wa.get(t) || 0) + w);
  let sum = 0;
  for (const [t, w] of hb) if (wa.has(t)) sum += Math.min(wa.get(t), w);
  return clamp(sum, 0, 100);
}

/* ------------------------------------------------------------- formatting */

/** "0.03%", "0.0945%", "0.20%": as many places as the fee was filed with. */
export function fmtEr(er) {
  if (!num(er)) return "—";
  let s = er.toFixed(4).replace(/0+$/, "");
  if (/\.\d$/.test(s)) s += "0";
  if (/\.$/.test(s)) s += "00";
  return s + "%";
}

/** What the fee takes from $10,000 in a year, in dollars. */
export const perTenK = (er) => (num(er) ? er * 100 : null);

export function dollars(v) {
  if (!num(v)) return "—";
  if (v < 1) return "under $1";
  return "$" + Math.round(v).toLocaleString("en-US");
}

/** The fee's cost over ten years on $10,000 growing 7% a year before it. */
export function tenYearCost(er, years = 10, growth = 7) {
  if (!num(er)) return null;
  return 10000 * (Math.pow(1 + growth / 100, years) - Math.pow(1 + growth / 100 - er / 100, years));
}

const BAND_WORDS = [["high", "strongly"], ["good", "well"], ["mid", "mixed"], ["low", "poorly"], ["bad", "badly"], ["none", "not scored"]];

/** "49% strongly · 18% well · 14% mixed · 11% poorly · 8% badly". */
export function bandsText(bands) {
  if (!bands) return "";
  return BAND_WORDS.filter(([k]) => bands[k] >= 0.5).map(([k, w]) => Math.round(bands[k]) + "% " + w).join(" · ");
}
export const BANDS = BAND_WORDS;

const ORDINAL = ["largest", "second-largest", "third-largest", "fourth-largest", "fifth-largest",
  "sixth-largest", "seventh-largest", "eighth-largest", "ninth-largest", "tenth-largest"];
const pct0 = (v) => pctPlain(v, 0);

/** A company as a fund holds it. The job counts a company's share classes
    as one holding under its first ticker (GOOGL for both of Alphabet's), so
    the class in that ticker's name would claim the other class's weight:
    "Alphabet (Class A)" is named "Alphabet". */
export const companyName = (n) => String(n || "").replace(/ \(Class [A-Z]\)$/, "");
const nameOf = (scores, t) => companyName(scores.get(t)?.s?.n) || t;

/** Why a fund has no number, in a sentence. */
export function whyNotRead(fund, now = new Date()) {
  if (neverRead(fund)) {
    return "No holdings filing has been read for this fund, so there is nothing to read it by.";
  }
  if (tooOld(fund, now)) {
    return "Its newest holdings we have are from " + dateShort(fund.nport.period) + ", too old to read it by.";
  }
  if (fund.reading === "full") return "";
  if (num(fund.other) && fund.other > 10) {
    return pct0(fund.other) + " of it is cash, money-market funds, futures or other things that are not company shares, so it is not read as a stock fund.";
  }
  if (num(fund.cover)) {
    return "We can match only " + pct0(fund.cover) + " of its stock holdings to S&P 500 companies we score, short of the 80% a reading needs.";
  }
  return "Its holdings could not be read in full.";
}

/** Where a fund read in full shows its number, a fund that was not shows
    this instead: a word and the figure behind it ("Partly read", "62%
    matched"), never an empty meter that looks like something still loading. */
export function inBrief(fund, now = new Date()) {
  if (neverRead(fund)) return { word: "Not read", detail: "No holdings filing" };
  if (tooOld(fund, now)) {
    const month = new Date(fund.nport.period + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
    return { word: "Out of date", detail: "Holdings of " + month };
  }
  if (fund.reading === "full") return { word: "Not read in full", detail: "" };
  return {
    word: fund.reading === "partial" ? "Partly read" : "Holdings only",
    detail: num(fund.other) && fund.other > 10 ? pct0(fund.other) + " cash and other"
      : num(fund.cover) ? pct0(fund.cover) + " matched" : ""
  };
}

/* ---------------------------------------------------------- the reading */

/**
 * The reading of one fund under a scoring style.
 *   ctx      the company score context (buildScoreContext), the one the
 *            company cards use, so a fund and its holdings never disagree
 *   opts.companies  every company record, for scores and names
 *   opts.funds      every fund, for the cheaper-twin line and fee ranks
 *   opts.now        today, for the age of its holdings
 * Returns { t, overall, blend, reading, brief, factors, notes, pros, cons,
 * hold, look, spread, sector, style, version }. overall is a number only
 * when the fund was read in full, from holdings that are not too old; brief
 * (inBrief) is what shows in its place when it is not.
 */
export function readFund(fund, ctx, styleId, opts = {}) {
  const st = styleById(styleId);
  const now = opts.now || new Date();
  const scores = companyScores(ctx, st.id, opts.companies);
  const reading = READINGS.includes(fund.reading) ? fund.reading : "none";
  const old = tooOld(fund, now);
  const full = reading === "full" && !old;
  const h = (fund.hold || []).length ? holdingsReading(fund, scores) : null;
  const er = num(fund.er) && fund.er >= 0 ? fund.er : null;
  const cost = costScore(er);
  const sp = fund.spread && num(fund.spread.effN) ? fund.spread : spreadOf(fund.hold);
  const spread = spreadScore(sp);
  const w = er === null ? NO_COST_WEIGHTS : Object.fromEntries(FUND_FACTORS.map((f) => [f.id, f.weight]));

  let blend = null;
  if (full && h && num(spread) && (er === null || num(cost))) {
    blend = w.hold * h.value + w.cost * (cost || 0) + w.spread * spread;
  }

  const factors = [
    { id: "hold", label: "What it owns", weight: w.hold, score: h ? h.value : null,
      why: !h ? (neverRead(fund) ? "Its holdings have not been read." : "None of its holdings could be matched to a company we score.")
        : h.unseen < 0.5 ? "The average dollar is in a company that screens ahead of " + Math.round(h.m) + "% of the S&P 500."
        : "The " + pct0(h.scored) + " we can score averages " + Math.round(h.m) + "; the other " + pct0(h.unseen) + " counts as 50." },
    { id: "cost", label: "What it costs", weight: w.cost, score: cost,
      why: er === null ? "Cost not read: its expense ratio has not been read from its SEC filings."
        : fmtEr(er) + " a year, " + dollars(perTenK(er)) + " on every $10,000." },
    { id: "spread", label: "How spread out", weight: w.spread, score: spread,
      why: !sp ? "Its holdings have not been read."
        : "Behaves like about " + Math.round(sp.effN) + " equal holdings; the largest ten are " + pct0(sp.top10) + " of it." }
  ];

  const look = h ? lookThrough(fund, scores) : null;
  const sector = topSector(fund);

  const notes = [];
  if (!full) notes.push(whyNotRead(fund, now));
  if (er === null) notes.push("Cost not read: its expense ratio has not been read from its SEC filings, so what it owns counts 60% and how spread out it is 40%." +
    (full ? " Until it is, the fund is not ranked against those whose fee has been." : ""));
  if (full && h && h.unseen >= 0.5) {
    notes.push("We can score " + pct0(h.scored) + " of its stock holdings. The other " + pct0(h.unseen) + ", mostly companies outside the S&P 500, counts as average.");
  }
  if (num(fund.other) && fund.other >= 0.5 && fund.other <= 10) {
    notes.push(pct0(fund.other) + " of the fund is cash, money-market funds, futures or other things that are not company shares; the reading leaves them out.");
  }
  if (h && st.id !== DEFAULT_STYLE) {
    notes.push("What it owns is read in the " + st.label + " style: each holding at its score in that style. Cost and spread do not change with the style.");
  }
  if (fund.nport && fund.nport.period) {
    notes.push("Holdings as of " + dateShort(fund.nport.period) + ", from its N-PORT filing. Funds make them public about 60 days after each quarter, so they are months old.");
  }

  const { pros, cons } = fundProsCons(fund, { h, er, cost, sp, spread, look, sector, full, old, reading, factors, scores, funds: opts.funds, now, index: indexProfile(opts.companies) });

  return {
    t: fund.t, kind: "etf", overall: num(blend) ? Math.round(blend) : null, blend, reading,
    brief: num(blend) ? null : inBrief(fund, now),
    factors, notes, pros, cons, hold: h, look, spread: sp, sector, style: st.id, version: FUND_VERSION
  };
}

/* ------------------------------------------------------- for and against

   The same rules as a company's (lib/analysis.mjs prosAndCons): every line
   names the figure that set it off, a factor under 42 keeps a line that
   explains it, a list of cons is never empty just because nothing crossed a
   line, and six a side at most. */

const AREA = { hold: "what it owns", cost: "what it costs", spread: "how spread out it is" };

function fundProsCons(fund, r) {
  const pros = [], cons = [];
  const add = (arr, w, factor, text) => arr.push({ w, factor, text });
  const { h, er, sp, look, sector, full, factors, scores } = r;
  const others = (r.funds || []).filter((g) => g && g.t !== fund.t);
  const assets = fund.nport && num(fund.nport.assets) ? fund.nport.assets : null;
  const years = num(fund.since) ? (r.now || new Date()).getUTCFullYear() - fund.since : null;

  /* cost */
  if (er !== null) {
    const cheaper = others.filter((g) => num(g.er)).length;
    const beats = others.filter((g) => num(g.er) && g.er > er).length;
    if (er <= 0.05) add(pros, 8, "cost", "Costs " + fmtEr(er) + " a year: " + dollars(perTenK(er)) + " on every $10,000.");
    else if (er <= 0.10) add(pros, 5, "cost", "Costs " + fmtEr(er) + " a year, " + dollars(perTenK(er)) + " on $10,000" +
      (cheaper >= 8 ? ", cheaper than " + Math.round((beats / cheaper) * 100) + "% of the funds we cover." : "."));
    if (er >= 0.35) add(cons, er >= 0.60 ? 8 : 6, "cost", "Costs " + fmtEr(er) + " a year. Over ten years at 7% that is about " +
      dollars(Math.round(tenYearCost(er) / 10) * 10) + " of a $10,000 stake, whatever the fund does.");
    /* a twin: the same companies at nearly the same weights, for less */
    let twin = null;
    for (const g of others) {
      if (!num(g.er) || g.er > er - 0.03) continue;
      const o = overlap(fund, g);
      if (num(o) && o >= 95 && (num(g.cover) ? g.cover >= 95 : true) && (num(fund.cover) ? fund.cover >= 95 : true) &&
          (!twin || g.er < twin.g.er)) twin = { g, o };
    }
    if (twin) add(cons, 7, "cost", "Owns the same companies as " + twin.g.t + " (" + Math.round(twin.o) + "% overlap), which costs " +
      fmtEr(twin.g.er) + " against this fund's " + fmtEr(er) + ".");
  }

  /* what it owns */
  if (full && h) {
    const m = Math.round(h.m);
    /* over all of it, or over only the part we can score, which is what h.m is */
    const avg = h.unseen < 0.5 ? "The average dollar here is in a company that screens "
      : "The " + pct0(h.scored) + " we can score is, on average, in companies that screen ";
    if (h.m >= 60) add(pros, h.m >= 70 ? 9 : 6, "hold", avg + "ahead of " + m + "% of the S&P 500.");
    if (h.m < 45) add(cons, h.m < 35 ? 8 : 5, "hold", avg + "behind " + (100 - m) + "% of the S&P 500.");
    if (h.bands.high >= 40) add(pros, 5, "hold", pct0(h.bands.high) + " of its holdings are in companies that screen strongly.");
    if (h.bands.low + h.bands.bad >= 35) add(cons, 6, "hold", pct0(h.bands.low + h.bands.bad) + " of its holdings are in companies that screen poorly or badly.");
    const top = (fund.hold || []).slice(0, 10);
    const weak = top.findIndex(([t, w]) => w >= 2 && num(scores.get(t)?.score) && scores.get(t).score < 20);
    if (weak >= 0) {
      const [t, w] = top[weak];
      add(cons, 5, "hold", "Its " + ORDINAL[weak] + " holding, " + nameOf(scores, t) + ", is " + pctPlain(w, 1) +
        " of it and screens badly (" + scores.get(t).score + ").");
    }
    if (h.scored < 95) add(cons, 7, "hold", "We can score " + pct0(h.scored) + " of its holdings. The other " + pct0(h.unseen) +
      ", mostly companies outside the S&P 500, counts as average.");
    const idx = r.index?.look;
    if (look && num(look.pe) && idx && num(idx.pe)) {
      const said = "Its companies together cost " + x(look.pe, 0) + " their earnings, against " + x(idx.pe, 0) + " for the S&P 500.";
      if (look.pe >= idx.pe * 1.3) add(cons, 5, "hold", said);
      else if (look.pe <= idx.pe * 0.75) add(pros, 4, "hold", said);
    }
    if (look && num(look.losing) && look.losing >= 10) add(cons, 5, null, pct0(look.losing) + " of it is in companies that lost money over the last year.");
    if (look && num(look.dy) && look.dy >= 1.5) {
      add(pros, look.dy >= 2.5 ? 5 : 3, null, "Its companies pay " + pctPlain(look.dy, 1) + " a year in dividends between them" +
        (er !== null ? "; after the " + fmtEr(er) + " fee, about " + pctPlain(look.dy - er, 1) + "." : "."));
    }
  } else if (!full) {
    /* never "nothing stands out" about a fund we could not read */
    add(cons, 9, "hold", r.reading === "partial" && !r.old && num(fund.cover) && !(num(fund.other) && fund.other > 10)
      ? "We can read only " + pct0(fund.cover) + " of what it holds, so it gets no overall reading."
      : whyNotRead(fund, r.now));
  }

  /* how spread out */
  if (sp) {
    const sectorFund = sector && sector[1] >= SECTOR_FUND;
    if (num(sp.top10) && sp.top10 >= 60) add(cons, 8, "spread", "Ten companies are " + pct0(sp.top10) + " of it.");
    if (num(sp.big1) && sp.big1 >= 15) add(cons, 7, "spread", "One company, " + nameOf(scores, sp.big1T) + ", is " + pct0(sp.big1) + " of it.");
    if (sector && !sectorFund && sector[1] >= 40) add(cons, 5, "spread", pct0(sector[1]) + " of it is in one sector, " + sector[0] + ".");
    if (sectorFund) add(cons, 3, "spread", "One sector by design: everything here rises and falls with " + sector[0] + ".");
    if (num(sp.effN) && sp.effN >= 150) add(pros, 6, "spread", "Spread evenly: no company is more than " + pctPlain(sp.big1, 1) + " of it.");
  }

  /* the fund itself */
  if (num(assets) && assets < 1e8) add(cons, 7, null, "Holds " + money(assets) + ". Funds this small close more often; a closure forces a sale and can bring a tax bill.");
  if (num(years) && years < 3) add(cons, 5, null, "Launched in " + fund.since + ". Funds launched on a popular theme have, on average, done worse after launch than before.");
  if (num(assets) && assets >= 1e10 && num(years) && years >= 10) add(pros, 3, null, money(assets) + " in assets and " + years + " years of history.");
  if (num(fund.r52) && fund.r52 <= -20) add(cons, 4, null, "Down " + pct0(-fund.r52) + " over the past year.");

  /* every weak factor keeps a line that explains it */
  const scored = factors.filter((f) => num(f.score));
  const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);
  const weakIds = scored.filter((f) => f.score < WEAK_FACTOR).map((f) => f.id);
  for (const f of scored) {
    if (f.score < WEAK_FACTOR && !cons.some((c) => c.factor === f.id)) {
      add(cons, 4, f.id, f.label + " is weak (" + Math.round(f.score) + "/100): " + lc(f.why));
    }
  }
  if (cons.length < 2) {
    const lowest = scored.filter((f) => !cons.some((c) => c.factor === f.id)).sort((a, b) => a.score - b.score)[0];
    if (lowest && lowest.score < 60) add(cons, 2, lowest.id, "Its weakest area is " + AREA[lowest.id] + " (" + Math.round(lowest.score) + "/100): " + lc(lowest.why));
  }

  const byWeight = (a, b) => b.w - a.w;
  const pick = (arr, keep) => {
    const sorted = arr.slice().sort(byWeight);
    const must = [];
    for (const id of keep) {
      const best = sorted.find((c) => c.factor === id && !must.includes(c));
      if (best) must.push(best);
    }
    const rest = sorted.filter((c) => !must.includes(c)).slice(0, Math.max(0, MAX_ITEMS - must.length));
    return must.concat(rest).sort(byWeight).map((c) => c.text);
  };
  return { pros: pick(pros, []), cons: pick(cons, weakIds) };
}

/* ------------------------------------------------------- every fund at once

   All the readings under one style, worked out once and kept until the
   company scores change (a new snapshot) or the funds do. Each reading read
   in full with its fee also gets its rank among those, for a caption only:
   the headline is the reading itself. A reading whose fee is unread is
   weighed 60/40 instead, so setting it among them would rank two different
   blends against each other; it gets no rank until its fee is read. */
const readCache = new WeakMap();

/** Whether a reading includes the fund's fee. */
export const costRead = (r) => Boolean(r) && num(r.factors.find((f) => f.id === "cost")?.score);

export function readFunds(funds, ctx, styleId, companies) {
  const st = styleById(styleId).id;
  let c = readCache.get(funds);
  if (!c || c.ctx !== ctx || c.companies !== companies) {
    c = { ctx, companies, byStyle: new Map() };
    readCache.set(funds, c);
  }
  let m = c.byStyle.get(st);
  if (m) return m;
  m = new Map();
  for (const f of funds) m.set(f.t, readFund(f, ctx, st, { companies, funds }));
  const ranked = [...m.values()].filter((r) => num(r.blend) && costRead(r));
  for (const r of ranked) r.place = { rank: 1 + ranked.filter((o) => o.blend > r.blend).length, of: ranked.length };
  c.byStyle.set(st, m);
  return m;
}

/** The ETF deck, in order: the funds read in full first, then the rest,
    each largest by net assets first. `readings` is readFunds' map. */
export function deckOrder(list, readings) {
  const later = (f) => (num(readings.get(f.t)?.overall) ? 0 : 1);
  const assets = (f) => (f.nport && num(f.nport.assets) ? f.nport.assets : 0);
  return (list || []).slice().sort((a, b) => later(a) - later(b) || assets(b) - assets(a) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

/** The largest funds by net assets, largest first, leaving out `skip`. */
export function largestFunds(funds, n, skip) {
  const out = new Set(skip || []);
  return (funds || []).filter((f) => !out.has(f.t))
    .sort((a, b) => ((b.nport && b.nport.assets) || 0) - ((a.nport && a.nport.assets) || 0))
    .slice(0, n);
}
