/**
 * The window a projection number is answering: this week, the rest of the
 * season, or the full season (scored + rest of season).
 *
 * Used twice, unchanged: Node imports it, and the dashboard has its text
 * inlined at build time (see renderHtml), so the page parses and labels a
 * window with the code the tests run. No imports here for that reason.
 *
 * There used to be twenty-odd windows — "next 3 weeks", "playoffs 15–17", and
 * every week 1–18 on its own. Both remaining sources publish the current week
 * and a rest-of-season figure and nothing in between, so every one of those
 * windows rendered a page of blanks. Three windows, each of which has data.
 *
 * Encoded as a short key so it can live in localStorage and the URL:
 *   w-7     week 7 (only ever the current week)
 *   ros     rest of season (now through 18)
 *   szn     full season (1 through 18)
 *
 * Any other key — an old bookmark's `n-3` or `p`, a past week — reads as the
 * current week rather than as an empty window.
 */

/** The last regular-season week. Everything that needs it imports it from here. */
export const LAST_WEEK = 18;

export function parseHorizon(raw, { now = 1, lastWeek = LAST_WEEK } = {}) {
  const cur = clampWeek(now, lastWeek);
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'ros') return { kind: 'ros', from: cur, to: lastWeek, key: 'ros' };
  if (s === 'szn' || s === 'season') return { kind: 'season', from: 1, to: lastWeek, key: 'szn' };
  return { kind: 'week', from: cur, to: cur, key: `w-${cur}` };
}

export function labelHorizon(horizon, { now = 1 } = {}) {
  if (!horizon) return '—';
  if (horizon.kind === 'ros') return now > 1 ? `Rest of season (wk ${horizon.from}–${horizon.to})` : 'Rest of season';
  if (horizon.kind === 'season') return 'Full season';
  return `Week ${horizon.from}`;
}

/** Dropdown options for a given "now". */
export function horizonOptions({ now = 1, lastWeek = LAST_WEEK } = {}) {
  const cur = clampWeek(now, lastWeek);
  return [
    { value: `w-${cur}`, label: `Week ${cur} (this week)` },
    { value: 'ros', label: 'Rest of season' },
    { value: 'szn', label: 'Full season' },
  ];
}

function clampWeek(w, lastWeek) {
  const n = Number(w);
  if (!Number.isFinite(n)) return 1;
  return Math.min(lastWeek, Math.max(1, Math.round(n)));
}
