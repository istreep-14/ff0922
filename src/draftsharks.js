import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, pool } from './http.js';
import { DATA } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';
import { writeJsonAtomic } from './jsonfile.js';
import { scoringsInUse } from './fpapi.js';
import { nameKey } from './sleeper.js';
import { normPos, normTeam, parseMatchup } from './teams.js';

/**
 * Draft Sharks — current-week rankings and a rest-of-season board.
 *
 * The page SSR-renders the top 25; its table script pages the rest through
 * `GET /{weekly,ros}-rankings/load-rows?offset=&limit=`. `load-table` stops at
 * the top 250 OVERALL — IDP included — which was only ~28 QBs and ~45 RBs, so
 * most waiver-wire players had no Draft Sharks number at all. One `load-rows`
 * call with a large limit returns the whole board (~750 weekly, ~1,150 ROS).
 *
 * Each board has two views of the same rows (`researchDepth`):
 *
 *   rankings     rank, tiers, floor/ceiling, consensus, SOS, bye; ROS adds
 *                games left, injury risk, 3D Value, its trend and market value
 *   projections  the projected stat line behind the number (per game on ROS)
 *
 * so a board is two requests, merged on Draft Sharks' own player id. The
 * `fantasyPosition` filter is applied in the browser, not by the server.
 * Last-Modified is always 01 Jan 2000 here, so there is no site clock.
 *
 * There are no stable cross-site ids. The join is name + position.
 */

const BASE = 'https://www.draftsharks.com';
const UA_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  Referer: 'https://www.draftsharks.com/weekly-rankings/ppr',
  'HX-Request': 'true',
};

/** Scoring format -> the slug Draft Sharks puts in the URL and the load-table query. */
export const SCORING_SLUG = { PPR: 'ppr', HALF: 'half-ppr', STD: '' };

/** Every row on the board fits in one page at this size (~1,150 ROS rows measured). */
const PAGE_LIMIT = 2000;

/** IDP and team-QB/K placeholder rows — no league here rosters them. */
const SKIP_POSITIONS = new Set(['DB', 'DL', 'LB', 'TK', 'TQB']);

/** Projections-view cells kept as the stat line. Fantasy-point subtotals (`*Total`) are skipped. */
export const STAT_KEYS = [
  'pass_att', 'pass_cmp', 'pass_yds', 'pass_tds', 'pass_int',
  'rush_yds', 'rush_tds', 'rec_catch', 'rec_yds', 'rec_tds',
  'k_xp', 'k_fg_0_29', 'k_fg_30_39', 'k_fg_40_49', 'k_fg_50_59', 'k_fg_60',
  'def_sack', 'def_int', 'def_fum_rec', 'def_tds', 'def_opp_pts', 'def_opp_yds',
];

const dir = (season) => join(DATA, 'draftsharks', String(season));
const filePath = (season, scoring) => join(dir(season), `${String(scoring).toLowerCase()}.json`);

const numOr = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[%+,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

function attr(block, name) {
  const m = block.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

function cellValue(block, attribute) {
  const re = new RegExp(
    `<(?:td|span)[^>]*data-attribute="${attribute}"[^>]*data-value="([^"]*)"`,
    'i',
  );
  const a = block.match(re);
  if (a) return a[1];
  const re2 = new RegExp(
    `<(?:td|span)[^>]*data-value="([^"]*)"[^>]*data-attribute="${attribute}"`,
    'i',
  );
  const b = block.match(re2);
  return b ? b[1] : null;
}

function teamFrom(block) {
  const name = block.match(/player-details-group__team-name">([^<]+)/);
  if (name) return normTeam(name[1]);
  const alt = block.match(/\/img\/icons\/teams\/([A-Z]{2,3})\.svg/i);
  return alt ? normTeam(alt[1]) : null;
}

/**
 * One player row from a Draft Sharks rankings table.
 *
 * Weekly and ROS boards share the same tbody[data-player-row] wrapper and
 * differ only in which `data-attribute` cells they fill, so one parser
 * covers both: missing cells are null rather than zero.
 */
export function parsePlayerBlock(block) {
  const name = attr(block, 'data-player-name');
  const rawPos = String(attr(block, 'data-fantasy-position') || '').toUpperCase();
  const position = normPos(rawPos);
  if (!name || !position || SKIP_POSITIONS.has(rawPos)) return null;
  const matchupRaw = cellValue(block, 'matchup');
  const matchup = parseMatchup(matchupRaw);
  const sosRaw = cellValue(block, 'strength_of_schedule');
  const rankText = block.match(/rank-index[^>]*>\s*<span>(\d+)<\/span>/i);
  // The position rank is the <pos-roster-spot> text. `data-tier-positional` is
  // the positional TIER, and was read as the rank until the two were compared.
  const posRank = block.match(/<pos-roster-spot[^>]*>\s*(\d+)\s*</i);
  const stats = {};
  for (const k of STAT_KEYS) {
    const v = numOr(cellValue(block, k));
    if (v != null && v !== 0) stats[k] = v;
  }
  return {
    id: attr(block, 'data-key'),
    name,
    position,
    team: teamFrom(block),
    rank: rankText ? Number(rankText[1]) : null,
    posRank: posRank ? Number(posRank[1]) : null,
    tier: numOr(attr(block, 'data-tier-overall')),
    posTier: numOr(attr(block, 'data-tier-positional')),
    rookie: attr(block, 'data-is-rookie') === 'true',
    matchup: matchupRaw,
    opp: matchup.bye ? null : matchup.opp,
    home: matchup.home,
    bye: matchup.bye || numOr(cellValue(block, 'player.team.bye')),
    sos: sosRaw != null ? numOr(String(sosRaw).replace('%', '')) : null,
    // Weekly board.
    proj: numOr(cellValue(block, 'weeklyPts')),
    d3: numOr(cellValue(block, 'weekly3dPts')),
    floor: numOr(cellValue(block, 'weeklyFloorPts')),
    ceiling: numOr(cellValue(block, 'weeklyCeilingPts')),
    // The site's name for consensus has been `consensus_projection`; the board
    // now says consensusWeeklyPts / consensusRosWeeklyPts, and the old name
    // left every consensus figure null.
    consensus: numOr(cellValue(block, 'consensusWeeklyPts') ?? cellValue(block, 'consensus_projection')),
    rosConsensus: numOr(cellValue(block, 'consensusRosWeeklyPts')),
    rosD3: numOr(cellValue(block, 'rosWeekly3dPts')),
    injuryRisk: numOr(cellValue(block, 'player.sipPlayerProfile.injury_prob')),
    // 3D Value (0-100, the trade-value scale) and its change since the last
    // update; market value is what the trade market says, on the same scale.
    value: numOr(cellValue(block, 'dsValue')),
    valueDelta: numOr(cellValue(block, 'dsValueDelta')),
    marketValue: numOr(attr(block, 'data-market-value')),
    stats,
    // ROS / season boards. rosWeeklyPts is a per-week average of the remainder.
    // The site used to publish a season/ROS total directly under
    // `fantasy_points`; a redesign dropped that attribute (still checked here
    // in case it returns) and left only the per-week average plus a
    // `games_played` cell that — despite its name — is how many of the
    // remaining games this ROS figure covers (bye subtracted, verified against
    // the current week's games-left count on real data). rosTotal is the
    // product of the two when there is no published total to use as-is.
    rosWeekly: numOr(cellValue(block, 'rosWeeklyPts')),
    rosFloor: numOr(cellValue(block, 'rosWeeklyFloorPts') || cellValue(block, 'floor_points')),
    rosCeiling: numOr(cellValue(block, 'rosWeeklyCeilingPts') || cellValue(block, 'ceiling_points')),
    rosGames: numOr(cellValue(block, 'games_played')),
    rosTotal: numOr(cellValue(block, 'fantasy_points')),
  };
}

export function parseRankingsTable(html) {
  const blocks = html.split(/<tbody\b/i).slice(1);
  const players = [];
  for (const raw of blocks) {
    const body = raw.includes('data-player-row') ? raw : null;
    if (!body) continue;
    const rec = parsePlayerBlock(body);
    if (rec) players.push(rec);
  }
  return players;
}

export function loadUrl(kind, { week, scoring, depth = 'rankings' } = {}) {
  const slug = SCORING_SLUG[String(scoring || 'PPR').toUpperCase()];
  const q = new URLSearchParams({ offset: '0', limit: String(PAGE_LIMIT) });
  if (slug) q.set('pprSuperflexSlug', slug);
  q.set('researchDepth', depth);
  if (kind === 'week') {
    q.set('week', String(week));
    return `${BASE}/weekly-rankings/load-rows?${q}`;
  }
  return `${BASE}/ros-rankings/load-rows?${q}`;
}

/** The projections view's stat line folded onto the rankings view's rows, by Draft Sharks id. */
export function mergeViews(rankRows, projRows) {
  const byId = new Map(projRows.filter((p) => p.id).map((p) => [p.id, p]));
  return rankRows.map((r) => {
    const p = byId.get(r.id);
    if (!p) return r;
    return { ...r, stats: p.stats, d3: r.d3 ?? p.d3, rosD3: r.rosD3 ?? p.rosD3 };
  });
}

/** Draft Sharks sometimes sends `Last-Modified: 01 Jan 2000`, which is not a clock. */
function plausibleSourceAt(lm) {
  if (!lm) return null;
  const d = new Date(lm);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2015) return null;
  return d.toISOString();
}

async function fetchTable(url) {
  const res = await get(url, { asText: true, withHeaders: true, headers: UA_HEADERS });
  const html = res.body;
  const players = parseRankingsTable(html);
  if (!players.length) throw new Error(`no player rows at ${url}`);
  const lm = res.headers?.['last-modified'];
  const sourceAt = plausibleSourceAt(lm);
  return { players, sourceAt, etag: res.headers?.etag ?? null };
}

/** One board, both views. A failed projections view keeps the rankings view. */
async function fetchBoard(kind, opts, log) {
  const rank = await fetchTable(loadUrl(kind, { ...opts, depth: 'rankings' }));
  try {
    const proj = await fetchTable(loadUrl(kind, { ...opts, depth: 'projections' }));
    return { ...rank, players: mergeViews(rank.players, proj.players) };
  } catch (err) {
    log(`  note ${kind} projections view failed — ${err.message.split('\n')[0]}; rankings kept`);
    return rank;
  }
}

export function readDraftSharks(season, scoring = 'PPR') {
  const p = filePath(season, scoring);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const empty = (season, scoring) => ({ season, scoring, fetchedAt: null, weeks: {}, ros: null, players: {} });

export function upsertPlayer(store, rec, { week = null, ros = false } = {}) {
  const key = nameKey(rec.name, rec.position);
  const prev = store.players[key] || { n: rec.name, p: rec.position, t: rec.team, id: rec.id, w: {} };
  prev.n = rec.name;
  prev.p = rec.position;
  prev.t = rec.team ?? prev.t;
  prev.id = rec.id ?? prev.id;
  if (week != null) {
    prev.w[week] = {
      proj: rec.proj,
      d3: rec.d3,
      floor: rec.floor,
      ceiling: rec.ceiling,
      consensus: rec.consensus,
      opp: rec.opp,
      home: rec.home,
      sos: rec.sos,
      rank: rec.rank,
      posRank: rec.posRank ?? null,
      tier: rec.tier ?? null,
      posTier: rec.posTier ?? null,
      bye: rec.bye === true || rec.bye === week,
      stats: rec.stats && Object.keys(rec.stats).length ? rec.stats : null,
    };
  }
  if (ros) {
    // Published total wins; otherwise the per-week average times how many of
    // the remaining games it covers (see parsePlayerBlock).
    const derived = rec.rosWeekly != null && rec.rosGames != null
      ? Math.round(rec.rosWeekly * rec.rosGames * 10) / 10
      : null;
    prev.ros = {
      proj: rec.rosTotal ?? derived,
      weekly: rec.rosWeekly,
      floor: rec.rosFloor,
      ceiling: rec.rosCeiling,
      consensus: rec.rosConsensus ?? rec.consensus ?? null,
      d3: rec.rosD3 ?? null,
      games: rec.rosGames ?? null,
      sos: rec.sos,
      rank: rec.rank,
      posRank: rec.posRank ?? null,
      tier: rec.tier ?? null,
      posTier: rec.posTier ?? null,
      injuryRisk: rec.injuryRisk ?? null,
      value: rec.value ?? null,
      valueDelta: rec.valueDelta ?? null,
      marketValue: rec.marketValue ?? null,
      // Per game, like `weekly` — the ROS projections view is per-game, not a total.
      stats: rec.stats && Object.keys(rec.stats).length ? rec.stats : null,
    };
    prev.rookie = rec.rookie ?? prev.rookie ?? false;
  }
  store.players[key] = prev;
}

/**
 * The current week and the ROS board, for every scoring format in use —
 * nothing else.
 *
 * A lineup decision only ever needs this week and the rest of the season, and
 * the page shows nothing further out (see AGENTS.md). There used to be a
 * `--full` mode that pulled all eighteen weeks and a `--week N` for any one;
 * neither fed a single number on the page, and every extra week was another
 * 250-row table on disk for `enrich` to index.
 *
 * Merge, not replace: weeks already on disk (the scores a past week was
 * projected at) stay, but only the current one is ever re-asked.
 */
export async function dsSync({ season, week, scorings = null, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const formats = scorings || scoringsInUse();
  log(`Draft Sharks — season ${yr}, week ${wk} + ROS; ${formats.join('/')}`);

  const ok = [], failed = [];
  let newest = null, items = 0;

  for (const sc of formats) {
    const store = readDraftSharks(yr, sc) || empty(yr, sc);
    const jobs = [{ kind: 'week', week: wk, scoring: sc }, { kind: 'ros', scoring: sc }];

    const results = await pool(jobs, async (job) => {
      try {
        const r = await fetchBoard(job.kind, job, log);
        return { ...job, ...r };
      } catch (err) {
        const label = job.kind === 'ros' ? `${sc} ROS` : `${sc} wk${job.week}`;
        log(`  FAIL ${label} — ${err.message.split('\n')[0]}`);
        failed.push({ label, error: err.message });
        return null;
      }
    }, { concurrency: 2 });

    const now = new Date().toISOString();
    for (const r of results) {
      if (!r) continue;
      if (r.kind === 'week') {
        for (const p of Object.values(store.players)) delete p.w[r.week];
        for (const p of r.players) upsertPlayer(store, p, { week: r.week });
        store.weeks[r.week] = { sourceAt: r.sourceAt, etag: r.etag, players: r.players.length, fetchedAt: now };
        ok.push(`${sc} week ${r.week} (${r.players.length})`);
        log(`  ok   ${sc.padEnd(4)} wk${String(r.week).padStart(2)} ${String(r.players.length).padStart(3)} players`
          + (r.sourceAt ? `  site ${r.sourceAt}` : ''));
      } else {
        // Replace, not merge: a player who fell off the ROS board (or an IDP
        // row from before those were dropped) must not keep an old ROS figure.
        for (const [k, p] of Object.entries(store.players)) {
          delete p.ros;
          if (SKIP_POSITIONS.has(String(p.p).toUpperCase())) delete store.players[k];
        }
        for (const p of r.players) upsertPlayer(store, p, { ros: true });
        store.ros = { sourceAt: r.sourceAt, etag: r.etag, players: r.players.length, fetchedAt: now };
        ok.push(`${sc} ROS (${r.players.length})`);
        log(`  ok   ${sc.padEnd(4)} ROS  ${String(r.players.length).padStart(3)} players`
          + (r.sourceAt ? `  site ${r.sourceAt}` : ''));
      }
      if (r.sourceAt && (!newest || r.sourceAt > newest)) newest = r.sourceAt;
    }
    store.fetchedAt = now;
    store.scoring = sc;
    mkdirSync(dir(yr), { recursive: true });
    writeJsonAtomic(filePath(yr, sc), store, { indent: 0 });
    items += Object.keys(store.players).length;
  }

  const rep = record('draftsharks', {
    ok, failed, sourceAt: newest, season: yr, week: wk,
    items, note: `${formats.join(', ')} · week ${wk} + ROS`,
  });
  log(`  ${ok.length} ok, ${failed.length} failed`);
  return rep;
}

/** Per-week report, newest week first-ish, for the freshness strip. */
export function dsWeekReport(season, scoring = 'PPR') {
  const store = readDraftSharks(season, scoring);
  if (!store) return [];
  const rows = Object.entries(store.weeks || {})
    .map(([week, w]) => ({ week: Number(week), sourceAt: w.sourceAt, fetchedAt: w.fetchedAt, players: w.players }));
  if (store.ros) rows.push({ week: 'ros', sourceAt: store.ros.sourceAt, fetchedAt: store.ros.fetchedAt, players: store.ros.players });
  return rows.sort((a, b) => String(a.week).localeCompare(String(b.week), undefined, { numeric: true }));
}
