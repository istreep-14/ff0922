import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchupUrl } from '../src/mpbadvanced.js';
import { weekNeedsFetch } from '../src/matchups.js';

const side = (teamId, points, starters = 9) => ({
  teamId, points, starters: Array.from({ length: starters }, (_, i) => ({ slot: 'QB', pts: i })), bench: [],
});
const final = (a, b) => ({ status: 'finished', isPreGame: false, minutesLeft: 0, sides: [a, b] });

test('matchupUrl asks for the week — without it every past week answered as the current one', () => {
  const u = new URL(matchupUrl('nfl~abc', { teamId: 3, week: 6 }));
  assert.equal(u.searchParams.get('week'), '6');
  assert.equal(u.searchParams.get('teamId'), '3');
  assert.equal(u.searchParams.get('includePropBet'), 'false');
  assert.equal(new URL(matchupUrl('nfl~abc', { teamId: 3 })).searchParams.has('week'), false);
});

test('a past week with team scores but no lineup slots is re-fetched', () => {
  // The Dynasty Daddy backfill shape: scores, zero starters -> "no lineup was stored".
  const dump = { ok: true, matchups: [final(side('1', 100, 0), side('2', 90, 0))] };
  assert.equal(weekNeedsFetch(dump, 1, 7), true);
});

test('a settled past week with lineups is left alone; the current week never is', () => {
  const settled = { ok: true, matchups: [final(side('1', 100), side('2', 90))] };
  assert.equal(weekNeedsFetch(settled, 3, 7), false);
  assert.equal(weekNeedsFetch(settled, 7, 7), true);
});

test('a missing, failed or unfinished past week is re-fetched', () => {
  assert.equal(weekNeedsFetch(undefined, 5, 7), true);
  assert.equal(weekNeedsFetch({ ok: false, error: 'x' }, 5, 7), true);
  const live = { ok: true, matchups: [{ status: 'inProgress', isPreGame: false, minutesLeft: 30, sides: [side('1', 50), side('2', 40)] }] };
  assert.equal(weekNeedsFetch(live, 5, 7), true);
});
