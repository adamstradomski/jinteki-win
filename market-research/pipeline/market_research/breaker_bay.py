"""Breaker Bay: the cost-to-break data, from the NRDB catalog and the hand-curated files.

The curated files live in data/breaker_bay/ (breakers.json, ice.json, support.json); their format is
docs/breaker-bay/data-format.md. `slice_file` joins them with the current Standard pool into the
snapshot's breaker-bay/pool.json; `draft` proposes entries for cards the files don't cover yet.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from market_research.catalog import Catalog
from market_research.records import CatCard

IceType = Literal["barrier", "code_gate", "sentry"]
ICE_TYPES: tuple[IceType, ...] = ("barrier", "code_gate", "sentry")
# The icebreaker subtype that interfaces with each ice type; AI interfaces with all of them.
BREAKER_TYPES: dict[str, IceType] = {"fracter": "barrier", "decoder": "code_gate", "killer": "sentry"}
FILES = ("breakers", "ice", "support")
FILE_SCHEMAS = {"breakers": "bb.breakers/1", "ice": "bb.ice/1", "support": "bb.support/1"}
NOT_REVIEWED = "Not reviewed yet: no entry in breakers.json."
# pydantic validates patterns with Rust regex, where $ matches only at the very end (no newline).
Slug = Annotated[str, Field(pattern=r"^[a-z0-9_]{1,64}$")]


class CuratedError(Exception):
    """A curated file can't be read or breaks the format."""


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Step(_Model):
    """add, once the param reaches at (Pharos: +5 strength at 3 or more advancement counters)."""

    param: Slug
    at: int
    add: int


class Expr(_Model):
    """base + sum(param value × times) + the steps reached, floored at min when given."""

    base: int = 0
    per: dict[Slug, int] = {}
    steps: list[Step] = []
    min: int | None = None


Amount = int | Expr


def params_of(a: Amount | Literal["X"] | None) -> set[str]:
    return set(a.per) | {s.param for s in a.steps} if isinstance(a, Expr) else set()


class Param(_Model):
    label: str = Field(min_length=1, max_length=80)
    default: int
    min: int = 0
    max: int
    kind: Literal["count", "flag"] = "count"

    @model_validator(mode="after")
    def _range(self) -> Self:
        if not self.min <= self.default <= self.max:
            raise ValueError("default must be within min..max")
        if self.kind == "flag" and (self.min, self.max) != (0, 1):
            raise ValueError("a flag goes from 0 to 1")
        return self


class Spend(_Model):
    """Hosted counters (or other countable things) an ability uses up, from a param."""

    param: Slug
    n: int = Field(1, ge=1)


ACTIONS = ("break", "pump", "weaken", "bypass", "rebate")


class Ability(_Model):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    break_: int | Literal["any", "X"] | None = Field(None, alias="break")
    pump: Amount | None = None
    weaken: Amount | None = None
    bypass: bool | None = None
    rebate: Amount | None = None
    cost: Amount | Literal["X"] = 0
    spend: Spend | None = None
    only: list[IceType] | None = None
    once: Literal["encounter", "run", "turn"] | None = None

    @model_validator(mode="after")
    def _one_action(self) -> Self:
        set_ = [a for a in ACTIONS if getattr(self, "break_" if a == "break" else a) is not None]
        if len(set_) != 1:
            raise ValueError(f"an ability has exactly one of {', '.join(ACTIONS)}")
        if self.bypass is False:
            raise ValueError("bypass is true or absent")
        if isinstance(self.break_, int) and self.break_ < 1:
            raise ValueError("break at least 1 subroutine")
        if (self.break_ == "X") != (self.cost == "X"):
            raise ValueError('"break": "X" goes with "cost": "X"')
        return self

    def params(self) -> set[str]:
        out = params_of(self.pump) | params_of(self.weaken) | params_of(self.rebate)
        out |= params_of(self.cost if self.cost != "X" else None)
        if self.spend:
            out.add(self.spend.param)
        return out


Breaks = list[IceType | Literal["any"]]


class Variant(_Model):
    id: Slug
    label: str = Field(min_length=1, max_length=80)
    default: bool = False
    breaks: Breaks | None = None
    strength: Amount | None = None
    abilities: list[Ability] | None = None
    note: str | None = None


class _Entry(_Model):
    reviewed: bool
    # Fields a draft could not settle; the reviewer checks them and empties the list.
    uncertain: list[str] = []
    params: dict[Slug, Param] = {}
    note: str | None = None

    def _check_params(self, used: set[str]) -> None:
        unknown = used - set(self.params)
        if unknown:
            raise ValueError(f"unknown params: {sorted(unknown)}")


class BreakerEntry(_Entry):
    breaks: Breaks = []
    stealth: bool = False
    strength: Amount | None = None
    abilities: list[Ability] = []
    variants: list[Variant] = []
    unmodelled: str | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.unmodelled is not None:
            if self.abilities or self.variants:
                raise ValueError("an unmodelled breaker has no abilities or variants")
            return self
        # A draft may be incomplete (no ability the regexes could read); a reviewed entry may not.
        if self.reviewed and not self.breaks:
            raise ValueError("breaks is required")
        if self.variants and sum(v.default for v in self.variants) != 1:
            raise ValueError("exactly one variant is the default")
        if len({v.id for v in self.variants}) != len(self.variants):
            raise ValueError("variant ids repeat")
        used = params_of(self.strength)
        for ab in self.abilities:
            used |= ab.params()
        for v in self.variants:
            used |= params_of(v.strength)
            for ab in v.abilities or []:
                used |= ab.params()
        if (
            self.reviewed
            and not self.abilities
            and (not self.variants or any(not v.abilities for v in self.variants))
        ):
            raise ValueError("abilities are required (on the entry or on every variant)")
        self._check_params(used)
        return self


class IceEntry(_Entry):
    strength: Amount | None = None
    subs: Amount | None = None
    gains: list[IceType] = []
    # Only breakers with one of these subtypes can break its subroutines (Semak-samun: fracters).
    broken_only_by: list[Literal["fracter", "decoder", "killer", "ai"]] | None = None
    unbreakable: str | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        self._check_params(params_of(self.strength) | params_of(self.subs))
        return self


class Effect(_Model):
    ice_strength: Amount | None = None
    ice_subs: Amount | None = None
    ice_gains: list[IceType] | None = None
    breaker_strength: Amount | None = None
    # Which ice an ice effect reaches: any of these subtypes (any ice when absent).
    ice: list[Slug] | None = None
    # Which breakers a breaker effect reaches.
    breakers: Literal["all", "non_ai"] = "all"

    @model_validator(mode="after")
    def _one(self) -> Self:
        n = sum(
            x is not None for x in (self.ice_strength, self.ice_subs, self.ice_gains, self.breaker_strength)
        )
        if n != 1:
            raise ValueError(
                "an effect has exactly one of ice_strength, ice_subs, ice_gains, breaker_strength"
            )
        return self


class SupportEntry(_Entry):
    include: bool = True
    reason: str | None = None
    effects: list[Effect] = []

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if not self.include:
            if not self.reason:
                raise ValueError("an excluded card needs a reason")
            return self
        if self.reviewed and not self.effects:
            raise ValueError("an included card has effects")
        used: set[str] = set()
        for e in self.effects:
            used |= params_of(e.ice_strength) | params_of(e.ice_subs) | params_of(e.breaker_strength)
        self._check_params(used)
        return self


ENTRY_MODELS: dict[str, type[_Entry]] = {"breakers": BreakerEntry, "ice": IceEntry, "support": SupportEntry}


@dataclass
class Curated:
    breakers: dict[str, BreakerEntry] = field(default_factory=dict)
    ice: dict[str, IceEntry] = field(default_factory=dict)
    support: dict[str, SupportEntry] = field(default_factory=dict)

    def unreviewed(self) -> list[str]:
        """file:card for every entry still waiting for review."""
        return [
            f"{name}:{cid}"
            for name in FILES
            for cid, e in sorted(getattr(self, name).items())
            if not e.reviewed or e.uncertain
        ]


def default_dir() -> Path:
    return Path(str(resources.files("market_research").joinpath("data/breaker_bay")))


def parse_file(name: str, raw: str) -> dict[str, Any]:
    """One curated file's entries, validated. Raises CuratedError naming the file and card."""
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as e:
        raise CuratedError(f"{name}.json: not JSON ({e.msg}, line {e.lineno})") from None
    if not isinstance(doc, dict) or doc.get("schema") != FILE_SCHEMAS[name]:
        raise CuratedError(f'{name}.json: "schema" must be {FILE_SCHEMAS[name]}')
    extra = set(doc) - {"schema", "cards"}
    if extra:
        raise CuratedError(f"{name}.json: unknown top-level keys {sorted(extra)}")
    cards = doc.get("cards")
    if not isinstance(cards, dict):
        raise CuratedError(f'{name}.json: "cards" must be an object keyed by card id')
    out: dict[str, Any] = {}
    for cid, entry in cards.items():
        if not re.fullmatch(r"[a-z0-9_]{1,80}", cid):
            raise CuratedError(f"{name}.json: bad card id {cid!r}")
        try:
            out[cid] = ENTRY_MODELS[name].model_validate(entry)
        except ValidationError as e:
            first = e.errors()[0]
            where = ".".join(str(p) for p in first["loc"])
            raise CuratedError(f"{name}.json: {cid}: {where}: {first['msg']}") from None
    return out


def load(directory: Path | None = None) -> Curated:
    d = directory or default_dir()
    cur = Curated()
    for name in FILES:
        path = d / f"{name}.json"
        try:
            raw = path.read_text("utf-8")
        except FileNotFoundError:
            continue
        setattr(cur, name, parse_file(name, raw))
    return cur


def dump_file(name: str, entries: dict[str, _Entry]) -> str:
    cards = {
        cid: {"reviewed": e.reviewed} | e.model_dump(mode="json", by_alias=True, exclude_defaults=True)
        for cid, e in sorted(entries.items())
    }
    return json.dumps({"schema": FILE_SCHEMAS[name], "cards": cards}, indent=2, ensure_ascii=False) + "\n"


# ---------------------------------------------------------------- the pool


def count_subroutines(text: str) -> int:
    """Printed subroutines: NRDB marks each with [subroutine] at the start of a line."""
    return len(re.findall(r"^\s*\[subroutine\]", text, flags=re.MULTILINE))


def is_icebreaker(c: CatCard) -> bool:
    return c.card_type_id == "program" and "icebreaker" in c.subtypes


def ice_types(c: CatCard) -> list[IceType]:
    return [t for t in ICE_TYPES if t in c.subtypes]


@dataclass
class Pool:
    restriction: str | None
    breakers: list[CatCard]
    ice: list[CatCard]
    others: list[CatCard]


def current_pool(catalog: Catalog, restriction: str | None) -> Pool:
    """The cards legal under a Standard ban list, split into breakers, ice and the rest."""
    legal = (
        [c for _, c in sorted(catalog.cards.items()) if catalog.legal_in(c.id, restriction)]
        if restriction
        else []
    )
    return Pool(
        restriction=restriction,
        breakers=[c for c in legal if is_icebreaker(c)],
        ice=[c for c in legal if c.card_type_id == "ice"],
        others=[c for c in legal if not is_icebreaker(c) and c.card_type_id != "ice"],
    )


def _model(entry: _Entry) -> dict[str, Any]:
    return entry.model_dump(
        mode="json", by_alias=True, exclude_defaults=True, exclude={"reviewed", "uncertain"}
    )


def slice_file(pool: Pool, cur: Curated, version: str, schema_id: str) -> dict[str, Any]:
    breakers = []
    for c in pool.breakers:
        e = cur.breakers.get(c.id)
        row: dict[str, Any] = {
            "id": c.id,
            "title": c.title,
            "faction": c.faction_id,
            "cost": c.cost,
            "mu": c.memory_cost,
            "strength": c.strength,
            "subtypes": c.subtypes,
        }
        if e is None:
            row["unmodelled"] = NOT_REVIEWED
        elif e.unmodelled is not None:
            row["unmodelled"] = e.unmodelled
            if e.note:
                row["note"] = e.note
        else:
            row["model"] = _model(e)
        breakers.append(row)
    ice = []
    for c in pool.ice:
        row = {
            "id": c.id,
            "title": c.title,
            "faction": c.faction_id,
            "rez": c.cost,
            "strength": c.strength,
            "subtypes": c.subtypes,
            "types": ice_types(c),
            "subs": count_subroutines(c.text),
        }
        ie = cur.ice.get(c.id)
        if ie is not None:
            row["model"] = _model(ie)
        ice.append(row)
    in_pool = {c.id: c for c in pool.others + pool.ice + pool.breakers}
    support = []
    for cid, se in sorted(cur.support.items()):
        sc = in_pool.get(cid)
        if sc is None or not se.include:
            continue
        support.append(
            {
                "id": cid,
                "title": sc.title,
                "side": sc.side_id,
                "faction": sc.faction_id,
                "type": sc.card_type_id,
                "model": _model(se),
            }
        )
    return {
        "schema": schema_id,
        "version": version,
        "restriction": pool.restriction,
        "breakers": breakers,
        "ice": ice,
        "support": support,
    }


# ---------------------------------------------------------------- drafts

_NUM = r"(\d+|X)"
_BREAK = re.compile(
    rf"(?P<cost>{_NUM})\[credit\]: Break (?P<upto>up to )?(?P<n>\d+|any number of|X) "
    r"(?:(?P<type>barrier|code gate|sentry) )?subroutines?(?P<rest>[^.]*)\."
)
_PUMP = re.compile(rf"(?P<cost>{_NUM})\[credit\]: \+(?P<n>\d+|X) strength\.")
_ICE_CHANGES = re.compile(
    r"strength|gains? .*subroutine|advance this ice|hosted (?:power|virus|advancement) counter|"
    r"cannot break|can only|subtypes",
    re.IGNORECASE,
)
_SUPPORT_HINT = re.compile(
    # NRDB writes minus as U+2212.
    r"[+\-−](?:\d+|X) strength|gains? (?:barrier|code gate|sentry)|"
    r"(?:choose|chosen) (?:an )?ice subtype|subroutines? cost|costs? \d+\[credit\] less to use",
    re.IGNORECASE,
)


def plain(text: str) -> str:
    """Card text without NRDB's HTML emphasis, on one line."""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", text)).strip()


def _num(s: str) -> int | Literal["X"]:
    return "X" if s == "X" else int(s)


def draft_breaker(c: CatCard) -> dict[str, Any]:
    """A proposed breakers.json entry from the card text; fields it can't settle are uncertain."""
    types = [BREAKER_TYPES[s] for s in c.subtypes if s in BREAKER_TYPES]
    breaks: list[str] = ["any"] if "ai" in c.subtypes else list(types)
    abilities: list[dict[str, Any]] = []
    uncertain: set[str] = set()
    text = plain(c.text)
    consumed = text
    for m in _BREAK.finditer(text):
        n = m.group("n")
        ab: dict[str, Any] = {
            "break": "any" if n == "any number of" else _num(n),
            "cost": _num(m.group("cost")),
        }
        if ab["break"] == "X" and ab["cost"] != "X":
            uncertain.add("abilities")
            continue
        if m.group("type"):
            t = m.group("type").replace(" ", "_")
            if [t] != breaks:
                ab["only"] = [t]
        if m.group("rest").strip():
            uncertain.add("abilities")
        abilities.append(ab)
        consumed = consumed.replace(m.group(0), "")
    for m in _PUMP.finditer(text):
        abilities.append({"pump": _num(m.group("n")), "cost": _num(m.group("cost"))})
        consumed = consumed.replace(m.group(0), "")
    for ab in abilities:
        if ab.get("pump") == "X" or (ab.get("cost") == "X" and ab.get("break") != "X"):
            uncertain.add("abilities")
    # Anything left beyond the "Interface →" labels is a condition or another mechanic.
    rest = re.sub(r"Interface\s*→", "", consumed).strip(" .")
    if rest:
        uncertain.add("abilities")
        uncertain.add("variants")
        uncertain.add("params")
    if not abilities:
        uncertain.add("abilities")
    if not breaks:
        uncertain.add("breaks")
    entry: dict[str, Any] = {"reviewed": False, "breaks": breaks, "abilities": abilities}
    if "stealth cards" in text:
        entry["stealth"] = True
    if uncertain:
        entry["uncertain"] = sorted(uncertain)
    return entry


def draft_ice(c: CatCard) -> dict[str, Any] | None:
    """A proposed ice.json entry, only for ice whose text suggests its strength or subroutines change."""
    if not _ICE_CHANGES.search(plain(c.text)):
        return None
    return {"reviewed": False, "uncertain": ["params", "strength", "subs"]}


def support_candidate(c: CatCard) -> bool:
    return c.card_type_id != "ice" and not is_icebreaker(c) and bool(_SUPPORT_HINT.search(plain(c.text)))


@dataclass
class DraftReport:
    added: dict[str, list[str]] = field(default_factory=lambda: {n: [] for n in FILES})
    pruned: dict[str, list[str]] = field(default_factory=lambda: {n: [] for n in FILES})
    outside_pool: dict[str, list[str]] = field(default_factory=lambda: {n: [] for n in FILES})

    def changed(self) -> bool:
        return any(self.added[n] or self.pruned[n] for n in FILES)


def draft(pool: Pool, cur: Curated, *, prune: bool = False) -> tuple[dict[str, dict[str, Any]], DraftReport]:
    """Entries per file after adding drafts for what the curated files don't cover (and, with prune,
    dropping entries for cards outside the pool). Existing entries are never changed."""
    rep = DraftReport()
    out: dict[str, dict[str, Any]] = {n: dict(getattr(cur, n)) for n in FILES}
    for c in pool.breakers:
        if c.id not in out["breakers"]:
            out["breakers"][c.id] = BreakerEntry.model_validate(draft_breaker(c))
            rep.added["breakers"].append(c.id)
    for c in pool.ice:
        if c.id not in out["ice"]:
            d = draft_ice(c)
            if d is not None:
                out["ice"][c.id] = IceEntry.model_validate(d)
                rep.added["ice"].append(c.id)
    for c in pool.others:
        if c.id not in out["support"] and support_candidate(c):
            out["support"][c.id] = SupportEntry.model_validate(
                {"reviewed": False, "uncertain": ["include", "effects"]}
            )
            rep.added["support"].append(c.id)
    ids = {
        "breakers": {c.id for c in pool.breakers},
        "ice": {c.id for c in pool.ice},
        # Ice can support too (Rime gives the other ice of its server +1 strength).
        "support": {c.id for c in pool.others + pool.ice + pool.breakers},
    }
    for n in FILES:
        for cid in sorted(set(out[n]) - ids[n]):
            if prune:
                del out[n][cid]
                rep.pruned[n].append(cid)
            else:
                rep.outside_pool[n].append(cid)
    return out, rep


def write(directory: Path, entries: dict[str, dict[str, Any]]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        (directory / f"{name}.json").write_text(dump_file(name, entries[name]), "utf-8", newline="\n")
