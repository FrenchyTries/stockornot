import assert from "node:assert/strict";
import { extractFundamentals } from "../scripts/fundamentals.mjs";

/* helpers to build companyfacts-shaped fixtures */
const F = (start, end, val, fy, filed, accn, form = "10-K") => ({ start, end, val, fy, fp: "FY", form, filed, accn });
const I = (end, val, fy, filed, accn, form = "10-K") => ({ end, val, fy, fp: "FY", form, filed, accn });
const cf = (gaap) => ({ cik: 1, entityName: "Test", facts: { "us-gaap": Object.fromEntries(Object.entries(gaap).map(([t, u]) => [t, { units: u }])) } });

/* ---- 1. June year-end, split, stale capex tag, 10-Q instant ignored ---- */
{
  // filings: K22 (FY2022, filed 2022-07-28), K23, K24, K25, K26 (FY2026, filed 2026-07-30)
  const acc = { 22: "a-22", 23: "a-23", 24: "a-24", 25: "a-25", 26: "a-26" };
  const filed = { 22: "2022-07-28", 23: "2023-07-27", 24: "2024-07-30", 25: "2025-07-30", 26: "2026-07-30" };
  const per = (y) => [`${y - 1}-07-01`, `${y}-06-30`];
  const rev = { 2020: 140, 2021: 168, 2022: 198, 2023: 212, 2024: 245, 2025: 282, 2026: 330 };
  const revenueFacts = [];
  for (const k of [22, 23, 24, 25, 26]) for (const y of [2000 + k, 1999 + k, 1998 + k]) revenueFacts.push(F(...per(y), rev[y], 2000 + k, filed[k], acc[k]));
  // shares: 2:1 split during FY2025 -> K25 and K26 report post-split counts for all their periods
  const pre = { 2020: 7.6, 2021: 7.55, 2022: 7.5, 2023: 7.45, 2024: 7.43 };      // billions, pre-split
  const shares = [];
  for (const k of [22, 23, 24]) for (const y of [2000 + k, 1999 + k, 1998 + k]) shares.push(F(...per(y), pre[y] * 1e9, 2000 + k, filed[k], acc[k]));
  for (const k of [25, 26]) for (const y of [2000 + k, 1999 + k, 1998 + k]) shares.push(F(...per(y), (y >= 2025 ? 14.8 - (y - 2025) * 0.1 : pre[y] * 2) * 1e9, 2000 + k, filed[k], acc[k]));
  const data = cf({
    RevenueFromContractWithCustomerExcludingAssessedTax: { USD: revenueFacts },
    NetIncomeLoss: { USD: [F(...per(2026), 101, 2026, filed[26], acc[26]), F(...per(2025), 88, 2026, filed[26], acc[26]), F(...per(2025), 88, 2025, filed[25], acc[25])] },
    NetCashProvidedByUsedInOperatingActivities: { USD: [F(...per(2026), 136, 2026, filed[26], acc[26]), F(...per(2025), 118, 2025, filed[25], acc[25])] },
    // old capex tag stopped in FY2019; new tag used since
    PaymentsToAcquireProductiveAssets: { USD: [F("2018-07-01", "2019-06-30", 13, 2019, "2019-08-01", "a-19")] },
    PaymentsToAcquirePropertyPlantAndEquipment: { USD: [F(...per(2026), 64, 2026, filed[26], acc[26]), F(...per(2025), 44, 2025, filed[25], acc[25])] },
    Assets: { USD: [I("2026-06-30", 620, 2026, filed[26], acc[26]), I("2025-12-31", 590, 2026, "2026-01-28", "q-26", "10-Q"), I("2025-06-30", 512, 2025, filed[25], acc[25])] },
    StockholdersEquity: { USD: [I("2026-06-30", 390, 2026, filed[26], acc[26])] },
    LiabilitiesAndStockholdersEquity: { USD: [I("2026-06-30", 620, 2026, filed[26], acc[26])] },
    WeightedAverageNumberOfDilutedSharesOutstanding: { shares: shares }
  });
  const r = extractFundamentals(data, { latestPeriod: "2026-06-30" });
  assert.equal(r.fy, 2026, "labelled with the company's own fiscal year");
  assert.equal(r.fin.revenue, 330); assert.equal(r.fin.revenuePrev, 282);
  assert.equal(r.fin.capex, 64, "stale capex tag must not win");
  assert.equal(r.fin.fcf, 72);
  assert.equal(r.fin.assets, 620, "balance sheet at the fiscal-year end, not the 10-Q");
  assert.equal(r.fin.liabs, 230, "liabilities derived from L+E minus equity");
  assert.deepEqual(Object.keys(r.history.revenue).map(Number).sort(), [2022, 2023, 2024, 2025, 2026]);
  assert.equal(r.current, true);
  // shares: FY2022/2023 came from pre-split filings; must be doubled
  assert.equal(r.history.shares[2022], 15e9);
  assert.equal(r.history.shares[2023], 14.9e9);
  assert.equal(r.history.shares[2026], 14.7e9); assert.equal(r.history.shares[2025], 14.8e9);
  assert.equal(r.sharesRestated, true);
  console.log("ok 1: June FY, split, stale tag, 10-Q instant", r.history.shares);
}

/* ---- 2. REIT: ASC 606 sub-line must not be taken as revenue ---- */
{
  const data = cf({
    RevenueFromContractWithCustomerExcludingAssessedTax: { USD: [F("2025-01-01", "2025-12-31", 7e6, 2025, "2026-02-20", "r-25"), F("2024-01-01", "2024-12-31", 6e6, 2024, "2025-02-20", "r-24")] },
    Revenues: { USD: [F("2025-01-01", "2025-12-31", 3.08e9, 2025, "2026-02-20", "r-25"), F("2024-01-01", "2024-12-31", 2.9e9, 2024, "2025-02-20", "r-24")] },
    NetIncomeLoss: { USD: [F("2025-01-01", "2025-12-31", 1.1e9, 2025, "2026-02-20", "r-25")] }
  });
  const r = extractFundamentals(data, { latestPeriod: "2025-12-31" });
  assert.equal(r.fin.revenue, 3.08e9); assert.equal(r.fin.revenuePrev, 2.9e9); assert.equal(r.fy, 2025);
  console.log("ok 2: REIT revenue total wins over ASC 606 sub-line");
}

/* ---- 3. Bank: revenue = net interest income + non-interest income ---- */
{
  const d = ["2025-01-01", "2025-12-31"];
  const data = cf({
    RevenueFromContractWithCustomerExcludingAssessedTax: { USD: [F(...d, 20e9, 2025, "2026-02-14", "b-25")] },
    InterestIncomeExpenseNet: { USD: [F(...d, 92e9, 2025, "2026-02-14", "b-25")] },
    NoninterestIncome: { USD: [F(...d, 88e9, 2025, "2026-02-14", "b-25")] },
    NetIncomeLoss: { USD: [F(...d, 57e9, 2025, "2026-02-14", "b-25")] }
  });
  const r = extractFundamentals(data, {});
  assert.equal(r.fin.revenue, 180e9);
  console.log("ok 3: bank revenue from NII + non-interest income");
}

/* ---- 4. Merger doubling share count is NOT a split ---- */
{
  const acc = (y) => "m-" + y, filed = (y) => `${y + 1}-02-20`, p = (y) => [`${y}-01-01`, `${y}-12-31`];
  const real = { 2021: 1.0e9, 2022: 1.02e9, 2023: 2.1e9, 2024: 2.12e9, 2025: 2.13e9 };   // merger in 2023
  const sh = [];
  for (const k of [2023, 2024, 2025]) for (const y of [k, k - 1, k - 2]) sh.push(F(...p(y), real[y], k, filed(k), acc(k)));
  const rv = [];
  for (const y of [2021, 2022, 2023, 2024, 2025]) rv.push(F(...p(y), 10e9 + y, y, filed(y), acc(y)));
  const r = extractFundamentals(cf({ Revenues: { USD: rv }, WeightedAverageNumberOfDilutedSharesOutstanding: { shares: sh } }), {});
  assert.equal(r.history.shares[2021], 1.0e9, "no invented split");
  assert.equal(r.history.shares[2023], 2.1e9);
  console.log("ok 4: merger issuance left as real dilution");
}

/* ---- 5. January year-end (NVIDIA-style) labels ---- */
{
  const rv = [
    F("2024-01-29", "2025-01-26", 130.5e9, 2025, "2025-02-26", "n-25"),
    F("2023-01-30", "2024-01-28", 60.9e9, 2025, "2025-02-26", "n-25"),
    F("2023-01-30", "2024-01-28", 60.9e9, 2024, "2024-02-21", "n-24"),
    F("2025-01-27", "2026-01-25", 210e9, 2026, "2026-02-25", "n-26"),
    F("2024-01-29", "2025-01-26", 130.5e9, 2026, "2026-02-25", "n-26")
  ];
  const r = extractFundamentals(cf({ Revenues: { USD: rv } }), { latestPeriod: "2026-01-25" });
  assert.equal(r.fy, 2026); assert.equal(r.history.revenue[2025], 130.5e9); assert.equal(r.history.revenue[2024], 60.9e9);
  console.log("ok 5: January year-end labelled FY2026 / FY2025 like the company does");
}

/* ---- 6. facts lag the newest 10-K -> not current ---- */
{
  const r = extractFundamentals(cf({ Revenues: { USD: [F("2024-07-01", "2025-06-30", 1e9, 2025, "2025-08-01", "x")] } }), { latestPeriod: "2026-06-30" });
  assert.equal(r.current, false);
  console.log("ok 6: lagging facts flagged as not current");
}
console.log("all fundamentals tests passed");
