"""ICIJ Offshore Leaks -> viewer JSON.

Input : the CSV bulk download from https://offshoreleaks.icij.org/pages/database
        (nodes-entities.csv, nodes-officers.csv, nodes-intermediaries.csv,
         nodes-addresses.csv, nodes-others.csv, relationships.csv).
Output: one JSON file for the web viewer.

The full database is millions of rows - far too much to draw in a browser - so the
adapter extracts a *slice*: every node linked to the chosen countries, plus their
direct neighbours, pruned to the ``--max-nodes`` best-connected nodes.

Time model
  * Entity       : start = incorporation_date,
                   end   = earliest of inactivation_date / struck_off_date.
  * Officer / Intermediary / Address / Other have no dates of their own, so they
    inherit a lifespan from the entities they connect to (earliest start; an end
    only if *every* connected entity has ended).
  * Relationships keep their own start_date / end_date when the file has them.

Column names are matched case-insensitively and every column is optional, so small
schema differences between ICIJ releases do not break the run.

    python pipeline/offshore_adapter.py --input path/to/csvs --country Thailand \
        --out data/offshore.json
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from graphkit import GraphBuilder, export, parse_dates  # noqa: E402

TYPE_KEYS = {  # node type -> substring expected in the file name
    "Entity": "entit",
    "Officer": "officer",
    "Intermediary": "intermediar",
    "Address": "address",
    "Other": "other",
}
NODE_COLS = [
    "node_id", "name", "jurisdiction", "jurisdiction_description", "countries",
    "country_codes", "sourceID", "status", "company_type", "address",
    "incorporation_date", "inactivation_date", "struck_off_date", "dorm_date",
]
REL_COLS = ["node_id_start", "node_id_end", "rel_type", "link", "start_date",
            "end_date", "sourceID"]

NODE_TYPES = {
    "Entity": {"label": "Entity (company)", "color": "#3987e5"},
    "Officer": {"label": "Officer (person / company)", "color": "#d95926"},
    "Intermediary": {"label": "Intermediary", "color": "#199e70"},
    "Address": {"label": "Address", "color": "#7d7c76", "hidden": True},
    "Other": {"label": "Other", "color": "#7d7c76", "hidden": True},
}


def _find(folder: Path, key: str) -> Path | None:
    hits = sorted(p for p in folder.rglob("*.csv")
                  if "node" in p.name.lower() and key in p.name.lower())
    return hits[0] if hits else None


def _read(path: Path, wanted: list[str]) -> pd.DataFrame:
    header = pd.read_csv(path, nrows=0, encoding="utf-8-sig").columns
    lower = {c.lower(): c for c in header}
    use = [lower[w.lower()] for w in wanted if w.lower() in lower]
    df = pd.read_csv(path, usecols=use, dtype=str, encoding="utf-8-sig")
    df.columns = [next(w for w in wanted if w.lower() == c.lower()) for c in df.columns]
    for w in wanted:
        if w not in df.columns:
            df[w] = pd.NA
    return df


def _tokens(arg: str | None) -> list[str]:
    return [t.strip() for t in (arg or "").split(",") if t.strip()]


def build(input_dir, out, countries=None, sources=None, max_nodes=4000,
          min_degree=1, demo=False, title="ICIJ Offshore Leaks") -> dict:
    folder = Path(input_dir)

    # 1. load nodes -------------------------------------------------------------
    frames = []
    for ntype, key in TYPE_KEYS.items():
        path = _find(folder, key)
        if path is None:
            print(f"  (no file for {ntype}, skipping)")
            continue
        df = _read(path, NODE_COLS)
        df["ntype"] = ntype
        frames.append(df)
        print(f"  {ntype:<13} {len(df):>9,} rows  <- {path.name}")
    if not frames:
        raise SystemExit(f"No node CSV files found under {folder}")
    nodes = pd.concat(frames, ignore_index=True)
    nodes = nodes.drop_duplicates("node_id").set_index("node_id", drop=False)
    nodes.index.name = None

    rel_path = next((p for p in sorted(folder.rglob("*.csv"))
                     if "relationship" in p.name.lower()), None)
    if rel_path is None:
        raise SystemExit(f"No relationships CSV found under {folder}")
    rels = _read(rel_path, REL_COLS)
    rels = rels.dropna(subset=["node_id_start", "node_id_end"])
    print(f"  relationships {len(rels):>9,} rows  <- {rel_path.name}")

    # 2. optional source filter --------------------------------------------------
    srcs = _tokens(sources)
    if srcs:
        pat = "|".join(srcs)
        nodes = nodes[nodes["sourceID"].fillna("").str.contains(pat, case=False, regex=True)]
        rels = rels[rels["node_id_start"].isin(nodes.index) & rels["node_id_end"].isin(nodes.index)]

    # 3. seed nodes by country, then expand one hop -------------------------------
    toks = _tokens(countries)
    if toks:
        hay = (nodes["countries"].fillna("") + ";" + nodes["country_codes"].fillna("")).str.lower()
        seed = pd.Series(False, index=nodes.index)
        for t in toks:
            seed |= hay.str.contains(t.lower(), regex=False)
        seeds = set(nodes.index[seed])
        print(f"  seed nodes matching {toks}: {len(seeds):,}")
        keep_rel = rels["node_id_start"].isin(seeds) | rels["node_id_end"].isin(seeds)
        rels = rels[keep_rel]
    rels = rels[rels["node_id_start"].isin(nodes.index) & rels["node_id_end"].isin(nodes.index)]

    # 4. prune to the best-connected nodes ------------------------------------------
    ends = pd.concat([rels["node_id_start"], rels["node_id_end"]])
    degree = ends.value_counts()
    degree = degree[degree >= min_degree]
    if len(degree) > max_nodes:
        degree = degree.head(max_nodes)
    keep = set(degree.index)
    rels = rels[rels["node_id_start"].isin(keep) & rels["node_id_end"].isin(keep)]
    ends = pd.concat([rels["node_id_start"], rels["node_id_end"]])
    keep = set(ends.unique())  # drop anything left without a relationship
    nodes = nodes.loc[sorted(keep)]
    print(f"  slice: {len(nodes):,} nodes, {len(rels):,} relationships")

    # 5. derive times ---------------------------------------------------------------------
    for col in ("incorporation_date", "inactivation_date", "struck_off_date", "dorm_date"):
        nodes[col + "_ms"] = parse_dates(nodes[col])
    is_ent = nodes["ntype"] == "Entity"
    nodes["start"] = nodes["incorporation_date_ms"].where(is_ent)
    nodes["end"] = nodes[["inactivation_date_ms", "struck_off_date_ms"]].min(axis=1).astype("Int64").where(is_ent)

    rels["start_ms"] = parse_dates(rels["start_date"])
    rels["end_ms"] = parse_dates(rels["end_date"])

    ent = nodes.loc[is_ent, ["start", "end"]]
    a = rels.join(ent.add_prefix("a_"), on="node_id_start")
    a = a.join(ent.add_prefix("b_"), on="node_id_end")
    pairs = pd.concat([
        a.loc[a["a_start"].notna() | a["a_end"].notna(), ["node_id_end", "a_start", "a_end"]]
        .rename(columns={"node_id_end": "x", "a_start": "s", "a_end": "e"}),
        a.loc[a["b_start"].notna() | a["b_end"].notna(), ["node_id_start", "b_start", "b_end"]]
        .rename(columns={"node_id_start": "x", "b_start": "s", "b_end": "e"}),
    ])
    pairs = pairs[~pairs["x"].isin(ent.index)]
    # entities connected to each non-entity (including undated ones, for the "all ended" test)
    both = pd.concat([
        rels.loc[rels["node_id_start"].isin(ent.index), ["node_id_end", "node_id_start"]]
        .set_axis(["x", "ent"], axis=1),
        rels.loc[rels["node_id_end"].isin(ent.index), ["node_id_start", "node_id_end"]]
        .set_axis(["x", "ent"], axis=1),
    ])
    both = both[~both["x"].isin(ent.index)]
    total = both.groupby("x")["ent"].nunique()
    ended = pairs.dropna(subset=["e"]).groupby("x").size().reindex(total.index).fillna(0)
    derived_start = pairs.groupby("x")["s"].min()
    derived_end = pairs.groupby("x")["e"].max()
    all_ended = (ended >= total)
    for x, s in derived_start.items():
        if not is_ent.get(x, False):
            nodes.at[x, "start"] = s
    for x, e in derived_end.items():
        if not is_ent.get(x, False) and all_ended.get(x, False):
            nodes.at[x, "end"] = e

    # 6. build the graph ----------------------------------------------------------------------
    def iso(v):
        return None if pd.isna(v) else pd.Timestamp(int(v), unit="ms").strftime("%Y-%m-%d")

    gb = GraphBuilder()
    for nid, r in nodes.iterrows():
        nt = r["ntype"]
        label = r["name"] if pd.notna(r["name"]) else (str(r["address"])[:70] if pd.notna(r["address"]) else nid)
        attrs = {
            "countries": r["countries"],
            "sourceID": r["sourceID"],
        }
        if nt == "Entity":
            attrs.update({
                "jurisdiction": r["jurisdiction_description"] if pd.notna(r["jurisdiction_description"]) else r["jurisdiction"],
                "status": r["status"], "company_type": r["company_type"],
                "incorporated": iso(r["incorporation_date_ms"]),
                "inactivated": iso(r["inactivation_date_ms"]),
                "struck off": iso(r["struck_off_date_ms"]),
                "dormant since": iso(r["dorm_date_ms"]),
            })
        elif nt == "Intermediary":
            attrs["status"] = r["status"]
        elif nt == "Address":
            attrs["address"] = r["address"]
        gb.add_node(nid, label, nt, start=r["start"], end=r["end"], attrs=attrs)
    for r in rels.itertuples(index=False):
        etype = (r.rel_type if pd.notna(r.rel_type) else "related").lower().replace(" ", "_")
        gb.add_edge(r.node_id_start, r.node_id_end, etype, start=r.start_ms, end=r.end_ms)

    meta = {
        "id": "offshore",
        "title": title,
        "subtitle": "Companies, people, intermediaries and addresses in offshore-leak records",
        "demo": demo,
        "nodeTypes": NODE_TYPES,
        "filters": [
            {"key": "countries", "label": "Country"},
            {"key": "jurisdiction", "label": "Jurisdiction", "types": ["Entity"]},
            {"key": "sourceID", "label": "Leak"},
            {"key": "status", "label": "Status", "types": ["Entity"]},
        ],
        "timeNote": ("Entities live from incorporation to inactivation / strike-off. People, "
                     "intermediaries and addresses take the lifespan of the entities they connect to."),
        "source": ("ICIJ Offshore Leaks Database (https://offshoreleaks.icij.org), "
                   "ODbL; contents CC BY-SA. Inclusion in the database does not imply "
                   "wrongdoing."),
        "windowDays": 365,
    }
    if demo:
        meta["demoNote"] = ("DEMO DATA - synthetic, generated by pipeline/make_demo_data.py. "
                            "Names, links and dates are fictional.")
        meta["source"] = "Synthetic demo data shaped like the ICIJ Offshore Leaks CSV export."
    return export(gb, out, meta)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help="folder with the ICIJ CSV files")
    ap.add_argument("--out", default="data/offshore.json")
    ap.add_argument("--country", default="Thailand",
                    help="comma-separated country names / ISO3 codes to seed the slice (empty = whole file)")
    ap.add_argument("--source", default="", help="only these sourceID substrings, e.g. 'Panama,Pandora'")
    ap.add_argument("--max-nodes", type=int, default=4000)
    ap.add_argument("--min-degree", type=int, default=1)
    ap.add_argument("--demo", action="store_true", help="flag the output as synthetic demo data")
    args = ap.parse_args(argv)
    summary = build(args.input, args.out, args.country, args.source,
                    args.max_nodes, args.min_degree, args.demo)
    print("  wrote", args.out, summary)


if __name__ == "__main__":
    main()
