import { get, pool } from './http.js';
import { config, requireEmail } from './config.js';

const base = (sport = 'nfl') => `https://mpb${sport}.fantasypros.com/api`;

/**
 * Per-league endpoints, all keyed by the league's `key` param.
 * `verified` marks endpoints confirmed to return data on ESPN/Yahoo/Sleeper leagues.
 *
 * `query` adds fixed parameters, which is how one path serves two entries:
 * `getLeagueAnalysisJSON` answers for a `period`, and `ros` and `week` are
 * different questions (see leagueanalysis.js), so each is its own endpoint and
 * fails, retries and reports on its own.
 *
 * `errorIsFailure` marks endpoints that report a refusal as a 200 carrying
 * `{ error }` rather than an HTTP status. Left alone, that reads as a
 * successful fetch of a payload with nothing in it.
 */
export const ENDPOINTS = {
  rosters:      { path: 'getLeagueRostersJSON',      verified: true,  note: 'teams + rostered fpIds' },
  settings:     { path: 'getLeagueSettingsJSON',     verified: true,  note: 'scoring, roster slots, playoffs, draft, waivers' },
  transactions: { path: 'getLeagueTransactionsJSON', verified: true,  note: 'adds/drops w/ player names' },
  waiver:       { path: 'getLeagueWaiverJSON',       verified: true,  note: 'league metadata only (thin)' },
  lineup:       { path: 'getLeagueLineupJSON',       verified: false, note: 'returns [] in testing' },
  analysisRos:  { path: 'getLeagueAnalysisJSON',     verified: true,  query: { period: 'ros' },  errorIsFailure: true, note: 'every team\'s roster value over replacement, rest of season' },
  analysisWeek: { path: 'getLeagueAnalysisJSON',     verified: true,  query: { period: 'week' }, errorIsFailure: true, note: 'the same, for this week only' },
};

/** Enumerate every league on the account. The email alone is the credential. */
export async function getUserLeagues(email = requireEmail()) {
  const data = await get(`${base()}/getUserLeaguesJSON?email=${encodeURIComponent(email)}`);
  if (!data || data.error) throw new Error(`getUserLeagues failed: ${data?.error || 'empty response'}`);
  return data;
}

/** Fetch one endpoint for one league key. */
export async function fetchEndpoint(name, key, sport = 'nfl') {
  const ep = ENDPOINTS[name];
  if (!ep) throw new Error(`Unknown endpoint: ${name}`);
  const qs = new URLSearchParams({ key, ...(ep.query || {}) });
  return get(`${base(sport)}/${ep.path}?${qs.toString()}`);
}

/** Fetch every endpoint for one league. Individual failures are captured, not thrown. */
export async function fetchLeague(league, names = Object.keys(ENDPOINTS)) {
  const out = { key: league.key, nickname: league.nickname || league.name, host: league.host, sport: league.sport || 'nfl' };
  const results = await pool(names, async (name) => {
    try {
      const data = await fetchEndpoint(name, league.key, out.sport);
      if (ENDPOINTS[name].errorIsFailure && data && typeof data === 'object' && data.error) {
        return [name, { ok: false, error: String(data.error) }];
      }
      return [name, { ok: true, data }];
    } catch (err) {
      return [name, { ok: false, error: err.message }];
    }
  }, { concurrency: 2 });
  out.endpoints = Object.fromEntries(results);
  return out;
}

/** Resolve the league list from the account email plus any extra standalone keys. */
export async function resolveLeagues() {
  const leagues = [];
  if (config.email) {
    const user = await getUserLeagues();
    leagues.push(...(user.leagues || []));
  }
  for (const key of config.extraKeys) {
    if (leagues.some((l) => l.key === key)) continue;
    // A standalone key still identifies itself via its own rosters payload.
    try {
      const d = await fetchEndpoint('rosters', key);
      leagues.push({ key, host: d?.host, nickname: d?.nickname || d?.name, sport: d?.sport || 'nfl', standalone: true });
    } catch {
      leagues.push({ key, host: 'unknown', nickname: '(unreachable)', sport: 'nfl', standalone: true });
    }
  }
  return leagues;
}
