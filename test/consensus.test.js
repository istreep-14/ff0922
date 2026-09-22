import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONS_SRC, buildMatrix, calibration, consensusTable, factorFor, playedGameDropped, sourceStats, weightedMean, median,
} from '../src/consensus.js';

/**
 * Consensus numbers and ranks, on synthetic players where the right answer is
 * known. Each test is a way the old plain average misled: a rank that depended
 * on how many sources covered a player, a stale source averaged in, a played
 * game counted in "rest of season", a rank that shifted with the list on screen.
 */

const ALL = { fp: 1, vg: 1, wwo: 1, fd: 1, fdl: 1, sl: 1, ds: 1, yh: 1 };
const PROFILE = { wk: ALL, ros: ALL };

/** 60 RBs whose FantasyPros week number falls from 30 to 1.2; source B prices the first `bCovers` at `level` x FP. */
function world({ level = 0.8, bCovers = 30 } = {}) {
  const fp = [], b = [];
  for (let i = 0; i < 60; i++) {
    const id = 100 + i, v = 30 - i * 0.48;
    fp.push({ i: id, wk: v, ros: v * 16 });
    if (i < bCovers) b.push({ i: id, wk: v * level, ros: v * 16 * level });
  }
  const pos = new Map(fp.map((r) => [r.i, 'RB']));
  return { tables: { fp, sleeper: b }, posOf: (id) => pos.get(id), ids: fp.map((r) => r.i) };
}
const rankOrder = (table, mode = 'wk') => [...table.entries()].sort((a, b) => a[1][mode].rk - b[1][mode].rk).map(([id]) => id);

test('scaling stops a player’s rank depending on how many low-running sources cover him', () => {
  const { tables, posOf, ids } = world({ level: 0.8, bCovers: 30 });
  const matrix = buildMatrix(tables);
  const calib = calibration(matrix, posOf);

  // Unscaled: the 30 players B covers are averaged down to 0.9x, the other 30 keep FP's full number,
  // so a player at FP rank 31 leaps over a player at FP rank 30.
  const raw = consensusTable(matrix, posOf, PROFILE, calib, { calibrate: false });
  assert.notDeepEqual(rankOrder(raw), ids, 'the plain average reorders players by coverage');

  const scaled = consensusTable(matrix, posOf, PROFILE, calib);
  assert.deepEqual(rankOrder(scaled), ids, 'scaled, the order is the order the sources agree on');
});

test('the scale is the median ratio over shared players, per position', () => {
  const { tables, posOf } = world({ level: 0.8, bCovers: 30 });
  const calib = calibration(buildMatrix(tables), posOf);
  assert.ok(Math.abs(factorFor(calib, 'wk', 'sl', 'RB') - 0.8) < 1e-9);
  assert.equal(factorFor(calib, 'wk', 'fp', 'RB'), 1, 'the anchor is never scaled');
  assert.equal(factorFor(calib, 'wk', 'sl', 'TE'), factorFor(calib, 'wk', 'sl', 'RB') , 'an unseen position borrows the overall ratio');
});

test('a source with too few shared players is left as published', () => {
  const { tables, posOf } = world({ level: 0.5, bCovers: 4 });
  const calib = calibration(buildMatrix(tables), posOf);
  assert.equal(factorFor(calib, 'wk', 'sl', 'RB'), 1);
});

test('positions with their own level are scaled on their own ratio', () => {
  const rows = [], b = [];
  for (let i = 0; i < 24; i++) {
    rows.push({ i: 1000 + i, wk: 20 - i * 0.3 }); b.push({ i: 1000 + i, wk: (20 - i * 0.3) * 0.9 });      // QB: 0.9x
    rows.push({ i: 2000 + i, wk: 20 - i * 0.3 }); b.push({ i: 2000 + i, wk: (20 - i * 0.3) * 0.6 });      // RB: 0.6x
  }
  const posOf = (id) => (id < 2000 ? 'QB' : 'RB');
  const calib = calibration(buildMatrix({ fp: rows, sleeper: b }), posOf);
  assert.ok(Math.abs(factorFor(calib, 'wk', 'sl', 'QB') - 0.9) < 1e-9);
  assert.ok(Math.abs(factorFor(calib, 'wk', 'sl', 'RB') - 0.6) < 1e-9);
});

test('a stale source is left out, so a fresh zero is not averaged with an old projection', () => {
  // The A.J. Brown case: FanDuel says 0.0 (out), Yahoo captured 5 days ago says 10.1.
  const vals = { fdl: 0, yh: 10.1 };
  const withStale = weightedMean(vals, ALL, {});
  assert.ok(Math.abs(withStale.v - 5.05) < 1e-9, 'averaged in, he reads as a middling 5.1');
  const without = weightedMean(vals, ALL, { exclude: new Set(['yh']) });
  assert.equal(without.v, 0);
  assert.equal(without.n, 1);
});

test('a zero-weight, partial or missing source never enters the average, and the rest renormalise', () => {
  const r = weightedMean({ fp: 10, sl: 20, vg: 100, ds: null }, { ...ALL, sl: 0 }, { partial: { vg: true } });
  assert.equal(r.v, 10);
  assert.equal(r.n, 1);
  const two = weightedMean({ fp: 10, sl: 20 }, { fp: 1, sl: 3 }, {});
  assert.ok(Math.abs(two.v - 17.5) < 1e-9);
});

test('ranks are computed once over every player: dense, unique, and identical however the table is read', () => {
  const { tables, posOf, ids } = world();
  const matrix = buildMatrix(tables);
  const table = consensusTable(matrix, posOf, PROFILE, calibration(matrix, posOf));
  const overall = [...table.values()].map((o) => o.wk.rk).sort((a, b) => a - b);
  assert.deepEqual(overall, ids.map((_, i) => i + 1));
  const pos = [...table.values()].map((o) => o.wk.pr).sort((a, b) => a - b);
  assert.deepEqual(pos, ids.map((_, i) => i + 1), 'one position, so position rank equals overall rank');

  // A rank belongs to the player, not to a list: building the table again, or after
  // "filtering" the input down to a few players, cannot change what a lookup returns.
  const again = consensusTable(matrix, posOf, PROFILE, calibration(matrix, posOf));
  for (const id of ids) assert.deepEqual(again.get(id), table.get(id));
});

test('position ranks count within their own position across a mixed pool', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) { rows.push({ i: 1 + i, wk: 30 - i }); rows.push({ i: 101 + i, wk: 25 - i }); }
  const posOf = (id) => (id < 100 ? 'QB' : 'WR');
  const matrix = buildMatrix({ fp: rows });
  const t = consensusTable(matrix, posOf, PROFILE, calibration(matrix, posOf));
  // QB1 (30) is overall 1, WR1 (25) is behind QB1..QB6 (30..25 ties break on id) - what matters is each position counts on its own.
  assert.equal(t.get(1).wk.pr, 1);
  assert.equal(t.get(2).wk.pr, 2);
  assert.equal(t.get(101).wk.pr, 1);
  assert.equal(t.get(102).wk.pr, 2);
  assert.equal(t.get(101).wk.pos, 'WR');
});

test('ties break on id, so the order is stable between builds', () => {
  const rows = [{ i: 7, wk: 10 }, { i: 3, wk: 10 }, { i: 5, wk: 10 }];
  const matrix = buildMatrix({ fp: rows });
  const t = consensusTable(matrix, () => 'RB', PROFILE, calibration(matrix, () => 'RB'));
  assert.deepEqual([3, 5, 7].map((id) => t.get(id).wk.rk), [1, 2, 3]);
});

/** Teams A (played) and B (not), 14 players each; every source projects `wk` and a ROS of `games` x wk. */
function playedWorld(sources) {
  const tables = {};
  const played = new Set();
  const pos = () => 'WR';
  for (const [table, games] of Object.entries(sources)) {
    tables[table] = [];
    for (let i = 0; i < 28; i++) {
      const id = 500 + i, wk = 12 + (i % 7);
      if (table === 'fp' && i < 14) played.add(id);
      const g = typeof games === 'function' ? games(i < 14) : games;
      tables[table].push({ i: id, wk, ros: wk * g });
    }
  }
  return { tables, played: (id) => played.has(id), pos };
}

test('a game already played is rolled out of rest of season, using the source’s own projection for it', () => {
  const { tables, played } = playedWorld({ fp: 16, sleeper: 15, draftsharks: 16 });
  const m = buildMatrix(tables, { played, rollForward: true });
  const e = m.get(500);            // a played player
  assert.equal(e.rosRaw.fp, e.wk.fp * 16);
  assert.equal(e.ros.fp, e.wk.fp * 15);
  assert.equal(e.ros.sl, e.wk.sl * 14);
  const notPlayed = m.get(520);
  assert.equal(notPlayed.ros.fp, notPlayed.rosRaw.fp, 'players still to play are untouched');

  const off = buildMatrix(tables, { played, rollForward: false });
  assert.equal(off.get(500).ros.fp, off.get(500).rosRaw.fp);
});

test('a published ROS that already dropped the played game is detected, and not rolled a second time', () => {
  // FanDuel-like: 16 games for teams still to play, 15 for teams already played. The others count the game.
  const { tables, played } = playedWorld({ fp: 16, sleeper: 16, draftsharks: 16, fanduel: (isPlayed) => (isPlayed ? 15 : 16) });
  const m = buildMatrix(tables, { played });
  assert.equal(m.dropped.fdl, true);
  assert.equal(m.dropped.fp, false);
  assert.equal(m.get(500).ros.fdl, m.get(500).rosRaw.fdl, 'left as published');
  assert.equal(m.get(500).ros.fp, m.get(500).wk.fp * 15, 'the others are rolled');
});

test('sources built here from this week on are never tested: they count this week by construction', () => {
  const { tables, played } = playedWorld({ fp: 16, sleeper: (p) => (p ? 14 : 16), draftsharks: 16, wwo: 16 });
  const dropped = playedGameDropped(buildMatrix(tables, { played, rollForward: false }), played);
  assert.equal(dropped.sl, false, 'summed');
  assert.equal(dropped.wwo, false, 'derived');
});

test('with nothing played, nothing is rolled', () => {
  const { tables } = playedWorld({ fp: 16, sleeper: 15 });
  const m = buildMatrix(tables, { played: () => false });
  for (const [, e] of m) assert.deepEqual(e.ros, e.rosRaw);
});

test('a played player with no weekly number from a source loses that source’s ROS instead of mixing bases', () => {
  const tables = { fp: [{ i: 1, wk: 10, ros: 160 }], sleeper: [{ i: 1, wk: null, ros: 150 }] };
  const m = buildMatrix(tables, { played: () => true });
  assert.equal(m.get(1).ros.fp, 150);
  assert.equal(m.get(1).ros.sl, undefined);
  assert.equal(m.get(1).rosRaw.sl, 150, 'the published figure is still on record');
});

test('a static season total is read as what is left of it', () => {
  const m = buildMatrix({ wwo: [{ i: 1, wk: 10, ros: 250, rosRest: 235 }] });
  assert.equal(m.get(1).ros.wwo, 235);
});

test('source stats report level, coverage and the games a ROS figure is worth', () => {
  const { tables, posOf } = world({ level: 0.8, bCovers: 30 });
  const matrix = buildMatrix(tables);
  const stats = sourceStats(matrix, posOf, calibration(matrix, posOf));
  assert.ok(Math.abs(stats.sl.scale.wk - 0.8) < 1e-9);
  assert.equal(stats.sl.n.wk, 30);
  assert.ok(stats.sl.corr.wk > 0.99);
  assert.equal(stats.fp.scale.wk, 1);
  assert.equal(stats.sl.impliedGames, 16);
  assert.equal(stats.vg.n.wk, 0);
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('the consensus source list matches the source tables the build produces', async () => {
  const { SOURCE_ORDER, SOURCE_KEY } = await import('../src/sourcetables.js');
  assert.deepEqual(CONS_SRC.map((s) => s.t).sort(), [...SOURCE_ORDER].sort());
  assert.equal(SOURCE_KEY.firstdown, 'fd');
});

test('too few played players to tell means "cannot tell", never "dropped"', () => {
  // Three teammates whose game is final, one of them noisy-low: nowhere near enough to conclude a source moved on.
  const tables = { fp: [], sleeper: [], draftsharks: [], fanduel: [] };
  const played = new Set([1, 2, 3]);
  for (let i = 1; i <= 30; i++) {
    const wk = 14 + (i % 5), games = played.has(i) ? 15 : 16;
    for (const t of Object.keys(tables)) tables[t].push({ i, wk, ros: wk * (t === 'fanduel' ? games : 16) });
  }
  const m = buildMatrix(tables, { played: (id) => played.has(id) });
  assert.equal(m.dropped.fdl, null);
  assert.equal(m.get(1).ros.fdl, m.get(1).rosRaw.fdl - m.get(1).wk.fdl, 'undecided is treated as still counting, and rolled');
});
