# My Team overview — wireframe and visual direction

## Page job

**Audience:** a fantasy manager opening Gridiron Desk before waivers, a lineup
lock, or a trade conversation.

**Job:** answer “what should I do with my roster today?” before asking the
manager to scan player data. The existing table remains the source of truth;
the redesign changes the reading order, not the calculation or source model.

## Direction: Gameweek Brief

The page is a compact scouting report rather than a dashboard full of equally
weighted cards. One thin **Decision Tape** crosses the page beneath the title:
it names the one highest-leverage action, shows the evidence that supports it,
and links directly to the relevant player or waiver result. Everything under
it is evidence for that recommendation.

This is intentionally one bold device, while the rest uses the existing quiet,
data-dense visual language. It avoids a generic “KPI cards at the top” layout:
the strip has a real purpose (prioritisation), and cannot be mistaken for a
score summary.

### Tokens

| Token | Value | Use |
|---|---:|---|
| Midnight film | `#081D3F` | existing navigation rails and report labels |
| Field blue | `#0769DE` | selected state, links, primary action |
| Chalk | `#F3F5F9` | page ground |
| Paper | `#FFFFFF` | panels and tables |
| Signal green | `#127A52` | favourable start / add signal |
| Flag amber | `#96600B` | uncertainty or a decision to inspect |

Keep Poppins for controls and tabular data so this fits the shipped dashboard.
For the page title only, use a narrow, athletic display face such as **Barlow
Condensed** (with `Arial Narrow` fallback). Its compressed letterforms echo a
game-program masthead without compromising the dense data table. If a new web
font is undesirable, keep Poppins and use the condensed fallback treatment
only in a later visual pass.

## Desktop wireframe

```text
┌──────┬──────────────────┬────────────────────────────────────────────────────────────────────┐
│ GD   │ Cville 2026      │ Search players, pages, commands…                    WK 7   Theme   │
│      │ ▾ Sleeper · PPR  ├────────────────────────────────────────────────────────────────────┤
│ Team │                  │ MY TEAM · SLEEPER · 12 TEAMS · PPR                               │
│  ◉   │ My Team          │ THE IRON LEAGUE                                                    │
│      │ Matchup          │ Overview  This week  Rest of season  Trade value  Buzz             │
│ Lg   │ Standings        ├────────────────────────────────────────────────────────────────────┤
│      │ Power Rankings   │ DECISION TAPE                                     [View player →]  │
│ Plyr │ All Rosters      │ START J. SMITH-NJIGBA over T. HIGGINS                              │
│      │ Players          │ +2.8 pts consensus · WR matchup edge · 82% confidence              │
│ Src  │ Waiver Wire      ├────────────────────────────────────────────┬───────────────────────┤
│      │                  │ STARTING LINEUP                            │ THIS WEEK             │
│      │                  │ Pos  Player          Opp  Proj  Score  Δ   │ vs. River City         │
│      │                  │ QB   Jalen Hurts      NYG  22.4    —    —   │ 108.3  —  101.6        │
│      │                  │ RB   Bijan Robinson   NO   19.1    —   +1   │ [projected edge +6.7]  │
│      │                  │ WR   J. Smith-Njigba  ARI  16.7    —  +2.8  ├───────────────────────┤
│      │                  │ ...                                        │ WATCH LIST             │
│      │                  │                                             │ Player       Signal    │
│      │                  │ BENCH / DEPTH                              │ Addison      +12 buzz  │
│      │                  │ same grid; quieter treatment                │ RB waiver    rostered  │
│      │                  ├────────────────────────────────────────────┼───────────────────────┤
│      │                  │ REST-OF-SEASON POSITIONAL DEPTH             │ ROSTER PULSE           │
│      │                  │ QB ████  RB ████████  WR ██████  TE ██      │ 2 starts · 1 injury    │
└──────┴──────────────────┴────────────────────────────────────────────┴───────────────────────┘
```

### Layout rules

- Preserve the two-level rail, league switcher, global search, theme switch,
  and existing tab row. No new global navigation.
- The page body uses a 9:3 grid at 1280px and above: lineup/evidence at left,
  contextual decision support at right. Collapse to one column below 980px;
  the Decision Tape stays first and the right rail moves below the lineup.
- The right rail is contextual, not a miscellaneous widget column: matchup,
  watch list, then roster pulse, in that order.
- The lineup grid retains the existing declared DataGrid/Table cell kinds.
  Add a narrow `decision delta` column only when a player has a comparison;
  otherwise leave the cell blank. Do not invent a blended projection.
- Existing sources stay visible: the tape’s “consensus” label opens the player
  card with FantasyPros and Draft Sharks inputs. League Value stays labelled
  separately as ROS value-over-replacement.

## Interaction model

| Element | Behaviour |
|---|---|
| Decision Tape | Shows only one action at a time, ordered: lineup lock risk → injury replacement → waiver need → trade imbalance. “View player” opens the existing player card. A quiet “Why this?” disclosure lists source inputs and confidence. |
| Starting lineup | Keeps compact DataGrid density and sticky identity column. A row click opens the player card; a highlighted row is the tape’s recommendation. |
| Matchup panel | Displays only the manager’s matchup, including current score if live and projected final otherwise. “Open matchup” retains the existing page. |
| Watch list | Shows no more than three actionable players: an own-roster risk, a waiver option, and a trade/buzz movement. “See waivers” retains the existing Waiver Wire page. |
| Roster pulse | A small positional depth view; it is diagnostic, not another ranking. Selecting a position filters the existing roster grid. |

## What changes in the existing page

1. Introduce a pure `teamBrief` selector that chooses one recommendation from
   already-present data. It must return a reason and source references, never
   calculate a new consensus or value.
2. Replace the current `teamgrid` side panels with `Matchup`, `Watch list`, and
   `Roster pulse` panels in the same 9:3 layout.
3. Split the overview roster table into `Starting lineup` and `Bench / depth`.
   This is a presentation split based on the host lineup slot, not a data join.
4. Keep the existing explanatory legend below the grid and add the tape’s
   source disclosure to make the recommendation auditable.

## Mobile wireframe

```text
┌──────────────────────────────────────┐
│ Cville 2026 ▾              WK 7      │
│ THE IRON LEAGUE                       │
│ Overview  Week  ROS  Trade  Buzz      │
├──────────────────────────────────────┤
│ DECISION TAPE                         │
│ Start J. Smith-Njigba over Higgins    │
│ +2.8 pts · 82% confidence        →    │
├──────────────────────────────────────┤
│ THIS WEEK · 108.3 — 101.6             │
├──────────────────────────────────────┤
│ STARTING LINEUP                        │
│ QB  J. Hurts       NYG  22.4          │
│ RB  B. Robinson    NO   19.1          │
│ WR  J. Smith-Njigba ARI  16.7  +2.8   │
│ ...                                   │
├──────────────────────────────────────┤
│ WATCH LIST                             │
│ ...                                   │
└──────────────────────────────────────┘
```

The desktop mockup is available as [my-team-overview-mockup.svg](my-team-overview-mockup.svg).
