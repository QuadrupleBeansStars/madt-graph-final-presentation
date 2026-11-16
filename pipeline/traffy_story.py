"""Numbers behind the slides -> data/traffy_story.json (small, safe to publish).

Reads the raw monthly exports (kept in a private place, never published), reuses the adapter's
cleaning (`prepare`), and computes what each slide shows: the funnel, the police-handoff
finding, chain length vs outcome, best/worst end-points, the five centralities and the
Chapter-8 shape fingerprint on the published graph, plus four real rows for the "table" slide.

"Finished" everywhere = status finished AND closed within 90 days, measured only on tickets
at least 120 days old at the end of the data, so old and new tickets are compared fairly.

    python pipeline/traffy_story.py --input "path/to/bangkok_*.csv.gz"
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import traffy_handoff as T  # noqa: E402

THAI_STATE = {v: k for k, v in T.STATE_MAP.items()}


def is_police(name: str) -> bool:
    return "ตำรวจ" in name or name.startswith("สน.") or "Police" in name


def gloss(name: str) -> str:
    en = T.en_for_agency(name)
    return f"{T.short(name)} · {en}" if en else T.short(name)


def pct(x):
    return None if x is None or pd.isna(x) else round(100 * float(x), 1)


# ------------------------------------------------------------------------------------ graph metrics
def graph_metrics(graph_path: Path) -> dict:
    raw = json.loads(graph_path.read_text(encoding="utf-8"))
    nodes = raw["nodes"]
    Gd, Gu = nx.DiGraph(), nx.Graph()
    for e in raw["edges"]:
        if e["type"] != "handoff":
            continue
        w = int(str(e.get("note", "0")).split()[0].replace(",", "") or 0)
        a, b = nodes[e["s"]]["id"], nodes[e["t"]]["id"]
        Gd.add_edge(a, b, w=w)
        Gu.add_edge(a, b)
    lab = {n["id"]: n["label"] for n in nodes}
    typ = {n["id"]: n["type"] for n in nodes}

    def top(d, k=3):
        return [{"id": n, "label": lab[n], "type": typ[n], "score": round(float(v), 4)}
                for n, v in sorted(d.items(), key=lambda kv: -kv[1])[:k]]

    big = Gu.subgraph(max(nx.connected_components(Gu), key=len)).copy()   # metrics on the biggest piece
    cent = {
        "degree": top(nx.degree_centrality(big)),
        "betweenness": top(nx.betweenness_centrality(big)),
        "closeness": top(nx.closeness_centrality(big)),
        "eigenvector": top(nx.eigenvector_centrality_numpy(big)),
        "pagerank": top(nx.pagerank(Gd.subgraph(big.nodes), alpha=0.85, weight="w")),
    }

    # ---- Chapter 8 fingerprint, on the biggest connected piece (as the lab does)
    comps = sorted(nx.connected_components(Gu), key=len, reverse=True)
    G = Gu.subgraph(comps[0]).copy()
    N, m = G.number_of_nodes(), G.number_of_edges()
    deg = dict(G.degree())
    dmax = max(deg.values())
    density = 2 * m / (N * (N - 1))
    central = sum(dmax - d for d in deg.values()) / ((N - 1) * (N - 2))
    apl, diam = nx.average_shortest_path_length(G), nx.diameter(G)
    clustering = nx.average_clustering(G)
    comm = nx.community.louvain_communities(G, seed=7)
    where = {n: i for i, c in enumerate(comm) for n in c}
    inside = sum(1 for a, b in G.edges if where[a] == where[b]) / m
    bt = nx.betweenness_centrality(G)
    hub = max(bt, key=bt.get)
    H = G.copy(); H.remove_node(hub)
    pieces_wo = sum(1 for c in nx.connected_components(H) if len(c) >= 2)
    k = max(3, round(0.1 * N))
    core = [n for n, _ in sorted(deg.items(), key=lambda kv: -kv[1])[:k]]
    rim = [n for n in G if n not in core]
    block_d = nx.density(G.subgraph(core))
    rim_d = nx.density(G.subgraph(rim))
    rng = np.random.default_rng(7)
    rnd = []
    for _ in range(10):
        R = nx.gnm_random_graph(N, m, seed=int(rng.integers(1e9)))
        if not nx.is_connected(R):
            R = R.subgraph(max(nx.connected_components(R), key=len)).copy()
        rc = nx.community.louvain_communities(R, seed=1)
        rw = {n: i for i, c in enumerate(rc) for n in c}
        rnd.append((nx.average_clustering(R), nx.average_shortest_path_length(R),
                    sum(1 for a, b in R.edges if rw[a] == rw[b]) / R.number_of_edges()))
    rnd = np.mean(rnd, axis=0)
    tests = [
        ("Fragmented", f"pieces > 1 ({len(comps)} pieces; classified on the biggest, {N} nodes)", False),
        ("Complete", f"density = 1.00 (ours {density:.3f})", density >= 0.999),
        ("Circle / chain", "every degree = 2, or two of degree 1 and rest 2", all(d == 2 for d in deg.values())),
        ("Star", f"centralization ≥ 0.80 (ours {central:.2f})", central >= 0.8),
        ("Hierarchy / tree", f"links = N − 1 (ours {m} vs {N - 1})", m == N - 1),
        ("Bridge / communities", f"inside share ≥ 0.80 (ours {inside:.2f})", inside >= 0.8),
        ("Core–periphery", f"core block density 1.00 and rim 0 (ours {block_d:.2f} / {rim_d:.2f})",
         block_d >= 0.999 and rim_d == 0),
    ]
    fp = {
        "nodes": N, "links": m, "pieces": len(comps), "density": round(density, 4),
        "centralization": round(central, 3), "avg_path": round(apl, 2), "diameter": diam,
        "cycles": m - (N - 1), "clustering": round(clustering, 3), "inside_share": round(inside, 3),
        "communities": len(comm), "connector": lab[hub], "pieces_without_connector": pieces_wo,
        "core_k": k, "block_density": round(block_d, 3), "rim_density": round(rim_d, 4),
        "random": {"clustering": round(float(rnd[0]), 3), "avg_path": round(float(rnd[1]), 2),
                   "inside_share": round(float(rnd[2]), 3), "density": round(density, 4)},
        "tests": [{"shape": s, "test": t, "pass": bool(p)} for s, t, p in tests],
    }
    first = next((s for s, _, p in tests[1:] if p), None)
    fp["verdict"] = first or "Random-like (no pure shape passes)"
    return {"centrality": cent, "fingerprint": fp}


# ------------------------------------------------------------------------------------ main numbers
def story(rows: pd.DataFrame, raw_rows: int, graph_path: Path) -> dict:
    out: dict = {}
    n = len(rows)
    t0, t1 = int(rows["ts_ms"].min()), int(rows["ts_ms"].max())
    days = (t1 - t0) / T.DAY_MS
    ym = pd.to_datetime(rows["ts_ms"], unit="ms").dt.strftime("%Y-%m")
    out["basics"] = {
        "tickets": n, "span": [t0, t1], "per_day": round(n / days),
        "hotline_pct": round(100 * float(rows["chain"].map(lambda c: ("A", T.HOTLINE) in c).mean()), 1),
        "months": [[k, int(v)] for k, v in ym.value_counts().sort_index().items()],
        "avg_chain": round(float(rows["L"].mean()), 2),
        "multi_agency_pct": round(100 * float((rows["L"] >= 3).mean())),
    }
    pairs = Counter()
    nodes = Counter()
    for ch in rows["chain"]:
        ids = [f"{k}:{v}" for k, v in ch]
        nodes.update(set(ids))
        pairs.update(zip(ids, ids[1:]))
    g = json.loads(graph_path.read_text(encoding="utf-8"))
    kinds = Counter(x["type"] for x in g["nodes"])
    hand = sum(1 for e in g["edges"] if e["type"] == "handoff")
    out["funnel"] = {
        "raw_rows": raw_rows, "tickets": n,
        "raw_org_names": int(len({o.strip() for v in rows["organization"] for o in str(v).split(",")})),
        "nodes_after_fold": len(nodes), "handoffs_total": int(sum(pairs.values())),
        "distinct_pairs": len(pairs),
        "kept_agencies": kinds["Agency"], "kept_districts": kinds["District"], "kept_categories": kinds["Category"],
        "kept_handoff_edges": hand,
        "thresholds": {"agency_min_tickets": 1000, "handoff_min_tickets": 500, "routed_min_tickets": 800},
    }

    sens = []
    base_top = None
    for ma, mh in ((500, 300), (1000, 500), (2000, 1000)):
        keep = {x for x, c in nodes.items() if x.startswith("D:") or c >= ma}
        Gs = nx.DiGraph()
        for (a, b), c in pairs.items():
            if a in keep and b in keep and c >= mh:
                Gs.add_edge(a, b, w=c)
        pr = nx.pagerank(Gs, alpha=0.85, weight="w")
        top5 = [x for x, _ in sorted(pr.items(), key=lambda kv: -kv[1])[:5]]
        if ma == 1000:
            base_top = set(top5)
        sens.append({"agency_min": ma, "handoff_min": mh, "nodes": Gs.number_of_nodes(), "edges": Gs.number_of_edges(),
                     "top5_pagerank": [gloss(x.split(":", 1)[1]) for x in top5], "_ids": top5})
    for r_ in sens:
        r_["overlap_with_published"] = len(set(r_.pop("_ids")) & base_top)
    out["sensitivity"] = sens

    old = rows[rows["age_d"] >= T.MIN_AGE_D].copy()
    old["year"] = pd.to_datetime(old["ts_ms"], unit="ms").dt.year
    old["police"] = old["chain"].map(lambda ch: any(k == "A" and is_police(v) for k, v in ch))
    rows["police"] = rows["chain"].map(lambda ch: any(k == "A" and is_police(v) for k, v in ch))
    pol, oth = old[old["police"]], old[~old["police"]]
    by_year = []
    for y, grp in old.groupby("year"):
        p, o = grp[grp["police"]], grp[~grp["police"]]
        by_year.append({"year": int(y), "police_n": int(len(p)), "other_n": int(len(o)),
                        "police_fin": pct(p["fin"].mean()), "other_fin": pct(o["fin"].mean())})
    chains = pol[pol["L"] >= 4]["chain"].map(lambda c: tuple(v for _, v in c))
    common = Counter(chains).most_common(1)
    cat_share = pol["tags"].map(lambda t: "ผิดกฎจราจร" in t).mean()
    out["police"] = {
        "share_of_tickets_pct": round(100 * float(rows["police"].mean()), 1),
        "tickets": int(rows["police"].sum()),
        "fin_police": pct(pol["fin"].mean()), "fin_other": pct(oth["fin"].mean()),
        "star_police": round(float(pol["star"].mean()), 2) if "star" in pol else None,
        "star_other": round(float(oth["star"].mean()), 2) if "star" in oth else None,
        "traffic_violation_share_pct": round(100 * float(cat_share)),
        "by_year": by_year,
        "n_old": int(len(old)),
        "typical_chain": [gloss(v) for v in common[0][0]] if common else [],
        "police_node_names": sorted({v for ch in rows["chain"] for k, v in ch if k == "A" and is_police(v)}),
    }

    by_len = []
    for L, grp in old.groupby(old["L"].clip(upper=6)):
        by_len.append({"len": int(L), "label": str(int(L)) if L < 6 else "6+", "n": int(len(grp)),
                       "fin": pct(grp["fin"].mean()),
                       "median_days": round(float(grp["dur_d"].median()), 1),
                       "star": round(float(grp["star"].mean()), 2)})
    out["length"] = by_len
    old["revisit"] = old["chain"].map(lambda c: len(c) != len(set(c)))
    out["revisit"] = {"pct": round(100 * float(old["revisit"].mean()), 1),
                      "fin_revisit": pct(old[old["revisit"]]["fin"].mean()),
                      "fin_other": pct(old[~old["revisit"]]["fin"].mean())}

    old["last"] = old["chain"].map(lambda c: c[-1])
    term = old.groupby("last").agg(n=("fin", "size"), fin=("fin", "mean"), med=("dur_d", "median"))
    term = term[term["n"] >= 2000].sort_values("fin")
    rec = lambda i, r: {"name": gloss(i[1]), "kind": i[0], "n": int(r.n), "fin": pct(r.fin),
                        "median_days": round(float(r.med), 1)}
    out["endpoints"] = {
        "worst": [rec(i, r) for i, r in term.head(8).iterrows()],
        "best": [rec(i, r) for i, r in term.tail(8).iloc[::-1].iterrows()],
    }
    def group(x):
        k, v = x
        if k == "D":
            return "District office"
        if is_police(v):
            return "Police"
        return {"External": "Other outside body", "District unit": "District unit", "Bureau": "BMA bureau",
                "Division / centre": "BMA division / centre"}.get(T.agency_kind(v), "Other BMA / hotline")
    old["end_group"] = old["last"].map(group)
    eg = old.groupby("end_group").agg(n=("fin", "size"), fin=("fin", "mean"), med=("dur_d", "median"))
    out["end_groups"] = [{"group": g, "n": int(r.n), "share_pct": round(100 * r.n / len(old), 1), "fin": pct(r.fin),
                          "median_days": round(float(r.med), 1)} for g, r in eg.sort_values("fin").iterrows()]
    enf = old[old["last"].map(lambda x: x[1].startswith("ฝ่ายเทศกิจ"))]
    per = enf.groupby("district").agg(n=("fin", "size"), fin=("fin", "mean"))
    per = per[per["n"] >= 300]
    out["enforcement"] = {
        "tickets": int(len(enf)), "districts": int(len(per)), "fin_all": pct(enf["fin"].mean()),
        "fin_min": pct(per["fin"].min()), "fin_median": pct(per["fin"].median()), "fin_max": pct(per["fin"].max()),
    }

    # four real rows (open-data fields only; no free text) + one worked path, from the latest month
    last_m = rows[pd.to_datetime(rows["ts_ms"], unit="ms").dt.strftime("%Y-%m") == ym.max()]
    def pick(mask):
        cand = last_m[mask(last_m)]
        return cand.iloc[len(cand) // 3] if len(cand) else None
    picks = [
        ("short", pick(lambda d: (d["L"] == 2) & (d["state"] == "finish") & (d["tags"].map(lambda t: "ความสะอาด" in t)))),
        ("police", pick(lambda d: (d["L"] == 5) & (d["state"] == "inprogress") & d["police"] & d["tags"].map(lambda t: "ผิดกฎจราจร" in t))),
        ("long", pick(lambda d: (d["L"] >= 8) & (d["state"] == "inprogress"))),
        ("hotline", pick(lambda d: d["chain"].map(lambda c: ("A", T.HOTLINE) in c) & (d["state"] == "finish") & (d["L"] >= 3))),
    ]
    ex_rows = []
    for tag, r in picks:
        if r is None:
            continue
        ts = pd.to_datetime(int(r["ts_ms"]), unit="ms", utc=True).tz_convert("Asia/Bangkok")
        ex_rows.append({
            "tag": tag, "ticket_id": r["ticket_id"], "type": ", ".join(r["tags"]),
            "organization": r["organization"], "district": r["district"],
            "state": THAI_STATE.get(r["state"], r["state"]), "state_code": r["state"],
            "timestamp": ts.strftime("%Y-%m-%d %H:%M"), "L": int(r["L"]),
            "chain": [{"id": f"{k}:{v}", "node": v, "short": T.short(v), "en": T.en_for_agency(v), "kind": k} for k, v in r["chain"]],
            "raw_parts": [p.strip() for p in str(r["organization"]).split(",")],
        })
    out["examples"] = ex_rows
    out.update(graph_metrics(graph_path))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", nargs="+", required=True)
    ap.add_argument("--graph", default="data/traffy.json")
    ap.add_argument("--out", default="data/traffy_story.json")
    ap.add_argument("--cache", help="optional pickle of prepared rows (speeds up iteration)")
    a = ap.parse_args(argv)
    if a.cache and Path(a.cache).exists():
        rows = pd.read_pickle(a.cache); raw_rows = rows.attrs.get("raw_rows", len(rows))
    else:
        raw = T.load_tickets(a.input); raw_rows = len(raw)
        rows = T.prepare(raw)
        if a.cache:
            rows.attrs["raw_rows"] = raw_rows; rows.to_pickle(a.cache)
    res = story(rows, raw_rows, Path(a.graph))
    Path(a.out).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("wrote", a.out)


if __name__ == "__main__":
    main()
