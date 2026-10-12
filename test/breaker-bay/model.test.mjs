// Breaker Bay's model (public/breaker-bay/model.js): amounts, the cost of one encounter, filters,
// the run planner and the address. Small hand-built pools, one rule per test; the last tests run
// the pipeline's golden pool.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as M from '../../public/breaker-bay/model.js';

const breaker = (id, subtypes, model, extra = {}) => ({
  id, title: id, faction: 'anarch', cost: 2, mu: 1, strength: 2, subtypes: ['icebreaker', ...subtypes], model, ...extra,
});
const ice = (id, types, strength, subs, extra = {}) => ({
  id, title: id, faction: 'weyland_consortium', rez: 3, strength, subtypes: [...types], types, subs, ...extra,
});
const fracter = (abilities, extra = {}) => breaker('f', ['fracter'], { breaks: ['barrier'], abilities, ...extra });
const row = (b, variant = true) => M.breakerRows({ breakers: [b] }, { variants: variant })[0];
const cost = (b, i, opts) => M.encounter(row(b), i, opts);
const credits = (b, i, opts) => cost(b, i, opts)?.credits ?? null;
const BRK1 = { break: 1, cost: 1 };
const PUMP1 = { pump: 1, cost: 1 };

// ---------------------------------------------------------------- amounts

test('an amount is a number or base + params × factors', () => {
  assert.equal(M.amount(3), 3);
  assert.equal(M.amount(null), 0);
  assert.equal(M.amount({ base: 3, per: { cyber: -1 } }, { cyber: 2 }), 1);
});

test('an amount is floored at its min', () => {
  assert.equal(M.amount({ base: 3, per: { cyber: -1 }, min: 0 }, { cyber: 5 }), 0);
});

test('a step adds once its param reaches the threshold: at, below, above', () => {
  const a = { steps: [{ param: 'adv', at: 3, add: 5 }] };
  assert.deepEqual([2, 3, 4].map((n) => M.amount(a, { adv: n })), [0, 5, 5]);
});

test('param values take the card default unless a change is within min..max', () => {
  const model = { params: { v: { label: 'V', default: 2, max: 4 }, w: { label: 'W', default: 1, min: 1, max: 3 } } };
  assert.deepEqual(M.paramValues(model, {}), { v: 2, w: 1 });
  assert.deepEqual(M.paramValues(model, { v: 4, w: 3 }), { v: 4, w: 3 });
  // Outside the range, negative or not a whole number: the default.
  assert.deepEqual(M.paramValues(model, { v: 5, w: 0 }), { v: 2, w: 1 });
  assert.deepEqual(M.paramValues(model, { v: -1, w: 1.5 }), { v: 2, w: 1 });
  assert.deepEqual(M.paramValues(model, { v: '3' }), { v: 2, w: 1 });
});

// ---------------------------------------------------------------- rows

test('every variant is its own row; without variants only the default is left', () => {
  const b = fracter([BRK1], {
    variants: [
      { id: 'a', label: 'A', default: true },
      { id: 'b', label: 'B', abilities: [{ break: 1, cost: 0 }] },
    ],
  });
  const all = M.breakerRows({ breakers: [b] });
  assert.deepEqual(all.map((r) => r.key), ['f:a', 'f:b']);
  assert.deepEqual(all[1].model.abilities, [{ break: 1, cost: 0 }]);
  assert.deepEqual(all[0].model.abilities, [BRK1]);
  const one = M.breakerRows({ breakers: [b] }, { variants: false });
  assert.deepEqual(one.map((r) => [r.key, r.label]), [['f', 'f']]);
});

test('a breaker without a model has no row', () => {
  assert.deepEqual(M.breakerRows({ breakers: [breaker('banner', ['fracter'], undefined, { unmodelled: 'x' })] }), []);
});

test('an AI fills the AI slot; a breaker of two types fills its first', () => {
  assert.equal(row(breaker('a', ['ai'], { breaks: ['any'], abilities: [BRK1] })).slot, 'ai');
  assert.deepEqual(row(breaker('l', ['decoder', 'fracter'], { breaks: ['barrier', 'code_gate'], abilities: [BRK1] })).types, ['fracter', 'decoder']);
});

// ---------------------------------------------------------------- one encounter

const wall = ice('wall', ['barrier'], 4, 2);

test('pump to the ice strength, then break every subroutine', () => {
  const r = cost(fracter([BRK1, PUMP1]), wall);
  assert.equal(r.credits, 4); // 2 pumps + 2 breaks
  assert.equal(M.describe(r), '2× +1 strength at 1c + 2× break 1 at 1c = 4c');
});

test('equal strength needs no pump; one below needs one', () => {
  assert.equal(credits(fracter([BRK1, PUMP1], {}), ice('w', ['barrier'], 2, 1)), 1);
  assert.equal(credits(fracter([BRK1, PUMP1]), ice('w', ['barrier'], 3, 1)), 2);
});

test('a breaker that does not interface with the ice has no cost', () => {
  assert.equal(cost(fracter([BRK1, PUMP1]), ice('gate', ['code_gate'], 1, 1)), null);
});

test('an AI interfaces with any ice, typed or not', () => {
  const ai = breaker('ai', ['ai'], { breaks: ['any'], abilities: [BRK1, PUMP1] });
  assert.equal(credits(ai, ice('trap', [], 1, 1)), 1);
});

test('without a pump, ice stronger than the breaker is out of reach', () => {
  assert.equal(cost(fracter([BRK1]), wall), null);
});

test('break up to n subroutines rounds up the uses', () => {
  assert.equal(credits(fracter([{ break: 2, cost: 1 }, PUMP1]), ice('w', ['barrier'], 2, 3)), 2);
});

test('break any breaks every subroutine in one use', () => {
  assert.equal(credits(fracter([{ break: 'any', cost: 2 }]), ice('w', ['barrier'], 2, 5)), 2);
});

test('break X costs one credit per subroutine, once', () => {
  const r = cost(fracter([{ break: 'X', cost: 'X', once: 'run' }]), ice('w', ['barrier'], 2, 3));
  assert.equal(r.credits, 3);
  assert.equal(M.describe(r), 'break 3 (X) at 3c = 3c');
});

test('an ability usable once per encounter breaks only that many subroutines', () => {
  const vandal = fracter([{ break: 1, cost: 1, once: 'encounter' }]);
  assert.equal(credits(vandal, ice('w', ['barrier'], 2, 1)), 1);
  assert.equal(cost(vandal, ice('w', ['barrier'], 2, 2)), null);
});

test('the cheapest mix of break abilities wins', () => {
  // Euler on its install turn: 0c for 1, 2c for up to 2.
  const b = fracter([{ break: 1 }, { break: 2, cost: 2 }]);
  assert.equal(credits(b, ice('w', ['barrier'], 2, 3)), 0);
});

test('a break ability limited to one subtype works only on that ice', () => {
  const lobisomem = breaker('l', ['decoder', 'fracter'], {
    breaks: ['barrier', 'code_gate'], abilities: [{ break: 1, cost: 1, only: ['code_gate'] }],
  });
  assert.equal(credits(lobisomem, ice('g', ['code_gate'], 1, 1)), 1);
  assert.equal(cost(lobisomem, ice('b', ['barrier'], 1, 1)), null);
});

test('a weaken lowers the ice strength instead of raising the breaker', () => {
  const corsair = breaker('c', ['fracter'], { breaks: ['barrier'], abilities: [BRK1, { weaken: 3, cost: 1 }] }, { strength: 0 });
  const r = cost(corsair, ice('w', ['barrier'], 5, 1));
  assert.equal(r.credits, 3);
  assert.equal(r.steps[0].label, '−3 ice strength');
});

test('spent counters limit the uses (n defaults to 1): two give exactly the strength, one is not enough', () => {
  const hantu = breaker('h', ['killer'], {
    breaks: ['sentry'], params: { virus: { label: 'V', default: 2, max: 6 } },
    abilities: [BRK1, { pump: 2, spend: { param: 'virus' } }],
  });
  assert.equal(credits(hantu, ice('s', ['sentry'], 6, 1)), 1);
  assert.equal(cost(hantu, ice('s', ['sentry'], 6, 1), { breakerParams: { virus: 1 } }), null);
  const r = cost(hantu, ice('s', ['sentry'], 6, 1));
  assert.equal(r.left.virus, 0);
});

test('a bypass passes the ice without breaking it', () => {
  const afterimage = breaker('a', ['killer'], { breaks: ['sentry'], abilities: [{ bypass: true, cost: 2, once: 'turn' }, BRK1] });
  const r = cost(afterimage, ice('s', ['sentry'], 9, 3));
  assert.equal(r.credits, 2);
  assert.equal(r.bypass, true);
});

test('a bypass that spends counters needs them', () => {
  const curupira = fracter([{ bypass: true, spend: { param: 'power', n: 3 } }], { params: { power: { label: 'P', default: 0, max: 6 } } });
  assert.equal(cost(curupira, wall), null);
  assert.equal(credits(curupira, wall, { breakerParams: { power: 3 } }), 0);
});

test('a rebate comes back after breaking, never below 0', () => {
  const makler = fracter([{ break: 2, cost: 2 }, { rebate: 1, once: 'turn' }]);
  assert.equal(credits(makler, ice('w', ['barrier'], 2, 2)), 1);
  assert.equal(credits(fracter([BRK1, { rebate: 5 }]), ice('w', ['barrier'], 2, 1)), 0);
});

test('ice without subroutines costs nothing to pass', () => {
  assert.equal(M.describe(cost(fracter([BRK1]), ice('k', ['barrier'], 0, 0))), 'Nothing to break: 0c');
});

test('a variant strength bonus counts', () => {
  const gauss = fracter([BRK1], { variants: [{ id: 'later', label: 'L', default: true }, { id: 'install', label: 'I', strength: 3 }] });
  const rows = M.breakerRows({ breakers: [gauss] });
  assert.equal(M.encounter(rows[0], wall), null);
  assert.equal(M.encounter(rows[1], wall).credits, 2);
});

test('a breaker strength amount uses its params', () => {
  const echelon = fracter([BRK1], { strength: { per: { icebreakers: 1 } }, params: { icebreakers: { label: 'I', default: 3, min: 1, max: 8 } } });
  assert.equal(credits(echelon, ice('w', ['barrier'], 5, 1)), 1);
  assert.equal(cost(echelon, ice('w', ['barrier'], 5, 1), { breakerParams: { icebreakers: 2 } }), null);
});

// ---------------------------------------------------------------- ice and support

test('ice corrections add strength and subroutines from its params', () => {
  const pharos = ice('pharos', ['barrier'], 5, 3, { model: { params: { adv: { label: 'A', default: 0, max: 6 } }, strength: { steps: [{ param: 'adv', at: 3, add: 5 }] } } });
  assert.equal(M.iceState(pharos, {}).strength, 5);
  assert.equal(M.iceState(pharos, { adv: 3 }).strength, 10);
  const echo = ice('echo', ['barrier'], 0, 0, { model: { params: { power: { label: 'P', default: 1, max: 6 } }, subs: { per: { power: 1 } } } });
  assert.equal(M.iceState(echo, { power: 4 }).subs, 4);
});

test('ice that only fracters can break is out of reach for others, AI included', () => {
  const semak = ice('semak', ['barrier'], 3, 1, { model: { broken_only_by: ['fracter'] } });
  assert.equal(credits(fracter([BRK1, PUMP1]), semak), 2);
  const ai = breaker('ai', ['ai'], { breaks: ['any'], abilities: [BRK1, PUMP1] });
  assert.equal(cost(ai, semak), null);
});

test('gained subtypes let other breakers interface', () => {
  const lycian = ice('lycian', [], 1, 1, { model: { gains: ['barrier', 'code_gate', 'sentry'] } });
  assert.equal(credits(fracter([BRK1, PUMP1]), lycian), 1);
});

const support = (id, effects, params) => ({ id, title: id, model: { effects, ...(params ? { params } : {}) }, params: {} });

test('support: ice strength for every ice, or only some subtypes', () => {
  const tailor = { ...support('t', [{ ice_strength: -1 }]) };
  assert.equal(M.iceState(wall, {}, [tailor]).strength, 3);
  const thunder = support('t', [{ ice_strength: 1, ice: ['ap'] }]);
  assert.equal(M.iceState(wall, {}, [thunder]).strength, 4);
  assert.equal(M.iceState(ice('ap', ['sentry', 'ap'], 2, 1), {}, [thunder]).strength, 3);
});

test('support: extra subroutines and gained subtypes', () => {
  const s = support('t', [{ ice_subs: 1 }, { ice_gains: ['sentry'] }]);
  const st = M.iceState(wall, {}, [s]);
  assert.equal(st.subs, 3);
  assert.deepEqual(st.types, ['barrier', 'sentry']);
});

test('support: breaker strength for non-AI breakers only', () => {
  const dragon = support('g', [{ breaker_strength: 1, breakers: 'non_ai' }]);
  assert.equal(credits(fracter([BRK1, PUMP1]), ice('w', ['barrier'], 3, 1), { support: [dragon] }), 1);
  const ai = breaker('ai', ['ai'], { breaks: ['any'], abilities: [BRK1, PUMP1] });
  assert.equal(credits(ai, ice('w', ['barrier'], 3, 1), { support: [dragon] }), 2);
});

test('activeSupport keeps the checked cards with their params', () => {
  const pool = { support: [support('leech', [{ ice_strength: { per: { virus: -1 } } }], { virus: { label: 'V', default: 0, max: 6 } }), support('x', [])] };
  const on = M.activeSupport(pool, { leech: { params: { virus: 2 } } });
  assert.deepEqual(on.map((x) => [x.id, x.params]), [['leech', { virus: 2 }]]);
});

// ---------------------------------------------------------------- filters

const POOL = {
  breakers: [
    breaker('corroder', ['fracter'], { breaks: ['barrier'], abilities: [BRK1, PUMP1] }),
    breaker('afterimage', ['killer'], { breaks: ['sentry'], stealth: true, abilities: [BRK1, PUMP1] }, { faction: 'criminal' }),
    breaker('vandal', ['ai'], { breaks: ['any'], special: 'Host ice only.', abilities: [{ break: 1, cost: 1, once: 'encounter' }] }, { faction: 'shaper', cost: 3 }),
  ],
  ice: [
    ice('wall', ['barrier'], 2, 1),
    ice('tower', ['barrier'], 5, 1, { rez: 7, faction: 'jinteki' }),
    ice('sentry', ['sentry'], 3, 2),
    ice('trap', [], 1, 1),
  ],
  support: [],
};

test('breaker filters: type, faction, stealth, special', () => {
  const keys = (s) => M.filterRows(POOL, { ...M.defaultState(), ...s }).map((r) => r.key);
  assert.deepEqual(keys({}), ['corroder', 'afterimage', 'vandal']);
  assert.deepEqual(keys({ bt: new Set(['killer']) }), ['afterimage']);
  assert.deepEqual(keys({ bf: new Set(['criminal']) }), ['afterimage']);
  assert.deepEqual(keys({ stealth: 'only' }), ['afterimage']);
  assert.deepEqual(keys({ stealth: 'none' }), ['corroder', 'vandal']);
  assert.deepEqual(keys({ special: false }), ['corroder', 'afterimage']);
});

test('an explicit pick of breakers overrides the other breaker filters', () => {
  const s = { ...M.defaultState(), bt: new Set(['fracter']), special: false, pickB: new Set(['vandal']) };
  assert.deepEqual(M.filterRows(POOL, s).map((r) => r.key), ['vandal']);
});

test('ice filters: type groups, faction, rez and strength ranges', () => {
  const ids = (s) => M.filterIce(POOL, { ...M.defaultState(), ...s }).map((x) => `${x.group}:${x.ice.id}`);
  assert.deepEqual(ids({}), ['barrier:wall', 'barrier:tower', 'sentry:sentry', 'other:trap']);
  assert.deepEqual(ids({ it: new Set(['sentry']) }), ['sentry:sentry', 'other:trap']);
  assert.deepEqual(ids({ bt: new Set(['fracter']) }), ['barrier:wall', 'barrier:tower', 'sentry:sentry']); // untyped ice only with AI
  assert.deepEqual(ids({ if: new Set(['jinteki']) }), ['barrier:tower']);
  assert.deepEqual(ids({ rez: [7, 7] }), ['barrier:tower']);
  assert.deepEqual(ids({ str: [2, 3] }), ['barrier:wall', 'sentry:sentry']);
});

test('the strength range sees strength after support cards', () => {
  const s = { ...M.defaultState(), str: [4, 4] };
  const plus2 = support('nac', [{ ice_strength: 2 }]);
  // wall 2 → 4, sentry 3 → 5: printed strength would pick the other one.
  assert.deepEqual(M.filterIce(POOL, s, [plus2]).map((x) => x.ice.id), ['wall']);
  assert.deepEqual(M.filterIce(POOL, { ...s, str: [5, 5] }, [plus2]).map((x) => x.ice.id), ['sentry']);
});

test('an explicit pick of ice overrides type and faction, not the ranges', () => {
  const s = { ...M.defaultState(), it: new Set(['sentry']), pickI: new Set(['tower', 'wall']) };
  assert.deepEqual(M.filterIce(POOL, s).map((x) => x.ice.id), ['wall', 'tower']);
  assert.deepEqual(M.filterIce(POOL, { ...s, rez: [0, 3] }).map((x) => x.ice.id), ['wall']);
});

test('a phone starts with fracters and barriers', () => {
  const s = M.defaultState({ phone: true });
  assert.deepEqual([[...s.bt], [...s.it]], [['fracter'], ['barrier']]);
});

test('quartiles of an even and an odd count, and of nothing', () => {
  assert.deepEqual(M.quartiles([4, 1, 3, 2]).med, 2.5);
  assert.deepEqual(M.quartiles([3, 1, 2]), { min: 1, q1: 1.5, med: 2, q3: 2.5, max: 3, n: 3, mean: 2 });
  assert.equal(M.quartiles([]), null);
});

// ---------------------------------------------------------------- run planner

test('rigs rank by the credits for the whole server', () => {
  const s = M.defaultState();
  const rows = M.filterRows(POOL, s);
  const rigs = M.rankRigs(POOL, rows, ['wall', 'sentry'], s, []);
  assert.deepEqual(rigs[0].rig.map((r) => r.key), ['corroder', 'afterimage']);
  assert.equal(rigs[0].total, 1 + 3); // wall: 1 break; sentry: 1 pump + 2 breaks
});

test('a rig with a breaker that breaks nothing is dropped; equal credits rank by install cost', () => {
  const s = M.defaultState();
  const rigs = M.rankRigs(POOL, M.filterRows(POOL, s), ['wall'], s, []);
  // Corroder + Vandal would break Wall with Corroder alone: not listed.
  assert.deepEqual(rigs.map((r) => r.rig.map((x) => x.key).join('+')), ['corroder', 'vandal']);
});

test('the rig size limits the breakers', () => {
  const s = M.defaultState();
  const rows = M.filterRows(POOL, s);
  assert.deepEqual(M.rankRigs(POOL, rows, ['wall', 'sentry'], s, [], { size: 1 }), []);
});

test('counters spent on one piece of ice are gone for the next', () => {
  const propeller = breaker('prop', ['fracter'], {
    breaks: ['barrier'], params: { power: { label: 'P', default: 2, max: 4 } },
    abilities: [BRK1, { pump: 2, spend: { param: 'power' } }],
  }, { strength: 0 });
  const pool = { breakers: [propeller], ice: [ice('a', ['barrier'], 2, 1), ice('b', ['barrier'], 2, 1), ice('c', ['barrier'], 2, 1)], support: [] };
  const s = M.defaultState();
  const rows = M.filterRows(pool, s);
  assert.equal(M.rankRigs(pool, rows, ['a', 'b'], s, [])[0].total, 2);
  assert.deepEqual(M.rankRigs(pool, rows, ['a', 'b', 'c'], s, []), []); // 2 counters, 3 ice
});

test('an installed-icebreakers param counts the rig unless the settings change it', () => {
  const echelon = breaker('ech', ['killer'], {
    breaks: ['sentry'], params: { icebreakers: { label: 'I', default: 3, min: 1, max: 8 } },
    strength: { per: { icebreakers: 1 } }, abilities: [BRK1],
  }, { strength: 0 });
  const pool = { breakers: [echelon], ice: [ice('s', ['sentry'], 2, 1)], support: [] };
  const s = M.defaultState();
  assert.deepEqual(M.rankRigs(pool, M.filterRows(pool, s), ['s'], s, []), []); // a rig of 1: strength 1
  const changed = { ...s, bp: { ech: { icebreakers: 2 } } };
  assert.equal(M.rankRigs(pool, M.filterRows(pool, changed), ['s'], changed, [])[0].total, 1);
});

test('an empty or unknown server ranks nothing', () => {
  const s = M.defaultState();
  assert.deepEqual(M.rankRigs(POOL, M.filterRows(POOL, s), [], s, []), []);
  assert.deepEqual(M.rankRigs(POOL, M.filterRows(POOL, s), ['nope'], s, []), []);
});

// ---------------------------------------------------------------- the address

const PPOOL = {
  ...POOL,
  breakers: [...POOL.breakers, breaker('hantu', ['killer'], { breaks: ['sentry'], params: { virus: { label: 'V', default: 2, max: 6 } }, abilities: [BRK1] })],
  ice: [...POOL.ice, ice('tree', ['barrier'], 4, 1, { model: { params: { adv: { label: 'A', default: 0, max: 6 } } } })],
  support: [support('leech', [{ ice_strength: { per: { virus: -1 } } }], { virus: { label: 'V', default: 0, max: 6 } })],
};

test('the defaults give an empty hash', () => {
  assert.equal(M.formatHash(M.defaultState()), '');
});

test('a state survives the round trip through the hash', () => {
  const s = {
    ...M.defaultState(),
    bt: new Set(['killer', 'fracter']), if: new Set(['jinteki']), stealth: 'none', rez: [0, 5], str: [2, 9],
    variants: false, special: false, swap: true, pickB: new Set(['vandal']), pickI: new Set(['wall', 'tower']),
    bp: { hantu: { virus: 4 } }, ip: { tree: { adv: 3 } }, sp: { leech: { params: { virus: 2 } } },
    server: ['tower', 'wall'], rig: 2,
  };
  const h = M.formatHash(s);
  assert.equal(h, '#bt=fracter,killer&if=jinteki&stealth=none&rez=0-5&str=2-9&variants=0&special=0&swap=1&b=vandal&i=tower,wall&p=hantu.virus.4&ip=tree.adv.3&s=leech&sp=leech.virus.2&srv=tower,wall&rig=2');
  assert.deepEqual(M.parseHash(h, PPOOL), s);
});

test('unknown keys, ids and values are dropped one by one', () => {
  const s = M.parseHash('#bt=fracter,hacker&bf=&stealth=maybe&rez=9-1&str=1-2%0A&b=nope&i=wall,nope&p=hantu.virus.9,hantu.virus.x,nope.v.1,hantu.virus.3&ip=tree.adv.-1&s=leech,nope&srv=wall,nope&rig=4&zzz=1&%E0', PPOOL);
  assert.deepEqual([...s.bt], ['fracter']);
  assert.deepEqual([...s.bf], []);
  assert.equal(s.stealth, 'all');
  assert.equal(s.rez, null);
  assert.equal(s.str, null); // a trailing newline is not a range
  assert.equal(s.pickB, null);
  assert.deepEqual([...s.pickI], ['wall']);
  assert.deepEqual(s.bp, { hantu: { virus: 3 } });
  assert.deepEqual(s.ip, {});
  assert.deepEqual(Object.keys(s.sp), ['leech']);
  assert.deepEqual(s.server, ['wall']);
  assert.equal(s.rig, 3);
});

test('a param set to its default is not kept', () => {
  assert.deepEqual(M.parseHash('#p=hantu.virus.2', PPOOL).bp, {});
});

test('non-ASCII digits are not numbers', () => {
  assert.deepEqual(M.parseHash('#p=hantu.virus.٣&rez=٠-5', PPOOL).bp, {});
  assert.equal(M.parseHash('#rez=٠-5', PPOOL).rez, null);
});

test('without a hash the fallback (a phone) applies; with one the desktop defaults do', () => {
  const phone = M.defaultState({ phone: true });
  assert.deepEqual([...M.parseHash('', PPOOL, phone).bt], ['fracter']);
  assert.deepEqual([...M.parseHash('#swap=1', PPOOL, phone).bt], M.BREAKER_TYPES);
});

test('the server keeps at most 8 pieces of ice', () => {
  const s = M.parseHash(`#srv=${Array(10).fill('wall').join(',')}`, PPOOL);
  assert.equal(s.server.length, 8);
});

// ---------------------------------------------------------------- the published pool

const SNAPSHOT = fileURLToPath(new URL('../../market-research/tests/fixtures/expected/snapshot/', import.meta.url));
const version = readdirSync(SNAPSHOT).find((d) => d.startsWith('v='));
const golden = JSON.parse(readFileSync(`${SNAPSHOT}${version}/breaker-bay/pool.json`, 'utf8'));

test('every breaker of the golden pool costs every piece of ice without an error', () => {
  const rows = M.breakerRows(golden);
  assert.ok(rows.length > 20);
  let reached = 0;
  for (const r of rows) for (const i of golden.ice) {
    const x = M.encounter(r, i);
    if (x) { reached++; assert.ok(Number.isInteger(x.credits) && x.credits >= 0, `${r.key} vs ${i.id}`); }
  }
  assert.ok(reached > 500);
});

test('the model knows every ability, amount and effect field the pool uses', () => {
  const ABILITY = new Set(['break', 'pump', 'weaken', 'bypass', 'rebate', 'cost', 'spend', 'only', 'once']);
  const EFFECT = new Set(['ice_strength', 'ice_subs', 'ice_gains', 'breaker_strength', 'ice', 'breakers']);
  const AMOUNT = new Set(['base', 'per', 'steps', 'min']);
  const amounts = [];
  for (const b of golden.breakers) {
    const m = b.model;
    if (!m) continue;
    for (const ab of [...(m.abilities || []), ...(m.variants || []).flatMap((v) => v.abilities || [])]) {
      for (const k of Object.keys(ab)) assert.ok(ABILITY.has(k), `${b.id}: ${k}`);
      amounts.push(ab.cost, ab.pump, ab.weaken, ab.rebate);
    }
    amounts.push(m.strength, ...(m.variants || []).map((v) => v.strength));
  }
  for (const s of golden.support) for (const e of s.model.effects) {
    for (const k of Object.keys(e)) assert.ok(EFFECT.has(k), `${s.id}: ${k}`);
    amounts.push(e.ice_strength, e.ice_subs, e.breaker_strength);
  }
  for (const i of golden.ice) amounts.push(i.model?.strength, i.model?.subs);
  for (const a of amounts) if (a && typeof a === 'object') for (const k of Object.keys(a)) assert.ok(AMOUNT.has(k), k);
});

// ---------------------------------------------------------------- data base

test('data comes from data.jinteki.win unless ?data= names a same-origin path', () => {
  assert.equal(M.dataBase(''), 'https://data.jinteki.win/');
  assert.equal(M.dataBase('?data=/market-research/tests/fixtures/expected/snapshot'), '/market-research/tests/fixtures/expected/snapshot/');
  for (const bad of ['?data=https://evil.example/', '?data=//evil.example/', '?data=/a b/', '?data=javascript:x']) {
    assert.equal(M.dataBase(bad), M.DEFAULT_DATA_BASE, bad);
  }
});

// ---------------------------------------------------------------- charts

const chartData = () => {
  const s = M.defaultState();
  const rows = M.filterRows(POOL, s);
  const list = M.filterIce(POOL, s);
  return { rows, list, grid: M.costGrid(rows, list, s, []) };
};

test('breaker spread: the costs each row reaches, sorted by median', () => {
  const { rows, list, grid } = chartData();
  assert.deepEqual(M.breakerSpread(rows, list, grid).map((x) => [x.row.key, x.values, x.matching]), [
    ['vandal', [1, 1], 4], // wall and trap only: strength 2, no pump, one subroutine
    ['corroder', [1, 4], 2], // wall 1; tower 3 pumps + 1 break
    ['afterimage', [3], 1],
  ]);
});

test('breaker spread puts rows reaching under half their matching ice last: at half, below', () => {
  const { rows, list, grid } = chartData();
  // Vandal reaches 2 of its 4: exactly half stays in median order. Reaching only the trap (1 of 4) does not.
  const g = grid.map((r) => [...r]);
  const vi = rows.findIndex((r) => r.key === 'vandal');
  const wall = list.findIndex((x) => x.ice.id === 'wall');
  g[wall][vi] = null;
  assert.deepEqual(M.breakerSpread(rows, list, g).map((x) => x.row.key), ['corroder', 'afterimage', 'vandal']);
});

test('breaker spread leaves out rows that reach nothing', () => {
  const { rows, list, grid } = chartData();
  const none = grid.map((r) => r.map(() => null));
  assert.deepEqual(M.breakerSpread(rows, list, none), []);
});

test('ice costs: how many, mean, median and mean ÷ rez over the rows that get through', () => {
  const { list, grid } = chartData();
  const by = Object.fromEntries(M.iceCosts(list, grid).map((x) => [x.ice.id, x]));
  assert.deepEqual([by.wall.n, by.wall.mean, by.wall.median, by.wall.efficiency], [2, 1, 1, 1 / 3]);
  assert.deepEqual([by.tower.n, by.tower.mean, by.tower.efficiency], [1, 4, 4 / 7]);
});

test('ice nobody gets through has no mean; rez 0 or X has no efficiency', () => {
  const one = (extra, results) => M.iceCosts([{ ice: ice('x', ['barrier'], 1, 1, extra), state: {} }], [results])[0];
  assert.deepEqual([one({}, [null]).n, one({}, [null]).mean], [0, null]);
  assert.deepEqual([one({ rez: 0 }, [{ credits: 2 }]).mean, one({ rez: 0 }, [{ credits: 2 }]).efficiency], [2, null]);
  assert.equal(one({ rez: 'X' }, [{ credits: 2 }]).efficiency, null);
});

test('treemap groups: factions in order, rez costs ascending, X last', () => {
  const list = [
    { ice: ice('a', ['barrier'], 1, 1, { faction: 'nbn', rez: 'X' }) },
    { ice: ice('b', ['barrier'], 1, 1, { faction: 'nbn', rez: 2 }) },
    { ice: ice('c', ['barrier'], 1, 1, { faction: 'jinteki', rez: 5 }) },
    { ice: ice('d', ['barrier'], 1, 1, { faction: 'nbn', rez: 2 }) },
  ];
  assert.deepEqual(M.iceByFactionAndRez(list).map((f) => [f.faction, f.count, f.rez.map((r) => `${r.rez}:${r.count}`)]), [
    ['jinteki', 1, ['5:1']],
    ['nbn', 3, ['2:2', 'X:1']],
  ]);
});

test('squarify fills the box with areas proportional to the weights', () => {
  const weights = [6, 6, 4, 3, 2, 2, 1];
  const r = M.squarify(weights, { x: 0, y: 0, w: 60, h: 40 });
  r.forEach((x, i) => assert.ok(Math.abs(x.w * x.h - (weights[i] / 24) * 2400) < 1e-6, `area ${i}`));
  for (const x of r) assert.ok(x.x >= -1e-9 && x.y >= -1e-9 && x.x + x.w <= 60 + 1e-9 && x.y + x.h <= 40 + 1e-9);
  // No two rectangles overlap.
  for (let a = 0; a < r.length; a++) for (let b = a + 1; b < r.length; b++) {
    const ox = Math.min(r[a].x + r[a].w, r[b].x + r[b].w) - Math.max(r[a].x, r[b].x);
    const oy = Math.min(r[a].y + r[a].h, r[b].y + r[b].h) - Math.max(r[a].y, r[b].y);
    assert.ok(ox <= 1e-9 || oy <= 1e-9, `${a} overlaps ${b}`);
  }
});

test('squarify: one weight takes the box', () => {
  assert.deepEqual(M.squarify([5], { x: 1, y: 2, w: 10, h: 4 }), [{ x: 1, y: 2, w: 10, h: 4 }]);
});

test('squarify: zero and negative weights get nothing; an empty box or list gives nothing', () => {
  const r = M.squarify([0, 3, -2], { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(r.map((x) => x.w * x.h), [0, 100, 0]);
  assert.deepEqual(M.squarify([1, 2], { x: 0, y: 0, w: 0, h: 10 }).map((x) => x.w), [0, 0]);
  assert.deepEqual(M.squarify([], { x: 0, y: 0, w: 10, h: 10 }), []);
});

test('strength counts per faction run from 0 to the strongest ice', () => {
  const list = [
    { ice: { faction: 'nbn' }, state: { strength: 2 } },
    { ice: { faction: 'nbn' }, state: { strength: 2 } },
    { ice: { faction: 'jinteki' }, state: { strength: 3 } },
  ];
  assert.deepEqual(M.strengthCounts(list), {
    strengths: [0, 1, 2, 3],
    factions: [{ faction: 'jinteki', counts: [0, 0, 0, 1] }, { faction: 'nbn', counts: [0, 0, 2, 0] }],
  });
  assert.deepEqual(M.strengthCounts([]), { strengths: [], factions: [] });
});

test('strength counts start below 0 when support makes ice negative', () => {
  assert.deepEqual(M.strengthCounts([{ ice: { faction: 'nbn' }, state: { strength: -1 } }]).strengths, [-1, 0]);
});
