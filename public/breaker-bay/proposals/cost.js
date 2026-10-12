// Breaker Bay design-proposal prototype: the cost to break a piece of ice with a breaker, from
// breaker-bay/pool.json (docs/breaker-bay/data-format.md). Throwaway: stage 2 replaces it with a
// tested module.

const MAX_USES = 12;

export function amount(a, params) {
  if (a == null) return 0;
  if (typeof a === 'number') return a;
  let v = a.base || 0;
  for (const [p, k] of Object.entries(a.per || {})) v += (params[p] || 0) * k;
  for (const s of a.steps || []) if ((params[s.param] || 0) >= s.at) v += s.add;
  return a.min != null ? Math.max(a.min, v) : v;
}

export function defaults(model) {
  const out = {};
  for (const [id, p] of Object.entries(model?.params || {})) out[id] = p.default;
  return out;
}

// One row per breaker variant: { key, breaker, variant, label, model }.
export function breakerRows(pool, { variants = true } = {}) {
  const rows = [];
  for (const b of pool.breakers) {
    if (!b.model) continue;
    const vs = b.model.variants || [];
    if (!vs.length) { rows.push({ key: b.id, breaker: b, variant: null, label: b.title, model: b.model }); continue; }
    for (const v of vs) {
      if (!variants && !v.default) continue;
      const model = { ...b.model, breaks: v.breaks || b.model.breaks, strength: v.strength ?? b.model.strength, abilities: v.abilities || b.model.abilities };
      rows.push({ key: `${b.id}:${v.id}`, breaker: b, variant: v, label: vs.length > 1 && variants ? `${b.title} · ${v.label}` : b.title, model });
    }
  }
  return rows;
}

export function breakerType(b) {
  if (b.subtypes.includes('ai')) return 'ai';
  return ['fracter', 'decoder', 'killer'].filter((t) => b.subtypes.includes(t));
}

// The ice after its own corrections and the checked support cards.
export function iceState(ice, iceParams, support) {
  const p = { ...defaults(ice.model), ...(iceParams || {}) };
  let strength = (ice.strength || 0) + amount(ice.model?.strength, p);
  let subs = ice.subs + amount(ice.model?.subs, p);
  const types = new Set([...ice.types, ...(ice.model?.gains || [])]);
  for (const s of support) {
    for (const e of s.model.effects) {
      if (e.ice && !e.ice.some((t) => ice.subtypes.includes(t))) continue;
      if (e.ice_strength != null) strength += amount(e.ice_strength, s.params);
      if (e.ice_subs != null) subs += amount(e.ice_subs, s.params);
      if (e.ice_gains) e.ice_gains.forEach((t) => types.add(t));
    }
  }
  return { strength, subs: Math.max(0, subs), types: [...types], onlyBy: ice.model?.broken_only_by || null };
}

// Cheapest way through: { credits, steps: [{label, n, each}], bypass } or null when it can't.
export function cost(row, ice, { breakerParams = {}, iceParams = {}, support = [] } = {}) {
  const m = row.model;
  const p = { ...defaults(m), ...breakerParams };
  const st = iceState(ice, iceParams, support);
  const interfaces = m.breaks.includes('any') || m.breaks.some((t) => st.types.includes(t));
  if (!interfaces) return null;
  const ai = row.breaker.subtypes.includes('ai');
  let bStr = (row.breaker.strength || 0) + amount(m.strength, p);
  for (const s of support) for (const e of s.model.effects) {
    if (e.breaker_strength != null && !(e.breakers === 'non_ai' && ai)) bStr += amount(e.breaker_strength, s.params);
  }
  const fits = (ab) => !ab.only || ab.only.some((t) => st.types.includes(t));
  const abilities = m.abilities.filter(fits);
  const counters = {};
  for (const [id, v] of Object.entries(p)) counters[id] = v;

  let best = null;
  // left: the counters (and other spendable params) still there afterwards.
  const consider = (credits, steps, bypass, left) => {
    if (best == null || credits < best.credits) best = { credits, steps, bypass, left };
  };

  for (const ab of abilities.filter((a) => a.bypass)) {
    const need = ab.spend ? (ab.spend.n ?? 1) : 0;
    if (ab.spend && (counters[ab.spend.param] || 0) < need) continue;
    const c = amount(ab.cost, p);
    const left = ab.spend ? { ...counters, [ab.spend.param]: counters[ab.spend.param] - need } : counters;
    consider(c, [{ label: 'bypass', n: 1, each: c }], true, left);
  }

  const canBreak = !st.onlyBy || st.onlyBy.some((t) => (t === 'ai' ? ai : row.breaker.subtypes.includes(t)));
  if (canBreak) {
    const ups = abilities.filter((a) => a.pump != null || a.weaken != null);
    const breaks = abilities.filter((a) => a.break != null);
    const rebate = abilities.filter((a) => a.rebate != null).reduce((s, a) => s + amount(a.rebate, p), 0);
    // Try every mix of strength uses (bounded), then the cheapest break of every subroutine.
    const walk = (i, gap, credits, steps, left) => {
      if (i === ups.length) {
        if (gap > 0) return;
        const br = breakAll(breaks, st.subs, p, left);
        if (br) consider(Math.max(0, credits + br.credits - (st.subs > 0 ? rebate : 0)), [...steps, ...br.steps, ...(rebate && st.subs ? [{ label: 'rebate', n: 1, each: -rebate }] : [])], false, br.left);
        return;
      }
      const ab = ups[i];
      const gain = amount(ab.pump ?? ab.weaken, p);
      const each = amount(ab.cost, p);
      const max = ab.once ? 1 : MAX_USES;
      for (let n = 0; n <= max; n++) {
        if (n > 0 && gap <= 0) break;
        if (ab.spend && n * (ab.spend.n ?? 1) > (left[ab.spend.param] || 0)) break;
        const l2 = ab.spend ? { ...left, [ab.spend.param]: (left[ab.spend.param] || 0) - n * (ab.spend.n ?? 1) } : left;
        const s2 = n ? [...steps, { label: ab.pump != null ? `+${gain} strength` : `−${gain} ice strength`, n, each }] : steps;
        walk(i + 1, gap - n * gain, credits + n * each, s2, l2);
        if (gain <= 0) break;
      }
    };
    walk(0, st.strength - bStr, 0, [], counters);
  }
  return best;
}

function breakAll(breaks, subs, p, left) {
  if (subs <= 0) return { credits: 0, steps: [], left };
  let best = null;
  const go = (i, rem, credits, steps, l) => {
    if (rem <= 0) { if (!best || credits < best.credits) best = { credits, steps, left: l }; return; }
    if (i === breaks.length) return;
    const ab = breaks[i];
    const per = ab.break === 'any' ? rem : ab.break === 'X' ? rem : ab.break;
    const each = ab.break === 'X' ? null : amount(ab.cost, p);
    const max = ab.once ? 1 : Math.ceil(rem / per);
    for (let n = 0; n <= max; n++) {
      if (ab.spend && n * (ab.spend.n ?? 1) > (l[ab.spend.param] || 0)) break;
      const done = Math.min(rem, n * per);
      const c = ab.break === 'X' ? done : n * each;
      const l2 = ab.spend ? { ...l, [ab.spend.param]: (l[ab.spend.param] || 0) - n * (ab.spend.n ?? 1) } : l;
      const label = ab.break === 'any' ? 'break all' : ab.break === 'X' ? `break ${done} (X)` : `break ${ab.break}`;
      go(i + 1, rem - done, credits + c, n ? [...steps, { label, n: ab.break === 'X' ? 1 : n, each: ab.break === 'X' ? done : each }] : steps, l2);
      if (n * per >= rem) break;
    }
  };
  go(0, subs, 0, [], left);
  return best;
}

export function describe(r) {
  if (!r) return 'Can’t get through';
  if (!r.steps.length) return 'Nothing to break: 0c';
  return r.steps.map((s) => `${s.n > 1 ? s.n + '× ' : ''}${s.label}${s.each ? ` at ${s.each}c` : ''}`).join(' + ') + ` = ${r.credits}c`;
}

export const FACTION_CLASS = {
  haas_bioroid: 'hb', jinteki: 'jinteki', nbn: 'nbn', weyland_consortium: 'weyland',
  anarch: 'anarch', criminal: 'criminal', shaper: 'shaper',
};
export const FACTION_NAME = {
  haas_bioroid: 'Haas-Bioroid', jinteki: 'Jinteki', nbn: 'NBN', weyland_consortium: 'Weyland',
  neutral_corp: 'Neutral', anarch: 'Anarch', criminal: 'Criminal', shaper: 'Shaper', neutral_runner: 'Neutral',
};
export const TYPE_NAME = { barrier: 'Barrier', code_gate: 'Code gate', sentry: 'Sentry' };
export const BREAKER_NAME = { fracter: 'Fracter', decoder: 'Decoder', killer: 'Killer', ai: 'AI' };

export async function loadPool() {
  const r = await fetch('pool.json');
  return r.json();
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
