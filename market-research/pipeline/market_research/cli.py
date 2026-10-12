"""Command-line interface: `market-research`."""

from __future__ import annotations

import json
import sys
from datetime import date
from enum import StrEnum
from pathlib import Path
from typing import Annotated

import typer

from market_research import logs
from market_research.clock import Clock, FakeClock, SystemClock
from market_research.config import Settings, load_settings
from market_research.runner import (
    EXIT_FAILURE,
    EXIT_OK,
    RunResult,
    Runtime,
    backfill,
    default_since,
    do_compute,
    do_ingest,
    do_normalize,
    dry_run_stores,
    format_plan,
    import_decks,
    parse_now,
    plan,
    reload,
    run_all,
)
from market_research.storage import ObjectStore, Stores, stores_from_settings

app = typer.Typer(
    add_completion=False, no_args_is_help=True, help="Market Research tournament card-meta pipeline."
)
fixtures_app = typer.Typer(help="Fixture maintenance (manual only; never run in CI).")
app.add_typer(fixtures_app, name="fixtures")
breaker_bay_app = typer.Typer(help="Breaker Bay's hand-curated cost data.")
app.add_typer(breaker_bay_app, name="breaker-bay")
log = logs.get("market_research.cli")


class Source(StrEnum):
    abr = "abr"
    cobra = "cobra"
    nrdb = "nrdb"


DryRun = Annotated[bool, typer.Option("--dry-run", help="Use a LocalObjectStore in a temporary directory.")]
Fixtures = Annotated[
    Path | None, typer.Option("--fixtures", hidden=True, help="Serve HTTP from a fixture directory.")
]
Now = Annotated[str | None, typer.Option("--now", hidden=True, help="Pin the clock (ISO time with zone).")]


class _RunLog:
    store: ObjectStore | None = None


_run_log = _RunLog()


def _runtime(
    dry_run: bool = False, fixtures: Path | None = None, now: str | None = None, *, command: str | None = None
) -> Runtime:
    """`command` names a run whose log is kept and uploaded to the canonical store (logs/...)."""
    logs.configure()
    settings: Settings = load_settings()
    logs.register_secret(
        settings.r2_secret_access_key.get_secret_value() if settings.r2_secret_access_key else None
    )
    logs.register_secret(settings.r2_access_key_id.get_secret_value() if settings.r2_access_key_id else None)
    clock: Clock = FakeClock(parse_now(now)) if now else SystemClock()
    if dry_run:
        stores, root = dry_run_stores()
        log.info("dry_run_store", path=str(root))
    else:
        stores = stores_from_settings(settings)
    if command is not None:
        _run_log.store = stores.canonical
        key = logs.start_capture(command, SystemClock().now().isoformat())
        log.info("run_log", key=key)
    transport = None
    if fixtures is not None:
        from market_research.testing import FixtureRoutes, FixtureTransport

        transport = FixtureTransport(FixtureRoutes(fixtures))
    return Runtime(settings=settings, clock=clock, stores=stores, transport=transport)


def _upload_log() -> None:
    if _run_log.store is not None:
        logs.upload(_run_log.store)
    _run_log.store = None
    logs.stop_capture()


def _finish(res: RunResult, command: str) -> None:
    log.info("run_summary", command=command, **res.summary())
    _upload_log()
    raise typer.Exit(res.exit_code)


@app.command()
def ingest(
    budget: Annotated[int | None, typer.Option(help="Requests per host for this run (default 400).")] = None,
    source: Annotated[Source | None, typer.Option(help="Only this source.")] = None,
    dry_run: DryRun = False,
    fixtures: Fixtures = None,
    now: Now = None,
) -> None:
    """Fetch what the frontier says is due, within each host's budget."""
    rt = _runtime(dry_run, fixtures, now, command="ingest")
    res = RunResult()
    do_ingest(rt, res, budget=budget, sources={source.value} if source else None)
    _finish(res, "ingest")


@app.command("normalize")
def normalize_cmd(fixtures: Fixtures = None, now: Now = None) -> None:
    """Rebuild the canonical tables from the source records."""
    rt = _runtime(False, fixtures, now, command="normalize")
    do_normalize(rt)
    _finish(RunResult(), "normalize")


@app.command()
def compute(
    no_publish: Annotated[bool, typer.Option("--no-publish", help="Build and validate only.")] = False,
    now: Now = None,
) -> None:
    """Compute every slice, validate it and publish (manifest last)."""
    from market_research.publish import PublishError

    rt = _runtime(False, None, now, command="compute")
    res = RunResult()
    try:
        do_compute(rt, res, publish_it=not no_publish)
    except PublishError:
        res.exit_code = EXIT_FAILURE
    _finish(res, "compute")


@app.command("run-all")
def run_all_cmd(
    budget: Annotated[int | None, typer.Option(help="Requests per host for this run (default 400).")] = None,
    dry_run: DryRun = False,
    fixtures: Fixtures = None,
    now: Now = None,
) -> None:
    """ingest -> normalize -> compute/publish."""
    rt = _runtime(dry_run, fixtures, now, command="run-all")
    _finish(run_all(rt, budget=budget), "run-all")


@app.command("backfill")
def backfill_cmd(
    since: Annotated[
        str | None,
        typer.Option(help="Start date YYYY-MM-DD (default: oldest relevant ban list or 24 months)."),
    ] = None,
    plan_only: Annotated[
        bool, typer.Option("--plan", help="Only list, then print requests and duration per host.")
    ] = False,
    phase: Annotated[int | None, typer.Option(min=1, max=3, help="Run only this phase.")] = None,
    cobra: Annotated[
        list[int] | None,
        typer.Option("--cobra", help="Reload only this Cobra tournament, in full (repeatable)."),
    ] = None,
    abr: Annotated[
        list[int] | None,
        typer.Option("--abr", help="Reload only this AlwaysBeRunning tournament, in full (repeatable)."),
    ] = None,
    dry_run: DryRun = False,
    fixtures: Fixtures = None,
    now: Now = None,
) -> None:
    """Initial load: no per-run budget, newest and biggest first, publishes after each phase; resumable.

    With --cobra/--abr it only reloads those tournaments, then publishes once."""
    if (cobra or abr) and (since or plan_only or phase):
        typer.echo("--cobra/--abr cannot be combined with --since, --plan or --phase.", err=True)
        raise typer.Exit(EXIT_FAILURE)
    if cobra or abr:
        rt = _runtime(dry_run, fixtures, now, command="backfill-reload")
        _finish(reload(rt, cobra_ids=cobra or [], abr_ids=abr or []), "backfill-reload")
    rt = _runtime(dry_run, fixtures, now, command="backfill-plan" if plan_only else "backfill")
    today = rt.clock.now().date()
    start = date.fromisoformat(since) if since else default_since(today, rt.stores)
    if plan_only:
        p = plan(rt, start)
        typer.echo(format_plan(p))
        log.info("backfill_plan", **p)
        _upload_log()
        raise typer.Exit(EXIT_OK)
    _finish(backfill(rt, start, phase=phase), "backfill")


@app.command("import-decks")
def import_decks_cmd(
    file: Annotated[Path, typer.Argument(help="Long-format decklist CSV: name,identity,card,card_count.")],
    cobra: Annotated[int, typer.Option("--cobra", help="The Cobra tournament the decklists belong to.")],
    origin: Annotated[
        str, typer.Option(help="Short label for where the file came from (a-z, 0-9, _ and -).")
    ] = "organiser",
    check: Annotated[bool, typer.Option("--check", help="Only match and report; write nothing.")] = False,
    fixtures: Fixtures = None,
    now: Now = None,
) -> None:
    """Load a tournament's decklists from a file; they take precedence over every crawled source.

    Then normalizes and publishes once (not with --check)."""
    from market_research.imports import ORIGIN

    if not ORIGIN.fullmatch(origin):
        typer.echo("--origin may only use a-z, 0-9, _ and - (at most 32).", err=True)
        raise typer.Exit(EXIT_FAILURE)
    try:
        data = file.read_bytes()
    except OSError as e:
        typer.echo(f"cannot read {file}: {e.strerror}", err=True)
        raise typer.Exit(EXIT_FAILURE) from None
    command = "import-decks-check" if check else "import-decks"
    rt = _runtime(False, fixtures, now, command=command)
    _finish(import_decks(rt, data, cobra_id=cobra, origin=origin, check=check), command)


@app.command()
def report(fixtures: Fixtures = None) -> None:
    """Print the latest published quality report."""
    rt = _runtime(False, fixtures, None)
    stores: Stores = rt.stores
    manifest = stores.published.get_json("manifest.json")
    if not isinstance(manifest, dict):
        typer.echo("No snapshot has been published yet.", err=True)
        raise typer.Exit(EXIT_FAILURE)
    rep = stores.published.get_json(manifest["base_path"] + manifest["paths"]["quality"])
    typer.echo(json.dumps(rep, indent=2, ensure_ascii=False))


@fixtures_app.command("refresh")
def fixtures_refresh(
    cobra: Annotated[int | None, typer.Option(help="Cobra tournament ID.")] = None,
    abr: Annotated[int | None, typer.Option(help="ABR tournament ID.")] = None,
    out: Annotated[Path, typer.Option(help="Output directory for review.")] = Path("tests/fixtures/refresh"),
) -> None:
    """Fetch one tournament live, anonymise it with canaries and write fixture files for review."""
    if (cobra is None) == (abr is None):
        typer.echo("Give exactly one of --cobra or --abr.", err=True)
        raise typer.Exit(EXIT_FAILURE)
    from market_research.fixtures_refresh import refresh

    rt = _runtime(True)
    written = refresh(rt, out, cobra=cobra, abr=abr)
    typer.echo(f"wrote {len(written)} files to {out}; review them before committing")


@breaker_bay_app.command("draft")
def breaker_bay_draft(
    prune: Annotated[
        bool, typer.Option("--prune", help="Also remove entries for cards no longer in the pool.")
    ] = False,
    directory: Annotated[
        Path | None,
        typer.Option("--dir", help="The curated files' directory (default: the package's data/breaker_bay)."),
    ] = None,
    now: Now = None,
) -> None:
    """Draft entries, marked not reviewed, for Standard breakers, ice and support cards the curated
    files don't cover yet. Review each one, then set "reviewed": true."""
    from market_research import breaker_bay
    from market_research.publish import stored_catalog

    rt = _runtime(False, None, now)
    target = directory or breaker_bay.default_dir()
    try:
        cur = breaker_bay.load(target)
    except breaker_bay.CuratedError as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(EXIT_FAILURE) from None
    catalog = stored_catalog(rt.stores, rt.settings)
    snap = catalog.snapshot_at(rt.clock.now().date().isoformat())
    if not catalog.cards or snap is None or not snap.restriction_id:
        typer.echo("No card catalog stored yet: run ingest first.", err=True)
        raise typer.Exit(EXIT_FAILURE)
    pool = breaker_bay.current_pool(catalog, snap.restriction_id)
    entries, rep = breaker_bay.draft(pool, cur, prune=prune)
    if rep.changed():
        breaker_bay.write(target, entries)
    typer.echo(f"pool: {snap.restriction_id} ({len(pool.breakers)} breakers, {len(pool.ice)} ice)")
    for name in breaker_bay.FILES:
        for label, ids in (
            ("drafted", rep.added[name]),
            ("pruned", rep.pruned[name]),
            ("not in the pool (--prune removes)", rep.outside_pool[name]),
        ):
            if ids:
                typer.echo(f"{name}.json {label}: {', '.join(ids)}")
    pending = breaker_bay.Curated(**{n: entries[n] for n in breaker_bay.FILES}).unreviewed()
    typer.echo(f"waiting for review: {len(pending)}" + (f" ({', '.join(pending)})" if pending else ""))
    raise typer.Exit(EXIT_OK)


def main() -> None:
    try:
        app()
    except KeyboardInterrupt:  # pragma: no cover
        sys.exit(EXIT_FAILURE)
    finally:
        _upload_log()  # a run that crashed still leaves its log in R2
