# Breaker Bay: specification

Breaker Bay (`/breaker-bay/` on jinteki.win) shows what it costs to break ice with each icebreaker
in the current NSG Standard card pool. It is inspired by Aaryn Byrne's "Netrunner - Breakers & Ice"
Tableau dashboard, and goes further: a breaker × ice cost table, per-card settings and support cards.

The UI is in English, like the rest of the site, and uses the jinteki.win design system
(`public/shared/jw/`).

## Card pool

Only the current Standard pool: cards legal under the newest Standard ban list in the catalog.
There is no format switch.

## Cost to break

- The cost to break a piece of ice with a breaker is the cheapest way, in credits, to raise the
  breaker's strength to the ice's strength (after every modifier) and break **every** subroutine.
- Only ice whose subtypes the breaker can interface with counts; AI breakers interface with any ice.
  Ice with several subtypes can be broken by any matching breaker.
- When a breaker cannot fully break a piece of ice at all (no pump, not enough hosted counters, a
  one-subroutine-per-encounter limit), its cost for that ice is empty, not a number.
- The install cost is shown separately; it is never added to the cost to break.

## Data

Built in stage 1. The Market Research pipeline publishes `breaker-bay/cards.json` in every snapshot
(schema `mr.breaker_bay/1`), refreshed with the rest of the snapshot, so a ban list change reaches
Breaker Bay on its own. It joins:

- **NetrunnerDB card data**: cost, strength, memory cost, subtypes, faction and the card text.
  The number of subroutines on a piece of ice is counted from the `[subroutine]` marks in its text.
- **Hand-curated files** in `market-research/pipeline/market_research/data/breaker_bay/`:
  - `breakers.json`: every icebreaker's abilities as data (break, pump, weaken, bypass, counters
    spent, per-card settings, variants);
  - `ice.json`: corrections for ice whose strength or subroutines change during play
    (advancement, hosted counters, conditions);
  - `support.json`: non-breaker cards that change ice strength, breaker strength, break costs or ice
    subtypes, shown as checkboxes.

Every curated entry has `reviewed`. The format is described in
[data-format.md](data-format.md).

### Keeping the curated files current

`market-research breaker-bay draft` reads the stored catalog, finds Standard breakers, ice and
support-card candidates that the curated files don't cover, proposes entries with regexes over the
card text, and writes them with `"reviewed": false` and an `uncertain` list of the fields the regexes
could not settle. A person reviews and corrects each draft and sets `"reviewed": true`.

- The test suite and `compute` refuse to run on a curated file with an unreviewed entry (exit `1`;
  nothing is published), so a draft never reaches the site by accident.
- A Standard breaker with no entry is published as unmodelled ("not reviewed yet") and logged
  (`breaker_bay_missing_entries`); it does not stop the Market Research snapshot.
- Entries for cards that left the pool are kept (a card can come back) and ignored;
  `draft --prune` removes them.

## Model

- **Variants**: a breaker whose abilities depend on a condition (Marjanah after a successful run,
  Euler or Gauss on their install turn, Boi-tatá after trashing a card, Afterimage's bypass, threat
  levels…) has variants. Each variant is its own row in the table and its own box in the box plot;
  one variant is marked default, and "Show variants" hides the others.
- **Per-card settings**: hosted virus counters, hosted power counters, installed icebreakers (default
  3), free MU and similar counts are settings of the card that uses them, starting from the value the
  card itself gives (e.g. Propeller's 4 power counters). Each piece of advanceable ice has its own
  advancement setting (default 0).
- **Support cards**: checkboxes. Each one changes ice strength, breaker strength, break costs or ice
  subtypes for every panel at once (a card that gives ice every subtype lets every breaker break it).
- **Unmodelled cards**: breakers whose cost doesn't fit the model at all (Banner only stops
  subroutines from ending the run) are listed in a note with the reason, never with a number.

## Page

Built in stage 2. Stage 3 adds the charts.

- **Card settings** panel on the left (above the content on a phone): per-card sliders, variant
  toggles and support-card checkboxes. It must be easy to use on a phone.
- **Filters**, applied to every panel: breaker type, breaker faction, stealth / non-stealth, ice
  faction, ice rez cost range, ice strength range (after modifiers), show variants.
- **Cost table**: one table, ice × breakers, heatmap colouring, sticky headers, a cost breakdown on
  click ("2× pump at 1c + 3× break at 1c = 5c"), toggles for breaker types and ice types, and a switch
  between the axes. On a phone it starts with one breaker type and one ice type (fracters, barriers).
- **Shareable state**: every filter, setting and toggle is kept in the URL hash; the defaults give an
  empty hash.
- **Charts** (stage 3), hand-written SVG with helpers shared with Market Research in `public/shared/`:
  - cost to break per breaker, as a box plot (whiskers from minimum to maximum);
  - ice by faction and rez cost, as a treemap (area = number of ice); a click lists that ice with the
    mean and median cost to break and the cost efficiency (cost to break ÷ rez cost) over the
    breakers left by the filters;
  - number of ice by strength (after modifiers) per faction.

## Stages

All three are built; the design proposals of stage 1 led to the page combining proposal A (the table, with
faction filters and an explicit choice of breakers and ice) and proposal C (the run planner). The table costs one
encounter per cell; the run planner carries spent counters from one piece of ice to the next. A switch leaves out
special breakers (`special` in breakers.json).

1. Data: the card fields in the catalog records, the curated files, `breaker-bay draft`, the
   `breaker-bay/cards.json` slice and its tests. Then several UI design proposals built on the real
   stage 1 data, for choosing a direction.
2. The page: cost model (tested in Node), card settings, filters, the cost table, URL state, a link
   from the landing page.
3. The charts.

Each stage is one pull request to `test`, green in CI, with its commands documented in the README.
