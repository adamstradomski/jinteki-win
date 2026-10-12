# Market Research

Market Research is the tournament card-meta backend for [jinteki.win](https://jinteki.win/market-research/).
It collects NSG Netrunner **Standard** tournament results and decklists, stores them **without any
personal data**, and publishes precomputed card-meta snapshots that the static page at
`/market-research/` reads from `data.jinteki.win`.

Tournament data comes from [AlwaysBeRunning.net](https://alwaysberunning.net) (please visit and
support it) and [NSG Cobra](https://tournaments.nullsignal.games); decklists and the card catalog
come from [NetrunnerDB](https://netrunnerdb.com).

Fan project, not affiliated with Null Signal Games.

## What it answers

For each side (Corp, Runner), per ban list, tier group and period:

1. **Most played cards**: inclusion rate, average copies, rank. Identities separately.
2. **Popularity trend**: monthly and per-ban-list series, change against the previous period, risers and fallers.
3. **Card winrate**: difference from the side's baseline in the same slice, Wilson 95% interval, minimum sample.
4. **Popularity vs winrate**: both joined, ready for a scatter plot.
5. **Top-cut conversion**: on high-decklist-coverage tournaments only, against the side's cut rate.
6. **In and out of faction**: the share of the card's own faction's decks that play it, the share of
   the other factions' decks that splash it (paying influence), and of the decks playing it, the share
   that splash it. Neutral cards have none; agendas, which can't leave their faction, only the first.

The page keeps its state in the address, so a view can be shared:
`#<ban list>/<tier>/<from>..<to>/<side>[/cut][/show:in|out|splash][/card:<card id>]`. The period is
written only when chosen, so a link without one follows the newest months; `show:` picks the view of
the most played cards table and `card:` opens that card's detail (a card of the other side switches to
its side; switching sides yourself closes it). Unknown or invalid parts are dropped.

Every card played in a slice is included (not a top N). Definitions: [docs/market-research/metrics.md](../docs/market-research/metrics.md).

## Layout

```
market-research/
  pipeline/market_research/   the Python package (CLI: market-research)
    http.py                   PoliteHttp: allowlist, rate limits, backoff, breaker, budget, robots.txt
    sources/                  ABR, Cobra and NetrunnerDB clients (parse into allowlisted records)
    records.py, scrub.py      scrubbed source record schemas, drift and quarantine
    frontier.py, ingest.py    crawl frontier (state/frontier.parquet) and the ingest loop
    imports.py                `import-decks`: decklist files matched to Cobra players
    normalize.py, catalog.py  canonical Parquet tables, linking, legality
    metrics.py, publish.py    additive counts, snapshot slices, validation, publishing
    breaker_bay.py            Breaker Bay's curated cost data, its pool slice and drafts
    runner.py, cli.py         run-all, backfill phases and --plan, CLI
    config.py, clock.py       settings from environment variables, injectable clock
    storage.py, db.py         R2 and local object stores, DuckDB bulk inserts
    logs.py                   JSON logs, secret redaction, the run log upload
    testing.py                fixture transport behind --fixtures and the tests
    fixtures_refresh.py       `fixtures refresh`: capture one live tournament as fixtures
    schemas/                  JSON Schemas of the snapshot contract
    data/tiers.json           the tier-group mapping (the one place it lives)
    data/breaker_bay/         Breaker Bay's hand-curated breakers, ice and support cards
  tests/                      offline tests (network disabled) and anonymised fixtures
  Dockerfile, requirements.lock, .env.example
```

Docs: [architecture](../docs/market-research/architecture.md), [sources](../docs/market-research/sources.md),
[data model](../docs/market-research/data-model.md), [metrics](../docs/market-research/metrics.md),
[snapshot contract](../docs/market-research/snapshot-contract/), [operations](../docs/market-research/operations.md).

## Data quality checks and fixes

The sources are community-run and hand-entered, so the pipeline checks everything it reads and fixes
what it safely can. Everything it drops, repairs or cannot match is counted in the published quality
report (`market-research report`, or `quality/report.json`; the page footer shows a summary), and each
run's full log is kept in R2 (`logs/…`, see [CLI](#cli)).

**Collecting**

- **Only allowlisted fields are kept.** Player names, user IDs, organisers, deck titles, descriptions
  and other free text are dropped before anything is stored; tests plant `PII_CANARY` values in the
  fixtures and fail if one reaches a record, a table, a snapshot or a log. The one piece of text kept
  is the event's public name (AlwaysBeRunning's title, Cobra's name), cleaned of control characters
  and capped at 120 characters, for the list of included tournaments.
- **Unknown fields** in a source's response are logged once as `drift_warnings`, so format changes
  show up before they break anything.
- **Unreadable data is quarantined item by item** (`parser_failures`), not the whole response:
  one tournament with a date like `20260-05-21` or `2026-02-30` no longer hides the rest of Cobra's
  or AlwaysBeRunning's list (it is logged under its event key, and the list is still paged by what
  the source sent). A quarantined item is retried after a day, an event from a list with the next
  list.
- **Responses over 5 MB are refused**; NetrunnerDB's card and printing lists are fetched 500 per page
  to stay under that.
- **Polite fetching:** one request at a time per site at a fixed rate, conditional requests, retries
  with backoff, and a circuit breaker that stops a site after repeated failures (the run then exits
  `2` and still publishes what it has).
- **Known source quirks handled:**
  - AlwaysBeRunning sometimes sends the text `"null"` for a missing identity; it counts as missing.
  - AlwaysBeRunning events can span several days (`end_date`); an unreadable end date is dropped,
    not the event.
  - Cobra lists tournaments by creation, not by date, and some are created long after the date they
    carry; listing stops on creation date and skips older-dated events one by one.
  - Cobra records a bye with the player in either seat.
  - While a cut is being played, Cobra lists its players without IDs. The players in elimination
    games then count as the cut, ranked by their seed until Cobra has the final placements, so a
    `backfill --cobra ID` can pull the public cut decks of a big event while its top cut is still on.
  - A Cobra event with a result still missing 14 days after its date counts as finished, so its decks
    are still fetched.

**Which tournaments count** (`skipped_tournaments`)

- Standard only: Cobra's format named "Standard", AlwaysBeRunning's `format` `standard`.
- Cobra events created before Cobra had a format setting (early 2025) have none. They follow their
  linked AlwaysBeRunning event; unlinked ones are left out when the name names another format
  (Startup, Eternal, draft, …) or an identity is not legal in Standard around the event date.
  Events with no identities recorded count only when their name says Standard.
  Startup events without the word in their name count as Standard (their card pool is a subset).
  A backfill re-checks events an earlier run skipped as not Standard.
- AlwaysBeRunning events must be approved, concluded and free of claim conflicts.
- At least 8 players (`MR_MIN_PLAYERS`).

**Joining the two sources** (`links`, `link_mismatches`)

- A Cobra event links to its AlwaysBeRunning copy through Cobra's `abr_code`, or else by date (within
  the AlwaysBeRunning event's days, ±1 day for time zones), the same player count, and at least 90%
  of AlwaysBeRunning's (Corp, Runner) identity pairs also in Cobra (unclaimed spots are missing from
  AlwaysBeRunning). A linked event is counted once.
- A candidate that fails only on identities is reported as `fallback_identities_differ`, so near
  misses can be reviewed.
- After linking, entries are matched by swiss rank; if a player's identities differ between the
  sites, that entry's AlwaysBeRunning claim is not used (`identity_mismatch`).

**Decks** (`decks_by_source`, `deck_comparison`, `illegal_decks`, `rejected_deck_refs`)

- One deck per player and side, in this order: a decklist file loaded with `import-decks` (e.g. the
  full lists the organiser sent), then the list registered in Cobra (locked when the event starts),
  then the NetrunnerDB decklist claimed on AlwaysBeRunning, then a private NetrunnerDB deck linked
  from Cobra. When two sources exist, whether their cards match is recorded.
- **Imported decklists are never overwritten by the crawler.** They live under `import/` in the
  source bucket, which ingest refuses to write; only another `import-decks` of the same tournament
  replaces them. See [Importing decklists](#importing-decklists).
- Deck links are read with a strict pattern and never followed elsewhere; others are rejected.
- Every deck is checked against its event's ban list and card pool: unknown or other-side cards,
  extra identities, copies over the limit, cards or identities not legal, deck size, influence,
  restricted cards, points and agenda points. Illegal decks stay in the canonical tables with their
  issues, and are left out of every statistic.
- **Each event's ban list is checked against its decks.** Organisers play a new list early, keep an
  old one, or cannot pick the right one in Cobra, and AlwaysBeRunning has no setting at all. Of the
  given list, the one in force on the event date and its neighbours, the one that makes clearly more
  decks legal replaces it: at least 2 more decks and at least 10% of the event's decks, so one
  player's illegal deck cannot move a whole event. Each change is listed in `restriction_overrides`.

**Statistics**

- Winrates exclude intentional draws and count draws as half a win; they come with a Wilson 95%
  interval. Cards and identities under 30 games are marked as small samples (`MR_MIN_GAMES`), and
  identity conversion under 20 entries in cut events (`MR_MIN_ENTRIES`).
- Card winrates are compared with the winrate of all decks of that side with a known decklist in the
  same filter; the headline Corp and Runner winrates use every game, so they add up to 100%.
- Identity conversion counts only events with a cut where at least 70% of identities are known
  (`MR_COVERAGE_HC`).
- The top-cut view counts only decks that made the cut in events that had one.

**Publishing**

- Every slice is validated against its JSON schema and a 2 MB size limit, and the published totals
  are checked against the canonical tables. If anything fails, nothing is published and the previous
  version stays live. The slice files are uploaded in parallel (16 at a time) and the manifest only
  after all of them succeeded, so readers never see a half-published version; a failed upload fails
  the run and leaves the previous manifest live.

## Development

Python 3.12. The easiest setup is [uv](https://docs.astral.sh/uv/), which fetches Python 3.12 if
needed and installs from `uv.lock`:

```sh
cd market-research
uv sync                          # creates .venv with the package (editable) and the dev group

uv run ruff check pipeline tests && uv run ruff format --check pipeline tests
uv run mypy
uv run pytest --cov              # sockets are disabled for every test
uv run pytest -n 0               # the same in one process: catches tests that leak global state
uv run market-research --help
```

| Command | What it does |
|---|---|
| `uv sync` | Creates or updates `.venv` to match `uv.lock` exactly: the runtime dependencies, the `dev` dependency group from `pyproject.toml`, and this package installed editable. `--no-dev` leaves out the dev tools. |
| `uv run <cmd>` | Runs `<cmd>` inside `.venv`, syncing it first if `pyproject.toml` or `uv.lock` changed. |
| `uv lock` | Re-resolves `uv.lock` after a dependency change in `pyproject.toml`; `-P name==version` moves one package. |

CI, the Docker image and Dependabot use the hash-pinned pip locks (`requirements.lock`,
`requirements-dev.lock`), not `uv.lock`. When you change a dependency, update both, and keep the
versions in `uv.lock` the same as in the pip locks (`uv lock -P name==version`).

Without uv, use pip and the pip locks:

```sh
cd market-research
python3.12 -m venv .venv && . .venv/bin/activate
pip install --require-hashes --no-deps -r requirements-dev.lock
pip install --no-deps --no-build-isolation -e .

ruff check pipeline tests && ruff format --check pipeline tests
mypy
pytest --cov                     # sockets are disabled for every test
```

Run the whole pipeline locally against the recorded fixtures, without network or R2:

```sh
market-research run-all --dry-run --fixtures tests/fixtures/http --now 2026-09-27T04:00:00Z
market-research backfill --plan --since 2026-06-01 --dry-run --fixtures tests/fixtures/http --now 2026-09-27T04:00:00Z
```

`--dry-run` uses a `LocalObjectStore` in a temporary directory (its path is logged). `--fixtures`
and `--now` are hidden development options.

Golden files (`tests/fixtures/expected/`) are regenerated with `MR_UPDATE_GOLDEN=1 pytest`; review the diff.
The raw HTTP fixtures are generated from real card data by `tests/fixtures/generate.py` (see its docstring).
`market-research fixtures refresh --cobra ID | --abr ID` captures one live tournament, anonymised with
canaries, into `tests/fixtures/refresh/` for review. It is manual only and never runs in CI.

## CLI

```
market-research ingest   [--budget N] [--source abr|cobra|nrdb] [--dry-run]
market-research normalize
market-research compute  [--no-publish]
market-research run-all  [--budget N] [--dry-run]         # ingest -> normalize -> compute/publish
market-research backfill [--since YYYY-MM-DD] [--plan] [--phase 1|2|3] [--dry-run]
market-research backfill --cobra ID ... --abr ID ... [--dry-run]    # reload single tournaments
market-research import-decks FILE --cobra ID [--origin LABEL] [--check]   # load decklists from a file
market-research report                                     # print the latest quality report
market-research breaker-bay draft [--prune] [--dir DIR]    # draft Breaker Bay entries for review
market-research fixtures refresh --cobra ID | --abr ID [--out DIR]   # manual only
```

Every command reads its configuration from environment variables ([.env.example](.env.example)).
Without `--dry-run` it uses the R2 buckets, or the directory in `MR_LOCAL_STORE` when that is set.
An empty value means the default; a number that doesn't parse stops the command before it starts.

| Variable | Default | Meaning |
|---|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | none | The R2 account and a token scoped to the three buckets. Never logged. |
| `MR_BUCKET_SOURCE`, `MR_BUCKET_CANONICAL`, `MR_BUCKET_PUBLISHED` | `mr-source`, `mr-canonical`, `mr-published` | Bucket names. |
| `MR_LOCAL_STORE` | none | Use this directory instead of R2 (development). |
| `CONTACT` | `unset` | An email or URL for source maintainers, sent in the User-Agent. |
| `MR_BUDGET` | `400` | Requests per host per run (`--budget` overrides it). |
| `MR_BUDGET_ABR`, `MR_BUDGET_COBRA`, `MR_BUDGET_NRDB` | `MR_BUDGET` | The same, for one host. |
| `MR_RATE_ABR_S`, `MR_RATE_COBRA_S`, `MR_RATE_NRDB_S` | `2`, `2`, `1` | Seconds between requests to a host. |
| `MR_JITTER_ABR`, `MR_JITTER_COBRA`, `MR_JITTER_NRDB` | `0.2` | Random spread of that interval (0.2 = ±20%). |
| `MR_MIN_PLAYERS` | `8` | Smallest tournament counted. |
| `MR_COVERAGE_HC` | `0.7` | Decklist coverage for a high-coverage tournament (identity and top-cut conversion). |
| `MR_MIN_GAMES` | `30` | Games under which a card or identity winrate is marked a small sample. |
| `MR_MIN_ENTRIES` | `20` | Entries under which identity conversion is marked a small sample. |
| `MR_MIN_SPLASH_DECKS` | `20` | Decks playing a card under which its splash share is marked a small sample. |
| `MR_PERIOD_MONTHS` | `3` | Length of the page's default period (manifest `period_months`). |
| `MR_UPDATE_GOLDEN` | none | Tests only: `1` rewrites the golden files in `tests/fixtures/expected/`. |

| Command | What it does | Network | Writes | Publishes | Log in R2 |
|---|---|---|---|---|---|
| `ingest` | Fetches what the crawl frontier says is due, newest and biggest first, within each host's request budget. | ABR, Cobra, NetrunnerDB | source records, frontier and ingest quality state | no | yes |
| `normalize` | Rebuilds the canonical tables (tournament, entry, game, deck, deck_card) from all source records. | none | canonical tables, normalize quality | no | yes |
| `compute` | Computes every slice from the canonical tables, validates it against the schemas and publishes a new `v=<version>/`, `manifest.json` last. | none | published snapshot | yes | yes |
| `run-all` | `ingest`, then `normalize`, then `compute`. The daily scheduled command. | all three hosts | all of the above | yes | yes |
| `backfill` | The initial or extended history load: no per-run budget, in three phases, publishing after each; resumable. | all three hosts | all of the above | after each phase | yes, also after each phase |
| `backfill --cobra ID --abr ID` | Reloads only these tournaments, in full, whatever the frontier says (results or entries, settings, deck pages, decklists and their daily lists), without the date window or the Cobra format check, and pulls public Cobra deck pages even while the event still counts as live (the first 3 days after its date, when scheduled runs leave them); then normalizes and publishes once. | the tournaments' hosts | all of the above | yes, once | yes |
| `import-decks FILE --cobra ID` | Loads a tournament's decklists from a file into `import/cobra/<id>.json` (see [Importing decklists](#importing-decklists)), then normalizes and publishes once. | Cobra (the tournament's export, once) | the import record, canonical tables | yes, once (not with `--check`) | yes |
| `backfill --plan` | Makes only the listing requests and prints requests and estimated duration per host and phase. | listings only | nothing but its log | no | yes |
| `report` | Prints the latest published `quality/report.json`. | none | nothing | no | no |
| `breaker-bay draft` | Adds draft entries, marked not reviewed, to Breaker Bay's curated files for the Standard breakers, ice and support-card candidates they don't cover yet (see [Breaker Bay](#breaker-bay)). | none (reads the stored catalog) | the curated files in `--dir` | no | no |
| `fixtures refresh` | Fetches one live tournament, anonymises it with canaries and writes fixture files for review. | the chosen host | files in `--out` only | no | no |

Options:

| Option | Commands | Meaning |
|---|---|---|
| `--budget N` | `ingest`, `run-all` | Requests per host for this run (default 400, or `MR_BUDGET`). |
| `--source abr\|cobra\|nrdb` | `ingest` | Fetch from this source only. |
| `--no-publish` | `compute` | Build and validate the snapshot without uploading it. |
| `--since YYYY-MM-DD` | `backfill` | Start date. Default: the start of the oldest ban list still relevant to Standard, or 24 months back, whichever is earlier. A later backfill with an earlier date adds the missing history. |
| `--plan` | `backfill` | Plan only (see above). |
| `--phase 1\|2\|3` | `backfill` | Run one phase: 1 = events of the last 90 days, 2 = older Megacity+ events, 3 = everything else. Listings, card data and daily decklist files (phase 0) run with every phase. |
| `--dry-run` | `ingest`, `run-all`, `backfill` | Use a `LocalObjectStore` in a new temporary directory instead of R2; its path is logged as `dry_run_store`. |
| `--cobra ID` / `--abr ID` | `backfill` | Reload this Cobra / AlwaysBeRunning tournament (repeatable, both may be given). Every ID is looked up first; an unknown one exits `1` and writes nothing. Not combinable with `--since`, `--plan` or `--phase`. AlwaysBeRunning has no single-event API, so its results listing is read until every ID is found. |
| `FILE` | `import-decks` | The decklist CSV to load (see below). Unreadable: exits `1`. |
| `--cobra ID` | `import-decks` | The Cobra tournament the file belongs to. It must already be stored (`backfill --cobra ID`). |
| `--origin LABEL` | `import-decks` | Where the file came from, kept with the decks and in `source_ref` (`import:<label>:…`). `a-z`, `0-9`, `_`, `-`, at most 32 characters; default `organiser`. |
| `--check` | `import-decks` | Match and report only: writes no record and publishes nothing. |
| `--cobra ID` / `--abr ID` | `fixtures refresh` | The tournament to capture; give exactly one. |
| `--out DIR` | `fixtures refresh` | Output directory (default `tests/fixtures/refresh`). |
| `--dir DIR` | `breaker-bay draft` | The curated files' directory (default: the package's `data/breaker_bay/`, which is `pipeline/market_research/data/breaker_bay/` in an editable install). Missing files count as empty. |
| `--prune` | `breaker-bay draft` | Also remove entries for cards no longer in the Standard pool (otherwise they are only listed). |
| `--fixtures DIR` (hidden) | `ingest`, `normalize`, `run-all`, `backfill`, `report`, `import-decks` | Serve every HTTP request from a recorded fixture directory. Development and tests only. |
| `--now ISO-TIME` (hidden) | `ingest`, `normalize`, `compute`, `run-all`, `backfill`, `import-decks`, `breaker-bay draft` | Pin the clock, e.g. `2026-09-27T04:00:00Z`. Development and tests only. |

Exit codes: `0` success, `2` partial (a host tripped its circuit breaker, publish still happened),
`1` failure (nothing published; the previous manifest stays live). `report` exits `1` when nothing
has been published yet. `import-decks` exits `1`, writing nothing, when the file can't be read, the
tournament, its players or the card catalog aren't stored, Cobra's export can't be fetched, or no
deck in the file matched. `breaker-bay draft` exits `0` whether or not it drafted anything, and `1`,
writing nothing, when no card catalog is stored or a curated file can't be read.

### Breaker Bay

Every snapshot also carries `breaker-bay/pool.json` for the [Breaker Bay](../docs/breaker-bay/spec.md)
page: the icebreakers, ice and support cards of the Standard ban list in force on the run date, with
the hand-curated cost model from `pipeline/market_research/data/breaker_bay/`
([format](../docs/breaker-bay/data-format.md)).

- **An unreviewed entry stops publishing.** While any curated entry has `"reviewed": false` or
  `uncertain` fields, `compute` (and `run-all`) publish nothing and exit `1`, and the tests fail.
- **A new breaker never stops publishing.** A Standard icebreaker without an entry is published as
  unmodelled ("Not reviewed yet") and logged as `breaker_bay_missing_entries`.
- **After a new set or ban list:**

  ```sh
  market-research breaker-bay draft             # adds drafts for what the files don't cover
  # review each draft in data/breaker_bay/*.json, then set "reviewed": true
  uv run pytest tests/test_breaker_bay.py       # fails while a draft is left unreviewed
  ```

  `draft` reads the stored NetrunnerDB catalog, so it needs `MR_LOCAL_STORE` or the R2 settings like
  the other commands. Cards that left the pool are listed; `--prune` removes their entries.

### Importing decklists

Organisers sometimes send the full decklists of an event that Cobra keeps private (NSG sent the
Worlds 2026 lists). `import-decks` loads such a file for one Cobra tournament:

```sh
market-research import-decks data/worlds26_long_format_decklists.csv --cobra 5132 --origin nsg --check
market-research import-decks data/worlds26_long_format_decklists.csv --cobra 5132 --origin nsg
```

- **The file** is a UTF-8 CSV with one row per card and the columns `name` (the player's name as in
  Cobra), `identity` and `card` (full card titles) and `card_count` (1 to 99); other columns are
  ignored. Up to 5 MB.
- **Players** are found by name in Cobra's export of the tournament, fetched once and kept in memory:
  the exact name, else the only player whose name is the same ignoring case, accents, spaces and
  punctuation. The stored record keeps the Cobra player ID, never the name.
- **Each deck is checked on its own**; one that fails is left out and the rest are imported. Reasons,
  reported in the `import_report` log line with the CSV line where the player or deck starts:
  `player_not_found` (no or several Cobra players fit the name; both decks), `unknown_identity`,
  `unknown_card` (a title not in the NetrunnerDB catalog, or one two cards share), `bad_count`,
  `identity_differs_from_cobra`, and `two_decks_for_one_side`. The report also lists the Swiss ranks
  of Cobra players the file has no deck for.
- **Imported decks come first** for their player and side, and are compared with the next source
  (Cobra's list, else the claimed NetrunnerDB decklist): `match`, `mismatch` or `import_only` in
  `deck_comparison`. They are checked for legality like every other deck.
- Keep the files themselves out of git: they contain player names (`data/` is ignored).

Logs are JSON lines on stdout. The first line (`run_log`) names the R2 key the log is uploaded to
(`logs/<date>/<start>-<command>.jsonl.gz` in the canonical bucket) and the last is `run_summary`
(requests per host, 304s, new records, decks added, slices published, duration). See
[operations.md](../docs/market-research/operations.md#run-logs).

### Through Docker

In production every command runs in the image, with the same arguments after the image name:

```sh
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --env-file market-research/market-research.env market-research:0.1.0 <command> [options]
```

In Git Bash on Windows, prefix it with `MSYS_NO_PATHCONV=1`, or Git Bash rewrites `/tmp` into a
Windows path and Docker refuses it. For a long backfill, run it detached with a name
(`docker run -d --name mr-backfill …`) instead of `--rm`, and follow it with `docker logs -f mr-backfill`.

## Running it

One Docker image, run by the host scheduler; it keeps no state on local disk between runs.

```sh
docker build -t market-research:0.1.0 market-research
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --env-file market-research.env market-research:0.1.0 run-all
```

Configuration comes only from environment variables; see [.env.example](.env.example). Buckets,
the scoped R2 token, the custom domain, cache rules, **the R2 lifecycle rule that removes old
versions** (the runner never deletes), scheduler examples and the first-backfill procedure
(including telling the ABR maintainer and NSG beforehand) are in
[operations.md](../docs/market-research/operations.md).
