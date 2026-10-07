/* ==========================================================================
   StockOrNot — reading a 10-K
   --------------------------------------------------------------------------
   Pulls two things out of a 10-K's HTML: the opening of Item 1 (what the
   company says it does) and the headings of Item 1A (the risks it lists).
   Filers mark these sections up in hundreds of different ways, so this is
   heuristic by nature; every rule below exists because a real filing broke
   the one before it. Pure functions, no network: scripts/refresh.mjs
   downloads, this reads.
   ========================================================================== */

/* Entities that actually turn up in 10-Ks. Numeric ones are decoded
   generically; anything left over becomes a space rather than "&#174;". */
const NAMED = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", hellip: "…", reg: "®", trade: "™",
  copy: "©", bull: "•", middot: "·", sect: "§", eacute: "é", egrave: "è", aacute: "á",
  oacute: "ó", uacute: "ú", iacute: "í", ntilde: "ñ", ouml: "ö", uuml: "ü", auml: "ä", ccedil: "ç"
};

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);?/g, (m, d) => { const n = Number(d); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "; })
    .replace(/&#x([0-9a-f]+);?/gi, (m, h) => { const n = parseInt(h, 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "; })
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? " ")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/ /g, " ");
}

export const stripTags = (html) =>
  decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^<>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();

/* 10-K markup is wildly inconsistent between filers. Normalising the invisible
   whitespace entities first is what makes "Item&#160;1A." findable at all. */
function normalizeHtml(html) {
  return html.replace(/&nbsp;|&#160;|&#xa0;|&#xA0;|&#8203;|&#x200b;/gi, " ");
}

/* Build a regex for an Item heading that tolerates tags and entities appearing
   between every single token — "Item", "1A", the punctuation and the word.
   Numbers are written like "1a" or "1b|2"; the letter may also be written
   "1.A", "1(a)" or "1 A", all of which real filers use. */
function itemRe(numbers, word, flags) {
  /* [^<>], not [^>]: on a stray "<" with no closing ">" the looser class
     makes every attempt scan to the end of the document, and a filing full
     of them took minutes (it would have been hours on a large one). */
  const gap = "(?:\\s|<[^<>]*>)*";
  const one = (n) => {
    const m = /^(\d+)([a-z])?$/i.exec(n);
    /* the letter must stand alone: "1. Business" is not "1B" */
    return m[2] ? `${m[1]}${gap}[.(]?${gap}${m[2]}\\)?(?![a-z])` : `${m[1]}(?![0-9])`;
  };
  const number = `(?:${numbers.split("|").map(one).join("|")})`;
  return new RegExp(`item${gap}${number}${gap}[.:\\-—]?${gap}${word}`, flags);
}

/* True when index i sits inside a tag, e.g. in id="item1business_912593".
   Headings found there start the slice in the middle of markup. */
function insideTag(html, i) {
  /* a tag is never this long; looking further back made every candidate
     heading a scan of the whole document so far */
  const before = html.slice(Math.max(0, i - 4000), i + 1);
  return before.lastIndexOf("<") > before.lastIndexOf(">");
}

/* A real heading starts its own block; a cross-reference ("see Item 1A.
   Risk Factors") sits mid-sentence. Look back past tags and whitespace. */
function startsBlock(html, i) {
  const before = html.slice(Math.max(0, i - 400), i).replace(/<[^<>]*>/g, "\n");
  return /(^|\n)\s*$/.test(before);
}

/** Slice the HTML between two Item headings, skipping the table of contents.
    A start with no end marker after it is not a section at all: it is a
    late cross-reference, and used to win because "the rest of the document"
    is long. Such candidates are rejected. */
/* A table-of-contents entry is followed at once by more Items ("Item 1.
   Business 1 Item 1A. Risk Factors 7 Item 1B…"); a real heading by prose. */
function tocLike(html, i) {
  const text = stripTags(html.slice(i, i + 2500)).slice(0, 350);
  return (text.match(/\bitem\s*\d/gi) || []).length >= 3;
}

function sliceItem(html, startRe, endRe, minLen = 1500) {
  const starts = [...html.matchAll(startRe)].map((m) => m.index)
    .filter((i) => !insideTag(html, i) && !tocLike(html, i));
  if (!starts.length) return null;
  /* The end is the next Item heading that starts its own block. A mention
     of it inside a sentence ("see Item 1A. Risk Factors") is not the end,
     it is a cross-reference, and used to cut the section off after a line. */
  const endAll = new RegExp(endRe.source, endRe.flags.includes("g") ? endRe.flags : endRe.flags + "g");
  const endAfter = (from) => {
    endAll.lastIndex = from;
    let loose = -1, m;
    while ((m = endAll.exec(html)) !== null) {
      if (insideTag(html, m.index)) continue;
      if (startsBlock(html, m.index)) return m.index;
      if (loose === -1) loose = m.index;
      if (m.index - from > 1500000) break;
    }
    return loose;
  };
  const found = [];
  for (const s of starts) {
    const e = endAfter(s + 20);
    if (e === -1) continue;
    const len = e - s;
    if (len > minLen) found.push({ s, len, block: startsBlock(html, s) });
  }
  if (!found.length) return null;
  /* the ToC mention is followed almost immediately by the next item, so of
     the real headings prefer the longest run of content */
  const pool = found.some((f) => f.block) ? found.filter((f) => f.block) : found;
  const best = pool.reduce((a, b) => (b.len > a.len ? b : a));
  return html.slice(best.s, best.s + Math.min(best.len, 1200000));
}

const BOILERPLATE = /^(table of contents|part\s+[ivx]+|item\s+\d|risk factors?|forward-looking|see also|index)/i;

/* Group titles inside the risk section ("Risks Related to Our Business")
   are not risks. Only rejected when they carry no verb, so a real heading
   such as "Risks related to our debt could limit our flexibility" stays. */
const GROUP_TITLE = /^(?:(?:general|other|additional|certain)\s+)?(?:risks?|factors?)\s+(?:related|relating|associated|specific|pertaining|regarding|attributable)\s+(?:to|with)\b|^(?:general|other|additional)\s+risks?\b|^summary\s+(?:of\s+)?risk/i;
const HAS_VERB = /\b(?:could|may|might|will|would|can|cannot|is|are|was|were|be|been|has|have|had|adversely|affect|harm|expose|subject|depend|reduce|increase|limit|result|cause|require|fail|face|impair)\b/i;

/* Headings from the financial statements, MD&A or the auditor's report mean
   the slice landed in the wrong part of the filing. */
const WRONG_SECTION = /\b(?:consolidated\s+(?:balance\s+sheets?|statements?\s+of)|statements?\s+of\s+(?:operations|income|earnings|cash\s+flows|comprehensive|stockholders|shareholders|changes\s+in|financial\s+(?:position|condition))|report\s+of\s+independent|critical\s+audit\s+matter|management'?s\s+discussion|critical\s+accounting|notes?\s+to\s+(?:the\s+)?(?:consolidated\s+)?financial|quantitative\s+and\s+qualitative|results\s+of\s+operations|liquidity\s+and\s+capital\s+resources|selected\s+financial\s+data|market\s+for\s+(?:the\s+)?registrant)/i;

function usableHeading(text) {
  if (text.length < 35 || text.length > 230) return false;
  if (!/[a-z]/.test(text)) return false;              /* skip ALL-CAPS chrome */
  if (BOILERPLATE.test(text)) return false;
  if (!/\s/.test(text)) return false;
  if (GROUP_TITLE.test(text) && !HAS_VERB.test(text)) return false;
  if (text.length <= 90 && /\brisks?$/i.test(text) && !HAS_VERB.test(text)) return false;
  return true;
}

/* Enough for any real risk section; the old limit of 14 cut off almost
   every filing while the app called the list "every risk factor". */
const MAX_RISKS = 80;

/** Risk-factor headings: bold/italic tags, or spans styled bold. */
function headingsFrom(chunk) {
  const out = [];
  const seen = new Set();
  let wrong = 0;
  const push = (raw) => {
    const text = stripTags(raw);
    if (WRONG_SECTION.test(text) && text.length < 120) { wrong++; return; }
    if (!usableHeading(text)) return;
    const key = text.toLowerCase().slice(0, 60);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text.replace(/\s*[.;:]\s*$/, ""));
  };

  let m;
  const tagRe = /<(b|strong|em|i)[^>]*>([\s\S]{0,800}?)<\/\1>/gi;
  while ((m = tagRe.exec(chunk)) !== null && out.length < MAX_RISKS) push(m[2]);

  if (out.length < 3) {
    /* many filers style headings inline instead of using <b> */
    const styleRe = /<(span|p|div)[^>]*style="[^"]*font-(?:weight|style)\s*:\s*(?:bold|700|800|italic)[^"]*"[^>]*>([\s\S]{0,800}?)<\/\1>/gi;
    while ((m = styleRe.exec(chunk)) !== null && out.length < MAX_RISKS) push(m[2]);
  }

  /* Statement or auditor headings in the list: the slice is not the risk
     section. Say it could not be read rather than publish them as risks. */
  if (wrong >= 2) return [];

  if (out.length < 3) {
    /* last resort: pull sentences that actually state a risk */
    const text = stripTags(chunk);
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      const t = s.trim().replace(/\s*[.;:]\s*$/, "");
      if (t.length < 60 || t.length > 230) continue;
      if (!/\b(could|may|might|risk|adversely|failure|unable|depend)\b/i.test(t)) continue;
      if (BOILERPLATE.test(t) || WRONG_SECTION.test(t)) continue;
      const key = t.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= 10) break;
    }
  }

  return out;
}

/* The business description should be prose. A run of "Item 1A … Item 2 …"
   is the table of contents; debris like `_912593">` is the tail of a tag. */
function looksLikeToc(text) {
  return (text.slice(0, 400).match(/\bitem\s+\d+[a-z]?\b/gi) || []).length >= 3;
}

/** Business description and risk headings from a 10-K's HTML, or null when
    neither can be read. */
export function parseTenK(raw) {
  const html = normalizeHtml(raw);

  const bizChunk = sliceItem(html, itemRe('1', 'business', 'gi'), itemRe('1a', 'risk', 'i'));

  /* Passes, each looser than the last. Filers are inconsistent enough that no
     single pattern finds the risk section in all 500 documents. Every pass
     needs an end marker: an unbounded slab is how MD&A and the financial
     statements used to be published as "risk factors". */
  const riskChunk =
    sliceItem(html, itemRe('1a', 'risk', 'gi'), itemRe('1b|2', '[a-z]', 'i')) ||
    sliceItem(html, /risk\s*factors/gi, itemRe('1b|2', '[a-z]', 'i'), 800) ||
    sliceItem(html, itemRe('1a', 'risk', 'gi'), itemRe('1b|1c|2|3', '', 'i'), 800);

  let business = null;
  if (bizChunk) {
    const text = stripTags(bizChunk)
      .replace(/^[^<>\s]*">\s*/, '')
      .replace(/^item\s*1\s*[.:\-—]?\s*business[\s.:-]*/i, '')
      .replace(/^general[\s.:-]*/i, '');
    business = text.slice(0, 950).replace(/\s+\S*$/, '') + (text.length > 950 ? '…' : '');
    if (business.length < 120 || looksLikeToc(business)) business = null;
  }

  const risks = riskChunk ? headingsFrom(riskChunk) : [];
  if (!business && !risks.length) return null;
  return { business, risks };
}
