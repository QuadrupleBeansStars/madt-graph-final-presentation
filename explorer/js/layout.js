// Dependency-free force layout. Repulsion uses a uniform grid (only nearby nodes
// push each other), springs follow edges, a weak gravity keeps components together.
// The layout is computed ONCE on the whole graph; the time slider only shows or
// hides nodes, so positions never jump while the graph "develops".

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ForceLayout {
  constructor(model) {
    this.model = model;
    const N = model.n;
    this.x = new Float64Array(N);
    this.y = new Float64Array(N);
    this.vx = new Float64Array(N);
    this.vy = new Float64Array(N);
    this.pinned = new Uint8Array(N); // dragging
    this.fixed = new Uint8Array(N); // double-click pin
    this.active = new Uint8Array(N).fill(1);
    this.mass = new Float32Array(N);
    for (let i = 0; i < N; i++) this.mass[i] = 1 + 0.4 * Math.sqrt(model.deg[i]);
    this.p = {
      edgeLen: 20, repel: 300, repelMax: 10, spring: 0.3, gravity: 0.002,
      damping: 0.62, vmax: 30, decay: 0.985, alphaMin: 0.02,
    };
    this.alpha = 0;
    this.iter = 0;
    this.rand = mulberry32(42);
    this._counts = new Int32Array(1);
    this._items = new Int32Array(N);
    this._cellOf = new Int32Array(N);
    this.setActive(this.active);
  }

  seed() {
    const { model, x, y } = this;
    const r0 = Math.sqrt(model.n) * 16;
    for (let i = 0; i < model.n; i++) {
      const nd = model.nodes[i];
      if (nd.x != null && nd.y != null) { x[i] = nd.x; y[i] = nd.y; continue; }
      const a = this.rand() * Math.PI * 2, r = r0 * Math.sqrt(this.rand());
      x[i] = Math.cos(a) * r; y[i] = Math.sin(a) * r;
    }
    this.vx.fill(0); this.vy.fill(0);
    this.reheat(1);
  }

  /** Restrict the simulation to the nodes in `mask` (others stay where they are). */
  setActive(mask) {
    const { model } = this;
    this.active = mask;
    const list = [];
    for (let i = 0; i < model.n; i++) if (mask[i]) list.push(i);
    this.act = Int32Array.from(list);
    const el = [];
    for (let e = 0; e < model.m; e++) if (mask[model.eS[e]] && mask[model.eT[e]]) el.push(e);
    this.edgeList = Int32Array.from(el);
    this.strength = new Float32Array(this.edgeList.length);
    this.edgeList.forEach((e, k) => {
      const d = Math.min(model.deg[model.eS[e]], model.deg[model.eT[e]]);
      this.strength[k] = 1 / Math.sqrt(Math.max(1, d));
    });
  }

  reheat(a = 1) { this.alpha = Math.max(this.alpha, a); }
  get running() { return this.alpha > this.p.alphaMin; }

  step(budgetMs = 10) {
    const t0 = performance.now();
    let n = 0;
    while (this.running && performance.now() - t0 < budgetMs) { this._iterate(); n++; }
    return n;
  }

  _iterate() {
    const { x, y, vx, vy, mass, pinned, fixed, act, p } = this;
    const na = act.length;
    if (!na) { this.alpha = 0; return; }
    const alpha = this.alpha;

    // bounds & grid
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < na; k++) {
      const i = act[k];
      if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
    }
    const R = Math.max(60, (maxX - minX) / 400, (maxY - minY) / 400);
    const gw = Math.floor((maxX - minX) / R) + 1, gh = Math.floor((maxY - minY) / R) + 1;
    const cells = gw * gh;
    if (this._counts.length < cells + 1) this._counts = new Int32Array(cells + 1);
    const counts = this._counts, items = this._items, cellOf = this._cellOf;
    counts.fill(0, 0, cells + 1);
    for (let k = 0; k < na; k++) {
      const i = act[k];
      const c = Math.floor((y[i] - minY) / R) * gw + Math.floor((x[i] - minX) / R);
      cellOf[i] = c; counts[c + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const fillPos = counts.slice(0, cells);
    for (let k = 0; k < na; k++) { const i = act[k]; items[fillPos[cellOf[i]]++] = i; }

    // repulsion
    const R2 = R * R, kRep = p.repel, fmax = p.repelMax;
    for (let k = 0; k < na; k++) {
      const i = act[k];
      const c = cellOf[i], cx = c % gw, cy = (c - cx) / gw;
      const xi = x[i], yi = y[i], mi = mass[i];
      for (let oy = -1; oy <= 1; oy++) {
        const yy = cy + oy; if (yy < 0 || yy >= gh) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const xx = cx + ox; if (xx < 0 || xx >= gw) continue;
          const cc = yy * gw + xx;
          for (let q = counts[cc]; q < counts[cc + 1]; q++) {
            const j = items[q];
            if (j <= i) continue;
            let dx = xi - x[j], dy = yi - y[j];
            let d2 = dx * dx + dy * dy;
            if (d2 > R2) continue;
            if (d2 < 0.25) { dx = this.rand() - 0.5; dy = this.rand() - 0.5; d2 = dx * dx + dy * dy + 0.01; }
            const inv = 1 / Math.sqrt(d2);
            let f = (kRep * mi * mass[j]) / d2;
            if (f > fmax) f = fmax;
            const fx = dx * inv * f * alpha, fy = dy * inv * f * alpha;
            vx[i] += fx; vy[i] += fy; vx[j] -= fx; vy[j] -= fy;
          }
        }
      }
    }

    // springs
    const { model, edgeList, strength } = this;
    for (let k = 0; k < edgeList.length; k++) {
      const e = edgeList[k], a = model.eS[e], b = model.eT[e];
      const dx = x[b] - x[a], dy = y[b] - y[a];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = p.spring * strength[k] * (d - p.edgeLen) * alpha;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      vx[a] += fx; vy[a] += fy; vx[b] -= fx; vy[b] -= fy;
    }

    // gravity + integrate
    const g = p.gravity * alpha;
    for (let k = 0; k < na; k++) {
      const i = act[k];
      if (pinned[i] || fixed[i]) { vx[i] = vy[i] = 0; continue; }
      vx[i] = (vx[i] - x[i] * g) * p.damping;
      vy[i] = (vy[i] - y[i] * g) * p.damping;
      const sp = Math.hypot(vx[i], vy[i]);
      if (sp > p.vmax) { vx[i] *= p.vmax / sp; vy[i] *= p.vmax / sp; }
      x[i] += vx[i]; y[i] += vy[i];
    }
    this.alpha *= p.decay;
    this.iter++;
  }
}
