import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlayers, normalizeLeague, leagueLoadBody, buildTime } from '../src/dynastydaddy.js';
import { slimDDLeague } from '../src/dashboard.js';

const row = (o) => ({
  name_id: 'joshallenqb', sleeper_id: '4984', espn_id: '3918298', yahoo_id: '30977', full_name: 'Josh Allen', position: 'QB', team: 'BUF',
  age: 30, experience: 8, injury_status: null, trade_value: 6449, sf_trade_value: 10200, last_month_value: 6579, last_month_value_sf: 10200,
  overall_rank: 14, sf_overall_rank: 1, position_rank: 1, sf_position_rank: 1, most_recent_data_point: '2026-10-20T08:01:51.285Z',
  avg_adp: '1.00000000000000000000', percent_owned: '99.70', percent_started: '99.00', espn_ros: 1, fantasypros_ros: 2, fanduel_ros: 1, fantasyguys_ros: 1,
  ...o,
});

test('draft picks are skipped, and the site clock is the newest build time on any row', () => {
  assert.ok(!normalizePlayers([{ name_id: 'p', position: 'PI' }]).p);
  assert.equal(buildTime([row(), row({ name_id: 'b', most_recent_data_point: '2026-10-19T08:00:00Z' })]), '2026-10-20T08:01:51.285Z');
  assert.equal(buildTime({ message: 'error' }), null);
});

test('identity keeps every host id as a string, and the string-typed numbers as numbers', () => {
  const p = normalizePlayers([row()]).joshallenqb;
  assert.equal(p.sleeperId, '4984');
  assert.equal(p.espnId, '3918298');
  assert.equal(p.adp, 1);
  assert.equal(p.owned, 99.7);
  assert.deepEqual(p.ros, { espn: 1, fp: 2, fanduel: 1, fantasyguys: 1 });
});

test('a non-array response is a failure, not an empty player table', () => {
  assert.equal(normalizePlayers({ message: 'error' }), null);
});

test('no trade value is kept: the player rows carry identity and ROS ranks only', () => {
  const p = normalizePlayers([row()]).joshallenqb;
  for (const k of Object.keys(p)) assert.ok(!/value|market/i.test(k), k);
});

const load = () => ({
  meta: { name: 'Sunday Funday', type: 0, season: '2026', status: 'in_progress', leagueId: '288294188' },
  lastUpdated: '2026-10-20T20:34:40.955Z',
  settings: { roster: { isSuperflex: false }, schedule: { playoffStartWeek: 15 }, playoffs: { teams: 6 } },
  teams: [
    { rosterId: 1, owner: { teamName: 'Papa Jawn', name: 'x' }, roster: { players: [4242335] }, metrics: { wins: 2, losses: 0, fpts: 260.5, fptsAgainst: 222.3, rank: 1 } },
    { rosterId: 2, owner: { name: 'Owner Two' }, roster: { players: [] }, metrics: { wins: 0, losses: 2, fpts: 200, fptsAgainst: 250, ppts: 230 } },
  ],
  matchUps: {
    1: [{ matchupId: 1, teams: [{ rosterId: 1, points: 120.3 }, { rosterId: 2, points: 99 }] }],
    2: [{ matchupId: 1, teams: [{ rosterId: 2, points: 110 }, { rosterId: 1, points: 115 }] }],
    // A cached private-ESPN copy: the pairing is real, the score is a placeholder.
    6: [{ matchupId: 26, teams: [{ rosterId: 1, points: 0 }, { rosterId: 2, points: 0 }] }],
  },
});

test('league/load keeps the whole schedule and finds the last week that actually scored', () => {
  const n = normalizeLeague(load());
  assert.deepEqual(Object.keys(n.schedule), ['1', '2', '6']);
  assert.equal(n.scoredThrough, 2);
  assert.deepEqual(n.schedule[6][0].map((s) => s.id), ['1', '2']);
  assert.equal(n.teams[1].name, 'Owner Two');
  assert.equal(n.teams[1].metrics.ppts, 230);
  assert.equal(n.playoffStartWeek, 15);
});

test('a snapshot scored weeks behind the calendar is flagged stale on the page', () => {
  const snap = { fetchedAt: 'x', ...normalizeLeague(load()) };
  assert.equal(slimDDLeague(snap, 7).stale, true);
  assert.equal(slimDDLeague(snap, 3).stale, false);
  assert.deepEqual(slimDDLeague(snap, 7).schedule[6], [[{ id: '1' }, { id: '2' }]]);
  assert.equal(slimDDLeague(null, 7), null);
});

test('ESPN cookies go to Dynasty Daddy only when both are set; Yahoo and unknown hosts are named, not guessed', () => {
  const espn = { host: 'ESPN', leagueId: 288294188 };
  assert.deepEqual(leagueLoadBody(espn, 2026, { espnS2: '', swid: '' }), { platform: 'ESPN', leagueId: '288294188', season: '2026' });
  assert.equal(leagueLoadBody(espn, 2026, { espnS2: 'a', swid: '' }).espnS2, undefined);
  assert.equal(leagueLoadBody(espn, 2026, { espnS2: 'a', swid: '{b}' }).swid, '{b}');
  assert.equal(leagueLoadBody({ host: 'Sleeper', leagueId: '1' }, 2026).platform, 'SLEEPER');
  assert.equal(leagueLoadBody({ host: 'Yahoo', leagueId: '470.l.1' }, 2026).platform, 'YAHOO');
  assert.equal(leagueLoadBody({ host: 'MFL', leagueId: '1' }, 2026), null);
});

test('an expert trade value is shown only where FantasyPros publishes one', async () => {
  const { tmExpert } = await import('../src/dashboard.js');
  assert.deepEqual(tmExpert({ trade: { value: 990, expert: { value: 1000, gap: 10 } } }), { xv: 1000, x: 10, xs: 'fp' });
  // Dynasty Daddy's copy of the experts' chart used to fill these; it went with the markets.
  assert.deepEqual(tmExpert({ trade: { value: 900, expert: null }, dd: { v: { 22: [930, 930] } } }), { xv: null, x: null, xs: null });
});
