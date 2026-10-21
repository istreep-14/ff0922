# ROS Value design

## Decision

ROS Value answers one question: **who is most valuable from now through the
end of this season in this league?** It produces a within-position rank and a
league-wide value rank. It is not a weekly start/sit projection, a predicted
total-points model, or a trade-price average.

The main view should use three compact outputs:

| Output | Meaning |
| --- | --- |
| `positionRank` | ROS order within QB, RB, WR, or TE, such as RB12. |
| `overallRank` | Cross-position order after this league's lineup scarcity and roster depth are applied. |
| `auctionValue` | A fixed-scale ROS auction-equivalent dollar value for this league; not a source's trade-currency value. |

The player detail also shows evidence: source count, family agreement,
within-position range, and source freshness. Raw source opinions stay visible.

## What does and does not enter

Only ROS-native opinions enter the ordering. Each source contributes a
within-position order; raw values are never averaged.

| Family | Candidate inputs | Unit used |
| --- | --- | --- |
| ROS analyst / projection | FantasyPros ROS rank, Draft Sharks ROS rank, ESPN/FanDuel/FantasyGuys ROS ranks carried by Dynasty Daddy | Within-position rank or percentile |
| Redraft market | FantasyPros Trade Market, Draft Sharks 3D Value, and eligible distinct Dynasty Daddy redraft markets | Within-position rank or percentile |
| Dynasty market | Distinct dynasty boards, only for keeper/dynasty leagues | Within-position rank or percentile |

Do not use current-week projections, current-week ECR, floor/ceiling, Buzz,
Sleeper trending, weekly start/sit grades, actual points, or raw trade values.
Those answer a different question.

`FantasyPros` and `Draft Sharks` ROS points totals can set an explanatory
replacement curve later, but their accompanying ROS ranks are not a second
vote. A source product gets one vote in the player ordering.

### A market's methodology is part of its identity

Dynasty Daddy's label `market` does not mean every board measures the same
thing or supplies independent evidence. Its own market guide describes, among
others:

| Market | Underlying evidence | ROS Value treatment |
| --- | --- | --- |
| Dynasty Daddy | Real fantasy trades and drafts | Market-family candidate, subject to league kind. |
| ADP Daddy | Real draft ADP | Exclude by default: draft cost is a slower, pre-season-oriented signal, not a current ROS opinion. |
| KeepTradeCut | Crowd Keep/Trade/Cut choices | One crowd-market candidate; never a direct price conversion. |
| DynastyProcess | FantasyPros ECR rankings | Suppress when FP ROS rank is present: it is derivative FP evidence, not an independent market vote. |

The registry must classify every other market from its documented methodology
before it is eligible. An unfamiliar market defaults to display-only rather
than silently entering the composite. Source: [Dynasty Daddy market guide](https://dynasty-daddy.com/help/fantasy-markets).

## Identity and duplicate rules

The eventual source registry must give every input a stable `productId`,
`family`, `kind` (`redraft` or `dynasty`), source timestamp, and duplicate
relationship.

Examples:

- FP ROS rank and FP ROS points are one `fp-ros` product.
- DS ROS rank and DS ROS total are one `ds-ros` product.
- A Dynasty Daddy copy of an already-direct FP or DS market is suppressed in
  favour of the direct pull.
- A redraft and dynasty board from the same brand are distinct products, but
  only the appropriate kind enters a league.
- A derivative board records its upstream source and is suppressed whenever
  that upstream source is already represented. DynastyProcess and FantasyPros
  ECR are the concrete initial case.
- ADP-only boards are display-only until testing shows they add current ROS
  information beyond the live ROS and market families.

This prevents a source from gaining influence merely because it has several
fields or arrives through more than one feed.

## Derivation

1. For every usable product, derive its rank within the player's own position.
   If a source publishes only overall rank, sort that source's own players
   within position. If its board has depth `d`, retain both rank and a
   normalized position percentile `(rank - 0.5) / d`.

2. Treat absence from a sufficiently deep source as weak negative evidence:
   rank immediately below the board, at half of that product's normal weight.
   Absence from a shallow board is no evidence.

3. Combine each family with a weighted median/trimmed center of normalized
   percentiles. A family receives a fixed total weight independent of how many
   sources it contains.

4. Combine family orders. Initial redraft mix: 60% ROS analyst/projection,
   40% redraft market. A keeper/dynasty league may admit dynasty markets at a
   separately declared, capped family weight. Weights remain configuration,
   not hidden constants.

5. Re-rank the resulting order inside each position. This is the primary ROS
   output and must remain intelligible without a point forecast.

6. Produce cross-position `overallRank` and `auctionValue` from this league's
   starting slots, flex eligibility, team count, and actual roster depth.
   Replacement lies between the last starter and first unrostered player,
   matching the current League Value policy. This is a scarcity translation,
   not a source-value average.

The detail view may expose a points-over-replacement explanation only when a
projection curve is present. The principal ROS table labels the result
`ROS Auction Value`, never projected points or a source's trade dollars.

### ROS Auction Value: a fixed unit, not a max-normalized index

An index calculated as `player / best player × 100` is rejected. The number of
the best player and the gap to him change throughout a season; dividing by it
causes every other player's displayed value to move even when that player's
evidence did not change.

Instead, ROS Auction Value is an auction-equivalent bid scale. League setup
declares a budget, normally `$200 per team`, and the value engine stores a
fixed conversion curve at the beginning of its measurement period:

```text
ROS Auction Value = fixed dollars-per-scarcity-unit × scarcity utility
```

`scarcity utility` comes from the consensus positional order and this league's
replacement level. The conversion curve is calibrated once against the chosen
auction budget, starter count, bench policy, and scoring, then retained until
the user deliberately changes the configuration. Replacement-level players
are `$0`; a player can rise or fall because his own ROS rank, source evidence,
or league replacement context changes—not because the current #1 player moved.

The total of displayed player values is deliberately not forced to equal the
entire league auction budget on every sync. It is a **maximum bid guideline in
a hypothetical ROS auction**, not the salary ledger of a real draft. An
optional, separately labelled `Auction Allocation` view may distribute a fixed
remaining pool and must say that doing so rebalances every player.

## Injury and availability policy

Current-week availability does not independently discount ROS Value. A player
who is questionable or out for this game can remain a top ROS player. The ROS
sources and market are expected to price ordinary injury uncertainty already.

An explicit override is allowed only for a durable, well-defined event:

- season-ending injury or IR with no expected return;
- retirement;
- known suspension length; or
- confirmed multi-week absence with a return window.

An override records its evidence, date, horizon, and expiry. It is never a
hidden `chance to play` multiplier. Conflicting or stale news lowers
confidence, not the player score.

## Confidence, separate from value

Confidence is not another vote in the rank. It reports:

- usable product count;
- inter-source positional-rank range;
- projection-family versus market-family gap;
- whether any input is stale by its source clock; and
- whether a documented durable-absence override is active.

An example player summary:

```text
ROS Auction Value  $41 · #18 overall · QB4
Confidence medium · 6 products · QB3–QB7 source range
Context    superflex raises QB scarcity; replacement is QB19
```

## Team table and modes

The Power Rankings page uses the same per-player ROS Auction Value exactly once, then
answers different team questions by changing which players are counted. It
does not create another player blend for each mode.

### Default table: ROS team value

| Rank | Team | Starter $ | Roster $ | Depth $ | QB | RB | WR | TE | Need | Confidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | Northside | $456 | $612 | +$156 | $82 | $109 | $145 | $46 | TE | High |
| 2 | Fourth & Long | $441 | $584 | +$143 | $42 | $126 | $151 | $51 | QB | Medium |
| 3 | Waiver Wire | $409 | $641 | +$232 | $91 | $73 | $130 | $44 | RB | High |

`Starter $` is the sum of the best legal ROS lineup's auction values. `Roster
$` is the sum of every rostered player's auction value. `Depth $` is `Roster
$ - Starter $`: it identifies trade inventory, not points expected to enter
the lineup. QB/RB/WR/TE are each position group's starter contribution;
`Need` is the weakest starter group relative to the league, not simply the
position with the lowest raw total.

The default sort is `Starters`, because it is the clearest answer to “who is a
contender from here?” A small `Roster` and `Depth` number makes a shallow
contender visible; a large `Roster` with a lower `Starters` number exposes a
deep rebuild.

### Explicit modes

| Mode | Sorts by | Counts | Main use |
| --- | --- | --- | --- |
| Contender | `Starters` | One best legal lineup | Current ROS strength |
| Roster Value | `Roster` | Every player | Asset base plus depth |
| Depth | `Depth` | Roster less starters | Sellable surplus / injury insulation |
| Position | selected position contribution | Starters at that position | Find buyers and weak spots |
| Trade Fit | marginal lineup gain | Before/after a candidate player or package | Rank plausible partners |

Modes only change the aggregation and table sort; the player-level ROS rank,
auction value, input sources, and confidence remain unchanged.

### Team drill-down

Opening a team shows three short sections rather than another wide table:

1. **Best ROS lineup** — each slot, player ROS position rank, auction value, and
   replacement player. This explains `Starters`.
2. **Depth and surplus** — bench ordered by auction value, with a `starts if` note
   showing which starter or flex slot the player would replace. This explains
   why a valuable player may contribute zero to current contender value.
3. **Needs and trade fit** — the weakest starter positions and candidate teams
   whose surplus raises this team's starter total. Show both teams' marginal
   gains before calling a trade plausible.

### Reading the example

Northside leads on starter value (`$456`), so it is the best current contender.
Waiver Wire has the largest roster total and depth (`$641`, `+$232`) but only
third-best starters: it has the most inventory, not the best weekly lineup.
Fourth & Long's QB value is low relative to its other starter groups, so it is
the natural buyer for a spare QB from Northside or Waiver Wire.

## Implementation sequence

1. Add a source registry and tests for product identity, duplicate suppression,
   kind eligibility, and source clocks.
2. Add a pure `src/rosvalue.js` module accepting source ranks and league
   settings, returning ranks, auction values, inputs, and confidence diagnostics.
3. Add regression tests:
   - FP rank and points count once;
   - a Dynasty Daddy duplicate cannot add a vote;
   - superflex changes QB overall value but not QB position rank;
   - source count cannot overpower family weight;
   - a current-week OUT flag alone does not change ROS order;
   - a documented durable absence is visible and expires.
4. Feed it from the existing one-row-per-player universe in `dashboard.js`.
   Do not re-read source files in the dashboard.
5. Present ROS Value as the default compact table metric; raw-source evidence
   and the older League Value calculation remain available in player detail
   until comparison is complete.
6. Snapshot inputs on each sync before tuning family weights from observed
   stability and trade/season outcomes.

## Open decisions, deliberately deferred

- Whether the 60/40 redraft mix should be fixed, per-league configurable, or
  fitted after enough snapshots exist.
- The exact fixed auction conversion curve; its assumptions must be shown.
- Which eligible Dynasty Daddy markets remain genuinely independent after their
  documented upstream methods and correlations are recorded.
- The threshold and evidence requirements for a durable-absence override.
