// Proposal A: Workbench. Settings column, one table of ice × breakers, box plot below.
import { breakerRows, breakerType, cost, describe, esc, FACTION_CLASS, iceState, loadPool, BREAKER_NAME, TYPE_NAME } from './cost.js';
import { activeSupport, boxSvg, changedCount, heat, isPhone, mountChrome, newState, quartiles, renderSettings } from './common.js';

mountChrome();
const pool = await loadPool();
const state = newState();
const BTYPES = ['fracter', 'decoder', 'killer', 'ai'];
const ITYPES = ['barrier', 'code_gate', 'sentry'];
const phone = isPhone();
const sel = { b: new Set(phone ? ['fracter'] : BTYPES), i: new Set(phone ? ['barrier'] : ITYPES), swap: false };
let picked = null;

function chips(hostId, all, set, names) {
  const host = document.getElementById(hostId);
  for (const t of all) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn chip';
    b.textContent = names[t];
    b.setAttribute('aria-pressed', String(set.has(t)));
    b.addEventListener('click', () => {
      if (set.has(t)) set.delete(t); else set.add(t);
      b.setAttribute('aria-pressed', String(set.has(t)));
      draw();
    });
    host.append(b);
  }
}
chips('breaker-types', BTYPES, sel.b, BREAKER_NAME);
chips('ice-types', ITYPES, sel.i, TYPE_NAME);

const toggle = (id, key) => {
  const b = document.getElementById(id);
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    if (key === 'variants') state.variants = on; else sel.swap = on;
    picked = null;
    draw();
  });
};
toggle('variants', 'variants');
toggle('swap', 'swap');

const panel = document.getElementById('settings-panel');
const tbtn = document.getElementById('settings-toggle');
tbtn.addEventListener('click', () => {
  const open = !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  tbtn.setAttribute('aria-expanded', String(open));
  tbtn.textContent = open ? 'Hide' : 'Show';
});
document.getElementById('reset').addEventListener('click', () => {
  Object.assign(state, newState(), { variants: state.variants });
  drawSettings();
  draw();
});

function drawSettings() {
  renderSettings(document.getElementById('settings'), pool, state, (o) => {
    if (o?.rerender) drawSettings();
    draw();
  });
}

function primary(row) {
  const t = breakerType(row.breaker);
  return t === 'ai' ? 'ai' : t[0];
}

function columns() {
  const rows = breakerRows(pool, { variants: state.variants }).filter((r) => {
    const t = breakerType(r.breaker);
    return t === 'ai' ? sel.b.has('ai') : t.some((x) => sel.b.has(x));
  });
  return BTYPES.flatMap((g) => rows.filter((r) => primary(r) === g).map((r) => ({ ...r, group: g })));
}

function iceRows() {
  const out = [];
  const seen = new Set();
  for (const g of ITYPES) {
    if (!sel.i.has(g)) continue;
    for (const i of pool.ice) {
      const types = [...i.types, ...(i.model?.gains || [])];
      if (types.includes(g) && !seen.has(i.id)) { seen.add(i.id); out.push({ ...i, group: g }); }
    }
  }
  if (sel.b.has('ai')) for (const i of pool.ice) if (!seen.has(i.id) && !i.types.length) out.push({ ...i, group: 'other' });
  return out.sort((a, b) => (ITYPES.indexOf(a.group) + 9) % 9 - (ITYPES.indexOf(b.group) + 9) % 9 || (a.rez ?? 0) - (b.rez ?? 0) || a.title.localeCompare(b.title));
}

function draw() {
  const changed = changedCount(state);
  const badge = document.getElementById('changed');
  badge.hidden = !changed;
  badge.textContent = `${changed} changed`;
  const opts = { support: activeSupport(pool, state) };
  const cols = columns();
  const ice = iceRows();
  const grid = ice.map((i) => cols.map((c) => {
    const o = { ...opts, breakerParams: state.breakerParams[c.breaker.id], iceParams: state.iceParams[i.id] };
    return cost(c, i, o);
  }));
  const max = Math.max(1, ...grid.flat().filter(Boolean).map((r) => r.credits));
  const table = document.getElementById('table');
  const iceLabel = (i) => {
    const st = iceState(i, state.iceParams[i.id], opts.support);
    return `<span class="faction ${FACTION_CLASS[i.faction] || ''}"></span> ${esc(i.title)}<span class="sub">rez ${i.rez ?? '–'} · str ${st.strength} · ${st.subs} sub</span>`;
  };
  const brLabel = (c) => `<span class="colname">${esc(c.breaker.title)}${c.variant && state.variants ? `<span class="vlabel">${esc(c.variant.label)}</span>` : ''}</span>`;
  const groupsOf = (list, name) => {
    const g = [];
    list.forEach((x, k) => { if (!g.length || g[g.length - 1].k !== x.group) g.push({ k: x.group, n: 1, start: k }); else g[g.length - 1].n++; });
    return g.map((x) => ({ ...x, name: name(x.k) }));
  };
  const bname = (k) => ({ fracter: 'Fracters', decoder: 'Decoders', killer: 'Killers', ai: 'AI' })[k];
  const iname = (k) => TYPE_NAME[k] || 'Other ice';
  const R = sel.swap ? cols : ice;
  const C = sel.swap ? ice : cols;
  const cell = (ri, ci) => (sel.swap ? grid[ci][ri] : grid[ri][ci]);
  const cg = groupsOf(C, sel.swap ? iname : bname);
  const firsts = new Set(cg.map((g) => g.start));
  let h = `<thead><tr><th class="rh" rowspan="2">${sel.swap ? 'Breaker' : 'Ice'}</th>`;
  h += cg.map((g) => `<th class="group" colspan="${g.n}">${g.name}</th>`).join('');
  h += `<th class="first" rowspan="2">${sel.swap ? 'Median' : 'Cheapest'}</th></tr><tr>`;
  h += C.map((c, k) => `<th class="${firsts.has(k) ? 'first' : ''}">${sel.swap ? `<span class="colname">${esc(c.title)}</span>` : brLabel(c)}</th>`).join('');
  h += '</tr></thead><tbody>';
  let last = null;
  R.forEach((r, ri) => {
    if (r.group !== last) {
      last = r.group;
      h += `<tr class="grp"><td class="rh">${(sel.swap ? bname : iname)(r.group)}</td><td colspan="${C.length + 1}"></td></tr>`;
    }
    const cs = C.map((_, ci) => cell(ri, ci));
    let tail;
    if (sel.swap) {
      const v = cs.filter(Boolean).map((x) => x.credits);
      tail = v.length ? quartiles(v).med : '–';
    } else {
      let bi = -1;
      cs.forEach((x, k) => { if (x && (bi < 0 || x.credits < cs[bi].credits)) bi = k; });
      tail = bi < 0 ? '–' : `${esc(C[bi].breaker.title)} ${cs[bi].credits}c`;
    }
    h += `<tr><td class="rh">${sel.swap ? esc(r.label) : iceLabel(r)}</td>`;
    h += cs.map((x, ci) => `<td class="bb-cost ${firsts.has(ci) ? 'first' : ''} ${x ? '' : 'bb-none'}" data-r="${ri}" data-c="${ci}">${x ? x.credits : ''}</td>`).join('');
    h += `<td class="first best">${tail}</td></tr>`;
  });
  table.innerHTML = h + '</tbody>';
  table.querySelectorAll('td.bb-cost').forEach((td) => {
    const x = cell(+td.dataset.r, +td.dataset.c);
    heat(td, x ? x.credits : null, max);
    if (picked && picked.r === +td.dataset.r && picked.c === +td.dataset.c) td.classList.add('sel');
  });
  drawBoxes(cols, ice, grid, max);
}

document.getElementById('table').addEventListener('click', (e) => {
  const td = e.target.closest('td.bb-cost');
  if (!td) return;
  picked = { r: +td.dataset.r, c: +td.dataset.c };
  const cols = columns();
  const ice = iceRows();
  const [bi, ii] = sel.swap ? [picked.r, picked.c] : [picked.c, picked.r];
  const c = cols[bi];
  const i = ice[ii];
  const x = cost(c, i, { support: activeSupport(pool, state), breakerParams: state.breakerParams[c.breaker.id], iceParams: state.iceParams[i.id] });
  document.getElementById('detail').innerHTML = `<strong>${esc(c.label)} → ${esc(i.title)}</strong>: ${esc(describe(x))}${c.breaker.cost != null ? ` <span class="bb-dim">· install ${c.breaker.cost}c</span>` : ''}`;
  draw();
});

function drawBoxes(cols, ice, grid, max) {
  const items = cols.map((c, ci) => ({ c, v: ice.map((_, ii) => grid[ii][ci]).filter(Boolean).map((x) => x.credits) }))
    .filter((x) => x.v.length)
    .sort((a, b) => quartiles(a.v).med - quartiles(b.v).med || a.c.label.localeCompare(b.c.label));
  const host = document.getElementById('boxes');
  host.innerHTML = items.map(({ c, v }) => {
    const q = quartiles(v);
    return `<span><span class="faction ${FACTION_CLASS[c.breaker.faction] || ''}"></span> ${esc(c.label)}</span><span class="box">${boxSvg(v, max, { width: 400 })}</span><span class="axis">med ${q.med} · ${v.length} ice</span>`;
  }).join('') || '<p class="bb-note">No breaker matches the filters.</p>';
}

drawSettings();
draw();
