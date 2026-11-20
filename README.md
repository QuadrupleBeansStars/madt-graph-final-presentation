# Who hands the complaint to whom? — Traffy Fondue as a graph

Two static sites in one repo (no build step, no dependencies):

| | Path | What it is |
|---|---|---|
| **Slides** | `/` (`index.html`) | A presentation: the problem, the data, the graph ideas, how it looks, what it shows, why a graph. Every graph on a slide is the real, live, draggable one. |
| **Explorer** | `/explorer/` | The interactive viewer for classmates: filters, search, highlight, shortest path, drag-to-pin and a **time slider**. |

The Traffy Fondue graph is built from the ordered `organization` column — the list of
agencies that handled each complaint — so each ticket becomes a **path** and all
tickets merge into one **agency handoff network**.

> **Data.** Bangkok Traffy Fondue tickets, Jan 2023 – Oct 2026 (about 1.3 million after cleaning).
> Only **derived** graph data is published here (`data/*.json`, about 1 MB): no ticket text, photos,
> addresses or coordinates. The raw monthly exports and the course lecture PDFs are deliberately not in this repo.

## Run locally

```bash
python -m http.server 8000     # slides: http://localhost:8000   explorer: http://localhost:8000/explorer/
```
(ES modules and `fetch` need HTTP; `file://` will not work.)

Slides: `→`/`Space` next step · `←` back · `F` fullscreen · click or swipe also works.

## Deploy on GitHub Pages

Settings → Pages → *Deploy from a branch* → pick the branch (`graph-explorer`) and `/ (root)`.
Slides: `https://quadruplebeansstars.github.io/madt-graph-final-presentation/` ·
Explorer: `.../explorer/`.

## Rebuild the data from raw exports

The site only needs `data/*.json`, which are already committed. Re-running the pipeline needs the
raw monthly exports (`bangkok_YYYY-MM.csv.gz`), which are **not** in this repo.
Python 3.10+ with `pandas`, `numpy`, `networkx`, `scipy` (`pip install -r pipeline/requirements.txt`).

```bash
python pipeline/traffy_handoff.py --input "path/to/bangkok_*.csv.gz"   # -> data/traffy.json, data/traffy_insights.json
python pipeline/traffy_story.py   --input "path/to/bangkok_*.csv.gz"   # -> data/traffy_story.json (numbers on the slides)
python pipeline/graphrag_demo.py  --cache prep.pkl                     # -> data/graphrag_demo.json (offline Graph RAG demo)
```

Required columns: `ticket_id, type, organization, district, timestamp, state`. Optional and used if
present: `organization_action, count_reopen, duration_minutes_total`.

What the adapter does
- **Drops the root** "กรุงเทพมหานคร" (on ~98% of chains, no routing information).
- **Folds district units** ("ฝ่ายโยธา เขตดินแดง") into one role ("ฝ่ายโยธา (เขต)"); district offices stay as District nodes.
- Splits `type` on commas → one Category edge per tag.
- **Nodes:** District office, Agency / unit (with `kind`), Category.
  **Edges:** `handoff` (directed, neighbours in a chain) and `routed_to` (category → agency),
  each with a weekly ticket series and a plain-text `note` ("132,118 tickets · median 5.4 d · 40% finished").
- **Pruning** keeps the graph readable: agencies with ≥ 1,000 tickets, handoffs ≥ 500, category routes ≥ 800
  (`--min-agency --min-handoff --min-routed`). Result: 337 nodes, 1,492 edges.
- **"Finished"** means Traffy state `finish` *and* closed within 90 days, measured only on tickets at least
  120 days old, so old and new tickets are compared fairly.

Things to know about the data: `state` takes the values `start, forward, inprogress, finish, follow,
irrelevant` (`forward`/`follow` are not in the data dictionary, shown as-is); `organization` and
`organization_action` differ on ~95% of rows, the adapter uses `organization` (participation order).
Names are Thai; English glosses are in `pipeline/traffy_handoff.py` (`CAT_EN`, `AGENCY_EN`).

## What the explorer does

- **Filters:** node types, edge types, minimum connections, community, attribute filters
  (e.g. *Agency kind*).
- **Appearance:** size by PageRank or live connections; colour by type or community (Louvain).
- **Time:** slider with an activity histogram, play/pause, speed, *Cumulative* vs *Active*
  (trailing window) views.
- **Interaction:** drag nodes (they stay pinned; double-click releases), pan, zoom, search,
  click for details (edge stats, direction arrows), shortest path between two nodes.
- The layout is computed once; the slider only shows/hides items, so nodes never jump.
- Keyboard: `Space` play/pause · `←/→` step time · `Esc` clear.

## Plug in the Graph RAG module

`window.GraphViewer` lets retrieved subgraphs be shown live next to an answer:

```js
GraphViewer.loadDataset('traffy');
GraphViewer.highlight(['C:ผิดกฎจราจร', 'A:สำนักการโยธา กทม.']);   // ids = node.id in data/traffy.json
GraphViewer.select('A:ร้องทุกข์ กทม. 1555');
GraphViewer.setTime('2026-09-30');
GraphViewer.clear();
```
URL hash: `explorer/index.html#d=traffy&sel=<nodeId>&t=2026-09-01&hl=id1,id2`.
Slides embed the same renderer through `explorer/js/embed.js` (`mount(canvas, rawJson, opts)`).

## Data format (`data/*.json`)

```jsonc
{ "meta":  { "id", "title", "nodeTypes": {"Agency": {"label","color"}}, "filters": [{"key","label"}],
             "directedEdges": ["handoff"], "timeRange": [ms, ms], "series": {"t0","stepMs","n"} },
  "nodes": [{ "id","label","type","start","end","deg","pr","comm","attrs":{} }],
  "edges": [{ "s","t","type","note?", "w","start","end" | "series": {"o": offset, "c": [counts...]} }] }
```
Times are epoch milliseconds (UTC). `deg`, `pr` (PageRank) and `comm` (Louvain) come from
`pipeline/graphkit.py`. Edge direction is `s → t`.

## Limits

- Correlations (longer chain ↔ lower completion) are not causes.
- Canvas 2D handles a few thousand nodes; keep slices under ~5–8k.
- "Finished" is a Traffy status: an agency may act without closing the ticket. List order in `organization`
  is assumed to equal handoff order.
- The Graph RAG answers on the slides were written ahead of time by Claude from retrieved context only
  (a static site holds no API key). Retrieval is real code in `pipeline/graphrag_demo.py`.
- Handoffs below the size cutoffs are pruned, so very small agencies do not appear.

## Layout

```
index.html  deck/{deck.css,deck.js,assets/}               slides (22, with live graph embeds)
explorer/   index.html, css/, js/{app,graph,layout,render,theme,embed}.js
data/       datasets.json, traffy.json, traffy_insights.json, traffy_story.json, graphrag_demo.json
pipeline/   graphkit.py, traffy_handoff.py, traffy_story.py, graphrag_demo.py
```
The explorer has a phone layout (filter drawer, pinch zoom, tap to select); the extra time controls are desktop-only.
