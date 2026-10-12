// Shared bits of the Breaker Bay design proposals: theme controls, heatmap colour, box plot SVG.

import { defaults, esc, FACTION_CLASS } from './cost.js';

export function mountChrome() {
  window.JW.mountThemeSwitcher(document.getElementById('theme-switcher'));
  window.JW.mountModeToggle(document.getElementById('mode-toggle'));
}

// Cheap (green) → expensive (red), from the theme's pos / warn / neg tokens.
export function heat(el, credits, max) {
  if (credits == null) { el.style.background = ''; return; }
  const t = max > 0 ? Math.min(1, credits / max) : 0;
  const mix = t < 0.5
    ? `color-mix(in srgb, var(--warn) ${Math.round(t * 200)}%, var(--pos))`
    : `color-mix(in srgb, var(--neg) ${Math.round((t - 0.5) * 200)}%, var(--warn))`;
  el.style.background = `color-mix(in srgb, ${mix} ${30 + Math.round(t * 30)}%, transparent)`;
}

export function quartiles(values) {
  const v = [...values].sort((a, b) => a - b);
  const q = (p) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return v[lo] + (v[hi] - v[lo]) * (i - lo);
  };
  return { min: v[0], q1: q(0.25), med: q(0.5), q3: q(0.75), max: v[v.length - 1], n: v.length };
}

// A horizontal box plot of costs on a 0..max scale.
export function boxSvg(values, max, { width = 220, height = 26, dots = true } = {}) {
  if (!values.length) return '<span class="bb-none bb-mono">no matching ice</span>';
  const s = quartiles(values);
  const x = (c) => 4 + ((width - 8) * c) / Math.max(1, max);
  const mid = height / 2;
  let out = `<svg class="bb-box" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(`min ${s.min}, median ${s.med}, max ${s.max} credits`)}">`;
  out += `<line x1="${x(s.min)}" x2="${x(s.q1)}" y1="${mid}" y2="${mid}"/><line x1="${x(s.q3)}" x2="${x(s.max)}" y1="${mid}" y2="${mid}"/>`;
  out += `<line x1="${x(s.min)}" x2="${x(s.min)}" y1="${mid - 5}" y2="${mid + 5}"/><line x1="${x(s.max)}" x2="${x(s.max)}" y1="${mid - 5}" y2="${mid + 5}"/>`;
  out += `<rect x="${x(s.q1)}" y="${mid - 7}" width="${Math.max(1, x(s.q3) - x(s.q1))}" height="14"/>`;
  out += `<line class="med" x1="${x(s.med)}" x2="${x(s.med)}" y1="${mid - 7}" y2="${mid + 7}"/>`;
  if (dots) values.forEach((c, i) => { out += `<circle class="dot" cx="${x(c)}" cy="${mid + ((i % 5) - 2) * 1.6}" r="1.6"/>`; });
  return out + '</svg>';
}

export function isPhone() {
  return window.matchMedia('(max-width: 720px)').matches;
}

// ---------------------------------------------------------------- settings state + panel

export function newState() {
  return { breakerParams: {}, iceParams: {}, support: {}, variants: true };
}

// The checked support cards with their param values, as cost() takes them.
export function activeSupport(pool, state) {
  return pool.support
    .filter((s) => state.support[s.id]?.on)
    .map((s) => ({ ...s, params: { ...defaults(s.model), ...(state.support[s.id]?.params || {}) } }));
}

export function changedCount(state) {
  let n = Object.values(state.support).filter((s) => s.on).length;
  for (const group of [state.breakerParams, state.iceParams]) {
    n += Object.values(group).filter((p) => Object.keys(p).length).length;
  }
  return n;
}

function slider(owner, id, p, value, onInput) {
  const wrap = document.createElement('div');
  wrap.className = 'bb-setting';
  const changed = value !== p.default;
  wrap.innerHTML = p.kind === 'flag'
    ? `<label class="bb-check"><input type="checkbox" ${value ? 'checked' : ''}><span>${esc(owner)}<small>${esc(p.label)}</small></span></label>`
    : `<span class="name">${esc(owner)}</span><span class="val ${changed ? 'bb-changed' : ''}">${value}</span>
       <span class="what">${esc(p.label)} · card default ${p.default}</span>
       <input type="range" min="${p.min ?? 0}" max="${p.max}" step="1" value="${value}" aria-label="${esc(`${owner}: ${p.label}`)}">`;
  const input = wrap.querySelector('input');
  input.addEventListener('input', () => onInput(p.kind === 'flag' ? (input.checked ? 1 : 0) : Number(input.value)));
  return wrap;
}

// onChange() after every change; onChange({ rerender: true }) when the panel itself must be drawn
// again (a slider never redraws it, so dragging keeps working).
// Sections: breakers with settings, ice with settings, support cards. `only` limits which cards show.
export function renderSettings(host, pool, state, onChange, { only = null } = {}) {
  host.replaceChildren();
  const section = (title) => {
    const h = document.createElement('h3');
    h.textContent = title;
    host.append(h);
  };
  const set = (bag, cid, pid, v, def) => {
    const cur = { ...(bag[cid] || {}) };
    if (v === def) delete cur[pid]; else cur[pid] = v;
    bag[cid] = cur;
    onChange();
  };
  const withParams = (cards) => cards.filter((c) => c.model?.params && (!only || only.has(c.id)));
  const bs = withParams(pool.breakers);
  if (bs.length) {
    section('Breakers');
    for (const b of bs) {
      for (const [pid, p] of Object.entries(b.model.params)) {
        const v = state.breakerParams[b.id]?.[pid] ?? p.default;
        host.append(slider(b.title, pid, p, v, (nv) => set(state.breakerParams, b.id, pid, nv, p.default)));
      }
    }
  }
  const is = withParams(pool.ice);
  if (is.length) {
    section('Ice');
    for (const i of is) {
      for (const [pid, p] of Object.entries(i.model.params)) {
        const v = state.iceParams[i.id]?.[pid] ?? p.default;
        host.append(slider(i.title, pid, p, v, (nv) => set(state.iceParams, i.id, pid, nv, p.default)));
      }
    }
  }
  section('Support cards');
  for (const s of pool.support) {
    const on = !!state.support[s.id]?.on;
    const row = document.createElement('label');
    row.className = 'bb-check';
    row.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}><span>${esc(s.title)} <span class="faction ${FACTION_CLASS[s.faction] || ''}"></span><small>${esc(effectText(s))}</small></span>`;
    row.querySelector('input').addEventListener('change', (e) => {
      state.support[s.id] = { ...(state.support[s.id] || {}), on: e.target.checked };
      onChange({ rerender: true }); // its own params appear under it
    });
    host.append(row);
    if (on) {
      for (const [pid, p] of Object.entries(s.model.params || {})) {
        const v = state.support[s.id]?.params?.[pid] ?? p.default;
        host.append(slider(s.title, pid, p, v, (nv) => {
          state.support[s.id].params = { ...(state.support[s.id].params || {}), [pid]: nv };
          onChange();
        }));
      }
    }
  }
}

export function effectText(s) {
  const parts = s.model.effects.map((e) => {
    const n = (a) => (typeof a === 'number' ? (a > 0 ? `+${a}` : `−${-a}`) : 'per counter');
    if (e.ice_strength != null) return `ice ${n(e.ice_strength)} strength${e.ice ? ` (${e.ice.join(', ')})` : ''}`;
    if (e.ice_subs != null) return `ice ${n(e.ice_subs)} subroutine`;
    if (e.ice_gains) return 'ice gains every subtype';
    return `${e.breakers === 'non_ai' ? 'non-AI ' : ''}breakers ${n(e.breaker_strength)} strength`;
  });
  return parts.join(', ') + (s.model.note ? `. ${s.model.note}` : '');
}
