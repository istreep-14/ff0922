/**
 * How every number on the page is written — one place, so the same value
 * cannot read `12.0` on one page and `12` on the next (docs/components.md §3.7).
 *
 * The page had six formatters (`fmt`, `num`, `pts2`, `prFmt`, `signed`,
 * `rate`) that grew one page at a time; they are now thin names over these.
 *
 * Used twice, unchanged: Node imports it for the tests, and the page has its
 * text inlined (see renderHtml). No imports, and every name carries an `fx`
 * prefix so it cannot collide with the page's own.
 */

/** What a missing number reads as. Never `0`: a blank and a zero are different answers. */
export const FX_BLANK = '—';

const fxMissing = (v) => v == null || v === '' || Number.isNaN(Number(v));

/** A plain number to `d` decimals (default 1): fantasy points, projections. */
export function fxNum(v, d) {
  return fxMissing(v) ? FX_BLANK : Number(v).toFixed(d == null ? 1 : d);
}

/**
 * A trade value on whatever scale its source uses: ~10,000-scale values as
 * whole numbers with separators, ~1,000-scale ones whole, ~100-scale ones to
 * a decimal (a PFN 97.4 is not a 97).
 */
export function fxValue(v) {
  if (fxMissing(v)) return FX_BLANK;
  const n = Number(v), a = Math.abs(n);
  return a >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(a < 100 ? 1 : 0);
}

/** A count of people doing something (adds, drops): 1,234 reads 1.2k, 12,345 reads 12k. */
export function fxCount(v) {
  if (fxMissing(v)) return FX_BLANK;
  const n = Number(v);
  if (n >= 10000) return (n / 1000).toFixed(0) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

/** A signed count, with a true minus sign: `+1.2k`, `−340`. */
export function fxSignedCount(v) {
  if (fxMissing(v)) return FX_BLANK;
  const n = Number(v);
  return (n > 0 ? '+' : n < 0 ? '−' : '') + fxCount(Math.abs(n));
}

/** A change in a number: sign always, `d` decimals. `+0.0` reads `0.0`. */
export function fxDelta(v, d = 1) {
  if (fxMissing(v)) return FX_BLANK;
  const n = Number(v);
  return (n > 0 ? '+' : '') + n.toFixed(d);
}

/** An overall rank: `#12`. */
export const fxRank = (n) => (fxMissing(n) ? FX_BLANK : '#' + n);

/** A position rank: `WR 12` — position, a space, the number. */
export const fxPosRank = (pos, n) => (fxMissing(n) ? FX_BLANK : (pos ? String(pos) + ' ' : '') + n);

/**
 * A position rank a source already wrote (`RB6`, `rb 6`) in the tables'
 * form, `RB 6`. Anything that is not a position rank is left as it is.
 */
export function fxRankText(s) {
  if (s == null) return FX_BLANK;
  const m = String(s).trim().match(/^(QB|RB|WR|TE|K|DST|DEF|FLEX|SF)\s*(\d+)$/i);
  return m ? m[1].toUpperCase() + ' ' + m[2] : String(s);
}

/**
 * Who has a player, as the owner badge writes it: the team's abbreviation
 * (YOU for yours), FA, or W for a player on waivers with the day he clears.
 * `own` is null for nobody, or { mine, abbr, name }; `claim` is a waiver
 * claim { clearsDay } when he is on waivers.
 */
export function fxOwner(own, claim) {
  if (own) return { text: own.mine ? 'YOU' : String(own.abbr || '?'), cls: own.mine ? 'you' : 'team', row: own.mine ? 'you' : '', title: (own.name || '') + (own.mine ? ' — your team' : '') };
  if (claim) return { text: 'W', cls: 'wv', row: 'wv', day: claim.clearsDay || '', title: 'On waivers' + (claim.clearsDay ? ', clears ' + claim.clearsDay : '') };
  return { text: 'FA', cls: 'fa', row: 'fa', title: 'Free agent' };
}

/** A share: `99%`. */
export const fxPct = (v) => (fxMissing(v) ? FX_BLANK : Math.round(Number(v)) + '%');

/**
 * How many shades a difference earns on a diverging scale: 0 inside the
 * neutral band, ±1..±3 past each threshold. `steps` is ascending magnitudes,
 * e.g. [8, 20, 40] league points or [3, 8, 16] ranks.
 */
export function fxHeat(delta, steps) {
  if (fxMissing(delta)) return 0;
  const m = Math.abs(Number(delta));
  let k = 0;
  for (const s of steps) if (m >= s) k++;
  return Number(delta) < 0 ? -k : k;
}

/** The class a heated cell carries for a step from fxHeat: ` hu2`, ` hd1`, or nothing. */
export const fxHeatClass = (step) => (step > 0 ? ' hu' + step : step < 0 ? ' hd' + (-step) : '');
