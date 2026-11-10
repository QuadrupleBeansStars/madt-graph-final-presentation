"""Traffy Fondue tickets -> agency *handoff* graph (viewer JSON + insights JSON).

Every ticket carries `organization`: an ordered, comma-separated list of the agencies
that took part in handling it. Read as a path, it is a route through the city
administration:

    ร้องทุกข์ กทม. 1555 -> เขตดินแดง -> ฝ่ายโยธา เขตดินแดง -> สำนักการโยธา -> ...

so a table of tickets is really a table of *walks on a graph of agencies*. This
adapter rebuilds that graph.

Nodes   Agency (bureaus, units, hotline, external bodies), District office, Category
Edges   handoff    Agency/District -> Agency/District  (directed, consecutive in a chain)
        routed_to  Category -> Agency                  (the category of tickets an agency saw)
Both carry weekly ticket-count series (by ticket creation time) so the viewer's time
slider shows the routing network growing.

Normalisation
  * the root "กรุงเทพมหานคร" appears in ~96% of chains and says nothing about routing: dropped
  * district-specific units ("ฝ่ายโยธา เขตดินแดง") are folded into one role node
    ("ฝ่ายโยธา (เขต)") so 50 districts share the same role; the district office itself
    ("เขตดินแดง") stays a District node
  * `type` can hold several comma-separated tags -> one Category edge per tag
Free text (`comment`), photos, addresses and coordinates are never read.

    python pipeline/traffy_handoff.py --input tickets.csv
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from graphkit import GraphBuilder, export, trim_series  # noqa: E402

DAY_MS = 86_400_000
ROOT = "กรุงเทพมหานคร"
HOTLINE = "ร้องทุกข์ กทม. 1555"

NODE_TYPES = {
    "District": {"label": "District office", "color": "#3987e5"},
    "Category": {"label": "Complaint category", "color": "#d95926"},
    "Agency": {"label": "Agency / unit", "color": "#199e70"},
}

# Short English glosses so non-Thai readers can follow. First match wins.
CAT_EN = {
    "ถนน": "Road", "ทางเท้า": "Sidewalk", "ผิดกฎจราจร": "Traffic violation", "ความสะอาด": "Cleanliness",
    "ไฟฟ้า": "Electricity / lights", "เสียง": "Noise", "ป้าย": "Signs", "ทุจริต": "Corruption",
    "กรุงเทพโปร่งใส": "BKK Transparent", "ฝุ่นควัน&กลิ่น&PM2.5": "Dust / smoke / smell",
    "ต้นไม้": "Trees", "อื่นๆ": "Other", "เสนอแนะ": "Suggestion", "อาคารสถานที่ชำรุด": "Damaged building",
    "น้ำท่วม": "Flooding", "ท่อระบายน้ำ": "Drains", "จุดเสี่ยง": "Risk spot", "หาบเร่แผงลอย": "Street vendors",
    "สะพาน": "Bridge", "คลอง": "Canal", "แสงสว่าง": "Street lighting", "ความปลอดภัย": "Safety",
    "สัตว์จรจัด": "Stray animals", "การเดินทาง": "Transport", "PM2.5": "PM2.5", "ร้องเรียน": "Complaint",
    "สอบถาม": "Inquiry", "ขอบคุณ": "Thanks", "PM25": "PM2.5",
}
AGENCY_EN = [
    ("ร้องทุกข์ กทม. 1555", "1555 hotline"), ("กรุงเทพโปร่งใส", "BKK Transparent"),
    ("สำนักงานก่อสร้างและบูรณะ", "Construction & Repair Office"), ("สำนักการโยธา", "Public Works Dept"),
    ("สำนักเทศกิจ", "City Law Enforcement"), ("สำนักการแพทย์", "Medical Services"),
    ("สำนักอนามัย", "Health Dept"), ("สำนักสิ่งแวดล้อม", "Environment Dept"),
    ("สำนักการจราจรและขนส่ง", "Traffic & Transport"), ("สำนักการระบายน้ำ", "Drainage & Sewerage"),
    ("สำนักการศึกษา", "Education"), ("สำนักพัฒนาสังคม", "Social Development"),
    ("สำนักการคลัง", "Finance"), ("สำนักป้องกันและบรรเทาสาธารณภัย", "Disaster Prevention"),
    ("สำนักวัฒนธรรม", "Culture, Sports & Tourism"), ("สำนักการวางผัง", "City Planning"),
    ("ศูนย์ควบคุมระบบป้องกันน้ำท่วม", "Flood Control Centre"), ("ศูนย์ปฏิบัติการติดตามการต่อต้านการทุจริต", "Anti-corruption Centre"),
    ("กองบัญชาการตำรวจนครบาล", "Metropolitan Police"), ("สำนักงานตำรวจแห่งชาติ", "Royal Thai Police"),
    ("ฝ่ายโยธา", "District public works"), ("ฝ่ายเทศกิจ", "District enforcement"),
    ("ฝ่ายรักษาความสะอาด", "District sanitation"), ("ฝ่ายสิ่งแวดล้อม", "District environment"),
    ("ฝ่ายพัฒนาชุมชน", "District community dev."), ("ฝ่ายปกครอง", "District administration"),
    ("ฝ่ายการคลัง", "District finance"), ("ฝ่ายการศึกษา", "District education"),
    ("ฝ่ายรายได้", "District revenue"), ("ฝ่ายทะเบียน", "District registration"),
    ("การไฟฟ้านครหลวง", "Metropolitan Electricity Authority"), ("การประปานครหลวง", "Metropolitan Waterworks"),
]


def en_for_agency(name: str) -> str | None:
    for key, en in AGENCY_EN:
        if name.startswith(key):
            return en
    return None


def agency_kind(name: str) -> str:
    if HOTLINE in name:
        return "Hotline"
    if "โปร่งใส" in name or "ต่อต้านการทุจริต" in name:
        return "Transparency"
    if any(k in name for k in ("ตำรวจ", "การไฟฟ้า", "การประปา", "กรม", "กระทรวง", "บริษัท", "การรถไฟ", "การทางพิเศษ", "ทางหลวง")):
        return "External"
    if name.startswith("ฝ่าย") or "(เขต)" in name:
        return "District unit"
    if name.startswith("สำนักงาน") or name.startswith("ศูนย์") or name.startswith("กอง") or name.startswith("โรงพยาบาล"):
        return "Division / centre"
    if name.startswith("สำนัก"):
        return "Bureau"
    return "Other"


def short(name: str) -> str:
    s = name.replace(" กทม.", "").replace("กรุงเทพมหานคร", "กทม.").strip()
    s = re.sub(r"\s+", " ", s)
    return s if len(s) <= 46 else s[:45] + "…"


def build_normaliser(districts: list[str]):
    ds = sorted(set(districts), key=len, reverse=True)
    dset = set(ds)

    def norm(o: str):
        o = re.sub(r"\s+", " ", o.strip())
        if not o or o == ROOT:
            return None
        if o.startswith("เขต") and o[3:] in dset:
            return ("D", o[3:])
        for d in ds:
            o = o.replace("เขต" + d, "(เขต)")
        o = o.replace("  ", " ").strip()
        return ("A", o)

    return norm


def split_tags(v) -> list[str]:
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return []
    return [t.strip() for t in str(v).split(",") if t.strip()]


STATE_EN = {
    "start": "Waiting", "forward": "Forwarded", "inprogress": "In progress",
    "follow": "Follow-up", "finish": "Finished", "irrelevant": "Not relevant",
}


STATE_MAP = {"รอรับเรื่อง": "start", "กำลังดำเนินการ": "inprogress", "เสร็จสิ้น": "finish", "ไม่เกี่ยวข้อง": "irrelevant",
             "ส่งต่อ": "forward"}


def load_tickets(paths) -> pd.DataFrame:
    """Read one or more exports (monthly files, a glob...), unify `state`, de-duplicate tickets."""
    import glob
    files = []
    for p in ([paths] if isinstance(paths, str) else paths):
        files += sorted(glob.glob(p)) or [p]
    frames = [pd.read_csv(f, low_memory=False) for f in files]
    df = pd.concat(frames, ignore_index=True)
    print(f"  files: {len(files)}  rows: {len(df):,}")
    if "state" in df:
        df["state"] = df["state"].astype(str).str.strip().replace(STATE_MAP)
    if "last_activity" in df:  # a ticket can appear in several exports: keep the freshest copy
        df = df.sort_values("last_activity").drop_duplicates("ticket_id", keep="last")
    else:
        df = df.drop_duplicates("ticket_id", keep="last")
    print(f"  after de-duplication: {len(df):,}")
    return df


def _pct(old, min_n=10):
    return None if len(old) < min_n else round(100 * float(old["fin"].mean()))


def _med(g):
    return None if g["dur_d"].notna().sum() < 5 else round(float(g["dur_d"].median()), 1)


def _days(mins):
    return None if pd.isna(mins) else float(mins) / 1440.0


def build(inp, out, insights_out, bucket_days=7, min_agency=8, min_handoff=3, min_routed=4):
    df = load_tickets(inp)
    need = ["ticket_id", "type", "organization", "district", "timestamp", "state"]
    miss = [c for c in need if c not in df.columns]
    if miss:
        raise SystemExit(f"Missing columns {miss}. Present: {list(df.columns)}")
    df = df.dropna(subset=["organization", "district", "timestamp"]).copy()
    df["district"] = df["district"].astype(str).str.strip()
    ts = pd.to_datetime(df["timestamp"], errors="coerce", format="mixed").dt.tz_localize("Asia/Bangkok", ambiguous="NaT", nonexistent="NaT")
    df["ts_ms"] = (ts.dt.tz_convert("UTC") - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(milliseconds=1)
    df = df[ts.notna()].copy()
    print(f"  tickets: {len(df):,}")

    norm = build_normaliser(df["district"].unique().tolist())
    chains, cross = [], []
    for org, dist in zip(df["organization"], df["district"]):
        ch = []
        for o in re.split(r",\s*", str(org)):
            n = norm(o)
            if n and (not ch or ch[-1] != n):
                ch.append(n)
        chains.append(ch)
        cross.append(any(k == "D" and v != dist for k, v in ch))
    df["chain"] = chains
    df["cross_district"] = cross
    df["L"] = df["chain"].str.len()
    df = df[df["L"] > 0].copy()
    df["tags"] = df["type"].map(split_tags)
    df["dur_d"] = df.get("duration_minutes_total", pd.Series(np.nan, index=df.index)).map(_days)
    df["fin"] = (df["state"] == "finish")
    now_ms = int(df["ts_ms"].max())
    df["age_d"] = (now_ms - df["ts_ms"]) / DAY_MS

    step = bucket_days * DAY_MS
    t0 = int(df["ts_ms"].min() // DAY_MS * DAY_MS)
    nb = int((now_ms - t0) // step) + 1
    df["bucket"] = ((df["ts_ms"] - t0) // step).astype(int)
    series_meta = {"t0": t0, "stepMs": step, "n": nb}

    def nid(k, v):
        return f"{k}:{v}"

    # per-node and per-edge accumulators ------------------------------------------------------
    node_t = defaultdict(list)       # node -> ticket row indexes (positional)
    pair_t = defaultdict(list)       # (a,b) -> positions
    cat_agency_t = defaultdict(list)  # (cat, agency) -> positions
    cat_t = defaultdict(list)
    rows = df.reset_index(drop=True)
    for pos, (ch, tags) in enumerate(zip(rows["chain"], rows["tags"])):
        ids = [nid(k, v) for k, v in ch]
        for x in set(ids):
            node_t[x].append(pos)
        for a, b in zip(ids, ids[1:]):
            pair_t[(a, b)].append(pos)
        for t in tags:
            cat_t[t].append(pos)
            for x in set(ids):
                if x.startswith("A:"):
                    cat_agency_t[(t, x)].append(pos)

    keep_agency = {n for n, p in node_t.items() if n.startswith("A:") and len(p) >= min_agency}
    keep_district = {n for n in node_t if n.startswith("D:")}
    keep = keep_agency | keep_district

    def stats(pos):
        sub = rows.iloc[pos]
        old = sub[sub["age_d"] >= 30]
        return {
            "tickets": len(sub),
            "median_days": None if sub["dur_d"].notna().sum() < 3 else round(float(sub["dur_d"].median()), 1),
            "finished_pct": None if len(old) < 5 else round(100 * float(old["fin"].mean())),
            "reopen_pct": round(100 * float((sub["count_reopen"] > 0).mean())) if "count_reopen" in sub else None,
            "avg_chain": round(float(sub["L"].mean()), 1),
        }

    def series_for(pos):
        arr = np.bincount(rows["bucket"].to_numpy()[pos], minlength=nb)
        return trim_series(arr.tolist())

    def first_seen(pos):
        return int(rows["ts_ms"].to_numpy()[pos].min())

    gb = GraphBuilder()
    for n in sorted(keep):
        k, v = n.split(":", 1)
        pos = node_t[n]
        s = stats(pos)
        attrs = {"tickets": f"{s['tickets']:,}", "median_days_total": s["median_days"],
                 "finished_pct_(tickets_30d+)": s["finished_pct"], "avg_chain_length": s["avg_chain"]}
        if k == "D":
            gb.add_node(n, "เขต" + v, "District", start=first_seen(pos), attrs=attrs)
        else:
            en = en_for_agency(v)
            label = f"{short(v)} · {en}" if en else short(v)
            attrs.update({"kind": agency_kind(v), "full_name": v, "english": en})
            gb.add_node(n, label, "Agency", start=first_seen(pos), attrs=attrs)
    for t, pos in cat_t.items():
        if len(pos) < 5:
            continue
        s = stats(pos)
        en = CAT_EN.get(t)
        agencies = len({a for (c, a) in cat_agency_t if c == t})
        gb.add_node(nid("C", t), f"{t} · {en}" if en else t, "Category", start=first_seen(pos),
                    attrs={"tickets": f"{s['tickets']:,}", "distinct_agencies": agencies,
                           "avg_chain_length": s["avg_chain"], "median_days_total": s["median_days"],
                           "finished_pct_(tickets_30d+)": s["finished_pct"], "english": en})

    handoffs = []
    for (a, b), pos in pair_t.items():
        if a in keep and b in keep and len(pos) >= min_handoff:
            s = stats(pos)
            note = f"{s['tickets']} tickets"
            if s["median_days"] is not None:
                note += f" · median {s['median_days']} d"
            if s["finished_pct"] is not None:
                note += f" · {s['finished_pct']}% finished"
            gb.add_edge(a, b, "handoff", series=series_for(pos))
            gb.edges[-1]["note"] = note
            handoffs.append((a, b, s))
    for (c, a), pos in cat_agency_t.items():
        cn = nid("C", c)
        if cn in gb.nodes and a in keep_agency and len(pos) >= min_routed:
            s = stats(pos)
            gb.add_edge(cn, a, "routed_to", series=series_for(pos))
            gb.edges[-1]["note"] = f"{s['tickets']} tickets"

    meta = {
        "id": "traffy",
        "title": "Traffy Fondue — who hands complaints to whom",
        "subtitle": "Agency handoff network rebuilt from ordered 'organization' paths",
        "demo": False,
        "nodeTypes": NODE_TYPES,
        "filters": [{"key": "kind", "label": "Agency kind"}],
        "directedEdges": ["handoff"],
        "timeNote": ("Edge width = tickets in the window, by ticket creation week. 'Cumulative' = everything so "
                     "far; 'Active' = trailing window. The sample is dense only in the last ~3 months."),
        "source": ("Bangkok Metropolitan Administration / Traffy Fondue open data (5,000-ticket sample). "
                   "Free text, photos, addresses and coordinates are not used."),
        "windowDays": 28, "defaultMode": "cumulative", "defaultSize": "pagerank",
    }
    summary = export(gb, out, meta, series_meta=series_meta)

    # ---------------------------------------------------------------- insights for the slides
    ins = {}
    ins["tickets"] = int(len(rows))
    ins["span"] = [int(rows["ts_ms"].min()), now_ms]
    ins["recent_share_90d"] = round(float((rows["age_d"] <= 90).mean()), 3)
    ins["states"] = {STATE_EN.get(k, k): int(v) for k, v in rows["state"].value_counts().items()}
    ins["via_hotline_pct"] = round(100 * float(rows["chain"].map(lambda c: ("A", HOTLINE) in c).mean()), 1)
    ins["cross_district_pct"] = round(100 * float(rows["cross_district"].mean()), 1)
    ins["root_in_chain_pct"] = round(100 * float(rows["organization"].str.contains(ROOT, regex=False).mean()), 1)
    ins["root_first_pct"] = round(100 * float(rows["organization"].str.split(",").str[0].str.strip().eq(ROOT).mean()), 1)
    ins["distinct_raw_orgs"] = int(len({o.strip() for v in rows["organization"] for o in str(v).split(",")}))
    ins["distinct_nodes_after_fold"] = int(len(node_t))
    ins["organization_vs_action_differ_pct"] = (
        round(100 * float((rows["organization"] != rows["organization_action"]).mean()), 1)
        if "organization_action" in rows else None)
    by_len = []
    for L, g in rows.groupby(rows["L"].clip(upper=6)):
        old = g[g["age_d"] >= 30]
        by_len.append({"len": int(L), "label": f"{int(L)}" if L < 6 else "6+", "tickets": int(len(g)),
                       "median_days": None if g["dur_d"].notna().sum() < 5 else round(float(g["dur_d"].median()), 1),
                       "finished_pct": None if len(old) < 10 else round(100 * float(old["fin"].mean())),
                       "n_old": int(len(old))})
    ins["by_chain_length"] = by_len
    ins["short_vs_long"] = {}
    for name, mask in (("short(<=3)", rows["L"] <= 3), ("long(>=5)", rows["L"] >= 5)):
        g = rows[mask]; old = g[g["age_d"] >= 30]
        ins["short_vs_long"][name] = {
            "tickets": int(len(g)), "median_days": _med(g),
            "finished_pct": _pct(old), "n_old": int(len(old))}

    def lab(n):
        nd = gb.nodes.get(n)
        return nd["label"] if nd else n.split(":", 1)[1]

    top = sorted(handoffs, key=lambda x: -x[2]["tickets"])[:12]
    ins["top_handoffs"] = [{"from": lab(a), "to": lab(b), "tickets": s["tickets"],
                            "median_days": s["median_days"]} for a, b, s in top]
    hset = {(a, b): s for a, b, s in handoffs}
    pp = [(a, b) for (a, b) in hset if (b, a) in hset and a < b]
    ins["bidirectional_pairs"] = len(pp)
    ins["handoff_edges"] = len(handoffs)
    pp_sorted = sorted(pp, key=lambda p: -(hset[p]["tickets"] + hset[(p[1], p[0])]["tickets"]))[:6]
    ins["ping_pong_examples"] = [{"a": lab(a), "b": lab(b), "a_to_b": hset[(a, b)]["tickets"],
                                  "b_to_a": hset[(b, a)]["tickets"]} for a, b in pp_sorted]

    D = nx.DiGraph()
    for a, b, s in handoffs:
        D.add_edge(a, b, w=s["tickets"])
    if D.number_of_nodes():
        bt = nx.betweenness_centrality(D, weight=None)
        pr = nx.pagerank(D, weight="w")
        ins["top_betweenness"] = [{"agency": lab(n), "score": round(v, 4)}
                                  for n, v in sorted(bt.items(), key=lambda kv: -kv[1])[:8] if n in gb.nodes]
        ins["top_pagerank"] = [{"agency": lab(n), "score": round(v, 4)}
                               for n, v in sorted(pr.items(), key=lambda kv: -kv[1])[:8] if n in gb.nodes]
        ins["weak_components"] = nx.number_weakly_connected_components(D)
    cats = []
    for t, pos in cat_t.items():
        if len(pos) < 40:
            continue
        s = stats(pos)
        cats.append({"category": t + (f" · {CAT_EN[t]}" if t in CAT_EN else ""), "tickets": len(pos),
                     "agencies": len({a for (c, a) in cat_agency_t if c == t}),
                     "avg_chain": s["avg_chain"], "finished_pct": s["finished_pct"],
                     "median_days": s["median_days"]})
    ins["categories"] = sorted(cats, key=lambda c: -c["tickets"])[:14]
    # an anonymised worked example: shortest typical long chain, no free text
    def has_fold(r):  # a district unit ("ฝ่าย... เขตX") so the folding step is visible in the example
        parts = re.split(r",\s*", r["organization"])
        return any(("เขต" + r["district"]) in x and x.strip() != "เขต" + r["district"] for x in parts)
    cand = rows[(rows["L"] == 5) & (rows["state"] == "finish") & rows["tags"].map(len).gt(0)]
    cand = cand[cand.apply(has_fold, axis=1)]
    ex = cand.head(1)
    if len(ex):
        r = ex.iloc[0]
        ins["example"] = {"categories": r["tags"], "district": "เขต" + r["district"], "state": STATE_EN.get(r["state"], r["state"]),
                          "chain": [("เขต" + v) if k == "D" else short(v) for k, v in r["chain"]],
                          "raw_org": r["organization"]}
    ins["graph"] = summary
    Path(insights_out).parent.mkdir(parents=True, exist_ok=True)
    Path(insights_out).write_text(json.dumps(ins, ensure_ascii=False, indent=1), encoding="utf-8")
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, nargs="+", help="one or more CSVs / globs, e.g. data/bangkok_*.csv")
    ap.add_argument("--out", default="data/traffy.json")
    ap.add_argument("--insights", default="data/traffy_insights.json")
    ap.add_argument("--min-agency", type=int, default=8)
    ap.add_argument("--min-handoff", type=int, default=3)
    ap.add_argument("--min-routed", type=int, default=4)
    a = ap.parse_args(argv)
    print("  wrote", a.out, build(a.input, a.out, a.insights, min_agency=a.min_agency,
                                  min_handoff=a.min_handoff, min_routed=a.min_routed))


if __name__ == "__main__":
    main()
