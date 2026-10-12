// Breaker Bay page: loads the snapshot's pool, keeps the state in the address, draws the card
// settings, the filters, the cost table and the run planner. Every rule lives in model.js.
import * as M from './model.js';
import { $, el, debounce } from '../shared/dom.js';

const PRESETS = [
  ['Weyland remote', ['tree_line', 'akhet', 'pharos']],
  ['HB HQ', ['m_i_c', 'bran_1_0', 'tyr']],
  ['Jinteki R&D', ['semak_samun', 'attini', 'lionsmane']],
  ['NBN tax', ['paywall', 'funhouse', 'f2p']],
];
const phoneQuery = window.matchMedia('(max-width: 720px)');
const base = M.dataBase(location.search);
let pool;
let state;
let picked = null; // { row, ice } keys of the cell whose breakdown is shown

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fclass = (f) => M.FACTION_CLASS[f] || '';
const support = () => M.activeSupport(pool, state.sp);

async function getJson(url) {
  const r = await fetch(url, { credentials: 'omit' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Cheap (pos) → dear (neg), mixed from the theme's tokens.
function heat(node, credits, max) {
  if (credits == null) return;
  const t = max > 0 ? Math.min(1, credits / max) : 0;
  const mix = t < 0.5
    ? `color-mix(in srgb, var(--warn) ${Math.round(t * 200)}%, var(--pos))`
    : `color-mix(in srgb, var(--neg) ${Math.round((t - 0.5) * 200)}%, var(--warn))`;
  node.style.background = `color-mix(in srgb, ${mix} ${30 + Math.round(t * 30)}%, transparent)`;
}

function chip(label, pressed, onClick, title) {
  return el('button', { type: 'button', class: 'btn chip', 'aria-pressed': String(pressed), title, onclick: onClick }, label);
}

function writeHash() {
  const h = M.formatHash(state);
  if (h !== location.hash && !(h === '' && !location.hash)) history.replaceState(null, '', h || location.pathname + location.search);
}

// ---------------------------------------------------------------- boot

async function boot() {
  JW.mountThemeSwitcher($('theme-switcher'));
  JW.mountModeToggle($('mode-toggle'));
  try {
    const manifest = await getJson(M.joinUrl(base, 'manifest.json'));
    if (!manifest.paths?.breaker_bay) throw new Error('no Breaker Bay data in this snapshot');
    pool = await getJson(M.joinUrl(base, manifest.base_path + manifest.paths.breaker_bay));
    $('version').textContent = `Card pool: ${pool.restriction || 'unknown ban list'} · snapshot ${manifest.version}.`;
  } catch {
    $('status').textContent = 'The card pool could not be loaded. Try again in a moment.';
    return;
  }
  state = M.parseHash(location.hash, pool, M.defaultState({ phone: phoneQuery.matches }));
  // Drop what a link got wrong; an address without a hash keeps none (a phone starts narrower).
  if (location.hash) writeHash();
  $('status').hidden = true;
  $('app').hidden = false;
  setupSettingsPanel();
  setupFilters();
  setupTable();
  setupPlanner();
  drawUnmodelled();
  drawAll();
  window.addEventListener('hashchange', () => {
    if (location.hash === M.formatHash(state)) return;
    state = M.parseHash(location.hash, pool, M.defaultState({ phone: phoneQuery.matches }));
    drawAll();
  });
}

function drawAll() {
  syncFilters();
  drawSettings();
  drawTable();
  drawPlanner();
}

// Settings changes redraw the numbers but not the panel, so a slider keeps working under a finger.
const redraw = debounce(() => { writeHash(); drawTable(); drawPlanner(); drawChangedBadge(); }, 60);
const refilter = () => { writeHash(); syncFilters(); drawSettings(); drawTable(); drawPlanner(); };

// ---------------------------------------------------------------- card settings

function setupSettingsPanel() {
  const panel = $('settings-panel');
  const toggle = $('settings-toggle');
  toggle.addEventListener('click', () => {
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Hide' : 'Show';
  });
  $('settings-reset').addEventListener('click', () => {
    state.bp = {};
    state.ip = {};
    state.sp = {};
    refilter();
  });
}

function changedCount() {
  const n = (bag) => Object.values(bag).filter((p) => Object.keys(p).length).length;
  return n(state.bp) + n(state.ip) + Object.keys(state.sp).length;
}

function drawChangedBadge() {
  const n = changedCount();
  $('changed').hidden = !n;
  $('changed').textContent = `${n} changed`;
}

function slider(owner, p, value, onValue) {
  const changed = value !== p.default;
  if (p.kind === 'flag') {
    const box = el('input', { type: 'checkbox', checked: !!value, onchange: (e) => onValue(e.target.checked ? 1 : 0) });
    return el('label', { class: `bb-check${changed ? ' changed' : ''}` }, box, el('span', {}, el('span', { class: 'name' }, owner), el('small', {}, p.label)));
  }
  const val = el('span', { class: `val${changed ? ' changed' : ''}` }, String(value));
  const range = el('input', {
    type: 'range', min: p.min ?? 0, max: p.max, step: 1, value, 'aria-label': `${owner}: ${p.label}`,
    oninput: (e) => {
      const v = Number(e.target.value);
      val.textContent = String(v);
      val.classList.toggle('changed', v !== p.default);
      onValue(v);
    },
  });
  return el('div', { class: 'bb-setting' }, el('span', { class: 'name' }, owner), val,
    el('span', { class: 'what' }, `${p.label} · card gives ${p.default}`), range);
}

function setParam(bag, card, param, value, def) {
  const cur = { ...(bag[card] || {}) };
  if (value === def) delete cur[param];
  else cur[param] = value;
  if (Object.keys(cur).length) bag[card] = cur;
  else delete bag[card];
  redraw();
}

function effectText(s) {
  const n = (a) => (typeof a === 'number' ? (a > 0 ? `+${a}` : `−${-a}`) : 'per counter');
  const parts = s.model.effects.map((e) => {
    if (e.ice_strength != null) return `ice ${n(e.ice_strength)} strength${e.ice ? ` (${e.ice.join(', ')})` : ''}`;
    if (e.ice_subs != null) return `ice ${n(e.ice_subs)} subroutine${e.ice ? ` (${e.ice.join(', ')})` : ''}`;
    if (e.ice_gains) return 'ice gains every subtype';
    return `${e.breakers === 'non_ai' ? 'non-AI ' : ''}icebreakers ${n(e.breaker_strength)} strength`;
  });
  return parts.join(', ') + (s.model.note ? `. ${s.model.note}` : '');
}

// Settings of the breakers and ice in view, and every support card.
function drawSettings() {
  drawChangedBadge();
  const host = $('settings');
  host.replaceChildren();
  const breakers = [...new Map(M.filterRows(pool, state).map((r) => [r.breaker.id, r.breaker])).values()]
    .filter((b) => b.model.params);
  if (breakers.length) {
    host.append(el('h3', {}, 'Breakers in view'));
    for (const b of breakers) {
      for (const [id, p] of Object.entries(b.model.params)) {
        const v = M.paramValues(b.model, state.bp[b.id])[id];
        host.append(slider(b.title, p, v, (nv) => setParam(state.bp, b.id, id, nv, p.default)));
      }
    }
  }
  const ice = M.filterIce(pool, state, support()).map((x) => x.ice).filter((i) => i.model?.params);
  if (ice.length) {
    host.append(el('h3', {}, 'Ice in view'));
    for (const i of ice) {
      for (const [id, p] of Object.entries(i.model.params)) {
        const v = M.paramValues(i.model, state.ip[i.id])[id];
        host.append(slider(i.title, p, v, (nv) => setParam(state.ip, i.id, id, nv, p.default)));
      }
    }
  }
  host.append(el('h3', {}, 'Support cards'));
  for (const s of pool.support) {
    const on = !!state.sp[s.id];
    const box = el('input', {
      type: 'checkbox', checked: on,
      onchange: (e) => {
        if (e.target.checked) state.sp[s.id] = { params: {} };
        else delete state.sp[s.id];
        refilter(); // its own settings appear under it, and the ice in view may change
      },
    });
    host.append(el('label', { class: `bb-check${on ? ' changed' : ''}` }, box,
      el('span', {}, el('span', { class: 'name' }, s.title), ' ', el('span', { class: `faction ${fclass(s.faction)}` }),
        el('small', {}, effectText(s)))));
    if (on) {
      for (const [id, p] of Object.entries(s.model.params || {})) {
        const v = M.paramValues(s.model, state.sp[s.id].params)[id];
        host.append(slider(s.title, p, v, (nv) => {
          const ps = { ...state.sp[s.id].params };
          if (nv === p.default) delete ps[id]; else ps[id] = nv;
          state.sp[s.id].params = ps;
          redraw();
        }));
      }
    }
  }
}

// ---------------------------------------------------------------- filters

function chipSet(host, values, names, key) {
  for (const v of values) {
    host.append(chip(names[v], state[key].has(v), (e) => {
      if (state[key].has(v)) state[key].delete(v); else state[key].add(v);
      e.currentTarget.setAttribute('aria-pressed', String(state[key].has(v)));
      refilter();
    }));
  }
}

function setupFilters() {
  chipSet($('f-bt'), M.BREAKER_TYPES, M.BREAKER_NAME, 'bt');
  chipSet($('f-bf'), M.RUNNER_FACTIONS, M.FACTION_NAME, 'bf');
  chipSet($('f-it'), M.ICE_TYPES, M.TYPE_NAME, 'it');
  chipSet($('f-if'), M.CORP_FACTIONS, M.FACTION_NAME, 'if');
  $('f-stealth').addEventListener('change', (e) => { state.stealth = e.target.value; refilter(); });
  for (const [id, key] of [['f-special', 'special'], ['f-variants', 'variants']]) {
    $(id).addEventListener('click', () => { state[key] = !state[key]; picked = null; refilter(); });
  }
  const range = (key, lo, hi) => {
    const read = () => {
      const a = $(lo).value === '' ? null : Number($(lo).value);
      const b = $(hi).value === '' ? null : Number($(hi).value);
      if (a == null && b == null) state[key] = null;
      else {
        const x = Number.isInteger(a) && a >= 0 ? a : 0;
        const y = Number.isInteger(b) && b >= 0 ? b : 99;
        state[key] = x <= y ? [x, y] : [y, x];
      }
      refilter();
    };
    $(lo).addEventListener('change', read);
    $(hi).addEventListener('change', read);
  };
  range('rez', 'f-rez-min', 'f-rez-max');
  range('str', 'f-str-min', 'f-str-max');
  $('filters-reset').addEventListener('click', () => {
    const d = M.defaultState({ phone: phoneQuery.matches });
    for (const k of ['bt', 'bf', 'it', 'if', 'stealth', 'rez', 'str', 'variants', 'special', 'pickB', 'pickI']) state[k] = d[k];
    refilter();
  });
  setupPicker('pick-b', 'pickB', () => pool.breakers.map((b) => ({ id: b.id, title: b.title, faction: b.faction, hint: b.model ? '' : 'not costed' })),
    () => new Set(M.filterRows(pool, { ...state, pickB: null }).map((r) => r.breaker.id)));
  setupPicker('pick-i', 'pickI', () => pool.ice.map((i) => ({ id: i.id, title: i.title, faction: i.faction, hint: '' })),
    () => new Set(M.filterIce(pool, { ...state, pickI: null }, support()).map((x) => x.ice.id)));
}

// A checklist of every card; ticking any switches from the filters to exactly the ticked cards.
function setupPicker(id, key, cards, fromFilters) {
  const body = $(id).querySelector('.bb-pick-body');
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Filter by name', 'aria-label': 'Filter the list by name' });
  const list = el('div', { class: 'bb-pick-list' });
  const set = (ids) => { state[key] = ids; refilter(); };
  const tools = el('div', { class: 'bb-pick-tools' }, search,
    el('button', { type: 'button', class: 'btn secondary', onclick: () => set(new Set(cards().map((c) => c.id))) }, 'All'),
    el('button', { type: 'button', class: 'btn secondary', onclick: () => set(new Set()) }, 'None'),
    el('button', { type: 'button', class: 'btn secondary', onclick: () => set(null) }, 'Use the filters'));
  body.append(tools, list);
  const draw = () => {
    const chosen = state[key] || fromFilters();
    const q = search.value.trim().toLowerCase();
    list.replaceChildren(...[...cards()].sort((a, b) => a.title.localeCompare(b.title))
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .map((c) => el('label', {},
        el('input', {
          type: 'checkbox', checked: chosen.has(c.id),
          onchange: (e) => {
            const next = new Set(state[key] || fromFilters());
            if (e.target.checked) next.add(c.id); else next.delete(c.id);
            set(next);
          },
        }),
        el('span', { class: `faction ${fclass(c.faction)}` }), c.title, c.hint ? el('small', { class: 'bb-note' }, ` (${c.hint})`) : null)));
  };
  search.addEventListener('input', draw);
  $(id).addEventListener('toggle', draw);
  $(id)._draw = draw;
}

function syncFilters() {
  const press = (host, key) => host.querySelectorAll('.btn.chip').forEach((b, k) => {
    const vals = { bt: M.BREAKER_TYPES, bf: M.RUNNER_FACTIONS, it: M.ICE_TYPES, if: M.CORP_FACTIONS }[key];
    b.setAttribute('aria-pressed', String(state[key].has(vals[k])));
  });
  press($('f-bt'), 'bt');
  press($('f-bf'), 'bf');
  press($('f-it'), 'it');
  press($('f-if'), 'if');
  $('f-stealth').value = state.stealth;
  $('f-special').setAttribute('aria-pressed', String(state.special));
  $('f-variants').setAttribute('aria-pressed', String(state.variants));
  $('swap').setAttribute('aria-pressed', String(state.swap));
  $('f-rez-min').value = state.rez ? state.rez[0] : '';
  $('f-rez-max').value = state.rez ? state.rez[1] : '';
  $('f-str-min').value = state.str ? state.str[0] : '';
  $('f-str-max').value = state.str ? state.str[1] : '';
  // A pick overrides the type and faction filters of its side: grey them out.
  for (const [k, ids] of [['pickB', ['f-bt', 'f-bf']], ['pickI', ['f-it', 'f-if']]]) {
    for (const i of ids) $(i).classList.toggle('bb-overridden', !!state[k]);
  }
  for (const [id, key] of [['pick-b', 'pickB'], ['pick-i', 'pickI']]) {
    const badge = $(`${id}-count`);
    badge.hidden = !state[key];
    badge.textContent = state[key] ? `${state[key].size} chosen` : '';
    if ($(id).open) $(id)._draw?.();
  }
}

// ---------------------------------------------------------------- cost table

function setupTable() {
  $('swap').addEventListener('click', () => { state.swap = !state.swap; picked = null; refilter(); });
  $('table').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-row]');
    if (!b) return;
    picked = { row: b.dataset.row, ice: b.dataset.ice };
    drawTable();
  });
}

const GROUP_NAME = { fracter: 'Fracters', decoder: 'Decoders', killer: 'Killers', ai: 'AI' };

function drawTable() {
  const sup = support();
  const rows = M.filterRows(pool, state);
  const cols = M.BREAKER_TYPES.flatMap((t) => rows.filter((r) => r.slot === t).map((r) => ({ ...r, group: t })));
  const ice = M.filterIce(pool, state, sup);
  const grid = M.costGrid(cols, ice, state, sup);
  const all = grid.flat().filter(Boolean).map((x) => x.credits);
  const max = Math.max(1, ...all);
  $('table-count').textContent = `${cols.length} breaker rows × ${ice.length} pieces of ice; ${all.length} costs, from ${all.length ? Math.min(...all) : 0} to ${all.length ? Math.max(...all) : 0} credits.`;
  const iceHead = (x) => `<span class="faction ${fclass(x.ice.faction)}"></span> ${esc(x.ice.title)}<span class="sub">rez ${x.ice.rez ?? '–'} · str ${x.state.strength} · ${x.state.subs} sub</span>`;
  const rowHead = (r) => `${esc(r.breaker.title)}${r.variant && state.variants ? `<span class="sub v">${esc(r.variant.label)}</span>` : ''}<span class="sub">str ${r.breaker.strength ?? 0} · install ${r.breaker.cost ?? '–'}</span>`;
  const colHead = (r) => `<span class="col">${esc(r.breaker.title)}${r.variant && state.variants ? `<span class="v">${esc(r.variant.label)}</span>` : ''}</span>`;
  const colIce = (x) => `<span class="col">${esc(x.ice.title)}</span>`;
  const R = state.swap ? cols : ice;
  const C = state.swap ? ice : cols;
  const cell = (ri, ci) => (state.swap ? grid[ci][ri] : grid[ri][ci]);
  const keyOf = (ri, ci) => (state.swap ? [cols[ri].key, ice[ci].ice.id] : [cols[ci].key, ice[ri].ice.id]);
  const groups = [];
  C.forEach((c, k) => { if (!groups.length || groups[groups.length - 1].g !== c.group) groups.push({ g: c.group, n: 1, start: k }); else groups[groups.length - 1].n++; });
  const firsts = new Set(groups.map((g) => g.start));
  const gname = (g) => (state.swap ? M.TYPE_NAME[g] : GROUP_NAME[g]);
  let h = `<thead><tr><th class="rh" rowspan="2">${state.swap ? 'Breaker' : 'Ice'}</th>`;
  h += groups.map((g) => `<th class="group first" colspan="${g.n}">${gname(g.g)}</th>`).join('');
  h += `<th class="first" rowspan="2">${state.swap ? 'Median' : 'Cheapest'}</th></tr><tr>`;
  h += C.map((c, k) => `<th class="${firsts.has(k) ? 'first' : ''}">${state.swap ? colIce(c) : colHead(c)}</th>`).join('');
  h += '</tr></thead><tbody>';
  let last = null;
  R.forEach((r, ri) => {
    if (r.group !== last) {
      last = r.group;
      h += `<tr class="grp"><td class="rh">${state.swap ? GROUP_NAME[r.group] : M.TYPE_NAME[r.group]}</td><td colspan="${C.length + 1}"></td></tr>`;
    }
    const cs = C.map((_, ci) => cell(ri, ci));
    let tail = '–';
    if (state.swap) {
      const q = M.quartiles(cs.filter(Boolean).map((x) => x.credits));
      if (q) tail = `${q.med}c`;
    } else {
      let bi = -1;
      cs.forEach((x, k) => { if (x && (bi < 0 || x.credits < cs[bi].credits)) bi = k; });
      if (bi >= 0) tail = `${esc(C[bi].breaker.title)} ${cs[bi].credits}c`;
    }
    h += `<tr><td class="rh">${state.swap ? rowHead(r) : iceHead(r)}</td>`;
    h += cs.map((x, ci) => {
      const [rk, ik] = keyOf(ri, ci);
      const sel = picked && picked.row === rk && picked.ice === ik ? ' sel' : '';
      return `<td class="cost${firsts.has(ci) ? ' first' : ''}${sel}">${x ? `<button type="button" data-row="${esc(rk)}" data-ice="${esc(ik)}" data-c="${x.credits}">${x.credits}</button>` : ''}</td>`;
    }).join('');
    h += `<td class="first tail">${tail}</td></tr>`;
  });
  const table = $('table');
  table.innerHTML = `${h}</tbody>`;
  table.querySelectorAll('button[data-c]').forEach((b) => heat(b.parentElement, Number(b.dataset.c), max));
  drawDetail(cols, sup);
}

function drawDetail(cols, sup) {
  const host = $('detail');
  const r = picked && cols.find((c) => c.key === picked.row);
  const i = picked && pool.ice.find((x) => x.id === picked.ice);
  if (!r || !i) { host.textContent = ''; return; }
  const x = M.encounter(r, i, { breakerParams: state.bp[r.breaker.id], iceParams: state.ip[i.id], support: sup });
  host.innerHTML = `<strong>${esc(r.label)} → ${esc(i.title)}</strong>: ${esc(M.describe(x))}`
    + `<span class="bb-note"> · install ${r.breaker.cost ?? '–'}c, ${r.breaker.mu ?? '–'} MU</span>`
    + (r.model.note || r.model.special ? `<br><span class="bb-note">${esc(r.model.special || r.model.note)}</span>` : '')
    + (i.model?.note ? `<br><span class="bb-note">${esc(i.title)}: ${esc(i.model.note)}</span>` : '');
}

// ---------------------------------------------------------------- run planner

function setupPlanner() {
  const byId = new Set(pool.ice.map((i) => i.id));
  for (const [name, ids] of PRESETS) {
    const known = ids.filter((id) => byId.has(id));
    if (known.length) $('presets').append(chip(name, false, () => { state.server = [...known]; writeHash(); drawPlanner(); }));
  }
  for (let n = 1; n <= M.MAX_RIG; n++) {
    $('rig-size').append(chip(n === 1 ? '1 breaker' : `Up to ${n}`, state.rig === n, () => { state.rig = n; writeHash(); drawPlanner(); }));
  }
  const sorted = [...pool.ice].sort((a, b) => a.title.localeCompare(b.title));
  $('ice-list').replaceChildren(...sorted.map((i) => el('option', { value: i.title })));
  $('add-ice').addEventListener('change', (e) => {
    const i = pool.ice.find((x) => x.title.toLowerCase() === e.target.value.trim().toLowerCase());
    if (!i || state.server.length >= 8) return;
    state.server.push(i.id);
    e.target.value = '';
    writeHash();
    drawPlanner();
  });
  $('stack').addEventListener('click', (e) => {
    const x = e.target.closest('[data-remove]');
    if (!x) return;
    state.server.splice(Number(x.dataset.remove), 1);
    writeHash();
    drawPlanner();
  });
  $('clear-server').addEventListener('click', () => { state.server = []; writeHash(); drawPlanner(); });
}

function drawPlanner() {
  $('rig-size').querySelectorAll('.btn.chip').forEach((b, k) => b.setAttribute('aria-pressed', String(state.rig === k + 1)));
  const byId = Object.fromEntries(pool.ice.map((i) => [i.id, i]));
  const sup = support();
  $('stack').replaceChildren(...state.server.map((id, k) => {
    const i = byId[id];
    const st = M.iceState(i, state.ip[id], sup);
    const li = el('li', {},
      el('span', {}, el('span', { class: 't' }, i.title),
        el('span', { class: 'm' }, `${st.types.map((t) => M.TYPE_NAME[t]).join(', ') || 'no breaker type'} · rez ${i.rez ?? '–'} · str ${st.strength} · ${st.subs} sub`)),
      el('button', { type: 'button', class: 'x', 'data-remove': k, 'aria-label': `Remove ${i.title}` }, '✕'));
    if (fclass(i.faction)) li.style.setProperty('--fc', `var(--faction-${fclass(i.faction)})`);
    return li;
  }));
  const note = $('rig-note');
  const host = $('rigs');
  if (!state.server.length) {
    note.textContent = 'Add the ice of a server, outermost first, to rank rigs.';
    host.replaceChildren();
    return;
  }
  // The breakers the filters keep, each in its default situation.
  const rows = M.filterRows(pool, { ...state, variants: false });
  const rigs = M.rankRigs(pool, rows, state.server, state, sup, { size: state.rig });
  note.textContent = rigs.length
    ? 'Credits for one run, outermost ice first, with the rig’s cheapest breaker on each; counters spent on one piece of ice are gone for the next. Install costs are separate. Uses the breakers the filters keep.'
    : 'No rig of this size from the breakers the filters keep gets through every piece of this server.';
  host.replaceChildren(...rigs.map((r, k) => el('li', { class: `bb-rig${k === 0 ? ' first-rank' : ''}` },
    el('div', { class: 'top' },
      el('span', { class: 'total' }, `${r.total}c`),
      el('span', { class: 'names' }, ...r.rig.flatMap((x, n) => [n ? ' + ' : '', el('span', { class: `faction ${fclass(x.breaker.faction)}` }), ' ', x.breaker.title])),
      el('span', { class: 'meta' }, `install ${r.install}c · ${r.mu} MU`)),
    el('ol', {}, ...r.per.flatMap((p) => [
      el('li', {}, p.ice.title, ' ', el('span', { class: 'with' }, `with ${p.row.breaker.title}`)),
      el('li', { class: 'how' }, M.describe(p.result)),
    ])))));
}

// ---------------------------------------------------------------- not costed

function drawUnmodelled() {
  const list = pool.breakers.filter((b) => b.unmodelled);
  $('unmodelled-panel').hidden = !list.length;
  $('unmodelled').replaceChildren(...list.map((b) => el('li', {}, el('span', { class: `faction ${fclass(b.faction)}` }), ' ', b.title, ': ', el('span', { class: 'why' }, b.unmodelled))));
}

boot();
