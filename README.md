# jinteki.win

Netrunner tools on [jinteki.win](https://jinteki.win/). The landing page at `/` links to all four:

- **Trace** (`/trace/`): a single-page, client-side log analyzer for [jinteki.net](https://jinteki.net) games, described below.
- **Market Research** (`/market-research/`): card meta from NSG Netrunner Standard tournaments. See [docs/market-research/](docs/market-research/).
- **Breaker Bay** (`/breaker-bay/`): what it costs to break every piece of Standard ice with every icebreaker, and a run planner that ranks rigs for a server. Described below.
- **Cobra Bot** (`/cobra-bot/`): a static page about the Cobra Discord bot, described below.

Trace: Paste (or bookmarklet-import) a finished game's chat log and get parsed stats, per-turn charts, and a per-card credit/cost breakdown — no server, no accounts, nothing leaves your browser unless you explicitly opt in.

**Live site:** [jinteki.win](https://jinteki.win/), Trace at [jinteki.win/trace/](https://jinteki.win/trace/)

## Features

- **Log parsing** — paste the log text from the jinteki.net chat panel and parse it into structured turn-by-turn data.
- **Browser bookmarklet** — drag a bookmarklet into your bookmarks bar; on any finished jinteki.net game, one click extracts the log and opens it here already parsed, no copy/paste.
- **Game summary & stats** — turns played, credits, draws, runs, installs, and other per-player totals.
- **Achievements** — per-player Corp/Runner achievements for the game (e.g. won without clicking for credits, flatline and mill wins, comebacks from 0–6), shown as tags next to the chat badges in the game summary with the description on hover. Defined in one `ACHIEVEMENTS` list in `public/trace/parser.js`.
- **Charts** — agenda points, net credits gained per turn, credit pool over time, cards in hand, and cumulative cards drawn, plotted both by each player's own turn number and on a shared/interleaved turn-order axis.
- **Per-card tables** — credits gained/spent and net value attributed to each installed card, plus operations/events, with a flagged-lines list for anything the parser couldn't confidently resolve.
- **Share link** — compresses the pasted log and encodes it into a URL fragment (`/trace/#log=...`) so a whole game can be shared as a link. The log never touches a server; only whoever has the link can decode it in their own browser.
- **Report a bug** — opens a prefilled GitHub issue, including an auto-generated share link to the log that triggered the problem.
- **Optional short links** — opt-in only; unlike the plain share link, this stores the encoded log on jinteki.win's own shortener (`src/`, run by the site's Cloudflare Worker) and returns a `jinteki.win/s/<id>` link.

## Privacy

Everything runs client-side. Nothing about a pasted log is uploaded anywhere unless you explicitly click "Shorten link", which is called out in the UI and in the page footer.

## Development

Trace is plain static files with no build step, no dependencies, and no package manager: the markup in `public/trace/index.html`, its styles in `public/trace/style.css`, the log parser in `public/trace/parser.js` (no DOM access; it exposes `globalThis.TraceParser`) and the rendering and page wiring in `public/trace/app.js`, plus two tiny scripts that must run before first paint, `theme-init.js` and `hash-overlay.js`. The two built-in example logs are in `examples.js`, which `app.js` loads with a `<script>` tag only when an example button is clicked. All of them are classic scripts, not ES modules, and nothing is fetched, so the page also works opened as a local file. Like the other pages, its Content Security Policy forbids inline scripts, `on…=` attributes and `style` attributes (setting `element.style` from script is fine), so keep script and styles in those files and use classes or the `hidden` attribute. Everything taken from a log (player names, card names, whole lines) is untrusted, because anyone can craft a `#log=` link: pass it through `esc()` (or `fmt()`) before it goes into `innerHTML`, or use `textContent`. To work on it locally, open it in a browser, or serve `public/` with any static file server. The parser has golden tests: `node --test test/trace/*.test.mjs` parses every `test/*.log` and both example logs and compares the result with `test/trace/golden/`; when a parser change is meant to change the output, rerun it with `UPDATE_GOLDEN=1` and review the golden diff (`.gitattributes` keeps the golden files LF, so they also match on a Windows checkout). The same command runs `parser-cases.test.mjs` (short hand-written logs: the timestamped and bookmarklet paste formats, rare line kinds, bad input) and `achievements.test.mjs` (every achievement on hand-built parse results); add a case there for behaviour the golden logs don't show. Market Research loads as ES modules, so serve `public/` for it.

Trace used to live at `/`. Old share links and installed bookmarklets still point at `https://jinteki.win/#log=…`, so `public/home.js` forwards any `#log=` hash on the landing page to `/trace/` before it paints. Keep that forwarding in place.

The pages' look comes from the jinteki.win design system, copied into `public/shared/jw/` (shared with the Market Research page): `tokens.css` (colours per theme, generated from `tokens.json` by `build-tokens.mjs`; don't edit it by hand), `bundle.css` (font stacks, shapes and components) and `bundle.js` (`window.JW`: theme switching, loading only the active theme's Google Fonts (again when the theme changes), resolved chart colours and `enablePanelCollapse()` for panels with a `.collapse-icon` button). The header offers four theme families (Beanstalk, Ice Wall, Console, Night City) and a separate Dark | Light toggle; the choices are saved in `localStorage['jw-theme']` and `localStorage['jw-mode']`, and with no saved mode the page follows the system's light/dark setting. Style new UI with the tokens (`var(--panel)`, `var(--accent)` …) and the `.btn` / `.btn.secondary` classes rather than hex values, so it follows the theme.

Real and synthetic game logs with their expected results are in `test/` (see `test/README.md`). To test a change, paste one of those or one of the two built-in example logs (via the "Log example 1/2" buttons) and confirm the parsed output looks right, or use `/code-review` / `/simplify` if you're using Claude Code against this repo.

### Commands

Run from the repository root. The Market Research pipeline has its own CLI, documented in [market-research/README.md](market-research/README.md#cli).

| Command | What it does |
|---|---|
| `npx serve public` (or any static file server with `public/` as its root) | Serves the site locally. Every page loads its files by relative path; Market Research needs a server because it loads as ES modules, while Trace and the landing page also work opened as files. |
| `npm install` | Installs Wrangler, the only dependency (needs Node.js 22 or newer). |
| `npm run build` | The Workers Builds step: `scripts/render-config.mjs` renders `wrangler.toml` from `wrangler.template.toml` and the build variables, then `scripts/stamp-build.mjs` stamps the build time (Warsaw time) and commit (`WORKERS_CI_COMMIT_SHA`, else `git rev-parse HEAD`) into Trace's footer. Don't commit the stamped page. Exits `1`, writing nothing, when a variable is missing or empty, or invalid: `WORKERS_DEV` not `true`/`false`, `ROUTES` not a TOML array, `RETENTION_DAYS` not a positive whole number, or another value holding a quote, backslash or line break. `stamp-build.mjs` alone exits `1` if the footer has no `Build:` text. |
| `npx wrangler dev` | Runs the Worker locally (site plus shortener) after `npm run build` has rendered `wrangler.toml`. |
| `npx wrangler deploy` | The Workers Builds deploy step. |
| `node public/shared/jw/build-tokens.mjs` | Regenerates `public/shared/jw/tokens.css` from `tokens.json` (`npm test` fails if the committed file differs). |
| `npm test` | Runs every Node test: `test/**/*.test.mjs` (the Worker, Trace, the build scripts and any new suite there) and `market-research/tests/ui/*.test.mjs`. No `npm install` needed, but it needs Node.js 22 or newer: older versions don't expand the globs and find no tests. |
| `node scripts/build-bookmarklet.mjs` | Rebuilds the Trace bookmarklet from `public/trace/bookmarklet.src.js` into the `#bookmarkletBtn` href in `public/trace/index.html`; `--check` fails if the href is out of date (run in CI). Exit codes: `0` up to date or rewritten, `1` out of date with `--check` (or the built href lacks the production URL), `2` no `#bookmarkletBtn` href found. |
| `node --test test/worker/*.test.mjs` | Unit tests for the link shortener Worker in `src/`, with in-memory fakes for D1 and the other bindings (also run in CI). |
| `node --test test/trace/*.test.mjs` | Trace's parser tests: the golden files (`UPDATE_GOLDEN=1` rewrites them), the hand-written log cases and the achievements (also run in CI). |
| `node --test test/scripts/*.test.mjs` | Tests for the build scripts (`render-config`, `stamp-build`, `build-bookmarklet`, `build-tokens`); each runs a copy of its script in a temporary directory, so the repo is never touched. Also checks that `tokens.css` is what `build-tokens.mjs` generates. |
| `node --test test/breaker-bay/*.test.mjs` | Tests Breaker Bay's model (`public/breaker-bay/model.js`): costs, filters, the run planner and the address, on small hand-built pools and on the pipeline's golden `breaker-bay/pool.json` (also run in CI). |
| `node --test market-research/tests/ui/*.test.mjs` | Tests the Market Research page's data module against the pipeline's reference snapshot (also run in CI). |

## Breaker Bay

`/breaker-bay/` reads the newest Market Research snapshot from `data.jinteki.win`: `manifest.json`, then the
file its `paths.breaker_bay` names (`breaker-bay/pool.json`), which the pipeline builds from the NetrunnerDB card
pool and hand-curated breaker data ([spec](docs/breaker-bay/spec.md), [data format](docs/breaker-bay/data-format.md)).
Everything else happens in the browser.

- `public/breaker-bay/model.js` holds every rule (no DOM): the cost of one encounter (pump to the ice's strength
  after every modifier, then break every subroutine, by the cheapest mix of the breaker's abilities), the filters,
  the run planner's rig ranking, and the address. `app.js` only draws; `index.html` and `style.css` use the design
  system and its CSP rules (no inline scripts or `style` attributes).
- **Cost table:** ice × breakers, one encounter per cell. Filters by breaker and ice type and faction, stealth,
  rez cost and strength ranges, variants, special breakers (`special` in the data), and an explicit choice of
  breakers or ice that overrides the type and faction filters. Card settings (counters, conditions, support cards)
  start from what each card gives.
- **Run planner:** stack a server's ice; it ranks rigs of up to three breakers (one per fracter, decoder, killer
  and AI slot) by the credits for one run, with counters spent on one piece of ice gone for the next.
- **Address:** every filter and setting that differs from the desktop defaults is kept in the hash, e.g.
  `#bf=criminal&b=buzzsaw,corsair&p=hantu.virus.4&srv=tree_line,pharos`; unknown parts are dropped. A phone with no
  hash starts with fracters and barriers.
- **Local preview:** serve the repository root (`python -m http.server 5318`) and open
  `/public/breaker-bay/?data=/market-research/tests/fixtures/expected/snapshot/` for the pipeline's golden snapshot;
  `?data=` accepts only a same-origin path.

## Deployment

The site runs on one Cloudflare Worker per environment, built from this repo with Workers Builds:

- `public/` holds the static site, served directly as Worker static assets.
- `src/` is the Worker code for the link shortener: `POST /api/shorten` creates a short link, `GET /s/<id>` redirects to `/trace/#log=<payload>`, and a daily cron (`17 3 * * *`) deletes links not opened for `RETENTION_DAYS` days (a build variable; a value that isn't a positive whole number makes the cron log an error and delete nothing). Only these paths run code.
- `schema.sql` is the D1 schema; each environment has its own database. It only uses `IF NOT EXISTS`, so re-running it on an existing database adds anything new (such as the `idx_links_created_at` index the daily cap uses): `npx wrangler d1 execute <D1_NAME> --remote --file schema.sql`.
- `public/_headers` adds security headers (`nosniff`, no framing, HSTS, Referrer-Policy) to every static file; `src/index.js` sets the same ones on the shortener's responses, which `_headers` doesn't reach. Each page sets its own Content-Security-Policy in a `<meta>` tag; it must allow `https://static.cloudflareinsights.com` in `script-src` and `https://cloudflareinsights.com` in `connect-src`, or the Cloudflare Web Analytics beacon that Cloudflare injects is blocked.

Production (`jinteki-analyzer`, from `main`) serves jinteki.win; the test Worker (`jinteki-analyzer-test`) is an identical copy with its own database on its workers.dev URL.

The repo is public, so account details aren't committed. `wrangler.toml` is generated at build time from `wrangler.template.toml` by `scripts/render-config.mjs`, using each Worker's build variables (Settings → Build → Variables and secrets). The build fails if any are missing. The same build step stamps the footer's build time and commit (`scripts/stamp-build.mjs`); the committed page just says `Build: dev`.

| Variable | Meaning |
|---|---|
| `WORKER_NAME` | Worker name; must match the Worker being built |
| `WORKERS_DEV` | `true` or `false`: serve on the workers.dev subdomain |
| `ROUTES` | TOML array of routes or custom domains, or `[]` |
| `RETENTION_DAYS` | Delete short links not opened for this many days |
| `D1_NAME`, `D1_ID` | D1 database for this environment |
| `RL_CREATE_NS`, `RL_MISS_NS` | Rate-limit namespace IDs (unique per environment) |

Build settings: root directory `/`, build command `node scripts/render-config.mjs`, deploy command `npx wrangler deploy`.

Short links accept only this site's log payloads (never arbitrary URLs), are created only from the site's own origin, are at most 32K characters (a long real game compresses to about 6K), are rate-limited per IP and capped at 1,000 new links a day site-wide (`DEFAULT_DAILY_CREATE_LIMIT` in `src/create.js`), and identical logs reuse the same link. Stay on the Workers Free plan: if a daily limit is reached, requests fail until the reset instead of being billed, and the site falls back to the long share link.

### Release process

Two branches deploy, each to its own Worker, through Workers Builds on every push. GitHub Actions
only run tests; they never deploy.

| Branch | Worker | Serves |
|---|---|---|
| `test` | `jinteki-analyzer-test` | its workers.dev URL |
| `main` | `jinteki-analyzer` | jinteki.win (production) |

1. Work on a feature branch, then merge it into `test` and push. Workers Builds deploys the test
   Worker; check the change there.
2. When it is right, fast-forward `main` to `test` and push (`git push origin test:main`, or merge
   `test` into `main`). Workers Builds deploys production. Nothing reaches jinteki.win without
   going through `test` first.

**Both environments read the same Market Research data.** There is one pipeline and one published
bucket: the test page and the production page both load their snapshots from `data.jinteki.win`
(the test Worker's origin must be in the bucket's CORS policy, see
[operations](docs/market-research/operations.md#custom-domain-and-cache-rules)). There is no test
data set, and publishing is not tied to a branch: a snapshot goes live for both environments as
soon as `compute` or `run-all` runs with an image built from the new pipeline code. Only the short
links differ: each Worker has its own D1 database.

So a change to the snapshot must work with both pages at once:

- Keep it additive: new fields, and new columns at the end of `trends.json` rows. The page in
  production (older code) must keep working on the new data, and the new page must keep working on
  the data published before it (show nothing new rather than fail). A change that can't be
  additive needs a new schema major version (`mr.summary/2` and so on).
- Release such a change in this order: push to `test` and check the test page on the current data;
  rebuild the image and publish (`docker build`, then `compute`, see
  [operations](docs/market-research/operations.md)); check the test page on the new data and
  jinteki.win still working; then push `main`.

To undo a release, revert on the branch and push (or roll back the deployment in the Cloudflare
dashboard). To undo a data change, run `compute` with the previous image: it publishes a new
version computed with the old code. Older versions stay in the bucket for 14 days.

## Market Research

`/market-research/` is a second page: tournament card meta (most played cards, trends, winrates, top-cut conversion) for NSG Netrunner Standard, built from [AlwaysBeRunning.net](https://alwaysberunning.net), NSG Cobra and NetrunnerDB data. The page lives in `public/market-research/` and reads precomputed snapshots from `data.jinteki.win`; the batch pipeline that builds them is in [`market-research/`](market-research/README.md), with docs in [`docs/market-research/`](docs/market-research/architecture.md).

## Cobra Bot

`/cobra-bot/` is a static page (no JavaScript beyond the theme controls) that introduces the Cobra Discord bot: its `/cobra standings`, `/cobra pairings`, `/cobra top-cut`, `/cobra bracket` and `/cobra player` commands, an example reply (`standings.webp`) and the [invite link](https://discord.com/oauth2/authorize?client_id=837045273128861727). The bot itself is a separate project (`cobra-bot-lambda`); when its commands change, update `public/cobra-bot/index.html` to match.

## Support

If this tool is useful to you, consider [supporting it on Ko-fi](https://ko-fi.com/inermis2020).

## Reporting issues

Use the in-app "Report a bug" button (it auto-fills a template and a share link to the log in question), or open an issue directly at [github.com/adamstradomski/jinteki-analyzer/issues](https://github.com/adamstradomski/jinteki-analyzer/issues/new).
