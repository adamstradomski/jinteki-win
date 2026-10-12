// Proposal C: Run planner. Stack the ice of a server; rank rigs of up to three breakers by the
// credits they need to break every piece of it.
import { breakerRows, breakerType, cost, describe, esc, FACTION_CLASS, FACTION_NAME, loadPool } from './cost.js';
import { activeSupport, changedCount, mountChrome, newState, renderSettings } from './common.js';

mountChrome();
const pool = await loadPool();
const state = newState();
const byId = Object.fromEntries(pool.ice.map((i) => [i.id, i]));
const PRESETS = [
  ['Weyland remote', ['tree_line', 'akhet', 'pharos']],
  ['HB HQ', ['m_i_c', 'bran_1_0', 'tyr']],
  ['Jinteki R&D', ['semak_samun', 'attini', 'lionsmane']],
  ['NBN tax', ['paywall', 'funhouse', 'f2p']],
].map(([n, ids]) => [n, ids.filter((id) => byId[id])]);
let server = [...PRESETS[0][1]];
let maxRig = 3;
const factions = new Set(['anarch', 'criminal', 'shaper', 'neutral_runner']);

const presets = document.getElementById('presets');
for (const [name, ids] of PRESETS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn chip';
  b.textContent = name;
  b.addEventListener('click', () => { server = [...ids]; draw(); });
  presets.append(b);
}
const fhost = document.getElementById('factions');
for (const f of factions) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn chip';
  b.textContent = FACTION_NAME[f];
  b.setAttribute('aria-pressed', 'true');
  b.addEventListener('click', () => {
    if (factions.has(f)) factions.delete(f); else factions.add(f);
    b.setAttribute('aria-pressed', String(factions.has(f)));
    draw();
  });
  fhost.append(b);
}
document.querySelectorAll('[data-max]').forEach((b) => b.addEventListener('click', () => {
  maxRig = Number(b.dataset.max);
  document.querySelectorAll('[data-max]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  draw();
}));
document.getElementById('clear').addEventListener('click', () => { server = []; draw(); });

const list = document.getElementById('ice-list');
const sorted = [...pool.ice].sort((a, b) => a.title.localeCompare(b.title));
list.innerHTML = sorted.map((i) => `<option value="${esc(i.title)}"></option>`).join('');
const add = document.getElementById('add');
add.addEventListener('change', () => {
  const i = pool.ice.find((x) => x.title.toLowerCase() === add.value.trim().toLowerCase());
  if (i) { server.push(i.id); add.value = ''; draw(); }
});
const browse = document.getElementById('browse');
browse.innerHTML = sorted.map((i) => `<button type="button" class="btn chip" data-add="${i.id}"><span class="faction ${FACTION_CLASS[i.faction] || ''}"></span> ${esc(i.title)}</button>`).join('');
browse.addEventListener('click', (e) => {
  const b = e.target.closest('[data-add]');
  if (b) { server.push(b.dataset.add); draw(); }
});
document.getElementById('stack').addEventListener('click', (e) => {
  const x = e.target.closest('[data-remove]');
  if (x) { server.splice(Number(x.dataset.remove), 1); draw(); }
});

function drawSettings() {
  renderSettings(document.getElementById('settings'), pool, state, (o) => {
    if (o?.rerender) drawSettings();
    draw();
  });
}

const slot = (r) => { const t = breakerType(r.breaker); return t === 'ai' ? 'ai' : t[0]; };

function rigs() {
  const support = activeSupport(pool, state);
  const rows = breakerRows(pool, { variants: false }).filter((r) => factions.has(r.breaker.faction));
  const spends = (r) => r.model.abilities.some((a) => a.spend);
  const memo = new Map();
  // Counters run out during a run: a breaker that spends them is costed ice by ice, in order, with
  // what the earlier ice left it. The rest don't depend on the order and are memoised.
  const costOf = (r, iceId, size, counters) => {
    const bp = { ...(state.breakerParams[r.breaker.id] || {}), ...(counters || {}) };
    if (r.model.params?.icebreakers && bp.icebreakers == null) bp.icebreakers = size;
    const run = () => cost(r, byId[iceId], { support, breakerParams: bp, iceParams: state.iceParams[iceId] });
    if (spends(r)) return run();
    const k = `${r.key}|${iceId}|${size}`;
    if (!memo.has(k)) memo.set(k, run());
    return memo.get(k);
  };
  const slots = ['fracter', 'decoder', 'killer', 'ai'].map((s) => [null, ...rows.filter((r) => slot(r) === s)]);
  const out = [];
  for (const a of slots[0]) for (const b of slots[1]) for (const c of slots[2]) for (const d of slots[3]) {
    const rig = [a, b, c, d].filter(Boolean);
    if (!rig.length || rig.length > maxRig) continue;
    let total = 0;
    const per = [];
    const left = new Map();
    let ok = true;
    for (const id of server) {
      let best = null;
      let who = null;
      for (const r of rig) {
        const x = costOf(r, id, rig.length, left.get(r.key));
        if (x && (!best || x.credits < best.credits)) { best = x; who = r; }
      }
      if (!best) { ok = false; break; }
      if (spends(who)) left.set(who.key, best.left);
      total += best.credits;
      per.push({ id, best, who });
    }
    // A rig with a breaker that breaks nothing here is the same rig without it.
    if (!ok || rig.some((r) => !per.some((p) => p.who === r))) continue;
    const install = rig.reduce((s, r) => s + (typeof r.breaker.cost === 'number' ? r.breaker.cost : 0), 0);
    const mu = rig.reduce((s, r) => s + (r.breaker.mu || 0), 0);
    out.push({ rig, total, per, install, mu });
  }
  return out.sort((x, y) => x.total - y.total || x.install - y.install || x.rig.length - y.rig.length).slice(0, 8);
}

function draw() {
  const changed = changedCount(state);
  const badge = document.getElementById('changed');
  badge.hidden = !changed;
  badge.textContent = `${changed} changed`;
  document.getElementById('stack').innerHTML = server.map((id, k) => {
    const i = byId[id];
    return `<li data-fc="${FACTION_CLASS[i.faction] || ''}"><span><span class="t">${esc(i.title)}</span><span class="m">${(i.types.map((t) => t.replace('_', ' ')).join(', ') || 'no breaker type')} · rez ${i.rez ?? '–'} · str ${i.strength ?? 0} · ${i.subs} sub</span></span><button type="button" class="x" data-remove="${k}" aria-label="Remove ${esc(i.title)}">✕</button></li>`;
  }).join('');
  document.querySelectorAll('#stack li').forEach((li) => { if (li.dataset.fc) li.style.setProperty('--fc', `var(--faction-${li.dataset.fc})`); });
  const host = document.getElementById('rigs');
  const note = document.getElementById('rig-note');
  if (!server.length) { host.innerHTML = ''; note.textContent = 'Add ice to the server to rank rigs.'; return; }
  const t0 = performance.now();
  const rs = rigs();
  note.textContent = rs.length
    ? `Credits for one run through the whole server, outermost ice first, with the cheapest breaker of the rig on each; hosted counters spent on one piece of ice are gone for the next. Install costs are separate. (${Math.round(performance.now() - t0)} ms)`
    : 'No rig of this size gets through every piece of this server with these settings.';
  host.innerHTML = rs.map((r, k) => `<li class="c-rig rank-${k + 1}"><div class="top"><span class="total">${r.total}c</span>
      <span class="names">${r.rig.map((x) => `<span class="faction ${FACTION_CLASS[x.breaker.faction] || ''}"></span> ${esc(x.breaker.title)}`).join(' + ')}</span>
      <span class="meta">install ${r.install}c · ${r.mu} MU</span></div>
      <ol>${r.per.map((p) => `<li><span>${esc(byId[p.id].title)} <span class="bb-dim">with ${esc(p.who.breaker.title)}</span></span><span class="how">${esc(describe(p.best))}</span></li>`).join('')}</ol></li>`).join('');
}

drawSettings();
draw();
