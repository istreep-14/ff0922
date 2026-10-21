/**
 * Team scoring from player trade values, two ways:
 *
 *   contender  the value of the best legal lineup this roster can field — who
 *              wins NOW. Bench players add nothing to it.
 *   trade      the value of every rostered player — what the roster is WORTH
 *              in a trade, depth included.
 *
 * Both are sums inside ONE market (Dynasty Daddy republishes a dozen, on
 * different scales); nothing here mixes markets. Tiers and needs follow Dynasty
 * Daddy's own power rankings so the two pages agree on what "Contender" means.
 *
 * Used twice, unchanged: Node imports it for the tests, and the dashboard has
 * its text inlined at build time (see renderHtml). No imports here for that
 * reason, and every name carries a `pr` prefix so it cannot collide with the
 * page's own.
 */

export const PR_TIERS = ['Super Team', 'Contender', 'Frisky', 'Fraud', 'Rebuilding', 'Trust the Process'];

/** Statuses that keep a player out of a contender lineup — Dynasty Daddy's list, plus NFI. */
export const PR_UNAVAILABLE = ['IR', 'PUP', 'SUS', 'COV', 'NFI'];

export const PR_GROUPS = ['QB', 'RB', 'WR', 'TE'];

const PR_FLEX = {
  FLEX: ['RB', 'WR', 'TE'],
  'W/R/T': ['RB', 'WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  SUPERFLEX: ['QB', 'RB', 'WR', 'TE'],
  OP: ['QB', 'RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
};
const PR_BENCH = new Set(['BN', 'BE', 'BENCH', 'IR', 'IL', 'RES', 'RESERVE', 'TAXI', 'NA']);
const prPos = (p) => {
  const s = String(p || '').toUpperCase().replace(/\s+/g, '');
  return s === 'D/ST' || s === 'DEF' || s === 'DF' ? 'DST' : s;
};

/** `["QB","WR/RB/TE","BN",…]` -> the starting slots, each as the positions it accepts. */
export function prSlots(rosterSlots) {
  const out = [];
  for (const raw of rosterSlots || []) {
    const s = prPos(raw);
    if (!s || PR_BENCH.has(s)) continue;
    out.push(PR_FLEX[s] || s.split('/').map(prPos));
  }
  return out;
}

/** A second quarterback can start: the league prices QBs on the superflex board. */
export function prSuperflex(slots) {
  return slots.filter((s) => s.includes('QB')).length >= 2 || slots.some((s) => s.includes('QB') && s.length > 1);
}

const prOut = (p) => PR_UNAVAILABLE.includes(String(p.inj || '').toUpperCase());

/**
 * The best lineup by value: single-position slots first, then the flex slots
 * from the narrowest to the widest, each taking the most valuable eligible
 * player left. An unpriced player (K, DST, a market's fringe) counts as 0.
 *
 * `players`: [{ id, pos, value, inj }]
 */
export function prLineup(players, slots) {
  const pool = players.filter((p) => !prOut(p)).map((p) => ({ ...p, pos: prPos(p.pos), value: Number(p.value) || 0 }))
    .sort((a, b) => b.value - a.value);
  const order = slots.map((s, i) => ({ s, i })).sort((a, b) => a.s.length - b.s.length || a.i - b.i);
  const used = new Set();
  const lineup = new Array(slots.length).fill(null);
  for (const { s, i } of order) {
    const pick = pool.find((p) => !used.has(p.id) && s.includes(p.pos));
    if (!pick) continue;
    used.add(pick.id);
    lineup[i] = pick;
  }
  return {
    lineup: lineup.map((p, i) => ({ slot: slots[i].join('/'), id: p ? p.id : null, value: p ? p.value : 0 })),
    value: lineup.reduce((s, p) => s + (p ? p.value : 0), 0),
  };
}

/** 1-based ranks, highest first; ties share the better rank. */
export function prRanks(values) {
  const sorted = values.slice().sort((a, b) => b - a);
  return values.map((v) => sorted.indexOf(v) + 1);
}

/**
 * Dynasty Daddy's tiering: four equal-width bands between the lowest and
 * highest score, top band Contender (1) down to Rebuilding (4). A team alone
 * in the top band is a Super Team (0); alone in the bottom, Trust the Process (5).
 */
export function prTiers(values) {
  if (!values.length) return [];
  const lo = Math.min(...values), hi = Math.max(...values);
  if (hi === lo) return values.map(() => 1);
  const width = (hi - lo) / 4;
  const band = values.map((v) => 3 - Math.min(3, Math.floor((v - lo) / width)));
  const count = [0, 0, 0, 0];
  band.forEach((b) => count[b]++);
  return band.map((b) => (b === 0 && count[0] === 1 ? 0 : b === 3 && count[3] === 1 ? 5 : b + 1));
}

/**
 * Score every team in a league.
 *
 * `teams`: [{ id, players: [{ id, pos, value, inj }] }] with `value` already
 * read from the chosen market (superflex or 1QB board). Returns one row per
 * team, in the input order.
 */
export function prScoreTeams(teams, rosterSlots) {
  const slots = prSlots(rosterSlots);
  const rows = teams.map((t) => {
    const { lineup, value: contender } = prLineup(t.players, slots);
    const trade = t.players.reduce((s, p) => s + (Number(p.value) || 0), 0);
    const groups = {};
    for (const g of PR_GROUPS) groups[g] = { value: t.players.filter((p) => prPos(p.pos) === g).reduce((s, p) => s + (Number(p.value) || 0), 0) };
    return { id: t.id, contender, trade, bench: trade - contender, groups, lineup };
  });
  const n = rows.length;
  prRanks(rows.map((r) => r.contender)).forEach((rk, i) => { rows[i].contenderRank = rk; });
  prRanks(rows.map((r) => r.trade)).forEach((rk, i) => { rows[i].tradeRank = rk; });
  prTiers(rows.map((r) => r.contender)).forEach((t, i) => { rows[i].tier = t; });
  prTiers(rows.map((r) => r.trade)).forEach((t, i) => { rows[i].valueTier = t; });
  for (const g of PR_GROUPS) prRanks(rows.map((r) => r.groups[g].value)).forEach((rk, i) => { rows[i].groups[g].rank = rk; });
  // Dynasty Daddy's needs: bottom fifth of the league at a position first,
  // then the bottom third, at most three.
  for (const r of rows) {
    const weak = (cut) => PR_GROUPS.filter((g) => r.groups[g].rank >= cut);
    r.needs = [...new Set([...weak(n * 0.8), ...weak(n * 0.66)])].slice(0, 3);
  }
  return rows;
}

/**
 * How hard each team's remaining schedule is: the mean contender score of the
 * opponents it still has to play, weeks `from` through `to`. `schedule` is
 * { week: [[{id}, {id}], …] }. Rank 1 is the hardest road.
 */
export function prScheduleStrength(rows, schedule, { from, to }) {
  const score = new Map(rows.map((r) => [String(r.id), r.contender]));
  const opps = new Map(rows.map((r) => [String(r.id), []]));
  for (let w = from; w <= to; w++) {
    for (const pair of (schedule && schedule[w]) || []) {
      if (!pair || pair.length !== 2) continue;
      const [a, b] = pair.map((s) => String(s.id));
      if (opps.has(a) && score.has(b)) opps.get(a).push(score.get(b));
      if (opps.has(b) && score.has(a)) opps.get(b).push(score.get(a));
    }
  }
  const out = rows.map((r) => {
    const o = opps.get(String(r.id));
    return { id: r.id, games: o.length, mean: o.length ? o.reduce((s, v) => s + v, 0) / o.length : null };
  });
  const scored = out.filter((x) => x.mean != null);
  const ranks = prRanks(scored.map((x) => x.mean));
  scored.forEach((x, i) => { x.rank = ranks[i]; });
  return out;
}
