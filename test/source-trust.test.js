import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreComponents, boardScoringDrift } from '../src/vegas.js';
import { resolveSourceWeek } from '../src/sourceweek.js';
import { scaleCheck, judge } from '../src/sourceaudit.js';
import { parseDeclaredWeek } from '../src/winwithodds.js';

// The stat lines VegasEdge published on 2026-09-19 15:00 ET, when its board was
// scored at 0.16/yd, 1.5/rec, 7/TD. `sitePoints` is what the site printed then.
const BIJAN = { position: 'RB', rushingYds: 83.8532, receivingYds: 42.9624, receptions: 4.7694, expectedTds: 0.9779, sitePoints: 34.29 };
const GIBBS = { position: 'RB', rushingYds: 90.0978, receivingYds: 32.3813, receptions: 4.2838, expectedTds: 1.1405, sitePoints: 34.01 };
// Live pull the next morning, plain PPR, where the site printed 23.8.
const ALLEN = { position: 'QB', passYds: 254.3282, passTds: 1.6272306190151256, ints: 0.4336, rushingYds: 33.4131, rushTds: 0.7735, sitePoints: 23.8 };

test('points are scored from the stat line, not read from the site', () => {
  // The inflated board printed 34.29; the same props at PPR are 23.32.
  assert.equal(scoreComponents(BIJAN, 'PPR'), 23.32);
  assert.equal(scoreComponents(GIBBS, 'PPR'), 23.37);
});

test('one stat line scores exactly at every format', () => {
  // half-PPR sits midway between PPR and standard by 0.5 x receptions
  const ppr = scoreComponents(BIJAN, 'PPR'), half = scoreComponents(BIJAN, 'HALF'), std = scoreComponents(BIJAN, 'STD');
  assert.ok(Math.abs((ppr - half) - 0.5 * BIJAN.receptions) < 0.011);
  assert.ok(Math.abs((half - std) - 0.5 * BIJAN.receptions) < 0.011);
});

test('a QB is scored from pass and rush stats, and matches the site at PPR', () => {
  assert.equal(scoreComponents(ALLEN, 'PPR'), 23.8);
  // receptions do not touch a QB, so every format agrees
  assert.equal(scoreComponents(ALLEN, 'STD'), scoreComponents(ALLEN, 'PPR'));
});

test('an incomplete stat line scores null, never a partial number', () => {
  assert.equal(scoreComponents({ position: 'QB', rushingYds: 33 }, 'PPR'), null);
  assert.equal(scoreComponents({ position: 'WR', receivingYds: 80 }, 'PPR'), null);
});

test('a board scored at someone else\'s settings is detected; a plain PPR board is not', () => {
  const inflated = Array.from({ length: 12 }, () => BIJAN);
  assert.equal(boardScoringDrift(inflated).drifted, true);
  assert.ok(boardScoringDrift(inflated).medianRatio > 1.4);
  const plain = inflated.map((p) => ({ ...p, sitePoints: scoreComponents(p, 'PPR') }));
  assert.equal(boardScoringDrift(plain).drifted, false);
});

test('drift is judged on real lines: depth players barely move under a scale change', () => {
  // 1-point rows differ by 0.6 under the inflated scoring; 23-point rows by 11.
  // A median of raw gaps over a board of mostly depth players read 0.17 and
  // called a 46%-inflated board fine.
  const depth = { position: 'WR', rushingYds: 0, receivingYds: 8, receptions: 0.8, expectedTds: 0.05, sitePoints: 3 };
  assert.equal(boardScoringDrift([depth]).n, 0);
});

test('a source\'s own statement of its week wins over the requested one', () => {
  const r = resolveSourceWeek({ season: 2026, week: 3 }, { season: 2026, week: 2 });
  assert.deepEqual([r.week, r.declared, r.mismatch], [3, true, true]);
  const same = resolveSourceWeek({ season: 2026, week: 2 }, { season: 2026, week: 2 });
  assert.deepEqual([same.week, same.declared, same.mismatch], [2, true, false]);
});

test('a source that states no week is filed under the requested one and marked unverified', () => {
  const r = resolveSourceWeek({ season: null, week: null }, { season: 2026, week: 2 });
  assert.deepEqual([r.season, r.week, r.declared, r.mismatch], [2026, 2, false, false]);
});

test('a week-only declaration compares the week and keeps the requested season', () => {
  const r = resolveSourceWeek({ week: 3 }, { season: 2026, week: 2 });
  assert.deepEqual([r.season, r.week, r.mismatch], [2026, 3, true]);
});

test('WinWithOdds\' heading names the week the page holds', () => {
  assert.equal(parseDeclaredWeek('<div id="banner"><h1>Week 2 Player Prop Projections</h1></div>'), 2);
  assert.equal(parseDeclaredWeek('<h1 class="x"> Week 14 Player Prop Projections</h1>'), 14);
  assert.equal(parseDeclaredWeek('<h1>Season Long Projections</h1>'), null);
});

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
  const ours = judge({ name: 'fanduel', prov: { week: 2, by: 'us (unverifiable)', fetchedAt: '2026-09-14T00:00:00Z' }, scale: {}, wantWeek: 2, now });
  assert.equal(ours.problems.length, 0);
  assert.equal(ours.warnings.length, 2);
});
