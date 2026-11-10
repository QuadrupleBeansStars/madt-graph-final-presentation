"""graphkit - build a typed, time-aware graph and export it as viewer JSON.

Both dataset adapters (Offshore Leaks, Traffy Fondue) feed a ``GraphBuilder``;
``export`` then computes the graph analysis the viewer shows (degree, PageRank,
Louvain communities) and writes one compact JSON file that the static web page
loads directly.

Time model (all timestamps are epoch milliseconds, UTC):
  * node ``start`` / ``end``   - lifespan. Both null = "undated".
  * node ``phases``            - [[t, state], ...] state changes (colour by state).
  * edge ``start`` / ``end``   - optional lifespan of a single relationship.
  * edge ``series``            - bucketed counts {"o": offset, "c": [..]} for
                                 aggregated edges whose weight changes over time.
                                 Bucket k covers [t0 + k*stepMs, t0 + (k+1)*stepMs).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import networkx as nx
import pandas as pd

EPOCH = pd.Timestamp("1970-01-01", tz="UTC")
MS_MIN = -2_208_988_800_000  # 1900-01-01
MS_MAX = 4_102_444_800_000  # 2100-01-01


def parse_dates(series) -> pd.Series:
    """Parse messy date strings to epoch milliseconds (nullable Int64)."""
    s = pd.Series(series).astype("string").str.strip()
    s = s.where(s != "", pd.NA)
    out = pd.to_datetime(s, format="%d-%b-%Y", errors="coerce", utc=True)  # ICIJ style
    miss = out.isna() & s.notna()
    if miss.any():
        out.loc[miss] = pd.to_datetime(s[miss], format="mixed", errors="coerce", utc=True)
    ms = (out - EPOCH) // pd.Timedelta(milliseconds=1)
    ms = pd.Series(ms, index=s.index).astype("Int64")
    return ms.where((ms >= MS_MIN) & (ms <= MS_MAX), pd.NA)


def _i(v):
    """Coerce to a plain int or None (handles pandas NA / NaN)."""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return int(v)


def _clean_attr(v):
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    s = str(v).strip()
    return s or None


class GraphBuilder:
    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}
        self.edges: list[dict] = []

    def add_node(self, nid, label, ntype, start=None, end=None, attrs=None, phases=None):
        nid = str(nid)
        if nid in self.nodes:
            return
        clean = {k: _clean_attr(v) for k, v in (attrs or {}).items()}
        self.nodes[nid] = {
            "id": nid,
            "label": _clean_attr(label) or nid,
            "type": ntype,
            "start": _i(start),
            "end": _i(end),
            "attrs": {k: v for k, v in clean.items() if v is not None},
            "phases": phases,
        }

    def add_edge(self, a, b, etype, w=1.0, start=None, end=None, series=None):
        self.edges.append(
            {"a": str(a), "b": str(b), "type": etype, "w": float(w),
             "start": _i(start), "end": _i(end), "series": series}
        )


def trim_series(counts) -> dict | None:
    """Trim leading/trailing zeros of a dense count list -> {"o": offset, "c": [...]}"""
    nz = [i for i, c in enumerate(counts) if c]
    if not nz:
        return None
    lo, hi = nz[0], nz[-1]
    return {"o": lo, "c": [int(c) for c in counts[lo : hi + 1]]}


def export(builder: GraphBuilder, path, meta: dict, series_meta: dict | None = None,
           seed: int = 42) -> dict:
    """Compute analysis, write viewer JSON, and return a small summary."""
    ids = list(builder.nodes)
    index = {nid: i for i, nid in enumerate(ids)}

    # Keep only edges whose endpoints exist and that are not self loops.
    edges = [e for e in builder.edges
             if e["a"] in index and e["b"] in index and e["a"] != e["b"]]

    G = nx.Graph()
    G.add_nodes_from(range(len(ids)))
    for e in edges:
        a, b = index[e["a"]], index[e["b"]]
        w = e["w"] if not e["series"] else float(sum(e["series"]["c"]))
        if G.has_edge(a, b):
            G[a][b]["w"] += w
        else:
            G.add_edge(a, b, w=w)

    deg = dict(G.degree())
    pr = nx.pagerank(G, weight="w") if G.number_of_edges() else {i: 1.0 for i in G}
    pmax = max(pr.values()) or 1.0

    comms = nx.community.louvain_communities(G, weight="w", seed=seed)
    comms = sorted(comms, key=len, reverse=True)
    comm_of = {}
    comm_info = []
    for ci, members in enumerate(comms):
        for m in members:
            comm_of[m] = ci
        top = max(members, key=lambda m: pr[m])
        comm_info.append({"id": ci, "size": len(members),
                          "top": builder.nodes[ids[top]]["label"]})

    nodes_out = []
    for i, nid in enumerate(ids):
        nd = builder.nodes[nid]
        row = {"id": nid, "label": nd["label"], "type": nd["type"],
               "start": nd["start"], "end": nd["end"],
               "deg": deg[i], "pr": round(pr[i] / pmax, 5), "comm": comm_of[i]}
        if nd["attrs"]:
            row["attrs"] = nd["attrs"]
        if nd["phases"]:
            row["phases"] = nd["phases"]
        nodes_out.append(row)

    edges_out = []
    for e in edges:
        row = {"s": index[e["a"]], "t": index[e["b"]], "type": e["type"]}
        if e["series"]:
            row["series"] = e["series"]
        else:
            row["w"] = round(e["w"], 4)
            if e["start"] is not None:
                row["start"] = e["start"]
            if e["end"] is not None:
                row["end"] = e["end"]
        edges_out.append(row)

    # Time range of everything that is dated.
    stamps = [n["start"] for n in nodes_out if n["start"] is not None]
    stamps += [n["end"] for n in nodes_out if n["end"] is not None]
    for n in nodes_out:
        for t, _ in n.get("phases") or []:
            stamps.append(t)
    stamps += [e["start"] for e in edges_out if e.get("start") is not None]
    stamps += [e["end"] for e in edges_out if e.get("end") is not None]
    if series_meta:
        stamps += [series_meta["t0"], series_meta["t0"] + series_meta["n"] * series_meta["stepMs"]]
    out_meta = dict(meta)
    if stamps:
        out_meta["timeRange"] = [min(stamps), max(stamps)]
    if series_meta:
        out_meta["series"] = series_meta
    out_meta["communities"] = comm_info[:30]
    out_meta["counts"] = {"nodes": len(nodes_out), "edges": len(edges_out)}

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"meta": out_meta, "nodes": nodes_out, "edges": edges_out},
                  fh, ensure_ascii=False, separators=(",", ":"))
    size_kb = Path(path).stat().st_size / 1024
    return {"nodes": len(nodes_out), "edges": len(edges_out),
            "communities": len(comms), "kb": round(size_kb, 1)}
