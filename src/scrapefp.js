import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, pool } from './http.js';
import { FPDIR, config } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { scoringsInUse } from './fpapi.js';
import { record } from './freshness.js';

/**
 * FantasyPros' public pages — the bulk of its data, no API key needed. Called
 * through `fpSync` (fpsync.js), which adds the two API-only files on top.
 *
 * FantasyPros publishes RANKINGS and PROJECTIONS as two separate products that
 * disagree with each other, not one dataset under two URLs:
 *
 *   /nfl/rankings/ppr-rb.php       expert-panel CONSENSUS RANKINGS for the week.
 *                                   Embeds `var ecrData = {...}`; `r2p_pts` is a
 *                                   points figure IMPLIED by the ranking, not a
 *                                   projection in its own right.
 *   /nfl/projections/rb.php        the site's own PROJECTIONS model, rendered as
 *                                   an HTML table (`id="data"`); FPTS is the last
 *                                   column, carrying a `data-sort-value`.
 *
 * These used to be treated as one thing (only rankings were scraped, and its
 * r2p_pts stood in for "the projection" everywhere) — that was wrong and is
 * fixed here: both are fetched, and `enrich.js` already prefers a dedicated
 * projections file over the rankings r2p_pts fallback (see `projIndex`) once
 * one exists on disk.
 *
 * ROS is NOT symmetric between the two. Rankings has a real rest-of-season
 * board (`ros-` prefixed / `type=ROS`) that FantasyPros keeps current.
 * Projections has no equivalent — its only non-weekly mode (`?week=draft`) is
 * the static PRESEASON full-season projection, last recomputed before week 1
 * and never touched again — the stale full-season figure this
 * app refuses to show. So only CURRENT-WEEK projections are
 * fetched here; rest-of-season stays sourced from the rankings ROS board.
 *
 * The projections page is also paywalled, unlike rankings: logged out, it
 * renders only the top ~10 players/position behind a "create a free account"
 * fence. `FP_COOKIE` (optional — the `Cookie:` header of a logged-in
 * fantasypros.com session) unlocks the full board; see
 * `fetchProjections`.
 *
 * Injuries and news come from the server-rendered injury-news listing.
 */

const RANK_BASE = 'https://www.fantasypros.com/nfl/rankings';
const PROJ_BASE = 'https://www.fantasypros.com/nfl/projections';
const NEWS_BASE = 'https://www.fantasypros.com/nfl/injury-news.php';
/** `enrich.js`'s POINTS_KEY, duplicated here rather than imported to avoid a cycle. */
const STATS_KEY = { PPR: 'points_ppr', HALF: 'points_half', STD: 'points' };

/**
 * Positions whose board varies by scoring format. QB/K/DST do not.
 *
 * `rankingUrl` collapses to the same URL for those three across PPR/HALF/STD,
 * so iterating formats × positions blindly fetched the identical page two or
 * three times per run on a multi-format account.
 */
const SCORING_SENSITIVE = new Set(['rb', 'wr', 'te', 'flex']);
export const isScoringSensitive = (position) => SCORING_SENSITIVE.has(String(position).toLowerCase());

/** FLEX boards carry ranks but no r2p_pts, so they're opt-in. */
export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

export function rankingUrl(position, scoring = 'PPR', { ros = false } = {}) {
  const p = String(position).toLowerCase();
  let base = p;
  if (SCORING_SENSITIVE.has(p)) {
    if (scoring === 'PPR') base = `ppr-${p}`;
    else if (scoring === 'HALF') base = `half-point-ppr-${p}`;
    else base = p; // STD
  }
  return `${RANK_BASE}/${ros ? 'ros-' : ''}${base}.php`;
}

function parseEcr(html, url) {
  const m = html.match(/var\s+ecrData\s*=\s*(\{.*?\});/s);
  if (!m) throw new Error(`no ecrData embedded at ${url}`);
  return JSON.parse(m[1]);
}

/** Fetch one ranking board. Returns the raw ecrData object. */
export async function fetchRankings({ position, scoring = 'PPR', ros = false } = {}) {
  const url = rankingUrl(position, scoring, { ros });
  const html = await get(url, { asText: true });
  const data = parseEcr(html, url);
  data._source = url;
  return data;
}

/* ------------------------------------------------------------- projections */

export function projectionsUrl(position, scoring = 'PPR', { week } = {}) {
  const qs = new URLSearchParams({ scoring });
  if (week != null) qs.set('week', String(week));
  return `${PROJ_BASE}/${String(position).toLowerCase()}.php?${qs.toString()}`;
}

/**
 * Parse the projections table. FPTS is always the LAST stat column and the
 * only one carrying `data-sort-value` (the un-rounded figure the display text
 * is rounded from), so one rule covers every position without a per-position
 * column map — QB's passing line and DST's team defense line differ, but both
 * end the row the same way.
 */
export function parseProjectionsTable(html) {
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!body) throw new Error('no projections table body found');
  const rows = body[1].split('<tr class="mpb-player-').slice(1);
  const players = [];
  for (const r of rows) {
    const fpid = Number((r.match(/^(\d+)/) || [])[1]) || null;
    const name = (r.match(/fp-player-name="([^"]*)"/) || [])[1] || null;
    const team = (r.match(/<\/a>\s*([A-Z]{2,3})\s*<\/td>/) || [])[1] || null;
    const sortValues = [...r.matchAll(/data-sort-value="([-\d.]+)"/g)];
    const fpts = sortValues.length ? Number(sortValues[sortValues.length - 1][1]) : null;
    if (!fpid || fpts == null) continue;
    players.push({ fpid, name, team_id: team, fpts });
  }
  return players;
}

/**
 * Fetch one position's current-week projections for one scoring format.
 *
 * Logged out, the page renders only the top ~10 players/position behind a
 * "create a free account" fence (verified on the raw response — a
 * `is_premium_feature` registration block, not a truncated table). `FP_COOKIE`
 * (a full `Cookie:` header from a logged-in fantasypros.com session) unlocks
 * the full board when set;
 * unset, this silently gets the top-10 slice, which `enrich.js` already
 * treats as a partial file (whatever a player is missing falls back to the
 * rankings board's implied points).
 */
export async function fetchProjections({ position, scoring = 'PPR', week } = {}) {
  const url = projectionsUrl(position, scoring, { week });
  const headers = config.fpCookie ? { Cookie: config.fpCookie } : {};
  const html = await get(url, { asText: true, headers });
  const players = parseProjectionsTable(html);
  const updated = (html.match(/Consensus last updated <time datetime="([^"]+)"/) || [])[1] || null;
  return { _source: url, _updatedAt: updated, players };
}

/* ------------------------------------------------------------ injury news */

const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&raquo;/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/**
 * Parse the player-news-item blocks. The FantasyPros player id is only present
 * in the headshot URL (/images/players/nfl/<fpid>/headshot/...), so that is what
 * the join key comes from.
 */
export function parseNewsItems(html) {
  const blocks = html.split('<div class="player-news-item"').slice(1);
  const items = [];
  for (const b of blocks) {
    const fpid = Number((b.match(/\/images\/players\/nfl\/(\d+)\//) || [])[1]) || null;
    const slug = (b.match(/href="\/nfl\/players\/([a-z0-9-]+)\.php"/) || [])[1] || null;
    const posTeam = (b.match(/<p style='text-align: center; font-size:11px[^>]*>([^<]+)<\/p>/) || [])[1] || '';
    const [position, team] = posTeam.split('-').map((s) => s.trim());
    const headline = strip((b.match(/<div class="player-news-header[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '')
      || strip((b.match(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/) || [])[1] || '');
    const date = (b.match(/((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\w{3}\s+\d{1,2}\w{0,2}\s+\d{1,2}:\d{2}[ap]m\s+\w+)/i) || [])[1] || null;
    const author = (b.match(/By\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)*)/) || [])[1] || null;
    const impact = strip((b.match(/Fantasy Impact:([\s\S]*?)(?:<\/div>|<div class="player-news-item)/) || [])[1] || '') || null;
    const text = strip(b.replace(/<script[\s\S]*?<\/script>/g, ''));
    if (!fpid && !headline) continue;
    items.push({ fpid, slug, position: position || null, team: team || null, headline, date, author, impact, text: text.slice(0, 2000) });
  }
  return items;
}

/**
 * Derive a structured status from a news headline. The listing has no status
 * field of its own — the headline is the only place it appears.
 */
export function classifyInjury(headline = '') {
  const h = headline.toLowerCase();
  if (/\b(placed on ir|to ir|injured reserve|pup list)\b/.test(h)) return 'IR';
  if (/\b(ruled out|won't play|will not play|out for|sidelined|miss(es|ing)? (sunday|monday|thursday|week))\b/.test(h)) return 'OUT';
  if (/\bdoubtful\b/.test(h)) return 'DOUBTFUL';
  if (/\bquestionable\b/.test(h)) return 'QUESTIONABLE';
  if (/\b(limited|dnp|did not practice|no practice)\b/.test(h)) return 'LIMITED';
  if (/\b(off injury report|full practice|cleared|activated|expected to play|will play|good to go|return(s|ing)?)\b/.test(h)) return 'ACTIVE';
  return null;
}

/** The body part in a headline parenthetical, e.g. "Kamara (knee)" -> "knee". */
export function injuryType(headline = '') {
  const m = headline.match(/\(([^)]{2,30})\)/);
  if (!m) return null;
  const t = m[1].trim();
  return /^(illness|rest|personal|coach|suspension)/i.test(t) || /^[a-z][a-z' -]+$/i.test(t) ? t.toLowerCase() : null;
}

/**
 * Player name for an item. The headline leads with the real name ("T.J. Sanders
 * (knee) ...") and preserves punctuation the URL slug flattens, so prefer it and
 * fall back to the slug.
 */
export function playerName(headline = '', slug = null) {
  const head = headline.split('(')[0].trim();
  if (/^[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){1,3}$/.test(head)) return head;
  return slug ? slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : null;
}

export async function fetchInjuryNews({ pages = 3, position, team } = {}) {
  const urls = Array.from({ length: pages }, (_, i) => {
    const qs = new URLSearchParams();
    if (i > 0) qs.set('page', String(i + 1));
    if (position) qs.set('position', position);
    if (team) qs.set('team', team);
    const q = qs.toString();
    return `${NEWS_BASE}${q ? `?${q}` : ''}`;
  });
  const chunks = await pool(urls, async (u) => {
    try {
      return parseNewsItems(await get(u, { asText: true }));
    } catch {
      return [];
    }
  }, { concurrency: 2 });
  return chunks.flat();
}

/* ----------------------------------------------------------------- sync */

const save = (dir, name, data) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2));
};

/**
 * Writes data/fp/<season>/{week-N,ros}/… — the layout `enrich` reads.
 */
export async function scrapeSync({ season, week, positions = POSITIONS, scorings = null, newsPages = 4, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season: season ?? config.season, week: week ?? config.week });
  const formats = scorings || scoringsInUse();
  const root = join(FPDIR, String(yr));
  const weekDir = join(root, `week-${wk}`);
  const rosDir = join(root, 'ros');

  log(`FantasyPros public pages — season ${yr}, week ${wk}`);
  log(`  scoring formats: ${formats.join(', ')}`);
  log(`  positions:       ${positions.join(', ')}`);

  const ok = [], failed = [];
  /**
   * One job per DISTINCT URL, then written out under every scoring format it
   * serves. A QB board is one fetch and three files, not three fetches.
   */
  const jobs = new Map();
  for (const ros of [false, true]) {
    for (const sc of formats) {
      for (const pos of positions) {
        const url = rankingUrl(pos, sc, { ros });
        const j = jobs.get(url) || { ros, pos, scoring: sc, formats: [], url };
        j.formats.push(sc);
        jobs.set(url, j);
      }
    }
  }
  const dedup = formats.length * positions.length * 2 - jobs.size;
  if (dedup > 0) log(`  ${jobs.size} distinct boards (${dedup} scoring duplicates skipped for QB/K/DST)`);

  // The newest last_updated_ts across every board — FantasyPros' own clock,
  // which is what says whether a re-scrape would return anything new.
  let newestTs = 0;

  await pool([...jobs.values()], async ({ ros, pos, scoring, formats: fmts }) => {
    const label = `${ros ? 'ROS' : `wk${wk}`} ${fmts.join('/')} ${pos}`;
    try {
      const data = await fetchRankings({ position: pos, scoring, ros });
      for (const sc of fmts) {
        const dir = join(ros ? rosDir : weekDir, 'rankings', sc.toLowerCase());
        save(dir, pos.toLowerCase(), data);
      }
      const ts = Number(data.last_updated_ts) || 0;
      if (ts > newestTs) newestTs = ts;
      const pts = (data.players || []).filter((p) => p.r2p_pts != null).length;
      log(`  ok   ${label.padEnd(20)} ${String(data.players?.length ?? 0).padStart(4)} players, ${pts} w/ ranking-implied pts`);
      ok.push(label);
    } catch (err) {
      log(`  FAIL ${label} — ${err.message}`);
      failed.push({ label, error: err.message });
    }
  }, { concurrency: 3 });

  // Separate product from rankings above (see the module docblock): the site's
  // own projections model, current week only — no static full-season figure.
  // Insensitive positions (QB/K/DST) are fetched once under a canonical PPR
  // URL and the same figure applied to every requested format, exactly as the
  // rankings job builder above does.
  log(`\nweek ${wk} — projections`);
  const projJobs = new Map();
  for (const sc of formats) {
    for (const pos of positions) {
      const canonicalSc = isScoringSensitive(pos) ? sc : 'PPR';
      const url = projectionsUrl(pos, canonicalSc, { week: wk });
      const j = projJobs.get(url) || { pos, scoring: canonicalSc, formats: [], url };
      j.formats.push(sc);
      projJobs.set(url, j);
    }
  }
  const projDedup = formats.length * positions.length - projJobs.size;
  if (projDedup > 0) log(`  ${projJobs.size} distinct boards (${projDedup} scoring duplicates skipped for QB/K/DST)`);

  const byPosition = new Map(positions.map((pos) => [pos, new Map()]));
  await pool([...projJobs.values()], async ({ pos, scoring, formats: fmts }) => {
    const label = `projections ${fmts.join('/')} ${pos} wk${wk}`;
    try {
      const data = await fetchProjections({ position: pos, scoring, week: wk });
      const byId = byPosition.get(pos);
      for (const p of data.players) {
        const row = byId.get(p.fpid) || { fpid: p.fpid, name: p.name, team_id: p.team_id, stats: {} };
        for (const sc of fmts) row.stats[STATS_KEY[sc]] = p.fpts;
        byId.set(p.fpid, row);
      }
      log(`  ok   ${label.padEnd(24)} ${data.players.length} players`);
      ok.push(label);
    } catch (err) {
      log(`  FAIL ${label} — ${err.message}`);
      failed.push({ label, error: err.message });
    }
  }, { concurrency: 3 });
  for (const [pos, byId] of byPosition) {
    const players = [...byId.values()];
    if (!players.length) continue;
    save(join(weekDir, 'projections'), pos.toLowerCase(), { fetchedAt: new Date().toISOString(), source: 'projections-page', players });
  }

  log('\ninjuries + news');
  try {
    const items = await fetchInjuryNews({ pages: newsPages });
    save(root, 'news', { fetchedAt: new Date().toISOString(), source: NEWS_BASE, news: items });
    // Injury view: only items whose headline actually resolves to a status.
    // Newest wins — the listing is reverse-chronological, so keep the first per player.
    const byPlayer = new Map();
    for (const i of items) {
      const status = classifyInjury(i.headline);
      if (!i.fpid || !status || byPlayer.has(i.fpid)) continue;
      byPlayer.set(i.fpid, {
        player_id: i.fpid,
        name: playerName(i.headline, i.slug),
        status,
        injury_type: injuryType(i.headline),
        headline: i.headline,
        comment: i.impact || i.headline,
        injury_update_date: i.date,
      });
    }
    const injuries = [...byPlayer.values()];
    save(weekDir, 'injuries', { fetchedAt: new Date().toISOString(), source: NEWS_BASE, injuries });
    log(`  ok   news ${items.length} items, ${injuries.length} players with a status`);
    ok.push('news', 'injuries');
  } catch (err) {
    log(`  FAIL news — ${err.message}`);
    failed.push({ label: 'news', error: err.message });
  }

  const sourceAt = newestTs ? new Date(newestTs * 1000).toISOString() : null;
  const rep = record('fp', { ok, failed, sourceAt, season: yr, week: wk, items: jobs.size, note: 'public-pages' });
  log(`\n${ok.length} ok, ${failed.length} failed${sourceAt ? `, boards last recomputed ${sourceAt}` : ''} -> ${root}`);
  return rep;
}
