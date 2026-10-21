import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FPDIR, config } from './config.js';
import * as fp from './fpapi.js';
import { ApiKeyRejectedError, MissingApiKeyError, scoringsInUse } from './fpapi.js';
import { resolve as resolveWeek } from './week.js';
import { scrapeSync } from './scrapefp.js';

/**
 * FantasyPros, fetched ONE way: the public pages for everything they carry,
 * then two API calls for the two things they do not.
 *
 * There used to be three ways in — a full API sync (~45 calls against a
 * 500/day quota whose throttle answers 403, same as a bad key), a pure scrape,
 * and a "hybrid" that was `fp:sync`'s default — and the pipeline's `fp` step
 * ran the pure scrape, so `npm run sync` and `fp:sync` left different files on
 * disk: points scored and external ids only refreshed when someone remembered
 * the other command. Now `sync` and `fp:sync` are the same call.
 *
 *   public pages -> week + ROS rankings, week projections, news, injuries
 *   API          -> players + external ids, points scored to date
 *
 * Without FP_API_KEY the second half is skipped and the previous copy of those
 * two files stays in use.
 */

function save(dir, name, data) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2));
}

/** The two API-only files. ~1 + (formats) requests. */
export async function apiSupplement({ season, week, scorings = null, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season: season ?? config.season, week: week ?? config.week });
  const formats = scorings || scoringsInUse();
  const root = join(FPDIR, String(yr));
  const report = { ok: [], failed: [] };

  const task = async (label, dir, name, fn) => {
    try {
      const data = await fn();
      save(dir, name, data);
      log(`  ok   ${label}${data?.players?.length ? ` (${data.players.length})` : ''}`);
      report.ok.push(label);
    } catch (err) {
      // A refused key refuses every call the same way; stop rather than grind.
      if (err instanceof ApiKeyRejectedError || err instanceof MissingApiKeyError) throw err;
      log(`  skip ${label} — ${err.message.split('\n')[0]}`);
      report.failed.push({ label, error: err.message });
    }
  };

  log('API supplement (data with no public-page equivalent)');
  await task('players + espn/yahoo/cbs ids', root, 'players', () =>
    fp.players({ ecr: 'included', external_ids: 'espn:yahoo:cbs:fleaflicker:fantrax:mfl' }),
  );
  for (const sc of formats) {
    await task(`player-points ${sc}`, join(root, 'points'), sc.toLowerCase(), () =>
      fp.playerPoints({ season: yr, start: 1, end: Math.max(wk, 1), scoring: sc }),
    );
  }
  log(`  ${report.ok.length} ok, ${report.failed.length} skipped, ${fp.requestsUsed()} API requests`);
  return report;
}

/** Everything FantasyPros, current week + rest of season. What `sync` and `fp:sync` both run. */
export async function fpSync({ season, week, scorings = null, log = console.log } = {}) {
  const rep = await scrapeSync({ season, week, scorings, log });
  if (!config.apiKey) {
    log('  (no FP_API_KEY — players/external ids and points scored keep their last copy)');
    return rep;
  }
  log('');
  try {
    await apiSupplement({ season, week, scorings, log });
  } catch (err) {
    if (!(err instanceof ApiKeyRejectedError || err instanceof MissingApiKeyError)) throw err;
    log(`  skip API supplement — ${err.message.split('\n')[0]}`);
  }
  return rep;
}
