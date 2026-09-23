import assert from "node:assert/strict";
import { parseTenK } from "../scripts/tenk.mjs";

const filler = (n, word = "operations") => Array.from({ length: n }, (_, i) => `<p>We describe our ${word} in detail here, sentence ${i}, with enough ordinary prose to look like a real filing section that runs on.</p>`).join("\n");
const risks = Array.from({ length: 20 }, (_, i) => `<p><b>Risk number ${i + 1}: disruption in our supply chain could adversely affect our margins and results.</b></p>` + filler(3, "risk"));

/* ---- A: standard layout, with every trap ---- */
{
  const html = `<html><body>
<div><p>TABLE OF CONTENTS</p>
<p><a href="#item1business_912593">Item 1. Business</a> 3</p>
<p><a href="#i1a">Item 1A. Risk Factors</a> 12</p>
<p><a href="#i1b">Item 1B. Unresolved Staff Comments</a> 30</p>
<p><a href="#i2">Item 2. Properties</a> 31</p></div>
<div id="item1business_912593"><p><b>Item 1. Business</b></p>
<p>General</p>
<p>Acme Corporation designs and sells industrial widgets through its Nestl&#233; partnership and its Acme&#174; brand. See Item 1A. Risk Factors for more.</p>
${filler(30)}
</div>
<div id="i1a"><p><b>Item 1A. Risk Factors</b></p>
<p><b>Risks Related to Our Business</b></p>
${risks.slice(0, 10).join("\n")}
<p><b>Legal and Regulatory Risks</b></p>
${risks.slice(10).join("\n")}
</div>
<div id="i1b"><p><b>Item 1B. Unresolved Staff Comments</b></p><p>None.</p></div>
<p><b>Item 2. Properties</b></p>${filler(5)}
<p><b>Item 7. Management's Discussion and Analysis of Financial Condition</b></p>
<p>As discussed in Item 1A. Risk Factors, our business is exposed to risk.</p>
<p><b>Results of Operations for the fiscal year compared with the prior year</b></p>
<p><b>Liquidity and Capital Resources and our financing arrangements</b></p>
<p><b>Consolidated Statements of Operations for the years presented</b></p>
<p><b>Report of Independent Registered Public Accounting Firm to shareholders</b></p>
${filler(200, "financials")}
</body></html>`;
  const r = parseTenK(html);
  assert.ok(r.business.startsWith("Acme Corporation designs"), "business starts at the prose: " + r.business.slice(0, 60));
  assert.ok(r.business.includes("Nestlé") && r.business.includes("Acme®"), "entities decoded");
  assert.ok(!/">/.test(r.business), "no markup debris");
  assert.equal(r.risks.length, 20, "all 20 risks, no cap at 14, no group titles: " + r.risks.length);
  assert.ok(!r.risks.some((t) => /Risks Related|Regulatory Risks|Results of Operations|Consolidated|Independent/.test(t)));
  console.log("ok A: standard layout", r.risks.length, "risks");
}

/* ---- B: "Item 1.A." style (Clorox) ---- */
{
  const html = `<html><body>
<p>Item 1. Business 1 Item 1.A. Risk Factors 7 Item 1.B. Unresolved Staff Comments 20 Item 1.C. Cybersecurity 21 Item 2. Properties 22 Item 3. Legal Proceedings</p>
<p><b>Item 1. Business</b></p>
<p>The Company is a leading multinational manufacturer and marketer of consumer and professional products.</p>${filler(25)}
<p><b>Item 1.A. Risk Factors</b></p>${risks.slice(0, 6).join("\n")}
<p><b>Item 1.B. Unresolved Staff Comments</b></p><p>None.</p>${filler(40)}
</body></html>`;
  const r = parseTenK(html);
  assert.ok(r.business.startsWith("The Company is a leading"), "not the table of contents: " + r.business.slice(0, 60));
  assert.equal(r.risks.length, 6);
  console.log("ok B: Item 1.A. style");
}

/* ---- C: "Item 1(a)" style (Halliburton) ---- */
{
  const html = `<html><body>
<p>Item 1. Business 1 Item 1(a). Risk Factors 9 Item 1(b). Unresolved Staff Comments 19 Item 2. Properties 20</p>
<p><b>Item 1. Business</b></p>
<p>We are one of the world's largest providers of products and services to the energy industry.</p>${filler(25)}
<p><b>Item 1(a). Risk Factors</b></p>${risks.slice(0, 5).join("\n")}
<p><b>Item 1(b). Unresolved Staff Comments</b></p><p>None.</p>${filler(40)}
</body></html>`;
  const r = parseTenK(html);
  assert.ok(r.business.startsWith("We are one of the world"), "not the table of contents: " + r.business.slice(0, 60));
  assert.equal(r.risks.length, 5);
  console.log("ok C: Item 1(a) style");
}

/* ---- D: only the wrong section is findable -> no risks rather than statements ---- */
{
  const html = `<html><body>
<p><b>Item 1. Business</b></p><p>We make things that people buy, in many countries, through many channels, every day of the year.</p>${filler(25)}
<p><b>Item 1A. Risk Factors</b></p><p>See our annual report exhibit.</p>
<p><b>Item 1B. Unresolved Staff Comments</b></p><p>None.</p>
<p><b>Item 7. Management's Discussion and Analysis</b></p>
<p><b>Consolidated Statements of Operations for the years presented</b></p>
<p><b>Consolidated Balance Sheets as of the dates presented here</b></p>
<p><b>Report of Independent Registered Public Accounting Firm to the board</b></p>${filler(100)}
</body></html>`;
  const r = parseTenK(html);
  assert.ok(r && r.business.startsWith("We make things"));
  assert.ok(!r.risks.some((t) => /Consolidated|Independent/.test(t)), "never publishes statement headings as risks: " + JSON.stringify(r.risks));
  console.log("ok D: statements not published as risks", r.risks.length);
}
console.log("all tenk tests passed");
