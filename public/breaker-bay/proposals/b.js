// Proposal B: Breaker cards. One card per breaker with its spread of costs, its own settings and
// variants on the card; support cards and ice settings in one drawer.
import { breakerRows, breakerType, cost, describe, esc, FACTION_CLASS, FACTION_NAME, loadPool, BREAKER_NAME } from './cost.js';
import { activeSupport, boxSvg, changedCount, mountChrome, newState, quartiles, renderSettings } from './common.js';

mountChrome();
const pool = await loadPool();
const state = newState();
const BTYPES = ['fracter', 'decoder', 'killer', 'ai'];
const sel = { b: new Set(BTYPES), f: new Set(['anarch', 'criminal', 'shaper', 'neutral_runner']), sort: 'median' };
const pickVariant = {};
const openIce = new Set();

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
chips('factions', [...sel.f], sel.f, FACTION_NAME);
document.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
  sel.sort = b.dataset.sort;
  document.querySelectorAll('[data-sort]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  draw();
}));

function drawSettings() {
  const iceIds = new Set(pool.ice.map((i) => i.id));
  renderSettings(document.getElementById('settings'), pool, state, (o) => {
    if (o?.rerender) drawSettings();
    draw();
  }, { only: iceIds });
}

function rowFor(b) {
  const rows = breakerRows(pool, { variants: true }).filter((r) => r.breaker.id === b.id);
  const want = pickVariant[b.id];
  return rows.find((r) => r.variant?.id === want) || rows.find((r) => !r.variant || r.variant.default) || rows[0];
}

function stats(b) {
  const row = rowFor(b);
  const opts = { support: activeSupport(pool, state), breakerParams: state.breakerParams[b.id] };
  const results = [];
  for (const i of pool.ice) {
    const types = [...i.types, ...(i.model?.gains || [])];
    const can = row.model.breaks.includes('any') || row.model.breaks.some((t) => types.includes(t));
    if (!can) continue;
    results.push({ ice: i, r: cost(row, i, { ...opts, iceParams: state.iceParams[i.id] }) });
  }
  const v = results.filter((x) => x.r).map((x) => x.r.credits);
  return { row, results, v, q: v.length ? quartiles(v) : null };
}

function slider(b, pid, p) {
  const v = state.breakerParams[b.id]?.[pid] ?? p.default;
  const flag = p.kind === 'flag';
  return `<div class="bb-setting" data-b="${b.id}" data-p="${pid}">${flag
    ? `<label class="bb-check"><input type="checkbox" ${v ? 'checked' : ''}><span>${esc(p.label)}</span></label>`
    : `<span class="what">${esc(p.label)}</span><span class="val ${v !== p.default ? 'bb-changed' : ''}">${v}</span>
       <input type="range" min="${p.min ?? 0}" max="${p.max}" step="1" value="${v}" aria-label="${esc(`${b.title}: ${p.label}`)}">`}</div>`;
}

function card(b, s, max) {
  const t = breakerType(b);
  const typeBadges = (t === 'ai' ? ['ai'] : t).map((x) => `<span class="badge">${BREAKER_NAME[x]}</span>`).join(' ');
  const head = `<div class="panel-header"><h2>${esc(b.title)}</h2><div class="header-controls">${typeBadges}</div></div>
    <div class="b-meta"><span class="faction ${FACTION_CLASS[b.faction] || ''}">${FACTION_NAME[b.faction]}</span>
      <span>install <strong>${b.cost ?? '–'}c</strong></span><span>MU <strong>${b.mu ?? '–'}</strong></span><span>str <strong>${b.strength ?? 0}</strong></span>
      ${b.model?.stealth ? '<span class="badge">stealth</span>' : ''}</div>`;
  if (!b.model) return `<article class="panel b-card b-unmodelled">${head}<p class="b-note">${esc(b.unmodelled)}</p></article>`;
  const vs = b.model.variants || [];
  const variants = vs.length
    ? `<div class="b-variants">${vs.map((v) => `<button type="button" class="btn chip" data-variant="${b.id}:${v.id}" aria-pressed="${s.row.variant?.id === v.id}">${esc(v.label)}</button>`).join('')}</div>`
    : '';
  const sliders = Object.entries(b.model.params || {}).map(([pid, p]) => slider(b, pid, p)).join('');
  const fail = s.results.length - s.v.length;
  const big = s.q
    ? `<div class="b-big"><span class="num">${s.q.med}c</span><span class="label">median to break · ${s.q.min}–${s.q.max}c<br>${s.v.length} of ${s.results.length} matching ice${fail ? ` · ${fail} out of reach` : ''}</span></div>`
    : `<div class="b-big"><span class="label">Can’t get through any matching ice with these settings.</span></div>`;
  const list = [...s.results].sort((a, c) => (a.r ? a.r.credits : 1e9) - (c.r ? c.r.credits : 1e9) || a.ice.title.localeCompare(c.ice.title));
  const ice = `<details class="b-ice" data-ice="${b.id}" ${openIce.has(b.id) ? 'open' : ''}><summary>Every matching ice</summary><ol>${list.map(({ ice: i, r }) => `<li class="${r ? '' : 'no'}" title="${esc(describe(r))}"><span><span class="faction ${FACTION_CLASS[i.faction] || ''}"></span> ${esc(i.title)}</span><span class="bar" data-w="${r ? r.credits / max : 0}"></span><span class="c">${r ? r.credits + 'c' : '—'}</span></li>`).join('')}</ol></details>`;
  return `<article class="panel b-card">${head}${variants}${big}${s.q ? boxSvg(s.v, max, { width: 300 }) : ''}${sliders}${b.model.note ? `<p class="b-note">${esc(b.model.note)}</p>` : ''}${ice}</article>`;
}

function draw() {
  const changed = changedCount(state);
  const badge = document.getElementById('changed');
  badge.hidden = !changed;
  badge.textContent = `${changed} changed`;
  const list = pool.breakers.filter((b) => {
    const t = breakerType(b);
    const typeOk = t === 'ai' ? sel.b.has('ai') : t.some((x) => sel.b.has(x));
    return typeOk && sel.f.has(b.faction);
  });
  const all = list.map((b) => ({ b, s: b.model ? stats(b) : null }));
  const max = Math.max(1, ...all.flatMap((x) => (x.s ? x.s.v : [])));
  // A breaker that reaches under half its ice sorts after the rest: Audrey's 0c median over one
  // piece of ice it can afford says nothing.
  const reach = (x) => (x.s?.results.length ? x.s.v.length / x.s.results.length : 0);
  const low = (x) => (reach(x) < 0.5 ? 1e6 : 0);
  const key = {
    median: (x) => (x.s?.q ? low(x) + x.s.q.med : 1e9),
    max: (x) => (x.s?.q ? low(x) + x.s.q.max : 1e9),
    install: (x) => x.b.cost ?? 1e9,
    name: () => 0,
  }[sel.sort];
  all.sort((a, c) => key(a) - key(c) || a.b.title.localeCompare(c.b.title));
  document.getElementById('scale').textContent = `Every box shares one scale, 0 to ${max} credits. ${all.length} breakers.`;
  const grid = document.getElementById('grid');
  grid.innerHTML = all.map((x) => card(x.b, x.s, max)).join('');
  grid.querySelectorAll('.bar').forEach((el) => { el.style.width = `${Math.round(Number(el.dataset.w) * 100)}%`; });
}

const grid = document.getElementById('grid');
grid.addEventListener('click', (e) => {
  const v = e.target.closest('[data-variant]');
  if (!v) return;
  const [bid, vid] = v.dataset.variant.split(':');
  pickVariant[bid] = vid;
  draw();
});
grid.addEventListener('toggle', (e) => {
  const d = e.target.closest?.('[data-ice]');
  if (!d) return;
  if (d.open) openIce.add(d.dataset.ice); else openIce.delete(d.dataset.ice);
}, true);
grid.addEventListener('input', (e) => {
  const w = e.target.closest('.bb-setting[data-b]');
  if (!w) return;
  const b = pool.breakers.find((x) => x.id === w.dataset.b);
  const p = b.model.params[w.dataset.p];
  const v = e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : Number(e.target.value);
  const cur = { ...(state.breakerParams[b.id] || {}) };
  if (v === p.default) delete cur[w.dataset.p]; else cur[w.dataset.p] = v;
  state.breakerParams[b.id] = cur;
  const val = w.querySelector('.val');
  if (val) val.textContent = v;
});
// Redraw when the drag ends, so the slider under the finger isn't replaced mid-drag.
grid.addEventListener('change', (e) => { if (e.target.closest('.bb-setting[data-b]')) draw(); });

drawSettings();
draw();
