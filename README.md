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
  not connected to it. The selected state is drawn in neutral grey with a white outline in both
  panels, the other nodes take the map's colours, and the region legend is hidden because no
  region colours remain on screen. The *Direction* control switches between out-migration, in-migration, and
  both, and the selected state's links follow it: each is redrawn at the value the map paints for
  that pair and filtered against the threshold on that value, so a weak outbound flow does not show
  as a strong link just because the other state sends many people back. Under out- and
  in-migration those links carry **arrowheads** pointing the way people moved (away from the
  selected state, or into it). Under *Both directions* they stay plain lines, because the value
  is the two-way exchange. The layout is not recomputed on selection; with nothing selected,
  links stay undirected.
- **Direction** also sizes the states (out, in, or total movers) and, with nothing selected, has no
  effect on the links or the net-migration map.
- **Year slider** — steps through the annual estimates; the play button animates them. Watching
  2007–2009 and 2021 in sequence is the point of the time dimension.
- **Threshold slider** — hides weak edges **in the network panel only**. At the 3% default the
  graph carries roughly 350–500 edges and no state is isolated. The map is deliberately left
  alone: it always shows every relationship the selected state has, classified over all of them,
  so the colours mean the same thing wherever the slider happens to sit.

## Map classification

The map uses **five classes** rather than a continuous ramp, so every color on the map stands for
a stated range of values that the legend names.

The two views are classified differently, deliberately:

- **A state selected** — **quantiles** (roughly equal counts of states per class). These values
  are unsigned and heavily right-skewed; equal-interval breaks would drop nearly every state into
  the bottom class and waste four fifths of the palette. A published **zero** gets its own class,
  "0 (none)", in the palest colour, and the quantiles are cut from the positive values only.
  Otherwise the many zeros a small state has pull the bottom breaks onto 0 and the legend reads
  "< 0.0%". Breaks that tie or would leave a class empty are dropped, so the map can show fewer
  than five classes. Percent labels show as many decimals as it takes for no two to print alike.
  Suppressed values sit outside the classes on a hatched row (see *Data*).
- **No selection (net migration)** — quintiles are the *wrong* tool here. Net migration is signed
  with a meaningful zero, and equal-count breaks would put the zero crossing at an arbitrary point
  inside a class, so a state that gained people could be painted the same color as one that lost
  them. Instead the breaks are quantiles of the **absolute** values, mirrored around zero. Classes
  still carry roughly equal counts (typically 7–14 states each), but the middle class straddles
  zero and every boundary is sign-correct.

All colours are [ColorBrewer](https://colorbrewer2.org/) schemes, used as published (Harrower and
Brewer 2003):

| Encoding | Scheme | Type |
|---|---|---|
| A selected state's relationships | YlGnBu, 5 classes | Sequential — light yellow = least, dark blue = most |
| Net migration | RdBu, 5 classes | Diverging — red = lost people, blue = gained them |
| Census region (network nodes) | Set2, 4 colours | Qualitative — the Census Bureau publishes no standard region colours |

ColorBrewer was designed for a light ground. On this near-black page its palest classes (the
smallest shares, and net migration near zero) are the brightest things on screen.

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
  can exceed the estimate itself. An estimate is flagged when its standard error (the 90% MOE
  divided by 1.645) exceeds two-thirds of the estimate. Flagged links are drawn dashed and faded,
  and the tooltip says so explicitly. With a state selected, the same test **dots** the map: a
  fine stipple over the class colour, so the colour still says which class the estimate falls
  in, and dots rather than lines so it is not confused with the suppressed hatching. In a typical
  view this marks 5–11 of the other 50 states, mostly in the pale bottom classes, where flows
  are smallest and relative error largest. The links and the map always use the same test on
  the same value:
  - Under *Both directions* that value is the two-way sum, judged with the combined MOE (root sum
    of squares, the Census Bureau's approximation for a sum of estimates).
  - A share inherits its flow's relative error, since the state-total denominator is far more
    precise.
  - A published zero is not dotted, because relative error is undefined at zero.

  The net-migration map carries no such marker yet. Net is a difference, so a relative-error test
  would flag every state near zero. The right question there is whether the 90% interval
  crosses zero, and the data does not yet carry margins of error for the state totals.

  The **Flag unreliable estimates** checkbox turns both cues off. The underlying MOEs ship in the
  data files rather than being discarded.
- **From 2024 the Bureau suppresses small cells** as `N` (too few sample cases). 255 of the 2,550
  ordered state pairs are suppressed in 2024; earlier years published an estimate for every pair.
  Suppressed cells are `null` in the data, never silently zero.

- **State totals come from the Bureau's published totals, not from summing cells.** Through 2023
  the two are identical — the matrix's row and column sums reproduce the Bureau's own published
  marginals *exactly*, verified state by state. In 2024 a sum of the published cells would fall
  short by whatever the suppressed cells held: 28,120 movers nationally, unevenly spread. That
  shortfall used to feed straight into net migration and the share denominators — enough to flip
  Kansas from a net loss of 85 to a net gain of 97, and to inflate Wyoming's shares by about 9% and
  Vermont's by about 5%. The 2024 workbook also publishes each state's total interstate movers in
  and out (its supplemental Tables 2 and 3, which cover the same 50 states plus DC and exclude
  Puerto Rico). Suppression does not reduce those totals, so the build uses them. It checks that
  they are never below the cell sum and equal it wherever a state has no suppressed cells, and
  stops if either check fails.

  So the **net migration map is complete in every year**. What suppression still hides is the
  individual flows. With a state selected, a pair whose value depends on a suppressed flow is
  drawn **hatched** with its own legend row, outside the five classes, rather than counted as zero.
  Under *Both directions* one suppressed direction is enough to hatch a pair, since a known flow
  plus an unknown one cannot be classed. Suppressed pairs draw no network link, and the tooltip
  names how many of a state's flows are suppressed. The counts ship as `out_sup` / `in_sup` per
  node per year.

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

Map and legend colours are from ColorBrewer, by Cynthia A. Brewer, via
[d3-scale-chromatic](https://github.com/d3/d3-scale-chromatic):

- Brewer, Cynthia A. [ColorBrewer 2.0: Color Advice for Cartography](https://colorbrewer2.org/).
  The Pennsylvania State University.
- Harrower, Mark, and Cynthia A. Brewer. 2003. "ColorBrewer.org: An Online Tool for Selecting
  Colour Schemes for Maps." *The Cartographic Journal* 40 (1): 27–37.
  [doi:10.1179/000870403235002042](https://doi.org/10.1179/000870403235002042).

Built with assistance from Claude (Anthropic).

## License

[MIT](LICENSE)
