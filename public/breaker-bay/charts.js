// Breaker Bay charts, hand-written SVG: the cost box plot per breaker, the treemap of ice by faction
// and rez cost, and the number of ice by strength per faction. They take computed data from
// model.js and colours from the design system tokens; they read no page state.
import { el, svg } from '../shared/dom.js';
import { FACTION_CLASS, FACTION_NAME } from './model.js';

const factionColor = (f) => (FACTION_CLASS[f] ? `var(--faction-${FACTION_CLASS[f]})` : 'var(--faction-neutral)');
const round = (v) => Math.round(v * 10) / 10;
// Theme colours are CSS variables, which SVG presentation attributes don't resolve: set them as styles.
const paint = (node, props) => { for (const [k, v] of Object.entries(props)) node.style.setProperty(k, v); return node; };

// ---------------------------------------------------------------- box plot

/** One row per breaker: name, a box from the first to the third quartile with the median and
 *  whiskers to the cheapest and dearest, each cost as a dot, and the reach. One scale, 0..max. */
export function drawBoxes(host, spread, max) {
  if (!spread.length) {
    host.replaceChildren(el('p', { class: 'bb-note' }, 'No breaker in view gets through any ice in view.'));
    return;
  }
  const W = 400;
  const H = 24;
  const x = (c) => 6 + ((W - 12) * c) / Math.max(1, max);
  const axis = svg('svg', { viewBox: `0 0 ${W} 14`, class: 'bb-box-axis', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
  const step = max > 12 ? 5 : max > 6 ? 2 : 1;
  for (let c = 0; c <= max; c += step) axis.append(svg('text', { class: 'chart-tick', x: x(c), y: 11, 'text-anchor': 'middle' }, `${c}c`));
  const rows = [el('div', { class: 'row axis-row' }, el('span', {}), el('span', { class: 'box' }, axis), el('span', {}))];
  for (const { row, values, q, matching } of spread) {
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'bb-box', role: 'img', preserveAspectRatio: 'none',
      'aria-label': `${row.label}: ${q.min} to ${q.max} credits, median ${round(q.med)}` });
    const mid = H / 2;
    s.append(
      svg('line', { x1: x(q.min), x2: x(q.q1), y1: mid, y2: mid }),
      svg('line', { x1: x(q.q3), x2: x(q.max), y1: mid, y2: mid }),
      svg('line', { x1: x(q.min), x2: x(q.min), y1: mid - 5, y2: mid + 5 }),
      svg('line', { x1: x(q.max), x2: x(q.max), y1: mid - 5, y2: mid + 5 }),
      svg('rect', { x: x(q.q1), y: mid - 7, width: Math.max(1.5, x(q.q3) - x(q.q1)), height: 14 }),
    );
    values.forEach((c, i) => s.append(svg('circle', { class: 'dot', cx: x(c), cy: mid + ((i % 5) - 2) * 1.8, r: 1.7 })));
    s.append(svg('line', { class: 'med', x1: x(q.med), x2: x(q.med), y1: mid - 7, y2: mid + 7 }));
    s.append(svg('title', {}, `${row.label}\nmedian ${round(q.med)}c · ${q.min}–${q.max}c · ${values.length} of ${matching} matching ice`));
    rows.push(el('div', { class: 'row' },
      el('span', { class: 'name' }, el('span', { class: `faction ${FACTION_CLASS[row.breaker.faction] || ''}` }), ' ', row.label),
      el('span', { class: 'box' }, s),
      el('span', { class: 'reach' }, `${round(q.med)}c · ${values.length}/${matching}`)));
  }
  host.replaceChildren(el('div', { class: 'bb-boxes' }, ...rows));
}

// ---------------------------------------------------------------- treemap

/** Ice by faction (one block each) and rez cost (a tile per cost inside it), area = number of
 *  ice. onPick(faction, rez) when a tile is chosen; `picked` is the chosen { faction, rez }. */
export function drawTreemap(host, groups, squarify, onPick, picked) {
  const W = Math.max(300, Math.round(host.clientWidth || 720));
  const H = Math.round(Math.min(420, Math.max(240, W * 0.5)));
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, class: 'bb-treemap', role: 'group', 'aria-label': 'Ice by faction and rez cost' });
  const blocks = squarify(groups.map((g) => g.count), { x: 0, y: 0, w: W, h: H });
  groups.forEach((g, gi) => {
    const b = blocks[gi];
    const pad = 2;
    const inner = { x: b.x + pad, y: b.y + 18, w: Math.max(0, b.w - 2 * pad), h: Math.max(0, b.h - 18 - pad) };
    s.append(paint(svg('rect', { class: 'block', x: b.x + 0.5, y: b.y + 0.5, width: Math.max(0, b.w - 1), height: Math.max(0, b.h - 1) }), { fill: factionColor(g.faction) }));
    if (b.w > 60) s.append(svg('text', { class: 'block-label', x: b.x + 6, y: b.y + 13 }, `${FACTION_NAME[g.faction]} · ${g.count}`));
    const tiles = squarify(g.rez.map((r) => r.count), inner);
    g.rez.forEach((r, ri) => {
      const t = tiles[ri];
      const on = picked && picked.faction === g.faction && String(picked.rez) === String(r.rez);
      const tile = svg('g', { class: `tile${on ? ' on' : ''}`, tabindex: 0, role: 'button',
        'aria-label': `${FACTION_NAME[g.faction]}, rez ${r.rez}: ${r.count} ice`, 'aria-pressed': String(!!on) });
      tile.append(paint(svg('rect', { x: t.x + 1, y: t.y + 1, width: Math.max(0, t.w - 2), height: Math.max(0, t.h - 2) }), { fill: factionColor(g.faction) }));
      if (t.w > 34 && t.h > 26) {
        tile.append(svg('text', { class: 'tile-rez', x: t.x + 6, y: t.y + 16 }, `${r.rez}c`));
        tile.append(svg('text', { class: 'tile-n', x: t.x + 6, y: t.y + 29 }, `${r.count} ice`));
      }
      tile.append(svg('title', {}, `${FACTION_NAME[g.faction]}, rez ${r.rez}: ${r.ice.map((x) => x.ice.title).join(', ')}`));
      const pick = () => onPick(g.faction, r.rez);
      tile.addEventListener('click', pick);
      tile.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      s.append(tile);
    });
  });
  host.replaceChildren(groups.length ? s : el('p', { class: 'bb-note' }, 'No ice in view.'));
}

// ---------------------------------------------------------------- strength per faction

/** A line per faction: how many pieces of ice in view have each strength. */
export function drawStrength(host, data) {
  if (!data.strengths.length) { host.replaceChildren(el('p', { class: 'bb-note' }, 'No ice in view.')); return; }
  const W = Math.max(300, Math.round(host.clientWidth || 720));
  const H = 260;
  const m = { l: 34, r: 12, t: 12, b: 34 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const maxN = Math.max(1, ...data.factions.flatMap((f) => f.counts));
  const xs = data.strengths;
  const x = (k) => m.l + (xs.length > 1 ? (iw * k) / (xs.length - 1) : iw / 2);
  const y = (n) => m.t + ih - (ih * n) / maxN;
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': 'Number of ice by strength, per faction' });
  const ystep = maxN > 10 ? 5 : maxN > 5 ? 2 : 1;
  for (let n = 0; n <= maxN; n += ystep) {
    s.append(svg('line', { class: n ? 'chart-grid' : 'chart-axis', x1: m.l, x2: W - m.r, y1: y(n), y2: y(n) }));
    s.append(svg('text', { class: 'chart-tick', x: m.l - 6, y: y(n) + 3, 'text-anchor': 'end' }, String(n)));
  }
  xs.forEach((v, k) => s.append(svg('text', { class: 'chart-tick', x: x(k), y: H - m.b + 14, 'text-anchor': 'middle' }, String(v))));
  s.append(svg('text', { class: 'chart-tick', x: m.l + iw / 2, y: H - 4, 'text-anchor': 'middle' }, 'ice strength'));
  for (const f of data.factions) {
    const d = f.counts.map((n, k) => `${k ? 'L' : 'M'}${round(x(k))},${round(y(n))}`).join(' ');
    s.append(paint(svg('path', { d, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round' }), { stroke: factionColor(f.faction) }));
    f.counts.forEach((n, k) => {
      if (!n) return;
      const dot = paint(svg('circle', { cx: x(k), cy: y(n), r: 3 }), { fill: factionColor(f.faction) });
      dot.append(svg('title', {}, `${FACTION_NAME[f.faction]}: ${n} ice at strength ${xs[k]}`));
      s.append(dot);
    });
  }
  const legend = el('div', { class: 'legend' }, ...data.factions.map((f) => {
    const sw = el('span', { class: 'legend-swatch' });
    sw.style.background = factionColor(f.faction);
    return el('span', { class: 'legend-item' }, sw, FACTION_NAME[f.faction]);
  }));
  host.replaceChildren(legend, s);
}
