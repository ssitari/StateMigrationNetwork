# State-to-State Migration Network

A dual-panel D3 visualization of interstate migration in the United States, 2005–2024. The left
panel is a force-directed network in which each node is a state; the right panel is a choropleth of
the same states. Selecting a state re-colors the map by that state's migration relationships, so the
abstract structure of the migration system and the real geography of the country can be read against
each other.

Built with [D3.js](https://d3js.org). No build step — plain HTML, CSS, and JavaScript.

---

## Live demo

[View on GitHub Pages](https://ssitari.github.io/StateMigrationNetwork/)

---

## The metric that makes it legible

Weighting edges by the raw number of movers produces a picture of population and distance:
California trades with Texas because both are enormous and adjacent. That is true but not
interesting, and it drowns out every small state.

The default edge weight is instead **the share of a state's interstate movers** that a flow
represents — of everyone who left Rhode Island last year, what fraction went to Massachusetts? An
edge between two states takes the larger of the two directional shares, so a pair matters if
*either* state sends a meaningful slice of its leavers to the other.

This is what surfaces the real structure. The strongest pairs in 2024 are:

| Pair | Share of the origin's interstate movers |
|---|---|
| Rhode Island → Massachusetts | 47.6% |
| North Dakota → Minnesota | 31.6% |
| District of Columbia → Maryland | 31.4% |
| Louisiana → Texas | 29.0% |
| Oregon → Washington | 28.7% |

Small states are not noise in this view; they are the most tightly coupled nodes in the system. A
toggle switches back to raw counts if you want to see the population-and-distance picture for
comparison.

## Reading the panels

- **No selection** — the map shows **net migration** (arrivals minus departures) on a diverging
  scale: blue states gained population from other states that year, red states lost it. Network
  nodes are colored by Census region and sized by total interstate movement.
- **A state selected** — the map shows that state's relationships on a sequential scale, and the
  network dims everything not connected to it. The *Direction* control switches between
  out-migration, in-migration, and both.
- **Year slider** — steps through the annual estimates; the play button animates them. Watching
  2007–2009 and 2021 in sequence is the point of the time dimension.
- **Threshold slider** — hides weak edges. At the 3% default the graph carries roughly 350–500
  edges and no state is isolated.

## Data

U.S. Census Bureau, [American Community Survey State-to-State Migration
Flows](https://www.census.gov/data/tables/time-series/demo/geographic-mobility/state-to-state-migration.html),
2005–2024. Boundaries are the Census Bureau's 2024 cartographic boundary file at 1:20,000,000.

Four things about this source are worth knowing before drawing conclusions from the visualization:

- **These are one-year flows.** The ACS asks where you lived one year ago. The 1980, 1990, and 2000
  censuses asked where you lived *five* years ago, so those older tables are not comparable to
  these and are deliberately not mixed in here.
- **There is no 2020.** The Census Bureau did not release standard 2020 ACS 1-year estimates,
  because pandemic conditions wrecked data collection. The year slider steps from 2019 to 2021.
  The gap is real, not an oversight.
- **Every number is a survey estimate with a margin of error**, and for small state pairs the MOE
  can exceed the estimate itself. Edges whose 90% margin of error implies a standard error above
  two-thirds of the estimate are drawn dashed and faded; the tooltip says so explicitly. The
  underlying MOEs ship in the data files rather than being discarded.
- **From 2024 the Bureau suppresses small cells** as `N` (too few sample cases). 255 of the 2,550
  ordered state pairs are suppressed in 2024; earlier years published an estimate for every pair.
  Suppressed cells are `null` in the data, never silently zero.

## Running locally

The app loads its data via `fetch()`, so it must be served over HTTP:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Rebuilding the data

Both scripts download from the Census Bureau, cache into `data/cache/` (gitignored), and are safe
to re-run.

```bash
pip install pandas requests openpyxl xlrd pyshp

python build_states_geojson.py     # -> data/states.geojson
python build_migration_data.py     # -> data/migration_network.json, data/s2s_flows_long.csv
```

`build_migration_data.py` handles the two different sheet layouts the Bureau has used over the
years — a wide matrix wrapped into horizontal blocks for 2005–2023, and a tidy three-column layout
for 2024 — and fails loudly if any year does not yield exactly 2,550 ordered state pairs. The
SHA-256 of every source file it downloaded is recorded in the `provenance` block of
`migration_network.json`.

### Outputs

| File | What it is |
|---|---|
| `data/migration_network.json` | Nodes, undirected links with both directional flows and MOEs per year, and source provenance |
| `data/s2s_flows_long.csv` | Tidy `year, origin, destination, movers, moe` — 48,450 rows, useful on its own |
| `data/states.geojson` | 50 states + DC, WGS 84, generalized to 1:20M |

---

## Related

The same linked network-and-choropleth idea applied to NYC Citi Bike trips:
[LinkedNetworkGraphChoroplethMap](https://github.com/ssitari/LinkedNetworkGraphChoroplethMap).

## Acknowledgements

Built with assistance from Claude (Anthropic).

## License

[MIT](LICENSE)
