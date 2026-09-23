/* ==========================================================================
   The cart as a set of records that several copies can agree on.

   The same cart lives in up to three places at once: this tab, other tabs of
   this browser (localStorage), and the account (Supabase, when signed in).
   Any of them can be edited while another is out of date, so a plain union
   brings removed companies back and an older copy can undo a newer edit.

   Instead every record carries updatedAt, and a removal leaves a small
   tombstone { t, deletedAt, updatedAt } rather than vanishing. Merging keeps,
   for each ticker, whichever record was written last, so an edit or a
   removal made anywhere wins over anything older, wherever that copy was.
   Tombstones are never shown and are dropped after GONE_DAYS, by which time
   every copy that could still hold the old record has long been merged.
   ========================================================================== */

export const GONE_DAYS = 60;

const stamp = (i) => i.updatedAt || i.deletedAt || i.addedAt || "";

export const isRecord = (i) => Boolean(i && typeof i === "object" && typeof i.t === "string" && i.t);

export function tombstone(t, at = new Date().toISOString()) {
  return { t, deletedAt: at, updatedAt: at };
}

/** Live items (newest first) and tombstones, from any stored list. */
export function split(items) {
  const live = [], gone = [];
  for (const i of Array.isArray(items) ? items : []) {
    if (!isRecord(i)) continue;
    (i.deletedAt ? gone : live).push(i);
  }
  return { live, gone };
}

/* Records written before updatedAt existed carry only addedAt. Two of those
   for the same ticker are the same company added on two devices, so keep the
   earlier add and let a written note or amount from either side fill a blank. */
function fillLegacy(into, other) {
  if (other.addedAt && (!into.addedAt || other.addedAt < into.addedAt)) {
    into.addedAt = other.addedAt;
    if (other.priceAtAdd != null) into.priceAtAdd = other.priceAtAdd;
  }
  if (!into.note && other.note) into.note = other.note;
  if (!(into.amount > 0) && other.amount > 0) into.amount = other.amount;
}

/**
 * One cart from two copies. Per ticker, the record written last wins; on a
 * tie, the local one. Local records are kept as the same objects when they
 * win, so the page's references to them stay good.
 */
export function mergeCarts(local, remote, now = Date.now()) {
  const out = new Map();
  const put = (item, isLocal) => {
    if (!isRecord(item)) return;
    const seen = out.get(item.t);
    if (!seen) { out.set(item.t, isLocal ? item : { ...item }); return; }
    const legacy = !seen.updatedAt && !item.updatedAt && !seen.deletedAt && !item.deletedAt;
    if (legacy) {
      const keep = isLocal ? item : seen;
      fillLegacy(keep, isLocal ? seen : item);
      out.set(item.t, keep);
      return;
    }
    const a = stamp(seen), b = stamp(item);
    if (b > a || (b === a && isLocal)) out.set(item.t, isLocal ? item : { ...item });
  };
  for (const i of remote || []) put(i, false);
  for (const i of local || []) put(i, true);

  const cutoff = new Date(now - GONE_DAYS * 864e5).toISOString();
  const { live, gone } = split([...out.values()]);
  live.sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));
  return [...live, ...gone.filter((g) => g.deletedAt >= cutoff).sort((a, b) => (a.t < b.t ? -1 : 1))];
}

/* Stable text for a list of records, for telling whether two copies differ
   in anything at all (a note, an amount, a tombstone), not just in tickers. */
function canonical(items) {
  const sortKeys = (o) => Object.keys(o).sort().reduce((acc, k) => {
    const v = o[k];
    if (v !== undefined) acc[k] = v && typeof v === "object" && !Array.isArray(v) ? sortKeys(v) : v;
    return acc;
  }, {});
  return JSON.stringify((items || []).filter(isRecord).map(sortKeys).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)));
}

export const sameCart = (a, b) => canonical(a) === canonical(b);
