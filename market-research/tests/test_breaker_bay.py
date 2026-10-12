"""Breaker Bay: the curated file format, the pool slice, the drafts and their command."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from helpers import EXPECTED
from market_research import breaker_bay as bb
from market_research.catalog import Catalog
from market_research.cli import app
from market_research.publish import SCHEMAS, check, load_curated
from market_research.records import CatCard, CatRestriction, CatSnapshot, NrdbCatalog, Verdicts

SOURCE = EXPECTED / "source"


def card(
    cid: str, ctype: str = "program", subtypes: list[str] | None = None, text: str = "", **kw
) -> CatCard:
    side = "corp" if ctype in ("ice", "upgrade", "asset", "operation", "agenda") else "runner"
    return CatCard(
        id=cid,
        title=cid.replace("_", " ").title(),
        side_id=kw.pop("side_id", side),
        card_type_id=ctype,
        faction_id=kw.pop("faction_id", "neutral_runner" if side == "runner" else "neutral_corp"),
        card_pool_ids=kw.pop("card_pool_ids", ["pool_new"]),
        subtypes=sorted(subtypes or []),
        text=text,
        **kw,
    )


def catalog(cards: list[CatCard], banned: list[str] | None = None) -> Catalog:
    snaps = [
        CatSnapshot(
            id="s_old",
            format_id="standard",
            card_pool_id="pool_old",
            restriction_id="r_old",
            date_start="2026-01-01",
        ),
        CatSnapshot(
            id="s_new",
            format_id="standard",
            card_pool_id="pool_new",
            restriction_id="r_new",
            date_start="2026-06-01",
        ),
    ]
    rest = [
        CatRestriction(id="r_old", name="Old"),
        CatRestriction(id="r_new", name="New", verdicts=Verdicts(banned=banned or [])),
    ]
    return Catalog(
        {
            "cards": NrdbCatalog(kind="cards", cards=cards),
            "snapshots": NrdbCatalog(kind="snapshots", snapshots=snaps),
            "restrictions": NrdbCatalog(kind="restrictions", restrictions=rest),
        }
    )


def doc(name: str, cards: dict) -> str:
    return json.dumps({"schema": bb.FILE_SCHEMAS[name], "cards": cards})


def brk(**kw):
    return {"reviewed": True, "breaks": ["barrier"], "abilities": [{"break": 1, "cost": 1}], **kw}


# ---------------------------------------------------------------- subroutines


def test_subroutines_are_counted_at_line_starts():
    text = "When rezzed, gain 1[credit].\n[subroutine] End the run.\n[subroutine] Do 1 net damage."
    assert bb.count_subroutines(text) == 2


def test_quoted_gained_subroutines_are_not_printed_ones():
    # Echo: 'This ice gains "[subroutine] End the run." for each hosted power counter.'
    assert bb.count_subroutines('This ice gains "[subroutine] End the run." for each counter.') == 0


def test_subroutines_with_crlf_and_none():
    assert bb.count_subroutines("[subroutine] A.\r\n[subroutine] B.\r\n") == 2
    assert bb.count_subroutines("") == 0


# ---------------------------------------------------------------- curated format: one rule each


BAD_FILES = {
    "not_json": ("breakers", "{", "not JSON"),
    "wrong_schema": (
        "breakers",
        json.dumps({"schema": "bb.ice/1", "cards": {}}),
        '"schema" must be bb.breakers/1',
    ),
    "extra_top_key": (
        "breakers",
        json.dumps({"schema": "bb.breakers/1", "cards": {}, "x": 1}),
        "unknown top-level",
    ),
    "cards_not_object": ("breakers", json.dumps({"schema": "bb.breakers/1", "cards": []}), '"cards" must be'),
    "bad_card_id": ("breakers", doc("breakers", {"Corroder": brk()}), "bad card id"),
    "card_id_newline": ("breakers", doc("breakers", {"corroder\n": brk()}), "bad card id"),
    "unknown_field": ("breakers", doc("breakers", {"c": brk(colour="red")}), "c: colour"),
    "no_reviewed": ("breakers", doc("breakers", {"c": {"breaks": ["barrier"]}}), "c: reviewed"),
    "no_breaks": ("breakers", doc("breakers", {"c": brk(breaks=[])}), "breaks is required"),
    "no_abilities": ("breakers", doc("breakers", {"c": brk(abilities=[])}), "abilities are required"),
    "two_actions": (
        "breakers",
        doc("breakers", {"c": brk(abilities=[{"break": 1, "pump": 1}])}),
        "exactly one of break",
    ),
    "no_action": ("breakers", doc("breakers", {"c": brk(abilities=[{"cost": 1}])}), "exactly one of break"),
    "break_zero": ("breakers", doc("breakers", {"c": brk(abilities=[{"break": 0}])}), "at least 1"),
    "break_x_fixed_cost": (
        "breakers",
        doc("breakers", {"c": brk(abilities=[{"break": "X", "cost": 2}])}),
        '"break": "X" goes with "cost": "X"',
    ),
    "bypass_false": (
        "breakers",
        doc("breakers", {"c": brk(abilities=[{"bypass": False}])}),
        "bypass is true",
    ),
    "unknown_param": (
        "breakers",
        doc("breakers", {"c": brk(strength={"per": {"virus": 1}})}),
        "unknown params: ['virus']",
    ),
    "unknown_spend_param": (
        "breakers",
        doc("breakers", {"c": brk(abilities=[{"break": 1, "spend": {"param": "power"}}])}),
        "unknown params: ['power']",
    ),
    "unknown_step_param": (
        "ice",
        doc("ice", {"i": {"reviewed": True, "strength": {"steps": [{"param": "adv", "at": 3, "add": 5}]}}}),
        "unknown params: ['adv']",
    ),
    "param_slug_newline": (
        "breakers",
        doc("breakers", {"c": brk(params={"virus\n": {"label": "V", "default": 0, "max": 3}})}),
        "c: params",
    ),
    "default_above_max": (
        "breakers",
        doc("breakers", {"c": brk(params={"v": {"label": "V", "default": 4, "max": 3}})}),
        "default must be within",
    ),
    "default_below_min": (
        "breakers",
        doc("breakers", {"c": brk(params={"v": {"label": "V", "default": 0, "min": 1, "max": 3}})}),
        "default must be within",
    ),
    "flag_range": (
        "ice",
        doc(
            "ice",
            {
                "i": {
                    "reviewed": True,
                    "params": {"f": {"label": "F", "default": 0, "max": 2, "kind": "flag"}},
                }
            },
        ),
        "a flag goes from 0 to 1",
    ),
    "no_default_variant": (
        "breakers",
        doc("breakers", {"c": brk(variants=[{"id": "a", "label": "A"}, {"id": "b", "label": "B"}])}),
        "exactly one variant is the default",
    ),
    "two_default_variants": (
        "breakers",
        doc(
            "breakers",
            {
                "c": brk(
                    variants=[
                        {"id": "a", "label": "A", "default": True},
                        {"id": "b", "label": "B", "default": True},
                    ]
                )
            },
        ),
        "exactly one variant is the default",
    ),
    "repeated_variant_id": (
        "breakers",
        doc(
            "breakers",
            {"c": brk(variants=[{"id": "a", "label": "A", "default": True}, {"id": "a", "label": "B"}])},
        ),
        "variant ids repeat",
    ),
    "unmodelled_with_abilities": (
        "breakers",
        doc("breakers", {"c": brk(unmodelled="Doesn't break.")}),
        "an unmodelled breaker has no abilities",
    ),
    "excluded_without_reason": (
        "support",
        doc("support", {"s": {"reviewed": True, "include": False}}),
        "an excluded card needs a reason",
    ),
    "included_without_effects": (
        "support",
        doc("support", {"s": {"reviewed": True}}),
        "an included card has effects",
    ),
    "effect_with_two_kinds": (
        "support",
        doc("support", {"s": {"reviewed": True, "effects": [{"ice_strength": 1, "breaker_strength": 1}]}}),
        "exactly one of ice_strength",
    ),
}


@pytest.mark.parametrize("case", sorted(BAD_FILES))
def test_curated_file_rule(case):
    name, raw, message = BAD_FILES[case]
    with pytest.raises(bb.CuratedError) as e:
        bb.parse_file(name, raw)
    assert message in str(e.value)
    assert str(e.value).startswith(f"{name}.json")


def test_a_cost_absent_is_zero_and_a_variant_may_carry_the_abilities():
    entries = bb.parse_file(
        "breakers",
        doc(
            "breakers",
            {
                "c": {
                    "reviewed": True,
                    "breaks": ["code_gate"],
                    "variants": [
                        {"id": "a", "label": "A", "default": True, "abilities": [{"break": 1}]},
                        {"id": "b", "label": "B", "abilities": [{"break": 2, "cost": 1}]},
                    ],
                }
            },
        ),
    )
    assert entries["c"].variants[0].abilities[0].cost == 0


def test_unreviewed_lists_drafts_and_uncertain_fields():
    cur = bb.Curated(
        breakers=bb.parse_file("breakers", doc("breakers", {"a": brk(), "b": brk(reviewed=False)})),
        ice=bb.parse_file("ice", doc("ice", {"i": {"reviewed": True, "uncertain": ["strength"]}})),
    )
    assert cur.unreviewed() == ["breakers:b", "ice:i"]


def test_missing_curated_files_are_empty(tmp_path):
    cur = bb.load(tmp_path)
    assert (cur.breakers, cur.ice, cur.support) == ({}, {}, {})


# ---------------------------------------------------------------- the packaged files


def test_packaged_files_are_reviewed_and_valid():
    cur, errors = load_curated()
    assert errors == []
    assert cur.breakers and cur.ice and cur.support


@pytest.mark.parametrize("name", bb.FILES)
def test_packaged_files_are_written_canonically(name):
    # The draft command rewrites the files; canonical formatting keeps its diffs to the drafts.
    path = bb.default_dir() / f"{name}.json"
    raw = path.read_bytes().decode("utf-8")
    assert bb.dump_file(name, bb.parse_file(name, raw)) == raw


def test_every_breaker_of_the_fixture_pool_has_an_entry():
    cat = Catalog(_stored_catalog_records())
    snap = cat.snapshot_at("2026-09-27")
    assert snap is not None
    pool = bb.current_pool(cat, snap.restriction_id)
    cur = bb.load()
    assert pool.breakers, "the fixture catalog has icebreakers"
    missing = [c.id for c in pool.breakers if c.id not in cur.breakers]
    assert missing == [], f"breakers.json lacks {missing}"


def _stored_catalog_records() -> dict[str, NrdbCatalog]:
    out = {}
    for kind in ("cards", "snapshots", "restrictions", "printings"):
        raw = json.loads((SOURCE / "nrdb" / "catalog" / f"{kind}.json").read_text("utf-8"))
        out[kind] = NrdbCatalog.model_validate(raw)
    return out


# ---------------------------------------------------------------- the pool slice


POOL_CARDS = [
    card("corroder", subtypes=["icebreaker", "fracter"], cost=2, strength=2, memory_cost=1),
    card("new_breaker", subtypes=["icebreaker", "ai"], cost=4, strength=1),
    card("banner_like", subtypes=["icebreaker", "fracter"]),
    card("banned_breaker", subtypes=["icebreaker", "killer"]),
    card("rotated_breaker", subtypes=["icebreaker", "decoder"], card_pool_ids=["pool_old"]),
    card(
        "wall", "ice", ["barrier"], "[subroutine] End the run.\n[subroutine] End the run.", cost=3, strength=4
    ),
    card(
        "growing",
        "ice",
        ["sentry", "ap"],
        "You can advance this ice.\n[subroutine] Do 1 net damage.",
        cost=2,
        strength=1,
    ),
    card("tailor", "hardware", text="Each piece of ice gets −1 strength."),
    card("unused", "resource", text="Gain 1[credit]."),
]


def _curated() -> bb.Curated:
    return bb.Curated(
        breakers=bb.parse_file(
            "breakers",
            doc(
                "breakers",
                {
                    "corroder": brk(abilities=[{"break": 1, "cost": 1}, {"pump": 1, "cost": 1}]),
                    "banner_like": {"reviewed": True, "unmodelled": "Doesn't break.", "note": "Fracter."},
                    "rotated_breaker": brk(),
                },
            ),
        ),
        ice=bb.parse_file(
            "ice",
            doc(
                "ice",
                {
                    "growing": {
                        "reviewed": True,
                        "params": {"advancements": {"label": "Adv", "default": 0, "max": 6}},
                        "strength": {"per": {"advancements": 1}},
                    }
                },
            ),
        ),
        support=bb.parse_file(
            "support",
            doc(
                "support",
                {
                    "tailor": {"reviewed": True, "effects": [{"ice_strength": -1}]},
                    "unused": {"reviewed": True, "include": False, "reason": "Doesn't change breaking."},
                    "gone": {"reviewed": True, "effects": [{"ice_strength": 1}]},
                },
            ),
        ),
    )


@pytest.fixture
def pool_slice():
    cat = catalog(POOL_CARDS, banned=["banned_breaker"])
    pool = bb.current_pool(cat, "r_new")
    return bb.slice_file(pool, _curated(), "2026-09-27T040000Z", SCHEMAS["breaker_bay"])


def test_slice_matches_its_schema(pool_slice):
    check(pool_slice, "breaker_bay")


def test_slice_holds_only_cards_legal_under_the_ban_list(pool_slice):
    ids = {b["id"] for b in pool_slice["breakers"]}
    assert ids == {"banner_like", "corroder", "new_breaker"}  # not banned, not rotated
    assert [i["id"] for i in pool_slice["ice"]] == ["growing", "wall"]
    assert pool_slice["restriction"] == "r_new"


def test_breaker_without_an_entry_is_unmodelled_not_reviewed(pool_slice):
    b = next(b for b in pool_slice["breakers"] if b["id"] == "new_breaker")
    assert b["unmodelled"] == bb.NOT_REVIEWED and "model" not in b


def test_unmodelled_breaker_keeps_its_reason_and_note(pool_slice):
    b = next(b for b in pool_slice["breakers"] if b["id"] == "banner_like")
    assert (b["unmodelled"], b["note"]) == ("Doesn't break.", "Fracter.")


def test_modelled_breaker_carries_its_model_without_review_fields(pool_slice):
    b = next(b for b in pool_slice["breakers"] if b["id"] == "corroder")
    assert (b["cost"], b["mu"], b["strength"]) == (2, 1, 2)
    assert b["model"] == {
        "breaks": ["barrier"],
        "abilities": [{"break": 1, "cost": 1}, {"pump": 1, "cost": 1}],
    }


def test_ice_has_its_interfacing_types_subroutines_and_correction(pool_slice):
    wall, growing = (next(i for i in pool_slice["ice"] if i["id"] == k) for k in ("wall", "growing"))
    assert (wall["types"], wall["subs"], wall["rez"], wall["strength"]) == (["barrier"], 2, 3, 4)
    assert "model" not in wall
    assert growing["types"] == ["sentry"] and growing["subtypes"] == ["ap", "sentry"]
    assert growing["model"]["strength"] == {"per": {"advancements": 1}}


def test_support_lists_included_cards_in_the_pool_only(pool_slice):
    assert [s["id"] for s in pool_slice["support"]] == ["tailor"]
    assert pool_slice["support"][0]["model"] == {"effects": [{"ice_strength": -1}]}


def test_no_ban_list_gives_an_empty_pool():
    out = bb.slice_file(bb.current_pool(catalog(POOL_CARDS), None), bb.Curated(), "v", SCHEMAS["breaker_bay"])
    assert (out["restriction"], out["breakers"], out["ice"], out["support"]) == (None, [], [], [])
    check(out, "breaker_bay")


# ---------------------------------------------------------------- drafts


def test_draft_of_a_plain_breaker_is_certain():
    c = card(
        "buzzsaw",
        subtypes=["icebreaker", "decoder"],
        text="Interface → <strong>1[credit]:</strong> Break up to 2 <strong>code gate</strong> subroutines.\n"
        "<strong>3[credit]:</strong> +1 strength.",
    )
    assert bb.draft_breaker(c) == {
        "reviewed": False,
        "breaks": ["code_gate"],
        "abilities": [{"break": 2, "cost": 1}, {"pump": 1, "cost": 3}],
    }


def test_draft_marks_type_only_for_a_breaker_of_several_types():
    c = card(
        "lobi",
        subtypes=["icebreaker", "decoder", "fracter"],
        text="Interface → 1[credit]: Break 1 code gate subroutine.\n1[credit]: +2 strength.",
    )
    d = bb.draft_breaker(c)
    assert d["breaks"] == ["code_gate", "barrier"]
    assert d["abilities"][0] == {"break": 1, "cost": 1, "only": ["code_gate"]}


def test_draft_of_an_ai_breaks_any_ice():
    c = card(
        "may",
        subtypes=["icebreaker", "ai"],
        text="Interface → 1[credit]: Break 1 subroutine.\n1[credit]: +1 strength.",
    )
    d = bb.draft_breaker(c)
    assert d["breaks"] == ["any"] and "uncertain" not in d


def test_draft_reads_any_number_and_x():
    c = card(
        "u",
        subtypes=["icebreaker", "killer"],
        text="Interface → 2[credit]: Break any number of sentry subroutines.\nInterface → X[credit]: Break X sentry subroutines.",
    )
    assert bb.draft_breaker(c)["abilities"] == [{"break": "any", "cost": 2}, {"break": "X", "cost": "X"}]


def test_draft_is_uncertain_about_conditions_and_other_text():
    c = card(
        "m",
        subtypes=["icebreaker", "fracter"],
        text="Interface → 2[credit]: Break 1 barrier subroutine. If you made a successful run this turn, "
        "this ability costs 1[credit] less to use.\n1[credit]: +1 strength.",
    )
    assert bb.draft_breaker(c)["uncertain"] == ["abilities", "params", "variants"]


def test_draft_is_uncertain_about_a_variable_pump():
    c = card(
        "u",
        subtypes=["icebreaker", "decoder"],
        text="Interface → 1[credit]: Break 1 code gate subroutine.\n1[credit]: +X strength.",
    )
    d = bb.draft_breaker(c)
    assert {"pump": "X", "cost": 1} in d["abilities"] and "abilities" in d["uncertain"]


def test_draft_without_abilities_or_types_is_uncertain():
    d = bb.draft_breaker(
        card("b", subtypes=["icebreaker"], text="Interface → 2[credit]: Subroutines can't end the run.")
    )
    assert d["abilities"] == [] and {"abilities", "breaks"} <= set(d["uncertain"])
    # The draft is incomplete but still a valid entry; reviewed, it would not be.
    assert bb.BreakerEntry.model_validate(d).reviewed is False
    with pytest.raises(ValueError, match="breaks is required"):
        bb.BreakerEntry.model_validate(d | {"reviewed": True})


def test_draft_notes_stealth_credits():
    c = card(
        "s",
        subtypes=["icebreaker", "fracter"],
        text="Interface → 1[credit]: Break 1 barrier subroutine.\nSpend credits only from <strong>stealth</strong> cards to use this ability.",
    )
    assert bb.draft_breaker(c)["stealth"] is True


def test_ice_draft_only_for_ice_whose_values_change():
    assert bb.draft_ice(card("w", "ice", ["barrier"], "[subroutine] End the run.")) is None
    d = bb.draft_ice(
        card(
            "t",
            "ice",
            ["barrier"],
            "You can advance this ice. It gets +1 strength for each hosted advancement counter.",
        )
    )
    assert d == {"reviewed": False, "uncertain": ["params", "strength", "subs"]}


@pytest.mark.parametrize(
    "text",
    [
        "Host ice gets −2 strength.",  # NRDB's minus sign, U+2212
        "Host ice gets -2 strength.",
        "Each piece of ice gets +2 strength.",
        "Host ice gains barrier, code gate, and sentry.",
        "Choose an ice subtype. The ice you are encountering gains that subtype.",
    ],
)
def test_support_candidates(text):
    assert bb.support_candidate(card("x", "hardware", text=text))


def test_support_candidates_leave_out_ice_breakers_and_unrelated_cards():
    assert not bb.support_candidate(card("x", "resource", text="Gain 3[credit]."))
    assert not bb.support_candidate(card("i", "ice", ["barrier"], "It gets +2 strength."))
    assert not bb.support_candidate(card("b", subtypes=["icebreaker"], text="1[credit]: +1 strength."))


def test_draft_adds_missing_entries_and_keeps_existing_ones():
    cat = catalog(POOL_CARDS, banned=["banned_breaker"])
    pool = bb.current_pool(cat, "r_new")
    cur = _curated()
    entries, rep = bb.draft(pool, cur)
    assert rep.added == {"breakers": ["new_breaker"], "ice": [], "support": []}
    assert entries["breakers"]["corroder"] is cur.breakers["corroder"]
    assert entries["breakers"]["new_breaker"].reviewed is False
    assert rep.outside_pool["breakers"] == ["rotated_breaker"] and "rotated_breaker" in entries["breakers"]
    assert rep.outside_pool["support"] == ["gone"]


def test_draft_prune_removes_entries_outside_the_pool():
    pool = bb.current_pool(catalog(POOL_CARDS, banned=["banned_breaker"]), "r_new")
    entries, rep = bb.draft(pool, _curated(), prune=True)
    assert rep.pruned["breakers"] == ["rotated_breaker"] and "rotated_breaker" not in entries["breakers"]
    assert rep.pruned["support"] == ["gone"]


def test_draft_proposes_support_candidates_and_ice():
    cards = [*POOL_CARDS, card("wrench", "program", ["trojan"], "Host ice gets −2 strength.")]
    cards.append(
        card("grow2", "ice", ["barrier"], "It gets +1 strength for each hosted advancement counter.")
    )
    entries, rep = bb.draft(bb.current_pool(catalog(cards), "r_new"), bb.Curated())
    assert rep.added["support"] == ["tailor", "wrench"]
    assert rep.added["ice"] == ["grow2", "growing"]
    assert entries["support"]["wrench"].uncertain == ["include", "effects"]


def test_written_drafts_round_trip(tmp_path):
    pool = bb.current_pool(catalog(POOL_CARDS), "r_new")
    entries, _ = bb.draft(pool, _curated())
    bb.write(tmp_path, entries)
    again = bb.load(tmp_path)
    assert set(again.breakers) == set(entries["breakers"])
    assert "breakers:new_breaker" in again.unreviewed()
    assert b"\r\n" not in (tmp_path / "breakers.json").read_bytes()


# ---------------------------------------------------------------- publishing


def test_load_curated_refuses_unreviewed_entries(tmp_path):
    (tmp_path / "breakers.json").write_text(doc("breakers", {"c": brk(reviewed=False)}), "utf-8")
    _, errors = load_curated(tmp_path)
    assert errors == ["breaker-bay: not reviewed: breakers:c"]


def test_load_curated_reports_a_broken_file(tmp_path):
    (tmp_path / "ice.json").write_text("[]", "utf-8")
    cur, errors = load_curated(tmp_path)
    assert errors == ['breaker-bay: ice.json: "schema" must be bb.ice/1']
    assert cur.breakers == {}


# ---------------------------------------------------------------- the draft command


@pytest.fixture
def store(tmp_path, monkeypatch):
    shutil.copytree(SOURCE, tmp_path / "store" / "mr-source", dirs_exist_ok=True)
    monkeypatch.setenv("MR_LOCAL_STORE", str(tmp_path / "store"))
    monkeypatch.setenv("CONTACT", "ops@example.invalid")
    return tmp_path


def _draft(*args: str):
    return CliRunner().invoke(app, ["breaker-bay", "draft", "--now", "2026-09-27T04:00:00Z", *args])


def test_draft_command_writes_drafts_for_missing_breakers(store):
    d = store / "curated"
    shutil.copytree(bb.default_dir(), d)
    raw = json.loads((d / "breakers.json").read_text("utf-8"))
    del raw["cards"]["corsair"]
    (d / "breakers.json").write_text(json.dumps(raw), "utf-8")
    r = _draft("--dir", str(d))
    assert r.exit_code == 0, r.output
    assert "breakers.json drafted: corsair" in r.output
    assert "waiting for review: 1 (breakers:corsair)" in r.output
    cur = bb.load(d)
    assert cur.breakers["corsair"].reviewed is False and cur.breakers["corsair"].stealth is True


def test_draft_command_with_nothing_missing_leaves_the_files(store):
    d = store / "curated"
    shutil.copytree(bb.default_dir(), d)
    before = {p.name: p.read_bytes() for p in d.iterdir()}
    r = _draft("--dir", str(d))
    assert r.exit_code == 0, r.output
    assert "waiting for review: 0" in r.output
    assert {p.name: p.read_bytes() for p in d.iterdir()} == before


def test_draft_command_without_a_catalog_exits_1(tmp_path, monkeypatch):
    monkeypatch.setenv("MR_LOCAL_STORE", str(tmp_path / "empty"))
    r = _draft("--dir", str(tmp_path / "curated"))
    assert r.exit_code == 1 and "No card catalog stored yet" in r.output


def test_draft_command_with_a_broken_file_exits_1(store):
    d = store / "curated"
    d.mkdir()
    (d / "support.json").write_text("{", "utf-8")
    r = _draft("--dir", str(d))
    assert r.exit_code == 1 and "support.json: not JSON" in r.output


def test_slice_is_in_the_published_snapshot_files_list():
    assert Path(EXPECTED / "snapshot").is_dir()
    found = list((EXPECTED / "snapshot").glob("v=*/breaker-bay/pool.json"))
    assert len(found) == 1
    check(json.loads(found[0].read_text("utf-8")), "breaker_bay")
