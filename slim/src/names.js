/**
 * The three sources do not share ids. FantasyPros rosters and ranking boards
 * share `player_id`. Draft Sharks only has a name, so the join is name + position.
 */

const ALIAS = { JAX: 'JAC', WSH: 'WAS', WAS: 'WAS', LA: 'LAR', STL: 'LAR', SD: 'LAC', OAK: 'LV' };

export function normPos(position) {
  const p = String(position || '').toUpperCase();
  if (p === 'DEF' || p === 'DST' || p === 'D/ST') return 'DST';
  return p || null;
}

export function normTeam(abbr) {
  const t = String(abbr || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!t) return null;
  return ALIAS[t] || t;
}

export function parseMatchup(raw) {
  const s = String(raw || '').trim();
  // An absent cell is not a bye. The ROS board has no matchup column, and
  // treating that as a bye threw away the bye week that sits in another cell.
  if (!s) return { opp: null, home: null, bye: false };
  if (/^bye$/i.test(s)) return { opp: null, home: null, bye: true };
  const at = s.match(/^@\s*([A-Za-z]{2,3})$/) || s.match(/^(?:at|@)\s+([A-Za-z]{2,3})$/i);
  if (at) return { opp: normTeam(at[1]), home: false, bye: false };
  const vs = s.match(/^(?:vs\.?|v\.?)\s*([A-Za-z]{2,3})$/i);
  if (vs) return { opp: normTeam(vs[1]), home: true, bye: false };
  const plain = s.match(/^([A-Za-z]{2,3})$/);
  if (plain) return { opp: normTeam(plain[1]), home: true, bye: false };
  return { opp: normTeam(s), home: null, bye: false };
}

export function nameKey(name, position = '') {
  const n = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${n}|${normPos(position) || ''}`;
}

/** League scoring labels -> the board we actually fetch. */
export function scoringFormat(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (s === 'PPR') return 'PPR';
  if (s === 'HALF' || s === 'HALFPPR' || s === 'HALFPOINTPPR') return 'HALF';
  if (s === 'STD' || s === 'STANDARD') return 'STD';
  return null;
}
