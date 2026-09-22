import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { get, pool } from './http.js';
import { DATA, config } from './config.js';
import { resolve as resolveWeek, LAST_WEEK } from './week.js';
import { record } from './freshness.js';
import { writeJsonAtomic } from './jsonfile.js';

/**
 * Yahoo Fantasy — this league's own per-week projected points, scraped from
 * the logged-in Players page. There is no public API for this: Yahoo's
 * Fantasy Sports API (OAuth) exposes rosters and stats but not projections,
 * and the projection only exists behind a league context at all — it is
 * scored under THAT LEAGUE'S OWN SETTINGS (league 529792 is PPR here), not a
 * universal PPR/Half/Standard split the way Sleeper/DraftSharks/FanDuel are.
 *
 * AUTH
 *
 * The page 302s to login.yahoo.com with no cookie at all (verified
 * 2026-09-14). Yahoo's session is spread across ~15 cookies (A1, A3, T, Y,
 * F, GUC, OTH, ...), not one token like VegasEdge's JWT — YAHOO_COOKIE in
 * .env is the whole `Cookie:` header value from a logged-in browser request
 * to football.fantasysports.yahoo.com. Because `fetch` follows redirects by
 * default, an expired cookie does not come back as a 302 — it comes back
 * 200 with the login page's HTML. `assertAuthed` below is what actually
 * catches that, by checking for the players table rather than the status
 * code. Expect Yahoo's session to go stale faster than Vegas's ~30-day JWT.
 *
 * PAGINATION AND POSITION GROUPS
 *
 * `pos=O` bundles QB/RB/WR/TE into one board; K and DEF are separate boards
 * (there is no single "all positions" value). Rows/page is fixed at 25 by
 * the site, via `count=0,25,50,...`. Measured on league 529792, week 3,
 * 2026-09-14: 45 pages of pos=O (~1125 rows, most with no projection — deep
 * bench/inactive players are still listed), 3 of K, 2 of DEF. PAGE_CAP below
 * is a generous ceiling, not an exact count: a page past the real end just
 * comes back with fewer than 25 rows (or none), which is what stops the
 * merge in `fetchWeekRaw` — walking the site's own "Next 25" link
 * sequentially first to avoid a few wasted requests would cost giving up
 * parallel fetching for the whole position group.
 *
 * ROW MARKUP (verified against a real authenticated fetch, not guessed)
 *
 * Each row's name anchor carries `data-ys-playerid="NNNNN"` — Yahoo's own
 * player id. DEF rows use ids in the 100000s (100008 = Lions) and read like
 * any other row. The "Fan Pts" column is marked `pts Selected` in whichever
 * column is currently sorted-and-requested (`sort=PTS` + `stat1=S_PW_n`),
 * so it always holds week n's projection regardless of column order
 * elsewhere on the page.
 *
 * Yahoo ids are already a first-class citizen in this codebase: idmap.js
 * resolves `yahooId` for most players from the FantasyPros players endpoint,
 * so joining this source to fpId/sleeperId needs no name-matching fallback
 * — see loadIdMap in idmap.js. (In practice, measured 2026-09-14: Sleeper's
 * own yahoo_id crosswalk — which idmap.js's match-by-yahoo-id step relies on
 * — only covers ~21% of what this scraper returns, and misses star players
 * like Jahmyr Gibbs and Ja'Marr Chase entirely. idmap.js's name+position
 * fallback, the same one DraftSharks/WinWithOdds already use, is doing most
 * of the real work here, not the id join.)
 *
 * WHEN THE SERVER-SIDE FETCH GETS BLOCKED
 *
 * Yahoo's edge layer returns HTTP 999 ("Request denied") to a request
 * pattern it doesn't like — measured 2026-09-14, a raw Node `fetch()` replay
 * of a copied cookie got flagged after one ~55-request sync, and stayed
 * blocked on a single isolated request afterward, while the SAME session
 * loaded fine in an actual browser at the same time. That points at the
 * client, not the account: a plain `fetch()` from Node has a different
 * TLS/HTTP2 fingerprint than a real browser, runs no JS challenge, and
 * carries no navigation history — three things `Sec-Fetch-*` headers alone
 * don't fake convincingly.
 *
 * `browserScript` / `ingestWeek` are the fallback for that: a self-contained
 * snippet you paste into DevTools console *on the actual logged-in Yahoo
 * tab*. It runs as same-origin JS, so it fetches with the browser's own
 * cookies, TLS stack and fingerprint — indistinguishable from the page's own
 * behaviour, because it is the page's own behaviour. It still paces itself
 * (a randomized 500-1200ms between requests) since an inhumanly fast in-page
 * loop is its own kind of automated tell. It downloads one JSON file per
 * week; `ingestWeek` reads that file and merges it exactly like the
 * server-side path does.
 */

const BASE = 'https://football.fantasysports.yahoo.com';

const POS_GROUPS = ['O', 'K', 'DEF'];
const PAGE_CAP = { O: 50, K: 5, DEF: 3 };

export class YahooAuthError extends Error {
  constructor(msg) {
    super(
      `${msg}\n` +
        '  YAHOO_COOKIE is the FULL `Cookie:` header from a logged-in\n' +
        '  football.fantasysports.yahoo.com request — DevTools > Network >\n' +
        '  any request to that host > Request Headers > Cookie. Paste the\n' +
        "  whole value into .env, not a single sub-cookie. Yahoo's session\n" +
        '  rotates more often than VegasEdge\'s token; expect to refresh it.',
    );
    this.name = 'YahooAuthError';
  }
}

/**
 * Yahoo's edge bot-mitigation, not an auth problem — the cookie is fine, the
 * REQUEST PATTERN got flagged. Distinguished from YahooAuthError because the
 * fix is different: waiting, not a fresh cookie. Measured 2026-09-14: a
 * ~55-request sync at the (shared) FantasyPros pacing of concurrency 3 /
 * 250ms got the session blocked within minutes, and it was still blocked on
 * a single isolated request afterward — so this is a cooldown, not a
 * per-burst throttle, and re-testing it immediately just risks resetting
 * that cooldown's clock.
 */
export class YahooBlockError extends Error {
  constructor() {
    super(
      'Yahoo returned HTTP 999 ("Request denied") — its bot-mitigation layer, not an\n' +
        '  auth failure. The cookie is still valid; the request pattern got flagged.\n' +
        '  Do not retry immediately — that risks extending the block. Wait at least\n' +
        "  30-60 minutes, and consider raising YAHOO_DELAY_MS / lowering\n" +
        '  YAHOO_CONCURRENCY in .env (defaults: concurrency 1, delay 2000ms) before\n' +
        '  the next sync.',
    );
    this.name = 'YahooBlockError';
  }
}

function reqHeaders() {
  if (!config.yahooCookie) throw new YahooAuthError('YAHOO_COOKIE is not set.');
  return {
    Cookie: config.yahooCookie,
    Referer: `${BASE}/f1/${config.yahooLeagueId}/players`,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
  };
}

/** Throws if the response is Yahoo's login page rather than the players table. */
function assertAuthed(html) {
  if (!html.includes('id="players-table"')) {
    throw new YahooAuthError('Yahoo did not return the players table — the session cookie is missing, expired, or rejected.');
  }
}

export function pageUrl({ leagueId, week, pos, count }) {
  const q = new URLSearchParams({
    status: 'ALL', eteam: 'ALL', fteam: 'NONE', pos, cut_type: '9',
    stat1: `S_PW_${week}`, myteam: '0', sort: 'PTS', sdir: '1', count: String(count),
  });
  return `${BASE}/f1/${leagueId}/players?${q}`;
}

const numOr = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '--') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

function unescapeHtml(s) {
  return String(s)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/**
 * One page's player rows. Exported for the tests, against a captured page.
 */
export function parseRows(html) {
  const start = html.indexOf('<tbody');
  if (start === -1) return [];
  const end = html.indexOf('</tbody>', start);
  const body = html.slice(start, end === -1 ? html.length : end);
  const chunks = body.split(/<tr[^>]*>/).slice(1);

  const players = [];
  for (const chunk of chunks) {
    const nameM = chunk.match(
      /class="Nowrap name F-link playernote" href="[^"]*" target="_blank" data-ys-playerid="(\d+)"[^>]*title="([^"]*)"/,
    );
    if (!nameM) continue;
    const posM = chunk.match(/class="Fz-xxs">([A-Za-z]+) - ([A-Za-z/]+)<\/span>/);
    const ptsM = chunk.match(/\bpts Selected"><div >(?:<span class="Fw-b">)?([^<]*)/);
    players.push({
      yahooId: nameM[1],
      name: unescapeHtml(nameM[2]),
      team: posM ? posM[1] : null,
      position: posM ? posM[2] : null,
      points: ptsM ? numOr(ptsM[1]) : null,
    });
  }
  return players;
}

/** All position groups, all pages, for one week — one bounded pool of requests. */
async function fetchWeekRaw({ leagueId, week }) {
  const tasks = [];
  for (const pos of POS_GROUPS) {
    const cap = PAGE_CAP[pos] ?? 10;
    for (let i = 0; i < cap; i++) tasks.push({ pos, count: i * 25 });
  }

  const pages = await pool(tasks, async (t) => {
    let html;
    try {
      html = await get(pageUrl({ leagueId, week, pos: t.pos, count: t.count }), { asText: true, headers: reqHeaders() });
    } catch (err) {
      if (err.status === 999) throw new YahooBlockError();
      throw err;
    }
    assertAuthed(html);
    return { ...t, html };
  }, { concurrency: config.yahooConcurrency, delayMs: config.yahooDelayMs });

  const byPos = new Map();
  for (const p of pages) {
    if (!byPos.has(p.pos)) byPos.set(p.pos, []);
    byPos.get(p.pos).push(p);
  }

  const players = [];
  for (const list of byPos.values()) {
    list.sort((a, b) => a.count - b.count);
    for (const p of list) {
      const rows = parseRows(p.html);
      players.push(...rows);
      if (rows.length < 25) break; // short page — the rest of the cap was past the real end
    }
  }
  return players;
}

const dir = (season) => join(DATA, 'yahoo', String(season));
const filePath = (season) => join(dir(season), 'projections.json');

export function readProjections(season) {
  const p = filePath(season);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** One player's week -> points map, or null. */
export function playerWeeks(store, yahooId) {
  if (!store || yahooId == null) return null;
  return store.players?.[String(yahooId)]?.w ?? null;
}

const empty = (season) => ({ season, fetchedAt: null, weeks: {}, players: {} });

/**
 * Merge one week's rows into the store, in place. Shared by the server-side
 * fetch path (projSync) and the browser-ingest path (ingestWeek) below, so
 * the two ways of getting the data land in an identical shape.
 *
 * A week being refetched replaces that week for every player, same as
 * sleeperproj: a player who drops off the board must not keep last night's
 * number. Returns how many players actually carried a projection — a row
 * with no points is not a projection of zero, so it is not counted or kept.
 */
function mergeWeek(store, week, players, fetchedAt) {
  for (const p of Object.values(store.players)) delete p.w[week];
  let kept = 0;
  for (const p of players) {
    if (p.points == null) continue;
    kept++;
    const rec = store.players[p.yahooId] || { n: p.name, p: p.position, t: p.team, w: {} };
    rec.n = p.name ?? rec.n;
    rec.p = p.position ?? rec.p;
    rec.t = p.team ?? rec.t;
    rec.w[week] = { pts: p.points };
    store.players[p.yahooId] = rec;
  }
  store.weeks[week] = { players: kept, fetchedAt };
  return kept;
}

/**
 * Fetch some or all weeks and merge them into the stored season, same shape
 * and merge strategy as sleeperproj.js's projSync.
 */
export async function projSync({ season, week, weeks = null, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const store = readProjections(yr) || empty(yr);
  const want = (weeks && weeks.length ? weeks : Array.from({ length: LAST_WEEK }, (_, i) => i + 1))
    .map(Number).filter((w) => w >= 1 && w <= LAST_WEEK);

  const leagueId = config.yahooLeagueId;
  log(`Yahoo projections — league ${leagueId}, season ${yr}, week ${wk}; fetching ${want.length === 1 ? `week ${want[0]}` : `weeks ${want[0]}–${want[want.length - 1]}`}`);

  const ok = [], failed = [];
  const now = new Date().toISOString();

  // Weeks run sequentially, not through pool(): each week is already its own
  // bounded pool of ~55 page requests against one shared session cookie, and
  // stacking eighteen of those concurrently is the kind of load that gets a
  // scraped session flagged, not just slow.
  for (const w of want) {
    let players;
    try {
      players = await fetchWeekRaw({ leagueId, week: w });
    } catch (err) {
      // Both stop the whole sync rather than moving to the next week: an
      // expired cookie or a block affects every remaining request the same
      // way, and looping past it just burns requests against a session that
      // has already said no — worse yet, against a block, that risks
      // resetting its cooldown.
      if (err instanceof YahooAuthError || err instanceof YahooBlockError) throw err;
      log(`  FAIL wk${String(w).padStart(2)} — ${err.message.split('\n')[0]}`);
      failed.push({ label: `week ${w}`, error: err.message });
      continue;
    }

    const kept = mergeWeek(store, w, players, now);
    ok.push(`week ${w} (${kept})`);
    log(`  ok   wk${String(w).padStart(2)} ${String(kept).padStart(4)} players`);
  }

  store.fetchedAt = now;
  store.lastWeek = LAST_WEEK;
  store.leagueId = leagueId;
  if (want.length === LAST_WEEK && !failed.length) store.fullSyncAt = now;
  mkdirSync(dir(yr), { recursive: true });
  writeJsonAtomic(filePath(yr), store, { indent: 0 });

  // Yahoo publishes no site clock for this page (no ETag/Last-Modified we can
  // read for it), so sourceAt is null — same situation as VegasEdge/FanDuel.
  const rep = record('yahoo', {
    ok, failed, sourceAt: null, season: yr, week: wk,
    items: Object.keys(store.players).length,
    note: `${Object.keys(store.weeks).length} weeks stored — league ${leagueId}`,
  });
  log(`  ${ok.length} ok, ${failed.length} failed — ${Object.keys(store.players).length} players across ${Object.keys(store.weeks).length} weeks`);
  log(`  -> ${filePath(yr)}`);
  return rep;
}

/** Only the live week. What a short-interval poll runs. */
export const projSyncWeek = ({ season, week, log } = {}) => {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  return projSync({ season: yr, week: wk, weeks: [Math.max(1, wk)], log });
};

/** How long the rest of the season is trusted for before a full re-pull. */
const FULL_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Pull what is actually out of date: the live week every time, and the
 * whole season only when it is missing weeks or stale. Mirrors
 * sleeperproj.js's projSyncAuto — see that module for the reasoning.
 */
export async function projSyncAuto({ season, week, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const store = readProjections(yr);
  const complete = store && Array.from({ length: LAST_WEEK }, (_, i) => i + 1).every((w) => store.weeks?.[w]);
  const fullAge = store?.fullSyncAt ? Date.now() - new Date(store.fullSyncAt).getTime() : Infinity;
  const wantFull = !complete || fullAge >= FULL_MAX_AGE_MS;
  if (!wantFull) log(`  (rest of season pulled ${Math.round(fullAge / 60000)}m ago — live week only)`);
  return projSync({ season: yr, week: wk, weeks: wantFull ? null : [Math.max(1, wk)], log });
}

/**
 * A self-contained script to paste into DevTools console while on the Yahoo
 * players page (already logged in) — see the module doc's "WHEN THE
 * SERVER-SIDE FETCH GETS BLOCKED" section for why this exists. It:
 *
 *  - detects its own league id from location.pathname (no hardcoding)
 *  - walks the same pos groups / pagination this file's server-side path
 *    does, for EVERY week in `weeks`, sequentially with a randomized delay
 *    (and a longer pause between weeks) — same-origin JS is still
 *    automation, and a metronomic loop is its own tell
 *  - copies one JSON payload covering all requested weeks to the clipboard
 *    (falling back to a `window.__yahooCapture` + manual `copy()` one-liner
 *    if the automatic clipboard write fails), so `yahoo:ingest` picks up
 *    everything in one call regardless of how many weeks were captured
 *
 * Capturing many weeks in one paste is still one continuous run of
 * same-origin requests — untested at, say, all 18 weeks in one sitting. A
 * handful at a time (`weeks: [2,3,4,5]`) is the safer default; there is no
 * evidence yet that a session tolerates hundreds of requests back to back
 * just because they come from the real browser.
 */
export function browserScript({ season, weeks }) {
  const weeksList = (Array.isArray(weeks) ? weeks : [weeks]).map(Number).filter((w) => Number.isInteger(w) && w >= 1);
  const yr = JSON.stringify(season);
  const wks = JSON.stringify(weeksList);
  return `(async () => {
  const weeks = ${wks};
  const season = ${yr};
  const m = location.pathname.match(/\\/f1\\/(\\d+)\\//);
  if (!m) { console.error('Not on a league players page — open .../f1/<leagueId>/players first.'); return; }
  const leagueId = m[1];
  const POS_GROUPS = ['O', 'K', 'DEF'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const numOr = (v) => { if (v == null) return null; const s = String(v).trim(); if (!s || s === '--') return null; const n = Number(s.replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
  const unesc = (s) => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#(\\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  function parseRows(html) {
    const start = html.indexOf('<tbody');
    if (start === -1) return [];
    const end = html.indexOf('</tbody>', start);
    const body = html.slice(start, end === -1 ? html.length : end);
    const chunks = body.split(/<tr[^>]*>/).slice(1);
    const out = [];
    for (const chunk of chunks) {
      const nameM = chunk.match(/class="Nowrap name F-link playernote" href="[^"]*" target="_blank" data-ys-playerid="(\\d+)"[^>]*title="([^"]*)"/);
      if (!nameM) continue;
      const posM = chunk.match(/class="Fz-xxs">([A-Za-z]+) - ([A-Za-z\\/]+)<\\/span>/);
      const ptsM = chunk.match(/\\bpts Selected"><div >(?:<span class="Fw-b">)?([^<]*)/);
      out.push({ yahooId: nameM[1], name: unesc(nameM[2]), team: posM ? posM[1] : null, position: posM ? posM[2] : null, points: ptsM ? numOr(ptsM[1]) : null });
    }
    return out;
  }
  function hasNextPage(html) { return /<a href="[^"]*">Next 25<\\/a>/.test(html); }
  function pageUrl(week, pos, count) {
    const q = new URLSearchParams({ status: 'ALL', eteam: 'ALL', fteam: 'NONE', pos, cut_type: '9', stat1: 'S_PW_' + week, myteam: '0', sort: 'PTS', sdir: '1', count: String(count) });
    return '/f1/' + leagueId + '/players?' + q;
  }
  const byWeek = {};
  for (const week of weeks) {
    const players = [];
    for (const pos of POS_GROUPS) {
      let count = 0, page = 0;
      while (page < 60) {
        const res = await fetch(pageUrl(week, pos, count), { credentials: 'same-origin' });
        if (res.status === 999) { console.error('Blocked (999) even from the browser tab — stop here and wait longer before trying again. Weeks captured so far are still in byWeek/window.__yahooCapture if you want to salvage them.'); window.__yahooCapture = { season, leagueId, capturedAt: new Date().toISOString(), byWeek }; return; }
        const html = await res.text();
        const rows = parseRows(html);
        players.push(...rows);
        console.log('week ' + week, pos, 'count=' + count, '—', rows.length, 'rows,', players.length, 'total so far');
        page++;
        if (rows.length < 25 || !hasNextPage(html)) break;
        count += 25;
        await sleep(500 + Math.random() * 700);
      }
      await sleep(500 + Math.random() * 700);
    }
    byWeek[week] = players;
    console.log('week ' + week + ' done — ' + players.filter((p) => p.points != null).length + ' players with a projection.');
    if (week !== weeks[weeks.length - 1]) await sleep(2000 + Math.random() * 2000);
  }
  const payload = { season, leagueId, capturedAt: new Date().toISOString(), byWeek };
  const totalProj = Object.values(byWeek).reduce((a, ps) => a + ps.filter((p) => p.points != null).length, 0);
  // copy() — DevTools console's clipboard utility — is only reliable as a
  // DIRECT top-level console statement in some Chrome builds; called from
  // inside this long-running async function it can silently be undefined.
  // Stashing the result on window and printing the exact one-liner to run
  // next sidesteps that: typed by hand, it's a genuine top-level statement.
  window.__yahooCapture = payload;
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload));
    console.log('Copied weeks [' + weeks.join(', ') + '] — ' + totalProj + ' player-weeks with a projection — to the clipboard automatically.');
    console.log('Run: node src/cli.js yahoo:ingest');
  } catch (e) {
    console.log('Weeks [' + weeks.join(', ') + '] captured — ' + totalProj + ' player-weeks with a projection. Automatic clipboard copy failed (' + e.message + ').');
    console.log('Run this next, as its own line:');
    console.log('  copy(JSON.stringify(window.__yahooCapture))');
    console.log('...then: node src/cli.js yahoo:ingest');
  }
})();`;
}

/**
 * Read whatever browserScript's `copy()` call put on the clipboard.
 * macOS-only (pbpaste, zero dependencies); returns null anywhere else, or if
 * the clipboard doesn't look like either shape of our payload (single-week
 * `{week, players}` or multi-week `{byWeek: {week: players}}`).
 */
function readClipboard() {
  if (process.platform !== 'darwin') return null;
  try {
    const text = execSync('pbpaste', { encoding: 'utf8' });
    const payload = JSON.parse(text);
    return (Array.isArray(payload?.players) || payload?.byWeek) ? payload : null;
  } catch {
    return null; // not JSON, not ours, or pbpaste unavailable — just fall through
  }
}

/** Normalizes either payload shape browserScript can produce into `{week, players}[]`. */
function weeksIn(payload) {
  if (payload.byWeek) return Object.entries(payload.byWeek).map(([w, players]) => ({ week: Number(w), players }));
  if (Array.isArray(payload.players)) return [{ week: Number(payload.week), players: payload.players }];
  return [];
}

/**
 * Merge one or many weeks captured by browserScript into the stored season
 * — however many weeks the paste covered, in one call. The script's
 * `copy()` call puts the payload on the clipboard — read that first
 * (macOS) — and fall back to a file (default
 * ~/Downloads/yahoo-<season>-week-<week>.json, or `file`) for everyone else
 * or if the clipboard has since been overwritten with something else.
 */
export function ingestWeeks({ season, week = null, file = null, log = console.log } = {}) {
  const { season: yr } = resolveWeek({ season });

  let payload = file ? null : readClipboard();
  let path = null;
  if (payload) {
    log('  reading from clipboard');
  } else {
    const fallbackWeek = week ?? resolveWeek({ season }).week;
    path = file || join(homedir(), 'Downloads', `yahoo-${yr}-week-${fallbackWeek}.json`);
    if (!existsSync(path)) {
      throw new Error(
        `Nothing usable on the clipboard, and no captured file at ${path}.\n` +
          `  Run \`yahoo:script\` for the browser snippet, paste it into DevTools\n` +
          '  console on the logged-in Yahoo players page, then retry.',
      );
    }
    payload = JSON.parse(readFileSync(path, 'utf8'));
  }

  const weeks = weeksIn(payload);
  if (!weeks.length) throw new Error(`${path || 'Clipboard contents'} does not look like a captured Yahoo payload (no players[] or byWeek{}).`);

  const source = path || 'clipboard';
  const store = readProjections(yr) || empty(yr);
  const now = new Date().toISOString();
  const ok = [];
  for (const { week: w, players } of weeks) {
    const kept = mergeWeek(store, w, players, now);
    ok.push(`week ${w} (${kept})`);
    log(`  ingested wk${String(w).padStart(2)} ${String(kept).padStart(4)} players`);
  }
  store.fetchedAt = now;
  store.lastWeek = LAST_WEEK;
  store.leagueId = payload.leagueId || config.yahooLeagueId;
  mkdirSync(dir(yr), { recursive: true });
  writeJsonAtomic(filePath(yr), store, { indent: 0 });

  const rep = record('yahoo', {
    ok, failed: [], sourceAt: null, season: yr, week: weeks[weeks.length - 1].week,
    items: Object.keys(store.players).length,
    note: `browser-ingested from ${source} (captured ${payload.capturedAt || 'unknown time'})`,
  });
  log(`  from ${source} — ${weeks.length} week(s)`);
  log(`  -> ${filePath(yr)}`);
  return rep;
}

/** Per-week player counts for the stored projection set. */
export function weekReport(season) {
  const store = readProjections(season);
  if (!store) return [];
  return Object.entries(store.weeks)
    .map(([week, w]) => ({ week: Number(week), players: w.players, fetchedAt: w.fetchedAt }))
    .sort((a, b) => a.week - b.week);
}
