import { GraphModel } from './graph.js';
import { ForceLayout } from './layout.js';
import { GraphView } from './render.js';
import { THEME, fmtDate, fmtNum, pretty } from './theme.js';

const $ = (id) => document.getElementById(id);
const dataUrl = (f) => new URL(f.replace(/^data\//, ''), new URL('../../data/', import.meta.url)).href;

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) e.append(kid && kid.nodeType ? kid : document.createTextNode(kid ?? ''));
  return e;
}
const swatch = (c) => { const s = h('span', { class: 'sw' }); s.style.background = c; return s; };

// ------------------------------------------------------------------ state
const S = {
  manifest: [], ds: null, model: null, layout: null, typeColors: [],
  f: 1, playing: false, speed: 1, durationMs: 24000,
  mode: 'cumulative', windowDays: 90, includeUndated: true, hideIso: false,
  nodeTypeOn: [], edgeTypeOn: [], minDeg: 0, comm: -1, attrVals: [],
  sizeBy: 'pagerank', colorBy: 'type',
  sel: -1, matches: null, hl: null, pathMode: false, pathA: -1, path: null,
  needsRefresh: true, userMoved: false, lower: [], histCache: null,
};

const view = new GraphView($('cv'), {
  onSelect: (i) => selectNode(i),
  onHover: showTip,
  onUser: () => { S.userMoved = true; },
});

// ------------------------------------------------------------------ helpers
const currentT = () => { const [a, b] = S.model.timeRange; return a + S.f * (b - a); };
function setT(ms) {
  const [a, b] = S.model.timeRange;
  S.f = Math.min(1, Math.max(0, (ms - a) / Math.max(1, b - a)));
  $('slider').value = Math.round(S.f * 1000);
}
function windowBuckets() {
  const sr = S.model.series;
  return sr ? Math.max(1, Math.round((S.windowDays * 86400000) / sr.stepMs)) : 1;
}
function visState() {
  return {
    t: currentT(), mode: S.mode, windowBuckets: windowBuckets(),
    nodeTypes: S.nodeTypeOn, edgeTypes: S.edgeTypeOn,
    includeUndated: S.includeUndated, hideIsolated: S.hideIso,
    minDeg: S.minDeg, comm: S.comm,
    filters: S.attrVals.map((v, idx) => (v ? { idx, value: v } : null)).filter(Boolean),
  };
}
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
const requestRefresh = () => { S.needsRefresh = true; };

// ------------------------------------------------------------------ refresh pipeline
function refresh() {
  const m = S.model; if (!m) return;
  m.compute(visState());
  view.updateAppearance({
    sizeBy: S.sizeBy, colorBy: S.colorBy, t: currentT(),
    typeColors: S.typeColors, states: m.meta.nodeStates,
  });
  recomputeFocus();
  updateCounts();
  updateTimeUI();
  drawHist();
  if (S.sel >= 0) renderDetails(true);
  view.invalidate();
}

function recomputeFocus() {
  const m = S.model;
  const nodes = new Uint8Array(m.n), edges = new Uint8Array(m.m), hot = new Set();
  let any = false;
  if (S.path) {
    S.path.nodes.forEach((i) => { nodes[i] = 1; hot.add(i); });
    S.path.edges.forEach((e) => { edges[e] = 1; });
    any = true;
  } else if (S.hl && S.hl.size) {
    S.hl.forEach((i) => { if (m.vis[i]) { nodes[i] = 1; hot.add(i); } });
    for (let e = 0; e < m.m; e++) if (m.evis[e] && nodes[m.eS[e]] && nodes[m.eT[e]]) edges[e] = 1;
    any = true;
  } else if (S.sel >= 0 && m.vis[S.sel]) {
    nodes[S.sel] = 1; hot.add(S.sel);
    for (const { node, edge } of m.neighbors(S.sel)) { nodes[node] = 1; edges[edge] = 1; hot.add(node); }
    any = true;
  } else if (S.matches && S.matches.size) {
    S.matches.forEach((i) => { if (m.vis[i]) { nodes[i] = 1; hot.add(i); } });
    any = hot.size > 0;
  }
  view.focus = any ? { nodes, edges, hot } : null;
  view.sel = S.sel;
  view.path = S.path;
  view.matches = S.matches && !S.hl ? S.matches : S.hl;
  view.showLabels = $('labelsOn').checked;
}

function updateCounts() {
  const m = S.model;
  const vt = new Array(m.typeNames.length).fill(0);
  for (let i = 0; i < m.n; i++) if (m.vis[i]) vt[m.nType[i]]++;
  const ve = new Array(m.edgeTypeNames.length).fill(0);
  for (let e = 0; e < m.m; e++) if (m.evis[e]) ve[m.eType[e]]++;
  S.typeCnt.forEach((el, i) => { el.textContent = `${fmtNum(vt[i])} / ${fmtNum(S.totalType[i])}`; });
  S.edgeCnt.forEach((el, i) => { el.textContent = `${fmtNum(ve[i])} / ${fmtNum(S.totalEdge[i])}`; });
  updateStats();
  updateLegend();
}
function updateStats() {
  const m = S.model;
  $('stats').textContent =
    `${fmtNum(m.visNodes)} of ${fmtNum(m.n)} nodes · ${fmtNum(m.visEdges)} edges` +
    (S.layout.running ? ' · settling layout…' : '');
}
function updateLegend() {
  const m = S.model, box = $('legend');
  const items = [];
  if (S.colorBy === 'state' && m.meta.nodeStates) {
    for (const s of Object.values(m.meta.nodeStates)) items.push([s.color, s.label]);
    items.push(['#9a9992', 'Not a complaint']);
  } else if (S.colorBy === 'community') {
    (m.meta.communities || []).slice(0, THEME.cat.length).forEach((c, i) =>
      items.push([THEME.cat[i], `#${c.id + 1} · ${c.top} (${fmtNum(c.size)})`]));
    items.push([THEME.neutral, 'Other communities']);
  }
  box.hidden = !items.length;
  box.replaceChildren(...items.map(([c, l]) => h('div', {}, swatch(c), l)));
}
function updateTimeUI() {
  $('timeLabel').textContent = fmtDate(currentT());
  $('btnPlay').textContent = S.playing ? '❚❚' : '▶';
  $('btnPlay').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
}

// ------------------------------------------------------------------ histogram
function drawHist() {
  const c = $('hist'), m = S.model;
  const W = c.clientWidth, H = c.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!W || !H) return;
  if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const bins = Math.max(30, Math.floor(W / 5));
  if (!S.histCache || S.histCache.bins !== bins) S.histCache = { bins, data: m.histogram(bins) };
  const data = S.histCache.data;
  let mx = 0; for (const v of data) if (v > mx) mx = v;
  if (!mx) return;
  const bw = W / bins;
  for (let k = 0; k < bins; k++) {
    const hh = Math.max(1, Math.pow(data[k] / mx, 0.6) * (H - 2));
    ctx.fillStyle = (k + 0.5) / bins <= S.f ? '#3987e5' : '#d6d4cc';
    ctx.fillRect(k * bw + 0.5, H - hh, Math.max(1, bw - 1.5), hh);
  }
}

// ------------------------------------------------------------------ selection / details
function selectNode(i, opts = {}) {
  const m = S.model;
  if (S.pathMode && i >= 0) { handlePathClick(i); return; }
  if (i >= 0 && opts.ensure && !m.vis[i]) ensureVisible(i);
  S.sel = i; S.hl = null; S.path = null;
  recomputeFocus();
  renderDetails();
  if (i >= 0 && opts.center) view.centerOn(i);
  view.invalidate();
  updateHash();
}

function ensureVisible(i) {
  const m = S.model;
  if (!S.nodeTypeOn[m.nType[i]]) { S.nodeTypeOn[m.nType[i]] = true; syncChecks(); }
  const st = m.nStart[i], en = m.nEnd[i];
  if (!Number.isNaN(st) && st > currentT()) setT(st);
  if (S.mode === 'active' && !Number.isNaN(en) && en < currentT()) setT(en);
  if (Number.isNaN(st) && Number.isNaN(en)) { S.includeUndated = true; $('undated').checked = true; }
  if (m.deg[i] < S.minDeg) { S.minDeg = 0; $('minDeg').value = 0; $('minDegVal').textContent = '0'; }
  if (S.comm >= 0 && m.comm[i] !== S.comm) { S.comm = -1; $('commSel').value = '-1'; }
  if (S.attrVals.some(Boolean)) { S.attrVals = S.attrVals.map(() => ''); document.querySelectorAll('#attrFilters select').forEach((s) => { s.value = ''; }); }
  refresh();
  if (!m.vis[i]) toast('That node is hidden by another filter.');
}

function renderDetails(keepScroll) {
  const box = $('details'), m = S.model;
  const scroll = keepScroll ? box.scrollTop : 0;
  if (S.path) { renderPath(box); box.hidden = false; return; }
  const i = S.sel;
  if (i < 0) { box.hidden = true; return; }
  const nd = m.nodes[i];
  const tcol = S.typeColors[m.nType[i]];
  const rows = [];
  const life = Number.isNaN(m.nStart[i]) && Number.isNaN(m.nEnd[i]) ? 'undated'
    : `${fmtDate(Number.isNaN(m.nStart[i]) ? null : m.nStart[i])} → ${Number.isNaN(m.nEnd[i]) ? 'ongoing' : fmtDate(m.nEnd[i])}`;
  rows.push(['Lifespan', life]);
  if (nd.attrs) for (const [k, v] of Object.entries(nd.attrs)) rows.push([pretty(k), v]);
  if (nd.phases) rows.push(['Timeline', nd.phases.map(([t, s]) => `${fmtDate(t)} ${pretty(s)}`).join(' → ')]);
  let better = 0; for (let k = 0; k < m.n; k++) if (m.pr[k] > m.pr[i]) better++;
  rows.push(['Connections', `${fmtNum(m.deg[i])} overall${m.vis[i] ? ` · ${fmtNum(m.ldeg[i])} in this view` : ''}`]);
  rows.push(['PageRank', `top ${Math.max(0.1, ((better + 1) / m.n) * 100).toFixed(1)}%`]);
  const ci = (m.meta.communities || []).find((c) => c.id === m.comm[i]);
  rows.push(['Community', ci ? `#${ci.id + 1} · ${ci.top}` : `#${m.comm[i] + 1}`]);

  const nbrs = m.vis[i] ? m.neighbors(i).sort((a, b) => m.pr[b.node] - m.pr[a.node]).slice(0, 12) : [];
  box.replaceChildren(
    h('button', { class: 'x', 'aria-label': 'Close', onclick: () => selectNode(-1) }, '×'),
    h('h3', {}, nd.label),
    h('div', { class: 'chip' }, swatch(tcol), m.meta.nodeTypes[nd.type].label || nd.type,
      m.vis[i] ? '' : ' · not in current view'),
    h('table', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v)))),
    nbrs.length ? h('h4', {}, `Connected (${m.neighbors(i).length})`) : '',
    nbrs.length ? h('ul', {}, nbrs.map(({ node, edge }) =>
      h('li', { onclick: () => selectNode(node, { center: true }) }, swatch(S.typeColors[m.nType[node]]),
        m.nodes[node].label.length > 30 ? m.nodes[node].label.slice(0, 29) + '…' : m.nodes[node].label,
        h('small', { class: 'muted' }, (m.dirType[m.eType[edge]] ? (m.eS[edge] === i ? '→ ' : '← ') : '') + pretty(m.edgeTypeNames[m.eType[edge]]) + (m.edges[edge].note ? ' · ' + m.edges[edge].note : ''))))) : '',
    h('div', { class: 'acts' },
      h('button', { class: 'btn', onclick: () => startPath(i) }, 'Path from here…'),
      h('button', { class: 'btn', onclick: () => { S.layout.fixed[i] ^= 1; view.invalidate(); } }, 'Pin / unpin')),
  );
  box.hidden = false;
  box.scrollTop = scroll;
}

// ------------------------------------------------------------------ path tool
function setPathMode(on) {
  S.pathMode = on; S.pathA = -1;
  $('btnPath').setAttribute('aria-pressed', String(on));
  const hint = $('pathHint');
  hint.hidden = !on;
  hint.textContent = 'Click the start node, then the end node.';
}
function startPath(i) {
  setPathMode(true); S.pathA = i; S.sel = i; S.path = null;
  $('pathHint').textContent = `Start: ${S.model.nodes[i].label}. Now click the end node.`;
  recomputeFocus(); renderDetails(); view.invalidate();
}
function handlePathClick(i) {
  if (S.pathA < 0) {
    S.pathA = i; S.sel = i;
    $('pathHint').textContent = `Start: ${S.model.nodes[i].label}. Now click the end node.`;
    recomputeFocus(); view.invalidate(); return;
  }
  const res = S.model.shortestPath(S.pathA, i);
  const a = S.pathA;
  setPathMode(false);
  if (!res) {
    toast('No path between those nodes in the current view — try a later time or enable more types.');
    S.sel = i; recomputeFocus(); renderDetails(); view.invalidate(); return;
  }
  S.path = res; S.sel = -1;
  recomputeFocus(); renderDetails(); view.invalidate();
  view.animateTo(...centerOfNodes(res.nodes));
  void a;
}
function centerOfNodes(list) {
  const L = S.layout; let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const i of list) { a = Math.min(a, L.x[i]); c = Math.max(c, L.x[i]); b = Math.min(b, L.y[i]); d = Math.max(d, L.y[i]); }
  const bw = Math.max(80, c - a), bh = Math.max(80, d - b);
  const k = Math.min(Math.max(0.05, Math.min((view.w - 420) / bw, (view.h - 140) / bh)), 6);
  return [(a + c) / 2 + 60 / k, (b + d) / 2, k];
}
function renderPath(box) {
  const m = S.model, p = S.path;
  box.replaceChildren(
    h('button', { class: 'x', 'aria-label': 'Close', onclick: () => clearAll() }, '×'),
    h('h3', {}, `Shortest path · ${p.edges.length} hop${p.edges.length === 1 ? '' : 's'}`),
    h('div', { class: 'muted small' }, 'Over the edges visible at the current time.'),
    h('ul', {}, p.nodes.flatMap((n, k) => {
      const out = [h('li', { onclick: () => selectNode(n, { center: true }) }, swatch(S.typeColors[m.nType[n]]), m.nodes[n].label)];
      if (k < p.edges.length) out.push(h('li', { class: 'muted small', style: 'cursor:default;padding-left:19px' }, '— ' + pretty(m.edgeTypeNames[m.eType[p.edges[k]]]) + ' —'));
      return out;
    })),
  );
}

// ------------------------------------------------------------------ search
function onSearch() {
  const q = $('search').value.trim().toLowerCase();
  const list = $('results');
  if (q.length < 2) { S.matches = null; list.hidden = true; recomputeFocus(); view.invalidate(); return; }
  const m = S.model, hits = [];
  for (let i = 0; i < m.n; i++) if (S.lower[i].includes(q)) hits.push(i);
  hits.sort((a, b) => (m.vis[b] - m.vis[a]) || (m.pr[b] - m.pr[a]));
  S.matches = new Set(hits.filter((i) => m.vis[i]).slice(0, 200));
  S.hl = null;
  list.replaceChildren(...hits.slice(0, 8).map((i) => h('li', { onclick: () => pickResult(i) },
    swatch(S.typeColors[m.nType[i]]), m.nodes[i].label.slice(0, 40), h('small', {}, m.vis[i] ? m.nodes[i].type : 'hidden now'))));
  if (!hits.length) list.replaceChildren(h('li', { class: 'muted' }, 'No matches'));
  list.hidden = false;
  recomputeFocus(); view.invalidate();
}
function pickResult(i) {
  $('results').hidden = true; $('search').value = ''; S.matches = null;
  selectNode(i, { center: true, ensure: true });
}

// ------------------------------------------------------------------ tooltip
function showTip(i, cx, cy) {
  const tip = $('tip');
  if (i < 0 || !S.model) { tip.hidden = true; return; }
  const m = S.model, nd = m.nodes[i];
  const st = m.stateAt(i, currentT());
  const lines = [m.meta.nodeTypes[nd.type].label || nd.type];
  if (nd.attrs) for (const k of Object.keys(nd.attrs).slice(0, 3)) lines.push(`${pretty(k)}: ${nd.attrs[k]}`);
  if (st) lines.push(`state now: ${pretty(st)}`);
  lines.push(`${fmtNum(m.ldeg[i])} connections in view`);
  tip.replaceChildren(h('b', {}, nd.label), ...lines.map((l) => h('span', {}, l, h('br'))));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(cx + 14, innerWidth - r.width - 8) + 'px';
  tip.style.top = Math.min(cy + 14, innerHeight - r.height - 8) + 'px';
}

// ------------------------------------------------------------------ UI build (per dataset)
function syncChecks() {
  document.querySelectorAll('#nodeTypes input').forEach((el, i) => { el.checked = !!S.nodeTypeOn[i]; });
  document.querySelectorAll('#edgeTypes input').forEach((el, i) => { el.checked = !!S.edgeTypeOn[i]; });
}

function buildUI() {
  const m = S.model, meta = m.meta;
  $('subtitle').textContent = meta.subtitle || '';
  const ban = $('demoBanner');
  ban.hidden = !meta.demo; ban.textContent = meta.demoNote || '';
  $('source').textContent = meta.source || '';
  $('timeNote').textContent = meta.timeNote || '';

  S.typeColors = m.typeNames.map((t, i) => meta.nodeTypes[t].color || THEME.cat[i % THEME.cat.length]);
  S.nodeTypeOn = m.typeNames.map((t) => !meta.nodeTypes[t].hidden);
  S.edgeTypeOn = m.edgeTypeNames.map((t) => (meta.edgeDefaults || {})[t] !== false);
  S.totalType = new Array(m.typeNames.length).fill(0);
  for (let i = 0; i < m.n; i++) S.totalType[m.nType[i]]++;
  S.totalEdge = new Array(m.edgeTypeNames.length).fill(0);
  for (let e = 0; e < m.m; e++) S.totalEdge[m.eType[e]]++;

  S.typeCnt = [];
  $('nodeTypes').replaceChildren(...m.typeNames.map((t, i) => {
    const cnt = h('span', { class: 'cnt' }); S.typeCnt.push(cnt);
    return h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: S.nodeTypeOn[i], onchange: (e) => { S.nodeTypeOn[i] = e.target.checked; requestRefresh(); } }),
      swatch(S.typeColors[i]), meta.nodeTypes[t].label || t, cnt);
  }));
  S.edgeCnt = [];
  $('edgeTypes').replaceChildren(...m.edgeTypeNames.map((t, i) => {
    const cnt = h('span', { class: 'cnt' }); S.edgeCnt.push(cnt);
    return h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: S.edgeTypeOn[i], onchange: (e) => { S.edgeTypeOn[i] = e.target.checked; requestRefresh(); } }),
      pretty(t), cnt);
  }));

  const maxDeg = Math.min(50, Math.max(...m.deg));
  const md = $('minDeg'); md.max = String(maxDeg); md.value = '0'; S.minDeg = 0; $('minDegVal').textContent = '0';

  const cs = $('commSel');
  cs.replaceChildren(h('option', { value: '-1' }, 'All communities'),
    ...(meta.communities || []).map((c) => h('option', { value: String(c.id) }, `#${c.id + 1} · ${c.top.slice(0, 28)} (${fmtNum(c.size)})`)));
  S.comm = -1;

  S.attrVals = m.filters.map(() => '');
  $('attrFilters').replaceChildren(...m.filters.map((f, idx) =>
    h('label', { class: 'row' }, h('span', {}, f.label),
      h('select', { onchange: (e) => { S.attrVals[idx] = e.target.value; requestRefresh(); } },
        h('option', { value: '' }, 'All'),
        ...f.options.map(([v, c]) => h('option', { value: v }, `${v.slice(0, 34)} (${fmtNum(c)})`))))));

  const hasPhases = m.nodes.some((n) => n.phases);
  [...$('colorBy').options].forEach((o) => { if (o.value === 'state') o.disabled = !hasPhases; });
  S.sizeBy = meta.defaultSize || 'pagerank'; $('sizeBy').value = S.sizeBy;
  S.colorBy = 'type'; $('colorBy').value = 'type';
  S.mode = meta.defaultMode || 'cumulative'; $('mode').value = S.mode;
  S.windowDays = meta.windowDays || 90;
  const win = $('win');
  if (![...win.options].some((o) => +o.value === S.windowDays)) win.append(h('option', { value: String(S.windowDays) }, `${S.windowDays} days`));
  win.value = String(S.windowDays);
  $('winWrap').hidden = !m.series;
  S.includeUndated = true; $('undated').checked = true;
  S.hideIso = false; $('hideIso').checked = false;
  $('tMin').textContent = fmtDate(m.timeRange[0]); $('tMax').textContent = fmtDate(m.timeRange[1]);
  S.lower = m.nodes.map((n) => n.label.toLowerCase());
  S.histCache = null;
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === S.ds.id)));
}

// ------------------------------------------------------------------ dataset loading
async function loadDataset(id, hash = {}) {
  const info = S.manifest.find((d) => d.id === id) || S.manifest[0];
  const ld = $('loading'); ld.classList.remove('done'); ld.textContent = `Loading ${info.title}…`;
  setPathMode(false);
  let raw;
  try {
    const res = await fetch(dataUrl(info.file));
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    raw = await res.json();
  } catch (err) {
    ld.textContent = `Could not load ${info.file}: ${err.message}. Serve this folder over HTTP (python -m http.server), not file://.`;
    return;
  }
  S.ds = info;
  S.playing = false;
  S.model = new GraphModel(raw);
  S.layout = new ForceLayout(S.model);
  S.sel = -1; S.matches = null; S.hl = null; S.path = null; S.userMoved = false;
  $('search').value = ''; $('results').hidden = true; $('details').hidden = true;
  view.setModel(S.model, S.layout);
  buildUI();
  S.f = 1; $('slider').value = 1000;
  if (hash.t) { const ms = Date.parse(hash.t); if (!Number.isNaN(ms)) setT(ms); }

  S.layout.seed();
  const t0 = performance.now();
  while (S.layout.alpha > 0.3 && performance.now() - t0 < 1200) S.layout.step(40);
  refresh();
  view.fit(true, 60, true);
  ld.classList.add('done');
  if (hash.sel) { const i = S.model.id2i.get(hash.sel); if (i != null) selectNode(i, { center: true, ensure: true }); }
  if (hash.hl) api.highlight(hash.hl.split(','));
  updateHash();
}

function updateHash() {
  const p = new URLSearchParams();
  if (S.ds) p.set('d', S.ds.id);
  if (S.sel >= 0) p.set('sel', S.model.nodes[S.sel].id);
  try { history.replaceState(null, '', '#' + p.toString()); } catch (_) { /* sandboxed frames may refuse */ }
}

// ------------------------------------------------------------------ playback + main loop
function togglePlay() {
  if (!S.playing && S.f >= 0.999) { S.f = 0; $('slider').value = 0; requestRefresh(); }
  S.playing = !S.playing;
  updateTimeUI();
}
function clearAll() {
  S.sel = -1; S.matches = null; S.hl = null; S.path = null;
  $('search').value = ''; $('results').hidden = true;
  setPathMode(false);
  recomputeFocus(); renderDetails(); view.invalidate(); updateHash();
}

let last = performance.now(), wasRunning = false;
function frame(now) {
  const dt = Math.min(100, now - last); last = now;
  if (S.model) {
    if (S.playing) {
      S.f = Math.min(1, S.f + dt / (S.durationMs / S.speed));
      $('slider').value = Math.round(S.f * 1000);
      if (S.f >= 1) S.playing = false;
      S.needsRefresh = true;
    }
    if (S.layout.running) {
      S.layout.step(9); view.invalidate(); wasRunning = true;
    } else if (wasRunning) {
      wasRunning = false; updateStats();
      if (!S.userMoved) view.fit(true);
    }
    if (S.needsRefresh) { S.needsRefresh = false; refresh(); }
    if (view.dirty) {
      view.dirty = false;
      view.draw();
      if (S.layout.running && (S.layout.iter & 15) === 0) updateStats();
    }
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ static control wiring
function wire() {
  $('slider').addEventListener('input', (e) => { S.f = +e.target.value / 1000; S.playing = false; requestRefresh(); });
  $('btnPlay').addEventListener('click', togglePlay);
  $('speed').addEventListener('change', (e) => { S.speed = +e.target.value; });
  $('mode').addEventListener('change', (e) => { S.mode = e.target.value; requestRefresh(); });
  $('win').addEventListener('change', (e) => { S.windowDays = +e.target.value; requestRefresh(); });
  $('undated').addEventListener('change', (e) => { S.includeUndated = e.target.checked; requestRefresh(); });
  $('hideIso').addEventListener('change', (e) => { S.hideIso = e.target.checked; requestRefresh(); });
  $('labelsOn').addEventListener('change', () => { recomputeFocus(); view.invalidate(); });
  $('minDeg').addEventListener('input', (e) => { S.minDeg = +e.target.value; $('minDegVal').textContent = e.target.value; requestRefresh(); });
  $('commSel').addEventListener('change', (e) => { S.comm = +e.target.value; requestRefresh(); });
  $('sizeBy').addEventListener('change', (e) => { S.sizeBy = e.target.value; requestRefresh(); });
  $('colorBy').addEventListener('change', (e) => { S.colorBy = e.target.value; requestRefresh(); });
  $('search').addEventListener('input', onSearch);
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = $('results').querySelector('li:not(.muted)'); if (first) first.click(); }
  });
  $('btnPath').addEventListener('click', () => { if (S.pathMode) setPathMode(false); else { S.path = null; recomputeFocus(); renderDetails(); setPathMode(true); } });
  $('btnFit').addEventListener('click', () => { S.userMoved = false; view.fit(true); });
  $('btnRelayout').addEventListener('click', () => {
    S.layout.setActive(Uint8Array.from(S.model.vis)); S.layout.reheat(1); S.userMoved = false;
  });
  $('btnReset').addEventListener('click', () => {
    S.layout.setActive(new Uint8Array(S.model.n).fill(1)); S.layout.fixed.fill(0);
    S.layout.seed(); S.userMoved = false;
  });
  $('btnPng').addEventListener('click', () => {
    view.draw();
    view.cv.toBlob((b) => {
      const a = h('a', { href: URL.createObjectURL(b), download: `graph-${S.ds.id}.png` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  });
  addEventListener('keydown', (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '') && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';
    if (e.key === 'Escape') clearAll();
    else if (e.key === ' ' && !typing) { e.preventDefault(); togglePlay(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing && document.activeElement?.type !== 'range') {
      S.f = Math.min(1, Math.max(0, S.f + (e.key === 'ArrowRight' ? 0.01 : -0.01)));
      $('slider').value = Math.round(S.f * 1000); requestRefresh();
    }
  });
  addEventListener('resize', () => { S.histCache = null; requestRefresh(); });
}

// ------------------------------------------------------------------ public API (for the Graph RAG module)
const api = {
  loadDataset: (id) => loadDataset(id),
  /** Select a node by its id (e.g. "D:Chatuchak" or an ICIJ node_id). */
  select(id) { const i = S.model.id2i.get(String(id)); if (i == null) return false; selectNode(i, { center: true, ensure: true }); return true; },
  /** Highlight a set of node ids (and the edges among them); reveals them if hidden. */
  highlight(ids, { reveal = true } = {}) {
    const m = S.model;
    const idx = ids.map((x) => m.id2i.get(String(x))).filter((i) => i != null);
    if (!idx.length) return 0;
    if (reveal) {
      let tNeed = -Infinity;
      for (const i of idx) {
        S.nodeTypeOn[m.nType[i]] = true;
        if (!Number.isNaN(m.nStart[i])) tNeed = Math.max(tNeed, m.nStart[i]);
      }
      syncChecks();
      S.mode = 'cumulative'; $('mode').value = 'cumulative';
      S.includeUndated = true; $('undated').checked = true;
      S.minDeg = 0; $('minDeg').value = 0; $('minDegVal').textContent = '0';
      S.comm = -1; $('commSel').value = '-1';
      S.attrVals = S.attrVals.map(() => ''); document.querySelectorAll('#attrFilters select').forEach((s) => { s.value = ''; });
      if (tNeed > currentT()) setT(tNeed);
      m.compute(visState());
    }
    S.sel = -1; S.path = null; S.matches = null; S.hl = new Set(idx);
    refresh(); renderDetails();
    view.animateTo(...centerOfNodes(idx));
    return idx.length;
  },
  clear: clearAll,
  setTime(v) { setT(typeof v === 'number' ? v : Date.parse(v)); requestRefresh(); },
  get state() { return { dataset: S.ds?.id, t: S.model ? currentT() : null, selected: S.sel >= 0 ? S.model.nodes[S.sel].id : null }; },
};
api._S = S; api._view = view;
window.GraphViewer = api;

// ------------------------------------------------------------------ boot
async function boot() {
  wire();
  let manifest;
  try { manifest = await (await fetch(dataUrl('datasets.json'))).json(); }
  catch (err) {
    $('loading').textContent = `Could not load ../data/datasets.json (${err.message}). Serve this folder over HTTP (python -m http.server), not file://.`;
    return;
  }
  S.manifest = manifest;
  $('tabs').replaceChildren(...manifest.map((d) => h('button', {
    role: 'tab', 'data-id': d.id, 'aria-selected': 'false', onclick: () => loadDataset(d.id),
  }, h('b', {}, d.title), h('span', {}, d.blurb || ''))));
  const hash = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  await loadDataset(hash.d || manifest[0].id, hash);
  requestAnimationFrame(frame);
}
boot();
