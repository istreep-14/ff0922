import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, ROOT, config } from './config.js';
import { runEnrich } from './enrich.js';
import { buildDashboard } from './dashboard.js';
import { runPipeline, pipelineMods, stepRows, current, PRESETS } from './sync.js';
import * as ov from './overrides.js';
import { report as freshnessReport } from './freshness.js';
import { ingestScores, bookmarklet } from './scoresingest.js';
import { resolve as resolveWeek } from './week.js';
import { tail as runlogTail, logger } from './runlog.js';
import { loadDirectory, setActiveByKey } from './leaguestate.js';

/**
 * Turns the dashboard from a static file into something buttons can act on.
 *
 * `dist/dashboard.html` has no backend by default — it's a single
 * self-contained file, opened via `file://`. This IS that backend: the Sync
 * page's buttons, League Setup saving straight to disk, the league on/off
 * switches on All Leagues, and the live tail of the run log.
 *
 * It re-serves `dist/dashboard.html` fresh on every GET, so a POST that
 * triggers a rebuild (a sync, or an overrides save) is reflected on the very
 * next load.
 *
 * A sync is one long POST. While it runs the page polls `/api/log?after=` for
 * the lines it has not seen, which is what makes the terminal on the Log page
 * and the toasts live without a socket or a dependency.
 *
 * Binds to 127.0.0.1 only, deliberately: this executes real (whitelisted)
 * CLI commands and writes to data/ on request, which is not something to
 * expose past localhost.
 */

const loadLatest = () => {
  const p = join(DATA, 'latest.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { leagues: [] };
};

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

const INGEST_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function readBody(req, { maxBytes = 2_000_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > maxBytes) req.destroy(); });
    req.on('end', () => {
      if (!body.trim()) return resolvePromise({});
      try { resolvePromise(JSON.parse(body)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const state = () => ({ running: current.run, steps: stepRows(), presets: PRESETS, freshness: freshnessReport() });

async function handleSync(body) {
  return runPipeline(await pipelineMods({}), {
    force: !!body.force,
    only: body.only || null,
    skip: body.skip || null,
    maxAge: body.maxAge ?? null,
    dryRun: !!body.dryRun,
    // The narration goes to the run log, which the page tails; the terminal
    // running `serve` gets a one-line note per run instead of every line.
    log: null,
    origin: 'dashboard',
  });
}

async function handleOverrides(body) {
  const leagues = body.leagues || body;
  const entries = Object.entries(leagues || {});
  if (!entries.length) return { ok: false, message: 'No league edits in the request body.' };
  for (const [key, patch] of entries) ov.update(key, patch);
  const log = logger({ src: 'overrides', echo: null });
  log(`saved League Setup edits for ${entries.length} league(s)`);
  await runEnrich({ log });
  await buildDashboard({ log });
  return { ok: true, leagues: entries.length };
}

async function handleScoresIngest(dump) {
  if (!dump || typeof dump !== 'object' || (Array.isArray(dump) && !dump.length)) {
    return { ok: false, message: 'Paste a JSON dump from the ESPN/Yahoo bookmarklet.' };
  }
  const { season, week } = resolveWeek({ season: config.season, week: config.week });
  const notes = [];
  const log = logger({ src: 'scores', echo: (line) => notes.push(String(line).trim()) });
  const result = ingestScores({ dump, leagues: loadLatest().leagues, season, currentWeek: week, log });
  await buildDashboard({ log });
  return { ok: true, written: result.written, skipped: result.skipped, notes };
}

function handleLeagueActive(body) {
  const known = loadDirectory().find((l) => l.key === body.key) || loadLatest().leagues.find((l) => l.key === body.key);
  if (!known) return { ok: false, message: 'Not a league on this account.' };
  setActiveByKey(body.key, !!body.active, { nickname: known.name || known.nickname, host: known.host });
  logger({ src: 'leagues', echo: null })(`${body.active ? 'activated' : 'deactivated'} ${known.name || known.nickname} (${known.host}) — takes effect on the next MyPlaybook sync`);
  return { ok: true, leagues: loadDirectory() };
}

export async function startServer({ port = 4173 } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /' || route === 'GET /dashboard.html') {
        const p = join(ROOT, 'dist', 'dashboard.html');
        if (!existsSync(p)) return sendJson(res, 404, { error: 'dist/dashboard.html does not exist yet — run `node src/cli.js dashboard` once.' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return void res.end(readFileSync(p, 'utf8'));
      }
      if (route === 'GET /api/state') return sendJson(res, 200, state());
      if (route === 'GET /api/steps') return sendJson(res, 200, { steps: stepRows().filter((s) => !s.always) });
      if (route === 'GET /api/status') return sendJson(res, 200, { sources: freshnessReport() });
      if (route === 'GET /api/log') {
        const entries = runlogTail({ limit: Number(url.searchParams.get('limit')) || 400, after: url.searchParams.get('after') });
        return sendJson(res, 200, { entries, running: current.run });
      }
      if (route === 'GET /api/leagues') return sendJson(res, 200, { leagues: loadDirectory() });
      if (route === 'POST /api/leagues') return sendJson(res, 200, handleLeagueActive(await readBody(req)));
      if (route === 'GET /api/scores-bookmarklet') {
        const { season, week } = resolveWeek({ season: config.season, week: config.week });
        return sendJson(res, 200, { href: bookmarklet({ season, throughWeek: week, leagues: loadLatest().leagues }) });
      }
      if (route === 'OPTIONS /api/scores-ingest') {
        res.writeHead(204, INGEST_CORS);
        return void res.end();
      }
      if (route === 'POST /api/scores-ingest') {
        const body = await readBody(req, { maxBytes: 8_000_000 });
        return sendJson(res, 200, await handleScoresIngest(body), INGEST_CORS);
      }
      if (route === 'POST /api/sync') {
        if (current.run) return sendJson(res, 409, { error: `A sync is already running (started ${current.run.startedAt}, on ${current.run.step || 'its first step'}).`, running: current.run });
        const body = await readBody(req);
        const t0 = Date.now();
        const results = await handleSync(body);
        const failed = results.filter((r) => r.status === 'failed').length;
        console.log(`  sync from the dashboard — ${((Date.now() - t0) / 1000).toFixed(0)}s, ${failed} failed`);
        return sendJson(res, 200, { results });
      }
      if (route === 'POST /api/overrides') return sendJson(res, 200, await handleOverrides(await readBody(req)));
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
