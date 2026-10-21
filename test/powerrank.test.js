import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prSlots, prSuperflex, prLineup, prTiers, prRanks, prScoreTeams, prScheduleStrength, PR_TIERS } from '../src/powerrank.js';

const SLEEPER = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'WR/RB/TE', 'QB/WR/RB/TE', 'K', 'BN', 'BN'];
const ESPN = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'WR/RB/TE', 'DST', 'BN', 'IR'];

test('bench and IR are not starting slots; flex slots accept what they name', () => {
  assert.equal(prSlots(ESPN).length, 8);
  assert.deepEqual(prSlots(['FLEX', 'SUPER_FLEX', 'D/ST', 'OP']), [['RB', 'WR', 'TE'], ['QB', 'RB', 'WR', 'TE'], ['DST'], ['QB', 'RB', 'WR', 'TE']]);
});

test('superflex is a second slot a quarterback can start in', () => {
  assert.equal(prSuperflex(prSlots(SLEEPER)), true);
  assert.equal(prSuperflex(prSlots(ESPN)), false);
  assert.equal(prSuperflex(prSlots(['QB', 'QB', 'RB'])), true);
});

test('the lineup fills fixed slots before flex, so a flex never steals a starter', () => {
  const players = [
    { id: 1, pos: 'QB', value: 100 }, { id: 2, pos: 'QB', value: 90 },
    { id: 3, pos: 'WR', value: 80 }, { id: 4, pos: 'WR', value: 10 },
  ];
  // Walked in slot order, the superflex would take the 90 QB... and in reverse
  // order it would take the 100 QB and leave QB to the 90. Either way the sum
  // must be every slot's best legal choice.
  const { lineup, value } = prLineup(players, prSlots(['QB/WR/RB/TE', 'QB', 'WR']));
  assert.equal(value, 270);
  assert.equal(lineup[1].id, 1);
  assert.equal(lineup[0].id, 2);
  assert.equal(lineup[2].id, 3);
});

test('IR, PUP and suspended players stay out of the contender lineup but count in trade value', () => {
  const [r] = prScoreTeams([{ id: 'a', players: [
    { id: 1, pos: 'RB', value: 500, inj: 'IR' }, { id: 2, pos: 'RB', value: 100, inj: 'Questionable' },
  ] }], ['RB']);
  assert.equal(r.contender, 100);
  assert.equal(r.trade, 600);
  assert.equal(r.bench, 500);
});

test('unpriced players (null) count as zero and an empty slot is not an error', () => {
  const { value, lineup } = prLineup([{ id: 9, pos: 'K', value: null }], prSlots(['K', 'DST']));
  assert.equal(value, 0);
  assert.equal(lineup[0].id, 9);
  assert.equal(lineup[1].id, null);
});

test('tiers: four equal bands, and a team alone at either end is named for it', () => {
  // 100 alone at the top, 0 alone at the bottom.
  assert.deepEqual(prTiers([100, 60, 55, 30, 0]).map((t) => PR_TIERS[t]), ['Super Team', 'Frisky', 'Frisky', 'Fraud', 'Trust the Process']);
  // Two at the top share Contender; two at the bottom are Rebuilding.
  assert.deepEqual(prTiers([100, 99, 50, 1, 0]), [1, 1, 2, 4, 4]);
  assert.deepEqual(prTiers([5, 5]), [1, 1]);
});

test('ranks are highest-first and ties share the better rank', () => {
  assert.deepEqual(prRanks([10, 30, 30, 5]), [3, 1, 1, 4]);
});

test('needs are the positions in the bottom of the league, at most three', () => {
  const team = (id, qb, rb, wr, te) => ({ id, players: [
    { id: id + 'q', pos: 'QB', value: qb }, { id: id + 'r', pos: 'RB', value: rb },
    { id: id + 'w', pos: 'WR', value: wr }, { id: id + 't', pos: 'TE', value: te },
  ] });
  const rows = prScoreTeams([team('a', 9, 9, 9, 11), team('b', 8, 8, 8, 8), team('c', 1, 1, 1, 10)], ['QB', 'RB', 'WR', 'TE']);
  // Bottom fifth first; c's TE room (2nd of 3) is in the bottom third but the list is full.
  assert.deepEqual(rows[2].needs, ['QB', 'RB', 'WR']);
  assert.equal(rows[2].groups.TE.rank, 2);
  assert.deepEqual(rows[0].needs, []);
  // b is 2nd everywhere and last at TE: the bottom fifth leads the list.
  assert.deepEqual(rows[1].needs, ['TE', 'QB', 'RB']);
});

test('schedule strength averages only the opponents still to play', () => {
  const rows = [{ id: 1, contender: 100 }, { id: 2, contender: 50 }, { id: 3, contender: 10 }, { id: 4, contender: 0 }];
  const sched = {
    6: [[{ id: '1' }, { id: '2' }], [{ id: '3' }, { id: '4' }]],
    7: [[{ id: '1' }, { id: '3' }], [{ id: '2' }, { id: '4' }]],
    8: [[{ id: '1' }, { id: '4' }], [{ id: '2' }, { id: '3' }]],
  };
  const s = prScheduleStrength(rows, sched, { from: 7, to: 8 });
  // Week 6 is behind us: team 1 faced the 50 then, and it must not count.
  assert.deepEqual(s.map((x) => x.mean), [5, 5, 75, 75]);
  assert.deepEqual(s.map((x) => x.rank), [3, 3, 1, 1]);
  // Before any week is scheduled there is no score, not a zero.
  assert.equal(prScheduleStrength(rows, {}, { from: 9, to: 14 })[0].mean, null);
});

test('the module is inlined into the page unchanged and collides with nothing there', () => {
  const src = readFileSync(new URL('../src/powerrank.js', import.meta.url), 'utf8');
  const tpl = readFileSync(new URL('../src/dashboard.template.html', import.meta.url), 'utf8');
  assert.ok(tpl.includes('/*__INLINE:powerrank.js__*/'));
  // A top-level `const` the page also declares would be a SyntaxError in the browser only.
  const names = [...src.matchAll(/^(?:export )?(?:const|function) (\w+)/gm)].map((m) => m[1]);
  for (const n of names) assert.ok(!new RegExp(`(?:const|let|function) ${n}\\b`).test(tpl), `${n} is declared in the template too`);
});
