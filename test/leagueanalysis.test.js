import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnalysis, analysisFor } from '../src/leagueanalysis.js';
import { fetchLeague, ENDPOINTS } from '../src/fantasypros.js';

/**
 * A two-team league, one slot per position plus one bench row.
 *
 *   team 1 (mine):  QB 100, WR 50 starting; bench RB 20    → roster 170, starters 150
 *   team 2:         QB  80, WR 60 starting; bench RB 10    → roster 150, starters 140
 */
const cell = (teamId, fpId, name, pos, vorp, extra = {}) => ({ teamId, fpId, name, pos, team: 'XXX', vorp, value: 10, pRank: 1, oRank: 5, ...extra });

const payload = (scores) => ({
  teamId: '1',
  teamName: 'Mine',
  eligibility: 30,
  actualStandings: { wins: 1, losses: 0, ties: 0, rank: 1 },
  futurePicksCount: 0,
  pointsLeague: false,
  tradePartners: [],
  positions: [{ tier: 1, rank: 1, position: 'QB', percent: 100 }, { tier: 2, rank: 2, position: 'WR', percent: 50 }],
  startersOnly: { tier: 1, rank: 1, position: 'Starters', percent: 100 },
  benchOnly: { tier: 1, rank: 1, position: 'Bench', percent: 100 },
  tradeNeeds: [{ rank: 2, position: 'WR' }],
  spiderWeb: { starters: [], bench: [{ tier: 'top', pos: 'RB', max: 2, rank: 1, value: 2 }] },
  starters: [{ position: 'QB', rank: 1, tier: 1, percent: 100, isTied: false, player: { fpId: 1, fullName: 'Q One', percentOwnedYahoo: 99 } }],
  standings: [
    { teamId: 1, teamName: 'Mine', rank: 1, tier: 1, score: scores[0], newscore: 100, percentAsNumber: 1, vorpPerc: 110, valuePerc: 100, isUser: true },
    { teamId: 2, teamName: 'Other', rank: 2, tier: 2, score: scores[1], newscore: 90, percentAsNumber: 0.5, vorpPerc: 90, valuePerc: 100, isUser: false },
  ],
  grid: [
    { position: 'Teams', cells: [{ teamId: 1, name: 'Mine' }, { teamId: 2, name: 'Other' }] },
    { position: 'QB', cells: [cell(1, 1, 'Q One', 'QB', 100), cell(2, 2, 'Q Two', 'QB', 80)] },
    { position: 'WR', cells: [cell(1, 3, 'W One', 'WR', 50), cell(2, 4, 'W Two', 'WR', 60, { oRank: undefined })] },
    { position: 'BN', cells: [cell(1, 5, 'B One', 'RB', 20), cell(2, 6, 'B Two', 'RB', 10)] },
  ],
});

test('the grid flattens to players keyed by fpId, with slot and starter flag', () => {
  const a = normalizeAnalysis(payload([170, 150]), 'ros');
  assert.equal(a.playerCount, 6);
  assert.deepEqual(a.slots, ['QB', 'WR', 'BN']);
  assert.equal(a.players['1'].slot, 'QB');
  assert.equal(a.players['1'].starter, true);
  assert.equal(a.players['5'].slot, 'BN');
  assert.equal(a.players['5'].starter, false);
  assert.equal(a.players['3'].vorp, 50);
});

test('a player outside the overall board has a null overall rank, not zero', () => {
  const a = normalizeAnalysis(payload([170, 150]), 'ros');
  assert.equal(a.players['4'].oRank, null);
  assert.equal(a.players['3'].oRank, 5);
});

test('teams come from standings, with the user marked', () => {
  const a = normalizeAnalysis(payload([170, 150]), 'ros');
  assert.deepEqual(a.teams.map((t) => [t.teamId, t.name, t.rank, t.isMine]), [[1, 'Mine', 1, true], [2, 'Other', 2, false]]);
  assert.equal(a.teams[0].score, 170);
  assert.equal(a.teams[0].index, 100);
});

test('ros scores the whole roster: the grid check passes on roster totals', () => {
  const a = normalizeAnalysis(payload([170, 150]), 'ros');
  assert.equal(a.basis, 'roster');
  assert.equal(a.scoreMatchesGrid, true);
});

test('week scores the starters only: the grid check passes on starter totals', () => {
  const a = normalizeAnalysis(payload([150, 140]), 'week');
  assert.equal(a.basis, 'starters');
  assert.equal(a.scoreMatchesGrid, true);
});

test('a score on the wrong basis fails the grid check rather than passing quietly', () => {
  // Roster totals under `week`, and starter totals under `ros`: the two ways
  // this endpoint would look right and be wrong.
  assert.equal(normalizeAnalysis(payload([170, 150]), 'week').scoreMatchesGrid, false);
  assert.equal(normalizeAnalysis(payload([150, 140]), 'ros').scoreMatchesGrid, false);
});

test('my team: position ranks, bench, lineup slots and trade needs are kept; the fat player object is not', () => {
  const me = normalizeAnalysis(payload([170, 150]), 'ros').me;
  assert.equal(me.teamId, '1');
  assert.deepEqual(me.positions[0], { position: 'QB', rank: 1, tier: 1, percent: 100 });
  assert.deepEqual(me.tradeNeeds, [{ position: 'WR', rank: 2 }]);
  assert.deepEqual(me.benchOnly, { position: 'Bench', rank: 1, tier: 1, percent: 100 });
  assert.deepEqual(me.benchByPosition, [{ position: 'RB', rank: 1, tier: 'top' }]);
  assert.deepEqual(me.lineup[0], { slot: 'QB', fpId: 1, name: 'Q One', rank: 1, tier: 1, percent: 100, tied: false });
  assert.ok(!JSON.stringify(me).includes('percentOwnedYahoo'));
});

test('a payload that is not an analysis normalizes to null', () => {
  assert.equal(normalizeAnalysis(null, 'ros'), null);
  assert.equal(normalizeAnalysis({ error: 'This league is set as inactive on FantasyPros.' }, 'ros'), null);
  assert.equal(normalizeAnalysis({ standings: [] }, 'ros'), null);
  assert.equal(normalizeAnalysis([], 'ros'), null);
});

test('analysisFor keeps the period that came back and is null only when neither did', () => {
  const ok = { ok: true, data: payload([170, 150]) };
  const bad = { ok: false, error: 'HTTP 500' };
  const both = analysisFor({ endpoints: { analysisRos: ok, analysisWeek: { ok: true, data: payload([150, 140]) } } });
  assert.equal(both.ros.period, 'ros');
  assert.equal(both.week.period, 'week');
  const one = analysisFor({ endpoints: { analysisRos: ok, analysisWeek: bad } });
  assert.equal(one.week, null);
  assert.equal(one.ros.teamCount, 2);
  assert.equal(analysisFor({ endpoints: { analysisRos: bad, analysisWeek: bad } }), null);
  assert.equal(analysisFor({ endpoints: {} }), null);
});

/* ---------------------------------------------------------------- the fetch */

const withFetch = async (handler, fn) => {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const body = handler(String(url));
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try { return await fn(urls); } finally { globalThis.fetch = real; }
};

const league = { key: 'nfl~abc-123', nickname: 'L', host: 'Sleeper' };

test('the analysis endpoints send the league key and their own period', async () => {
  await withFetch(() => payload([170, 150]), async (urls) => {
    await fetchLeague(league, ['analysisRos', 'analysisWeek']);
    const ros = urls.find((u) => u.includes('period=ros'));
    const week = urls.find((u) => u.includes('period=week'));
    assert.ok(ros && week, `expected both periods, got ${urls.join(' | ')}`);
    for (const u of [ros, week]) {
      assert.ok(u.startsWith('https://mpbnfl.fantasypros.com/api/getLeagueAnalysisJSON?'));
      // `~` may arrive as %7E once URLSearchParams has encoded it; both decode to the key.
      assert.equal(new URL(u).searchParams.get('key'), league.key);
    }
  });
});

test('a 200 carrying { error } is a failed analysis fetch, not an empty success', async () => {
  const inactive = () => ({ error: 'This league is set as inactive on FantasyPros.' });
  await withFetch(inactive, async () => {
    const r = await fetchLeague(league, ['analysisRos', 'analysisWeek']);
    assert.equal(r.endpoints.analysisRos.ok, false);
    assert.match(r.endpoints.analysisRos.error, /inactive/);
    assert.equal(analysisFor(r), null);
  });
});

test('other endpoints keep their existing behaviour for an { error } body', async () => {
  // Rosters are not marked errorIsFailure; changing that would be a separate decision.
  assert.equal(ENDPOINTS.rosters.errorIsFailure, undefined);
  await withFetch(() => ({ error: 'nope' }), async () => {
    const r = await fetchLeague(league, ['rosters']);
    assert.equal(r.endpoints.rosters.ok, true);
  });
});
