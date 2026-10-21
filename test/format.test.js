import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FX_BLANK, fxNum, fxValue, fxCount, fxSignedCount, fxDelta, fxRank, fxPosRank, fxPct, fxHeat, fxHeatClass } from '../src/format.js';

test('a missing number is a dash, never a zero — and a real zero stays a zero', () => {
  for (const f of [fxNum, fxValue, fxCount, fxSignedCount, fxDelta, fxRank, fxPct]) {
    assert.equal(f(null), FX_BLANK);
    assert.equal(f(''), FX_BLANK);
    assert.equal(f(undefined), FX_BLANK);
  }
  assert.equal(fxNum('abc'), FX_BLANK, 'NaN is not a number to print');
  assert.equal(fxNum(0), '0.0');
  assert.equal(fxValue(0), '0.0');
  assert.equal(fxPosRank('WR', null), FX_BLANK);
});

test('points default to one decimal; a null decimals argument means the default, not zero', () => {
  assert.equal(fxNum(17.24), '17.2');
  assert.equal(fxNum(17.24, null), '17.2');
  assert.equal(fxNum(17.24, 0), '17');
  assert.equal(fxNum(123.456, 2), '123.46');
});

test('trade values keep their source\'s precision: separators at 10,000 scale, a decimal at 100', () => {
  assert.equal(fxValue(10200), '10,200');
  assert.equal(fxValue(984), '984');
  assert.equal(fxValue(97.44), '97.4');
  assert.equal(fxValue(-1234.6), '-1,235');
});

test('counts shorten to k, and a signed count uses a true minus sign', () => {
  assert.equal(fxCount(999), '999');
  assert.equal(fxCount(1234), '1.2k');
  assert.equal(fxCount(12345), '12k');
  assert.equal(fxSignedCount(1234), '+1.2k');
  assert.equal(fxSignedCount(-340), '−340');
  assert.equal(fxSignedCount(0), '0');
});

test('a change always carries its sign; ranks and shares read as ranks and shares', () => {
  assert.equal(fxDelta(2.04), '+2.0');
  assert.equal(fxDelta(-0.55), '-0.6');
  assert.equal(fxDelta(0), '0.0');
  assert.equal(fxDelta(22, 0), '+22');
  assert.equal(fxRank(12), '#12');
  assert.equal(fxPosRank('WR', 12), 'WR12');
  assert.equal(fxPct(99.7), '100%');
});

test('heat counts the thresholds passed, signed, and names the shade', () => {
  const steps = [8, 20, 40];
  assert.equal(fxHeat(7.9, steps), 0);
  assert.equal(fxHeat(8, steps), 1);
  assert.equal(fxHeat(-25, steps), -2);
  assert.equal(fxHeat(400, steps), 3);
  assert.equal(fxHeat(null, steps), 0);
  assert.equal(fxHeatClass(2), ' hu2');
  assert.equal(fxHeatClass(-3), ' hd3');
  assert.equal(fxHeatClass(0), '');
});

test('the page formats through this module, and has no private formatter left', () => {
  const tpl = readFileSync(new URL('../src/dashboard.template.html', import.meta.url), 'utf8');
  assert.ok(tpl.includes('/*__INLINE:format.js__*/'));
  // The old bodies were each a slightly different toFixed; they must stay aliases.
  for (const name of ['num', 'fmt', 'prFmt', 'signed']) {
    const m = tpl.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
    assert.ok(m && /^fx\w+$/.test(m[1].trim()), `${name} is an alias of a format.js function, not its own formatter`);
  }
  const src = readFileSync(new URL('../src/format.js', import.meta.url), 'utf8');
  const names = [...src.matchAll(/^(?:export )?(?:const|function) (\w+)/gm)].map((m) => m[1]);
  for (const n of names) assert.ok(!new RegExp(`(?:const|let|function) ${n}\\b`).test(tpl), `${n} is declared in the template too`);
});
