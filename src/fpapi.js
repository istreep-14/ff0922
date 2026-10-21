/**
 * FantasyPros public API v2 — the documented, keyed backend for the universal
 * data scrapefp.js gets from public pages without a key.
 *
 * Calls are serialised (one queue per key) to respect the documented 1 req/sec
 * limit, and a 403 is retried six times with backoff because 403 is also this
 * API's throttling signal — a bad key and throttling are indistinguishable at
 * the gateway (see the "Why hybrid" section in readme.md).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { get } from './http.js';
import { config, DATA } from './config.js';

export const BASE = 'https://api.fantasypros.com/public/v2/json';

/** MyPlaybook reports league scoring with these labels; map them to API values. */
export const LEAGUE_SCORING_TO_API = { PPR: 'PPR', HALF: 'HALF', STD: 'STD', STANDARD: 'STD' };
/** A scoring format's stored-data key, e.g. Draft Sharks' per-week cells. */
export const SCORING_KEY = { PPR: 'ppr', HALF: 'half', STD: 'std' };

/**
 * Which scoring formats to pull — the ones the account's leagues actually use.
 *
 * Every projection/ranking source asks this, so a PPR-only account never
 * fetches a half-PPR board. Lives here, beside the label map it reads, so the
 * sources can import it without importing each other.
 */
export function scoringsInUse() {
  const latest = join(DATA, 'latest.json');
  if (!existsSync(latest)) return ['PPR'];
  const model = JSON.parse(readFileSync(latest, 'utf8'));
  const found = new Set();
  for (const l of model.leagues) {
    const api = LEAGUE_SCORING_TO_API[String(l.scoring || '').toUpperCase()];
    if (api) found.add(api);
  }
  return found.size ? [...found] : ['PPR'];
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('FP_API_KEY is not set. Request one at https://secure.fantasypros.com/api-keys/request/ and add it to .env');
    this.name = 'MissingApiKeyError';
  }
}

export class ApiKeyRejectedError extends Error {
  constructor(url) {
    super(
      'FantasyPros returned 403 Forbidden after retries.\n' +
        '  This API answers 403 both for a bad key AND for throttling, so it can mean either:\n' +
        '    - the key is wrong / not yet propagated across the API gateway edges, or\n' +
        '    - the rate limit (1 req/sec) or daily quota (500/day on premium) is exhausted.\n' +
        '  Check the key at https://secure.fantasypros.com/api-keys/, or retry later.\n' +
        `  URL: ${url}`,
    );
    this.name = 'ApiKeyRejectedError';
  }
}

/**
 * The plan allows 1 request/second and 500/day, and the gateway signals
 * throttling with 403 (not 429), so requests are serialised through a single
 * queue with a minimum gap rather than relying on the generic retry path.
 */
const MIN_GAP_MS = config.apiGapMs || 2000;
let chain = Promise.resolve();
let lastAt = 0;
let requestCount = 0;

export const requestsUsed = () => requestCount;

function schedule(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastAt + MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    requestCount++;
    return fn();
  });
  // Keep the chain alive even when a call rejects.
  chain = run.then(() => {}, () => {});
  return run;
}

function url(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const q = qs.toString();
  return `${BASE}${path}${q ? `?${q}` : ''}`;
}

async function call(path, params = {}) {
  if (!config.apiKey) throw new MissingApiKeyError();
  const u = url(path, params);
  // 403 is ambiguous here (bad key vs throttle), so retry a few times with
  // growing backoff before deciding the key is genuinely refused.
  const attempts = 6;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await schedule(() => get(u, { headers: { 'x-api-key': config.apiKey }, retries: 1 }));
    } catch (err) {
      lastErr = err;
      if (err.status !== 403) throw err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, Math.min(1500 * 2 ** i, 15000)));
    }
  }
  if (lastErr?.status === 403) throw new ApiKeyRejectedError(u);
  throw lastErr;
}

/* ---------------------------------------------------------------- Players */

/**
 * Universal player database. `external_ids` maps FP ids onto host-site ids.
 *
 * This and `playerPoints` are the only two endpoints the app calls: rankings,
 * projections, news and injuries all come from the public pages (scrapefp.js),
 * which carry more per player and cost nothing against the 500/day quota.
 */
export const players = ({ sport = 'nfl', player, update, ecr, external_ids, show } = {}) =>
  call(`/${sport}/players`, { player, update, ecr, external_ids, show });

/* --------------------------------------------------------- Points scored */

export const playerPoints = ({ season, start, end, position, scoring, min } = {}) =>
  call(`/nfl/${season}/player-points`, { start, end, position, scoring, min });

/** Cheap authenticated call used to validate a key. */
export const ping = () => players({ ecr: 'included' });
