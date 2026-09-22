/**
 * MyPlaybook's league analysis — `getLeagueAnalysisJSON?key=…&period=ros|week`.
 *
 * What it is: FantasyPros valuing EVERY team's roster in the league, under that
 * league's own scoring and roster slots, against a replacement level. Nothing
 * else this app pulls is league-specific in this way — the ranking boards are
 * one universal list, and a league's own points come from games already played.
 *
 * The payload, by what is worth keeping:
 *
 *   `grid`       one row per lineup slot (QB, RB, RB, WR, … FLEX, BN×n), one
 *                cell per team, so it reads down a column as a team's roster.
 *                The first row, `Teams`, only names the columns. Each player
 *                cell carries `vorp` (points over replacement — this is what
 *                lets a QB and a WR be compared inside THIS league), `value`
 *                (a 0–60ish trade-chart style number; that reading is inferred),
 *                `pRank`/`oRank` (positional/overall rank) and `pos`. The slot
 *                is FantasyPros' OPTIMAL lineup for the roster, not the lineup
 *                the manager has set.
 *   `standings`  the teams ranked by `score` — the sum of `vorp` over the
 *                WHOLE roster for `ros` (bench depth is worth something over a
 *                season) but over the STARTERS only for `week` (a benched
 *                player scores nothing this week). `newscore` puts the scores on
 *                a 50–100 scale (worst team 50, best 100, the rest by where
 *                they fall between), `vorpPerc` is `score` as a percentage of
 *                the league's mean score (the mean is exactly 100), and there
 *                is a `tier`.
 *   `positions`, `startersOnly`, `benchOnly`, `tradeNeeds`, `starters`,
 *   `spiderWeb`  YOUR team only, as ranks among the league's teams (1 = best):
 *                by position group, starters as a whole, bench as a whole, the
 *                weakest groups, each lineup slot, and the bench by position.
 *                `percent` is that rank restated as a share of the league,
 *                (teams + 1 − rank) / teams. `starters` also carries a very
 *                large per-player object (a dozen other sites' ids, ownership
 *                percentages, alert text) that is deliberately not kept.
 *
 * `period` is `ros` (rest of season) or `week` (this week). Those are the only
 * two used here: any other value (`2`, `5`, `season` all behaved the same) gets
 * the same standings as `week` but an emptied-out bench evaluation, for reasons
 * that are not clear, and there is no way to ask for a specific week — "this
 * week" is whatever FantasyPros considers the current one.
 *
 * Unlike matchups and projected standings (mpbadvanced.js) this endpoint is
 * served for every league on the account, not just the FantasyPros-active one,
 * and so it syncs with the other per-league endpoints in fantasypros.js.
 */

const rankOf = (p) => ({ position: p.position, rank: p.rank, tier: p.tier, percent: p.percent });

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** A team's grid cells are the only place a rostered player's value appears. */
const isPlayerCell = (c) => c && c.fpId != null && c.teamId != null;

/**
 * One period's payload, flattened.
 *
 * Returns null for anything that is not a usable payload (an `{ error }`, an
 * empty body, a shape we have not seen), so the caller keeps one code path for
 * "no analysis" instead of guessing at half a structure.
 */
export function normalizeAnalysis(raw, period) {
  if (!raw || typeof raw !== 'object' || raw.error) return null;
  if (!Array.isArray(raw.grid) || !Array.isArray(raw.standings)) return null;

  // What `score` sums, per period. Checked below, not assumed.
  const basis = period === 'week' ? 'starters' : 'roster';
  const myId = raw.teamId != null ? String(raw.teamId) : null;

  const teams = raw.standings.map((s) => ({
    teamId: s.teamId,
    name: s.teamName ?? s.name ?? null,
    rank: s.rank ?? null,
    tier: s.tier ?? null,
    // Sum of VORP over the period's `basis` (see the header).
    score: num(s.score),
    // `score` on a 50–100 scale: the worst team is 50, the best 100.
    index: num(s.newscore),
    // `score` as a percentage of the league's mean score (mean = exactly 100).
    vorpPct: num(s.vorpPerc),
    // The same idea for trade value; it averages ~98, not 100, so what it is
    // a percentage OF is not confirmed. Kept, but nothing displays it.
    valuePct: num(s.valuePerc),
    isMine: s.isUser != null ? !!s.isUser : (myId != null && String(s.teamId) === myId),
  }));

  const players = {};
  const slots = [];
  const summed = new Map();
  for (const row of raw.grid) {
    if (!row || row.position === 'Teams' || !Array.isArray(row.cells)) continue;
    slots.push(row.position);
    for (const c of row.cells) {
      if (!isPlayerCell(c)) continue;
      const vorp = num(c.vorp);
      players[String(c.fpId)] = {
        teamId: c.teamId,
        // FantasyPros' optimal-lineup slot for this roster, not the set lineup.
        slot: row.position,
        starter: row.position !== 'BN',
        pos: c.pos ?? null,
        team: c.team ?? null,
        vorp,
        value: num(c.value),
        pRank: num(c.pRank),
        // Absent for players outside the overall board, not zero.
        oRank: num(c.oRank),
      };
      if (basis === 'roster' || row.position !== 'BN') {
        summed.set(String(c.teamId), (summed.get(String(c.teamId)) ?? 0) + (vorp ?? 0));
      }
    }
  }

  /**
   * Does the grid still add up to the standings?
   *
   * `score` is documented nowhere; its basis was inferred by summing the grid
   * both ways. It held to within rounding (<0.6) on every team of all four
   * leagues, and the wrong basis is off by 45–170, so a change in what either
   * number means shows up here as a false rather than as a quiet shift in the
   * page's team rankings.
   */
  const drift = teams.map((t) => Math.abs((summed.get(String(t.teamId)) ?? 0) - (t.score ?? 0)));
  const maxScoreDrift = drift.length ? Math.max(...drift) : null;

  return {
    period,
    basis,
    teamCount: teams.length,
    slots,
    teams,
    players,
    playerCount: Object.keys(players).length,
    scoreMatchesGrid: maxScoreDrift != null && maxScoreDrift <= 1,
    maxScoreDrift: maxScoreDrift == null ? null : Math.round(maxScoreDrift * 100) / 100,
    me: myId == null ? null : {
      teamId: raw.teamId,
      name: raw.teamName ?? null,
      // Meaning unconfirmed: 30 on the Sleeper league, 1–2 on ESPN and Yahoo.
      eligibility: raw.eligibility ?? null,
      record: raw.actualStandings ?? null,
      futurePicks: raw.futurePicksCount ?? null,
      pointsLeague: raw.pointsLeague ?? null,
      // Rank 1 is best; `percent` is the rank as a share of the league.
      positions: (raw.positions || []).map(rankOf),
      startersOnly: raw.startersOnly ? rankOf(raw.startersOnly) : null,
      benchOnly: raw.benchOnly ? rankOf(raw.benchOnly) : null,
      // The bench by position group. Only positions the league starts appear.
      benchByPosition: (raw.spiderWeb?.bench || []).map((b) => ({ position: b.pos, rank: b.rank, tier: b.tier })),
      // Each lineup slot: which of YOUR players fills it and how that slot
      // ranks against the same slot on the other teams.
      lineup: (raw.starters || []).map((x) => ({
        slot: x.position,
        fpId: x.player?.fpId ?? x.player?.id ?? null,
        name: x.player?.fullName ?? null,
        rank: x.rank ?? null,
        tier: x.tier ?? null,
        percent: x.percent ?? null,
        tied: !!x.isTied,
      })),
      tradeNeeds: (raw.tradeNeeds || []).map((n) => ({ position: n.position, rank: n.rank })),
      tradePartners: Array.isArray(raw.tradePartners) ? raw.tradePartners : [],
    },
  };
}

/**
 * Both periods for one scraped league, or null if neither came back.
 *
 * `r.endpoints` is the raw per-endpoint result from fetchLeague, so an endpoint
 * that failed is `{ ok: false }` with no `data`.
 */
export function analysisFor(r) {
  const ros = normalizeAnalysis(r.endpoints?.analysisRos?.data, 'ros');
  const week = normalizeAnalysis(r.endpoints?.analysisWeek?.data, 'week');
  return ros || week ? { ros, week } : null;
}
