import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get } from './http.js';
import { FPDIR, config } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';
import { writeJsonAtomic } from './jsonfile.js';
import { scoringsInUse } from './fpapi.js';

/**
 * FantasyPros' trade market — `mpbnfl.fantasypros.com/api/tradeMarketValues`.
 *
 * What it is: a value for each player from what managers actually trade for on
 * FantasyPros' trade analyzer, on a scale where the most valued player is
 * ~1000. That is a different question from every other number in this app,
 * which are all projections or ranks of how a player will SCORE. This says how
 * he is PRICED, and the ten-day series says which way that price is moving.
 * `volumeSeries` is the number of trades that touched him each day, which is
 * the difference between a real price and a stale one.
 *
 * Shape, as observed (2026-09-19):
 *   - one row per player and per draft pick (`position: 'PICK'`, ids like
 *     202700001). Picks are skipped: they carry no value in a redraft league.
 *   - `marketValue` exists for QB/RB/WR/TE only. K and DST are null, and so are
 *     ~100 fringe players nobody trades for. A null is "not priced", never 0.
 *   - `expertValue`, `ecrRank*`, `valueGap` and `rankGap` (what the experts
 *     would pay against what the market does) were present for 3 of 463
 *     players, and still are (2026-10-20: every scoring, every `date`). The
 *     experts' chart itself is what Dynasty Daddy republishes as its
 *     FantasyPros market; dashboard.js `tmExpert` fills the gap from there.
 *   - `playerId` is the FantasyPros player id — the same `fpId` the rosters and
 *     league analysis use, so it joins without a crosswalk.
 *   - `timestamp` is when FantasyPros built the payload (seconds). It was
 *     identical across separate requests minutes apart, so it is a real
 *     "site said" time, not our clock.
 *
 * Which requests return anything: `type=redraft` with `scoring` PPR, HALF or
 * STD. `STANDARD` and `type=dynasty` answer 200 with 463–484 rows and no values
 * at all — so an empty payload is treated as a failure, never written over a
 * good file. `includeChartData=true` is what adds the two series; it is ~3.6×
 * the bytes (780 KB against 216 KB), which is why it is trimmed on the way in.
 */

const BASE = 'https://mpbnfl.fantasypros.com/api/tradeMarketValues';

/** The scoring formats that return values. FantasyPros' own name for standard is `STD`. */
export const TRADE_SCORINGS = ['PPR', 'HALF', 'STD'];

export const tradeUrl = ({ type = 'redraft', scoring = 'PPR', chart = true } = {}) => {
  const qs = new URLSearchParams({ type, scoring });
  if (chart) qs.set('includeChartData', 'true');
  return `${BASE}?${qs.toString()}`;
};

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * The whole response, thinned to what the page uses.
 *
 * Series are aligned onto one shared `dates` axis and stored as bare arrays
 * (null where a day is missing), so 359 players cost 359 short arrays rather
 * than 359 × 10 `{date, value}` objects.
 */
export function normalizeTradeMarket(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.players)) return null;

  const rows = raw.players.filter((p) => p && p.position !== 'PICK' && p.playerId != null);
  const priced = rows.filter((p) => num(p.marketValue) != null);

  const dates = [...new Set(priced.flatMap((p) => [
    ...(p.valueSeries || []).map((x) => x.date),
    ...(p.volumeSeries || []).map((x) => x.date),
  ]))].sort();

  const align = (series, key) => {
    if (!Array.isArray(series) || !series.length) return null;
    const by = new Map(series.map((x) => [x.date, num(x[key])]));
    return dates.map((d) => by.get(d) ?? null);
  };

  const players = priced.map((p) => ({
    fpId: Number(p.playerId),
    name: p.name ?? null,
    pos: p.position ?? null,
    team: p.team ?? null,
    value: num(p.marketValue),
    // Yesterday's value where FantasyPros gives one; null on a first day.
    prev: num(p.prevMarketValue),
    rank: num(p.marketRankOverall),
    posRank: num(p.marketRankPositional),
    series: align(p.valueSeries, 'value'),
    // Trades that touched him that day: how much to trust `value`.
    volume: align(p.volumeSeries, 'volume'),
    expert: num(p.expertValue) == null ? null : {
      value: num(p.expertValue),
      prev: num(p.prevExpertValue),
      rank: num(p.ecrRankOverall),
      posRank: num(p.ecrRankPositional),
      // Expert value minus market value: positive = experts like him more than the market does.
      gap: num(p.valueGap),
      rankGap: num(p.rankGap),
    },
  }));

  const ts = num(raw.timestamp);
  return {
    type: raw.type ?? null,
    scoring: raw.scoring ?? null,
    anchorDate: raw.anchorDate ?? null,
    windowDays: raw.windowDays ?? null,
    timestamp: ts,
    sourceAt: ts != null ? new Date(ts * 1000).toISOString() : null,
    dates,
    counts: {
      rows: raw.players.length,
      picksSkipped: raw.players.length - rows.length,
      unpriced: rows.length - priced.length,
      priced: priced.length,
    },
    players,
  };
}

export async function fetchTradeMarket({ scoring = 'PPR', type = 'redraft' } = {}) {
  return normalizeTradeMarket(await get(tradeUrl({ type, scoring })));
}

const dirFor = (yr) => join(FPDIR, String(yr), 'trade');
const fileFor = (yr, scoring) => join(dirFor(yr), `${String(scoring).toLowerCase()}.json`);

/** One stored format as `{ meta, byId }`, or null when it was never synced. */
export function loadTradeMarket(season, scoring) {
  const p = fileFor(season, scoring);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const { players, ...meta } = j;
    return { meta, byId: new Map((players || []).map((x) => [x.fpId, x])) };
  } catch {
    // Everything here is re-fetchable, so an unreadable file is a miss.
    return null;
  }
}

/**
 * Pull the market for every scoring format the account's leagues use.
 *
 * A format that comes back with no priced players is a FAILURE and leaves the
 * previous file alone; see the header for which requests do that.
 */
export async function tradeSync({ season, week, scorings = null, log = console.log } = {}) {
  const { season: yr } = resolveWeek({ season: season ?? config.season, week: week ?? config.week });
  const wanted = (scorings || scoringsInUse()).map((s) => (String(s).toUpperCase() === 'STANDARD' ? 'STD' : String(s).toUpperCase()));
  const formats = [...new Set(wanted.filter((s) => TRADE_SCORINGS.includes(s)))];
  if (!formats.length) formats.push('PPR');

  log(`FantasyPros trade market — season ${yr}, formats: ${formats.join(', ')}`);
  const ok = [], failed = [];
  let items = 0, sourceAt = null;

  for (const scoring of formats) {
    try {
      const data = await fetchTradeMarket({ scoring });
      if (!data || !data.counts.priced) {
        throw new Error('no priced players in the response — refusing to overwrite the stored file');
      }
      writeJsonAtomic(fileFor(yr, scoring), { season: yr, fetchedAt: new Date().toISOString(), ...data });
      const movers = data.players.filter((p) => p.series && p.series.some((v) => v != null)).length;
      log(`  ok   ${scoring.padEnd(4)} ${data.counts.priced} priced (${data.counts.unpriced} unpriced, ${data.counts.picksSkipped} picks skipped), ${movers} with a ${data.dates.length}-day series`);
      ok.push(scoring);
      items += data.counts.priced;
      if (data.sourceAt && (!sourceAt || data.sourceAt > sourceAt)) sourceAt = data.sourceAt;
    } catch (err) {
      log(`  FAIL ${scoring} — ${err.message.split('\n')[0]}`);
      failed.push({ label: scoring, error: err.message });
    }
  }

  record('trade', { ok, failed, sourceAt, items, season: yr, week: week ?? null });
  return { ok, failed };
}
