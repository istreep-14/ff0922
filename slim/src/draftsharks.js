/**
 * Draft Sharks current-week and rest-of-season rankings. The public page only
 * server-renders the top 25; the full board is the same table at
 * `/weekly-rankings/load-table` and `/ros-rankings/load-table`.
 */
import { get, pool } from './http.js';
import { normPos, normTeam, parseMatchup } from './names.js';

const BASE = 'https://www.draftsharks.com';
const HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  Referer: 'https://www.draftsharks.com/weekly-rankings/ppr',
  'HX-Request': 'true',
};

export const SCORING_SLUG = { PPR: 'ppr', HALF: 'half-ppr', STD: '' };

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
  const re = new RegExp(`<(?:td|span)[^>]*data-attribute="${attribute}"[^>]*data-value="([^"]*)"`, 'i');
  const a = block.match(re);
  if (a) return a[1];
  const re2 = new RegExp(`<(?:td|span)[^>]*data-value="([^"]*)"[^>]*data-attribute="${attribute}"`, 'i');
  const b = block.match(re2);
  return b ? b[1] : null;
}

function teamFrom(block) {
  const name = block.match(/player-details-group__team-name">([^<]+)/);
  if (name) return normTeam(name[1]);
  const alt = block.match(/\/img\/icons\/teams\/([A-Z]{2,3})\.svg/i);
  return alt ? normTeam(alt[1]) : null;
}

export function parsePlayerBlock(block) {
  const name = attr(block, 'data-player-name');
  const position = normPos(attr(block, 'data-fantasy-position'));
  if (!name || !position) return null;
  const matchupRaw = cellValue(block, 'matchup');
  const matchup = parseMatchup(matchupRaw);
  const sosRaw = cellValue(block, 'strength_of_schedule');
  const rankText = block.match(/rank-index[^>]*>\s*<span>(\d+)<\/span>/i);
  return {
    id: attr(block, 'data-key'),
    name,
    position,
    team: teamFrom(block),
    rank: rankText ? Number(rankText[1]) : numOr(attr(block, 'data-tier-overall')),
    matchup: matchupRaw,
    opp: matchup.bye ? null : matchup.opp,
    bye: matchup.bye || numOr(cellValue(block, 'player.team.bye')),
    sos: sosRaw != null ? numOr(String(sosRaw).replace('%', '')) : null,
    proj: numOr(cellValue(block, 'weeklyPts')),
    floor: numOr(cellValue(block, 'weeklyFloorPts')),
    ceiling: numOr(cellValue(block, 'weeklyCeilingPts')),
    games: numOr(cellValue(block, 'games_played')),
    rosWeekly: numOr(cellValue(block, 'rosWeeklyPts')),
    rosFloor: numOr(cellValue(block, 'rosWeeklyFloorPts') || cellValue(block, 'floor_points')),
    rosCeiling: numOr(cellValue(block, 'rosWeeklyCeilingPts') || cellValue(block, 'ceiling_points')),
    // The ROS table publishes a per-week average and a games count, not a
    // season total. The product is the rest-of-season points, which is the
    // same unit FantasyPros puts on its ROS board.
    rosTotal: rosTotal(block),
  };
}

function rosTotal(block) {
  const published = numOr(cellValue(block, 'fantasy_points'));
  if (published != null) return published;
  const weekly = numOr(cellValue(block, 'rosWeeklyPts'));
  const games = numOr(cellValue(block, 'games_played'));
  if (weekly == null || games == null) return null;
  return Math.round(weekly * games * 10) / 10;
}

export function parseRankingsTable(html) {
  const players = [];
  for (const raw of html.split(/<tbody\b/i).slice(1)) {
    if (!raw.includes('data-player-row')) continue;
    const rec = parsePlayerBlock(raw);
    if (rec) players.push(rec);
  }
  return players;
}

function loadUrl(kind, { week, scoring }) {
  const slug = SCORING_SLUG[String(scoring || 'PPR').toUpperCase()];
  const q = new URLSearchParams();
  if (slug) q.set('pprSuperflexSlug', slug);
  if (kind === 'week') {
    q.set('week', String(week));
    return `${BASE}/weekly-rankings/load-table?${q}`;
  }
  return `${BASE}/ros-rankings/load-table?${q}`;
}

async function fetchTable(url) {
  const res = await get(url, { asText: true, withHeaders: true, headers: HEADERS });
  const players = parseRankingsTable(res.body);
  if (!players.length) throw new Error(`no player rows at ${url}`);
  return { players, sourceAt: res.headers?.['last-modified'] || null };
}

export async function fetchDraftSharks({ week, scorings = ['PPR'], log = () => {} } = {}) {
  const jobs = [];
  for (const scoring of scorings) {
    jobs.push({ kind: 'week', week, scoring });
    jobs.push({ kind: 'ros', scoring });
  }
  const sharks = {};
  for (const sc of scorings) sharks[sc] = { week: [], ros: [], sourceAt: null };
  const errors = [];

  const results = await pool(jobs, async (job) => {
    const label = `${job.scoring} ${job.kind === 'ros' ? 'ROS' : `week ${job.week}`}`;
    try {
      const table = await fetchTable(loadUrl(job.kind, job));
      log(`  ok   ${label.padEnd(16)} ${table.players.length}`);
      return { ...job, ...table };
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
      log(`  FAIL ${label} — ${err.message}`);
      return null;
    }
  }, { concurrency: 2 });

  for (const r of results) {
    if (!r) continue;
    sharks[r.scoring][r.kind === 'ros' ? 'ros' : 'week'] = r.players;
    if (r.sourceAt) sharks[r.scoring].sourceAt = r.sourceAt;
  }
  return { sharks, errors };
}
