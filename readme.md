# ff091126 — FantasyPros scraper

Two data sources, joined:

1. **MyPlaybook** (`mpbnfl.fantasypros.com/api`) — your actual leagues across
   **ESPN, Yahoo, and Sleeper**, via the undocumented endpoints the mobile app uses.
2. **VegasEdgeFantasy** (`vegasedgefantasy.com`) — sportsbook-derived
   projections for the current week, per bookmaker. Compared side-by-side
   against FantasyPros.
3. **Sleeper** (`api.sleeper.app`) — the player universe that bridges the id
   spaces, plus headshots from `sleepercdn.com`.
4. **Yahoo BuzzIndex** (`football.fantasysports.yahoo.com/f1/buzzindex`) — how
   many managers across **every Yahoo league** tried to add, drop or trade each
   player on a given day. No login. The demand side of the market.
5. **Sleeper trending** (`api.sleeper.app/.../trending`) — the same thing as a
   rolling lookback rather than a calendar day, which is what lets it be
   differenced into an add *rate* and a change in rate.
6. **Sleeper projections** (`api.sleeper.com/projections/nfl/<season>/<week>`) —
   a projection for **every player in every week of the season**, in all three
   scoring formats, and the only source here that publishes its own recompute
   time on every row. One request per week is the whole season.
7. **Draft Sharks** (`draftsharks.com/weekly-rankings/<week>/ppr`) — a second
   independent weekly board. Each week is re-ranked on its own, so a teammate
   landing on IR shows up in weeks 2–4 the same day even if Sleeper's week-4
   number has not moved since last night. The public page SSR-renders the top
   25; the rest of the board is HTMX `GET /weekly-rankings/load-table`.
8. **NFL schedule** (`cdn.espn.com/core/nfl/schedule`) — opponent and bye for
   every team, every week. Byes are no longer inferred from a missing Sleeper
   row.
9. **FantasyPros universal data** — rankings, projections, points, news,
   injuries, both **current week** and **rest of season**. Two interchangeable
   backends:
   - the **public API v2** (`api.fantasypros.com/public/v2/json`), needs a key
   - **public-page scraping**, needs *no key* and is the default fallback

`enrich` joins all of it, so every rostered player carries this week's FP
projection and rank, its ROS projection and rank, the Vegas line and the delta
between them, the market's floor–ceiling distribution, injury status, a headshot
URL, and how hard the rest of fantasy football is currently bidding for him.

### What each source's number covers, and the look-ahead window

Eight sources project the coming Sunday, but they publish very different things
beyond it, and the difference decides what a column can honestly show:

| Source | Weeks ahead | Season-level number |
|---|---|---|
| FantasyPros | this week only | rest of season, revised weekly, includes this week |
| Sleeper | every remaining week | none — the app sums the weeks |
| Draft Sharks | every week synced (`ds:sync --full` for all) | none — the app sums the weeks |
| Yahoo | every week captured | none — the app sums the weeks |
| FanDuel | this week only | rest of season (`REMAINING`), revised weekly |
| WinWithOdds | this week only | **static** full-season projection |
| First Down Studio | this week only | **static** full-season projection |
| VegasEdge | this week only | none |

*Static* is measured, not assumed: neither WinWithOdds' nor First Down's season
figure moved for any of 100+ players between the Sept 14 and Sept 19 pulls even
though week 1 was played in between. It is the preseason projection, so
rest-of-season for those two is the season total less what **the same source
projected** for the weeks already played — never less the actual points, which
the total never absorbed. FanDuel's file already is rest-of-season and is used as
published (this app used to subtract points scored from it a second time). The
Sources page's **Guide** tab records all of this per source, with the evidence.

**Nothing spreads a season total across weeks.** A week's cell is what a site
published for that week or it is empty: Sleeper, Draft Sharks and Yahoo fill every
week; the rest fill this week only. A window of several weeks sums published weeks
and stays blank unless a source published all of them. (`proj <player>` still
prints the old spread table for reference; the dashboard no longer uses it.)
A missing Sleeper row is not a bye — the NFL schedule marks byes.

The **Window** dropdown is the same on Players and All Rosters: this week, next
2/3/4 weeks, playoffs (15–17), rest of season, full season, or any single week
1–18.

**My Team has no window.** It is one page with tabs, like a fantasy site's team
page, and each tab reads one fixed scope:

| Tab | Shows |
|---|---|
| **Overview** (default) | Stat strip, then your roster with **this week and rest of season side by side** (points, rank, position rank), opponent, trade value and points scored; below it market vs consensus, injury watch, who is being added, recent moves |
| **This week** | Every source for this week, plus ECR and expert range |
| **Rest of season** | Every source for the weeks still to play |
| **Week by week** | Each remaining week, this one through week 18, per source or as the consensus |
| **Trade value** | FantasyPros trade market: value, change, chart |
| **Buzz** | Adds, drops, starts and roster % across Sleeper and Yahoo |

The old Overview and Week by Week pages are these tabs; links to them (`#page=overview`,
`#page=weeks`) open the matching tab. The tab is carried in the link (`#tab=`).

### One player, one row

Every page reads the same row for a player. `buildUniverse` (`src/dashboard.js`)
builds one row per player — every FantasyPros-ranked player plus anyone rostered
who is on no board — through one function (`createEnricher` in `src/enrich.js`),
and a league roster is just ids plus that league's own live fields (points, slot,
game state). Before this, rostered players and free agents were built by two
different functions, which is how a player could carry a different projection,
rank, injury flag or roster % on My Team than on Players, and why free agents had
no injury status at all. The Sources tables are read off those same rows
(`buildSourceTables({ rows })`), so a number in a table is by construction the
number on the row.

### Consensus (weights you set)

The **Consensus** columns on Players, My Team, All Rosters and the Waiver Wire are
a weighted average of whichever sources have a number for a player, with a rank
across every player and a rank within position. There are three named profiles
(defaults: *All sources*, *Experts & feeds*, *Sportsbook*), each with a weight per
source for **this week** and for **rest of season**, edited on Sources →
Consensus and saved in your browser. A weight of 0 sits a source out; a source
with no number for a player is left out of that player's average and the rest are
renormalised, so a thin source never drags a player toward zero. A Vegas line
with unpriced props is shown but never averaged. Ranks exist for this week and
rest of season; other windows get a weighted value from the sources that
published those weeks, with no rank.

The derivation is `src/consensus.js` — one file, run by Node (the build, the
tests) and inlined verbatim into the page, so the browser runs the functions the
tests do. It is *not* a plain average, because a plain average misled in three
measured ways, and each fix is a switch on Sources → Consensus (all on by default):

| Problem, measured on this repo's data | What the consensus does |
|---|---|
| Levels differ: rest-of-season figures run 0.77–0.96× FantasyPros' for the same players, a week's 0.89–0.98×. A plain average makes a player's rank depend on **how many** low-running sources cover him. | Each source is divided by its median ratio to FantasyPros (per mode and position, over the players both publish) before it is averaged. Health shows every ratio. |
| A source can be days old. Yahoo's week-2 capture was from Sept 14; averaged with a fresh FanDuel 0.0 for a player since ruled out it read as a middling 5.1. | A source whose numbers for this week are older than N hours (default 48) is left out of every consensus, and marked with a red dot on its column. |
| Every ROS figure still counts this week's game for teams whose game is already final (implied games left is the same for BUF/DET players as for everyone else). | That game is taken back out, using each source's *own* projection for it, and the cell is marked †. Sources whose ROS is published as-is are tested on the data first; ones built here from the current week onward are known to include it. |

Ranks are computed **once**, over every player, and only looked up afterwards.
They are never recomputed from a filtered or sorted list, so a position rank is
the same on Players, My Team and the Waiver Wire under any sort or filter. The
one deliberate exception is the Waiver Wire's **Avail #**, which is a rank among
the available players and is labelled as one.

The **Accuracy** tab scores each source's projection for every completed week
against what players actually scored (MAE, bias, RMSE, correlation), on each
source's own players and on the players every source covers. It compares against
the last snapshot each sync stored for the week, not a kickoff-time archive —
worth knowing when reading it.

### Why the demand signal is separate from everything else

Every projection source here answers *how many points will he score*. None of
them answers *will he still be available in an hour*, and on a Thursday night
that is the only question a waiver claim turns on. Projection sites republish on
their own schedule — hours, sometimes a day. The buzz boards move the moment a
game ends.

The two demand sources are pulled together because they fail differently:

| | Yahoo BuzzIndex | Sleeper trending |
|---|---|---|
| time unit | one completed calendar day | rolling lookback (6h / 24h / 72h) |
| key | Yahoo player id | Sleeper player id |
| reports | adds, drops, trades, % rostered, % started | adds and drops only |
| best at | separating a real wave from two-way churn | telling you the wave is happening *now* |

Differencing Sleeper's 6h and 24h windows gives adds-per-hour now against
adds-per-hour before, and that ratio is the number worth acting on. Week 1, the
Sunday after the games:

```
Devin Singletary   99,999 adds/24h    16,428/hr now    206x prior rate    1% rostered
Michael Mayer     384,678 adds/24h     6,436/hr now   0.33x prior rate   26% rostered
```

Mayer has the bigger number and is the worse claim — that wave broke hours ago
and most leagues have already taken him. Singletary *is* the wave. Volume tells
you who has been claimed; acceleration tells you who is being claimed.

Zero dependencies. Node 20+.

## Tests

```sh
npm test          # node --test, no dependencies, ~0.1s
```

Node's built-in runner, so there is nothing to install — this project has no
dependencies and the tests do not add any.

They are **regression tests for defects that actually shipped**, not coverage
for its own sake. Everything under test is something that was once wrong in a
way that produced a plausible incorrect number rather than an error, which is
why each of them survived as long as it did:

| Covered | The defect it exists for |
|---|---|
| `renderHtml` | `$&`/`$'`/`$$` in the payload were read as substitution patterns, so a team named `Money$$` silently corrupted the JSON and blanked the page |
| `parseArgs` | nothing distinguished a boolean flag from an option, so the token after any `--x` was eaten and `players [--refresh] [query]` searched for nothing |
| `since()` | hours and remainder rounded independently, printing `8h 60m` |
| `sleeperPoints` | `{fpts: 1102, fpts_decimal: 6}` is 1102.06; string-concatenating made it 1102.6, in the column standings are ranked on |
| `esc` (CSV) | a team name starting `=` was a live formula in Excel, and a negative number must stay numeric anyway |
| `parseEnv` | trailing whitespace made a key read as *rejected*, and `FP_WEEK=3 # pinned` parsed as `NaN` and went into a file path |
| `slimWeek` | every player is on every week's board; an empty stat block is not a projection of zero |
| `writeJsonAtomic` | a truncated write read as "you have no overrides", and the next write made that permanent |
| `resolve` (week) | `--week fifteen` resolved to `NaN` and wrote `data/fp/2026/week-NaN/`, which then read back as an empty week forever |
| `fetchAdvanced` cache | four requests per league on every dashboard build, uncached, to endpoints capped by a subscription plan |
| `shapeFor` / `splitRos` | the per-week split: shares carry no level, byes take nothing, and the weeks reconcile with the total they came from |
| `consensus.js` | a rank that depended on how many low-running sources covered a player; a stale source averaged with a fresh zero; a played game counted in "rest of season" (and rolled a second time for a source that had already dropped it); a "cannot tell" read as "dropped"; ranks that were not a property of the table |
| `buildSourceTables` / `renderHtml` | a Sources table read from the files a second time and drifting from the player row; the inlined consensus module not compiling in the page |

The suite is mutation-checked: reintroducing each defect above makes at least
one test fail. A test that passes either way is not a test.

CI also extracts the dashboard's inline script and runs `node --check` on it.
That 3,000-line block never executes on the Node side, so a syntax error in it
is invisible to everything else here and fatal in a browser.

## Setup

```bash
cp .env.example .env     # add your account email + API key
npm run leagues          # verify it sees your leagues
npm run sync             # every source, skipping whatever is still fresh
```

### Which command to run

| Command | What it does |
|---|---|
| `npm run sync` | **the one to run.** Every source, but only the ones that have gone stale; then join + rebuild the dashboard. |
| `npm run sync -- --force` | ignore freshness, fetch everything |
| `npm run sync -- --only buzz,trend` | just these steps |
| `npm run sync -- --dry-run` | say what would run, fetch nothing |
| `npm run status` | per-source age, and the site's own last-recompute time |
| `npm run all` | unconditional: every sync, no freshness check |
| `npm run live` | the two minute-by-minute sources only |
| `npm run serve` | serve the dashboard live at `http://localhost:4173` with a **Sync** page — buttons run the same commands as this table, and League Setup saves edits directly instead of downloading a patch file |

`sync` exists because `all` was eleven unconditional network calls: re-running
it two minutes later re-pulled every source, including the ones that publish a
timestamp saying nothing had changed. Each source declares how often it actually
republishes (`MAX_AGE_MIN` in `src/freshness.js`) and is skipped under it. The
joins always run — a skipped fetch still leaves the previous fetch un-joined if
a different source moved.

### Two clocks, tracked separately

`data/freshness.json` records, per source, **when we fetched** and **when the
site itself last recomputed**. They are not the same thing and conflating them
hides the case that matters: a source fetched a minute ago that is still serving
yesterday's numbers.

| Source | Publishes its own update time? |
|---|---|
| FantasyPros | yes — `last_updated_ts` on every board |
| WinWithOdds | yes — a `rankings-updated-at` block on each page |
| First Down Studio | yes — `generated_at` on the snapshot |
| Yahoo BuzzIndex | yes — the board *is* a date |
| Sleeper projections | yes — `last_modified` on **every row**, and a per-week ETag on top |
| Draft Sharks | yes — `Last-Modified` on the load-table response |
| NFL schedule (ESPN) | **no.** Flexes are overnight news; 12-hour TTL. |
| Sleeper player dump | via ETag, so the refresh is a conditional GET: a 304 keeps the 15MB cache |
| FanDuel, MyPlaybook, Sleeper trending | **no.** None publishes a recompute time or a usable validator, so those are governed by our clock alone — reported as blank rather than echoing our own fetch time back. |
| VegasEdge | **yes**, from `/config` (`inseason_generated_at`), together with the week the boards hold. |

`status` prints both clocks side by side plus a **`moved`** column: whether the
site's own timestamp changed between our last two pulls. That is the reading
that tells you whether polling is achieving anything, and a row that is freshly
fetched and has not moved is flagged `site is behind` — the case that looks fine
and is not.

The Sleeper projection set has **eighteen** source clocks, not one, and they
genuinely differ. Measured mid-week-1: the live week had been recomputed four
minutes earlier while weeks 2–18 had not moved since the previous night's
batch. So `sleeper:proj` re-pulls the live week on a 20-minute TTL and the rest
of the season only when it is missing or the nightly batch has since run, and
`status --weeks` shows every week's own recompute time:

```
  WK  SITE RECOMPUTED           AGE      PLAYERS  OUR PULL
   1  2026-09-14T07:31:04.044Z      23m      456  5m
   2  2026-09-13T23:46:04.382Z    8h 8m      490  5m
  18  2026-09-13T23:46:02.531Z    8h 8m      511  5m
```

Every week is also an ETag-conditional GET, so re-asking for all eighteen costs
eighteen 304s and no payload — about two seconds. That is what makes polling the
live week affordable rather than a 36MB download.

`npm run live` is the short-interval pass: the sources that move inside an hour
(`trend`, `buzz`, `matchups`, `sleeper-proj`, `draftsharks`), and then the joins, which are
exempt from `--only` because re-fetching a source you cannot then see on the
page has achieved nothing.

`sync --watch N` repeats a pass every N minutes until interrupted. Every pass
still honours each source's own TTL, so the interval is **how often we check,
not how often we fetch** — `--watch 5` against the full pipeline wakes up, finds
eleven of thirteen sources under their limit, re-asks Sleeper with an ETag and
gets a 304, and is done in under a second. A pass that throws is logged and the
watch continues; the next one may well work.

The dashboard build is the step that made that possible. It runs at the end of
every pass, and it used to fire **four MyPlaybook requests per league every
single time**, uncached, while the league-detail fetch immediately beside it was
carefully cached. Four leagues meant sixteen requests per build against
endpoints that are capped by a subscription plan. They are now cached on the
same short TTL as matchups — a rebuild inside it went from **10.6s and sixteen
requests to 0.17s and none.**

The halves of the pipeline are independent:
`scrape` needs only `FP_EMAIL`; `fp:sync` uses the API key if it works and
otherwise falls back to scraping, so **no key is required for anything**.

## Commands

| Command | What it does |
|---|---|
| `node src/cli.js leagues` | list every league on the account + its key |
| `node src/cli.js scrape` | pull all endpoints → `data/raw/<ts>/` + `data/latest.json` |
| `node src/cli.js scrape --league Cville` | scrape one league |
| `node src/cli.js roster [name]` | print resolved rosters w/ ECR |
| `node src/cli.js transactions [name]` | print the move log — add and the drop that paid for it on one line |
| `node src/cli.js players [--refresh] [query]` | build/search the fpId → player dictionary |
| `node src/cli.js export` | write `leagues.csv`, `rosters.csv`, `transactions.csv` |
| `node src/cli.js endpoints` | show the discovered API surface |

### Choosing which leagues sync

Leagues are **active by default** — a newly discovered league is never silently
skipped. Deactivating is explicit and persists in `data/leagues-state.json`.

| Command | What it does |
|---|---|
| `leagues` | list all leagues with their on/off state |
| `leagues:off <name>` | drop a league from every sync |
| `leagues:on <name>` | put it back |
| `leagues:only <name>...` | keep only these active |
| `leagues:all` | reactivate everything |
| `scrape --limit N` | truncate to the first N active leagues |
| `scrape --all` | ignore the toggles for one run |

### VegasEdgeFantasy (needs `VEGAS_TOKEN`)

| Command | What it does |
|---|---|
| `vegas:check` | validate the session cookie, show its expiry |
| `vegas:sync [--bookmaker A,B]` | pull QB/RB/WR/TE boards → `data/vegas/` |
| `vegas:dist [--scoring PPR] [--limit N]` | per-player floor/ceiling/boom/bust distributions |
| `vegas:rankings [--position flex\|qb\|rb\|wr\|te]` | one board, printed |
| `compare [--position RB] [--by-diff]` | Vegas vs FantasyPros side by side |

VegasEdge's ranking board publishes a point estimate only. `vegas:dist` pulls
the site's own 10,000-sample alt-line simulation from `/player/{name}/boombust`
— p5 through p95, boom and bust probabilities — reweighted server-side to
whatever scoring you pass, so the number is directly comparable to a league's
own. Roughly half the board has a market too thin to simulate; those players
keep a projection and get no range, which is reported rather than guessed at.

### WinWithOdds (no auth)

| Command | What it does |
|---|---|
| `wwo:sync [--week N]` | weekly proj/floor/ceiling/actuals + season-long → `data/wwo/<season>/` |

Publishes a full-season total alongside the weekly numbers, not just the week —
one of the three sources `enrich` derives rest-of-season from by subtracting
points already scored (see [Two weekly boards](#two-weekly-boards-a-schedule-and-a-look-ahead-window)
above). Joined by name + position; there is no id on this one.

### First Down Studio (no auth)

| Command | What it does |
|---|---|
| `fd:sync [--week N]` | weekly + season projections → `data/firstdown/<season>/` |

The one exact join in this group — keyed by Sleeper id, not name, so it never
needs the name+position fallback the others do.

### FanDuel / numberFire (no auth)

| Command | What it does |
|---|---|
| `fanduel:sync [--week N]` | weekly standard + PPR + rest-of-season → `data/fanduel/<season>/` |

Publishes STANDARD and full PPR but no half-PPR set of its own; for a HALF
league `enrich` averages the two, which is exact (half-PPR is precisely the
midpoint of standard and full PPR), not an approximation. Joined by name +
position.

### Yahoo Fantasy weekly projections (needs `YAHOO_COOKIE`)

| Command | What it does |
|---|---|
| `yahoo:sync [--week N \| --full]` | server-side fetch → `data/yahoo/<season>/projections.json` |
| `yahoo:ages` | per-week player counts for the stored set |
| `yahoo:script [--week N \| --week-range 2-5 \| --full]` | prints (and copies, on macOS) a DevTools console snippet — see below |
| `yahoo:ingest [--file path]` | merges whatever `yahoo:script` captured (clipboard first, then a file) |

Scraped from the logged-in Players page at `football.fantasysports.yahoo.com`
— there is no public API for this; Yahoo's official Fantasy Sports API exposes
rosters and stats but not projections. `YAHOO_COOKIE` is the *entire* `Cookie:`
header from a logged-in browser request (DevTools → Network → any request to
that host → Request Headers → Cookie), not a single token — Yahoo's session is
spread across ~15 cookies. It rotates faster than VegasEdge's ~30-day JWT.

The number is scored under **the configured league's own settings**
(`YAHOO_LEAGUE_ID`, default `529792`), not a universal PPR/Half/Standard split
the way the other sources are — if it disagrees with the others, that is
usually why. Joined by name + position: measured 2026-09-14, Sleeper's own
`yahoo_id` crosswalk (what an id join would ride on) covers only ~21% of what
this scraper returns and misses players like Jahmyr Gibbs and Ja'Marr Chase
entirely, so the id join buys little over the name fallback every other
name-matched source here already uses.

**`yahoo:sync` can get you blocked.** Yahoo's edge layer returns HTTP 999
("Request denied") to a request pattern it doesn't like — measured, a ~55-request
sync at ordinary pacing got the session flagged within minutes, and it stayed
blocked on a single isolated request afterward while the same session loaded
fine in an actual browser at the same time. `YAHOO_CONCURRENCY` / `YAHOO_DELAY_MS`
(default 1 / 2000ms) exist to slow it down, but the real fix when it happens is
the fallback:

```bash
node src/cli.js yahoo:script --week-range 2-5   # paste into DevTools console
                                                 # on the logged-in players page
node src/cli.js yahoo:ingest                    # merges what it captured
```

The pasted script runs as same-origin JS in your actual browser tab — the
browser's own cookies and TLS/JS fingerprint, not a raw `fetch()` replay from
Node — and has not been blocked in practice. It paces itself (500ms–2s between
requests, longer between weeks) since an inhumanly fast in-page loop is its own
kind of tell. It copies the result to your clipboard automatically; if that
fails (some Chrome builds don't expose the DevTools `copy()` utility inside a
long-running async function), it prints one line to run yourself instead.

**A capture does not update the dashboard by itself** — like every source
here, `yahoo:ingest` only writes `data/yahoo/`. Run `enrich` and `dashboard`
(or just `sync`) afterward to see it reflected.

### League-wide live scores — on ESPN and Yahoo too

| Command | What it does |
|---|---|
| `matchups:sync` | every matchup in every league → `data/scores/<season>/week-N.json` |
| `matchups [league]` | this week's board, printed |

MyPlaybook's matchup endpoint takes a `teamId` **and answers for any team in the
league, not just yours**. That one fact is what makes a league-wide live
scoreboard possible on ESPN and Yahoo, neither of which exposes scores anywhere
else reachable from here. Ask once per team, skip the ones already seen in a
fetched pairing, and a 12-team league costs 6 requests.

It is also the only way to get points for and against on those hosts. The
projected-standings endpoint has records and playoff odds for every host but no
points, and the matchup endpoint has no `week` parameter — it only ever answers
for the current week. So season totals for ESPN and Yahoo cannot be fetched at
all; they are **accumulated**, one sync at a time, from the finished matchups on
disk. Every total carries how many games it actually counts.

The board keeps **every lineup slot for every team**, not a count of them — which
is what fixed the per-player points (below) and what lets the Matchup page open
any pairing in the league rather than only yours.

### Per-player points come from the league, not from a generic PPR file

`data/scores/<season>/week-N.json` carries MyPlaybook's `points` per player, and
MyPlaybook has applied **the league's own scoring table**. That matters more than
it sounds:

```
Sleeper league, week 1 — 12 players disagreed with the old number, all QBs:
  Drake Maye      9.82 vs 12.82   (3 INT)
  Tyler Shough   23.20 vs 25.20   (2 INT)
  Joe Burrow     14.16 vs 15.16   (1 INT)
```

Exactly 1.00 per interception. FantasyPros' generic file scores an interception
at -1; that league scores it at -2, and the PTS column was reading the generic
file. It now reads the league's, for every roster in the league — the board asks
per team, so it covers all of them, and it is the only per-player actual that
exists for ESPN and Yahoo at all.

One caveat, found by checking the parts against the whole: on one Yahoo league,
MyPlaybook's per-player points sum 1–3 above what Yahoo reports for the team, on
five teams of twelve. ESPN and Sleeper agree exactly. The team score is the
host's own live figure, so that is what the scoreboard, the standings and the
matchup totals use; where the rows disagree with it the matchup total says so
rather than quietly printing a third number the league has never seen.

The league's scoring table itself is scraped too (it was in the settings payload
all along) and shown in **League Setup → Scoring**, beside the host's own table
where the host publishes one. Sleeper does, and its version is the more complete
of the two: MyPlaybook's Sleeper read lists no defensive stats for a league that
scores them. Both columns are shown rather than merged, and you can override any
row — a disagreement between two sources should be visible, not averaged.

### Standings

**One table whatever the host is**, sortable by any column and linkable
(`#page=standings&view=division&sort=pf&mode=proj`):

- **`#` is the standard rank: record, then points for.** Every league, same rule.
  It used to be the playoff seed where a seeding rule existed, which conflated two
  questions — a division winner can be seeded first from fourth place, and the
  table then numbered them 1 while the record said otherwise. The seed still
  decides who is *in*, shows beside the number when it differs, and is on the
  tooltip.
- **Records change only when a game finishes.** A matchup in progress does not
  reorder the table while you are watching it. `If leaders hold` is the opt-in to
  the other reading: every unfinished game counted to whoever is ahead, or
  projected higher before kickoff — and PF/PA follow it, because a record and a
  points total that disagree about which games happened is worse than either
  alone.
- **PF/PA count every finished matchup**, with the game count carried so a row
  over one game never reads as a season. This used to require the whole week to
  be final, which meant one Monday-night game left the column blank for the
  entire league — the number exists, and refusing to show it is not accuracy.
- **Week N shows the score over the projected final** — MyPlaybook's own figure,
  which already counts banked points plus what is left, so a team with four
  players still to play reads correctly.
- **Playoff position is a row fill, not just a divider.** Sorting by points or
  grouping by division breaks rank order, and a line drawn at a fixed row index
  would then sit in the wrong place while still looking authoritative. The
  labelled cut line draws only when the current sort genuinely puts the
  qualifiers on top.
- **Seeds are computed in the page**, on the merged rows. They used to be
  computed off Sleeper's standings, which meant a rule configured for an ESPN or
  Yahoo league silently did nothing.
- **By division** splits into one table per division, ranks preserved.

### Matchup

Any pairing in the league, not just yours — arrows and a strip of every game
across the top, and the pairing is in the URL (`#page=matchup&mu=1-9`). Rows are
slot-by-slot with the position badge down the middle, each player's game and its
score under his name, his league-scored points, and the projection to read them
against: the pre-game number once his game is over (coloured by the gap), the
live projected final while it is running.

### Your corrections (`data/league-overrides.json`)

Everything else here is read-only: a scrape of what ESPN, Yahoo and Sleeper
report. This is the one place your corrections live, in a file a re-scrape never
touches.

| Command | What it does |
|---|---|
| `league [name]` | show a league's overrides + its team ids |
| `league:name <league> <name>` | rename a league |
| `league:team <league> <id> <name>` | rename a team |
| `league:abbr <league> <id> [ABBR]` | set a team's badge abbreviation (up to 6 chars); omit ABBR to clear |
| `league:mine <league> <id> [id...]` | which teams are yours — first is primary |
| `league:division <league> <id> <name>` | assign a team to a division |
| `league:playoffs <league> --rule R ...` | how seeds are actually decided |
| `league:waivers <league> --claim-days N ...` | waiver mechanics no host exposes |
| `league:import <file.json>` | apply a patch exported from the dashboard |

Five things the upstream data genuinely cannot carry:

- **Which teams are yours.** MyPlaybook reports exactly one `teamId` per league.
  That is wrong for anyone co-managing or running two teams, so this is a list
  with one marked primary — and My Team grows a switcher when you have more than
  one.
- **Divisions.** ESPN leagues have them; the endpoints reachable here do not
  return them, and seeding cannot be computed without them.
- **Seeding rules.** Every league invents its own and no host exposes it:

  ```
  league:playoffs "Sigma Chi 23" --rule points-wildcard --teams 6 --wildcards 1
  #   seeds 1-5 by record; seed 6 is most points scored among everyone who missed

  league:playoffs "Cville 2026" --rule division-first --teams 6 --division-seeds 2
  #   seeds 1-2 locked for division winners; the rest by record
  ```

  Standings then draws the real bracket. Without a rule it draws none — a
  guessed bracket looks authoritative and isn't.
- **Waiver mechanics.** A claim period and a processing day turn "unrostered"
  into "on waivers until Wednesday 3am" versus "free agent, first come", which
  are different decisions.
- **Scoring.** The hosts *do* report a scoring table — but incompletely, and they
  disagree with each other. League Setup shows both readings side by side and
  keeps your corrections in a third column.

The dashboard's **League Setup** page edits all of it in the browser (saved to
localStorage). Under `npm run serve`, **Save to server** writes it straight to
`data/league-overrides.json` and rebuilds — no file to download. Opened as a
static file instead, **Export edits** writes the same JSON for `league:import`
so the changes still survive a rebuild.

A team's **badge** (up to 6 characters, `league:abbr` or the Badge column in
League Setup) is what the Players and Sources pages show beside the team crest
for "who rosters him" — a full team name does not fit a table cell. Left blank it
falls back to the initials of the team's name. It is stored per team next to the
nickname and division, and saving one never disturbs the others.

### Navigation, League Analysis and the new columns

The rail is two tiers, like FantasyPros' own chrome. The narrow navy one has
**one league-specific option, League**, and its second rail is divided into
sections, with the league switcher pinned above them:

| Section | Pages |
|---|---|
| Team | My Team |
| League | Matchup, Standings, Analysis, All Rosters |
| Activity | Waiver Wire, Transactions |
| Setup | League Setup |

Everything else is not about one league. **Players** holds the player pool, Trade
Market and Sources (they read the current league's scoring format and roster, so
the switcher stays), and **All Leagues** and **Sync** are single pages at the foot
of the rail, with no second rail. Which option is open is read off the current
page, so links and back/forward land correctly, and a tile returns you to the last
page you had open in it. The League tile carries a dot while League Setup has
unsaved edits for the current league. The pages are one table (`PAGES`) in
`src/dashboard.template.html`; tests fail if a page has no renderer, a group has
no pages, a league page has no section, or a league page is filed elsewhere.

**League → Analysis** is FantasyPros' valuation of every roster in the league
(see *League analysis* under The API surface): a strength table for all teams, your
rank by position and by lineup slot, where to trade, and a grid of every roster
slot by slot. Toggle rest-of-season / this week, and points-over-replacement /
trade value. It reads from `data/latest.json`, so it is as fresh as the last
`scrape`, and says when that was.

Two column groups were added to every player table:

- **FantasyPros experts** (in Consensus): FantasyPros' own rank, and the best–worst
  rank any expert gave him. The bar beside the range is a *percentile*: how
  contested his spread is against every other player on the same board. Weekly
  boards spread far wider than rest-of-season ones, so no fixed threshold is right
  for both. `rmin`/`rmax` were in every payload row from the start and never drawn.
- **Trade** (its own toggle): what managers actually pay for him on FantasyPros'
  trade analyzer (~1000 = the most valued player), the change over the window and a
  daily chart. Unpriced players (K, DST, fringe) show a dash, not a zero.

### Sources page

Tabs, left to right:

- **Compare** — every source as its own column, per player, for this week or rest
  of season, with the consensus, its ranks and the *Range* across sources. Filter
  to everyone, your players, or available players; sort by Range to find where the
  sources disagree most. Under each source's number is that source's *own* position
  rank. (This replaced the Market Edge page.)
- **Consensus** — the weights, and the three switches above.
- **Health** — per source: how old its numbers are (and whether that is the site's
  own clock), whether it is in the consensus or left out, how many players it
  prices, its level against FantasyPros, correlation, the games its ROS figure is
  worth, how the ROS is built, and whether it still counts a game already played.
  Also says how many of this week's games are final.
- **Guide**, **Accuracy** — what each source covers; how each did against results.
- One tab per source — FantasyPros, Sleeper, Draft Sharks, VegasEdge, WinWithOdds,
  First Down Studio, FanDuel, Yahoo — that source's *own* numbers, unmixed with any
  other's. A source's season column is labelled **ROS** only where the number is
  rest-of-season; WinWithOdds and First Down Studio say **Season Total**. A
  positional rank a source does not publish is computed within that source's own
  rows.

Players and All Rosters share one **Columns** switch (Consensus, Sources, Info,
Buzz). My Team does not need it: its tabs are those column groups.

### Waiver Wire

Your players against the best available at each position, with **this week and
rest of season side by side** (points and position rank for both) and the upgrade
over your weakest player at that position. Also *Best upgrades* across positions
and *Most added right now* (Sleeper and Yahoo adds, drops, net, starts, roster %).
The Roster column everywhere says who has a player, or **FA**, or **Waivers** with
the time it clears when a claim period is set in League Setup — it used to be a
separate Status column that said "free agent" for rostered players.

Buzz coverage is what the two boards publish: Yahoo's BuzzIndex is a top-50 per
position and sort, so a player on neither board shows a dash, which is not a zero.

### Schedule and byes

`schedule:sync` reads ESPN's public schedule, one request per week. ESPN answers
some weeks with an empty body, and an empty week used to read as "every team is on
bye", which left all 32 teams on bye in week 18 and every real bye looking like a
normal week. A week now counts only with at least 13 games; a team with no game in
a fully stored week is on bye that week, recoverable from the file alone; and the
bye printed on each FantasyPros board is the fallback for any team ESPN has not
served yet.

### Demand signals (no credentials)

| Command | What it does |
|---|---|
| `trade:sync [--scoring PPR,HALF,STD]` | FantasyPros trade market values + ten-day series → `data/fp/<season>/trade/<scoring>.json` |
| `buzz:sync [--days N] [--date YYYY-MM-DD]` | Yahoo BuzzIndex → `data/buzz/<season>/<date>.json` |
| `buzz [--date YYYY-MM-DD] [--limit N]` | one day's board, printed |
| `trend:sync` | Sleeper trending → `data/trend/<season>/` |
| `trend [--velocity] [--limit N]` | live adds, or adds acceleration |
| `signal <player name> [--position RB]` | both boards for one player |

### Week-by-week projections

| Command | What it does |
|---|---|
| `sleeper:proj` | live week always, rest of season when stale → `data/sleeper/<season>/projections.json` |
| `sleeper:proj --full` | force all 18 weeks (~4s cold, ~2s when nothing has moved) |
| `sleeper:proj --week N` | one week only |
| `ds:sync` | Draft Sharks weekly rankings → `data/draftsharks/<season>/{ppr,half}.json` |
| `ds:sync --full` | all 18 weeks + ROS |
| `ds:sync --week N` | that week + ROS |
| `schedule:sync` | NFL opponents + byes from ESPN → `data/schedule/<season>/nfl.json` |
| `proj <player> [--scoring PPR] [--from N]` | the week-by-week table, with every source's total spread across the preferred curve |
| `proj:ages` | when Sleeper last recomputed each week |
| `status --weeks` | Sleeper and Draft Sharks per-week clocks, appended to the freshness table |

Sleeper: 514 players × 18 weeks is 480KB stored, out of 36MB fetched — the
response is mostly player biography repeated on every row, and only players
with an actual projection are kept. Draft Sharks is ~250 rows per week via
HTMX `load-table` (the HTML page itself only SSR-renders 25). The NFL schedule
is 18 ESPN XHRs, 32 teams, opponents and byes.

The Yahoo board caps at 50 rows per request with no pagination, so `buzz:sync`
fans out over position tabs × sort orders (adds / drops / total) and merges by
Yahoo id — about 350 players a day rather than 50. `--days N` backfills, which
is what makes the day-over-day comparison possible on a first run.

`npm run live` is the fast path: both demand sources, then `enrich` and
`dashboard`. It takes a few seconds and is the one to re-run between games.
`npm run all` does everything.

### FantasyPros public API v2 (needs `FP_API_KEY`)

| Command | What it does |
|---|---|
| `fp:check` | validate the key, show resolved season/week |
| `fp:sync` | pull everything below into `data/fp/` |
| `fp:rankings --position RB --scoring PPR [--week N] [--ros]` | consensus rankings |
| `fp:projections --position RB [--week N] [--ros]` | projections, sorted by points |
| `fp:injuries [--week N]` | injury report |
| `fp:news [--category injury]` | player news |
| `enrich` | join FP data onto rosters → `data/enriched.json` |
| `lineup [league]` | your team with week + ROS projections, ranks, injuries |

`fp:sync --source hybrid|scrape|api`. **Default is `hybrid`**, which scrapes the
bulk and spends ~3 API calls on the two things scraping cannot provide. See
[Why hybrid](#why-hybrid) below.

### Public-page scraping (no API key)

| Command | What it does |
|---|---|
| `fp:scrape` | full dataset from public pages → same `data/fp/` layout |
| `scrape:rankings --position RB --scoring PPR [--ros]` | one board, printed |
| `scrape:news [--pages N] [--team SF]` | injury news listing |

## The API surface

Base: `https://mpb{sport}.fantasypros.com/api/` (`mpbnfl` for football).

### Account-level — auth is the email, nothing else

```
GET /getUserLeaguesJSON?email=<account email>
```

Returns **every league on the account with its own per-league `key`**, across all
host sites. This is the entry point: one email bootstraps every key.

> The parameter must be `email=`. `user=`, `userId=`, `username=` all return
> `{"errorCode":1,"error":"user not found"}`.

### Per-league — auth is the league `key`

| Endpoint | Status | Payload |
|---|---|---|
| `getLeagueRostersJSON` | works | teams, team names/logos, rostered `fpId`s, scoring, roster slots, draft state |
| `getLeagueSettingsJSON` | works | scoring rules, roster positions, playoff config, waiver type/FAAB, draft order, picks by team |
| `getLeagueTransactionsJSON` | works | add/drop history **with player names, teams, positions** |
| `getLeagueWaiverJSON` | works, thin | league metadata only — no waiver claims observed |
| `getLeagueLineupJSON` | returns `[]` | empty with and without `week`/`teamId` params |
| `getLeagueAnalysisJSON?period=ros\|week` | works | **every** team's roster valued for *this* league: per-player VORP, trade value and ranks, team strength, plus your team's rank at each position — see below |

Verified 200 on all 10 leagues across ESPN, Yahoo, and Sleeper.

Endpoint names not in this list mostly 404 (`getLeagueStandingsJSON`, `getLeagueMatchupJSON`,
`getLeagueScheduleJSON`, `getLeaguePlayersJSON`, … all tested). Note the `rosters`
payload advertises an `apis` capability map — `{schedule, transactions, standings,
matchup, submitLineup, autoPilotSubmit, autoPilotEmail}` — but only `transactions`
has a reachable `getLeague*JSON` endpoint; the rest are app-internal.

### League analysis (`getLeagueAnalysisJSON`)

FantasyPros values every roster in the league against a replacement level, using
that league's own scoring and roster slots. It is the one league-specific
valuation available for **other managers' players**, and it is synced with the
other per-league endpoints (`scrape` → `league.analysis` in `data/latest.json`),
once per `period`:

| | `ros` | `week` |
|---|---|---|
| player `vorp` | rest-of-season points over replacement | this week's |
| team `score` | sum over the **whole roster** (bench depth counts) | sum over the **starters only** |

- **`players`** — every rostered player by `fpId`: `vorp`, `value`, positional and
  overall rank, and the slot FantasyPros' *optimal* lineup gives him (not the
  lineup the manager set). This is what puts a QB and a WR on one scale inside a
  league.
- **`teams`** — the league ranked by `score`, an `index` (worst team 50, best 100), `vorpPct` (score as a percentage of the league mean) and a tier.
- **`me`** — your team's rank at each position, starters vs bench, each lineup
  slot, and `tradeNeeds` (your weakest groups).

Served for every league on the account, ESPN, Yahoo and Sleeper alike — unlike
the matchup and projected-standings endpoints, it is not limited to the
FantasyPros-active league. Only `ros` and `week` are used; other `period` values
return an emptied-out bench evaluation and there is no way to ask for a specific
week.

Each period carries a `scoreMatchesGrid` check: the standings `score` is inferred
to be a sum of the grid's `vorp` (roster for `ros`, starters for `week`), and the
sync verifies it. Both held to within 0.6 on every team of all four leagues; the
wrong basis is off by 45–170. If it goes `false`, FantasyPros has changed what
one of those numbers means, and nothing that ranks teams by it should be trusted
until it is looked at. The payload's `eligibility` field (30 on Sleeper, 1–2
elsewhere) is kept but its meaning is not known.

An `{ "error": … }` body on a 200 (a league FantasyPros has switched off) counts
as a failed endpoint, so it appears in the league's `errors` and in the sync
report rather than as an analysis with nothing in it.

### Trade market (`tradeMarketValues`)

`GET mpbnfl.fantasypros.com/api/tradeMarketValues?type=redraft&scoring=PPR&includeChartData=true`
— no key, not per-league. Synced by `trade:sync` (and as the `trade` step of
`sync`) for the scoring formats your leagues use.

A value per player from what managers actually trade for, on a scale where the top
player is ~1000. Every other number here is a projection or a rank of how a player
will *score*; this is how he is *priced*, and `volumeSeries` (trades per day) says
whether the price is real. `playerId` is the FantasyPros id — the same `fpId` as
rosters and league analysis, so it joins without a crosswalk.

What was measured, and what the sync does about it:

| Observed (2026-09-19) | Handling |
|---|---|
| `redraft` × `PPR` / `HALF` / `STD` return values; `STANDARD` and `type=dynasty` answer 200 with 463–484 rows and **no values** | Only the first three are requested. A response with no priced players is a *failure* and never overwrites the stored file |
| 797 rows, of which 334 are 2027+ draft picks (`position: "PICK"`) | Skipped, and counted |
| `marketValue` is null for K, DST and ~100 fringe players | Kept out of the file: null means unpriced, never 0 |
| `expertValue`, `valueGap`, `rankGap` present for 3 of 463 players | Stored where present; nothing leans on them |
| `includeChartData=true` is ~3.6× the bytes (780 KB vs 216 KB) | Kept, and thinned: one shared date axis, bare arrays |
| `timestamp` was identical across requests minutes apart | Used as the site's own time in `status` |

### Player ids

Rosters return bare integers (`22968`). Those are FantasyPros player ids, the same
`fpId` that `getLeagueTransactionsJSON` pairs with a name, and the same `player_id`
embedded as `var ecrData` on public FantasyPros ranking pages. `src/players.js`
scrapes ten ranking boards and merges them into `data/cache/players.json`
(~1000 players, refreshed every 12h).

**Ranks are stored per board and never merged** — PPR, half-PPR, standard,
rest-of-season and positional ranks are different scales. `resolve()` picks the
overall board matching each league's scoring, so `ecrOverall` in a HALF league is
the half-PPR rank. `ecrPosition` is the within-position rank.

Unresolved ids are labelled `Unknown (fpId N)` rather than dropped. Currently 3 of
284 rostered players don't appear on any public board (deep bench / IR).

## Output

```
data/
├── raw/<timestamp>/       one JSON per league, exactly as returned
│   └── _normalized.json
├── latest.json            normalized model, most recent scrape
├── cache/players.json     fpId -> player dictionary
└── export/*.csv
```

Each league in the normalized model carries a `status`:

| status | meaning |
|---|---|
| `active` | rosters present |
| `predraft` | `hasDrafted: false` upstream — no rosters yet |
| `no-rosters-synced` | drafted but host hasn't synced rosters |
| `partial-sync` | `hasRosters: false`, some players present |

This distinguishes "nothing to scrape" from "the scrape failed."

## FantasyPros public API v2

Base `https://api.fantasypros.com/public/v2/json`, auth via an `x-api-key` header.
Request a key at <https://secure.fantasypros.com/api-keys/request/> — it is a
**separate credential** from the MyPlaybook league keys.

Spec: <https://api.fantasypros.com/public/v2/docs> (OpenAPI at
`/public/v2/docs/fantasypros_v2_public.yml`).

| Endpoint | Used for |
|---|---|
| `/{sport}/players` | universal player database; `external_ids` maps FP ids → espn, yahoo, cbs, fleaflicker, fantrax, mfl |
| `/{sport}/news` | news, filterable by `category` (injury, recap, transaction, rumor, breaking) |
| `/{sport}/injuries` | injury report by `year` + `week` |
| `/{sport}/{season}/consensus-rankings` | rankings by `position` + `scoring`; `week=N` for weekly, `type=ROS` for rest of season |
| `/{sport}/{season}/rankings/experts` | expert roster behind the consensus |
| `/nfl/{season}/projections` | projections by `position`; `week=N` weekly, `ros=true` rest of season |
| `/nfl/{season}/player-points` | fantasy points scored, `start`/`end` week range |
| `/{sport}/compare-players` | head-to-head comparison |

Useful details:

- Projections return `points`, `points_ppr` and `points_half` in one payload, so
  one call per position covers every scoring format.
- Rankings do **not** — `scoring` is a request parameter, so `fp:sync` pulls one
  board per (position × scoring). It only pulls the formats your leagues actually
  use, read from `data/latest.json`.
- `week=0` means preseason/draft on both rankings and projections.
- Season and week are auto-detected from the calendar (kickoff = Thursday after
  Labor Day, weeks roll over Tuesday). Override with `FP_SEASON` / `FP_WEEK` or
  `--season` / `--week`.

### Output layout

```
data/fp/<season>/
├── players.json           universal player db + external ids
├── news.json
├── experts.json
├── points/<scoring>.json  points scored, season to date
├── week-<N>/
│   ├── injuries.json
│   ├── rankings/<scoring>/<position>.json
│   └── projections/<position>.json
└── ros/
    ├── rankings/<scoring>/<position>.json
    └── projections/<position>.json
```

## VegasEdgeFantasy

Sportsbook-implied projections for the current week. Auth is the `access_token`
cookie from a logged-in session — a JWT, valid about a month. Copy it from
DevTools → Application → Cookies into `VEGAS_TOKEN`; `vegas:check` reports the
expiry before a sync wastes requests.

```
GET https://vegasedgefantasy.com/{board}/rankings?bookmaker={book}
    Cookie: access_token=<JWT>
```

- boards: `qb`, `rb`, `wr`, `te`, and `flex` (= rb+wr+te). **No K or DST.**
- bookmakers that return rows: `Average`, `DraftKings`, `FanDuel`, `BetMGM`,
  `Fanatics`. Others 200 with an empty body.

Each row gives the expected stat line (`RushingYds`, `ReceivingYds`,
`Receptions`, `ExpectedTds`; for QBs `PassYds`, `PassTds`, `INTs`, `RushTDs`),
`TD_Prob`, a `volatility_tag` (High Floor / Balanced / Volatile), injury status
and a `FantasyPoints` figure.

### Do not trust `FantasyPoints`

The site keeps **one scoring setting for the whole server process**, shared by
every visitor (its own `league-settings.js` says so), and the rankings endpoint
ignores scoring and week query parameters. So anyone saving a scoring change
re-scores the board for everybody. Measured 2026-09-19: one pull came back at
0.16/yd, 1.5/rec, 7/TD (Bijan Robinson 34.3, every source ~+46%), and a pull the
next morning off the same props was plain PPR (23.4).

So `points` in `data/vegas/` is **scored here from the stat line**, at the format
the caller asks for (exact for half/standard too), and the site's figure is kept
as `sitePoints` only to detect drift (`siteScoringDrift` in each file, and a
warning on sync). Files written before this change are re-scored on read; their
QB rows, which lack pass stats, are kept only when the same pull's skill rows
prove the site was at PPR that day, otherwise dropped.

### Which week, and when

The boards are bare arrays with no week or time. `GET /config` is the site's
statement of both: `inseason_week` / `inseason_season` (what the served boards
hold, distinct from `week`, the live NFL week) and `inseason_generated_at` (when
they were built). `vegas:sync` files the data under **the site's** week, warns if
that is not the week you asked for, and records the generation time as the
ledger's `sourceAt`. `vegas:dist` drops any response whose echoed `week` differs.

**Players are keyed by Sleeper id**, not a FantasyPros id — which is also what
the headshot CDN uses.

### Partially-priced players matter

A player without a full prop market still gets a `FantasyPoints` value derived
from touchdown probability alone. On the week-1 RB board, **68 of 108** players
were missing at least one prop. Those look like enormous disagreements with
FantasyPros when they are really just absent markets — Jonathon Brooks priced at
2.84 vs FP's 9.1, with all three yardage props missing.

So each row carries `complete`, and `compare` shows only fully-priced players by
default. `--include-partial` shows the rest, flagged. `vegasVsFp` is only
computed for complete lines.

## Cross-source player ids

Three id spaces have to line up:

| Space | Used by |
|---|---|
| FantasyPros `fpId` | MyPlaybook rosters, FP rankings/projections |
| Sleeper id | VegasEdge, `sleepercdn.com` headshots |
| ESPN / Yahoo id | host sites, via the FP players endpoint |

`src/idmap.js` matches strongest-first — ESPN id, then Yahoo id, then normalised
name + position (suffixes, punctuation and accents stripped). Measured against
the week-1 Vegas board: 74 by ESPN id, 329 by name, **6 unmatched** — and those
six are absent from FantasyPros entirely, not mis-joined.

Sleeper's own `espn_id` / `yahoo_id` are null for many recent players, which is
why name matching carries most of the load.

Headshots: `https://sleepercdn.com/content/nfl/players/thumb/{sleeperId}.jpg`
(and the same path without `/thumb` for full size). The ~15MB Sleeper dump is
cached for 24h.

## Why hybrid

The public API works, but two things make it a poor *primary* source:

1. **403 means two different things.** The gateway returns 403 for a bad key
   *and* for throttling. Observed behaviour is genuinely intermittent — the same
   request returned `403,403,200,200,403` in a row. The client serialises calls
   (2s apart) and retries 403 six times with backoff before giving up.
2. **Responses are truncated.** Every payload carries `public_api_limited: true`.
   Season points-scored came back with 55 players; the scraped ranking boards
   return 161 RBs and 273 WRs for the same week.

Scraping has no key, no quota, no throttling, and returns *more* per player. So
the split is:

| Source | Provides |
|---|---|
| **Public pages** | rankings, projections, start/sit, matchup, expert spread, news, injuries |
| **API** (~3 calls) | `players` + external ids (ESPN/Yahoo/CBS), `player-points` (actual points scored) |

A full hybrid run costs **4 API requests** against your 500/day, instead of ~45.

## Scraping without an API key

The API is convenient but gated. Everything it provides for rankings and
projections is already embedded in FantasyPros' public ranking pages as
`var ecrData = {...}`, ungated and complete.

```
https://www.fantasypros.com/nfl/rankings/{ros-}{scoring-}{position}.php
```

- scoring prefix: `ppr-`, `half-point-ppr-`, or none for standard. QB/K/DST
  have no scoring variants.
- `ros-` prefix switches the board from the current week to rest of season.

Each player on a board carries:

| Field | Meaning |
|---|---|
| `rank_ecr` | consensus rank |
| `rank_min` / `rank_max` / `rank_ave` / `rank_std` | expert spread |
| `r2p_pts` | **projected points** for that board's scoring format |
| `start_sit_grade` | A+ … F |
| `player_opponent` | this week's matchup |
| `pos_rank`, `player_owned_avg`, `player_bye_week` | |
| `note` | expert write-up, often several paragraphs |

Because `r2p_pts` is on the ranking board itself, one request per
(position × scoring × week|ros) covers rankings *and* projections — 24 requests
for a two-format account. `enrich` prefers a dedicated projections file when the
API supplied one and falls back to `r2p_pts` otherwise, so both sources join
identically.

Injuries and news come from `/nfl/injury-news.php` (server-rendered, paginated,
filterable by `position` / `team`). The FantasyPros player id appears only in the
headshot URL, which is what the join keys on; status (`OUT`, `QUESTIONABLE`,
`DOUBTFUL`, `IR`, `LIMITED`, `ACTIVE`) and body part are parsed from the headline,
since the listing has no structured status field.

**What scraping does not give you:** the API's `player-points` (actual fantasy
points scored per week), `compare-players`, and `external_ids` (FP id → ESPN /
Yahoo / CBS ids). Those have no public-page equivalent, which is exactly what the
hybrid mode spends its handful of API calls on.

### Note on the projections pages

`/nfl/projections/{pos}.php` is gated to 10 players when logged out, so it is not
used. The ranking boards' `r2p_pts` is the ungated route to the same numbers.

## Notes

- `.env`, `config.json` and everything under `data/` are gitignored — league keys
  are credentials.
- **`getUserLeaguesJSON` takes an email and no secret.** Anyone who knows an
  account's email can enumerate that account's leagues and keys, and each key then
  unlocks that league's roster/settings/transaction data. Treat your keys as
  sensitive, and be aware the email endpoint is the weak link.
- Requests run 3-wide with a 250ms delay (`FP_CONCURRENCY`, `FP_DELAY_MS`), with
  retry + exponential backoff on 429/5xx.
- The MyPlaybook endpoints are undocumented and can change without notice. The
  public v2 API is documented and versioned.
- API calls are serialised 2s apart (`FP_API_GAP_MS`) to respect the documented
  1 req/sec limit, and 403s are retried six times with exponential backoff before
  being reported, because 403 is also this API's throttling signal.
