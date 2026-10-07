/* ==========================================================================
   StockOrNot
   Every S&P 500 company, one card at a time. The card shows the whole picture
   up front — valuation, growth, margins, balance sheet, next earnings date and
   what the company's own 10-K says — and you decide. Swipe right to put it in
   your cart, left to move on.

   The score is a weighted blend of five factors, each half a curve over
   reported figures and half a rank within the sector, and the pros and cons
   are thresholds that name the number that set them off. Neither predicts
   anything; both are shown with the raw figures beside them.

   Data comes from data/snapshot.json, rebuilt every weekday evening by a GitHub
   Action (see scripts/refresh.mjs). Beyond those static files the page calls
   /api/news for headlines and /api/broker for the brokerage (both functions on
   this site), and, for someone signed in, Supabase for the saved cart.
   ========================================================================== */
import {
  num, clamp, money, cap, price, pct, pctPlain, x, dateShort, rangePos, rangeSummary,
  FACTORS, scoreStock, scoreLabel, sectorRankText, prosAndCons, buildScoreContext
} from "./lib/analysis.mjs";
import * as auth from "./lib/auth.mjs";
import * as tier from "./lib/tier.mjs";
import * as insight from "./lib/insight.mjs";
import * as broker from "./lib/broker.mjs";
import * as earn from "./lib/earnings.mjs";
import * as cartLib from "./lib/cart.mjs";
import { CHECK_ICONS } from "./lib/icons.mjs";

/* ---------------------------------------------------------------- storage */

var LS = { cart: "ts.cart", seen: "ts.seen", owner: "ts.cartOwner" };

function load(k, fb) {
  try { var raw = localStorage.getItem(k); return raw === null ? fb : JSON.parse(raw); }
  catch (e) { return fb; }
}
function save(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
}

var storedCart = cartLib.split(load(LS.cart, []));

var state = {
  all:     [],            /* every company from the snapshot          */
  deck:    [],            /* tickers queued for swiping               */
  cursor:  0,
  cart:    storedCart.live,   /* what the cart shows                   */
  cartGone: storedCart.gone,  /* removals, kept so other copies learn of them */
  /* whose cart this browser holds: an account id, "" after signing out,
     null when it was saved before this was recorded */
  cartOwner: load(LS.owner, null),
  seen:    load(LS.seen, []),
  showSeen: false,        /* set only by the end-of-deck prompt, never saved */
  byTicker: {},
  details: {},            /* lazy-loaded 10-K contents, keyed by ticker */
  updated: null,
  user:    null,          /* set once auth resolves; null means signed out */
  tier:    "anon",        /* anon | free | member, resolved after auth */
  viewed:  null,          /* distinct companies opened, counted against the allowance */
  authPending: false,     /* true while we are still finding out */
  busy:    false,
  history: [],            /* recent swipes, newest last: { t, action, added } */
  sectors: null,          /* per-sector sorted metrics, built once per snapshot */
  scoreCtx: null,         /* the same, for the score's sector half */
  broker:  null,          /* last /api/broker status; null until asked */
  orderType: "market"     /* market (dollars) | limit (whole shares) */
};

var seenSet = new Set(state.seen);

/* -------------------------------------------------------------- utilities */

var $ = function (s, r) { return (r || document).querySelector(s); };

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}
function shuffle(a) {
  a = a.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1)), t = a[i];
    a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* -------------------------------------------- local formatting helpers ---
   Everything shared with the static page builder lives in lib/analysis.mjs;
   these two are only meaningful in a live page. */

function daysUntil(iso) {
  if (!iso) return null;
  var d = new Date(iso + "T12:00:00Z");
  if (isNaN(d)) return null;
  return Math.round((d - Date.now()) / 864e5);
}

function relTime(iso) {
  if (!iso) return "never";
  var mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 90) return mins + " min ago";
  var hrs = Math.round(mins / 60);
  if (hrs < 36) return hrs + "h ago";
  return Math.round(hrs / 24) + " days ago";
}

/* ============================================================== DATA ===== */

function loadSnapshot() {
  return fetch("data/snapshot.json", { cache: "no-cache" })
    .then(function (r) {
      if (r.status === 404) throw new Error("missing");
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    })
    .then(function (snap) {
      if (!snap || !Array.isArray(snap.stocks) || !snap.stocks.length) throw new Error("empty");
      state.all = snap.stocks;
      state.updated = snap.updated;
      state.session = snap.session || null;
      state.all.forEach(function (s) { state.byTicker[s.t] = s; });
      state.sectors = insight.buildSectorStats(state.all);
      state.scoreCtx = buildScoreContext(state.all);
      return snap;
    });
}

/* 10-K prose is one small file per company, fetched only when its card renders. */
/* The cached reading must belong to the 10-K the card links to. After a new
   filing that could not be read, the file can still hold last year's text,
   which would otherwise sit under this year's link. Revalidated each visit
   (no-cache), because a new filing replaces the file in place. */
function filingMatches(s, j) {
  var k = s && s.sec && s.sec.tenK;
  if (!k || !j) return false;
  return !k.accession || !j.accession || k.accession === j.accession;
}

function loadDetail(ticker) {
  if (state.details[ticker] !== undefined) return Promise.resolve(state.details[ticker]);
  var safe = ticker.replace(/[^A-Z0-9.]/gi, "_");
  return fetch("data/filings/" + encodeURIComponent(safe) + ".json", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      var d = j && filingMatches(state.byTicker[ticker], j) ? j.detail || null : null;
      state.details[ticker] = d;
      return d;
    })
    .catch(function () { state.details[ticker] = null; return null; });
}

/* ============================================================== DECK ===== */

var deckEl   = $("#deckEl");
var deckMsg  = $("#deckMsg");
var deckBar  = $("#deckBar");
var VISIBLE  = 3;           /* the top card, the next, and the edge of a third */
var cards    = [];          /* [{node, ticker, depth}], top first */
var HISTORY_MAX = 25;       /* swipes Undo can walk back */
var counted  = null;        /* the last company whose score counted up */
var calm     = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
function stillMotion() { return Boolean(calm && calm.matches); }

function buildDeck() {
  /* The only rule left: a company you have already swiped does not come back
     until you ask for it. Everything else is in the deck, in random order. */
  var pool = state.all.filter(function (s) {
    return state.showSeen || !seenSet.has(s.t);
  });
  state.deck = shuffle(pool.map(function (s) { return s.t; }));
  state.cursor = 0;
  state.history = [];
}

function showMessage(title, body, actions) {
  deckMsg.hidden = false;
  $("#msgTitle").textContent = title;
  $("#msgBody").innerHTML = body;
  var box = $("#msgActions");
  box.innerHTML = "";
  (actions || []).forEach(function (a) {
    var b = el("button", a.kind === "link" ? "link-btn" : "primary-btn", a.label);
    b.type = "button";
    b.addEventListener("click", a.onClick);
    box.appendChild(b);
  });
}

function renderDeck() {
  cards.forEach(function (c) { c.node.remove(); });
  cards = [];

  var remaining = state.deck.length - state.cursor;

  if (remaining === 0) {
    showMessage(
      "That is all " + state.all.length + " of them",
      "You have been through the whole index. Your cart is still there.",
      [
        { label: "Go through them again", onClick: function () {
            state.seen = []; seenSet = new Set();
            save(LS.seen, state.seen);
            state.showSeen = false;
            buildDeck(); renderDeck();
        } },
        { label: "Show the ones I passed on", kind: "link", onClick: function () {
            state.showSeen = true;
            buildDeck(); renderDeck();
        } }
      ]
    );
    renderDeckBar();
    return;
  }

  /* The allowance is spent on distinct companies, so going back over ones
     already seen costs nothing. It is charged at the moment a card is about
     to be rendered, not when it is swiped, because looking is the thing
     being metered. */
  var next = state.deck[state.cursor];
  if (!tier.withinAllowance(state.viewed, next, state.tier)) { showWall(); renderDeckBar(); return; }
  tier.recordViewed(state.viewed, next);

  deckMsg.hidden = true;

  var n = Math.min(VISIBLE, remaining);
  for (var depth = n - 1; depth >= 0; depth--) {
    var ticker = state.deck[state.cursor + depth];
    /* Only the top card is guaranteed inside the allowance. The one behind it
       is a blurred placeholder rather than a real card, so nothing readable
       is ever put in the DOM for a company this person has not paid to see. */
    var allowed = tier.withinAllowance(state.viewed, ticker, state.tier);
    var node = depth >= 2 ? makeGhostCard(depth)
      : allowed ? makeCard(state.byTicker[ticker], depth) : makeLockedCard(depth);
    deckEl.appendChild(node);
    cards.unshift({ node: node, ticker: ticker, depth: depth, locked: !allowed });
  }
  attachDrag(cards[0]);
  countUp(cards[0]);
  renderAllowance();
  renderDeckBar();
}

/* Pass, Undo and Add under the deck: for anyone who would rather press than
   swipe, and so a first visit shows what the deck is for. Undo stays while
   there is a swipe to take back, even after the deck runs out. */
function renderDeckBar() {
  var live = cards.length > 0 && !cards[0].locked;
  deckBar.hidden = !live && !state.history.length;
  $("#btnPass").disabled = $("#btnKeep").disabled = !live;
  $("#btnUndo").disabled = !state.history.length;
}

/* Third in the pile: only its edge shows, so it is an empty shell. */
function makeGhostCard(depth) {
  var art = el("article", "card is-behind is-ghost");
  art.style.transform = stackTransform(depth);
  art.style.zIndex = String(50 - depth);
  art.setAttribute("aria-hidden", "true");
  return art;
}

/* The score counts up and its meter fills when a company comes to the top,
   once per company, so redrawing the same card leaves it still. */
function countUp(entry) {
  if (!entry || entry.locked || entry.ticker === counted) return;
  counted = entry.ticker;
  if (stillMotion()) return;
  var b = $(".score-num b", entry.node), fill = $(".score-meter i", entry.node);
  var to = b ? parseInt(b.textContent, 10) : NaN;
  if (!isFinite(to) || !fill) return;
  var width = fill.style.width;
  fill.style.transition = "none";
  fill.style.width = "0";
  void fill.offsetWidth;
  fill.style.transition = "";
  fill.style.width = width;
  var t0 = performance.now();
  b.textContent = "0";
  requestAnimationFrame(function step(now) {
    var k = Math.min(1, Math.max(0, now - t0) / 650);
    b.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(step);
  });
}

/* What a visitor sees when the allowance runs out. Two different messages:
   somebody who has not signed in is one email away from twice as many,
   which is a much easier ask than a card number. */
function showWall() {
  cards.forEach(function (c) { c.node.remove(); });
  cards = [];

  var seen = state.viewed.size;
  if (state.tier === "anon") {
    showMessage(
      "You have seen " + seen + " of " + state.all.length,
      "Create a free account and the next <b>" + (tier.LIMITS.free - tier.LIMITS.anon) +
      "</b> are yours. No card, just an email address.",
      [
        { label: "Create a free account", onClick: function () { openAuth(); } },
        { label: "See what a membership includes", kind: "link",
          onClick: function () { location.href = "/pricing"; } }
      ]
    );
  } else {
    showMessage(
      "You have seen " + seen + " of " + state.all.length,
      "Membership opens the remaining <b>" + (state.all.length - seen) +
      "</b>, plus an unlimited cart and an email a week before anything in it reports.",
      [
        { label: "See what membership includes", onClick: function () { location.href = "/pricing"; } },
        { label: "Keep my cart and stop here", kind: "link",
          onClick: openCart }
      ]
    );
  }
}

/* Deliberately empty. A blurred real card invites someone to read it out of
   the DOM, and a fake one with made-up numbers on a finance site is worse
   than either. */
function makeLockedCard(depth) {
  var art = el("article", "card is-locked" + (depth ? " is-behind" : ""));
  art.style.transform = stackTransform(depth);
  art.style.zIndex = String(50 - depth);
  art.setAttribute("aria-hidden", "true");
  art.appendChild(el("div", "lock-mark"));
  return art;
}

/* A quiet count, so running out is never a surprise. Hidden for members. */
function renderAllowance() {
  var box = $("#allowance");
  if (!box) return;
  var left = tier.remainingFor(state.viewed, state.tier);
  if (left === Infinity) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent = left > 0
    ? left + (left === 1 ? " company left" : " companies left") +
      (state.tier === "anon" ? " · sign in for more" : "")
    : "No companies left";
  box.classList.toggle("is-low", left <= 3);
}

/* Cards behind sit lower and narrower, scaled from their bottom edge, so a
   strip of each shows under the one in front. */
function stackTransform(depth) {
  return "translateY(" + (depth * 11) + "px) scale(" + (1 - depth * 0.045) + ")";
}

/* --------------------------------------------------------- card contents */

/* The score as a ring. Deliberately small on the card — it sits beside the
   numbers rather than on top of them, and the factor bars behind it are one
   tap away in the detail sheet. */
/* The score as a number out of 100, a thin meter, the word for it and the
   company's rank in its sector. */
function scoreRing(res, big) {
  var v = res.overall;
  var lab = scoreLabel(v);
  var box = el("div", "score-box" + (big ? " is-big" : "") + " tone-" + lab.tone);
  var n = el("div", "score-num");
  n.appendChild(el("b", "", num(v) ? String(v) : "—"));
  n.appendChild(el("span", "", "/100"));
  box.appendChild(n);
  var meter = el("div", "score-meter");
  var fill = el("i", "");
  fill.style.width = clamp(v || 0, 0, 100) + "%";
  meter.appendChild(fill);
  box.appendChild(meter);
  box.appendChild(el("span", "sr-label", lab.word));
  var rank = sectorRankText(res.place, big);
  if (rank) box.appendChild(el("span", "sr-rank", rank));
  box.title = !num(v) ? "Not enough reported data to score this one"
    : res.place ? "Ahead of " + v + "% of the S&P 500 on its fundamentals" +
        (res.place.sector ? ", and " + sectorRankText(res.place, true) : "")
    : "Fundamentals score " + v + " out of 100, " + lab.word.toLowerCase();
  return box;
}

function factorBars(res) {
  var box = el("div", "factor-list");
  FACTORS.forEach(function (f) {
    var val = res.factors[f.id];
    var row = el("div", "factor-row" + (num(val) ? "" : " is-na"));
    var lab = el("div", "factor-label");
    lab.appendChild(el("span", "fl-name", f.label));
    lab.appendChild(el("span", "fl-blurb", f.blurb));
    row.appendChild(lab);
    var meter = el("div", "factor-meter");
    var fill = el("div", "factor-fill");
    if (num(val)) fill.style.width = clamp(val, 0, 100) + "%";
    meter.appendChild(fill);
    row.appendChild(meter);
    row.appendChild(el("span", "factor-val", num(val) ? String(Math.round(val)) : "n/a"));
    box.appendChild(row);
  });
  return box;
}

function statRow(label, value, hint) {
  var d = el("div", "stat");
  d.appendChild(el("dt", "", label));
  d.appendChild(el("dd", "", value));
  if (hint) d.title = hint;
  return d;
}

function streetExpects(e) {
  var parts = [];
  if (num(e.epsEst)) parts.push(earn.eps(e.epsEst) + " EPS");
  if (num(e.revEst)) parts.push(earn.money(e.revEst) + " revenue");
  return parts.length ? " · street expects " + parts.join(" on ") : "";
}

/* The financials as five questions, each with a one-line answer and only the
   figures behind it (lib/insight.mjs financialChecks). Every figure carries a
   one-line explanation as its tooltip. */
function checksBlock(s, score) {
  var wrap = el("div", "checks");
  insight.financialChecks(s, score).forEach(function (g) {
    var box = el("div", "check");
    var head = el("div", "check-head");
    var icon = el("span", "check-icon");
    icon.innerHTML = CHECK_ICONS[g.icon] || "";      /* a constant from lib/icons.mjs */
    icon.setAttribute("aria-hidden", "true");
    head.appendChild(icon);
    var q = el("div", "check-q");
    q.appendChild(el("b", "", g.title));
    var line = el("p", "check-line");
    line.appendChild(el("span", "", g.question));
    if (g.answer) {
      var a = el("span", "check-a is-" + g.answer.tone, g.answer.text);
      if (g.note) a.title = g.note;
      line.appendChild(a);
    }
    q.appendChild(line);
    head.appendChild(q);
    box.appendChild(head);
    if (g.rows.length) {
      var grid = el("dl", "c-stats");
      g.rows.forEach(function (r) {
        var st = statRow(r[0], r[1], r[2]);
        if (r[3]) st.classList.add("is-wide");
        grid.appendChild(st);
      });
      box.appendChild(grid);
    }
    if (g.why) box.appendChild(el("p", "check-why", g.why));
    wrap.appendChild(box);
  });
  return wrap;
}

/* Where the company sits among the rest of its sector, metric by metric. The
   dot runs from the weak end on the left to the strong end on the right, and
   the words say the same thing so nothing rests on the dot alone. */
function sectorBlock(s, limit) {
  var view = insight.sectorView(s, state.sectors);
  if (!view || !view.rows.length) return null;
  var box = el("div", "vs-list");
  view.rows.slice(0, limit || view.rows.length).forEach(function (r) {
    var row = el("div", "vs-row");
    row.title = r.label + " " + r.value + ": " + r.text + " of the other " + r.peers + " companies in the sector that report it. Median " + r.median + ".";
    var left = el("div", "vs-l");
    left.appendChild(el("span", "vs-label", r.label));
    left.appendChild(el("span", "vs-med", "median " + r.median));
    row.appendChild(left);
    var meter = el("div", "vs-meter");
    meter.setAttribute("aria-hidden", "true");
    var dot = el("span", "vs-dot");
    dot.style.left = r.share + "%";
    meter.appendChild(dot);
    row.appendChild(meter);
    var right = el("div", "vs-r");
    right.appendChild(el("span", "vs-val", r.value));
    right.appendChild(el("span", "vs-rank", r.text));
    row.appendChild(right);
    box.appendChild(row);
  });
  return { node: box, view: view };
}

/* Ratings, the beat record and insider activity in three lines. Returns false
   when there is nothing to say, so the card can drop the block entirely. */
function fillStreet(box, deep) {
  var a = deep && deep.analyst;
  var c = insight.consensus(a);
  var b = insight.beatRecord(a);
  var ins = insight.insiderSummary(a && a.insider);
  if (!c && !b && !ins) return false;

  if (c) {
    var bar = el("div", "rec-bar street-bar");
    [["buy", c.buy, "rec-b", "Buy"], ["hold", c.hold, "rec-h", "Hold"], ["sell", c.sell, "rec-s", "Sell"]]
      .forEach(function (p) {
        if (!p[1]) return;
        var seg = el("span", "rec-seg " + p[2]);
        seg.style.width = (p[1] / c.total * 100) + "%";
        seg.title = p[3] + ": " + p[1];
        if (p[1] / c.total > 0.12) seg.textContent = Math.round(p[1] / c.total * 100) + "%";
        bar.appendChild(seg);
      });
    box.appendChild(bar);
    var line = c.buyPct + "% rate it a buy, " + c.holdPct + "% hold, " + c.sellPct + "% sell · " +
      c.total + " analysts";
    if (num(c.shift) && c.shift !== 0) line += " · buys " + (c.shift > 0 ? "up " : "down ") + Math.abs(c.shift) + (Math.abs(c.shift) === 1 ? " pt" : " pts") + " on the month";
    box.appendChild(el("p", "street-line", line));
  }
  if (b) {
    box.appendChild(el("p", "street-line",
      "Beat the EPS estimate in " + b.beats + " of the last " + b.of + " quarters" +
      (num(b.avgSurprise) ? ", coming in " + pctPlain(Math.abs(b.avgSurprise), 1) + (b.avgSurprise >= 0 ? " above" : " below") + " the estimates in total." : ".")));
  }
  if (ins) {
    box.appendChild(el("p", "street-line",
      "Insiders: " + ins.word + " " + ins.when +
      " (sentiment " + (ins.mspr > 0 ? "+" : "") + ins.mspr.toFixed(0) + " on a −100 to +100 scale)."));
  }
  return true;
}

function pcColumn(kind, title, items, glyph, max) {
  var col = el("section", "pc-col " + kind);
  var shown = max ? items.slice(0, max) : items;

  var h = el("h3", "");
  h.appendChild(el("span", "pc-glyph", glyph));
  h.appendChild(el("span", "", title));
  if (items.length) h.appendChild(el("span", "pc-count", String(items.length)));
  col.appendChild(h);

  if (!items.length) {
    col.appendChild(el("p", "pc-none", kind === "pro"
      ? "Nothing in the numbers stands out as a strength."
      : "Nothing in these numbers stands out as a concern. That is not the same as no risk: read the risk factors from the 10-K below."));
  } else {
    var ul = el("ul", "");
    shown.forEach(function (t) { ul.appendChild(el("li", "", t)); });
    col.appendChild(ul);
    if (items.length > shown.length) {
      col.appendChild(el("p", "pc-more",
        "and " + (items.length - shown.length) + " more in the full record"));
    }
  }
  return col;
}

/* max: how many of each to show; none shows them all */
function prosConsBlock(s, max) {
  var pc = prosAndCons(s, state.scoreCtx);
  var wrap = el("div", "c-pc");
  wrap.appendChild(pcColumn("pro", "In its favour", pc.pros, "+", max));
  wrap.appendChild(pcColumn("con", "Against it", pc.cons, "−", max));
  return wrap;
}

var CAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';

function makeCard(s, depth) {
  var card = el("article", "card");
  card.style.transform = stackTransform(depth);
  card.style.zIndex = String(50 - depth);
  card.setAttribute("aria-hidden", depth > 0 ? "true" : "false");
  if (depth > 0) card.classList.add("is-behind");

  card.innerHTML =
    '<div class="stamp add"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>In cart</div>' +
    '<div class="stamp pass"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>Pass</div>' +
    '<div class="card-scroll"></div>';

  var body = $(".card-scroll", card);
  if (!s) { body.appendChild(el("p", "", "Missing data.")); return card; }

  /* ---------- identity ---------- */
  var top = el("header", "c-top");
  var idb = el("div", "c-id");
  idb.appendChild(el("h2", "c-ticker", s.t));
  idb.appendChild(el("p", "c-name", s.n));
  idb.appendChild(el("span", "c-sector", s.s));
  top.appendChild(idb);
  var res = scoreStock(s, state.scoreCtx);
  top.appendChild(scoreRing(res, false));
  body.appendChild(top);

  /* ---------- price ---------- */
  var pr = el("div", "c-price");
  pr.appendChild(el("div", "c-price-v", price(s.price)));
  var dir = !num(s.change) ? "flat" : s.change > 0.005 ? "up" : s.change < -0.005 ? "down" : "flat";
  var delta = el("div", "delta " + dir);
  delta.appendChild(el("span", "arrow", dir === "up" ? "▲" : dir === "down" ? "▼" : "–"));
  delta.appendChild(el("span", "", num(s.change) ? pct(s.change, 2) + " today" : "no change data"));
  pr.appendChild(delta);
  var mcTag = el("span", "c-cap", cap(s.mc) + " market cap");
  pr.appendChild(mcTag);
  body.appendChild(pr);

  /* ---------- 52-week range ----------
     Said the way people say it: how far off the high, how far above the low. */
  var range = rangeSummary(s);
  if (range) {
    var pos = range.pos;
    var rw = el("div", "c-range");
    var head = el("div", "c-range-head");
    head.appendChild(el("span", "", "52-week range"));
    head.appendChild(el("span", "c-range-zone", range.zone));
    rw.appendChild(head);
    var bar = el("div", "rangebar");
    bar.innerHTML = '<div class="rangebar-track"></div><div class="rangebar-fill"></div>' +
                    '<div class="rangebar-marker"><span class="rangebar-dot"></span></div>';
    $(".rangebar-fill", bar).style.width = (pos * 100) + "%";
    $(".rangebar-marker", bar).style.left = (pos * 100) + "%";
    rw.appendChild(bar);
    var ends = el("div", "c-range-ends");
    ends.appendChild(el("span", "", "Low " + price(s.lo)));
    ends.appendChild(el("span", "", "High " + price(s.hi)));
    rw.appendChild(ends);
    rw.appendChild(el("p", "c-range-text", range.text));
    body.appendChild(rw);
  }

  /* ---------- next earnings ---------- */
  var e = s.earnings;
  var eb = el("div", "c-earnings");
  if (e && e.date) {
    var d = daysUntil(e.date);
    var when = d === null ? "" : d < 0 ? "just reported" : d === 0 ? "today" : d === 1 ? "tomorrow" : "in " + d + " days";
    if (d !== null && d >= 0 && d <= earn.ALERT_DAYS) eb.classList.add("is-soon");
    /* Vendor fields go in as text, never as markup. */
    eb.innerHTML = CAL_ICON;
    var line = el("span", "");
    line.appendChild(el("b", "", "Next earnings " + when));
    line.appendChild(document.createTextNode(" on " + dateShort(e.date) +
      (earn.quarterLabel(e) ? " for " + earn.quarterLabel(e) : "") +
      (earn.whenWord(e.hour) ? " (" + earn.whenWord(e.hour) + ")" : "") +
      streetExpects(e)));
    eb.appendChild(line);
  } else {
    eb.classList.add("is-muted");
    eb.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>' +
      '<span>No earnings date scheduled in the next few months.</span>';
  }
  body.appendChild(eb);

  /* ---------- pros and cons ----------
     The card shows at most four of each. A company with six strengths and one
     worry used to bury the worry below the fold, which is the one line a
     person most needs to see. The count in the heading says what is being
     held back, and the detail sheet lists all of it. */
  body.appendChild(prosConsBlock(s, 4));

  /* ---------- what the street says, from the deep file ---------- */
  var street = el("section", "c-block c-street");
  street.appendChild(el("h3", "block-h", "What the street says"));
  var streetSlot = el("div", "");
  streetSlot.appendChild(el("p", "block-note", "Loading…"));
  street.appendChild(streetSlot);
  body.appendChild(street);
  loadDeep(s.t).then(function (deep) {
    if (!card.isConnected) return;
    streetSlot.innerHTML = "";
    if (!fillStreet(streetSlot, deep)) street.remove();
  });

  /* ---------- the financials: five questions ---------- */
  var sec1 = el("section", "c-block c-checks");
  sec1.appendChild(el("h3", "block-h", "The financials"));
  sec1.appendChild(checksBlock(s, res));
  body.appendChild(sec1);

  /* ---------- against its sector ---------- */
  var vs = sectorBlock(s, 6);
  if (vs) {
    var secV = el("section", "c-block");
    secV.appendChild(el("h3", "block-h", "Against " + vs.view.sector + " (" + vs.view.count + ")"));
    secV.appendChild(vs.node);
    body.appendChild(secV);
  }

  /* ---------- the 10-K itself ---------- */
  var sec3 = el("section", "c-block c-filing");
  sec3.appendChild(el("h3", "block-h", "Straight from the 10-K"));
  var slot = el("div", "filing-slot");
  slot.appendChild(el("p", "block-note", "Loading the filing…"));
  sec3.appendChild(slot);

  var links = el("div", "filing-links");
  if (s.sec && s.sec.tenK && s.sec.tenK.url) {
    var a1 = el("a", "filing-link", "Read the 10-K (filed " + dateShort(s.sec.tenK.date) + ")");
    a1.href = s.sec.tenK.url; a1.target = "_blank"; a1.rel = "noopener";
    links.appendChild(a1);
  }
  if (s.sec && s.sec.tenQ && s.sec.tenQ.url) {
    var a2 = el("a", "filing-link", "Latest 10-Q (" + dateShort(s.sec.tenQ.date) + ")");
    a2.href = s.sec.tenQ.url; a2.target = "_blank"; a2.rel = "noopener";
    links.appendChild(a2);
  }
  var a3 = el("a", "filing-link", "All filings on EDGAR");
  a3.href = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=" + (s.cik || s.t) + "&type=10-K&dateb=&owner=include&count=40";
  a3.target = "_blank"; a3.rel = "noopener";
  links.appendChild(a3);
  sec3.appendChild(links);
  body.appendChild(sec3);

  if (s.sec && s.sec.detail) {
    loadDetail(s.t).then(function (d) {
      if (!card.isConnected) return;
      slot.innerHTML = "";
      if (!d) { slot.appendChild(el("p", "block-note", "This filing could not be read automatically. The original is linked below.")); return; }

      if (d.business) {
        var bh = el("h4", "sub-h", "What the company says it does");
        slot.appendChild(bh);
        slot.appendChild(el("p", "filing-text", d.business));
      }
      if (d.risks && d.risks.length) {
        var rh = el("h4", "sub-h", "Risk factors it lists");
        slot.appendChild(rh);
        var ul = el("ul", "risk-list");
        d.risks.slice(0, 5).forEach(function (r) { ul.appendChild(el("li", "", r)); });
        slot.appendChild(ul);
        if (d.risks.length > 5) {
          var more = el("button", "link-btn", "Show " + (d.risks.length - 5) + " more risk factors");
          more.type = "button";
          more.addEventListener("click", function () {
            d.risks.slice(5).forEach(function (r) { ul.appendChild(el("li", "", r)); });
            more.remove();
          });
          slot.appendChild(more);
        }
      }
      if (!d.business && !(d.risks || []).length) {
        slot.appendChild(el("p", "block-note", "Nothing could be read out of this filing. The original is linked below."));
      }
    });
  } else {
    slot.innerHTML = "";
    slot.appendChild(el("p", "block-note",
      s.sec && s.sec.tenK
        ? "This 10-K has not been read yet. The original is linked below."
        : "No annual report on file for this company."));
  }

  /* ---------- into the full record ---------- */
  var more = el("button", "more-btn");
  more.type = "button";
  more.innerHTML = '<span>Open the full record</span>' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  more.addEventListener("click", function (ev) { ev.stopPropagation(); openDetail(s); });
  body.appendChild(more);

  /* ---------- scroll affordance ---------- */
  var fade = el("div", "card-fade");
  card.appendChild(fade);
  body.addEventListener("scroll", function () {
    fade.style.opacity = body.scrollTop + body.clientHeight >= body.scrollHeight - 24 ? "0" : "1";
  }, { passive: true });

  return card;
}

/* --------------------------------------------------------------- swiping */

var drag = null;

function attachDrag(entry) {
  if (!entry) return;
  var card = entry.node;
  var scroller = $(".card-scroll", card);
  var stampAdd = $(".stamp.add", card);
  var stampPass = $(".stamp.pass", card);

  card.addEventListener("pointerdown", function (ev) {
    if (state.busy) return;
    if (ev.button !== undefined && ev.button !== 0) return;
    if (ev.target.closest("a, button")) return;      /* let links and buttons work */
    drag = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, dx: 0, axis: null, t0: Date.now() };
  });

  card.addEventListener("pointermove", function (ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    var dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;

    /* Decide once whether this gesture is a scroll or a swipe. */
    if (drag.axis === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) * 1.3 ? "x" : "y";
      if (drag.axis === "x") {
        card.setPointerCapture(drag.id);
        card.classList.add("is-drag");
        scroller.style.overflowY = "hidden";
      } else {
        drag = null;                                  /* hand it back to the scroller */
        return;
      }
    }

    drag.dx = dx;
    card.style.transform = "translate(" + dx + "px," + (dy * 0.18) + "px) rotate(" + clamp(dx / 22, -10, 10) + "deg)";
    var t = clamp(Math.abs(dx) / 120, 0, 1);
    stampAdd.style.opacity = dx > 0 ? t : 0;
    stampPass.style.opacity = dx < 0 ? t : 0;
    pull(dx > 0 ? t : 0, dx < 0 ? t : 0);
  });

  function release(ev) {
    if (!drag || (ev.pointerId !== undefined && ev.pointerId !== drag.id)) return;
    var dx = drag.dx, axis = drag.axis;
    var held = Date.now() - drag.t0;
    var speed = Math.abs(dx) / Math.max(1, held);
    var moved = Math.abs((ev.clientX || drag.x0) - drag.x0) + Math.abs((ev.clientY || drag.y0) - drag.y0);
    drag = null;
    pull(0, 0);
    card.classList.remove("is-drag");
    scroller.style.overflowY = "";

    /* a still, short press is a tap — open the full record */
    if (axis === null && moved < 8 && held < 500) {
      openDetail(state.byTicker[entry.ticker]);
      return;
    }
    if (axis !== "x") return;

    if (Math.abs(dx) > 110 || (Math.abs(dx) > 55 && speed > 0.6)) {
      commit(dx > 0 ? "add" : "pass");
    } else {
      card.classList.add("is-settling");
      card.style.transform = stackTransform(0);
      stampAdd.style.opacity = stampPass.style.opacity = 0;
      setTimeout(function () { card.classList.remove("is-settling"); }, 300);
    }
  }
  card.addEventListener("pointerup", release);
  card.addEventListener("pointercancel", release);
}

/* Folds in what other tabs have marked before writing, so two tabs swiping
   at once both keep their history. */
function markSeen(t) {
  load(LS.seen, []).forEach(function (x) { if (!seenSet.has(x)) { seenSet.add(x); state.seen.push(x); } });
  if (!seenSet.has(t)) { seenSet.add(t); state.seen.push(t); }
  save(LS.seen, state.seen);
}

function commit(action) {
  if (state.busy) return;
  var entry = cards[0];
  if (!entry) return;
  state.busy = true;

  var s = state.byTicker[entry.ticker];
  var added = action === "add" ? addToCart(s) : false;
  state.history.push({ t: entry.ticker, action: action, added: added });
  if (state.history.length > HISTORY_MAX) state.history.shift();
  pressed(action === "add" ? "#btnKeep" : "#btnPass");

  markSeen(entry.ticker);

  var dirSign = action === "add" ? 1 : -1;
  var card = entry.node;
  $(".stamp." + action, card).style.opacity = 1;
  card.classList.add("is-gone");
  card.style.transform = "translate(" + (dirSign * (window.innerWidth * 0.9 + 200)) + "px, 30px) rotate(" +
                         (dirSign * 16) + "deg)";

  for (var i = 1; i < cards.length; i++) {
    var c = cards[i];
    c.depth -= 1;
    c.node.style.transition = "transform .3s cubic-bezier(.22,1,.36,1)";
    c.node.style.transform = stackTransform(c.depth);
    c.node.classList.toggle("is-behind", c.depth > 0);
    c.node.setAttribute("aria-hidden", c.depth > 0 ? "true" : "false");
  }

  setTimeout(function () {
    state.busy = false;
    state.cursor += 1;
    renderDeck();
  }, 300);
}

/* Takes back the last swipe: the company returns to the top of the pile, out
   of the seen list, and out of the cart if that swipe is what put it there. */
function undo() {
  if (state.busy) return;
  var last = state.history.pop();
  if (!last) return;
  if (last.added && cartItem(last.t)) {
    removeFromCart(last.t);
    persistCart();
    renderCartCount(); renderEarnNotice();
  }
  unmarkSeen(last.t);
  var idx = state.deck.indexOf(last.t);
  if (idx === state.cursor - 1) state.cursor -= 1;
  else {
    if (idx >= 0) { state.deck.splice(idx, 1); if (idx < state.cursor) state.cursor -= 1; }
    state.deck.splice(state.cursor, 0, last.t);
  }
  counted = last.t;                /* it counted up the first time round */
  pressed("#btnUndo");
  renderDeck();

  /* fly back in from the side it left by */
  var top = cards[0];
  if (!top || top.ticker !== last.t || stillMotion()) return;
  var node = top.node, dir = last.action === "add" ? 1 : -1;
  node.style.transform = "translate(" + (dir * (window.innerWidth * 0.6 + 120)) + "px, 30px) rotate(" + (dir * 14) + "deg)";
  void node.offsetWidth;
  node.classList.add("is-returning");
  node.style.transform = stackTransform(0);
  setTimeout(function () { node.classList.remove("is-returning"); }, 450);
}

function unmarkSeen(t) {
  if (!seenSet.has(t)) return;
  seenSet.delete(t);
  state.seen = state.seen.filter(function (x) { return x !== t; });
  save(LS.seen, state.seen);
}

/* A press on the matching button, whichever way the choice was made. */
function pressed(sel) {
  var b = $(sel);
  if (!b) return;
  b.classList.remove("is-pressed");
  void b.offsetWidth;
  b.classList.add("is-pressed");
  setTimeout(function () { b.classList.remove("is-pressed"); }, 240);
}

/* While a card is dragged, the button on that side lights up with it. */
function pull(add, pass) {
  $("#btnKeep").style.setProperty("--pull", add);
  $("#btnPass").style.setProperty("--pull", pass);
}

/* ============================================================== CART ===== */

/* Local first, always. The browser copy is written synchronously so the cart
   survives a refresh whether or not anyone is signed in. Every write first
   folds in whatever another tab saved meanwhile (lib/cart.mjs merges by last
   write per company, removals included), so two open tabs cannot erase each
   other's changes.

   The account copy follows behind, debounced because the notes field fires on
   every keystroke. Each sync reads the account's cart, merges, and writes back
   only if something differs, so a device that was offline, or a second device
   editing at the same time, loses nothing. Nothing is ever written to an
   account whose cart could not first be read, and nothing is written to an
   account this browser's cart does not belong to (see ensureCartOwner). */

function cartRecords() { return state.cart.concat(state.cartGone); }

function setCart(records) {
  var parts = cartLib.split(records);
  state.cart = parts.live;
  state.cartGone = parts.gone;
}

function cartItem(t) {
  return state.cart.filter(function (i) { return i.t === t; })[0] || null;
}

function touch(item) {
  item.updatedAt = new Date().toISOString();
  return item;
}

function removeFromCart(t) {
  if (!cartItem(t)) return;
  state.cart = state.cart.filter(function (i) { return i.t !== t; });
  state.cartGone = state.cartGone.filter(function (g) { return g.t !== t; }).concat([cartLib.tombstone(t)]);
}

/* Undo for a removal: the record comes back as it was, note and amount
   included, stamped now so it outranks its own tombstone on every copy of
   the cart. It sorts back into place by when it was first added. */
function restoreToCart(item) {
  if (cartItem(item.t)) return;
  state.cartGone = state.cartGone.filter(function (g) { return g.t !== item.t; });
  state.cart.push(touch(item));
  state.cart.sort(function (a, b) { return String(b.addedAt || "").localeCompare(String(a.addedAt || "")); });
  persistCart();
  renderCartCount(); renderEarnNotice();
  if (view === "cart") renderCart();
}

/* ---------------------------------------------------------------- toast */

var toastTimer = null;

/* One line, and a way back. A modal dialog covers everything outside it, so
   the toast moves into whichever dialog is open. */
function showToast(text, label, onAction, ms) {
  var box = $("#toast");
  var host = document.querySelector("dialog[open]") || document.body;
  if (box.parentNode !== host) host.appendChild(box);
  $("#toastText").textContent = text;
  var btn = $("#toastAction");
  btn.hidden = !onAction;
  btn.textContent = label || "Undo";
  btn.onclick = function () { hideToast(); if (onAction) onAction(); };
  box.hidden = false;
  box.classList.remove("is-in");
  void box.offsetWidth;
  box.classList.add("is-in");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms || 6000);
}

function hideToast() {
  clearTimeout(toastTimer);
  $("#toast").hidden = true;
}

function setCartOwner(owner) {
  state.cartOwner = owner;
  save(LS.owner, owner);
}

/* Everything that shows the cart, redrawn after it changed from outside this
   tab. The open cart is left alone while someone is typing in it; its
   handlers look items up by ticker, so they keep working either way. */
function cartChanged() {
  renderCartCount();
  renderEarnNotice();
  renderOrderBar();
  var box = $("#viewCart");
  if (view === "cart" && !box.contains(document.activeElement && document.activeElement.matches("input, textarea") ? document.activeElement : null)) renderCart();
}

function persistCart() {
  setCart(cartLib.mergeCarts(cartRecords(), load(LS.cart, [])));
  save(LS.cart, cartRecords());
  scheduleSync();
}

/* Another tab saved. Its copy is merged in, never written back from here, so
   two tabs cannot ping-pong. A different owner means the other tab signed in
   or out: its cart is this browser's cart now, as it stands. */
function onStorage(ev) {
  if (ev.key === LS.cart || ev.key === LS.owner) {
    var owner = load(LS.owner, null);
    var theirs = load(LS.cart, []);
    if (owner !== state.cartOwner) { state.cartOwner = owner; setCart(theirs); }
    else setCart(cartLib.mergeCarts(cartRecords(), theirs));
    cartChanged();
  } else if (ev.key === LS.seen) {
    load(LS.seen, []).forEach(function (t) { if (!seenSet.has(t)) { seenSet.add(t); state.seen.push(t); } });
  }
}

var sync = { timer: null, retryTimer: null, retries: 0, running: null, again: false };

function scheduleSync() {
  if (!state.user || state.cartOwner !== state.user.id) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(syncCart, 800);
}

function syncCart() {
  clearTimeout(sync.timer); sync.timer = null;
  var user = state.user;
  if (!user || state.cartOwner !== user.id) return Promise.resolve(false);
  if (sync.running) { sync.again = true; return sync.running; }
  setSyncNote("saving");
  sync.running = auth.fetchCart().then(function (r) {
    if (!r.ok || r.userId !== user.id || state.user !== user) return false;
    var mine = cartRecords();
    var merged = cartLib.mergeCarts(mine, r.items);
    if (!cartLib.sameCart(merged, mine)) {
      setCart(merged);
      save(LS.cart, cartRecords());
      cartChanged();
    }
    if (cartLib.sameCart(merged, r.items)) return true;
    return auth.pushCart(merged, user.id);
  }).then(function (ok) {
    sync.running = null;
    clearTimeout(sync.retryTimer);
    if (ok) {
      sync.retries = 0;
      setSyncNote("saved");
      if (sync.again) { sync.again = false; return syncCart(); }
    } else if (state.user === user) {
      /* retry on a widening timer, and at once when the connection returns */
      setSyncNote("offline");
      var wait = [5, 15, 45, 120][Math.min(sync.retries++, 3)] * 1000;
      sync.retryTimer = setTimeout(syncCart, wait);
    }
    return ok;
  });
  return sync.running;
}

function setSyncNote(status) {
  var n = $("#cartSync");
  if (!n) return;
  var owned = state.user && state.cartOwner === state.user.id;
  n.hidden = !state.user;
  n.textContent = !owned
    ? "Not linked to your account yet"
    : status === "offline" ? "Not saved to your account yet, retrying"
    : status === "saving" ? "Saving…" : "Saved to your account";
  n.classList.toggle("is-warn", !owned || status === "offline");
}

/* Whose cart is this? Signing in merges this browser's cart into the account
   only when it is already that account's, or when the person says so. A cart
   left by someone else (or by nobody, before signing in) is not folded into
   an account without asking, and the question names the account, so a sign-in
   link somebody else sent cannot quietly collect this browser's notes. */
var ownerAsk = null;      /* a question put off while the tab was hidden */

function ensureCartOwner(user, fresh) {
  if (!user) return;
  var stored = load(LS.owner, null);
  if (stored !== state.cartOwner) { state.cartOwner = stored; setCart(load(LS.cart, [])); cartChanged(); }
  if (state.cartOwner === user.id) { syncCart(); return; }
  var legacy = state.cartOwner === null && !fresh;   /* saved while signed in, before owners were recorded */
  if (!state.cart.length || legacy) {
    setCartOwner(user.id);
    syncCart();
    return;
  }
  if (document.visibilityState === "hidden") { ownerAsk = { user: user, fresh: fresh }; return; }
  ownerAsk = null;
  var n = state.cart.length;
  var body = $("#ownerBody");
  body.textContent = "";
  body.appendChild(document.createTextNode("You are signed in as "));
  body.appendChild(el("b", "", user.email || "an account with no email"));
  body.appendChild(document.createTextNode(". This browser's cart has " + n + (n === 1 ? " company" : " companies") +
    ", with any notes and amounts, that " + (n === 1 ? "is" : "are") + " not saved to that account."));
  var dlg = $("#dlgOwner");
  $("#ownerAdd").onclick = function () {
    closeDialog(dlg);
    if (state.user !== user) return;
    setCartOwner(user.id);
    syncCart();
  };
  $("#ownerLeave").onclick = function () {
    closeDialog(dlg);
    if (state.user !== user) return;
    setCart([]);
    save(LS.cart, []);
    setCartOwner(user.id);
    cartChanged();
    syncCart();
  };
  setSyncNote();
  openDialog(dlg);
}

/* Signing out takes the cart with it: the notes are private, and whoever uses
   this browser next should not see them or have them folded into their own
   account. Anything not yet saved is saved first. */
function signOutAndForget() {
  var user = state.user;
  /* a cart that never joined the account (the question was put off) is not
     the account's to take away */
  var owned = !!(user && state.cartOwner === user.id);
  var flush = owned ? syncCart() : Promise.resolve(true);
  return flush.then(function (ok) {
    if (!ok && !window.confirm("Your latest cart changes have not reached your account yet (the connection failed). Sign out anyway and lose them?")) {
      return Promise.reject("kept");
    }
    return auth.signOut();
  }).then(function () {
    clearTimeout(sync.timer); clearTimeout(sync.retryTimer);
    /* Signing out on a shared computer has to end the brokerage connection
       too: its cookie belongs to the browser, not the account, and would
       otherwise leave the account and its orders to whoever sits down next. */
    broker.disconnect().then(function (r) {
      if (r.ok) state.broker = r.data;
      portfolio = null;
      renderBrokerPanel(); renderOrderBar();
    });
    if (owned) {
      setCartOwner("");
      setCart([]);
      save(LS.cart, []);
      cartChanged();
    }
    return true;
  }, function () { return false; });
}

/* true when this call put it in the cart */
function addToCart(s) {
  if (!s) return false;
  var existing = state.cart.filter(function (c) { return c.t === s.t; })[0];
  if (existing) { flashCart(); return false; }

  var cap = tier.featuresFor(state.tier).cart;
  if (state.cart.length >= cap) {
    showMessage(
      "Your cart is full at " + cap,
      state.tier === "anon"
        ? "A free account holds <b>" + tier.FEATURES.free.cart + "</b>. Membership holds as many as you like."
        : "Membership removes the limit, and emails you when anything in the cart reports.",
      [
        { label: state.tier === "anon" ? "Create a free account" : "See membership",
          onClick: function () { state.tier === "anon" ? openAuth() : (location.href = "/pricing"); } },
        { label: "Empty a slot instead", kind: "link",
          onClick: openCart }
      ]
    );
    return false;
  }
  var now = new Date().toISOString();
  state.cartGone = state.cartGone.filter(function (g) { return g.t !== s.t; });
  state.cart.unshift({
    t: s.t, n: s.n, sector: s.s,
    addedAt: now,
    updatedAt: now,
    priceAtAdd: num(s.price) ? s.price : null,
    note: ""
  });
  persistCart();
  renderCartCount();
  renderEarnNotice();
  flashCart();
  return true;
}

function flashCart() {
  var b = $("#cartCount");
  b.classList.remove("bump");
  void b.offsetWidth;
  b.classList.add("bump");
}

function renderCartCount() {
  var n = state.cart.length;
  var badge = $("#cartCount");
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.hidden = n === 0;
  $("#tabCart").setAttribute("aria-label", n ? "Cart, " + n + (n === 1 ? " company" : " companies") : "Cart");
}

var NOTE_MAX = 600;

/* What was last sent for this row, so a placed amount is not mistaken for
   one still to place. */
function lastOrderLine(o) {
  if (!o || !o.at) return null;
  var what = (o.type === "limit" ? "Limit order up to " : "Order for ") + usd(o.amount);
  return what + " sent " + relTime(o.at) + " (" + envName(o.env) + ", " + String(o.status || "sent").replace(/_/g, " ") + ")";
}

function renderCart() {
  var list = $("#cartList");
  list.innerHTML = "";
  $("#cartEmpty").hidden = state.cart.length > 0;
  $("#cartFoot").hidden = state.cart.length === 0;

  var moves = [];
  var held = heldBySymbol();

  state.cart.forEach(function (item) {
    var t = item.t;
    var live = state.byTicker[item.t];
    var now = live && num(live.price) ? live.price : null;
    var move = now !== null && num(item.priceAtAdd) && item.priceAtAdd > 0
      ? ((now - item.priceAtAdd) / item.priceAtAdd) * 100 : null;
    if (move !== null) moves.push(move);

    var row = el("div", "cart-item");

    var head = el("div", "ci-head");
    var idb = el("div", "ci-id");
    idb.appendChild(el("span", "ci-ticker", item.t));
    idb.appendChild(el("span", "ci-name", item.n));
    head.appendChild(idb);

    var priceBox = el("div", "ci-prices");
    priceBox.appendChild(el("span", "ci-now", price(now)));
    if (move !== null) {
      var dir = move > 0.05 ? "up" : move < -0.05 ? "down" : "flat";
      var mv = el("span", "delta small " + dir);
      mv.appendChild(el("span", "arrow", dir === "up" ? "▲" : dir === "down" ? "▼" : "–"));
      mv.appendChild(el("span", "", pct(move) + " since you added it"));
      priceBox.appendChild(mv);
    }
    head.appendChild(priceBox);

    var rm = el("button", "icon-btn small", null);
    rm.type = "button";
    rm.setAttribute("aria-label", "Remove " + item.t + " from cart");
    rm.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    rm.addEventListener("click", function () {
      var it = cartItem(t);
      if (!it) return;
      var copy = Object.assign({}, it);
      rm.disabled = true;
      function finish() {
        removeFromCart(t);
        persistCart();
        renderCart(); renderCartCount(); renderEarnNotice();
        showToast(t + " is out of your cart", "Undo", function () { restoreToCart(copy); });
      }
      if (stillMotion()) { finish(); return; }
      row.style.height = row.offsetHeight + "px";
      void row.offsetWidth;
      row.classList.add("is-leaving");
      setTimeout(finish, 220);
    });
    head.appendChild(rm);
    row.appendChild(head);

    var e = live && live.earnings;
    var d = e && e.date ? earn.daysUntil(e.date) : null;
    var meta = el("p", "ci-meta");
    meta.textContent = "Added " + dateShort(item.addedAt.slice(0, 10)) + " at " + price(item.priceAtAdd) +
      (e && e.date ? " · reports " + dateShort(e.date) + (d !== null && d >= 0 && d <= earn.ALERT_DAYS ? " (" + (d === 0 ? "today" : d === 1 ? "tomorrow" : "in " + d + " days") + ")" : "") : "");
    if (d !== null && d >= 0 && d <= earn.ALERT_DAYS) meta.classList.add("is-soon");
    row.appendChild(meta);

    /* ---- how much to put in ---- */
    var amtRow = el("div", "ci-amount");
    var lab = el("label", "ci-amt-label", "Amount");
    var inputId = "amt-" + item.t.replace(/[^A-Za-z0-9]/g, "_");
    lab.htmlFor = inputId;
    amtRow.appendChild(lab);
    var wrapIn = el("span", "money-in");
    wrapIn.appendChild(el("span", "", "$"));
    var amt = el("input", "");
    amt.id = inputId;
    amt.type = "number"; amt.inputMode = "decimal"; amt.min = "0"; amt.step = "any";
    amt.placeholder = "0";
    amt.value = num(item.amount) && item.amount > 0 ? String(item.amount) : "";
    wrapIn.appendChild(amt);
    amtRow.appendChild(wrapIn);
    var est = el("span", "ci-est", "");
    amtRow.appendChild(est);
    var h = held[item.t];
    if (h) amtRow.appendChild(el("span", "ci-held", "You hold " + fmtQty(h.qty) + " sh (" + usd(h.value) + ")"));
    row.appendChild(amtRow);
    var sent = lastOrderLine(item.lastOrder);
    if (sent) row.appendChild(el("p", "ci-meta ci-sent", sent));

    function showEst() {
      var v = Number(item.amount);
      est.textContent = v > 0 && now ? "≈ " + fmtQty(v / now) + " sh at " + price(now) : "";
    }
    showEst();
    /* Handlers find the item by ticker each time: a sync from another tab
       or device can swap in a newer copy of it while this row is on screen. */
    amt.addEventListener("input", function () {
      var it = cartItem(t);
      if (!it) return;
      var v = parseFloat(amt.value);
      it.amount = isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
      item = it;
      touch(it);
      showEst();
      renderOrderBar();
      persistCart();
    });

    var note = el("textarea", "ci-note");
    note.rows = 2;
    note.maxLength = NOTE_MAX;
    note.placeholder = "What made you keep this one? Private to you, and saved with your account if you sign in.";
    note.value = item.note || "";
    note.addEventListener("input", function () {
      var it = cartItem(t);
      if (!it) return;
      it.note = note.value.slice(0, NOTE_MAX);
      touch(it);
      persistCart();
    });
    if (item.note) row.appendChild(note);
    else {
      /* most rows have no note; a box per row made the cart a form */
      var addNote = el("button", "link-btn ci-add-note", "Add a note");
      addNote.type = "button";
      addNote.addEventListener("click", function () {
        note.classList.add("is-new");
        addNote.replaceWith(note);
        note.focus();
      });
      row.appendChild(addNote);
    }

    list.appendChild(row);
  });

  var summary = "";
  if (state.cart.length) {
    summary = state.cart.length + (state.cart.length === 1 ? " company" : " companies");
    if (moves.length) {
      var avg = moves.reduce(function (a, b) { return a + b; }, 0) / moves.length;
      summary += " · " + pct(avg) + " average move since added";
    }
  }
  $("#cartSummary").textContent = summary;
  renderBrokerPanel();
  renderOrderBar();
}

function openCart() { go("cart"); }

/* The cart tab, each time it is shown: drawn fresh, and the brokerage asked
   whether it is still connected. */
function showCart() {
  renderCart();
  refreshBroker().then(function (b) { if (b && b.connected) loadPortfolio(); });
}

function fmtQty(q) {
  if (!num(q)) return "—";
  return q >= 100 ? q.toFixed(0) : q >= 1 ? q.toFixed(2).replace(/\.?0+$/, "") : q.toFixed(4).replace(/0+$/, "");
}

function exportCsv() {
  var rows = [["ticker", "company", "sector", "added", "price_at_add", "price_now", "change_pct", "planned_amount", "note"]];
  state.cart.forEach(function (i) {
    var live = state.byTicker[i.t];
    var now = live && num(live.price) ? live.price : "";
    var chg = now !== "" && num(i.priceAtAdd) && i.priceAtAdd > 0
      ? (((now - i.priceAtAdd) / i.priceAtAdd) * 100).toFixed(2) : "";
    rows.push([text(i.t), text(i.n), text(i.sector), text(String(i.addedAt || "").slice(0, 10)),
               num(i.priceAtAdd) ? i.priceAtAdd : "", now, chg, num(i.amount) ? i.amount : "", text(i.note)]);
  });
  /* A text cell that starts with = + - @ is run as a formula by spreadsheet
     apps; a leading apostrophe makes it plain text. Numbers are left alone. */
  function text(v) {
    v = String(v || "");
    return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
  }
  var csv = rows.map(function (r) {
    return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(",");
  }).join("\r\n");

  /* the byte-order mark tells Excel the file is UTF-8 */
  var url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  var a = document.createElement("a");
  a.href = url;
  a.download = "stockornot-cart-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}



/* ========================================================= BROKERAGE =====
   The cart becomes an order ticket. Each company carries a dollar amount;
   once a brokerage is connected those amounts can be reviewed and sent as
   orders. Everything goes through /api/broker on this site, which holds the
   credentials where this script cannot reach them (see lib/broker.mjs).
   ======================================================================== */

var portfolio = null;         /* { positions, orders } once fetched */
var portfolioError = "";      /* why the last fetch failed, shown in place of "Loading…" */
var brokerLoading = null;

function refreshBroker() {
  if (brokerLoading) return brokerLoading;
  brokerLoading = broker.status().then(function (r) {
    brokerLoading = null;
    if (r.unavailable) state.broker = { unavailable: true };
    else if (!r.ok) state.broker = { error: r.error || "Could not check the brokerage." };
    else state.broker = r.data;
    if (!state.broker.connected) { portfolio = null; portfolioError = ""; }
    renderBrokerPanel();
    renderOrderBar();
    return state.broker;
  });
  return brokerLoading;
}

function loadPortfolio() {
  if (!state.broker || !state.broker.connected) return Promise.resolve(null);
  return broker.portfolio().then(function (r) {
    /* A failed refresh keeps what was already on screen and says why. */
    if (r.ok) { portfolio = r.data; portfolioError = ""; }
    else portfolioError = r.error || "Could not load holdings and orders.";
    if (view === "cart") renderCart();
    if ($("#dlgBroker").open) renderAccount();
    return portfolio;
  });
}

function heldBySymbol() {
  var out = {};
  ((portfolio && portfolio.positions) || []).forEach(function (p) { out[p.symbol] = p; });
  return out;
}

var envName = function (env) { return env === "live" ? "Live" : "Paper"; };

/* Money that is about to change hands is shown to the cent, never as "$2K". */
function usd(v) {
  if (!num(v)) return "—";
  var a = Math.abs(v);
  return (v < 0 ? "\u2212$" : "$") + a.toLocaleString("en-US", {
    minimumFractionDigits: Math.round(a * 100) % 100 ? 2 : 0, maximumFractionDigits: 2
  });
}

function renderBrokerPanel() {
  var box = $("#brokerPanel");
  if (!box) return;
  box.innerHTML = "";
  var b = state.broker;
  box.className = "broker-panel";

  /* Nothing to offer (still checking, or ordering is not switched on for this
     site): say nothing rather than explain the plumbing to a visitor. */
  if (!b || b.unavailable || b.configured === false) return;
  if (b.error) { box.appendChild(el("p", "bp-line", "Your brokerage could not be reached just now.")); return; }

  var line = el("div", "bp-row");
  var icon = el("span", "bp-dot" + (b.connected ? " is-on" : ""));
  icon.setAttribute("aria-hidden", "true");
  line.appendChild(icon);
  var txt = el("div", "bp-text");
  if (b.connected) {
    box.classList.add("is-connected", b.env === "live" ? "is-live" : "is-paper");
    var t = el("b", "", b.broker + " · " + envName(b.env));
    txt.appendChild(t);
    var a = b.account;
    txt.appendChild(el("span", "", a
      ? usd(a.buyingPower) + " available to buy" + (a.tradingBlocked ? " · trading blocked on this account" : "")
      : (b.accountError || "Account details unavailable right now.")));
  } else {
    txt.appendChild(el("b", "", "No brokerage connected"));
    txt.appendChild(el("span", "", "Connect one to turn this cart into orders."));
  }
  line.appendChild(txt);
  var btn = el("button", b.connected ? "ghost-btn" : "primary-btn", b.connected ? "Account" : "Connect");
  btn.type = "button";
  btn.addEventListener("click", openBroker);
  line.appendChild(btn);
  box.appendChild(line);
}

function plannedTotal() {
  return state.cart.reduce(function (sum, i) { return sum + (num(i.amount) && i.amount > 0 ? i.amount : 0); }, 0);
}

function renderOrderBar() {
  var bar = $("#orderBar");
  if (!bar) return;
  bar.hidden = state.cart.length === 0;
  var total = plannedTotal();
  $("#obTotal").textContent = usd(total);
  var b = state.broker;
  var bp = b && b.connected && b.account ? b.account.buyingPower : null;
  var bpEl = $("#obBp");
  bpEl.textContent = num(bp) ? "of " + usd(bp) + " available" : "";
  bpEl.classList.toggle("is-over", num(bp) && total > bp);

  var btn = $("#btnReview");
  /* no brokerage on this site: the amounts are still a plan worth keeping,
     but there is no button to press */
  btn.hidden = !(b && (b.connected || b.configured));
  if (b && b.connected) {
    btn.textContent = "Review orders";
    btn.disabled = !(total > 0);
  } else if (b && b.configured) {
    btn.textContent = "Connect to place orders";
    btn.disabled = false;
  }
}

function splitEvenly(total) {
  if (!(total > 0) || !state.cart.length) return;
  var each = Math.floor((total / state.cart.length) * 100) / 100;
  state.cart.forEach(function (i) { i.amount = each; touch(i); });
  persistCart();
  renderCart();
}

/* ---------------------------------------------------------- the account */

function brokerError(msg) {
  var box = $("#brokerError");
  box.hidden = !msg;
  box.textContent = msg || "";
}

function openBroker() {
  brokerError("");
  renderAccount();
  openDialog($("#dlgBroker"));
  refreshBroker().then(function () {
    renderAccount();
    if (state.broker && state.broker.connected) loadPortfolio();
  });
}

function renderAccount() {
  var b = state.broker || {};
  var connected = !!b.connected;
  $("#brokerConnect").hidden = connected || !b.configured;
  $("#brokerAccount").hidden = !connected;
  var un = $("#brokerUnavailable");
  un.hidden = !(b.unavailable || (b.configured === false));
  un.textContent = b.unavailable
    ? "Placing orders is not available on this copy of the site."
    : "Placing orders is not available yet.";
  $("#brokerEnvNote").textContent = connected ? b.broker + " · " + envName(b.env) + (b.via === "oauth" ? " · via sign-in" : " · via API keys") : "";
  if (b.lost) brokerError("The saved connection stopped working (" + b.lost + ") and has been removed. Connect again.");
  if (b.error) brokerError(b.error);

  if (!connected) {
    var oauth = $("#brokerOauth");
    oauth.hidden = !b.oauth;
    $("#brokerOr").hidden = !b.oauth;
    var liveOpt = $("#envLiveOpt");
    var liveInput = $("input[value=live]", liveOpt);
    liveInput.disabled = !b.liveAllowed;
    liveOpt.classList.toggle("is-disabled", !b.liveAllowed);
    liveOpt.title = b.liveAllowed ? "" : "Live trading is switched off while the site is in development.";
    if (!b.liveAllowed) $("input[value=paper]", $("#brokerEnv")).checked = true;
    oauth.href = broker.oauthUrl(pickedEnv());
    return;
  }

  var a = b.account;
  var grid = $("#acctGrid");
  grid.innerHTML = "";
  if (a) {
    var dayMove = num(a.equity) && num(a.lastEquity) && a.lastEquity > 0 ? ((a.equity - a.lastEquity) / a.lastEquity) * 100 : null;
    [
      ["Account", (a.number || "—") + (a.status && a.status !== "ACTIVE" ? " · " + a.status.toLowerCase() : "")],
      ["Value", usd(a.equity) + (dayMove !== null ? "  (" + pct(dayMove, 2) + " today)" : "")],
      ["Cash", usd(a.cash)],
      ["Available to buy", usd(a.buyingPower)]
    ].forEach(function (p) { grid.appendChild(statRow(p[0], p[1])); });
    var c = a.clock;
    $("#acctClock").textContent = c
      ? (c.isOpen ? "The market is open. It closes " + clockTime(c.nextClose) + "."
                  : "The market is closed. It opens " + clockTime(c.nextOpen) + "; market orders placed now wait until then.")
      : "";
  } else {
    $("#acctClock").textContent = b.accountError || "";
  }

  var posBox = $("#acctPositions");
  var ordBox = $("#acctOrders");
  if (!portfolio) {
    var wait = portfolioError ? portfolioError + " Press Refresh to try again." : "Loading…";
    posBox.innerHTML = ""; posBox.appendChild(el("p", "block-note", wait));
    ordBox.innerHTML = ""; ordBox.appendChild(el("p", "block-note", wait));
    return;
  }
  if (portfolioError) brokerError("Could not refresh holdings and orders: " + portfolioError.replace(/\.?$/, ".") + " Showing the last ones loaded.");
  posBox.innerHTML = "";
  if (!portfolio.positions.length) posBox.appendChild(el("p", "block-note", "Nothing held yet."));
  else posBox.appendChild(positionsTable(portfolio.positions));
  ordBox.innerHTML = "";
  if (!portfolio.orders.length) ordBox.appendChild(el("p", "block-note", "No orders yet."));
  else ordBox.appendChild(ordersTable(portfolio.orders));
}

function pickedEnv() {
  var r = $("input[name=brokerEnv]:checked");
  return r ? r.value : "paper";
}

function clockTime(iso) {
  if (!iso) return "soon";
  var d = new Date(iso);
  if (isNaN(d)) return "soon";
  return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
}

function positionsTable(rows) {
  var t = el("table", "fin-table acct-table");
  var hr = el("tr");
  ["", "Shares", "Avg cost", "Price", "Value", "Gain"].forEach(function (h) { hr.appendChild(el("th", "", h)); });
  var thead = el("thead"); thead.appendChild(hr); t.appendChild(thead);
  var tb = el("tbody");
  rows.forEach(function (p) {
    var tr = el("tr");
    var th = el("th", "", p.symbol); th.scope = "row";
    tr.appendChild(th);
    [fmtQty(p.qty), price(p.avgPrice), price(p.price), usd(p.value)].forEach(function (v) { tr.appendChild(el("td", "", v)); });
    var td = el("td", "");
    if (num(p.plPct)) {
      var dir = p.plPct > 0.05 ? "up" : p.plPct < -0.05 ? "down" : "flat";
      var m = el("span", "delta small " + dir);
      m.appendChild(el("span", "arrow", dir === "up" ? "▲" : dir === "down" ? "▼" : "–"));
      m.appendChild(el("span", "", pct(p.plPct, 1)));
      td.appendChild(m);
    } else td.textContent = "—";
    tr.appendChild(td);
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  var sc = el("div", "table-scroll"); sc.appendChild(t);
  return sc;
}

var OPEN_STATUS = { "new": 1, "accepted": 1, "pending_new": 1, "partially_filled": 1, "held": 1, "accepted_for_bidding": 1 };

function ordersTable(rows) {
  var t = el("table", "fin-table acct-table");
  var hr = el("tr");
  ["", "Order", "Status", "Placed", ""].forEach(function (h) { hr.appendChild(el("th", "", h)); });
  var thead = el("thead"); thead.appendChild(hr); t.appendChild(thead);
  var tb = el("tbody");
  rows.forEach(function (o) {
    var tr = el("tr");
    var th = el("th", "", o.symbol); th.scope = "row";
    tr.appendChild(th);
    var what = o.side + " " + (num(o.notional) ? usd(o.notional) : fmtQty(o.qty) + " sh") +
      (o.type === "limit" && num(o.limitPrice) ? " @ " + price(o.limitPrice) : "");
    tr.appendChild(el("td", "", what));
    var st = (o.status || "").replace(/_/g, " ");
    if (o.status === "filled" && num(o.filledAvg)) st += " @ " + price(o.filledAvg);
    tr.appendChild(el("td", "ord-status is-" + (o.status || ""), st));
    tr.appendChild(el("td", "", o.submittedAt ? relTime(o.submittedAt) : ""));
    var tdc = el("td", "");
    if (OPEN_STATUS[o.status]) {
      var cb = el("button", "link-btn danger", "Cancel");
      cb.type = "button";
      cb.addEventListener("click", function () {
        cb.disabled = true;
        broker.cancel(o.id).then(function (r) {
          if (!r.ok) { cb.disabled = false; brokerError(r.error); return; }
          loadPortfolio();
        });
      });
      tdc.appendChild(cb);
    }
    tr.appendChild(tdc);
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  var sc = el("div", "table-scroll"); sc.appendChild(t);
  return sc;
}

/* ----------------------------------------------------------- the review

   Money leaves from here, so the rules are strict:
   - Each cart row keeps one client id per planned order (item.orderKey). The
     brokerage refuses an id it has seen, so pressing Place twice, reopening
     the review, retrying after a lost answer, or placing the same row from a
     second device cannot buy twice.
   - While a batch is out nothing on the sheet can change, and what is sent is
     the plan as it stood at the click, not whatever is on screen later.
   - A row that went through has its amount cleared and remembers the order
     (item.lastOrder), so the cart stops offering to buy it again.
   ------------------------------------------------------------------------ */

var review = null;   /* { env, rows: [{ t, limit, plan, sent, result }], sending, placed } */
var BATCH = 50;      /* the server takes at most this many per request */
var DEAD_ORDER = { rejected: 1, canceled: 1, expired: 1 };

function orderError(msg) {
  var box = $("#orderError");
  box.hidden = !msg;
  box.textContent = msg || "";
}

function openReview() {
  var b = state.broker;
  if (!b || !b.connected) { openBroker(); return; }
  /* a batch is still out: show it rather than start a second one */
  if (review && review.sending) { openDialog($("#dlgOrders")); return; }
  orderError("");
  var mine = review = {
    env: b.env,
    sending: false,
    placed: false,
    rows: state.cart.filter(function (i) { return num(i.amount) && i.amount > 0; })
      .map(function (i) { return { t: i.t, limit: null, plan: null, sent: null, result: null }; })
  };
  $("#orderLiveCheck").checked = false;
  showReviewEnv();
  setOrderType(state.orderType);
  openDialog($("#dlgOrders"));
  /* The connection may have changed in another tab since this page last asked. */
  refreshBroker().then(function (nb) {
    if (review !== mine || mine.sending || mine.placed) return;
    if (!nb || !nb.connected) { mine.message = "No brokerage is connected any more. Connect again from Account."; mine.env = null; }
    else if (nb.env !== mine.env) { mine.env = nb.env; $("#orderLiveCheck").checked = false; }
    showReviewEnv();
    renderReview();
  });
}

function showReviewEnv() {
  var b = state.broker || {};
  $("#ordersEnv").textContent = review && review.env ? b.broker + " · " + envName(review.env) : "";
  $("#orderLiveConfirm").hidden = !(review && review.env === "live");
}

function setOrderType(type) {
  if (review && (review.sending || review.placed)) return;
  state.orderType = type === "limit" ? "limit" : "market";
  Array.prototype.forEach.call($("#orderType").children, function (c) {
    var on = c.getAttribute("data-type") === state.orderType;
    c.classList.toggle("is-on", on);
    c.setAttribute("aria-checked", on ? "true" : "false");
  });
  var clock = state.broker && state.broker.account && state.broker.account.clock;
  var closed = clock && !clock.isOpen ? " The market is closed; orders wait for the open " + clockTime(clock.nextOpen) + "." : "";
  $("#orderTypeNote").textContent = (state.orderType === "market"
    ? "Buys the dollar amount at whatever the price is when the order fills, fractions of a share included. Prices below are last night's close, so the share count is an estimate."
    : "Buys whole shares only, and only at or below the limit. Starts at last night's close; change any limit before placing.") + closed;
  renderReview();
}

function planFor(row) {
  var item = cartItem(row.t);
  if (!item) return { symbol: row.t, error: "No longer in the cart." };
  var live = state.byTicker[row.t];
  var b = state.broker || {};
  return broker.planOrder(item, {
    type: state.orderType,
    limitPrice: row.limit,
    price: live && live.price,
    env: review && review.env,
    maxLive: b.maxLiveOrder
  });
}

function renderReview() {
  var list = $("#orderList");
  list.innerHTML = "";
  var total = 0, ready = 0, noAnswer = null;
  var locked = !!(review && (review.sending || review.placed));

  if (!review || !review.rows.length) {
    list.appendChild(el("p", "empty-note", "Nothing to place. Put a dollar amount against at least one company in the cart."));
  }

  (review ? review.rows : []).forEach(function (row) {
    var item = cartItem(row.t);
    /* a row that has been sent shows what was sent, never a fresh plan */
    var plan = row.sent || (locked ? row.plan : planFor(row));
    if (!row.sent && !locked) row.plan = plan;
    var live = state.byTicker[row.t];
    var r = el("div", "order-row" + (row.result ? (row.result.ok ? " is-ok" : " is-bad") : ""));

    var idb = el("div", "or-id");
    idb.appendChild(el("b", "", row.t));
    idb.appendChild(el("span", "", (item && item.n) || (live && live.n) || ""));
    r.appendChild(idb);

    var what = el("div", "or-what");
    var isLimit = plan ? plan.type === "limit" : state.orderType === "limit";
    if (plan && !plan.error && plan.type === "market") {
      what.appendChild(el("span", "", "Buy " + usd(plan.notional)));
      if (num(plan.estShares)) what.appendChild(el("span", "or-sub", "≈ " + fmtQty(plan.estShares) + " sh at " + price(live && live.price)));
    } else if (plan && !plan.error) {
      what.appendChild(el("span", "", "Buy " + plan.qty + " sh"));
    }
    /* The limit field stays even when the limit is what is wrong, so a
       mistyped price can be fixed without starting over. */
    if (plan && isLimit) {
      var limWrap = el("label", "or-lim");
      limWrap.appendChild(el("span", "", "limit $"));
      var lim = el("input", "");
      lim.type = "number"; lim.step = "0.01"; lim.min = "0.0001"; lim.inputMode = "decimal";
      var shown = num(plan.limitPrice) ? plan.limitPrice : row.limit !== null ? row.limit : live && live.price;
      lim.value = num(shown) ? String(shown) : "";
      lim.disabled = locked || !!row.sent;
      lim.setAttribute("aria-label", "Limit price for " + row.t);
      lim.addEventListener("change", function () {
        if (review && (review.sending || review.placed)) return;
        var v = parseFloat(lim.value);
        row.limit = isFinite(v) && v > 0 ? v : null;
        renderReview();
      });
      limWrap.appendChild(lim);
      what.appendChild(limWrap);
      if (!plan.error) what.appendChild(el("span", "or-sub", "up to " + usd(plan.cost)));
    }
    if (plan && plan.error) what.appendChild(el("span", "or-err", plan.error));
    if (plan && !plan.error && !(row.result && row.result.ok)) { total += plan.cost; ready++; }
    if (!row.result && item && item.orderKey && item.orderKey.sentAt && !row.sent) {
      noAnswer = noAnswer || item.orderKey.sentAt;
      what.appendChild(el("span", "or-sub or-warn", "Sent " + relTime(item.orderKey.sentAt) + ", no answer yet"));
    }
    r.appendChild(what);

    if (row.result) {
      var res = el("div", "or-result");
      if (row.result.ok) {
        var o = row.result.order || {};
        res.appendChild(el("span", "delta small up", "✓ " + (row.result.duplicate ? "already placed · " : "") + (o.status || "sent").replace(/_/g, " ")));
      } else {
        res.appendChild(el("span", "delta small down", "✗ " + row.result.error));
      }
      r.appendChild(res);
    }
    list.appendChild(r);
  });

  $("#orderTotal").textContent = usd(total);
  var btn = $("#btnPlace");
  var b = state.broker || {};
  var needsConfirm = review && review.env === "live" && !$("#orderLiveCheck").checked;
  $("#orderLiveCheck").disabled = locked;
  Array.prototype.forEach.call($("#orderType").children, function (c) { c.disabled = locked; });
  btn.disabled = !ready || locked || needsConfirm || !(review && review.env);
  if (review && review.sending) btn.textContent = "Placing…";
  else if (review && review.placed) btn.textContent = review.summary || "Sent";
  else if (review && review.rows.some(function (x) { return x.result; })) btn.textContent = "Place the other " + ready;
  else btn.textContent = "Place " + ready + (ready === 1 ? " order" : " orders");
  /* the outcome of the last send, if there was one, otherwise a warning */
  var bp = b.account && b.account.buyingPower;
  orderError(review && review.message ? review.message
    : noAnswer ? "Rows marked \u201cno answer yet\u201d were sent " + relTime(noAnswer) + " but no reply came back. Placing them again as they are cannot buy twice: the brokerage refuses a repeat. If you change one, check Account \u2192 Recent orders first."
    : !locked && num(bp) && total > bp ? "That is more than the " + usd(bp) + " this account has available. Some orders will be refused." : "");
}

/* The id to send for this row's plan: the one already kept for the same plan,
   or a new one kept from now on. */
function orderIdFor(item, plan) {
  var sig = broker.planSignature(plan);
  if (!item.orderKey || item.orderKey.sig !== sig) item.orderKey = { sig: sig, id: broker.clientId(item.t) };
  item.orderKey.sentAt = new Date().toISOString();
  touch(item);
  return item.orderKey.id;
}

function placeOrders() {
  var mine = review;
  if (!mine || mine.sending || mine.placed || !mine.env) return;
  if (mine.env === "live" && !$("#orderLiveCheck").checked) return;
  var rows = mine.rows.filter(function (r) { return !(r.result && r.result.ok) && r.plan && !r.plan.error && cartItem(r.t); });
  if (!rows.length) return;

  /* freeze exactly what is being sent */
  var payload = rows.map(function (r) {
    var item = cartItem(r.t);
    r.sent = r.plan;
    r.result = null;
    return {
      symbol: r.sent.symbol, side: "buy", type: r.sent.type, clientId: orderIdFor(item, r.sent),
      notional: r.sent.notional, qty: r.sent.qty, limitPrice: r.sent.limitPrice, tif: r.sent.tif
    };
  });
  persistCart();
  mine.sending = true;
  mine.message = "";
  renderReview();

  var chunks = [];
  for (var i = 0; i < payload.length; i += BATCH) chunks.push(payload.slice(i, i + BATCH));
  var answered = [];
  var confirmLive = mine.env === "live" && $("#orderLiveCheck").checked;

  function next(k) {
    if (k >= chunks.length) return Promise.resolve(null);
    return broker.place(chunks[k], mine.env, confirmLive).then(function (res) {
      if (!res.ok) return res;
      answered = answered.concat(res.data.results);
      return next(k + 1);
    });
  }

  next(0).then(function (failure) {
    var bySym = {};
    answered.forEach(function (x) { bySym[x.symbol] = x; });
    var now = new Date().toISOString();
    rows.forEach(function (r) {
      var x = bySym[r.sent.symbol];
      if (!x) { r.sent = null; return; }        /* never answered: may be retried as is */
      var o = x.order || {};
      if (x.ok && x.duplicate && DEAD_ORDER[o.status]) {
        x = { ok: false, error: "An earlier attempt was " + o.status + ". Review again to send a fresh order." };
      }
      r.result = x;
      var item = cartItem(r.t);
      if (!item) return;
      touch(item);
      if (x.ok) {
        item.lastOrder = { at: now, env: mine.env, amount: r.sent.cost, type: r.sent.type, status: o.status || "sent", id: o.id || null };
        item.amount = null;
        delete item.orderKey;
      } else if (item.orderKey && DEAD_ORDER[(x.order || {}).status]) {
        delete item.orderKey;
      } else if (item.orderKey) {
        delete item.orderKey.sentAt;              /* answered: refused, not lost */
      }
    });
    persistCart();
    mine.sending = false;

    if (failure) {
      if (failure.status === 409 && failure.error) {
        /* the connection changed under this sheet: re-read it and ask again */
        refreshBroker().then(function (nb) {
          if (review !== mine) return;
          mine.env = nb && nb.connected ? nb.env : null;
          $("#orderLiveCheck").checked = false;
          showReviewEnv();
          renderReview();
        });
      }
      mine.message = (answered.length ? answered.length + " were answered before this. " : "") + failure.error +
        (failure.status === 409 ? "" : " Pressing Place again resends the same orders, which the brokerage will not duplicate.");
    } else {
      mine.placed = true;
      var sentRows = rows.length;
      var okCount = rows.filter(function (r) { return r.result && r.result.ok; }).length;
      mine.summary = okCount + " of " + sentRows + " sent";
      mine.message = okCount === sentRows ? "" : (sentRows - okCount) + " of " + sentRows + " were refused. The reasons are beside each one; their amounts stay in the cart.";
    }
    if (review === mine) renderReview();
    renderOrderBar();
    if (view === "cart") renderCart();
    refreshBroker().then(loadPortfolio);
  });
}

/* ========================================================== EARNINGS =====
   A week's warning before anything in the cart reports, with what the street
   expects it to hit. Three ways to hear about it: this banner whenever the
   site is open, a calendar file whose reminders fire on any device, and an
   email from the nightly job for anyone signed in who asks for one.
   ======================================================================== */

var NOTICE_KEY = "ts.earnNoticeHidden";

function renderEarnNotice() {
  var box = $("#earnNotice");
  if (!box || !state.all.length) return;
  var soon = earn.upcoming(state.cart, state.byTicker, { days: earn.ALERT_DAYS });
  var sig = soon.map(function (u) { return u.t + u.date; }).join(",");
  var hidden = false;
  try { hidden = localStorage.getItem(NOTICE_KEY) === sig; } catch (e) {}
  if (!soon.length || hidden) { box.hidden = true; return; }
  var first = soon[0];
  var when = first.days === 0 ? "today" : first.days === 1 ? "tomorrow" : "in " + first.days + " days";
  $("#earnNoticeText").textContent = first.t + " reports " + when +
    (num(first.epsEst) ? ", expected " + earn.eps(first.epsEst) + " a share" : "") +
    (soon.length > 1 ? " · " + (soon.length - 1) + " more in your cart in the next week" : "");
  box.hidden = false;
  box.dataset.sig = sig;
}

function openEarnings() {
  var icsNote = $("#icsNote");
  if (icsNote.dataset.text) icsNote.textContent = icsNote.dataset.text;
  else icsNote.dataset.text = icsNote.textContent;
  var list = $("#earnList");
  list.innerHTML = "";
  var month = earn.upcoming(state.cart, state.byTicker, { days: 45 });
  var undated = state.cart.filter(function (i) {
    var s = state.byTicker[i.t];
    return !(s && s.earnings && s.earnings.date && earn.daysUntil(s.earnings.date) >= 0);
  });

  $("#earnNote").textContent = state.cart.length
    ? month.length + " of " + state.cart.length + " in your cart report in the next 45 days"
    : "";

  if (!state.cart.length) {
    list.appendChild(el("p", "empty-note", "Add companies to your cart and their report dates show up here."));
  } else if (!month.length) {
    list.appendChild(el("p", "empty-note", "Nothing in your cart reports in the next 45 days."));
  }

  var groups = [
    { title: "Next 7 days", rows: month.filter(function (u) { return u.days <= earn.ALERT_DAYS; }) },
    { title: "Later", rows: month.filter(function (u) { return u.days > earn.ALERT_DAYS; }) }
  ];
  groups.forEach(function (g) {
    if (!g.rows.length) return;
    list.appendChild(el("h3", "block-h", g.title));
    g.rows.forEach(function (u) {
      var row = el("div", "earn-row" + (u.days <= earn.ALERT_DAYS ? " is-soon" : ""));
      var when = el("div", "er-when");
      when.appendChild(el("b", "", dateShort(u.date)));
      when.appendChild(el("span", "", u.days === 0 ? "today" : u.days === 1 ? "tomorrow" : "in " + u.days + " days"));
      if (earn.whenWord(u.hour)) when.appendChild(el("span", "", earn.whenWord(u.hour)));
      row.appendChild(when);

      var body = el("div", "er-body");
      var h = el("p", "er-head");
      var tb = el("button", "link-btn er-ticker", u.t);
      tb.type = "button";
      tb.addEventListener("click", function () { closeDialog($("#dlgEarnings")); openDetail(state.byTicker[u.t]); });
      h.appendChild(tb);
      h.appendChild(el("span", "", " " + (u.n || "") + (earn.quarterLabel(u) ? " · " + earn.quarterLabel(u) : "")));
      body.appendChild(h);
      body.appendChild(el("p", "er-expect", earn.expectation(u)));
      var trackP = el("p", "er-track", "");
      body.appendChild(trackP);
      loadDeep(u.t).then(function (deep) { trackP.textContent = earn.track(deep && deep.analyst); });
      row.appendChild(body);
      list.appendChild(row);
    });
  });

  if (undated.length) {
    list.appendChild(el("p", "block-note", "No date announced yet for " + undated.map(function (i) { return i.t; }).join(", ") +
      ". They appear here as soon as the company sets one."));
  }

  renderEmailToggle();
  openDialog($("#dlgEarnings"));
}

function renderEmailToggle() {
  var box = $("#earnEmail");
  var note = $("#earnEmailNote");
  if (!auth.isConfigured()) {
    box.disabled = true;
    note.textContent = "Email alerts need accounts, which are not set up on this copy of the site.";
    return;
  }
  if (!state.user) {
    box.checked = false;
    box.disabled = true;
    note.innerHTML = "";
    note.appendChild(document.createTextNode("Sign in so there is an address to send it to. "));
    var go = el("button", "link-btn", "Sign in");
    go.type = "button";
    go.addEventListener("click", function () { closeDialog($("#dlgEarnings")); openAuth(); });
    note.appendChild(go);
    return;
  }
  box.disabled = true;
  note.textContent = "Checking…";
  auth.fetchAlertPrefs().then(function (r) {
    if (!r.ok) {
      note.textContent = r.error;
      return;
    }
    box.disabled = false;
    box.checked = !!(r.data && r.data.email);
    note.textContent = box.checked
      ? "On. One email to " + (state.user.email || "your account address") + " on the first evening anything in your cart is within a week of reporting; each report is mentioned once."
      : "Off.";
  });
}

function downloadIcs(rows, filename) {
  if (!rows.length) return;
  var ics = earn.toIcs(rows, { site: location.origin });
  var url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  var a = document.createElement("a");
  a.href = url;
  a.download = filename || "stockornot-earnings.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}

function cartIcs() {
  var rows = earn.upcoming(state.cart, state.byTicker, { days: 400 });
  if (!rows.length) {
    $("#icsNote").textContent = "None of the companies in your cart has a report date yet, so there is nothing to put in a calendar.";
    return;
  }
  downloadIcs(rows, "stockornot-earnings.ics");
}

/* ====================================================== DETAIL SHEET =====
   Everything that doesn't fit on the card: a five-year price chart, the
   financial statements as filed, what analysts think, and the whole risk
   section rather than the first five lines of it.
   ======================================================================== */

var deepCache = {};

function loadDeep(ticker) {
  if (deepCache[ticker] !== undefined) return Promise.resolve(deepCache[ticker]);
  var safe = ticker.replace(/[^A-Z0-9.]/gi, "_");
  return fetch("data/detail/" + encodeURIComponent(safe) + ".json", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { deepCache[ticker] = j; return j; })
    .catch(function () { deepCache[ticker] = null; return null; });
}

/* ---------------------------------------------------------- price chart */

var CHART_W = 720, CHART_H = 240, PAD_L = 4, PAD_R = 4, PAD_T = 12, PAD_B = 22;

function niceTicks(lo, hi, count) {
  var span = hi - lo;
  if (span <= 0) return [lo];
  var raw = span / count;
  var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
  var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; })
    .filter(function (s) { return s >= raw; })[0] || 10 * mag;
  var out = [], v = Math.ceil(lo / step) * step;
  while (v <= hi + 1e-9) { out.push(v); v += step; }
  return out;
}

function buildChart(points, months) {
  var wrap = el("div", "chart-wrap");
  if (!points || points.length < 5) {
    wrap.appendChild(el("p", "block-note", "No price history for this company yet."));
    return wrap;
  }

  var cut = months
    ? new Date(Date.now() - months * 30.5 * 864e5).toISOString().slice(0, 10)
    : "0000";
  var pts = points.filter(function (p) { return p[0] >= cut; });
  if (pts.length < 5) pts = points.slice(-Math.max(5, Math.round(points.length / 4)));

  var vals = pts.map(function (p) { return p[1]; });
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  var pad = (hi - lo) * 0.08 || hi * 0.05 || 1;
  lo -= pad; hi += pad;

  var innerW = CHART_W - PAD_L - PAD_R, innerH = CHART_H - PAD_T - PAD_B;
  var xOf = function (i) { return PAD_L + (i / (pts.length - 1)) * innerW; };
  var yOf = function (v) { return PAD_T + (1 - (v - lo) / (hi - lo)) * innerH; };

  var line = "", area = "";
  pts.forEach(function (p, i) {
    var cmd = (i === 0 ? "M" : "L") + xOf(i).toFixed(1) + " " + yOf(p[1]).toFixed(1);
    line += cmd; area += cmd;
  });
  area += "L" + xOf(pts.length - 1).toFixed(1) + " " + (PAD_T + innerH) + "L" + PAD_L + " " + (PAD_T + innerH) + "Z";

  var first = pts[0][1], last = pts[pts.length - 1][1];
  var move = ((last - first) / first) * 100;

  var svgNS = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 " + CHART_W + " " + CHART_H);
  svg.setAttribute("class", "pricechart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label",
    "Price from " + pts[0][0] + " to " + pts[pts.length - 1][0] +
    ", " + price(first) + " to " + price(last) + ", " + pct(move, 1));

  function add(tag, attrs, cls) {
    var n = document.createElementNS(svgNS, tag);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (cls) n.setAttribute("class", cls);
    svg.appendChild(n);
    return n;
  }

  niceTicks(lo, hi, 3).forEach(function (v) {
    add("line", { x1: PAD_L, x2: CHART_W - PAD_R, y1: yOf(v).toFixed(1), y2: yOf(v).toFixed(1) }, "grid");
    var t = add("text", { x: PAD_L + 2, y: (yOf(v) - 4).toFixed(1) }, "axis");
    t.textContent = price(v);
  });

  /* year boundaries as sparse x labels */
  var seenYear = null;
  pts.forEach(function (p, i) {
    var y = p[0].slice(0, 4);
    if (y !== seenYear) {
      seenYear = y;
      if (i > 2 && i < pts.length - 2) {
        var t = add("text", { x: xOf(i).toFixed(1), y: CHART_H - 6, "text-anchor": "middle" }, "axis");
        t.textContent = y;
      }
    }
  });

  add("path", { d: area }, "area");
  add("path", { d: line, "vector-effect": "non-scaling-stroke" }, "line");

  var cross = add("line", { x1: 0, x2: 0, y1: PAD_T, y2: PAD_T + innerH }, "crosshair");
  var dot = add("circle", { cx: 0, cy: 0, r: 4.5 }, "cursor-dot");
  cross.style.opacity = dot.style.opacity = 0;

  wrap.appendChild(svg);

  var tip = el("div", "chart-tip");
  tip.hidden = true;
  wrap.appendChild(tip);

  var caption = el("p", "chart-caption");
  caption.innerHTML = "";
  var moveSpan = el("span", "delta small " + (move > 0.05 ? "up" : move < -0.05 ? "down" : "flat"));
  moveSpan.appendChild(el("span", "arrow", move > 0.05 ? "▲" : move < -0.05 ? "▼" : "–"));
  moveSpan.appendChild(el("span", "", pct(move, 1) + " over this window"));
  caption.appendChild(el("span", "", pts[0][0] + " → " + pts[pts.length - 1][0]));
  caption.appendChild(moveSpan);
  wrap.appendChild(caption);

  function place(ev) {
    var box = svg.getBoundingClientRect();
    var rel = (ev.clientX - box.left) / box.width;
    var i = clamp(Math.round(rel * (pts.length - 1)), 0, pts.length - 1);
    var px = xOf(i), py = yOf(pts[i][1]);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px);
    dot.setAttribute("cx", px); dot.setAttribute("cy", py);
    cross.style.opacity = dot.style.opacity = 1;
    tip.hidden = false;
    tip.textContent = "";
    tip.appendChild(el("b", "", price(pts[i][1])));
    tip.appendChild(el("span", "", dateShort(pts[i][0])));
    var leftPct = (px / CHART_W) * 100;
    tip.style.left = clamp(leftPct, 8, 92) + "%";
  }
  svg.addEventListener("pointermove", place);
  svg.addEventListener("pointerdown", place);
  svg.addEventListener("pointerleave", function () {
    cross.style.opacity = dot.style.opacity = 0;
    tip.hidden = true;
  });

  return wrap;
}

/* ------------------------------------------------ financials, as filed */

/* Five years of the filings, under the same four checks as the card
   (valuation has no history in a filing). */
function buildHistory(deep) {
  var box = el("div", "");
  var hc = insight.historyChecks(deep && deep.history);
  if (!hc) {
    box.appendChild(el("p", "block-note", "This company files its numbers in a shape this reader could not follow, so there is no year-by-year history."));
    return box;
  }

  var table = el("table", "fin-table");
  var thead = el("thead");
  var hr = el("tr");
  hr.appendChild(el("th", "", ""));
  hc.years.forEach(function (y) { hr.appendChild(el("th", "", "FY" + y)); });
  thead.appendChild(hr);
  table.appendChild(thead);

  var tb = el("tbody");
  hc.groups.forEach(function (g) {
    var gr = el("tr", "fin-group");
    var gh = el("th", "");
    gh.colSpan = hc.years.length + 1;
    gh.scope = "colgroup";
    var ic = el("span", "check-icon");
    ic.innerHTML = CHECK_ICONS[g.icon] || "";
    ic.setAttribute("aria-hidden", "true");
    gh.appendChild(ic);
    gh.appendChild(document.createTextNode(" " + g.title));
    gr.appendChild(gh);
    tb.appendChild(gr);
    g.rows.forEach(function (row) {
      var tr = el("tr", row.derived ? "is-derived" : "");
      var th = el("th", "", row.label); th.scope = "row";
      tr.appendChild(th);
      row.cells.forEach(function (c) { tr.appendChild(el("td", "", c)); });
      tb.appendChild(tr);
    });
  });
  table.appendChild(tb);

  box.appendChild(el("p", "block-note", "Taken from the company's own filings. Italic rows are worked out from the others."));
  var scroll = el("div", "table-scroll");
  scroll.appendChild(table);
  box.appendChild(scroll);
  return box;
}

/* ------------------------------------------------------- analyst view */

var REC_BANDS = [
  { key: "strongBuy",  label: "Strong buy",  cls: "rec-sb" },
  { key: "buy",        label: "Buy",         cls: "rec-b"  },
  { key: "hold",       label: "Hold",        cls: "rec-h"  },
  { key: "sell",       label: "Sell",        cls: "rec-s"  },
  { key: "strongSell", label: "Strong sell", cls: "rec-ss" }
];

/* Two decimals unless the number genuinely has more, then up to four. */
function trimNum(v) {
  var s = v.toFixed(4).replace(/0+$/, "");
  var dp = (s.split(".")[1] || "").length;
  return v.toFixed(Math.max(2, Math.min(4, dp)));
}

/* The estimate beside an actual, in cents unless the two round to the same
   cent, when "$0.80 vs $0.80, a miss" would read as a tie: then its real
   precision says which way it went. */
function estimateBeside(actual, estimate) {
  return earn.eps(estimate) === earn.eps(actual) ? epsPrecise(estimate) : earn.eps(estimate);
}
function epsPrecise(v) { return (v < 0 ? "\u2212" : "") + "$" + trimNum(Math.abs(v)); }

function buildAnalyst(deep) {
  var box = el("div", "");
  var a = deep && deep.analyst;
  var trend = (a && a.trend) || [];
  var surprises = (a && a.earnings) || [];

  /* Three different silences, and they are not the same thing: the deep file
     has not been generated yet, it exists but the fetch has not run, or the
     street genuinely publishes nothing on this ticker. Say which. */
  if (!trend.length && !surprises.length) {
    box.appendChild(el("p", "block-note", !deep
      ? "The chart and analyst view for this company have not been built yet. They arrive with tomorrow's refresh."
      : "Nobody publishes ratings or earnings estimates for this company."));
    return box;
  }

  if (trend.length) {
    box.appendChild(el("h4", "sub-h", "Where the ratings sit"));

    var legend = el("div", "rec-legend");
    REC_BANDS.forEach(function (b) {
      var item = el("span", "rec-key");
      item.appendChild(el("span", "rec-chip " + b.cls));
      item.appendChild(el("span", "", b.label));
      legend.appendChild(item);
    });
    box.appendChild(legend);

    var list = el("div", "rec-rows");
    trend.slice(0, 4).forEach(function (row) {
      var total = REC_BANDS.reduce(function (s, b) { return s + (row[b.key] || 0); }, 0);
      var r = el("div", "rec-row");
      r.appendChild(el("span", "rec-period", (row.period || "").slice(0, 7)));
      var bar = el("div", "rec-bar");
      REC_BANDS.forEach(function (b) {
        var v = row[b.key] || 0;
        if (!v) return;
        var seg = el("span", "rec-seg " + b.cls);
        seg.style.width = ((v / total) * 100) + "%";
        seg.title = b.label + ": " + v;
        if (v / total > 0.13) seg.textContent = v;
        bar.appendChild(seg);
      });
      r.appendChild(bar);
      r.appendChild(el("span", "rec-total", total + " analysts"));
      list.appendChild(r);
    });
    box.appendChild(list);
  }

  if (surprises.length) {
    box.appendChild(el("h4", "sub-h", "Has it been beating estimates?"));
    var t = el("table", "rv-table");
    var tb = el("tbody");
    surprises.slice(0, 6).forEach(function (e) {
      var tr = el("tr");
      var th = el("th", "", e.period); th.scope = "row";
      tr.appendChild(th);
      var beat = num(e.actual) && num(e.estimate) && e.actual >= e.estimate;
      var td = el("td", "");
      var mark = el("span", "delta small " + (beat ? "up" : "down"));
      mark.appendChild(el("span", "arrow", beat ? "▲" : "▼"));
      /* Consensus estimates carry more decimals than a share price does — APH's
         Q2 was $1.1942, not $1.19. Rounding it to two made the printed beat
         percentage look like it did not follow from the two numbers beside it,
         so keep whatever precision the estimate actually has, up to four. */
      mark.appendChild(el("span", "",
        earn.eps(e.actual) + " vs " + (num(e.estimate) ? epsPrecise(e.estimate) : "—") + " expected" +
        (num(e.surprisePct) ? " (" + pct(e.surprisePct, 1) + ")" : "")));
      td.appendChild(mark);
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    box.appendChild(t);
  }

  var months = (a && a.insider && a.insider.months) || [];
  if (months.length) {
    var ins = insight.insiderSummary(a.insider);
    box.appendChild(el("h4", "sub-h", "Are insiders buying or selling?"));
    box.appendChild(el("p", "block-note first",
      (ins.word === "mixed" ? "No clear direction" : ins.word.charAt(0).toUpperCase() + ins.word.slice(1)) +
      " " + ins.when + ". Sentiment runs from −100, every insider trade a sale, to +100, every one a purchase. " +
      "Executives sell for many reasons; buying with their own money has only one."));
    var it = el("table", "rv-table");
    var itb = el("tbody");
    months.forEach(function (m) {
      var tr = el("tr");
      var th = el("th", "", m.ym); th.scope = "row";
      tr.appendChild(th);
      var dir = m.mspr > 5 ? "up" : m.mspr < -5 ? "down" : "flat";
      var td = el("td", "");
      var mark = el("span", "delta small " + dir);
      mark.appendChild(el("span", "arrow", dir === "up" ? "▲" : dir === "down" ? "▼" : "–"));
      mark.appendChild(el("span", "", (m.mspr > 0 ? "+" : "") + m.mspr.toFixed(0) +
        (num(m.change) && m.change !== 0 ? " · " + (m.change > 0 ? "+" : "-") + money(Math.abs(m.change), false) + " shares" : "")));
      td.appendChild(mark);
      tr.appendChild(td);
      itb.appendChild(tr);
    });
    it.appendChild(itb);
    box.appendChild(it);
  }
  return box;
}

/* ---------------------------------------------------------- next report */

function buildNextReport(s, deep) {
  var e = s.earnings;
  if (!e || !e.date) return null;
  var d = earn.daysUntil(e.date);
  if (d === null || d < 0) return null;       /* already reported: nothing "next" to show */
  var box = el("div", "next-report");
  var head = el("p", "nr-head");
  head.appendChild(el("b", "", dateShort(e.date)));
  head.appendChild(el("span", "", " · " + (d === 0 ? "today" : d === 1 ? "tomorrow" : d > 1 ? "in " + d + " days" : "just reported") +
    (earn.whenWord(e.hour) ? ", " + earn.whenWord(e.hour) : "") +
    (earn.quarterLabel(e) ? " · " + earn.quarterLabel(e) + " results" : "")));
  box.appendChild(head);

  var grid = el("dl", "c-stats");
  grid.appendChild(statRow("EPS expected", earn.eps(e.epsEst), "Consensus earnings per share for the quarter being reported."));
  if (num(e.revEst)) grid.appendChild(statRow("Revenue expected", earn.money(e.revEst), "Consensus revenue for the quarter being reported."));
  var last = ((deep && deep.analyst && deep.analyst.earnings) || [])[0];
  /* to the cent the estimate can look like a tie ("$0.80 vs $0.80") when the
     quarter was a narrow miss, so show its real precision and say which */
  grid.appendChild(statRow("Last quarter", last && num(last.actual) ? earn.eps(last.actual) +
    (num(last.estimate) ? " vs " + estimateBeside(last.actual, last.estimate) + (last.actual >= last.estimate ? ", a beat" : ", a miss") : "") : "—",
    "Reported EPS against what was expected, for the most recent quarter."));
  box.appendChild(grid);

  var trackLine = earn.track(deep && deep.analyst);
  if (trackLine) box.appendChild(el("p", "block-note", trackLine));

  var cal = el("button", "link-btn", "Add this date to my calendar, with a reminder a week before");
  cal.type = "button";
  cal.addEventListener("click", function () {
    downloadIcs([{ t: s.t, n: s.n, date: e.date, hour: e.hour, epsEst: e.epsEst, revEst: e.revEst, q: e.q, fy: e.fy }],
      "stockornot-" + s.t.toLowerCase() + "-earnings.ics");
  });
  box.appendChild(cal);
  return box;
}

/* ---------------------------------------------------------------- peers */

function buildPeers(s, peers) {
  var wrap = el("div", "");
  wrap.appendChild(el("h4", "sub-h", "Closest in size"));
  var t = el("table", "fin-table peer-table");
  var thead = el("thead");
  var hr = el("tr");
  ["", "Mkt cap", "P/E", "Rev. growth", "Net margin", "1yr"].forEach(function (h) { hr.appendChild(el("th", "", h)); });
  thead.appendChild(hr);
  t.appendChild(thead);
  var tb = el("tbody");
  [s].concat(peers).forEach(function (p) {
    var tr = el("tr", p.t === s.t ? "is-self" : "");
    var th = el("th", "");
    th.scope = "row";
    if (p.t === s.t) th.appendChild(el("b", "", p.t));
    else {
      var b = el("button", "link-btn", p.t);
      b.type = "button";
      b.title = p.n;
      b.addEventListener("click", function () { openDetail(p); });
      th.appendChild(b);
    }
    tr.appendChild(th);
    [cap(p.mc), num(p.pe) && p.pe > 0 ? x(p.pe) : "n/a", pct(p.rg), pctPlain(p.nm, 0), pct(p.r52)]
      .forEach(function (v) { tr.appendChild(el("td", "", v)); });
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  var scroll = el("div", "table-scroll");
  scroll.appendChild(t);
  wrap.appendChild(scroll);
  return wrap;
}

/* ----------------------------------------------------------------- news */

var newsCache = {};

function loadNews(ticker) {
  if (newsCache[ticker]) return newsCache[ticker];
  newsCache[ticker] = fetch("/api/news?t=" + encodeURIComponent(ticker))
    .then(function (r) {
      if (r.status === 404) return { unavailable: true };
      return r.json().then(function (j) { return r.ok ? j : { error: (j && j.error) || "No news right now." }; });
    })
    .catch(function () { return { unavailable: true }; })
    .then(function (res) {
      if (res.error || res.unavailable) delete newsCache[ticker];   /* try again next time */
      return res;
    });
  return newsCache[ticker];
}

function fillNews(box, res) {
  if (!res || res.unavailable) {
    box.appendChild(el("p", "block-note first", "Headlines load on the live site; this copy has no server behind it."));
    return;
  }
  if (res.error) { box.appendChild(el("p", "block-note first", res.error)); return; }
  if (!res.items || !res.items.length) {
    box.appendChild(el("p", "block-note first", "Nothing in the last ten days."));
    return;
  }
  var ul = el("ul", "news-list");
  res.items.forEach(function (n) {
    var li = el("li", "");
    var a = el("a", "news-h", n.headline);
    a.href = n.url; a.target = "_blank"; a.rel = "noopener nofollow";
    li.appendChild(a);
    li.appendChild(el("span", "news-meta", [n.source, n.at ? relTime(n.at) : ""].filter(Boolean).join(" · ")));
    ul.appendChild(li);
  });
  box.appendChild(ul);
  box.appendChild(el("p", "block-note", "Headlines from Finnhub. Read past the headline before acting on one."));
}

/* ------------------------------------------------------- the sheet itself */

var detailTicker = null;

function section(title, node) {
  var s = el("section", "c-block");
  s.appendChild(el("h3", "block-h", title));
  s.appendChild(node);
  return s;
}

function openDetail(s) {
  if (!s) return;
  detailTicker = s.t;

  $("#detailTitle").textContent = s.t;
  $("#detailName").textContent = s.n + " · " + s.s;
  $("#detailPrice").textContent = price(s.price);
  var dir = !num(s.change) ? "flat" : s.change > 0.005 ? "up" : s.change < -0.005 ? "down" : "flat";
  var ch = $("#detailChange");
  ch.className = "delta small " + dir;
  ch.innerHTML = "";
  ch.appendChild(el("span", "arrow", dir === "up" ? "▲" : dir === "down" ? "▼" : "–"));
  ch.appendChild(el("span", "", num(s.change) ? pct(s.change, 2) : "—"));

  var body = $("#detailBody");
  body.innerHTML = "";
  body.appendChild(el("p", "block-note", "Loading the full record…"));

  openDialog($("#dlgDetail"));

  Promise.all([loadDeep(s.t), loadDetail(s.t)]).then(function (both) {
    if (detailTicker !== s.t) return;
    var deep = both[0], filing = both[1];
    body.innerHTML = "";

    /* --- the score, and what drove it --- */
    var scoreRes = scoreStock(s, state.scoreCtx);
    var scoreBox = el("div", "score-detail");
    var scoreHead = el("div", "score-head");
    scoreHead.appendChild(scoreRing(scoreRes, true));
    var blurb = el("div", "score-blurb");
    blurb.appendChild(el("p", "", !num(scoreRes.overall) ? "Not enough reported data to score this one."
      : (scoreRes.place
          ? "Ahead of " + scoreRes.overall + "% of the S&P 500 on the five factors below, weighted. "
          : "A weighted blend of the five factors below. ") +
        "It describes what the last filing and the current price look like. It is not a forecast, and it knows nothing about the business beyond these numbers."));
    scoreHead.appendChild(blurb);
    if (scoreRes.notes && scoreRes.notes.length) {
      var notes = el("ul", "score-notes");
      scoreRes.notes.forEach(function (n) { notes.appendChild(el("li", "", n)); });
      blurb.appendChild(notes);
    }
    scoreBox.appendChild(scoreHead);
    scoreBox.appendChild(factorBars(scoreRes));
    body.appendChild(section("Fundamentals score", scoreBox));
    body.appendChild(section("For and against", prosConsBlock(s)));

    var nextBox = buildNextReport(s, deep);
    if (nextBox) body.appendChild(section("Next report", nextBox));

    /* --- price chart with a range toggle --- */
    var points = insight.priceSeries(deep);
    var chartBox = el("div", "");
    if (!points) {
      chartBox.appendChild(el("p", "block-note first", "No price history recorded for this company yet."));
    } else {
      var ranges = el("div", "range-toggle");
      var chartSlot = el("div", "");
      var spanDays = (new Date(points[points.length - 1][0]) - new Date(points[0][0])) / 864e5;
      /* Only offer windows the data actually covers, then "All". */
      var windows = [{ label: "1M", months: 1 }, { label: "3M", months: 3 }, { label: "1Y", months: 12 }]
        .filter(function (r) { return spanDays > r.months * 30.5 * 1.15; })
        .concat([{ label: "All", months: 0 }]);
      var draw = function (months) {
        chartSlot.innerHTML = "";
        chartSlot.appendChild(buildChart(points, months));
        var shown = months ? points.filter(function (p) { return p[0] >= new Date(Date.now() - months * 30.5 * 864e5).toISOString().slice(0, 10); }) : points;
        var cs = insight.chartStats(shown);
        if (cs) {
          var csGrid = el("dl", "c-stats");
          if (num(cs.vsMa)) csGrid.appendChild(statRow("vs " + cs.maLabel + " avg", pct(cs.vsMa, 1), "Last close against the average of the last " + cs.maLabel + ". Above zero means the trend is up."));
          csGrid.appendChild(statRow("Worst fall", pct(cs.maxDrawdown, 0), "The biggest drop from a high to a later low in this window" + (cs.maxDrawdownAt ? ", bottoming " + dateShort(cs.maxDrawdownAt) : "") + "."));
          if (num(cs.volatility)) csGrid.appendChild(statRow("Volatility", pctPlain(cs.volatility, 0) + "/yr", "How widely daily returns swing, scaled to a year. The S&P 500 usually runs 15–20%."));
          chartSlot.appendChild(csGrid);
        }
      };
      if (windows.length > 1) {
        windows.forEach(function (r, i) {
          var b = el("button", "chip" + (i === windows.length - 1 ? " is-on" : ""), r.label);
          b.type = "button";
          b.addEventListener("click", function () {
            Array.prototype.forEach.call(ranges.children, function (x) { x.classList.remove("is-on"); });
            b.classList.add("is-on");
            draw(r.months);
          });
          ranges.appendChild(b);
        });
        chartBox.appendChild(ranges);
      }
      chartBox.appendChild(chartSlot);
      draw(0);
      if (!(deep && deep.chart && deep.chart.length >= 20)) {
        chartBox.appendChild(el("p", "block-note", "Closing prices recorded here each trading day since " + dateShort(points[0][0]) + "."));
      }
    }
    body.appendChild(section("Price", chartBox));

    body.appendChild(section("The financials, five years deep", buildHistory(deep)));

    var vsFull = sectorBlock(s);
    var peers = insight.nearestPeers(s, state.sectors, 5);
    if (vsFull || peers.length) {
      var vsBox = el("div", "");
      if (vsFull) {
        vsBox.appendChild(el("p", "block-note first", "Against the " + vsFull.view.count + " " + vsFull.view.sector +
          " companies in the index (a company with two share classes counts once). Half of each factor in the score is already a rank within the sector; these are the raw figures behind it, beside the sector median."));
        vsBox.appendChild(vsFull.node);
      }
      if (peers.length) vsBox.appendChild(buildPeers(s, peers));
      body.appendChild(section("Against its sector", vsBox));
    }

    body.appendChild(section("What analysts say", buildAnalyst(deep)));

    var newsBox = el("div", "");
    newsBox.appendChild(el("p", "block-note first", "Loading headlines…"));
    body.appendChild(section("In the news", newsBox));
    loadNews(s.t).then(function (res) {
      if (detailTicker !== s.t) return;
      newsBox.innerHTML = "";
      fillNews(newsBox, res);
    });

    /* --- the filing in full --- */
    var fbox = el("div", "");
    if (filing && filing.business) {
      fbox.appendChild(el("h4", "sub-h", "What the company says it does"));
      fbox.appendChild(el("p", "filing-text", filing.business));
    }
    if (filing && filing.risks && filing.risks.length) {
      fbox.appendChild(el("h4", "sub-h", "Risk factors it lists (" + filing.risks.length + ")"));
      var ul = el("ul", "risk-list");
      filing.risks.forEach(function (r) { ul.appendChild(el("li", "", r)); });
      fbox.appendChild(ul);
    }
    if (!filing || (!filing.business && !(filing.risks || []).length)) {
      fbox.appendChild(el("p", "block-note", "This filing could not be read automatically. The original is linked below."));
    }
    var links = el("div", "filing-links");
    [
      s.sec && s.sec.tenK && { href: s.sec.tenK.url, text: "Read the 10-K (" + dateShort(s.sec.tenK.date) + ")" },
      s.sec && s.sec.tenQ && { href: s.sec.tenQ.url, text: "Latest 10-Q (" + dateShort(s.sec.tenQ.date) + ")" },
      { href: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=" + (s.cik || s.t) + "&type=10-K&dateb=&owner=include&count=40",
        text: "All filings on EDGAR" }
    ].filter(Boolean).forEach(function (l) {
      if (!l.href) return;
      var a = el("a", "filing-link", l.text);
      a.href = l.href; a.target = "_blank"; a.rel = "noopener";
      links.appendChild(a);
    });
    fbox.appendChild(links);
    body.appendChild(section("The filing", fbox));

    if (deep && deep.updated) {
      body.appendChild(el("p", "block-note", "Deep data refreshed " + relTime(deep.updated) + "."));
    }
    body.scrollTop = 0;
  });
}

/* ============================================================ COMPARE ===
   Up to three companies side by side: the score and its five factors, the
   answers to the five checks, and the figures people compare most. The pick
   is kept in this browser; the first time, it starts from the cart. */

var CMP_KEY = "ts.compare";
var CMP_MAX = 3;
var CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
var cmpPicks = null;

function comparePicks() {
  if (cmpPicks) return cmpPicks;
  var saved = load(CMP_KEY, null);
  cmpPicks = Array.isArray(saved)
    ? saved.filter(function (t) { return typeof t === "string"; }).slice(0, CMP_MAX)
    : state.cart.slice(0, CMP_MAX).map(function (i) { return i.t; });
  return cmpPicks;
}

function setPicks(list) {
  cmpPicks = list.slice(0, CMP_MAX);
  save(CMP_KEY, cmpPicks);
  $("#cmpMsg").textContent = "";
  renderCompare();
}

function addPick(t) {
  var picks = comparePicks();
  if (picks.indexOf(t) >= 0) return;
  if (picks.length >= CMP_MAX) { $("#cmpMsg").textContent = "Three at a time. Take one out to add " + t + "."; return; }
  /* the same allowance as the deck: a company opened here counts as opened */
  if (!tier.withinAllowance(state.viewed, t, state.tier)) {
    $("#cmpMsg").textContent = "That is past the companies your plan can open." +
      (state.tier === "anon" ? " Sign in for more." : "");
    return;
  }
  tier.recordViewed(state.viewed, t);
  renderAllowance();
  setPicks(picks.concat([t]));
}

/* Tickers that start with what was typed come first, then names that hold it. */
function findCompanies(q) {
  q = q.trim().toUpperCase();
  if (!q) return [];
  var starts = [], within = [];
  state.all.forEach(function (s) {
    if (s.t.indexOf(q) === 0) starts.push(s);
    else if (q.length >= 2 && String(s.n || "").toUpperCase().indexOf(q) >= 0) within.push(s);
  });
  starts.sort(function (a, b) { return a.t.length - b.t.length || (a.t < b.t ? -1 : 1); });
  return starts.concat(within).slice(0, 6);
}

function renderHits() {
  var input = $("#cmpInput"), box = $("#cmpHits");
  var picks = comparePicks();
  var hits = findCompanies(input.value);
  box.innerHTML = "";
  hits.forEach(function (s) {
    var b = el("button", "search-hit");
    b.type = "button";
    b.appendChild(el("b", "", s.t));
    b.appendChild(el("span", "", picks.indexOf(s.t) >= 0 ? s.n + " · already here" : s.n));
    b.addEventListener("click", function (ev) { pickHit(s.t, ev.detail === 0); });
    box.appendChild(b);
  });
  box.hidden = !hits.length;
}

function pickHit(t, byKeyboard) {
  var input = $("#cmpInput");
  input.value = "";
  renderHits();
  addPick(t);
  if (byKeyboard && !$(".cmp-find").hidden) input.focus();
}

function renderPicks(list) {
  var box = $("#cmpPicks");
  box.innerHTML = "";
  list.forEach(function (s) {
    var chip = el("span", "cmp-pick");
    chip.appendChild(el("span", "", s.t));
    var out = el("button", "icon-btn small");
    out.type = "button";
    out.innerHTML = CLOSE_ICON;
    out.setAttribute("aria-label", "Take " + s.t + " out of the comparison");
    out.addEventListener("click", function (ev) {
      setPicks(comparePicks().filter(function (t) { return t !== s.t; }));
      /* from the keyboard, on to the box that is back now there is room; a
         tap leaves the phone's keyboard down */
      if (ev.detail === 0) $("#cmpInput").focus();
    });
    chip.appendChild(out);
    box.appendChild(chip);
  });

  /* three is the most a phone can show side by side */
  var full = list.length >= CMP_MAX;
  $(".cmp-find").hidden = full;
  $("#cmpFull").hidden = !full;

  /* what is in the cart and not here yet, one tap each */
  var sug = $("#cmpSuggest");
  sug.innerHTML = "";
  var here = list.map(function (s) { return s.t; });
  var left = state.cart.map(function (i) { return i.t; })
    .filter(function (t) { return here.indexOf(t) < 0 && state.byTicker[t]; }).slice(0, 8);
  sug.hidden = full || !left.length;
  if (sug.hidden) return;
  sug.appendChild(el("span", "cmp-suggest-l", "From your cart"));
  left.forEach(function (t) {
    var b = el("button", "chip", t);
    b.type = "button";
    b.setAttribute("aria-label", "Add " + t + " to the comparison");
    b.addEventListener("click", function () { addPick(t); });
    sug.appendChild(b);
  });
}

function renderCompare() {
  var body = $("#cmpBody");
  body.innerHTML = "";
  if (!state.all.length) {
    renderPicks([]);
    body.appendChild(el("p", "block-note", "Loading the S&P 500…"));
    return;
  }
  var list = comparePicks().map(function (t) { return state.byTicker[t]; }).filter(Boolean);
  /* a company that has left the index since it was picked no longer holds a place */
  if (list.length < comparePicks().length) {
    cmpPicks = list.map(function (s) { return s.t; });
    save(CMP_KEY, cmpPicks);
  }
  renderPicks(list);
  if (!list.length) {
    body.appendChild(el("p", "empty-note", state.cart.length
      ? "Pick two or three companies from your cart, or type a ticker or a name."
      : "Type a ticker or a name to start. Companies you add to your cart from the deck show up here too, one tap each."));
    return;
  }

  var cols = list.map(function (s) {
    var res = scoreStock(s, state.scoreCtx);
    return { s: s, res: res, checks: insight.financialChecks(s, res) };
  });

  var table = el("table", "cmp-table");
  table.appendChild(el("caption", "sr-only", "Side by side: " + list.map(function (s) { return s.t; }).join(", ")));
  var head = el("thead");
  var hr = el("tr");
  hr.appendChild(el("td", "cmp-corner"));
  cols.forEach(function (c) {
    var th = el("th");
    th.scope = "col";
    var b = el("button", "cmp-ticker", c.s.t);
    b.type = "button";
    b.title = "Open the full record";
    b.addEventListener("click", function () { openDetail(c.s); });
    th.appendChild(b);
    th.appendChild(el("span", "cmp-name", c.s.n));
    hr.appendChild(th);
  });
  head.appendChild(hr);
  table.appendChild(head);

  var tbody = el("tbody");
  function section(title) {
    var tr = el("tr", "cmp-sec");
    var th = el("th", "", title);
    th.scope = "colgroup";
    th.colSpan = cols.length + 1;
    tr.appendChild(th);
    tbody.appendChild(tr);
  }
  /* cells: one per company, each a string or a node; best: the cells to mark */
  function row(label, cells, best, hint) {
    var tr = el("tr");
    var th = el("th", "", label);
    th.scope = "row";
    if (hint) th.title = hint;
    tr.appendChild(th);
    cells.forEach(function (c, i) {
      var td = el("td", best && best[i] ? "is-top" : "");
      if (c && c.nodeType) td.appendChild(c); else td.textContent = c;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  /* the highest of two or more, unless they all tie */
  function highest(vals) {
    if (vals.length < 2) return null;
    var nums = vals.filter(num);
    if (nums.length < 2) return null;
    var top = Math.max.apply(null, nums), low = Math.min.apply(null, nums);
    if (top === low) return null;
    return vals.map(function (v) { return v === top; });
  }
  function meter(v) {
    var wrap = el("span");
    wrap.appendChild(el("span", "", num(v) ? String(Math.round(v)) : "n/a"));
    var m = el("span", "cmp-meter");
    var fill = el("i");
    fill.style.width = num(v) ? clamp(v, 0, 100) + "%" : "0";
    m.appendChild(fill);
    wrap.appendChild(m);
    return wrap;
  }

  section("Score");
  var overall = cols.map(function (c) { return c.res.overall; });
  row("Score", cols.map(function (c) {
    var box = el("span");
    box.appendChild(el("b", "cmp-big", num(c.res.overall) ? String(c.res.overall) : "—"));
    box.appendChild(el("span", "cmp-sub", scoreLabel(c.res.overall).word));
    return box;
  }), highest(overall), "Its place in the S&P 500, 1 to 99: better than that share of the index.");
  row("In its sector", cols.map(function (c) {
    /* "#2 of 73", and the sector under it in small type */
    var m = (sectorRankText(c.res.place) || "").match(/^(#\d+ of \d+) in (.+)$/);
    if (!m) return "—";
    var box = el("span");
    box.appendChild(el("span", "", m[1]));
    box.appendChild(el("span", "cmp-sub", m[2]));
    return box;
  }));
  FACTORS.forEach(function (f) {
    var vals = cols.map(function (c) { return c.res.factors[f.id]; });
    row(f.label, vals.map(meter), highest(vals.map(function (v) { return num(v) ? Math.round(v) : null; })), f.blurb);
  });

  section("The five checks");
  var titles = [];
  cols.forEach(function (c) { c.checks.forEach(function (g) { if (titles.indexOf(g.title) < 0) titles.push(g.title); }); });
  titles.forEach(function (title) {
    var question = "";
    row(title, cols.map(function (c) {
      var g = c.checks.filter(function (k) { return k.title === title; })[0];
      if (g && g.question) question = g.question;
      if (!g || !g.answer) return "—";
      var a = el("span", "check-a is-" + g.answer.tone, g.answer.text);
      if (g.note) a.title = g.note;
      return a;
    }), null, question);
  });

  section("The figures");
  row("Price", cols.map(function (c) { return price(c.s.price); }));
  row("Today", cols.map(function (c) {
    var v = c.s.change;
    var dir = !num(v) ? "flat" : v > 0.005 ? "up" : v < -0.005 ? "down" : "flat";
    return el("span", "delta small " + dir, num(v) ? pct(v, 2) : "—");
  }));
  row("Past year", cols.map(function (c) { return pct(c.s.r52, 0); }), null, "The share price over the last 52 weeks, without dividends.");
  row("Market cap", cols.map(function (c) { return cap(c.s.mc); }));
  row("P/E", cols.map(function (c) { return num(c.s.pe) && c.s.pe > 0 ? x(c.s.pe) : "n/a"; }), null,
    "Price over the last twelve months' earnings per share. None for a company losing money.");
  row("Net margin", cols.map(function (c) { return pctPlain(c.s.nm); }));
  row("Dividend yield", cols.map(function (c) { return num(c.s.dy) && c.s.dy > 0 ? pctPlain(c.s.dy, 2) : "None"; }));
  row("Next earnings", cols.map(function (c) {
    var e = c.s.earnings;
    return e && e.date && daysUntil(e.date) >= 0 ? dateShort(e.date).replace(/, \d{4}$/, "") : "—";
  }));

  table.appendChild(tbody);
  body.appendChild(table);
}

/* ======================================================= TRACK RECORD ===
   The weekly groups scripts/track.mjs follows, newest first, as on the
   /track page. Fetched the first time the tab is shown. */

var MEANINGFUL_DAYS = 60;       /* about three months of sessions, as on /track */
var trackLoad = null;

function showTrack() {
  if (trackLoad) return;
  trackLoad = fetch("data/track.json", { cache: "no-cache" })
    .then(function (r) {
      if (r.status === 404) return null;            /* not started yet */
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    })
    .then(renderTrack, function () {
      trackLoad = null;                            /* asked again next time */
      var body = $("#trackBody");
      body.innerHTML = "";
      body.appendChild(el("p", "block-note", "The track record did not load. Check the connection, then open this tab again."));
    });
}

function renderTrack(track) {
  var body = $("#trackBody");
  body.innerHTML = "";
  var groups = (track && Array.isArray(track.groups) ? track.groups : []).slice().reverse();
  $("#trackNote").textContent = track && track.started ? "Since " + dateShort(track.started) : "";
  if (!groups.length) {
    body.appendChild(el("p", "empty-note", "The first group is picked on the first nightly run. Come back in a week."));
    return;
  }
  var table = el("table", "doc-table list track-table");
  var head = el("thead");
  var hr = el("tr");
  [["Picked", ""], ["Top fifth", "num"], ["Bottom fifth", "num"], ["All 500", "num"], ["Top vs all", "num"]].forEach(function (h) {
    var th = el("th", h[1], h[0]);
    th.scope = "col";
    hr.appendChild(th);
  });
  head.appendChild(hr);
  table.appendChild(head);
  var tbody = el("tbody");
  function cell(v, tone) {
    var td = el("td", "num");
    var ok = num(v);
    var dir = !ok ? "flat" : v > 1.0005 ? "up" : v < 0.9995 ? "down" : "flat";
    td.appendChild(el("span", tone ? "delta " + dir : "", ok ? pct((v - 1) * 100, 1) : "—"));
    return td;
  }
  var longest = 0;
  groups.forEach(function (g) {
    longest = Math.max(longest, g.days || 0);
    var tr = el("tr");
    var th = el("th", "", dateShort(g.start));
    th.scope = "row";
    th.appendChild(el("span", "track-days", g.days + (g.days === 1 ? " session" : " sessions")));
    tr.appendChild(th);
    tr.appendChild(cell(g.top, true));
    tr.appendChild(cell(g.bottom, true));
    tr.appendChild(cell(g.index, false));
    tr.appendChild(cell(num(g.top) && g.index > 0 ? g.top / g.index : null, true));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  var wrap = el("div", "table-scroll");
  wrap.appendChild(table);
  body.appendChild(wrap);
  if (longest < MEANINGFUL_DAYS) {
    body.appendChild(el("p", "block-note", "The oldest group has been followed for " + longest + " trading " +
      (longest === 1 ? "session" : "sessions") + ". Over weeks, prices move for reasons no score can see; read nothing into this until it has run for months."));
  }
}

/* ============================================================== CHROME === */

function openDialog(dlg) { if (!dlg.open) dlg.showModal(); }
function closeDialog(dlg) { if (dlg.open) dlg.close(); }

/* --------------------------------------------------------------- tabs ---
   Five tabs, one shown at a time. The address carries the tab (#cart,
   #compare…), so Back steps between them and a shared link opens the same
   one; the deck is the address with no hash. Anything else after a # (a
   sign-in link's tokens) is not a tab, and is left alone for auth to read. */

var VIEWS = { deck: "#deck", compare: "#viewCompare", cart: "#viewCart", track: "#viewTrack", account: "#viewAccount" };
var view = "deck";

function viewInUrl() {
  var h = location.hash.slice(1);
  return Object.prototype.hasOwnProperty.call(VIEWS, h) ? h : "deck";
}

function showView(name, focus) {
  if (!VIEWS[name]) name = "deck";
  var changed = name !== view;
  view = name;
  Object.keys(VIEWS).forEach(function (k) { $(VIEWS[k]).hidden = k !== name; });
  Array.prototype.forEach.call(document.querySelectorAll("#tabbar [data-view]"), function (a) {
    if (a.getAttribute("data-view") === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (name === "cart") showCart();
  else if (name === "account") showAccount();
  else if (name === "compare") renderCompare();
  else if (name === "track") showTrack();
  else deckShown();
  if (!changed) return;
  window.scrollTo(0, 0);
  /* chosen from the bar: start the reader at the tab's heading */
  var h = focus && $(VIEWS[name] + " h1");
  if (h) h.focus({ preventScroll: true });
}

function go(name) {
  if (name === view) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  if (!auth.isAuthCallback()) {
    try { history.pushState(null, "", name === "deck" ? location.pathname + location.search : "#" + name); } catch (e) {}
  }
  showView(name, true);
}

/* Back on the deck: the top card was hidden while another tab showed, so its
   scroll fade is measured again. */
function deckShown() {
  var sc = cards[0] && $(".card-scroll", cards[0].node);
  if (sc) sc.dispatchEvent(new Event("scroll"));
}

/* "Prices at the Sep 22 close": the session the figures describe, which is
   what matters, rather than how long ago a job ran. */
function renderDataAge() {
  var text = !state.updated ? "No data yet"
    : state.session ? "Prices at the " + dateShort(state.session).replace(/, \d{4}$/, "") + " close"
    : "Updated " + relTime(state.updated);
  var title = state.updated ? "Snapshot built " + new Date(state.updated).toLocaleString() : "";
  ["#dataAge", "#footAge"].forEach(function (sel) {
    var n = $(sel);
    if (!n) return;
    n.textContent = text;
    n.title = title;
  });
}

function setupScreen(reason) {
  var repo = repoUrl();
  showMessage(
    "No data yet",
    reason === "missing"
      ? "The daily refresh hasn't run, so there is nothing to show. It needs a free " +
        "<a href='https://finnhub.io/register' target='_blank' rel='noopener'>Finnhub</a> API key " +
        "stored as the repository secret <code>FINNHUB_TOKEN</code>. Once that's set, run the " +
        "<b>Refresh market data</b> workflow and this page fills in."
      : "The snapshot exists but is empty. Check the workflow logs in the Actions tab.",
    [
      { label: "Open the Actions tab", onClick: function () { window.open(repo + "/actions", "_blank", "noopener"); } },
      { label: "Set up the key", kind: "link", onClick: function () {
          window.open(repo + "/settings/secrets/actions/new", "_blank", "noopener");
      } }
    ]
  );
}

function repoUrl() {
  var m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (!m) return "https://github.com";
  var seg = location.pathname.split("/").filter(Boolean)[0];
  return "https://github.com/" + m[1] + (seg ? "/" + seg : "/" + m[1] + ".github.io");
}

/* ================================================================ INIT === */

function wire() {

  window.addEventListener("storage", onStorage);

  Array.prototype.forEach.call(document.querySelectorAll("#tabbar [data-view]"), function (a) {
    a.addEventListener("click", function (ev) {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button) return;   /* a new browser tab */
      ev.preventDefault();
      go(a.getAttribute("data-view"));
    });
  });
  function followUrl() { var v = viewInUrl(); if (v !== view) showView(v); }
  window.addEventListener("popstate", followUrl);
  window.addEventListener("hashchange", followUrl);
  $("#acctAlerts").addEventListener("click", openEarnings);
  $("#cmpInput").addEventListener("input", renderHits);
  $("#cmpInput").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      var hit = findCompanies(ev.target.value)[0];
      if (hit) pickHit(hit.t, true);
    } else if (ev.key === "Escape" && ev.target.value) {
      ev.preventDefault();
      ev.target.value = "";
      renderHits();
    }
  });
  $("#acctBroker").addEventListener("click", openBroker);

  Array.prototype.forEach.call(document.querySelectorAll("[data-close]"), function (b) {
    b.addEventListener("click", function () { closeDialog(b.closest("dialog")); });
  });
  Array.prototype.forEach.call(document.querySelectorAll("dialog"), function (d) {
    d.addEventListener("click", function (ev) { if (ev.target === d) closeDialog(d); });
  });

  $("#btnExport").addEventListener("click", exportCsv);
  /* Two taps: the cart holds notes and amounts nothing else keeps. */
  var clearArmed = null;
  $("#btnClearCart").addEventListener("click", function () {
    var btn = $("#btnClearCart");
    if (!state.cart.length) return;
    if (!clearArmed) {
      btn.textContent = "Tap again to remove all " + state.cart.length;
      btn.classList.add("is-armed");
      clearArmed = setTimeout(function () {
        clearArmed = null; btn.textContent = "Empty the cart"; btn.classList.remove("is-armed");
      }, 4000);
      return;
    }
    clearTimeout(clearArmed); clearArmed = null;
    btn.textContent = "Empty the cart"; btn.classList.remove("is-armed");
    state.cart.map(function (i) { return i.t; }).forEach(removeFromCart);
    persistCart();
    renderCart(); renderCartCount(); renderEarnNotice();
  });

  /* ---- orders ---- */
  $("#obSplit").addEventListener("submit", function (e) {
    e.preventDefault();
    splitEvenly(parseFloat($("#obSplitAmt").value));
  });
  $("#btnReview").addEventListener("click", function () {
    if (state.broker && state.broker.connected) openReview(); else openBroker();
  });
  $("#orderType").addEventListener("click", function (e) {
    var chip = e.target.closest("[data-type]");
    if (chip) setOrderType(chip.getAttribute("data-type"));
  });
  $("#orderLiveCheck").addEventListener("change", renderReview);
  $("#btnPlace").addEventListener("click", placeOrders);
  $("#dlgOrders").addEventListener("close", function () { if (view === "cart") renderCart(); });

  /* ---- brokerage ---- */
  $("#brokerEnv").addEventListener("change", function () { $("#brokerOauth").href = broker.oauthUrl(pickedEnv()); });
  $("#brokerKeys").addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = $("#brokerKeysGo");
    btn.disabled = true; btn.textContent = "Checking with Alpaca…";
    brokerError("");
    broker.connect($("#brokerKeyId").value.trim(), $("#brokerSecret").value.trim(), pickedEnv()).then(function (r) {
      btn.disabled = false; btn.textContent = "Connect";
      if (!r.ok) { brokerError(r.error); return; }
      $("#brokerKeyId").value = ""; $("#brokerSecret").value = "";
      state.broker = r.data;
      renderAccount(); renderBrokerPanel(); renderOrderBar();
      loadPortfolio();
    });
  });
  $("#brokerDisconnect").addEventListener("click", function () {
    broker.disconnect().then(function (r) {
      if (r.ok) state.broker = r.data;
      portfolio = null;
      renderAccount(); renderBrokerPanel(); renderOrderBar();
      if (view === "cart") renderCart();
    });
  });
  $("#brokerRefresh").addEventListener("click", function () { brokerError(""); refreshBroker().then(loadPortfolio); });

  /* ---- earnings ---- */
  $("#btnEarnings").addEventListener("click", openEarnings);
  $("#earnNoticeOpen").addEventListener("click", openEarnings);
  $("#earnNoticeClose").addEventListener("click", function () {
    try { localStorage.setItem(NOTICE_KEY, $("#earnNotice").dataset.sig || ""); } catch (e) {}
    $("#earnNotice").hidden = true;
  });
  $("#btnIcs").addEventListener("click", cartIcs);
  $("#earnEmail").addEventListener("change", function () {
    var box = $("#earnEmail");
    var want = box.checked;
    box.disabled = true;
    auth.saveAlertPrefs({ email: want, days_before: earn.ALERT_DAYS }).then(function (r) {
      box.disabled = false;
      if (!r.ok) { box.checked = !want; $("#earnEmailNote").textContent = r.error; return; }
      renderEmailToggle();
    });
  });


  /* The sheet can be showing a company other than the top card (a peer link
     leads there), so the buttons act on whatever the sheet shows. Only the
     top card is swiped away; any other is added or passed on and taken out
     of the rest of the deck. */
  function detailAct(action) {
    var t = detailTicker;
    closeDialog($("#dlgDetail"));
    if (!t) return;
    if (cards[0] && cards[0].ticker === t) { commit(action); return; }
    if (action === "add") addToCart(state.byTicker[t]);
    markSeen(t);
    var ahead = state.deck.slice(state.cursor + 1);
    if (ahead.indexOf(t) >= 0) {
      state.deck = state.deck.slice(0, state.cursor + 1).concat(ahead.filter(function (x) { return x !== t; }));
      renderDeck();
    }
  }
  $("#detailAdd").addEventListener("click", function () { detailAct("add"); });
  $("#btnKeep").addEventListener("click", function () { commit("add"); });
  $("#btnPass").addEventListener("click", function () { commit("pass"); });
  $("#btnUndo").addEventListener("click", undo);
  $("#detailSkip").addEventListener("click", function () { detailAct("pass"); });

  document.addEventListener("keydown", function (ev) {
    /* Shortcuts only when nothing else wants the key: not while typing, not
       on a focused button or link (Enter should press that), and never with
       a modifier (Ctrl+D is the browser's bookmark). */
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (view !== "deck") return;
    var t = ev.target;
    if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    if (ev.key === "Enter" || ev.key === "d") {
      if (t.closest && t.closest("a, button, summary")) return;
      var top = cards[0];
      if (top) { ev.preventDefault(); openDetail(state.byTicker[top.ticker]); }
      return;
    }
    if (ev.key === "ArrowRight") { ev.preventDefault(); commit("add"); }
    else if (ev.key === "ArrowLeft") { ev.preventDefault(); commit("pass"); }
    else if (ev.key === "z" || ev.key === "Z") { ev.preventDefault(); undo(); }
    else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      var sc = cards[0] && $(".card-scroll", cards[0].node);
      if (sc) { ev.preventDefault(); sc.scrollBy({ top: ev.key === "ArrowDown" ? 220 : -220, behavior: "smooth" }); }
    }
  });

}

/* ============================================================== AUTH ===== */

function authError(msg) {
  var box = $("#authError");
  box.hidden = !msg;
  box.textContent = msg || "";
}

function showAuthStep(which) {
  ["authPendingStep", "authEmailStep", "authCodeStep", "authSignedIn"].forEach(function (id) {
    $("#" + id).hidden = id !== which;
  });
  authError("");
}

/* The account tab: who is signed in, or the way to sign in. Three states, not
   two. The sign-in library loads on demand, so for the first moment of every
   page load we do not yet know who you are. Offering a sign-in form during
   that gap tells an already-signed-in person they have been thrown out. */
function renderAccountTab() {
  var on = auth.isConfigured();
  $("#authBox").hidden = !on;
  $("#authOff").hidden = on;
  $("#acctPlan").textContent = tier.DEV_UNLIMITED ? "Not taking payment yet, so everything is open"
    : tier.TIER_LABEL[state.tier] + (state.tier === "member" ? "" : " · see what membership adds");
  if (!on) return;
  $("#authTitle").textContent = state.user ? "Signed in" : "Keep your cart";
  if (state.user) {
    $("#authWho").textContent = state.user.email || "your account";
    if ($("#authSignedIn").hidden) showAuthStep("authSignedIn");
  } else if (state.authPending) {
    showAuthStep("authPendingStep");
  } else if (!$("#authSignedIn").hidden || !$("#authPendingStep").hidden) {
    /* only a panel still saying "signed in" or "checking" needs to change;
       resetting any other step would wipe a message or a half-typed code */
    showAuthStep("authEmailStep");
  }
}

var startAuth = function () {};   /* set by wireAuth */

/* The tab loads the sign-in library the first time it is shown. */
function showAccount() {
  startAuth();
  renderAccountTab();
}

function openAuth() { go("account"); }

/* One place decides the tier, and every path that could change it calls here.
   Re-rendering afterwards matters: someone who pays in another tab should see
   the wall lift without reloading. */
function refreshTier() {
  var before = state.tier;
  if (!state.user) {
    state.tier = "anon";
    if (before !== state.tier) { renderDeck(); renderCartCount(); renderAccountTab(); }
    return;
  }
  auth.getClient().then(function (client) {
    return tier.tierFor(client, state.user);
  }).then(function (t) {
    state.tier = t || "free";
    if (state.tier !== before) { renderDeck(); renderCartCount(); renderAccountTab(); }
    else renderAllowance();
  });
}

function wireAuth() {
  if (!auth.isConfigured()) return;

  var pending = "";
  /* a sign-in that happens on this page load (a link or a code), as opposed
     to a session restored from storage */
  var fresh = auth.isAuthCallback();
  var fromLink = fresh;
  var linkError = auth.callbackError();
  var whoShown = false;

  /* A link signed this browser in, but nobody asked for one here: say whose
     account it is, so a link someone sent for their own account cannot
     quietly collect what you add to the cart. */
  function sayWho(user) {
    if (whoShown || !fromLink || !user || auth.linkWasAsked(user.email)) return;
    whoShown = true;
    showToast("Signed in as " + (user.email || "an account you did not ask for") + ". Not you?",
      "Sign out", function () { signOutAndForget().then(function () { renderAccountTab(); }); }, 20000);
  }

  $("#authEmailStep").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = $("#authEmail").value.trim();
    if (!email) return;
    var btn = $("#authSend");
    btn.disabled = true; btn.textContent = "Sending…";
    auth.sendCode(email).then(function (r) {
      btn.disabled = false; btn.textContent = "Email me a sign-in link";
      if (!r.ok) return authError(r.error);
      pending = email;
      $("#authSentTo").textContent = email;
      showAuthStep("authCodeStep");
      $("#authCode").focus();
    });
  });

  $("#authCodeStep").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = $("#authCode").value.replace(/\D/g, "");
    if (code.length !== 6) return authError("Paste the six-digit code, or just click the link in the email instead.");
    var btn = $("#authVerify");
    btn.disabled = true; btn.textContent = "Signing in…";
    fresh = true;
    auth.verifyCode(pending, code).then(function (r) {
      btn.disabled = false; btn.textContent = "Sign in with the code";
      if (!r.ok) return authError(r.error);
      $("#authCode").value = "";
    });
  });

  $("#authBack").addEventListener("click", function () {
    $("#authCode").value = "";
    showAuthStep("authEmailStep");
  });

  $("#authSignOut").addEventListener("click", function () {
    var btn = $("#authSignOut");
    btn.disabled = true; btn.textContent = "Saving and signing out…";
    signOutAndForget().then(function (done) {
      btn.disabled = false; btn.textContent = "Sign out";
      if (done) renderAccountTab();
    });
  });

  /* The sign-in library is only loaded for someone who is signed in, is
     arriving from a sign-in link, or opens the account tab (or signs in
     from another tab). Everyone else never downloads it. */
  var started = false;
  startAuth = function () {
    if (started) return;
    started = true;
    listen();
  };
  if (auth.hasStoredSession() || auth.isAuthCallback() || linkError) startAuth();
  window.addEventListener("storage", function (e) {
    if (e.key && e.key.indexOf("sb-") === 0 && e.newValue) startAuth();
  });

  window.addEventListener("online", function () { if (state.user) syncCart(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && ownerAsk && state.user === ownerAsk.user) ensureCartOwner(ownerAsk.user, ownerAsk.fresh);
    /* leaving the page: send anything still waiting on the debounce */
    if (document.visibilityState === "hidden" && sync.timer) syncCart();
  });

  function listen() {
    /* One place decides what being signed in means, so a session restored on
       page load and a fresh sign-in take exactly the same path. */
    auth.onAuthChange(function (user) {
      var same = user && state.user && state.user.id === user.id;
      state.user = user;
      state.authPending = false;
      renderAccountTab();
      setSyncNote("saved");
      refreshTier();
      if (user) {
        auth.tidyUrl();
        /* token refreshes arrive here too; only a new person needs the check */
        if (!same) { ensureCartOwner(user, fresh); sayWho(user); }
      }
    });

    auth.currentUser().then(function (user) {
      var same = user && state.user && state.user.id === user.id;
      state.authPending = false;
      state.user = user;
      refreshTier();
      renderAccountTab();
      auth.tidyUrl();
      if (user && !same) { ensureCartOwner(user, fresh); sayWho(user); }
      if (!user && linkError) {
        openAuth();
        showAuthStep("authEmailStep");
        authError(linkError);
      }
    });
  }
}

function init() {
  state.viewed = tier.loadViewed();
  wire();
  /* Installable as an app, and able to open with no signal on the last data
     it saw (sw.js, network first). Over https, and on localhost for development. */
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  }
  /* Decided synchronously, before any network call: either a session is already
     in storage or this page load is the return leg of a sign-in link. Either
     way somebody is signed in, and the account tab should not claim otherwise. */
  state.authPending = auth.isConfigured() && (auth.hasStoredSession() || auth.isAuthCallback());
  wireAuth();
  renderAccountTab();
  renderCartCount();
  showView(viewInUrl());
  showMessage("Loading the S&P 500…", "Pulling the latest snapshot.", []);

  loadSnapshot()
    .catch(function (err) {
      /* only data problems land on the setup screen — a render bug should throw */
      console.warn("snapshot:", err);
      renderDataAge();
      setupScreen(err && err.message === "missing" ? "missing" : "empty");
      return null;
    })
    .then(function (snap) {
      if (!snap) return;
      renderDataAge();
      setInterval(renderDataAge, 60000);
      buildDeck();

      /* a company page links in with ?t=TICKER — start the deck on that one */
      var want = new URLSearchParams(location.search).get("t");
      if (want && state.byTicker[want.toUpperCase()]) {
        var wt = want.toUpperCase();
        state.deck = [wt].concat(state.deck.filter(function (t) { return t !== wt; }));
        state.cursor = 0;
      }

      renderDeck();
      renderEarnNotice();
      /* a tab opened before the prices arrived is drawn again with them */
      if (view === "cart") renderCart();
      else if (view === "compare") renderCompare();
      brokerReturn();

      /* "Turn them off" in an alert email lands here: open the alert settings
         straight away (signing in first, if need be, is part of that dialog) */
      if (new URLSearchParams(location.search).get("alerts") === "off") {
        history.replaceState(null, "", location.pathname);
        openEarnings();
      }
    });
}

/* The last leg of "Connect with Alpaca" lands here with ?broker=<outcome>. */
function brokerReturn() {
  var params = new URLSearchParams(location.search);
  var outcome = params.get("broker");
  if (!outcome) return;
  params.delete("broker");
  try { history.replaceState({}, document.title, location.pathname + (params.toString() ? "?" + params : "")); } catch (e) {}
  var said = {
    connected: "",
    declined: "The connection was cancelled on Alpaca's side. Nothing was changed.",
    expired: "That sign-in took too long or was opened in another browser. Start it again from here.",
    failed: "Alpaca did not complete the connection. Try again, or paste API keys instead.",
    unavailable: "Connecting with an Alpaca sign-in is not set up on this site. Paste API keys instead."
  };
  openBroker();
  if (said[outcome]) brokerError(said[outcome]);
}

init();

