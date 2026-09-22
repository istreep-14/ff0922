/**
 * One static page. Rosters are the point of it; the full week, rest-of-season,
 * and Draft Sharks boards are the same numbers, for players you do not own.
 */
import { nameKey, scoringFormat } from './names.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '' : (Math.round(Number(v) * 10) / 10).toFixed(1));
const rank = (v) => (v == null || v === '' ? '' : String(v));

function search(id) {
  return `<input class="search" data-filter="${id}" placeholder="Filter" aria-label="Filter">`;
}

function table(id, headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  return `<div class="table-wrap">${search(id)}<table id="${id}"><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function rosterRows(players) {
  return players.map((p) => `<tr class="${p.starter ? 'starter' : ''}">
    <td>${esc(p.slot || '')}</td>
    <td>${esc(p.name)}</td>
    <td>${esc(p.position || '')}</td>
    <td>${esc(p.team || '')}</td>
    <td>${esc(p.opp || '')}</td>
    <td class="num">${num(p.fpWeek)}</td>
    <td class="num">${num(p.fpRos)}</td>
    <td class="num">${num(p.dsWeek)}</td>
    <td class="num">${num(p.dsRos)}</td>
    <td class="num">${num(p.vorpWeek)}</td>
    <td class="num">${num(p.vorpRos)}</td>
  </tr>`);
}

function standingsRows(week, ros) {
  const byId = new Map();
  for (const s of week || []) byId.set(s.teamId, { name: s.name, week: s, ros: null, mine: s.isMine });
  for (const s of ros || []) {
    const row = byId.get(s.teamId) || { name: s.name, week: null, ros: null, mine: false };
    row.ros = s;
    row.name = row.name || s.name;
    row.mine = row.mine || s.isMine;
    byId.set(s.teamId, row);
  }
  return [...byId.values()]
    .sort((a, b) => (a.week?.rank ?? 99) - (b.week?.rank ?? 99))
    .map((s) => `<tr class="${s.mine ? 'mine' : ''}">
      <td>${esc(s.name)}</td>
      <td class="num">${rank(s.week?.rank)}</td>
      <td class="num">${num(s.week?.score)}</td>
      <td class="num">${rank(s.ros?.rank)}</td>
      <td class="num">${num(s.ros?.score)}</td>
    </tr>`);
}

function fpRows(players, sharksByName) {
  return (players || []).map((p) => {
    const ds = sharksByName.get(nameKey(p.name, p.position));
    return `<tr>
      <td class="num">${rank(p.rank)}</td>
      <td>${esc(p.name)}</td>
      <td>${esc(p.position || '')}</td>
      <td>${esc(p.team || '')}</td>
      <td>${esc(p.opp || '')}</td>
      <td class="num">${num(p.proj)}</td>
      <td class="num">${ds ? num(ds.proj ?? ds.rosTotal) : ''}</td>
    </tr>`;
  });
}

function dsRows(players, ros) {
  return (players || []).map((p) => `<tr>
    <td class="num">${rank(p.rank)}</td>
    <td>${esc(p.name)}</td>
    <td>${esc(p.position || '')}</td>
    <td>${esc(p.team || '')}</td>
    <td>${esc(p.opp || '')}</td>
    <td class="num">${ros ? num(p.rosTotal) : num(p.proj)}</td>
    <td class="num">${ros ? num(p.rosWeekly) : num(p.floor)}</td>
    <td class="num">${ros ? num(p.rosCeiling) : num(p.ceiling)}</td>
  </tr>`);
}

function nameIndex(players, ros) {
  const m = new Map();
  for (const p of players || []) {
    m.set(nameKey(p.name, p.position), ros ? { rosTotal: p.rosTotal } : { proj: p.proj });
  }
  return m;
}

function leagueSection(league, i) {
  const mine = (league.teams || []).find((t) => t.isMine) || league.teams?.[0];
  const others = (league.teams || []).filter((t) => t !== mine);
  const id = `league-${i}`;
  const standings = standingsRows(league.standings?.week, league.standings?.ros);
  const mineTable = mine
    ? `<h3>${esc(mine.name)}${mine.isMine ? ' · yours' : ''}</h3>` + table(`${id}-mine`,
      ['Slot', 'Player', 'Pos', 'Team', 'Opp', 'FP week', 'FP ROS', 'DS week', 'DS ROS', 'VORP wk', 'VORP ROS'],
      rosterRows(mine.players || []))
    : '<p class="muted">No roster returned.</p>';
  const otherHtml = others.map((t, n) => `<details>
    <summary>${esc(t.name)} · ${(t.players || []).length} players</summary>
    ${table(`${id}-t${n}`, ['Slot', 'Player', 'Pos', 'Team', 'Opp', 'FP week', 'FP ROS', 'DS week', 'DS ROS', 'VORP wk', 'VORP ROS'], rosterRows(t.players || []))}
  </details>`).join('');
  const errs = (league.errors || []).length ? `<p class="warn">${esc(league.errors.join(' · '))}</p>` : '';
  return `<article class="league" id="${id}">
    <h2>${esc(league.nickname)}</h2>
    <p class="muted">${esc([league.host, scoringFormat(league.scoring) || league.scoring, league.myTeamName].filter(Boolean).join(' · '))}</p>
    ${errs}
    <h3>Standings</h3>
    ${table(`${id}-stand`, ['Team', 'Week rank', 'Week value', 'ROS rank', 'ROS value'], standings)}
    ${mineTable}
    ${otherHtml}
  </article>`;
}

function boardSection(title, id, snapshot, slot) {
  const blocks = (snapshot.scorings || ['PPR']).map((sc) => {
    const players = snapshot.boards?.[sc]?.[slot] || [];
    const sharks = snapshot.sharks?.[sc]?.[slot] || [];
    const ros = slot === 'ros';
    return `<h3>${esc(sc)}</h3>` + table(`${id}-${sc}`,
      ['Rank', 'Player', 'Pos', 'Team', 'Opp', 'FP pts', ros ? 'DS total' : 'DS pts'],
      fpRows(players, nameIndex(sharks, ros)));
  });
  return `<section id="${id}"><h2>${esc(title)}</h2>${blocks.join('')}</section>`;
}

function sharkSection(snapshot) {
  const blocks = (snapshot.scorings || ['PPR']).flatMap((sc) => {
    const pack = snapshot.sharks?.[sc] || { week: [], ros: [] };
    return [
      `<h3>${esc(sc)} · week ${esc(snapshot.week)}</h3>`,
      table(`ds-week-${sc}`, ['Rank', 'Player', 'Pos', 'Team', 'Opp', 'Proj', 'Floor', 'Ceiling'], dsRows(pack.week, false)),
      `<h3>${esc(sc)} · rest of season</h3>`,
      table(`ds-ros-${sc}`, ['Rank', 'Player', 'Pos', 'Team', 'Opp', 'Total', 'Per week', 'Ceiling'], dsRows(pack.ros, true)),
    ];
  });
  return `<section id="sharks"><h2>Draft Sharks</h2>${blocks.join('')}</section>`;
}

export function render(snapshot) {
  const when = snapshot.fetchedAt ? new Date(snapshot.fetchedAt).toLocaleString() : '';
  const errors = (snapshot.errors || []).length
    ? `<p class="warn">${snapshot.errors.map(esc).join('<br>')}</p>`
    : '';
  const leagues = (snapshot.leagues || []).map(leagueSection).join('')
    || '<p class="muted">No leagues in this snapshot.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Week ${esc(snapshot.week)} leagues</title>
<style>
  :root { color-scheme: light dark; --line: #d8d4cc; --mine: #e7f2e4; --ink: #1c1b19; --muted: #5e5a54; --bg: #f7f5f1; --card: #fff; }
  @media (prefers-color-scheme: dark) {
    :root { --line: #3a3834; --mine: #1d3324; --ink: #f3f0ea; --muted: #b3aea4; --bg: #141311; --card: #1d1c19; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.4 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--ink); }
  header, main { max-width: 1100px; margin: 0 auto; padding: 1.25rem; }
  header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line); z-index: 2; display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap; }
  h1 { font-size: 1.25rem; margin: 0; }
  h2 { font-size: 1.15rem; margin: 1.5rem 0 0.25rem; }
  h3 { font-size: 1rem; margin: 1rem 0 0.35rem; }
  nav a { margin-right: 0.8rem; color: inherit; }
  .muted { color: var(--muted); margin: 0.15rem 0 0.6rem; }
  .warn { color: #8a3b12; background: #f8e6d8; padding: 0.5rem 0.7rem; border-radius: 6px; }
  article, section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 0.8rem 1rem 1rem; margin: 1rem 0; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 0.28rem 0.45rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { font-size: 0.75rem; letter-spacing: 0.02em; color: var(--muted); font-weight: 600; }
  td.num, th:nth-child(n+5) { text-align: right; }
  tr.mine td { background: var(--mine); }
  tr.starter td:first-child { font-weight: 650; }
  .search { margin: 0.2rem 0 0.45rem; padding: 0.35rem 0.5rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
  summary { cursor: pointer; margin: 0.7rem 0; }
</style>
</head>
<body>
<header>
  <h1>Week ${esc(snapshot.week)} · ${esc(snapshot.season)}</h1>
  <span class="muted">${esc(when)}</span>
  <nav>
    <a href="#leagues">Leagues</a>
    <a href="#week">Week projections</a>
    <a href="#ros">ROS projections</a>
    <a href="#sharks">Draft Sharks</a>
  </nav>
</header>
<main>
  ${errors}
  <section id="leagues"><h2>Leagues</h2>${leagues}</section>
  ${boardSection(`FantasyPros week ${snapshot.week}`, 'week', snapshot, 'week')}
  ${boardSection('FantasyPros rest of season', 'ros', snapshot, 'ros')}
  ${sharkSection(snapshot)}
</main>
<script>
  for (const input of document.querySelectorAll('.search')) {
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      const table = document.getElementById(input.dataset.filter);
      if (!table?.tBodies[0]) return;
      for (const tr of table.tBodies[0].rows) tr.hidden = q.length > 0 && !tr.textContent.toLowerCase().includes(q);
    });
  }
</script>
</body>
</html>`;
}
