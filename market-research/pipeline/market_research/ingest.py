"""Ingestion: discovery, the frontier loop and one handler per item kind.

Hosts run concurrently (one worker per host), each at its own polite rate. The loop works in
rounds: every round takes the items due now, per host in priority order, until the host's budget
is spent or its breaker trips. Items created during a round (new deck references, say) are due in
the next round.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any

from pydantic import ValidationError

from market_research import logs
from market_research.clock import Clock
from market_research.config import Settings, tier_config
from market_research.frontier import PRIVATE_DECK_BONUS, Frontier, Item, base_priority, event_priority
from market_research.http import (
    BudgetExhausted,
    FetchFailed,
    HostTripped,
    HttpResult,
    PoliteHttp,
    RequestRefused,
    ResponseTooLarge,
)
from market_research.imports import IMPORT_PREFIX
from market_research.records import (
    AbrTournament,
    CobraTournament,
    NrdbByDate,
    Record,
    dump,
)
from market_research.scrub import IngestQuality
from market_research.sources import abr, cobra, nrdb
from market_research.sources.common import NotFound, ParseError, iso_now
from market_research.storage import Stores

log = logs.get("market_research.ingest")

QUALITY_KEY = "state/ingest_quality.json"
LINKS_KEY = "state/cobra_abr_codes.json"
DISCOVERY_PRIORITY = 10_000_000.0
BY_DATE_PRIORITY = 5_000_000.0
BY_DATE_WINDOW = (-1, 14)  # days around an event in which its decklists are usually published
# Cobra's index is sorted by ID (creation order), not by event date, and some events are created
# long after the date they carry. Discovery therefore stops on creation date, with this much slack
# for events created well before they are played; older-dated events are skipped one by one.
COBRA_CREATED_SLACK = timedelta(days=366)

SOURCE_GROUP = {"abr": "abr", "cobra": "cobra", "nrdb": "nrdb"}


@dataclass
class RunStats:
    new_records: int = 0
    decks_added: int = 0
    items_done: int = 0
    by_status: dict[str, int] = field(default_factory=dict)

    def status(self, s: str) -> None:
        self.by_status[s] = self.by_status.get(s, 0) + 1


class Deferred(Exception):
    """The item cannot be handled yet (it waits for another item)."""


class ReloadNotFound(Exception):
    """Some tournaments asked for by a reload do not exist at their source."""

    def __init__(self, missing: list[str]) -> None:
        super().__init__(", ".join(missing))
        self.missing = missing


def _cobra_index_data(r: HttpResult) -> list[Any]:
    """The events on one page of the Cobra index (a JSON:API document)."""
    if r.status != 200:
        raise NotFound(f"status {r.status}")
    doc = r.json()
    if not isinstance(doc, dict) or not isinstance(doc.get("data"), list):
        raise ParseError("not a JSON:API document")
    data: list[Any] = doc["data"]
    return data


class Ingestor:
    def __init__(
        self,
        settings: Settings,
        clock: Clock,
        http: PoliteHttp,
        stores: Stores,
        *,
        frontier: Frontier | None = None,
        since: date | None = None,
        backfill: bool = False,
        parallel: bool = True,
    ) -> None:
        self.settings = settings
        self.clock = clock
        self.http = http
        self.stores = stores
        self.frontier = frontier if frontier is not None else Frontier.load(stores.canonical)
        self.quality = IngestQuality()
        self.stats = RunStats()
        self.since = since
        self.backfill = backfill
        self.parallel = parallel
        self.tiers = tier_config()
        self._lock = threading.RLock()
        self._cache: dict[str, Any] = {}
        self._since_flush = 0
        self._last_flush = time.monotonic()
        self._stopped: set[str] = set()
        self._reload: set[str] | None = None  # during reload(): the keys it fetches again
        prev_q = stores.canonical.get_json(QUALITY_KEY)
        self._prev_quality: dict[str, Any] = prev_q if isinstance(prev_q, dict) else {}
        links = stores.canonical.get_json(LINKS_KEY)
        self.cobra_abr_codes: dict[str, str] = links if isinstance(links, dict) else {}
        self.handlers: dict[str, Callable[[Item], None]] = {
            "abr_list_recent": self.h_abr_list,
            "abr_list_sweep": self.h_abr_list,
            "abr_list_full": self.h_abr_list,
            "abr_entries": self.h_abr_entries,
            "cobra_catalog": self.h_cobra_catalog,
            "cobra_index": self.h_cobra_index,
            "cobra_tournament": self.h_cobra_tournament,
            "cobra_deck": self.h_cobra_deck,
            "cobra_settings": self.h_cobra_settings,
            "nrdb_catalog": self.h_nrdb_catalog,
            "nrdb_catalog_bulk": self.h_nrdb_catalog,
            "nrdb_by_date": self.h_nrdb_by_date,
            "nrdb_decklist": self.h_nrdb_decklist,
            "nrdb_deck": self.h_nrdb_decklist,
        }

    # ------------------------------------------------------------------ helpers

    @property
    def now(self) -> datetime:
        return self.clock.now()

    @property
    def today(self) -> date:
        return self.now.date()

    def fetched_at(self) -> str:
        return iso_now(self.now)

    def read(self, key: str) -> Any:
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        v = self.stores.source.get_json(key)
        with self._lock:
            self._cache[key] = v
        return v

    def write(self, key: str, record: Record, known_hash: str | None = None) -> bool:
        """Writes a record only when its hash changed. Returns True if written."""
        if key.startswith(IMPORT_PREFIX):
            raise ValueError(f"the crawler never writes imported data: {key}")
        h = record.compute_hash()
        if known_hash is None:
            existing = self.read(key)
            known_hash = existing.get("record_hash") if isinstance(existing, dict) else None
        if known_hash == h:
            return False
        obj = dump(record)
        self.stores.source.put_json(key, obj)
        with self._lock:
            self._cache[key] = obj
            self.stats.new_records += 1
        return True

    def enqueue(
        self,
        key: str,
        source: str,
        kind: str,
        entity_id: str,
        *,
        priority: float,
        event_date: str | None = None,
    ) -> bool:
        with self._lock:
            _, created = self.frontier.upsert(
                key,
                source=source,
                kind=kind,
                entity_id=entity_id,
                now=self.now,
                priority=priority,
                event_date=event_date,
            )
            if self._reload is not None and key not in self._reload:
                # A reload fetches everything under its tournaments again, once, in full.
                self._reload.add(key)
                self.frontier.reopen(key, self.now)
            return created

    def seed(self) -> None:
        """Discovery and reference items every run needs."""
        pr = DISCOVERY_PRIORITY
        for kind, key in (
            ("abr_list_recent", "abr:list:recent"),
            ("abr_list_sweep", "abr:list:sweep"),
            ("abr_list_full", "abr:list:full"),
        ):
            self.enqueue(key, "abr", kind, key.rsplit(":", 1)[1], priority=pr)
        for k in ("formats", "tournament_types", "deckbuilding_restrictions"):
            self.enqueue(f"cobra:catalog:{k}", "cobra", "cobra_catalog", k, priority=pr + 1)
        self.enqueue("cobra:index", "cobra", "cobra_index", "index", priority=pr)
        for k in ("card_sets", "restrictions", "formats", "snapshots"):
            self.enqueue(f"nrdb:catalog:{k}", "nrdb", "nrdb_catalog", k, priority=pr + 1)
        for k in ("cards", "printings"):
            self.enqueue(f"nrdb:catalog:{k}", "nrdb", "nrdb_catalog_bulk", k, priority=pr)
        if self._stale_card_fields():
            # The stored cards lack fields added since. The bulk item is fetched once and NRDB would
            # answer 304, so it is fetched again in full, without validators.
            with self._lock:
                self.frontier.reopen("nrdb:catalog:cards", self.now, priority=pr)
        if self.backfill:
            # A backfill may reach further back than earlier runs did, so it always re-reads the full
            # ABR list and the Cobra index, even if a recent run already completed them.
            with self._lock:
                for key in ("abr:list:full", "cobra:index"):
                    it = self.frontier.get(key)
                    if it is not None and (it.next_due > self.now or it.frozen):
                        it.next_due = self.now
                        it.frozen = False
                        self.frontier.dirty = True
        days = [self.today - timedelta(days=1), self.today]
        if self.backfill and self.since:
            days = [self.since + timedelta(days=i) for i in range((self.today - self.since).days + 1)]
        for d in days:
            self.enqueue_by_date(d, BY_DATE_PRIORITY + 1)

    def enqueue_by_date(self, d: date, priority: float = BY_DATE_PRIORITY) -> None:
        if d > self.today:
            return
        self.enqueue(
            f"nrdb:by_date:{d.isoformat()}",
            "nrdb",
            "nrdb_by_date",
            d.isoformat(),
            priority=priority,
            event_date=d.isoformat(),
        )

    def identity_printings(self) -> frozenset[str]:
        cached = self._cache.get("__identity_printings")
        if isinstance(cached, frozenset):
            return cached
        cards = self.read("nrdb/catalog/cards.json") or {}
        printings = self.read("nrdb/catalog/printings.json") or {}
        idents = {
            c["id"] for c in cards.get("cards", []) if str(c.get("card_type_id", "")).endswith("identity")
        }
        out = frozenset(p["id"] for p in printings.get("printings", []) if p.get("card_id") in idents)
        if out:
            self._cache["__identity_printings"] = out
        return out

    def cobra_catalog(self, kind: str) -> dict[str, str]:
        rec = self.read(f"cobra/catalog/{kind}.json") or {}
        return {i["id"]: i["name"] for i in rec.get("items", [])}

    def may_be_standard_cobra(self, format_id: int | None) -> bool:
        """Whether a Cobra event may be Standard. Events created before Cobra had a format setting
        (early 2025) carry none; they are fetched, and normalization decides from the linked ABR
        event, the name and the identities."""
        if format_id is None:
            return True
        return self.cobra_catalog("formats").get(str(format_id), "").strip().lower() == "standard"

    # ------------------------------------------------------------------ loop

    def run(
        self,
        *,
        sources: set[str] | None = None,
        accept: Callable[[Item], bool] | None = None,
        seed: bool = True,
    ) -> RunStats:
        if seed:
            self.seed()
        groups = sorted({SOURCE_GROUP[s] for s in (sources or {"abr", "cobra", "nrdb"})})
        try:
            while True:
                work: dict[str, list[Item]] = {}
                for g in groups:
                    if g in self._stopped:
                        continue
                    items = [i for i in self.frontier.due(self.now, source=g) if accept is None or accept(i)]
                    if items:
                        work[g] = items
                if not work:
                    break
                progressed = self._round(work)
                if not progressed:
                    break
        finally:
            self.flush()
        return self.stats

    def _round(self, work: dict[str, list[Item]]) -> bool:
        if self.parallel and len(work) > 1:
            with ThreadPoolExecutor(max_workers=len(work)) as ex:
                results = list(ex.map(lambda kv: self._drain(kv[0], kv[1]), sorted(work.items())))
        else:
            results = [self._drain(g, items) for g, items in sorted(work.items())]
        return any(results)

    def _drain(self, group: str, items: list[Item]) -> bool:
        progressed = False
        for it in items:
            if group in self._stopped:
                break
            if it.frozen or it.next_due > self.now:
                continue
            try:
                self.handlers[it.kind](it)
                progressed = True
            except Deferred:
                continue
            except BudgetExhausted:
                log.info("budget_exhausted", host_group=group)
                self._stopped.add(group)
            except HostTripped:
                log.warning("host_stopped", host_group=group, key=it.key)
                self._stopped.add(group)
            except (FetchFailed, NotFound) as e:
                with self._lock:
                    self.frontier.fail(it, self.now, type(e).__name__)
                if isinstance(e, FetchFailed):
                    log.warning("item_fetch_failed", key=it.key, reason=str(e))
                progressed = True
            except RequestRefused as e:
                with self._lock:
                    self.frontier.fail(it, self.now, "refused")
                log.warning("request_refused", key=it.key, reason=str(e))
                progressed = True
            except (ParseError, ValidationError, ValueError, ResponseTooLarge) as e:
                self.quality.add_quarantine(
                    it.key, f"{type(e).__name__}: {str(e).splitlines()[0][:120]}", None
                )
                with self._lock:
                    self.frontier.fail(it, self.now, "quarantined", retry_s=86400)
                progressed = True
            with self._lock:
                self.stats.items_done += 1
                self.stats.status(it.last_status or "none")
                self._since_flush += 1
            self.maybe_flush()
        return progressed

    def maybe_flush(self) -> None:
        with self._lock:
            due = self._since_flush >= self.settings.flush_every_items or (
                time.monotonic() - self._last_flush >= self.settings.flush_every_s
            )
        if due:
            self.flush()

    def flush(self) -> None:
        with self._lock:
            self.frontier.save(self.stores.canonical)
            self.stores.canonical.put_json(LINKS_KEY, self.cobra_abr_codes)
            prev = self._prev_quality
            cur = self.quality.to_json()
            drift = {
                k: sorted(set(prev.get("drift", {}).get(k, [])) | set(v)) for k, v in cur["drift"].items()
            }
            for k, v in prev.get("drift", {}).items():
                drift.setdefault(k, v)
            q = {e["key"]: e for e in prev.get("quarantine", [])}
            q.update({e["key"]: e for e in cur["quarantine"]})
            self.stores.canonical.put_json(
                QUALITY_KEY,
                {
                    "drift": dict(sorted(drift.items())),
                    "quarantine": [q[k] for k in sorted(q)][-500:],
                    "rejected_deck_refs": cur["rejected_deck_refs"]
                    + int(prev.get("rejected_deck_refs_total", 0)),
                    "rejected_deck_refs_total": cur["rejected_deck_refs"]
                    + int(prev.get("rejected_deck_refs_total", 0)),
                },
            )
            self._since_flush = 0
            self._last_flush = time.monotonic()

    # ------------------------------------------------------------------ reload

    def reload(self, *, cobra_ids: Iterable[int] = (), abr_ids: Iterable[int] = ()) -> RunStats:
        """Fetches the given tournaments again in full, with everything under them (results,
        entries, settings, deck pages, decklists and their daily lists), whatever the frontier
        says. Discovery rules (date window, Cobra format) are not applied; normalization still
        decides what counts. Every tournament is looked up first: if one is missing, nothing is
        written and ReloadNotFound is raised."""
        abr_list = list(dict.fromkeys(abr_ids))
        cobra_meta = {tid: self.reload_cobra_meta(tid) for tid in dict.fromkeys(cobra_ids)}
        abr_events = self.reload_abr_events(abr_list)
        missing = [f"cobra:{tid}" for tid, m in cobra_meta.items() if m is None]
        missing += [f"abr:{aid}" for aid in abr_list if aid not in abr_events]
        if missing:
            raise ReloadNotFound(missing)
        self._reload = set()
        try:
            types = self.cobra_catalog("tournament_types")
            for meta in (m for m in cobra_meta.values() if m is not None):
                key = f"cobra:tournament:{meta.id}"
                self._collect_cobra_tournament(key, meta, date.fromisoformat(meta.date), types)
                log.info("reload", key=key, date=meta.date, format_id=meta.format_id)
            for ev in abr_events.values():
                self._collect_reloaded_abr_event(ev)
            reloading = self._reload
            return self.run(seed=False, accept=lambda it: it.key in reloading)
        finally:
            self._reload = None

    def _collect_reloaded_abr_event(self, ev: AbrTournament) -> None:
        """Stores an ABR event and queues its entries, whether or not discovery would keep it."""
        self.write(f"abr/tournament/{ev.id}.json", ev)
        key = f"abr:event:{ev.id}"
        with self._lock:
            self.frontier.mark_known(
                key, source="abr", kind="abr_event", entity_id=str(ev.id), now=self.now, status="seen"
            )
            self.frontier.items[key].record_hash = ev.record_hash
            self.frontier.items[key].event_date = ev.date
        _, group = self.tiers.abr_tier(ev.type_id)
        days = (self.today - date.fromisoformat(ev.date)).days
        pr = event_priority(group, ev.players_count, recency_days=days)
        ekey = f"abr:entries:{ev.id}"
        self.enqueue(ekey, "abr", "abr_entries", str(ev.id), priority=pr, event_date=ev.date)
        log.info("reload", key=ekey, date=ev.date, format=ev.format, skip_reason=self.abr_eligible(ev))

    def reload_cobra_meta(self, tid: int) -> CobraTournament | None:
        """A Cobra tournament's current metadata, keeping the results already stored (they are
        fetched again right after, and must not be lost if that fails)."""
        r = self.http.get(cobra.show_url(tid), accept="application/vnd.api+json, application/json")
        if r.status == 404:
            return None
        if r.status != 200:
            raise NotFound(f"status {r.status}")
        meta = cobra.parse_show(r.json(), self.quality, self.fetched_at())
        stored = self.read(f"cobra/tournament/{tid}.json")
        if isinstance(stored, dict):
            old = CobraTournament.model_validate(stored)
            keep = ("results_fetched", "stages", "players", "pairings")
            meta = meta.model_copy(update={k: getattr(old, k) for k in keep}).hashed()
        return meta

    def reload_abr_events(self, ids: list[int]) -> dict[int, AbrTournament]:
        """ABR has no single-event endpoint: its results listing is read until every ID is found."""
        found: dict[int, AbrTournament] = {}
        wanted = set(ids)
        if not wanted:
            return found
        for page in self.abr_results(self.fetched_at()):
            found.update((ev.id, ev) for ev in page if ev.id in wanted)
            if wanted <= found.keys():
                break
        return found

    def abr_results(self, fetched: str) -> Iterator[list[AbrTournament]]:
        """ABR's results listing, page by page, until a page comes back short."""
        size = self.settings.abr_page_size
        offset = 0
        while True:
            r = self.http.get(abr.results_url(offset, size))
            if r.status != 200:
                raise NotFound(f"status {r.status}")
            payload = r.json()
            yield abr.parse_events(payload, self.quality, fetched)  # raises unless a list
            # Counted as sent: parse_events leaves unreadable events out of a full page.
            if not isinstance(payload, list) or len(payload) < size:
                return
            offset += size

    # ------------------------------------------------------------------ ABR

    def abr_list_urls(self, it: Item) -> list[str] | None:
        t = self.today
        if it.kind == "abr_list_recent":
            return [abr.list_url(t - timedelta(days=60))]
        if it.kind == "abr_list_sweep":
            return [abr.list_url(t - timedelta(days=365), t - timedelta(days=60))]
        return None  # full: paginated results

    def h_abr_list(self, it: Item) -> None:
        urls = self.abr_list_urls(it)
        fetched = self.fetched_at()
        events: list[AbrTournament] = []
        if urls is not None:
            for u in urls:
                r = self.http.get(u)
                if r.status != 200:
                    raise NotFound(f"status {r.status}")
                events += abr.parse_events(r.json(), self.quality, fetched)
        else:
            for page in self.abr_results(fetched):
                events += page
                if self.since and page and all(date.fromisoformat(e.date) < self.since for e in page):
                    break
        for ev in events:
            self.consider_abr_event(ev)
        with self._lock:
            self.frontier.complete(it, self.now, changed=True, status="ok")

    def abr_eligible(self, ev: AbrTournament) -> str | None:
        """Returns a skip reason, or None if the event is kept."""
        if ev.format != "standard":
            return "not_standard"
        if ev.approved != 1:
            return "unapproved"
        if not ev.concluded:
            return "not_concluded"
        if ev.claim_conflict:
            return "claim_conflict"
        if ev.players_count < self.settings.thresholds.min_players:
            return "too_small"
        if self.since and date.fromisoformat(ev.date) < self.since:
            return "before_window"
        return None

    def consider_abr_event(self, ev: AbrTournament) -> None:
        reason = self.abr_eligible(ev)
        key = f"abr:event:{ev.id}"
        if reason:
            log.debug("abr_event_skipped", abr_id=ev.id, reason=reason)
            return
        with self._lock:
            prev = self.frontier.get(key)
            prev_hash = prev.record_hash if prev else None
        if prev_hash == ev.record_hash:
            return
        old = self.read(f"abr/tournament/{ev.id}.json")
        old_fp = AbrTournament.model_validate(old).fingerprint() if isinstance(old, dict) else None
        self.write(f"abr/tournament/{ev.id}.json", ev)
        with self._lock:
            self.frontier.mark_known(
                key, source="abr", kind="abr_event", entity_id=str(ev.id), now=self.now, status="seen"
            )
            self.frontier.items[key].record_hash = ev.record_hash
            self.frontier.items[key].event_date = ev.date
        if old_fp == ev.fingerprint():
            return
        linked = str(ev.id) in set(self.cobra_abr_codes.values())
        need_entries = ev.claim_count > 0 or (ev.matchdata and not linked)
        if not need_entries:
            return
        _, group = self.tiers.abr_tier(ev.type_id)
        pr = event_priority(
            group, ev.players_count, recency_days=(self.today - date.fromisoformat(ev.date)).days
        )
        ekey = f"abr:entries:{ev.id}"
        created = self.enqueue(ekey, "abr", "abr_entries", str(ev.id), priority=pr, event_date=ev.date)
        if not created:
            with self._lock:
                self.frontier.signal(ekey, self.now)

    def h_abr_entries(self, it: Item) -> None:
        tid = int(it.entity_id)
        r = self.http.get(abr.entries_url(tid))
        if r.status != 200:
            raise NotFound(f"status {r.status}")
        rec = abr.parse_entries(tid, r.json(), self.quality)
        changed = self.write(f"abr/entries/{tid}.json", rec, known_hash=it.record_hash)
        base = base_priority(it.priority)
        if changed or self._reload is not None:
            ev_date = date.fromisoformat(it.event_date) if it.event_date else self.today
            refs = [
                (s.deck_ref.kind, s.deck_ref.id)
                for e in rec.entries
                for s in (e.corp, e.runner)
                if s.deck_ref
            ]
            if any(k == "decklist" for k, _ in refs):
                for off in range(BY_DATE_WINDOW[0], BY_DATE_WINDOW[1] + 1):
                    self.enqueue_by_date(ev_date + timedelta(days=off))
            for kind, ref in refs:
                if kind == "decklist":
                    self.enqueue(
                        f"nrdb:decklist:{ref}",
                        "nrdb",
                        "nrdb_decklist",
                        ref,
                        priority=base,
                        event_date=it.event_date,
                    )
                else:
                    # Private shared decks can change after the event: fetch them first, then freeze.
                    self.enqueue(
                        f"nrdb:deck:{ref}",
                        "nrdb",
                        "nrdb_deck",
                        ref,
                        priority=base + PRIVATE_DECK_BONUS,
                        event_date=it.event_date,
                    )
        with self._lock:
            self.frontier.complete(it, self.now, changed=changed, status="ok", record_hash=rec.record_hash)

    # ------------------------------------------------------------------ Cobra

    def h_cobra_catalog(self, it: Item) -> None:
        kind = it.entity_id
        got = cobra.fetch_catalog(self.http, kind, self.quality, etag=it.etag)
        if got is None:
            with self._lock:
                self.frontier.complete(it, self.now, changed=False, status="not_modified")
            return
        rec, etag = got
        changed = self.write(f"cobra/catalog/{kind}.json", rec, known_hash=it.record_hash)
        with self._lock:
            self.frontier.complete(
                it, self.now, changed=changed, status="ok", record_hash=rec.record_hash, etag=etag
            )

    def h_cobra_index(self, it: Item) -> None:
        if not self.cobra_catalog("formats"):
            fmt = self.frontier.get("cobra:catalog:formats")
            if fmt is not None and fmt.last_status is None:
                raise Deferred
        types = self.cobra_catalog("tournament_types")
        size = self.settings.cobra_page_size
        fetched = self.fetched_at()
        first_etag = it.etag
        page = 1
        while True:
            r = self.http.get(
                cobra.index_url(page, size),
                etag=it.etag if page == 1 and not self.backfill else None,
                accept="application/vnd.api+json, application/json",
            )
            if r.not_modified:
                break  # the newest page is unchanged: nothing new
            if page == 1:
                first_etag = r.etag
            data = _cobra_index_data(r)
            if any(self._index_cobra_item(item, types, fetched) for item in data) or len(data) < size:
                break
            page += 1
        with self._lock:
            self.frontier.complete(it, self.now, changed=True, status="ok", etag=first_etag)

    def _index_cobra_item(self, item: Any, types: dict[str, str], fetched: str) -> bool:
        """Handles one event of the Cobra index; True when the rest of the index needn't be read."""
        try:
            meta, private = cobra.parse_index_item(item, self.quality, fetched)
        except ParseError as e:
            # One bad event (seen live: date "20260-05-21") must not hide the rest of the index.
            raw_id = str(item.get("id")) if isinstance(item, dict) else ""
            item_id = raw_id if raw_id.isdigit() and len(raw_id) <= 9 else "unknown"
            self.quality.add_quarantine(f"cobra:index:{item_id}", f"ParseError: {e}", str(item).encode())
            return False
        key = f"cobra:tournament:{meta.id}"
        known = self.frontier.get(key)
        # A backfill re-checks events skipped as not Standard under an earlier rule (events without
        # a format were once skipped).
        recheck = (
            known is not None
            and self.backfill
            and known.last_status == "skipped_not_standard"
            and self.may_be_standard_cobra(meta.format_id)
        )
        if known is not None and not recheck:
            if self.backfill:
                self.fill_cobra_name(meta)
                return False  # a backfill reads on to its start date: older events may be new
            return True  # newest first: everything after this is known
        d = date.fromisoformat(meta.date)
        if self.since and d < self.since:
            created = cobra.created_date(item)
            return created is not None and created < self.since - COBRA_CREATED_SLACK
        if d > self.today:
            return False  # not played yet; seen again next run
        if private:
            self._mark_cobra_skipped(key, meta, "skipped_private")
        elif not self.may_be_standard_cobra(meta.format_id):
            self._mark_cobra_skipped(key, meta, "skipped_not_standard")
        else:
            pr = self._collect_cobra_tournament(key, meta, d, types)
            if recheck:
                with self._lock:
                    self.frontier.reopen(key, self.now, priority=pr)
        return False

    def _mark_cobra_skipped(self, key: str, meta: CobraTournament, status: str) -> None:
        with self._lock:
            self.frontier.mark_known(
                key,
                source="cobra",
                kind="cobra_tournament",
                entity_id=str(meta.id),
                now=self.now,
                status=status,
            )

    def _collect_cobra_tournament(
        self, key: str, meta: CobraTournament, d: date, types: dict[str, str]
    ) -> float:
        """Stores an event's index metadata and queues the event itself; returns its priority."""
        self.write(f"cobra/tournament/{meta.id}.json", meta)
        if meta.abr_code:
            with self._lock:
                self.cobra_abr_codes[str(meta.id)] = meta.abr_code
        _, group = self.tiers.cobra_tier(types.get(str(meta.type_id)))
        pr = event_priority(group, meta.players_active, recency_days=(self.today - d).days)
        self.enqueue(key, "cobra", "cobra_tournament", str(meta.id), priority=pr, event_date=meta.date)
        return pr

    def fill_cobra_name(self, meta: CobraTournament) -> None:
        """Adds the public name to a stored tournament collected before names were kept."""
        stored = self.read(f"cobra/tournament/{meta.id}.json")
        if not isinstance(stored, dict) or stored.get("name") or not meta.name:
            return
        rec = CobraTournament.model_validate(stored).model_copy(update={"name": meta.name}).hashed()
        self.write(f"cobra/tournament/{meta.id}.json", rec, known_hash=stored.get("record_hash"))

    def h_cobra_tournament(self, it: Item) -> None:
        tid = int(it.entity_id)
        key = f"cobra/tournament/{tid}.json"
        stored = self.read(key)
        if not isinstance(stored, dict):
            raise ParseError("tournament metadata missing")
        meta = CobraTournament.model_validate(stored)
        fetched = self.fetched_at()
        concluded_by_date = date.fromisoformat(meta.date) < self.today - timedelta(days=3)
        if concluded_by_date and "public" not in (meta.deck_visibility.swiss, meta.deck_visibility.cut):
            # Organisers often publish decks after the event: watch the tournament's settings.
            self.enqueue(
                f"cobra:settings:{tid}",
                "cobra",
                "cobra_settings",
                str(tid),
                priority=base_priority(it.priority),
                event_date=meta.date,
            )
        r = self.http.get(cobra.nrtm_url(tid), etag=it.etag if meta.results_fetched else None)
        if r.not_modified:
            rec = meta
            etag = it.etag
        elif r.status == 200:
            rec = cobra.parse_nrtm(r.json(), meta, self.quality, fetched)
            etag = r.etag
        else:
            raise NotFound(f"status {r.status}")
        changed = self.write(key, rec, known_hash=stored.get("record_hash"))
        live = cobra.is_live(rec, self.today)
        if not live or self._reload is not None:
            # A reload pulls the decks even while the event is live (its decks lock when it starts).
            self.enqueue_cobra_decks(rec, base_priority(it.priority))
        with self._lock:
            self.frontier.complete(
                it, self.now, changed=changed, status="ok", record_hash=rec.record_hash, etag=etag, live=live
            )

    def h_cobra_settings(self, it: Item) -> None:
        """Re-reads a finished tournament's settings (conditional) to notice decks made public later."""
        tid = int(it.entity_id)
        r = self.http.get(
            cobra.show_url(tid), etag=it.etag, accept="application/vnd.api+json, application/json"
        )
        if r.not_modified:
            with self._lock:
                self.frontier.complete(it, self.now, changed=False, status="not_modified")
            return
        if r.status != 200:
            raise NotFound(f"status {r.status}")
        fresh = cobra.parse_show(r.json(), self.quality, self.fetched_at())
        key = f"cobra/tournament/{tid}.json"
        stored = CobraTournament.model_validate(self.read(key))
        changed = stored.deck_visibility != fresh.deck_visibility
        if changed:
            rec = stored.model_copy(update={"deck_visibility": fresh.deck_visibility}).hashed()
            self.write(key, rec)
            with self._lock:
                self.frontier.signal(f"cobra:tournament:{tid}", self.now)
        with self._lock:
            self.frontier.complete(it, self.now, changed=changed, status="ok", etag=r.etag)
            if "public" in (fresh.deck_visibility.swiss, fresh.deck_visibility.cut):
                self.frontier.freeze(it, "public")

    def enqueue_cobra_decks(self, t: CobraTournament, priority: float) -> None:
        vis = t.deck_visibility
        if vis.swiss == "public":
            pids = [p.pid for p in t.players]
        elif vis.cut == "public":
            pids = [p.pid for p in t.players if p.cut_rank is not None]
        else:
            return  # open or private stages: identity-level data only, no deck pages
        for pid in pids:
            self.enqueue(
                f"cobra:deck:{t.id}:{pid}",
                "cobra",
                "cobra_deck",
                f"{t.id}:{pid}",
                priority=priority,
                event_date=t.date,
            )

    def h_cobra_deck(self, it: Item) -> None:
        tid_s, pid_s = it.entity_id.split(":")
        tid, pid = int(tid_s), int(pid_s)
        t = CobraTournament.model_validate(self.read(f"cobra/tournament/{tid}.json"))
        r = self.http.get(cobra.decks_url(tid, pid), accept="text/html")
        if r.status in (401, 403, 404) or 300 <= r.status < 400:
            with self._lock:
                self.frontier.freeze(it, "not_visible")
            return
        if r.status != 200:
            raise NotFound(f"status {r.status}")
        decks = cobra.parse_view_decks(r.body.decode("utf-8", "replace"), tid, pid, t, self.quality)
        added = 0
        for d in decks:
            if self.write(f"cobra/deck/{tid}/{pid}-{d.side}.json", d):
                added += 1
            if not d.cards and d.nrdb_uuid:
                self.enqueue(
                    f"nrdb:deck:{d.nrdb_uuid}",
                    "nrdb",
                    "nrdb_deck",
                    d.nrdb_uuid,
                    priority=it.priority + PRIVATE_DECK_BONUS,
                    event_date=t.date,
                )
        with self._lock:
            self.stats.decks_added += added
            self.frontier.complete(it, self.now, changed=added > 0, status="ok")

    # ------------------------------------------------------------------ NetrunnerDB

    def h_nrdb_catalog(self, it: Item) -> None:
        kind = it.entity_id
        if kind not in nrdb.CATALOG_KINDS:
            raise ValueError(f"unknown catalog kind {kind}")
        rec, etag, lm = nrdb.fetch_catalog(
            self.http,
            kind,
            self.quality,
            etag=it.etag,
            last_modified=it.last_modified,
        )
        changed = False
        if rec is not None:
            old = self.read(f"nrdb/catalog/{kind}.json")
            changed = self.write(f"nrdb/catalog/{kind}.json", rec, known_hash=it.record_hash)
            if changed and kind in ("card_sets", "restrictions") and isinstance(old, dict):
                old_ids = {x["id"] for x in old.get(kind, [])}
                new_ids = {x.id for x in getattr(rec, kind)}
                if new_ids - old_ids:
                    log.info("catalog_new_entries", kind=kind, count=len(new_ids - old_ids))
                    with self._lock:
                        self.frontier.signal("nrdb:catalog:cards", self.now)
                        self.frontier.signal("nrdb:catalog:printings", self.now)
            if kind in ("cards", "printings"):
                self._cache.pop("__identity_printings", None)
        with self._lock:
            self.frontier.complete(
                it,
                self.now,
                changed=changed,
                status="ok" if rec else "not_modified",
                record_hash=rec.record_hash if rec else None,
                etag=etag,
                last_modified=lm,
            )

    def _stale_card_fields(self) -> bool:
        stored = self.read("nrdb/catalog/cards.json")
        return isinstance(stored, dict) and int(stored.get("card_fields") or 1) < nrdb.CARD_FIELDS

    def h_nrdb_by_date(self, it: Item) -> None:
        d = date.fromisoformat(it.entity_id)
        r = self.http.get(nrdb.by_date_url(d), last_modified=it.last_modified, etag=it.etag)
        changed = False
        rec: NrdbByDate | None = None
        if r.status == 200:
            rec = nrdb.parse_by_date(d, r.json(), self.quality, self.identity_printings())
            changed = self.write(
                f"nrdb/decklists/by_date/{d.isoformat()}.json", rec, known_hash=it.record_hash
            )
        elif not r.not_modified:
            raise NotFound(f"status {r.status}")
        with self._lock:
            self.frontier.complete(
                it,
                self.now,
                changed=changed,
                status="ok" if rec else "not_modified",
                record_hash=rec.record_hash if rec else None,
                etag=r.etag or it.etag,
                last_modified=r.last_modified or it.last_modified,
            )
            if d < self.today - timedelta(days=2):
                self.frontier.freeze(it, it.last_status or "ok")  # a past day's published lists are settled

    def in_bulk(self, it: Item) -> bool:
        """True when the decklist is already in a stored by_date file. Defers while those are pending."""
        ev = date.fromisoformat(it.event_date) if it.event_date else None
        if ev is None:
            return False
        ref = it.entity_id
        pending = False
        for off in range(BY_DATE_WINDOW[0], BY_DATE_WINDOW[1] + 1):
            d = ev + timedelta(days=off)
            if d > self.today:
                break
            fi = self.frontier.get(f"nrdb:by_date:{d.isoformat()}")
            if fi is not None and fi.last_status is None and fi.fail_count == 0:
                pending = True
                continue
            rec = self.read(f"nrdb/decklists/by_date/{d.isoformat()}.json")
            if isinstance(rec, dict) and any(
                ref in (x.get("id"), x.get("uuid")) for x in rec.get("decklists", [])
            ):
                return True
        if pending:
            raise Deferred
        return False

    def h_nrdb_decklist(self, it: Item) -> None:
        kind = "deck" if it.kind == "nrdb_deck" else "decklist"
        if kind == "decklist" and self.in_bulk(it):
            with self._lock:
                self.frontier.complete(it, self.now, changed=False, status="in_bulk")
            return
        u = nrdb.deck_url(it.entity_id) if kind == "deck" else nrdb.decklist_url(it.entity_id)
        r = self.http.get(u)
        if r.status in (403, 404):
            with self._lock:
                self.frontier.freeze(it, "not_found")
            return
        if r.status != 200:
            raise NotFound(f"status {r.status}")
        try:
            rec = nrdb.parse_single(
                r.json(), self.quality, kind=kind, identity_printings=self.identity_printings()
            )
        except NotFound:
            with self._lock:
                self.frontier.freeze(it, "not_found")
            return
        rec = rec.model_copy(update={"id": it.entity_id}).hashed()
        written = self.write(f"nrdb/{kind}/{it.entity_id}.json", rec)
        with self._lock:
            if written:
                self.stats.decks_added += 1
            self.frontier.complete(
                it,
                self.now,
                changed=written,
                status="ok",
                record_hash=rec.record_hash,
                last_modified=r.last_modified,
            )
