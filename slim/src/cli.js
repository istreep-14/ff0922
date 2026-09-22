/**
 * fetch  — leagues, FantasyPros week + ROS, Draft Sharks week + ROS, then HTML
 * html   — rebuild dist/index.html from data/snapshot.json
 * serve  — open the page
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { config, DATA, DIST, SNAPSHOT, HTML } from './config.js';
import { resolve } from './week.js';
import { fetchLeagues } from './leagues.js';
import { fetchBoards } from './projections.js';
import { fetchDraftSharks } from './draftsharks.js';
import { buildSnapshot, keepLeagues, scoringsInUse } from './build.js';
import { render } from './html.js';

function readSnapshot() {
  if (!existsSync(SNAPSHOT)) return null;
  return JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
}

function writeBoth(snapshot) {
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  mkdirSync(DIST, { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot));
  writeFileSync(HTML, render(snapshot));
}

async function fetchAll(argv) {
  const seasonFlag = flag(argv, '--season');
  const weekFlag = flag(argv, '--week');
  const { season, week } = resolve({
    season: seasonFlag ?? config.season,
    week: weekFlag ?? config.week,
  });
  const previous = readSnapshot();
  const log = (s) => console.log(s);

  log('Leagues');
  const leagueResult = await fetchLeagues({ log });
  const kept = keepLeagues(previous?.leagues, leagueResult.leagues);
  const errors = [...leagueResult.errors];
  if (kept.kept && (config.email || config.extraKeys.length)) {
    log('  MyPlaybook returned no leagues — kept the previous list.');
    errors.push('MyPlaybook returned no leagues. Kept the previous league list.');
  }

  const scorings = scoringsInUse(kept.leagues);
  const dsWeek = Math.max(week, 1);
  log(`FantasyPros projections — ${scorings.join(', ')}, week ${week} and ROS`);
  const boards = await fetchBoards({ scorings, log });
  errors.push(...boards.errors);
  log(`Draft Sharks — week ${dsWeek} and ROS`);
  const sharks = await fetchDraftSharks({ week: dsWeek, scorings, log });
  errors.push(...sharks.errors);

  const snapshot = buildSnapshot({
    season,
    week,
    leagues: kept.leagues,
    boards: boards.boards,
    sharks: sharks.sharks,
    errors,
  });
  writeBoth(snapshot);
  log(`\n${snapshot.leagues.length} league(s) → ${HTML}`);
}

function htmlOnly() {
  const snapshot = readSnapshot();
  if (!snapshot) {
    console.error('No data/snapshot.json yet. Run: npm run fetch');
    process.exit(1);
  }
  mkdirSync(DIST, { recursive: true });
  writeFileSync(HTML, render(snapshot));
  console.log(HTML);
}

function serve(argv) {
  const port = Number(flag(argv, '--port') || 4173);
  if (!existsSync(HTML)) {
    console.error('No dist/index.html yet. Run: npm run fetch');
    process.exit(1);
  }
  const server = createServer((req, res) => {
    const body = readFileSync(HTML);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  server.listen(port, () => console.log(`http://localhost:${port}`));
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'fetch') await fetchAll(rest);
else if (cmd === 'html') htmlOnly();
else if (cmd === 'serve') serve(rest);
else {
  console.log(`Usage:
  node src/cli.js fetch [--season 2026] [--week 3]
  node src/cli.js html
  node src/cli.js serve [--port 4173]`);
  if (cmd && cmd !== 'help') process.exit(1);
}
