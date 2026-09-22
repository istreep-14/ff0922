import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWeek, repairStore, MIN_GAMES_TRUSTED } from '../src/schedule.js';

const TEAMS = ['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAC','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'];
const emptyStore = () => ({ weeks: {}, teams: Object.fromEntries(TEAMS.map((t) => [t, { bye: null, weeks: {} }])) });
/** n games between consecutive teams in TEAMS, the rest on bye. */
const games = (n) => Array.from({ length: n }, (_, i) => ({ home: TEAMS[i * 2], away: TEAMS[i * 2 + 1], date: 'd', final: false, name: 'g' }));

test('a team absent from a full week is on bye that week', () => {
  const s = mergeWeek(emptyStore(), 5, games(14));
  assert.equal(s.teams.WAS.bye, 5);
  assert.equal(s.teams.TEN.bye, 5);
  assert.equal(s.teams.ARI.bye, null);
  assert.equal(s.teams.ARI.weeks[5].opp, 'ATL');
});

test('a later correct fetch clears a bye latched onto that same week', () => {
  const s = emptyStore();
  s.teams.ARI.bye = 6;
  mergeWeek(s, 6, games(16));
  assert.equal(s.teams.ARI.bye, null);
});

test('a real bye in one week is not disturbed by merging another', () => {
  const s = mergeWeek(emptyStore(), 5, games(14));
  mergeWeek(s, 6, games(16));
  assert.equal(s.teams.WAS.bye, 5);
});

test('a bye resting on a week with no trusted games is dropped', () => {
  // The fingerprint of the empty-week bug: every team on bye in a week that
  // has zero games stored.
  const s = mergeWeek(emptyStore(), 5, games(14));
  s.weeks[18] = { games: 0 };
  for (const t of TEAMS) s.teams[t].bye = 18;
  s.teams.WAS.bye = 5;
  repairStore(s);
  assert.equal(s.teams.ARI.bye, null);
  assert.equal(s.teams.WAS.bye, 5);
});

test('a bye on a week the store never recorded is dropped too', () => {
  const s = emptyStore();
  s.teams.ARI.bye = 9;
  assert.equal(repairStore(s).teams.ARI.bye, null);
});

test('a team with no game in a fully stored week is on bye, recovered from the file alone', () => {
  const s = mergeWeek(emptyStore(), 5, games(14));
  for (const t of TEAMS) s.teams[t].bye = null; // as if the byes had been wiped
  repairStore(s);
  assert.equal(s.teams.WAS.bye, 5);
  assert.equal(s.teams.ARI.bye, null);
});

test('a short week is not used to infer byes', () => {
  const s = mergeWeek(emptyStore(), 5, games(14));
  s.weeks[5].games = 9; // no longer a trustworthy count
  for (const t of TEAMS) s.teams[t].bye = null;
  repairStore(s);
  assert.equal(s.teams.WAS.bye, null);
});

test('the trust threshold sits at the smallest real week', () => {
  assert.equal(MIN_GAMES_TRUSTED, 13);
});
