/**
 * Which week the data we just fetched actually is.
 *
 * Several sources (VegasEdge, WinWithOdds, First Down, FanDuel) serve "the
 * current week" from a URL with no week in it, and this app files what it gets
 * under the week IT thinks it is. The two agree until they do not — a site
 * that rolls over Tuesday morning, a sync run late — and then last week's
 * numbers sit under this week's label with nothing on screen to say so.
 *
 * Where the source states its own week, that statement wins. This is the one
 * place the rule lives: file under the source's week, say so when it differs
 * from what was asked, and mark the file when the label is only ours.
 *
 *   declared  the source said which week it is holding
 *   mismatch  it said, and it is not the week that was requested
 *
 * `declared` may carry only a week (WinWithOdds' heading has no season); the
 * season then falls back to the requested one and only the week is compared.
 */
export function resolveSourceWeek(declared, requested) {
  const hasWeek = declared?.week != null;
  const hasSeason = declared?.season != null;
  const season = hasSeason ? Number(declared.season) : Number(requested.season);
  const week = hasWeek ? Number(declared.week) : Number(requested.week);
  return {
    season, week, declared: hasWeek,
    mismatch: hasWeek && (week !== Number(requested.week) || (hasSeason && season !== Number(requested.season))),
  };
}

/** The warning lines for a mismatch, shared so every source words it the same. */
export function mismatchNotice(name, src, requested) {
  return [
    `  WARNING requested season ${requested.season} week ${requested.week} but ${name} is serving week ${src.week}.`,
    `          Filing under week ${src.week}, where it belongs; week ${requested.week} gets no ${name} data until the site rolls over.`,
  ];
}
