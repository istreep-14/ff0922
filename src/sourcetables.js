import { CONS_SRC } from './consensus.js';

/**
 * Per-source tables for the Sources page: every source's OWN numbers, unmixed
 * with any other's.
 *
 * The rest of the dashboard leans toward reconciliation — a consensus column, a
 * market-vs-consensus edge, a blended rest-of-season spread. This is the
 * opposite on purpose: nothing here is averaged, spread or derived across two
 * sources, so each source can be judged on its own before it is trusted inside
 * one of those blends.
 *
 * The universe is the FantasyPros-board pool the Players page already uses. A
 * player who is on Vegas's or Sleeper's board but on no FantasyPros ranking
 * board does not appear on that source's tab. Rows carry only the player id
 * (`i`); the page joins name, team and position from the pool, so a player is
 * not repeated once per source.
 *
 * Field by field, and why each source's rest-of-season column is labelled the
 * way it is (see SOURCE_META):
 *
 *   fp          FantasyPros' own week and ROS boards. `wkRk`/`rosRk` are its
 *               published positional ranks. `wkAct` is the FP API's actual
 *               points scored season to date (only when the API sync has run).
 *   sleeper     a pure projections feed, no actuals. `ros` is Sleeper's own
 *               remaining weeks summed — one source, not a cross-source spread.
 *   draftsharks likewise; `ros` is its own remaining-weeks sum.
 *   vegas       a betting-market number for this week only — a market that
 *               reprices game to game has no rest-of-season. Floor/ceiling come
 *               from the separate distribution simulation, same source family.
 *   wwo         WinWithOdds publishes a real per-player weekly actual once the
 *               game is played. Its `ros` is a FULL-season total, so it is
 *               labelled Season Total, never ROS.
 *   firstdown   the same full-season-total caveat as WinWithOdds.
 *   fanduel     the one source whose season file genuinely is rest-of-season,
 *               with both positional ranks published directly.
 *   yahoo       this league's own re-projection, no universal scoring format;
 *               `ros` is Yahoo's own remaining weeks summed.
 *
 * A positional rank a source does not itself publish is computed by sorting
 * THAT SOURCE'S OWN rows within a position, so no other source's number ever
 * enters the sort.
 */

export const SOURCE_ORDER = ['fp', 'sleeper', 'draftsharks', 'vegas', 'wwo', 'firstdown', 'fanduel', 'yahoo'];

/** Table name -> the short key the dashboard uses for the same source (defined once, in consensus.js). */
export const SOURCE_KEY = Object.fromEntries(CONS_SRC.map((s) => [s.t, s.k]));

/**
 * What each source publishes, and what its numbers actually cover.
 *
 * `label`/`sync`/`rosLabel`/`hasActual`/`range` drive the per-source tabs. The
 * `scope` block is the plain-language record of what a number means — it is
 * what the Sources page's Guide tab prints, and it is here so it lives next to
 * the code that reads each source and cannot drift from it.
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
    label: 'FantasyPros', sync: 'fp:sync', rosLabel: 'ROS', hasActual: 'season to date', range: false,
    scope: {
      thisWeek: 'This week\u2019s expert-consensus projection (points), positional rank, start/sit grade, ECR range and rank movement.',
      futureWeeks: 'Nothing — only the current week is published.',
      season: 'Rest-of-season board total.',
      seasonKind: 'remaining',
      includesThisWeek: 'yes',
      rosUsed: 'As published.',
      actuals: 'Season-to-date and per-week actual points from the FantasyPros API (needs FP_API_KEY; ~490 players).',
      scoring: 'A separate board per format: PPR, Half, Standard.',
      evidence: 'Revised each week: for top players it fell by about one week\u2019s projection (median \u221213 pts) between Sept 14 and Sept 19. Includes the current week: implied games (ROS \u00f7 own week-2 projection) is 16.5, in line with Sleeper\u2019s known weeks 2\u201318 at 16.2 and well clear of 15.2 for weeks 3\u201318.',
    },
  },
  sleeper: {
    label: 'Sleeper', sync: 'sleeper:proj', rosLabel: 'ROS', hasActual: false, range: false,
    scope: {
      thisWeek: 'Published projection for the week.',
      futureWeeks: 'A published number for every remaining week (byes are rows the NFL schedule marks, not zeros).',
      season: 'None published.',
      seasonKind: 'sum',
      includesThisWeek: 'yes',
      rosUsed: 'This app adds up the published weeks from this week through week 18.',
      actuals: 'None.',
      scoring: 'Keyed to the league format (ppr / half_ppr / std).',
      evidence: 'By construction: the sum runs from the current week onward.',
    },
  },
  draftsharks: {
    label: 'Draft Sharks', sync: 'ds:sync', rosLabel: 'ROS', hasActual: false, range: true,
    scope: {
      thisWeek: 'Weekly ranking projection with a floor and ceiling and a strength-of-schedule figure.',
      futureWeeks: 'A published number for each week that has been synced — the default sync stores the next three weeks; `ds:sync --full` stores all of them.',
      season: 'Its own ROS page total is not stored, so none.',
      seasonKind: 'sum',
      includesThisWeek: 'yes',
      rosUsed: 'This app adds up the stored weeks from this week onward — a short total until every week is synced.',
      actuals: 'None.',
      scoring: 'A separate table per format.',
      evidence: 'By construction. Covers roughly the 250 players a fantasy roster cares about, so it is a smaller universe than the other sources.',
    },
  },
  vegas: {
    label: 'VegasEdge', sync: 'vegas:sync', rosLabel: null, hasActual: false, range: true,
    scope: {
      thisWeek: 'Points implied by sportsbook player props (average across books) — QB/RB/WR/TE only, and only where the props are priced.',
      futureWeeks: 'Nothing — a market that reprices game to game has no forward weeks.',
      season: 'None.',
      seasonKind: 'none',
      includesThisWeek: 'n/a',
      rosUsed: 'Not used for rest of season.',
      actuals: 'None.',
      scoring: 'Scored here from the market\u2019s expected stat line at each league\u2019s own format. The site\u2019s printed points are not used: its scoring is one setting shared by every visitor, and it was seen inflated ~46% on one pull. Floor and ceiling come from a separate simulation run at one format (PPR by default).',
      evidence: 'Measured week 1: lowest error of any source (see Accuracy) but biased about 0.7 pts low — it only prices the props it has.',
    },
  },
  wwo: {
    label: 'WinWithOdds', sync: 'wwo:sync', rosLabel: 'Season Total', hasActual: 'weekly', range: true,
    scope: {
      thisWeek: 'Weekly projection with floor and ceiling, and a real weekly actual once the game is played (a 0 before kickoff is a placeholder, not a result).',
      futureWeeks: 'Nothing — this week only.',
      season: 'A full-season projection that includes weeks already played.',
      seasonKind: 'static',
      includesThisWeek: 'yes',
      rosUsed: 'Season total less what WinWithOdds itself projected for the weeks already played — never less the actual points, which the total never absorbed.',
      actuals: 'Per-week actual (this source only, besides the FantasyPros API).',
      scoring: 'Not stated by the site; the one figure is used for every league format.',
      evidence: 'Static: the season figure did not change for any of 104 players between the Sept 14 and Sept 19 pulls, although week 1 was played in between. It is the preseason projection, not a revised one.',
    },
  },
  firstdown: {
    label: 'First Down Studio', sync: 'fd:sync', rosLabel: 'Season Total', hasActual: false, range: false,
    scope: {
      thisWeek: 'Weekly projection for the week; rows carry a locked flag once the game starts.',
      futureWeeks: 'Nothing — this week only.',
      season: 'A full-season projection that includes weeks already played.',
      seasonKind: 'static',
      includesThisWeek: 'yes',
      rosUsed: 'Season total less what First Down itself projected for the weeks already played.',
      actuals: 'None.',
      scoring: 'A figure per format (PPR / Half / Standard).',
      evidence: 'Static: unchanged for all 132 players compared between Sept 14 and Sept 19. Covers roughly the 200 players it prices, a smaller universe than most sources.',
    },
  },
  fanduel: {
    label: 'FanDuel', sync: 'fanduel:sync', rosLabel: 'ROS', hasActual: false, range: false,
    scope: {
      thisWeek: 'Weekly projection (numberFire), standard and PPR; Half is the midpoint of the two, which is an identity, not an estimate.',
      futureWeeks: 'Nothing — this week only.',
      season: 'A REMAINING projection: rest of season.',
      seasonKind: 'remaining',
      includesThisWeek: 'unclear',
      rosUsed: 'As published. (This used to subtract points already scored from it, which double-counted.)',
      actuals: 'None.',
      scoring: 'Standard and PPR published; Half derived.',
      evidence: 'Revised each week: fell by about one week\u2019s projection (median \u221214 pts) between Sept 14 and Sept 19. Whether it counts the current week could not be settled from the data: its implied games (14.4) sits below every other source\u2019s, which reads as a more heavily regressed per-game rate as much as a missing week.',
    },
  },
  yahoo: {
    label: 'Yahoo', sync: 'yahoo:sync', rosLabel: 'ROS', hasActual: false, range: false,
    scope: {
      thisWeek: 'This league\u2019s own re-projection under its scoring settings.',
      futureWeeks: 'A number for each week captured. Needs a logged-in scrape, so it is only as fresh as the last time you ran it.',
      season: 'None published.',
      seasonKind: 'sum',
      includesThisWeek: 'yes',
      rosUsed: 'This app adds up the captured weeks from this week onward.',
      actuals: 'None.',
      scoring: 'This league\u2019s own settings, not a universal PPR/Half/Standard split — the reason it can look off next to the others.',
      evidence: 'Its weeks are only those last captured; check the freshness column before leaning on it.',
    },
  },
};

/**
 * How each source's rest-of-season figure is made, in one line, for the Health
 * tab. What it CONTAINS (does it still count a game already played this week)
 * is measured on the data, not stated here: see playedGameDropped in
 * consensus.js and the `impliedGames` column.
 *
 *   published  the site's own rest-of-season figure, used as it printed it
 *   summed     no total published; this app adds up the weeks the source did
 *   derived    a static season total, less the SAME source's own projection for
 *              the weeks already played
 *   none       no rest-of-season figure
 */
const kindOf = (table) => CONS_SRC.find((s) => s.t === table).rosKind;
export const ROS_BASIS = {
  fp: { kind: kindOf('fp'), note: 'The ROS board, as published. Counts the current week.' },
  sleeper: { kind: kindOf('sleeper'), note: 'Every published week from this week through 18, added up here.' },
  draftsharks: { kind: kindOf('draftsharks'), note: 'Stored weeks from this week onward, added up here \u2014 short until every week is synced (`ds:sync --full`).' },
  vegas: { kind: kindOf('vegas'), note: 'A betting market reprices game to game; there is no rest of season.' },
  wwo: { kind: kindOf('wwo'), note: 'Static full-season total less what WinWithOdds projected for the weeks already played.' },
  firstdown: { kind: kindOf('firstdown'), note: 'Static full-season total less what First Down projected for the weeks already played.' },
  fanduel: { kind: kindOf('fanduel'), note: 'The REMAINING file, as published. Whether it counts the current week is not stated.' },
  yahoo: { kind: kindOf('yahoo'), note: 'Every captured week from this week onward, added up here \u2014 only as fresh as the last capture.' },
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
 * All eight sources' tables for one scoring format, read off the universe rows.
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
      wk: r.wk, wkRk: posRankNumber(r.pr), wkAct: r.pts, ros: r.ros, rosRk: posRankNumber(r.rosPr),
    }) : null),

    sleeper: (r) => (r.sl ? row(r.i, { wk: r.sl.wk, ros: r.sl.ros }) : null),

    draftsharks: (r) => (r.ds ? row(r.i, { wk: r.ds.wk, ros: r.ds.ros, floor: r.ds.floor, ceiling: r.ds.ceiling }) : null),

    // `partial`: some of the props behind the number were not priced, which
    // reads low. Shown, but kept out of any consensus.
    vegas: (r) => (r.vg != null ? row(r.i, {
      wk: r.vg, floor: r.vdist?.floor, ceiling: r.vdist?.ceiling, partial: r.vc === false ? true : null,
    }) : null),

    wwo: (r) => (r.wwo ? row(r.i, {
      wk: r.wwo.proj, wkAct: r.wwo.actual, ros: r.wwo.seasonProj, rosRest: r.wwo.rosDerived,
      floor: r.wwo.floor, ceiling: r.wwo.ceiling,
    }) : null),

    firstdown: (r) => (r.fd ? row(r.i, { wk: r.fd.proj, ros: r.fd.seasonProj, rosRest: r.fd.rosDerived }) : null),

    fanduel: (r) => (r.fdl ? row(r.i, {
      wk: r.fdl.proj, wkRk: r.fdl.posRank, ros: r.fdl.seasonProj, rosRk: r.fdl.seasonPosRank,
    }) : null),

    yahoo: (r) => (r.yh ? row(r.i, { wk: r.yh.wk, ros: r.yh.ros }) : null),
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
