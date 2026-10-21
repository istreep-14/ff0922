import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compactStats, weekIsComplete, shouldReplace, mergeWeekPoints, resolveWeeklyPoints, MIN_COMPLETE,
} from '../src/actuals.js';

/**
 * Weekly points used to exist only on a matchup lineup. A player the board
 * did not include — a free agent, or a past week stored as team scores with
 * empty lineups — rendered as unavailable. These pin the stat-file fallback
 * and the cases where it must not override the league or invent a zero.
 */

test('compactStats keeps fantasy points and drops counting-stat-only rows', () => {
  const players = compactStats({
    4046: { pass_yd: 300, pts_ppr: 21.5, pts_half_ppr: 19.5, pts_std: 17.5 },
    999: { rush_yd: 40 },
    100: { pts_ppr: 0, pts_half_ppr: 0, pts_std: 0 },
  });
  assert.deepEqual(players['4046'], { ppr: 21.5, half: 19.5, std: 17.5 });
  assert.equal(players['999'], undefined);
  assert.deepEqual(players['100'], { ppr: 0, half: 0, std: 0 });
});

test('a past week with a full slate is complete; the current week never is', () => {
  const full = { players: Object.fromEntries(Array.from({ length: MIN_COMPLETE }, (_, i) => [i, { ppr: 1 }])) };
  const thin = { players: { 1: { ppr: 10 } } };
  assert.equal(weekIsComplete(full, 1, 3), true);
  assert.equal(weekIsComplete(thin, 1, 3), false);
  assert.equal(weekIsComplete(full, 3, 3), false);
  assert.equal(weekIsComplete(null, 1, 3), false);
});

test('an empty feed does not erase a week that already has players', () => {
  assert.equal(shouldReplace({ players: { 1: { ppr: 8 } } }, {}), false);
  assert.equal(shouldReplace(null, {}), true);
  assert.equal(shouldReplace({ players: { 1: { ppr: 8 } } }, { 2: { ppr: 4 } }), true);
});

test('Sleeper points win a week; FantasyPros fills a week Sleeper lacks', () => {
  const weeks = mergeWeekPoints(
    { 2: { ppr: 18.2, half: 16.2, std: 14.2 } },
    { 1: 11, 2: 9 },
    'PPR',
  );
  assert.equal(weeks['1'], 11);
  assert.equal(weeks['2'], 18.2);
  assert.equal(mergeWeekPoints(null, null, 'PPR'), null);
});

test('half scoring reads the half field, not PPR', () => {
  const weeks = mergeWeekPoints({ 1: { ppr: 20, half: 17, std: 14 } }, null, 'HALF');
  assert.equal(weeks['1'], 17);
});

test('league points win once the game has started; a missing lineup uses the stat file', () => {
  const base = { week: 3, currentWeek: 3, leaguePts: 12.4, onBoard: true, started: true, statPts: 14 };
  assert.equal(resolveWeeklyPoints(base), 12.4);
  assert.equal(resolveWeeklyPoints({ ...base, onBoard: false, leaguePts: null }), 14);
  assert.equal(resolveWeeklyPoints({ ...base, started: false }), null);
  assert.equal(resolveWeeklyPoints({ ...base, leaguePts: 0 }), 0);
  assert.equal(resolveWeeklyPoints({ week: 1, currentWeek: 3, leaguePts: null, statPts: 9.5 }), 9.5);
  assert.equal(resolveWeeklyPoints({ week: 1, currentWeek: 3, leaguePts: 8, statPts: 9.5 }), 8);
  assert.equal(resolveWeeklyPoints({ week: 3, currentWeek: 3, onBoard: false, statPts: null }), null);
});

test('the page reads weekly actuals when the matchup board has no line for the player', () => {
  const template = readFileSync(new URL('../src/dashboard.template.html', import.meta.url), 'utf8');
  assert.match(template, /function weekActual/);
  assert.match(template, /p\.act/);
  assert.doesNotMatch(template, /const v = onBoard\? p\.lp : null/);
});
