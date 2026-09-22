/**
 * MyPlaybook leagues. The account email enumerates them; each league key
 * then loads rosters, settings, and the week / rest-of-season roster values.
 * Analysis answers `{ error }` with HTTP 200, which is a failed fetch.
 */
import { get, pool } from './http.js';
import { config } from './config.js';
import { normPos, normTeam, scoringFormat } from './names.js';

const base = (sport = 'nfl') => `https://mpb${sport}.fantasypros.com/api`;

const ENDPOINTS = {
  rosters: { path: 'getLeagueRostersJSON' },
  settings: { path: 'getLeagueSettingsJSON' },
  analysisRos: { path: 'getLeagueAnalysisJSON', query: { period: 'ros' }, errorIsFailure: true },
  analysisWeek: { path: 'getLeagueAnalysisJSON', query: { period: 'week' }, errorIsFailure: true },
};

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export async function getUserLeagues(email) {
  const data = await get(`${base()}/getUserLeaguesJSON?email=${encodeURIComponent(email)}`);
  if (!data || data.error) throw new Error(data?.error || 'getUserLeagues returned nothing');
  return data.leagues || [];
}

async function fetchEndpoint(name, key, sport = 'nfl') {
  const ep = ENDPOINTS[name];
  const qs = new URLSearchParams({ key, ...(ep.query || {}) });
  const data = await get(`${base(sport)}/${ep.path}?${qs.toString()}`);
  if (ep.errorIsFailure && data && typeof data === 'object' && data.error) {
    throw new Error(String(data.error));
  }
  return data;
}

function analysisPlayers(raw) {
  const byId = {};
  if (!raw || raw.error || !Array.isArray(raw.grid)) return { byId, standings: [], myLineup: [] };
  for (const row of raw.grid) {
    if (!row || row.position === 'Teams' || !Array.isArray(row.cells)) continue;
    for (const c of row.cells) {
      if (c?.fpId == null) continue;
      byId[String(c.fpId)] = {
        teamId: c.teamId != null ? String(c.teamId) : null,
        slot: row.position,
        starter: row.position !== 'BN',
        pos: normPos(c.pos),
        team: normTeam(c.team),
        vorp: num(c.vorp),
      };
    }
  }
  const standings = (raw.standings || []).map((s) => ({
    teamId: s.teamId != null ? String(s.teamId) : null,
    name: s.teamName ?? s.name ?? null,
    rank: s.rank ?? null,
    score: num(s.score),
    isMine: !!s.isUser,
  }));
  const myLineup = (raw.starters || []).map((x) => ({
    fpId: x.player?.fpId ?? x.player?.id ?? null,
    name: x.player?.fullName ?? null,
    slot: x.position ?? null,
  })).filter((x) => x.fpId != null);
  return { byId, standings, myLineup };
}

export function shapeLeague(discovered, endpoints) {
  const rosters = endpoints.rosters?.ok ? endpoints.rosters.data : null;
  const settings = endpoints.settings?.ok ? endpoints.settings.data : null;
  const week = analysisPlayers(endpoints.analysisWeek?.ok ? endpoints.analysisWeek.data : null);
  const ros = analysisPlayers(endpoints.analysisRos?.ok ? endpoints.analysisRos.data : null);
  const scoring = scoringFormat(rosters?.scoring || settings?.settings?.scoring) || rosters?.scoring || null;
  const myTeamId = rosters?.teamId != null ? String(rosters.teamId) : null;
  const names = new Map();
  for (const row of [...week.myLineup, ...ros.myLineup]) {
    if (row.name) names.set(String(row.fpId), row.name);
  }

  const teams = (rosters?.teams || []).map((t) => ({
    teamId: String(t.id),
    name: t.name,
    isMine: String(t.id) === myTeamId,
    players: (t.players || []).map((fpId) => {
      const id = String(fpId);
      const w = week.byId[id];
      const r = ros.byId[id];
      return {
        fpId: id,
        name: names.get(id) || null,
        position: w?.pos || r?.pos || null,
        team: w?.team || r?.team || null,
        slot: w?.slot || r?.slot || null,
        starter: w?.starter ?? r?.starter ?? null,
        vorpWeek: w?.vorp ?? null,
        vorpRos: r?.vorp ?? null,
      };
    }),
  }));

  return {
    nickname: discovered.nickname || discovered.name || rosters?.nickname || 'League',
    host: discovered.host || rosters?.host || null,
    scoring,
    url: rosters?.url || settings?.url || null,
    myTeamId,
    myTeamName: rosters?.teamName || null,
    teams,
    standings: { week: week.standings, ros: ros.standings },
    errors: Object.entries(endpoints).filter(([, e]) => e && !e.ok).map(([name, e]) => `${name}: ${e.error}`),
  };
}

export async function fetchLeagues({ email = config.email, extraKeys = config.extraKeys, log = () => {} } = {}) {
  const errors = [];
  const discovered = [];
  if (email) {
    try {
      const list = await getUserLeagues(email);
      discovered.push(...list.filter((l) => !l.sport || l.sport === 'nfl'));
    } catch (err) {
      errors.push(`leagues: ${err.message}`);
    }
  } else {
    errors.push('FP_EMAIL is not set, so no leagues were fetched.');
  }

  for (const key of extraKeys) {
    if (discovered.some((l) => l.key === key)) continue;
    try {
      const d = await fetchEndpoint('rosters', key);
      discovered.push({ key, host: d?.host, nickname: d?.nickname || d?.name, sport: 'nfl' });
    } catch (err) {
      errors.push(`extra key: ${err.message}`);
    }
  }

  const names = Object.keys(ENDPOINTS);
  const leagues = [];
  for (const league of discovered) {
    const results = await pool(names, async (name) => {
      try {
        return [name, { ok: true, data: await fetchEndpoint(name, league.key, league.sport || 'nfl') }];
      } catch (err) {
        return [name, { ok: false, error: err.message }];
      }
    }, { concurrency: 2 });
    const endpoints = Object.fromEntries(results);
    const shaped = shapeLeague(league, endpoints);
    log(`  ${(shaped.host || '?').padEnd(8)} ${shaped.nickname} — ${shaped.teams.length} teams`);
    leagues.push(shaped);
  }
  return { leagues, errors };
}
