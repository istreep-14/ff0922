import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDump, findLeague, leagueIdsOf, shouldReplace, ingestDump, captureScript, bookmarklet,
} from '../src/scoresingest.js';

/**
 * ESPN/Yahoo past weeks cannot be re-fetched from MyPlaybook, so the recovery
 * path is a file captured in a logged-in browser. These tests pin the joins
 * that would silently write the wrong league's scores, skip a stale snapshot,
 * or count ESPN's season-to-date total as a weekly score.
 */

const leagues = [
  { key: 'espn-a', nickname: 'Cville 2026', host: 'ESPN', leagueId: '650258755',
    teams: [{ teamId: '10', name: "Ian's Impressive Team" }, { teamId: '8', name: 'TuaWaddleHill' }] },
  { key: 'yahoo-a', nickname: 'Krause', host: 'Yahoo', leagueId: '470.l.529792',
    teams: [{ teamId: '7', name: "Ian’s team" }, { teamId: '1', name: 'Commissioner’s Clan' }] },
  { key: 'sleeper-a', nickname: 'Sigma Chi 23', host: 'Sleeper', leagueId: '1389342442368532480',
    teams: [{ teamId: '1', name: 'The Implication' }, { teamId: '9', name: 'Back 2 Backshots' }] },
];

const mem = () => {
  const files = new Map();
  return {
    files,
    read: (s, w) => files.get(`${s}-${w}`) || null,
    merge: (s, w, key, payload, { fetchedAt } = {}) => {
      const cur = files.get(`${s}-${w}`) || { season: s, week: w, fetchedAt: null, leagues: {} };
      cur.leagues[key] = payload;
      if (fetchedAt) cur.fetchedAt = fetchedAt;
      files.set(`${s}-${w}`, cur);
      return cur;
    },
  };
};

test('Yahoo league keys match both 470.l.529792 and the bare id', () => {
  const ids = leagueIdsOf(leagues[1]);
  assert.ok(ids.has('470.l.529792'));
  assert.ok(ids.has('529792'));
  assert.equal(findLeague(leagues, '529792')?.key, 'yahoo-a');
  assert.equal(findLeague(leagues, '470.l.529792')?.key, 'yahoo-a');
});

test('Dynasty Daddy load maps rosterId to this app\'s teamId', () => {
  const [parsed] = parseDump({
    meta: { leagueId: '1389342442368532480', season: '2026' },
    teams: [
      { rosterId: 1, owner: { teamName: 'The Implication' } },
      { rosterId: 9, owner: { teamName: 'Back 2 Backshots' } },
    ],
    matchUps: {
      1: [{ teams: [{ rosterId: 1, points: 123.46 }, { rosterId: 9, points: 120.36 }] }],
      3: [{ teams: [{ rosterId: 1, points: 0 }, { rosterId: 9, points: 0 }] }],
    },
  });
  assert.equal(parsed.source, 'dynasty-daddy');
  assert.equal(parsed.weeks[1][0].sides[0].teamId, '1');
  assert.equal(parsed.weeks[1][0].sides[0].points, 123.46);
  assert.equal(parsed.weeks[3][0].sides[0].points, 0);
});

test('ESPN weekly points prefer pointsByScoringPeriod over season totalPoints', () => {
  // totalPoints on a matchup can be the season running total. Using it as the
  // weekly score would double-count every prior week into PF.
  const [parsed] = parseDump({
    id: 650258755,
    seasonId: 2026,
    teams: [
      { id: 10, location: "Ian's", nickname: 'Impressive Team' },
      { id: 8, location: 'TuaWaddleHill', nickname: '' },
    ],
    schedule: [{
      matchupPeriodId: 1,
      home: { teamId: 10, totalPoints: 270.1, pointsByScoringPeriod: { 1: 130.4 } },
      away: { teamId: 8, totalPoints: 255.2, pointsByScoringPeriod: { 1: 125.8 } },
    }],
  });
  const sides = parsed.weeks[1][0].sides;
  assert.equal(sides.find((s) => s.teamId === '10').points, 130.4);
  assert.equal(sides.find((s) => s.teamId === '8').points, 125.8);
});

test('a wrapped ESPN capture (one payload per week) still parses', () => {
  const [parsed] = parseDump({
    source: 'espn',
    leagueId: '650258755',
    season: 2026,
    weeks: {
      2: {
        id: 650258755,
        seasonId: 2026,
        teams: [{ id: 10, name: 'Ian' }, { id: 8, name: 'Tua' }],
        schedule: [{
          matchupPeriodId: 2,
          home: { teamId: 10, totalPoints: 99.1 },
          away: { teamId: 8, totalPoints: 80 },
        }],
      },
    },
  });
  assert.equal(parsed.source, 'espn');
  assert.equal(parsed.weeks[2][0].sides[0].points, 99.1);
});

test('a stale inProgress snapshot is replaced; a final week is not', () => {
  assert.equal(shouldReplace({ ok: true, matchups: [{ status: 'inProgress', isPreGame: false, minutesLeft: 40, sides: [] }] }), true);
  assert.equal(shouldReplace({ ok: true, matchups: [{ status: 'finished', isPreGame: false, minutesLeft: 0, sides: [] }] }), false);
  assert.equal(shouldReplace({ ok: true, matchups: [{ status: 'finished', isPreGame: false, minutesLeft: 0, sides: [] }] }, { force: true }), true);
  assert.equal(shouldReplace(null), true);
});

test('ingest writes past weeks, skips the live week, and skips future pairings', () => {
  const store = mem();
  const dump = {
    leagueId: '470.l.529792',
    season: 2026,
    weeks: {
      1: { matchups: [{ sides: [{ teamId: '7', points: 144.04 }, { teamId: '1', points: 140.36 }] }] },
      2: { matchups: [{ sides: [{ teamId: '7', points: 101.2 }, { teamId: '1', points: 88 }] }] },
      3: { matchups: [{ sides: [{ teamId: '7', points: 0 }, { teamId: '1', points: 0 }] }] },
      4: { matchups: [{ sides: [{ teamId: '7', points: 0 }, { teamId: '3', points: 0 }] }] },
    },
  };
  const r = ingestDump(dump, {
    leagues, season: 2026, currentWeek: 3, read: store.read, merge: store.merge, log: () => {},
  });
  assert.deepEqual(r.written.map((w) => w.week).sort((a, b) => a - b), [1, 2]);
  assert.ok(r.skipped.some((s) => s.week === 3));
  assert.ok(r.skipped.some((s) => s.week === 4));
  const w1 = store.read(2026, 1).leagues['yahoo-a'];
  assert.equal(w1.ok, true);
  assert.equal(w1.matchups[0].status, 'finished');
  assert.equal(w1.matchups[0].sides[0].name, "Ian’s team");
  assert.equal(w1.matchups[0].sides[0].points, 144.04);
  assert.equal(store.read(2026, 3), null);
});

test('ingest --schedule keeps future pairings as notStarted', () => {
  const store = mem();
  ingestDump({
    leagueId: '650258755',
    weeks: { 8: { matchups: [{ sides: [{ teamId: '10', points: 0 }, { teamId: '8', points: 0 }] }] } },
  }, {
    leagues, season: 2026, currentWeek: 3, includeSchedule: true,
    read: store.read, merge: store.merge, log: () => {},
  });
  const row = store.read(2026, 8).leagues['espn-a'].matchups[0];
  assert.equal(row.status, 'notStarted');
  assert.equal(row.isPreGame, true);
  assert.equal(row.sides[1].name, 'TuaWaddleHill');
});

test('an unrecognised dump throws rather than writing an empty week', () => {
  assert.throws(() => ingestDump({ foo: 1 }, { leagues, season: 2026, currentWeek: 3 }), /Unrecognised dump/);
});

test('capture script targets the logged-in host APIs, not MyPlaybook', () => {
  const src = captureScript({ season: 2026, throughWeek: 3, leagues });
  assert.match(src, /lm-api-reads\.fantasy\.espn\.com/);
  assert.match(src, /scoringPeriodId=/);
  assert.match(src, /league\/load/);
  assert.match(src, /127\.0\.0\.1:4173\/api\/scores-ingest/);
  assert.match(src, /clipboard/);
  assert.match(src, /football\.fantasysports\.yahoo\.com|yahoo\.com/);
  assert.doesNotMatch(src, /mpbnfl\.fantasypros\.com/);
  assert.doesNotMatch(src, /a\.download/);
  const href = bookmarklet({ season: 2026, throughWeek: 3, leagues });
  assert.ok(href.startsWith('javascript:void('));
  // The snippet is JS source: '\\d' in the output is a digit class once the
  // browser evaluates it. A regex literal with over-escaped \\d would not.
  assert.ok(src.includes("new RegExp('\\\\b(\\\\d{1,3}\\\\.\\\\d{1,2})\\\\b'"));
});
