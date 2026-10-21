import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slimAnalysis } from '../src/dashboard.js';
import { normalizeAnalysis } from '../src/leagueanalysis.js';

const template = readFileSync(new URL('../src/dashboard.template.html', import.meta.url), 'utf8');

/**
 * The nav is a table in the page (`GROUPS`, `PAGES`) and the renderers are a
 * second table (`RENDER`). A page in the first but not the second does not
 * error: `render()` falls back to Overview, so the tab appears to work and
 * shows the wrong page. Nothing else would ever notice.
 */
const block = (re) => template.match(re)?.[1] ?? '';
const pageRows = [...block(/const PAGES = \[([\s\S]*?)\n\];/).matchAll(/\{id:'(\w+)',\s*label:'([^']+)',\s*group:'(\w+)'(?:,\s*section:'([^']*)')?\}/g)]
  .map(([, id, label, group, section]) => ({ id, label, group, section }));
const groupIds = [...block(/const GROUPS = \[([\s\S]*?)\n\];/).matchAll(/\{id:'(\w+)',\s*label:/g)].map((m) => m[1]);
const renderKeys = [...block(/const RENDER=\{([^}]*)\}/).matchAll(/(\w+):page\w+/g)].map((m) => m[1]);

test('the nav table was read (guards the guards below)', () => {
  assert.ok(pageRows.length >= 10, `found ${pageRows.length} pages`);
  assert.ok(groupIds.length >= 3, `found ${groupIds.length} groups`);
  assert.ok(renderKeys.length >= 10, `found ${renderKeys.length} renderers`);
});

test('every page in the nav has a renderer', () => {
  const missing = pageRows.filter((p) => !renderKeys.includes(p.id)).map((p) => p.id);
  assert.deepEqual(missing, []);
});

test('every renderer is reachable from the nav', () => {
  const orphans = renderKeys.filter((k) => !pageRows.some((p) => p.id === k));
  assert.deepEqual(orphans, []);
});

test('every page belongs to a group that exists, and every group has a page', () => {
  assert.deepEqual(pageRows.filter((p) => !groupIds.includes(p.group)).map((p) => p.id), []);
  assert.deepEqual(groupIds.filter((g) => !pageRows.some((p) => p.group === g)), []);
});

test('league analysis is reachable from the League group', () => {
  assert.equal(pageRows.find((p) => p.id === 'analysis')?.group, 'league');
});

/**
 * One rail option is about a league; the rest are not. The League option's own
 * rail is divided into sections, and only its pages have them, so a page cannot
 * be added to it without saying where it goes, or leak a section into an option
 * that is not about a league.
 */
test('the League group is the one league-specific option, and its pages are all sectioned', () => {
  const league = pageRows.filter((p) => p.group === 'league');
  assert.ok(league.length >= 5);
  assert.deepEqual(league.filter((p) => !p.section).map((p) => p.id), []);
  assert.equal(new Set(league.map((p) => p.section)).size >= 3, true, 'more than one section');
});

test('league-specific pages are under League, not scattered across the other options', () => {
  const under = (id) => pageRows.find((p) => p.id === id)?.group;
  for (const id of ['myteam', 'matchup', 'standings', 'analysis', 'league', 'lplayers', 'waivers', 'moves', 'manage']) {
    assert.equal(under(id), 'league', id);
  }
  for (const id of ['players', 'trade', 'fp', 'draftsharks', 'leagues', 'sync']) {
    assert.notEqual(under(id), 'league', id);
  }
});

/**
 * Sources is the one other sectioned rail: its Overview, then one page per site
 * grouped by what the site gives us (src/sourcefeeds.js). Those site pages are
 * generated from FEED_SITES, so they are checked in sourcefeeds.test.js.
 */
test('pages outside the League and Sources options carry no section', () => {
  assert.deepEqual(pageRows.filter((p) => p.group !== 'league' && p.group !== 'sources' && p.section).map((p) => p.id), []);
});

test('the league has its own players page, and waivers are four sheets', () => {
  assert.equal(pageRows.find((p) => p.id === 'lplayers')?.section, 'League');
  assert.match(template, /lplayers:pageLeaguePlayers/);
  assert.match(template, /function pageLeaguePlayers\(/);
  assert.match(template, /\['overview','Overview'\],\['projections','Projections'\],\['statistics','Statistics'\],\['schedule','Schedule'\]/);
  const note = template.match(/function sheetNote\(p\)\{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(note, /p\.blurb/);
  assert.match(note, /p\.nw/);
  assert.doesNotMatch(note, /sig\.nt/);
});

/* ------------------------------------------------------------ the payload */

const raw = {
  teamId: '1', teamName: 'Mine', positions: [], tradeNeeds: [], tradePartners: [],
  standings: [{ teamId: 1, teamName: 'Mine', rank: 1, tier: 1, score: 150, newscore: 100, vorpPerc: 105, isUser: true }],
  grid: [
    { position: 'Teams', cells: [{ teamId: 1, name: 'Mine' }] },
    { position: 'QB', cells: [{ teamId: 1, fpId: 7, name: 'Q One', pos: 'QB', team: 'DET', vorp: 100, value: 30, pRank: 1, oRank: 5 }] },
    { position: 'BN', cells: [{ teamId: 1, fpId: 8, name: 'B One', pos: 'RB', team: 'DAL', vorp: 50, value: 9, pRank: 20 }] },
  ],
};

test('slimAnalysis keeps the numbers and drops what the player pool already holds', () => {
  const a = { ros: normalizeAnalysis(raw, 'ros'), week: normalizeAnalysis(raw, 'week') };
  const s = slimAnalysis(a, '2026-09-19T00:00:00.000Z');
  assert.equal(s.asOf, '2026-09-19T00:00:00.000Z');
  assert.deepEqual(s.ros.players['7'], { tid: 1, slot: 'QB', vorp: 100, value: 30, pRank: 1, oRank: 5 });
  // Name, position and team come from `pools`, not from every period of every league.
  assert.ok(!('name' in s.ros.players['7']) && !('pos' in s.ros.players['7']) && !('team' in s.ros.players['7']));
  // The bench player has no overall rank: null, not absent-and-undefined.
  assert.equal(s.ros.players['8'].oRank, null);
  assert.equal(s.ros.basis, 'roster');
  assert.equal(s.week.basis, 'starters');
  assert.equal(typeof s.ros.ok, 'boolean');
});

test('slimAnalysis is null when there is no analysis, and keeps a lone period', () => {
  assert.equal(slimAnalysis(null), null);
  assert.equal(slimAnalysis({ ros: null, week: null }), null);
  const one = slimAnalysis({ ros: normalizeAnalysis(raw, 'ros'), week: null });
  assert.equal(one.week, null);
  assert.equal(one.ros.teams.length, 1);
});
