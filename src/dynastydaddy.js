import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get, post } from './http.js';
import { DATA, config } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';
import { writeJsonAtomic } from './jsonfile.js';

/**
 * Dynasty Daddy — `api.dynasty-daddy.com/api/v1`. Public, no key, no cookie.
 *
 * Two things come from it, and neither is a projection:
 *
 *   1. PLAYER DATA: every row carries Sleeper, ESPN, Yahoo, MFL and Fantrax
 *      ids, ADP, roster/start rates, and four sites' rest-of-season ranks
 *      (ESPN, FantasyPros, FanDuel, FantasyGuys), each kept apart. League
 *      Value reads those ranks as expert ROS signals.
 *
 *      It is served on the trade-value endpoint (`GET player/all/today?market=N`),
 *      and every market returns the same rows, so ONE request is enough. The
 *      markets' trade values themselves are not kept: each is a price already
 *      shaped by someone else's league size, scoring and scarcity, several
 *      lagged by days, and the app prices players for each league itself
 *      (leaguevalue.js) from rest-of-season ranks and projections instead.
 *
 *   2. The LEAGUE as Dynasty Daddy loads it: `POST league/load` with
 *      `{ platform, leagueId, season }`. What it adds over MyPlaybook is the
 *      whole season's schedule (every week's pairings, future ones included,
 *      for ESPN as well as Sleeper) and Sleeper's potential points.
 *
 * Observed (2026-10-20):
 *   - Every market returns the same ~764 rows; only the trade-value columns
 *     differ. `position: 'PI'` rows are draft picks (`first_name` is the year)
 *     and are skipped: every league here is redraft.
 *   - `most_recent_data_point` is Dynasty Daddy's nightly build (~08:00Z),
 *     identical on every row, so it is the site's own clock.
 *   - `league/load` answers Sleeper and public ESPN leagues with no auth. A
 *     private ESPN league is served from Dynasty Daddy's cache of whenever
 *     someone last loaded it with cookies — `lastUpdated` still says "now", and
 *     every week after that load scores 0. Refreshing one needs the league's
 *     `espn_s2` + `SWID` (ESPN_S2 / ESPN_SWID in .env). Yahoo answers 401
 *     without a Yahoo OAuth bearer token and is not attempted.
 */

const BASE = 'https://api.dynasty-daddy.com/api/v1';

/**
 * The market asked for when only the player rows are wanted. Any market
 * returns the same rows; 22 (FantasyPros redraft) is the smallest response.
 */
export const IDENTITY_MARKET = 22;

export const valuesUrl = (market) => `${BASE}/player/all/today?market=${Number(market)}`;
export const leagueLoadUrl = () => `${BASE}/league/load`;

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v == null || v === '' ? null : String(v));

/** The site's build time: the newest `most_recent_data_point` on any row. */
export function buildTime(raw) {
  let at = null;
  for (const r of Array.isArray(raw) ? raw : []) {
    const t = str(r?.most_recent_data_point);
    if (t && (!at || t > at)) at = t;
  }
  return at;
}

/**
 * Who each row is: ids on every host, plus the market-independent numbers
 * Dynasty Daddy carries on the same row (ADP, roster %, and four sites'
 * rest-of-season ranks, each kept apart). Null for a non-array response, so
 * an error body is a failure rather than an empty table.
 */
export function normalizePlayers(raw) {
  if (!Array.isArray(raw)) return null;
  const out = {};
  for (const r of raw) {
    if (!r || r.position === 'PI' || !r.name_id) continue;
    out[r.name_id] = {
      sleeperId: str(r.sleeper_id),
      espnId: str(r.espn_id),
      yahooId: str(r.yahoo_id),
      name: r.full_name ?? null,
      pos: r.position ?? null,
      team: r.team ?? null,
      age: num(r.age),
      exp: num(r.experience),
      inj: str(r.injury_status),
      // Served as a 20-decimal string ("1.00000000000000000000").
      adp: num(r.avg_adp) == null ? null : Math.round(num(r.avg_adp) * 10) / 10,
      owned: num(r.percent_owned),
      started: num(r.percent_started),
      ros: {
        espn: num(r.espn_ros), fp: num(r.fantasypros_ros), fanduel: num(r.fanduel_ros), fantasyguys: num(r.fantasyguys_ros),
      },
    };
  }
  return out;
}

const dirFor = (yr) => join(DATA, 'dynastydaddy', String(yr));
const playersFile = (yr) => join(dirFor(yr), 'players.json');
const leagueFile = (yr, leagueId) => join(dirFor(yr), 'leagues', `${String(leagueId).replace(/[^\w.-]/g, '_')}.json`);

const readJson = (p) => {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

/**
 * The player rows, in one request. A response with no players never
 * overwrites a good file.
 */
export async function ddPlayersSync({ season, week, log = console.log } = {}) {
  const { season: yr } = resolveWeek({ season: season ?? config.season, week: week ?? config.week });
  log(`Dynasty Daddy player data — season ${yr}`);
  const ok = [], failed = [];
  let sourceAt = null, items = 0;
  try {
    const raw = await get(valuesUrl(IDENTITY_MARKET));
    const players = normalizePlayers(raw);
    items = players ? Object.keys(players).length : 0;
    if (!items) throw new Error('no player rows — refusing to overwrite the stored file');
    sourceAt = buildTime(raw);
    writeJsonAtomic(playersFile(yr), { season: yr, fetchedAt: new Date().toISOString(), sourceAt, players }, { indent: 0 });
    log(`  ok   ${items} players (ids, ADP, ESPN/FanDuel/FantasyGuys ROS ranks)`);
    ok.push('players');
  } catch (err) {
    log(`  FAIL players — ${err.message.split('\n')[0]}`);
    failed.push({ label: 'players', error: err.message });
  }
  record('ddplayers', { ok, failed, sourceAt, items, season: yr, week: week ?? null });
  return { ok, failed };
}

/**
 * The stored player rows as one lookup: `find({ sleeperId, espnId, yahooId })`
 * answers with the player's row.
 */
export function loadDDPlayers(season) {
  const ids = readJson(playersFile(season));
  if (!ids?.players) return null;
  const bySleeper = new Map(), byEspn = new Map(), byYahoo = new Map();
  for (const [nameId, p] of Object.entries(ids.players)) {
    const row = { nameId, ...p };
    if (p.sleeperId) bySleeper.set(p.sleeperId, row);
    if (p.espnId) byEspn.set(p.espnId, row);
    if (p.yahooId) byYahoo.set(p.yahooId, row);
  }
  const find = ({ sleeperId, espnId, yahooId } = {}) =>
    (sleeperId != null && bySleeper.get(String(sleeperId)))
    || (espnId != null && byEspn.get(String(espnId)))
    || (yahooId != null && byYahoo.get(String(yahooId)))
    || null;
  return { fetchedAt: ids.fetchedAt ?? null, sourceAt: ids.sourceAt ?? null, find };
}

const PLATFORM = { sleeper: 'SLEEPER', espn: 'ESPN', yahoo: 'YAHOO' };

/**
 * A league/load response thinned to what the page uses.
 *
 * `scoredThrough` is the last week with any non-zero score. It is how a stale
 * cached ESPN snapshot is caught: Dynasty Daddy stamps `lastUpdated` with the
 * time of the request, not of the data.
 */
export function normalizeLeague(raw) {
  if (!raw || typeof raw !== 'object' || !raw.meta || !Array.isArray(raw.teams)) return null;
  const schedule = {};
  let scoredThrough = 0;
  for (const [wk, rows] of Object.entries(raw.matchUps || {})) {
    const w = Number(wk);
    if (!Number.isFinite(w) || !Array.isArray(rows)) continue;
    schedule[w] = rows.map((m) => (m.teams || []).map((t) => ({ id: String(t.rosterId), pts: num(t.points) })));
    if (rows.some((m) => (m.teams || []).some((t) => num(t.points) > 0))) scoredThrough = Math.max(scoredThrough, w);
  }
  const s = raw.settings || {};
  return {
    name: raw.meta.name ?? null,
    leagueId: str(raw.meta.leagueId),
    season: num(raw.meta.season),
    type: num(raw.meta.type),
    status: raw.meta.status ?? null,
    lastUpdated: raw.lastUpdated ?? null,
    scoredThrough,
    superflex: !!s.roster?.isSuperflex,
    playoffStartWeek: num(s.schedule?.playoffStartWeek),
    playoffTeams: num(s.playoffs?.teams),
    teams: raw.teams.map((t) => ({
      id: String(t.rosterId),
      name: t.owner?.teamName || t.owner?.name || null,
      owner: t.owner?.name ?? null,
      players: (t.roster?.players || []).map(String),
      metrics: t.metrics ? {
        wins: num(t.metrics.wins), losses: num(t.metrics.losses), ties: num(t.metrics.ties),
        pf: num(t.metrics.fpts), pa: num(t.metrics.fptsAgainst),
        // Sleeper only: what the best possible lineup would have scored.
        ppts: num(t.metrics.ppts),
        rank: num(t.metrics.rank),
      } : null,
    })),
    schedule,
  };
}

/** The request body for one league, with ESPN cookies only when the user set them. */
export function leagueLoadBody(league, season, { espnS2 = process.env.ESPN_S2 || '', swid = process.env.ESPN_SWID || '' } = {}) {
  const platform = PLATFORM[String(league.host || '').toLowerCase()];
  if (!platform) return null;
  const body = { platform, leagueId: String(league.leagueId), season: String(season) };
  if (platform === 'ESPN' && espnS2 && swid) Object.assign(body, { espnS2, swid, forceRefresh: true });
  return body;
}

/**
 * Load every scraped league Dynasty Daddy can answer for without a login.
 *
 * A snapshot that stopped scoring weeks ago is still written — its schedule is
 * right and the page needs it — but it is logged as stale, by name.
 */
export async function ddLeagueSync({ season, week, leagues = [], log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season: season ?? config.season, week: week ?? config.week });
  log(`Dynasty Daddy leagues — season ${yr}, ${leagues.length} scraped`);
  const ok = [], failed = [];
  for (const l of leagues) {
    const label = `${l.host} ${l.nickname || l.leagueId}`;
    const body = leagueLoadBody(l, yr);
    if (!body) { log(`  skip ${label} — no Dynasty Daddy platform for ${l.host}`); continue; }
    if (body.platform === 'YAHOO') { log(`  skip ${label} — Dynasty Daddy needs a Yahoo OAuth token; the page uses the MyPlaybook roster`); continue; }
    try {
      const data = normalizeLeague(await post(leagueLoadUrl(), body));
      if (!data) throw new Error('no league in the response');
      writeJsonAtomic(leagueFile(yr, l.leagueId), { fetchedAt: new Date().toISOString(), key: l.key, host: l.host, ...data });
      const behind = data.scoredThrough < wk - 1;
      log(`  ok   ${label} — ${data.teams.length} teams, ${Object.keys(data.schedule).length} weeks scheduled, scored through week ${data.scoredThrough}`
        + (behind ? ` (STALE: Dynasty Daddy's cached copy; set ESPN_S2 + ESPN_SWID to refresh it)` : ''));
      ok.push(l.key);
    } catch (err) {
      log(`  FAIL ${label} — ${err.message.split('\n')[0]}`);
      failed.push({ label: l.key, error: err.message });
    }
  }
  record('ddleague', { ok, failed, items: ok.length, season: yr, week: wk });
  return { ok, failed };
}

export function loadDDLeague(season, leagueId) {
  return readJson(leagueFile(season, leagueId));
}
