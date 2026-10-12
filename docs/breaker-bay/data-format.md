# Breaker Bay: curated data format

Breaker Bay's cost model comes from three hand-curated JSON files in
`market-research/pipeline/market_research/data/breaker_bay/`. The pipeline joins them with the
NetrunnerDB catalog into the snapshot's `breaker-bay/pool.json`
([schema](../market-research/snapshot-contract/breaker_bay.schema.json),
[example](../market-research/snapshot-contract/examples/breaker_bay.example.json)). The page
computes every cost from that file.

| File | Schema | Holds |
|---|---|---|
| `breakers.json` | `bb.breakers/1` | One entry for every icebreaker in the Standard pool |
| `ice.json` | `bb.ice/1` | Corrections for ice whose strength, subroutines or subtypes change during play |
| `support.json` | `bb.support/1` | Other cards that change ice strength, subroutines, subtypes or breaker strength |

Each file is `{"schema": "<id>", "cards": {"<card id>": <entry>}}`, keyed by NetrunnerDB card id and
sorted. A field left out takes its default, so the files only say what differs. `breaker-bay draft`
writes the files in this exact form (two-space indent, LF), and a test keeps them that way.

## Review

Every entry has `"reviewed"`. Drafts come with `"reviewed": false` and an `"uncertain"` list naming
the fields the draft could not settle (`abilities`, `variants`, `params`, `strength`, `subs`,
`include`, `effects`…). To review an entry: read the card, correct the entry, remove `uncertain` and
set `"reviewed": true`. While any entry is unreviewed or has `uncertain` fields, the tests fail and
`compute` publishes nothing.

What the printed card data already says is never repeated here: cost, strength, memory cost,
subtypes and the number of printed subroutines (the `[subroutine]` lines of the text) come from
NetrunnerDB.

## Amounts

Wherever a number goes, an amount can be a plain integer or an object that depends on params:

```json
{"base": 3, "per": {"cybernetic": -1}, "min": 0}
{"steps": [{"param": "advancements", "at": 3, "add": 5}]}
```

Its value is `base` (default 0), plus each param's value times its factor in `per`, plus `add` of
every step whose param is at least `at`, raised to `min` when it is lower.

## Params

A card's settings, shown as sliders (or checkboxes for flags) in the card settings panel:

```json
"params": {"virus": {"label": "Hosted virus counters", "default": 2, "max": 6}}
```

| Field | Meaning |
|---|---|
| `label` | What the slider says |
| `default` | The value the card itself gives (Hantu places 2 virus counters on install) |
| `min`, `max` | The range; `min` defaults to 0 |
| `kind` | `count` (default) or `flag`, a 0/1 yes-no setting |

Amounts and `spend` name params by id (`a-z`, `0-9`, `_`); a name that isn't in `params` is an error.

## breakers.json

```json
"marjanah": {
  "reviewed": true,
  "breaks": ["barrier"],
  "abilities": [{"break": 1, "cost": 2}, {"pump": 1, "cost": 1}],
  "variants": [
    {"id": "no_run", "label": "Without a successful run this turn", "default": true},
    {"id": "after_run", "label": "After a successful run this turn",
     "abilities": [{"break": 1, "cost": 1}, {"pump": 1, "cost": 1}]}
  ]
}
```

| Field | Meaning |
|---|---|
| `breaks` | Ice subtypes it interfaces with: `barrier`, `code_gate`, `sentry`, or `any` for AI |
| `stealth` | Its abilities spend credits only from stealth cards (a filter on the page) |
| `special` | Why it only works in narrow situations (Slap Vandal: one host ice; Mayfly: one run); the page has a switch that leaves these out |
| `params` | Its settings |
| `strength` | An amount added to the printed strength (Echelon: one per installed icebreaker) |
| `abilities` | Its paid abilities, below |
| `variants` | Situations that change it, below |
| `note` | A short remark shown with the card (a condition the model leaves out) |
| `unmodelled` | Instead of the above: why it has no cost (Banner doesn't break subroutines) |

### Abilities

Each ability has exactly one action:

| Action | Meaning |
|---|---|
| `"break": n` | Break up to n subroutines per use; `"any"` breaks any number; `"X"` breaks X for X credits (with `"cost": "X"`) |
| `"pump": amount` | +strength per use, for the encounter |
| `"weaken": amount` | The ice gets −strength per use, for the encounter (Corsair) |
| `"bypass": true` | Pass the ice without breaking it (Afterimage, Curupira) |
| `"rebate": amount` | Credits gained back after fully breaking the ice (Makler) |

and optionally:

| Field | Meaning |
|---|---|
| `cost` | Credits per use, an amount (default 0), or `"X"` with `"break": "X"` |
| `spend` | `{"param": "power", "n": 1}`: also uses up n of what the param counts (hosted counters, cards in the grip) |
| `only` | Works only on ice with one of these subtypes (Lobisomem breaks code gates one way and barriers another) |
| `once` | Usable once per `encounter`, `run` or `turn` |

### Variants

A variant is another situation for the same card: an install turn, a successful run this turn,
a threat level, a bypass instead of breaking. Each variant has an `id`, a `label` and, for exactly
one of them, `"default": true`. It may set `breaks`, `strength`, `abilities` and `note`; each one it
sets replaces the entry's own. The page shows each variant as its own row and box.

## ice.json

Only ice whose values change during play needs an entry; the rest is read from the card. An entry
with nothing but `"reviewed": true` (and maybe a `note`) records that the ice was checked and needs
no correction, so drafts don't propose it again.

```json
"pharos": {
  "reviewed": true,
  "params": {"advancements": {"label": "Hosted advancement counters", "default": 0, "max": 6}},
  "strength": {"steps": [{"param": "advancements", "at": 3, "add": 5}]}
}
```

| Field | Meaning |
|---|---|
| `params` | Its settings (advancement counters, hosted counters, flags like "Protecting a remote server") |
| `strength` | An amount added to the printed strength |
| `subs` | An amount added to the printed subroutines (Echo: one per hosted power counter) |
| `gains` | Subtypes it has besides the printed ones (Lycian Multi-Munition, counted with all three) |
| `broken_only_by` | Only breakers with one of these subtypes can break it (Semak-samun: `["fracter"]`) |
| `unbreakable` | Why its subroutines can't be broken at all |
| `note` | A short remark (a condition the model leaves out, like Afshar on HQ) |

## support.json

Cards that change breaking for every breaker or every piece of ice, shown as checkboxes:

```json
"thunderbolt_armaments_peace_through_power": {
  "reviewed": true,
  "effects": [
    {"ice_strength": 1, "ice": ["ap", "destroyer"]},
    {"ice_subs": 1, "ice": ["ap", "destroyer"]}
  ]
}
```

| Field | Meaning |
|---|---|
| `include` | `false` keeps a draft candidate out of Breaker Bay (with `reason`), so drafts don't propose it again |
| `reason` | Why it is left out |
| `params` | Its settings (Leech's virus counters) |
| `effects` | What it does when checked, below |
| `note` | The condition the effect really has (Monkeywrench: only its host ice) |

Each effect has exactly one of `ice_strength`, `ice_subs` (amounts), `ice_gains` (a list of ice
subtypes) or `breaker_strength` (an amount). `ice` limits an ice effect to ice with one of the given
NetrunnerDB subtypes; `"breakers": "non_ai"` limits a breaker effect to non-AI icebreakers.

## Drafts

`market-research breaker-bay draft` (see the [CLI](../../market-research/README.md#cli)) reads the
stored catalog and the Standard ban list in force, and adds:

- an entry for every icebreaker without one, from its text: the types from its subtypes, every
  `N[credit]: Break …` and `N[credit]: +N strength` it can read, `stealth` when the text says
  stealth credits. Anything else in the text (conditions, counters, other mechanics) marks
  `abilities`, `variants` and `params` uncertain;
- an entry for ice whose text mentions strength, advancing, hosted counters, gained subroutines or
  breaking limits, with `params`, `strength` and `subs` uncertain;
- an entry for every other card whose text changes strength (`+2 strength`, `−1 strength`) or gives
  ice subtypes, with `include` and `effects` uncertain.

Existing entries are never changed. Entries for cards that left the pool are reported, and
`--prune` removes them.
