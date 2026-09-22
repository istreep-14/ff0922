import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, FPDIR, VEGASDIR } from './config.js';
import { scoreComponents, boardScoringDrift } from './vegas.js';
import { nameKey } from './sleeper.js';
import { LEAGUE_SCORING_TO_API } from './fpapi.js';
import { resolve as resolveWeek } from './week.js';
import { loadSignals } from './signals.js';
import { readProjections, playerWeeks, SCORING_KEY, LAST_WEEK } from './sleeperproj.js';
import { readProjections as readYahooProjections } from './yahooproj.js';
import { shapeFor, shapeFromPoints, preferredShape, perWeekEstimates } from './weekshape.js';
import { readDraftSharks } from './draftsharks.js';
import { readSchedule, byeWeek, teamWeek } from './schedule.js';
import { normTeam, normPos } from './teams.js';
import { loadTradeMarket } from './trademarket.js';

/**
 * Joins the FantasyPros universal dataset onto the scraped league rosters, so
 * every rostered player carries this week's rank/projection, its rest-of-season
 * rank/projection, and current injury status.
 *
 * Degrades cleanly: whatever slice of data/fp/ exists gets joined, the rest is null.
 */

const POINTS_KEY = { PPR: 'points_ppr', HALF: 'points_half', STD: 'points' };

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

function readDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(dir, f))).filter(Boolean);
}

/**
 * fpId -> rank for one scoring format.
 *
 * Also carries `points` from `r2p_pts` when present: the public ranking boards
 * embed projected points directly, so a scraped sync needs no separate
 * projections file. The API sync leaves r2p_pts absent and supplies projections
 * separately; both paths are handled.
 */
function rankIndex(dir) {
  const idx = new Map();
  for (const board of readDir(dir)) {
    for (const p of board.players || []) {
      const id = Number(p.player_id);
      const prev = idx.get(id);
      // Positional boards don't overlap, but guard anyway: keep the better rank.
      if (!prev || Number(p.rank_ecr) < prev.rank) {
        idx.set(id, {
          rank: Number(p.rank_ecr),
          tier: p.tier ?? null,
          position: p.player_position_id,
          points: p.r2p_pts != null && p.r2p_pts !== '' ? Number(p.r2p_pts) : null,
          posRank: p.pos_rank ?? null,
          startSitGrade: p.start_sit_grade ?? null,
          tag: p.tag ?? null,
          opponent: p.player_opponent ?? null,
          rankMin: p.rank_min != null ? Number(p.rank_min) : null,
          rankMax: p.rank_max != null ? Number(p.rank_max) : null,
          rankAve: p.rank_ave != null ? Number(p.rank_ave) : null,
          trend: p.player_ecr_delta != null && p.player_ecr_delta !== '' ? Number(p.player_ecr_delta) : null,
          rankStd: p.rank_std != null ? Number(p.rank_std) : null,
          owned: p.player_owned_avg ?? null,
          bye: p.player_bye_week != null && p.player_bye_week !== '' ? Number(p.player_bye_week) : null,
          note: p.note ?? null,
        });
      }
    }
  }
  return idx;
}

/** fpId -> projection stat block. */
function projIndex(dir) {
  const idx = new Map();
  for (const board of readDir(dir)) {
    for (const p of board.players || []) {
      const stats = Array.isArray(p.stats) ? p.stats[0] : p.stats;
      idx.set(Number(p.fpid), { name: p.name, team: p.team_id, position: p.position_id, stats: stats || {} });
    }
  }
  return idx;
}

function injuryIndex(weekDir) {
  const idx = new Map();
  const data = readJson(join(weekDir, 'injuries.json'));
  for (const i of data?.injuries || data?.players || []) {
    const id = Number(i.player_id ?? i.fpid);
    if (id) idx.set(id, { status: i.status ?? null, type: i.injury_type ?? null, comment: i.comment ?? null, updated: i.injury_update_date ?? null });
  }
  return idx;
}

/** fpId -> actual fantasy points scored so far (API only; no scraped equivalent). */
export function pointsIndex(root, scoring) {
  const idx = new Map();
  const data = readJson(join(root, 'points', `${String(scoring).toLowerCase()}.json`));
  for (const p of data?.players || []) {
    idx.set(Number(p.player_id), { games: p.games ?? null, points: p.points ?? null, average: p.average ?? null, weeks: p.weeks ?? null });
  }
  return idx;
}

/** fpId -> host-site player ids (API only). Lets you cross-reference ESPN/Yahoo. */
function externalIdIndex(root) {
  const idx = new Map();
  const data = readJson(join(root, 'players.json'));
  for (const p of data?.players || []) {
    if (!p.espn_id && !p.yahoo_id && !p.cbs_id) continue;
    idx.set(Number(p.player_id), { espn: p.espn_id ?? null, yahoo: p.yahoo_id ?? null, cbs: p.cbs_id ?? null });
  }
  return idx;
}

function newsIndex(root) {
  const idx = new Map();
  const data = readJson(join(root, 'news.json'));
  for (const n of data?.news || data?.items || []) {
    const id = Number(n.fpid ?? n.player_id);
    if (!id) continue;
    if (!idx.has(id)) idx.set(id, []);
    if (idx.get(id).length < 3) idx.get(id).push({ title: n.title || n.headline, date: n.created || n.updated, url: n.url });
  }
  return idx;
}

/**
 * sleeperId -> vegas projection, for one bookmaker, scored at `scoring`.
 *
 * The points are computed from the stored stat line (see scoreComponents), never
 * read from the site's `FantasyPoints`: the site's scoring is one process-wide
 * setting anyone can change, and a board pulled while it was changed is
 * inflated (measured 2026-09-19: 34.3 for a player the site itself lists at
 * 23.4).
 *
 * A file written before stat lines were kept whole (no `schema`) still has
 * yards/receptions/TDs for RB/WR/TE, so those are re-scored the same way. Its QB
 * rows have no pass stats and cannot be, so they keep the stored figure ONLY if
 * the same file's skill rows show the site was at plain PPR that day; if the
 * board had drifted they are dropped rather than trusted.
 */
export function vegasIndex(season, week, bookmaker = 'Average', scoring = 'PPR') {
  const idx = new Map();
  const dir = join(VEGASDIR, String(season), `week-${week}`, String(bookmaker).toLowerCase());
  const boards = readDir(dir);
  // Judged across every board in the pull: the QB file alone has no skill rows to judge by.
  const legacyOk = legacyBoardAtPpr(boards.filter((b) => b.schema == null).flatMap((b) => b.players || []));
  for (const board of boards) {
    for (const raw of board.players || []) {
      if (!raw.sleeperId) continue;
      // Legacy QB rows carry no position; the board they came from is the position.
      const p = raw.position ? raw : { ...raw, position: String(board.board || '').toUpperCase() };
      let points = scoreComponents(p, scoring);
      if (points == null && board.schema == null && legacyOk && p.position === 'QB' && p.points != null) {
        // A legacy QB row has no pass stats to re-score, so it keeps the site's
        // own number — trusted only because the file's other rows proved the
        // site was at plain PPR that day. A QB's points do not depend on the
        // reception setting, so this holds for every format.
        points = p.points;
      }
      idx.set(String(p.sleeperId), {
        points,
        rushingYds: p.rushingYds ?? null,
        receivingYds: p.receivingYds ?? null,
        receptions: p.receptions ?? null,
        tdProb: p.tdProb ?? null,
        expectedTds: p.expectedTds ?? null,
        volatility: p.volatility ?? null,
        injuryStatus: p.injuryStatus ?? null,
        noOdds: !!p.noOdds,
        missingProps: p.missingProps ?? [],
        complete: p.complete !== false && !p.noOdds && !(p.missingProps ?? []).length,
        // Which week the file says it holds, and whether the SITE said so.
        sourceWeek: board.week ?? null,
        weekDeclared: board.weekDeclared ?? null,
        generatedAt: board.generatedAt ?? null,
      });
    }
  }
  return idx;
}

/** Legacy boards (no schema): was the site at plain PPR that day? Judged from the skill rows, which have a stat line. */
function legacyBoardAtPpr(rows) {
  const d = boardScoringDrift(rows.filter((p) => p.position && p.position !== 'QB'), 'points');
  return d.n >= 10 && d.drifted === false;
}

/**
 * VegasEdge distributions, keyed by Sleeper id with a name fallback.
 *
 * Separate from vegasIndex because it is a separate sync with separate
 * coverage: roughly half the board has a market thin enough that the
 * simulation refuses to run, and those players keep a point projection but get
 * no spread.
 */
export function vegasDistIndex(season, week, scoring) {
  const sc = String(scoring || 'PPR').toLowerCase();
  const data = readJson(join(VEGASDIR, String(season), `week-${week}`, `distributions-${sc}.json`));
  const byId = new Map(), byName = new Map();
  for (const p of data?.players || []) {
    const rec = {
      proj: p.proj ?? null,
      floor: p.floor ?? null,
      ceiling: p.ceiling ?? null,
      percentiles: p.percentiles ?? null,
      boomPct: p.boomPct ?? null,
      bustPct: p.bustPct ?? null,
      boomThreshold: p.boomThreshold ?? null,
      bustThreshold: p.bustThreshold ?? null,
      volatility: p.volatility ?? null,
      cv: p.cv ?? null,
      booksUsed: p.booksUsed ?? null,
    };
    if (p.sleeperId) byId.set(String(p.sleeperId), rec);
    byName.set(nameKey(p.name, p.position), rec);
  }
  return { byId, byName };
}

/** WinWithOdds, keyed by normalised name+position (the source has no ids). */
export function wwoIndex(season, week) {
  const dir = join(DATA, 'wwo', String(season));
  const weekly = readJson(join(dir, `week-${week}.json`));
  const seasonLong = readJson(join(dir, 'season-long.json'));
  const idx = new Map();
  for (const p of weekly?.players || []) {
    idx.set(p.key, { proj: p.proj, ceiling: p.ceiling, floor: p.floor, actual: p.actual });
  }
  for (const p of seasonLong?.players || []) {
    const prev = idx.get(p.key) || {};
    idx.set(p.key, { ...prev, seasonProj: p.seasonProj, delta7d: p.delta7d });
  }
  return idx;
}

/** First Down Studio, keyed by Sleeper id — an exact join, no name matching. */
export function firstdownIndex(season, week, scoring) {
  const dir = join(DATA, 'firstdown', String(season));
  const weekly = readJson(join(dir, `week-${week}.json`));
  const seasonRows = readJson(join(dir, 'season.json'));
  const field = { PPR: 'ppr', HALF: 'half', STD: 'std' }[String(scoring || 'PPR').toUpperCase()] || 'ppr';
  const rankField = { PPR: 'pprRank', HALF: 'halfRank', STD: 'stdRank' }[String(scoring || 'PPR').toUpperCase()] || 'pprRank';
  const idx = new Map();
  for (const p of weekly?.players || []) {
    if (!p.sleeperId) continue;
    idx.set(p.sleeperId, {
      proj: p[field] ?? null,
      rank: p[rankField] ?? null,
      opponent: p.opponent ?? null,
      locked: !!p.locked,
      injuryStatus: p.injuryStatus ?? null,
      expectedTds: p.expectedTds ?? null,
    });
  }
  for (const p of seasonRows?.players || []) {
    if (!p.sleeperId) continue;
    const prev = idx.get(p.sleeperId) || {};
    idx.set(p.sleeperId, { ...prev, seasonProj: p[field] ?? null, age: p.age ?? null, isRookie: !!p.isRookie });
  }
  return idx;
}

/**
 * Σ of one source's OWN stored projection for every week already played, by
 * player key — what a full-season projection has to give up to become a
 * rest-of-season one.
 *
 * WinWithOdds' and First Down's season totals are static: measured 2026-09-19,
 * neither moved for any of 100+ players between the Sept 14 and Sept 19 pulls
 * even though week 1 had been played in between. They are the preseason
 * full-season projection, unrevised by results. Subtracting the ACTUAL points
 * scored from a projection that never absorbed them mixes a result into a
 * forecast (a hot start would shrink the "remainder"); subtracting what the
 * same source projected for those weeks stays inside one source.
 *
 * Returns null when any played week's file is missing — the remainder cannot be
 * worked out then, and a made-up zero would overstate it. A player absent from a
 * file that does exist had no projection that week and contributes 0.
 */
function playedTotals(week, readWeek) {
  const totals = new Map();
  for (let w = 1; w < week; w++) {
    const rows = readWeek(w);
    if (!rows) return null;
    for (const [k, v] of rows) if (v != null) totals.set(k, (totals.get(k) ?? 0) + Number(v));
  }
  return totals;
}

export function wwoPlayedTotals(season, week) {
  return playedTotals(week, (w) => {
    const f = readJson(join(DATA, 'wwo', String(season), `week-${w}.json`));
    return f ? (f.players || []).map((p) => [p.key, p.proj]) : null;
  });
}

export function firstdownPlayedTotals(season, week, scoring) {
  const field = { PPR: 'ppr', HALF: 'half', STD: 'std' }[String(scoring || 'PPR').toUpperCase()] || 'ppr';
  return playedTotals(week, (w) => {
    const f = readJson(join(DATA, 'firstdown', String(season), `week-${w}.json`));
    return f ? (f.players || []).filter((p) => p.sleeperId).map((p) => [String(p.sleeperId), p[field]]) : null;
  });
}

/**
 * FanDuel / numberFire, keyed by name+position.
 *
 * FanDuel publishes STANDARD and full PPR but no half-PPR set. Half-PPR is
 * exactly the midpoint — standard + 0.5*receptions, PPR being standard + 1.0*
 * receptions — so for HALF leagues the two are averaged. That is an identity,
 * not an approximation.
 */
export function fanduelIndex(season, week, scoring) {
  const dir = join(DATA, 'fanduel', String(season));
  const std = readJson(join(dir, `week-${week}-standard.json`));
  const ppr = readJson(join(dir, `week-${week}-ppr.json`));
  const rem = readJson(join(dir, 'remaining.json'));
  const sc = String(scoring || 'PPR').toUpperCase();

  const stdIdx = new Map((std?.players || []).map((p) => [p.key, p]));
  const pprIdx = new Map((ppr?.players || []).map((p) => [p.key, p]));
  const remIdx = new Map((rem?.players || []).map((p) => [p.key, p]));

  const keys = new Set([...stdIdx.keys(), ...pprIdx.keys(), ...remIdx.keys()]);
  const out = new Map();
  for (const k of keys) {
    const S = stdIdx.get(k), P = pprIdx.get(k), R = remIdx.get(k);
    let proj = null, rank = null;
    if (sc === 'PPR') { proj = P?.fantasy ?? S?.fantasy ?? null; rank = P?.positionRank ?? S?.positionRank ?? null; }
    else if (sc === 'STD') { proj = S?.fantasy ?? null; rank = S?.positionRank ?? null; }
    else if (S?.fantasy != null && P?.fantasy != null) { proj = Number(((S.fantasy + P.fantasy) / 2).toFixed(2)); rank = P.positionRank ?? S.positionRank ?? null; }
    else { proj = S?.fantasy ?? P?.fantasy ?? null; rank = S?.positionRank ?? P?.positionRank ?? null; }

    out.set(k, {
      proj,
      posRank: rank,
      overallRank: (P || S)?.overallRank ?? null,
      oppRank: (P || S)?.opponentDefensiveRank ?? (S?.opponentOffensiveRank ?? null),
      seasonProj: R?.fantasy ?? null,
      seasonPosRank: R?.positionRank ?? null,
      halfDerived: sc === 'HALF' && S?.fantasy != null && P?.fantasy != null,
    });
  }
  return out;
}

/** Draft Sharks, keyed by name+position — a real weekly number for every week. */
export function draftsharksIndex(season, scoring) {
  const store = readDraftSharks(season, scoring);
  const idx = new Map();
  if (!store) return idx;
  for (const rec of Object.values(store.players || {})) {
    const row = {
      id: rec.id ?? null,
      ros: rec.ros?.proj ?? null,
      rosWeekly: rec.ros?.weekly ?? null,
      weeks: rec.w || {},
    };
    idx.set(nameKey(rec.n, rec.p), row);
    if (normPos(rec.p) !== rec.p) idx.set(nameKey(rec.n, normPos(rec.p)), row);
  }
  return idx;
}

export function dsShapeFrom(rec, { fromWeek, byeWeeks }) {
  if (!rec?.weeks) return null;
  const points = {};
  for (const [w, cell] of Object.entries(rec.weeks)) {
    const v = cell?.proj ?? cell?.d3;
    if (typeof v === 'number' && Number.isFinite(v)) points[w] = v;
  }
  return shapeFromPoints(points, { fromWeek, throughWeek: LAST_WEEK, byeWeeks, source: 'draftsharks' });
}

/**
 * Yahoo Fantasy, keyed by name+position — same fallback DraftSharks and
 * WinWithOdds already use. There is no reliable id join: measured 2026-09-14,
 * Sleeper's own yahoo_id crosswalk (what an id join would ride on) covers
 * only ~21% of what the scraper returns and misses star players entirely —
 * see the note in src/yahooproj.js. This publishes a real number for THIS
 * league's own scoring settings, not a universal PPR/Half/Standard split.
 */
export function yahooIndex(season) {
  const store = readYahooProjections(season);
  const idx = new Map();
  if (!store) return idx;
  for (const rec of Object.values(store.players || {})) {
    const row = { weeks: rec.w || {} };
    idx.set(nameKey(rec.n, rec.p), row);
    if (normPos(rec.p) !== rec.p) idx.set(nameKey(rec.n, normPos(rec.p)), row);
  }
  return idx;
}

export function yahooShapeFrom(rec, { fromWeek, byeWeeks }) {
  if (!rec?.weeks) return null;
  const points = {};
  for (const [w, cell] of Object.entries(rec.weeks)) {
    if (typeof cell?.pts === 'number' && Number.isFinite(cell.pts)) points[w] = cell.pts;
  }
  return shapeFromPoints(points, { fromWeek, throughWeek: LAST_WEEK, byeWeeks, source: 'yahoo' });
}

/**
 * Everything the dashboard knows about one player, built ONE way.
 *
 * Rostered players and free agents used to be built by different code (this file
 * for rosters, a thinner copy in dashboard.js for the pool), which is how a
 * player could carry a different projection, rank, injury flag or roster % on
 * My Team than on Players. Both now call `fpFor`.
 *
 * `player` needs {fpId, name, position, team}; the result is the `fp` block.
 */
export function createEnricher({ season, week, bookmaker = 'Average', idMap = null } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const root = join(FPDIR, String(yr));
  const weekDir = join(root, `week-${wk}`);
  const rosDir = join(root, 'ros');

  const have = existsSync(root);
  const weekProj = projIndex(join(weekDir, 'projections'));
  const rosProj = projIndex(join(rosDir, 'projections'));
  const injuries = injuryIndex(weekDir);
  const news = newsIndex(root);
  const externalIds = externalIdIndex(root);
  const wwo = wwoIndex(yr, wk);
  const wwoPlayed = wwoPlayedTotals(yr, wk);
  // Demand-side signal: who the rest of fantasy football is adding, right now.
  const signals = loadSignals({ season: yr });
  // Sleeper's week-by-week projections for the whole season — one shape, not
  // the only one. Draft Sharks publishes a real weekly number too, and the
  // NFL schedule is what actually says who is on bye.
  const sleeperProj = readProjections(yr);
  const nflSchedule = readSchedule(yr);
  const yahooIdx = yahooIndex(yr);
  const fpToSleeper = idMap?.fpToSleeper || {};

  const apiOf = (scoring) => LEAGUE_SCORING_TO_API[String(scoring || '').toUpperCase()] || 'PPR';
  // One set of per-format indexes, built on first use.
  const perFormat = new Map();
  const formatOf = (scoring) => {
    const sc = apiOf(scoring);
    if (!perFormat.has(sc)) {
      perFormat.set(sc, {
        sc,
        ptsKey: POINTS_KEY[sc],
        scored: pointsIndex(root, sc),
        fd: firstdownIndex(yr, wk, sc),
        fdPlayed: firstdownPlayedTotals(yr, wk, sc),
        fanduel: fanduelIndex(yr, wk, sc),
        vdist: vegasDistIndex(yr, wk, sc),
        // Scored at THIS format, so a half-PPR league is not shown PPR points.
        vegas: vegasIndex(yr, wk, bookmaker, sc),
        ds: draftsharksIndex(yr, sc),
        // What FantasyPros' trade analyzer users actually pay for each player.
        trade: loadTradeMarket(yr, sc),
        ranks: {
          week: rankIndex(join(weekDir, 'rankings', sc.toLowerCase())),
          ros: rankIndex(join(rosDir, 'rankings', sc.toLowerCase())),
        },
      });
    }
    return perFormat.get(sc);
  };

  const cache = new Map();
  function fpFor(p, scoring) {
    const F = formatOf(scoring);
    const id = Number(p.fpId);
    const key = `${F.sc}|${id}`;
    if (cache.has(key)) return cache.get(key);

    const wp = weekProj.get(id);
    const rp = rosProj.get(id);
    const wr = F.ranks.week.get(id);
    const rr = F.ranks.ros.get(id);
    const sid = fpToSleeper[id]?.sleeperId ?? null;
    const fp = {
      weekRank: wr?.rank ?? null,
      weekPosRank: wr?.posRank ?? null,
      weekTier: wr?.tier ?? null,
      weekTrend: wr?.trend ?? null,
      rosRank: rr?.rank ?? null,
      rosPosRank: rr?.posRank ?? null,
      rosTier: rr?.tier ?? null,
      // Dedicated projections win; ranking-board r2p_pts is the fallback.
      weekPoints: wp?.stats?.[F.ptsKey] ?? wr?.points ?? null,
      rosPoints: rp?.stats?.[F.ptsKey] ?? rr?.points ?? null,
      weekStats: wp?.stats ?? null,
      opponent: wr?.opponent ?? null,
      startSitGrade: wr?.startSitGrade ?? null,
      tag: wr?.tag ?? null,
      expertSpread: wr ? { min: wr.rankMin, max: wr.rankMax, ave: wr.rankAve, std: wr.rankStd } : null,
      // The same spread on the rest-of-season board, which is what a ROS range column reads.
      rosSpread: rr ? { min: rr.rankMin, max: rr.rankMax, ave: rr.rankAve, std: rr.rankStd } : null,
      trade: F.trade?.byId.get(id) ?? null,
      ownedPct: wr?.owned ?? rr?.owned ?? null,
      note: wr?.note ?? rr?.note ?? null,
      scored: F.scored.get(id) ?? null,
      externalIds: externalIds.get(id) ?? null,
      sleeperId: sid,
      thumb: fpToSleeper[id]?.thumb ?? null,
      vegas: sid ? F.vegas.get(sid) ?? null : null,
      injury: injuries.get(id) ?? null,
      news: news.get(id) ?? null,
      wwo: wwo.get(nameKey(p.name, p.position)) ?? null,
      fd: (sid && F.fd.get(sid)) || null,
      fanduel: F.fanduel.get(nameKey(p.name, p.position)) ?? null,
      vegasDist: (sid && F.vdist.byId.get(sid)) || F.vdist.byName.get(nameKey(p.name, p.position)) || null,
      signal: signals.signalFor({
        sleeperId: sid,
        yahooId: externalIds.get(id)?.yahoo,
        name: p.name,
        position: p.position,
      }),
    };

    // Per-week numbers, from every source that actually publishes one, plus a
    // remaining-season shape that is no longer Sleeper-only.
    const teamAbbr = normTeam(p.team);
    // The stored schedule can be missing a team's bye (ESPN serves some weeks
    // empty); FantasyPros prints every player's bye week on its board.
    const bye = byeWeek(nflSchedule, teamAbbr) ?? wr?.bye ?? (p.byeWeek != null && p.byeWeek !== '' ? Number(p.byeWeek) : null);
    const byeWeeks = bye != null ? [bye] : null;
    const schedThis = teamWeek(nflSchedule, teamAbbr, wk);
    const sw = playerWeeks(sleeperProj, sid);
    const sleeperShape = shapeFor(sw, { fromWeek: wk, scoring: F.sc, byeWeeks });
    const scKey = SCORING_KEY[F.sc] || 'ppr';
    const thisWeek = sw?.[wk] ?? sw?.[String(wk)] ?? null;
    const onBye = schedThis?.bye === true || bye === wk;
    fp.sleeper = sw ? {
      week: onBye ? null : (thisWeek?.[scKey] ?? null),
      opponent: onBye ? null : (schedThis?.opp ?? thisWeek?.opp ?? null),
      home: onBye ? null : (schedThis?.home ?? null),
      bye: onBye,
      rosTotal: sleeperShape?.total ?? null,
      weeksLeft: sleeperShape ? sleeperShape.played : null,
      byeWeeks: sleeperShape?.byes ?? (byeWeeks || []),
      // Published weeklies only — a missing Sleeper row is not a zero and
      // is not a bye. The page reads this when the SL column is selected.
      weeks: Object.fromEntries(
        Object.entries(sw || {})
          .map(([w, c]) => [Number(w), { proj: c?.[scKey] ?? null, opp: c?.opp ?? null }])
          .filter(([w, c]) => w >= wk && c.proj != null),
      ),
    } : null;

    const dsRec = F.ds.get(nameKey(p.name, p.position)) || F.ds.get(nameKey(p.name, normPos(p.position)));
    const dsCell = dsRec?.weeks?.[wk] ?? dsRec?.weeks?.[String(wk)] ?? null;
    const dsShape = dsShapeFrom(dsRec, { fromWeek: wk, byeWeeks: byeWeeks || [] });
    fp.draftsharks = dsRec ? {
      week: onBye ? null : (dsCell?.proj ?? null),
      d3: onBye ? null : (dsCell?.d3 ?? null),
      floor: dsCell?.floor ?? null,
      ceiling: dsCell?.ceiling ?? null,
      opponent: onBye ? null : (dsCell?.opp ?? schedThis?.opp ?? null),
      sos: dsCell?.sos ?? null,
      rank: dsCell?.rank ?? null,
      bye: onBye,
      rosTotal: dsShape?.total ?? dsRec.ros ?? null,
      byeWeeks: byeWeeks || [],
      // Remaining weeks as published, so the page can read week 12 without
      // asking Sleeper what Draft Sharks thinks.
      weeks: Object.fromEntries(
        Object.entries(dsRec.weeks || {})
          .map(([w, c]) => [Number(w), { proj: c.proj ?? null, d3: c.d3 ?? null, opp: c.opp ?? null, sos: c.sos ?? null, bye: !!c.bye }])
          .filter(([w]) => w >= wk),
      ),
    } : null;

    const yhRec = yahooIdx.get(nameKey(p.name, p.position)) || yahooIdx.get(nameKey(p.name, normPos(p.position)));
    const yhCell = yhRec?.weeks?.[wk] ?? yhRec?.weeks?.[String(wk)] ?? null;
    const yahooShape = yhRec ? yahooShapeFrom(yhRec, { fromWeek: wk, byeWeeks: byeWeeks || [] }) : null;
    fp.yahoo = yhRec ? {
      week: onBye ? null : (yhCell?.pts ?? null),
      opponent: onBye ? null : (schedThis?.opp ?? null),
      bye: onBye,
      rosTotal: yahooShape?.total ?? null,
      byeWeeks: byeWeeks || [],
      // Published weeks only, same convention as Sleeper/Draft Sharks above — a
      // missing week is not a zero. Opponent per future week comes from the NFL
      // schedule: the scrape itself only captures a point value, not a matchup,
      // for weeks other than the current one.
      weeks: Object.fromEntries(
        Object.entries(yhRec.weeks || {})
          .map(([w, c]) => {
            const wn = Number(w);
            return [wn, { proj: c?.pts ?? null, opp: teamWeek(nflSchedule, teamAbbr, wn)?.opp ?? null }];
          })
          .filter(([w, c]) => w >= wk && c.proj != null),
      ),
    } : null;

    // The shape OTHER sources are spread on: whichever of Draft Sharks, Yahoo or
    // Sleeper actually varies week to week.
    fp.weekShape = preferredShape(dsShape, yahooShape, sleeperShape);
    fp.sleeperShape = sleeperShape;
    fp.dsShape = dsShape;
    fp.yahooShape = yahooShape;
    fp.schedule = {
      bye,
      opp: onBye ? null : (schedThis?.opp ?? null),
      home: onBye ? null : (schedThis?.home ?? null),
    };

    // Vegas vs FantasyPros delta — positive means Vegas is higher. Only a
    // fully-priced Vegas line is a meaningful comparison.
    const f = fp.weekPoints;
    const v = fp.vegas?.points;
    fp.vegasVsFp = v != null && f != null && fp.vegas.complete ? Number((v - f).toFixed(2)) : null;
    const d = fp.fd;
    if (d) {
      d.vsFp = d.proj != null && f != null ? Number((d.proj - f).toFixed(2)) : null;
      // A static full-season total (see playedTotals): the remainder is the
      // total less what this source itself projected for the weeks played.
      d.rosDerived = d.seasonProj != null && F.fdPlayed
        ? Number((d.seasonProj - (F.fdPlayed.get(String(sid)) ?? 0)).toFixed(1))
        : null;
    }
    const fdl = fp.fanduel;
    if (fdl) {
      fdl.vsFp = fdl.proj != null && f != null ? Number((fdl.proj - f).toFixed(2)) : null;
      // FanDuel's REMAINING file already IS rest-of-season and is revised as
      // weeks pass, so it is used as published.
      fdl.rosDerived = fdl.seasonProj != null ? Number(fdl.seasonProj.toFixed(1)) : null;
    }
    const w = fp.wwo;
    if (w) {
      w.wwoVsFp = w.proj != null && f != null ? Number((w.proj - f).toFixed(2)) : null;
      // A static full-season total, like First Down's — see playedTotals.
      w.rosDerived = w.seasonProj != null && wwoPlayed
        ? Number((w.seasonProj - (wwoPlayed.get(nameKey(p.name, p.position)) ?? 0)).toFixed(1))
        : null;
    }

    /**
     * Every rest-of-season total this player carries, put onto THIS week.
     *
     * Sleeper's own weekly number is deliberately not part of this: it is a real
     * weekly projection, so it belongs beside these estimates as a check on
     * them, not inside their average.
     */
    fp.rosPerWeek = perWeekEstimates({
      fp: fp.rosPoints,
      wwo: w?.rosDerived,
      fd: d?.rosDerived,
      fanduel: fdl?.rosDerived,
    }, fp.weekShape, wk);

    cache.set(key, fp);
    return fp;
  }

  /** Provenance of a format's trade market (dates axis, site time), for the page to label it. */
  const tradeMeta = (scoring) => formatOf(scoring).trade?.meta ?? null;

  return { season: yr, week: wk, bookmaker, have, signals, schedule: nflSchedule, idMap: { fpToSleeper }, fpFor, tradeMeta };
}

export function enrich({ season, week, bookmaker = 'Average', idMap = null } = {}) {
  const model = readJson(join(DATA, 'latest.json'));
  if (!model) throw new Error('No data/latest.json — run `npm run scrape` first.');

  const E = createEnricher({ season, week, bookmaker, idMap });
  for (const league of model.leagues) {
    for (const team of league.teams) {
      for (const p of team.players) p.fp = E.fpFor(p, league.scoring);
    }
  }

  model.bookmaker = bookmaker;
  const signals = E.signals;
  model.signals = { ok: signals.ok, buzzDate: signals.buzzDate, buzzStale: signals.buzzStale, trendFetchedAt: signals.trendFetchedAt, windows: signals.windows, counts: signals.counts };
  model.enrichedAt = new Date().toISOString();
  model.enrichedSeason = E.season;
  model.enrichedWeek = E.week;
  model.fpDataPresent = E.have;
  writeFileSync(join(DATA, 'enriched.json'), JSON.stringify(model, null, 2));
  return model;
}
