import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { get } from './http.js';
import { DATA } from './config.js';
import { writeJsonAtomic } from './jsonfile.js';
import { record } from './freshness.js';
import { resolve as resolveWeek } from './week.js';
import { SCORING_KEY } from './fpapi.js';

/**
 * Actual fantasy points for every NFL player, every week, from one public feed.
 *
 * Matchup lineups only know the players a league rostered when that board was
 * fetched. A past week captured as team scores, a free agent, or anyone the
 * lineup call missed then has no points at all. Sleeper's stats endpoint has
 * no auth and returns `pts_ppr` / `pts_half_ppr` / `pts_std` for everyone who
 * played that week, so the page can show a number without a lineup slot.
 *
 * League scoring still wins when the matchup board has the player and the
 * game has started — a custom interception penalty is not in this file.
 * This file is the number for everyone else, in the league's format
 * (PPR, half, or standard).
 *
 * A finished week is fetched once. The current week is refetched whenever
 * the pipeline says this source is stale, because points arrive as games end.
 * An empty response before Thursday is not written over a week that already
 * has a slate, and it is never treated as "everyone scored zero".
 */

const dirOf = (season) => join(DATA, 'actuals', String(season));
const fileOf = (season, week) => join(dirOf(season), `week-${week}.json`);

/** A full week scores a few hundred skill players, kickers and defenses. */
export const MIN_COMPLETE = 150;

export const statsUrl = (season, week) =>
  `https://api.sleeper.app/v1/stats/nfl/regular/${season}/${week}`;

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Keep only the three fantasy-point fields. Raw counting stats are not used. */
export function compactStats(raw) {
  const players = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return players;
  for (const [id, s] of Object.entries(raw)) {
    if (!s || typeof s !== 'object') continue;
    const row = {};
    const ppr = num(s.pts_ppr);
    const half = num(s.pts_half_ppr);
    const std = num(s.pts_std);
    if (ppr != null) row.ppr = ppr;
    if (half != null) row.half = half;
    if (std != null) row.std = std;
    if (Object.keys(row).length) players[String(id)] = row;
  }
  return players;
}

export function readWeekFile(season, week) {
  const path = fileOf(season, week);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Past weeks with a full slate stay on disk. The current week never does —
 * Sleeper fills it in as games finish, and a file from Thursday morning is
 * not the week's result.
 */
export function weekIsComplete(file, week, currentWeek) {
  if (!file) return false;
  if (Number(week) >= Number(currentWeek)) return false;
  return Object.keys(file.players || {}).length >= MIN_COMPLETE;
}

/** An empty feed must not erase a week that already has players. */
export function shouldReplace(prev, nextPlayers) {
  const prevN = Object.keys(prev?.players || {}).length;
  const nextN = Object.keys(nextPlayers || {}).length;
  if (nextN === 0 && prevN > 0) return false;
  return true;
}

export function formatPoints(cell, scoring) {
  if (!cell) return null;
  const key = SCORING_KEY[String(scoring || 'PPR').toUpperCase()] || 'ppr';
  return num(cell[key]);
}

/**
 * One map of week -> points for a player.
 *
 * Sleeper wins a week it has, because that feed covers everyone who played
 * and does not need an API key. FantasyPros' per-week actuals fill a week
 * Sleeper has not stored yet.
 */
export function mergeWeekPoints(sleeperByWeek, fpWeeks, scoring) {
  const out = {};
  if (fpWeeks && typeof fpWeeks === 'object') {
    for (const [w, v] of Object.entries(fpWeeks)) {
      const n = num(v);
      if (n != null) out[String(w)] = n;
    }
  }
  if (sleeperByWeek && typeof sleeperByWeek === 'object') {
    for (const [w, cell] of Object.entries(sleeperByWeek)) {
      const n = formatPoints(cell, scoring);
      if (n != null) out[String(w)] = n;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The number to show for one player-week.
 *
 * Matchup points are the league's own scoring, so they win once that
 * player's game has started. They are absent for anyone the lineup fetch
 * did not include. A kickoff that has not happened is not a zero.
 */
export function resolveWeeklyPoints({
  week,
  currentWeek,
  leaguePts = null,
  onBoard = false,
  started = false,
  statPts = null,
} = {}) {
  const live = Number(week) === Number(currentWeek);
  if (live && onBoard && !started) return null;
  if (leaguePts != null && (!live || onBoard)) return Number(leaguePts);
  if (statPts != null) return Number(statPts);
  return null;
}

/** sleeperId -> { "1": {ppr, half, std}, "2": ... } across every stored week. */
export function loadActualsIndex(season) {
  const idx = new Map();
  const dir = dirOf(season);
  if (!existsSync(dir)) return idx;
  for (const name of readdirSync(dir)) {
    const m = name.match(/^week-(\d+)\.json$/);
    if (!m) continue;
    const file = readWeekFile(season, Number(m[1]));
    const w = String(m[1]);
    for (const [id, cell] of Object.entries(file?.players || {})) {
      const rec = idx.get(id) || {};
      rec[w] = cell;
      idx.set(id, rec);
    }
  }
  return idx;
}

export async function syncActuals({ season, week, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const written = [];
  const skipped = [];
  log(`Weekly actuals — Sleeper stats, season ${yr}, through week ${wk}`);

  for (let w = 1; w <= wk; w++) {
    const prev = readWeekFile(yr, w);
    if (weekIsComplete(prev, w, wk)) {
      skipped.push(w);
      continue;
    }
    const raw = await get(statsUrl(yr, w));
    const players = compactStats(raw);
    if (!shouldReplace(prev, players)) {
      log(`  week ${w} — feed empty, kept ${Object.keys(prev.players).length} stored`);
      skipped.push(w);
      continue;
    }
    const file = {
      season: yr,
      week: w,
      source: 'sleeper',
      fetchedAt: new Date().toISOString(),
      complete: weekIsComplete({ players }, w, wk),
      players,
    };
    writeJsonAtomic(fileOf(yr, w), file);
    written.push({ week: w, players: Object.keys(players).length, complete: file.complete });
    log(`  week ${w} — ${Object.keys(players).length} players${file.complete ? '' : ' (still live)'}`);
  }

  record('actuals', {
    ok: written.map((w) => `wk${w.week}:${w.players}`),
    items: written.reduce((s, w) => s + w.players, 0),
    season: yr,
    week: wk,
    note: skipped.length ? `kept weeks ${skipped.join(',')}` : null,
  });
  return { season: yr, week: wk, written, skipped };
}
