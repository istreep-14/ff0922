import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, pool } from './http.js';
import { VEGASDIR, config } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';
import { resolveSourceWeek, mismatchNotice } from './sourceweek.js';

export { resolveSourceWeek };

/**
 * VegasEdgeFantasy — sportsbook-derived projections for the current week.
 *
 * Auth is the `access_token` cookie (a JWT) from a logged-in browser session;
 * there is no public API key. The token expires, so `checkToken` reports that
 * before a sync wastes requests.
 *
 * Players are keyed by SLEEPER player id, which is also what
 * sleepercdn.com uses for headshots — see src/sleeper.js.
 */

const BASE = 'https://vegasedgefantasy.com';

/** Endpoints that return data. K and DST have no Vegas board. */
export const BOARDS = ['qb', 'rb', 'wr', 'te'];

/** Books confirmed to return rows. Others 200 with an empty body. */
export const BOOKMAKERS = ['Average', 'DraftKings', 'FanDuel', 'BetMGM', 'Fanatics'];

export class VegasAuthError extends Error {
  constructor(msg) {
    super(
      `${msg}\n` +
        '  VEGAS_TOKEN is the `access_token` cookie from a logged-in vegasedgefantasy.com session.\n' +
        '  Copy it from DevTools > Application > Cookies and put it in .env. It expires roughly monthly.',
    );
    this.name = 'VegasAuthError';
  }
}

function headers() {
  if (!config.vegasToken) throw new VegasAuthError('VEGAS_TOKEN is not set.');
  return {
    Cookie: `access_token=${config.vegasToken}`,
    Referer: `${BASE}/inseason`,
    Accept: '*/*',
  };
}

/** Decode the JWT payload without verifying — just to report expiry locally. */
export function tokenInfo(token = config.vegasToken) {
  if (!token) return null;
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return { email: p.email, subject: p.sub, expiresAt: new Date(p.exp * 1000), expired: p.exp * 1000 <= Date.now() };
  } catch {
    return null;
  }
}

/**
 * Scoring parameters, in the shape the endpoint expects.
 *
 * Defined up here because the board is re-scored with them too — see
 * `scoreComponents`.
 */
export const SCORING_PRESETS = {
  PPR:  { ppr: 1,   pts_per_rush_yd: 0.1, pts_per_rec_yd: 0.1, td_points: 6, pts_per_pass_yd: 0.04, pass_td_points: 4, int_points: -2 },
  HALF: { ppr: 0.5, pts_per_rush_yd: 0.1, pts_per_rec_yd: 0.1, td_points: 6, pts_per_pass_yd: 0.04, pass_td_points: 4, int_points: -2 },
  STD:  { ppr: 0,   pts_per_rush_yd: 0.1, pts_per_rec_yd: 0.1, td_points: 6, pts_per_pass_yd: 0.04, pass_td_points: 4, int_points: -2 },
};

/**
 * Points for one board row, computed HERE from the row's expected stat line.
 *
 * The board's own `FantasyPoints` is not used, because it is not a property of
 * the market: the site keeps ONE scoring setting for the whole server process
 * (its own league-settings.js says "scoring_settings in app.py is process-wide,
 * shared with every other visitor"), and any visitor saving a scoring change
 * re-scores the board for everyone. The rankings endpoint ignores scoring and
 * week query parameters — verified — so there is nothing to pin. Measured
 * 2026-09-19: the same pull came back at 0.16/yd, 1.5/rec, 7/TD (Bijan 34.3)
 * while a pull the next morning was plain PPR (Bijan 23.4), off identical
 * sportsbook props.
 *
 * The stat line (yards, receptions, TDs) does not move with that setting, so
 * scoring it ourselves gives the market's number at a scoring we control, and
 * for HALF/STD as exactly as for PPR. Returns null when the components are
 * not all there (a legacy row, or a QB pulled before pass stats were kept).
 */
export function scoreComponents(p, scoring = 'PPR') {
  const s = typeof scoring === 'string' ? SCORING_PRESETS[scoring.toUpperCase()] : scoring;
  if (!s) return null;
  const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const rush = n(p.rushingYds);
  let pts;
  if (p.position === 'QB') {
    const [py, ptd, ints, rtd] = [n(p.passYds), n(p.passTds), n(p.ints), n(p.rushTds)];
    if ([py, ptd, ints, rtd, rush].some((v) => v == null)) return null;
    pts = py * s.pts_per_pass_yd + ptd * s.pass_td_points + ints * s.int_points + rush * s.pts_per_rush_yd + rtd * s.td_points;
  } else {
    const [ry, rec, td] = [n(p.receivingYds), n(p.receptions), n(p.expectedTds)];
    if ([ry, rec, td, rush].some((v) => v == null)) return null;
    pts = rush * s.pts_per_rush_yd + ry * s.pts_per_rec_yd + rec * s.ppr + td * s.td_points;
  }
  return Number(pts.toFixed(2));
}

/**
 * Did the board's own point figure agree with plain PPR?
 *
 * Compares the site's number with ours on rows worth at least 6 points, as a
 * ratio. Not as a raw difference: a scoring change scales a line, so it barely
 * moves a 1-point depth player and moves a 23-point RB by 11 — the median
 * absolute gap over the whole board reads 0.17 on a board that was 46% inflated.
 * A drifted board is still usable (we re-score it), but it means someone
 * changed the site's scoring, and any figure read from a pull that was NOT
 * re-scored is wrong by that factor.
 *
 * `field` names where the site's figure is stored (`sitePoints`, or `points` in
 * files written before we kept both).
 */
export function boardScoringDrift(rows, field = 'sitePoints') {
  const ratios = [];
  for (const p of rows) {
    const mine = scoreComponents(p, 'PPR');
    if (mine == null || mine < 6 || p[field] == null) continue;
    ratios.push(p[field] / mine);
  }
  if (!ratios.length) return { n: 0, medianRatio: null, drifted: null };
  ratios.sort((a, b) => a - b);
  const medianRatio = Number(ratios[Math.floor(ratios.length / 2)].toFixed(3));
  // The site rounds to 0.1, under 1% on a 6-point row; 3% is well clear of that.
  return { n: ratios.length, medianRatio, drifted: Math.abs(medianRatio - 1) > 0.03 };
}

/**
 * What the site says about the data it is serving.
 *
 * `/config` is the only place the site states WHICH week the served boards
 * hold (`inseason_week`, the manifest's, as opposed to `week`, the live NFL
 * week ESPN reports) and WHEN they were generated (`inseason_generated_at`).
 * The rankings payloads themselves are bare arrays with neither.
 */
export async function fetchConfig() {
  let c;
  try {
    c = await get(`${BASE}/config`, { headers: headers() });
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new VegasAuthError('VegasEdge rejected the token.');
    throw err;
  }
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    season: num(c?.inseason_season),
    week: num(c?.inseason_week),
    generatedAt: c?.inseason_generated_at ?? null,
    liveSeason: num(c?.season_year),
    liveWeek: num(c?.week),
    books: c?.inseason_books ?? [],
  };
}

export async function fetchBoard({ board = 'flex', bookmaker = 'Average' } = {}) {
  const info = tokenInfo();
  if (info?.expired) throw new VegasAuthError(`VEGAS_TOKEN expired ${info.expiresAt.toISOString().slice(0, 10)}.`);
  const url = `${BASE}/${board}/rankings?bookmaker=${encodeURIComponent(bookmaker)}`;
  let data;
  try {
    data = await get(url, { headers: headers() });
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new VegasAuthError('VegasEdge rejected the token.');
    throw err;
  }
  if (!Array.isArray(data)) return [];
  return data.map((p) => {
    // The QB board has no Position field; the board it came from is the position.
    const position = p.Position || String(board).toUpperCase();
    const row = {
      sleeperId: String(p.PlayerID),
      name: p.Player,
      position,
      team: p.Team,
      // The expected stat line, kept whole so the points can be re-scored.
      rushingYds: p.RushingYds ?? null,
      receivingYds: p.ReceivingYds ?? null,
      receptions: p.Receptions ?? null,
      passYds: p.PassYds ?? null,
      passTds: p.PassTds ?? null,
      ints: p.INTs ?? null,
      rushTds: p.ExpectedRushTds ?? p.RushTDs ?? null,
      tdProb: p.TD_Prob ?? null,
      expectedTds: p.ExpectedTds ?? null,
      volatility: p.volatility_tag ?? null,
      noOdds: !!p.no_odds,
      missingProps: p.missing_props ?? [],
      missingFromBook: !!p.missing_from_book,
      // A projection is only comparable when every prop priced. Players without a
      // full market get points derived from TD probability alone, which reads as a
      // huge disagreement with FantasyPros when it is really just missing data.
      complete: !p.no_odds && !p.missing_from_book && !(p.missing_props ?? []).length,
      injuryStatus: p.InjuryStatus || null,
      injuryBodyPart: p.InjuryBodyPart || null,
      // What the site printed, at whatever scoring it held at the time. Kept
      // to detect drift; never read as the projection.
      sitePoints: p.FantasyPoints ?? null,
    };
    row.points = scoreComponents(row, 'PPR');
    return row;
  });
}

export async function checkToken() {
  const info = tokenInfo();
  const rows = await fetchBoard({ board: 'qb', bookmaker: 'Average' });
  return { ...info, ok: rows.length > 0, sample: rows.length };
}

/** Pull every position board for one bookmaker and write it under data/vegas/. */
export async function vegasSync({ season, week, bookmakers = ['Average'], boards = BOARDS, log = console.log } = {}) {
  const requested = resolveWeek({ season: season ?? config.season, week: week ?? config.week });
  const info = tokenInfo();
  if (info) log(`VegasEdge — ${info.email}, token valid to ${info.expiresAt.toISOString().slice(0, 10)}`);

  const cfg = await fetchConfig();
  const src = resolveSourceWeek(cfg, requested);
  const { season: yr, week: wk } = src;
  log(`  site is serving season ${cfg.season ?? '?'} week ${cfg.week ?? '?'}, generated ${cfg.generatedAt ?? 'at an unstated time'}`);
  if (!src.declared) log('  WARNING the site did not declare its week; filing under the requested week, unverified.');
  if (src.mismatch) for (const l of mismatchNotice('VegasEdge', src, requested)) log(l);
  log(`  season ${yr}, week ${wk}; books: ${bookmakers.join(', ')}`);

  const dir = join(VEGASDIR, String(yr), `week-${wk}`);
  mkdirSync(dir, { recursive: true });
  const fetchedAt = new Date().toISOString();
  const report = { season: yr, week: wk, fetchedAt, ok: [], failed: [], drift: [] };

  const jobs = bookmakers.flatMap((bk) => boards.map((b) => ({ bk, b })));
  await pool(jobs, async ({ bk, b }) => {
    try {
      const rows = await fetchBoard({ board: b, bookmaker: bk });
      const drift = boardScoringDrift(rows);
      const bkDir = join(dir, bk.toLowerCase());
      mkdirSync(bkDir, { recursive: true });
      writeFileSync(join(bkDir, `${b}.json`), JSON.stringify({
        season: yr, week: wk, bookmaker: bk, board: b,
        // Provenance. `sourceWeek`/`generatedAt` are the SITE's statements;
        // `weekDeclared:false` means the week above is only ours.
        schema: 2, fetchedAt, generatedAt: cfg.generatedAt, weekDeclared: src.declared,
        // `points` is scored by us at this format; `sitePoints` is what the
        // site printed under whatever scoring it held. See scoreComponents.
        scoring: 'PPR', siteScoringDrift: drift,
        players: rows,
      }, null, 2));
      log(`  ok   ${bk.padEnd(11)} ${b.toUpperCase().padEnd(4)} ${String(rows.length).padStart(4)} players`);
      report.ok.push(`${bk}/${b}`);
      if (drift.drifted) report.drift.push(`${bk}/${b} (x${drift.medianRatio} of PPR)`);
    } catch (err) {
      if (err instanceof VegasAuthError) throw err;
      log(`  FAIL ${bk}/${b} — ${err.message}`);
      report.failed.push({ label: `${bk}/${b}`, error: err.message });
    }
  }, { concurrency: 2 });
  if (report.drift.length) {
    log(`  NOTE the site's own point figure was NOT plain PPR on: ${report.drift.join(', ')}.`);
    log('       Its scoring is one process-wide setting that any visitor can change. Points here are re-scored from the');
    log('       stat line, so they are unaffected.');
  }

  // The site's own clock is `generatedAt`, from /config. Recorded as sourceAt so
  // the ledger can say when the market was last recomputed, not just when we asked.
  record('vegas', { ok: report.ok, failed: report.failed, sourceAt: cfg.generatedAt ?? null, season: yr, week: wk,
    items: report.ok.length,
    note: [src.declared ? null : 'week not declared by site', src.mismatch ? `requested week ${requested.week}, site serving ${wk}` : null,
      report.drift.length ? 'site scoring was not PPR (re-scored)' : null].filter(Boolean).join('; ') || null });
  log(`\n${report.ok.length} ok, ${report.failed.length} failed -> ${dir}`);
  return { ...report, requested, sourceWeek: src };
}

/* ------------------------------------------------------------- distributions
 *
 * The rankings board publishes a point ESTIMATE only. The same site computes a
 * full distribution behind /player/{name}/boombust — the 10K-sample alt-line
 * simulation the site's boom/bust panel draws — and that is the half worth
 * keeping: WinWithOdds ships floor and ceiling, and without this VegasEdge is
 * the only market source in the stack with no spread at all.
 *
 * The endpoint reweights the sample per request at whatever scoring you pass,
 * so the projection it returns is directly comparable to a league's own
 * numbers, unlike the board's, which uses the account's default scoring.
 *
 * Keyed by NAME, not by id — the only endpoint on the site that is.
 */

/**
 * One player's distribution. Returns null when the market is too thin to
 * simulate (`data_complete:false`) — a partial distribution is worse than none,
 * for the same reason a partial projection is.
 */
export async function fetchDistribution(name, { scoring = 'PPR' } = {}) {
  const sc = SCORING_PRESETS[String(scoring).toUpperCase()] || SCORING_PRESETS.PPR;
  const q = new URLSearchParams(Object.fromEntries(Object.entries(sc).map(([k, v]) => [k, String(v)])));
  let d;
  try {
    d = await get(`${BASE}/player/${encodeURIComponent(name)}/boombust?${q}`, { headers: headers() });
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new VegasAuthError('VegasEdge rejected the token.');
    if (err.status === 404) return null;
    throw err;
  }
  if (!d || d.data_complete === false || d.projection == null) return null;
  const pc = d.percentiles || {};
  return {
    name: d.player_name ?? name,
    position: d.position ?? null,
    team: d.team ?? null,
    week: d.week ?? null,
    proj: d.projection ?? null,
    // p10/p90 are the honest floor/ceiling pair: the same span WinWithOdds
    // publishes, so the two sources' ranges are read on one scale.
    floor: pc.p10 ?? null,
    ceiling: pc.p90 ?? null,
    percentiles: { p5: pc.p5 ?? null, p10: pc.p10 ?? null, p25: pc.p25 ?? null, p50: pc.p50 ?? null, p75: pc.p75 ?? null, p90: pc.p90 ?? null, p95: pc.p95 ?? null },
    boomThreshold: d.boom_threshold ?? null,
    bustThreshold: d.bust_threshold ?? null,
    boomPct: d.boom_pct ?? null,
    bustPct: d.bust_pct ?? null,
    volatility: d.tag ?? null,
    cv: d.tag_cv ?? null,
    booksUsed: d.n_books_used ?? null,
  };
}

/**
 * Distributions for every player on the already-synced boards, for one scoring
 * format. Run after `vegasSync`, which is where the name list comes from.
 */
export async function vegasDistSync({ season, week, scoring = 'PPR', bookmaker = 'Average', limit = 0, log = console.log } = {}) {
  const requested = resolveWeek({ season: season ?? config.season, week: week ?? config.week });
  const cfg = await fetchConfig();
  const { season: yr, week: wk, declared, mismatch } = resolveSourceWeek(cfg, requested);
  if (mismatch) log(`  WARNING requested week ${requested.week} but the site is serving week ${wk}; using week ${wk}.`);
  const dir = join(VEGASDIR, String(yr), `week-${wk}`);
  const boardDir = join(dir, String(bookmaker).toLowerCase());
  if (!existsSync(boardDir)) throw new Error(`No boards at ${boardDir} — run \`vegas:sync\` first.`);

  const roster = new Map();
  for (const f of readdirSync(boardDir).filter((x) => x.endsWith('.json'))) {
    for (const p of JSON.parse(readFileSync(join(boardDir, f), 'utf8')).players || []) {
      if (p.name && !roster.has(p.name)) roster.set(p.name, p.sleeperId || null);
    }
  }
  let names = [...roster.keys()];
  if (limit) names = names.slice(0, Number(limit));
  log(`VegasEdge distributions — season ${yr}, week ${wk}, ${scoring} scoring, ${names.length} players`);

  const out = [];
  let missing = 0, failed = 0, wrongWeek = 0;
  await pool(names, async (name) => {
    try {
      const d = await fetchDistribution(name, { scoring });
      if (!d) { missing++; return; }
      // Each response echoes the week it was simulated for. One that is not the
      // week we are filing under is somebody else's week, not a slow update.
      if (d.week != null && Number(d.week) !== Number(wk)) { wrongWeek++; return; }
      out.push({ ...d, sleeperId: roster.get(name) });
    } catch (err) {
      if (err instanceof VegasAuthError) throw err;
      failed++;
    }
  }, { concurrency: 4 });
  if (wrongWeek) log(`  WARNING ${wrongWeek} responses were for a different week than ${wk} and were dropped.`);

  mkdirSync(dir, { recursive: true });
  const file = join(dir, `distributions-${String(scoring).toLowerCase()}.json`);
  writeFileSync(file, JSON.stringify({ season: yr, week: wk, scoring, bookmaker, fetchedAt: new Date().toISOString(),
    generatedAt: cfg.generatedAt, weekDeclared: declared, players: out }, null, 2));
  record('vegas-dist', { ok: [`${scoring} ${out.length} players`], failed: failed ? [{ label: 'boombust', error: `${failed} requests failed` }] : [],
    sourceAt: cfg.generatedAt ?? null, season: yr, week: wk, items: out.length,
    note: [`${missing} markets too thin to simulate`, wrongWeek ? `${wrongWeek} dropped for wrong week` : null].filter(Boolean).join('; ') });
  log(`  ok   ${out.length} with a full distribution, ${missing} too thin to simulate${failed ? `, ${failed} failed` : ''}`);
  log(`  -> ${file}`);
  return { file, count: out.length, missing, failed, wrongWeek };
}
