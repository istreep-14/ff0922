/**
 * FantasyPros current-week and rest-of-season projections, from the public
 * ranking pages. Each board embeds `var ecrData = {...}`, and `r2p_pts` is
 * the projected points for that board. No API key.
 *
 * QB, K, and DST pages do not change with scoring format, so those URLs are
 * fetched once and copied onto every format.
 */
import { get, pool } from './http.js';
import { normPos, normTeam } from './names.js';

const RANK_BASE = 'https://www.fantasypros.com/nfl/rankings';
const SCORING_SENSITIVE = new Set(['rb', 'wr', 'te']);
export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

export function rankingUrl(position, scoring = 'PPR', { ros = false } = {}) {
  const p = String(position).toLowerCase();
  let base = p;
  if (SCORING_SENSITIVE.has(p)) {
    if (scoring === 'PPR') base = `ppr-${p}`;
    else if (scoring === 'HALF') base = `half-point-ppr-${p}`;
    else base = p;
  }
  return `${RANK_BASE}/${ros ? 'ros-' : ''}${base}.php`;
}

export function parseEcr(html, url = '') {
  const m = html.match(/var\s+ecrData\s*=\s*(\{.*?\});/s);
  if (!m) throw new Error(`no ecrData embedded${url ? ` at ${url}` : ''}`);
  return JSON.parse(m[1]);
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function playersFromEcr(data) {
  const out = [];
  for (const p of data?.players || []) {
    if (!p.player_id || !p.player_name) continue;
    out.push({
      fpId: String(p.player_id),
      name: p.player_name,
      team: normTeam(p.player_team_id),
      position: normPos(p.player_position_id),
      rank: num(p.rank_ecr),
      posRank: p.pos_rank ?? null,
      proj: num(p.r2p_pts),
      opp: p.player_opponent || null,
    });
  }
  return out.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
}

export async function fetchBoards({ scorings = ['PPR'], positions = POSITIONS, log = () => {} } = {}) {
  const jobs = new Map();
  for (const ros of [false, true]) {
    for (const scoring of scorings) {
      for (const position of positions) {
        const url = rankingUrl(position, scoring, { ros });
        const job = jobs.get(url) || { url, ros, position, scoring, formats: [] };
        job.formats.push(scoring);
        jobs.set(url, job);
      }
    }
  }

  const boards = {};
  for (const sc of scorings) boards[sc] = { week: [], ros: [] };
  const errors = [];

  await pool([...jobs.values()], async (job) => {
    const label = `${job.ros ? 'ROS' : 'week'} ${job.formats.join('/')} ${job.position}`;
    try {
      const html = await get(job.url, { asText: true });
      const players = playersFromEcr(parseEcr(html, job.url));
      for (const sc of job.formats) {
        const slot = job.ros ? 'ros' : 'week';
        boards[sc][slot].push(...players);
      }
      log(`  ok   ${label.padEnd(22)} ${players.length}`);
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
      log(`  FAIL ${label} — ${err.message}`);
    }
  }, { concurrency: 3 });

  for (const sc of scorings) {
    for (const slot of ['week', 'ros']) {
      boards[sc][slot].sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1) || (a.rank ?? 9999) - (b.rank ?? 9999));
    }
  }
  return { boards, errors };
}
