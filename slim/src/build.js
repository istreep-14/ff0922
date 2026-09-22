/**
 * One snapshot: each rostered player carries FantasyPros week and rest-of-season
 * points plus the Draft Sharks pair. Boards stay on the snapshot so the HTML
 * can show the full lists, not only rostered players.
 */
import { nameKey, normPos, scoringFormat } from './names.js';

function byId(players) {
  const m = new Map();
  for (const p of players || []) if (p.fpId) m.set(String(p.fpId), p);
  return m;
}

function byName(players) {
  const m = new Map();
  for (const p of players || []) m.set(nameKey(p.name, p.position), p);
  return m;
}

export function scoringsInUse(leagues) {
  const found = new Set();
  for (const l of leagues || []) {
    const s = scoringFormat(l.scoring);
    if (s) found.add(s);
  }
  return found.size ? [...found] : ['PPR'];
}

/**
 * An empty league list from MyPlaybook is a dead session, not an empty
 * account. Keep the previous leagues rather than writing nothing over them.
 */
export function keepLeagues(previous, next) {
  if (next.length) return { leagues: next, kept: false };
  if (previous?.length) return { leagues: previous, kept: true };
  return { leagues: [], kept: false };
}

function attach(player, boards, sharks) {
  const fpW = boards.week.get(String(player.fpId));
  const fpR = boards.ros.get(String(player.fpId));
  const name = player.name || fpW?.name || fpR?.name || null;
  const position = normPos(player.position || fpW?.position || fpR?.position);
  const team = player.team || fpW?.team || fpR?.team || null;
  const key = nameKey(name, position);
  const dsW = sharks.week.get(key);
  const dsR = sharks.ros.get(key);
  return {
    ...player,
    name: name || `fpId ${player.fpId}`,
    position,
    team,
    fpWeek: fpW?.proj ?? null,
    fpRos: fpR?.proj ?? null,
    fpWeekRank: fpW?.rank ?? null,
    fpRosRank: fpR?.rank ?? null,
    dsWeek: dsW?.proj ?? null,
    dsRos: dsR?.rosTotal ?? null,
    dsWeekRank: dsW?.rank ?? null,
    dsRosRank: dsR?.rank ?? null,
    opp: fpW?.opp || dsW?.opp || null,
  };
}

const SLOT = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'WRRB', 'W/R/T', 'SUPER', 'OP', 'K', 'DST', 'BN'];

function slotRank(slot) {
  const i = SLOT.indexOf(String(slot || '').toUpperCase());
  return i === -1 ? SLOT.length : i;
}

export function orderRoster(players) {
  return [...players].sort((a, b) => {
    const starter = Number(b.starter === true) - Number(a.starter === true);
    if (starter) return starter;
    const slot = slotRank(a.slot) - slotRank(b.slot);
    if (slot) return slot;
    return (b.fpWeek ?? -1) - (a.fpWeek ?? -1);
  });
}

export function buildSnapshot({ season, week, leagues, boards, sharks, errors = [], fetchedAt = new Date().toISOString() }) {
  const scorings = scoringsInUse(leagues);
  const joined = leagues.map((league) => {
    const sc = scoringFormat(league.scoring) || scorings[0] || 'PPR';
    const board = boards[sc] || { week: [], ros: [] };
    const shark = sharks[sc] || { week: [], ros: [] };
    const idx = {
      week: byId(board.week),
      ros: byId(board.ros),
    };
    const ds = { week: byName(shark.week), ros: byName(shark.ros) };
    return {
      ...league,
      scoring: sc,
      teams: (league.teams || []).map((t) => ({
        ...t,
        players: orderRoster((t.players || []).map((p) => attach(p, idx, ds))),
      })).sort((a, b) => Number(b.isMine) - Number(a.isMine)),
    };
  });

  return { fetchedAt, season, week, scorings, errors, leagues: joined, boards, sharks };
}
