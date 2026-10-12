"""End to end: run-all over the fixtures (served by respx) reproduces the golden snapshot."""

from __future__ import annotations

import gzip
import json
import os
import random
import shutil

import httpx
import pytest
import respx
from typer.testing import CliRunner

from helpers import EXPECTED, HTTP, all_files, assert_no_canary, make_env
from market_research.cli import app
from market_research.runner import EXIT_OK, EXIT_PARTIAL, Runtime, run_all
from market_research.testing import FixtureRoutes

UPDATE = os.environ.get("MR_UPDATE_GOLDEN") == "1"
GOLDEN = EXPECTED / "snapshot"


@pytest.fixture
def served():
    routes = FixtureRoutes(HTTP)
    with respx.mock(assert_all_called=False) as m:
        m.route().mock(side_effect=routes.respond)
        yield routes


def runtime(env) -> Runtime:
    return Runtime(
        settings=env.settings, clock=env.clock, stores=env.stores, rng=random.Random(7), parallel=False
    )


def published_tree(env) -> dict[str, bytes]:
    root = env.stores.published.root
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in all_files(root) if ".meta" not in p.parts}


def test_run_all_reproduces_golden_snapshot(tmp_path, clock, served):
    env = make_env(tmp_path, clock)
    res = run_all(runtime(env))
    assert res.exit_code == EXIT_OK
    assert res.slices_published == 168
    got = published_tree(env)
    if UPDATE:
        shutil.rmtree(GOLDEN, ignore_errors=True)
        for rel, body in got.items():
            p = GOLDEN / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body)
    expected = {p.relative_to(GOLDEN).as_posix(): p.read_bytes() for p in all_files(GOLDEN)}
    assert sorted(got) == sorted(expected)
    for rel in got:
        assert got[rel] == expected[rel], rel  # byte for byte
    assert_no_canary(env.root, env.log.getvalue())


def test_partial_exit_code_when_a_host_trips(tmp_path, clock, served):
    env = make_env(tmp_path, clock)
    for r in list(served.routes.values()):
        if r["url"].startswith("https://alwaysberunning.net/api"):
            served.override(r["url"], httpx.Response(503))
    res = run_all(runtime(env))
    assert res.exit_code == EXIT_PARTIAL and res.tripped == ["abr"]
    assert env.stores.published.exists("manifest.json")  # still published


def test_cli_run_all_dry_run_with_fixtures(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTACT", "ops@example.invalid")
    result = CliRunner().invoke(
        app, ["run-all", "--dry-run", "--fixtures", str(HTTP), "--now", "2026-09-27T04:00:00Z"]
    )
    assert result.exit_code == 0, result.output
    lines = [json.loads(line) for line in result.output.splitlines() if line.startswith("{")]
    summary = next(x for x in lines if x["event"] == "run_summary")
    assert summary["slices_published"] == 168 and summary["exit_code"] == 0
    assert set(summary["requests"]) == {"abr", "cobra", "nrdb"}
    path = next(x for x in lines if x["event"] == "dry_run_store")["path"]
    assert os.path.exists(os.path.join(path, "mr-published", "manifest.json"))
    shutil.rmtree(path)


def test_cli_report(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTACT", "ops@example.invalid")
    monkeypatch.setenv("MR_LOCAL_STORE", str(tmp_path / "store"))
    r = CliRunner().invoke(app, ["report"])
    assert r.exit_code == 1
    r = CliRunner().invoke(app, ["run-all", "--fixtures", str(HTTP), "--now", "2026-09-27T04:00:00Z"])
    assert r.exit_code == 0
    r = CliRunner().invoke(app, ["report"])
    assert r.exit_code == 0 and '"schema": "mr.quality/1"' in r.output
    r = CliRunner().invoke(app, ["normalize"])
    assert r.exit_code == 0
    r = CliRunner().invoke(app, ["compute", "--no-publish", "--now", "2026-09-28T04:00:00Z"])
    assert r.exit_code == 0
    r = CliRunner().invoke(
        app,
        [
            "ingest",
            "--source",
            "abr",
            "--budget",
            "3",
            "--fixtures",
            str(HTTP),
            "--now",
            "2026-09-28T04:00:00Z",
        ],
    )
    assert r.exit_code == 0
    r = CliRunner().invoke(app, ["fixtures", "refresh"])
    assert r.exit_code == 1


SECRET, KEY_ID = "super-secret-value-123", "key-id-456"


@pytest.fixture(scope="module")
def cli_run(tmp_path_factory):
    """One `run-all` through the CLI into a local store, with R2 credentials set. Tests only read it."""
    store = tmp_path_factory.mktemp("cli") / "store"
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("CONTACT", "ops@example.invalid")
        mp.setenv("MR_LOCAL_STORE", str(store))
        mp.setenv("R2_SECRET_ACCESS_KEY", SECRET)
        mp.setenv("R2_ACCESS_KEY_ID", KEY_ID)
        r = CliRunner().invoke(app, ["run-all", "--fixtures", str(HTTP), "--now", "2026-09-27T04:00:00Z"])
    assert r.exit_code == 0, r.output
    return store, r.output


def test_secrets_are_never_logged(cli_run):
    store, output = cli_run
    assert SECRET not in output and KEY_ID not in output
    uploaded = b"".join(gzip.decompress(p.read_bytes()) for p in store.rglob("*.jsonl.gz"))
    assert uploaded and SECRET.encode() not in uploaded and KEY_ID.encode() not in uploaded


def test_run_log_is_uploaded_to_canonical_store(cli_run, monkeypatch):
    store, output = cli_run
    lines = [json.loads(line) for line in output.splitlines() if line.startswith("{")]
    key = next(x for x in lines if x["event"] == "run_log")["key"]
    assert key.startswith("logs/") and key.endswith("-run-all.jsonl.gz")
    stored = store / "mr-canonical" / key
    events = [json.loads(line)["event"] for line in gzip.decompress(stored.read_bytes()).splitlines()]
    assert events[0] == "run_log" and events[-1] == "run_summary"
    monkeypatch.setenv("CONTACT", "ops@example.invalid")
    monkeypatch.setenv("MR_LOCAL_STORE", str(store))
    CliRunner().invoke(app, ["report"])
    assert len(list(store.rglob("*.jsonl.gz"))) == 1  # read-only commands keep no log
