import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './config.js';
import { pool } from './http.js';
import { getMatchup } from './mpbadvanced.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';

/**
 * Every matchup in a league, every week, for every host.
 *
 * MyPlaybook's matchup endpoint takes a `teamId` and answers for ANY team in
 * the league — not just yours — and a `week`, which reaches every past week
 * with full starter/bench slots and the league's own scoring. That one
 * endpoint is the whole scoreboard and the whole season for ESPN, Yahoo and
 * Sleeper alike: ask once per team, per week.
 *
 * Each pairing comes back twice, once from either side, so teams already seen
 * in a fetched matchup are skipped. A 12-team league costs 6 requests a week.
 *
 * The endpoint was long believed to answer only the current week, so season
 * totals used to be ACCUMULATED from whatever weeks a sync happened to catch,
 * and missed ESPN/Yahoo weeks were patched in from browser dumps that carry
 * team scores but no lineups. Now every sync re-asks any past week that is
 * missing, unfinished or lineup-less (`weekNeedsFetch`) and leaves settled
 * weeks alone, so data/scores/ converges on the full season by itself.
 */

const dir = (season) => join(DATA, 'scores', String(season));
const filePath = (season, week) => join(dir(season), `week-${week}.json`);

const sideOf = (t) => t && ({
  teamId: t.id ?? null,
  name: t.name || null,
  logo: t.logo || null,
  color: t.color || null,
  points: t.points ?? 0,
  projected: t.projected ?? null,
  projected0: t.originalProjected ?? null,
  status: t.status || null,
  result: t.result || null,
  isPreGame: !!t.isPreGame,
  minutesLeft: t.minutesLeft ?? null,
  /**
   * The full lineup, not a count of it.
   *
   * This used to collapse to `starters: n`, so per-player points had to come
   * from somewhere else — and the only somewhere else was FantasyPros' generic
   * PPR file, which is not what any of these leagues actually scores. See
   * slimSlot in mpbadvanced.js: these carry the league's own numbers.
   */
  starters: t.starters || [],
  bench: t.bench || [],
});

/**
 * One league's full slate. `teamIds` is every team; the order decides which
 * side of a pairing is fetched, nothing else.
 */
export async function fetchLeagueMatchups(league, { week = null, log = null } = {}) {
  const ids = (league.teams || []).map((t) => t.teamId).filter((x) => x != null);
  if (!ids.length) return { ok: false, error: 'no teams' };

  const seen = new Set();
  const pairs = [];
  let failed = 0;

  // Sequential on purpose: each result tells us which ids we no longer need to
  // ask about, and a parallel fan-out would throw that saving away.
  for (const id of ids) {
    if (seen.has(String(id))) continue;
    let r;
    try {
      r = await getMatchup(league.key, { teamId: id, week });
    } catch (err) {
      failed++;
      log?.(`    FAIL team ${id} — ${err.message.split('\n')[0]}`);
      seen.add(String(id));
      continue;
    }
    if (!r.ok) {
      // An inactive league answers for no team, so stop rather than ask N times.
      if (r.inactive) return { ok: false, inactive: true, error: r.error };
      failed++;
      seen.add(String(id));
      continue;
    }
    const a = sideOf(r.team1), b = sideOf(r.team2);
    [a, b].forEach((s) => { if (s?.teamId != null) seen.add(String(s.teamId)); });
    seen.add(String(id));
    pairs.push({
      status: r.status || null,
      isPreGame: !!r.isPreGame,
      live: !!r.liveUpdates,
      minutesLeft: r.minutesLeft ?? null,
      winProbability: r.winProbability ?? null,
      result: r.result || null,
      sides: [a, b].filter(Boolean),
    });
  }

  // MyPlaybook marks every team "noMatchup" before a week has kicked off. That
  // all-the-world-is-on-bye reading is what poisoned the scoreboard and the
  // standings' live column; a board of nothing but noMatchup cards is not data,
  // so it is stored as an empty week. A league-wide BYE week still has real
  // pairings around its byes, so the one-sided cards survive whenever the board
  // has anything else on it.
  const matchups = dedupe(pairs);
  const allNoMatchup = matchups.length > 0
    && matchups.every((m) => /no\s*matchup/i.test(String(m.status || '')));
  return { ok: true, failed, matchups: allNoMatchup ? [] : matchups };
}

/**
 * Collapse pairings that came back more than once.
 *
 * The skip-what-you-have-seen loop assumes the endpoint answers consistently:
 * ask about team 4 and you get 4's pairing. A 16-team ESPN league does not
 * always oblige — asking about one team occasionally returns a pairing that
 * team is not in, so a team already accounted for gets fetched again and the
 * board grows a seventeenth side for sixteen teams.
 *
 * Deduping on the pairing itself rather than on the request is the fix that
 * does not depend on upstream behaving: two sides sorted make a stable key, and
 * a one-sided card is dropped outright if that team also appears in a real
 * pairing (it is the same bye, reported twice).
 */
function dedupe(pairs) {
  const byKey = new Map();
  for (const m of pairs) {
    const ids = m.sides.map((s) => String(s.teamId ?? s.name)).sort();
    const key = ids.join('|');
    const prev = byKey.get(key);
    // Keep the copy with more sides, then the one further along.
    if (!prev || m.sides.length > prev.sides.length
      || (m.sides.length === prev.sides.length && (m.minutesLeft ?? 1e9) < (prev.minutesLeft ?? 1e9))) {
      byKey.set(key, m);
    }
  }
  const kept = [...byKey.values()];
  const paired = new Set(kept.filter((m) => m.sides.length > 1).flatMap((m) => m.sides.map((s) => String(s.teamId ?? s.name))));
  return kept.filter((m) => m.sides.length > 1 || !paired.has(String(m.sides[0]?.teamId ?? m.sides[0]?.name)));
}

/** Read one stored week. */
export function readWeek(season, week) {
  const p = filePath(season, week);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/**
 * Fold one league's board into a week file without touching the other leagues.
 *
 * `matchups:sync` rewrites the CURRENT week for every league at once. Past-week
 * backfills (ESPN/Yahoo ingest, a recovered snapshot) have to land in the same
 * files or `seasonTotals` / the week picker will not see them — but they must
 * not wipe a sibling league's live capture in that same week file.
 */
export function mergeLeagueWeek(season, week, leagueKey, payload, { fetchedAt = null } = {}) {
  const existing = readWeek(season, week) || { season, week, fetchedAt: null, leagues: {} };
  existing.leagues = existing.leagues || {};
  existing.leagues[leagueKey] = payload;
  if (fetchedAt) existing.fetchedAt = fetchedAt;
  else if (!existing.fetchedAt) existing.fetchedAt = new Date().toISOString();
  mkdirSync(dir(season), { recursive: true });
  writeFileSync(filePath(season, week), JSON.stringify(existing));
  return existing;
}

/** Every week on disk for a season, ascending. */
export function storedWeeks(season) {
  if (!existsSync(dir(season))) return [];
  return readdirSync(dir(season))
    .map((f) => f.match(/^week-(\d+)\.json$/)?.[1])
    .filter(Boolean).map(Number).sort((a, b) => a - b);
}

/**
 * Season points for and against per team, over every FINAL matchup on disk.
 *
 * Returns Map<leagueKey, Map<teamId, {pointsFor, pointsAgainst, games, weeks,
 * wins, losses, ties}>>. A bye (a matchup with one side) contributes points for
 * and no opponent, which is what it is — not a zero against.
 *
 * WHY PER MATCHUP AND NOT PER WEEK
 *
 * This counted only weeks where every matchup had finished, to avoid a table
 * where two teams carried a season total and ten carried nothing. That rule
 * traded one incoherence for a worse one: with a Monday night game outstanding,
 * the column was blank for the entire league — the number exists, and refusing
 * to show it is not accuracy.
 *
 * So a finished game counts as soon as it is finished, and `games` rides along
 * with every total. The column says how many games each row is over, which is
 * the honest version of the same caveat and the one you can act on.
 */
export function seasonTotals(season, { throughWeek = null } = {}) {
  const out = new Map();
  for (const wk of storedWeeks(season)) {
    if (throughWeek != null && wk > throughWeek) continue;
    const data = readWeek(season, wk);
    for (const [key, lg] of Object.entries(data?.leagues || {})) {
      if (!lg?.ok) continue;
      if (!out.has(key)) out.set(key, new Map());
      const byTeam = out.get(key);
      for (const m of lg.matchups || []) {
        if (!isFinal(m)) continue;
        const [a, b] = m.sides;
        const add = (self, opp) => {
          if (!self || self.teamId == null) return;
          const k = String(self.teamId);
          const cur = byTeam.get(k)
            || { pointsFor: 0, pointsAgainst: 0, games: 0, weeks: [], wins: 0, losses: 0, ties: 0 };
          cur.pointsFor += self.points || 0;
          cur.games++;
          if (!cur.weeks.includes(wk)) cur.weeks.push(wk);
          if (opp) {
            cur.pointsAgainst += opp.points || 0;
            if ((self.points || 0) > (opp.points || 0)) cur.wins++;
            else if ((self.points || 0) < (opp.points || 0)) cur.losses++;
            else cur.ties++;
          }
          byTeam.set(k, cur);
        };
        add(a, b); add(b, a);
      }
    }
  }
  // Float addition over a season drifts; one rounding at the end keeps the
  // column and any tiebreak computed from it agreeing to the same decimal.
  for (const byTeam of out.values()) {
    for (const t of byTeam.values()) {
      t.pointsFor = Number(t.pointsFor.toFixed(2));
      t.pointsAgainst = Number(t.pointsAgainst.toFixed(2));
    }
  }
  return out;
}

/**
 * Which weeks are complete for each league — the denominator behind every
 * accumulated total, so the UI can name it instead of implying a full season.
 */
export function completeWeeks(season, { throughWeek = null } = {}) {
  const out = new Map();
  for (const wk of storedWeeks(season)) {
    if (throughWeek != null && wk > throughWeek) continue;
    const data = readWeek(season, wk);
    for (const [key, lg] of Object.entries(data?.leagues || {})) {
      if (!lg?.ok || !(lg.matchups || []).length) continue;
      if (!lg.matchups.every(isFinal)) continue;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(wk);
    }
  }
  return out;
}

/**
 * A matchup is final when the host says so, or when the clock has run out.
 *
 * MyPlaybook's own word is "finished"; `liveUpdates` stays true even after, so
 * that flag says the league is being polled, not that the game is running.
 */
export const isFinal = (m) =>
  /final|finish|complete/i.test(String(m.status || '')) || (!m.isPreGame && m.minutesLeft === 0);

/**
 * Does this league's stored copy of a week need asking for again?
 *
 * The current week always does — scores move. A past week does when it is
 * missing, failed, not yet final, or has no lineup slots (a browser-dump
 * backfill: team scores only, so the page fell back to "no lineup was stored").
 * A settled past week with lineups is never re-asked.
 */
export function weekNeedsFetch(entry, week, currentWeek) {
  if (Number(week) >= Number(currentWeek)) return true;
  if (!entry?.ok || !(entry.matchups || []).length) return true;
  if (!entry.matchups.every(isFinal)) return true;
  return !entry.matchups.every((m) => (m.sides || []).every((s) => (s.starters || []).length > 0));
}

export async function matchupsSync({ season, week, leagues, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  log(`League matchups — season ${yr}, weeks 1–${wk}, ${leagues.length} league(s)`);
  const ok = [], failed = [];

  await pool(leagues, async (l) => {
    const label = `${(l.host || '').padEnd(8)} ${(l.nickname || '').slice(0, 24).padEnd(25)}`;
    const fetched = [];
    let kept = 0;
    for (let w = 1; w <= Math.max(wk, 1); w++) {
      const stored = readWeek(yr, w)?.leagues?.[l.key];
      if (!weekNeedsFetch(stored, w, wk)) { kept++; continue; }
      const r = await fetchLeagueMatchups(l, { week: w, log });
      if (r.inactive) {
        log(`  skip ${label} ${r.error}`);
        return;
      }
      // A failed fetch never overwrites a stored copy that has data in it.
      if (r.ok || !stored?.ok) mergeLeagueWeek(yr, w, l.key, r);
      if (!r.ok) {
        log(`  FAIL ${label} week ${w} — ${r.error}`);
        failed.push({ label: `${l.nickname || l.key} week ${w}`, error: r.error });
        continue;
      }
      fetched.push(w);
    }
    log(`  ok   ${label} fetched wk ${fetched.join(',') || '—'}${kept ? ` · kept ${kept} settled` : ''}`);
    ok.push(l.nickname || l.key);
  }, { concurrency: 2 });

  const weeks = storedWeeks(yr);
  record('matchups', { ok, failed, sourceAt: null, season: yr, week: wk,
    items: ok.length, note: `weeks on disk: ${weeks.join(', ') || 'none'}` });
  log(`  -> ${dir(yr)} (season history: week ${weeks.join(', ')})`);
  return readWeek(yr, wk)?.leagues || {};
}
