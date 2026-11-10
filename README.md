# Graph Explorer — Offshore Leaks & Traffy Fondue

An interactive, static web page (no build step, no dependencies) that draws two datasets
as graphs: filter nodes, drag them, highlight neighbourhoods, find shortest paths, and
scrub a **time slider** to watch the graph grow and change.

| Dataset | Nodes | What the time slider shows |
|---|---|---|
| **ICIJ Offshore Leaks** (global) | companies, officers, intermediaries, addresses | companies appearing at incorporation and disappearing at inactivation / strike-off |
| **Traffy Fondue** (Bangkok) | districts, complaint categories, agencies (+ sampled tickets) | weekly ticket counts per edge — flood season, growth, a trailing "last N months" window; sampled tickets change colour reported → in progress → finished |

> **The data checked into `data/` is synthetic demo data** (a banner says so in the app).
> It is shaped like the real exports so the viewer and pipeline can be developed and
> demoed offline. Replace it with the real data using the steps below.

## Run locally

```bash
python -m http.server 8000      # then open http://localhost:8000
```
(ES modules and `fetch` need HTTP — opening `index.html` as a `file://` URL will not work.)

## Deploy on GitHub Pages

Settings → Pages → *Deploy from a branch* → `main` / `/ (root)`. Everything is static.

## Use the real data

Python 3.10+ with `pandas`, `numpy`, `networkx`, `scipy`.

**1. Offshore Leaks** — download the CSV bulk archive from
<https://offshoreleaks.icij.org/pages/database>, unzip, then:

```bash
python pipeline/offshore_adapter.py --input path/to/csv_folder --country Thailand \
       --max-nodes 4000 --out data/offshore.json
```
The full database is millions of rows, so the adapter extracts a *slice*: everything
linked to `--country` (names or ISO3 codes, comma-separated), one hop out, pruned to the
best-connected `--max-nodes`. Options: `--source "Panama,Pandora"`, `--min-degree 2`.

**2. Traffy Fondue** — export tickets as CSV / JSON / GeoJSON (BMA open data
`data.bangkok.go.th`, or the Traffy Fondue public map). Then:

```bash
python pipeline/traffy_adapter.py --input tickets.csv --out data/traffy.json \
       --province-contains "กรุงเทพ|Bangkok" --sample 400
```
Column names vary between exports. The adapter matches common aliases (see `ALIASES` in
the file) and prints the columns it picked; override any with
`--col category=problem_type_fondue --col district=district_name`.

**3. Update `data/datasets.json`** if you rename files or add datasets (id, file, title, blurb).

> Both adapters were developed against the *documented* schemas and tested end-to-end on
> the synthetic files from `pipeline/make_demo_data.py`. They have **not** been run on the
> real downloads yet — check the printed column mapping and counts on the first real run.

Regenerate the demo data any time with `python pipeline/make_demo_data.py`.

## What the viewer does

- **Filters:** node types, edge types, minimum connections, community, and attribute
  filters (country, jurisdiction, leak, status — defined per dataset in `meta.filters`).
- **Appearance:** size by PageRank or by live connections in the current time view;
  colour by node type, community (Louvain) or complaint state.
- **Time:** slider with an activity histogram, play/pause, speed, *Cumulative* vs
  *Active* views, trailing window for weighted edges, include/exclude undated items.
- **Interaction:** drag nodes (they stay pinned; double-click releases), pan, zoom,
  search, click for details and neighbours, shortest path between two nodes.
- **Layout is computed once** and the slider only shows/hides items, so nodes never jump
  while time moves. *Re-layout visible* re-flows whatever is currently shown.
- Keyboard: `Space` play/pause · `←/→` step time · `Esc` clear.

## Plug in the Graph RAG module

The page exposes `window.GraphViewer`, so retrieved subgraphs can be shown live:

```js
GraphViewer.loadDataset('traffy');
GraphViewer.highlight(['D:Chatuchak', 'C:Flood', 'A:Drainage & Sewerage Dept.']); // ids = node.id in the JSON
GraphViewer.select('D:Chatuchak');
GraphViewer.setTime('2025-09-30');
GraphViewer.clear();
```
`highlight()` reveals hidden nodes (enables their type, moves time forward if needed) and
dims everything else. The URL hash works too: `#d=offshore&sel=<nodeId>&t=2012-06-01&hl=id1,id2`.

## Data format (`data/*.json`)

```jsonc
{ "meta":  { "id", "title", "nodeTypes": {"Entity": {"label","color","hidden?"}}, "filters": [...],
             "timeRange": [ms, ms], "series": {"t0","stepMs","n"}, "demo": true, ... },
  "nodes": [{ "id","label","type","start","end","deg","pr","comm","attrs":{}, "phases":[[ms,"state"]] }],
  "edges": [{ "s","t","type", "w","start","end" | "series": {"o": offset, "c": [counts...]} }] }
```
All times are epoch milliseconds (UTC). `start`/`end` null on both = "undated".
`deg`, `pr` (PageRank, normalised) and `comm` (Louvain) are computed in `pipeline/graphkit.py`.

## Limits & notes

- Canvas 2D rendering handles a few thousand nodes comfortably; keep slices under ~5–8k nodes.
- **Offshore Leaks:** inclusion in the database does not imply wrongdoing. Data is ODbL,
  contents CC BY-SA (check the current terms on the ICIJ site) — keep the attribution
  and share derived data alike.
- **Traffy Fondue:** the pipeline aggregates and never uses free text, photos or contact
  details. Check the data provider's terms before publishing real data.

## Layout

```
index.html  css/style.css  js/{app,graph,layout,render,theme}.js
data/       datasets.json, offshore.json, traffy.json   (demo data)
pipeline/   graphkit.py, offshore_adapter.py, traffy_adapter.py, make_demo_data.py
```
