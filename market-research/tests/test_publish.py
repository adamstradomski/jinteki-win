from __future__ import annotations

import copy
import json
import shutil
import threading
import time
from dataclasses import replace
from pathlib import Path

import duckdb
import jsonschema
import pytest

from market_research import publish as publish_module
from market_research.metrics import compute_counts
from market_research.normalize import Normalizer, load_sources, load_tables
from market_research.publish import (
    IMMUTABLE,
    MANIFEST_CACHE,
    PATHS,
    PublishError,
    build,
    check,
    encode,
    publish,
    schema,
    validate,
)
from market_research.storage import LocalObjectStore

DOCS = Path(__file__).resolve().parents[2] / "docs" / "market-research" / "snapshot-contract"


@pytest.fixture(scope="module")
def snapshot(fixture_run, tmp_path_factory):
    """One snapshot built from the shared fixture run; tests get a copy through `built`."""
    env, _, _, _ = fixture_run
    stores = replace(env.stores, published=LocalObjectStore(tmp_path_factory.mktemp("published")))
    return build(stores, env.settings, env.clock.now())


@pytest.fixture
def built(fixture_run, snapshot, tmp_path):
    """(stores with an empty published store, a copy of the snapshot, its validation errors)."""
    env, _, _, _ = fixture_run
    stores = replace(env.stores, published=LocalObjectStore(tmp_path / "published"))
    snap, errors = copy.deepcopy(snapshot)
    return stores, snap, errors


def test_snapshot_is_valid(built):
    _, snap, errors = built
    assert errors == []
    names = {
        "catalog": "catalog",
        "summary": "summary",
        "trends": "trends",
        "identities": "identities",
        "report": "quality",
        "tournaments": "tournaments",
        "pool": "breaker_bay",
    }
    for path, obj in snap.files.items():
        kind = "catalog" if path == PATHS["catalog"] else names[path.rsplit("/", 1)[1][:-5]]
        check(obj, kind)
        assert obj["schema"].startswith("mr.")
    check(snap.manifest, "manifest")


def test_every_slice_path_exists_and_is_deterministic(built):
    _, snap, _ = built
    m = snap.manifest
    for side in m["sides"]:
        for r in m["restrictions"]:
            for g in m["tier_groups"]:
                for kind in ("summary", "trends", "identities", "summary_cut", "trends_cut"):
                    path = m["paths"][kind].format(side=side, restriction=r["id"], tier_group=g["id"])
                    assert path in snap.files, path
    for r in m["restrictions"]:
        for g in m["tier_groups"]:
            assert m["paths"]["tournaments"].format(restriction=r["id"], tier_group=g["id"]) in snap.files
    expected = (
        2 * len(m["restrictions"]) * len(m["tier_groups"]) * 5
        + len(m["restrictions"]) * len(m["tier_groups"])
        + 3  # catalog, quality report, Breaker Bay
    )
    assert len(snap.files) == expected
    assert m["base_path"] == f"v={m['version']}/"


def test_manifest_written_last_with_cache_headers(built):
    stores, snap, errors = built
    publish(stores, snap, errors)
    pub = stores.published
    assert pub.puts[-1] == "manifest.json"  # type: ignore[attr-defined]
    assert pub.head("manifest.json").cache_control == MANIFEST_CACHE == "public, max-age=60"
    for key in pub.puts[:-1]:  # type: ignore[attr-defined]
        assert key.startswith(snap.manifest["base_path"])
        obj = pub.head(key)
        assert obj.cache_control == IMMUTABLE == "public, max-age=31536000, immutable"
        assert obj.content_type == "application/json"


def test_invalid_snapshot_publishes_nothing(built):
    stores, snap, _ = built
    old = b'{"schema":"mr.manifest/1","version":"old"}'
    stores.published.put("manifest.json", old, cache_control=MANIFEST_CACHE)
    stores.published.puts.clear()  # type: ignore[attr-defined]
    bad = snap.files[PATHS["summary"].format(side="corp", restriction="all", tier_group="all")]
    bad["cards"].append({"card_id": "NOT A CARD"})
    with pytest.raises(PublishError):
        publish(stores, snap, ["forced"])
    assert stores.published.puts == []  # type: ignore[attr-defined]
    assert stores.published.get("manifest.json") == old


@pytest.fixture(scope="module")
def counted(fixture_run, tmp_path_factory):
    """The canonical tables and their counts in DuckDB, which validate() checks the totals against."""
    env, _, _, _ = fixture_run
    con = duckdb.connect()
    load_tables(env.stores.canonical, con, str(tmp_path_factory.mktemp("tables")))
    src = {
        k: v
        for k, v in load_sources(env.stores.source, env.stores.canonical).items()
        if k.startswith("nrdb/catalog/")
    }
    compute_counts(con, Normalizer(src, env.settings).catalog, env.settings)
    yield con
    con.close()


ALL = {"restriction": "all", "tier_group": "all"}
# The files validate() checks totals in, plus the headline summaries: validating these instead of
# all ~170 files keeps each case below fast (schema checks dominate validate()).
CROSS_CHECKED = [
    PATHS["catalog"],
    PATHS["tournaments"].format(**ALL),
    *(
        PATHS[k].format(side=side, **ALL)
        for k in ("summary", "trends", "trends_cut")
        for side in ("corp", "runner")
    ),
]


@pytest.fixture
def slim(snapshot):
    """A copy of the snapshot with only the CROSS_CHECKED files."""
    snap, _ = snapshot
    return replace(
        snap,
        files=copy.deepcopy({p: snap.files[p] for p in CROSS_CHECKED}),
        manifest=copy.deepcopy(snap.manifest),
    )


def test_validation_passes_the_built_snapshot(snapshot, slim, counted):
    _, errors = snapshot
    assert errors == validate(slim, counted) == []


def _bump_baseline(kind: str, col: int):
    def edit(snap):
        snap.files[PATHS[kind].format(side="runner", **ALL)]["baseline"][0][col] += 1

    return edit


def _bump_faction(kind: str):
    def edit(snap):
        snap.files[PATHS[kind].format(side="runner", **ALL)]["faction_baseline"][0][3] += 1

    return edit


def _in_faction_over_decks(snap):
    t = snap.files[PATHS["trends"].format(side="corp", **ALL)]
    _cid, rows = next((c, r) for c, r in sorted(t["cards"].items()) if r[0][2] > 0)
    rows[0][-1] = rows[0][2] + 1


def _drop_tournament(snap):
    snap.files[PATHS["tournaments"].format(**ALL)]["tournaments"].pop()


def _schema(snap):
    snap.files[PATHS["summary"].format(side="corp", **ALL)]["schema"] = "mr.summary/2"


def _manifest(snap):
    snap.manifest["version"] = 5


def _unknown_card(snap):
    snap.files[PATHS["summary"].format(side="corp", **ALL)]["cards"][0]["card_id"] = "made_up_card"


@pytest.mark.parametrize(
    ("edit", "error"),
    [
        (_schema, "meta/corp/all/all/summary.json: 'mr.summary/1' was expected"),
        (_manifest, "manifest.json: 5 is not of type 'string'"),
        (_unknown_card, "meta/corp/all/all/summary.json: card ids not in the catalog: ['made_up_card']"),
        (_drop_tournament, "tournaments listed "),
        (_bump_baseline("trends", 2), "runner: published decks "),
        (_bump_baseline("trends", 3), "runner: published games "),
        (_bump_baseline("trends_cut", 2), "runner: published top-cut decks != canonical"),
        (_bump_faction("trends"), "runner: published decks per identity faction "),
        (_bump_faction("trends_cut"), "runner: published top-cut decks per identity faction "),
        (_in_faction_over_decks, "corp: in-faction decks exceed decks with the card: "),
    ],
)
def test_validation_reports_each_problem(slim, counted, edit, error):
    edit(slim)
    errors = validate(slim, counted)
    assert [e for e in errors if e.startswith(error)] == errors != [], errors


def test_validation_reports_a_slice_over_the_size_limit(slim, counted, monkeypatch):
    # A limit just under the largest file's size, instead of growing a file past 2 MB (which the
    # schema check then walks for seconds).
    sizes = {path: len(encode(obj)) for path, obj in slim.files.items()}
    second, largest = sorted(sizes.values())[-2:]
    assert largest > second
    monkeypatch.setattr(publish_module, "MAX_SLICE_BYTES", second)
    path = max(sizes, key=sizes.__getitem__)
    assert validate(slim, counted) == [f"{path}: {largest} bytes exceeds the 2 MB slice limit"]


def test_only_catalog_titles_and_numbers(built):
    _, snap, _ = built
    catalog = snap.files[PATHS["catalog"]]
    titles = {c["title"] for c in catalog["cards"]}
    for path, obj in snap.files.items():
        if path == PATHS["catalog"]:
            continue
        for s in _strings(obj):
            assert len(s) <= 160, (path, s)
            assert ("<" not in s and ">" not in s) or s in titles


def _strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for k, v in o.items():
            yield k
            yield from _strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from _strings(v)


def test_docs_contract_matches_package_schemas():
    for name in (
        "manifest",
        "summary",
        "trends",
        "identities",
        "catalog",
        "quality",
        "tournaments",
        "breaker_bay",
    ):
        doc = json.loads((DOCS / f"{name}.schema.json").read_text())
        assert doc == schema(name), name
    for ex in sorted(DOCS.glob("examples/*.json")):
        obj = json.loads(ex.read_text())
        kind = ex.stem.split(".")[0]
        check(obj, kind)


def test_catalog_contains_only_standard_legal_cards(built):
    _, snap, _ = built
    cat = snap.files[PATHS["catalog"]]
    ids = {c["id"] for c in cat["cards"]}
    assert "account_siphon" not in ids  # rotated out of Standard
    assert "hedge_fund" in ids
    assert all(c["legal_in"] for c in cat["cards"])
    rlc = next(c for c in cat["cards"] if c["id"] == "red_level_clearance")
    assert rlc["legal_in"] == ["standard_ban_list_26_05"]
    assert rlc["banned_in"] == ["standard_balance_update_26_08"]


def test_check_raises_what_jsonschema_validate_raises():
    manifest = json.loads((DOCS / "examples" / "manifest.example.json").read_text())
    check(manifest, "manifest")
    del manifest["version"]
    manifest["generated_at"] = 5
    with pytest.raises(jsonschema.ValidationError) as ours:
        check(manifest, "manifest")
    with pytest.raises(jsonschema.ValidationError) as theirs:
        jsonschema.validate(manifest, schema("manifest"))
    assert (ours.value.message, list(ours.value.path)) == (theirs.value.message, list(theirs.value.path))


class SlowStore(LocalObjectStore):
    """A local bucket whose puts take a moment and can fail for one key; records how many overlap."""

    def __init__(self, root: Path, fail: str | None = None) -> None:
        super().__init__(root)
        self.fail = fail
        self.in_flight = 0
        self.max_in_flight = 0
        self.threads: set[str] = set()
        self._count = threading.Lock()

    def put(self, key, body, *, content_type="application/json", cache_control=None):
        with self._count:
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
            self.threads.add(threading.current_thread().name)
        try:
            time.sleep(0.002)
            if key == self.fail:
                raise OSError(f"upload of {key} failed")
            super().put(key, body, content_type=content_type, cache_control=cache_control)
        finally:
            with self._count:
                self.in_flight -= 1


def test_publish_uploads_concurrently_and_manifest_last(built, tmp_path):
    stores, snap, errors = built
    store = SlowStore(tmp_path / "slow")
    n = publish(replace(stores, published=store), snap, errors, workers=8)
    assert n == len(snap.files)
    assert store.max_in_flight > 1  # the slice files really went up in parallel
    assert 1 < len(store.threads) <= 9  # at most 8 workers, plus the caller for the manifest
    assert store.puts[-1] == "manifest.json"
    assert store.puts.count("manifest.json") == 1
    prefix = snap.manifest["base_path"]
    assert sorted(store.puts[:-1]) == sorted(prefix + p for p in snap.files)
    for path, obj in snap.files.items():
        assert store.get(prefix + path) == encode(obj)
        assert store.head(prefix + path).cache_control == IMMUTABLE


def test_failed_upload_raises_and_keeps_the_old_manifest(built, tmp_path):
    stores, snap, errors = built
    bad = snap.manifest["base_path"] + PATHS["summary"].format(
        side="runner", restriction="all", tier_group="all"
    )
    store = SlowStore(tmp_path / "slow", fail=bad)
    old = b'{"schema":"mr.manifest/1","version":"old"}'
    store.put("manifest.json", old, cache_control=MANIFEST_CACHE)
    store.puts.clear()
    with pytest.raises(OSError, match="failed"):
        publish(replace(stores, published=store), snap, errors, workers=4)
    assert "manifest.json" not in store.puts
    assert store.get("manifest.json") == old
    assert bad not in store.puts


def test_an_unreviewed_breaker_bay_entry_stops_publishing(fixture_run, tmp_path, monkeypatch):
    from market_research import breaker_bay

    env, _, _, _ = fixture_run
    stores = replace(env.stores, published=LocalObjectStore(tmp_path / "published"))
    cur = tmp_path / "curated"
    shutil.copytree(breaker_bay.default_dir(), cur)
    raw = json.loads((cur / "breakers.json").read_text("utf-8"))
    raw["cards"]["corsair"]["reviewed"] = False
    (cur / "breakers.json").write_text(json.dumps(raw), "utf-8")
    monkeypatch.setattr(breaker_bay, "default_dir", lambda: cur)
    snap, errors = build(stores, env.settings, env.clock.now())
    assert errors == ["breaker-bay: not reviewed: breakers:corsair"]
    with pytest.raises(PublishError):
        publish(stores, snap, errors)
    assert not stores.published.exists("manifest.json")
