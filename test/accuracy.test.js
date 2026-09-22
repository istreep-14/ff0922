import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accuracyStats } from '../src/accuracy.js';

test('error, bias and correlation on a small known set', () => {
  // projection, actual
  const st = accuracyStats([[10, 12], [20, 18], [5, 5], [15, 21]]);
  assert.equal(st.n, 4);
  assert.equal(st.mae, 2.5);          // (2 + 2 + 0 + 6) / 4
  assert.equal(st.bias, -1.5);        // (-2 + 2 + 0 - 6) / 4: runs low
  assert.equal(st.rmse, 3.32);        // sqrt((4 + 4 + 0 + 36) / 4) = sqrt(11)
  assert.ok(st.corr > 0.8 && st.corr <= 1);
});

test('a source that always projects the same number has no correlation, not a NaN', () => {
  assert.equal(accuracyStats([[7, 3], [7, 9], [7, 1]]).corr, null);
});

test('positive bias means it runs high', () => {
  assert.ok(accuracyStats([[12, 10], [22, 20]]).bias > 0);
});

test('non-finite pairs are ignored and an empty set scores nothing', () => {
  assert.equal(accuracyStats([[NaN, 3], [4, undefined]]), null);
  assert.equal(accuracyStats([[10, 10], [NaN, 4]]).n, 1);
});
