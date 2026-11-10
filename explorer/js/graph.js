// GraphModel: typed arrays for speed, plus the time-aware visibility pass,
// shortest paths and the activity histogram. No DOM in here.

export class GraphModel {
  constructor(raw) {
    const meta = (this.meta = raw.meta);
    const nodes = (this.nodes = raw.nodes);
    const edges = (this.edges = raw.edges);
    const N = (this.n = nodes.length);
    const E = (this.m = edges.length);

    this.id2i = new Map(nodes.map((nd, i) => [nd.id, i]));
    this.typeNames = Object.keys(meta.nodeTypes);
    const typeIdx = Object.fromEntries(this.typeNames.map((k, i) => [k, i]));
    this.edgeTypeNames = [...new Set(edges.map((e) => e.type))];
    const etIdx = Object.fromEntries(this.edgeTypeNames.map((k, i) => [k, i]));
    this.dirType = Uint8Array.from(this.edgeTypeNames, (t) => ((meta.directedEdges || []).includes(t) ? 1 : 0));

    this.nType = new Uint8Array(N);
    this.nStart = new Float64Array(N);
    this.nEnd = new Float64Array(N);
    this.pr = new Float32Array(N);
    this.comm = new Int16Array(N);
    this.deg = new Int32Array(N);
    nodes.forEach((nd, i) => {
      this.nType[i] = typeIdx[nd.type] ?? 0;
      this.nStart[i] = nd.start == null ? NaN : nd.start;
      this.nEnd[i] = nd.end == null ? NaN : nd.end;
      this.pr[i] = nd.pr;
      this.comm[i] = nd.comm;
      this.deg[i] = nd.deg;
    });

    this.eS = new Int32Array(E);
    this.eT = new Int32Array(E);
    this.eType = new Uint8Array(E);
    this.eW = new Float32Array(E);
    this.eStart = new Float64Array(E);
    this.eEnd = new Float64Array(E);
    edges.forEach((e, i) => {
      this.eS[i] = e.s;
      this.eT[i] = e.t;
      this.eType[i] = etIdx[e.type];
      this.eW[i] = e.w ?? 1;
      this.eStart[i] = e.start == null ? NaN : e.start;
      this.eEnd[i] = e.end == null ? NaN : e.end;
    });

    // weekly (or other) bucketed series -> prefix sums for O(1) window queries
    this.series = meta.series || null;
    this.cum = new Array(E).fill(null);
    if (this.series) {
      const nb = this.series.n;
      edges.forEach((e, i) => {
        if (!e.series) return;
        const cum = new Float64Array(nb + 1);
        let acc = 0;
        for (let k = 0; k < nb; k++) {
          const j = k - e.series.o;
          if (j >= 0 && j < e.series.c.length) acc += e.series.c[j];
          cum[k + 1] = acc;
        }
        this.cum[i] = cum;
      });
    }

    // adjacency (CSR)
    this.adjStart = new Int32Array(N + 1);
    for (let e = 0; e < E; e++) {
      this.adjStart[this.eS[e] + 1]++;
      this.adjStart[this.eT[e] + 1]++;
    }
    for (let i = 0; i < N; i++) this.adjStart[i + 1] += this.adjStart[i];
    this.adjNbr = new Int32Array(2 * E);
    this.adjEdge = new Int32Array(2 * E);
    const fill = this.adjStart.slice(0, N);
    for (let e = 0; e < E; e++) {
      const a = this.eS[e], b = this.eT[e];
      this.adjNbr[fill[a]] = b; this.adjEdge[fill[a]++] = e;
      this.adjNbr[fill[b]] = a; this.adjEdge[fill[b]++] = e;
    }

    // attribute filters -> token lists per node
    this.filters = (meta.filters || [])
      .map((f) => {
        const tok = new Array(N).fill(null);
        const counts = new Map();
        nodes.forEach((nd, i) => {
          const v = nd.attrs && nd.attrs[f.key];
          if (v == null || v === '') return;
          const ts = String(v).split(';').map((s) => s.trim()).filter(Boolean);
          tok[i] = ts;
          ts.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
        });
        const typeMask = f.types ? new Set(f.types.map((t) => typeIdx[t])) : null;
        const options = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300);
        return { ...f, tok, typeMask, options };
      })
      .filter((f) => f.options.length > 0);

    this.timeRange = meta.timeRange || [0, 1];

    // state buffers filled by compute()
    this.vis = new Uint8Array(N);
    this.evis = new Uint8Array(E);
    this.ew = new Float32Array(E);
    this.ldeg = new Float32Array(N);
    this.visNodes = 0;
    this.visEdges = 0;
  }

  /** s: {t, mode, windowBuckets, nodeTypes[], edgeTypes[], includeUndated, hideIsolated,
   *      minDeg, comm, filters:[{idx, value}]} */
  compute(s) {
    const { n, m, vis, evis, ew, ldeg } = this;
    const t = s.t;
    const active = s.mode === 'active';
    for (let i = 0; i < n; i++) {
      let ok = s.nodeTypes[this.nType[i]];
      if (ok && this.deg[i] < s.minDeg) ok = false;
      if (ok && s.comm >= 0 && this.comm[i] !== s.comm) ok = false;
      if (ok) {
        const st = this.nStart[i], en = this.nEnd[i];
        if (Number.isNaN(st) && Number.isNaN(en)) ok = s.includeUndated;
        else {
          if (!Number.isNaN(st) && st > t) ok = false;
          else if (active && !Number.isNaN(en) && en < t) ok = false;
        }
      }
      if (ok && s.filters.length) {
        for (const f of s.filters) {
          const def = this.filters[f.idx];
          if (def.typeMask && !def.typeMask.has(this.nType[i])) continue;
          const tk = def.tok[i];
          if (!tk || !tk.includes(f.value)) { ok = false; break; }
        }
      }
      vis[i] = ok ? 1 : 0;
    }

    let b = -1, a = 0;
    const sr = this.series;
    if (sr) {
      b = Math.min(Math.floor((t - sr.t0) / sr.stepMs), sr.n - 1);
      a = active ? Math.max(0, b - s.windowBuckets + 1) : 0;
    }
    ldeg.fill(0);
    let ve = 0;
    for (let e = 0; e < m; e++) {
      const x = this.eS[e], y = this.eT[e];
      if (!vis[x] || !vis[y] || !s.edgeTypes[this.eType[e]]) { evis[e] = 0; continue; }
      let w;
      const cum = this.cum[e];
      if (cum) w = b < 0 ? 0 : cum[b + 1] - cum[a];
      else {
        const st = this.eStart[e], en = this.eEnd[e];
        if (!Number.isNaN(st) && st > t) w = 0;
        else if (active && !Number.isNaN(en) && en < t) w = 0;
        else w = this.eW[e];
      }
      if (w <= 0) { evis[e] = 0; continue; }
      evis[e] = 1; ew[e] = w; ldeg[x] += w; ldeg[y] += w; ve++;
    }
    let vn = 0;
    for (let i = 0; i < n; i++) {
      if (vis[i] && s.hideIsolated && ldeg[i] === 0) vis[i] = 0;
      vn += vis[i];
    }
    this.visNodes = vn;
    this.visEdges = ve;
  }

  /** Visible neighbours of node i -> [{node, edge}] */
  neighbors(i) {
    const out = [];
    for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) {
      const e = this.adjEdge[k];
      if (this.evis[e]) out.push({ node: this.adjNbr[k], edge: e });
    }
    return out;
  }

  /** Unweighted shortest path over the currently visible graph. */
  shortestPath(a, b) {
    if (!this.vis[a] || !this.vis[b]) return null;
    if (a === b) return { nodes: [a], edges: [] };
    const prev = new Int32Array(this.n).fill(-2);
    const prevE = new Int32Array(this.n).fill(-1);
    const q = [a];
    prev[a] = -1;
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
        const e = this.adjEdge[k];
        if (!this.evis[e]) continue;
        const v = this.adjNbr[k];
        if (prev[v] !== -2) continue;
        prev[v] = u; prevE[v] = e;
        if (v === b) {
          const nodes = [b], edges = [];
          for (let x = b; prev[x] !== -1; x = prev[x]) { edges.push(prevE[x]); nodes.push(prev[x]); }
          return { nodes: nodes.reverse(), edges: edges.reverse() };
        }
        q.push(v);
      }
    }
    return null;
  }

  /** Events per time bin for the slider backdrop: ticket counts if the data has
   *  series, otherwise node start dates. */
  histogram(bins) {
    const [t0, t1] = this.timeRange;
    const span = Math.max(1, t1 - t0);
    const out = new Float64Array(bins);
    const put = (t, v) => {
      const k = Math.min(bins - 1, Math.max(0, Math.floor(((t - t0) / span) * bins)));
      out[k] += v;
    };
    if (this.series) {
      const { t0: s0, stepMs, n } = this.series;
      for (let e = 0; e < this.m; e++) {
        const cum = this.cum[e];
        if (!cum) continue;
        for (let k = 0; k < n; k++) {
          const v = cum[k + 1] - cum[k];
          if (v) put(s0 + k * stepMs, v);
        }
      }
    } else {
      for (let i = 0; i < this.n; i++) if (!Number.isNaN(this.nStart[i])) put(this.nStart[i], 1);
    }
    return out;
  }

  /** State of a node with phases at time t (or null). */
  stateAt(i, t) {
    const ph = this.nodes[i].phases;
    if (!ph) return null;
    let st = null;
    for (const [pt, name] of ph) { if (pt <= t) st = name; else break; }
    return st;
  }
}
