// Slide deck: step-by-step reveals, live embedded graphs, charts computed from data/traffy_insights.json.
import { loadRaw, mount } from '../explorer/js/embed.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === 'class' ? (n.className = v) : n.setAttribute(k, v);
  kids.forEach((c) => n.append(c));
  return n;
};
const sv = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  kids.forEach((c) => n.append(c));
  return n;
};
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const BLUE = '#3987e5', ORANGE = '#d95926', GREEN = '#199e70', AMBER = '#fab219', T2 = '#c3c2b7', MUTED = '#8e8d86', LINE = '#383835';
const EXPLORER = 'explorer/index.html';

// ------------------------------------------------------------------ stage + navigation
const slides = $$('.slide');
let cur = 0, step = 0;
const stepsOf = (i) => +(slides[i].dataset.steps || 0);

function fit() {
  const s = Math.min(innerWidth / 1280, innerHeight / 720) * 0.985;
  document.documentElement.style.setProperty('--s', s.toFixed(4));
}
addEventListener('resize', fit); fit();

function applySteps() {
  $$('.fx', slides[cur]).forEach((n) => n.classList.toggle('on', +n.dataset.s <= step));
  (onStep[cur] || (() => {}))(step);
}
function go(i, st = 0) {
  i = Math.max(0, Math.min(slides.length - 1, i));
  const prev = cur; cur = i; step = Math.min(st, stepsOf(i));
  slides.forEach((s, k) => { s.classList.toggle('active', k === i); s.classList.toggle('past', k < i); });
  $('#count').textContent = `${i + 1} / ${slides.length}`;
  $('#prog').style.width = `${((i + 1) / slides.length) * 100}%`;
  if (prev !== i) leave(prev);
  enter(i);
  applySteps();
  try { history.replaceState(null, '', '#' + (i + 1)); } catch (_) { /* ignore */ }
}
const next = () => (step < stepsOf(cur) ? (step++, applySteps()) : go(cur + 1));
const prev = () => (step > 0 ? (step--, applySteps()) : go(cur - 1, cur > 0 ? stepsOf(cur - 1) : 0));

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); next(); }
  else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); prev(); }
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(slides.length - 1);
  else if (e.key.toLowerCase() === 'f') {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
  }
});
document.addEventListener('fullscreenchange', () => document.body.classList.toggle('fs', !!document.fullscreenElement));
$('#next').onclick = next; $('#prev').onclick = prev;
let tx = null;
addEventListener('touchstart', (e) => { tx = e.touches[0].clientX; }, { passive: true });
addEventListener('touchend', (e) => {
  if (tx == null) return; const dx = e.changedTouches[0].clientX - tx; tx = null;
  if (Math.abs(dx) > 50) (dx < 0 ? next : prev)();
});
// click on the slide background (not on a graph / control) advances
$('#stage').addEventListener('click', (e) => {
  if (e.target.closest('canvas, button, a, .side, .gwrap, #nav')) return;
  next();
});

// ------------------------------------------------------------------ data
const [RAW, INS] = await Promise.all([
  loadRaw(new URL('../data/traffy.json', import.meta.url).href),
  fetch(new URL('../data/traffy_insights.json', import.meta.url)).then((r) => r.json()),
]);
const kinds = RAW.nodes.reduce((a, n) => { a[n.type] = (a[n.type] || 0) + 1; return a; }, {});
const nodeById = new Map(RAW.nodes.map((n) => [n.id, n]));
const idByPrefix = (p) => (RAW.nodes.find((n) => n.id.startsWith(p)) || {}).id;
const ID = {
  works: idByPrefix('A:สำนักการโยธา'), hotline: idByPrefix('A:ร้องทุกข์'),
  flood: idByPrefix('A:ศูนย์ควบคุมระบบป้องกันน้ำท่วม'),
};
const link = (hash) => `${EXPLORER}#${new URLSearchParams(hash).toString()}`;

// ------------------------------------------------------------------ text fills
const longShare = INS.by_chain_length.filter((r) => r.len >= 3).reduce((a, r) => a + r.tickets, 0) / INS.tickets;
$('#t-agencies').textContent = fmt(INS.distinct_raw_orgs);
$('#t-multi').textContent = Math.round(longShare * 100) + '%';
$('#t-hotline').textContent = Math.round(INS.via_hotline_pct) + '%';
$('#d-n').textContent = fmt(INS.tickets);
$('#d-recent').textContent = Math.round(INS.recent_share_90d * 100) + '%';
$('#ex-cat').textContent = INS.example.categories.join(', ');

// raw organisation chips (slide 3)
const rawParts = INS.example.raw_org.split(/,\s*/);
const shortTh = (s) => s.replace(/ กทม\./g, '').replace(/\s+/g, ' ');
$('#rawchips-mini').append(...rawParts.map((p) => el('span', { class: 'rc' }, clip(shortTh(p), 38))));

// ------------------------------------------------------------------ slide 4: one row = one path
const onStep = {};
(function pathSlide() {
  const box = $('#pathviz');
  const dist = INS.example.district.replace(/^เขต/, '');
  const chips = el('div', { class: 'chips fx', 'data-s': '1' });
  const chipEls = rawParts.map((p) => {
    const c = el('span', { class: 'rc' }, clip(shortTh(p), 44));
    c.dataset.raw = clip(shortTh(p), 44);
    const root = p === 'กรุงเทพมหานคร';
    const folds = !root && p !== 'เขต' + dist && p.includes(dist);
    c.dataset.kind = root ? 'drop' : folds ? 'fold' : '';
    c.dataset.folded = folds ? clip(shortTh(p).replace('เขต' + dist, '(เขต)').replace(dist, '(เขต)'), 44) : '';
    chips.append(c);
    return c;
  });
  box.append(chips);

  const fe = chipEls.find((c) => c.dataset.kind === 'fold'); if (fe) $('#fold-ex').textContent = shortTh(rawParts[chipEls.indexOf(fe)]);
  const chain = INS.example.chain;
  const W = 1150, H = 190, n = chain.length, xs = chain.map((_, i) => 80 + (i * (W - 160)) / (n - 1));
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fx', 'data-s': '3' });
  svg.style.marginTop = '14px'; svg.style.height = '190px';
  const defs = sv('defs', {}, sv('marker', { id: 'ah', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' },
    sv('path', { d: 'M0 0L10 5L0 10z', fill: '#f0efec' })));
  svg.append(defs);
  xs.slice(1).forEach((x, i) => svg.append(sv('line', { x1: xs[i] + 22, y1: 40, x2: x - 24, y2: 40, stroke: '#f0efec', 'stroke-width': 2.2, 'marker-end': 'url(#ah)' })));
  chain.forEach((label, i) => {
    const isD = label.startsWith('เขต');
    svg.append(sv('circle', { cx: xs[i], cy: 40, r: 18, fill: isD ? BLUE : GREEN, stroke: '#1a1a19', 'stroke-width': 2 }));
    const fo = sv('foreignObject', { x: xs[i] - 82, y: 68, width: 164, height: 110 });
    const d = document.createElement('div');
    d.style.cssText = 'font-size:15px;line-height:1.3;color:#c3c2b7;text-align:center;overflow-wrap:anywhere;font-family:inherit';
    d.textContent = label; fo.append(d); svg.append(fo);
  });
  box.append(svg);
  onStep[slides.indexOf(box.closest('.slide'))] = (st) => {
    chipEls.forEach((c) => {
      const k = c.dataset.kind;
      c.classList.toggle('drop', st >= 2 && k === 'drop');
      c.classList.toggle('fold', st >= 2 && k === 'fold');
      c.textContent = st >= 2 && k === 'fold' ? c.dataset.folded : c.dataset.raw;
    });
  };
})();

// ------------------------------------------------------------------ slide 5: principles
const glyph = (inner) => `<svg viewBox="0 0 300 74">${inner}</svg>`;
const C = (x, y, r, f) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${f}"/>`;
const L = (x1, y1, x2, y2, w = 2, c = '#8e8d86', ex = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${w}" ${ex}/>`;
const ARR = '<defs><marker id="pa" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#f0efec"/></marker></defs>';
const PRIN = [
  { t: 'Nodes and directed edges', p: 'An agency is a node. A handoff is an arrow from the agency that passed the ticket to the one that received it.', q: 'Who passes to whom?',
    g: glyph(ARR + L(95, 37, 195, 37, 2.4, '#f0efec', 'marker-end="url(#pa)"') + C(80, 37, 15, GREEN) + C(210, 37, 15, GREEN)) },
  { t: 'Weight and time', p: 'Edge width = tickets per week. The time slider replays how the network built up.', q: 'When did this route start to matter?',
    g: glyph(L(40, 16, 260, 16, 1, '#8e8d86') + L(40, 36, 260, 36, 3, '#8e8d86') + L(40, 58, 260, 58, 7, '#8e8d86')) },
  { t: 'Centrality', p: 'Degree: busy. PageRank: well connected. Betweenness: sitting on many routes between others.', q: 'Who is a bottleneck?',
    g: glyph(L(150, 37, 70, 14) + L(150, 37, 70, 60) + L(150, 37, 230, 14) + L(150, 37, 230, 60) + L(150, 37, 40, 37) + L(150, 37, 260, 37) + C(150, 37, 17, AMBER) + [70, 230].map((x) => C(x, 14, 7, GREEN) + C(x, 60, 7, GREEN)).join('') + C(40, 37, 6, GREEN) + C(260, 37, 6, GREEN)) },
  { t: 'Paths and length', p: 'A ticket’s chain is a walk through the graph. Its length counts the handoffs; a shortest path shows the direct route.', q: 'Is there a shorter way?',
    g: glyph(L(50, 50, 120, 50) + L(120, 50, 190, 50) + L(190, 50, 250, 50) + L(50, 50, 250, 18, 2, AMBER, 'stroke-dasharray="5 4"') + [50, 120, 190, 250].map((x) => C(x, 50, 9, GREEN)).join('') + C(250, 18, 9, AMBER)) },
  { t: 'Reciprocity', p: 'When A→B and B→A both exist, responsibility has no clear direction.', q: 'Who is the right owner?',
    g: glyph(ARR + '<path d="M95 28 Q150 6 205 28" fill="none" stroke="#f0efec" stroke-width="2.2" marker-end="url(#pa)"/><path d="M205 46 Q150 68 95 46" fill="none" stroke="#f0efec" stroke-width="2.2" marker-end="url(#pa)"/>' + C(80, 37, 15, GREEN) + C(220, 37, 15, GREEN)) },
  { t: 'Communities', p: 'Louvain finds groups of agencies that mostly pass tickets among themselves.', q: 'Which agencies work as a team?',
    g: glyph(L(40, 20, 80, 50) + L(80, 50, 60, 66, 2) + L(40, 20, 60, 66) + L(200, 20, 240, 50) + L(240, 50, 220, 66) + L(200, 20, 220, 66) + L(80, 50, 200, 20, 1, '#555') +
      [[40, 20], [80, 50], [60, 66]].map(([x, y]) => C(x, y, 9, BLUE)).join('') + [[200, 20], [240, 50], [220, 66]].map(([x, y]) => C(x, y, 9, ORANGE)).join('')) },
];
$('#principles').append(...PRIN.map((p, i) => {
  const c = el('div', { class: 'card fx', 'data-s': String(Math.floor(i / 2)) });
  c.innerHTML = `${p.g}<h3>${p.t}</h3><p>${p.p}</p><p class="ask">${p.q}</p>`;
  return c;
}));

// ------------------------------------------------------------------ slide 6: funnel
(function funnel() {
  const rows = [
    ['5,000', '', 'tickets', `each one a row with an ordered <code>organization</code> list`, 0],
    [fmt(INS.distinct_raw_orgs), 'g', 'agency names', `as written. Many are the same role repeated per district (“ฝ่ายโยธา เขต…”)`, 1],
    [fmt(INS.distinct_nodes_after_fold), 'g', 'nodes after cleaning', `<b>drop the root</b>, <b>fold</b> district units into roles, keep 50 district offices`, 2],
    [`${fmt(INS.graph.nodes)} · ${fmt(INS.graph.edges)}`, 'o', 'nodes · edges kept', `agencies in ≥8 tickets, handoffs in ≥3 tickets, categories with ≥5`, 3],
  ];
  $('#funnel').append(...rows.map(([n, k, u, why, s]) => {
    const r = el('div', { class: 'fn fx', 'data-s': String(s) });
    r.innerHTML = `<div class="bar ${k}">${n}</div><div class="why"><b>${u}</b><br>${why}</div>`;
    return r;
  }));
  const rowsT = $$('.mini tbody tr');
  const byType = (t) => RAW.nodes.filter((n) => n.type === t).length;
  rowsT[0].children[1].textContent = `${byType('District')} nodes · tickets, median days`;
  rowsT[1].children[1].textContent = `${byType('Agency')} nodes · kind, tickets, finish rate`;
  rowsT[2].children[1].textContent = `${byType('Category')} nodes · agencies touched`;
})();

// ------------------------------------------------------------------ charts
function barChartLen() {
  const rows = INS.by_chain_length.filter((r) => r.finished_pct != null);
  const W = 760, H = 430, pl = 92, pb = 78, pt = 34, bw = 70, gap = (W - pl - 20 - rows.length * bw) / (rows.length - 1);
  const y = (v) => pt + (H - pt - pb) * (1 - v / 100);
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}` });
  [0, 50, 100].forEach((g) => {
    svg.append(sv('line', { x1: pl, x2: W - 10, y1: y(g), y2: y(g), stroke: LINE, 'stroke-width': g === 0 ? 1.5 : 1 }));
    const t = sv('text', { x: pl - 8, y: y(g) + 4, 'text-anchor': 'end', fill: MUTED, 'font-size': 13 }); t.textContent = g + '%'; svg.append(t);
  });
  rows.forEach((r, i) => {
    const x = pl + 10 + i * (bw + gap), top = y(r.finished_pct), hot = r.len >= 5;
    svg.append(sv('rect', { x, y: top, width: bw, height: y(0) - top, rx: 5, fill: hot ? ORANGE : BLUE }));
    svg.append(sv('rect', { x, y: y(0) - 4, width: bw, height: 4, fill: hot ? ORANGE : BLUE }));
    const v = sv('text', { x: x + bw / 2, y: top - 8, 'text-anchor': 'middle', fill: '#f0efec', 'font-size': 18, 'font-weight': 700 }); v.textContent = r.finished_pct + '%'; svg.append(v);
    const lb = sv('text', { x: x + bw / 2, y: y(0) + 24, 'text-anchor': 'middle', fill: '#f0efec', 'font-size': 16 }); lb.textContent = r.label; svg.append(lb);
    const nn = sv('text', { x: x + bw / 2, y: y(0) + 44, 'text-anchor': 'middle', fill: MUTED, 'font-size': 12 }); nn.textContent = `n=${r.n_old}`; svg.append(nn);
    const md = sv('text', { x: x + bw / 2, y: y(0) + 62, 'text-anchor': 'middle', fill: T2, 'font-size': 12 }); md.textContent = r.median_days != null ? `${r.median_days} d` : ''; svg.append(md);
  });
  const ax = sv('text', { x: pl, y: 20, fill: T2, 'font-size': 14 }); ax.textContent = 'Share finished, by number of agencies on the ticket (tickets ≥ 30 days old)'; svg.append(ax);
  const al = sv('text', { x: 0, y: y(0) + 62, fill: MUTED, 'font-size': 12 }); al.textContent = 'median days'; svg.append(al);
  $('#chart-len').append(svg);
  const s = INS.short_vs_long['short(<=3)'], l = INS.short_vs_long['long(>=5)'];
  $('#len-text').innerHTML = `Tickets with <b>3 or fewer</b> agencies: <b>${s.finished_pct}%</b> finished, median ${s.median_days} days. With <b>5 or more</b>: <b>${l.finished_pct}%</b> finished, median ${l.median_days} days. Tickets with a single agency (n=${rows[0].n_old}, too few to read much into) are rarely finished — possibly never routed on.`;
}
barChartLen();

function barChartCat() {
  const cats = [...INS.categories].sort((a, b) => b.agencies - a.agencies).slice(0, 10);
  const W = 760, rowH = 38, H = cats.length * rowH + 44, pl = 250, max = Math.max(...cats.map((c) => c.agencies));
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}` });
  const ttl = sv('text', { x: 0, y: 16, fill: T2, 'font-size': 14 }); ttl.textContent = 'Distinct agencies reached by each complaint category (top 10)'; svg.append(ttl);
  cats.forEach((c, i) => {
    const y = 36 + i * rowH, w = ((W - pl - 190) * c.agencies) / max;
    const th = c.category.split(' · ');
    const t = sv('text', { x: pl - 12, y: y + 20, 'text-anchor': 'end', fill: '#f0efec', 'font-size': 15 }); t.textContent = clip(th[1] || th[0], 26); svg.append(t);
    svg.append(sv('rect', { x: pl, y: y + 4, width: w, height: 24, rx: 5, fill: GREEN }));
    const v = sv('text', { x: pl + w + 8, y: y + 21, fill: '#f0efec', 'font-size': 15, 'font-weight': 700 }); v.textContent = c.agencies; svg.append(v);
    const k = sv('text', { x: pl + w + 8 + String(c.agencies).length * 9 + 8, y: y + 21, fill: MUTED, 'font-size': 12 }); k.textContent = `${fmt(c.tickets)} tickets`; svg.append(k);
  });
  $('#chart-cat').append(svg);
  const hi = cats[0], lo = [...INS.categories].sort((a, b) => a.agencies - b.agencies)[0];
  $('#cat-text').innerHTML = `<b>${clip(hi.category.split(' · ')[1] || hi.category, 30)}</b> tickets reached <b>${hi.agencies}</b> different agencies; <b>${clip(lo.category.split(' · ')[1] || lo.category, 30)}</b> reached only <b>${lo.agencies}</b>.`;
}
barChartCat();

(function rankLists() {
  $('#pingpong').append(...INS.ping_pong_examples.slice(0, 5).map((p) => {
    const d = el('div', { class: 'pp' });
    d.innerHTML = `<div class="a">${clip(shortTh(p.a), 44)}</div><div class="mid"><i>⇄</i><b>${p.a_to_b}</b> → · ← <b>${p.b_to_a}</b></div><div class="b">${clip(shortTh(p.b), 44)}</div>`;
    return d;
  }));
  const h = $('h4.sub'); if (h) h.insertAdjacentHTML('beforeend', ` <span class="muted">· ${INS.bidirectional_pairs} of ${fmt(INS.handoff_edges)} edges</span>`);
  $('#between').append(...INS.top_betweenness.slice(0, 5).map((b) => {
    const li = el('li'); li.innerHTML = `${clip(shortTh(b.agency), 42)} <span>${b.score.toFixed(3)}</span>`; return li;
  }));
})();

(function ragLines() {
  const cid = RAW.nodes.find((n) => n.id === 'C:ผิดกฎจราจร');
  if (!cid) return;
  const idx = RAW.nodes.indexOf(cid);
  const rows = RAW.edges.filter((e) => e.type === 'routed_to' && (e.s === idx || e.t === idx))
    .map((e) => ({ n: RAW.nodes[e.s === idx ? e.t : e.s], k: parseInt((e.note || '0').split(' ')[0], 10) }))
    .sort((a, b) => b.k - a.k).slice(0, 5);
  $('#rag-lines').append(...rows.map(({ n, k }) => {
    const a = n.attrs || {};
    const d = el('div', { class: 'rl' });
    d.innerHTML = `<i>→</i><div>${clip(shortTh(n.label), 60)}</div><span>${k} tickets${a.median_days_total ? ` · median ${a.median_days_total} d` : ''}${a['finished_pct_(tickets_30d+)'] ? ` · ${a['finished_pct_(tickets_30d+)']}% finished` : ''}</span>`;
    return d;
  }));
})();

// tasks (deep links into the explorer)
$('#tasks').append(...[
  [link({ d: 'traffy', sel: ID.works }), 'Select Public Works.', ' Which agencies does it pass tickets to — and which pass to it?'],
  [link({ d: 'traffy', sel: ID.hotline }), 'Select the 1555 hotline.', ' How many agencies are one handoff away? Then try Path from here… to Flood Control.'],
  [link({ d: 'traffy', t: '2026-09-01' }), 'Drag the time slider back to September 2026.', ' Which routes had not appeared yet?'],
  [link({ d: 'traffy' }), 'Set “Agency kind” to External.', ' Which outside bodies (police, utilities) receive tickets?'],
].map(([href, a, rest]) => { const li = el('li'); const x = el('a', { href }, a); li.append(x, rest); return li; }));

// ------------------------------------------------------------------ live graphs
const embeds = {};
function ensure(kind) {
  if (embeds[kind]) return embeds[kind];
  const slide = $(`[data-embed="${kind}"]`);
  const canvas = $('canvas', slide);
  let g;
  if (kind === 'bg') {
    g = mount(canvas, RAW, { interactive: false, labels: false, edgeTypes: ['handoff'], hideIsolated: true });
  } else if (kind === 'full') {
    g = mount(canvas, RAW, { labels: true, hideIsolated: true });
    $('#g1-count').innerHTML = `<b>${fmt(g.model.visNodes)}</b> nodes · <b>${fmt(g.model.visEdges)}</b> edges`;
  } else if (kind === 'focus') {
    g = mount(canvas, RAW, { edgeTypes: ['handoff'], labels: true });
    focusInit(g);
  } else if (kind === 'time') {
    g = mount(canvas, RAW, { edgeTypes: ['handoff'], labels: false, sizeBy: 'live', f: 1 });
    timeInit(g);
  }
  embeds[kind] = g; return g;
}

function focusInit(g) {
  const text = $('#focus-text');
  const state = (k) => {
    $$('#focus-chips .chip').forEach((c) => c.classList.toggle('on', c.dataset.k === k));
    g.clear();
    if (k === 'handoff') g.set({ edgeTypes: ['handoff'], kind: '' }, { fit: true });
    if (k === 'bureau') g.set({ edgeTypes: ['handoff'], kind: 'Bureau' }, { fit: true });
    if (k === 'works') { g.set({ edgeTypes: ['handoff'], kind: '' }, { fit: true }); g.select(ID.works); }
    if (k === 'cats') g.set({ edgeTypes: ['handoff', 'routed_to'], kind: '' }, { fit: true });
    const m = g.model;
    const nv = fmt(m.visNodes), ev = fmt(m.visEdges);
    text.innerHTML = {
      handoff: `<b>${nv}</b> nodes, <b>${ev}</b> handoff edges. Still dense — but a few hubs stand out.`,
      bureau: `Only the bureaus and the handoffs between them: <b>${nv}</b> nodes, <b>${ev}</b> edges. A filter turns the hairball into something you can read.`,
      works: `Public Works (สำนักการโยธา) is connected to <b>${m.neighbors(m.id2i.get(ID.works)).length}</b> others. Highlighting one node and its neighbours is how you read a dense graph.`,
      cats: `Adding “routed to” links each category to every agency it reached: <b>${ev}</b> edges. More information, less readability — so we filter.`,
    }[k];
  };
  $$('#focus-chips .chip').forEach((c) => { c.onclick = () => state(c.dataset.k); });
  g.state = state; state('handoff');
}

function timeInit(g) {
  const [a, b] = g.model.timeRange, span = b - a, recent = Math.max(0, 1 - (120 * 86400000) / span);
  let range = 'recent', f0 = recent, f = recent, t0 = 0, playing = false;
  const draw = () => {
    g.setF(f);
    const t = a + f * span;
    $('#time-date').textContent = new Date(t).toISOString().slice(0, 10);
    $('#time-count').innerHTML = `<b>${fmt(g.model.visNodes)}</b> nodes · <b>${fmt(g.model.visEdges)}</b> handoff edges`;
  };
  const tick = (now) => {
    if (!playing) return;
    f = f0 + ((now - t0) / (range === 'recent' ? 9000 : 14000)) * (1 - f0);
    if (f >= 1) { f = 1; playing = false; }
    draw(); if (playing) requestAnimationFrame(tick);
  };
  const play = () => { f0 = range === 'recent' ? recent : 0; f = f0; t0 = performance.now(); playing = true; draw(); requestAnimationFrame(tick); };
  g.play = play; g.pause = () => { playing = false; };
  $$('.chip[data-r]').forEach((c) => { c.onclick = () => { range = c.dataset.r; $$('.chip[data-r]').forEach((x) => x.classList.toggle('on', x === c)); play(); }; });
  $('#time-replay').onclick = play;
  f = recent; draw();
}

function enter(i) {
  const k = slides[i].dataset.embed; if (!k) return;
  const g = ensure(k); g.start();
  if (k === 'time') g.play(); else g.fit();
}
function leave(i) {
  const k = slides[i].dataset.embed; if (!k || !embeds[k]) return;
  embeds[k].stop(); if (embeds[k].pause) embeds[k].pause();
}

// ------------------------------------------------------------------ boot
const start = Math.max(0, Math.min(slides.length - 1, (parseInt(location.hash.slice(1), 10) || 1) - 1));
requestAnimationFrame(() => { go(start); setTimeout(() => ensure('full'), 400); });
