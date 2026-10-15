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

   Beside the companies sit the exchange-traded funds of data/etfs.json, in
   a deck of their own behind a Stocks | ETFs switch. A fund is read by
   lib/funds.mjs on its own fixed scale, never placed among the companies,
   and the switch stays hidden until the nightly job has written the file.

   The iPhone app runs this same file from its own copy of the site, with
   <html data-app>. What differs there (live data from stockornot.com, the
   share sheet, haptics, reminders, no brokerage) goes through lib/native.mjs,
   and on the website each of those calls does what the page did before.
   ========================================================================== */
import {
  num, clamp, money, cap, price, pct, pctPlain, signedNum, x, dateShort, rangePos, rangeSummary,
  FACTORS, scoreStock, scoreLabel, sectorRankText, prosAndCons, buildScoreContext, inputs, valuation,
  STYLES, DEFAULT_STYLE, styleById, styleFactors
} from "./lib/analysis.mjs";
import * as auth from "./lib/auth.mjs";
import * as tier from "./lib/tier.mjs";
import * as insight from "./lib/insight.mjs";
import * as broker from "./lib/broker.mjs";
import * as earn from "./lib/earnings.mjs";
import * as cartLib from "./lib/cart.mjs";
import { CHECK_ICONS } from "./lib/icons.mjs";
import * as native from "./lib/native.mjs";
import * as funds from "./lib/funds.mjs";

/* ---------------------------------------------------------------- storage */

var LS = { cart: "ts.cart", seen: "ts.seen", owner: "ts.cartOwner", style: "ts.style",
           kind: "ts.deckKind", cmpKind: "ts.compareKind" };

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
  funds:   [],            /* every fund from data/etfs.json, when there is one */
  fundsUpdated: null,     /* when the nightly job wrote that file */
  fundsSession: null,     /* the trading day its prices are from */
  kind:    load(LS.kind, "stocks") === "etfs" ? "etfs" : "stocks",   /* the deck: companies or funds */
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
  history: [],            /* recent swipes, newest last: { t, action, added: addedAt of the cart record the swipe made, or null } */
  sectors: null,          /* per-sector sorted metrics, built once per snapshot */
  scoreCtx: null,         /* the same, for the score's sector half */
  broker:  null,          /* last /api/broker status; null until asked */
  style:   styleById(load(LS.style, DEFAULT_STYLE)).id,   /* the scoring style chosen, kept in this browser */
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
   this one is only meaningful in a live page. Days until a report come from
   earn.daysUntil, so the card, the cart and the notice count alike. */

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
  function read(r) {
    if (r.status === 404) throw new Error("missing");
    if (!r.ok) throw new Error("http " + r.status);
    return r.json().then(function (snap) {
      if (!snap || !Array.isArray(snap.stocks) || !snap.stocks.length) throw new Error("empty");
      return snap;
    });
  }
  return native.dataFetch("data/snapshot.json", { cache: "no-cache" })
    .then(read)
    .then(function (snap) {
      state.snapshotFromApp = native.inApp && native.cameFromApp("data/snapshot.json");
      return snap;
    }, function (err) {
      /* In the app, a live file that arrived but cannot be read (cut short,
         or a format this build does not know) must not stop the app while
         the copy built into it is fine. */
      if (!native.inApp) throw err;
      return fetch("/data/snapshot.json").then(read).then(function (snap) {
        state.snapshotFromApp = true;
        return snap;
      });
    })
    .then(function (snap) {
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
  return native.dataFetch("data/filings/" + encodeURIComponent(safe) + ".json", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      var d = j && filingMatches(state.byTicker[ticker], j) ? j.detail || null : null;
      state.details[ticker] = d;
      return d;
    })
    .catch(function () { state.details[ticker] = null; return null; });
}

/* The funds, from data/etfs.json, which scripts/etfs.mjs writes each night.
   A file of its own beside the snapshot, so a build of the app from before
   funds never asks for it. Missing or unreadable, there are simply no funds:
   the Stocks | ETFs switch stays hidden and every screen is what it was
   without them. Always resolves, to the file or null.
   The app asks the website for it only when its own copy has funds to show
   (lib/funds.mjs loadFundsFile): a build that went to App Review without
   funds never shows them. */
function fetchFunds() {
  return funds.loadFundsFile({
    inApp: native.inApp,
    live: function () { return native.dataFetch("data/etfs.json", { cache: "no-cache" }); },
    bundled: function () { return fetch("/data/etfs.json"); }
  });
}

/* The deck waits for the funds, since a link to a fund opens on it and the
   switch may have been left on ETFs, but not for long. On the website, a
   file still out when the snapshot is in has until `by`, three seconds after
   it was asked for: slower than that, or never answering, and this visit
   goes on without funds rather than sit on "Loading". The app's own
   fetch has a deadline already (lib/native.mjs dataFetch), with the copy
   built into it to fall back on. Resolves to the file or null. */
var FUNDS_WAIT_MS = 3000;

function fundsInTime(file, by) {
  if (native.inApp) return file;
  return Promise.race([file, new Promise(function (done) { setTimeout(done, Math.max(0, by - Date.now()), null); })]);
}

/* Added after the companies, so a fund can never take a company's ticker
   (lib/funds.mjs mergeFunds), and only the funds whose holdings have been
   read, two at least (fundsToShow). */
function useFunds(file) {
  state.funds = file ? funds.mergeFunds(state.byTicker, funds.fundsToShow(file.etfs, state.byTicker)) : [];
  state.fundsUpdated = file && file.updated || null;
  state.fundsSession = file && typeof file.session === "string" ? file.session : null;
  renderKinds();
}

/* The trading day a fund's price and move are from: its own, when tonight's
   quote failed and yesterday's was kept, else the fund file's. */
function fundDay(f) {
  return (typeof f.stale === "string" && f.stale) || state.fundsSession || snapshotDay();
}
/* " on Oct 7" when that is older than the companies' prices, else "" */
function fundDayNote(f) {
  var day = fundDay(f), snap = snapshotDay();
  return day && snap && day < snap ? " " + sessionWord(day) : "";
}

/* Every fund's closing prices, one file for all of them, fetched the first
   time a fund's chart is wanted. */
var fundCloses = null;

function loadFundCloses() {
  if (fundCloses) return fundCloses;
  fundCloses = native.dataFetch("data/etf-closes.json", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { return j && j.closes && typeof j.closes === "object" ? j.closes : {}; })
    .catch(function () { fundCloses = null; return {}; });    /* asked again next time */
  return fundCloses;
}

/* The reading of a fund under the style chosen, kept per style until the
   companies change (lib/funds.mjs readFunds). */
function fundReading(f) {
  return funds.readFunds(state.funds, state.scoreCtx, state.style, state.all).get(f.t) ||
    funds.readFund(f, state.scoreCtx, state.style, { companies: state.all, funds: state.funds });
}

/* A cart row is a fund's when it was added as one, or when its ticker is a
   fund's now. */
function isFundItem(i) {
  return i.kind === "etf" || funds.isFund(state.byTicker[i.t]);
}

/* "3 companies and 2 ETFs", or with a separator, "3 companies · 2 ETFs".
   With only companies in it, the words are the ones used before funds. */
function cartWords(items, sep) {
  var nf = items.filter(isFundItem).length, nc = items.length - nf;
  var parts = [];
  if (nc || !nf) parts.push(nc + (nc === 1 ? " company" : " companies"));
  if (nf) parts.push(nf + (nf === 1 ? " ETF" : " ETFs"));
  return parts.join(sep || " and ");
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

/* Stocks or ETFs. Always the companies while there are no funds, whatever
   was chosen before. */
function deckKind() { return state.funds.length && state.kind === "etfs" ? "etfs" : "stocks"; }
function deckPool() { return deckKind() === "etfs" ? state.funds : state.all; }

function buildDeck() {
  /* The only rule left: a company you have already swiped does not come back
     until you ask for it. Everything else is in the deck, in random order.
     The funds come in order instead: those read in full first, then the
     rest, each largest first (lib/funds.mjs deckOrder). */
  var pool = deckPool().filter(function (s) {
    /* "the ones I passed on": the seen list holds adds too, so leave out
       what is in the cart */
    return state.showSeen ? !cartItem(s.t) : !seenSet.has(s.t);
  });
  state.deck = deckKind() === "etfs"
    ? funds.deckOrder(pool, funds.readFunds(state.funds, state.scoreCtx, state.style, state.all)).map(function (s) { return s.t; })
    : shuffle(pool.map(function (s) { return s.t; }));
  state.cursor = 0;
  state.history = [];
}

/* Starting a deck again forgets only that deck's swipes: going back through
   the funds does not bring back every company passed on. Without funds,
   everything, as before. */
function forgetSeen(pool) {
  var drop = new Set(pool.map(function (s) { return s.t; }));
  state.seen = state.funds.length ? state.seen.filter(function (t) { return !drop.has(t); }) : [];
  seenSet = new Set(state.seen);
  save(LS.seen, state.seen);
}

/* The Stocks | ETFs switches, on the deck and in Compare: shown only when
   there are funds, each on its own setting. Two toggle buttons, not a radio
   group: the arrow keys stay the deck's Pass and Add, and nothing on the
   switch promises otherwise. */
function setKindChips(box, kind) {
  Array.prototype.forEach.call(box.querySelectorAll("[data-kind]"), function (c) {
    var on = c.getAttribute("data-kind") === kind;
    c.classList.toggle("is-on", on);
    c.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function renderKinds() {
  var any = state.funds.length > 0;
  $("#kindSwitch").hidden = !any;
  $(".deck-wrap").classList.toggle("has-kinds", any);
  setKindChips($("#kindSwitch"), deckKind());
  $("#deck").setAttribute("aria-label", deckKind() === "etfs" ? "ETF deck" : "Company deck");
  $("#cmpKind").hidden = state.funds.length < 2;
  setKindChips($("#cmpKind"), compareKind());
}

/* Each deck as it was left, by kind, so going to the funds and back finds
   the companies where they were, in the same order and with Undo still able
   to take back their last swipes. A deck is built only the first time it is
   shown. */
var leftDecks = {};

function chooseKind(kind) {
  kind = kind === "etfs" ? "etfs" : "stocks";
  if (kind === deckKind() || state.busy) return;
  leftDecks[deckKind()] = { deck: state.deck, cursor: state.cursor, history: state.history, showSeen: state.showSeen };
  state.kind = kind;
  save(LS.kind, kind);
  var back = leftDecks[kind];
  if (back) {
    /* one passed on or added meanwhile from a record (a fund's holding, say)
       is taken out of the rest, as it is from the deck showing */
    state.deck = back.deck.slice(0, back.cursor).concat(back.deck.slice(back.cursor).filter(function (t) {
      return back.showSeen ? !cartItem(t) : !seenSet.has(t);
    }));
    state.cursor = back.cursor;
    state.history = back.history;
    state.showSeen = back.showSeen;
  } else {
    state.showSeen = false;
    buildDeck();
  }
  renderKinds();
  renderDeck();
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
    var etf = deckKind() === "etfs";
    var actions = [
      { label: "Go through them again", onClick: function () {
          forgetSeen(deckPool());
          state.showSeen = false;
          buildDeck(); renderDeck();
      } }
    ];
    /* only when one was passed on: with all of them in the cart it would
       deal an empty deck and this same message */
    if (deckPool().some(function (s) { return !cartItem(s.t); })) {
      actions.push({ label: "Show the ones I passed on", kind: "link", onClick: function () {
          state.showSeen = true;
          buildDeck(); renderDeck();
      } });
    }
    showMessage(
      etf ? "That is all " + state.funds.length + " funds" : "That is all " + state.all.length + " of them",
      etf ? "You have been through every fund we cover. Your cart is still there."
        : "You have been through the whole index. Your cart is still there.",
      actions
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
  var total = state.all.length + state.funds.length;   /* a fund counts as a company does */
  if (state.tier === "anon") {
    showMessage(
      "You have seen " + seen + " of " + total,
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
      "You have seen " + seen + " of " + total,
      "Membership opens the remaining <b>" + Math.max(0, total - seen) +
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
  /* any style but the standard one says so wherever its score shows */
  var st = styleById(res.style);
  if (st.id !== DEFAULT_STYLE) box.appendChild(el("span", "sr-style", st.short));
  box.title = !num(v) ? "Not enough reported data to score this one"
    : (res.place ? "Ahead of " + v + "% of the S&P 500 on its fundamentals" +
        (res.place.sector ? ", and " + sectorRankText(res.place, true) : "")
      : "Fundamentals score " + v + " out of 100, " + lab.word.toLowerCase()) +
      (st.id !== DEFAULT_STYLE ? ", in the " + st.label + " style" : "");
  return box;
}

/* The factors the score's style reads. Balanced reads all five in their usual
   order; any other style lists its own, heaviest first, with each weight. */
function factorBars(res) {
  var box = el("div", "factor-list");
  var styled = res.style && res.style !== DEFAULT_STYLE;
  styleFactors(res.factors, res.style).forEach(function (f) {
    var val = f.value;
    var row = el("div", "factor-row" + (num(val) ? "" : " is-na"));
    var lab = el("div", "factor-label");
    var name = el("span", "fl-name", f.label);
    if (styled) name.appendChild(el("span", "fl-weight", Math.round(f.weight * 100) + "%"));
    lab.appendChild(name);
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
    /* the labels are the line's own shares, which add up to 100 */
    [["buy", c.buy, "rec-b", "Buy", c.buyPct], ["hold", c.hold, "rec-h", "Hold", c.holdPct], ["sell", c.sell, "rec-s", "Sell", c.sellPct]]
      .forEach(function (p) {
        if (!p[1]) return;
        var seg = el("span", "rec-seg " + p[2]);
        seg.style.width = (p[1] / c.total * 100) + "%";
        seg.title = p[3] + ": " + p[1];
        if (p[1] / c.total > 0.12) seg.textContent = p[4] + "%";
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
      " (sentiment " + signedNum(ins.mspr) + " on a −100 to +100 scale)."));
  }
  return true;
}

function pcColumn(kind, title, items, glyph, max, none) {
  var col = el("section", "pc-col " + kind);
  var shown = max ? items.slice(0, max) : items;

  var h = el("h3", "");
  h.appendChild(el("span", "pc-glyph", glyph));
  h.appendChild(el("span", "", title));
  if (items.length) h.appendChild(el("span", "pc-count", String(items.length)));
  col.appendChild(h);

  if (!items.length) {
    col.appendChild(el("p", "pc-none", none || (kind === "pro"
      ? "Nothing in the numbers stands out as a strength."
      : "Nothing in these numbers stands out as a concern. That is not the same as no risk: read the risk factors from the 10-K below.")));
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

/* The card itself, the same for a company and a fund: the two stamps and
   the scrolling body. */
function cardShell(depth) {
  var card = el("article", "card");
  card.style.transform = stackTransform(depth);
  card.style.zIndex = String(50 - depth);
  card.setAttribute("aria-hidden", depth > 0 ? "true" : "false");
  /* covered: no Tab stops or Enter on a card nobody can see */
  card.inert = depth > 0;
  if (depth > 0) card.classList.add("is-behind");

  /* the stamps only show as a card is swiped away; a screen reader would
     otherwise start every card with "In cart, Pass" */
  card.innerHTML =
    '<div class="stamp add" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>In cart</div>' +
    '<div class="stamp pass" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>Pass</div>' +
    '<div class="card-scroll"></div>';
  return card;
}

/* The price, its move and a line under them (market cap, or a fund's net
   assets). `day`: the trading day they are from, when it is not the
   snapshot's (a fund's price kept from an earlier night). */
function priceBlock(s, under, day) {
  var pr = el("div", "c-price");
  pr.appendChild(el("div", "c-price-v", price(s.price)));
  var dir = !num(s.change) ? "flat" : s.change > 0.005 ? "up" : s.change < -0.005 ? "down" : "flat";
  var delta = el("div", "delta " + dir);
  delta.appendChild(el("span", "arrow", dir === "up" ? "▲" : dir === "down" ? "▼" : "–"));
  var older = day && snapshotDay() && day < snapshotDay();
  delta.appendChild(el("span", "", num(s.change) ? pct(s.change, 2) + " " + sessionWord(day)
    : older && num(s.price) ? "price " + sessionWord(day) : "no change data"));
  pr.appendChild(delta);
  pr.appendChild(el("span", "c-cap", under));
  return pr;
}

/* The 52-week range, said the way people say it: how far off the high, how
   far above the low. null when there is no range to show. */
function rangeBlock(s) {
  var range = rangeSummary(s);
  if (!range) return null;
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
  return rw;
}

/* The foot of a card: "Open the full record", and the fade that says there
   is more to scroll. */
function cardFoot(card, body, open) {
  var more = el("button", "more-btn");
  more.type = "button";
  more.innerHTML = '<span>Open the full record</span>' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  more.addEventListener("click", function (ev) { ev.stopPropagation(); open(); });
  body.appendChild(more);

  var fade = el("div", "card-fade");
  card.appendChild(fade);
  body.addEventListener("scroll", function () {
    fade.style.opacity = body.scrollTop + body.clientHeight >= body.scrollHeight - 24 ? "0" : "1";
  }, { passive: true });
}

function makeCard(s, depth) {
  if (funds.isFund(s)) return makeFundCard(s, depth);
  var card = cardShell(depth);

  var body = $(".card-scroll", card);
  if (!s) { body.appendChild(el("p", "", "Missing data.")); return card; }

  /* ---------- identity ---------- */
  var top = el("header", "c-top");
  var idb = el("div", "c-id");
  idb.appendChild(el("h2", "c-ticker", s.t));
  idb.appendChild(el("p", "c-name", s.n));
  idb.appendChild(el("span", "c-sector", s.s));
  top.appendChild(idb);
  var res = scoreStock(s, state.scoreCtx, state.style);
  top.appendChild(scoreRing(res, false));
  body.appendChild(top);

  /* ---------- price ---------- */
  body.appendChild(priceBlock(s, cap(s.mc) + " market cap"));

  /* ---------- 52-week range ---------- */
  var rw = rangeBlock(s);
  if (rw) body.appendChild(rw);

  /* ---------- next earnings ---------- */
  var e = s.earnings;
  var eb = el("div", "c-earnings");
  if (e && e.date) {
    var d = earn.daysUntil(e.date);
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
        ? "The text of this 10-K is not in our record. The original is linked below."
        : "No annual report on file for this company."));
  }

  /* ---------- into the full record, and the scroll affordance ---------- */
  cardFoot(card, body, function () { openDetail(s); });

  return card;
}

/* ------------------------------------------------------------- fund cards

   A fund's card has the company card's shell, price and range and its two
   columns for and against. Where a company shows its score, a fund shows
   its reading (lib/funds.mjs): a number on its own fixed scale, labelled as
   a fund reading wherever it appears, and only for a fund read in full. */

var DOC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>';

/* "$1.41T in the fund, all share classes": a fund total can cover several
   share classes of one fund, and says so. */
function assetsLine(f) {
  var n = f.nport;
  if (!n || !num(n.assets)) return "Net assets not read";
  return money(n.assets) + " in the fund" + (n.assetsScope === "series" ? ", all share classes" : "");
}

/* "what it owns (40%), what it costs (35%) and how spread out it is (25%)" */
function weightsWords(read) {
  var parts = read.factors.filter(function (f) { return f.weight > 0; }).map(function (f) {
    return (f.id === "spread" ? "how spread out it is" : f.label.toLowerCase()) + " (" + Math.round(f.weight * 100) + "%)";
  });
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

/* The reading as a number out of 100, a thin meter and its word, in the
   score's own markup so it counts up the same way, and captioned "Fund
   reading" so it is never taken for a company's place. A rank among the
   funds read in full with their fee is a caption only. A fund not read in
   full has no number, so no "—/100" and no empty meter, which would look
   like a number still on its way: it says what it is, "Partly read" and
   the figure behind it (lib/funds.mjs inBrief). */
function fundRing(read, big) {
  var v = read.overall;
  var st = styleById(read.style);
  if (!num(v)) {
    var brief = read.brief || { word: "Not read in full", detail: "" };
    var nb = el("div", "score-box fund-ring fund-brief" + (big ? " is-big" : "") + " tone-none");
    nb.appendChild(el("b", "fb-word", brief.word));
    if (brief.detail) nb.appendChild(el("span", "sr-label", brief.detail));
    nb.appendChild(el("span", "sr-rank", "No overall reading"));
    if (st.id !== DEFAULT_STYLE && read.hold) nb.appendChild(el("span", "sr-style", st.short));
    nb.title = read.notes[0] || "Not read in full";
    return nb;
  }
  var lab = scoreLabel(v);
  var box = el("div", "score-box fund-ring" + (big ? " is-big" : "") + " tone-" + lab.tone);
  var n = el("div", "score-num");
  n.appendChild(el("b", "", String(v)));
  n.appendChild(el("span", "", "/100"));
  box.appendChild(n);
  var meter = el("div", "score-meter");
  var fill = el("i", "");
  fill.style.width = clamp(v, 0, 100) + "%";
  meter.appendChild(fill);
  box.appendChild(meter);
  box.appendChild(el("span", "sr-label", lab.word));
  box.appendChild(el("span", "sr-rank", "Fund reading"));
  /* ranked only among the funds read in full whose fee has been read, which
     can be fewer than all those read in full: the caption counts those */
  if (read.place) {
    box.appendChild(el("span", "sr-rank", "#" + read.place.rank + " of " + read.place.of + (big ? " funds read in full, fee included" : " funds ranked")));
  }
  /* the style changes what it owns, so a style other than Balanced is named */
  if (st.id !== DEFAULT_STYLE && read.hold) box.appendChild(el("span", "sr-style", st.short));
  box.title = "Fund reading " + v + " out of 100: " + weightsWords(read) + ", each on a fixed scale. Not a place among companies." +
    (read.place ? " #" + read.place.rank + " of the " + read.place.of + " funds read in full with their fee read."
      : funds.costRead(read) ? "" : " Not ranked against other funds until its fee has been read.");
  return box;
}

/* The reading's three parts, each with its weight, a meter, and the figure
   behind it on a line of its own (it says "cost not read" when it is). */
function fundBars(read) {
  var box = el("div", "factor-list fund-factors");
  read.factors.forEach(function (f) {
    var val = f.score;
    var row = el("div", "factor-row" + (num(val) ? "" : " is-na"));
    var lab = el("div", "factor-label");
    var name = el("span", "fl-name", f.label);
    if (f.weight > 0) name.appendChild(el("span", "fl-weight", Math.round(f.weight * 100) + "%"));
    lab.appendChild(name);
    row.appendChild(lab);
    var meter = el("div", "factor-meter");
    var fill = el("div", "factor-fill");
    if (num(val)) fill.style.width = clamp(val, 0, 100) + "%";
    meter.appendChild(fill);
    row.appendChild(meter);
    row.appendChild(el("span", "factor-val", num(val) ? String(Math.round(val)) : "n/a"));
    row.appendChild(el("p", "factor-why", f.why));
    box.appendChild(row);
  });
  return box;
}

/* Cost in plain money, and the size and shape of the fund. */
function fundFacts(f, read) {
  var grid = el("dl", "c-stats");
  grid.appendChild(statRow("Expense ratio", num(f.er) ? funds.fmtEr(f.er) + " · " + funds.dollars(funds.perTenK(f.er)) + " a year on $10,000" : "Not read",
    "What the fund takes each year, as a share of what you hold in it."));
  if (f.nport && num(f.nport.count)) grid.appendChild(statRow("Holdings", f.nport.count.toLocaleString("en-US")));
  if (read.spread && num(read.spread.top10)) grid.appendChild(statRow("Largest ten", pctPlain(read.spread.top10, 0) + " of it",
    "The weight of its ten largest holdings, as a share of its stock holdings."));
  if (num(f.cover)) grid.appendChild(statRow("Matched to S&P 500 companies", pctPlain(f.cover, 0),
    "The share of its stock holdings we could match to a company we score."));
  return grid;
}

/* The largest holdings, each opening that company's own card, with its
   weight in the fund and its score in the style chosen. */
function holdList(f, n) {
  var scores = funds.companyScores(state.scoreCtx, state.style, state.all);
  var list = el("ol", "hold-list");
  f.hold.slice(0, n).forEach(function (h) {
    var co = state.byTicker[h[0]];
    if (funds.isFund(co)) co = null;
    var v = scores.get(h[0]) ? scores.get(h[0]).score : null;
    var li = el("li", "hold-row");
    var b = el("button", "link-btn hold-t", h[0]);
    b.type = "button";
    b.disabled = !co;
    if (co) b.title = "Open " + co.n;
    b.addEventListener("click", function (ev) { ev.stopPropagation(); if (co) openDetail(co); });
    li.appendChild(b);
    /* the company, not one share class: a weight covers all its classes */
    var name = el("span", "hold-n", co ? funds.companyName(co.n) : "");
    if (co && co.cik && state.all.some(function (o) { return o !== co && o.cik === co.cik; })) {
      name.title = funds.companyName(co.n) + ", all its share classes together";
    }
    li.appendChild(name);
    li.appendChild(el("span", "hold-w", pctPlain(h[1], 1)));
    var lab = scoreLabel(v);
    var chip = el("span", "hold-score tone-" + lab.tone);
    /* a bare number is all a screen reader would say; the title is not read everywhere */
    if (num(v)) { chip.appendChild(el("span", "sr-only", "score ")); chip.appendChild(document.createTextNode(String(v))); }
    else { chip.appendChild(el("span", "sr-only", "no score")); chip.appendChild(el("span", "", "—")).setAttribute("aria-hidden", "true"); }
    chip.title = num(v) ? "Its score: " + v + ", " + lab.word.toLowerCase() : "No score";
    li.appendChild(chip);
    list.appendChild(li);
  });
  return list;
}

/* How the holdings split across the five score words. One hue, stronger
   darker, never red and green: it describes, it does not signal. The same
   split is said in words beside it. */
function bandBar(bands) {
  var wrap = el("div", "band-wrap");
  var bar = el("div", "band-bar");
  bar.setAttribute("aria-hidden", "true");
  funds.BANDS.forEach(function (b) {
    var v = bands[b[0]];
    if (!(v >= 0.5)) return;
    var seg = el("span", "band-seg band-" + b[0]);
    seg.style.width = v + "%";
    seg.title = Math.round(v) + "% " + b[1];
    bar.appendChild(seg);
  });
  wrap.appendChild(bar);
  wrap.appendChild(el("p", "band-text", "How its holdings screen: " + funds.bandsText(bands)));
  return wrap;
}

function fundProsCons(read, max) {
  var wrap = el("div", "c-pc");
  wrap.appendChild(pcColumn("pro", "In its favour", read.pros, "+", max));
  wrap.appendChild(pcColumn("con", "Against it", read.cons, "−", max,
    "Nothing in these numbers stands out as a concern. That is not the same as no risk: the full record says what a fund reading cannot know."));
  return wrap;
}

function makeFundCard(f, depth) {
  var card = cardShell(depth);
  card.classList.add("is-fund");
  var body = $(".card-scroll", card);
  var read = fundReading(f);

  /* ---------- identity ---------- */
  var top = el("header", "c-top");
  var idb = el("div", "c-id");
  idb.appendChild(el("h2", "c-ticker", f.t));
  idb.appendChild(el("p", "c-name", f.n));
  var kind = el("span", "c-sector");
  kind.appendChild(el("span", "fund-chip", "ETF"));
  if (f.issuer) kind.appendChild(document.createTextNode(" " + f.issuer));
  idb.appendChild(kind);
  top.appendChild(idb);
  top.appendChild(fundRing(read, false));
  body.appendChild(top);

  /* ---------- price, and the fund's size where a company's market cap goes ---------- */
  body.appendChild(priceBlock(f, assetsLine(f), fundDay(f)));

  /* ---------- how old its holdings are, where a company's next report goes ---------- */
  var asOf = el("div", "c-earnings" + (f.nport && f.nport.period ? "" : " is-muted"));
  asOf.innerHTML = DOC_ICON;
  var line = el("span", "");
  if (f.nport && f.nport.period) {
    line.appendChild(el("b", "", "Holdings as of " + dateShort(f.nport.period)));
    line.appendChild(document.createTextNode(", from its N-PORT filing" + (f.nport.filed ? " of " + dateShort(f.nport.filed) : "") + "."));
  } else line.textContent = "No holdings filing has been read for it.";
  asOf.appendChild(line);
  body.appendChild(asOf);
  if (!num(read.overall)) body.appendChild(el("p", "fund-why", "Not read in full. " + funds.whyNotRead(f)));

  /* ---------- the reading, part by part ---------- */
  var parts = el("section", "c-block");
  parts.appendChild(el("h3", "block-h", "The fund reading"));
  parts.appendChild(fundBars(read));
  parts.appendChild(fundFacts(f, read));
  body.appendChild(parts);

  /* ---------- for and against, three of each ---------- */
  body.appendChild(fundProsCons(read, 3));

  /* ---------- what it owns ---------- */
  if (f.hold.length) {
    var owns = el("section", "c-block");
    owns.appendChild(el("h3", "block-h", "What it owns"));
    owns.appendChild(holdList(f, 5));
    if (read.hold) owns.appendChild(bandBar(read.hold.bands));
    body.appendChild(owns);
  }

  var rw = rangeBlock(f);
  if (rw) body.appendChild(rw);

  cardFoot(card, body, function () { openDetail(f); });
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
    drag = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, dx: 0, axis: null, t0: Date.now(), over: false };
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
        native.dragStart();
      } else {
        drag = null;                                  /* hand it back to the scroller */
        return;
      }
    }

    drag.dx = dx;
    /* in the app, a tick each time the card crosses the line where letting go
       commits (the 110 in release), either way */
    var over = Math.abs(dx) > 110;
    if (over !== drag.over) { drag.over = over; native.tick(); }
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
    if (axis === "x") native.dragEnd();
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
  /* swiped, or pressed Keep or Pass: a tap in the app, firmer for Keep */
  native.tap(action === "add");

  var s = state.byTicker[entry.ticker];
  var added = action === "add" ? addToCart(s) : false;
  /* the cart record this swipe made, if any, so Undo takes out only that one */
  state.history.push({ t: entry.ticker, action: action, added: added ? cartItem(entry.ticker).addedAt : null });
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
    c.node.inert = c.depth > 0;
  }

  setTimeout(function () {
    state.busy = false;
    state.cursor += 1;
    renderDeck();
  }, 300);
}

/* Takes back the last swipe: the company returns to the top of the pile, out
   of the seen list, and out of the cart if that swipe is what put it there.
   A record added again since is left alone, and one given a note or an
   amount since goes with the cart's own Undo, so nothing typed goes without
   a way back. */
function undo() {
  if (state.busy) return;
  var last = state.history.pop();
  if (!last) return;
  var item = last.added ? cartItem(last.t) : null;
  if (item && item.addedAt === last.added) {
    var copy = Object.assign({}, item);
    removeFromCart(last.t);
    persistCart();
    renderCartCount(); renderEarnNotice();
    if (item.note || (num(item.amount) && item.amount > 0)) {
      showToast(last.t + " is out of your cart", "Undo", function () { restoreToCart(copy); });
    }
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
  $("#toast").classList.remove("toast-top");
}

function setCartOwner(owner) {
  state.cartOwner = owner;
  save(LS.owner, owner);
}

/* Everything that shows the cart, redrawn after it changed from outside this
   tab. The open cart is left alone while someone is typing in it; its
   handlers look items up by ticker, so they keep working either way. */
/* `force`: redraw the cart even while a note or amount in it is being typed
   in (the cart has left this browser, so what is typed there goes too) */
function cartChanged(force) {
  renderCartCount();
  renderEarnNotice();
  renderOrderBar();
  var box = $("#viewCart");
  if (view === "cart" && (force || !box.contains(document.activeElement && document.activeElement.matches("input, textarea") ? document.activeElement : null))) renderCart();
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
    if (owner !== state.cartOwner) {
      /* signed out (or deleted) in the other tab: that cart has left this
         browser, even if this tab has not yet seen ts.cart change */
      var signedOut = owner === "" && !!state.cartOwner;
      state.cartOwner = owner;
      setCart(signedOut ? [] : theirs);
    }
    else setCart(cartLib.mergeCarts(cartRecords(), theirs));
    cartChanged(signedOut);
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
    ? "Not linked to your account"
    : status === "offline" ? "Not saved to your account, retrying"
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
  body.appendChild(document.createTextNode((native.inApp ? ". The cart on this iPhone has " : ". This browser's cart has ") +
    cartWords(state.cart) + (native.inApp ? ", with any notes, that " : ", with any notes and amounts, that ") +
    (n === 1 ? "is" : "are") + " not saved to that account."));
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
    if (!ok && !window.confirm("Your latest cart changes did not reach your account (the connection failed). Sign out anyway and lose them?")) {
      return Promise.reject("kept");
    }
    return auth.signOut();
  }).then(function () {
    /* offline with an access token that has run out, the library does not
       sign out; auth.signOut() removes the session itself, and no listener
       hears of it */
    if (state.user) { state.user = null; state.authPending = false; refreshTier(); setSyncNote(); }
    clearTimeout(sync.timer); clearTimeout(sync.retryTimer);
    /* Signing out on a shared computer has to end the brokerage connection
       too: its cookie belongs to the browser, not the account, and would
       otherwise leave the account and its orders to whoever sits down next. */
    broker.disconnect().then(function (r) {
      if (r.ok) state.broker = r.data;
      portfolio = null;
      renderBrokerPanel(); renderOrderBar();
    });
    /* the cart is emptied before the owner changes, so another tab never
       sees the owner gone while the old cart is still stored */
    if (owned) {
      setCart([]);
      save(LS.cart, []);
      setCartOwner("");
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
  var item = {
    t: s.t, n: s.n, sector: s.s,
    addedAt: now,
    updatedAt: now,
    priceAtAdd: num(s.price) ? s.price : null,
    note: ""
  };
  /* A fund says so in the record itself, so every copy of the cart (another
     device, the account, the CSV, an app from before funds) knows it is not
     a company, whether or not that copy has the funds loaded. */
  if (funds.isFund(s)) { item.sector = "ETF"; item.kind = "etf"; }
  state.cart.unshift(item);
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
  $("#tabCart").setAttribute("aria-label", n ? "Cart, " + cartWords(state.cart) : "Cart");
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
    var tk = el("span", "ci-ticker", item.t);
    if (isFundItem(item)) tk.appendChild(el("span", "fund-chip", "ETF"));
    idb.appendChild(tk);
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
    /* the day it was added on the viewer's calendar, not UTC's: something
       kept at 6pm in California was kept that day */
    meta.textContent = "Added " + dateShort(earn.localDay(item.addedAt)) + " at " + price(item.priceAtAdd) +
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
    summary = cartWords(state.cart, " · ");
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
    rows.push([text(i.t), text(i.n), text(i.sector), text(earn.localDay(i.addedAt)),
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

  /* the byte-order mark tells Excel the file is UTF-8. A download on the
     website; in the app, the share sheet (Save to Files, Mail…). */
  native.saveFile("stockornot-cart-" + earn.localDay(Date.now()) + ".csv",
    "text/csv;charset=utf-8", "\ufeff" + csv).then(savedOrSay);
}

/* After saveFile: only a failure needs saying. Closing the share sheet is a
   choice, not an error. */
function savedOrSay(result) {
  if (result === "failed") showToast("The file could not be saved. Try again.");
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
  /* the app has no brokerage at all (mobile/broker-stub.js) */
  if (native.inApp) { box.hidden = true; return; }
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
  if (native.inApp) { bar.hidden = true; return; }
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
  if (native.inApp) return;
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
  if (native.inApp) return;
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

/* Real money: the server refuses a batch whose orders add up to more than
   its batch cap, so the sheet says so before anything is sent. */
function overBatchCap(total) {
  var cap = (state.broker || {}).maxLiveBatch;
  return review && review.env === "live" && num(cap) && total > cap ? cap : null;
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
  var batchCap = locked ? null : overBatchCap(total);
  btn.disabled = !ready || locked || needsConfirm || !(review && review.env) || batchCap !== null;
  if (review && review.sending) btn.textContent = "Placing…";
  else if (review && review.placed) btn.textContent = review.summary || "Sent";
  else if (review && review.rows.some(function (x) { return x.result; })) btn.textContent = "Place the other " + ready;
  else btn.textContent = "Place " + ready + (ready === 1 ? " order" : " orders");
  /* the outcome of the last send, if there was one, otherwise a warning */
  var bp = b.account && b.account.buyingPower;
  orderError(review && review.message ? review.message
    : batchCap !== null ? "Live orders on this site are capped at " + usd(batchCap) + " a batch, all orders together. This comes to " + usd(total) + "; lower some amounts."
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
  if (native.inApp) return;
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
        (failure.status === 409 || failure.status === 400 ? "" : " Pressing Place again resends the same orders, which the brokerage will not duplicate.");
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
   email from the nightly job for anyone signed in who asks for one. In the
   iPhone app a notification scheduled on the phone takes the calendar file's
   place.
   ======================================================================== */

var NOTICE_KEY = "ts.earnNoticeHidden";

/* The earnings notice sits above the deck; the deck gives up its height, so
   the buttons under it stay clear of the tab bar on a phone. */
function fitDeck() {
  var box = $("#earnNotice");
  document.documentElement.style.setProperty("--notice-h", box.hidden ? "0px" : box.offsetHeight + "px");
}

function renderEarnNotice() {
  var box = $("#earnNotice");
  if (!box || !state.all.length) return;
  /* every change to the cart passes through here, so the reminders follow it */
  scheduleReminders();
  var soon = earn.upcoming(state.cart, state.byTicker, { days: earn.ALERT_DAYS });
  var sig = soon.map(function (u) { return u.t + u.date; }).join(",");
  var hidden = false;
  try { hidden = localStorage.getItem(NOTICE_KEY) === sig; } catch (e) {}
  if (!soon.length || hidden) { box.hidden = true; fitDeck(); return; }
  var first = soon[0];
  var when = first.days === 0 ? "today" : first.days === 1 ? "tomorrow" : "in " + first.days + " days";
  $("#earnNoticeText").textContent = first.t + " reports " + when +
    (num(first.epsEst) ? ", expected " + earn.eps(first.epsEst) + " a share" : "") +
    (soon.length > 1 ? " · " + (soon.length - 1) + " more in your cart in the next week" : "");
  box.hidden = false;
  box.dataset.sig = sig;
  fitDeck();
}

/* The app's reminders: one notification at 9 a.m. a week before each report
   in the cart, scheduled on the phone (earn.reminders, native.reschedule).
   The whole list is replaced each time, a second after the cart last
   changed, so a burst of swipes schedules once (or, on data older than the
   list was built from, only pruned: see NOTIFY_DATA). Nothing is scheduled before
   the companies have loaded: an empty list would cancel every reminder. */
var reminderTimer = null;
var NOTIFY_ON = "On: a notification at 9 a.m. a week before each report.";
var NOTIFY_DENIED = "Notifications are off for StockOrNot. Turn them on in Settings \u2192 Notifications.";

/* The data the phone's pending reminders were built from, by its "updated"
   stamp. An offline launch reads the copy built into the app, which can be
   weeks older: its report dates may have moved, or all be past. Rebuilding
   from it would move reminders to the wrong day or cancel them. So the list
   is never replaced from older data than built it, and the copy in the app
   replaces it only when that copy is known to be newer (a new version of the
   app opened before it could reach the site). With no stamp there is no
   list to spoil (reminders just turned on, or never scheduled), and the
   copy in the app builds one: the next launch that reaches the site
   replaces it with newer data. */
var NOTIFY_DATA = "ts.notifyData";
var UNDO_MS = 6000;   /* how long the cart's Undo stays offered (showToast) */

function scheduleReminders() {
  if (!native.canNotify() || !native.notifyWanted()) return;
  clearTimeout(reminderTimer);
  reminderTimer = setTimeout(function () {
    /* turned off in the meantime: that already cleared the list */
    if (!state.all.length || !native.notifyWanted()) return;
    var built = null;
    try { built = localStorage.getItem(NOTIFY_DATA); } catch (e) { /* private mode */ }
    var now = String(state.updated || "");
    if ((built && now < built) || (state.snapshotFromApp && built && !(now > built))) {
      /* data too old to rebuild from must not move the dates, but a company
         taken out of the cart still loses its reminder, once the cart's Undo
         is no longer offered: a company put back keeps the reminder that data
         this old could not build again (putting it back clears this timer) */
      reminderTimer = setTimeout(function () {
        native.prune(state.cart.map(function (i) { return i.t; }));
      }, UNDO_MS);
      return;
    }
    native.reschedule(earn.reminders(state.cart, state.byTicker)).then(function (ok) {
      if (ok && now) try { localStorage.setItem(NOTIFY_DATA, now); } catch (e) { /* private mode */ }
    });
  }, 1000);
}

/* The "Notify me on this iPhone" switch in the Earnings sheet. It is on only
   while both the person wants it and iOS allows it. */
function renderLocalToggle() {
  var row = $("#earnLocalRow");
  var box = $("#earnLocal");
  var note = $("#earnLocalNote");
  /* the app build opened in a browser, or a build without the plugin */
  row.hidden = note.hidden = !native.canNotify();
  if (row.hidden) return;
  box.disabled = true;
  native.notifyPermission().then(function (perm) {
    var wanted = native.notifyWanted();
    box.disabled = false;
    box.checked = wanted && perm === "granted";
    note.textContent = box.checked ? NOTIFY_ON : wanted && perm === "denied" ? NOTIFY_DENIED : "";
  });
}

function setLocalNotify(on) {
  var box = $("#earnLocal");
  var note = $("#earnLocalNote");
  if (!on) {
    clearTimeout(reminderTimer);
    native.setNotifyWanted(false);
    native.reschedule([]);
    try { localStorage.removeItem(NOTIFY_DATA); } catch (e) { /* private mode */ }
    note.textContent = "Off.";
    return;
  }
  /* iOS asks the first time; after that it answers from Settings */
  box.disabled = true;
  native.askNotify().then(function (perm) {
    box.disabled = false;
    if (perm !== "granted") {
      box.checked = false;
      note.textContent = NOTIFY_DENIED;
      return;
    }
    native.setNotifyWanted(true);
    box.checked = true;
    note.textContent = NOTIFY_ON;
    scheduleReminders();
  });
}

function openEarnings() {
  var icsNote = $("#icsNote");
  if (icsNote.dataset.text) icsNote.textContent = icsNote.dataset.text;
  else icsNote.dataset.text = icsNote.textContent;
  var list = $("#earnList");
  list.innerHTML = "";
  var month = earn.upcoming(state.cart, state.byTicker, { days: 45 });
  /* funds do not report earnings: they are left out of every count here */
  var companies = state.cart.filter(function (i) { return !isFundItem(i); });
  var undated = companies.filter(function (i) {
    var s = state.byTicker[i.t];
    return !(s && s.earnings && s.earnings.date && earn.daysUntil(s.earnings.date) >= 0);
  });

  $("#earnNote").textContent = companies.length
    ? month.length + " of " + companies.length + " in your cart report in the next 45 days"
    : "";

  if (!companies.length) {
    list.appendChild(el("p", "empty-note", state.cart.length
      ? "Funds do not report earnings. Add companies to your cart and their report dates show up here."
      : "Add companies to your cart and their report dates show up here."));
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
  renderLocalToggle();
  openDialog($("#dlgEarnings"));
}

/* "Turn them off" in an alert email opened the sheet (alertsOffLink), and,
   where nobody was signed in, when the sign-in to do that was started
   (alertsOffAt): the alerts are switched off once it completes. */
var alertsOffLink = false;
var alertsOffAt = 0;
var ALERTS_OFF_FOR_MS = 3600e3;

function renderEmailToggle() {
  var box = $("#earnEmail");
  var note = $("#earnEmailNote");
  if (!auth.isConfigured()) {
    box.disabled = true;
    note.textContent = "Email alerts need accounts, which are not set up on this copy of the site.";
    return;
  }
  if (!state.user && state.authPending) {
    /* a saved sign-in is still being checked; the listeners redraw this */
    box.disabled = true;
    note.textContent = "Checking…";
    return;
  }
  if (!state.user) {
    box.checked = false;
    /* this browser cannot know whether they are on, so it does not say "off" */
    box.indeterminate = alertsOffLink;
    box.disabled = true;
    note.innerHTML = "";
    note.appendChild(document.createTextNode(alertsOffLink
      ? "This browser is not signed in, so it cannot tell whether your alerts are on. Sign in with the address they go to and they are switched off, or reply \"unsubscribe\" to any alert. "
      : "Sign in so there is an address to send it to. "));
    var go = el("button", "link-btn", "Sign in");
    go.type = "button";
    go.addEventListener("click", function () {
      if (alertsOffLink) alertsOffAt = Date.now();
      closeDialog($("#dlgEarnings")); openAuth();
    });
    note.appendChild(go);
    return;
  }
  box.indeterminate = false;
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

/* Signed in to switch the alerts off (above): do that, then show the switch. */
function alertsOffAfterSignIn(user) {
  var asked = alertsOffAt && Date.now() - alertsOffAt < ALERTS_OFF_FOR_MS;
  alertsOffAt = 0;
  if (!asked) return;
  auth.saveAlertPrefs({ email: false, days_before: earn.ALERT_DAYS }).then(function (r) {
    if (!state.user || state.user.id !== user.id) return;
    whenLoaded(function () {
      /* the switch shows what is saved; if that is still "on", say so */
      function show() {
        openEarnings();
        if (r && r.ok) return;
        var msg = "Your alerts could not be switched off just now. Untick the box to try again.";
        var box = $("#toast"), act = $("#toastAction");
        /* "Signed in as …. Not you? Sign out" from the link is still on
           screen: add to it, do not replace it */
        if (box.getClientRects().length && !act.hidden && act.textContent === "Sign out") $("#toastText").textContent += " " + msg;
        else showToast(msg, null, null, 10000);
      }
      /* after the question about whose cart this is, when that is open */
      var owner = $("#dlgOwner");
      if (owner.open) owner.addEventListener("close", show, { once: true });
      else show();
    });
  });
}

function downloadIcs(rows, filename) {
  if (!rows.length) return;
  /* the events link to the company pages on the website, wherever this runs */
  var ics = earn.toIcs(rows, { site: native.SITE });
  native.saveFile(filename || "stockornot-earnings.ics", "text/calendar", ics).then(savedOrSay);
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
  return native.dataFetch("data/detail/" + encodeURIComponent(safe) + ".json", { cache: "no-cache" })
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
    wrap.appendChild(el("p", "block-note", "No price history recorded for this company."));
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
      /* signed the app's way: a real minus, and no "-0" */
      mark.appendChild(el("span", "", signedNum(m.mspr) +
        (num(m.change) && m.change !== 0 ? " · " + (m.change > 0 ? "+" : "") + money(m.change, false) + " shares" : "")));
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

  /* the app reminds with a notification instead (the Earnings sheet) */
  var cal = el("button", "link-btn web-only", "Add this date to my calendar, with a reminder a week before");
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
  var starred = false;
  [s].concat(peers).forEach(function (p) {
    /* the same mark the card and Compare put on a bank's one-year jump */
    var odd = inputs(p).rgSuspect;
    if (odd) starred = true;
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
    [cap(p.mc), num(p.pe) && p.pe > 0 ? x(p.pe) : "n/a", pct(p.rg) + (odd ? "*" : ""), pctPlain(p.nm, 0), pct(p.r52)]
      .forEach(function (v) { tr.appendChild(el("td", "", v)); });
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  var scroll = el("div", "table-scroll");
  scroll.appendChild(t);
  wrap.appendChild(scroll);
  if (starred) wrap.appendChild(el("p", "block-note", "*Far out of line with the five-year trend, which in the Financials sector is usually interest income swinging with rates. The score uses the five-year figure instead."));
  return wrap;
}

/* ----------------------------------------------------------------- news */

var newsCache = {};

function loadNews(ticker) {
  if (newsCache[ticker]) return newsCache[ticker];
  /* the app asks the website by its full address, which is canonical, so the
     redirect in api/news.mjs never fires */
  newsCache[ticker] = fetch(native.apiUrl("/api/news?t=") + encodeURIComponent(ticker))
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
    box.appendChild(el("p", "block-note first", native.inApp ? "Headlines need a connection."
      : "Headlines load on the live site; this copy has no server behind it."));
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

/* The company's page on the website, by the same rule as the address
   scripts/build-pages.mjs gives it. */
function stockUrl(t) {
  return native.SITE + "/stock/" + t.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/* The share sheet, with the company's page on the website. Where sharing
   fails on the website the link is copied instead; closing the sheet is not
   a failure. */
function shareDetail() {
  var s = state.byTicker[detailTicker];
  if (!s) return;
  /* a fund has no page of its own: its link opens the deck on it */
  var url = funds.isFund(s) ? native.SITE + "/?t=" + encodeURIComponent(s.t) : stockUrl(s.t);
  native.share({
    title: s.t + " on StockOrNot",
    text: s.n + " (" + s.t + ") on StockOrNot. Not investment advice.",
    url: url
  }).then(function (result) {
    if (result !== "failed") return;
    if (native.inApp) { showToast("The share sheet did not open. Try again."); return; }
    var copied = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(url) : Promise.reject();
    copied.then(function () { showToast("Link copied"); },
      function () { showToast("Share this link: " + url.replace(/^https:\/\//, "")); });
  });
}

function section(title, node) {
  var s = el("section", "c-block");
  s.appendChild(el("h3", "block-h", title));
  s.appendChild(node);
  return s;
}

/* The sheet's header: who it is, the price and the day's move. `when`,
   " on Oct 7", dates the move once it is not today's, as the card does. */
function detailHead(s, name, when) {
  detailTicker = s.t;
  $("#detailShare").hidden = !native.canShare;
  $("#detailTitle").textContent = s.t;
  $("#detailName").textContent = name;
  $("#detailPrice").textContent = price(s.price);
  var dir = !num(s.change) ? "flat" : s.change > 0.005 ? "up" : s.change < -0.005 ? "down" : "flat";
  var ch = $("#detailChange");
  ch.className = "delta small " + dir;
  ch.innerHTML = "";
  ch.appendChild(el("span", "arrow", dir === "up" ? "▲" : dir === "down" ? "▼" : "–"));
  ch.appendChild(el("span", "", num(s.change) ? pct(s.change, 2) + (when || "") : when && num(s.price) ? "price" + when : "—"));
}

/* A price chart with a range toggle and the trend figures under it, or a
   line saying there is none yet. `recorded`: the series is our own nightly
   closes, which says since when. */
function fillChart(chartBox, points, recorded, none) {
  if (!points) {
    chartBox.appendChild(el("p", "block-note first", none));
    return;
  }
  var ranges = el("div", "range-toggle");
  /* the chosen range is said, not only shaded, as on the Stocks|ETFs switch */
  ranges.setAttribute("role", "group");
  ranges.setAttribute("aria-label", "Chart range");
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
      b.setAttribute("aria-pressed", i === windows.length - 1 ? "true" : "false");
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(ranges.children, function (x) { x.classList.remove("is-on"); x.setAttribute("aria-pressed", "false"); });
        b.classList.add("is-on");
        b.setAttribute("aria-pressed", "true");
        draw(r.months);
      });
      ranges.appendChild(b);
    });
    chartBox.appendChild(ranges);
  }
  chartBox.appendChild(chartSlot);
  draw(0);
  if (recorded) {
    chartBox.appendChild(el("p", "block-note", "Closing prices recorded here each trading day since " + dateShort(points[0][0]) + "."));
  }
}

function openDetail(s) {
  if (!s) return;
  /* a peer or a holding opened from inside the sheet: the button pressed
     goes with the old record, so the reader starts again at the new name */
  var refocus = $("#dlgDetail").open;
  if (funds.isFund(s)) { openFundDetail(s); if (refocus) $("#detailTitle").focus(); return; }
  /* "on Oct 13" once the close is not today's, as the card says it */
  detailHead(s, s.n + " · " + s.s, sessionWord() !== "today" ? " " + sessionWord() : "");

  var body = $("#detailBody");
  body.innerHTML = "";
  body.appendChild(el("p", "block-note", "Loading the full record…"));

  openDialog($("#dlgDetail"));
  if (refocus) $("#detailTitle").focus();

  Promise.all([loadDeep(s.t), loadDetail(s.t)]).then(function (both) {
    if (detailTicker !== s.t) return;
    var deep = both[0], filing = both[1];
    body.innerHTML = "";

    /* --- the score, and what drove it --- */
    var scoreRes = scoreStock(s, state.scoreCtx, state.style);
    var scoreBox = el("div", "score-detail");
    var scoreHead = el("div", "score-head");
    scoreHead.appendChild(scoreRing(scoreRes, true));
    var blurb = el("div", "score-blurb");
    var st = styleById(scoreRes.style);
    var styled = st.id !== DEFAULT_STYLE;   /* a style may read fewer than five */
    blurb.appendChild(el("p", "", !num(scoreRes.overall) ? "Not enough reported data to score this one."
      : (scoreRes.place
          ? "Ahead of " + scoreRes.overall + "% of the S&P 500 on the " + (styled ? "" : "five ") + "factors below, weighted. "
          : "A weighted blend of the factors below. ") +
        "It describes what the last filing and the current price look like. It is not a forecast, and it knows nothing about the business beyond these numbers."));
    /* this sheet covers the top bar and its line, so it carries its own */
    var advice = el("p", "block-note score-advice");
    advice.appendChild(el("b", "", "Not investment advice."));
    blurb.appendChild(advice);
    blurb.appendChild(styleLine(st));
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
    var chartBox = el("div", "");
    fillChart(chartBox, insight.priceSeries(deep), !(deep && deep.chart && deep.chart.length >= 20),
      "No price history recorded for this company yet.");
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

/* ------------------------------------------------------ a fund's full record

   The reading and what drove it, the case both ways, what it owns and how
   that splits by sector, its companies taken together, what it costs, its
   price, the fund's own facts and filings, and what a reading like this
   cannot know. Everything comes from data/etfs.json and the company cards;
   only the chart needs a second file. */

/* Links into the record come from our own data file; only the SEC's own
   addresses are ever made into links. */
function secLink(href, text) {
  if (typeof href !== "string" || !/^https:\/\/www\.sec\.gov\//.test(href)) return null;
  var a = el("a", "filing-link", text);
  a.href = href; a.target = "_blank"; a.rel = "noopener";
  return a;
}

/* The fund's sectors against the S&P 500's own, by market value. "Outside
   the S&P 500" is what it holds that we do not cover. */
function mixBlock(f) {
  var mix = f.mix || {};
  var keys = Object.keys(mix).filter(function (k) { return num(mix[k]) && mix[k] >= 0.05; });
  if (!keys.length) return null;
  var idx = funds.indexProfile(state.all) || { mix: {} };
  keys.sort(function (a, b) { return (a === funds.OUTSIDE) - (b === funds.OUTSIDE) || mix[b] - mix[a]; });
  var box = el("div", "");
  box.appendChild(el("p", "block-note first", "Each sector's share of its stock holdings, with the S&P 500's own share by market value beside it."));
  var list = el("div", "mix-list");
  keys.forEach(function (k) {
    var row = el("div", "mix-row");
    var ix = k === funds.OUTSIDE ? null : idx.mix[k];
    row.title = k + ": " + pctPlain(mix[k], 1) + " of the fund" + (num(ix) ? ", " + pctPlain(ix, 1) + " of the S&P 500" : "");
    row.appendChild(el("span", "mix-name", k));
    var meter = el("div", "mix-meter");
    meter.setAttribute("aria-hidden", "true");
    var fill = el("i", "");
    fill.style.width = clamp(mix[k], 0, 100) + "%";
    meter.appendChild(fill);
    if (num(ix)) {
      var tick = el("b", "");
      tick.style.left = clamp(ix, 0, 100) + "%";
      meter.appendChild(tick);
    }
    row.appendChild(meter);
    var vals = el("span", "mix-val");
    vals.appendChild(el("b", "", pctPlain(mix[k], 1)));
    vals.appendChild(el("span", "", num(ix) ? "S&P 500 " + pctPlain(ix, 1) : ""));
    row.appendChild(vals);
    list.appendChild(row);
  });
  box.appendChild(list);
  return box;
}

/* Its companies taken together: shown, not scored. */
function lookBlock(read, f) {
  var look = read.look;
  var idx = (funds.indexProfile(state.all) || {}).look || {};
  var box = el("div", "");
  var grid = el("dl", "c-stats");
  grid.appendChild(statRow("P/E, together", num(look.pe) ? x(look.pe, 1) + (num(idx.pe) ? " · S&P 500 " + x(idx.pe, 1) : "") : "n/a",
    "A harmonic mean weighted as the fund holds them, so one company at 400 times earnings cannot drag it; a loss counts as no earnings."));
  grid.appendChild(statRow("Dividend yield, together", num(look.dy) ? pctPlain(look.dy, 2) + (num(f.er) ? " · " + pctPlain(look.dy - f.er, 2) + " after the fee" : "") : "n/a",
    "Each company's yield weighted as the fund holds it. A yield the provider's own figures dispute counts as unseen. Not the fund's own distribution."));
  grid.appendChild(statRow("In companies losing money", num(look.losing) ? pctPlain(look.losing, 1) : "n/a"));
  box.appendChild(grid);
  box.appendChild(el("p", "block-note", "Over the " + pctPlain(look.base, 0) + " of its stock holdings we can match, weighted as the fund holds them. Shown, not part of the reading."));
  return box;
}

/* The fee in money, over a year and over ten, with where it was read. */
function costBlock(f) {
  var box = el("div", "");
  if (!num(f.er)) {
    box.appendChild(el("p", "block-note first", "Not read. The expense ratio is read from the fund's own SEC filings; until it is, the reading leaves cost out and says so."));
    return box;
  }
  var grid = el("dl", "c-stats");
  grid.appendChild(statRow("Expense ratio", funds.fmtEr(f.er), "Taken from the fund every year, whatever it does."));
  grid.appendChild(statRow("A year on $10,000", funds.dollars(funds.perTenK(f.er))));
  grid.appendChild(statRow("Ten years on $10,000", funds.dollars(funds.tenYearCost(f.er)),
    "What the fee takes from $10,000 growing 7% a year before it, against the same with no fee."));
  box.appendChild(grid);
  var src = secLink(f.erUrl, "The filing it was read from" + (f.erAsOf ? " (" + dateShort(f.erAsOf) + ")" : ""));
  if (src) {
    var links = el("div", "filing-links");
    links.appendChild(src);
    box.appendChild(links);
  }
  return box;
}

/* The fund's own facts and filings. */
function fundAbout(f, read) {
  var box = el("div", "");
  var grid = el("dl", "c-stats");
  var n = f.nport || {};
  if (f.issuer) grid.appendChild(statRow("Issuer", f.issuer));
  if (num(f.since)) grid.appendChild(statRow("Launched", String(f.since)));
  grid.appendChild(statRow("Net assets", num(n.assets) ? money(n.assets) + (n.assetsScope === "series" ? ", all share classes" : "") : "—",
    "From its last N-PORT filing. For a fund with several share classes, the fund's total across all of them."));
  if (num(n.count)) grid.appendChild(statRow("Holdings", n.count.toLocaleString("en-US")));
  var sp = read.spread;
  if (sp && num(sp.effN)) grid.appendChild(statRow("Behaves like", "about " + Math.round(sp.effN) + " equal holdings",
    "One over the sum of the squared weights: the number of equal holdings that would be as concentrated."));
  if (sp && num(sp.big1)) grid.appendChild(statRow("Largest holding", (sp.big1T || "") + " " + pctPlain(sp.big1, 1)));
  if (num(f.other)) grid.appendChild(statRow("Cash and other", pctPlain(f.other, 1),
    "Cash, money-market funds, futures and anything else that is not a company's shares."));
  if (Array.isArray(n.rtn) && n.rtn.some(num)) {
    grid.appendChild(statRow("Monthly returns filed", n.rtn.map(function (v) { return pct(v, 1); }).join(", "),
      "The fund's own return in each month of its last N-PORT filing, as it reports them. Shown, not part of the reading."));
  }
  [["r13", "13 weeks"], ["r52", "Past year"], ["ytd", "This year"], ["beta", "Beta"]].forEach(function (p) {
    if (num(f[p[0]])) grid.appendChild(statRow(p[1], p[0] === "beta" ? f.beta.toFixed(2) : pct(f[p[0]], 1)));
  });
  box.appendChild(grid);

  var links = el("div", "filing-links");
  [
    secLink(n.url, "Its holdings filing (N-PORT" + (n.period ? ", " + dateShort(n.period) : "") + ")"),
    (f.series || f.trust) && secLink("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=" +
      encodeURIComponent(f.series || f.trust) + "&type=NPORT-P&dateb=&owner=include&count=40", "All its filings on EDGAR")
  ].filter(Boolean).forEach(function (a) { links.appendChild(a); });
  if (links.children.length) box.appendChild(links);
  return box;
}

/* What a fund reading cannot know, said beside every one. */
function cannotKnow() {
  var box = el("div", "");
  var ul = el("ul", "risk-list");
  [
    "Its holdings are months old. Funds make their holdings public once a quarter, up to 60 days after it ends. An index fund changes slowly; an actively managed one may have changed completely.",
    "We only judge S&P 500 companies. Anything else a fund owns counts as average, neither good nor bad, and the record says how much that is.",
    "What it owns is our company score counted again. A fund full of the companies our screen likes this year reads well for that reason alone. It is not a second opinion.",
    "A fund is less risky than the average of its parts. Owning 500 companies moves less than the typical one of them, and how spread out it is captures that only roughly.",
    "What it costs you to trade is not read: the gap between the buying and selling price, a market price above or below the fund's value, taxes and capital-gain payouts, securities lending, and how the index is rebuilt.",
    "Past returns are not part of the reading, and nothing here has been backtested."
  ].forEach(function (t) { ul.appendChild(el("li", "", t)); });
  box.appendChild(ul);
  var more = el("a", "filing-link", "How a fund is read");
  more.href = "/method#funds";
  var links = el("div", "filing-links");
  links.appendChild(more);
  box.appendChild(links);
  return box;
}

function openFundDetail(f) {
  /* nearly every fund's name already ends in "ETF" */
  /* "on Oct 13" once the fund's close is not today's, as its card says it */
  var fw = sessionWord(fundDay(f));
  detailHead(f, f.n + (/\bETF\b/.test(f.n) ? "" : " · ETF") + (f.issuer ? " · " + f.issuer : ""), fw !== "today" ? " " + fw : "");
  var body = $("#detailBody");
  body.innerHTML = "";
  var read = fundReading(f);
  var st = styleById(read.style);

  /* --- the reading, and what drove it --- */
  var scoreBox = el("div", "score-detail");
  var head = el("div", "score-head");
  head.appendChild(fundRing(read, true));
  var blurb = el("div", "score-blurb");
  blurb.appendChild(el("p", "", num(read.overall)
    ? "A blend of " + weightsWords(read) + ", each on a fixed scale, so it does not move when other funds come and go. It is not a place among companies, and not a forecast."
    : "Not read in full, so there is no overall reading. " + funds.whyNotRead(f) + " What can be read is below."));
  var advice = el("p", "block-note score-advice");
  advice.appendChild(el("b", "", "Not investment advice."));
  blurb.appendChild(advice);
  if (read.hold) blurb.appendChild(styleLine(st));
  var notes = read.notes.slice(num(read.overall) ? 0 : 1);
  if (notes.length) {
    var ul = el("ul", "score-notes");
    notes.forEach(function (n) { ul.appendChild(el("li", "", n)); });
    blurb.appendChild(ul);
  }
  head.appendChild(blurb);
  scoreBox.appendChild(head);
  scoreBox.appendChild(fundBars(read));
  body.appendChild(section("Fund reading", scoreBox));
  body.appendChild(section("For and against", fundProsCons(read)));

  /* --- what it owns --- */
  var owns = el("div", "");
  if (f.hold.length) {
    owns.appendChild(holdList(f, 10));
    var total = f.nport && num(f.nport.count) ? f.nport.count : f.hold.length;
    var rest = total - Math.min(10, f.hold.length);
    if (rest > 0) owns.appendChild(el("p", "block-note", "and " + rest.toLocaleString("en-US") + " more"));
    if (read.hold) owns.appendChild(bandBar(read.hold.bands));
    if (f.out.length) {
      owns.appendChild(el("h4", "sub-h", "Not matched to a company we score"));
      owns.appendChild(el("p", "block-note first", f.out.slice(0, 8).map(function (o) {
        return String(o[1] || "Unnamed") + " " + pctPlain(o[2], 1);
      }).join(" · ") + (f.out.length > 8 ? " and " + (f.out.length - 8) + " more" : "") + "."));
    }
  } else {
    owns.appendChild(el("p", "block-note first", "No holdings have been read for this fund."));
  }
  if (f.nport && f.nport.period) {
    owns.appendChild(el("p", "block-note", "Holdings as of " + dateShort(f.nport.period) + ", from its N-PORT filing; prices have moved since. " +
      "Each weight is a share of its stock holdings, and each score is the one on that company's card."));
  }
  body.appendChild(section("What it owns", owns));

  var mix = mixBlock(f);
  if (mix) body.appendChild(section("By sector", mix));
  if (read.look && read.look.base > 0) body.appendChild(section("Its companies together", lookBlock(read, f)));
  body.appendChild(section("What it costs", costBlock(f)));

  /* --- the price, from the closes recorded each night --- */
  var chartBox = el("div", "");
  chartBox.appendChild(el("p", "block-note first", "Loading prices…"));
  body.appendChild(section("Price", chartBox));
  loadFundCloses().then(function (closes) {
    if (detailTicker !== f.t) return;
    var pts = closes && Array.isArray(closes[f.t]) ? closes[f.t].filter(function (p) {
      return Array.isArray(p) && typeof p[0] === "string" && num(p[1]);
    }) : [];
    chartBox.innerHTML = "";
    fillChart(chartBox, pts.length >= 5 ? pts : null, true,
      "Not enough price history for a chart. Its closing price is recorded each trading day, and the chart starts at five.");
    var rw = rangeBlock(f);
    if (rw) chartBox.appendChild(rw);
  });

  body.appendChild(section("The fund", fundAbout(f, read)));
  body.appendChild(section("What a fund reading cannot know", cannotKnow()));
  if (state.fundsUpdated) body.appendChild(el("p", "block-note", "Fund data refreshed " + relTime(state.fundsUpdated) + "."));

  openDialog($("#dlgDetail"));
  body.scrollTop = 0;
}

/* ============================================================ COMPARE ===
   Two companies head to head: the score and its factors under the chosen
   style, then the figures behind the five checks as numbers, with the
   stronger of the two marked on each row. It opens on the two largest
   companies in the index; tapping either one swaps it. The pair is kept in
   this browser.

   With funds, a Stocks | ETFs switch: fund against fund, never a fund
   against a company, whose numbers are on different scales. That pair opens
   on the two largest funds by net assets and is kept apart. */

var CMP_KEY = "ts.compare";
var CMP_FUND_KEY = "ts.compareFunds";
var SWAP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9l4-4 4 4M8 15l4 4 4-4"/></svg>';
var cmpPairs = { stocks: null, etfs: null };     /* [left, right] tickers, per kind */
var pickSide = 0;        /* the side the picker is choosing for */
var cmpKind = load(LS.cmpKind, "stocks") === "etfs" ? "etfs" : "stocks";

/* Companies, or funds once there are two to set side by side. */
function compareKind() { return state.funds.length >= 2 && cmpKind === "etfs" ? "etfs" : "stocks"; }

function chooseCompareKind(kind) {
  kind = kind === "etfs" ? "etfs" : "stocks";
  if (kind === compareKind()) return;
  cmpKind = kind;
  save(LS.cmpKind, kind);
  renderKinds();
  renderCompare();
}

var idOf = function (s) { return s.cik || s.t; };

/* The largest companies by market value, one share class each, leaving out
   any company in `skip` (tickers). */
function largest(n, skip) {
  var seen = new Set((skip || []).map(function (t) { return state.byTicker[t] ? idOf(state.byTicker[t]) : t; }));
  var out = [];
  state.all.slice().sort(function (a, b) { return (b.mc || 0) - (a.mc || 0); }).forEach(function (s) {
    if (out.length >= n || seen.has(idOf(s))) return;
    seen.add(idOf(s));
    out.push(s);
  });
  return out;
}

function comparePair() {
  var etf = compareKind() === "etfs";
  /* a ticker belongs on this side only if it is of this kind */
  var fits = function (t) { var s = state.byTicker[t]; return Boolean(s) && funds.isFund(s) === etf; };
  var cmpPair = cmpPairs[compareKind()];
  if (cmpPair && cmpPair.length === 2 && cmpPair.every(fits)) return cmpPair;
  var saved = load(etf ? CMP_FUND_KEY : CMP_KEY, null);
  var pair = Array.isArray(saved)
    ? saved.filter(function (t) { return typeof t === "string" && fits(t); }).slice(0, 2) : [];
  /* a first visit, or a company that has left the index: the largest fill in */
  (etf ? funds.largestFunds(state.funds, 2, pair) : largest(2, pair)).forEach(function (s) { if (pair.length < 2) pair.push(s.t); });
  cmpPairs[compareKind()] = pair;
  return pair;
}

function setSide(side, t) {
  var pair = comparePair().slice();
  if (pair[side] !== t) {
    /* the same allowance as the deck: a company opened here counts as opened */
    if (!tier.withinAllowance(state.viewed, t, state.tier)) {
      $("#pickMsg").textContent = "That is past the companies your plan can open." +
        (state.tier === "anon" ? " Sign in for more." : "");
      return;
    }
    tier.recordViewed(state.viewed, t);
    renderAllowance();
    /* choosing the company on the other side swaps the two */
    if (pair[1 - side] === t) pair[1 - side] = pair[side];
    pair[side] = t;
    cmpPairs[compareKind()] = pair;
    save(compareKind() === "etfs" ? CMP_FUND_KEY : CMP_KEY, pair);
  }
  closeDialog($("#dlgPick"));
  renderCompare();
}

/* Tickers that start with what was typed come first, then names that hold it. */
function findCompanies(q) {
  q = q.trim().toUpperCase();
  if (!q) return [];
  var starts = [], within = [];
  (compareKind() === "etfs" ? state.funds : state.all).forEach(function (s) {
    if (s.t.indexOf(q) === 0) starts.push(s);
    else if (q.length >= 2 && String(s.n || "").toUpperCase().indexOf(q) >= 0) within.push(s);
  });
  starts.sort(function (a, b) { return a.t.length - b.t.length || (a.t < b.t ? -1 : 1); });
  return starts.concat(within).slice(0, 8);
}

function openPicker(side) {
  pickSide = side;
  $("#pickTitle").textContent = "Swap " + comparePair()[side];
  $("label[for=pickInput]").textContent = compareKind() === "etfs" ? "Find a fund by ticker or name" : "Find a company by ticker or name";
  $("#pickInput").value = "";
  $("#pickMsg").textContent = "";
  renderPickList();
  openDialog($("#dlgPick"));
}

/* What was typed, or with nothing typed, the cart and the largest companies. */
function renderPickList() {
  var box = $("#pickList");
  box.innerHTML = "";
  var pair = comparePair();
  function group(title, list) {
    if (!list.length) return;
    if (title) box.appendChild(el("h3", "pick-h", title));
    list.forEach(function (s) {
      var b = el("button", "search-hit");
      b.type = "button";
      b.appendChild(el("b", "", s.t));
      b.appendChild(el("span", "", s.n + (s.t === pair[pickSide] ? " · showing now" : s.t === pair[1 - pickSide] ? " · on the other side" : "")));
      b.addEventListener("click", function () { setSide(pickSide, s.t); });
      box.appendChild(b);
    });
  }
  var q = $("#pickInput").value;
  if (q.trim()) {
    var hits = findCompanies(q);
    if (hits.length) group("", hits);
    else box.appendChild(el("p", "block-note", compareKind() === "etfs" ? "No fund we cover matches that." : "Nothing in the S&P 500 matches that."));
    return;
  }
  var etf = compareKind() === "etfs";
  group("In your cart", state.cart.map(function (i) { return state.byTicker[i.t]; })
    .filter(function (s) { return s && funds.isFund(s) === etf; }).slice(0, 12));
  /* some totals take in a fund's other share classes (its card says so) */
  if (etf) group("Largest by net assets", funds.largestFunds(state.funds, 10));
  else group("Largest companies", largest(10));
}

/* The figures behind the five checks, as numbers, worked out the way the
   card's checks work them out (lib/insight.mjs), traps included: a bank's
   revenue swing, cash flow and debt are not read as such, and a gap in the
   filings is said rather than shown as zero. Each is { v: number to compare,
   or null; t: what to show }. */
function cmpFigures(s) {
  var k = inputs(s), f = s.fin || {}, val = valuation(s, k);
  var fin = k.financial ? "n/a, a financial" : null;
  var fig = function (v, t) { return { v: num(v) ? v : null, t: t }; };
  var fcfOk = !k.financial && num(f.fcf);
  var fcfm = fcfOk && num(f.revenue) && f.revenue > 0 ? (f.fcf / f.revenue) * 100 : null;
  var net = !k.financial && num(f.cash) && num(f.debt) ? f.cash - f.debt : null;
  var pePos = num(s.pe) && s.pe > 0, pefPos = num(s.pef) && s.pef > 0;
  var lens = val.cash && !val.cash.none ? val.cash.multiple : null;
  var e = s.earnings;
  var dir = !num(s.change) ? "flat" : s.change > 0.005 ? "up" : s.change < -0.005 ? "down" : "flat";
  return {
    rg:    fig(num(k.rg) ? s.rg : null, num(s.rg) ? pct(s.rg) + (k.rgSuspect ? "*" : "") : "n/a"),
    rg5:   fig(s.rg5, num(s.rg5) ? pct(s.rg5) : "n/a"),
    eg:    fig(s.eg, num(s.eg) ? pct(s.eg) : "n/a"),
    gm:    fig(s.gm, num(s.gm) ? pctPlain(s.gm, 0) : "n/a"),
    nm:    fig(s.nm, num(s.nm) ? pctPlain(s.nm, 1) : "n/a"),
    roe:   fig(k.roeOk ? s.roe : null, k.roeOk ? pctPlain(s.roe, 0) : "n/a"),
    fcfm:  fig(fcfm, num(fcfm) ? pctPlain(fcfm, 0) : fin || (num(f.ocf) ? "no capital spending filed" : "n/a")),
    fcf:   fig(fcfOk ? f.fcf : null, fcfOk ? money(f.fcf) : fin || "n/a"),
    net:   fig(net, num(net) ? money(net) : fin || "n/a"),
    years: fig(k.financial ? null : k.debtYears === Infinity ? 1e9 : k.debtYears,
      fin || (num(k.debtYears) ? k.debtYears.toFixed(1) + " yrs" : k.debtYears === Infinity ? "no cash flow" : "n/a")),
    pe:    fig(pePos ? s.pe : null, pePos ? x(s.pe) : k.losing ? "a loss" : "n/a"),
    fair:  fig(val.fair, x(val.fair, 0)),
    pef:   fig(pefPos ? s.pef : null, pefPos ? x(s.pef) : "n/a"),
    /* a REIT's multiple is on operating cash: never marked against another's free cash */
    pfcf:  Object.assign(fig(lens, val.cash ? (val.cash.none ? "no free cash flow" : x(lens, 1) + (val.kind === "ocf" ? " (operating)" : "")) : fin || "n/a"), { kind: val.kind }),
    /* the yield the score uses: one the provider's own figures contradict is not shown as fact */
    dy:    k.dyDisputed ? fig(null, "disputed") : fig(k.dy, num(k.dy) && k.dy > 0 ? pctPlain(k.dy, 2) : "None"),
    price: fig(s.price, price(s.price)),
    day:   fig(null, el("span", "delta small " + dir, num(s.change) ? pct(s.change, 2) : "—")),
    r52:   fig(null, pct(s.r52, 0)),
    mc:    fig(null, cap(s.mc)),
    next:  fig(null, e && e.date && earn.daysUntil(e.date) >= 0 ? dateShort(e.date).replace(/, \d{4}$/, "") : "—")
  };
}

/* [key, label, which way is stronger (1 higher, -1 lower, 0 neither), hint];
   a one-item row is a heading. */
var CMP_ROWS = [
  ["Growth"],
  ["rg", "Revenue, 12 months", 1, "Revenue over the last twelve months against the twelve before. *Far out of line with the five-year trend: for a bank, usually interest income moving with rates."],
  ["rg5", "Revenue, 5-year average", 1, "Average yearly revenue growth over five years."],
  ["eg", "Earnings per share, 12 months", 1, "Earnings per share over the last twelve months against the twelve before."],
  ["Profitability"],
  ["gm", "Gross margin", 1, "What is left of each dollar of sales after the direct cost of making it."],
  ["nm", "Net margin", 1, "Profit after everything, as a share of revenue."],
  ["roe", "Return on equity", 1, "Profit against the shareholders' money in the business. Left out where equity is negative or a sliver."],
  ["Cash and debt"],
  ["fcfm", "Free cash flow, of revenue", 1, "Cash from operations minus capital spending, as a share of revenue."],
  ["fcf", "Free cash flow", 0, "Cash from operations minus capital spending, from the last annual filing."],
  ["net", "Cash minus debt", 0, "Cash less long-term debt at the last fiscal year end. Below zero is net debt."],
  ["years", "Years to repay debt", -1, "Years of operating cash flow it would take to pay off the long-term debt. Under 3 is comfortable."],
  ["Valuation"],
  ["pe", "P/E", -1, "Price against the last twelve months of earnings per share."],
  ["fair", "Fair P/E for its growth", 0, "8 + 1.5 × (growth + dividend yield; growth alone for a REIT), the yield counted up to 8% and the two together up to 25: the P/E its growth would justify, as on the card."],
  ["pef", "Forward P/E", -1, "Price against next year's expected earnings. Analysts' forecasts, not scored."],
  ["pfcf", "Price / free cash flow", -1, "Market value against last year's free cash flow: the cash version of the P/E."],
  ["dy", "Dividend yield", 0, "A year of dividends as a share of the price. Left out where the provider's yield and its payout ratio disagree."],
  ["Price"],
  ["price", "Price", 0],
  ["day", "Day's move", 0],
  ["r52", "Past year", 0, "The share price over the last 52 weeks, without dividends."],
  ["mc", "Market cap", 0],
  ["next", "Next earnings", 0]
];

/* The table both kinds of Compare share: a head with the two picks, each a
   button to swap it, a row of section headings, and rows whose cells can be
   marked as the stronger. */
function cmpTable(picks, word) {
  var table = el("table", "cmp-table");
  table.appendChild(el("caption", "sr-only", picks[0].t + " and " + picks[1].t + " side by side"));
  var head = el("thead");
  var hr = el("tr");
  hr.appendChild(el("td", "cmp-corner"));
  picks.forEach(function (p, side) {
    var th = el("th");
    th.scope = "col";
    var b = el("button", "cmp-co");
    b.type = "button";
    b.setAttribute("aria-label", p.t + ", " + p.n + ": swap for another " + word);
    var top = el("span", "cmp-co-t");
    top.appendChild(el("b", "", p.t));
    top.insertAdjacentHTML("beforeend", SWAP_ICON);      /* a constant */
    b.appendChild(top);
    b.appendChild(el("span", "cmp-name", p.n));
    b.addEventListener("click", function () { openPicker(side); });
    th.appendChild(b);
    hr.appendChild(th);
  });
  head.appendChild(hr);
  table.appendChild(head);

  var tbody = el("tbody");
  table.appendChild(tbody);
  function section(title) {
    var tr = el("tr", "cmp-sec");
    var th = el("th", "", title);
    th.scope = "colgroup";
    th.colSpan = picks.length + 1;
    tr.appendChild(th);
    tbody.appendChild(tr);
  }
  /* cells: one per pick, each a string or a node; best: the cells to mark */
  function row(label, cells, best, hint) {
    var tr = el("tr");
    var th = el("th", "", label);
    th.scope = "row";
    if (hint) th.title = hint;
    tr.appendChild(th);
    cells.forEach(function (c, i) {
      var td = el("td", best && best[i] ? "is-top" : "");
      if (c && c.nodeType) td.appendChild(c); else td.textContent = c;
      /* not by colour alone: bold on screen, and said to a screen reader */
      if (best && best[i]) td.appendChild(el("span", "sr-only", " (stronger)"));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
    return tr;
  }
  return { table: table, tbody: tbody, section: section, row: row };
}

/* the stronger of the two, when both have the figure and they differ */
function stronger(vals, way) {
  if (!way || !num(vals[0]) || !num(vals[1]) || vals[0] === vals[1]) return null;
  var left = way > 0 ? vals[0] > vals[1] : vals[0] < vals[1];
  return [left, !left];
}

function cmpMeter(v) {
  var wrap = el("span");
  wrap.appendChild(el("span", "", num(v) ? String(Math.round(v)) : "n/a"));
  var m = el("span", "cmp-meter");
  var fill = el("i");
  fill.style.width = num(v) ? clamp(v, 0, 100) + "%" : "0";
  m.appendChild(fill);
  wrap.appendChild(m);
  return wrap;
}

/* The words around the table, for companies or for funds. The company ones
   are exactly those in index.html. */
var CMP_WORDS = {
  stocks: ["Two companies, head to head", "Tap either company to swap it. On each row the stronger figure is in blue.",
    "Not investment advice. The score describes the latest filings; it does not predict the price."],
  etfs: ["Two funds, head to head", "Tap either fund to swap it. On each row the stronger figure is in blue; funds are only ever set against funds.",
    "Not investment advice. A fund reading describes its last holdings filing and its fee; it does not predict the price."]
};

function renderCompare() {
  var words = CMP_WORDS[compareKind()];
  $("#cmpHeadNote").textContent = words[0];
  $("#cmpHelp").textContent = words[1];
  $("#cmpFoot").textContent = words[2];
  if (compareKind() === "etfs") { renderFundCompare(); return; }
  var body = $("#cmpBody");
  body.innerHTML = "";
  var note = $("#cmpStyle");
  note.innerHTML = "";
  note.appendChild(styleLine(styleById(state.style)));
  if (!state.all.length) {
    body.appendChild(el("p", "block-note", "Loading the S&P 500…"));
    return;
  }

  var cols = comparePair().map(function (t) {
    var s = state.byTicker[t];
    return { s: s, res: scoreStock(s, state.scoreCtx, state.style), fig: cmpFigures(s) };
  });

  var t = cmpTable(cols.map(function (c) { return c.s; }), "company");
  var table = t.table, tbody = t.tbody, section = t.section, row = t.row, meter = cmpMeter;

  section("Score");
  row("Score", cols.map(function (c) {
    var box = el("span");
    box.appendChild(el("b", "cmp-big", num(c.res.overall) ? String(c.res.overall) : "—"));
    box.appendChild(el("span", "cmp-sub", scoreLabel(c.res.overall).word));
    return box;
  }), stronger(cols.map(function (c) { return c.res.overall; }), 1),
    "Its place in the S&P 500, 1 to 99: better than that share of the index.");
  row("In its sector", cols.map(function (c) {
    /* "#2 of 73", and the sector under it in small type */
    var m = (sectorRankText(c.res.place) || "").match(/^(#\d+ of \d+) in (.+)$/);
    if (!m) return "—";
    var box = el("span");
    box.appendChild(el("span", "", m[1]));
    box.appendChild(el("span", "cmp-sub", m[2]));
    return box;
  }));
  var styled = state.style !== DEFAULT_STYLE;
  var weighed = cols.map(function (c) { return styleFactors(c.res.factors, state.style); });
  weighed[0].forEach(function (f, i) {
    var vals = weighed.map(function (list) { return list[i].value; });
    row(f.label + (styled ? " · " + Math.round(f.weight * 100) + "%" : ""), vals.map(meter),
      stronger(vals.map(function (v) { return num(v) ? Math.round(v) : null; }), 1), f.blurb);
  });

  CMP_ROWS.forEach(function (r) {
    if (r.length === 1) { section(r[0]); return; }
    var figs = cols.map(function (c) { return c.fig[r[0]]; });
    var way = r[0] === "pfcf" && figs[0].kind !== figs[1].kind ? 0 : r[2];
    /* two figures that print alike are not told apart, as on the factor rows */
    if (typeof figs[0].t === "string" && figs[0].t === figs[1].t) way = 0;
    /* "Day's move on Oct 13" once that close is no longer today's, as the
       card says it; in the label, since both columns share the session */
    var label = r[0] === "day" && sessionWord() !== "today" ? r[1] + " " + sessionWord() : r[1];
    row(label, figs.map(function (g) { return g.t; }), stronger(figs.map(function (g) { return g.v; }), way), r[3]);
  });

  row("Full record", cols.map(function (c) {
    var b = el("button", "link-btn", "Open " + c.s.t);
    b.type = "button";
    b.addEventListener("click", function () { openDetail(c.s); });
    return b;
  }));

  body.appendChild(table);
}

/* Fund against fund: the reading and its three parts, what each costs, what
   each owns and how much of it the two hold in common, the funds' own facts
   and their prices. The stronger mark only ever compares two funds. */
function renderFundCompare() {
  var body = $("#cmpBody");
  body.innerHTML = "";
  var note = $("#cmpStyle");
  note.innerHTML = "";
  note.appendChild(styleLine(styleById(state.style)));

  var cols = comparePair().map(function (t) {
    var f = state.byTicker[t];
    return { f: f, r: fundReading(f) };
  });
  var t = cmpTable(cols.map(function (c) { return c.f; }), "fund");
  var section = t.section, row = t.row;
  var vals = function (get) { return cols.map(function (c) { var v = get(c); return num(v) ? v : null; }); };
  var shown = function (get, fmt) { return cols.map(function (c) { var v = get(c); return num(v) ? fmt(v) : "n/a"; }); };

  section("Fund reading");
  /* a reading without its fee is a different blend (60/40), so two readings
     are marked against each other only when both fees have been read */
  var alike = cols.every(function (c) { return funds.costRead(c.r); });
  row("Fund reading", cols.map(function (c) {
    var box = el("span");
    if (num(c.r.overall)) {
      box.appendChild(el("b", "cmp-big", String(c.r.overall)));
      box.appendChild(el("span", "cmp-sub", scoreLabel(c.r.overall).word));
    } else {
      /* no number, so no "—": what it is instead, as on its card */
      var brief = c.r.brief || { word: "Not read in full", detail: "" };
      box.appendChild(el("b", "cmp-brief", brief.word));
      box.appendChild(el("span", "cmp-sub", brief.detail || "No overall reading"));
    }
    return box;
  }), alike ? stronger(vals(function (c) { return c.r.overall; }), 1) : null,
    "What it owns, what it costs and how spread out it is, each on a fixed scale. Only for a fund read in full; never a place among companies." +
    (alike ? "" : " Not marked: a fee has not been read, so the two are not weighed alike."));
  [0, 1, 2].forEach(function (i) {
    var f0 = cols[0].r.factors[i];
    var v = vals(function (c) { return c.r.factors[i].score; });
    row(f0.label, v.map(cmpMeter), stronger(v.map(function (x) { return num(x) ? Math.round(x) : null; }), 1),
      f0.id === "hold" ? "Its holdings, read through our company scores in the style chosen; the part we cannot score counts as 50."
        : f0.id === "cost" ? "The expense ratio on a fixed curve: 0.03% reads 94, 0.35% reads 50."
        : "The effective number of holdings and the weight of the largest ten.");
  });

  section("What it costs");
  row("Expense ratio", cols.map(function (c) { return num(c.f.er) ? funds.fmtEr(c.f.er) : "Not read"; }),
    stronger(vals(function (c) { return c.f.er; }), -1), "Taken from the fund every year, whatever it does.");
  row("A year on $10,000", shown(function (c) { return funds.perTenK(c.f.er); }, funds.dollars),
    stronger(vals(function (c) { return funds.perTenK(c.f.er); }), -1));
  row("Ten years on $10,000", shown(function (c) { return funds.tenYearCost(c.f.er); }, funds.dollars),
    stronger(vals(function (c) { return funds.tenYearCost(c.f.er); }), -1),
    "What the fee takes from $10,000 growing 7% a year before it.");

  section("What it owns");
  /* one figure for the pair, across both columns */
  var o = funds.overlap(cols[0].f, cols[1].f);
  var otr = row("Overlap", [num(o) ? Math.round(o) + "% of their holdings in common" : "n/a"], null,
    "The sum, over the companies both hold, of the smaller of the two weights: 100% would be the same companies at the same weights. Over what each filing let us match.");
  otr.lastChild.colSpan = 2;
  otr.lastChild.className = "cmp-span";
  row("Holdings", shown(function (c) { return c.f.nport && c.f.nport.count; }, function (v) { return v.toLocaleString("en-US"); }));
  row("Behaves like", shown(function (c) { return c.r.spread && c.r.spread.effN; }, function (v) { return "about " + Math.round(v); }),
    stronger(vals(function (c) { return c.r.spread && Math.round(c.r.spread.effN); }), 1),
    "The number of equal holdings that would be as concentrated: one over the sum of the squared weights.");
  row("Largest ten", shown(function (c) { return c.r.spread && c.r.spread.top10; }, function (v) { return pctPlain(v, 0); }),
    stronger(vals(function (c) { return c.r.spread && Math.round(c.r.spread.top10); }), -1));
  row("Largest holding", cols.map(function (c) {
    var sp = c.r.spread;
    return sp && num(sp.big1) ? (sp.big1T ? sp.big1T + " " : "") + pctPlain(sp.big1, 1) : "n/a";
  }), stronger(vals(function (c) { return c.r.spread && Math.round(c.r.spread.big1 * 10); }), -1));
  row("Matched to S&P 500 companies", shown(function (c) { return c.f.cover; }, function (v) { return pctPlain(v, 0); }), null,
    "The share of its stock holdings we could match to a company we score. Under 80% and there is no overall reading.");
  row("P/E, its companies together", shown(function (c) { return c.r.look && c.r.look.pe; }, function (v) { return x(v, 1); }), null,
    "A harmonic mean weighted as the fund holds them. Shown, not part of the reading.");
  row("Dividend yield, together", shown(function (c) { return c.r.look && c.r.look.dy; }, function (v) { return pctPlain(v, 2); }), null,
    "Its companies' yields weighted as the fund holds them; not the fund's own distribution. Shown, not part of the reading.");
  row("Holdings as of", cols.map(function (c) { return c.f.nport && c.f.nport.period ? dateShort(c.f.nport.period) : "—"; }));

  section("The fund");
  /* a total across share classes says so, as on the card */
  row("Net assets", shown(function (c) { return c.f.nport && c.f.nport.assets; }, money).map(function (t, i) {
    var n = cols[i].f.nport;
    return n && num(n.assets) && n.assetsScope === "series" ? t + ", all share classes" : t;
  }), null, "From its last N-PORT filing. For a fund with several share classes, the fund's total across all of them.");
  row("Issuer", cols.map(function (c) { return c.f.issuer || "—"; }));
  row("Launched", cols.map(function (c) { return num(c.f.since) ? String(c.f.since) : "—"; }));

  section("Price");
  row("Price", cols.map(function (c) { return price(c.f.price) + (num(c.f.price) ? fundDayNote(c.f) : ""); }));
  /* dated in the label as on the company side; a fund whose own quote is
     from another day says so in its cell */
  var fdayIso = state.fundsSession || snapshotDay(), fday = sessionWord(fdayIso);
  row("Day's move" + (fday !== "today" ? " " + fday : ""), cols.map(function (c) {
    var dir = !num(c.f.change) ? "flat" : c.f.change > 0.005 ? "up" : c.f.change < -0.005 ? "down" : "flat";
    return el("span", "delta small " + dir, num(c.f.change) ? pct(c.f.change, 2) + (fundDay(c.f) !== fdayIso ? fundDayNote(c.f) : "") : "—");
  }));
  row("Past year", cols.map(function (c) { return pct(c.f.r52, 0); }), null, "The fund's price over the last 52 weeks, without its distributions.");

  row("Full record", cols.map(function (c) {
    var b = el("button", "link-btn", "Open " + c.f.t);
    b.type = "button";
    b.addEventListener("click", function () { openDetail(c.f); });
    return b;
  }));

  body.appendChild(t.table);
}

/* ======================================================= TRACK RECORD ===
   The weekly groups scripts/track.mjs follows, newest first, as on the
   /track page. Fetched the first time the tab is shown. */

var MEANINGFUL_DAYS = 60;       /* about three months of sessions, as on /track */
var trackLoad = null;

function showTrack() {
  if (trackLoad) return;
  trackLoad = native.dataFetch("data/track.json", { cache: "no-cache" })
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

/* ------------------------------------------------------- scoring style ---
   The same five factors weighted the way a known investor has said matters
   (STYLES in lib/analysis.mjs). The choice applies at once, behind the
   sheet, so the score on the card can be watched changing. */

/* "Scored in the Balanced style. Try another style" */
function styleLine(st) {
  var p = el("p", "style-line");
  p.appendChild(document.createTextNode(st.id === DEFAULT_STYLE ? "Scored in the Balanced style. "
    : "Scored in the " + st.label + " style, after " + st.after + ". "));
  var b = el("button", "link-btn", st.id === DEFAULT_STYLE ? "Try another style" : "Change");
  b.type = "button";
  b.addEventListener("click", openStyles);
  p.appendChild(b);
  return p;
}

function weightsText(st) {
  return styleFactors(null, st.id).map(function (f) { return f.label + " " + Math.round(f.weight * 100) + "%"; }).join(" · ");
}

function openStyles() {
  var list = $("#styleList");
  Array.prototype.slice.call(list.querySelectorAll(".style-opt")).forEach(function (n) { n.remove(); });
  STYLES.forEach(function (st) {
    var opt = el("label", "style-opt");
    var input = el("input");
    input.type = "radio";
    input.name = "scoreStyle";
    input.value = st.id;
    input.checked = st.id === state.style;
    input.addEventListener("change", function () { if (input.checked) chooseStyle(st.id); });
    opt.appendChild(input);
    var txt = el("span", "style-txt");
    txt.appendChild(el("b", "", st.label));
    if (st.after) txt.appendChild(el("span", "style-after", "After " + st.after + ", from " + st.source));
    txt.appendChild(el("span", "style-blurb", st.blurb));
    txt.appendChild(el("span", "style-weights", weightsText(st)));
    opt.appendChild(txt);
    list.appendChild(opt);
  });
  openDialog($("#dlgStyle"));
}

function chooseStyle(id) {
  state.style = styleById(id).id;
  save(LS.style, state.style);
  if (state.all.length) renderDeck();
  renderAccountTab();
  if (view === "compare") renderCompare();
  if ($("#dlgDetail").open && detailTicker && state.byTicker[detailTicker]) openDetail(state.byTicker[detailTicker]);
}

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

/* The top bar says "Not investment advice" on every tab, and the date of the
   prices only once it has gone stale: a nightly run that stopped is the one
   time the date needs saying. The card says which close its move is from. */
var STALE_DAYS = 4;          /* a Friday close read on the Tuesday after a holiday is still the latest */

function snapshotDay() {
  return state.session || (state.updated ? String(state.updated).slice(0, 10) : null);
}

function renderDataAge() {
  var box = $("#dataAge");
  var day = snapshotDay();
  var age = day ? Math.floor((Date.now() - Date.parse(day + "T12:00:00Z")) / 864e5) : null;
  box.hidden = !(age > STALE_DAYS);
  var shown = dateShort(day);
  if (shown.slice(-4) === String(new Date().getFullYear())) shown = shown.replace(/, \d{4}$/, "");
  box.textContent = box.hidden ? "" : "Prices from " + shown;
  box.title = state.updated ? "Not updated since " + new Date(state.updated).toLocaleString() : "";
}

/* "today" while the snapshot is today's close, "on Oct 6" after that; for
   `day`, if given, in place of the snapshot's */
function sessionWord(day) {
  day = day || snapshotDay();
  var today = earn.localDay(Date.now());     /* YYYY-MM-DD on the viewer's calendar, as report days are counted */
  return !day || day === today ? "today" : "on " + dateShort(day).replace(/, \d{4}$/, "");
}

/* Why the companies did not load: "missing" (no snapshot file) and "empty"
   (a file with no companies) say the copy has no data yet; anything else is
   "failed", a file that did not arrive (offline, cut short, a server error,
   unreadable). */
function snapshotProblem(err) {
  return err && (err.message === "missing" || err.message === "empty") ? err.message : "failed";
}

function setupScreen(reason) {
  /* The setup steps below are for whoever runs a copy of the site on their
     own computer with no data in it yet ("missing" or "empty"). Everyone
     else is offered another try: anyone not on localhost (stockornot.com,
     a preview, a phone on the local network), anyone whose file did not
     arrive ("failed"), and the app, which holds its own copy of the data,
     so getting here means neither that nor the website answered; its own
     address is localhost too, hence the inApp check. */
  var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (native.inApp || !local || reason === "failed") {
    showMessage("Couldn't load the companies", "Check the connection, then try again.",
      [{ label: "Retry", onClick: function () { location.reload(); } }]);
    return;
  }
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

  /* the app: links open on the website, a tapped reminder opens the Earnings
     sheet once the companies are there, and coming back to the foreground
     brings the reminders up to date */
  native.routeLinks();
  native.onNotificationTap(function (extra) {
    if (extra && extra.open && extra.open !== "earnings") return;
    whenLoaded(openEarnings);
  });
  native.onResume(scheduleReminders);

  Array.prototype.forEach.call(document.querySelectorAll("#tabbar [data-view]"), function (a) {
    a.addEventListener("click", function (ev) {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button) return;   /* a new browser tab */
      ev.preventDefault();
      go(a.getAttribute("data-view"));
    });
  });
  /* The sign-in library takes its tokens out of the address once it has
     read them, firing popstate and hashchange as it does. That is not the
     reader asking for the deck: the tab they are on stays, once. */
  var fromCallback = auth.isAuthCallback();
  function followUrl() {
    if (fromCallback && !location.hash.slice(1)) {
      fromCallback = false;
      if (view !== "deck") { try { history.replaceState(null, "", "#" + view); } catch (e) {} }
      return;
    }
    var v = viewInUrl();
    if (v !== view) showView(v);
  }
  window.addEventListener("popstate", followUrl);
  window.addEventListener("hashchange", followUrl);
  $("#acctAlerts").addEventListener("click", openEarnings);
  $("#acctStyle").addEventListener("click", openStyles);
  /* Stocks | ETFs, on the deck and in Compare (shown only once there are funds) */
  $("#kindSwitch").addEventListener("click", function (ev) {
    var chip = ev.target.closest("[data-kind]");
    if (chip) chooseKind(chip.getAttribute("data-kind"));
  });
  $("#cmpKind").addEventListener("click", function (ev) {
    var chip = ev.target.closest("[data-kind]");
    if (chip) chooseCompareKind(chip.getAttribute("data-kind"));
  });
  $("#pickInput").addEventListener("input", renderPickList);
  $("#pickInput").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    var hit = findCompanies(ev.target.value)[0];
    if (hit) setSide(pickSide, hit.t);
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
    fitDeck();
  });
  window.addEventListener("resize", fitDeck);
  $("#btnIcs").addEventListener("click", cartIcs);
  $("#earnLocal").addEventListener("change", function () { setLocalNotify($("#earnLocal").checked); });
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
  $("#detailShare").addEventListener("click", shareDetail);
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
  ["authPendingStep", "authEmailStep", "authCodeStep", "authPassStep", "authSignedIn"].forEach(function (id) {
    $("#" + id).hidden = id !== which;
  });
  /* "Delete everything" is only ever offered to the person who just asked for it */
  $("#acctDeleteConfirm").hidden = true;
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
  var st = styleById(state.style);
  $("#acctStyleNote").textContent = st.label + (st.after ? ", after " + st.after : ", the standard score");
  /* While everything is free there is nothing to join, and a row leading to a
     page that cannot take payment reads as unfinished (App Review sends those
     back), so it stays out of sight until membership opens, and in the app
     for good. */
  $("#acctMember").hidden = tier.UNLIMITED;
  $("#acctPlan").textContent = tier.TIER_LABEL[state.tier] + (state.tier === "member" ? "" : " · see what membership adds");
  if (!on) return;
  $("#authTitle").textContent = state.user ? "Signed in" : "Keep your cart";
  if (state.user) {
    $("#authWho").textContent = state.user.email || "your account";
    if ($("#authSignedIn").hidden) showAuthStep("authSignedIn");
  } else if (state.authPending) {
    showAuthStep("authPendingStep");
  } else if (!$("#authSignedIn").hidden || !$("#authPendingStep").hidden) {
    /* only a panel still saying "signed in" or "checking" needs to change;
       resetting any other step would wipe a message or a half-typed code.
       After someone signs out, the agreement and the address are the next
       person's to give. */
    if (!$("#authSignedIn").hidden) { $("#authAgree").checked = false; $("#authEmail").value = ""; }
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
  auth.tidyAsked();
  if (!auth.isConfigured()) return;

  var pending = "";
  /* a sign-in that happens on this page load (a link or a code), as opposed
     to a session restored from storage */
  var fresh = auth.isAuthCallback();
  var fromLink = fresh;
  var linkError = auth.callbackError();
  /* a sign-in link asked for from "Turn them off" comes back to ?alerts=off */
  if (fresh && /[?&]alerts=off(&|$)/.test(location.search)) alertsOffAt = Date.now();
  var whoShown = false;
  /* The app signs in with the emailed code: the link in the same email opens
     the website in Safari (lib/auth.mjs), which cannot sign the app in. */
  var sendLabel = native.inApp ? "Email me a code" : "Email me a sign-in link";
  $("#authSend").textContent = sendLabel;

  /* A link signed this browser in, but nobody asked for one here: say whose
     account it is, so a link someone sent for their own account cannot
     quietly collect what you add to the cart. */
  function sayWho(user) {
    if (whoShown || !fromLink || !user) return;
    whoShown = true;                      /* checked once, shown at most once */
    var asked = auth.linkWasAsked(user.email);
    auth.forgetAsked();                   /* it has done its job */
    if (asked) return;
    /* at the top of the screen: at the bottom its Sign out would sit exactly
       where Add to cart is, for twenty seconds */
    $("#toast").classList.add("toast-top");
    showToast("Signed in as " + (user.email || "an account you did not ask for") + ". Not you?",
      "Sign out", function () { signOutAndForget().then(function () { renderAccountTab(); }); }, 20000);
  }

  $("#authEmailStep").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = $("#authEmail").value.trim();
    if (!email) return;
    /* an account is created on first sign-in, so agreeing comes first, every time */
    if (!$("#authAgree").checked) return authError("Tick the box to agree to the terms first.");
    /* App Review's account: a password, since the reviewer cannot read our mail */
    if (auth.isReviewEmail(email)) {
      pending = email;
      $("#authPassWho").textContent = email;
      showAuthStep("authPassStep");
      $("#authPass").focus();
      return;
    }
    var btn = $("#authSend");
    btn.disabled = true; btn.textContent = "Sending…";
    /* asked for from "Turn them off": the link comes back to finish that */
    var alertsOff = !!alertsOffAt && Date.now() - alertsOffAt < ALERTS_OFF_FOR_MS;
    auth.sendCode(email, { alertsOff: alertsOff }).then(function (r) {
      btn.disabled = false; btn.textContent = sendLabel;
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
    /* six digits by default; Supabase can be set to send up to ten */
    if (!/^\d{6,10}$/.test(code)) {
      return authError(native.inApp ? "Type the code from the email."
        : "Paste the code from the email, or just click the link in it instead.");
    }
    var btn = $("#authVerify");
    btn.disabled = true; btn.textContent = "Signing in…";
    fresh = true;
    auth.verifyCode(pending, code).then(function (r) {
      btn.disabled = false; btn.textContent = "Sign in with the code";
      if (!r.ok) return authError(r.error);
      $("#authCode").value = "";
      /* the record that a link was asked for has done its job, and
         privacy.html promises it does not outlive the sign-in */
      auth.forgetAsked();
    });
  });

  $("#authBack").addEventListener("click", function () {
    $("#authCode").value = "";
    showAuthStep("authEmailStep");
  });

  $("#authPassStep").addEventListener("submit", function (e) {
    e.preventDefault();
    var pass = $("#authPass").value;
    if (!pass) return authError("Enter the password from the App Review notes.");
    var btn = $("#authPassGo");
    btn.disabled = true; btn.textContent = "Signing in…";
    fresh = true;
    auth.signInForReview(pending, pass).then(function (r) {
      btn.disabled = false; btn.textContent = "Sign in";
      $("#authPass").value = "";
      if (!r.ok) return authError(r.error);
      /* a code asked for earlier, for another address before going back
         to the address step, is forgotten here too: privacy.html promises
         the record does not outlive the sign-in */
      auth.forgetAsked();
    });
  });

  $("#authPassBack").addEventListener("click", function () {
    $("#authPass").value = "";
    showAuthStep("authEmailStep");
  });

  /* everything kept about you, as a file: the account, the saved cart and
     alerts, and what this browser holds */
  $("#acctExport").addEventListener("click", function () {
    var btn = $("#acctExport");
    btn.disabled = true; btn.textContent = "Gathering…";
    authError("");
    auth.myData().then(function (r) {
      btn.disabled = false; btn.textContent = "Download my data";
      if (!r.ok) return authError(r.error);
      var out = {
        exported_at: new Date().toISOString(),
        from: "StockOrNot (stockornot.com)",
        stored_in_your_account: r.data,
        stored_in_this_browser: {
          cart: cartRecords(),
          scoring_style: state.style,
          cards_swiped_past: state.seen.length,
          compare: load(CMP_KEY, null),
          /* every StockOrNot setting as stored. The sign-in session is left
             out: it is a key to the account, not information about you. */
          all_settings: storedSettings()
        }
      };
      /* a download on the website, the share sheet in the app */
      native.saveFile("stockornot-my-data-" + earn.localDay(Date.now()) + ".json",
        "application/json", JSON.stringify(out, null, 2)).then(function (result) {
        if (result === "failed") authError("The file could not be saved. Try again.");
      });
    });
  });

  function storedSettings() {
    var out = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("ts.") === 0) out[k] = localStorage.getItem(k);
      }
    } catch (e) { /* storage off */ }
    return out;
  }

  $("#acctDelete").addEventListener("click", function () {
    authError("");
    $("#acctDeleteConfirm").hidden = false;
    $("#acctDeleteKeep").focus();
  });
  $("#acctDeleteKeep").addEventListener("click", function () { $("#acctDeleteConfirm").hidden = true; });
  $("#acctDeleteGo").addEventListener("click", function () {
    var btn = $("#acctDeleteGo");
    var owned = !!(state.user && state.cartOwner === state.user.id);
    btn.disabled = true; btn.textContent = "Deleting…";
    auth.deleteAccount().then(function (r) {
      btn.disabled = false; btn.textContent = "Delete everything";
      if (!r.ok) { $("#acctDeleteConfirm").hidden = true; return authError(r.error); }
      /* the account's copy of the cart is gone, so this browser's goes too,
         and the brokerage cookie with it, as on signing out */
      clearTimeout(sync.timer); clearTimeout(sync.retryTimer);
      broker.disconnect().then(function (b) {
        if (b.ok) state.broker = b.data;
        portfolio = null;
        renderBrokerPanel(); renderOrderBar();
      });
      /* as on signing out: a cart that never joined the account stays, and
         the cart is emptied before the owner changes */
      if (owned) {
        setCart([]);
        save(LS.cart, []);
        setCartOwner("");
        cartChanged();
      }
      $("#acctDeleteConfirm").hidden = true;
      state.user = null;
      refreshTier();
      renderAccountTab();
      showToast("Your account and everything in it has been deleted.");
    });
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
      /* offline with an access token that has run out, the library reports
         nobody but keeps the session; a refused refresh removes it */
      user = user || auth.storedUser();
      var same = user && state.user && state.user.id === user.id;
      state.user = user;
      state.authPending = false;
      renderAccountTab();
      if ($("#dlgEarnings").open) renderEmailToggle();
      setSyncNote("saved");
      refreshTier();
      if (user) {
        auth.tidyUrl();
        /* token refreshes arrive here too; only a new person needs the check */
        if (!same) { ensureCartOwner(user, fresh); sayWho(user); alertsOffAfterSignIn(user); }
      }
    });

    auth.currentUser().then(function (user) {
      user = user || auth.storedUser();
      var same = user && state.user && state.user.id === user.id;
      state.authPending = false;
      state.user = user;
      refreshTier();
      renderAccountTab();
      if ($("#dlgEarnings").open) renderEmailToggle();
      auth.tidyUrl();
      if (user && !same) { ensureCartOwner(user, fresh); sayWho(user); alertsOffAfterSignIn(user); }
      if (!user && linkError) {
        openAuth();
        showAuthStep("authEmailStep");
        authError(linkError);
      }
    });
  }
}

/* Things that need the companies (a tapped reminder, before they have
   loaded), run once they are there. */
var loaded = false;
var afterLoad = [];
function whenLoaded(fn) { if (loaded) fn(); else afterLoad.push(fn); }

function init() {
  state.viewed = tier.loadViewed();
  wire();
  /* Opened from the home screen, the site can open with no signal on the last
     data it saw (sw.js, network first). That copy is kept only for someone who
     installed it: a visit in a browser tab stores nothing it did not ask for,
     and a worker or copy left by an earlier visit is removed. Over https, and
     on localhost for development. Not in the iPhone app, which carries its
     files and has no sw.js. */
  if (!native.inApp && "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    var installed = navigator.standalone === true ||
      Boolean(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    if (installed) navigator.serviceWorker.register("/sw.js").catch(function () {});
    else {
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        regs.forEach(function (r) { r.unregister(); });
      }).catch(function () {});
      /* a worker keeps the page it already controls until that page closes, and
         may refill its copy meanwhile, so the copy goes on the first load that
         no worker controls */
      if (!navigator.serviceWorker.controller && window.caches) caches.delete("stockornot-v1").catch(function () {});
    }
  }
  /* Decided synchronously, before any network call: either a session is already
     in storage or this page load is the return leg of a sign-in link. Either
     way somebody is signed in, and the account tab should not claim otherwise. */
  state.authPending = auth.isConfigured() && (auth.hasStoredSession() || auth.isAuthCallback());
  /* read now: the sign-in library tidies the address before the companies load */
  var linkFailed = !!auth.callbackError();
  wireAuth();
  renderAccountTab();
  renderCartCount();
  showView(viewInUrl());
  showMessage("Loading the S&P 500…", "Pulling the latest snapshot.", []);

  /* the funds load beside the snapshot and join it once it is in, or once
     their time is up (fundsInTime) */
  var fundsFile = fetchFunds(), fundsBy = Date.now() + FUNDS_WAIT_MS;
  loadSnapshot()
    .catch(function (err) {
      /* only data problems land on the setup screen — a render bug should throw */
      console.warn("snapshot:", err);
      renderDataAge();
      setupScreen(snapshotProblem(err));
      return null;
    })
    .then(function (snap) {
      return snap && fundsInTime(fundsFile, fundsBy).then(function (file) { useFunds(file); return snap; });
    })
    .then(function (snap) {
      if (!snap) return;
      renderDataAge();
      setInterval(renderDataAge, 60000);

      /* a company page links in with ?t=TICKER — start the deck on that one.
         A fund's link opens the funds' deck, a company's the companies',
         for this visit, without changing the switch's saved setting. */
      var want = new URLSearchParams(location.search).get("t");
      var wt = want ? want.toUpperCase() : null;
      var hit = wt && state.byTicker[wt];
      if (hit) {
        var kind = funds.isFund(hit) ? "etfs" : "stocks";
        if (kind !== deckKind()) { state.kind = kind; renderKinds(); }
      }
      buildDeck();
      if (hit) {
        state.deck = [wt].concat(state.deck.filter(function (t) { return t !== wt; }));
        state.cursor = 0;
      }

      renderDeck();
      renderEarnNotice();
      /* a tab opened before the prices arrived is drawn again with them */
      if (view === "cart") renderCart();
      else if (view === "compare") renderCompare();
      brokerReturn();
      loaded = true;
      afterLoad.splice(0).forEach(function (fn) { fn(); });

      /* "Turn them off" in an alert email lands here: open the alert settings
         straight away (signing in first, if need be, is part of that dialog) */
      if (new URLSearchParams(location.search).get("alerts") === "off") {
        /* a sign-in link sent from here comes back to this address too: its
           tokens stay until the sign-in library has read them */
        history.replaceState(null, "", location.pathname + (auth.isAuthCallback() ? location.hash : ""));
        alertsOffLink = true;
        /* an expired or used link: the sign-in form says so, and the sheet
           would cover it */
        if (!linkFailed) openEarnings();
      }
    });
}

/* The last leg of "Connect with Alpaca" lands here with ?broker=<outcome>. */
function brokerReturn() {
  if (native.inApp) return;
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

