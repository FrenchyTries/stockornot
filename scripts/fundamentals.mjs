/* ==========================================================================
   StockOrNot — a company's financials from its own SEC filings
   --------------------------------------------------------------------------
   Reads one company's XBRL "companyfacts" (every fact it has ever filed) and
   returns the last five fiscal years as the company itself reported them.

   This replaced reading the SEC's calendar-year "frames", which put every
   filer on a December calendar. That was wrong in ways that showed:
     - a June or September year-end company showed last year's figures for
       months after filing the new 10-K, and its balance sheet was a 10-Q's;
     - years were labelled by the frame, not by the company's own fiscal year,
       so NVIDIA's fiscal 2025 read "FY2024" and one company had a year twice;
     - the first revenue tag with any value won, so REITs and banks recorded
       a small ASC 606 sub-line as total revenue ("FCF 1337% of revenue");
     - a per-company fallback took whichever tag came first even if the
       company stopped using it years ago, so a utility showed 2018 revenue
       and zero capex as "FY2025".

   Rules here, in order of how often they matter:
     - A fiscal year is a period of 340–380 days reported on a 10-K. It is
       labelled with the fiscal year of the filing that first reported it as
       its own year, which is the company's own name for it.
     - For each year, each concept takes the first tag in its list that has a
       value for that exact period; revenue takes the largest candidate,
       because the alternatives are sub-lines, never supersets.
     - Balance-sheet figures are the ones dated at that fiscal year's end.
     - Where a period was restated in a later filing, the latest one wins.
     - Share counts are put on the latest 10-K's basis using the company's own
       restatements: a filing that reported a period the newest 10-K also
       reports tells us exactly how to scale everything else it reported.
       That catches every real split and never mistakes a merger for one.

   No network, no filesystem: give it the parsed JSON, get plain data back.
   ========================================================================== */

const MIN_DAYS = 340, MAX_DAYS = 380;
const YEARS = 5;

const CONCEPTS = {
  revenue: { mode: "max", tags: [
    "Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet", "SalesRevenueGoodsNet",
    "RevenuesNetOfInterestExpense", "RegulatedAndUnregulatedOperatingRevenue", "RealEstateRevenueNet",
    "OperatingLeasesIncomeStatementLeaseRevenue", "RevenuesNetOfInterestExpenseAndProvisionForLoanLosses"
  ] },
  netIncome: { tags: ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"] },
  ocf:       { tags: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"] },
  capex:     { mode: "max", tags: [
    "PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets",
    "PaymentsForCapitalImprovements", "PaymentsToAcquireOilAndGasPropertyAndEquipment",
    "PaymentsToAcquireOilAndGasProperty"
  ] },
  grossProfit: { tags: ["GrossProfit"] },
  opIncome:  { tags: ["OperatingIncomeLoss"] },
  assets:    { instant: true, tags: ["Assets"] },
  liabs:     { instant: true, tags: ["Liabilities"] },
  equity:    { instant: true, tags: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"] },
  cash:      { instant: true, tags: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"] },
  debt:      { instant: true, tags: ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"] },
  shares:    { unit: "shares", tags: ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"] }
};

const num = (v) => typeof v === "number" && isFinite(v);
const days = (a, b) => (new Date(b) - new Date(a)) / 864e5;
const isAnnualForm = (form) => form === "10-K" || form === "10-K/A" || form === "10-KT";

function factsOf(gaap, tag, unit = "USD") {
  const u = gaap?.[tag]?.units?.[unit];
  return Array.isArray(u) ? u : [];
}

/* Annual facts for one tag: flows need a 340–380 day period, instants none. */
function annual(gaap, tag, { instant = false, unit = "USD" } = {}) {
  return factsOf(gaap, tag, unit).filter((f) => {
    if (!num(f.val) || !f.end || !isAnnualForm(f.form)) return false;
    if (instant) return !f.start;
    if (!f.start) return false;
    const d = days(f.start, f.end);
    return d >= MIN_DAYS && d <= MAX_DAYS;
  });
}

/* The latest-filed fact for a given period end (±7 days for 52/53-week
   calendars reported with slightly different end dates). */
function latestFor(facts, end, tol = 7) {
  let best = null;
  for (const f of facts) {
    if (Math.abs(days(f.end, end)) > tol) continue;
    if (!best || f.filed > best.filed || (f.filed === best.filed && f.accn > best.accn)) best = f;
  }
  return best;
}

/* ----------------------------------------------------------- fiscal years */

/* Every fiscal year end the company has reported on a 10-K, newest first,
   with the label the company gave it. The label comes from the filing that
   first reported the period, whose `fy` is that period's own fiscal year;
   later filings carry it as a comparative under their own, later `fy`. */
function fiscalYears(gaap) {
  const seen = new Map();          /* end -> { end, fy, filed } */
  for (const key of ["revenue", "netIncome", "ocf"]) {
    for (const tag of CONCEPTS[key].tags) {
      for (const f of annual(gaap, tag)) {
        let slot = null;
        for (const s of seen.values()) if (Math.abs(days(s.end, f.end)) <= 7) { slot = s; break; }
        if (!slot) { slot = { end: f.end, fy: null, filed: null }; seen.set(f.end, slot); }
        if (f.end > slot.end) slot.end = f.end;
        if (num(f.fy) && (!slot.filed || f.filed < slot.filed)) { slot.fy = f.fy; slot.filed = f.filed; }
      }
    }
  }
  const out = [...seen.values()].sort((a, b) => (a.end < b.end ? 1 : -1));
  /* A filing's fy is occasionally off for its own period (a transition year,
     a late 10-K/A). Fall back to the end year, and never let two periods
     share a label: the older one steps back a year. */
  let last = Infinity;
  for (const p of out) {
    let fy = num(p.fy) ? p.fy : Number(p.end.slice(0, 4));
    if (fy >= last) fy = last - 1;
    p.fy = fy;
    last = fy;
  }
  return out;
}

/* ------------------------------------------------------------ one concept */

function valueFor(gaap, spec, end) {
  const opts = { instant: !!spec.instant, unit: spec.unit || "USD" };
  if (spec.mode === "max") {
    let best = null;
    for (const tag of spec.tags) {
      const f = latestFor(annual(gaap, tag, opts), end, spec.instant ? 3 : 7);
      if (f && (best === null || f.val > best)) best = f.val;
    }
    return best;
  }
  for (const tag of spec.tags) {
    const f = latestFor(annual(gaap, tag, opts), end, spec.instant ? 3 : 7);
    if (f) return f.val;
  }
  return null;
}

/* Banks rarely tag a revenue total. Net interest income plus non-interest
   income is what they report as revenue, and is offered as a candidate. */
function bankRevenue(gaap, end) {
  const nii = latestFor(annual(gaap, "InterestIncomeExpenseNet"), end);
  const non = latestFor(annual(gaap, "NoninterestIncome"), end);
  return nii && non ? nii.val + non.val : null;
}

/* Liabilities are often only tagged as "liabilities and equity"; subtract. */
function derivedLiabilities(gaap, end, equity) {
  const total = latestFor(annual(gaap, "LiabilitiesAndStockholdersEquity", { instant: true }), end, 3);
  if (!total) return null;
  const withNci = latestFor(annual(gaap, "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", { instant: true }), end, 3);
  const eq = withNci ? withNci.val : equity;
  return num(eq) ? total.val - eq : null;
}

/* ---------------------------------------------------------------- shares */

/* Put every year's share count on the basis of the newest 10-K. A filing
   that reported periods the newest one also reports shows the ratio between
   its units and today's: a 2:1 split since then reads exactly 2.0 on those
   overlapping years, a merger reads 1.0. Only that measured ratio is used. */
function restatedShares(gaap, periods) {
  for (const tag of CONCEPTS.shares.tags) {
    const facts = annual(gaap, tag, { unit: "shares" });
    if (!facts.length) continue;
    const newestEnd = periods[0]?.end;
    const newest = newestEnd && latestFor(facts, newestEnd);
    if (!newest) continue;
    const newestAccn = newest.accn;
    const inNewest = (end) => facts.find((f) => f.accn === newestAccn && Math.abs(days(f.end, end)) <= 7);

    const scaleCache = new Map();
    const scaleOf = (accn) => {
      if (accn === newestAccn) return 1;
      if (scaleCache.has(accn)) return scaleCache.get(accn);
      const ratios = [];
      for (const f of facts) {
        if (f.accn !== accn) continue;
        const n = inNewest(f.end);
        if (n && f.val > 0) ratios.push(n.val / f.val);
      }
      ratios.sort((a, b) => a - b);
      const r = ratios.length ? ratios[ratios.length >> 1] : 1;
      const s = Math.abs(r - 1) > 0.02 ? r : 1;
      scaleCache.set(accn, s);
      return s;
    };

    const out = {};
    for (const p of periods) {
      const f = latestFor(facts, p.end);
      if (!f) continue;
      out[p.fy] = Math.round(f.val * scaleOf(f.accn));
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

/* ------------------------------------------------------- missing capex

   Capital spending goes by many names. When operating cash flow is there and
   none of the capex tags above is, the outflows in the same period whose
   names look like spending on assets are listed, largest first. Nothing uses
   them as figures; they go into the cache and the audit, so the tag a company
   really uses can be added to the list on evidence rather than by guesswork. */
const CAPEX_LIKE = /^(PaymentsToAcquire|PaymentsFor|PaymentsToDevelop|PaymentsToConstruct|PaymentsToExplore|CapitalExpenditure)/;
const NOT_CAPEX = /Business|Investment|Securit|Loan|Interest|Dividend|Repurchase|Tax|Debt|Equity|Share|Stock|Note|Pension|Restructuring|Legal|Contingent|Derivative|Hedg|Financ|Receivable|Mortgage|Affiliate|Subsidiar|Noncontrolling|Partnership|JointVenture|Retire|Settle/;

function capexCandidates(gaap, end) {
  const out = [];
  for (const tag of Object.keys(gaap)) {
    if (!CAPEX_LIKE.test(tag) || NOT_CAPEX.test(tag) || CONCEPTS.capex.tags.includes(tag)) continue;
    const f = latestFor(annual(gaap, tag), end);
    if (f && f.val > 0) out.push({ tag, val: f.val });
  }
  return out.sort((a, b) => b.val - a.val).slice(0, 6);
}

/* ------------------------------------------------------------------ main */

/**
 * @param {object} companyfacts  parsed JSON from data.sec.gov/api/xbrl/companyfacts
 * @param {object} [opt]
 * @param {string} [opt.latestPeriod]  period end of the newest 10-K (from submissions)
 * @returns {{ fin, history, end, fy, current } | null}
 */
export function extractFundamentals(companyfacts, { latestPeriod = null } = {}) {
  const gaap = companyfacts?.facts?.["us-gaap"];
  if (!gaap) return null;

  const periods = fiscalYears(gaap).slice(0, YEARS);
  if (!periods.length) return null;

  const history = {};
  const put = (key, fy, v) => { if (num(v)) (history[key] ||= {})[fy] = v; };

  for (const p of periods) {
    for (const [key, spec] of Object.entries(CONCEPTS)) {
      if (key === "shares") continue;
      let v = valueFor(gaap, spec, p.end);
      if (key === "revenue") {
        const bank = bankRevenue(gaap, p.end);
        if (num(bank) && (!num(v) || bank > v)) v = bank;
      }
      put(key, p.fy, v);
    }
    if (!num(history.liabs?.[p.fy])) put("liabs", p.fy, derivedLiabilities(gaap, p.end, history.equity?.[p.fy]));
  }
  const shares = restatedShares(gaap, periods);
  if (shares) history.shares = shares;

  const [cur, prev] = periods;
  const at = (key, p) => (p ? history[key]?.[p.fy] ?? null : null);
  const ocf = at("ocf", cur), capex = at("capex", cur);
  const fin = {
    revenue: at("revenue", cur), revenuePrev: at("revenue", prev),
    netIncome: at("netIncome", cur), netIncomePrev: at("netIncome", prev),
    assets: at("assets", cur), liabs: at("liabs", cur), equity: at("equity", cur),
    cash: at("cash", cur), debt: at("debt", cur),
    ocf, capex,
    fcf: num(ocf) && num(capex) ? ocf - capex : null,
    fy: cur.fy, end: cur.end
  };

  /* Does the newest period here match the newest 10-K? Right after a filing
     the facts API can lag by a few hours; the caller should not cache that. */
  const current = !latestPeriod || Math.abs(days(cur.end, latestPeriod)) <= 20;

  if (!num(fin.revenue) && !num(fin.netIncome)) return null;
  const out = { fin, history, end: cur.end, fy: cur.fy, current, sharesRestated: !!shares };
  if (num(ocf) && !num(capex)) out.capexCandidates = capexCandidates(gaap, cur.end);
  return out;
}

export const FUNDAMENTALS_VERSION = 1;
