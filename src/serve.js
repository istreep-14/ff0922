import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, ROOT, config } from './config.js';
import { resolveLeagues } from './fantasypros.js';
import { scrape } from './scrape.js';
import { scrapeSync as fpScrapeSync } from './scrapefp.js';
import { projSyncAuto } from './sleeperproj.js';
import { projSync as yahooProjSync, projSyncAuto as yahooProjSyncAuto, YahooAuthError, YahooBlockError } from './yahooproj.js';
import { dsSyncAuto } from './draftsharks.js';
import { scheduleSync } from './schedule.js';
import * as vegas from './vegas.js';
import { wwoSync } from './winwithodds.js';
import { fdSync } from './firstdown.js';
import { fanduelSync } from './fanduel.js';
import { buzzSync } from './buzz.js';
import { trendSync } from './sleepertrend.js';
import { syncLeagueDetail } from './leaguedata.js';
import { matchupsSync } from './matchups.js';
import { enrich } from './enrich.js';
import { buildDashboard } from './dashboard.js';
import { loadIdMap } from './idmap.js';
import { applyFilters } from './leaguestate.js';
import { runPipeline, steps } from './sync.js';
import * as ov from './overrides.js';
import { report as freshnessReport } from './freshness.js';
import { resolve as resolveWeek } from './week.js';

/**
 * Turns the dashboard from a static file into something buttons can act on.
 *
 * `dist/dashboard.html` has no backend by default — it's a single
 * self-contained file, opened via `file://`, which is exactly why the League
 * Setup page has always exported a downloadable patch instead of saving: "a
 * download is the only way off a page with no server" (see its own comment
 * in dashboard.template.html). This IS that server.
 *
 * It re-serves `dist/dashboard.html` fresh on every GET, so a POST that
 * triggers a rebuild (a sync, or an overrides save) is reflected on the very
 * next load — no separate "don't forget to rebuild" step, which is the trap
 * this project's own maintainer walked into earlier in the same session this
 * file was written in.
 *
 * Binds to 127.0.0.1 only, deliberately: this executes real (whitelisted)
 * CLI commands and writes to data/league-overrides.json on request, which is
 * not something to expose past localhost.
 */

const loadLatest = () => {
  const p = join(DATA, 'latest.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { leagues: [] };
};

async function runEnrich() {
  const { season, week } = resolveWeek({ season: config.season, week: config.week });
  const idMap = await loadIdMap({ season });
  enrich({ season, week, bookmaker: 'Average', idMap });
}

/**
 * Same wiring as the `sync` CLI command in cli.js — kept separate rather
 * than imported from there, because cli.js is an entrypoint script (argv
 * parsing runs at module load) and importing it here would run the CLI.
 */
function buildMods() {
  return {
    scrape: async () => { await scrape({}); },
    fp: async ({ season, week }) => { await fpScrapeSync({ season, week }); },
    sleeperProj: async ({ season, week }) => { await projSyncAuto({ season, week }); },
    draftsharks: async ({ season, week }) => { await dsSyncAuto({ season, week }); },
    schedule: async ({ season, week }) => { await scheduleSync({ season, week }); },
    vegas: async ({ season, week }) => { await vegas.vegasSync({ season, week, bookmakers: ['Average'] }); },
    vegasDist: async ({ season, week }) => { await vegas.vegasDistSync({ season, week, scoring: 'PPR' }); },
    wwo: async ({ season, week }) => { await wwoSync({ season, week }); },
    firstdown: async ({ season, week }) => { await fdSync({ season, week }); },
    fanduel: async ({ season, week }) => { await fanduelSync({ season, week }); },
    buzz: async ({ season, week }) => { await buzzSync({ season, week, days: 2 }); },
    trend: async ({ season, week }) => { await trendSync({ season, week }); },
    leaguedetail: async ({ season, week }) => {
      const leagues = applyFilters(await resolveLeagues(), {});
      await syncLeagueDetail({ season, week, leagues });
    },
    matchups: async ({ season, week }) => { await matchupsSync({ season, week, leagues: loadLatest().leagues }); },
    enrich: async () => { await runEnrich(); },
    dashboard: async () => { await buildDashboard({}); },
  };
}

/** name/label pairs the dashboard can render one button per — no run fn leaks to the client. */
function stepList() {
  return steps(buildMods()).filter((s) => !s.always).map(({ name, label }) => ({ name, label }));
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', () => {
      if (!body.trim()) return resolvePromise({});
      try { resolvePromise(JSON.parse(body)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleSync(body) {
  return runPipeline(buildMods(), {
    force: !!body.force,
    only: body.only || null,
    skip: body.skip || null,
    maxAge: body.maxAge ?? null,
    log: () => {}, // the CLI's console.log narration isn't useful over HTTP; the result array carries the same info
  });
}

async function handleYahooSync(body) {
  const { season, week } = resolveWeek({ season: config.season, week: config.week });
  try {
    const rep = body.full ? await yahooProjSync({ season, week, weeks: null }) : await yahooProjSyncAuto({ season, week });
    await runEnrich();
    await buildDashboard({});
    return { ok: true, report: rep };
  } catch (err) {
    if (err instanceof YahooAuthError || err instanceof YahooBlockError) {
      return { ok: false, blocked: true, message: err.message };
    }
    throw err;
  }
}

async function handleOverrides(body) {
  const leagues = body.leagues || body;
  const entries = Object.entries(leagues || {});
  if (!entries.length) return { ok: false, message: 'No league edits in the request body.' };
  for (const [key, patch] of entries) ov.update(key, patch);
  await runEnrich();
  await buildDashboard({});
  return { ok: true, leagues: entries.length };
}

export async function startServer({ port = 4173 } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard.html')) {
        const p = join(ROOT, 'dist', 'dashboard.html');
        if (!existsSync(p)) return sendJson(res, 404, { error: 'dist/dashboard.html does not exist yet — run `node src/cli.js dashboard` once.' });
        const html = readFileSync(p, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return void res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/api/steps') return sendJson(res, 200, { steps: stepList() });
      if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, { sources: freshnessReport() });
      if (req.method === 'POST' && url.pathname === '/api/sync') {
        const body = await readBody(req);
        return sendJson(res, 200, { results: await handleSync(body) });
      }
      if (req.method === 'POST' && url.pathname === '/api/yahoo-sync') {
        const body = await readBody(req);
        return sendJson(res, 200, await handleYahooSync(body));
      }
      if (req.method === 'POST' && url.pathname === '/api/overrides') {
        const body = await readBody(req);
        return sendJson(res, 200, await handleOverrides(body));
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolvePromise);
  });
  return server;
}
