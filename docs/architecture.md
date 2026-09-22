# Architecture — file-by-file code map

This is the file map that `AGENTS.md` points at. It answers "what does this
module do, what data does it touch, and which CLI command runs it" so a first
pass through the code never has to read every file. `readme.md` is the
narrative — the *why* behind the shapes here. `AGENTS.md` is the 60-second
orientation.

Read order if you are new: this page → `src/sync.js` + `src/freshness.js` (how
a run happens) → `src/cli.js` (what a command is) → one per-source module →
`src/enrich.js` (how it all joins).

## The data pipeline

```
data/latest.json  ───────────────►  per-source syncs  ──►  data/<source>/...
        ▲                                  │
   (scrape step)                            ▼
                                      src/enrich.js  ──►  data/enriched.json
                                                                 │
                                                                 ▼
                       src/dashboard.js renders src/dashboard.template.html
                                                                 │
                                                                 ▼
                                                        dist/dashboard.html
```

- **Fetch half** — `scrape` (MyPlaybook leagues) plus one sync step per external
  source (`fp`, `vegas`, `wwo`, `firstdown`, `fanduel`, `yahoo`, `draftsharks`,
  `sleeper-proj`, `schedule`, `buzz`, `trend`, `leaguedetail`, `matchups`).
  Each writes its own `data/<source>/` tree and records the fetch in
  `data/freshness.json`.
- **Join half** — `enrich` reads *every* per-source tree plus the scraped
  rosters and writes one row-per-player universe to `data/enriched.json`.
- **Build half** — `dashboard` turns `enriched.json` into the in-browser app.
  The only transforms that still happen at build time are shaping for the page
  (`buildUniverse`, `buildSourceTables`, `slimAnalysis`) and the inlined
  consensus module.

The `sync` command orchestrates both halves via `src/sync.js`; the joins are
marked `always` so a `--only <source>` run still lands the fetch on the page.

## Layers

### Entry, config, shared plumbing

| File | Purpose | Reads / Writes | Called by |
|---|---|---|---|
| `src/cli.js` | CLI entrypoint (`#!/usr/bin/env node`), the 64-command `commands{}` dispatcher, argv wiring | reads `data/latest.json`, `data/enriched.json`, `.env` | — (the `ff` binary / npm scripts) |
| `src/args.js` | `--flag` / `--opt value` / positional parser; `BOOLEAN_FLAGS` disambiguates value-less flags | none | everything via `parseArgs` |
| `src/config.js` | path constants (`DATA`, `RAW`, `CACHE`, `FPDIR`, `VEGASDIR`, `STATE`), `.env` loader, the `config` object (credentials, pacing, season/week pins) | `.env` | every module |
| `src/http.js` | the one `fetch` wrapper: retries, exponential backoff, ETag/`NotModified` handling, shared pool, timeouts | network | every network sync |
| `src/jsonfile.js` | atomic JSON writes (temp file + rename) so a truncated write can never read as data | writes `data/…/*.json` | schedule, draftsharks, mpbadvanced, overrides, leaguestate, freshness |
| `src/teams.js` | NFL abbreviation normalization across namespaces (ESPN `JAX/WSH` vs Sleeper `JAC/WAS`), `normPos` `DEF/DST→DST`, matchup-string parser | none | `proj`, `enrich`, `dashboard` |

### Scrape → the normalized league model

| File | Purpose | Reads / Writes | Called by |
|---|---|---|---|
| `src/fantasypros.js` | MyPlaybook per-league API (`getLeagueRostersJSON`, settings, transactions, analysis…), account→leagues bootstrap | none | `leagues`, `scrape`, `endpoints`, sync |
| `src/scrape.js` | pulls every league into `data/raw/<ts>/` snapshots + normalized `_normalized.json`, writes `data/latest.json`; refuses an empty league list | writes `data/raw/`, `data/latest.json` | `scrape`, sync step |
| `src/normalize.js` | flattens raw endpoint payloads into the queryable `latest.json` model, derives `scoringSystem` | none | `scrape` |
| `src/leaguestate.js` | per-league on/off toggles persisting in `data/leagues-state.json` | `data/leagues-state.json` | `leagues:*` commands |
| `src/overrides.js` | user corrections (renames, badges, divisions, my teams, playoff rules, waivers, scoring) in `data/league-overrides.json` | `data/league-overrides.json` | `league*` commands, dashboard |
| `src/prune.js` | bounded history: keeps last 20 `raw/` runs, last 48 trend files | deletes old files | seen from `scrape`, `trend:sync` |
| `src/export.js` | CSV export with CSV-formula injection defusing (`esc`, leading `=` neutralized) | writes `data/export/*.csv` | `export`, sync step |
| `src/leaguedata.js` | per-league detail (standings, matchups, waivers) from MyPlaybook — **Sleeper host only**; cached to `data/leaguedetail/` | reads/writes `data/leaguedetail/` | sync step `leaguedetail`, `serve` |
| `src/leagueanalysis.js` | `getLeagueAnalysisJSON?period=ros|week`: VORP grid, team strength/tiers, your ranks; `normalizeAnalysis` | reads scraped model | dashboard build |
| `src/mpbadvanced.js` | MyPlaybook *advanced* endpoints (matchup, projected standings, start/sit, insights) with a disk cache `data/mpbadvanced/` | reads/writes `data/mpbadvanced/` | `matchups`, dashboard build |

### Per-source syncs (each writes its own `data/<source>/` tree)

| File | Source | Writes | Called by |
|---|---|---|---|
| `src/fpsync.js` | FantasyPros universal dataset — API key path plus `apiSupplement` (external ids, points scored) | `data/fp/<season>/` | `fp:sync`, sync step `fp` |
| `src/scrapefp.js` | FantasyPros **public pages** (no key): ranking boards' `ecrData`, injury-news pages | `data/fp/<season>/` | `fp:scrape`, `scrape:rankings`, `scrape:news`, sync step `fp` |
| `src/fpapi.js` | FantasyPros public API v2 wrapper (`api.fantasypros.com/public/v2/json`): rankings, projections, injuries, news, ping; serialized per-key queue | none (writes nothing) | `fp:*`, `fp:sync --source api` |
| `src/vegas.js` | VegasEdgeFantasy sportsbook boards (QB/RB/WR/TE × bookmaker) + `vegas:dist` boom/bust distributions from the site's 10k-sample sim; token lifecycle | `data/vegas/<season>/` | `vegas:sync`, `vegas:dist`, `vegas:rankings`, `vegas:check`, sync steps |
| `src/winwithodds.js` | WinWithOdds weekly + **static** season-total stat tables (no auth) | `data/wwo/<season>/` | `wwo:sync`, sync step `wwo` |
| `src/firstdown.js` | First Down Studio Next.js flight payload; rows keyed by **Sleeper id** (the one exact join) | `data/firstdown/<season>/` | `fd:sync`, sync step `firstdown` |
| `src/fanduel.js` | FanDuel Research / numberFire GraphQL projections (standard + PPR + ROS) | `data/fanduel/<season>/` | `fanduel:sync`, sync step `fanduel` |
| `src/yahooproj.js` | Yahoo weekly projections scraped from the logged-in players page (`YAHOO_COOKIE`), paced against HTTP-999 blocks; DevTools-console fallback + ingest | `data/yahoo/<season>/projections.json` | `yahoo:sync`, `yahoo:ages`, `yahoo:script`, `yahoo:ingest`, sync step `yahoo` |
| `src/draftsharks.js` | Draft Sharks weekly rankings: SSR top-25 + HTMX `load-table` for the rest | `data/draftsharks/<season>/` | `ds:sync`, `proj` (reads), sync step `draftsharks` |
| `src/sleeperproj.js` | Sleeper week-by-week projections for all 18 weeks; `slimWeek` keeps only rows with real projections; per-week ETag revalidation | `data/sleeper/<season>/projections.json` | `sleeper:proj`, `proj:ages`, `proj`, sync step, `serve` |
| `src/sleepertrend.js` | Sleeper trending (6h/24h/72h rolling lookbacks, the demand signal's *acceleration*) | `data/trend/<season>/` | `trend:sync`, `trend`, sync step `trend` |
| `src/buzz.js` | Yahoo BuzzIndex daily add/drop/trade boards, fanned out over position × sort × date (the demand signal's *volume*) | `data/buzz/<season>/` | `buzz:sync`, `buzz`, sync step `buzz`, `serve` |
| `src/schedule.js` | NFL opponents + byes from ESPN (`cdn.espn.com/core/nfl/schedule`), one request per week; `MIN_GAMES_TRUSTED` guards empty weeks | `data/schedule/<season>/` | `schedule:sync`, `schedule:import`, sync step, read by `proj` |
| `src/trademarket.js` | FantasyPros trade market values + 10-day volume series (`tradeMarketValues`) | `data/fp/<season>/trade/` | `trade:sync`, sync step `trade` |
| `src/matchups.js` | every league's live scoreboard via `mpbadvanced.getMatchup`; **accumulates** season points/standings on disk (ESPN/Yahoo expose no other source) | reads/writes `data/scores/<season>/week-N.json` | `matchups:sync`, `matchups`, sync step, `serve` |
| `src/players.js` | FP ECR dictionary: scrapes ten ranking boards into `data/cache/players.json` (fpId → player) | `data/cache/players.json` | `players` |

### Joins, consensus, derived data

| File | Purpose | Reads / Writes | Called by |
|---|---|---|---|
| `src/idmap.js` | the id bridge (FantasyPros `fpId` ↔ Sleeper ↔ ESPN/Yahoo) built from FP external ids + scraped model, cached 12h | `data/cache/idmap.json` | `enrich`, `lineup`, `compare` |
| `src/enrich.js` | **the big join** — every source onto the row-per-player universe, then `data/enriched.json`. Degrades cleanly: whatever slice of `data/` exists gets joined, the rest is null | reads every per-source tree + caches; writes `data/enriched.json` | `enrich`, `lineup`, `compare`, sync step |
| `src/consensus.js` | the one consensus derivation (calibration to the FP anchor, stale-source exclusion, played-game-removed ROS) — imported by Node **and inlined verbatim into the page** | none | `status`, dashboard build, the page |
| `src/weekshape.js` | splits a season/ROS total across remaining weeks using Sleeper's per-week shape (shares sum to 1); `splitRos` reconciles to its source total | none | `proj`, `enrich`, inlined into page |
| `src/weekhorizon.js` | the look-ahead window keys (`w-7`, `n-3`, `p`, `ros`, `szn`): `parseHorizon`, `weeksIn`, `labelHorizon` | none | `proj`, inlined into page |
| `src/accuracy.js` | scores each source's stored projections against actual points for finished weeks (MAE, bias, RMSE, correlation) | `data/fp/<season>/…` | dashboard Accuracy tab |
| `src/signals.js` | demand signal per player: Sleeper trending acceleration × Yahoo buzz, percentile heat | `data/trend/`, `data/buzz/` | `signal`, dashboard build |
| `src/sourceaudit.js` | verifies stored sources (scale band, week labels, age, site-side moves); `audit` exits 1 on failure | reads every source tree | `audit`, sync step |
| `src/sourcetables.js` | the Sources page's per-source wide tables (`buildSourceTables`), read off the *same* universe rows as the player tables | none (takes rows) | dashboard build |
| `src/sourceweek.js` | which week the data we fetched actually *is* (`resolveSourceWeek`: declared vs requested mismatch) | none | `sourceaudit` |

### Week resolution (shared by nearly everything)

| File | Purpose |
|---|---|
| `src/week.js` | NFL season/week resolution: kickoff heuristic, `FP_SEASON`/`FP_WEEK` pins, week 0 = preseason |
| `src/accuracy.js` | (listed above) |

### Dashboard & serving

| File | Purpose | Reads / Writes | Called by |
|---|---|---|---|
| `src/dashboard.js` | builds the compact page payload from `data/enriched.json` + league detail/advanced/accuracy, runs `buildUniverse` (one row per player), renders `src/dashboard.template.html` with the inlined consensus + payload → `dist/dashboard.html` | reads `data/enriched.json`, `data/leaguedetail/`, `data/mpbadvanced/`, caches, template; writes `dist/dashboard.html` | `dashboard`, sync step, `serve` |
| `src/dashboard.template.html` | the ~3,000-line inline `<script>` in-browser app + markup + CSS; a placeholder is replaced with the payload | — | `dashboard`, `serve` |
| `src/serve.js` | localhost-only HTTP server (`npm run serve`) serving `dist/dashboard.html` with a Sync panel that runs the same sync steps and a League Setup editor that saves back to `data/league-overrides.json` | `data/latest.json`, `dist/dashboard.html` | `serve` |

## The `sync` pipeline (what actually runs)

Seen in `src/sync.js` — `steps(mods)` returns the ordered step list; `runPipeline`
applies `--force/--only/--skip/--max-age/--dry-run/--watch N` and consults the
freshness ledger (`freshness.check`) before fetching. Notable rules codified there:

- Fetch steps in order: `scrape, fp, trade, sleeper-proj, draftsharks, schedule,
  vegas, vegas-dist, wwo, firstdown, fanduel, buzz, trend, leaguedetail,
  matchups`.
- `enrich`, `dashboard`, `audit` are `always: true` — exempt from `--only`,
  because a fetch you cannot see on the page has achieved nothing. `--skip`
  still stops them.
- A failed fetch is recorded and the pipeline **continues**: the other twelve
  sources are on disk, and a dashboard built from them is better than none.
- `data/freshness.json` is the ledger: `fetchedAt` (our clock) vs `sourceAt`
  (the site's own recompute time) vs `prevSourceAt` (to detect "moved").
  `MAX_AGE_MIN` in `src/freshness.js` is the per-source republish interval, not
  arbitrary numbers — change one only when the site's cadence actually changes.

## Tests

`test/*.test.js` are `node --test` regression tests, **mutation-checked**: each
pins a defect that actually shipped and fails if the bug is reintroduced.
Mapping (file → target module):

| Test | Targets |
|---|---|
| `args.test.js` | `args.js` (boolean flags don't eat the next arg) |
| `consensus.test.js` | `consensus.js` (matrix/calibration/table) |
| `dashboard-build.test.js` | `dashboard.js` render, `sourcetables.js`, template script compiles |
| `dates.test.js` | `buzz.js` date boundary, `signals.js` heat |
| `freshness.test.js` | `freshness.js` (since rounding, siteMoved) |
| `jsonfile.test.js` | `jsonfile.js` atomic write |
| `leagueanalysis.test.js` | `leagueanalysis.js`, `fantasypros.js` |
| `nav-and-analysis-payload.test.js` | `dashboard.js` slimAnalysis + template nav tables |
| `render.test.js` | `dashboard.js` renderHtml injection safety |
| `schedule.test.js` | `schedule.js` bye inference, repairStore |
| `source-trust.test.js` | `vegas.js`, `sourceweek.js`, `sourceaudit.js`, `winwithodds.js` |
| `team-overrides.test.js` | `overrides.js`, `sourcetables.js` |
| `trademarket.test.js` | `trademarket.js` |
| `values.test.js` | `export.js` esc, `config.js` parseEnv, `leaguedata.js`, `sleeperproj.js` |
| `week.test.js` | `week.js` |
| `weekly-outlook.test.js` | `draftsharks.js`, `schedule.js`, `weekhorizon.js`, `teams.js`, `weekshape.js` |
| `weekshape.test.js` | `weekshape.js` (shares sum to 1, split reconciles) |

`http.js`, `fpapi.js`, `idmap.js`, `vegas.js` (network), `serve.js`,
`sleeper.js` cache, and `sync.js` have no dedicated unit tests — they are the
network-touching or whole-run pieces, exercised via the CLI/sync path.