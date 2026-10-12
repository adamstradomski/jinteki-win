// Sortable data tables and the shared cells they use.
import { sortRows } from './data.js';
import { el } from '../shared/dom.js';
import { fmtInt, fmtPct, fmtPp } from './format.js';

const TABLE_ROWS = 25;

export function changeCell(v) {
  if (v === null || v === undefined) return el('td', { class: 'num', text: '–' });
  const arrow = v > 0 ? '▲ ' : v < 0 ? '▼ ' : '';
  return el('td', { class: `num ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}`, text: arrow + fmtPp(v) });
}

export function diffCell(v, insufficient) {
  const cls = insufficient ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  return el('td', { class: `num ${cls}`, text: fmtPp(v) });
}

export function meterCell(v) {
  const pct = v === null ? 0 : Math.max(0, Math.min(100, v * 100));
  return el('td', {}, el('div', { class: 'meter' },
    el('div', { class: 'meter-track' }, el('div', { class: 'meter-fill', style: `width:${pct.toFixed(1)}%` })),
    el('span', { class: 'num', text: fmtPct(v) })));
}

// Tables whose column guide the viewer opened, so it stays open when the table redraws.
const openGuides = new Set();

/** "What do the columns mean?": the header tooltips as a list, for touch screens and screen readers. */
function columnGuide(host, columns) {
  const described = columns.filter((c) => c.help);
  if (!described.length) return null;
  const d = el('details', { class: 'mr-alt mr-guide' }, el('summary', { text: 'What do the columns mean?' }),
    el('dl', {}, ...described.flatMap((c) => [el('dt', { text: c.label }), el('dd', { text: c.help })])));
  d.open = openGuides.has(host.id);
  d.addEventListener('toggle', () => { if (d.open) openGuides.add(host.id); else openGuides.delete(host.id); });
  return d;
}

/**
 * A sortable table with real header buttons and an optional "show all" button.
 * `side()` returns the side whose colour the table uses; it is read on every redraw.
 */
export function dataTable(host, columns, rows, { side, initial, sortKey = null, sortDir = 'descending', rowClass = () => '', limit = TABLE_ROWS, empty = 'No cards in this filter.', noun = 'cards' }) {
  let key = sortKey;
  let dir = sortDir;
  let all = false;
  const draw = () => {
    const col = columns.find((c) => c.key === key);
    const sorted = key ? sortRows(rows, key, dir, col?.value || ((r) => r[key])) : initial ? initial(rows) : rows;
    const shown = all ? sorted : sorted.slice(0, limit);
    const head = el('tr', {}, ...columns.map((c) => {
      const th = el('th', { class: c.num ? 'num' : '', scope: 'col', 'aria-sort': c.key === key ? dir : null, title: c.help || null });
      if (c.sortable === false) th.textContent = c.label;
      else th.append(el('button', { type: 'button', class: 'mr-sort', onclick: () => {
        if (key === c.key) dir = dir === 'descending' ? 'ascending' : 'descending';
        else { key = c.key; dir = c.num ? 'descending' : 'ascending'; }
        draw();
      } }, c.label));
      return th;
    }));
    const body = shown.map((r) => el('tr', { class: rowClass(r) || null }, ...columns.map((c) => c.cell(r))));
    const table = el('table', { class: 'data-table', style: `--side: var(--${side()})` }, el('thead', {}, head), el('tbody', {}, ...body));
    const parts = [rows.length ? el('div', { class: 'mr-scroll' }, table) : el('p', { class: 'mr-note', text: empty })];
    if (sorted.length > limit) {
      parts.push(el('button', { type: 'button', class: 'btn secondary mr-more', onclick: () => { all = !all; draw(); } },
        all ? `Show top ${limit}` : `Show all ${fmtInt(sorted.length)} ${noun}`));
    }
    const guide = rows.length ? columnGuide(host, columns) : null;
    if (guide) parts.push(guide);
    host.replaceChildren(...parts);
  };
  draw();
}
