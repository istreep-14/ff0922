import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rosUniqueSignals, rosValues } from '../src/rosvalue.js';

const rows = [
  { i: 1, p: 'QB', fp: 100, ds: 99, market: 900 },
  { i: 2, p: 'QB', fp: 80, ds: 82, market: 700 },
  { i: 3, p: 'QB', fp: 60, ds: 61, market: 500 },
  { i: 4, p: 'RB', fp: 100, ds: 98, market: 900 },
  { i: 5, p: 'RB', fp: 80, ds: 81, market: 700 },
  { i: 6, p: 'RB', fp: 60, ds: 62, market: 500 },
];
const fp = { id: 'fp:ros', productId: 'fp:ros', family: 'projection', score: (r) => r.fp };
const ds = { id: 'ds:ros', productId: 'ds:ros', family: 'projection', score: (r) => r.ds };
const market = { id: 'market', productId: 'market', family: 'market', score: (r) => r.market };
const league = { replacementRanks: { QB: 3, RB: 3 }, dollarsPerUtility: 60 };

test('a duplicate product receives one vote, with the higher-priority direct source retained', () => {
  const copy = { ...fp, id: 'fp:dd-copy', priority: 0 };
  const direct = { ...fp, priority: 1 };
  assert.deepEqual(rosUniqueSignals([copy, direct]).map((s) => s.id), ['fp:ros']);
});

test('dynasty and ADP-only inputs stay out of a redraft ROS blend', () => {
  const dynasty = { ...market, id: 'dynasty', productId: 'dynasty', kind: 'dynasty' };
  const adp = { ...market, id: 'adp', productId: 'adp', kind: 'adp' };
  assert.deepEqual(rosUniqueSignals([fp, dynasty, adp]).map((s) => s.id), ['fp:ros']);
});

test('auction values use a fixed conversion, not the current top player as a denominator', () => {
  const before = rosValues(rows, [fp, ds, market], league);
  const movedTop = rows.map((r) => r.i === 1 ? { ...r, fp: 10000, ds: 9000, market: 100000 } : r);
  const after = rosValues(movedTop, [fp, ds, market], league);
  assert.equal(before.players.get(2).auctionValue, 40);
  assert.equal(after.players.get(2).auctionValue, 40);
  assert.equal(before.players.get(2).positionRank, after.players.get(2).positionRank);
});

test('a deeper replacement rank makes a quarterback more valuable without changing his positional rank', () => {
  const oneQb = rosValues(rows, [fp, ds, market], league);
  const superflex = rosValues(rows, [fp, ds, market], { ...league, replacementRanks: { QB: 6, RB: 3 } });
  assert.equal(oneQb.players.get(2).positionRank, 2);
  assert.equal(superflex.players.get(2).positionRank, 2);
  assert.ok(superflex.players.get(2).auctionValue > oneQb.players.get(2).auctionValue);
});

test('a player at or below replacement is worth zero, never a negative bid', () => {
  const value = rosValues(rows, [fp, ds, market], { ...league, replacementRanks: { QB: 2, RB: 2 } });
  assert.equal(value.players.get(3).auctionValue, 0);
});
