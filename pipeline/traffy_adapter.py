"""Traffy Fondue complaints -> viewer JSON.

Input : a CSV, JSON or GeoJSON export of Bangkok Traffy Fondue tickets
        (e.g. from https://share.traffy.in.th/teamchadchart or data.bangkok.go.th).
Output: one JSON file for the web viewer.

Hundreds of thousands of tickets cannot be drawn as nodes, so the adapter builds an
*aggregated* graph and lets time flow through the edge weights:

  * District, Category and Agency nodes.
  * District--Category and Category--Agency edges carry a weekly time series of
    ticket counts, so the viewer can show how the complaint network grows or
    which categories dominate in a trailing window (for example the flood season).
  * District~District "similar" edges link districts with a similar complaint mix
    (Pearson correlation of category shares, top-k per district). Community
    detection on this layer groups districts with the same problems.
  * A random sample of individual tickets is attached as "Complaint" nodes with a
    reported -> in progress -> finished timeline (colour by state in the viewer).

Column names differ between exports, so each field is matched against a list of
aliases; override any of them with ``--col field=column_name``.

    python pipeline/traffy_adapter.py --input tickets.csv --out data/traffy.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from graphkit import GraphBuilder, export, parse_dates, trim_series  # noqa: E402

DAY_MS = 86_400_000

ALIASES = {
    "id": ["ticket_id", "id", "ticketid", "ticket"],
    "category": ["type", "category", "problem_type", "problem_type_fondue", "issue_type"],
    "org": ["organization", "org", "org_action", "agency", "department"],
    "ts": ["timestamp", "created_at", "ticket_created", "created", "date", "time_stamp"],
    "last": ["last_activity", "updated_at", "last_update", "last_updated"],
    "state": ["state", "status", "state_type_latest", "ticket_state"],
    "district": ["district", "district_name", "khet"],
    "subdistrict": ["subdistrict", "sub_district", "khwaeng"],
    "province": ["province", "province_name"],
}

NODE_TYPES = {
    "District": {"label": "District", "color": "#3987e5"},
    "Category": {"label": "Complaint category", "color": "#d95926"},
    "Agency": {"label": "Responsible agency", "color": "#199e70"},
    "Complaint": {"label": "Complaint (sample)", "color": "#7d7c76", "hidden": True},
}
NODE_STATES = {  # status palette: icon-free here, the viewer legend carries the text label
    "reported": {"label": "Reported / waiting", "color": "#ec835a"},
    "in_progress": {"label": "In progress / forwarded", "color": "#fab219"},
    "finished": {"label": "Finished", "color": "#0ca30c"},
}


# ---------------------------------------------------------------------------- loading
def load_any(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix in (".csv", ".tsv", ".txt"):
        return pd.read_csv(path, dtype=str, sep="\t" if suffix == ".tsv" else ",",
                           encoding="utf-8-sig")
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if isinstance(data, dict) and "features" in data:  # GeoJSON
        rows = []
        for f in data["features"]:
            props = dict(f.get("properties") or {})
            coords = (f.get("geometry") or {}).get("coordinates")
            if coords and len(coords) >= 2:
                props.setdefault("lon", coords[0])
                props.setdefault("lat", coords[1])
            rows.append(props)
        return pd.DataFrame(rows).astype(object)
    if isinstance(data, dict):
        for key in ("results", "data", "items", "tickets"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    return pd.json_normalize(data).astype(object)


def pick_columns(df: pd.DataFrame, overrides: dict[str, str]) -> dict[str, str]:
    lower = {c.lower(): c for c in df.columns}
    found = {}
    for field, names in ALIASES.items():
        if field in overrides:
            found[field] = overrides[field]
        else:
            hit = next((lower[n] for n in names if n in lower), None)
            if hit:
                found[field] = hit
    missing = [f for f in ("category", "ts", "district") if f not in found]
    if missing:
        raise SystemExit(f"Could not find required column(s) {missing}. Columns present: "
                         f"{list(df.columns)}\nUse --col field=column_name to map them.")
    return found


def split_cats(v) -> list[str]:
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return []
    s = str(v).strip().strip("{}[]()")
    parts = [re.sub(r"^['\"\s]+|['\"\s]+$", "", p) for p in re.split(r"[,|;]", s)]
    return [p for p in parts if p]


def norm_state(v) -> str:
    s = str(v or "").lower()
    if any(k in s for k in ("finish", "done", "resolv", "close", "complete", "เสร็จ", "แก้ไขแล้ว")):
        return "finished"
    if any(k in s for k in ("progress", "forward", "process", "กำลัง", "ส่งต่อ", "ดำเนินการ")):
        return "in_progress"
    return "reported"


# ---------------------------------------------------------------------------- build
def build(input_path, out, bucket_days=7, sample=400, similar_k=4, similar_min=0.35,
          overrides=None, province_contains=None, demo=False, seed=7,
          title="Traffy Fondue - Bangkok complaints") -> dict:
    raw = load_any(Path(input_path))
    col = pick_columns(raw, overrides or {})
    print("  columns used:", col)
    df = pd.DataFrame({k: raw[v] for k, v in col.items()})

    if province_contains and "province" in df:
        df = df[df["province"].fillna("").str.contains(province_contains, regex=True)]
    df["ts_ms"] = parse_dates(df["ts"])
    df["last_ms"] = parse_dates(df["last"]) if "last" in df else pd.NA
    df = df.dropna(subset=["ts_ms", "district"])
    df = df[df["district"].astype(str).str.strip() != ""]
    df["district"] = df["district"].astype(str).str.strip()
    print(f"  usable tickets: {len(df):,}")
    if df.empty:
        raise SystemExit("No usable tickets after cleaning.")

    df["cats"] = df["category"].map(split_cats)
    df = df[df["cats"].map(len) > 0]
    df["state_n"] = df["state"].map(norm_state) if "state" in df else "reported"

    # time buckets ---------------------------------------------------------------------------
    step = int(bucket_days) * DAY_MS
    t0 = int(df["ts_ms"].min() // DAY_MS * DAY_MS)
    t1 = int(df["ts_ms"].max())
    nb = int((t1 - t0) // step) + 1
    df["bucket"] = ((df["ts_ms"].astype("int64") - t0) // step).astype(int)
    series_meta = {"t0": t0, "stepMs": step, "n": nb}

    ex = df.explode("cats").rename(columns={"cats": "cat"})
    gb = GraphBuilder()

    def dense(group_bucket) -> list[int]:
        arr = np.zeros(nb, dtype=int)
        vc = group_bucket.value_counts()
        arr[vc.index.to_numpy()] = vc.to_numpy()
        return arr.tolist()

    # nodes ------------------------------------------------------------------------------------
    d_tot = df.groupby("district").size()
    for d, n in d_tot.items():
        gb.add_node(f"D:{d}", d, "District", attrs={"tickets": f"{n:,}"})
    c_tot = ex.groupby("cat").size()
    for c, n in c_tot.items():
        gb.add_node(f"C:{c}", c, "Category", attrs={"tickets": f"{n:,}"})

    # district -- category (time series) -----------------------------------------------------
    for (d, c), g in ex.groupby(["district", "cat"]):
        gb.add_edge(f"D:{d}", f"C:{c}", "reports", series=trim_series(dense(g["bucket"])))

    # category -- agency (time series) -------------------------------------------------------
    if "org" in df:
        ex2 = ex.dropna(subset=["org"])
        ex2 = ex2[ex2["org"].astype(str).str.strip() != ""]
        for a, n in ex2.groupby("org").size().items():
            gb.add_node(f"A:{a}", a, "Agency", attrs={"tickets": f"{n:,}"})
        for (c, a), g in ex2.groupby(["cat", "org"]):
            gb.add_edge(f"C:{c}", f"A:{a}", "handled_by", series=trim_series(dense(g["bucket"])))

    # district ~ district similarity (static layer) ------------------------------------------
    mat = ex.groupby(["district", "cat"]).size().unstack(fill_value=0)
    if mat.shape[0] > 2 and mat.shape[1] > 2:
        share = mat.div(mat.sum(axis=1), axis=0)
        corr = np.corrcoef(share.to_numpy())
        names = list(share.index)
        seen = set()
        for i, d in enumerate(names):
            order = [j for j in np.argsort(-corr[i]) if j != i][:similar_k]
            for j in order:
                if corr[i, j] >= similar_min and (min(i, j), max(i, j)) not in seen:
                    seen.add((min(i, j), max(i, j)))
                    gb.add_edge(f"D:{d}", f"D:{names[j]}", "similar", w=float(corr[i, j]) * 20)

    # sampled individual complaints (state timeline) -----------------------------------------
    if sample > 0:
        smp = df.sample(n=min(sample, len(df)), random_state=seed)
        has_id = "id" in df.columns
        for r in smp.itertuples(index=False):
            tid = f"T:{r.id}" if has_id and pd.notna(r.id) else f"T:{r.ts_ms}-{r.district}"
            phases = [[int(r.ts_ms), "reported"]]
            if r.state_n != "reported":
                tl = int(r.last_ms) if pd.notna(r.last_ms) and r.last_ms > r.ts_ms else int(r.ts_ms) + DAY_MS
                phases.append([tl, r.state_n])
            gb.add_node(tid, str(r.id) if has_id else tid, "Complaint",
                        start=r.ts_ms, attrs={
                            "category": ", ".join(r.cats), "district": r.district,
                            "agency": getattr(r, "org", None), "state": r.state_n,
                        }, phases=phases)
            gb.add_edge(tid, f"D:{r.district}", "reported_in", start=r.ts_ms)

    meta = {
        "id": "traffy",
        "title": title,
        "subtitle": "Districts, complaint categories and responsible agencies, over time",
        "demo": demo,
        "nodeTypes": NODE_TYPES,
        "nodeStates": NODE_STATES,
        "filters": [],
        "timeNote": ("Edge width = tickets in the current time window (weekly buckets). "
                     "'Cumulative' counts everything so far; 'Active' counts a trailing window."),
        "source": ("Bangkok Metropolitan Administration / Traffy Fondue (NECTEC) open data. "
                   "Aggregated; free-text and photos are not used."),
        "windowDays": 90,
        "defaultMode": "active",
        "edgeDefaults": {"similar": False},  # kept in the layout, hidden until toggled on
        "defaultSize": "live",
    }
    if demo:
        meta["demoNote"] = ("DEMO DATA - synthetic tickets generated by pipeline/make_demo_data.py. "
                            "Counts and patterns are fictional.")
        meta["source"] = "Synthetic demo data shaped like a Traffy Fondue ticket export."
    return export(gb, out, meta, series_meta=series_meta)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help="CSV / JSON / GeoJSON ticket export")
    ap.add_argument("--out", default="data/traffy.json")
    ap.add_argument("--bucket-days", type=int, default=7)
    ap.add_argument("--sample", type=int, default=400, help="individual tickets to attach (0 = none)")
    ap.add_argument("--similar-k", type=int, default=4)
    ap.add_argument("--province-contains", default=None, help="regex, e.g. 'กรุงเทพ|Bangkok'")
    ap.add_argument("--col", action="append", default=[], metavar="FIELD=COLUMN",
                    help="override column mapping, e.g. --col category=problem_type_fondue")
    ap.add_argument("--demo", action="store_true")
    args = ap.parse_args(argv)
    overrides = dict(kv.split("=", 1) for kv in args.col)
    summary = build(args.input, args.out, args.bucket_days, args.sample, args.similar_k,
                    overrides=overrides, province_contains=args.province_contains, demo=args.demo)
    print("  wrote", args.out, summary)


if __name__ == "__main__":
    main()
