import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, FPDIR, VEGASDIR } from './config.js';
import { nameKey } from './sleeper.js';
import { loadIdMap } from './idmap.js';
import { readProjections, playerWeeks, SCORING_KEY } from './sleeperproj.js';
import {
  vegasIndex, vegasDistIndex, wwoIndex, firstdownIndex, fanduelIndex, draftsharksIndex, yahooIndex,
} from './enrich.js';

/**
 * Do the stored sources mean what their labels say?
 *
 * Three ways a source goes quietly wrong, each of which has happened here:
 *
 *   SCALE   the numbers are in the wrong units. VegasEdge's board once came back
 *           scored at someone else's settings, every player ~46% high, and still
 *           looked like a normal projection table. Caught by comparing each
 *           source's median value with FantasyPros' for the same players — a
 *           source is allowed to disagree about WHO, not to be uniformly high.
 *   WEEK    the file is filed under a week other than the one it holds.
 *   TIME    the file is older than anyone would guess from its label.
 *
 * Nothing here fixes anything; it reports, and exits non-zero from the CLI when
 * a check fails, so it can sit at the end of a sync.
 */

/** A source's median ratio to FantasyPros outside this band is not "a different opinion". */
export const SCALE_BAND = [0.8, 1.25];

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : null;
};

/**
 * Pure. `rows` are `{ pos, v, ref }`: a source's value and FantasyPros' for one
 * player. Per position (rows under 5 reference points are skipped — a
 * 1-point kicker says nothing about scale): n, median ratio, median difference,
 * and a flag when the ratio leaves the band.
 */
export function scaleCheck(rows, { band = SCALE_BAND, minN = 10, minRef = 5 } = {}) {
  const out = {};
  for (const pos of [...new Set(rows.map((r) => r.pos))]) {
    const use = rows.filter((r) => r.pos === pos && r.ref >= minRef && Number.isFinite(r.v));
    if (use.length < minN) continue;
    const ratio = median(use.map((r) => r.v / r.ref));
    out[pos] = {
      n: use.length,
      ratio: Number(ratio.toFixed(2)),
      diff: Number(median(use.map((r) => r.v - r.ref)).toFixed(1)),
      flag: ratio > band[1] ? 'high' : ratio < band[0] ? 'low' : null,
    };
  }
  return out;
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** FantasyPros' own week board for one format: nameKey -> {pos, pts, fpId}. */
function fpReference(season, week, scoring) {
  const dir = join(FPDIR, String(season), `week-${week}`, 'rankings', String(scoring).toLowerCase());
  const out = new Map();
  let declaredWeek = null, updatedAt = null;
  if (!existsSync(dir)) return { rows: out, declaredWeek, updatedAt };
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const d = readJson(join(dir, f));
    if (!d) continue;
    if (d.week != null) declaredWeek = Number(d.week);
    if (d.last_updated_ts) updatedAt = new Date(d.last_updated_ts * 1000).toISOString();
    for (const p of d.players || []) {
      if (p.r2p_pts === '' || p.r2p_pts == null) continue;
      out.set(nameKey(p.player_name, p.player_position_id), { pos: p.player_position_id, pts: Number(p.r2p_pts), fpId: p.player_id });
    }
  }
  return { rows: out, declaredWeek, updatedAt };
}

/** Provenance for the sources that keep one store with a per-week entry (asked for BY week). */
function storeWeek(store, week) {
  const w = store?.weeks?.[week] ?? store?.weeks?.[String(week)];
  if (!w) return null;
  return { week: Number(week), by: 'request', fetchedAt: w.fetchedAt ?? null, sourceAt: w.sourceAt ?? null };
}

/** What a source's stored file says about its own week and time, without loading its rows. */
function provenance(season, week) {
  const vegasBoard = readJson(join(VEGASDIR, String(season), `week-${week}`, 'average', 'qb.json'))
    ?? readJson(join(VEGASDIR, String(season), `week-${week}`, 'average', 'rb.json'));
  const dist = readJson(join(VEGASDIR, String(season), `week-${week}`, 'distributions-ppr.json'));
  const wwo = readJson(join(DATA, 'wwo', String(season), `week-${week}.json`));
  const fd = readJson(join(DATA, 'firstdown', String(season), `week-${week}.json`));
  const fanduel = readJson(join(DATA, 'fanduel', String(season), `week-${week}-ppr.json`));
  return {
    vegas: vegasBoard && {
      week: vegasBoard.week, by: vegasBoard.weekDeclared ? 'source' : 'us (legacy file)',
      fetchedAt: vegasBoard.fetchedAt ?? null, sourceAt: vegasBoard.generatedAt ?? null,
      note: vegasBoard.siteScoringDrift?.drifted ? `site scoring drifted (x${vegasBoard.siteScoringDrift.medianRatio}); re-scored` : null,
    },
    vegasDist: dist && { week: dist.week, by: dist.weekDeclared ? 'source' : 'source (per response)', fetchedAt: dist.fetchedAt ?? null, sourceAt: dist.generatedAt ?? null },
    wwo: wwo && { week: wwo.week, by: wwo.weekDeclared ? 'source' : 'us (unverified)', fetchedAt: null, sourceAt: wwo.updatedAt ?? null },
    firstdown: fd && { week: fd.week, by: fd.weekDeclared ? 'source' : 'us (unverified)', fetchedAt: null, sourceAt: fd.generatedAt ?? null, note: fd.scoringVersion ?? null },
    // FanDuel's payload states no week and no time, and its endpoint takes no week: what it serves is
    // "now", filed under our week number. Nothing on disk can confirm which week it holds.
    fanduel: fanduel && { week: fanduel.week, by: 'us (unverifiable)', fetchedAt: fanduel.fetchedAt ?? null, sourceAt: null },
    // These three are asked for by week, so the week is part of the request, not an assumption.
    sleeper: storeWeek(readJson(join(DATA, 'sleeper', String(season), 'projections.json')), week),
    draftsharks: storeWeek(readJson(join(DATA, 'draftsharks', String(season), 'ppr.json')), week),
    yahoo: storeWeek(readJson(join(DATA, 'yahoo', String(season), 'projections.json')), week),
  };
}

/** Pure: turn a source's provenance + scale result into pass/warn/fail lines. */
export function judge({ name, prov, scale, wantWeek, now = Date.now(), maxAgeHours = 36 }) {
  const problems = [];
  const warnings = [];
  if (prov) {
    if (prov.week != null && Number(prov.week) !== Number(wantWeek)) problems.push(`file holds week ${prov.week}, audited as week ${wantWeek}`);
    if (prov.by?.startsWith('us')) warnings.push(`week label is ours, not declared by ${name}`);
    const t = prov.sourceAt ?? prov.fetchedAt;
    if (t && (now - Date.parse(t)) / 3.6e6 > maxAgeHours) warnings.push(`data is ${Math.round((now - Date.parse(t)) / 3.6e6)}h old`);
    if (prov.note) warnings.push(prov.note);
  }
  for (const [pos, r] of Object.entries(scale || {})) {
    if (r.flag) problems.push(`${pos} runs ${r.flag} vs FantasyPros: median x${r.ratio} (${r.diff >= 0 ? '+' : ''}${r.diff} pts, n=${r.n})`);
  }
  return { problems, warnings };
}

/**
 * Audit every stored source for one week. Async only because the FP -> Sleeper
 * id map is loaded through its usual loader.
 */
export async function auditSources({ season, week, scoring = 'PPR' } = {}) {
  const ref = fpReference(season, week, scoring);
  const prov = provenance(season, week);
  const byRef = (key, v, out) => { const f = ref.rows.get(key); if (f && v != null && Number.isFinite(Number(v))) out.push({ pos: f.pos, v: Number(v), ref: f.pts }); };
  const rows = { vegas: [], vegasDist: [], wwo: [], fanduel: [], draftsharks: [], firstdown: [], sleeper: [], yahoo: [] };

  // VegasEdge: from the stored board so QBs (which carry no name in the index) join too.
  for (const b of ['qb', 'rb', 'wr', 'te']) {
    const d = readJson(join(VEGASDIR, String(season), `week-${week}`, 'average', `${b}.json`));
    const idx = vegasIndex(season, week, 'Average', scoring);
    for (const p of d?.players || []) byRef(nameKey(p.name, p.position || b.toUpperCase()), idx.get(String(p.sleeperId))?.points, rows.vegas);
  }
  for (const [k, v] of vegasDistIndex(season, week, scoring).byName) byRef(k, v.proj, rows.vegasDist);
  for (const [k, v] of wwoIndex(season, week)) byRef(k, v.proj, rows.wwo);
  for (const [k, v] of fanduelIndex(season, week, scoring)) byRef(k, v.proj, rows.fanduel);
  for (const [k, v] of draftsharksIndex(season, scoring)) byRef(k, (v.weeks?.[week] ?? v.weeks?.[String(week)])?.proj, rows.draftsharks);
  for (const [k, v] of yahooIndex(season)) byRef(k, (v.weeks?.[week] ?? v.weeks?.[String(week)])?.pts, rows.yahoo);
  const fdRows = readJson(join(DATA, 'firstdown', String(season), `week-${week}.json`))?.players || [];
  const fdField = { PPR: 'ppr', HALF: 'half', STD: 'std' }[scoring] || 'ppr';
  for (const p of fdRows) byRef(nameKey(p.name, p.position), p[fdField], rows.firstdown);
  // Sleeper is keyed by its own id; FP's ids reach it through the id map.
  try {
    const store = readProjections(season);
    const idMap = await loadIdMap({ season });
    for (const [key, f] of ref.rows) {
      const sid = idMap?.fpToSleeper?.[f.fpId]?.sleeperId;
      const w = sid ? playerWeeks(store, sid) : null;
      const v = (w?.[week] ?? w?.[String(week)])?.[SCORING_KEY[scoring] || 'ppr'];
      if (v != null) rows.sleeper.push({ pos: f.pos, v: Number(v), ref: f.pts });
    }
  } catch { /* no Sleeper store or id map on disk; reported as no rows */ }

  const results = {};
  for (const [name, r] of Object.entries(rows)) {
    const scale = scaleCheck(r);
    results[name] = { n: r.length, scale, prov: prov[name] ?? null, ...judge({ name, prov: prov[name], scale, wantWeek: week }) };
  }
  // FantasyPros itself: only its own declared week can be checked, it is the reference.
  const fpProblems = [];
  if (ref.declaredWeek != null && ref.declaredWeek !== Number(week)) fpProblems.push(`file holds week ${ref.declaredWeek}, audited as week ${week}`);
  results.fp = { n: ref.rows.size, scale: {}, prov: { week: ref.declaredWeek, by: 'source', sourceAt: ref.updatedAt }, problems: fpProblems, warnings: [] };
  return { season, week, scoring, sources: results, ok: Object.values(results).every((r) => !r.problems.length) };
}

export function formatAudit(a, log = console.log) {
  log(`Source audit — season ${a.season}, week ${a.week}, ${a.scoring}; scale is each source's median value relative to FantasyPros for the same players\n`);
  for (const [name, r] of Object.entries(a.sources)) {
    const scale = Object.entries(r.scale).map(([pos, s]) => `${pos} x${s.ratio}`).join('  ');
    const week = r.prov?.week != null ? `wk ${r.prov.week} (${r.prov.by})` : 'no week file';
    const state = r.problems.length ? 'FAIL' : r.n ? (r.warnings.length ? 'warn' : 'ok') : 'no data';
    log(`  ${state.padEnd(7)} ${name.padEnd(11)} n=${String(r.n).padStart(3)}  ${week.padEnd(24)} ${scale}`);
    for (const p of r.problems) log(`            ✗ ${p}`);
    for (const w of r.warnings) log(`            · ${w}`);
  }
  log(`\n${a.ok ? 'No source failed a check.' : 'One or more sources failed — do not trust their numbers until resolved.'}`);
  log('Scale flags mean uniformly high/low against FantasyPros (0.8-1.25 allowed); a source may disagree about individuals, not about units.');
}
