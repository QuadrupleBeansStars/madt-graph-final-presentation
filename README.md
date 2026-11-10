# Who hands the complaint to whom? — Traffy Fondue as a graph

Two static sites in one repo (no build step, no dependencies):

| | Path | What it is |
|---|---|---|
| **Slides** | `/` (`index.html`) | A presentation: the problem, the data, the graph ideas, how it looks, what it shows, why a graph. Every graph on a slide is the real, live, draggable one. |
| **Explorer** | `/explorer/` | The interactive viewer for classmates: filters, search, highlight, shortest path, drag-to-pin and a **time slider**. |

The Traffy Fondue graph is built from the ordered `organization` column — the list of
agencies that handled each complaint — so each ticket becomes a **path** and 5,000
tickets merge into one **agency handoff network**.

> **Data status.** Traffy Fondue is the **real 5,000-ticket sample** (derived data only:
> free text, photos, addresses and coordinates are never read). The Offshore Leaks tab in
> the explorer is **synthetic demo data** (a banner says so). The sample is ~84% from the
> last 90 days, so the time slider is only dense in recent months.

## Run locally

```bash
python -m http.server 8000     # slides: http://localhost:8000   explorer: http://localhost:8000/explorer/
```
(ES modules and `fetch` need HTTP; `file://` will not work.)

Slides: `→`/`Space` next step · `←` back · `F` fullscreen · click or swipe also works.

## Deploy on GitHub Pages

Settings → Pages → *Deploy from a branch* → pick the branch (`graph-explorer`, or `main`
after merging) and `/ (root)`. The slides are at the site root, the explorer at `/explorer/`.

## Rebuild the Traffy graph from a new export

Python 3.10+ with `pandas`, `numpy`, `networkx`, `scipy`.

```bash
python pipeline/traffy_handoff.py --input "path/to/bangkok_*.csv"   # one or several files / globs
# writes data/traffy.json (graph for the viewer) and data/traffy_insights.json (numbers on the slides)
```

Required columns: `ticket_id, type, organization, district, timestamp, state`. Optional and
used if present: `organization_action, count_reopen, duration_minutes_total`.

What the adapter does
- **Drops the root** "กรุงเทพมหานคร" (on ~98% of chains, no routing information).
- **Folds district units** ("ฝ่ายโยธา เขตดินแดง") into one role ("ฝ่ายโยธา (เขต)"); district
  offices stay as 50 District nodes.
- Splits `type` on commas → one Category edge per tag.
- **Nodes:** District office, Agency / unit (with `kind`), Category.
  **Edges:** `handoff` (directed, neighbours in a chain) and `routed_to` (category → agency),
  each with a weekly ticket series and a plain-text `note` ("226 tickets · median 1.2 d · 80% finished").
- Completion rates only use tickets ≥ 30 days old (a young ticket cannot be finished yet).
- Thresholds: `--min-agency 8 --min-handoff 3 --min-routed 4`.

Things to know about the data: `state` takes the values `start, forward, inprogress, finish,
follow, irrelevant` (`forward`/`follow` are not in the data dictionary — shown as-is);
`organization` and `organization_action` differ on ~95% of rows, the adapter uses
`organization` (participation order). Names are Thai; English glosses are in
`pipeline/traffy_handoff.py` (`CAT_EN`, `AGENCY_EN`).

Offshore demo data: `python pipeline/make_demo_data.py`. Real ICIJ data:
`python pipeline/offshore_adapter.py --input <csv folder> --country Thailand --max-nodes 4000`
(untested on the real download — check the printed counts on first run).

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

- A 5,000-ticket sample; completion rates for long chains rest on a few hundred tickets.
- Correlations (longer chain ↔ lower completion) are not causes.
- Canvas 2D handles a few thousand nodes; keep slices under ~5–8k.
- Traffy data: check the provider's terms before publishing larger real extracts.
  Offshore Leaks: inclusion does not imply wrongdoing; data is ODbL / CC BY-SA.

## Layout

```
index.html  deck/{deck.css,deck.js}                      slides
explorer/   index.html, css/, js/{app,graph,layout,render,theme,embed}.js
data/       datasets.json, traffy.json, traffy_insights.json, offshore.json (demo)
pipeline/   graphkit.py, traffy_handoff.py, offshore_adapter.py, make_demo_data.py
```
