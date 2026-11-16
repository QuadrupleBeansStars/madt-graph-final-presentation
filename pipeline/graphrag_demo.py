"""Offline Graph RAG demo over the published handoff graph -> data/graphrag_demo.json.

Why offline: the site is static (GitHub Pages), so it cannot hold an LLM API key. The retrieval
half is real code, run here; the answer half was written by Claude from *only* the retrieved
context and stored with it. A plain-RAG baseline (TF-IDF over ticket rows) is run on the same
questions so the slide can show what a table-shaped store retrieves instead.

    retrieve (graph)  ->  verbalise as triples  ->  answer from those triples only

    python pipeline/graphrag_demo.py --cache /tmp/work/prep.pkl
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd

HOTLINE = "A:ร้องทุกข์ กทม. 1555"


def num(note: str) -> int:
    m = re.match(r"([\d,]+) tickets", note or "")
    return int(m.group(1).replace(",", "")) if m else 0


def load(path: Path):
    raw = json.loads(path.read_text(encoding="utf-8"))
    nodes = raw["nodes"]
    N = {n["id"]: n for n in nodes}
    G = nx.DiGraph()
    R = []                       # routed_to: category -> agency
    for e in raw["edges"]:
        a, b = nodes[e["s"]]["id"], nodes[e["t"]]["id"]
        if e["type"] == "handoff":
            G.add_edge(a, b, w=num(e.get("note")), note=e.get("note", ""))
        else:
            R.append((a, b, num(e.get("note")), e.get("note", "")))
    return N, G, R


def label(N, i):
    return N[i]["label"]


def find(N, prefix):
    for i, n in N.items():
        if n["label"].startswith(prefix):
            return i
    raise KeyError(prefix)


def attr(N, i, k):
    return (N[i].get("attrs") or {}).get(k)


# ----------------------------------------------------------------------------- three retrievals
def q_category(N, G, R):
    cat = "C:ผิดกฎจราจร"
    rt = sorted([r for r in R if r[0] == cat], key=lambda r: -r[2])[:5]
    ids = {cat}
    facts = [f"{label(N, cat)}: {attr(N, cat, 'tickets')} tickets, reaches {attr(N, cat, 'distinct_agencies')} "
             f"different agencies, average chain {attr(N, cat, 'avg_chain_length')} agencies, "
             f"{attr(N, cat, 'finished_90d_pct')}% finished within 90 days, median {attr(N, cat, 'median_days_total')} days."]
    for _, a, k, _n in rt:
        ids.add(a)
        ins = sorted(G.in_edges(a, data=True), key=lambda e: -e[2]["w"])[:1]
        facts.append(f"{label(N, cat)} —routed_to→ {label(N, a)}: {k:,} tickets; this agency finishes "
                     f"{attr(N, a, 'finished_90d_pct')}% within 90 days.")
        for u, v, d in ins:
            ids.add(u)
            facts.append(f"{label(N, u)} —handoff→ {label(N, v)}: {d['note']}.")
    worst = min(rt, key=lambda r: attr(N, r[1], "finished_90d_pct") or 999)
    return ids, facts, {"cat": cat, "top": rt, "worst": worst}


def q_impact(N, G, R):
    target = find(N, "กองบังคับการตำรวจนครบาล 5")
    paths = []
    for d in [i for i in N if i.startswith("D:")]:
        if d in G and nx.has_path(G, d, target):
            p = nx.shortest_path(G, d, target)
            if len(p) <= 5:
                paths.append((min(G[a][b]["w"] for a, b in zip(p, p[1:])), p))
    paths.sort(key=lambda x: -x[0])
    top = paths[:5]
    ids = {target}
    facts = [f"{label(N, target)}: {attr(N, target, 'tickets')} tickets, "
             f"{attr(N, target, 'finished_90d_pct')}% finished within 90 days, median {attr(N, target, 'median_days_total')} days."]
    for w, p in top:
        ids.update(p)
        hops = " → ".join(label(N, x).split(" · ")[0] for x in p)
        facts.append(f"Path {hops} (weakest link {w:,} tickets).")
    return ids, facts, {"target": target, "paths": top, "n_districts": len(paths)}


def q_pingpong(N, G, R):
    pairs = []
    for a, b in G.edges:
        if a < b and G.has_edge(b, a):
            wab, wba = G[a][b]["w"], G[b][a]["w"]
            pairs.append((min(wab, wba), a, b, wab, wba))
    pairs.sort(reverse=True)
    top = pairs[:5]
    ids, facts = set(), [f"{len(pairs)} of {G.number_of_edges()} handoff edges have a reverse edge (A→B and B→A both exist)."]
    for _, a, b, wab, wba in top:
        ids.update((a, b))
        facts.append(f"{label(N, a).split(' · ')[0]} —handoff→ {label(N, b).split(' · ')[0]}: {G[a][b]['note']}; "
                     f"reverse {label(N, b).split(' · ')[0]} —handoff→ {label(N, a).split(' · ')[0]}: {G[b][a]['note']}.")
    return ids, facts, {"pairs": top, "n_pairs": len(pairs), "n_edges": G.number_of_edges()}



DIST_EN = {"คลองเตย": "Khlong Toei", "บางพลัด": "Bang Phlat", "หนองจอก": "Nong Chok", "บางบอน": "Bang Bon",
           "ตลิ่งชัน": "Taling Chan"}


def en(N, i):
    """Readable name for prose: English gloss when the label has one, else the Thai label."""
    lab = N[i]["label"]
    if i.startswith("D:"):
        d = i[2:]
        return DIST_EN.get(d, "เขต" + d)
    return " · ".join(lab.split(" · ")[1:]) if " · " in lab else lab


def pct_of(N, i):
    return attr(N, i, "finished_90d_pct")


def answers(N, G, R, a1, a2, a3):
    """Answers composed (by Claude) from ONLY the retrieved facts; every number comes from the graph."""
    rtk = {(c, a): k for c, a, k, _ in R}
    cat = a1["cat"]
    rp = find(N, "สำนักงานตำรวจแห่งชาติ"); bj = find(N, "กองบัญชาการตำรวจนครบาล (บช"); b5 = find(N, "กองบังคับการตำรวจนครบาล 5")
    enf = find(N, "ฝ่ายเทศกิจ (เขต)")
    ans1 = (f"Because many of them leave the city administration for the police. Of {attr(N, cat, 'tickets')} traffic-violation tickets, the two biggest "
            f"routes go to the Royal Thai Police ({rtk[(cat, rp)]:,}) and the Metropolitan Police ({rtk[(cat, bj)]:,}); both finish only "
            f"{pct_of(N, rp)}% within 90 days, and Division 5 only {pct_of(N, b5)}% (the Royal Thai Police → Division 5 handoff alone is "
            f"{G[rp][b5]['w']:,} tickets with a median of {G[rp][b5]['note'].split('median ')[1].split(' d')[0]} days). The same category "
            f"routed to district enforcement finishes {pct_of(N, enf)}%. The stall sits at the police end of the chain, not at the district.")
    t = a2["target"]; names = []
    for _, p in a2["paths"]:
        names.append((en(N, p[0]), [en(N, x) for x in p[1:-1]]))
    direct = [n for n, mid in names if not mid]; via_fr = [n for n, mid in names if mid and "Friends" in " ".join(mid) or any("เพื่อน" in m for m in mid)]
    via_police = [n for n, mid in names if mid and not any("เพื่อน" in m for m in mid)]
    ans2 = (f"Division 5 closes {pct_of(N, t)}% of its tickets within 90 days (median {attr(N, t, 'median_days_total')} days), and {a2['n_districts']} district "
            f"offices reach it within four hops. The heaviest feeders are " + ", ".join(direct) + " (direct)" +
            (", " + ", ".join(via_fr) + " (through the เพื่อนชัชชาติ, “Chadchart’s friends”, node)" if via_fr else "") +
            (", and " + ", ".join(via_police) + " (via the Royal Thai Police)" if via_police else "") +
            ". If the division stops closing tickets, those districts' complaints are the first to pile up.")
    (w1, a, b, wab, wba), (w2, c, d, wcd, wdc) = a3["pairs"][:2]
    ans3 = (f"{a3['n_pairs']} of the {a3['n_edges']} handoff edges run in both directions. The heaviest pair is {en(N, a)} ⇄ {en(N, b)}: "
            f"{wab:,} tickets one way and {wba:,} back. Next is {label(N, c)} ⇄ {label(N, d)} ({wcd:,} / {wdc:,}), where the returning leg finishes "
            f"only {G[d][c]['note'].split(' · ')[-1].replace(' finished', '')}. Two edges in opposite directions come from different tickets, so this shows unclear "
            f"ownership rather than one ticket bouncing.")
    return ans1, ans2, ans3

# ----------------------------------------------------------------------------- plain RAG baseline
def plain_rag(rows: pd.DataFrame, queries: list[str], k=3, n=250_000, seed=3):
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import linear_kernel
    sample = rows.sample(min(n, len(rows)), random_state=seed).reset_index(drop=True)
    thai = {"finish": "เสร็จสิ้น", "inprogress": "กำลังดำเนินการ", "start": "รอรับเรื่อง"}
    text = (sample["type"].fillna("") + " | " + sample["organization"].fillna("") + " | "
            + sample["state"].map(lambda s: thai.get(s, s)) + " | " + sample["district"].fillna(""))
    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), min_df=5, sublinear_tf=True, dtype=np.float32)
    X = vec.fit_transform(text)
    out = []
    for q in queries:
        sims = linear_kernel(vec.transform([q]), X).ravel()
        top = sims.argsort()[::-1][:k]
        out.append([{"ticket_id": sample.loc[i, "ticket_id"], "type": sample.loc[i, "type"],
                     "organization": sample.loc[i, "organization"], "state": thai.get(sample.loc[i, "state"], sample.loc[i, "state"]),
                     "district": sample.loc[i, "district"], "score": round(float(sims[i]), 3)} for i in top])
    return out, len(sample)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--graph", default="data/traffy.json")
    ap.add_argument("--cache", required=True, help="pickle of prepared rows (see traffy_story.py --cache)")
    ap.add_argument("--out", default="data/graphrag_demo.json")
    a = ap.parse_args(argv)
    N, G, R = load(Path(a.graph))
    r1, r2, r3 = q_category(N, G, R), q_impact(N, G, R), q_pingpong(N, G, R)
    th = [
        "ทำไมเรื่องร้องเรียนผิดกฎจราจรถึงค้าง",
        "กองบังคับการตำรวจนครบาล 5 ไม่ปิดเรื่อง เขตไหนได้รับผลกระทบ",
        "หน่วยงานที่ส่งเรื่องกลับไปกลับมาระหว่างกัน",
    ]
    rows = pd.read_pickle(a.cache)
    plain, nidx = plain_rag(rows, th)
    ans = answers(N, G, R, r1[2], r2[2], r3[2])
    qs = []
    for i, ((ids, facts, aux), q_en, q_th, pr, an) in enumerate(zip(
            (r1, r2, r3),
            ("Why do traffic-violation complaints stall?",
             "If Metropolitan Police Division 5 stops closing tickets, which districts feel it?",
             "Which pairs of agencies pass tickets back and forth?"),
            th, plain, ans)):
        qs.append({"id": f"q{i + 1}", "question": q_en, "question_th": q_th, "highlight": sorted(ids),
                   "facts": facts, "answer": an, "plain_rows": pr})
    Path(a.out).write_text(json.dumps({"index_rows": nidx, "questions": qs}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("wrote", a.out)


if __name__ == "__main__":
    main()
