// SVG charts for the Market Research page: the monthly line chart (trends, card detail) and the
// popularity-vs-winrate scatter, plus the shared tooltip and axis helpers. Charts get their data
// and colours from the caller; they read no page state.
import { $, el, svg } from '../shared/dom.js';
import { MINUS, fmtInt, fmtN, fmtPct, fmtPp, monthName, shortMonth } from './format.js';

// ---------------------------------------------------------------- tooltip

export function showTip(x, y, lines) {
  const tip = $('tip');
  tip.replaceChildren(...lines.map((l, i) => el('div', { class: i === 0 ? 'mr-tip-title' : '' }, l)));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 14));
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  tip.style.left = `${left + window.scrollX}px`;
  tip.style.top = `${top + window.scrollY}px`;
}

export function hideTip() { $('tip').hidden = true; }

// ---------------------------------------------------------------- charts: shared axes

function chartBox(host, height) {
  const width = Math.max(300, host.clientWidth || 720);
  const m = { l: 44, r: 16, t: 14, b: 30 };
  const s = svg('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' });
  return { s, width, height, m, iw: width - m.l - m.r, ih: height - m.t - m.b };
}

export function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => k >= v);
}

// Ticks for a value axis: a nice step covering [lo, hi], widened to whole steps.
export function niceAxis(lo, hi, ticks = 4) {
  if (hi <= lo) hi = lo + 1;
  const step = niceMax((hi - lo) / ticks);
  return { lo: Math.floor(lo / step + 1e-9) * step, hi: Math.ceil(hi / step - 1e-9) * step, step };
}

// ---------------------------------------------------------------- line chart

// Monthly line chart. Each series plots `value` (the option, or its own), drawn dashed when it
// has `dash`; `interval` shades a band for the first series; points `hollow` flags are drawn open;
// `bans` (from D.banPeriods) shades in red the months the card was banned.
export function lineChart(host, series, markers, {
  height = 260, label, band = null, bans = [], value = (p) => p.popularity, interval = null, hollow = null,
  axis = null, tick = (v) => `${Math.round(v * 100)}%`, zero = false, tip = null,
}) {
  const months = series[0]?.points.map((p) => p.month) || [];
  if (!months.length) { host.replaceChildren(el('p', { class: 'mr-note', text: 'No data in this period.' })); return; }
  const val = (ser, p) => (ser.value || value)(p);
  const all = series.flatMap((ser) => ser.points.map((p) => val(ser, p)))
    .concat(interval ? series[0].points.flatMap(interval) : []).filter((v) => v !== null && v !== undefined);
  if (!all.length) { host.replaceChildren(el('p', { class: 'mr-note', text: 'No data in this period.' })); return; }
  const { s, width, m, iw, ih } = chartBox(host, height);
  s.setAttribute('aria-label', label);
  const ax = axis ? axis(all) : (() => { const hi = niceMax(Math.max(0.01, ...all)); return { lo: 0, hi, step: hi / 4 }; })();
  const x = (i) => m.l + (months.length === 1 ? iw / 2 : (i * iw) / (months.length - 1));
  const y = (v) => m.t + ih - ((v - ax.lo) / (ax.hi - ax.lo)) * ih;
  const n = Math.round((ax.hi - ax.lo) / ax.step);
  for (let k = 0; k <= n; k++) {
    const v = ax.lo + k * ax.step;
    const isAxis = zero ? Math.abs(v) < ax.step / 1e6 : k === 0;
    s.append(svg('line', { class: isAxis ? 'chart-axis' : 'chart-grid', x1: m.l, x2: width - m.r, y1: y(v), y2: y(v) }));
    s.append(svg('text', { class: 'chart-tick', x: m.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, tick(v)));
  }
  // Shade the months from index i0 to i1, each month spanning half a step either side of its point.
  const shade = (i0, i1, cls) => {
    if (i0 < 0 || i1 < i0) return;
    const half = months.length > 1 ? iw / (months.length - 1) / 2 : iw / 2;
    const x0 = Math.max(m.l, x(i0) - half);
    const x1 = Math.min(m.l + iw, x(i1) + half);
    s.append(svg('rect', { class: cls, x: x0, y: m.t, width: Math.max(1, x1 - x0), height: ih }));
  };
  const banned = months.map((mo) => bans.find((b) => mo >= b.from && mo <= b.to));
  for (const b of bans) shade(months.findIndex((mo) => mo >= b.from), months.findLastIndex((mo) => mo <= b.to), 'mr-ban');
  // Shade the months selected in the filters; the rest of the timeline stays for context.
  if (band) shade(months.indexOf(band.from), months.indexOf(band.to), 'mr-band');
  const step = Math.ceil(months.length / Math.max(2, Math.floor(iw / 70)));
  months.forEach((mo, i) => {
    if (i % step === 0 || i === months.length - 1) {
      s.append(svg('text', { class: 'chart-tick', x: x(i), y: m.t + ih + 16, 'text-anchor': 'middle' }, shortMonth(mo)));
    }
  });
  // Every ban list gets its line; a label that would overlap one already drawn is left out.
  const taken = [];
  for (const mk of markers) {
    const i = months.indexOf(mk.month);
    if (i < 0) continue;
    s.append(svg('line', { class: 'chart-marker', x1: x(i), x2: x(i), y1: m.t, y2: m.t + ih }));
    const right = x(i) > m.l + iw * 0.6;
    const w = mk.name.length * 5.6;
    const x0 = right ? x(i) - 4 - w : x(i) + 4;
    if (taken.some(([a0, a1]) => x0 < a1 + 6 && x0 + w > a0 - 6)) continue;
    taken.push([x0, x0 + w]);
    s.append(svg('text', { class: 'chart-tick', x: x(i) + (right ? -4 : 4), y: m.t + 9, 'text-anchor': right ? 'end' : 'start' }, mk.name));
  }
  if (interval) {
    // One closed area per run of months that have an interval.
    const ser = series[0];
    let run = [];
    const flush = () => {
      if (run.length) {
        const top = run.map((i) => `${x(i).toFixed(1)} ${y(interval(ser.points[i])[1]).toFixed(1)}`);
        const bottom = run.slice().reverse().map((i) => `${x(i).toFixed(1)} ${y(interval(ser.points[i])[0]).toFixed(1)}`);
        const d = run.length === 1
          ? `M${x(run[0]) - 2} ${y(interval(ser.points[run[0]])[1])} h4 V${y(interval(ser.points[run[0]])[0])} h-4 Z`
          : `M${top.join(' L')} L${bottom.join(' L')} Z`;
        s.append(svg('path', { d, fill: ser.color, 'fill-opacity': 0.15, stroke: 'none' }));
      }
      run = [];
    };
    ser.points.forEach((p, i) => { if (interval(p)[0] === null || interval(p)[0] === undefined) flush(); else run.push(i); });
    flush();
  }
  for (const ser of series) {
    let d = '';
    let gap = true;
    ser.points.forEach((p, i) => {
      const v = val(ser, p);
      if (v === null || v === undefined) { gap = true; return; }
      d += `${gap ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      gap = false;
    });
    s.append(svg('path', { d, fill: 'none', stroke: ser.color, 'stroke-width': ser.dash ? 1.5 : 2, 'stroke-dasharray': ser.dash ? '5 4' : null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (ser.dash) continue;
    ser.points.forEach((p, i) => {
      const v = val(ser, p);
      if (v === null || v === undefined) return;
      const open = hollow && hollow(p);
      // Open points always show (they flag small samples); filled ones only on short timelines.
      if (open || ser.points.length <= 24) {
        s.append(svg('circle', { cx: x(i), cy: y(v), r: 3, fill: open ? 'var(--panel)' : ser.color, stroke: ser.color, 'stroke-width': open ? 1.5 : 0 }));
      }
    });
  }
  const cross = svg('line', { class: 'chart-axis', x1: 0, x2: 0, y1: m.t, y2: m.t + ih, visibility: 'hidden' });
  s.append(cross);
  const hit = svg('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
  hit.addEventListener('pointermove', (ev) => {
    const r = s.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * width;
    const i = Math.max(0, Math.min(months.length - 1, Math.round(((px - m.l) / iw) * (months.length - 1))));
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    showTip(ev.clientX, ev.clientY, [monthName(months[i]), ...(tip ? tip(i) : series.map((ser) => {
      const p = ser.points[i];
      return `${ser.name}: ${fmtPct(p.popularity)} (${fmtN(p.decks)} of ${fmtInt(p.total)})`;
    })), ...(banned[i] ? [`Banned (${banned[i].names.join(', ')})`] : [])]);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
  s.append(hit);
  host.replaceChildren(s);
}

// ---------------------------------------------------------------- scatter

// Popularity-vs-winrate scatter of `pts` ({ card_id, x, y, games, sufficient }), coloured `color`.
// `name(cardId)` gives a point's label; every point is labelled when there are at most `labelAll`.
export function scatterChart(host, pts, { color, name: cardName, labelAll }) {
  const { s, width, m, iw, ih } = chartBox(host, 320);
  s.setAttribute('aria-label', 'Scatter of inclusion against winrate difference; the table below lists the same points');
  const maxX = niceMax(Math.max(...pts.map((p) => p.x)));
  const ext = niceMax(Math.max(5, ...pts.map((p) => Math.abs(p.y))));
  const maxGames = Math.max(...pts.map((p) => p.games));
  const x = (v) => m.l + (v / maxX) * iw;
  const y = (v) => m.t + ih / 2 - (v / ext) * (ih / 2);
  const r = (g) => 3 + 9 * Math.sqrt(g / maxGames);
  for (let k = -2; k <= 2; k++) {
    const v = (ext * k) / 2;
    s.append(svg('line', { class: k === 0 ? 'chart-axis' : 'chart-grid', x1: m.l, x2: width - m.r, y1: y(v), y2: y(v) }));
    s.append(svg('text', { class: 'chart-tick', x: m.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v)} pp`));
  }
  for (let k = 0; k <= 4; k++) {
    const v = (maxX * k) / 4;
    s.append(svg('text', { class: 'chart-tick', x: x(v), y: m.t + ih + 16, 'text-anchor': 'middle' }, `${Math.round(v)}%`));
  }
  s.append(svg('text', { class: 'chart-tick', x: width - m.r, y: m.t + ih + 28, 'text-anchor': 'end' }, 'inclusion →'));
  const ordered = [...pts].sort((a, b) => b.games - a.games);
  for (const p of ordered) {
    s.append(svg('circle', {
      cx: x(p.x), cy: y(p.y), r: r(p.games),
      fill: p.sufficient ? color : 'none', 'fill-opacity': p.sufficient ? 0.75 : null,
      stroke: color, 'stroke-width': p.sufficient ? 1 : 1.5,
    }));
  }
  // Label every point of a short list (top per axis, a name filter); otherwise the 8 most included.
  const labelled = pts.length <= labelAll ? pts : pts.filter((p) => p.sufficient).sort((a, b) => b.x - a.x).slice(0, 8);
  // Greedy placement, biggest points first: try beside the point, then a line above or below; a
  // label that still overlaps one already placed is left out (hovering still names the card).
  const placed = [];
  const overlaps = (bx) => placed.some((o) => bx.x1 < o.x2 && bx.x2 > o.x1 && bx.y1 < o.y2 && bx.y2 > o.y1);
  for (const p of [...labelled].sort((a, b) => b.games - a.games)) {
    const name = cardName(p.card_id);
    const w = name.length * 6.2;
    const right = x(p.x) > m.l + iw * 0.75;
    const dx = r(p.games) + 3;
    const lx = right ? x(p.x) - dx : x(p.x) + dx;
    const spot = [0, -12, 12, -24, 24].map((dy) => ({ ly: y(p.y) + 3 + dy, box: { x1: right ? lx - w : lx, x2: right ? lx : lx + w, y1: y(p.y) - 6 + dy, y2: y(p.y) + 5 + dy } }))
      .find((c) => !overlaps(c.box));
    if (!spot) continue;
    placed.push(spot.box);
    s.append(svg('text', { class: 'chart-tick mr-label', x: lx, y: spot.ly, 'text-anchor': right ? 'end' : 'start' }, name));
  }
  const hit = svg('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
  hit.addEventListener('pointermove', (ev) => {
    const b = s.getBoundingClientRect();
    const px = ((ev.clientX - b.left) / b.width) * width;
    const py = ((ev.clientY - b.top) / b.height) * s.viewBox.baseVal.height;
    let best = null;
    let bestD = 18 * 18;
    for (const p of pts) {
      const d = (x(p.x) - px) ** 2 + (y(p.y) - py) ** 2;
      if (d < bestD) { best = p; bestD = d; }
    }
    if (!best) { hideTip(); return; }
    showTip(ev.clientX, ev.clientY, [cardName(best.card_id), `Inclusion ${best.x.toFixed(1)}%`,
      `Winrate ${fmtPp(best.y)} vs baseline`, `${fmtN(best.games)} games${best.sufficient ? '' : ' (below minimum sample)'}`]);
  });
  hit.addEventListener('pointerleave', hideTip);
  hit.addEventListener('click', () => { /* the table below offers keyboard access to each card */ });
  s.append(hit);
  host.replaceChildren(s);
}
