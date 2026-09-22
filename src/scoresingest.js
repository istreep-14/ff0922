import { execFileSync } from 'node:child_process';
import { isFinal, mergeLeagueWeek, readWeek, storedWeeks } from './matchups.js';
import { record } from './freshness.js';

/**
 * Recover ESPN/Yahoo weeks MyPlaybook can no longer answer for.
 *
 * MyPlaybook's matchup endpoint has no week parameter — once the slate rolls
 * (roughly Tuesday morning) the previous week is gone, and future pairings
 * never appear. Sleeper we ask directly (`leaguedetail:backfill`). ESPN and
 * Yahoo have no public equivalent from Node (ESPN's read API wants session
 * cookies; Yahoo 999-blocks cookie replay), so the recovery path is a file
 * the user captured in a logged-in browser.
 *
 * Accepted shapes, all collapsed onto the existing `data/scores/` ledger:
 *   - Dynasty Daddy `GET /api/v1/league/load` (the Network-tab save)
 *   - ESPN `mMatchupScore` (+ optional `mTeam`) response, raw or wrapped
 *   - a compact `{ leagueId, weeks: { N: { matchups: [...] } } }` dump
 *
 * Current week is left alone — `matchups:sync` owns the live board. Per-player
 * lineups are empty: team score + result is what standings PF/PA need.
 */

const sleepers = (host) => String(host || '').toLowerCase() === 'sleeper';

export function leagueIdsOf(league) {
  const raw = String(league?.leagueId ?? '').trim();
  const out = new Set();
  if (!raw) return out;
  out.add(raw);
  out.add(raw.toLowerCase());
  const yahoo = raw.match(/(?:^|\.)l\.(\d+)$/i);
  if (yahoo) {
    out.add(yahoo[1]);
    out.add(`nfl.l.${yahoo[1]}`);
  }
  const digits = raw.match(/(\d{5,})$/);
  if (digits) out.add(digits[1]);
  return out;
}

export function findLeague(leagues, leagueId) {
  const want = new Set();
  for (const id of [leagueId].flat()) {
    if (id == null || id === '') continue;
    const s = String(id).trim();
    want.add(s);
    want.add(s.toLowerCase());
    const yahoo = s.match(/(?:^|\.)l\.(\d+)$/i);
    if (yahoo) want.add(yahoo[1]);
    const digits = s.match(/(\d{5,})$/);
    if (digits) want.add(digits[1]);
  }
  if (!want.size) return null;
  return (leagues || []).find((l) => [...leagueIdsOf(l)].some((id) => want.has(id))) || null;
}

const side = (teamId, name, points, extra = {}) => ({
  teamId: teamId == null ? null : String(teamId),
  name: name || null,
  logo: extra.logo || null,
  color: extra.color || null,
  points: Number(points) || 0,
  projected: extra.projected ?? null,
  projected0: extra.projected0 ?? null,
  status: extra.status || null,
  result: extra.result || null,
  isPreGame: !!extra.isPreGame,
  minutesLeft: extra.minutesLeft ?? 0,
  starters: extra.starters || [],
  bench: extra.bench || [],
});

function pairing(a, b, { status, isPreGame, result } = {}) {
  const sides = [a, b].filter(Boolean);
  return {
    status: status || (isPreGame ? 'notStarted' : 'finished'),
    isPreGame: !!isPreGame,
    live: false,
    minutesLeft: isPreGame ? null : 0,
    winProbability: null,
    result: result ?? null,
    sides,
  };
}

function nameOf(league, teamId, fallback) {
  const id = String(teamId);
  const t = (league?.teams || []).find((x) => String(x.teamId) === id);
  return t?.name || fallback || `Team ${id}`;
}

function logoOf(league, teamId, fallback) {
  const id = String(teamId);
  const t = (league?.teams || []).find((x) => String(x.teamId) === id);
  return t?.logo || fallback || null;
}

/** Dynasty Daddy `league/load` — full season, keyed by week. */
export function parseDynastyDaddy(dump) {
  const meta = dump?.meta || {};
  const leagueId = meta.leagueId ?? dump.leagueId;
  if (leagueId == null || !dump.matchUps || typeof dump.matchUps !== 'object') return null;
  const teams = new Map((dump.teams || []).map((t) => [String(t.rosterId), t]));
  const weeks = {};
  for (const [wk, rows] of Object.entries(dump.matchUps)) {
    const n = Number(wk);
    if (!Number.isFinite(n) || !Array.isArray(rows)) continue;
    weeks[n] = (rows || []).map((row) => {
      const sides = (row.teams || []).map((s) => {
        const id = s.rosterId;
        const metaTeam = teams.get(String(id));
        const name = metaTeam?.owner?.teamName || metaTeam?.owner?.name || `Team ${id}`;
        return side(id, name, s.points, { logo: metaTeam?.owner?.avatar || null });
      });
      return pairing(sides[0], sides[1]);
    }).filter((m) => m.sides.length);
  }
  return { source: 'dynasty-daddy', leagueId: String(leagueId), season: meta.season ? Number(meta.season) : null, weeks };
}

function espnTeamName(t) {
  if (!t) return null;
  if (t.name) return t.name;
  const loc = t.location || t.abbrev || '';
  const nick = t.nickname || '';
  return [loc, nick].filter(Boolean).join(' ').trim() || null;
}

function espnWeekPoints(entry, week) {
  if (!entry) return 0;
  const by = entry.pointsByScoringPeriod;
  if (by && by[String(week)] != null) return Number(by[String(week)]) || 0;
  if (entry.totalPointsLive != null && Number(entry.totalPointsLive) > 0) return Number(entry.totalPointsLive);
  return Number(entry.totalPoints) || 0;
}

function parseEspnLeague(raw, { week = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.schedule) && !Array.isArray(raw.teams)) return null;
  const leagueId = raw.id ?? raw.leagueId;
  const season = raw.seasonId ?? raw.season ?? null;
  const names = new Map((raw.teams || []).map((t) => [String(t.id), espnTeamName(t)]));
  const logos = new Map((raw.teams || []).map((t) => [String(t.id), t.logo || t.logoURL || null]));
  const byWeek = {};
  for (const g of raw.schedule || []) {
    const wk = Number(g.matchupPeriodId ?? g.scoringPeriodId);
    if (!Number.isFinite(wk)) continue;
    if (week != null && wk !== Number(week)) continue;
    const home = g.home || g.homeTeam;
    const away = g.away || g.awayTeam;
    const hId = home?.teamId ?? home?.id;
    const aId = away?.teamId ?? away?.id;
    if (hId == null && aId == null) continue;
    const h = hId == null ? null : side(hId, names.get(String(hId)), espnWeekPoints(home, wk), { logo: logos.get(String(hId)) });
    const a = aId == null ? null : side(aId, names.get(String(aId)), espnWeekPoints(away, wk), { logo: logos.get(String(aId)) });
    if (!byWeek[wk]) byWeek[wk] = [];
    byWeek[wk].push(pairing(h, a));
  }
  if (!Object.keys(byWeek).length) return null;
  return { source: 'espn', leagueId: leagueId != null ? String(leagueId) : null, season: season ? Number(season) : null, weeks: byWeek };
}

function compactWeek(entry) {
  if (!entry) return [];
  if (Array.isArray(entry)) return entry;
  if (Array.isArray(entry.matchups)) return entry.matchups;
  if (Array.isArray(entry.rows)) return entry.rows;
  return [];
}

function parseCompact(dump) {
  if (!dump || typeof dump !== 'object') return null;
  const leagueId = dump.leagueId ?? dump.meta?.leagueId;
  const weeksIn = dump.weeks || dump.matchUps;
  if (leagueId == null || !weeksIn || typeof weeksIn !== 'object' || Array.isArray(weeksIn)) return null;
  const weeks = {};
  for (const [wk, entry] of Object.entries(weeksIn)) {
    const n = Number(wk);
    if (!Number.isFinite(n)) continue;
    const rows = compactWeek(entry).map((m) => {
      const sides = (m.sides || m.teams || []).map((s) =>
        side(s.teamId ?? s.rosterId ?? s.id, s.name ?? s.team, s.points ?? s.pts ?? s.score));
      return pairing(sides[0], sides[1], { status: m.status, isPreGame: m.isPreGame ?? m.pre });
    }).filter((m) => m.sides.length);
    if (rows.length) weeks[n] = rows;
  }
  if (!Object.keys(weeks).length) return null;
  return { source: dump.source || 'compact', leagueId: String(leagueId), season: dump.season ? Number(dump.season) : null, weeks };
}

/**
 * Identify a pasted dump. A wrapped `{ weeks: { N: espnResponse } }` is ESPN
 * per week; a Dynasty Daddy load is the whole season in one object.
 */
export function parseDump(dump) {
  if (dump == null) return [];
  if (typeof dump === 'string') {
    try { dump = JSON.parse(dump); } catch { return []; }
  }
  if (Array.isArray(dump)) return dump.flatMap(parseDump);

  const dd = parseDynastyDaddy(dump);
  if (dd) return [dd];

  if (dump.weeks && typeof dump.weeks === 'object' && dump.leagueId != null) {
    const first = Object.values(dump.weeks)[0];
    // Wrapped ESPN: each week value is a full mMatchupScore payload.
    if (first && typeof first === 'object' && Array.isArray(first.schedule)) {
      const weeks = {};
      let season = dump.season ?? null;
      for (const [wk, raw] of Object.entries(dump.weeks)) {
        const parsed = parseEspnLeague(raw, { week: Number(wk) });
        if (!parsed) continue;
        season = season ?? parsed.season;
        Object.assign(weeks, parsed.weeks);
      }
      if (Object.keys(weeks).length) {
        return [{ source: 'espn', leagueId: String(dump.leagueId), season: season ? Number(season) : null, weeks }];
      }
    }
    const compact = parseCompact(dump);
    if (compact) return [compact];
  }

  const espn = parseEspnLeague(dump);
  if (espn) return [espn];

  const compact = parseCompact(dump);
  return compact ? [compact] : [];
}

export function shouldReplace(existing, { force = false } = {}) {
  if (force) return true;
  if (!existing?.ok || !(existing.matchups || []).length) return true;
  // A mid-game snapshot that rolled over is exactly the bug: keep the ingest.
  if (!existing.matchups.every(isFinal)) return true;
  return false;
}

function weekState(week, currentWeek, includeSchedule) {
  if (week === currentWeek) return 'current';
  if (week > currentWeek) return includeSchedule ? 'future' : 'skip-future';
  return 'past';
}

function finalizeMatchups(rows, { past }) {
  return (rows || []).map((m) => {
    const isPreGame = !past;
    const [a, b] = m.sides || [];
    let result = m.result;
    if (past && a && b && result == null) {
      if ((a.points || 0) > (b.points || 0)) result = `${a.name} wins`;
      else if ((b.points || 0) > (a.points || 0)) result = `${b.name} wins`;
      else result = 'Tie';
    }
    return pairing(
      a && { ...a, isPreGame, minutesLeft: past ? 0 : null, result: past ? (a.points > (b?.points ?? -Infinity) ? 'win' : a.points < (b?.points ?? Infinity) ? 'loss' : 'tie') : null },
      b && { ...b, isPreGame, minutesLeft: past ? 0 : null, result: past ? (b.points > (a?.points ?? -Infinity) ? 'win' : b.points < (a?.points ?? Infinity) ? 'loss' : 'tie') : null },
      { status: past ? 'finished' : 'notStarted', isPreGame, result },
    );
  });
}

function bindNames(rows, league) {
  return (rows || []).map((m) => ({
    ...m,
    sides: (m.sides || []).map((s) => ({
      ...s,
      name: nameOf(league, s.teamId, s.name),
      logo: logoOf(league, s.teamId, s.logo),
    })),
  }));
}

export function ingestDump(dump, {
  leagues,
  season,
  currentWeek,
  force = false,
  includeSchedule = false,
  merge = mergeLeagueWeek,
  read = readWeek,
  log = () => {},
} = {}) {
  const parsed = parseDump(dump);
  if (!parsed.length) throw new Error('Unrecognised dump — expected Dynasty Daddy league/load, an ESPN mMatchupScore payload, or { leagueId, weeks }.');

  const written = [];
  const skipped = [];
  for (const item of parsed) {
    const league = findLeague(leagues, item.leagueId);
    if (!league) {
      skipped.push({ leagueId: item.leagueId, reason: 'no matching league in latest.json' });
      log(`  skip  leagueId ${item.leagueId} — not in latest.json`);
      continue;
    }
    if (sleepers(league.host) && item.source === 'dynasty-daddy') {
      // Sleeper already has a first-party backfill; accepting the dump still
      // recovers a week the Sleeper step missed, so we do not refuse it.
    }
    const yr = season ?? item.season;
    if (yr == null) throw new Error(`No season on dump for ${league.nickname || item.leagueId} — pass --season.`);

    for (const [wkRaw, rows] of Object.entries(item.weeks || {})) {
      const wk = Number(wkRaw);
      const state = weekState(wk, currentWeek, includeSchedule);
      if (state === 'current') {
        skipped.push({ league: league.nickname, week: wk, reason: 'current week belongs to matchups:sync' });
        log(`  skip  ${(league.nickname || '').padEnd(24)} week ${wk} — live week, left for matchups:sync`);
        continue;
      }
      if (state === 'skip-future') {
        skipped.push({ league: league.nickname, week: wk, reason: 'future (pass --schedule to keep pairings)' });
        continue;
      }
      const existing = read(yr, wk)?.leagues?.[league.key];
      if (!shouldReplace(existing, { force })) {
        skipped.push({ league: league.nickname, week: wk, reason: 'already final' });
        log(`  skip  ${(league.nickname || '').padEnd(24)} week ${wk} — already final`);
        continue;
      }
      const past = state === 'past';
      const matchups = bindNames(finalizeMatchups(rows, { past }), league);
      if (!matchups.length) continue;
      const payload = {
        ok: true,
        failed: 0,
        matchups,
        source: item.source,
        fetchedAt: new Date().toISOString(),
      };
      merge(yr, wk, league.key, payload, { fetchedAt: payload.fetchedAt });
      written.push({ league: league.nickname || league.key, host: league.host, week: wk, matchups: matchups.length, source: item.source });
      log(`  ok    ${(league.host || '').padEnd(8)} ${(league.nickname || '').slice(0, 24).padEnd(25)} week ${String(wk).padStart(2)}  ${matchups.length} matchups (${item.source}${past ? '' : ', schedule'})`);
    }
  }
  return { written, skipped };
}

export function ingestScores({
  dump,
  leagues,
  season,
  currentWeek,
  force = false,
  includeSchedule = false,
  log = console.log,
} = {}) {
  const result = ingestDump(dump, { leagues, season, currentWeek, force, includeSchedule, log });
  const weeks = storedWeeks(season);
  record('scores-ingest', {
    ok: result.written.map((w) => `${w.league} w${w.week}`),
    failed: result.skipped.filter((s) => s.reason?.startsWith('no matching')).map((s) => ({ label: s.leagueId, error: s.reason })),
    sourceAt: null,
    season,
    items: result.written.length,
    note: result.written.length
      ? `filled ${result.written.map((w) => `w${w.week}`).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`
      : 'nothing new',
  });
  log(result.written.length
    ? `  -> data/scores/${season}/ (weeks on disk: ${weeks.join(', ') || 'none'})`
    : '  nothing written');
  return result;
}

export function readClipboard() {
  try {
    return execFileSync('pbpaste', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * In-page capture. Copies JSON to the clipboard (a bookmarklet click is a
 * user gesture, which DevTools paste is not) and POSTs to the local serve
 * process when it is running. Returns the object so a leftover Promise in
 * DevTools has the dump as its result, not `undefined`.
 */
export function captureIife({ season, throughWeek, leagues = [] } = {}) {
  const yahoo = (leagues || []).filter((l) => String(l.host).toLowerCase() === 'yahoo')
    .map((l) => ({ nickname: l.nickname, leagueId: String(l.leagueId) }));
  const thru = Number(throughWeek) || 1;
  const yr = Number(season) || new Date().getFullYear();
  return `(async () => {
  const SEASON = ${yr};
  const THROUGH = ${thru};
  const YAHOO = ${JSON.stringify(yahoo)};
  const weeks = Array.from({ length: Math.max(THROUGH - 1, 0) }, (_, i) => i + 1);
  const host = location.hostname;
  console.log('Capturing weeks 1–' + Math.max(THROUGH - 1, 0) + '. Clipboard + local server; ignore Promise {pending}.');
  const copyOut = async (obj) => {
    window.__FF_SCORES__ = obj;
    const text = JSON.stringify(obj);
    try {
      await navigator.clipboard.writeText(text);
      console.log('Copied ' + text.length + ' chars. Paste on Sync, or: node src/cli.js scores:ingest');
    } catch (e) {
      console.log('Clipboard blocked. copy(JSON.stringify(window.__FF_SCORES__)) then paste on Sync.');
    }
    try {
      const r = await fetch('http://127.0.0.1:4173/api/scores-ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
      if (r.ok) console.log('Posted to local server — reload the dashboard.');
    } catch (e) {}
    return obj;
  };

  if (host.includes('dynasty-daddy.com')) {
    throw new Error(
      'Do not GET /api/v1/league/load from the league list (404). Open one league, DevTools → Network → filter "load" → the league/load request → Response → Copy. Paste on the Sync page.'
    );
  }

  if (host.includes('espn.com')) {
    const qs = new URLSearchParams(location.search);
    const fromPath = location.pathname.match(/leagues\\/(\\d+)/);
    const leagueId = qs.get('leagueId') || (fromPath && fromPath[1]);
    if (!leagueId) throw new Error('No leagueId on this ESPN URL — open the league scoreboard first.');
    const out = { source: 'espn', leagueId: String(leagueId), season: SEASON, weeks: {} };
    for (const w of weeks) {
      const url = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + SEASON
        + '/segments/0/leagues/' + leagueId
        + '?view=mMatchupScore&view=mTeam&scoringPeriodId=' + w;
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error('ESPN week ' + w + ' HTTP ' + r.status + ' — are you logged in? Private league?');
      out.weeks[w] = await r.json();
      await new Promise((res) => setTimeout(res, 400));
    }
    return await copyOut(out);
  }

  if (host.includes('yahoo.com')) {
    const m = location.pathname.match(/\\/f1\\/(\\d+)/);
    const leagueId = m && m[1];
    if (!leagueId) throw new Error('No /f1/<id> in the Yahoo URL — open the league scoreboard first.');
    const known = YAHOO.find((l) => String(l.leagueId).endsWith(leagueId) || String(l.leagueId) === leagueId);
    const out = { source: 'yahoo', leagueId: known ? known.leagueId : leagueId, season: SEASON, weeks: {} };
    const parseHtml = (html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const ids = new Set();
      const re = new RegExp('/f1/' + leagueId + '/(\\\\d+)(?:\\\\D|$)');
      const hits = [];
      for (const a of doc.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const mm = href.match(re);
        if (!mm) continue;
        const teamId = mm[1];
        if (ids.has(teamId + '@' + hits.length)) continue;
        let el = a;
        let pts = null;
        for (let i = 0; i < 8 && el; i++) {
          const txt = (el.innerText || el.textContent || '').replace(/,/g, '');
          const sm = txt.match(new RegExp('\\\\b(\\\\d{1,3}\\\\.\\\\d{1,2})\\\\b', 'g'));
          if (sm && sm.length) pts = Number(sm[sm.length - 1]);
          if (pts != null) break;
          el = el.parentElement;
        }
        const name = (a.textContent || '').trim() || ('Team ' + teamId);
        hits.push({ teamId, name, points: pts || 0 });
        ids.add(teamId + '@' + hits.length);
      }
      const uniq = [];
      const seen = new Set();
      for (const h of hits) {
        if (seen.has(h.teamId)) continue;
        seen.add(h.teamId);
        uniq.push(h);
      }
      const matchups = [];
      for (let i = 0; i < uniq.length; i += 2) {
        const a = uniq[i], b = uniq[i + 1];
        matchups.push({ sides: [a, b].filter(Boolean) });
      }
      return matchups;
    };
    for (const w of weeks) {
      const url = location.origin + '/f1/' + leagueId + '?week=' + w;
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error('Yahoo week ' + w + ' HTTP ' + r.status);
      const html = await r.text();
      out.weeks[w] = { matchups: parseHtml(html) };
      await new Promise((res) => setTimeout(res, 800));
    }
    return await copyOut(out);
  }

  throw new Error('Open this on fantasy.espn.com, football.fantasysports.yahoo.com, or dynasty-daddy.com');
})();`;
}

export function captureScript(opts) {
  return `/* Click the bookmarklet on ESPN/Yahoo instead of pasting this.
   Bookmarklet click is a user gesture so clipboard works; DevTools paste often is not.
   If serve is running it also POSTs to http://127.0.0.1:4173/api/scores-ingest.
*/
${captureIife(opts)}`;
}

export function bookmarklet(opts) {
  return `javascript:void(${captureIife(opts)})`;
}
