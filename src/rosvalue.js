/**
 * Rest-of-season player ordering and fixed-scale auction-equivalent values.
 *
 * Every input contributes only a within-position order. Values from external
 * boards never mix: the source's own scale becomes a rank, ranks combine by
 * family, and league scarcity turns that order into a fixed auction guideline.
 * The auction conversion deliberately does not divide by the current best
 * player, so a change to RB1 cannot rebase every other displayed dollar value.
 *
 * This module has no imports because the dashboard can inline it when it is
 * wired in. Callers supply signal score functions and replacement ranks.
 */

export const ROS_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

export const ROS_FAMILY_WEIGHTS = { projection: 0.6, market: 0.4, dynasty: 0 };

export const ROS_AUCTION_DEFAULTS = {
  budgetPerTeam: 200,
  dollarsPerUtility: 50,
  familyWeights: ROS_FAMILY_WEIGHTS,
};

const rosFinite = (v) => v != null && Number.isFinite(Number(v));
const rosMedian = (rows) => {
  if (!rows.length) return null;
  const sorted = rows.slice().sort((a, b) => a - b);
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

/** A source's rank and board depth for every player it covers, per position. */
function rosSignalRanks(players, signal) {
  const ranks = new Map(), depth = {};
  for (const pos of ROS_POSITIONS) {
    const scored = players.filter((p) => p.pos === pos).map((p) => ({ id: p.id, score: signal.score(p.row) }))
      .filter((x) => rosFinite(x.score)).sort((a, b) => Number(b.score) - Number(a.score) || String(a.id).localeCompare(String(b.id)));
    scored.forEach((x, i) => ranks.set(x.id, i + 1));
    depth[pos] = scored.length;
  }
  return { ...signal, ranks, depth };
}

/** Keep one signal per underlying product; a direct/high-priority copy wins. */
export function rosUniqueSignals(signals, { keeper = false } = {}) {
  const chosen = new Map();
  for (const signal of signals || []) {
    if (!signal || typeof signal.score !== 'function') continue;
    if (signal.kind === 'dynasty' && !keeper) continue;
    if (signal.kind === 'adp' || signal.eligible === false) continue;
    const key = signal.productId || signal.id;
    if (!key) continue;
    const prior = chosen.get(key);
    if (!prior || (signal.priority ?? 0) > (prior.priority ?? 0)) chosen.set(key, signal);
  }
  return [...chosen.values()];
}

/** A lower percentile is better: rank 1 on a 100-player board is 0.005. */
const rosPercentile = (rank, depth) => (depth > 0 ? (rank - 0.5) / depth : null);

/**
 * Value a league's players from ROS orders.
 *
 * `rows`: [{ i, p, ... }]
 * `signals`: [{ id, productId?, family, kind?, priority?, score(row) }]
 * `league`: {
 *   keeper?: boolean,
 *   replacementRanks: { QB, RB, WR, TE },
 *   budgetPerTeam?: number,
 *   dollarsPerUtility?: number,
 *   familyWeights?: { projection, market, dynasty }
 * }
 *
 * A replacement rank is the first player who is not meaningfully rosterable
 * at that position (for example QB19 in a 12-team 1-QB league). It is passed
 * by the caller because lineup/flex demand belongs to league setup, not here.
 */
export function rosValues(rows, signals, league = {}) {
  const players = (rows || []).filter((r) => ROS_POSITIONS.includes(r.p)).map((r) => ({ id: r.i, pos: r.p, row: r }));
  const live = rosUniqueSignals(signals, league).map((s) => rosSignalRanks(players, s)).filter((s) => s.ranks.size);
  const weights = { ...ROS_FAMILY_WEIGHTS, ...(league.familyWeights || {}) };
  const families = [...new Set(live.map((s) => s.family).filter(Boolean))];
  const replacementRanks = league.replacementRanks || {};
  const dollarsPerUtility = Number(league.dollarsPerUtility ?? ROS_AUCTION_DEFAULTS.dollarsPerUtility);

  for (const player of players) {
    const inputs = [];
    for (const signal of live) {
      const rank = signal.ranks.get(player.id);
      if (rank != null) {
        inputs.push({ id: signal.id, productId: signal.productId || signal.id, family: signal.family, rank, depth: signal.depth[player.pos], percentile: rosPercentile(rank, signal.depth[player.pos]), imputed: false });
      }
    }
    player.inputs = inputs;
    player.byFamily = {};
    for (const family of families) {
      const values = inputs.filter((x) => x.family === family).map((x) => x.percentile);
      player.byFamily[family] = values.length ? rosMedian(values) : null;
    }
    const active = families.filter((family) => player.byFamily[family] != null && Number(weights[family]) > 0);
    const totalWeight = active.reduce((n, family) => n + Number(weights[family]), 0);
    player.order = totalWeight ? active.reduce((n, family) => n + player.byFamily[family] * Number(weights[family]), 0) / totalWeight : null;
    const realRanks = inputs.map((x) => x.rank);
    player.range = realRanks.length > 1 ? [Math.min(...realRanks), Math.max(...realRanks)] : null;
    player.sourceCount = inputs.length;
  }

  const ranked = [];
  for (const pos of ROS_POSITIONS) {
    const group = players.filter((p) => p.pos === pos && p.order != null).sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
    const replacement = Number(replacementRanks[pos]);
    group.forEach((player, index) => {
      player.positionRank = index + 1;
      player.replacementRank = Number.isFinite(replacement) && replacement > 0 ? replacement : null;
      // A fixed rank-to-utility curve. It has no dependency on the top player's score.
      player.utility = player.replacementRank == null ? null : Math.max(0, (player.replacementRank - player.positionRank + 1) / player.replacementRank);
      player.auctionValue = player.utility == null ? null : Math.round(player.utility * dollarsPerUtility * 10) / 10;
      ranked.push(player);
    });
  }
  ranked.sort((a, b) => (b.auctionValue ?? -1) - (a.auctionValue ?? -1) || a.order - b.order || String(a.id).localeCompare(String(b.id)));
  ranked.forEach((player, index) => { player.overallRank = index + 1; });

  const out = new Map(ranked.map((p) => [p.id, {
    positionRank: p.positionRank,
    overallRank: p.overallRank,
    auctionValue: p.auctionValue,
    utility: p.utility,
    replacementRank: p.replacementRank,
    sourceCount: p.sourceCount,
    range: p.range,
    inputs: p.inputs,
    families: p.byFamily,
  }]));
  return { players: out, signals: live.map((s) => ({ id: s.id, productId: s.productId || s.id, family: s.family, kind: s.kind ?? null })), budgetPerTeam: Number(league.budgetPerTeam ?? ROS_AUCTION_DEFAULTS.budgetPerTeam), dollarsPerUtility };
}
