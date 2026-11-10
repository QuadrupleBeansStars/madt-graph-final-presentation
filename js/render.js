// GraphView: canvas renderer + pointer interaction (pan, zoom, drag nodes, click, hover).
import { THEME } from './theme.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class GraphView {
  constructor(canvas, hooks) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks;
    this.cam = { x: 0, y: 0, k: 1 };
    this.w = 800; this.h = 600; this.dpr = 1;
    this.dirty = true;
    this.sel = -1; this.hover = -1;
    this.focus = null;            // {nodes:Uint8Array, edges:Uint8Array, hot:Set} | null
    this.path = null;             // {nodes:[], edges:[]} | null
    this.matches = null;          // Set of node indices (search)
    this.showLabels = true;
    this.drag = null;
    this.tween = null;
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  setModel(model, layout) {
    this.model = model; this.layout = layout;
    const N = model.n;
    this.sx = new Float32Array(N); this.sy = new Float32Array(N);
    this.rad = new Float32Array(N).fill(4);
    this.col = new Array(N).fill(THEME.neutral);
    this.sel = -1; this.hover = -1; this.focus = null; this.path = null; this.matches = null;
    this.invalidate();
  }

  invalidate() { this.dirty = true; }

  resize() {
    const p = this.cv.parentElement;
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(100, p.clientWidth); this.h = Math.max(100, p.clientHeight);
    this.cv.width = Math.round(this.w * this.dpr); this.cv.height = Math.round(this.h * this.dpr);
    this.cv.style.width = this.w + 'px'; this.cv.style.height = this.h + 'px';
    this.invalidate();
  }

  // ------------------------------------------------------------------ appearance
  /** Recompute node radius + colour for the current slider time / modes. */
  updateAppearance({ sizeBy, colorBy, t, typeColors, states }) {
    const m = this.model, N = m.n, rad = this.rad, col = this.col;
    let maxL = 1;
    if (sizeBy === 'live') for (let i = 0; i < N; i++) if (m.vis[i] && m.ldeg[i] > maxL) maxL = m.ldeg[i];
    for (let i = 0; i < N; i++) {
      if (!m.vis[i]) continue;
      rad[i] = sizeBy === 'uniform' ? 4.5
        : sizeBy === 'live' ? 2.4 + 12 * Math.sqrt(m.ldeg[i] / maxL)
        : 2.4 + 12 * Math.sqrt(m.pr[i]);
      let c;
      if (colorBy === 'community') { const ci = m.comm[i]; c = ci < THEME.cat.length ? THEME.cat[ci] : THEME.neutral; }
      else if (colorBy === 'state') {
        const st = m.stateAt(i, t);
        c = st && states && states[st] ? states[st].color : THEME.neutral;
        if (!st) c = '#5d5c56';
      } else c = typeColors[m.nType[i]];
      col[i] = c;
    }
    // edge width bucket (0-3) from live weight, normalised per edge type
    const E = m.m;
    if (!this.ebk || this.ebk.length !== E) this.ebk = new Uint8Array(E);
    const maxW = new Float32Array(m.edgeTypeNames.length).fill(1);
    for (let e = 0; e < E; e++) if (m.evis[e] && m.ew[e] > maxW[m.eType[e]]) maxW[m.eType[e]] = m.ew[e];
    for (let e = 0; e < E; e++) {
      if (!m.evis[e]) continue;
      const u = Math.sqrt(m.ew[e] / maxW[m.eType[e]]);
      this.ebk[e] = u > 0.75 ? 3 : u > 0.5 ? 2 : u > 0.25 ? 1 : 0;
    }
    this.invalidate();
  }

  // ------------------------------------------------------------------ camera
  w2s(x, y) { return [(x - this.cam.x) * this.cam.k + this.w / 2, (y - this.cam.y) * this.cam.k + this.h / 2]; }
  s2w(x, y) { return [(x - this.w / 2) / this.cam.k + this.cam.x, (y - this.h / 2) / this.cam.k + this.cam.y]; }
  screenR(i) { return Math.max(1.3, this.rad[i] * Math.pow(this.cam.k, 0.45)); }

  fit(onlyVisible = true, pad = 60, instant = false) {
    const { model: m, layout: L } = this;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity, n = 0;
    for (let i = 0; i < m.n; i++) {
      if (onlyVisible && !m.vis[i]) continue;
      n++;
      a = Math.min(a, L.x[i]); c = Math.max(c, L.x[i]);
      b = Math.min(b, L.y[i]); d = Math.max(d, L.y[i]);
    }
    if (!n) return;
    const bw = Math.max(40, c - a), bh = Math.max(40, d - b);
    const k = clamp(Math.min((this.w - pad * 2) / bw, (this.h - pad * 2) / bh), 0.02, 12);
    if (instant) { this.cam.x = (a + c) / 2; this.cam.y = (b + d) / 2; this.cam.k = k; this.tween = null; this.invalidate(); }
    else this.animateTo((a + c) / 2, (b + d) / 2, k);
  }

  animateTo(x, y, k, ms = 350) {
    this.tween = { x0: this.cam.x, y0: this.cam.y, k0: this.cam.k, x, y, k, t0: performance.now(), ms };
    this.invalidate();
  }
  centerOn(i, zoom) {
    this.animateTo(this.layout.x[i], this.layout.y[i], zoom ?? Math.max(this.cam.k, 1.4));
  }

  // ------------------------------------------------------------------ picking
  pick(mx, my) {
    const m = this.model, L = this.layout;
    let best = -1, bd = Infinity;
    for (let i = 0; i < m.n; i++) {
      if (!m.vis[i]) continue;
      const [x, y] = this.w2s(L.x[i], L.y[i]);
      const r = this.screenR(i) + 3;
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d <= r * r && d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ------------------------------------------------------------------ drawing
  draw() {
    const now = performance.now();
    if (this.tween) {
      const tw = this.tween, u = clamp((now - tw.t0) / tw.ms, 0, 1), e = 1 - Math.pow(1 - u, 3);
      this.cam.x = tw.x0 + (tw.x - tw.x0) * e; this.cam.y = tw.y0 + (tw.y - tw.y0) * e;
      this.cam.k = tw.k0 * Math.pow(tw.k / tw.k0, e);
      if (u >= 1) this.tween = null; else this.dirty = true;
    }
    if (!this.model) return;
    const { ctx, w, h, dpr, model: m, layout: L, cam } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = THEME.surface;
    ctx.fillRect(0, 0, w, h);

    const N = m.n, E = m.m, sx = this.sx, sy = this.sy, k = cam.k;
    for (let i = 0; i < N; i++) {
      sx[i] = (L.x[i] - cam.x) * k + w / 2;
      sy[i] = (L.y[i] - cam.y) * k + h / 2;
    }
    const focus = this.focus, path = this.path;
    const onScreen = (i) => sx[i] > -40 && sx[i] < w + 40 && sy[i] > -40 && sy[i] < h + 40;

    // --- edges: width by live weight (buckets precomputed in updateAppearance)
    const ebk = this.ebk;
    const widths = [0.6, 0.9, 1.4, 2.0];
    ctx.lineCap = 'round';
    const baseAlpha = focus ? 0.07 : 1;
    for (let b = 0; b < 4; b++) {
      ctx.beginPath();
      let any = false;
      for (let e = 0; e < E; e++) {
        if (!m.evis[e] || ebk[e] !== b) continue;
        const a = m.eS[e], c = m.eT[e];
        if (!onScreen(a) && !onScreen(c)) continue;
        ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[c], sy[c]); any = true;
      }
      if (!any) continue;
      ctx.strokeStyle = THEME.edge; ctx.globalAlpha = baseAlpha; ctx.lineWidth = widths[b];
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (focus) {
      ctx.beginPath();
      for (let e = 0; e < E; e++) {
        if (!m.evis[e] || !focus.edges[e]) continue;
        ctx.moveTo(sx[m.eS[e]], sy[m.eS[e]]); ctx.lineTo(sx[m.eT[e]], sy[m.eT[e]]);
      }
      ctx.strokeStyle = THEME.edgeHi; ctx.lineWidth = 1.3; ctx.globalAlpha = 0.75; ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (path && path.edges.length) {
      ctx.beginPath();
      for (const e of path.edges) { ctx.moveTo(sx[m.eS[e]], sy[m.eS[e]]); ctx.lineTo(sx[m.eT[e]], sy[m.eT[e]]); }
      ctx.strokeStyle = THEME.path; ctx.lineWidth = 3; ctx.stroke();
    }

    // --- nodes: small ones batched per colour (one fill per colour), big ones get a ring
    const drawGroup = (pred) => {
      const groups = new Map(), big = [];
      for (let i = 0; i < N; i++) {
        if (!m.vis[i] || !onScreen(i) || !pred(i)) continue;
        if (this.screenR(i) >= 6) { big.push(i); continue; }
        const c = this.col[i];
        let g = groups.get(c); if (!g) groups.set(c, (g = []));
        g.push(i);
      }
      for (const [c, list] of groups) {
        ctx.beginPath();
        for (const i of list) { const r = this.screenR(i); ctx.moveTo(sx[i] + r, sy[i]); ctx.arc(sx[i], sy[i], r, 0, Math.PI * 2); }
        ctx.fillStyle = c; ctx.fill();
      }
      for (const i of big) {
        ctx.beginPath(); ctx.arc(sx[i], sy[i], this.screenR(i), 0, Math.PI * 2);
        ctx.fillStyle = this.col[i]; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = THEME.surface; ctx.stroke();
      }
    };
    if (focus) {
      ctx.globalAlpha = 0.16; drawGroup((i) => !focus.nodes[i]);
      ctx.globalAlpha = 1; drawGroup((i) => focus.nodes[i]);
    } else drawGroup(() => true);
    for (let i = 0; i < N; i++) {
      if (L.fixed[i] && m.vis[i]) {
        ctx.beginPath(); ctx.arc(sx[i], sy[i], this.screenR(i), 0, Math.PI * 2);
        ctx.lineWidth = 1.5; ctx.strokeStyle = THEME.text1; ctx.stroke();
      }
    }

    // --- rings: matches, path, selection, hover
    const ring = (i, color, wd) => {
      if (i < 0 || !m.vis[i]) return;
      ctx.beginPath(); ctx.arc(sx[i], sy[i], this.screenR(i) + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = color; ctx.lineWidth = wd; ctx.stroke();
    };
    if (this.matches) for (const i of this.matches) ring(i, THEME.match, 1.8);
    if (path) for (const i of path.nodes) ring(i, THEME.path, 2.2);
    ring(this.sel, THEME.select, 2.4);
    if (this.hover !== this.sel) ring(this.hover, THEME.text2, 1.4);

    // --- labels
    this._labels(sx, sy);
  }

  _labels(sx, sy) {
    const { ctx, model: m } = this;
    const want = new Map(); // node -> priority
    const add = (i, p) => { if (i >= 0 && m.vis[i] && (!want.has(i) || want.get(i) < p)) want.set(i, p); };
    add(this.sel, 100); add(this.hover, 99);
    if (this.path) this.path.nodes.forEach((i) => add(i, 90));
    if (this.matches) { let c = 0; for (const i of this.matches) { if (c++ < 30) add(i, 80); } }
    if (this.focus) {
      const hot = [...(this.focus.hot || [])].sort((a, b) => this.rad[b] - this.rad[a]).slice(0, 25);
      hot.forEach((i) => add(i, 60 + this.rad[i] * 0.1));
    } else if (this.showLabels) {
      const cand = [];
      for (let i = 0; i < m.n; i++) if (m.vis[i] && this.screenR(i) >= 7.5) cand.push(i);
      cand.sort((a, b) => this.rad[b] - this.rad[a]);
      cand.slice(0, 40).forEach((i) => add(i, this.rad[i] * 0.1));
    }
    const order = [...want.entries()].sort((a, b) => b[1] - a[1]);
    ctx.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Thai", sans-serif';
    ctx.textBaseline = 'middle';
    const placed = [];
    for (const [i] of order) {
      const label = m.nodes[i].label;
      const txt = label.length > 34 ? label.slice(0, 33) + '…' : label;
      const tw = ctx.measureText(txt).width;
      const x = sx[i] + this.screenR(i) + 5, y = sy[i];
      const box = [x - 2, y - 8, x + tw + 2, y + 8];
      const forced = i === this.sel || i === this.hover;
      if (!forced && placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      if (x > this.w || y < 0 || y > this.h) continue;
      placed.push(box);
      ctx.lineWidth = 3.5; ctx.strokeStyle = THEME.surface; ctx.lineJoin = 'round';
      ctx.strokeText(txt, x, y);
      ctx.fillStyle = THEME.text1; ctx.fillText(txt, x, y);
    }
  }

  // ------------------------------------------------------------------ pointer events
  _local(e) { const r = this.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  _bind() {
    const cv = this.cv;
    cv.addEventListener('pointerdown', (e) => {
      if (!this.model) return;
      cv.setPointerCapture(e.pointerId);
      this.hooks.onUser && this.hooks.onUser();
      const [x, y] = this._local(e);
      const hit = this.pick(x, y);
      this.drag = { kind: hit >= 0 ? 'node' : 'pan', i: hit, x0: x, y0: y, moved: false, cx: this.cam.x, cy: this.cam.y };
      this.tween = null;
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.model) return;
      const [x, y] = this._local(e);
      const d = this.drag;
      if (d) {
        if (Math.hypot(x - d.x0, y - d.y0) > 3) d.moved = true;
        if (d.kind === 'pan' && d.moved) {
          this.cam.x = d.cx - (x - d.x0) / this.cam.k; this.cam.y = d.cy - (y - d.y0) / this.cam.k;
          this.invalidate();
        } else if (d.kind === 'node' && d.moved) {
          const [wx, wy] = this.s2w(x, y);
          this.layout.x[d.i] = wx; this.layout.y[d.i] = wy;
          this.layout.pinned[d.i] = 1; this.layout.reheat(0.35);
          this.invalidate();
        }
        return;
      }
      const hit = this.pick(x, y);
      if (hit !== this.hover) { this.hover = hit; cv.style.cursor = hit >= 0 ? 'pointer' : 'grab'; this.invalidate(); }
      this.hooks.onHover(hit, e.clientX, e.clientY);
    });
    const up = () => {
      const d = this.drag; this.drag = null;
      if (!d) return;
      if (d.kind === 'node') {
        this.layout.pinned[d.i] = 0;
        if (d.moved) { this.layout.fixed[d.i] = 1; this.invalidate(); } // dropped nodes stay put
        else this.hooks.onSelect(d.i);
      } else if (!d.moved) this.hooks.onSelect(-1);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', () => { this.drag = null; });
    cv.addEventListener('pointerleave', () => {
      if (!this.drag && this.hover !== -1) { this.hover = -1; this.hooks.onHover(-1, 0, 0); this.invalidate(); }
    });
    cv.addEventListener('dblclick', (e) => {
      const [x, y] = this._local(e);
      const hit = this.pick(x, y);
      if (hit >= 0) { this.layout.fixed[hit] ^= 1; this.invalidate(); }
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.hooks.onUser && this.hooks.onUser();
      const [x, y] = this._local(e);
      const [wx, wy] = this.s2w(x, y);
      const nk = clamp(this.cam.k * Math.exp(-e.deltaY * 0.0015), 0.02, 25);
      this.cam.k = nk;
      this.cam.x = wx - (x - this.w / 2) / nk; this.cam.y = wy - (y - this.h / 2) / nk;
      this.tween = null; this.invalidate();
    }, { passive: false });
  }
}
