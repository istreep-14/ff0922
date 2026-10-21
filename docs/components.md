# Dashboard components: tables, lists and data cells

Status: **phases 1–4 done** — formatting module, `cell()` kinds, one player
identity, `grid()` on every large table, `smallTable()` on every small table,
and shared List / Compare / KeyValue components; phase 5 remains. The
migration order is at the end.

The dashboard (`src/dashboard.template.html`) grew one page at a time, and its
tables show it. This document fixes ONE vocabulary of components — which one a
piece of data gets, what it looks like, and how it is built — so a number,
a player or a team reads the same way on every page.

## 1. Where things stand (audit, 2026-10-20)

| What | Today | Problem |
|---|---|---|
| Table builders | `table()` (16 calls), `table2()` (12 calls), and 7 hand-built `el('table', …)` (Players, Standings, Waivers, Matchup, Analysis grid, …) | Three ways to build a table; sticky headers, bands, widths and density differ by which one a page happened to use |
| Density | `table.fixed` (3px cell padding, sticky header, max-height scroll) vs. plain `table` (4px, no sticky) | Chosen by "has fixed widths", not by how many rows the table has |
| Cell helpers | ~30 (`stackCell`, `numCell`, `ecrCell`, `tmMarketCell`, `consPtsCell`, `srcCell`, `trendCell`, `deltaCell`, `dashCell`…) | Several do the same job differently; a blank is sometimes `dashCell()`, sometimes the text `'—'` |
| Number formatting | `fmt`, `prFmt`, `pts2`, `num`, `signed`, `rate` | The same value shows `12.0`, `12` or `12.00` depending on the page |
| Player identity | `playerCell2`, `rosterCell`, `.prow` rows, plain text names | Avatar size, position chip and team line vary |
| Disagreement / change | `.delta up/dn`, `.tmgap`, `td.hu1–3/hd1–3`, coloured text | Four encodings of "better / worse" |
| Sorting | `makeSortable` re-reads cell TEXT (`sortCell`) | "RB3", "+12", "—" are parsed back out of strings; fragile |
| Lists (non-tabular) | `.posrank/.prk`, `.pm-card dl`, lineup rows, strip tiles | No shared row component; every page rolls its own |

## 2. What the references get right

The six reference screens (FantasyPros Trade Market Values, player profile +
game log, trade result, Trade Analyzer ×2, a props table) share a small
grammar worth copying:

1. **The amount of data decides the component, not the page.** 400-row prop
   board = dense grid with heat; 10–16 teams = roomy table with bars; a trade
   side = a list of player rows; a player's headline = a stat strip.
2. **One player identity everywhere:** headshot, name, then `POS - TEAM`
   (and bye / injury badge) underneath. Rank lives at the trailing edge
   (`WR12`), never mixed into the name.
3. **Numbers are right-aligned, tabular, and unit-consistent**; change is a
   signed number in green/red, with an arrow icon only past a threshold
   (Puka `943 ⬆`).
4. **Column groups are named bands** (`Fantasy | Receiving | Rushing`,
   `Projections & Ratings | Over Hit Rates`).
5. **Heat is a background, not text colour,** and its scale is stated:
   full-bleed cells in a dense grid (props), rounded pills in a small table
   (game log).
6. **The filter bar has a fixed order:** view segment → format/scope selects
   → position pills → value filter → search on the right → row count
   (`449 of 449`).
7. **Actions sit at the end of a row**: an outlined button for the primary
   (`View Details`). (The reference's `Find Trades` link is not wanted — §6.)
8. **Summaries are a number + a bar with a marker** (Power Rank 67.6, the
   trade's +0.9%), and needs are chips (`FLX RB K`).

## 3. The components

Pick by the data's shape. When two fit, take the one higher in this list.

| Component | Use when | Row height | Examples here |
|---|---|---|---|
| **DataGrid** | > ~25 rows, or > 8 columns, or the reader scans/sorts/filters | 36px (compact) | Players, League Players, Values, Trade Market, Sources |
| **Table** | ≤ ~25 rows, rows are teams/weeks, a bar or tier is the point | 48px (comfortable) | Standings, Power Rankings, Teams matrix, Analysis, Waiver Wire sheets (top 8–30 per position), game log |
| **List** | 1–3 facts per row, read top to bottom, often selectable | 44px; 64px as cards | Lineups, trade sides, watch list, recent players, transactions |
| **Compare** | two things side by side | — | Matchup, trade result |
| **KeyValue** | one object's attributes | 28px | player card blocks, league settings |
| **StatStrip** | 2–5 headline numbers | — | page summaries, player card hero |
| **Feed** | time-ordered text | — | Log, news |

### 3.1 DataGrid (large)

- Sticky header (and band row); the first column is sticky ALWAYS.
- Named **bands** over grouped columns: a centred spanner label over a short
  rule that stops shy of the next group. Every table shares one header —
  unfilled, muted eyebrow labels, one strong rule under the last header row.
- A grid narrower than its panel still spans it: the columns keep their
  widths (`sizeCols(…, fill)` pins a min-width) and an empty trailing cell
  takes the spare room, so header and row rules run to the panel edge.
- Compact density; zebra off; row hover on; `tr.mine` highlight kept.
- **Sort is declared, not parsed**: each column gives `sortValue(row)`;
  blanks always last; the sorted column header is highlighted.
- Rows render 100 at a time with "Show all N" (no virtualisation needed at
  our sizes, ≤ ~800 rows); the panel header shows `N of M` like the props board.
- A **density toggle** (compact / comfortable) per grid, remembered per grid;
  Trade Market defaults to comfortable (§6), the rest to compact.
- Optional **heat** columns (see 3.6) and a legend line under the grid.
- Filter bar above it, in the order from §2.6.

### 3.2 Table (small)

- Same column definitions as DataGrid, comfortable density, no sticky header,
  no pagination.
- Allowed here and not in DataGrid: strength **bars**, **tier chips**,
  larger team avatars (32px), two-line cells (value + rank underneath).
- Total rows (`totrow`) pinned to the bottom and excluded from sorting.
- **Lean** (`grid({lean:true})`, `table2(…, {cls:'lean'})`): one line per
  row, like a printed cheat sheet — every player table (My Team, All Rosters,
  Players, League Players, Sources, Waiver Wire, stored weeks, the Overview's
  side panels). The player reads `Name  RB – BAL`, or `Name (BAL)` with
  `nopos` where the table is already one position; a number's rank sits to
  its left (`RB12 178.8`), not under it; the kickoff moves to the opponent's
  hover. Group labels stay, centred and unfilled; no header fill, no column
  rules. Pure CSS over the same cells. Team tables (Standings, Power, Analysis)
  keep the comfortable two-line Table.

### 3.3 List

One row component, three variants:

- `plain` — avatar (with position badge overlay, as in the profile sidebar),
  name, `WR12 · HOU` subline, trailing value/rank.
- `select` — checkbox leading, IR/Q badges after the name, trailing rank
  (Trade Analyzer).
- `card` — bordered rounded row with 8px gap between rows (trade result).

Lists never sort by header (they have none); a list that needs sorting is a
Table.

### 3.4 Compare

Two columns with a centred verdict between them (`Win-Win`), each side a
header (team identity + big number + marker bar) over a List. Matchup and any
future trade analyzer use it.

### 3.5 KeyValue and StatStrip

`KeyValue` replaces the ad-hoc `mdCard` `<dl>`s: label left, value right,
value uses the same formatters as cells. `StatStrip` replaces `statTile`
rows: label (eyebrow style), number, one sub-line.

### 3.6 Cell kinds (the atoms every component shares)

A column declares a `kind`; the kind owns rendering, alignment, formatting,
blank handling and sort value. No page writes a cell by hand.

| kind | Shows | Align | Blank | Notes |
|---|---|---|---|---|
| `player` | PlayerIdentity (sm 28px / md 36px) | left | — | name opens the card |
| `team` | TeamIdentity (logo + name, "you" mark) | left | — | |
| `text` | string, ellipsis | left | `—` | |
| `num` | value with unit-aware format | right | `—` + reason tooltip | optional sub-line |
| `rank` | `#12` or `WR12` | right | `—` | sort ascending |
| `delta` | signed number, green/red; arrow icon past `threshold` | right | `—` | `+0` shown as `0` |
| `heat` | `num` + background from a scale | right | uncoloured | full-bleed in DataGrid, pill in Table |
| `spark` | line/area series | right | `—` | `data-v` = net change |
| `bars` | volume micro-bars | right | `—` | |
| `bar` | strength bar with tier colour | left | empty track | Table only |
| `chip` | tier / need / status chips | left | — | |
| `action` | link or outlined button | right | — | last column only |

**PlayerIdentity** (one renderer, three sizes): headshot → name → `POS chip ·
TEAM logo · TEAM` (+ `bye N`, injury badge). Replaces `playerCell2`,
`rosterCell` and `.prow`.

### 3.7 Formatting rules (one module, tested)

| Quantity | Format | Example |
|---|---|---|
| fantasy points | 1 decimal | `17.2` |
| trade value ≥ 1,000 | integer, thousands separator | `10,200` |
| trade value < 100 | 1 decimal | `97.4` |
| league points (League Value) | integer ≥ 100, else 1 decimal | `168`, `48.1` |
| overall rank | `#n` | `#12` |
| position rank | `POSn` | `WR12` |
| percent | integer + `%` | `99%` |
| change | sign always, same decimals as the value | `+22`, `-1.5` |
| missing | `—`, never `0`, with a tooltip saying why | |

### 3.8 Colour scales

- **Diverging** (better / worse than a reference): 3 steps each side of a
  neutral band — the existing `hu1–3 / hd1–3`, renamed `heat-up-1..3 /
  heat-dn-1..3`, used for League Value disagreement, value gap, rank change.
- **Sequential** (more is better, e.g. hit rate, snap %): 4 steps of one hue.
- **Categorical**: positions (existing `--p-*`), tiers (`prt0–5`).
- Heat steps come from `fxHeat(delta, thresholds)` in `src/format.js`; the
  class from `fxHeatClass`.
- Every scale works in both themes (built with `color-mix` on tokens, as
  today) and every heated column has a one-line legend.

## 4. How it is built

Same pattern as the rest of the page's logic: the pure part is a module in
`src/`, inlined with `/*__INLINE:…__*/` and unit-tested under Node.

- `src/format.js` (pure, inlined): the formatters in 3.7 and the heat-scale
  functions (`heatStep(delta, thresholds)`). Replaces `fmt/prFmt/pts2/num/
  signed/rate`.
- In the template, one component layer:
  - `grid({ cols, rows, bands, density, sticky, limit, empty, footer, legend })`
  - `table(...)` = `grid` with `density:'comfortable', sticky:false, limit:null`
  - `list({ items, variant, row, trailing, onSelect })`
  - `compare({ left, right, verdict })`, `keyValue(rows)`, `statStrip(tiles)`
- A column is data, shared by grid and table:

  ```js
  {key:'lv', label:'League Value', band:'This league', kind:'heat',
   get:p=>valWorth(p,LV,sf), sub:p=>posRank(p), heat:{ref:..., steps:[8,20,40]},
   title:'…', w:84}
  ```

- Sorting reads `sortValue` (defaults to `get`), so `makeSortable` and
  `sortCell`'s text parsing go away.

## 5. Migration, page by page

Each phase ships on its own, with `npm test`, the template `node --check`, and
a before/after screenshot of every page it touches.

1. **Atoms, no visual change.** ✅ `src/format.js` (+ `test/format.test.js`);
   `playerIdentity()`; `cell(kind, v, opts)` with `num` / `delta` / `blank` /
   `player`. `fmt`, `num`, `pts2`, `prFmt`, `signed`, `rate`, `stackCell`,
   `numCell`, `dashCell`, `deltaCell`, `playerCell2`, `rosterCell` are now
   thin aliases over them. Verified by dumping every page's rendered DOM
   (2 leagues × 17 pages + the Values teams view) before and after: identical.
2. **DataGrid.** ✅ `grid()` in the template: Values, Trade Market (roomy),
   Players, League Players, Sources. Sticky header + band row, sticky
   identity column(s) (star + player on the Players pages), Compact /
   Comfortable (Roomy on Trade Market) remembered per grid, "Showing N of M",
   100 rows then "Show all", sorting by each column's `sort(row)` (Values,
   Trade Market) or the page's own comparator (Players, Sources — controlled
   mode). A test fails if those tables go back to building their own
   `<table>`. Waiver Wire moved to phase 3: its sheets are 8–30 rows.
3. **Table.** ✅ Power Rankings, Teams matrix, Standings, Analysis, Waiver Wire
   sheets, and stored-week player scores use `smallTable()`.
4. **List / Compare.** ✅ Matchup score and lineup comparisons use `compare()`;
   transaction moves use responsive `list()` cards; player-card detail blocks
   use `keyValue()`. There is no trade-analyzer/trade-side view in the app yet.
5. **Remove the old layer.** `table2`, `stackCell`, the `*Cell` helpers,
   `makeSortable`'s text parsing. Add a test that fails if any page builds
   `el('table'` itself, so the drift cannot come back.

## 6. Decisions (2026-10-20)

- **Trade Market is roomy**: comfortable density, ~88px rows with the
  sparkline and volume bars, like the reference. Every other DataGrid
  defaults to compact.
- **No per-row `Find Trades`.** Rows keep only `View Details`.
- **The first column is sticky always**, on every screen size, in every
  DataGrid.
- **My Team's roster tables are Tables** (comfortable, 46px rows): ~16 rows
  of two-line cells. A starter on bye is flagged on the slot; the score
  column appears once someone on the roster has scored. On the Overview the
  roster hugs its table and Injury watch / Being added / Recent moves sit
  beside it, wrapping underneath when there is no room.
- **League Value is a My Team column** (Overview, Rest of season, Trade
  value): the same `lvFor` number as the Values page, with its position and
  league rank underneath and a starters total. FantasyPros points carry
  their own window's position rank underneath (week rank under the week,
  ROS rank under ROS).
