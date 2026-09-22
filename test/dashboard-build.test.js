import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderHtml } from '../src/dashboard.js';
import { buildSourceTables, SOURCE_ORDER } from '../src/sourcetables.js';

const template = readFileSync(new URL('../src/dashboard.template.html', import.meta.url), 'utf8');

test('the built page carries the consensus module, and its script still compiles', () => {
  const html = renderHtml(template, { leagues: [] });
  assert.ok(!html.includes('/*__CONSENSUS__*/'), 'placeholder replaced');
  assert.ok(html.includes('function consensusTable('), 'module is in the page');
  const script = html.match(/<script(?![^>]*type=)[^>]*>([\s\S]*?)<\/script>/)[1];
  // `export` is not valid in a classic script; the build strips it from the inlined module.
  assert.ok(!/^export /m.test(script), 'no export left in the page script');
  // Compile only. It is a browser script, so it is never run here.
  assert.doesNotThrow(() => new vm.Script(script));
});

test('the page runs the same consensus functions the tests do', () => {
  const module = readFileSync(new URL('../src/consensus.js', import.meta.url), 'utf8').replace(/^export /gm, '');
  assert.ok(renderHtml(template, {}).includes(module), 'the inlined text is the module, unchanged');
});

test('a Sources table is read off the player row, so the two cannot disagree', () => {
  const rows = [
    { i: 1, n: 'A', p: 'RB', wk: 20, ros: 250, pr: 'RB1', rosPr: 'RB2', pts: 19,
      sl: { wk: 19, ros: 240 }, ds: { wk: 18, ros: 245, floor: 10, ceiling: 30 },
      vg: 17, vc: false, vdist: { floor: 8, ceiling: 28 },
      wwo: { proj: 21, seasonProj: 300, rosDerived: 280, floor: 9, ceiling: 31, actual: 12 },
      fd: { proj: 16, seasonProj: 290, rosDerived: 270 },
      fdl: { proj: 15, posRank: 4, seasonProj: 200, seasonPosRank: 6 },
      yh: { wk: 14, ros: 180 } },
    { i: 2, n: 'B', p: 'RB', wk: 10, ros: 100, pr: 'RB2', rosPr: 'RB1' },
  ];
  const t = buildSourceTables({ rows });
  assert.deepEqual(Object.keys(t), SOURCE_ORDER);
  const of = (source, i = 1) => t[source].find((r) => r.i === i);
  assert.equal(of('fp').wk, 20);
  assert.equal(of('fp').wkAct, 19);
  assert.equal(of('sleeper').ros, 240);
  assert.equal(of('draftsharks').ceiling, 30);
  assert.equal(of('vegas').wk, 17);
  assert.equal(of('vegas').partial, true, 'a partly priced line is marked, not averaged');
  assert.equal(of('wwo').ros, 300);
  assert.equal(of('wwo').rosRest, 280, 'a static season total carries what is left of it');
  assert.equal(of('firstdown').rosRest, 270);
  assert.equal(of('fanduel').rosRk, 6);
  assert.equal(of('yahoo').wk, 14);
  assert.equal(of('sleeper', 2), undefined, 'a source that does not price him has no row');
});

test('a source’s own positional rank is computed within its own numbers', () => {
  const rows = [1, 2, 3].map((i) => ({ i, n: String(i), p: 'WR', sl: { wk: 10 - i, ros: 100 - i } }));
  const t = buildSourceTables({ rows });
  assert.deepEqual(t.sleeper.map((r) => [r.i, r.wkRk]), [[1, 1], [2, 2], [3, 3]]);
});

test('the page parses and labels a look-ahead window with the tested module', async () => {
  const html = renderHtml(template, {});
  const horizon = readFileSync(new URL('../src/weekhorizon.js', import.meta.url), 'utf8').replace(/^export /gm, '');
  assert.ok(html.includes(horizon), 'weekhorizon.js is inlined unchanged');
  assert.ok(!html.includes('/*__HORIZON__*/'));
  const { parseHorizon, labelHorizon } = await import('../src/weekhorizon.js');
  assert.equal(labelHorizon(parseHorizon('ros', { now: 2 }), { now: 2 }), 'Rest of season (wk 2–18)');
});
