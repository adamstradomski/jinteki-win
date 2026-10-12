// An accessible card-name combobox (listbox of suggestions, arrow keys, Enter, Escape).
import { faction } from './data.js';
import { el } from '../shared/dom.js';

/** A card-name combobox: `find(query)` returns catalog cards, `onPick(card)` handles a choice. */
export function cardCombo(input, list, { find, onPick, clearOnPick = false }) {
  let active = -1;
  let hits = [];
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const pick = (c) => { input.value = clearOnPick ? '' : c.title; close(); onPick(c); };
  const draw = () => {
    hits = find(input.value);
    list.replaceChildren(...hits.map((c, i) => {
      const f = faction(c.faction);
      const li = el('li', { id: `${list.id}-${i}`, role: 'option', class: 'mr-option', 'aria-selected': i === active ? 'true' : 'false' },
        el('span', { text: c.title }), ' ', el('span', { class: `faction ${f.className}`, text: `${f.name} · ${c.side === 'corp' ? 'Corp' : 'Runner'}` }));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(c); });
      return li;
    }));
    list.hidden = !hits.length;
    input.setAttribute('aria-expanded', String(!!hits.length));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
  };
  input.addEventListener('input', () => { active = -1; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(hits.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && hits.length) { pick(hits[Math.max(0, active)]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
}
