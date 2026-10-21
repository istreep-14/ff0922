/**
 * Per-source tables: each source's OWN numbers, unmixed with any other's. The
 * page reads the FantasyPros one for points already scored, and the build
 * logs each table's coverage. (The Sources pages themselves are one tab per
 * file — src/sourcefeeds.js.)
 *
 * Nothing here is averaged, spread or derived across sources, so each source
 * can be judged on its own.
 *
 * The universe is the FantasyPros-board pool the Players page already uses. A
 * player who is on Draft Sharks' board but on no FantasyPros ranking board
 * does not appear on that source's tab. Rows carry only the player id (`i`);
 * the page joins name, team and position from the pool, so a player is not
 * repeated once per source.
 *
 * Field by field, and why each source's rest-of-season column is labelled the
 * way it is (see SOURCE_META):
 *
 *   fp          FantasyPros' own week and ROS boards. `wkRk`/`rosRk` are its
 *               published positional ranks. `wkAct` is the FP API's actual
 *               points scored season to date (only when the API sync has run).
 *   draftsharks a real weekly number for the current week, plus its own ROS
 *               board total — both published, not derived.
 *
 * A positional rank a source does not itself publish is computed by sorting
 * THAT SOURCE'S OWN rows within a position, so no other source's number ever
 * enters the sort.
 */

export const SOURCE_ORDER = ['fp', 'draftsharks'];

/** Table name -> the short key the dashboard uses for the same source. */
export const SOURCE_KEY = { fp: 'fp', draftsharks: 'ds' };

/**
 * What each source publishes, and what its numbers actually cover.
 *
 * `label` names the source on the accuracy panels; which file each column
 * comes from is src/sourcefeeds.js. The `scope` block is the plain-language
 * record of what a number means — it is here so it lives next to the code
 * that reads each source and cannot drift from it.
 *
 * `seasonKind` is what the source's season-ish number IS:
 *
 *   remaining  a rest-of-season total that the source revises as weeks pass
 *   static     a full-season total that does NOT move as results come in
 *   sum        no total published; the app adds up the weeks the source did
 *   none       the source has no season-level number
 *
 * Everything under `evidence` was measured on this repo's own data, not read off
 * a site's marketing copy; where a claim could not be settled from the data it
 * says so instead of guessing.
 */
export const SOURCE_META = {
  fp: {
    label: 'FantasyPros', sync: 'fp:sync',
    scope: {
      thisWeek: 'This week’s rankings-implied points AND FantasyPros’ own projections-model points (separate tabs — they are different products), plus positional rank, start/sit grade, ECR range and rank movement.',
      futureWeeks: 'Nothing — only the current week is published.',
      season: 'Rest-of-season board total.',
      seasonKind: 'remaining',
      includesThisWeek: 'yes',
      rosUsed: 'As published.',
      actuals: 'The Season points tab is the FantasyPros API season total (needs FP_API_KEY). Weekly points on the player tables are separate: Sleeper stats for everyone who played that week.',
      scoring: 'A separate board per format: PPR, Half, Standard.',
      evidence: 'Revised each week: for top players it fell by about one week’s projection (median −13 pts) between Sept 14 and Sept 19. Includes the current week: implied games (ROS ÷ own week-2 projection) is 16.5, in line with Sleeper’s known weeks 2–18 at 16.2 and well clear of 15.2 for weeks 3–18.',
    },
  },
  draftsharks: {
    label: 'Draft Sharks', sync: 'ds:sync',
    scope: {
      thisWeek: 'Weekly ranking projection with a floor and ceiling and a strength-of-schedule figure.',
      futureWeeks: 'Nothing — only the current week is fetched (`ds:sync --full` can force all weeks manually).',
      season: 'Its own ROS board total, as published, with its own floor and ceiling.',
      seasonKind: 'remaining',
      includesThisWeek: 'yes',
      rosUsed: 'As published.',
      actuals: 'None.',
      scoring: 'A separate table per format.',
      evidence: 'The whole board via load-rows (~750 weekly, ~1,150 ROS rows before IDP is dropped), not just the top 250 the page first renders.',
    },
  },
};

/**
 * How each source's rest-of-season figure is made, in one line.
 *
 *   published  the site's own rest-of-season figure, used as it printed it
 */
export const ROS_BASIS = {
  fp: { kind: 'published', note: 'The ROS board, as published. Counts the current week.' },
  draftsharks: { kind: 'published', note: 'The ROS board, as published.' },
};

/** "WR12" -> 12. FantasyPros publishes positional ranks as position + number. */
export const posRankNumber = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** One row, without its null fields — most sources leave most columns empty. */
function row(i, fields) {
  const out = { i };
  for (const [k, v] of Object.entries(fields)) if (v != null) out[k] = v;
  return out;
}

/**
 * Fill in a positional rank for every row missing one, computed within its own
 * position from this source's own numbers alone. `posOf` reads a row's position
 * (rows do not carry it — the page joins that from the pool).
 */
export function rankInSource(rows, posOf, valueKey, rankKey) {
  const byPos = new Map();
  for (const r of rows) {
    if (r[valueKey] == null) continue;
    const pos = posOf(r);
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push(r);
  }
  for (const group of byPos.values()) {
    group.sort((a, b) => b[valueKey] - a[valueKey]);
    group.forEach((r, k) => { if (r[rankKey] == null) r[rankKey] = k + 1; });
  }
  return rows;
}

/**
 * Both sources' tables for one scoring format, read off the universe rows.
 *
 * `rows` are the same rows every page renders (see buildUniverse in
 * dashboard.js), so a number in a Sources table is by construction the number
 * on the player's row - there is no second reading of the source files to drift
 * from the first.
 */
export function buildSourceTables({ rows }) {
  const posById = new Map(rows.map((r) => [r.i, r.p]));
  const posOf = (r) => posById.get(r.i);

  const extract = {
    fp: (r) => (r.wk != null || r.ros != null ? row(r.i, {
      wk: r.wk, wkX: r.wkX, wkP: r.wkP, wkRk: posRankNumber(r.pr), wkAct: r.pts, ros: r.ros, rosRk: posRankNumber(r.rosPr),
    }) : null),

    draftsharks: (r) => (r.ds ? row(r.i, {
      wk: r.ds.wk, wkRk: r.ds.prk, ros: r.ds.ros, rosRk: r.ds.rosPrk, floor: r.ds.floor, ceiling: r.ds.ceiling,
      rosFloor: r.ds.rosFloor, rosCeiling: r.ds.rosCeiling,
      cons: r.ds.cons, d3: r.ds.d3, tier: r.ds.tier, val: r.ds.val, dv: r.ds.dv, mkt: r.ds.mkt, rosG: r.ds.rosG, inj: r.ds.inj,
    }) : null),
  };

  const tables = {};
  for (const source of SOURCE_ORDER) {
    const out = rows.map(extract[source]).filter(Boolean);
    rankInSource(out, posOf, 'wk', 'wkRk');
    rankInSource(out, posOf, 'ros', 'rosRk');
    tables[source] = out;
  }
  return tables;
}
