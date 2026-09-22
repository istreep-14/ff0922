/**
 * NFL week. Regular season starts the Thursday after Labor Day. Weeks roll
 * on Tuesday. FP_SEASON / FP_WEEK pin either one when the calendar is wrong.
 */

const MS_DAY = 86_400_000;
export const LAST_WEEK = 18;

function laborDay(year) {
  const d = new Date(Date.UTC(year, 8, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export function kickoff(year) {
  const d = laborDay(year);
  d.setUTCDate(d.getUTCDate() + 3);
  return d;
}

export function currentSeason(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() <= 1 ? y - 1 : y;
}

/** Before kickoff returns 0. The public ranking pages are still "this week". */
export function currentWeek(now = new Date(), season = currentSeason(now)) {
  const start = kickoff(season);
  if (now < start) return 0;
  const week = Math.floor((now - start + 2 * MS_DAY) / (7 * MS_DAY)) + 1;
  return Math.min(Math.max(week, 0), LAST_WEEK);
}

const unset = (v) => v === undefined || v === null || v === '';

export function resolve({ season, week } = {}, now = new Date()) {
  let s;
  if (unset(season)) s = currentSeason(now);
  else {
    s = Number(season);
    if (!Number.isInteger(s) || s < 1990 || s > 2200) {
      throw new Error(`Invalid season "${season}" — expected a four-digit year.`);
    }
  }
  let w;
  if (unset(week)) w = currentWeek(now, s);
  else {
    w = Number(week);
    if (!Number.isInteger(w) || w < 0 || w > LAST_WEEK) {
      throw new Error(`Invalid week "${week}" — expected an integer 0–${LAST_WEEK}.`);
    }
  }
  return { season: s, week: w };
}
