import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FPDIR } from './config.js';
import { nameKey } from './sleeper.js';
import { normPos } from './teams.js';
import { readProjections, playerWeeks, SCORING_KEY } from './sleeperproj.js';
import {
  pointsIndex, vegasIndex, wwoIndex, firstdownIndex, fanduelIndex, draftsharksIndex, yahooIndex,
} from './enrich.js';
import { SOURCE_ORDER } from './sourcetables.js';

/**
 * How each source's stored projection for a PLAYED week compares with what the
 * player actually scored.
 *
 * The point is to weigh sources against outcomes before weighting them in a
 * consensus: a source that reads well but runs 0.7 points low on average, or one
 * whose error is twice another's, is worth knowing before it gets an equal vote.
 *
 * What "the projection" is matters, and is a limit of the data rather than of
 * this code: nothing here archives a projection at kickoff. Each sync overwrites
 * that week's file, so what is compared is the LAST snapshot of that week, which
 * for a played week may have been pulled after some games had started. A source
 * that rewrote its numbers to results would show suspiciously little error; none
 * of the week-1 numbers do (correlations of 0.5–0.7, near-zero bias), which is
 * why they are treated as real projections. See the `note` in the result.
 *
 * Actuals are the FantasyPros API's per-week points, so they exist only for the
 * ~490 players that API returns, and only when FP_API_KEY has synced them.
 *
 * Each source is scored on the players IT covers (a broad source is not
 * penalised for a narrow one's easy universe) and also on the subset every
 * source covers, the only apples-to-apples comparison.
 */

/** n, mean absolute error, bias (projection minus actual, so positive = runs high), RMSE and correlation. */
export function accuracyStats(pairs) {
  const rows = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const n = rows.length;
  if (!n) return null;
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / n;
  const ma = mean(([a]) => a), mb = mean(([, b]) => b);
  const cov = rows.reduce((s, [a, b]) => s + (a - ma) * (b - mb), 0);
  const va = rows.reduce((s, [a]) => s + (a - ma) ** 2, 0);
  const vb = rows.reduce((s, [, b]) => s + (b - mb) ** 2, 0);
  const r2 = (x) => Number(x.toFixed(2));
  return {
    n,
    mae: r2(mean(([a, b]) => Math.abs(a - b))),
    bias: r2(mean(([a, b]) => a - b)),
    rmse: r2(Math.sqrt(mean(([a, b]) => (a - b) ** 2))),
    corr: va > 0 && vb > 0 ? Number((cov / Math.sqrt(va * vb)).toFixed(3)) : null,
  };
}

function fpWeekBoard(season, week, scoring) {
  const dir = join(FPDIR, String(season), `week-${week}`, 'rankings', String(scoring).toLowerCase());
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    for (const p of JSON.parse(readFileSync(join(dir, f), 'utf8')).players || []) {
      if (p.r2p_pts != null && p.r2p_pts !== '') out.set(p.player_id, Number(p.r2p_pts));
    }
  }
  return out;
}

/**
 * Per source, fpId -> that source's projection for one week. Same joins the
 * Sources tables use (name+position, or Sleeper id) so the two agree on who is
 * who.
 */
function weekProjections({ season, week, scoring, pool, sleeperProj, ds, yahoo }) {
  const byName = (idx, r) => idx.get(nameKey(r.n, r.p)) || idx.get(nameKey(r.n, normPos(r.p))) || null;
  const cell = (weeks, w) => weeks?.[w] ?? weeks?.[String(w)] ?? null;
  const fp = fpWeekBoard(season, week, scoring);
  const vegas = vegasIndex(season, week, 'Average', scoring);
  const wwo = wwoIndex(season, week);
  const fd = firstdownIndex(season, week, scoring);
  const fdl = fanduelIndex(season, week, scoring);
  const key = SCORING_KEY[scoring] || 'ppr';

  const out = Object.fromEntries(SOURCE_ORDER.map((s) => [s, new Map()]));
  for (const r of pool) {
    const put = (src, v) => { if (v != null && Number.isFinite(Number(v))) out[src].set(r.i, Number(v)); };
    put('fp', fp.get(r.i));
    put('sleeper', cell(r.s ? playerWeeks(sleeperProj, r.s) : null, week)?.[key]);
    put('draftsharks', cell(byName(ds, r)?.weeks, week)?.proj);
    put('vegas', r.s ? vegas.get(String(r.s))?.points : null);
    put('wwo', byName(wwo, r)?.proj);
    put('firstdown', r.s ? fd.get(String(r.s))?.proj : null);
    put('fanduel', byName(fdl, r)?.proj);
    put('yahoo', cell(byName(yahoo, r)?.weeks, week)?.pts);
  }
  return out;
}

/**
 * One scoring format's backtest across every completed week (1 .. week-1).
 * Returns null when no week has finished or no actuals are stored.
 */
export function buildAccuracy({ season, week, scoring, pool }) {
  const played = [];
  for (let w = 1; w < week; w++) played.push(w);
  if (!played.length) return null;

  const points = pointsIndex(join(FPDIR, String(season)), scoring);
  const sleeperProj = readProjections(season);
  const ds = draftsharksIndex(season, scoring);
  const yahoo = yahooIndex(season);

  // source -> [[projection, actual, key]] pooled over the played weeks
  const pairs = Object.fromEntries(SOURCE_ORDER.map((s) => [s, []]));
  const weeksWithActuals = [];
  for (const w of played) {
    const proj = weekProjections({ season, week: w, scoring, pool, sleeperProj, ds, yahoo });
    let any = false;
    for (const src of SOURCE_ORDER) {
      for (const [id, v] of proj[src]) {
        const actual = points.get(Number(id))?.weeks?.[w] ?? points.get(Number(id))?.weeks?.[String(w)];
        if (actual == null) continue;
        pairs[src].push([v, Number(actual), `${w}:${id}`]);
        any = true;
      }
    }
    if (any) weeksWithActuals.push(w);
  }
  if (!weeksWithActuals.length) return null;

  const sources = {};
  for (const src of SOURCE_ORDER) sources[src] = accuracyStats(pairs[src]);

  // The subset every source that has any data covers, keyed player-week.
  const live = SOURCE_ORDER.filter((s) => pairs[s].length);
  const sets = live.map((s) => new Set(pairs[s].map((r) => r[2])));
  const shared = sets.length ? [...sets[0]].filter((k) => sets.every((st) => st.has(k))) : [];
  const sharedSet = new Set(shared);
  const common = { n: shared.length, sources: {} };
  for (const src of live) common.sources[src] = accuracyStats(pairs[src].filter((r) => sharedSet.has(r[2])));

  return {
    weeks: weeksWithActuals,
    sources,
    common,
    note: 'Compared against the last snapshot each source’s sync stored for the week, not a kickoff-time archive — a played week may have been pulled after some games started. Actuals come from the FantasyPros API, so only players it returns are scored.',
  };
}
