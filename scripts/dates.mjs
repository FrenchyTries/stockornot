/* ==========================================================================
   Market dates.

   Prices belong to a US trading session, which is a New York date. The
   refresh finishes after midnight UTC, so the UTC date of a run labelled
   Friday's close "Saturday". These turn a timestamp into the session it
   describes: the New York date, stepped back to the previous weekday when
   the moment is before that day's 9:30 open or on a weekend. Holidays are
   not modelled; a quote timestamp from the provider avoids them anyway.
   ========================================================================== */

const NY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false
});

function nyParts(d) {
  const p = Object.fromEntries(NY.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

function stepBack(iso) {
  const d = new Date(iso + "T12:00:00Z");
  do d.setUTCDate(d.getUTCDate() - 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/** The trading session a moment belongs to, as YYYY-MM-DD. */
export function sessionDate(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (isNaN(d)) return null;
  const { date, minutes } = nyParts(d);
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  if (dow === 0 || dow === 6 || minutes < 9 * 60 + 30) return stepBack(date);
  return date;
}
