"""Snapshots: compute every slice, validate, upload `v=<version>/` then `manifest.json` last."""

from __future__ import annotations

import json
import operator
import tempfile
from collections import defaultdict
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from functools import cache
from importlib import resources
from pathlib import Path
from typing import Any

import duckdb
import jsonschema

from market_research import breaker_bay, logs
from market_research.catalog import Catalog
from market_research.config import SIDES, Settings, tier_config
from market_research.metrics import (
    BASELINE_COLUMNS,
    CARD_COLUMNS,
    FACTION_COLUMNS,
    IDENTITY_BASELINE_COLUMNS,
    IDENTITY_COLUMNS,
    card_view,
    compute_counts,
    faction_view,
    identity_view,
)
from market_research.normalize import NORMALIZE_QUALITY_KEY, Normalizer, load_sources, load_tables
from market_research.storage import Stores

log = logs.get("market_research.publish")

MAX_SLICE_BYTES = 2 * 1024 * 1024
IMMUTABLE = "public, max-age=31536000, immutable"
MANIFEST_CACHE = "public, max-age=60"
# Concurrent slice uploads; below the R2 client's connection pool (max_pool_connections=32).
UPLOAD_WORKERS = 16
SCHEMAS = {
    "manifest": "mr.manifest/1",
    "summary": "mr.summary/1",
    "trends": "mr.trends/1",
    "identities": "mr.identities/1",
    "catalog": "mr.catalog/1",
    "quality": "mr.quality/1",
    "tournaments": "mr.tournaments/1",
    "breaker_bay": "mr.breaker_bay/1",
}
PATHS = {
    "catalog": "catalog/cards.json",
    "summary": "meta/{side}/{restriction}/{tier_group}/summary.json",
    "trends": "meta/{side}/{restriction}/{tier_group}/trends.json",
    # The same card stats over top-cut decks only (decks that made the cut in events with a cut).
    "summary_cut": "meta/{side}/{restriction}/{tier_group}/cut/summary.json",
    "trends_cut": "meta/{side}/{restriction}/{tier_group}/cut/trends.json",
    # The tournaments a slice counts; the same for both sides.
    "tournaments": "meta/{restriction}/{tier_group}/tournaments.json",
    "identities": "meta/{side}/{restriction}/{tier_group}/identities.json",
    "quality": "quality/report.json",
    # Breaker Bay: the current Standard breakers and ice with the curated cost model.
    "breaker_bay": "breaker-bay/pool.json",
}
ATTRIBUTION = {
    "text": "Tournament results from AlwaysBeRunning.net and NSG Cobra; decklists from NetrunnerDB and NSG Cobra; card data from NetrunnerDB.",
    "links": [
        {"name": "AlwaysBeRunning.net", "url": "https://alwaysberunning.net"},
        {"name": "NSG Cobra", "url": "https://tournaments.nullsignal.games"},
        {"name": "NetrunnerDB", "url": "https://netrunnerdb.com"},
    ],
}
DISCLAIMER = "Fan project, not affiliated with Null Signal Games."


class PublishError(Exception):
    """Validation failed; nothing was published."""


@cache
def schema(name: str) -> dict[str, Any]:
    text = resources.files("market_research").joinpath(f"schemas/{name}.schema.json").read_text("utf-8")
    loaded: dict[str, Any] = json.loads(text)
    return loaded


@cache
def _validator(name: str) -> jsonschema.protocols.Validator:
    s = schema(name)
    cls = jsonschema.validators.validator_for(s)
    cls.check_schema(s)
    return cls(s)


def check(obj: Any, name: str) -> None:
    """Raises what `jsonschema.validate(obj, schema(name))` raises.

    `jsonschema.validate` checks the schema itself and builds a new validator on every call, which
    took most of a publish's validation time over ~170 files; the validator here is built once.
    """
    err = jsonschema.exceptions.best_match(_validator(name).iter_errors(obj))
    if err is not None:
        raise err


def encode(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=False).encode("utf-8")


def version_of(now: datetime) -> str:
    return now.strftime("%Y-%m-%dT%H%M%SZ")


def free_version(stores: Stores, now: datetime) -> str:
    """The first second at or after `now` with no published version, so versions never collide."""
    t = now.replace(microsecond=0)
    while stores.published.exists(f"v={version_of(t)}/{PATHS['catalog']}"):
        t += timedelta(seconds=1)
    return version_of(t)


def add_months(month: str, n: int) -> str:
    y, m = (int(x) for x in month.split("-"))
    idx = y * 12 + (m - 1) + n
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def month_range(a: str, b: str) -> list[str]:
    out = []
    cur = a
    while cur <= b:
        out.append(cur)
        cur = add_months(cur, 1)
    return out


@dataclass
class Snapshot:
    version: str
    files: dict[str, Any]  # path under v=<version>/ -> object
    manifest: dict[str, Any]


Row = tuple[Any, ...]


def _rows(con: duckdb.DuckDBPyConnection, table: str, keys: list[str], cols: list[str]) -> list[Row]:
    sel = ", ".join(keys + [f"CAST({c} AS DOUBLE)" for c in cols])
    return con.execute(f"SELECT {sel} FROM {table} ORDER BY {', '.join(keys)}").fetchall()


def _num(v: Any) -> float | int:
    if isinstance(v, float):
        return int(v) if v.is_integer() else round(v, 4)
    return int(v)


def _trend_row(m: int, ri: int, sums: list[float]) -> list[float | int]:
    """[month index, restriction index, *counts]; `_num` inlined for the float sums (a trends file has
    one per count, millions over a snapshot)."""
    return [m, ri, *[int(x) if x.is_integer() else round(x, 4) for x in sums]]


def _add_into(acc: list[float], row: Row, start: int) -> None:
    """Adds row[start:] to `acc` element-wise (`row` holds exactly len(acc) values from `start`)."""
    acc[:] = map(operator.add, acc, row[start:])


_SLICE_KEYS = ["side", "restriction_id", "tier", "month"]


def _sum_baselines(
    rows: Iterable[Row], cur: set[str], prev: set[str]
) -> tuple[dict[str, float], dict[str, float]]:
    """Side baseline counts summed over the current and the previous period."""
    base_c = dict.fromkeys(BASELINE_COLUMNS, 0.0)
    base_p = dict.fromkeys(BASELINE_COLUMNS, 0.0)
    for r in rows:
        tgt = base_c if r[3] in cur else base_p if r[3] in prev else None
        if tgt is not None:
            for i, col in enumerate(BASELINE_COLUMNS):
                tgt[col] += r[4 + i]
    return base_c, base_p


def _sum_cards(
    rows: Iterable[Row], cur: set[str], prev: set[str]
) -> tuple[dict[str, dict[str, float]], dict[str, dict[str, float]]]:
    """Per-card counts summed over the current and the previous period (cards seen in each only)."""
    per_c: dict[str, dict[str, float]] = defaultdict(lambda: dict.fromkeys(CARD_COLUMNS, 0.0))
    per_p: dict[str, dict[str, float]] = defaultdict(lambda: dict.fromkeys(CARD_COLUMNS, 0.0))
    for r in rows:
        if r[3] in cur or r[3] in prev:
            tgt = per_c[r[4]] if r[3] in cur else per_p[r[4]]
            for i, col in enumerate(CARD_COLUMNS):
                tgt[col] += r[5 + i]
    return per_c, per_p


def _sum_factions(
    rows: Iterable[Row], cur: set[str], prev: set[str]
) -> tuple[dict[str, float], dict[str, float]]:
    """Decks per identity faction summed over the current and the previous period."""
    fac_c: dict[str, float] = defaultdict(float)
    fac_p: dict[str, float] = defaultdict(float)
    for r in rows:
        if r[3] in cur:
            fac_c[r[4]] += r[5]
        elif r[3] in prev:
            fac_p[r[4]] += r[5]
    return dict(fac_c), dict(fac_p)


def _movers(cards: list[dict[str, Any]], n: int = 10) -> tuple[list[str], list[str]]:
    """The `n` cards whose popularity rose most and the `n` that fell most since the previous period."""
    movers = [c for c in cards if c["change_pp"] is not None]
    risers = [
        c["card_id"]
        for c in sorted(movers, key=lambda c: (-c["change_pp"], c["card_id"]))
        if c["change_pp"] > 0
    ][:n]
    fallers = [
        c["card_id"]
        for c in sorted(movers, key=lambda c: (c["change_pp"], c["card_id"]))
        if c["change_pp"] < 0
    ][:n]
    return risers, fallers


def _summary_baseline(base: dict[str, float], factions: dict[str, float]) -> dict[str, Any]:
    """The side baseline a summary's card figures are compared with."""
    wr = base["side_wins"] / base["side_games"] if base["side_games"] else None
    wr_all = base["side_wins_all"] / base["side_games_all"] if base["side_games_all"] else None
    cut = base["side_cut_hc"] / base["side_entries_hc"] if base["side_entries_hc"] else None
    return {
        "decks": int(base["side_decks"]),
        "games": int(base["side_games"]),
        "wins": _num(base["side_wins"]),
        "winrate": round(wr, 4) if wr is not None else None,
        "entries_hc": int(base["side_entries_hc"]),
        "cut_hc": int(base["side_cut_hc"]),
        "cut_rate": round(cut, 4) if cut is not None else None,
        "tournaments": int(base["tournaments"]),
        "tournaments_hc": int(base["tournaments_hc"]),
        "games_all": int(base["side_games_all"]),
        "wins_all": _num(base["side_wins_all"]),
        "winrate_all": round(wr_all, 4) if wr_all is not None else None,
        "faction_decks": {f: int(n) for f, n in sorted(factions.items())},
    }


class SliceIndex:
    """Count rows grouped once by side, then by (restriction, tier), so a slice reads only its rows.

    The rows come from `_rows` ordered by (side, restriction_id, tier, month, ...), so every
    (side, restriction, tier) block is contiguous. `rows()` walks the blocks in that same order,
    which yields exactly the rows a full scan filtered by slice would, in the same order: sums over
    them (floats included) come out bit for bit the same, while a slice costs its own rows instead
    of every row in the table.
    """

    def __init__(self, rows: list[Row]) -> None:
        self.by_side: dict[str, dict[tuple[str, str], list[Row]]] = {}
        block: list[Row] | None = None
        key: tuple[Any, ...] | None = None
        for r in rows:
            if r[:3] != key:
                key = r[:3]
                blocks = self.by_side.setdefault(r[0], {})
                if (r[1], r[2]) in blocks:
                    raise ValueError(f"rows not ordered by side, restriction, tier: {key} seen twice")
                block = blocks[(r[1], r[2])] = []
            assert block is not None
            block.append(r)

    def rows(self, side: str, restriction: str, group: str) -> Iterator[Row]:
        for (r, tier), block in self.by_side.get(side, {}).items():
            if restriction in ("all", r) and group in ("all", tier):
                yield from block


@dataclass(frozen=True)
class Scope:
    """The card and side-baseline rows of one deck scope: every deck, or top-cut decks only."""

    cards: SliceIndex
    base: SliceIndex
    factions: SliceIndex


class SnapshotBuilder:
    def __init__(
        self,
        con: duckdb.DuckDBPyConnection,
        catalog: Catalog,
        settings: Settings,
        now: datetime,
        version: str | None = None,
    ) -> None:
        self.con = con
        self.catalog = catalog
        self.settings = settings
        self.now = now
        self.tiers = tier_config()
        self.version = version or version_of(now)
        compute_counts(con, catalog, settings)
        self.cards = _rows(con, "card_counts", [*_SLICE_KEYS, "card_id"], CARD_COLUMNS)
        self.base = _rows(con, "side_counts", _SLICE_KEYS, BASELINE_COLUMNS)
        cut_cards = _rows(con, "card_counts_cut", [*_SLICE_KEYS, "card_id"], CARD_COLUMNS)
        cut_base = _rows(con, "side_counts_cut", _SLICE_KEYS, BASELINE_COLUMNS)
        fac = _rows(con, "faction_counts", [*_SLICE_KEYS, "faction"], FACTION_COLUMNS)
        cut_fac = _rows(con, "faction_counts_cut", [*_SLICE_KEYS, "faction"], FACTION_COLUMNS)
        self.scopes = {
            "all": Scope(SliceIndex(self.cards), SliceIndex(self.base), SliceIndex(fac)),
            "cut": Scope(SliceIndex(cut_cards), SliceIndex(cut_base), SliceIndex(cut_fac)),
        }
        # Identity factions of the side's decks; every trends file indexes the same list.
        self.factions = sorted({r[4] for r in fac})
        self.idents = SliceIndex(_rows(con, "identity_counts", [*_SLICE_KEYS, "identity"], IDENTITY_COLUMNS))
        self.ibase = SliceIndex(_rows(con, "identity_side_counts", _SLICE_KEYS, IDENTITY_BASELINE_COLUMNS))
        order = {r: i for i, r in enumerate(catalog.standard_restrictions())}
        present = {r[1] for r in self.base}
        self.restrictions = sorted(present, key=lambda r: (order.get(r, 10**6), r))
        self.months = (
            month_range(min(r[3] for r in self.base), max(r[3] for r in self.base)) if self.base else []
        )
        self._month_idx = {m: i for i, m in enumerate(self.months)}
        self._restriction_idx = {r: i for i, r in enumerate(self.restrictions)}
        self._periods: dict[tuple[str, str, str], tuple[list[str], list[str]]] = {}
        self.data_as_of = con.execute("SELECT max(date) FROM tournament").fetchone()
        # The events the counts cover (table t from compute_counts), with what the page lists.
        cur = con.execute(
            """SELECT tn.tid, tn.name, tn.date, t.restriction_id AS restriction, t.tier, tn.type, tn.online,
                      tn.country, tn.players, tn.swiss_format, tn.cut_size, tn.cobra_id, tn.abr_id, tn.has_games,
                      tn.decklist_coverage,
                      (SELECT count(*) FROM deck d WHERE d.tid = tn.tid AND d.legal) AS decklists
               FROM t JOIN tournament tn USING (tid) ORDER BY tn.date DESC, tn.tid"""
        )
        cols = [c[0] for c in cur.description]
        self.events = [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]
        self.groups = [g["id"] for g in self.tiers.groups]

    # ----- slicing -----

    def _period(self, side: str, restriction: str, group: str) -> tuple[list[str], list[str]]:
        """(current, previous) period months of a slice, from every deck (so both scopes align)."""
        key = (side, restriction, group)
        if key not in self._periods:
            base = self.scopes["all"].base.rows(side, restriction, group)
            self._periods[key] = self._period_from({r[3] for r in base if r[4] > 0})
        return self._periods[key]

    def _period_from(self, months: set[str]) -> tuple[list[str], list[str]]:
        if not months:
            return [], []
        to = max(months)
        p = self.settings.thresholds.period_months
        cur = month_range(add_months(to, -(p - 1)), to)
        prev = month_range(add_months(to, -(2 * p - 1)), add_months(to, -p))
        return cur, prev

    def summary(self, side: str, restriction: str, group: str, scope: str = "all") -> dict[str, Any]:
        """The summary for one deck scope; its period is always that of every deck, so both scopes align."""
        cur, prev = self._period(side, restriction, group)
        data = self.scopes[scope]
        cs, ps = set(cur), set(prev)
        base_c, base_p = _sum_baselines(data.base.rows(side, restriction, group), cs, ps)
        per_c, per_p = _sum_cards(data.cards.rows(side, restriction, group), cs, ps)
        fac_c, fac_p = _sum_factions(data.factions.rows(side, restriction, group), cs, ps)
        has_prev = base_p["side_decks"] > 0
        cards = self._ranked_cards(
            per_c, per_p, base_c, base_p if has_prev else None, fac_c, fac_p if has_prev else None
        )
        risers, fallers = _movers(cards)
        return {
            **self._head("summary", side, restriction, group),
            "period": {"from": cur[0], "to": cur[-1]} if cur else None,
            "previous_period": {"from": prev[0], "to": prev[-1]} if has_prev else None,
            "baseline": _summary_baseline(base_c, fac_c),
            "cards": [c for c in cards if c["decks"] > 0 or c["prev_popularity"]],
            "risers": risers,
            "fallers": fallers,
        }

    def _ranked_cards(
        self,
        per_c: dict[str, dict[str, float]],
        per_p: dict[str, dict[str, float]],
        base_c: dict[str, float],
        base_p: dict[str, float] | None,
        fac_c: dict[str, float],
        fac_p: dict[str, float] | None,
    ) -> list[dict[str, Any]]:
        """Every card seen in either period, most-played first; `rank` only for cards played now."""
        empty = dict.fromkeys(CARD_COLUMNS, 0.0)
        cards = []
        for cid in sorted(set(per_c) | set(per_p)):
            prev = per_p.get(cid) if base_p is not None else None
            cur = per_c.get(cid, empty)
            v = card_view(cur, base_c, prev, base_p, self.settings)
            meta = self.catalog.cards.get(cid)
            f = faction_view(
                cur,
                base_c,
                fac_c,
                prev,
                base_p,
                fac_p,
                meta.faction_id if meta else None,
                meta.card_type_id if meta else None,
                self.settings,
            )
            cards.append({"card_id": cid, **v, **f})
        cards.sort(key=lambda c: (-c["decks"], c["card_id"]))
        for i, c in enumerate(cards, start=1):
            c["rank"] = i if c["decks"] > 0 else None
        return cards

    def identities(self, side: str, restriction: str, group: str) -> dict[str, Any]:
        """Identity counts over the slice's current period (the same period as its summary)."""
        cur, _ = self._period(side, restriction, group)
        cs = set(cur)
        base = dict.fromkeys(IDENTITY_BASELINE_COLUMNS, 0.0)
        for r in self.ibase.rows(side, restriction, group):
            if r[3] in cs:
                for i, col in enumerate(IDENTITY_BASELINE_COLUMNS):
                    base[col] += r[4 + i]
        per: dict[str, dict[str, float]] = defaultdict(lambda: dict.fromkeys(IDENTITY_COLUMNS, 0.0))
        for r in self.idents.rows(side, restriction, group):
            if r[3] in cs:
                for i, col in enumerate(IDENTITY_COLUMNS):
                    per[r[4]][col] += r[5 + i]
        rows = [{"card_id": cid, **identity_view(v, base, self.settings)} for cid, v in per.items()]
        rows.sort(key=lambda x: (-x["entries"], x["card_id"]))
        for i, x in enumerate(rows, start=1):
            x["rank"] = i
        base_wr = base["side_wins"] / base["side_games"] if base["side_games"] else None
        base_conv = base["side_cut_made"] / base["side_cut_entries"] if base["side_cut_entries"] else None
        return {
            **self._head("identities", side, restriction, group),
            "period": {"from": cur[0], "to": cur[-1]} if cur else None,
            "baseline": {
                "entries": int(base["side_entries"]),
                "games": int(base["side_games"]),
                "wins": _num(base["side_wins"]),
                "winrate": round(base_wr, 4) if base_wr is not None else None,
                "cut_entries": int(base["side_cut_entries"]),
                "cut_made": int(base["side_cut_made"]),
                "cut_rate": round(base_conv, 4) if base_conv is not None else None,
            },
            "identities": rows,
        }

    def trends(self, side: str, restriction: str, group: str, scope: str = "all") -> dict[str, Any]:
        data = self.scopes[scope]
        m_idx, r_idx = self._month_idx, self._restriction_idx
        base: dict[tuple[int, int], list[float]] = defaultdict(lambda: [0.0] * len(BASELINE_COLUMNS))
        for r in data.base.rows(side, restriction, group):
            _add_into(base[(m_idx[r[3]], r_idx[r[1]])], r, 4)
        cards: dict[str, dict[tuple[int, int], list[float]]] = defaultdict(
            lambda: defaultdict(lambda: [0.0] * len(CARD_COLUMNS))
        )
        for r in data.cards.rows(side, restriction, group):
            _add_into(cards[r[4]][(m_idx[r[3]], r_idx[r[1]])], r, 5)
        f_idx = {f: i for i, f in enumerate(self.factions)}
        fac: dict[tuple[int, int, int], float] = defaultdict(float)
        for r in data.factions.rows(side, restriction, group):
            fac[(m_idx[r[3]], r_idx[r[1]], f_idx[r[4]])] += r[5]
        return {
            **self._head("trends", side, restriction, group),
            "months": self.months,
            "restrictions": self.restrictions,
            "columns": CARD_COLUMNS,
            "baseline_columns": BASELINE_COLUMNS,
            "baseline": [_trend_row(m, ri, v) for (m, ri), v in sorted(base.items()) if any(v)],
            "factions": self.factions,
            "faction_baseline": [[m, ri, fi, int(n)] for (m, ri, fi), n in sorted(fac.items())],
            "cards": {
                cid: [_trend_row(m, ri, v) for (m, ri), v in sorted(rows.items())]
                for cid, rows in sorted(cards.items())
            },
        }

    def tournaments(self, restriction: str, group: str) -> dict[str, Any]:
        rows = [
            {
                **e,
                "date": e["date"].isoformat(),
                "online": bool(e["online"]),
                "has_games": bool(e["has_games"]),
                "decklist_coverage": round(float(e["decklist_coverage"] or 0.0), 4),
                "players": int(e["players"] or 0),
                "cut_size": int(e["cut_size"] or 0),
                "decklists": int(e["decklists"] or 0),
            }
            for e in self.events
            if restriction in ("all", e["restriction"]) and group in ("all", e["tier"])
        ]
        return {
            "schema": SCHEMAS["tournaments"],
            "version": self.version,
            "restriction": restriction,
            "tier_group": group,
            "tournaments": rows,
        }

    def _head(self, kind: str, side: str, restriction: str, group: str) -> dict[str, Any]:
        return {
            "schema": SCHEMAS[kind],
            "version": self.version,
            "side": side,
            "restriction": restriction,
            "tier_group": group,
        }

    # ----- whole snapshot -----

    def catalog_file(self) -> dict[str, Any]:
        cards = []
        for cid in sorted(self.catalog.cards):
            c = self.catalog.cards[cid]
            legal = [r for r in self.restrictions if self.catalog.legal_in(cid, r)]
            if not legal:
                continue
            cards.append(
                {
                    "id": cid,
                    "title": c.title,
                    "side": c.side_id,
                    "type": c.card_type_id,
                    "faction": c.faction_id,
                    "printings": sorted(c.printing_ids),
                    "legal_in": legal,
                    "banned_in": [r for r in self.restrictions if self.catalog.banned_in(cid, r)],
                }
            )
        return {
            "schema": SCHEMAS["catalog"],
            "version": self.version,
            "restrictions": self.restrictions,
            "cards": cards,
        }

    def breaker_bay_file(self, curated: breaker_bay.Curated) -> dict[str, Any]:
        """The pool of the Standard ban list in force at the run, not the newest one with tournaments."""
        snap = self.catalog.snapshot_at(self.now.date().isoformat())
        rid = snap.restriction_id if snap else None
        pool = breaker_bay.current_pool(self.catalog, rid)
        out = breaker_bay.slice_file(pool, curated, self.version, SCHEMAS["breaker_bay"])
        missing = [b["id"] for b in out["breakers"] if b.get("unmodelled") == breaker_bay.NOT_REVIEWED]
        if missing:
            log.warning("breaker_bay_missing_entries", cards=missing)
        return out

    def restriction_list(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = [{"id": "all", "name": "All ban lists", "date_start": None}]
        for r in self.restrictions:
            meta = self.catalog.restrictions.get(r)
            out.append(
                {"id": r, "name": meta.name if meta else r, "date_start": meta.date_start if meta else None}
            )
        return out

    def build(self, quality: dict[str, Any], curated: breaker_bay.Curated | None = None) -> Snapshot:
        files: dict[str, Any] = {PATHS["catalog"]: self.catalog_file()}
        files[PATHS["breaker_bay"]] = self.breaker_bay_file(curated or breaker_bay.Curated())
        for side in SIDES:
            for restriction in ["all", *self.restrictions]:
                for group in ["all", *self.groups]:
                    fmt = {"side": side, "restriction": restriction, "tier_group": group}
                    files[PATHS["summary"].format(**fmt)] = self.summary(side, restriction, group)
                    files[PATHS["identities"].format(**fmt)] = self.identities(side, restriction, group)
                    files[PATHS["trends"].format(**fmt)] = self.trends(side, restriction, group)
                    files[PATHS["summary_cut"].format(**fmt)] = self.summary(side, restriction, group, "cut")
                    files[PATHS["trends_cut"].format(**fmt)] = self.trends(side, restriction, group, "cut")
        for restriction in ["all", *self.restrictions]:
            for group in ["all", *self.groups]:
                fmt = {"restriction": restriction, "tier_group": group}
                files[PATHS["tournaments"].format(**fmt)] = self.tournaments(restriction, group)
        files[PATHS["quality"]] = {"schema": SCHEMAS["quality"], "version": self.version, **quality}
        as_of = self.data_as_of[0] if self.data_as_of else None
        manifest = {
            "schema": SCHEMAS["manifest"],
            "version": self.version,
            "base_path": f"v={self.version}/",
            "generated_at": self.now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "data_as_of": as_of.isoformat() if isinstance(as_of, date) else None,
            "formats": ["standard"],
            "sides": list(SIDES),
            "restrictions": self.restriction_list(),
            "tier_groups": [{"id": "all", "name": "All tiers"}, *self.tiers.groups],
            "months": self.months,
            "period_months": self.settings.thresholds.period_months,
            "thresholds": {
                "min_games": self.settings.thresholds.min_games,
                "min_entries": self.settings.thresholds.min_entries,
                "min_splash_decks": self.settings.thresholds.min_splash_decks,
                "coverage_hc": self.settings.thresholds.coverage_hc,
                "min_players": self.settings.thresholds.min_players,
            },
            "paths": PATHS,
            "schemas": SCHEMAS,
            "attribution": ATTRIBUTION,
            "disclaimer": DISCLAIMER,
        }
        return Snapshot(self.version, files, manifest)


def quality_report(
    stores: Stores, con: duckdb.DuckDBPyConnection, norm_q: dict[str, Any], settings: Settings
) -> dict[str, Any]:
    ingest_q = stores.canonical.get_json("state/ingest_quality.json") or {}
    one = con.execute(
        """SELECT count(*), count(*) FILTER (WHERE has_games), count(*) FILTER (WHERE decklist_coverage >= ? AND cut_size > 0),
                  coalesce(round(avg(decklist_coverage), 4), 0)
           FROM tournament""",
        [settings.thresholds.coverage_hc],
    ).fetchone()
    assert one is not None
    decks = con.execute("SELECT count(*), count(*) FILTER (WHERE legal) FROM deck").fetchone()
    assert decks is not None
    by_source = dict(con.execute("SELECT source, count(*) FROM deck GROUP BY 1 ORDER BY 1").fetchall())
    entries = con.execute("SELECT count(*) FROM entry").fetchone()
    games = con.execute("SELECT count(*) FROM game").fetchone()
    return {
        "coverage": {
            "tournaments": one[0],
            "tournaments_with_games": one[1],
            "tournaments_high_coverage": one[2],
            "mean_decklist_coverage": float(one[3]),
            "entries": entries[0] if entries else 0,
            "games": games[0] if games else 0,
            "decks": decks[0],
            "legal_decks": decks[1],
            "illegal_decks": decks[0] - decks[1],
            "decks_by_source": by_source,
            "deck_comparison": norm_q.get("deck_comparison", {}),
        },
        "unresolved_cards": norm_q.get("unresolved_cards", {}),
        "unresolved_identities": norm_q.get("unresolved_identities", {}),
        "parser_failures": ingest_q.get("quarantine", []),
        "link_mismatches": norm_q.get("link_mismatches", []),
        "links": norm_q.get("links", []),
        "drift_warnings": ingest_q.get("drift", {}),
        "rejected_deck_refs": int(
            ingest_q.get("rejected_deck_refs_total", ingest_q.get("rejected_deck_refs", 0))
        ),
        "skipped_tournaments": norm_q.get("skipped_tournaments", {}),
        "restriction_overrides": norm_q.get("restriction_overrides", []),
    }


def validate(snap: Snapshot, con: duckdb.DuckDBPyConnection) -> list[str]:
    errors: list[str] = []
    kinds = {
        "catalog": "catalog",
        "summary": "summary",
        "trends": "trends",
        "identities": "identities",
        "report": "quality",
        "tournaments": "tournaments",
        "pool": "breaker_bay",
    }
    known = {c["id"] for c in snap.files[PATHS["catalog"]]["cards"]}
    for path, obj in sorted(snap.files.items()):
        name = path.rsplit("/", 1)[1].removesuffix(".json")
        kind = kinds["catalog" if path == PATHS["catalog"] else name]
        try:
            check(obj, kind)
        except jsonschema.ValidationError as e:
            errors.append(f"{path}: {e.message[:200]}")
        size = len(encode(obj))
        if size > MAX_SLICE_BYTES:
            errors.append(f"{path}: {size} bytes exceeds the 2 MB slice limit")
        ids: set[str] = set()
        if kind == "summary":
            ids = {c["card_id"] for c in obj["cards"]} | set(obj["risers"]) | set(obj["fallers"])
        elif kind == "identities":
            ids = {c["card_id"] for c in obj["identities"]}
        elif kind == "trends":
            ids = set(obj["cards"])
        elif kind in ("tournaments", "breaker_bay"):
            # Breaker Bay lists the ban list in force, which may have no tournaments in the catalog file yet.
            ids = set()
        missing = ids - known
        if missing:
            errors.append(f"{path}: card ids not in the catalog: {sorted(missing)[:5]}")
    try:
        check(snap.manifest, "manifest")
    except jsonschema.ValidationError as e:
        errors.append(f"manifest.json: {e.message[:200]}")
    # Totals in the published slices must match the canonical tables.
    listed = len(snap.files[PATHS["tournaments"].format(restriction="all", tier_group="all")]["tournaments"])
    row = con.execute("SELECT count(*) FROM t").fetchone()
    if listed != (row[0] if row else 0):
        errors.append(f"tournaments listed {listed} != counted {row[0] if row else 0}")
    for side in SIDES:
        tr = snap.files[PATHS["trends"].format(side=side, restriction="all", tier_group="all")]
        pub = sum(row[2] for row in tr["baseline"])
        row = con.execute("SELECT count(*) FROM d WHERE side = ?", [side]).fetchone()
        canon = row[0] if row else 0
        if pub != canon:
            errors.append(f"{side}: published decks {pub} != canonical {canon}")
        games = sum(row[3] for row in tr["baseline"])
        row = con.execute("SELECT count(*) FROM dg WHERE side = ?", [side]).fetchone()
        if games != (row[0] if row else 0):
            errors.append(f"{side}: published games {games} != canonical")
        cut = snap.files[PATHS["trends_cut"].format(side=side, restriction="all", tier_group="all")]
        row = con.execute("SELECT count(*) FROM d_cut WHERE side = ?", [side]).fetchone()
        if sum(r[2] for r in cut["baseline"]) != (row[0] if row else 0):
            errors.append(f"{side}: published top-cut decks != canonical")
        for scope, t, table in (("", tr, "d"), ("top-cut ", cut, "d_cut")):
            # Every deck is counted under its identity's faction (none is left without one), and a
            # card's in-faction decks are some of its decks.
            pub_f: dict[str, int] = defaultdict(int)
            for r in t["faction_baseline"]:
                pub_f[t["factions"][r[2]]] += r[3]
            canon_f = dict(
                con.execute(
                    f"SELECT id_faction, count(*) FROM {table} WHERE side = ? GROUP BY 1", [side]
                ).fetchall()
            )
            if dict(pub_f) != canon_f:
                errors.append(
                    f"{side}: published {scope}decks per identity faction {dict(pub_f)} != canonical {canon_f}"
                )
            i_all, i_in = (
                2 + CARD_COLUMNS.index("decks_with_card"),
                2 + CARD_COLUMNS.index("decks_in_faction"),
            )
            over = sorted(cid for cid, rows in t["cards"].items() if any(r[i_in] > r[i_all] for r in rows))
            if over:
                errors.append(f"{side}: {scope}in-faction decks exceed decks with the card: {over[:5]}")
    return errors


def load_curated(directory: Path | None = None) -> tuple[breaker_bay.Curated, list[str]]:
    """The Breaker Bay files, and the errors that stop publishing: a file that breaks the format, or
    an entry not reviewed yet (a draft must never reach the site)."""
    try:
        cur = breaker_bay.load(directory)
    except breaker_bay.CuratedError as e:
        return breaker_bay.Curated(), [f"breaker-bay: {e}"]
    pending = cur.unreviewed()
    return cur, [f"breaker-bay: not reviewed: {', '.join(pending)}"] if pending else []


def stored_catalog(stores: Stores, settings: Settings) -> Catalog:
    sources_catalog = {
        k: v
        for k, v in load_sources(stores.source, stores.canonical).items()
        if k.startswith("nrdb/catalog/")
    }
    return Normalizer(sources_catalog, settings).catalog


def build(stores: Stores, settings: Settings, now: datetime) -> tuple[Snapshot, list[str]]:
    catalog = stored_catalog(stores, settings)
    with tempfile.TemporaryDirectory() as tmp:
        con = duckdb.connect()
        try:
            load_tables(stores.canonical, con, tmp)
            norm_q = stores.canonical.get_json(NORMALIZE_QUALITY_KEY) or {}
            builder = SnapshotBuilder(con, catalog, settings, now, free_version(stores, now))
            curated, curated_errors = load_curated()
            snap = builder.build(quality_report(stores, con, norm_q, settings), curated)
            errors = curated_errors + validate(snap, con)
        finally:
            con.close()
    return snap, errors


def publish(stores: Stores, snap: Snapshot, errors: list[str], *, workers: int = UPLOAD_WORKERS) -> int:
    """Uploads the version, then the manifest. Returns the number of slice files published.

    The `v=<version>/` files go up concurrently (`workers` at a time); the manifest only once every
    one of them is stored, so readers never see a manifest pointing at a partial version. If any
    upload fails, the rest are cancelled, the error propagates and the manifest is left as it was.
    """
    if errors:
        for e in errors[:20]:
            log.error("snapshot_invalid", error=e)
        raise PublishError(f"{len(errors)} validation errors; nothing published")
    prefix = f"v={snap.version}/"

    def upload(path: str) -> None:
        stores.published.put(
            prefix + path, encode(snap.files[path]), content_type="application/json", cache_control=IMMUTABLE
        )

    _upload_all(upload, sorted(snap.files), workers)
    stores.published.put(
        "manifest.json", encode(snap.manifest), content_type="application/json", cache_control=MANIFEST_CACHE
    )
    log.info("published", version=snap.version, files=len(snap.files))
    return len(snap.files)


def _upload_all(upload: Callable[[str], None], paths: list[str], workers: int) -> None:
    """Runs `upload` for every path on a bounded pool; raises the first failure once the pool is idle."""
    with ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="publish") as pool:
        futures = [pool.submit(upload, p) for p in paths]
        done, pending = wait(futures, return_when=FIRST_EXCEPTION)
        failed = [f for f in done if f.exception() is not None]
        if failed:
            for f in pending:
                f.cancel()
    if failed:
        log.error("upload_failed", failed=len(failed), cancelled=len(pending))
        exc = failed[0].exception()
        assert exc is not None
        raise exc
