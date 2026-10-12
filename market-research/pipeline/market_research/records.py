"""Scrubbed source records.

Allowlist, not blocklist: every record type lists exactly the fields that are kept. Parsers build
these from the parsed payload in memory; original payloads are never stored. Anything not declared
here cannot end up in storage, because models forbid extra fields.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field

Side = Literal["corp", "runner"]
Visibility = Literal["public", "open", "private"]

_HASH_EXCLUDE = {"record_hash", "fetched_at", "imported_at"}


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Record(BaseModel):
    """Base for stored records: strict (no extra fields), hashable."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    def compute_hash(self) -> str:
        body = self.model_dump(mode="json", by_alias=True, exclude=_HASH_EXCLUDE)
        return "sha256:" + sha256_hex(canonical_json(body).encode("utf-8"))

    def hashed(self) -> Self:
        if "record_hash" not in type(self).model_fields:
            return self
        return self.model_copy(update={"record_hash": self.compute_hash()})


class Part(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# ---------------- Cobra ----------------


class CobraStage(Part):
    n: int
    format: str
    rounds: int | None = None
    size: int | None = None


class CobraPlayer(Part):
    pid: int
    active: bool | None = None
    corp_identity: str | None = None
    runner_identity: str | None = None
    swiss_rank: int | None = None
    cut_rank: int | None = None
    points: int | None = None
    corp_points: int | None = None
    runner_points: int | None = None
    sos: float | None = None
    esos: float | None = None


class CobraPairing(Part):
    stage: int
    round: int
    table: int | None
    p1: int | None
    p2: int | None
    p1_side: Side | None = None
    p1_corp_score: int | None = None
    p1_runner_score: int | None = None
    p2_corp_score: int | None = None
    p2_runner_score: int | None = None
    intentional_draw: bool = False
    two_for_one: bool = False
    elimination: bool = False
    # Elimination games in the NRTM export carry only a winner flag, not scores.
    winner: Literal[1, 2] | None = None


class DeckVisibility(Part):
    swiss: Visibility
    cut: Visibility


class CobraTournament(Record):
    schema_: Literal["cobra.tournament/1"] = Field("cobra.tournament/1", alias="schema")
    id: int
    fetched_at: str
    record_hash: str = ""
    abr_code: str | None = None
    name: str | None = None  # the event's public name
    date: str
    type_id: int | None = None
    format_id: int | None = None
    restriction_id: str | None = None
    card_set_id: str | None = None
    swiss_format: str | None = None
    deck_visibility: DeckVisibility
    players_active: int | None = None
    players_dropped: int | None = None
    stage: str | None = None
    results_fetched: bool = False
    stages: list[CobraStage] = []
    players: list[CobraPlayer] = []
    pairings: list[CobraPairing] = []

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class CardRef(Part):
    nrdb_card_id: str | None = None
    nrdb_printing_id: str | None = None


class CobraDeckCard(Part):
    nrdb_card_id: str | None = None
    nrdb_printing_id: str | None = None
    qty: int


class CobraDeck(Record):
    schema_: Literal["cobra.deck/1"] = Field("cobra.deck/1", alias="schema")
    tournament_id: int
    pid: int
    side: Side
    stage_visibility: Visibility
    identity: CardRef
    nrdb_uuid: str | None = None
    cards: list[CobraDeckCard]
    record_hash: str = ""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class NamedRef(Part):
    id: str
    name: str
    extra: str | None = None


class CobraCatalog(Record):
    """Cobra reference tables: formats, tournament types, deckbuilding restrictions (public data)."""

    schema_: Literal["cobra.catalog/1"] = Field("cobra.catalog/1", alias="schema")
    kind: Literal["formats", "tournament_types", "deckbuilding_restrictions"]
    items: list[NamedRef]
    record_hash: str = ""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


# ---------------- ABR ----------------


class AbrTournament(Record):
    schema_: Literal["abr.tournament/1"] = Field("abr.tournament/1", alias="schema")
    id: int
    fetched_at: str
    record_hash: str = ""
    date: str
    end_date: str | None = None  # last day of a multi-day event; None for one-day events
    title: str | None = None  # the event's public name
    online: bool = False  # ABR's location is "online"
    type_id: str | None = None
    format: str | None = None
    cardpool: str | None = None
    approved: int | None = None
    concluded: bool = False
    players_count: int = 0
    top_count: int = 0
    claim_count: int = 0
    claim_conflict: bool = False
    matchdata: bool = False
    country: str | None = None
    winner_corp_identity: str | None = None
    winner_runner_identity: str | None = None

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    def fingerprint(self) -> str:
        body = {
            "claim_count": self.claim_count,
            "players_count": self.players_count,
            "top_count": self.top_count,
            "matchdata": self.matchdata,
            "concluded": self.concluded,
            "winner_corp_identity": self.winner_corp_identity,
            "winner_runner_identity": self.winner_runner_identity,
        }
        return "sha256:" + sha256_hex(canonical_json(body).encode("utf-8"))


class DeckRef(Part):
    kind: Literal["decklist", "deck"]
    id: str


class AbrSide(Part):
    identity: str | None = None
    deck_ref: DeckRef | None = None


class AbrEntry(Part):
    swiss_rank: int
    cut_rank: int | None = None
    claimed: bool = False
    corp: AbrSide
    runner: AbrSide


class AbrEntries(Record):
    schema_: Literal["abr.entries/1"] = Field("abr.entries/1", alias="schema")
    tournament_id: int
    entries: list[AbrEntry]
    record_hash: str = ""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


# ---------------- NetrunnerDB ----------------


class PrintingQty(Part):
    printing_id: str
    qty: int


class NrdbDecklist(Record):
    """A published decklist (`kind=decklist`) or a private shared deck (`kind=deck`)."""

    schema_: Literal["nrdb.decklist/1"] = Field("nrdb.decklist/1", alias="schema")
    kind: Literal["decklist", "deck"] = "decklist"
    id: str
    uuid: str | None = None
    published: str | None = None
    identity_printing_id: str | None = None
    cards: list[PrintingQty]
    record_hash: str = ""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class NrdbByDate(Record):
    schema_: Literal["nrdb.by_date/1"] = Field("nrdb.by_date/1", alias="schema")
    date: str
    decklists: list[NrdbDecklist]
    record_hash: str = ""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class CatCard(Part):
    id: str
    title: str
    side_id: str
    card_type_id: str
    faction_id: str
    influence_cost: int | None = None
    influence_limit: int | None = None
    minimum_deck_size: int | None = None
    deck_limit: int | None = None
    agenda_points: int | None = None
    is_unique: bool = False
    card_pool_ids: list[str] = []
    printing_ids: list[str] = []
    # Game text fields for Breaker Bay (catalog card_fields 2 and later). "X" is a variable cost.
    cost: int | Literal["X"] | None = None
    strength: int | None = None
    memory_cost: int | None = None
    subtypes: list[str] = []
    text: str = ""


class CatPrinting(Part):
    id: str
    card_id: str
    card_set_id: str
    date_release: str | None = None


class CatSet(Part):
    id: str
    name: str
    date_release: str | None = None
    card_cycle_id: str | None = None


class CatFormat(Part):
    id: str
    name: str
    active_snapshot_id: str | None = None
    snapshot_ids: list[str] = []
    restriction_ids: list[str] = []


class Verdicts(Part):
    banned: list[str] = []
    restricted: list[str] = []
    universal_faction_cost: dict[str, int] = {}
    global_penalty: list[str] = []
    points: dict[str, int] = {}


class CatRestriction(Part):
    id: str
    name: str
    date_start: str | None = None
    format_id: str | None = None
    point_limit: int | None = None
    verdicts: Verdicts = Verdicts()


class CatSnapshot(Part):
    id: str
    format_id: str
    card_pool_id: str | None = None
    restriction_id: str | None = None
    date_start: str | None = None
    active: bool = False


CatalogKind = Literal["cards", "printings", "card_sets", "formats", "restrictions", "snapshots"]


class NrdbCatalog(Record):
    schema_: Literal["nrdb.catalog/1"] = Field("nrdb.catalog/1", alias="schema")
    kind: CatalogKind
    cards: list[CatCard] = []
    printings: list[CatPrinting] = []
    card_sets: list[CatSet] = []
    formats: list[CatFormat] = []
    restrictions: list[CatRestriction] = []
    snapshots: list[CatSnapshot] = []
    # Which CatCard fields a cards record was parsed with: 1 had no game text, 2 has it. Ingest
    # fetches the cards again, ignoring the stored validators, while the stored record is older.
    card_fields: int = 1
    record_hash: str = ""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


# ---------------- Imported decklists ----------------


class CardQty(Part):
    card_id: str
    qty: int


class ImportedDeck(Part):
    pid: int  # the Cobra player; the player's name is only used to find it and never kept
    side: Side
    identity: str
    cards: list[CardQty]


class ImportedDecks(Record):
    """Decklists of one Cobra tournament loaded from a file (e.g. one the organiser sent). Stored under
    `import/`, which the crawler never writes, so later runs never replace them."""

    schema_: Literal["import.decks/1"] = Field("import.decks/1", alias="schema")
    cobra_id: int
    origin: str  # a short label for where the file came from, e.g. "nsg"
    imported_at: str
    decks: list[ImportedDeck]
    record_hash: str = ""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


def dump(record: Record) -> dict[str, Any]:
    return record.model_dump(mode="json", by_alias=True)
