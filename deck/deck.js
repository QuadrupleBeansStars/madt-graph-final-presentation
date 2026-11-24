// Slide deck: step-by-step reveals, live embedded graphs, every number read from data/*.json
// (traffy_story.json, traffy_insights.json, graphrag_demo.json) built by pipeline/*.py.
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
const BLUE = '#3987e5', ORANGE = '#d95926', GREEN = '#199e70', AMBER = '#e5a000', T1 = '#1a1a19', T2 = '#4a4943', MUTED = '#6f6e67', LINE = '#dcdad2';
const EXPLORER = 'explorer/index.html';
const en = (label) => (label.includes(' · ') ? label.split(' · ').slice(1).join(' · ') : label);       // English gloss if we have one
const th = (label) => label.split(' · ')[0].replace(/\s*\([A-Za-z .-]+\)/g, '');
const shortTh = (s) => s.replace(/ กทม\./g, '').replace(/\s+/g, ' ');

// ------------------------------------------------------------------ stage + navigation
const slides = $$('.slide');
let cur = 0, step = 0;
const stepsOf = (i) => +(slides[i].dataset.steps || 0);

function fit() {
  const s = Math.min(innerWidth / 1280, innerHeight / 720) * 0.985;
  document.documentElement.style.setProperty('--s', s.toFixed(4));
}
addEventListener('resize', fit); fit();

const onStep = {};
const onEnter = {};
function applySteps() {
  $$('.fx', slides[cur]).forEach((n) => n.classList.toggle('on', +n.dataset.s <= step));
  (onStep[cur] || (() => {}))(step);
}
function go(i, st = 0) {
  i = Math.max(0, Math.min(slides.length - 1, i));
  const prev = cur; cur = i; step = Math.min(st, stepsOf(i));
  slides.forEach((s, k) => { s.classList.toggle('active', k === i); s.classList.toggle('past', k < i); });
  $('#pgno').textContent = `${i + 1} / ${slides.length}`;
  $('#sfill').style.width = `${((i + 1) / slides.length) * 100}%`;
  $('#pgno').style.display = i === 0 ? 'none' : '';
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
$('#stage').addEventListener('click', (e) => {
  if (e.target.closest('canvas, button, a, .gw, .side, .ragpane, .edgetab, .chips, #nav')) return;
  next();
});

// ------------------------------------------------------------------ data
const base = (p) => new URL('../data/' + p, import.meta.url).href;
const [RAW, INS, ST, RD] = await Promise.all([
  loadRaw(base('traffy.json')),
  fetch(base('traffy_insights.json')).then((r) => r.json()),
  fetch(base('traffy_story.json')).then((r) => r.json()),
  fetch(base('graphrag_demo.json')).then((r) => r.json()),
]);
const B = ST.basics, F = ST.funnel, P = ST.police;
RAW.nodes.forEach((n) => { n.label = th(n.label); }); // slides show Thai names only
const inHand = new Set(); RAW.edges.forEach((e) => { if (e.type === 'handoff') { inHand.add(e.s); inHand.add(e.t); } });
const kinds = RAW.nodes.reduce((a, n, i) => { if (inHand.has(i)) a[n.type] = (a[n.type] || 0) + 1; return a; }, {});
const nodeById = new Map(RAW.nodes.map((n) => [n.id, n]));
const idByPrefix = (p) => (RAW.nodes.find((n) => n.id.startsWith(p)) || {}).id;
const idByLabel = (l) => (RAW.nodes.find((n) => n.label === th(l)) || {}).id;
const link = (hash) => `${EXPLORER}#${new URLSearchParams(hash).toString()}`;
const isPolice = (n) => /ตำรวจ|Police/.test(n.label) || n.label.startsWith('สน.');
const policeIds = RAW.nodes.filter((n) => n.type === 'Agency' && isPolice(n)).map((n) => n.id);
const ym = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
const T0 = B.span[0], T1_ = B.span[1];
const monthName = (t) => new Date(t).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });

// ------------------------------------------------------------------ simple text fills
$('#s-span').textContent = `${monthName(T0 < Date.UTC(2023,0,1) ? Date.UTC(2023,0,1) : T0)} – ${monthName(T1_)} · ${B.tickets.toLocaleString('en-US')} tickets`;
$('#t-tickets').textContent = (B.tickets / 1e6).toFixed(1) + 'M';
$('#t-perday').textContent = fmt(B.per_day);
$('#t-avg').textContent = B.avg_chain.toFixed(1);
$('#t-hotline').textContent = Math.round(B.hotline_pct) + '%';
$('#rag-n').textContent = fmt(B.tickets);
$('#d-nodes').textContent = `${kinds.Agency} agencies and ${kinds.District} district offices in the published graph.`;

// ------------------------------------------------------------------ slide 3: real rows
(function rowsTable() {
  const tb = $('#rows-table tbody');
  ST.examples.forEach((r) => {
    const tr = el('tr');
    [r.ticket_id, r.type, r.organization, r.district, r.state, r.timestamp].forEach((v) => tr.append(el('td', { title: v }, String(v))));
    tb.append(tr);
  });
  onStep[slides.indexOf($('#rows-table').closest('.slide'))] = (st) => { $('#rows-table').classList.toggle('hl', st >= 1); $('#rows-table').classList.toggle('pick', st >= 2); };
  const ex = ST.examples.find((e) => e.tag === 'police') || ST.examples[0];
  $('#z-id').textContent = `organization · ticket ${ex.ticket_id}`;
  const zs = $('#z-str');
  ex.raw_parts.forEach((p, i) => { if (i) zs.append(el('i', {}, ', ')); zs.append(el('span', {}, p)); });
  $('#z-tag').innerHTML = `<b>${ex.raw_parts.length} names in one string.</b> Read left to right it is a route, but the database sees only text. Across all tickets, <b>${Math.round(B.multi_agency_pct)}%</b> list more than one agency.`;
})();

// ------------------------------------------------------------------ slide 4: what SQL takes
$('#sq1').textContent = `${fmt(B.tickets)} strings`;
$('#sq2').textContent = `${fmt(B.tickets * B.avg_chain)} agency rows`;
$('#sq3').textContent = `${fmt(F.handoffs_total)} handoffs`;
$('#sq4').textContent = `${fmt(F.distinct_pairs)} edges`;
{
  const ex = ST.examples.find((e) => e.tag === 'police') || ST.examples[0];
  const P = ex.raw_parts, n = P.length;
  const chips = (xs) => xs.map((p, i) => `<span class="mc"><u>${i + 1}</u>${p}</span>`).join('');
  const demo = [
    `<span class="lb">ticket ${ex.ticket_id}</span> ${chips(P)}`,
    `<span class="lb">${n} rows for this one ticket</span> ${P.map((p, i) => `<span class="mc"><u>${i + 1}</u></span>`).join('')}`,
    `<span class="lb">${n - 1} handoffs</span> ${P.slice(1).map((p, i) => `<span class="mp">${i + 1}→${i + 2}</span>`).join('')}`,
    `<span class="lb">this ticket adds +1 to each of its ${n - 1} pairs; the other tickets add theirs</span>`
  ];
  const cnt = (a, b) => { const ia = RAW.nodes.findIndex((x) => x.id === a), ib = RAW.nodes.findIndex((x) => x.id === b); const e = RAW.edges.find((x) => x.type === 'handoff' && x.s === ia && x.t === ib); const m = e && /^([\d,]+) tickets/.exec(e.note || ''); return m ? m[1] : '—'; };
  const ids = ex.chain.map((c) => c.id);
  const cn = (i) => (i >= 1 ? cnt(ids[i - 2] || '', ids[i - 1] || '') : '—');
  const nm = (i) => `<span class="mc"><u>${i + 1}</u>${P[i]}</span>`;
  const tb = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const T = [
    tb(['ticket_id', 'organization'], [[ex.ticket_id.slice(5), `<span class="el">${P.join(', ')}</span>`]]),
    tb(['ticket_id', 'organization (list)'], [[ex.ticket_id.slice(5), `<span class="chs">${P.map((p, i) => `<span class="mc"><u>${i + 1}</u></span>`).join('')}</span>`]]),
    tb(['ticket_id', 'pos', 'agency'], P.map((p, i) => [ex.ticket_id.slice(5), i + 1, `<span class="el">${p}</span>`])),
    tb(['ticket_id', 'from', 'to'], P.slice(1).map((p, i) => [ex.ticket_id.slice(5), `<span class="el">${P[i]}</span>`, `<span class="el">${p}</span>`])),
    tb(['from', 'to', 'tickets'], P.slice(1).map((p, i) => [`<span class="el">${P[i]}</span>`, `<span class="el">${p}</span>`, cn(i + 1)]))
  ];
  const lab = ['', 'split', 'explode', 'pair', 'group + count'];
  const ba = $('#ba');
  onStep[slides.indexOf(ba.closest('.slide'))] = (st) => {
    ba.classList.toggle('on', st >= 1);
    if (st >= 1) ba.innerHTML = `<div class="bx"><h5>Before</h5>${T[st - 1]}</div><div class="arw">→<small>${lab[st]}</small></div><div class="bx"><h5>After</h5>${T[st]}</div>`;
  };
  ['sq1', 'sq2', 'sq3', 'sq4'].forEach((id, i) => { const row = $('#' + id).closest('.cl'); row.append(el('div', { class: 'ex' })); row.lastChild.innerHTML = demo[i]; });
}

// ------------------------------------------------------------------ slide 5: one ticket is a path
(function pathSlide() {
  const ex = ST.examples.find((e) => e.tag === 'police') || ST.examples[0];
  $('#p-meta').textContent = `Ticket ${ex.ticket_id} · ${ex.type} · ${ex.timestamp}`;
  const box = $('#pathviz');
  const gloss = (c) => c.en || (c.kind === 'D' ? 'district office' : c.node.startsWith('สน.') ? 'local police station' : c.node.includes('กองบังคับการ') ? 'police division' : '');
  const xl = el('div', { class: 'xl' });
  xl.append(el('div', { class: 'xh' }, el('span', {}, 'organization')));
  const xc = el('div', { class: 'xc' });
  const toks = ex.raw_parts.map((part, i) => {
    if (i) xc.append(el('i', {}, ', '));
    const t = el('span', { class: 'tk' }, shortTh(part)); xc.append(t); return t;
  });
  xc.append(el('em', { class: 'xfill' }));
  xl.append(xc);
  const ngrid = el('div', { class: 'ngrid' });
  const nodes = ex.chain.map((c, k) => {
    const node = el('div', { class: 'pnode' });
    if (k > 0) node.append(el('u', { class: 'parrow' }));
    node.append(el('i', { class: c.kind === 'D' ? 'd' : 'a' }), el('span', {}, clip((c.kind === 'D' ? 'เขต' : '') + th(shortTh(c.node.replace(/^[A-Z]:/, ''))), 24)));
    ngrid.append(node); return node;
  });
  box.append(el('div', { class: 'plab a' }, 'the cell'), xl, el('div', { class: 'plab b' }, 'the graph'), ngrid);
  const cols = null;
  const nR = Math.round(INS.root_in_chain_pct), nN = ex.chain.length;
  const caps = [
    `This is one cell of one row: an ordered list of ${ex.raw_parts.length} names.`,
    `<b>Drop the root.</b> “กรุงเทพมหานคร” (Bangkok Metropolitan Administration) is on ${nR}% of lists, so it says nothing about routing.`,
    'Each remaining name becomes a <b>node</b>. The first is a district office.',
    'The next name becomes a node, and an <b>arrow</b> joins the two: one handoff.',
    'Same again, in list order.',
    'Same again, in list order.',
    `${nN} nodes, ${nN - 1} handoffs: a <b>walk through the agencies</b>. We know the <em>order</em> of handoffs, not the minute of each.`,
  ];
  onStep[slides.indexOf(box.closest('.slide'))] = (st) => {
    $('#pcap').innerHTML = caps[Math.min(st, caps.length - 1)];
    toks.forEach((t, i) => {
      if (i === 0) t.classList.toggle('drop', st >= 1);
      else t.classList.toggle('used', st >= i + 1);
    });
    nodes.forEach((n, k) => n.classList.toggle('on', st >= k + 2));

  };
})();

// ------------------------------------------------------------------ slide 7: nodes and edges (real pair)
(function nodeViz() {
  const svg = $('#nodeviz');
  const pp = INS.ping_pong_examples[0];
  const idA = idByLabel(pp.a), idB = idByLabel(pp.b);
  const ia = RAW.nodes.findIndex((n) => n.id === idA), ib = RAW.nodes.findIndex((n) => n.id === idB);
  const eAB = RAW.edges.find((e) => e.type === 'handoff' && e.s === ia && e.t === ib);
  const A = { x: 130, y: 190 }, Bn = { x: 510, y: 190 };
  svg.append(sv('defs', {}, sv('marker', { id: 'ah2', viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto' }, sv('path', { d: 'M0 0L10 5L0 10z', fill: T1 }))));
  const g1 = sv('g', { class: 'fx', 'data-s': '1' });
  [[A, pp.a], [Bn, pp.b]].forEach(([p, lab]) => {
    g1.append(sv('circle', { cx: p.x, cy: p.y, r: 34, fill: GREEN, stroke: '#fff', 'stroke-width': 3 }));
    const fo = sv('foreignObject', { x: p.x - 110, y: p.y + 44, width: 220, height: 70 });
    const d = document.createElement('div'); d.style.cssText = 'font-size:15px;line-height:1.3;text-align:center;color:#1a1a19;font-family:inherit';
    d.textContent = th(lab); fo.append(d); g1.append(fo);
  });
  const call = (txt, x, y) => { const t = sv('text', { x, y, 'text-anchor': 'middle', fill: BLUE, 'font-size': 15, 'font-weight': 600 }); t.textContent = txt; return t; };
  g1.append(call('node', A.x, 130));
  svg.append(g1);
  const g2 = sv('g', { class: 'fx', 'data-s': '2' });
  g2.append(sv('path', { d: `M${A.x + 40} ${A.y - 14} Q320 ${A.y - 70} ${Bn.x - 42} ${A.y - 14}`, fill: 'none', stroke: T1, 'stroke-width': 9, 'marker-end': 'url(#ah2)' }));
  g2.append(call('edge = one handoff', 320, 92));
  svg.append(g2);
  const g3 = sv('g', { class: 'fx', 'data-s': '3' });
  g3.append(sv('path', { d: `M${Bn.x - 40} ${A.y + 14} Q320 ${A.y + 70} ${A.x + 42} ${A.y + 14}`, fill: 'none', stroke: T1, 'stroke-width': 4, 'marker-end': 'url(#ah2)' }));
  const lw = (txt, x, y) => { const t = sv('text', { x, y, 'text-anchor': 'middle', fill: T2, 'font-size': 15 }); t.textContent = txt; return t; };
  g3.append(lw(`${fmt(pp.a_to_b)} tickets →`, 320, 116)); g3.append(lw(`← ${fmt(pp.b_to_a)} tickets`, 320, 276));
  svg.append(g3);
  const g4 = sv('g', { class: 'fx', 'data-s': '4' });
  if (eAB && eAB.series) {
    const c = eAB.series.c, mx = Math.max(...c, 1), x0 = 230, w = 180, y0 = 330, h = 36;
    g4.append(sv('polyline', { fill: 'none', stroke: BLUE, 'stroke-width': 1.8, points: c.map((v, i) => `${x0 + (i / (c.length - 1 || 1)) * w},${y0 - (v / mx) * h}`).join(' ') }));
    g4.append(lw('weekly tickets on this edge', 320, 346));
  }
  svg.append(g4);
})();

// ------------------------------------------------------------------ slide 8: funnel
$('#funnel').append(...[
  [fmt(F.tickets), '', 'tickets, one row each', `with an ordered <code>organization</code> list (${fmt(F.raw_rows - F.tickets)} dropped: no district or timestamp)`, 0],
  [fmt(F.nodes_after_fold), 'g', 'nodes after cleaning', `${fmt(F.raw_org_names)} written names → drop the root, fold district-specific units into one role each`, 1],
  [fmt(F.distinct_pairs), 'g', 'distinct handoffs', `${fmt(F.handoffs_total)} consecutive pairs across all tickets, counted per (from, to)`, 2],
  [`${kinds.Agency + kinds.District} · ${fmt(F.kept_handoff_edges)}`, 'o', 'nodes · edges kept', `the handoff graph in this deck and the explorer. ${F.kept_agencies + F.kept_districts - kinds.Agency - kinds.District} more pass the cutoff but have no kept handoff; ${F.kept_categories} complaint categories sit in a second layer`, 3],
].map(([n, k, u, why, s]) => {
  const r = el('div', { class: 'fn fx', 'data-s': String(Math.min(s, 3)) });
  r.innerHTML = `<div class="bar ${k}">${n}</div><div class="why"><b>${u}</b><br>${why}</div>`;
  return r;
}));
slides[9].dataset.steps = '3';

// ------------------------------------------------------------------ slide 10: decisions
(function decisions() {
  $('#n-res').textContent = `${fmt(F.raw_org_names)} → ${fmt(F.nodes_after_fold)}`;
  $('#dec-res').textContent = 'Written names become nodes. The root is dropped, and district-specific units fold into one role each.';
  $('#n-prune').textContent = `${fmt(F.distinct_pairs)} → ${fmt(F.kept_handoff_edges)}`;
  const s = ST.sensitivity, lo = s[0], hi = s[2];
  $('#dec-prune').textContent = `Handoffs become edges. We keep agencies with ≥1,000 tickets and handoffs with ≥500. Sensitivity: the top-5 PageRank agencies keep ${Math.min(lo.overlap_with_published, hi.overlap_with_published)}+ of 5 at half and double the cutoffs.`;
  const ex = ST.examples.find((e) => e.tag === 'short') || ST.examples[0];
  const raw = ex.raw_parts.find((p) => p.includes('เขต') && p !== 'เขต' + ex.district && p !== 'กรุงเทพมหานคร');
  const folded = ex.chain.find((c) => c.kind === 'A');
  const box = $('#fold-ex');
  const row = (a, b) => { const d = el('div', { class: 'fe' }); d.append(el('span', {}, a), el('i', {}, '→'), el('span', { class: 'to' }, b)); return d; };
  if (raw && folded) box.append(row(raw, folded.short));
  box.append(row('ฝ่ายเทศกิจ เขตบางพลัด', 'ฝ่ายเทศกิจ (เขต)'), row('ฝ่ายเทศกิจ เขตสาทร', 'ฝ่ายเทศกิจ (เขต)'));
  box.append(el('p', { class: 'tiny' }, 'The district office itself (e.g. เขตบางพลัด) stays its own node.'));
})();

// ------------------------------------------------------------------ charts
function chartPolice() {
  const rows = P.by_year.filter((r) => r.year >= 2023);
  const W = 600, H = 340, pl = 44, pr = 150, pt = 40, pb = 40;
  const x = (i) => pl + (i * (W - pl - pr)) / (rows.length - 1), y = (v) => pt + (H - pt - pb) * (1 - v / 100);
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}` });
  const t = sv('text', { x: 0, y: 18, fill: T2, 'font-size': 14 }); t.textContent = 'Share of tickets finished within 90 days, by year created'; svg.append(t);
  [0, 50, 100].forEach((g) => {
    svg.append(sv('line', { x1: pl, x2: W - pr + 10, y1: y(g), y2: y(g), stroke: LINE, 'stroke-width': g === 0 ? 1.5 : 1 }));
    const tx_ = sv('text', { x: pl - 8, y: y(g) + 4, 'text-anchor': 'end', fill: MUTED, 'font-size': 12 }); tx_.textContent = g + '%'; svg.append(tx_);
  });
  const series = [['police_fin', ORANGE, 'Police-touched'], ['other_fin', BLUE, 'All other tickets']];
  let policeG = null;
  series.forEach(([k, col, name]) => {
    const g = sv('g', {}); svg.append(g);
    if (k === 'police_fin') { policeG = g; g.style.transition = 'opacity .5s'; g.style.opacity = 0; }
    g.append(sv('polyline', { fill: 'none', stroke: col, 'stroke-width': 3, points: rows.map((r, i) => `${x(i)},${y(r[k])}`).join(' ') }));
    rows.forEach((r, i) => {
      g.append(sv('circle', { cx: x(i), cy: y(r[k]), r: 5, fill: col, stroke: '#fcfcfb', 'stroke-width': 2 }));
      const v = sv('text', { x: x(i), y: y(r[k]) + (k === 'other_fin' ? -12 : 20), 'text-anchor': 'middle', fill: T1, 'font-size': 14, 'font-weight': 700 }); v.textContent = Math.round(r[k]) + '%'; g.append(v);
    });
    const last = rows[rows.length - 1];
    const lb = sv('text', { x: x(rows.length - 1) + 14, y: y(last[k]) + 5, fill: col === ORANGE ? '#a8420f' : '#1f5fb0', 'font-size': 15, 'font-weight': 600 }); lb.textContent = name; g.append(lb);
  });
  // reveal: all other tickets first, so the audience can guess where police-touched sits
  onStep[slides.indexOf($('#chart-police').closest('.slide'))] = (st) => { policeG.style.opacity = st >= 1 ? 1 : 0; };
  rows.forEach((r, i) => { const l = sv('text', { x: x(i), y: H - 18, 'text-anchor': 'middle', fill: T1, 'font-size': 14 }); l.textContent = r.year; svg.append(l); });
  const nn = sv('text', { x: pl, y: H - 2, fill: MUTED, 'font-size': 11 }); nn.textContent = `n = ${fmt(P.n_old)} tickets at least 120 days old`; svg.append(nn);
  $('#chart-police').append(svg);
}
function chartLen() {
  const rows = ST.length;
  const W = 600, H = 340, pl = 54, pb = 78, pt = 36, bw = 56, gap = (W - pl - 14 - rows.length * bw) / (rows.length - 1);
  const y = (v) => pt + (H - pt - pb) * (1 - v / 100);
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}` });
  [0, 50, 100].forEach((g) => {
    svg.append(sv('line', { x1: pl, x2: W - 6, y1: y(g), y2: y(g), stroke: LINE, 'stroke-width': g === 0 ? 1.5 : 1 }));
    const t = sv('text', { x: pl - 8, y: y(g) + 4, 'text-anchor': 'end', fill: MUTED, 'font-size': 12 }); t.textContent = g + '%'; svg.append(t);
  });
  const barGs = [];
  rows.forEach((r, i) => {
    const x = pl + 8 + i * (bw + gap), top = y(r.fin), hot = r.len >= 5;
    const bg = sv('g', {}); bg.style.transition = 'opacity .45s'; bg.style.opacity = 0; svg.append(bg); barGs.push(bg);
    bg.append(sv('rect', { x, y: top, width: bw, height: y(0) - top, rx: 5, fill: hot ? ORANGE : BLUE }));
    bg.append(sv('rect', { x, y: y(0) - 4, width: bw, height: 4, fill: hot ? ORANGE : BLUE }));
    const put = (txt, yy, size, w, c) => { const t = sv('text', { x: x + bw / 2, y: yy, 'text-anchor': 'middle', fill: c, 'font-size': size, 'font-weight': w }); t.textContent = txt; bg.append(t); };
    put(Math.round(r.fin) + '%', top - 8, 16, 700, T1);
    put(r.label, y(0) + 22, 15, 400, T1);
    put(`${r.median_days} d`, y(0) + 42, 13, 400, T2);
    put(`n=${fmt(r.n / 1000)}k`, y(0) + 60, 11, 400, MUTED);
  });
  const ax = sv('text', { x: 0, y: 18, fill: T2, 'font-size': 14 }); ax.textContent = 'Finished within 90 days, by number of agencies on the ticket'; svg.append(ax);
  const al = sv('text', { x: 4, y: y(0) + 42, fill: MUTED, 'font-size': 11 }); al.textContent = 'median days'; svg.append(al);
  $('#chart-len').append(svg);
  // reveal one bar per click, then the decision and the caveat
  const lenSlide = $('#chart-len').closest('.slide');
  onStep[slides.indexOf(lenSlide)] = (st) => barGs.forEach((g, i) => { g.style.opacity = st >= i + 1 ? 1 : 0; });
}
function chartEnds() {
  const rows = [...ST.end_groups].sort((a, b) => b.fin - a.fin);
  const W = 600, rowH = 40, H = rows.length * rowH + 46, pl = 168, max = 100;
  const anim = [];
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}` });
  const t = sv('text', { x: 0, y: 18, fill: T2, 'font-size': 14 }); t.textContent = 'Finished within 90 days, by the agency a ticket ends at'; svg.append(t);
  rows.forEach((r, i) => {
    const yy = 36 + i * rowH, w = ((W - pl - 120) * r.fin) / max;
    const outside = r.group === 'Police' || r.group === 'Other outside body';
    const col = outside ? ORANGE : r.group.startsWith('District') ? GREEN : BLUE;
    const l = sv('text', { x: pl - 10, y: yy + 19, 'text-anchor': 'end', fill: T1, 'font-size': 14 }); l.textContent = r.group; svg.append(l);
    const bar = sv('rect', { x: pl, y: yy + 4, width: w, height: 22, rx: 5, fill: col });
    bar.style.transformBox = 'fill-box'; bar.style.transformOrigin = 'left center'; svg.append(bar);
    const v = sv('text', { x: pl + w + 8, y: yy + 20, fill: T1, 'font-size': 15, 'font-weight': 700 }); v.textContent = Math.round(r.fin) + '%'; svg.append(v);
    const s = sv('text', { x: pl + w + 52, y: yy + 20, fill: MUTED, 'font-size': 12 }); s.textContent = `${r.share_pct}% of tickets`; svg.append(s);
    anim.push([bar, v, s]);
  });
  $('#chart-ends').append(svg);
  // bars grow to their value each time the slide is opened
  onEnter[slides.indexOf($('#chart-ends').closest('.slide'))] = () => anim.forEach(([bar, v, s], i) => {
    const o = { duration: 750, delay: i * 110, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' };
    bar.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], o);
    [v, s].forEach((n) => n.animate([{ opacity: 0 }, { opacity: 0 }, { opacity: 1 }], { ...o, duration: 900 }));
  });
}
chartPolice(); chartLen(); chartEnds();

// insight text blocks
const dec = (id, decision, who, track) => { $(id).innerHTML = `<p class="sw">${decision}</p><p class="wt">Track: ${track}</p>`; };
const pY = P.by_year.filter((r) => r.year >= 2023), p26 = pY[pY.length - 1], p24 = pY.find((r) => r.year === 2024);
dec('#dec-police', '<b>Close the loop.</b> Agree a status return with the police units, or stop routing tickets nobody closes.', 'BMA Traffy team with the Metropolitan Police liaison',
  `Police-touched finish rate, 2026: <b>${Math.round(p26.police_fin)}%</b> vs <b>${Math.round(p26.other_fin)}%</b>`);
$('#cav-police').textContent = `“Finished” is the Traffy status. Police may act without closing a ticket, so this tracks the loop. ${fmt(P.tickets)} tickets (${P.share_of_tickets_pct}%) touch a police unit.`;
$('#police-cap').innerHTML = `<b>${policeIds.length}</b> police units highlighted. Typical route: เขต → สน. → บช.น. → สำนักงานตำรวจแห่งชาติ → บก.น..`;

const L = ST.length, shortRow = L[1], longRow = L[L.length - 1];
const share5 = (L.filter((r) => r.len >= 5).reduce((a, r) => a + r.n, 0) / L.reduce((a, r) => a + r.n, 0));
dec('#dec-len', '<b>Route by category.</b> Send each category straight to the agency that fixes it; make a fifth hop an exception, not the default.', 'Traffy routing rules (BMA)',
  `Average agencies per ticket (now <b>${B.avg_chain.toFixed(1)}</b>) and the share with 5+ (<b>${Math.round(share5 * 100)}%</b>)`);
$('#cav-len').textContent = `Hard tickets may need more agencies, so this is a correlation. Only tickets at least 120 days old are counted.`;
const ex9 = ST.examples.find((e) => e.tag === 'long');
const present = ex9 ? ex9.chain.filter((c) => nodeById.has(c.id)).length : 0;
$('#long-cap').innerHTML = ex9 ? `One real ticket (${ex9.type}) passed through <b>${ex9.L}</b> agencies; ${present} of them are in the published graph (highlighted).` : '';

const eg = Object.fromEntries(ST.end_groups.map((g) => [g.group, g]));
dec('#dec-ends', '<b>Copy the district model.</b> Give outside bodies a return channel and publish their close rate beside the district units.', 'BMA with partner agencies',
  `Close rate outside the BMA, now <b>${Math.round(eg['Other outside body'].fin)}%</b>; police <b>${Math.round(eg.Police.fin)}%</b>`);
const ws = ST.endpoints.worst;
$('#cav-ends').textContent = `Grouped by the last agency on the list. Worst single end-points: ${ws.slice(0, 3).map((w) => `${en(w.name)} ${Math.round(w.fin)}%`).join(', ')}. District enforcement closes ${Math.round(ST.enforcement.fin_all)}% across ${ST.enforcement.districts} districts (range ${Math.round(ST.enforcement.fin_min)}–${Math.round(ST.enforcement.fin_max)}%).`;
$('#ends-cap').textContent = 'Switch the graph between district units and outside bodies to see where the tickets end.';

// appendix: summary, fingerprint, limits
(function appendix() {
  const f = ST.fingerprint, rn = f.random;
  const frows = [
    ['Nodes · links (largest piece)', `${f.nodes} · ${f.links}`, '—'],
    ['Density', f.density.toFixed(3), rn.density.toFixed(3)],
    ['Centralization (star = 1)', f.centralization.toFixed(2), '—'],
    ['Average path length · diameter', `${f.avg_path} · ${f.diameter}`, `${rn.avg_path} · —`],
    ['Clustering', f.clustering.toFixed(3), rn.clustering.toFixed(3)],
    [`Inside share (${f.communities} communities)`, f.inside_share.toFixed(2), rn.inside_share.toFixed(2)],
    ['Cycles (links − (N−1))', fmt(f.cycles), '—'],
  ];
  $('#fp-table tbody').append(...frows.map((r) => { const tr = el('tr'); r.forEach((c, i) => tr.append(el('td', i ? { class: 'num' } : {}, c))); return tr; }));
  const box = $('#fp-tests');
  box.innerHTML = `<h4>Chapter 8 tests, in order</h4><ul>${f.tests.map((t) => `<li><span class="${t.pass ? 'pass' : 'fail'}">${t.pass ? '✓' : '✗'}</span> <b>${t.shape}</b> — ${t.test}</li>`).join('')}</ul>
    <p class="tiny"><b>Reading:</b> no pure shape passes. Closest is core–periphery: the ${f.core_k} best-connected agencies are ${Math.round(f.block_density * 100)}% linked to each other, the rim only ${(f.rim_density * 100).toFixed(1)}%. Clustering is ${(f.clustering / rn.clustering).toFixed(0)}× a random graph’s, so the structure is real. Removing the top connector (${en(f.connector)}) leaves ${f.pieces_without_connector} piece.</p>`;
  const lim = [
    '<b>Finished</b> = status finished within 90 days, measured on tickets at least 120 days old.',
    'It is a Traffy status: police and outside bodies may act without closing a ticket.',
    'Correlation, not cause. Hard tickets may need more agencies.',
    'We assume the list order is the handoff order; the time of each handoff is not in the data.',
    `Inside one ticket agencies almost never repeat (${ST.revisit.pct}%), so “sent back” shows up as two-way edges across tickets.`,
    `Graph pruned to agencies ≥${fmt(F.thresholds.agency_min_tickets)} tickets and handoffs ≥${fmt(F.thresholds.handoff_min_tickets)}; top results hold at nearby cutoffs.`,
    'Data gate: comments, photos, addresses and coordinates are never loaded; raw files are not published.',
    'Graph RAG answers are pre-run and written from the retrieved context; a static site cannot hold an API key.',
    'Names are Thai; English glosses are ours.',
  ];
  $('#limits-list').innerHTML = lim.map((x) => `<li>${x}</li>`).join('');
})();

// ------------------------------------------------------------------ tasks (deep links)
const ID = { police: idByPrefix('A:กองบัญชาการตำรวจนครบาล (บช'), hotline: idByPrefix('A:ร้องทุกข์'), flood: idByPrefix('A:ศูนย์ควบคุมระบบป้องกันน้ำท่วม'), works: idByPrefix('A:สำนักการโยธา') };
$('#tasks').append(...[
  [link({ d: 'traffy', sel: ID.police }), 'Select the Metropolitan Police (บช.น.).', ' Who feeds it, and where does it send tickets next?'],
  [link({ d: 'traffy', sel: ID.hotline }), 'Select the 1555 hotline.', ' Then try Path from here… to Flood Control: how many handoffs?'],
  [link({ d: 'traffy', t: '2024-01-01' }), 'Drag the time slider back to January 2024.', ' Which routes had not appeared yet?'],
  [link({ d: 'traffy' }), 'Set “Agency kind” to External.', ' Which outside bodies receive tickets, and from whom?'],
].map(([href, a, rest]) => { const li = el('li'); li.append(el('a', { href }, a), rest); return li; }));

// ------------------------------------------------------------------ live graphs
const embeds = {};
const tween = (get, set, to, ms = 1100) => {
  const from = get(), t0 = performance.now();
  const f = (now) => { const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3); set(from + (to - from) * e); if (k < 1) requestAnimationFrame(f); };
  requestAnimationFrame(f);
};
function ensure(kind) {
  if (embeds[kind]) return embeds[kind];
  const slide = $(`[data-embed="${kind}"]`);
  const canvas = $('canvas', slide);
  let g;
  if (kind === 'bg') g = mount(canvas, RAW, { interactive: false, labels: false, edgeTypes: ['handoff'], hideIsolated: true });
  else if (kind === 'stack') { g = mount(canvas, RAW, { edgeTypes: ['handoff'], labels: false, sizeBy: 'live', f: 0.002 }); stackInit(g); }
  else if (kind === 'edgelist') { g = mount(canvas, RAW, { edgeTypes: ['handoff'], labels: false, hideIsolated: true }); edgeListInit(g); }
  else if (kind === 'metrics') { g = mount(canvas, RAW, { edgeTypes: ['handoff'], labels: false }); metricsInit(g); }
  else if (kind === 'police') { g = mount(canvas, RAW, { edgeTypes: ['handoff'], labels: false }); g.highlight(policeIds); }
  else if (kind === 'long') { g = mount(canvas, RAW, { edgeTypes: ['handoff'], labels: false }); const e = ST.examples.find((x) => x.tag === 'long'); if (e) g.highlight(e.chain.map((c) => c.id).filter((i) => nodeById.has(i))); }
  else if (kind === 'ends') { g = mount(canvas, RAW, { edgeTypes: ['handoff'], labels: false }); endsInit(g); }
  else if (kind === 'rag') { g = mount(canvas, RAW, { edgeTypes: ['handoff'], labels: true }); ragInit(g); }
  embeds[kind] = g; return g;
}

// slide 7: stack the paths, by number of tickets
function stackInit(g) {
  const [a, b] = g.model.timeRange, span = b - a;
  const DAY = 86400000, utc = (y, m, d) => Date.UTC(y, m - 1, d);
  const dstr = (t) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Bangkok' });
  const cumTickets = (t) => {
    if (t >= B.span[1]) return B.tickets;
    let s = 0;
    for (const [k, n] of B.months) {
      const m0 = Date.UTC(+k.slice(0, 4), +k.slice(5) - 1, 1), m1 = Date.UTC(+k.slice(0, 4), +k.slice(5), 1);
      if (t >= m1) s += n; else if (t > m0) s += n * ((t - m0) / (m1 - m0));
    }
    return s;
  };
  const idsOf = (e) => e.chain.map((c) => c.id).filter((i) => nodeById.has(i));
  const hero = ST.examples.find((e) => e.tag === 'police') || ST.examples[0];
  const longT = ST.examples.find((e) => e.tag === 'long') || ST.examples[2];
  const twoIds = [...new Set([...idsOf(hero), ...idsOf(longT)])];
  const heroIds = idsOf(hero), fourIds = [...new Set(ST.examples.flatMap(idsOf))];
  const pairsOf = (es) => [...new Set(es.flatMap((e) => { const ids = idsOf(e); return ids.slice(1).map((x, i) => ids[i] + '\t' + x); }))].map((k) => k.split('\t'));
  const stops = [
    { real: heroIds, pairs: pairsOf([hero]), tk: 1, label: '1 ticket', cap: 'One ticket is a path, the one from the last slide. It touches only a handful of agencies.' },
    { real: twoIds, pairs: pairsOf([hero, longT]), tk: 2, label: '2 tickets', cap: 'Add a second real ticket. Both pass through the Metropolitan Police and the Royal Thai Police, so their paths meet there.' },
    { real: fourIds, pairs: pairsOf(ST.examples), tk: 4, label: '4 tickets', cap: 'Four real tickets. The map is still sparse: most of the 230 agencies are on none of these paths.' },
    { t: a + 7 * DAY, cap: 'One week of tickets. The busy routes repeat so often that most of the map is already drawn.' },
    { t: utc(2023, 1, 31), cap: 'One month: the less common routes start to appear.' },
    { t: utc(2023, 12, 31), cap: 'One year: almost every agency and route is there. Later tickets mostly add traffic to routes that already exist.' },
    { t: b, cap: 'All 1.3 million tickets stacked: the full handoff graph.' },
  ];
  g.setF(1);
  stops.forEach((q) => {
    if (q.real) { g.only(q.real, q.pairs); q.n = g.model.visNodes; q.e = g.model.visEdges; g.only(null); }
    else { g.clear(); g.setF(Math.min(1, (q.t - a) / span)); q.tk = cumTickets(Math.min(q.t, B.span[1])); q.n = g.model.visNodes; q.e = g.model.visEdges; q.label = fmt(q.tk) + ' tickets'; q.sub = 'up to ' + dstr(Math.min(q.t, B.span[1])); }
  });
  const ladder = $('#stk-ladder');
  stops.forEach((q) => ladder.append(el('div', { class: 'lr' }, el('span', {}, q.label), el('b', {}, fmt(q.n)), el('i', {}, 'nodes'), el('b', {}, q.e == null ? '–' : fmt(q.e)), el('i', {}, 'edges'))));
  let f = 0.002, cur = -1;
  const draw = () => g.setF(f);
  g.stackTo = (st) => {
    const k = Math.min(st, stops.length - 1), q = stops[k];
    $('#stk-date').textContent = q.label;
    $('#stk-count').innerHTML = q.real ? `<b>${fmt(q.n)}</b> agencies · <b>${fmt(q.e)}</b> handoffs` : `<b>${fmt(q.n)}</b> nodes · <b>${fmt(q.e)}</b> edges`;
    $('#stk-cap').innerHTML = q.cap + (q.sub ? ` <span class="sub">(${q.sub})</span>` : '');
    $$('#stk-ladder .lr').forEach((r, i) => { r.classList.toggle('on', i <= k); r.classList.toggle('now', i === k); });
    if (q.real) { f = 1; g.set({ f: 1, labels: k === 0 }); g.only(q.real, q.pairs); g.fit(); }
    else {
      const wasReal = cur >= 0 && stops[cur].real;
      g.set({ labels: false }); g.only(null); g.clear();
      if (wasReal || cur < 0) { f = Math.min(1, (stops[3].t - a) / span); g.setF(f); g.fit(); }
      tween(() => f, (v) => { f = v; draw(); }, Math.min(1, (q.t - a) / span));
    }
    cur = k;
  };
  g.stackTo(0);
}
onStep[1] = (st) => $('#steps4').classList.toggle('focus', st >= 5);
onStep[7] = (st) => { const g = embeds.stack; if (g) g.stackTo(st); };

// slide 9: edge list <-> graph
function edgeListInit(g) {
  const tb = $('#edgetab tbody');
  INS.top_handoffs.slice(0, 7).forEach((h) => {
    const tr = el('tr');
    tr.append(el('td', {}, clip(th(h.from), 30)), el('td', {}, '→'), el('td', {}, clip(th(h.to), 30)), el('td', {}, fmt(h.tickets)));
    tr.onclick = () => {
      $$('tr', tb).forEach((r) => r.classList.toggle('on', r === tr));
      g.highlight([idByLabel(h.from), idByLabel(h.to)].filter(Boolean));
    };
    tb.append(tr);
  });
  $('#g9-count').innerHTML = `The published graph: <b>${fmt(g.model.visNodes)}</b> nodes, <b>${fmt(g.model.visEdges)}</b> edges (handoffs only).`;
}

// slide 11: five centralities
function metricsInit(g) {
  const C = ST.centrality;
  const META = {
    degree: ['Degree', 'Who has the most direct links?'],
    betweenness: ['Betweenness', 'Who is the bridge — the most routes pass through?'],
    closeness: ['Closeness', 'Who reaches everyone in the fewest steps?'],
    eigenvector: ['Eigenvector', 'Who is linked to the best-connected agencies?'],
    pagerank: ['PageRank', 'Who receives from agencies that matter? (arrows count)'],
  };
  const winners = new Set(Object.values(C).map((l) => l[0].id));
  const tab = $('#metric-all');
  Object.entries(META).forEach(([k, [name]]) => { const tr = el('tr', { 'data-k': k }); tr.append(el('td', {}, name), el('td', {}, clip(th(C[k][0].label), 38))); tab.append(tr); });
  const chips = $('#metric-chips');
  const show = (k) => {
    $$('.chip', chips).forEach((c) => c.classList.toggle('on', c.dataset.k === k));
    $$('tr', $('#metric-all')).forEach((r) => r.classList.toggle('on', r.dataset.k === k));
    $('#metric-q').textContent = META[k][1];
    $('#metric-top').replaceChildren(...C[k].map((x, i) => { const li = el('li'); li.innerHTML = `<b>${clip(th(x.label), 40)}</b> <span>${x.score.toFixed(3)}</span>`; if (i === 0) li.style.color = T1; return li; }));
    g.clear(); g.select(C[k][0].id);
  };
  Object.entries(META).forEach(([k, [name]]) => { const c = el('button', { class: 'chip', 'data-k': k }, name); c.onclick = () => show(k); chips.append(c); });
  $('#metric-note').innerHTML = `Same graph, same agencies: <b>${winners.size}</b> different winners across the five questions. Which metric is “right” depends on the decision.`;
  show('degree');
}

// slide 14: filter by who the ticket ends at
function endsInit(g) {
  const chips = $('#ends-chips');
  [['', 'All'], ['District unit', 'District units'], ['External', 'Outside bodies']].forEach(([k, name], i) => {
    const c = el('button', { class: 'chip' + (i === 0 ? ' on' : ''), 'data-k': k }, name);
    c.onclick = () => { $$('.chip', chips).forEach((x) => x.classList.toggle('on', x === c)); g.set({ edgeTypes: ['handoff'], kind: k }, { fit: true }); };
    chips.append(c);
  });
}

// slide 16: Graph RAG demo
function ragInit(g) {
  const chips = $('#rag-chips'), plain = $('#rag-plain');
  const show = (i) => {
    const q = RD.questions[i];
    $$('.chip', chips).forEach((c, k) => c.classList.toggle('on', k === i));
    $('#rag-q').textContent = q.question;
    $('#rag-facts').replaceChildren(...q.facts.slice(0, 5).map((f) => el('li', {}, clip(f, 200))));
    $('#rag-n-facts').textContent = `· ${q.facts.length} facts, ${q.highlight.length} nodes`;
    $('#rag-answer').textContent = q.answer;
    plain.innerHTML = `<h4>Plain RAG: top 3 rows of ${fmt(RD.index_rows)} sampled, by text similarity to “${q.question_th}”</h4>` +
      q.plain_rows.map((r) => `<div class="pr"><span>${r.ticket_id}</span><span>${clip(r.type, 44)} · ${clip(shortTh(r.organization), 60)}</span><span>${r.state}</span></div>`).join('') +
      '<p>Rows, not structure: nothing here says how common this is, where tickets stall, or who is upstream. A stronger embedding retriever would be more relevant but would still return individual rows.</p>';
    g.highlight(q.highlight);
  };
  RD.questions.forEach((q, i) => { const c = el('button', { class: 'chip', title: q.question }, ['Q1 · why stalls?', 'Q2 · who is hit?', 'Q3 · back and forth?'][i] || `Q${i + 1}`); c.onclick = () => show(i); chips.append(c); });
  $('#rag-toggle').onclick = () => { plain.hidden = !plain.hidden; $('#rag-toggle').textContent = plain.hidden ? 'Show what plain RAG retrieves' : 'Hide plain RAG'; };
  show(0);
}

function enter(i) {
  (onEnter[i] || (() => {}))();
  const k = slides[i].dataset.embed; if (!k) return;
  const g = ensure(k); g.start();
  if (k !== 'stack') g.fit();
}
function leave(i) {
  const k = slides[i].dataset.embed; if (!k || !embeds[k]) return;
  embeds[k].stop();
}

// ------------------------------------------------------------------ boot
const start = Math.max(0, Math.min(slides.length - 1, (parseInt(location.hash.slice(1), 10) || 1) - 1));
requestAnimationFrame(() => { go(start); });
