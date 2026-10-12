// Market Research page: fetches the manifest, builds slice paths from it and renders panels.
// All arithmetic is in data.js; this module holds the page state, filters and loading, and wires
// the panels to the table (table.js), chart (charts.js) and combobox (combo.js) components. Every
// value is written with textContent (never innerHTML), even though snapshots carry no free text.
import * as D from './data.js';
import { $, el, debounce } from '../shared/dom.js';
import { MINUS, fmtInt, fmtN, fmtPct, fmtPp, fmtRatio, fmtNum, monthName } from './format.js';
import { dataTable as table, changeCell, diffCell, meterCell } from './table.js';
import { lineChart, scatterChart, niceAxis } from './charts.js';
import { cardCombo } from './combo.js';

const JW = window.JW;
const MAX_TREND_CARDS = 6;
const LAST_SEEN_KEY = 'mr-last-generated';

const base = D.dataBase(location.search);
const cache = new Map();

let manifest = null;
let catalog = null;
let cards = new Map();
let state = null;
let view = null; // current summary (from summary.json or recomputed from trends)
let identities = null;
let events = null; // the included tournaments of the current ban list and tier
let trendCards = []; // [{ id, slot }] – colour slots stay with the card
let detailCard = null;
let scrollToDetail = false;
let sideToggle = null;
// Per-panel "Hide small samples" switches (cards under the minimum games or decks); on by default.
const hideSmall = { winrate: true, scatter: true, splash: true };
const BASE_TITLE = document.title;
const scatterView = { query: '', top: false };
const SCATTER_TOP = 10;

// ---------------------------------------------------------------- cards and tables

/** A sortable table (table.js) coloured for the selected side. */
const dataTable = (host, columns, rows, opts) => table(host, columns, rows, { side: () => state.side, ...opts });

function cardName(id) {
  const c = cards.get(id);
  return c ? c.title : id;
}

function cardCell(id) {
  const c = cards.get(id);
  const f = D.faction(c?.faction);
  const btn = el('button', { type: 'button', class: 'mr-link', onclick: () => openDetail(id) }, cardName(id));
  return el('td', { class: 'card' }, btn, ' ', el('span', { class: `faction ${f.className}`, text: f.name }));
}

// ---------------------------------------------------------------- loading state

// Panels whose content comes from the card slices; Trends and the card detail load on their own.
const DATA_PANELS = ['stats', 'events', 'played', 'identities', 'scatter', 'winrate'];

/** Blurs the given panels under a spinning wheel (on) or reveals them (off). */
function setBusy(ids, on) {
  for (const id of ids) {
    const n = $(id);
    if (!n) continue;
    if (on && !n.querySelector(':scope > .mr-spinner')) n.append(el('div', { class: 'mr-spinner', 'aria-hidden': 'true' }));
    n.classList.toggle('mr-busy', on);
    n.setAttribute('aria-busy', String(on));
  }
}

/** Empty placeholder tables and charts, shown blurred until the first data arrives. */
function showSkeletons() {
  const skelTable = (cols, rows = 8) => el('div', { class: 'mr-scroll' }, el('table', { class: 'data-table' },
    el('thead', {}, el('tr', {}, ...Array.from({ length: cols }, () => el('th', {}, el('span', { class: 'mr-skel' }))))),
    el('tbody', {}, ...Array.from({ length: rows }, () => el('tr', {}, ...Array.from({ length: cols }, () => el('td', {}, el('span', { class: 'mr-skel' }))))))));
  $('stats').replaceChildren(...Array.from({ length: 5 }, () => el('div', { class: 'stat' },
    el('span', { class: 'num', text: '––' }), el('span', { class: 'label' }, el('span', { class: 'mr-skel' })))));
  $('played-body').replaceChildren(skelTable(7));
  $('identities-body').replaceChildren(skelTable(7));
  $('winrate-body').replaceChildren(skelTable(5));
  $('trend-chart').replaceChildren(el('div', { class: 'mr-skel-chart' }));
  $('scatter-chart').replaceChildren(el('div', { class: 'mr-skel-chart' }));
}

// ---------------------------------------------------------------- data

async function getJson(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url, { credentials: 'omit' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }));
  }
  try {
    return await cache.get(url);
  } catch (e) {
    cache.delete(url);
    throw e;
  }
}

// Card slices come from the top-cut scope when "Top-cut decks only" is on; identities have none.
const scoped = (kind, s) => (s.cut && (kind === 'summary' || kind === 'trends') ? `${kind}_cut` : kind);
const slice = (kind, s = state) => getJson(D.sliceUrl(base, manifest, scoped(kind, s), { side: s.side, restriction: s.restriction, tier: s.tier }));

async function boot() {
  JW.mountThemeSwitcher($('theme-switcher'));
  JW.mountModeToggle($('mode-toggle'));
  JW.enablePanelCollapse();
  showSkeletons();
  setBusy([...DATA_PANELS, 'trends'], true);
  try {
    manifest = await getJson(D.joinUrl(base, 'manifest.json'));
    catalog = await getJson(D.joinUrl(base, manifest.base_path + manifest.paths.catalog));
  } catch {
    showUnavailable();
    return;
  }
  try { localStorage.setItem(LAST_SEEN_KEY, manifest.data_as_of || manifest.generated_at); } catch { /* ignore */ }
  cards = D.catalogIndex(catalog);
  state = D.parseHash(location.hash, manifest, isCard);
  detailCard = state.card;
  scrollToDetail = !!detailCard; // a link to a card opens on its detail
  // Drop what the link got wrong (an unknown card or view, a bad filter) from the address.
  if (location.hash && location.hash !== D.formatHash(state)) history.replaceState(null, '', D.formatHash(state));
  setupFilters();
  setupSearch();
  setupSampleToggle('winrate-small', 'winrate', renderWinrate);
  setupSampleToggle('scatter-small', 'scatter', renderScatter);
  $('scatter-filter').addEventListener('input', debounce(() => { scatterView.query = $('scatter-filter').value; if (view) renderScatter(); }, 150));
  $('scatter-top').addEventListener('click', () => {
    scatterView.top = !scatterView.top;
    $('scatter-top').setAttribute('aria-pressed', String(scatterView.top));
    if (view) renderScatter();
  });
  // Back and forward between opened cards, or an edited address: reload only when the filters changed.
  window.addEventListener('hashchange', followUrl);
  window.addEventListener('popstate', followUrl);
  document.addEventListener('jw:themechange', () => { drawTrends(); drawScatter(); drawDetailChart(); });
  window.addEventListener('resize', debounce(() => { drawTrends(); drawScatter(); drawDetailChart(); }, 150));
  $('detail-close').addEventListener('click', () => {
    hideDetail();
    state.card = null;
    pushUrl();
  });
  loadQuality(); // the footer needs only the manifest, so it loads alongside the first slices
  await refresh();
}

const isCard = (id) => cards.has(id);

function followUrl() {
  const next = D.parseHash(location.hash, manifest, isCard);
  if (D.formatHash(next) === D.formatHash(state)) return;
  const reload = D.dataHash(next) !== D.dataHash(state);
  const showChanged = next.show !== state.show;
  state = next;
  syncFilters();
  if (reload) {
    detailCard = state.card;
    if (!detailCard) hideDetail();
    refresh();
    return;
  }
  if (showChanged && view) renderPlayed();
  if (state.card && state.card !== detailCard) openDetail(state.card, true, false);
  else if (!state.card && detailCard) hideDetail();
}

/** A new history entry for the current state (opening or closing a card), so Back returns to the last one. */
function pushUrl() {
  const h = D.formatHash(state);
  if (location.hash !== h) history.pushState(null, '', h);
  setTitle();
}

function setTitle() {
  document.title = detailCard ? `${cardName(detailCard)} · ${BASE_TITLE}` : BASE_TITLE;
}

function hideDetail() {
  detailCard = null;
  $('detail').hidden = true;
  setTitle();
}

/** Replaces the page with a notice when the data can't be loaded, instead of leaving it on placeholders. */
function showUnavailable() {
  let last = null;
  try { last = localStorage.getItem(LAST_SEEN_KEY); } catch { /* storage may be blocked */ }
  $('app').hidden = true;
  $('status').hidden = false;
  $('status').textContent = `Market Research data is unavailable right now.${last ? ` Last updated ${last}.` : ''} Try again later.`;
}

// ---------------------------------------------------------------- filters

function option(value, label, selected) {
  const o = el('option', { value }, label);
  o.selected = selected;
  return o;
}

function setupFilters() {
  sideToggle = JW.mountSideToggle($('side-toggle'), state.side, (side) => {
    state = D.withSide(state, side, (id) => cards.get(id)?.side);
    if (!state.card && detailCard) hideDetail();
    commit();
  });
  $('f-restriction').replaceChildren(...D.banlistOptions(manifest).map((r) => option(r.id, r.name, r.id === state.restriction)));
  $('f-tier').replaceChildren(...manifest.tier_groups.map((t) => option(t.id, t.name, t.id === state.tier)));
  for (const id of ['f-from', 'f-to']) {
    $(id).replaceChildren(...manifest.months.map((m) => option(m, monthName(m), false)));
  }
  syncFilters();
  $('f-restriction').addEventListener('change', (e) => { state.restriction = e.target.value; commit(); });
  $('f-tier').addEventListener('change', (e) => { state.tier = e.target.value; commit(); });
  $('f-from').addEventListener('change', (e) => { setPeriod(e.target.value, state.to); });
  $('f-to').addEventListener('change', (e) => { setPeriod(state.from, e.target.value); });
  // Filters only: the table view and the open card stay.
  $('f-reset').addEventListener('click', () => { state = { ...D.parseHash('', manifest), show: state.show, card: state.card }; syncFilters(); commit(); });
  $('f-cut-field').hidden = !manifest.paths.summary_cut; // snapshots before the top-cut scope
  $('f-cut').addEventListener('click', () => { state.cut = !state.cut; syncFilters(); commit(); });
}

function setPeriod(from, to) {
  if (from > to) [from, to] = [to, from];
  state.from = from;
  state.to = to;
  state.custom = true;
  syncFilters();
  commit();
}

function syncFilters() {
  $('f-restriction').value = state.restriction;
  $('f-tier').value = state.tier;
  if (state.from) $('f-from').value = state.from;
  if (state.to) $('f-to').value = state.to;
  sideToggle?.set(state.side);
  $('f-cut').setAttribute('aria-pressed', String(!!state.cut));
  $('card-search').placeholder = `Type a ${state.side === 'corp' ? 'Corp' : 'Runner'} card name`;
  document.documentElement.style.setProperty('--mr-side', `var(--${state.side})`);
}

function commit() {
  replaceUrl();
  refresh();
}

/** Writes the state to the address without a new history entry (filters and table views). */
function replaceUrl() {
  const h = D.formatHash(state);
  if (location.hash !== h) history.replaceState(null, '', h);
  setTitle();
}

// ---------------------------------------------------------------- main refresh

let refreshToken = 0;

async function refresh() {
  const token = ++refreshToken;
  $('status').hidden = true;
  setBusy([...DATA_PANELS, 'trends'], true);
  document.documentElement.style.setProperty('--mr-side', `var(--${state.side})`);
  try {
    // Start every slice this filter needs at once rather than one round trip after another.
    // Trends are always started: renderTrends asks for the same slice (the cache shares the
    // request), and a custom period needs them here. They are only awaited for a custom period,
    // so a trends failure is left to renderTrends to report, as before.
    const trendsReq = slice('trends');
    trendsReq.catch(() => {});
    const [summary, ids, evs] = await Promise.all([
      slice('summary'),
      slice('identities'),
      manifest.paths.tournaments ? slice('tournaments') : null,
    ]);
    let v = summary;
    if (state.custom && summary.period && (state.from !== summary.period.from || state.to !== summary.period.to)) {
      const trends = await trendsReq;
      v = D.summarize(trends, { from: state.from, to: state.to }, manifest.thresholds, 'all', cards);
    }
    if (token !== refreshToken) return;
    view = v;
    identities = ids;
    events = evs;
    if (!state.custom && view.period) { state.from = view.period.from; state.to = view.period.to; syncFilters(); }
    renderAll();
    setBusy(DATA_PANELS, false);
  } catch (e) {
    if (token !== refreshToken) return;
    setBusy([...DATA_PANELS, 'trends'], false);
    $('status').hidden = false;
    $('status').textContent = 'This slice could not be loaded. Try another filter or reload the page.';
  }
}

function renderAll() {
  renderStats();
  renderEvents();
  renderPlayed();
  renderIdentities();
  renderWinrate();
  renderScatter();
  initTrendCards();
  renderTrends();
  // Taken before opening: a card of the other side switches sides and asks for the scroll again.
  const scroll = scrollToDetail;
  scrollToDetail = false;
  if (detailCard) openDetail(detailCard, scroll, false);
}

function renderStats() {
  const b = view.baseline;
  const side = state.side === 'corp' ? 'Corp' : 'Runner';
  const who = state.cut ? `top-cut ${side}` : side;
  const stat = (num, label, cls = '') => el('div', { class: `stat ${cls}` }, el('span', { class: 'num', text: num }), el('span', { class: 'label', text: label }));
  $('stats').replaceChildren(
    stat(manifest.data_as_of || '–', 'Data as of'),
    stat(fmtInt(b.tournaments), state.cut ? 'Tournaments with a cut' : 'Tournaments'),
    stat(fmtInt(b.decks), `${who} decks`, state.side),
    stat(b.games_all == null ? fmtInt(b.games) : `${fmtInt(b.games)} / ${fmtInt(b.games_all)}`, `${who} games (with decklists / total)`, state.side),
    stat(fmtPct(b.winrate_all ?? b.winrate), `${who} winrate (all games)`),
  );
  const p = view.period;
  $('period-note').textContent = p
    ? `Showing ${monthName(p.from)} → ${monthName(p.to)}${view.previous_period ? `, compared with ${monthName(view.previous_period.from)} → ${monthName(view.previous_period.to)}` : ''}.${state.cut ? ' Card stats count only decks that made the top cut, in events that had one, and the games they played. Identities always count every entry.' : ''}`
    : 'No Standard tournaments match this filter.';
}

function setupSampleToggle(id, key, render) {
  const btn = $(id);
  btn.addEventListener('click', () => {
    hideSmall[key] = !hideSmall[key];
    btn.setAttribute('aria-pressed', String(hideSmall[key]));
    if (view) render();
  });
}

/** Drops cards below the minimum games when the panel's switch is on. */
const sampled = (key, rows, ok) => (hideSmall[key] ? rows.filter(ok) : rows);

// ---------------------------------------------------------------- column help (header tooltips)

function help() {
  const side = state.side === 'corp' ? 'Corp' : 'Runner';
  const decks = state.cut ? `top-cut ${side} decks (decks that made the cut, in events with a cut)` : `${side} decks`;
  const base = `the winrate of all ${decks} with a known decklist in this filter (${fmtPct(view.baseline.winrate)})`;
  return {
    rank: 'Position by the number of decks playing the card in this period.',
    card: 'Card name and faction. Select it for details and its monthly trend.',
    type: 'Card type.',
    inclusion: `Share of ${decks} with a known decklist in this filter that play at least one copy: decks with the card ÷ all decks.`,
    inFaction: `Share of ${decks} whose identity is of the card's faction that play it: decks with the card in faction ÷ decks of that faction. Neutral cards and identities have none.`,
    outFaction: `Share of ${decks} whose identity is of another faction that play the card, paying influence for it: decks with the card out of faction ÷ decks of the other factions. Neutral cards, identities and agendas (which can't leave their faction) have none.`,
    splash: `Of the ${decks} that play the card, the share that play it out of faction, paying influence. High means the card is played mostly as a splash.`,
    allDecks: `Inclusion over all ${decks}, for comparison.`,
    modeChange: 'This column in this period minus the same figure in the previous period of the same length, in percentage points.',
    modeDecks: 'The decks the percentage counts, out of the decks it is taken over.',
    avgCopies: 'Average number of copies, over the decks that play the card.',
    change: 'Inclusion in this period minus inclusion in the previous period of the same length, in percentage points.',
    decks: `Number of ${decks} with a known decklist that play the card.`,
    winrateDiff: `Winrate of the games played by decks with the card, minus ${base}. Draws count as half a win; intentional draws are excluded.`,
    interval: 'Wilson 95% confidence interval of the card\'s winrate, minus the baseline. When it spans 0, the difference may be chance.',
    winrate: 'Games won ÷ games played by decks with the card. Draws count as half a win.',
    games: 'Games played by decks with the card, where the deck is known.',
    identRank: 'Position by the number of entries.',
    identity: 'Identity name and faction.',
    share: `Share of ${side} entries in this filter (players with a known identity) on this identity.`,
    identWinrate: `Game winrate of players on this identity, minus the winrate of all ${side} players with a known identity. Draws count as half a win.`,
    identGames: 'Games played on this identity.',
    conversion: `Share of entries on this identity that made the top cut, in events with a cut where most identities are known. In brackets: that share ÷ the share for all ${side} entries.`,
    cutEntries: 'Entries on this identity in events with a cut where most identities are known: the sample the conversion is based on.',
  };
}

// ---------------------------------------------------------------- included tournaments

const COBRA_URL = 'https://tournaments.nullsignal.games/tournaments/';
const ABR_URL = 'https://alwaysberunning.net/tournaments/';

function renderEvents() {
  const box = $('events');
  box.hidden = !events;
  if (!events) return;
  const list = D.eventsInView(events.tournaments, trendRange(), state.cut);
  const tot = D.eventTotals(list);
  const banName = new Map(manifest.restrictions.map((r) => [r.id, r.name]));
  $('events-summary').textContent = `Included tournaments (${fmtInt(tot.events)})`;
  $('events-note').textContent = list.length
    ? `${fmtInt(tot.events)} tournaments, ${fmtInt(tot.players)} players: decklists are known for ${fmtInt(tot.decklists)} of ${fmtInt(tot.decks)} decks (${fmtPct(tot.share)}), counting Corp and Runner for each player.${state.cut ? ' Only events with a top cut, as the top-cut switch is on.' : ''}`
    : '';
  const link = (href, id) => el('td', {}, id ? el('a', { href: href + id, rel: 'noopener', target: '_blank' }, `#${id}`) : '–');
  const share = (t) => (t.players ? t.decklists / (2 * t.players) : null);
  dataTable($('events-body'), [
    { key: 'name', label: 'Tournament', help: 'The event\'s public name on Cobra or AlwaysBeRunning.', value: (t) => t.name || '', cell: (t) => el('td', { text: t.name || '–' }) },
    { key: 'date', label: 'Date', help: 'The day the event started.', cell: (t) => el('td', { class: 'num', text: t.date }) },
    { key: 'restriction', label: 'Ban list', help: 'The ban list the event\'s decks were checked against: the organiser\'s, unless the decks clearly fit another one.', value: (t) => banName.get(t.restriction) || t.restriction, cell: (t) => el('td', { text: banName.get(t.restriction) || t.restriction }) },
    { key: 'online', label: 'Location', help: 'Online or in person, with the country when AlwaysBeRunning lists it.', value: (t) => (t.online ? 'Online' : `Offline ${t.country || ''}`), cell: (t) => el('td', { text: t.online ? 'Online' : t.country ? `Offline · ${t.country}` : 'Offline' }) },
    { key: 'players', label: 'Players', num: true, help: 'Players who took part.', cell: (t) => el('td', { class: 'num', text: fmtInt(t.players) }) },
    { key: 'format', label: 'Format', help: 'Swiss rounds (single-sided or double-sided) and the size of the top cut. Events known only from AlwaysBeRunning have no swiss format.', value: (t) => D.eventFormat(t), cell: (t) => el('td', { text: D.eventFormat(t) }) },
    { key: 'decklists', label: 'Decklists', num: true, help: 'Legal decks with a known decklist, out of two per player (Corp and Runner), and that share. Only these decks count in the card statistics.', value: (t) => share(t), cell: (t) => el('td', { class: 'num', text: `${fmtInt(t.decklists)} / ${fmtInt(2 * t.players)} (${fmtPct(share(t), 0)})` }) },
    { key: 'cobra_id', label: 'Cobra', help: 'The event on NSG Cobra.', sortable: false, cell: (t) => link(COBRA_URL, t.cobra_id) },
    { key: 'abr_id', label: 'ABR', help: 'The event on AlwaysBeRunning.net.', sortable: false, cell: (t) => link(ABR_URL, t.abr_id) },
  ], list, { sortKey: 'date', sortDir: 'descending', noun: 'tournaments', empty: 'No tournaments match this filter.' });
}

// ---------------------------------------------------------------- card tables

// The views of the most played cards table: the value they rank by, the column and the note above it.
const PLAYED_VIEWS = {
  all: { label: 'All decks', column: 'Inclusion', help: (h) => h.inclusion },
  in: { label: 'In faction', column: 'In-faction inclusion', help: (h) => h.inFaction,
    note: 'Share of the decks of the card\'s faction that play it. Neutral cards are left out.' },
  out: { label: 'Out of faction', column: 'Out-of-faction inclusion', help: (h) => h.outFaction,
    note: 'Share of the other factions\' decks that play the card, paying influence for it. Neutral cards and agendas are left out.' },
  splash: { label: 'Splash share', column: 'Splash share', help: (h) => h.splash,
    note: 'Of the decks that play the card, the share that splash it from another faction. High means the card is played mostly on influence.' },
};

function renderPlayed() {
  const h = help();
  // Older snapshots have no decks per faction: only the all-decks view.
  const hasFactions = !!view.baseline.faction_decks;
  const mode = hasFactions && PLAYED_VIEWS[state.show] ? state.show : 'all';
  const v = PLAYED_VIEWS[mode];
  const minSplash = manifest.thresholds.min_splash_decks ?? 20;
  const rows = D.playedRows(view.cards, mode, { hideSmall: hideSmall.splash });
  const setMode = (id) => { state.show = id; replaceUrl(); renderPlayed(); };
  const tools = [];
  if (hasFactions) {
    tools.push(el('span', { class: 'mr-toolbar-label', text: 'Show' }),
      ...Object.entries(PLAYED_VIEWS).map(([id, x]) => el('button', { type: 'button', class: 'btn chip', 'aria-pressed': String(mode === id), onclick: () => setMode(id) }, x.label)));
    if (mode === 'splash') {
      tools.push(el('button', { type: 'button', class: 'btn chip mr-toolbar-end', 'aria-pressed': String(hideSmall.splash),
        onclick: () => { hideSmall.splash = !hideSmall.splash; renderPlayed(); } }, 'Hide small samples'));
    }
  }
  const notes = [];
  if (v.note) notes.push(`${v.note}${mode === 'splash' ? ` ${hideSmall.splash ? `Cards in fewer than ${minSplash} decks are hidden.` : `Rows under ${minSplash} decks are greyed.`}` : ''}`);
  const host = $('played-body');
  const tableHost = el('div', { id: 'played-table' });
  host.replaceChildren(...(tools.length ? [el('div', { class: 'mr-toolbar', role: 'group', 'aria-label': 'Count inclusion over' }, ...tools)] : []),
    ...notes.map((text) => el('p', { class: 'mr-note', text })), tableHost);
  const count = (r) => D.playedCount(r, mode, view.baseline, cards.get(r.card_id));
  const plain = (text) => el('td', { class: 'num mr-dim', text });
  const columns = [
    { key: 'mode_rank', label: 'Rank', num: true, help: h.rank, cell: (r) => el('td', { class: 'num', text: fmtInt(r.mode_rank) }) },
    { key: 'title', label: 'Card', help: h.card, value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'type', label: 'Type', help: h.type, value: (r) => D.typeName(cards.get(r.card_id)?.type), cell: (r) => el('td', { text: D.typeName(cards.get(r.card_id)?.type) }) },
    { key: 'value', label: v.column, num: true, help: v.help(h), cell: (r) => meterCell(r.value) },
  ];
  if (mode !== 'all') columns.push({ key: 'popularity', label: 'All decks', num: true, help: h.allDecks, cell: (r) => plain(fmtPct(r.popularity)) });
  if (mode === 'splash') columns.push({ key: 'popularity_out', label: 'Out of faction', num: true, help: h.outFaction, cell: (r) => plain(fmtPct(r.popularity_out)) });
  if (mode === 'all') columns.push({ key: 'avg_copies', label: 'Avg copies', num: true, help: h.avgCopies, cell: (r) => el('td', { class: 'num', text: fmtNum(r.avg_copies) }) });
  columns.push(
    { key: 'change', label: 'Change', num: true, help: mode === 'all' ? h.change : h.modeChange, cell: (r) => changeCell(r.change) },
    mode === 'all'
      ? { key: 'decks', label: 'Decks', num: true, help: h.decks, cell: (r) => el('td', { class: 'num', text: fmtN(r.decks) }) }
      : { key: 'count', label: 'Decks', num: true, help: h.modeDecks, value: (r) => count(r)[0],
        cell: (r) => { const [n, of] = count(r); return el('td', { class: 'num', text: `${fmtInt(n)} / ${fmtInt(of)}` }); } },
  );
  const emptyPlayed = mode === 'splash' && hideSmall.splash ? `No card is in ${minSplash} decks in this filter.`
    : state.cut ? 'No top-cut decks with known decklists in this filter.' : 'No cards in this filter.';
  dataTable(tableHost, columns, rows, { sortKey: 'mode_rank', sortDir: 'ascending', empty: emptyPlayed,
    rowClass: (r) => (mode === 'splash' && r.splash_status !== 'ok' ? 'mr-insufficient' : '') });
}

function renderIdentities() {
  const h = help();
  const list = identities?.identities || [];
  const p = identities?.period;
  $('identities-note').textContent = p
    ? `Share of entries, winrate difference from the ${state.side === 'corp' ? 'Corp' : 'Runner'} baseline and top-cut conversion, ${monthName(p.from)} → ${monthName(p.to)}.${state.custom && view.period && (p.from !== view.period.from || p.to !== view.period.to) ? ' Identities always show the default period.' : ''}`
    : '';
  dataTable($('identities-body'), [
    { key: 'rank', label: 'Rank', num: true, help: h.identRank, cell: (r) => el('td', { class: 'num', text: fmtInt(r.rank) }) },
    { key: 'title', label: 'Identity', help: h.identity, value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'share', label: 'Share', num: true, help: h.share, cell: (r) => meterCell(r.share) },
    { key: 'winrate_diff_pp', label: 'Winrate vs baseline', num: true, help: h.identWinrate, cell: (r) => diffCell(r.winrate_diff_pp, r.winrate_status !== 'ok') },
    { key: 'games', label: 'Games', num: true, help: h.identGames, cell: (r) => el('td', { class: 'num', text: fmtN(r.games) }) },
    { key: 'conversion', label: 'Conversion', num: true, help: h.conversion, cell: (r) => el('td', { class: 'num', text: `${fmtPct(r.conversion)} (${fmtRatio(r.conversion_ratio)})` }) },
    { key: 'cut_entries', label: 'Entries in cut events', num: true, help: h.cutEntries, cell: (r) => el('td', { class: 'num', text: fmtN(r.cut_entries) }) },
  ], list, { sortKey: 'rank', sortDir: 'ascending', rowClass: (r) => (r.winrate_status !== 'ok' ? 'mr-insufficient' : ''), empty: 'No identities in this filter.' });
}

function renderWinrate() {
  const h = help();
  const min = manifest.thresholds.min_games;
  $('winrate-note').textContent = `Game winrate of decks with the card minus the ${state.side === 'corp' ? 'Corp' : 'Runner'} baseline over games with decklists (${fmtPct(view.baseline.winrate)}), with the Wilson 95% interval. Draws count as half a win; intentional draws are excluded. ${hideSmall.winrate ? `Cards under ${min} games are hidden.` : `Rows under ${min} games are greyed and listed last.`}`;
  const rows = sampled('winrate', D.winrateRows(view.cards), (r) => r.winrate_status === 'ok');
  dataTable($('winrate-body'), [
    { key: 'title', label: 'Card', help: h.card, value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'winrate_diff_pp', label: 'Winrate vs baseline', num: true, help: h.winrateDiff, cell: (r) => diffCell(r.winrate_diff_pp, r.winrate_status !== 'ok') },
    { key: 'wilson_low_pp', label: '95% interval', num: true, sortable: false, help: h.interval, cell: (r) => el('td', { class: 'num', text: `${fmtPp(r.wilson_low_pp)} → ${fmtPp(r.wilson_high_pp)}` }) },
    { key: 'winrate', label: 'Winrate', num: true, help: h.winrate, cell: (r) => el('td', { class: 'num', text: fmtPct(r.winrate) }) },
    { key: 'games', label: 'Games', num: true, help: h.games, cell: (r) => el('td', { class: 'num', text: fmtN(r.games) }) },
  ], rows, { rowClass: (r) => (r.winrate_status !== 'ok' ? 'mr-insufficient' : ''), empty: hideSmall.winrate ? `No card has ${min} games with decklists in this filter.` : 'No games with decklists in this filter.' });
}

// ---------------------------------------------------------------- trends

let trendsData = null;
// The card detail chart's trends: every ban list, whatever the Ban list filter says.
let detailTrends = null;

function initTrendCards() {
  const played = view.cards.filter((c) => c.decks > 0);
  const valid = new Set(played.map((c) => c.card_id));
  trendCards = trendCards.filter((t) => valid.has(t.id));
  if (!trendCards.length) trendCards = played.slice(0, 5).map((c, i) => ({ id: c.card_id, slot: i }));
}

function addTrendCard(id) {
  if (trendCards.some((t) => t.id === id)) return;
  if (trendCards.length >= MAX_TREND_CARDS) trendCards.shift();
  const used = new Set(trendCards.map((t) => t.slot));
  const slot = [0, 1, 2, 3, 4, 5].find((s) => !used.has(s));
  trendCards.push({ id, slot });
  initTrendCards();
  renderTrends();
}

async function renderTrends() {
  const s = { ...state };
  const chips = trendCards.map((t) => el('span', { class: 'badge mr-chip' },
    el('span', { class: 'legend-swatch', style: `background: var(--chart-${t.slot + 1})` }), ' ', cardName(t.id), ' ',
    el('button', { type: 'button', class: 'mr-x', 'aria-label': `Remove ${cardName(t.id)}`, onclick: () => {
      trendCards = trendCards.filter((x) => x.id !== t.id);
      initTrendCards();
      renderTrends();
    } }, '×')));
  $('trend-chips').replaceChildren(...chips);
  $('trend-add').disabled = false;
  setBusy(['trends'], true);
  try {
    const t = await slice('trends', s);
    if (D.dataHash(s) !== D.dataHash(state)) return;
    trendsData = t;
    drawTrends();
    setBusy(['trends'], false);
  } catch {
    if (D.dataHash(s) !== D.dataHash(state)) return;
    setBusy(['trends'], false);
    $('trend-chart').replaceChildren(el('p', { class: 'mr-note', text: 'Trends could not be loaded.' }));
  }
}

function trendRange() {
  return state.from && state.to ? { from: state.from, to: state.to } : null;
}

function drawTrends() {
  if (!trendsData || !manifest) return;
  const colors = JW.chartColors();
  const range = trendRange();
  const series = trendCards.map((t) => ({
    name: cardName(t.id),
    color: colors[t.slot] || colors[0],
    points: D.monthlySeries(trendsData, t.id, range),
  }));
  const months = series[0]?.points.map((p) => p.month) || [];
  const markers = D.banlistMarkers(manifest, months);
  $('trend-legend').replaceChildren(...trendCards.map((t) => el('span', { class: 'legend-item' },
    el('span', { class: 'legend-swatch', style: `background: var(--chart-${t.slot + 1})` }), cardName(t.id))));
  lineChart($('trend-chart'), series, markers, { label: `Monthly inclusion of ${series.map((x) => x.name).join(', ')}` });
  // Table alternative
  const monthly = `Share of ${state.cut ? 'top-cut ' : ''}${state.side === 'corp' ? 'Corp' : 'Runner'} decks with a known decklist from that month that play the card.`;
  const head = el('tr', {}, el('th', { scope: 'col', text: 'Month' }), ...series.map((x) => el('th', { class: 'num', scope: 'col', text: x.name, title: monthly })));
  const rows = months.map((mo, i) => el('tr', {}, el('td', { text: monthName(mo) }), ...series.map((x) => el('td', { class: 'num', text: fmtPct(x.points[i].popularity) }))));
  $('trend-table').replaceChildren(el('div', { class: 'mr-scroll' }, el('table', { class: 'data-table' }, el('thead', {}, head), el('tbody', {}, ...rows))));
}

// ---------------------------------------------------------------- scatter

function scatterData() {
  let pts = sampled('scatter', D.scatterPoints(view.cards), (p) => p.sufficient);
  if (scatterView.top) pts = D.topPerAxis(pts, SCATTER_TOP);
  return D.filterByName(pts, scatterView.query, cardName);
}

function renderScatter() {
  const b = view.baseline;
  const side = state.side === 'corp' ? 'Corp' : 'Runner';
  $('scatter-note').textContent = `Across: inclusion, the share of ${side} decks with a known decklist in this filter that play the card. Up and down: the card's game winrate minus the baseline, which is the winrate of every ${side} deck with a known decklist in this filter (${fmtPct(b.winrate)} over ${fmtInt(b.games)} games). Point size shows games; hollow points are below the minimum sample.${scatterView.top ? ` Showing the ${SCATTER_TOP} most included cards and the ${SCATTER_TOP} with the best winrate difference.` : ''}`;
  drawScatter();
  const h = help();
  const pts = scatterData();
  dataTable($('scatter-table'), [
    { key: 'title', label: 'Card', help: h.card, value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'x', label: 'Inclusion', num: true, help: h.inclusion, cell: (r) => el('td', { class: 'num', text: `${r.x.toFixed(1)}%` }) },
    { key: 'y', label: 'Winrate vs baseline', num: true, help: h.winrateDiff, cell: (r) => diffCell(r.y, !r.sufficient) },
    { key: 'games', label: 'Games', num: true, help: h.games, cell: (r) => el('td', { class: 'num', text: fmtN(r.games) }) },
  ], pts, { sortKey: 'x', rowClass: (r) => (r.sufficient ? '' : 'mr-insufficient') });
}

function drawScatter() {
  const host = $('scatter-chart');
  if (!view || !host) return;
  const pts = scatterData();
  if (!pts.length) {
    const text = scatterView.query ? 'No card matches that name here.'
      : hideSmall.scatter ? `No card has ${manifest.thresholds.min_games} games with decklists in this filter.` : 'No games with decklists in this filter.';
    host.replaceChildren(el('p', { class: 'mr-note', text }));
    return;
  }
  scatterChart(host, pts, { color: JW.sideColor(state.side), name: cardName, labelAll: 2 * SCATTER_TOP });
}

// ---------------------------------------------------------------- search and card detail

function setupSearch() {
  cardCombo($('card-search'), $('card-options'), {
    find: (q) => D.searchCards(catalog, q, { side: state.side, limit: 8 }), // only the selected side's cards
    onPick: (c) => openDetail(c.id),
  });
  // Trends: only cards played in the current view and not already charted.
  cardCombo($('trend-add'), $('trend-options'), {
    find: (q) => {
      const charted = new Set(trendCards.map((t) => t.id));
      const played = (view?.cards || []).filter((c) => c.decks > 0 && !charted.has(c.card_id)).map((c) => cards.get(c.card_id)).filter(Boolean);
      return D.searchCards({ cards: played }, q, { limit: 10 });
    },
    onPick: (c) => addTrendCard(c.id),
    clearOnPick: true,
  });
}

/** Opens a card's detail; `push` (a viewer's choice, not a redraw) adds it to the address and history. */
async function openDetail(id, scroll = true, push = true) {
  const c = cards.get(id);
  if (!c) return;
  if (c.side !== state.side) {
    detailCard = id;
    scrollToDetail = scroll;
    state.side = c.side;
    state.card = id;
    syncFilters();
    if (push) pushUrl();
    else replaceUrl();
    refresh();
    return;
  }
  detailCard = id;
  if (state.card !== id) {
    state.card = id;
    if (push) pushUrl();
    else replaceUrl();
  }
  setTitle();
  const panel = $('detail');
  panel.hidden = false;
  const body = $('detail-body');
  const f = D.faction(c.faction);
  const head = el('div', { class: 'mr-detail-head' }, el('h3', { class: 'mr-detail-title', text: c.title }),
    el('span', { class: `faction ${f.className}`, text: f.name }), ' ', el('span', { class: 'badge', text: D.typeName(c.type) }),
    ' ', el('span', { class: `badge ${c.side}`, text: c.side === 'corp' ? 'Corp' : 'Runner' }));
  const m = view.cards.find((x) => x.card_id === id);
  const isIdentity = c.type.endsWith('identity');
  const ident = isIdentity ? (identities?.identities || []).find((x) => x.card_id === id) : null;
  if ((!m || !m.decks) && !ident) {
    body.replaceChildren(head, el('p', { class: 'mr-note', text: 'Not played in this filter.' }));
    if (scroll) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const stat = (num, label) => el('div', { class: 'stat' }, el('span', { class: 'num', text: num }), el('span', { class: 'label', text: label }));
  const stats = ident
    ? [stat(fmtPct(ident.share), 'Share of entries'), stat(fmtPp(ident.winrate_diff_pp), `Winrate vs baseline (${fmtN(ident.games)})`),
      stat(`${fmtPp(ident.wilson_low_pp)} → ${fmtPp(ident.wilson_high_pp)}`, '95% interval'), stat(fmtPct(ident.conversion), `Top-cut conversion (${fmtN(ident.cut_entries)})`)]
    : [stat(fmtPct(m.popularity), `Inclusion (${fmtN(m.decks)} decks)`), ...factionStats(m, c, stat), stat(fmtNum(m.avg_copies), 'Average copies'),
      stat(m.copies_mode ? `${m.copies_mode}×` : '–', 'Most common copy count'),
      stat(fmtPp(m.winrate_diff_pp), `Winrate vs baseline (${fmtN(m.games)}${m.winrate_status === 'ok' ? '' : ', small sample'})`),
      stat(`${fmtPp(m.wilson_low_pp)} → ${fmtPp(m.wilson_high_pp)}`, '95% interval')];
  const charts = isIdentity ? [el('div', { id: 'detail-chart', class: 'mr-chart' })] : detailCharts();
  body.replaceChildren(head, el('div', { class: 'summary-grid mr-stats' }, ...stats),
    el('p', { class: 'mr-note', text: `Charts show every month and every ban list; the months selected in Filters are shaded.${c.banned_in?.length ? ' Red shading marks the months a ban list banned the card.' : ''}${isIdentity ? '' : ` Open winrate points are months with fewer than ${fmtInt(manifest.thresholds.min_games)} games.`}` }), ...charts);
  if (scroll) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    setBusy(['detail'], true);
    detailTrends = await slice('trends', { ...state, restriction: 'all' }); // whole timeline, every ban list
    drawDetailChart();
    setBusy(['detail'], false);
  } catch {
    setBusy(['detail'], false);
    $('detail-chart').replaceChildren(el('p', { class: 'mr-note', text: 'Trends could not be loaded.' }));
  }
}

/** Stat tiles for in- and out-of-faction inclusion and splash share; none for a card without them. */
function factionStats(m, c, stat) {
  if (m.popularity_in === null || m.popularity_in === undefined) return [];
  const fd = view.baseline.faction_decks?.[c.faction] ?? 0;
  const out = [stat(fmtPct(m.popularity_in), `In faction (${fmtInt(m.decks_in_faction)} of ${fmtInt(fd)} ${D.faction(c.faction).name} decks)`)];
  if (m.popularity_out !== null) {
    const splashed = m.decks - m.decks_in_faction;
    out.push(stat(fmtPct(m.popularity_out), `Out of faction (${fmtInt(splashed)} of ${fmtInt(view.baseline.decks - fd)} other decks)`),
      stat(fmtPct(m.splash_share), `Splash share (${fmtInt(splashed)} of ${fmtInt(m.decks)} decks${m.splash_status === 'ok' ? '' : ', small sample'})`));
  }
  return out;
}

/** The colour of a faction's line: its faction colour, or the dimmed text colour. */
const factionColor = (factionId) => {
  const cls = D.faction(factionId).className;
  return cls ? `var(--faction-${cls})` : 'var(--dim)';
};

// Headings, notes and hosts for the card's monthly charts; drawDetailChart fills the hosts.
function detailCharts() {
  const side = state.side === 'corp' ? 'Corp' : 'Runner';
  const color = JW.sideColor(state.side);
  const key = (swatch, text) => el('span', { class: 'legend-item' }, el('span', { class: 'legend-swatch', style: swatch }), text);
  const dashed = 'background: repeating-linear-gradient(90deg, var(--dim) 0 5px, transparent 5px 9px); width: 18px; height: 2px';
  const card = cards.get(detailCard);
  const scope = D.factionScope(card);
  const inclusionKey = scope.inF && view.baseline.faction_decks
    ? [el('div', { class: 'legend' }, key(`background: ${color}`, `All ${side} decks`), key(`background: ${factionColor(card.faction)}`, `${D.faction(card.faction).name} decks (in faction)`),
      ...(scope.outF ? [key(dashed, 'Other factions\' decks (out of faction)')] : []))]
    : [];
  return [
    el('h3', { text: 'Inclusion by month' }),
    ...inclusionKey,
    el('div', { id: 'detail-chart', class: 'mr-chart' }),
    el('h3', { text: 'Winrate by month' }),
    el('div', { class: 'legend' }, key(`background: ${color}`, 'Game winrate'), key(`background: ${color}; opacity: 0.25; height: 10px`, '95% interval'),
      key(dashed, `Baseline (every ${side} deck)`)),
    el('div', { id: 'detail-winrate', class: 'mr-chart' }),
    el('h3', { text: 'Winrate vs baseline by month' }),
    el('p', { class: 'mr-note', text: `The card's winrate minus that month's baseline, with the 95% interval shaded.` }),
    el('div', { id: 'detail-diff', class: 'mr-chart' }),
    el('h3', { text: 'Average copies by month' }),
    el('div', { id: 'detail-copies', class: 'mr-chart' }),
  ];
}

function drawDetailChart() {
  const host = document.getElementById('detail-chart');
  if (!host || !detailCard || !detailTrends || !detailTrends.cards[detailCard]) {
    if (host && detailCard && detailTrends) host.replaceChildren(el('p', { class: 'mr-note', text: 'Identities have no monthly series.' }));
    return;
  }
  const name = cardName(detailCard);
  const meta = cards.get(detailCard);
  const points = D.monthlySeries(detailTrends, detailCard, null, 'all', meta);
  const months = points.map((p) => p.month);
  const markers = D.banlistMarkers(manifest, months);
  const range = trendRange();
  const bans = D.banPeriods(manifest, cards.get(detailCard), months);
  const shaded = (range ? `; ${monthName(range.from)} to ${monthName(range.to)} is shaded` : '')
    + bans.map((b) => `; banned ${b.from === b.to ? `in ${monthName(b.from)}` : `from ${monthName(b.from)} to ${monthName(b.to)}`}`).join('');
  const color = JW.sideColor(state.side);
  const card = [{ name, color, points }];
  const small = (p) => p.games > 0 && p.games < manifest.thresholds.min_games;
  const pctAxis = (vals) => niceAxis(Math.max(0, Math.min(...vals)), Math.min(1, Math.max(...vals)));
  const opts = { height: 200, band: range, bans };
  // In and out of faction next to every deck, for a card that has them (and a snapshot with them).
  const lines = [...card];
  if (points.some((p) => p.popularity_in !== null)) lines.push({ name: 'In faction', color: factionColor(meta.faction), points, value: (p) => p.popularity_in });
  if (points.some((p) => p.popularity_out !== null)) lines.push({ name: 'Out of faction', color: 'var(--dim)', points, value: (p) => p.popularity_out, dash: true });
  const split = lines.length > 1;
  lineChart(host, lines, markers, {
    ...opts, label: `Monthly inclusion of ${name} over every month, all ban lists${split ? ', in and out of its faction' : ''}${shaded}`,
    tip: split ? (i) => {
      const p = points[i];
      const out = [`All decks: ${fmtPct(p.popularity)} (${fmtInt(p.decks)} of ${fmtInt(p.total)})`,
        `In faction: ${fmtPct(p.popularity_in)} (${fmtInt(p.decks_in)} of ${fmtInt(p.total_in)})`];
      if (p.popularity_out !== null) out.push(`Out of faction: ${fmtPct(p.popularity_out)} (${fmtInt(p.decks - p.decks_in)} of ${fmtInt(p.total - p.total_in)})`);
      return out;
    } : null,
  });
  const wr = $('detail-winrate');
  if (wr) {
    lineChart(wr, [...card, { name: 'Baseline', color: 'var(--dim)', points, value: (p) => p.baseline_winrate, dash: true }], markers, {
      ...opts, value: (p) => p.winrate, interval: (p) => [p.winrate_low, p.winrate_high], hollow: small, axis: pctAxis,
      label: `Monthly game winrate of ${name} with its 95% interval, against the baseline${shaded}`,
      tip: (i) => {
        const p = points[i];
        return [`${name}: ${fmtPct(p.winrate)} (${fmtN(p.games)})`, `95% interval: ${fmtPct(p.winrate_low)} → ${fmtPct(p.winrate_high)}`, `Baseline: ${fmtPct(p.baseline_winrate)}`];
      },
    });
  }
  const diff = $('detail-diff');
  if (diff) {
    lineChart(diff, card, markers, {
      ...opts, value: (p) => p.winrate_diff_pp, interval: (p) => [p.wilson_low_pp, p.wilson_high_pp], hollow: small, zero: true,
      axis: (vals) => { const ext = Math.max(5, ...vals.map(Math.abs)); return niceAxis(-ext, ext); },
      tick: (v) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(+v.toFixed(1))} pp`,
      label: `Monthly winrate of ${name} minus the baseline, with its 95% interval${shaded}`,
      tip: (i) => {
        const p = points[i];
        return [`vs baseline: ${fmtPp(p.winrate_diff_pp)} (${fmtN(p.games)})`, `95% interval: ${fmtPp(p.wilson_low_pp)} → ${fmtPp(p.wilson_high_pp)}`];
      },
    });
  }
  const copies = $('detail-copies');
  if (copies) {
    lineChart(copies, card, markers, {
      ...opts, value: (p) => p.avg_copies, axis: (vals) => niceAxis(0, Math.max(3, ...vals)), tick: (v) => `${+v.toFixed(2)}×`,
      label: `Monthly average copies of ${name} in the decks that play it${shaded}`,
      tip: (i) => [`Average copies: ${fmtNum(points[i].avg_copies)} (${fmtN(points[i].decks)} decks)`],
    });
  }
}

// ---------------------------------------------------------------- quality footer

async function loadQuality() {
  try {
    const q = await getJson(D.joinUrl(base, manifest.base_path + manifest.paths.quality));
    const c = q.coverage;
    $('quality').textContent = `Data quality: ${fmtInt(c.tournaments)} tournaments (${fmtInt(c.tournaments_with_games)} with game results, ${fmtInt(c.tournaments_high_coverage)} with high decklist coverage), ${fmtInt(c.legal_decks)} legal decks of ${fmtInt(c.decks)}, ${fmtInt(c.games)} games. Unresolved cards: ${fmtInt(Object.keys(q.unresolved_cards).length)}; link mismatches: ${fmtInt(q.link_mismatches.length)}; parser failures: ${fmtInt(q.parser_failures.length)}. Generated ${manifest.generated_at}.`;
  } catch {
    $('quality').textContent = '';
  }
}

boot().catch((e) => {
  console.error(e);
  showUnavailable();
});
