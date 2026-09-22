import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, pool } from './http.js';
import { DATA } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';
import { writeJsonAtomic } from './jsonfile.js';
import { LAST_WEEK } from './sleeperproj.js';
import { normTeam } from './teams.js';

/**
 * The NFL regular-season schedule, scraped from ESPN's public schedule page.
 *
 * Sleeper's projection rows carry an opponent, but that opponent is whatever
 * Sleeper last wrote onto that week — and Sleeper's weeks 2–18 move on a
 * nightly batch. A teammate landing on IR, a game flexed, a team on a bye that
 * Sleeper has not yet marked as one: none of those should have to wait on
 * Sleeper's curve to be visible.
 *
 * ESPN publishes the whole slate as JSON behind `cdn.espn.com/core/nfl/schedule`
 * (the HTML page's own XHR). One request per week, 16 games, every team either
 * has an opponent or is on bye. No auth.
 *
 * A week's response is believed only if it has a plausible number of games. ESPN
 * answers HTTP 202 with an empty body for weeks it is not serving (seen for the
 * live week and for weeks not yet published), and an empty week used to read as
 * "every team is on bye" — the last such week overwrote each team's real bye,
 * which left all 32 teams on bye in week 18 and every real bye week looking like
 * a normal game week. Empty weeks now fail and write nothing, a team confirmed
 * playing clears any stale bye pointing at that week, and a bye that rests on a
 * week that was never trustworthy is dropped on load.
 */

const dir = (season) => join(DATA, 'schedule', String(season));
export const filePath = (season) => join(dir(season), 'nfl.json');

const scheduleUrl = (season, week) =>
  `https://cdn.espn.com/core/nfl/schedule?xhr=1&year=${season}&seasontype=2&week=${week}`;

const NFL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
  'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAC', 'KC',
  'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS',
];

// With up to 6 teams on bye in the heaviest bye weeks (32 teams, so as few as 13
// games), a genuine NFL week is never below ~13 games; a truncated or empty
// payload is far below that.
export const MIN_GAMES_TRUSTED = 13;

export function readSchedule(season) {
  const p = filePath(season);
  if (!existsSync(p)) return null;
  try {
    // Repaired on the way in as well as on sync, so a file written by the old
    // empty-week bug never reaches a reader as "every team is on bye".
    return repairStore(JSON.parse(readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
}

export function teamWeek(store, team, week) {
  if (!store || team == null || week == null) return null;
  const t = store.teams?.[normTeam(team)];
  if (!t) return null;
  if (t.bye === Number(week)) return { bye: true, opp: null, home: null, date: null };
  return t.weeks?.[String(week)] || t.weeks?.[week] || null;
}

export function byeWeek(store, team) {
  return store?.teams?.[normTeam(team)]?.bye ?? null;
}

/** Parse one ESPN schedule XHR payload into per-team rows. */
export function parseEspnSchedule(json, { week } = {}) {
  const days = json?.content?.schedule || {};
  const games = [];
  for (const day of Object.values(days)) {
    for (const g of day?.games || []) {
      const comp = g.competitions?.[0] || g;
      const competitors = comp.competitors || [];
      const home = competitors.find((c) => c.homeAway === 'home');
      const away = competitors.find((c) => c.homeAway === 'away');
      if (!home || !away) continue;
      const ht = normTeam(home.team?.abbreviation);
      const at = normTeam(away.team?.abbreviation);
      if (!ht || !at) continue;
      const date = g.date || comp.date || comp.startDate || null;
      games.push({
        id: String(g.id || comp.id || ''),
        week: Number(week) || Number(g.week?.number) || null,
        date,
        home: ht,
        away: at,
        name: g.shortName || g.name || `${at} @ ${ht}`,
        status: g.status?.type?.name || comp.status?.type?.name || null,
        final: !!(g.status?.type?.completed || comp.status?.type?.completed),
      });
    }
  }
  return games;
}

export function emptyTeams() {
  const teams = {};
  for (const t of NFL_TEAMS) teams[t] = { bye: null, weeks: {} };
  return teams;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWeekSchedule({ season, week } = {}) {
  // ESPN answers 202 with an empty body more often than it should — the same
  // week can return a full 16-game slate one request and nothing the next, so
  // an empty response is a retryable artifact, not an answer. `get` retries
  // HTTP errors but treats an empty body as success (it returns null), so the
  // empty/incomplete case is retried here.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const json = await get(scheduleUrl(season, week), {
        headers: { Accept: 'application/json', Referer: 'https://www.espn.com/nfl/schedule' },
      });
      const games = parseEspnSchedule(json, { week });
      if (games.length >= MIN_GAMES_TRUSTED) return games;
      lastErr = new Error(`only ${games.length} games in the response \u2014 treating as an incomplete fetch, not a real schedule`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(2 ** attempt * 500 + Math.random() * 250);
  }
  throw lastErr;
}

/**
 * Fold one trusted week into the store. Pure apart from mutating `store`.
 *
 * A team absent from the week's games is on bye that week; a team found playing
 * clears any bye that was latched onto the same week by an earlier, less
 * trustworthy fetch.
 */
export function mergeWeek(store, week, games, fetchedAt = new Date().toISOString()) {
  store.weeks[week] = { fetchedAt, games: games.length };
  const playing = new Set();
  for (const g of games) {
    playing.add(g.home); playing.add(g.away);
    const put = (team, opp, home) => {
      const rec = store.teams[team] || { bye: null, weeks: {} };
      rec.weeks[week] = { opp, home, date: g.date, final: !!g.final, name: g.name };
      store.teams[team] = rec;
    };
    put(g.home, g.away, true);
    put(g.away, g.home, false);
  }
  for (const t of NFL_TEAMS) {
    const rec = store.teams[t] || { bye: null, weeks: {} };
    if (playing.has(t)) {
      if (rec.bye === week) rec.bye = null;
    } else {
      rec.bye = week;
      delete rec.weeks[week];
    }
    store.teams[t] = rec;
  }
  return store;
}

/**
 * Make the stored byes agree with the games actually stored.
 *
 * A bye that rests on a week the store never trusted (no games stored, or too
 * few) is dropped: that is the fingerprint of the empty-week bug, and a bye known
 * only from an empty week is not a bye. Then any team with no game in a fully
 * stored week is on bye that week — recoverable from the file alone, with no
 * network, which matters because ESPN keeps answering empty for some weeks.
 */
export function repairStore(store) {
  const trusted = (w) => (store.weeks?.[w]?.games ?? 0) >= MIN_GAMES_TRUSTED;
  for (const rec of Object.values(store?.teams || {})) {
    if (rec.bye != null && !trusted(rec.bye)) rec.bye = null;
  }
  for (const w of Object.keys(store?.weeks || {})) {
    if (!trusted(w)) continue;
    for (const rec of Object.values(store.teams || {})) {
      if (rec.bye == null && !rec.weeks?.[w]) rec.bye = Number(w);
    }
  }
  return store;
}

/**
 * Fold an externally-produced schedule into the store — the manual fallback
 * when `schedule:sync` keeps hitting ESPN during a stretch where it answers
 * empty. `data` is a games-per-week map:
 *
 *   { "weeks": { "1": [ { "home": "BUF", "away": "NYJ", "date": "...",
 *                        "name": "...", "final": false }, ... ] }, ... }
 *
 * each week merged exactly like a trusted live fetch (byes come from the
 * teams absent from that week's games), and only weeks with a plausible number
 * of games are believed. Returns the list of weeks folded in; throws if a week
 * has games but too few to trust.
 */
export function importScheduleWeeks(store, data, now = new Date().toISOString()) {
  const weeks = data?.weeks || data?.schedule || {};
  const folded = [];
  const half = [];
  for (const key of Object.keys(weeks)) {
    const w = Number(key);
    if (!Number.isInteger(w) || w < 1 || w > LAST_WEEK) continue;
    const v = weeks[key];
    if (!Array.isArray(v)) continue;
    const games = [];
    for (const g of v) {
      if (!g || typeof g !== 'object') continue;
      const home = normTeam(g.home ?? g.homeTeam ?? g.homeAbbrev);
      const away = normTeam(g.away ?? g.awayTeam ?? g.awayAbbrev);
      if (!home || !away) continue;
      games.push({ home, away, date: g.date ?? g.time ?? null, name: g.name ?? `${away} @ ${home}`, final: !!g.final });
    }
    if (games.length >= MIN_GAMES_TRUSTED) {
      mergeWeek(store, w, games, now);
      folded.push(`week ${w} (${games.length} games)`);
    } else if (games.length) {
      half.push(`week ${w} (${games.length} games — below the ${MIN_GAMES_TRUSTED}-game trust threshold)`);
    }
  }
  if (half.length) throw new Error(`incomplete weeks in import: ${half.join('; ')}`);
  if (!folded.length) {
    throw new Error('no trustworthy weeks in the import — expected `{ "weeks": { "1": [ { home, away, ... } ] } }` with 13+ games per week');
  }
  store.fetchedAt = now;
  return folded;
}

export async function scheduleSync({ season, week, weeks = null, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const want = (weeks && weeks.length ? weeks : Array.from({ length: LAST_WEEK }, (_, i) => i + 1))
    .map(Number).filter((w) => w >= 1 && w <= LAST_WEEK);

  log(`NFL schedule — season ${yr}; fetching ${want.length === 1 ? `week ${want[0]}` : `weeks ${want[0]}–${want[want.length - 1]}`}`);

  const store = repairStore(readSchedule(yr) || { season: yr, fetchedAt: null, weeks: {}, teams: emptyTeams() });
  if (!store.teams || Object.keys(store.teams).length < 32) store.teams = { ...emptyTeams(), ...(store.teams || {}) };

  const ok = [], failed = [];
  const results = await pool(want, async (w) => {
    try {
      const games = await fetchWeekSchedule({ season: yr, week: w });
      return { week: w, games };
    } catch (err) {
      log(`  FAIL wk${String(w).padStart(2)} \u2014 ${err.message.split('\n')[0]}`);
      failed.push({ label: `week ${w}`, error: err.message });
      return null;
    }
  }, { concurrency: 3 });

  const now = new Date().toISOString();
  for (const r of results) {
    if (!r) continue;
    mergeWeek(store, r.week, r.games, now);
    ok.push(`week ${r.week} (${r.games.length} games)`);
    log(`  ok   wk${String(r.week).padStart(2)} ${String(r.games.length).padStart(2)} games`);
  }

  store.fetchedAt = now;
  store.season = yr;
  mkdirSync(dir(yr), { recursive: true });
  writeJsonAtomic(filePath(yr), store, { indent: 0 });

  const rep = record('schedule', {
    ok, failed, sourceAt: null, season: yr, week: wk,
    items: Object.keys(store.teams).length,
    note: `${Object.keys(store.weeks).length} weeks stored`,
  });
  log(`  ${ok.length} ok, ${failed.length} failed — ${Object.keys(store.teams).length} teams -> ${filePath(yr)}`);
  return rep;
}
