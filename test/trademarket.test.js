import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTradeMarket, tradeUrl, TRADE_SCORINGS } from '../src/trademarket.js';

const vs = (pairs) => pairs.map(([date, value]) => ({ date, value }));
const vol = (pairs) => pairs.map(([date, volume]) => ({ date, volume }));

const raw = () => ({
  type: 'redraft', scoring: 'PPR', anchorDate: '2026-09-19', windowDays: 3, timestamp: 1789811733,
  players: [
    { playerId: 1, name: 'Star RB', position: 'RB', team: 'DET', marketValue: 1000, prevMarketValue: 990, marketRankOverall: 1, marketRankPositional: 1,
      expertValue: 980, prevExpertValue: 970, ecrRankOverall: 2, ecrRankPositional: 1, valueGap: -20, rankGap: 1,
      valueSeries: vs([['2026-09-17', 980], ['2026-09-18', 990], ['2026-09-19', 1000]]), volumeSeries: vol([['2026-09-17', 5], ['2026-09-18', 9], ['2026-09-19', 12]]) },
    // A first-day player: one point of series, nothing for the days before.
    { playerId: 2, name: 'New WR', position: 'WR', team: 'CIN', marketValue: 400, prevMarketValue: null, marketRankOverall: 90, marketRankPositional: 30,
      expertValue: null, valueSeries: vs([['2026-09-19', 400]]), volumeSeries: vol([['2026-09-18', 2]]) },
    // Not priced: K and DST come back null, and so do fringe players.
    { playerId: 3, name: 'A Kicker', position: 'K', team: 'DAL', marketValue: null, valueSeries: [], volumeSeries: [] },
    // A draft pick has a synthetic id and no value in redraft.
    { playerId: 202700001, pickCode: '202700001', name: '2027 Pick 1', position: 'PICK', team: null, marketValue: null },
  ],
});

test('picks and unpriced rows are dropped, and counted', () => {
  const n = normalizeTradeMarket(raw());
  assert.deepEqual(n.players.map((p) => p.fpId), [1, 2]);
  assert.deepEqual(n.counts, { rows: 4, picksSkipped: 1, unpriced: 1, priced: 2 });
});

test('a player with no market value is absent, not a zero', () => {
  const n = normalizeTradeMarket(raw());
  assert.ok(!n.players.some((p) => p.fpId === 3));
  // ...while a genuine zero is a value and stays.
  const r = raw(); r.players[1].marketValue = 0;
  assert.equal(normalizeTradeMarket(r).players.find((p) => p.fpId === 2).value, 0);
});

test('series are aligned onto one date axis with nulls for the days a player lacks', () => {
  const n = normalizeTradeMarket(raw());
  assert.deepEqual(n.dates, ['2026-09-17', '2026-09-18', '2026-09-19']);
  assert.deepEqual(n.players[0].series, [980, 990, 1000]);
  assert.deepEqual(n.players[0].volume, [5, 9, 12]);
  assert.deepEqual(n.players[1].series, [null, null, 400]);
  assert.deepEqual(n.players[1].volume, [null, 2, null]);
});

test('a player with no chart data keeps null series instead of an empty array', () => {
  const r = raw(); delete r.players[0].valueSeries; delete r.players[0].volumeSeries;
  const p = normalizeTradeMarket(r).players[0];
  assert.equal(p.series, null);
  assert.equal(p.volume, null);
});

test('expert values are kept where present and null where absent', () => {
  const [a, b] = normalizeTradeMarket(raw()).players;
  assert.deepEqual(a.expert, { value: 980, prev: 970, rank: 2, posRank: 1, gap: -20, rankGap: 1 });
  assert.equal(b.expert, null);
});

test('the site timestamp becomes an ISO time, in seconds not milliseconds', () => {
  const n = normalizeTradeMarket(raw());
  assert.equal(n.sourceAt, new Date(1789811733 * 1000).toISOString());
  assert.equal(n.sourceAt.slice(0, 4), '2026');
});

test('a payload with rows but no values reports zero priced (dynasty / STANDARD look like this)', () => {
  const r = raw(); r.players.forEach((p) => { p.marketValue = null; });
  assert.equal(normalizeTradeMarket(r).counts.priced, 0);
});

test('anything that is not a market payload is null', () => {
  assert.equal(normalizeTradeMarket(null), null);
  assert.equal(normalizeTradeMarket({ error: 'x' }), null);
  assert.equal(normalizeTradeMarket({ players: 'nope' }), null);
});

test('the request asks for the redraft market with chart data, and never for STANDARD', () => {
  const u = new URL(tradeUrl({ scoring: 'HALF' }));
  assert.equal(u.origin + u.pathname, 'https://mpbnfl.fantasypros.com/api/tradeMarketValues');
  assert.equal(u.searchParams.get('type'), 'redraft');
  assert.equal(u.searchParams.get('scoring'), 'HALF');
  assert.equal(u.searchParams.get('includeChartData'), 'true');
  assert.ok(!new URL(tradeUrl({ chart: false })).searchParams.has('includeChartData'));
  assert.deepEqual(TRADE_SCORINGS, ['PPR', 'HALF', 'STD']);
});
