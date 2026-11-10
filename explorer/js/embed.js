// Embeddable graph: the same model, layout and renderer as the explorer, in a single
// canvas with a handful of options. Used by the slide deck so every graph on a slide is
// the real, live, draggable one. The layout is solved once per dataset and shared.
import { GraphModel } from './graph.js';
import { ForceLayout } from './layout.js';
import { GraphView } from './render.js';

const rawCache = new Map();
const posCache = new WeakMap();

export function loadRaw(url) {
  if (!rawCache.has(url)) rawCache.set(url, fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }));
  return rawCache.get(url);
}

/**
 * mount(canvas, raw, opts) -> controller
 * opts: edgeTypes[] (names, default all), nodeTypes[] (names, default all), kind (agency-kind filter),
 *       minDeg, f (0..1 position on the time axis), mode ('cumulative'|'active'), windowDays,
 *       sizeBy ('pagerank'|'live'|'uniform'), colorBy ('type'|'community'), labels (bool),
 *       select (node id), interactive (bool), onSelect(node|null), hideIsolated (bool)
 */
export function mount(canvas, raw, opts = {}) {
  const model = new GraphModel(raw);
  const layout = new ForceLayout(model);
  const o = {
    edgeTypes: null, nodeTypes: null, kind: '', minDeg: 0, f: 1, mode: 'cumulative', windowDays: 28,
    sizeBy: 'pagerank', colorBy: 'type', labels: true, select: null, interactive: true,
    hideIsolated: true, ...opts,
  };
  const typeColors = model.typeNames.map((t) => model.meta.nodeTypes[t].color || '#7d7c76');

  // layout: solve once per dataset, reuse everywhere
  if (posCache.has(raw)) {
    const p = posCache.get(raw);
    layout.x.set(p.x); layout.y.set(p.y); layout.alpha = 0;
  } else {
    layout.seed();
    const t0 = performance.now();
    while (layout.running && performance.now() - t0 < 2500) layout.step(40);
    posCache.set(raw, { x: layout.x.slice(), y: layout.y.slice() });
  }

  let sel = -1, hl = null;
  const tip = document.createElement('div');
  tip.className = 'gtip'; tip.hidden = true;
  canvas.parentElement.appendChild(tip);

  const view = new GraphView(canvas, {
    onSelect: (i) => select(i),
    onHover: (i, x, y) => {
      if (i < 0 || !o.interactive) { tip.hidden = true; return; }
      const nd = model.nodes[i];
      const a = nd.attrs || {};
      const bits = [model.meta.nodeTypes[nd.type].label];
      if (a.tickets) bits.push(`${a.tickets} tickets`);
      tip.replaceChildren();
      const b = document.createElement('b'); b.textContent = nd.label;
      const s = document.createElement('span'); s.textContent = bits.join(' · ');
      tip.append(b, s);
      const r = canvas.parentElement.getBoundingClientRect(), k = r.width / canvas.parentElement.clientWidth || 1;
      tip.style.left = Math.min((x - r.left) / k + 14, canvas.parentElement.clientWidth - 240) + 'px';
      tip.style.top = Math.max(4, (y - r.top) / k + 14) + 'px';
      tip.hidden = false;
    },
    onUser: () => {},
  });
  view.setModel(model, layout);
  if (!o.interactive) canvas.style.pointerEvents = 'none';

  const filterIdx = model.filters.findIndex((f) => f.key === 'kind');
  const state = () => ({
    t: model.timeRange[0] + o.f * (model.timeRange[1] - model.timeRange[0]),
    mode: o.mode, windowBuckets: model.series ? Math.max(1, Math.round((o.windowDays * 86400000) / model.series.stepMs)) : 1,
    nodeTypes: model.typeNames.map((t) => (o.nodeTypes ? o.nodeTypes.includes(t) : true)),
    edgeTypes: model.edgeTypeNames.map((t) => (o.edgeTypes ? o.edgeTypes.includes(t) : true)),
    includeUndated: true, hideIsolated: o.hideIsolated, minDeg: o.minDeg, comm: -1,
    filters: o.kind && filterIdx >= 0 ? [{ idx: filterIdx, value: o.kind }] : [],
  });

  function refresh(fit) {
    model.compute(state());
    view.updateAppearance({ sizeBy: o.sizeBy, colorBy: o.colorBy, t: state().t, typeColors, states: null });
    const nodes = new Uint8Array(model.n), edges = new Uint8Array(model.m), hot = new Set();
    let any = false;
    if (hl && hl.size) {
      hl.forEach((i) => { if (model.vis[i]) { nodes[i] = 1; hot.add(i); } });
      for (let e = 0; e < model.m; e++) if (model.evis[e] && nodes[model.eS[e]] && nodes[model.eT[e]]) edges[e] = 1;
      any = hot.size > 0;
    } else if (sel >= 0 && model.vis[sel]) {
      nodes[sel] = 1; hot.add(sel);
      for (const { node, edge } of model.neighbors(sel)) { nodes[node] = 1; edges[edge] = 1; hot.add(node); }
      any = true;
    }
    view.focus = any ? { nodes, edges, hot } : null;
    view.sel = sel; view.showLabels = o.labels;
    if (fit) view.fit(true, 36, true);
    view.invalidate();
  }

  function select(i) {
    sel = i; hl = null; refresh(false);
    if (o.onSelect) o.onSelect(i >= 0 ? model.nodes[i] : null, i >= 0 ? model.neighbors(i).length : 0);
    if (i >= 0) view.centerOn(i, Math.max(view.cam.k, 1.1));
  }

  let raf = 0, running = false;
  function loop() {
    if (!running) return;
    if (view.dirty || view.tween) { view.dirty = false; view.draw(); }
    raf = requestAnimationFrame(loop);
  }

  const api = {
    model, view, layout,
    set(patch, { fit = false } = {}) { Object.assign(o, patch); refresh(fit); },
    setF(f) { o.f = f; refresh(false); },
    select(id) { const i = id == null ? -1 : model.id2i.get(id); select(i == null ? -1 : i); },
    highlight(ids) { hl = new Set(ids.map((id) => model.id2i.get(id)).filter((i) => i != null)); sel = -1; refresh(false); },
    clear() { hl = null; sel = -1; refresh(false); },
    fit() { view.fit(true, 36, false); },
    start() { if (running) return; running = true; view.resize(); view.invalidate(); raf = requestAnimationFrame(loop); },
    stop() { running = false; cancelAnimationFrame(raf); },
    find(prefix) { return model.nodes.find((n) => n.label.startsWith(prefix) || n.id === prefix) || null; },
  };
  refresh(true);
  if (o.select) api.select(o.select);
  return api;
}
