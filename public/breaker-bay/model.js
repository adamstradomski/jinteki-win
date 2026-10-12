// Breaker Bay model: every cost, filter and address rule of the page. No DOM access, so it runs
// under `node --test` (test/breaker-bay/). The data is the snapshot's breaker-bay/pool.json;
// its format is docs/breaker-bay/data-format.md. Optional fields take their documented defaults
// (an ability's cost 0, a spend's n 1, a param's min 0), because the pipeline leaves them out.

export const BREAKER_TYPES = ['fracter', 'decoder', 'killer', 'ai'];
export const ICE_TYPES = ['barrier', 'code_gate', 'sentry'];
export const RUNNER_FACTIONS = ['anarch', 'criminal', 'shaper', 'neutral_runner'];
export const CORP_FACTIONS = ['haas_bioroid', 'jinteki', 'nbn', 'weyland_consortium', 'neutral_corp'];
export const TYPE_NAME = { barrier: 'Barrier', code_gate: 'Code gate', sentry: 'Sentry', other: 'Other ice' };
export const BREAKER_NAME = { fracter: 'Fracter', decoder: 'Decoder', killer: 'Killer', ai: 'AI' };
export const FACTION_NAME = {
  haas_bioroid: 'Haas-Bioroid', jinteki: 'Jinteki', nbn: 'NBN', weyland_consortium: 'Weyland',
  neutral_corp: 'Neutral', anarch: 'Anarch', criminal: 'Criminal', shaper: 'Shaper', neutral_runner: 'Neutral',
};
// The design system's faction classes (.faction.hb …).
export const FACTION_CLASS = {
  haas_bioroid: 'hb', jinteki: 'jinteki', nbn: 'nbn', weyland_consortium: 'weyland',
  anarch: 'anarch', criminal: 'criminal', shaper: 'shaper',
};
export const MAX_RIG = 3;
// More uses of one strength ability than this never pay off against Standard ice (strength ≤ 15).
const MAX_USES = 16;

// ---------------------------------------------------------------- data

export const DEFAULT_DATA_BASE = 'https://data.jinteki.win/';

/** Where the snapshot comes from: the production host, or a same-origin path (?data=/dir/) for local
 *  previews. Anything else is ignored. */
export function dataBase(search) {
  const v = new URLSearchParams(search || '').get('data');
  if (v && /^\/(?!\/)[A-Za-z0-9._\-/]*$/.test(v)) return v.endsWith('/') ? v : `${v}/`;
  return DEFAULT_DATA_BASE;
}

export function joinUrl(base, path) {
  return base.endsWith('/') ? base + path : `${base}/${path}`;
}

// ---------------------------------------------------------------- amounts and params

/** An amount's value: a number, or base + Σ param × factor + the steps reached, floored at min. */
export function amount(a, params = {}) {
  if (a == null) return 0;
  if (typeof a === 'number') return a;
  let v = a.base || 0;
  for (const [p, k] of Object.entries(a.per || {})) v += (params[p] || 0) * k;
  for (const s of a.steps || []) if ((params[s.param] || 0) >= s.at) v += s.add;
  return a.min != null ? Math.max(a.min, v) : v;
}

/** Each param's value: the card's default, unless the settings change it within min..max. */
export function paramValues(model, changed = {}) {
  const out = {};
  for (const [id, p] of Object.entries(model?.params || {})) {
    const v = changed[id];
    out[id] = Number.isInteger(v) && v >= (p.min ?? 0) && v <= p.max ? v : p.default;
  }
  return out;
}

// ---------------------------------------------------------------- breakers and ice

/** The breaker's interface subtypes: fracter/decoder/killer, or ['ai']. */
export function breakerTypes(b) {
  if (b.subtypes.includes('ai')) return ['ai'];
  return BREAKER_TYPES.filter((t) => b.subtypes.includes(t));
}

/** One row per breaker and variant: { key, breaker, variant, label, model, types, slot }. Breakers
 *  without a model are left out; `variants: false` keeps only the default variant. */
export function breakerRows(pool, { variants = true } = {}) {
  const rows = [];
  for (const b of pool.breakers) {
    if (!b.model) continue;
    const types = breakerTypes(b);
    const base = { breaker: b, types, slot: types[0] || 'ai' };
    const vs = b.model.variants || [];
    if (!vs.length) {
      rows.push({ ...base, key: b.id, variant: null, label: b.title, model: b.model });
      continue;
    }
    for (const v of vs) {
      if (!variants && !v.default) continue;
      rows.push({
        ...base,
        key: variants ? `${b.id}:${v.id}` : b.id,
        variant: v,
        label: variants ? `${b.title} · ${v.label}` : b.title,
        model: {
          ...b.model,
          breaks: v.breaks || b.model.breaks,
          strength: v.strength ?? b.model.strength,
          abilities: v.abilities || b.model.abilities,
        },
      });
    }
  }
  return rows;
}

/** The ice as it is encountered: strength, subroutines and subtypes after its own corrections and
 *  the checked support cards. `support` is [{ model, params }] (see activeSupport). */
export function iceState(ice, iceParams, support = []) {
  const p = paramValues(ice.model, iceParams);
  let strength = (ice.strength || 0) + amount(ice.model?.strength, p);
  let subs = ice.subs + amount(ice.model?.subs, p);
  const types = new Set([...ice.types, ...(ice.model?.gains || [])]);
  for (const s of support) {
    for (const e of s.model.effects) {
      if (e.ice && !e.ice.some((t) => ice.subtypes.includes(t))) continue;
      if (e.ice_strength != null) strength += amount(e.ice_strength, s.params);
      if (e.ice_subs != null) subs += amount(e.ice_subs, s.params);
      for (const t of e.ice_gains || []) types.add(t);
    }
  }
  return {
    strength,
    subs: Math.max(0, subs),
    types: ICE_TYPES.filter((t) => types.has(t)),
    onlyBy: ice.model?.broken_only_by || null,
    unbreakable: ice.model?.unbreakable || null,
  };
}

/** The breaker's strength for a row, with its params and the checked support cards. */
export function breakerStrength(row, params, support = []) {
  let s = (row.breaker.strength || 0) + amount(row.model.strength, params);
  const ai = row.types.includes('ai');
  for (const c of support) {
    for (const e of c.model.effects) {
      if (e.breaker_strength != null && !(e.breakers === 'non_ai' && ai)) s += amount(e.breaker_strength, c.params);
    }
  }
  return s;
}

export function interfaces(row, types) {
  return row.model.breaks.includes('any') || row.model.breaks.some((t) => types.includes(t));
}

// ---------------------------------------------------------------- the cost of one encounter

/**
 * The cheapest way through one encounter of `ice` with the breaker `row`:
 * { credits, steps: [{ kind, label, n, each }], bypass, left } or null when it can't get through
 * (no interface, no way to reach the strength, too few counters, a per-encounter limit).
 * `left` is what the spendable params hold afterwards. Strength abilities last the encounter; a
 * weaken lowers the ice's strength instead. Credits never go below 0 (a rebate can't pay you).
 */
export function encounter(row, ice, { breakerParams = {}, iceParams = {}, support = [] } = {}) {
  const st = iceState(ice, iceParams, support);
  if (!interfaces(row, st.types)) return null;
  const p = paramValues(row.model, breakerParams);
  const fits = (ab) => !ab.only || ab.only.some((t) => st.types.includes(t));
  const abilities = (row.model.abilities || []).filter(fits);
  let best = null;
  const consider = (credits, steps, bypass, left) => {
    const c = Math.max(0, credits);
    if (best == null || c < best.credits || (c === best.credits && steps.length < best.steps.length)) {
      best = { credits: c, steps, bypass, left };
    }
  };
  const spendOk = (ab, uses, left) => !ab.spend || uses * (ab.spend.n ?? 1) <= (left[ab.spend.param] || 0);
  const spent = (ab, uses, left) =>
    ab.spend ? { ...left, [ab.spend.param]: left[ab.spend.param] - uses * (ab.spend.n ?? 1) } : left;

  for (const ab of abilities.filter((a) => a.bypass)) {
    if (!spendOk(ab, 1, p)) continue;
    const c = amount(ab.cost, p);
    consider(c, [{ kind: 'bypass', label: 'bypass', n: 1, each: c }], true, spent(ab, 1, p));
  }

  const ai = row.types.includes('ai');
  const allowed = !st.unbreakable && (!st.onlyBy || st.onlyBy.some((t) => (t === 'ai' ? ai : row.breaker.subtypes.includes(t))));
  if (allowed) {
    const ups = abilities.filter((a) => a.pump != null || a.weaken != null);
    const breaks = abilities.filter((a) => a.break != null);
    const rebate = abilities.filter((a) => a.rebate != null).reduce((s, a) => s + amount(a.rebate, p), 0);
    const walk = (i, gap, credits, steps, left) => {
      if (i === ups.length) {
        if (gap > 0) return;
        const br = breakAll(breaks, st.subs, p, left);
        if (!br) return;
        const back = st.subs > 0 && rebate ? [{ kind: 'rebate', label: 'gain back', n: 1, each: -rebate }] : [];
        consider(credits + br.credits - (back.length ? rebate : 0), [...steps, ...br.steps, ...back], false, br.left);
        return;
      }
      const ab = ups[i];
      const gain = amount(ab.pump ?? ab.weaken, p);
      const each = amount(ab.cost, p);
      const max = ab.once ? 1 : MAX_USES;
      for (let n = 0; n <= max; n++) {
        if (n > 0 && (gap <= 0 || gain <= 0)) break;
        if (!spendOk(ab, n, left)) break;
        const label = ab.pump != null ? `+${gain} strength` : `−${gain} ice strength`;
        const s2 = n ? [...steps, { kind: ab.pump != null ? 'pump' : 'weaken', label, n, each }] : steps;
        walk(i + 1, gap - n * gain, credits + n * each, s2, spent(ab, n, left));
      }
    };
    walk(0, st.strength - breakerStrength(row, p, support), 0, [], p);
  }
  return best;
}

// The cheapest way to break `subs` subroutines with the break abilities, within the counters left.
function breakAll(breaks, subs, p, left) {
  if (subs <= 0) return { credits: 0, steps: [], left };
  let best = null;
  const go = (i, rem, credits, steps, l) => {
    if (rem <= 0) {
      if (!best || credits < best.credits) best = { credits, steps, left: l };
      return;
    }
    if (i === breaks.length) return;
    const ab = breaks[i];
    const per = ab.break === 'any' || ab.break === 'X' ? rem : ab.break;
    const each = ab.break === 'X' ? 1 : amount(ab.cost, p);
    const max = ab.once ? 1 : Math.ceil(rem / per);
    for (let n = 0; n <= max; n++) {
      const need = n * (ab.spend?.n ?? 1);
      if (ab.spend && need > (l[ab.spend.param] || 0)) break;
      const done = Math.min(rem, n * per);
      const c = ab.break === 'X' ? done : n * each;
      const l2 = ab.spend ? { ...l, [ab.spend.param]: l[ab.spend.param] - need } : l;
      let step = null;
      if (n) {
        if (ab.break === 'X') step = { kind: 'break', label: `break ${done} (X)`, n: 1, each: done };
        else step = { kind: 'break', label: ab.break === 'any' ? 'break all' : `break ${ab.break}`, n, each };
      }
      go(i + 1, rem - done, credits + c, step ? [...steps, step] : steps, l2);
      if (n * per >= rem) break;
    }
  };
  go(0, subs, 0, [], left);
  return best;
}

/** "2× +2 strength at 1c + 3× break 1 at 1c = 5c". */
export function describe(r) {
  if (!r) return 'Can’t get through';
  if (!r.steps.length) return 'Nothing to break: 0c';
  const parts = r.steps.map((s) => {
    const times = s.n > 1 ? `${s.n}× ` : '';
    const at = s.each > 0 ? ` at ${s.each}c` : s.each < 0 ? ` ${-s.each}c` : ' (free)';
    return `${times}${s.label}${at}`;
  });
  return `${parts.join(' + ')} = ${r.credits}c`;
}

// ---------------------------------------------------------------- support cards

/** The checked support cards in the pool, with their param values: [{ ...card, params }]. */
export function activeSupport(pool, checked) {
  return pool.support
    .filter((s) => checked[s.id])
    .map((s) => ({ ...s, params: paramValues(s.model, checked[s.id]?.params || {}) }));
}

// ---------------------------------------------------------------- filters

/** Every filter, setting and choice of the page. Sets are kept sorted when written to the address. */
export function defaultState({ phone = false } = {}) {
  return {
    bt: new Set(phone ? ['fracter'] : BREAKER_TYPES),
    bf: new Set(RUNNER_FACTIONS),
    it: new Set(phone ? ['barrier'] : ICE_TYPES),
    if: new Set(CORP_FACTIONS),
    stealth: 'all',
    rez: null,
    str: null,
    variants: true,
    special: true,
    swap: false,
    pickB: null,
    pickI: null,
    bp: {},
    ip: {},
    sp: {},
    server: [],
    rig: MAX_RIG,
  };
}

const inRange = (v, r) => !r || (typeof v === 'number' && v >= r[0] && v <= r[1]);

/** The breaker rows the filters keep. An explicit pick (pickB) overrides type, faction, stealth and
 *  special; variants still apply. */
export function filterRows(pool, s) {
  return breakerRows(pool, { variants: s.variants }).filter((r) => {
    if (s.pickB) return s.pickB.has(r.breaker.id);
    if (!r.types.some((t) => s.bt.has(t))) return false;
    if (!s.bf.has(r.breaker.faction)) return false;
    if (s.stealth === 'only' && !r.model.stealth) return false;
    if (s.stealth === 'none' && r.model.stealth) return false;
    if (!s.special && r.model.special) return false;
    return true;
  });
}

/** The ice the filters keep, each with the type group it is listed under (its first selected
 *  type; 'other' for ice without one, kept when AI breakers are shown). Strength is after every
 *  modifier. An explicit pick (pickI) overrides type and faction; the ranges still apply. */
export function filterIce(pool, s, support = []) {
  const out = [];
  for (const i of pool.ice) {
    const st = iceState(i, s.ip[i.id], support);
    let group;
    if (s.pickI) {
      if (!s.pickI.has(i.id)) continue;
      group = st.types[0] || 'other';
    } else {
      if (!s.if.has(i.faction)) continue;
      group = ICE_TYPES.find((t) => s.it.has(t) && st.types.includes(t)) || (!st.types.length && s.bt.has('ai') ? 'other' : null);
      if (!group) continue;
    }
    if (!inRange(i.rez, s.rez) || !inRange(st.strength, s.str)) continue;
    out.push({ ice: i, state: st, group });
  }
  const order = [...ICE_TYPES, 'other'];
  return out.sort(
    (a, b) => order.indexOf(a.group) - order.indexOf(b.group)
      || (a.ice.rez ?? 99) - (b.ice.rez ?? 99)
      || a.ice.title.localeCompare(b.ice.title),
  );
}

/** The cost grid: grid[iceIndex][rowIndex] = encounter result or null. */
export function costGrid(rows, ice, s, support) {
  return ice.map(({ ice: i }) => rows.map((r) => encounter(r, i, { breakerParams: s.bp[r.breaker.id], iceParams: s.ip[i.id], support })));
}

export function quartiles(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return v[lo] + (v[hi] - v[lo]) * (i - lo);
  };
  return { min: v[0], q1: q(0.25), med: q(0.5), q3: q(0.75), max: v[v.length - 1], n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length };
}

// ---------------------------------------------------------------- run planner

/**
 * Rigs of up to `size` breakers (at most one per slot: fracter, decoder, killer, AI) ranked by the
 * credits for one run through `server` (ice ids, outermost first): each piece of ice is one
 * encounter, broken by the rig's cheapest breaker for it. Hosted counters a breaker spends are gone
 * for the next ice; an "installed icebreakers" param the settings leave alone counts the rig.
 * A rig with a breaker that breaks nothing is the same rig without it and is dropped.
 */
export function rankRigs(pool, rows, server, s, support, { size = MAX_RIG, limit = 8 } = {}) {
  const byId = Object.fromEntries(pool.ice.map((i) => [i.id, i]));
  const ice = server.map((id) => byId[id]).filter(Boolean);
  if (!ice.length) return [];
  const spends = (r) => r.model.abilities.some((a) => a.spend);
  const memo = new Map();
  const costOf = (r, i, rigSize, counters) => {
    const bp = { ...(s.bp[r.breaker.id] || {}) };
    if (r.model.params?.icebreakers && bp.icebreakers == null) bp.icebreakers = rigSize;
    if (counters) Object.assign(bp, counters);
    const run = () => encounter(r, i, { breakerParams: bp, iceParams: s.ip[i.id], support });
    if (spends(r)) return run();
    const k = `${r.key}|${i.id}|${rigSize}`;
    if (!memo.has(k)) memo.set(k, run());
    return memo.get(k);
  };
  const slots = BREAKER_TYPES.map((t) => [null, ...rows.filter((r) => r.slot === t)]);
  const out = [];
  for (const a of slots[0]) for (const b of slots[1]) for (const c of slots[2]) for (const d of slots[3]) {
    const rig = [a, b, c, d].filter(Boolean);
    if (!rig.length || rig.length > size) continue;
    const left = new Map();
    const per = [];
    let total = 0;
    let ok = true;
    for (const i of ice) {
      let best = null;
      let who = null;
      for (const r of rig) {
        const x = costOf(r, i, rig.length, left.get(r.key));
        if (x && (!best || x.credits < best.credits)) { best = x; who = r; }
      }
      if (!best) { ok = false; break; }
      if (spends(who)) left.set(who.key, best.left);
      total += best.credits;
      per.push({ ice: i, result: best, row: who });
    }
    if (!ok || rig.some((r) => !per.some((x) => x.row === r))) continue;
    const install = rig.reduce((t, r) => t + (typeof r.breaker.cost === 'number' ? r.breaker.cost : 0), 0);
    const mu = rig.reduce((t, r) => t + (r.breaker.mu || 0), 0);
    out.push({ rig, total, per, install, mu });
  }
  out.sort((x, y) => x.total - y.total || x.install - y.install || x.rig.length - y.rig.length
    || x.rig.map((r) => r.key).join().localeCompare(y.rig.map((r) => r.key).join()));
  return out.slice(0, limit);
}

// ---------------------------------------------------------------- the address

const ID = /^[a-z0-9_]{1,80}$/;
const RANGE = /^(\d{1,2})-(\d{1,2})$/;
const SET_KEYS = { bt: BREAKER_TYPES, bf: RUNNER_FACTIONS, it: ICE_TYPES, if: CORP_FACTIONS };

/** The hash for a state: only what differs from the desktop defaults, so the defaults give "". */
export function formatHash(s) {
  const d = defaultState();
  const parts = [];
  const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  for (const k of Object.keys(SET_KEYS)) if (!same(s[k], d[k])) parts.push(`${k}=${[...s[k]].sort().join(',')}`);
  if (s.stealth !== 'all') parts.push(`stealth=${s.stealth}`);
  if (s.rez) parts.push(`rez=${s.rez[0]}-${s.rez[1]}`);
  if (s.str) parts.push(`str=${s.str[0]}-${s.str[1]}`);
  if (!s.variants) parts.push('variants=0');
  if (!s.special) parts.push('special=0');
  if (s.swap) parts.push('swap=1');
  if (s.pickB) parts.push(`b=${[...s.pickB].sort().join(',')}`);
  if (s.pickI) parts.push(`i=${[...s.pickI].sort().join(',')}`);
  const params = (bag) => Object.entries(bag).sort()
    .flatMap(([c, ps]) => Object.entries(ps).sort().map(([p, v]) => `${c}.${p}.${v}`));
  const bp = params(s.bp);
  if (bp.length) parts.push(`p=${bp.join(',')}`);
  const ip = params(s.ip);
  if (ip.length) parts.push(`ip=${ip.join(',')}`);
  const sp = Object.keys(s.sp).sort();
  if (sp.length) parts.push(`s=${sp.join(',')}`);
  const spp = params(Object.fromEntries(sp.map((id) => [id, s.sp[id].params || {}])));
  if (spp.length) parts.push(`sp=${spp.join(',')}`);
  if (s.server.length) parts.push(`srv=${s.server.join(',')}`);
  if (s.rig !== MAX_RIG) parts.push(`rig=${s.rig}`);
  return parts.length ? `#${parts.join('&')}` : '';
}

/** The state a hash describes. Anything unknown or invalid is dropped, not fatal: a bad value
 *  leaves that part at its default. `fallback` is the state without a hash (a phone's defaults). */
export function parseHash(hash, pool, fallback = defaultState()) {
  const s = { ...fallback, bt: new Set(fallback.bt), it: new Set(fallback.it), bf: new Set(fallback.bf), if: new Set(fallback.if), bp: {}, ip: {}, sp: {}, server: [] };
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return s;
  const breakers = Object.fromEntries(pool.breakers.map((b) => [b.id, b]));
  const ice = Object.fromEntries(pool.ice.map((i) => [i.id, i]));
  const support = Object.fromEntries(pool.support.map((x) => [x.id, x]));
  const d = defaultState();
  for (const k of Object.keys(SET_KEYS)) s[k] = new Set(d[k]); // a hash starts from the desktop defaults
  const list = (v) => (v ? v.split(',').filter(Boolean) : []);
  const range = (v) => {
    const m = RANGE.exec(v);
    return m && Number(m[1]) <= Number(m[2]) ? [Number(m[1]), Number(m[2])] : null;
  };
  const params = (v, cards, bag) => {
    for (const item of list(v)) {
      const [c, p, n] = item.split('.');
      const def = cards[c]?.model?.params?.[p];
      if (!def || !/^-?\d{1,3}$/.test(n || '')) continue;
      const num = Number(n);
      if (num < (def.min ?? 0) || num > def.max || num === def.default) continue;
      bag[c] = { ...(bag[c] || {}), [p]: num };
    }
  };
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq);
    let v;
    try { v = decodeURIComponent(part.slice(eq + 1)); } catch { continue; }
    if (k in SET_KEYS) s[k] = new Set(list(v).filter((x) => SET_KEYS[k].includes(x)));
    else if (k === 'stealth' && ['only', 'none'].includes(v)) s.stealth = v;
    else if (k === 'rez') s.rez = range(v);
    else if (k === 'str') s.str = range(v);
    else if (k === 'variants' && v === '0') s.variants = false;
    else if (k === 'special' && v === '0') s.special = false;
    else if (k === 'swap' && v === '1') s.swap = true;
    else if (k === 'b') { const ids = list(v).filter((x) => ID.test(x) && breakers[x]); s.pickB = ids.length ? new Set(ids) : null; }
    else if (k === 'i') { const ids = list(v).filter((x) => ID.test(x) && ice[x]); s.pickI = ids.length ? new Set(ids) : null; }
    else if (k === 'p') params(v, breakers, s.bp);
    else if (k === 'ip') params(v, ice, s.ip);
    else if (k === 's') for (const id of list(v)) { if (support[id]) s.sp[id] = { params: {} }; }
    else if (k === 'sp') {
      const bag = {};
      params(v, support, bag);
      for (const [id, ps] of Object.entries(bag)) if (s.sp[id]) s.sp[id].params = ps;
    }
    else if (k === 'srv') s.server = list(v).filter((x) => ice[x]).slice(0, 8);
    else if (k === 'rig' && /^[1-3]$/.test(v)) s.rig = Number(v);
  }
  return s;
}

// ---------------------------------------------------------------- charts

/** Per breaker row, the credits of every piece of ice in view it gets through, with quartiles and
 *  how many of that ice it interfaces with; sorted by median, then by reach (more first), then name.
 *  Rows that get through under half their matching ice come last: Audrey's 0c median over the one
 *  piece of ice it can afford says nothing about it. */
export function breakerSpread(rows, ice, grid) {
  const low = (x) => (x.values.length * 2 < x.matching ? 1 : 0);
  return rows
    .map((row, ri) => {
      const matching = ice.filter((x) => interfaces(row, x.state.types)).length;
      const values = ice.map((_, ii) => grid[ii][ri]).filter(Boolean).map((r) => r.credits);
      return { row, values, q: quartiles(values), matching };
    })
    .filter((x) => x.values.length)
    .sort((a, b) => low(a) - low(b) || a.q.med - b.q.med
      || b.values.length / b.matching - a.values.length / a.matching
      || a.row.label.localeCompare(b.row.label));
}

/** Per piece of ice in view, the credits over the breaker rows in view that get through it:
 *  how many, mean, median, and efficiency = mean cost to break ÷ rez cost (null for rez 0 or X). */
export function iceCosts(ice, grid) {
  return ice.map((x, ii) => {
    const q = quartiles(grid[ii].filter(Boolean).map((r) => r.credits));
    const rez = typeof x.ice.rez === 'number' && x.ice.rez > 0 ? x.ice.rez : null;
    return {
      ice: x.ice,
      state: x.state,
      n: q ? q.n : 0,
      mean: q ? q.mean : null,
      median: q ? q.med : null,
      efficiency: q && rez ? q.mean / rez : null,
    };
  });
}

/** Treemap groups: faction → rez cost → ice, with counts; factions in CORP_FACTIONS order, rez
 *  costs ascending with X last. */
export function iceByFactionAndRez(ice) {
  const byFaction = new Map();
  for (const x of ice) {
    const rez = typeof x.ice.rez === 'number' ? x.ice.rez : 'X';
    if (!byFaction.has(x.ice.faction)) byFaction.set(x.ice.faction, new Map());
    const byRez = byFaction.get(x.ice.faction);
    if (!byRez.has(rez)) byRez.set(rez, []);
    byRez.get(rez).push(x);
  }
  const rank = (r) => (r === 'X' ? Infinity : r);
  return [...byFaction.entries()]
    .sort((a, b) => CORP_FACTIONS.indexOf(a[0]) - CORP_FACTIONS.indexOf(b[0]))
    .map(([faction, byRez]) => ({
      faction,
      count: [...byRez.values()].reduce((n, l) => n + l.length, 0),
      rez: [...byRez.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([rez, list]) => ({ rez, count: list.length, ice: list })),
    }));
}

/**
 * Squarified treemap (Bruls, Huizing and van Wijk): one rectangle per weight, in the order given,
 * filling box { x, y, w, h } with areas proportional to the weights and sides as close to square
 * as each row allows. Weights that aren't positive get an empty rectangle.
 */
export function squarify(weights, box) {
  const empty = () => ({ x: box.x, y: box.y, w: 0, h: 0 });
  const total = weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const out = weights.map(empty);
  if (!total || box.w <= 0 || box.h <= 0) return out;
  const scale = (box.w * box.h) / total;
  const items = weights.map((v, i) => ({ i, a: v > 0 ? v * scale : 0 })).filter((x) => x.a > 0);
  let { x, y, w, h } = box;
  const worst = (row, side) => {
    const s = row.reduce((t, r) => t + r.a, 0);
    const max = Math.max(...row.map((r) => r.a));
    const min = Math.min(...row.map((r) => r.a));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const lay = (row) => {
    const s = row.reduce((t, r) => t + r.a, 0);
    if (w >= h) {
      const rw = s / h;
      let yy = y;
      for (const r of row) { const rh = r.a / rw; out[r.i] = { x, y: yy, w: rw, h: rh }; yy += rh; }
      x += rw;
      w -= rw;
    } else {
      const rh = s / w;
      let xx = x;
      for (const r of row) { const cw = r.a / rh; out[r.i] = { x: xx, y, w: cw, h: rh }; xx += cw; }
      y += rh;
      h -= rh;
    }
  };
  let row = [];
  for (const item of items) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, item], side) <= worst(row, side)) row.push(item);
    else { lay(row); row = [item]; }
  }
  if (row.length) lay(row);
  return out;
}

/** How many pieces of ice in view have each strength (after modifiers), per faction, on an axis
 *  that always holds 0: from 0 (or the weakest, when support makes it negative) to the strongest. */
export function strengthCounts(ice) {
  if (!ice.length) return { strengths: [], factions: [] };
  const vals = ice.map((x) => x.state.strength);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const strengths = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
  const factions = CORP_FACTIONS.filter((f) => ice.some((x) => x.ice.faction === f)).map((faction) => ({
    faction,
    counts: strengths.map((s) => ice.filter((x) => x.ice.faction === faction && x.state.strength === s).length),
  }));
  return { strengths, factions };
}
