import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderHtml } from '../src/dashboard.js';
import { buildSourceTables, SOURCE_ORDER } from '../src/sourcetables.js';

const template = readFileSync(new URL('../src/dashboard.template.html', import.meta.url), 'utf8');

test('the built page has no leftover template placeholders, and its script still compiles', () => {
  const html = renderHtml(template, { leagues: [] });
  assert.ok(!/\/\*__[A-Z]/.test(html), 'every placeholder replaced');
  const script = html.match(/<script(?![^>]*type=)[^>]*>([\s\S]*?)<\/script>/)[1];
  // `export` is not valid in a classic script; the build strips it from the inlined module.
  assert.ok(!/^export /m.test(script), 'no export left in the page script');
  // Compile only. It is a browser script, so it is never run here.
  assert.doesNotThrow(() => new vm.Script(script));
});

test('every pure module the page inlines is in it, unchanged', () => {
  const html = renderHtml(template, {});
  for (const file of ['weekhorizon.js', 'valuescale.js', 'powerrank.js', 'leaguevalue.js', 'sourcefeeds.js']) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').replace(/^export /gm, '');
    assert.ok(html.includes(src), `${file} is inlined`);
  }
});

test('a placeholder the renderer cannot fill fails the build instead of shipping a page that dies on load', () => {
  // A renderer older than the template: it knows HORIZON, not LEAGUEVALUE. This shipped.
  assert.throws(() => renderHtml(`${template}\n/*__LEAGUEVALUE__*/`, {}), /LEAGUEVALUE__\*\/ was not filled/);
  assert.throws(() => renderHtml('<script>/*__INLINE:nope.js__*/</script>/*__DATA__*/null', {}), /ENOENT/);
});

test('the large tables are DataGrids: one builder, not a hand-rolled table per page', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    const b = template.indexOf('\nfunction ', a + 1);
    return template.slice(a, b);
  };
  for (const name of ['playersTable', 'leaguePlayersTable', 'sourceTable', 'pageValues', 'pageTrade']) {
    const body = fnBody(name);
    assert.ok(/\bgrid\(\{/.test(body), `${name} renders through grid()`);
    assert.ok(!/el\('table'|table2\(/.test(body), `${name} does not build its own table`);
  }
});

test('the small tables are smallTable()s, sorted by their columns, not hand-rolled', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    const b = template.indexOf('\nfunction ', a + 1);
    return template.slice(a, b);
  };
  for (const name of ['pagePower', 'valTeamsMatrix', 'pageStandings', 'pageWaivers', 'pageAnalysis', 'storedWeekPanel']) {
    const body = fnBody(name);
    assert.ok(/\bsmallTable\(\{/.test(body), `${name} renders through smallTable()`);
    assert.ok(!/el\('table'|table2\(|[^.\w]table\(\[/.test(body), `${name} does not build its own table`);
  }
  // The DOM-text sorter's own builders for these pages are gone.
  assert.ok(!/function (sortableTable|sortTh|waiverSheetRow|srcBands)\(/.test(template));
});

test('phase-four views use the shared List, Compare and KeyValue components', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    const b = template.indexOf('\nfunction ', a + 1);
    return template.slice(a, b);
  };
  assert.match(template, /function list\(\{/);
  assert.match(template, /function compare\(\{/);
  assert.match(template, /function keyValue\(/);
  assert.match(fnBody('pageMoves'), /\blist\(\{/);
  assert.match(fnBody('matchupPanel'), /\bcompare\(\{/);
  assert.match(fnBody('muRows'), /\bcompare\(\{/);
  assert.match(fnBody('muRosterFallback'), /\bcompare\(\{/);
  assert.match(fnBody('sleeperMatchupFallback'), /\bcompare\(\{/);
  assert.match(fnBody('mdCard'), /\bkeyValue\(/);
  assert.doesNotMatch(fnBody('pageMoves'), /table2\(|[^.\w]table\(\[/);
});

test('a Sources table is read off the player row, so the two cannot disagree', () => {
  const rows = [
    { i: 1, n: 'A', p: 'RB', wk: 20, ros: 250, pr: 'RB1', rosPr: 'RB2', pts: 19,
      ds: { wk: 18, ros: 245, floor: 10, ceiling: 30 } },
    { i: 2, n: 'B', p: 'RB', wk: 10, ros: 100, pr: 'RB2', rosPr: 'RB1' },
  ];
  const t = buildSourceTables({ rows });
  assert.deepEqual(Object.keys(t), SOURCE_ORDER);
  const of = (source, i = 1) => t[source].find((r) => r.i === i);
  assert.equal(of('fp').wk, 20);
  assert.equal(of('fp').wkAct, 19);
  assert.equal(of('draftsharks').ceiling, 30);
  assert.equal(of('draftsharks', 2), undefined, 'a source that does not price him has no row');
});

test('a source’s own positional rank is computed within its own numbers', () => {
  const rows = [1, 2, 3].map((i) => ({ i, n: String(i), p: 'WR', ds: { wk: 10 - i, ros: 100 - i } }));
  const t = buildSourceTables({ rows });
  assert.deepEqual(t.draftsharks.map((r) => [r.i, r.wkRk]), [[1, 1], [2, 2], [3, 3]]);
});

test('the page parses and labels a look-ahead window with the tested module', async () => {
  const html = renderHtml(template, {});
  const horizon = readFileSync(new URL('../src/weekhorizon.js', import.meta.url), 'utf8').replace(/^export /gm, '');
  assert.ok(html.includes(horizon), 'weekhorizon.js is inlined unchanged');
  const { parseHorizon, labelHorizon } = await import('../src/weekhorizon.js');
  assert.equal(labelHorizon(parseHorizon('ros', { now: 2 }), { now: 2 }), 'Rest of season (wk 2–18)');
});

test('My Team: recent moves read the move shape, and controls only show where they act', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    const b = template.indexOf('\nfunction ', a + 1);
    return template.slice(a, b);
  };
  // A move is {kind, teamName, adds[], drops[]}. The Overview read per-player
  // fields (x.playerName, x.action) a move no longer has, so every row said "—".
  const parts = fnBody('overviewParts');
  assert.match(parts, /\blist\(\{items:recent, row:moveRow\}\)/);
  assert.doesNotMatch(parts, /\.playerName|\.playerPos|\.action\b/);
  const row = fnBody('moveRow');
  assert.match(row, /movePlayers\(t\.adds,1\)/);
  assert.match(row, /movePlayers\(t\.drops,-1\)/);
  // Only Overview and This week can show a stored week; the picker did nothing on the other tabs.
  assert.match(fnBody('pageMyTeam'), /\(teamTab==='overview'\|\|teamTab==='week'\)\? weekPicker\(l\) : null/);
  // Before kickoff the score column is all dashes and a 0.0 total.
  assert.match(fnBody('teamRosterTable'), /if\(!anyScored\(t\)\) cols=cols\.filter\(c=>c\.key!=='pts'\)/);
});

test('projection columns carry a tone: the headline number of each band leads', () => {
  const tone = template.match(/const COL_TONE = (\{[^}]*\})/);
  assert.ok(tone, 'COL_TONE exists');
  const map = Function(`return ${tone[1]}`)();
  for (const k of ['cons', 'tm', 'pts']) assert.equal(map[k], 'key', `${k} leads its band`);
  for (const k of ['ecr', 'ecrrng', 'dsfloor', 'dsceil', 'own']) assert.equal(map[k], 'aux', `${k} is context`);
  // Applied inside columnsFor, so My Team, Players and All Rosters all get it.
  const a = template.indexOf('function columnsFor('), b = template.indexOf('\nfunction ', a + 1);
  assert.match(template.slice(a, b), /td\.classList\.add\('t-'\+tone\)/);
});

test('My Team shows League Value beside its ROS inputs, and each window its own position rank', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    const b = template.indexOf('\nfunction ', a + 1);
    return template.slice(a, b);
  };
  // One League Value: the module's number, read through lvFor, never recomputed per page.
  const lv = fnBody('lvCols');
  assert.match(lv, /const lv=lvFor\(l\)/);
  assert.doesNotMatch(lv, /lvValues\(/);
  const cols = fnBody('teamColumns');
  assert.equal((cols.match(/\.\.\.lvCols\(L\(\)\)/g) || []).length, 3, 'Overview, Rest of season and Trade value');
  // RB7 this week under the week's points, RB12 rest of season under the ROS points.
  assert.match(fnBody('consPtsCell'), /stackCell\(fmt\(c&&c\.v\), c&&c\.pr \|\| null/);
});

test('lean tables: one line per row, on the player tables', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    const b = template.indexOf('\nfunction ', a + 1);
    return template.slice(a, b);
  };
  // Lean is a table class, styled in CSS, so no page builds its own one-line player.
  assert.match(fnBody('grid'), /\(o\.lean\? ' lean' : ''\)\+\(o\.nopos\? ' nopos' : ''\)/);
  for (const name of ['playersTable', 'leaguePlayersTable', 'sourceTable', 'pageWaivers', 'storedWeekPanel', 'overviewParts']) {
    assert.match(fnBody(name), /lean:true/, `${name} is lean`);
  }
  assert.match(fnBody('lineupTableView'), /cls:'roster lean'/);
  assert.match(fnBody('positionTableView'), /cls:'roster lean nopos'/, 'grouped by position: no position on each row');
  assert.match(fnBody('rosterTable'), /cls:'lean'/);
  // The kickoff a lean row hides stays on hover.
  assert.match(fnBody('oppCell'), /td\.title=kickoff/);
  assert.match(template, /table\.lean \.stack\{flex-direction:row-reverse/);
  assert.doesNotMatch(fnBody('overviewParts'), /table2\(|[^.\w]table\(\[/, 'the Overview side panels do not hand-build tables');
});

test('League Players centers data columns and keeps position with the agreed rank', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  assert.match(fnBody('leaguePlayersTable'), /tableClass:'lplayers'/);
  assert.match(fnBody('leaguePlayerColumns'), /leagueConsPtsCell\(p,hz\(\)\)/);
  assert.match(fnBody('leagueConsPtsCell'), /posChip\(rank\[1\],'mini'\)/);
  assert.match(template, /table\.dg\.lplayers th:nth-child\(n\+4\),table\.dg\.lplayers td:nth-child\(n\+4\)\{text-align:center\}/);
  assert.match(template, /table\.dg\.lplayers \.subt \.pos\.mini\{display:none\}/);
  assert.match(template, /\.lp-rank\{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;flex:none;width:max-content\}/);
  assert.match(template, /\.teambadge\{padding:0;border-radius:0;background:transparent!important\}/);
  assert.match(template, /\.teambadge\.other\{color:var\(--ink-2\)\}/);
  assert.match(template, /table\.lean td\{border-bottom-color:color-mix\(in srgb,var\(--line\) 82%,transparent\)\}/);
});

test('the player tables’ main number is the agreed one, not one site’s', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  // consFor fed every table, total, sort and lineup with FantasyPros' own
  // `wk`/`ros`; it now reads the FantasyPros + Draft Sharks consensus.
  const cons = fnBody('consFor');
  assert.match(cons, /agreed\(p,\s*(true|false)\)/);
  assert.doesNotMatch(cons, /p\.wk\b|p\.ros\b/);
  assert.match(template, /lvConsensus\(DATA\.pools\[sc\]\|\|\[\], vsSignals\(ros\? VS_SOURCES : VS_WEEK_SOURCES\)/);
  // A best-fit lineup is picked on the agreed week number too.
  assert.match(fnBody('lineupFor'), /wkPts\(b\)/);
  assert.match(template, /const wkPts = p=>\{ const m=metric\(p,'agreed'/);
  assert.match(fnBody('columnsFor'), /metric\(p,'agreed'/);
});

test('metric() is the one table accessor: agreed vs each site’s published number', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  const met = fnBody('metric');
  assert.match(met, /id==='agreed'/);
  assert.match(met, /id==='fp'/);
  assert.match(met, /id==='ds'/);
  assert.match(met, /p\.wk\b/);
  assert.match(met, /p\.ros\b/);
  // FantasyPros as published, not the agreed blend — this labeled the card "FP"
  // and filled it with consFor.
  const src = fnBody('srcValue');
  assert.match(src, /metric\(p,\s*key/);
  assert.doesNotMatch(src, /consFor/);
  assert.match(fnBody('fpOwn'), /metric\(p,'fp'/);
  assert.match(fnBody('mdProjections'), /srcValue\(p,k,/);
  assert.doesNotMatch(fnBody('mdProjections'), /consFor/);
  assert.match(fnBody('mdOverview'), /metric\(p,'fp'/);
  assert.match(fnBody('mdKpis'), /metric\(p,'agreed'/);
});

test('grid() draws kind+get columns when cell is absent, and sorts by get', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  const draw = fnBody('dgCell');
  assert.match(draw, /c\.cell\) return c\.cell\(r\)/);
  assert.match(draw, /c\.kind\) return cell\(c\.kind,\s*c\.get/);
  assert.match(fnBody('grid'), /!c\.sort && c\.get/);
  assert.match(fnBody('grid'), /dgCell\(c,r\)/);
  const cols = fnBody('columnsFor');
  assert.match(cols, /kind:'num'/);
  assert.match(cols, /get:p=>\{ const m=metric\(p,'agreed'/);
  assert.match(cols, /get:p=>\{ const m=metric\(p,'fp'/);
  assert.match(cols, /get:p=>\{ const m=metric\(p,k,h\)/);
});
