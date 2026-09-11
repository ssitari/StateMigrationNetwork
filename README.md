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

- **No selection** — the map shows **net migration** (arrivals minus departures): blue states
  gained population from other states that year, red states lost it. Network nodes are colored by
  Census region and sized by total interstate movement.
- **A state selected** — the map shows that state's relationships, and the network dims everything
  not connected to it. The *Direction* control switches between out-migration, in-migration, and
  both.
- **Year slider** — steps through the annual estimates; the play button animates them. Watching
  2007–2009 and 2021 in sequence is the point of the time dimension.
- **Threshold slider** — hides weak edges. At the 3% default the graph carries roughly 350–500
  edges and no state is isolated.

## Map classification

The map uses **five classes** rather than a continuous ramp, so every color on the map stands for
a stated range of values that the legend names.

The two views are classified differently, deliberately:

- **A state selected** — true **quintiles** (equal counts of states per class). These values are
  unsigned and heavily right-skewed; equal-interval breaks would drop nearly every state into the
  bottom class and waste four fifths of the palette.
- **No selection (net migration)** — quintiles are the *wrong* tool here. Net migration is signed
  with a meaningful zero, and equal-count breaks would put the zero crossing at an arbitrary point
  inside a class, so a state that gained people could be painted the same color as one that lost
  them. Instead the breaks are quantiles of the **absolute** values, mirrored around zero. Classes
  still carry roughly equal counts (typically 7–14 states each), but the middle class straddles
  zero and every boundary is sign-correct.

Both ramps are built for a dark ground, where brightness advances and darkness recedes — the
reverse of print. ColorBrewer's schemes put their palest colour at the class meaning "least" or
"no change", so on a near-black map they made the states that did nothing the loudest thing on
screen. The sequential ramp is viridis, which runs dark to bright and stays ordered for colourblind
readers; the diverging ramp keeps red = losing and blue = gaining but carries magnitude as
brightness away from a dark neutral.

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

- **In 2024 that makes every state total a floor, and every share an upper bound.** A state's
  out-migration total is the sum of its published outbound cells. Through 2023 that reproduces the
  Bureau's own published marginals *exactly* — verified state by state against the "Different state
  of residence 1 year ago" column. From 2024 it is short by whatever the suppressed cells held, and
  the share metric divides by it, so an understated denominator becomes an overstated share.
  Suppression falls hardest on small states, which are the ones the share metric exists to show:
  Vermont loses 11 of its 50 outbound cells and Wyoming 14, which lifts their shares by roughly a
  fifth. Nationally the shortfall is about 66,000 movers, under 1% of the total.

  The app does not paper over this. Node totals show as `≥`, affected shares carry a `†`, and the
  tooltip names the number of suppressed flows. The counts ship as `out_sup` / `in_sup` per node
  per year so the caveat travels with the data rather than living only in this README.

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
| `data/migration_network.json` | Nodes (with per-year `out`/`in` totals and the `out_sup`/`in_sup` counts of cells those totals are missing), undirected links with both directional flows and MOEs per year, and source provenance |
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
