import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaleCheck, judge } from '../src/sourceaudit.js';

const rowsAt = (mult, n = 20) => Array.from({ length: n }, (_, i) => ({ pos: 'RB', v: (10 + i) * mult, ref: 10 + i }));

test('a source running uniformly high against FantasyPros is flagged', () => {
  const s = scaleCheck(rowsAt(1.46));
  assert.equal(s.RB.flag, 'high');
  assert.equal(scaleCheck(rowsAt(0.7)).RB.flag, 'low');
});

test('ordinary disagreement is not a scale problem', () => {
  assert.equal(scaleCheck(rowsAt(0.93)).RB.flag, null);
  assert.equal(scaleCheck(rowsAt(1.1)).RB.flag, null);
});

test('too few players, or too small a reference value, says nothing about scale', () => {
  assert.deepEqual(scaleCheck(rowsAt(2, 5)), {});
  assert.deepEqual(scaleCheck(Array.from({ length: 30 }, () => ({ pos: 'K', v: 4, ref: 2 }))), {});
});

test('judge fails on the wrong week or a scale flag, warns on an unverified label or old data', () => {
  const now = Date.parse('2026-09-20T12:00:00Z');
  const wrongWeek = judge({ name: 'x', prov: { week: 3, by: 'source' }, scale: {}, wantWeek: 2, now });
  assert.equal(wrongWeek.problems.length, 1);
  const scale = judge({ name: 'x', prov: { week: 2, by: 'source' }, scale: scaleCheck(rowsAt(1.5)), wantWeek: 2, now });
  assert.match(scale.problems[0], /RB runs high/);
  const ours = judge({ name: 'draftsharks', prov: { week: 2, by: 'us (unverifiable)', fetchedAt: '2026-09-14T00:00:00Z' }, scale: {}, wantWeek: 2, now });
  assert.equal(ours.problems.length, 0);
  assert.equal(ours.warnings.length, 2);
});
