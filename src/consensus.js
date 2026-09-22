/**
 * The one derivation of consensus numbers and ranks.
 *
 * This file is used twice, unchanged: Node imports it (the build computes each
 * source's calibration and health, and the tests exercise it), and the dashboard
 * has its text inlined at build time (see renderHtml in dashboard.js), so the
 * browser runs the exact functions the tests do. Keep it free of imports and of
 * anything that only exists in one of the two places.
 *
 * Why it is not a plain weighted average of what the sources printed:
 *
 *   Levels differ. Measured on this repo's own data, rest-of-season figures run
 *   0.79x-0.96x of FantasyPros' for the same players, and a week's figure
 *   0.88x-0.99x. A plain average lets a player's rank depend on HOW MANY
 *   sources happen to cover him: one covered only by FantasyPros keeps
 *   FantasyPros' higher level, one covered by eight is pulled toward the low
 *   sources. So each source is first scaled onto the anchor's level (its median
 *   ratio to the anchor over the players both publish), and only then averaged.
 *
 *   Some are stale. A source last captured five days ago still had a number for
 *   a player who has since been ruled out; averaged with a fresh 0.0 it reads as
 *   a middling projection. Stale sources are left out (see `exclude`).
 *
 *   Some still count a game that has been played. Every ROS figure here was
 *   measured to include the current week, including for teams whose game this
 *   week is already final. The default is to take that game back out, using the
 *   source's own projection for it, so "rest of season" means games still to come.
 */

/**
 * Consensus key -> the Sources table it reads, whether the source has a
 * rest-of-season number at all, and how that number is made (`rosKind`):
 *
 *   published  the site's own figure, used as printed - what it counts is the
 *              site's business, so it is tested on the data (playedGameDropped)
 *   summed     this app adds up the weeks the site published, from this week on
 *   derived    a static season total less the SAME source's projection for the
 *              weeks already played
 *
 * The last two are built here from the current week onward, so they include this
 * week's game by construction and there is nothing to test.
 */
export const CONS_SRC = [
  { k: 'fp', t: 'fp', ros: true, rosKind: 'published' },
  { k: 'vg', t: 'vegas', ros: false, rosKind: 'none' },
  { k: 'wwo', t: 'wwo', ros: true, rosKind: 'derived' },
  { k: 'fd', t: 'firstdown', ros: true, rosKind: 'derived' },
  { k: 'fdl', t: 'fanduel', ros: true, rosKind: 'published' },
  { k: 'sl', t: 'sleeper', ros: true, rosKind: 'summed' },
  { k: 'ds', t: 'draftsharks', ros: true, rosKind: 'summed' },
  { k: 'yh', t: 'yahoo', ros: true, rosKind: 'summed' },
];

/** The source every other is measured against: the one with the broadest board. */
export const ANCHOR = 'fp';
/** A ratio is only estimated on players whose anchor number clears this, or small numbers dominate it. */
export const RATIO_FLOOR = { wk: 5, ros: 50 };
/** A source whose numbers for this week are older than this is left out of the consensus (a setting; 0 turns it off). */
export const DEFAULT_STALE_HOURS = 48;
/** Fewest overlapping players a ratio is trusted on. */
export const MIN_OVERLAP = 10;
/** A source whose games-per-week reads this much lower for played teams has already dropped the played game. */
const DROPPED_GAMES = 0.8;

export const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Every source's number for every player, keyed by player id.
 *
 * `tables` is {tableName: [{i, wk, ros, rosRest, partial, wkAct}]} (the per-source
 * tables); a static full-season total is read as what is left of it (`rosRest`).
 * `played(id)` says whether that player's game this week is already final.
 *
 * Returns Map id -> {wk:{k:v}, ros:{k:v}, rosRaw:{k:v}, partial:{k:true}, act}.
 * `ros` is on the same basis for everyone - games still to come - and `rosRaw` is
 * what was published. `rolled` says which sources were adjusted and which had
 * already dropped the played game on their own.
 */
export function buildMatrix(tables, { played = () => false, rollForward = true } = {}) {
  const m = new Map();
  for (const src of CONS_SRC) {
    for (const r of tables?.[src.t] || []) {
      let e = m.get(r.i);
      if (!e) { e = { wk: {}, ros: {}, rosRaw: {}, partial: {}, act: null }; m.set(r.i, e); }
      if (r.wk != null) e.wk[src.k] = r.wk;
      const ros = r.rosRest != null ? r.rosRest : r.ros;
      if (src.ros && ros != null) { e.ros[src.k] = ros; e.rosRaw[src.k] = ros; }
      if (r.partial) e.partial[src.k] = true;
      if (src.k === ANCHOR && r.wkAct != null) e.act = r.wkAct;
    }
  }

  const dropped = playedGameDropped(m, played);
  if (rollForward) {
    for (const [id, e] of m) {
      if (!played(id)) continue;
      for (const k of Object.keys(e.ros)) {
        if (dropped[k]) continue;
        // Without the source's own number for that game there is nothing to take
        // back out, and leaving the raw figure in would mix two bases.
        if (e.wk[k] == null) delete e.ros[k];
        else e.ros[k] = round(e.ros[k] - e.wk[k]);
      }
    }
  }
  m.dropped = dropped;
  return m;
}

/**
 * Per source: has it already taken this week's played games out of its
 * rest-of-season figure? Read off the data instead of assumed.
 *
 * A ROS total divided by the same source's week projection is "games left" as
 * that source sees it. Sources differ in level, and players differ from each
 * other, so compare like with like: for each player, a source's games left minus
 * the median of the OTHER sources' games left for the same player. If a source
 * has moved on, that gap is about one game lower for teams whose game is final
 * than for teams whose game is not. null when there is too little to tell.
 * Only a `published` figure is tested; the others are built from this week on.
 */
export function playedGameDropped(matrix, played) {
  const games = (e, k) => {
    const wk = e.wk[k], ros = e.rosRaw[k];
    return wk != null && ros != null && wk >= 8 && ros > 0 ? ros / wk : null;
  };
  const out = {};
  for (const src of CONS_SRC) {
    if (!src.ros) continue;
    if (src.rosKind !== 'published') { out[src.k] = false; continue; }
    const a = [], b = [];
    for (const [id, e] of matrix) {
      const mine = games(e, src.k);
      if (mine == null) continue;
      const others = CONS_SRC.filter((o) => o.ros && o.k !== src.k).map((o) => games(e, o.k)).filter((g) => g != null);
      if (others.length < 2) continue;
      (played(id) ? a : b).push(mine - median(others));
    }
    out[src.k] = a.length >= 8 && b.length >= 8 ? median(b) - median(a) >= DROPPED_GAMES : null;
  }
  return out;
}

/**
 * Each source's level relative to the anchor, per mode and position: the median
 * ratio over players both publish and the anchor rates above the floor. A position
 * with too few overlapping players borrows the all-position ratio; with too few
 * overall the source is left as published (factor 1, marked uncalibrated).
 *
 * Returns {wk:{k:{all,QB,...}}, ros:{...}, n:{wk:{k:count}, ros:{...}}}.
 */
export function calibration(matrix, posOf) {
  const out = { wk: {}, ros: {}, n: { wk: {}, ros: {} } };
  for (const mode of ['wk', 'ros']) {
    for (const src of CONS_SRC) {
      if (mode === 'ros' && !src.ros) continue;
      const byPos = {}, all = [];
      if (src.k !== ANCHOR) {
        for (const [id, e] of matrix) {
          const v = e[mode][src.k], a = e[mode][ANCHOR];
          if (v == null || a == null || a < RATIO_FLOOR[mode] || e.partial[src.k]) continue;
          const r = v / a;
          all.push(r);
          const pos = posOf(id);
          if (pos) (byPos[pos] ||= []).push(r);
        }
      }
      const f = { all: all.length >= MIN_OVERLAP ? median(all) : 1 };
      for (const [pos, rs] of Object.entries(byPos)) f[pos] = rs.length >= MIN_OVERLAP ? median(rs) : f.all;
      out[mode][src.k] = f;
      out.n[mode][src.k] = all.length;
    }
  }
  return out;
}

/** The factor for one source, mode and position (1 when there is no calibration to apply). */
export function factorFor(calib, mode, k, pos) {
  const f = calib?.[mode]?.[k];
  if (!f) return 1;
  const v = f[pos] ?? f.all;
  return v > 0 ? v : 1;
}

/**
 * Weighted mean of one player's source numbers, each divided by its factor first.
 * `weights` is {k: number}; a source with no number, zero weight, an entry in
 * `exclude` or a partial line is skipped and the rest renormalised.
 * Returns {v, n, lo, hi, raw} or null; `raw` is the same mean with no scaling.
 */
export function weightedMean(vals, weights, { partial = null, exclude = null, factor = null } = {}) {
  let num = 0, den = 0, rawNum = 0, n = 0, lo = Infinity, hi = -Infinity;
  for (const s of CONS_SRC) {
    const v = vals[s.k], w = Number(weights[s.k]);
    if (v == null || !(w > 0) || (partial && partial[s.k]) || (exclude && exclude.has(s.k))) continue;
    const c = factor ? v / factor(s.k) : v;
    num += w * c; rawNum += w * v; den += w; n++;
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  return den > 0 ? { v: num / den, raw: rawNum / den, n, lo, hi } : null;
}

/**
 * Every player's consensus for one profile, ranked once: overall and within
 * position, for this week and for the rest of the season.
 *
 * A rank is a property of the table, computed here and read back by id - never
 * recomputed from a filtered or sorted list - so it is the same on every page.
 * Ties break on id so the order is stable between builds.
 *
 * `profile` is {wk:{k:w}, ros:{k:w}}; `opts.exclude` is {wk:Set, ros:Set};
 * `opts.calibrate` turns the scaling on (default) or off.
 */
export function consensusTable(matrix, posOf, profile, calib, { calibrate = true, exclude = {} } = {}) {
  const out = new Map();
  for (const mode of ['wk', 'ros']) {
    const rows = [];
    for (const [id, e] of matrix) {
      const pos = posOf(id);
      const r = weightedMean(e[mode], profile[mode], {
        partial: e.partial,
        exclude: exclude[mode] || null,
        factor: calibrate ? (k) => factorFor(calib, mode, k, pos) : null,
      });
      if (!r) continue;
      let o = out.get(id);
      if (!o) { o = {}; out.set(id, o); }
      o[mode] = { v: r.v, raw: r.raw, n: r.n, lo: r.lo, hi: r.hi, rk: null, pr: null, pos: pos || null };
      rows.push([id, r.v, pos || '?']);
    }
    rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const seen = {};
    rows.forEach(([id, , pos], i) => {
      const o = out.get(id)[mode];
      o.rk = i + 1;
      seen[pos] = (seen[pos] || 0) + 1;
      o.pr = seen[pos];
    });
  }
  return out;
}

const pearson = (xs, ys) => {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
};

/**
 * What each source looks like next to the anchor, for the Sources page's Health
 * tab: how many players it prices, its level, how closely it ranks players the
 * way the anchor does, and the games its rest-of-season figure implies.
 *
 * `impliedGames` (median ROS / week for players with a real week) is how a ROS
 * total is checked against the weeks it claims to cover: about 16 for weeks 2-18
 * with a bye, and a source far below that has regressed hard or is missing weeks.
 */
export function sourceStats(matrix, posOf, calib) {
  const top = { wk: [], ros: [] };
  for (const mode of ['wk', 'ros']) {
    top[mode] = [...matrix.entries()]
      .filter(([, e]) => e[mode][ANCHOR] != null)
      .sort((a, b) => b[1][mode][ANCHOR] - a[1][mode][ANCHOR])
      .slice(0, 150);
  }
  const out = {};
  for (const src of CONS_SRC) {
    const s = { n: { wk: 0, ros: 0 }, cover: { wk: null, ros: null }, scale: { wk: null, ros: null }, corr: { wk: null, ros: null }, impliedGames: null };
    for (const mode of ['wk', 'ros']) {
      if (mode === 'ros' && !src.ros) continue;
      const xs = [], ys = [];
      for (const [id, e] of matrix) {
        if (e[mode][src.k] != null) s.n[mode]++;
        if (src.k !== ANCHOR && e[mode][src.k] != null && e[mode][ANCHOR] != null && e[mode][ANCHOR] >= RATIO_FLOOR[mode]) {
          xs.push(e[mode][src.k]); ys.push(e[mode][ANCHOR]);
        }
      }
      s.cover[mode] = top[mode].length ? top[mode].filter(([, e]) => e[mode][src.k] != null).length / top[mode].length : null;
      s.scale[mode] = src.k === ANCHOR ? 1 : (calib?.n?.[mode]?.[src.k] >= MIN_OVERLAP ? calib[mode][src.k].all : null);
      s.corr[mode] = src.k === ANCHOR ? 1 : pearson(xs, ys);
    }
    if (src.ros) {
      const g = [];
      for (const [id, e] of matrix) {
        const wk = e.wk[src.k], ros = e.rosRaw[src.k];
        if (wk != null && ros != null && wk >= 8 && ros > 0 && ['QB', 'RB', 'WR', 'TE'].includes(posOf(id))) g.push(ros / wk);
      }
      s.impliedGames = g.length >= MIN_OVERLAP ? round(median(g), 1) : null;
    }
    out[src.k] = s;
  }
  return out;
}
