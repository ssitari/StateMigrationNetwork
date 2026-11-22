'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
// Census regions are categories, so they take a ColorBrewer qualitative scheme (Set2). The Census
// Bureau publishes no standard colours for its four regions.
const REGION_COLOR = {
  'Northeast': d3.schemeSet2[2],   // #8da0cb
  'Midwest':   d3.schemeSet2[0],   // #66c2a5
  'South':     d3.schemeSet2[1],   // #fc8d62
  'West':      d3.schemeSet2[3],   // #e78ac3
};
const DEFAULT_COLOR = '#aaa';
const LAND_COLOR    = '#2a2a2a';

// The selected state is marked by a neutral grey fill and a white outline, in both panels. It is
// not a region colour, because the region legend is hidden while a state is selected, and not
// white, which would be confused with YlGnBu's palest class and RdBu's near-white midpoint.
const SELECTED_FILL = '#8c8c8c';

// An ACS margin of error is published at 90% confidence, so the standard error is MOE / 1.645.
// Flag an estimate when its standard error exceeds two-thirds of the estimate -- the Census
// Bureau's own rule of thumb for "use with caution".
const CV_LIMIT = 2 / 3;

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  yearIndex:  0,
  metric:    'share',   // 'share' | 'movers'
  mode:      'total',   // 'total' | 'out' | 'in'
  threshold:  0,
  flagUnreliable: true,
};

let selectedNode = null;
let networkData  = null;
let simNodes     = [];
let activeLinks  = [];
let allLinks     = [];
let fipsToIndex  = {};
let playTimer    = null;
let wScale       = null;   // link width scale, rebuilt by draw() over the undirected weights

// ── SVG / layout ─────────────────────────────────────────────────────────────
const container = document.getElementById('chart-container');
const svg       = d3.select('#chart');
const g         = svg.append('g');
const linkLayer  = g.append('g').attr('class', 'links');
const arrowLayer = g.append('g').attr('class', 'arrows').attr('pointer-events', 'none');
const nodeLayer  = g.append('g').attr('class', 'nodes');

// Arrowheads are drawn as their own triangles rather than SVG markers. A marker scales with the
// line's stroke width, and links here run from 0.4 to 8 px, so marker heads were either specks or
// blobs. These are sized from the width but floored so even the thinnest link's direction reads.
const LINK_COLOR = '#888';
function arrowSize(w) { return { len: Math.max(7, w * 2.2), half: Math.max(3.5, w * 1.3) }; }

const mapContainer = document.getElementById('map-container');
const mapSvg       = d3.select('#map');
const mapG         = mapSvg.append('g');
// States, and above them a non-interactive copy of each outline that carries the margin-of-error
// dots. The dots sit on their own layer so the class colour underneath stays untouched.
const stateLayer   = mapG.append('g').attr('class', 'states');
const moeLayer     = mapG.append('g').attr('class', 'moe-overlay').attr('pointer-events', 'none');

// Five-class ColorBrewer schemes (Brewer, colorbrewer2.org; shipped in d3-scale-chromatic), used
// as published, rather than continuous ramps -- every colour on the map corresponds to a stated
// range of values. Same convention as the other map projects in this account.
//
// Known trade-off: ColorBrewer is designed for a light ground, so on this near-black page the
// palest classes (the smallest shares; net migration near zero) are the brightest on screen.
const CLASS_COUNT = 5;

// Sequential: YlGnBu, light yellow = least, dark blue = most.
const SEQ_COLORS = d3.schemeYlGnBu[CLASS_COUNT];

// Diverging: RdBu. schemeRdBu runs red -> blue and scaleThreshold assigns range[0] to the most
// negative class, so red = losing, blue = gaining. Do not reverse it.
const DIV_COLORS = d3.schemeRdBu[CLASS_COUNT];

const tooltip = d3.select('#tooltip');

function dims() {
  const r = container.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

// Link distance and charge are tuned for a panel around 700 px on its short side. Left fixed,
// the graph keeps its full spread in a panel too small to hold it and the outer states are
// clipped against the edge, so scale the spacing with the panel. The floor stops the layout
// collapsing into an unreadable knot on a phone.
const LINK_DISTANCE = 70, CHARGE_STRENGTH = -260, LAYOUT_REFERENCE = 700;

function applyLayoutScale() {
  const { w, h } = dims();
  const k = Math.max(0.45, Math.min(1, Math.min(w, h) / LAYOUT_REFERENCE));
  simulation.force('link').distance(LINK_DISTANCE * k);
  simulation.force('charge').strength(CHARGE_STRENGTH * k);
}

// The network zooms geometrically, so a node's on-screen radius is its drawn radius times the
// zoom factor. The size legend reads the factor and redraws, so it stays true at any zoom.
let zoomK = 1;
svg.call(d3.zoom().scaleExtent([0.2, 10]).on('zoom', e => {
  g.attr('transform', e.transform);
  if (e.transform.k !== zoomK) { zoomK = e.transform.k; updateSizeLegend(); }
}));
svg.on('click.deselect', () => select(null));

let simulation;

// ── Data load ────────────────────────────────────────────────────────────────
Promise.all([
  d3.json('data/migration_network.json'),
  d3.json('data/states.geojson'),
]).then(([data, geo]) => {
  document.getElementById('loading').style.display = 'none';
  networkData = data;
  state.yearIndex = data.years.length - 1;   // open on the most recent year

  const { w, h } = dims();
  simNodes = data.nodes.map((n, i) => ({
    id: n.id, name: n.name, fips: n.fips, region: n.region, index: i,
    x: w / 2 + (Math.random() - 0.5) * 400,
    y: h / 2 + (Math.random() - 0.5) * 400,
  }));

  simulation = d3.forceSimulation(simNodes)
    .force('link',      d3.forceLink([]).id(d => d.index).distance(70))
    .force('charge',    d3.forceManyBody().strength(-260))
    .force('center',    d3.forceCenter(w / 2, h / 2))
    .force('collision', d3.forceCollide(12))
    .alphaDecay(0.02)
    .on('tick', ticked);

  buildLegend();
  buildMapLegend();
  initControls(data);
  initMap(geo, data);
  applyLayoutScale();
  draw(0.6);                                   // first run: there is no layout to preserve yet
});

// ── Weight computation ───────────────────────────────────────────────────────
// Edge weight under the share metric is the stronger of the two directional shares: the fraction
// of A's interstate movers who went to B, or of B's who went to A. A pair matters if either state
// sends a meaningful slice of its leavers to the other.
function directedShare(movers, originIndex) {
  const out = networkData.nodes[originIndex].out[state.yearIndex];
  return out > 0 ? (movers || 0) / out : 0;
}

function unreliable(est, moe) {
  if (est === null) return true;                 // suppressed by the Bureau
  if (est === 0 || moe === null) return false;
  return (moe / 1.645) / est > CV_LIMIT;
}

function computeLinks() {
  const y = state.yearIndex;
  return networkData.links.map(l => {
    const ab = l.ab[y], ba = l.ba[y];              // ab: s → t, ba: t → s
    const abShare = directedShare(ab, l.s);
    const baShare = directedShare(ba, l.t);
    return {
      s: l.s, t: l.t,
      ab: ab, ba: ba, abm: l.abm[y], bam: l.bam[y],
      abShare, baShare,
      movers: (ab || 0) + (ba || 0),
      share: Math.max(abShare, baShare),
      // No separate `suppressed` flag: unreliable() already returns true for a suppressed cell,
      // and the tooltip reads the raw ab/ba nulls directly.
      unreliable: unreliable(ab, l.abm[y]) || unreliable(ba, l.bam[y]),
    };
  // Every pair is kept, including published zeros and suppressed cells: the map has to class a
  // zero as "0 (none)" and a suppressed cell as suppressed, and dropping them here painted both
  // as bare land, which reads as missing data. Zero-weight links never reach the network --
  // draw() filters them out.
  });
}

function weightOf(l) { return state.metric === 'share' ? l.share : l.movers; }

// The weight a link carries while `selIndex` is selected: exactly what the map paints for that
// pair, so the two panels cannot tell different stories. The undirected weightOf() is an upper
// bound on it under every metric and direction -- max(a/oA, b/oB) bounds either share and their
// mediant (a+b)/(oA+oB), and a+b bounds a or b -- so the links that survive the threshold under
// the directional weight are always a subset of the ones the layout was built from.
function selectedWeight(l, selIndex) { return pairValue(l, selIndex); }

// Reliability of exactly the value the selected-state view shows, so the map's dots and the
// network's dashes always agree. Under "both directions" that value is the two-way sum, so it is
// judged on the sum and its combined MOE (root sum of squares, the Census Bureau's standard
// approximation for a sum of estimates) -- not flagged because one small direction is noisy
// when a large, solid flow the other way dominates the total.
// A share's relative error is taken as its flow's: the denominator is a state total, far more
// precise than any single state-to-state cell.
function selectedUnreliable(l, selIndex) {
  const selIsS = l.s === selIndex;
  if (state.mode === 'out') return selIsS ? unreliable(l.ab, l.abm) : unreliable(l.ba, l.bam);
  if (state.mode === 'in')  return selIsS ? unreliable(l.ba, l.bam) : unreliable(l.ab, l.abm);
  if (l.ab === null || l.ba === null) return true;
  return unreliable(l.ab + l.ba, Math.hypot(l.abm || 0, l.bam || 0));
}

// The value the choropleth paints for state `other` when `sel` is selected, or null when the
// Bureau suppressed a flow the value depends on. A suppressed cell is unknown, not zero: painting
// it as 0 put it in the bottom class, a definite-looking "almost nobody" the data does not say.
// Under "both directions" one suppressed direction is enough -- the sum of a known flow and an
// unknown one is not a number that can be classed.
function pairValue(l, selIndex) {
  const selIsS = l.s === selIndex;
  const needed = state.mode === 'out' ? [selIsS ? l.ab : l.ba]
               : state.mode === 'in'  ? [selIsS ? l.ba : l.ab]
               : [l.ab, l.ba];
  if (needed.some(v => v === null)) return null;
  if (state.metric === 'share') {
    // out: of the SELECTED state's movers, the fraction that went to the other state.
    // in:  of the OTHER state's movers, the fraction that came to the selected state.
    if (state.mode === 'out') return selIsS ? l.abShare : l.baShare;
    if (state.mode === 'in')  return selIsS ? l.baShare : l.abShare;
    // both: the exchange as a fraction of the two states' combined out-migration.
    const outs = networkData.nodes[l.s].out[state.yearIndex] +
                 networkData.nodes[l.t].out[state.yearIndex];
    return outs > 0 ? l.movers / outs : 0;
  }
  if (state.mode === 'out') return (selIsS ? l.ab : l.ba) || 0;
  if (state.mode === 'in')  return (selIsS ? l.ba : l.ab) || 0;
  return l.movers;
}

// ── Node sizing ──────────────────────────────────────────────────────────────
// Sized on the published state totals rather than on the drawn edges, so the threshold slider
// changes which edges you see without silently resizing the states.
function nodeMetric(i, y = state.yearIndex) {
  const n = networkData.nodes[i];
  if (state.mode === 'out') return n.out[y];
  if (state.mode === 'in')  return n.in[y];
  return n.out[y] + n.in[y];
}

// One size scale per Direction setting, fixed across ALL years. It used to be rebuilt from each
// year's largest state, so the same circle meant different numbers in different years -- the
// yearly maximum of out-migration varies 1.5x (CA 546k in 2009, 841k in 2021) -- and pressing
// play hid exactly the change it exists to show. Area is proportional to the value (sqrt scale
// from zero); the floor only keeps the very smallest values visible, and the size legend never
// shows a reference value small enough to fall under it.
const R_MAX = 26, R_MIN = 3.5;
const sizeMaxCache = {};
function sizeMax() {
  if (!(state.mode in sizeMaxCache)) {
    sizeMaxCache[state.mode] = d3.max(networkData.years, (_, y) =>
      d3.max(networkData.nodes, (_, i) => nodeMetric(i, y))) || 1;
  }
  return sizeMaxCache[state.mode];
}
function trueRadius(v) { return R_MAX * Math.sqrt(Math.max(0, v) / sizeMax()); }
function nodeRadius(v) { return Math.max(R_MIN, trueRadius(v)); }

function netMigration(i) {
  const n = networkData.nodes[i], y = state.yearIndex;
  return n.in[y] - n.out[y];
}

// ── Suppressed cells ─────────────────────────────────────────────────────────
// From 2024 the Bureau suppresses some state-to-state cells. A state's out/in totals are NOT
// affected: the build takes them from the Bureau's published state totals, which count every
// mover including those in suppressed cells. So net migration and the share denominators are
// complete; only the individual suppressed flows are unknown, and pairValue() returns null for
// them. These counts are for the tooltip.
function outSuppressed(i) {
  const n = networkData.nodes[i];
  return (n.out_sup && n.out_sup[state.yearIndex]) || 0;
}
function inSuppressed(i) {
  const n = networkData.nodes[i];
  return (n.in_sup && n.in_sup[state.yearIndex]) || 0;
}

// Fill for a state whose value is suppressed: hatching over the land colour, so it reads as
// "no number here" rather than as one of the five classes. Defined once in the map SVG; inline
// SVGs in one HTML document share an id space, so the network nodes can reference it too.
const SUPPRESSED_FILL = 'url(#suppressed-hatch)';
const SUPPRESSED_LABEL = 'Suppressed (too few sample cases)';

// ── Classification ───────────────────────────────────────────────────────────
// Quantile classes: roughly equal counts of states per class. Appropriate for the selected-state
// view, where values are unsigned shares or counts and the distribution is heavily right-skewed --
// equal-interval breaks would put nearly every state in the bottom class.
//
// A published ZERO gets a class of its own ("0 (none)", the palest colour) and the quantiles are
// cut from the positive values only. Small states often send no one to a dozen others; left in
// the quantiles, those ties dragged the bottom breaks onto zero and the legend read "< 0.0%" and
// "0.0% – 0.1%" -- a class that looked negative, and one that mixed none with some.
//
// Ties can still collapse breaks, and an interpolated break can leave a class empty, so breaks
// are kept only when the class beneath them holds at least one state. Fewer classes take the TOP
// of the five-class YlGnBu, so the darkest blue always means the largest value. `integer` rounds
// breaks up to whole numbers for mover counts, where a break of 2.5 would print as a tie.
function classifyQuantile(values, integer = false) {
  const vals = values.filter(v => v != null && !Number.isNaN(v));
  const hasZero = vals.some(v => v === 0);
  const pos = vals.filter(v => v > 0).sort(d3.ascending);
  const kPos = CLASS_COUNT - (hasZero ? 1 : 0);

  let candidates = d3.range(1, kPos).map(i => d3.quantile(pos, i / kPos));
  if (integer) candidates = candidates.map(Math.ceil);
  const breaks = [];
  for (const b of candidates) {
    const lo = breaks.length ? breaks[breaks.length - 1] : -Infinity;
    if (b > lo && pos.some(v => v >= lo && v < b)) breaks.push(b);
  }

  const nPos = pos.length ? breaks.length + 1 : 0;
  const n = nPos + (hasZero ? 1 : 0);
  const colors = SEQ_COLORS.slice(CLASS_COUNT - n);
  const posColors = colors.slice(hasZero ? 1 : 0);
  const thr = d3.scaleThreshold().domain(breaks).range(posColors);
  const scale = v => (v === 0 ? colors[0] : thr(v));

  // Legend rows, highest class first. The extremes stay open-ended ("<", "≥"), because the
  // outermost classes really are unbounded; with a zero class below, "<" means "above 0, below".
  const rows = label => {
    const out = d3.range(nPos).map(j => {
      let text;
      if (nPos === 1) {
        const lo = pos[0], hi = pos[pos.length - 1];
        text = lo === hi ? label(lo) : `${label(lo)} – ${label(hi)}`;
      } else if (j === 0)        text = `< ${label(breaks[0])}`;
      else if (j === nPos - 1)   text = `≥ ${label(breaks[nPos - 2])}`;
      else                       text = `${label(breaks[j - 1])} – ${label(breaks[j])}`;
      return { color: posColors[j], text };
    }).reverse();
    if (hasZero) out.push({ color: colors[0], text: '0 (none)' });
    return out;
  };
  return { scale, breaks, colors, rows, pos };
}

// Percent labels with just enough decimals that no two breaks print alike and none prints as
// "0.0%". One decimal suits most states; a small state's in-migration shares need two or three.
function shareLabelFor(values) {
  for (const d of [1, 2, 3]) {
    const f = d3.format(`.${d}%`);
    const s = values.map(f);
    if (new Set(s).size === s.length && values.every(v => v === 0 || parseFloat(f(v)) > 0)) return f;
  }
  return d3.format('.3%');
}

// Net migration is signed and has a meaningful zero, so plain quintiles are the wrong tool: the
// zero crossing would land at an arbitrary point inside a class, and a state that gained people
// could be painted the same colour as one that lost them. Instead the breaks are quantiles of the
// ABSOLUTE values, mirrored around zero. Classes still carry roughly equal counts, but the middle
// class straddles zero and every boundary is sign-correct.
function classifyDiverging(values) {
  const abs = values.map(Math.abs).filter(v => v > 0).sort(d3.ascending);
  let b1 = d3.quantile(abs, 0.2) || 0;
  let b2 = d3.quantile(abs, 0.6) || 0;
  if (!(b2 > b1)) b2 = b1 + Math.max(1, b1);          // degenerate distributions
  const breaks = [-b2, -b1, b1, b2];
  return { scale: d3.scaleThreshold().domain(breaks).range(DIV_COLORS), breaks, colors: DIV_COLORS };
}

// ── Main render ──────────────────────────────────────────────────────────────
// `reheat` is the alpha to restart the layout at, and it should be zero for most redraws.
// A year step in particular must NOT reheat: the point of the year slider is to read one year
// against the one before it, and that is impossible while the layout is still travelling. At
// the 1100 ms play interval a 0.6 restart only decays to about 0.16 before the next frame, so
// the graph never settles and every node drifts ~100 px over three frames -- change you cannot
// attribute to the data. Positions hold; weights, radii and colours update.
function draw(reheat = 0) {
  allLinks = computeLinks();
  activeLinks = allLinks.filter(l => weightOf(l) > 0 && weightOf(l) >= state.threshold);

  const maxWeight = d3.max(activeLinks, weightOf) || 1;
  wScale = d3.scalePow().exponent(0.5).domain([0, maxWeight]).range([0.4, 8]).clamp(true);

  const simLinks = activeLinks.map(l => ({ ...l, source: l.s, target: l.t }));

  // ── Links ──
  // Width, dashing and opacity are set in paint(), because they depend on the selection.
  const linkSel = linkLayer.selectAll('line').data(simLinks, l => `${l.s}-${l.t}`);
  linkSel.exit().remove();
  linkSel.enter().append('line').attr('stroke', LINK_COLOR);

  // ── Nodes ──
  const nodeSel = nodeLayer.selectAll('g.node').data(simNodes, d => d.id);
  const nodeEnter = nodeSel.enter().append('g')
    .attr('class', 'node')
    .attr('cursor', 'pointer')
    .call(drag())
    .on('mouseover', (event, d) => showNodeTooltip(event, d))
    .on('mousemove', moveTooltip)
    .on('mouseout', hideTooltip)
    .on('click', (event, d) => {
      event.stopPropagation();
      select(selectedNode && selectedNode.id === d.id ? null : d);
    });

  nodeEnter.append('circle').attr('stroke', '#fff').attr('stroke-width', 1.2);
  nodeEnter.append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'hanging')
    .attr('pointer-events', 'none')
    .attr('fill', '#ddd')
    .attr('font-size', '10px')
    .attr('font-weight', '600')
    .attr('paint-order', 'stroke')
    .attr('stroke', '#141414')
    .attr('stroke-width', '3px')
    .attr('stroke-linejoin', 'round')
    .style('font-family', 'system-ui, sans-serif')
    .text(d => d.id);

  const nodeAll = nodeEnter.merge(nodeSel);
  simNodes.forEach(d => { d.r = nodeRadius(nodeMetric(d.index)); });   // ticked() stops arrows here
  nodeAll.select('circle').attr('r', d => d.r);
  nodeAll.select('text').attr('dy', d => d.r + 3);

  simulation.force('collision', d3.forceCollide().radius(d => d.r + 3));
  updateSizeLegend();
  // Under the share metric the link force pulls proportionally to the share, so a state sits
  // near the states it actually sends its movers to rather than near the biggest states.
  simulation.force('link')
    .links(simLinks)
    .strength(l => state.metric === 'share'
      ? Math.min(1, l.share / (maxWeight || 1))
      : Math.min(1, l.movers / (maxWeight || 1)));

  if (reheat > 0) simulation.alpha(reheat).restart();
  // forceLink resolves the new source/target indices into node objects when links() is called
  // above, but nothing draws them until a tick. With the layout at rest, run one by hand so
  // links that just entered pick up the positions their endpoints already hold.
  else ticked();

  paint();
  updateStats();
}

// ── Selection and colouring ──────────────────────────────────────────────────
function select(node) {
  selectedNode = node;
  paint();
}

function paint() {
  const sel = selectedNode ? selectedNode.index : null;

  // Map values come from EVERY link, not only the ones above the threshold. Classifying on the
  // filtered set meant a control that reads as "hide weak edges in the network" also rescaled
  // the choropleth: the same state in the same year drew breaks of "≥ 0.9%", "≥ 3.4%" or
  // "≥ 9.2%" depending purely on the slider, and at high settings the map emptied out. The
  // threshold now governs the panel it belongs to and nothing else.
  const values = new Map();
  if (sel === null) {
    simNodes.forEach(d => values.set(d.index, netMigration(d.index)));
  } else {
    for (const l of allLinks) {
      if (l.s === sel) values.set(l.t, pairValue(l, sel));
      else if (l.t === sel) values.set(l.s, pairValue(l, sel));
    }
    // The build omits a pair only when both directions are a published 0 in EVERY year (it
    // fails rather than omit a suppressed one), so a state with no link exchanged no one.
    for (const d of simNodes) if (d.index !== sel && !values.has(d.index)) values.set(d.index, 0);
  }

  // States whose selected-state value fails the same reliability test that dashes the links get
  // margin-of-error dots on the map. Not a published zero (a relative error of zero is undefined),
  // not a suppressed value (already hatched), and not net migration, which needs an
  // interval-crosses-zero test the data cannot yet support.
  const moeFlagged = new Set();
  if (sel !== null && state.flagUnreliable) {
    for (const l of allLinks) {
      if (l.s !== sel && l.t !== sel) continue;
      const other = l.s === sel ? l.t : l.s, v = values.get(other);
      if (v !== null && v !== 0 && selectedUnreliable(l, sel)) moeFlagged.add(other);
    }
  }

  let colorOf;
  const vals = Array.from(values.values());
  if (sel === null) {
    const cls = classifyDiverging(vals);
    colorOf = i => cls.scale(values.get(i) || 0);
    updateMapLegend('Net migration (in − out)', cls, netLabel);
  } else {
    // Suppressed values are left out of the class breaks and get their own legend row.
    const cls = classifyQuantile(vals, state.metric === 'movers');
    colorOf = i => !values.has(i) ? LAND_COLOR
                 : values.get(i) === null ? SUPPRESSED_FILL
                 : cls.scale(values.get(i));
    const label = state.metric === 'share'
      ? shareLabelFor([...cls.breaks, ...(cls.breaks.length ? [] : [cls.pos[0], cls.pos[cls.pos.length - 1]])]
          .filter(v => v !== undefined))
      : v => fmt(Math.round(v));
    updateMapLegend(legendTitle(), cls, label, vals.some(v => v === null), moeFlagged.size > 0);
  }

  // With a state selected, its links switch from the undirected weight to the directional one the
  // map is painting, and the threshold is applied to that. Without this, Out-migration could show
  // a heavy link to a neighbour the state barely sends anyone to, because the neighbour sends
  // many people back. The LAYOUT is not touched -- clicking a state must not rearrange the graph
  // -- only the styling of links already on screen.
  const incident = l => sel !== null && (l.s === sel || l.t === sel);
  const shownIncident = l => incident(l) && selectedWeight(l, sel) >= state.threshold &&
    selectedWeight(l, sel) > 0;

  // Dimming in the network follows the DRAWN edges, so raising the threshold visibly prunes the
  // neighbourhood in the panel the threshold controls.
  let neighbours = null;
  if (sel !== null) {
    neighbours = new Set();
    for (const l of activeLinks) {
      if (!shownIncident(l)) continue;
      neighbours.add(l.s === sel ? l.t : l.s);
    }
  }

  // Nodes wear region colours only with nothing selected; once a state is selected they take the
  // map's classes, so the region legend would be describing colours no longer on screen.
  d3.selectAll('.region-legend').style('display', sel === null ? null : 'none');

  nodeLayer.selectAll('g.node')
    .attr('opacity', d => sel === null || d.index === sel || neighbours.has(d.index) ? 1 : 0.08);

  nodeLayer.selectAll('g.node circle')
    .attr('fill', d => d.index === sel
      ? SELECTED_FILL
      : (sel === null ? (REGION_COLOR[d.region] || DEFAULT_COLOR) : colorOf(d.index)))
    .attr('stroke', d => d.index === sel ? '#fff' : 'rgba(0,0,0,0.4)')
    .attr('stroke-width', d => d.index === sel ? 3 : 0.9);

  const isUnreliable = l => incident(l) ? selectedUnreliable(l, sel) : l.unreliable;
  const lines = linkLayer.selectAll('line');
  lines.each(l => {
    l.w = wScale(incident(l) ? selectedWeight(l, sel) : weightOf(l));
    // Which end carries an arrowhead: only the selected state's drawn links, and only when the
    // Direction setting makes them directional. Out points away from the selected state, In
    // points at it; Both directions and the unselected network stay undirected.
    l.head = null;
    if (state.mode !== 'total' && shownIncident(l)) {
      const other = l.s === sel ? l.t : l.s;
      const headIndex = state.mode === 'out' ? other : sel;
      l.head = l.s === headIndex ? 'source' : 'target';
    }
  });
  lines
    .attr('stroke-width', l => l.w)
    .attr('stroke-dasharray', l => state.flagUnreliable && isUnreliable(l) ? '2 3' : null)
    .attr('stroke-opacity', l => {
      const base = state.flagUnreliable && isUnreliable(l) ? 0.18 : 0.4;
      if (sel === null) return base;
      if (!incident(l)) return 0.04;
      return shownIncident(l) ? Math.max(base, 0.85) : 0;
    });

  arrowLayer.selectAll('path')
    .data(lines.data().filter(l => l.head), l => `${l.s}-${l.t}`)
    .join('path')
    .attr('d', l => {
      const { len, half } = arrowSize(l.w);
      return `M0,0L${-len},${-half}L${-len},${half}Z`;   // tip at the origin, pointing along +x
    })
    .attr('fill', LINK_COLOR)
    .attr('fill-opacity', 0.85);
  ticked();                                            // place the arrows and trim their lines

  // Dark dots on the three pale YlGnBu classes, light dots on the two dark ones, so they read on
  // either.
  moeLayer.selectAll('path').attr('fill', f => {
    const i = fipsToIndex[f.properties.fips];
    if (!moeFlagged.has(i)) return 'none';
    return d3.lab(colorOf(i)).l > 60 ? 'url(#moe-dots-dark)' : 'url(#moe-dots-light)';
  });

  stateLayer.selectAll('path')
    .attr('fill', f => {
      const i = fipsToIndex[f.properties.fips];
      if (i === undefined) return LAND_COLOR;
      if (i === sel) return SELECTED_FILL;
      return sel === null ? colorOf(i) : (values.has(i) ? colorOf(i) : LAND_COLOR);
    })
    .attr('stroke', f => fipsToIndex[f.properties.fips] === sel ? '#fff' : '#444')
    .attr('stroke-width', f => fipsToIndex[f.properties.fips] === sel ? 2 : 0.5);
}

function legendTitle() {
  const name = selectedNode.id;
  const pct = state.metric === 'share';
  if (state.mode === 'out') return pct ? `Share of ${name}'s movers going here` : `Movers from ${name}`;
  if (state.mode === 'in')  return pct ? `Share of each state's movers going to ${name}` : `Movers to ${name}`;
  return pct ? `Exchange with ${name}, share of both states' movers` : `Movers exchanged with ${name}`;
}

// ── Tick / drag ──────────────────────────────────────────────────────────────
// Where a directed link's arrow sits: the tip just outside the head node's circle, so the circle
// does not swallow it, and the line trimmed back to the arrow's base so its butt end does not
// poke past the tip.
function arrowGeometry(l) {
  const head = l.head === 'target' ? l.target : l.source;
  const tail = l.head === 'target' ? l.source : l.target;
  const dx = head.x - tail.x, dy = head.y - tail.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist, uy = dy / dist;
  const tipBack = (head.r || 0) + 1.5;
  const { len } = arrowSize(l.w);
  return {
    tipX: head.x - ux * tipBack, tipY: head.y - uy * tipBack,
    baseX: head.x - ux * (tipBack + len - 1), baseY: head.y - uy * (tipBack + len - 1),
    angle: Math.atan2(dy, dx) * 180 / Math.PI,
  };
}

function ticked() {
  linkLayer.selectAll('line').each(function (d) {
    let x1 = d.source.x, y1 = d.source.y, x2 = d.target.x, y2 = d.target.y;
    if (d.head) {
      const a = arrowGeometry(d);
      if (d.head === 'target') { x2 = a.baseX; y2 = a.baseY; } else { x1 = a.baseX; y1 = a.baseY; }
    }
    this.setAttribute('x1', x1); this.setAttribute('y1', y1);
    this.setAttribute('x2', x2); this.setAttribute('y2', y2);
  });
  arrowLayer.selectAll('path').attr('transform', d => {
    const a = arrowGeometry(d);
    return `translate(${a.tipX},${a.tipY}) rotate(${a.angle})`;
  });
  nodeLayer.selectAll('g.node').attr('transform', d => `translate(${d.x},${d.y})`);
}

function drag() {
  return d3.drag()
    .on('start', (event, d) => {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x; d.fy = d.y;
    })
    .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
    .on('end', (event, d) => {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null; d.fy = null;
    });
}

// ── Tooltip ──────────────────────────────────────────────────────────────────
const fmt = d3.format(',d');
const pct = d3.format('.1%');

function showNodeTooltip(event, d) {
  const y = state.yearIndex, n = networkData.nodes[d.index];
  const net = netMigration(d.index);
  const supOut = outSuppressed(d.index), supIn = inSuppressed(d.index);
  const peers = networkData.nodes.length - 1;
  let html = `<strong>${d.name}</strong><br>${d.region} · ${networkData.years[y]}<br>` +
    `<span class="num">Left the state: ${fmt(n.out[y])}<br>` +
    `Arrived: ${fmt(n.in[y])}<br>` +
    `Net: ${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}</span>`;

  if (supOut || supIn) {
    html += `<br><span class="warn">${supOut} of ${peers} outbound and ${supIn} of ${peers} ` +
      `inbound flows are suppressed. The totals above are the Bureau's published state ` +
      `totals and include them.</span>`;
  }

  if (selectedNode && selectedNode.index !== d.index) {
    const l = allLinks.find(l =>
      (l.s === selectedNode.index && l.t === d.index) ||
      (l.t === selectedNode.index && l.s === d.index));
    if (l) {
      const selIsS = l.s === selectedNode.index;
      const toOther = selIsS ? l.ab : l.ba;
      const toSel   = selIsS ? l.ba : l.ab;
      const shareToOther = selIsS ? l.abShare : l.baShare;
      const shareToSel   = selIsS ? l.baShare : l.abShare;
      html += `<hr style="border:none;border-top:1px solid #444;margin:6px 0">` +
        `<span class="num">${selectedNode.id} → ${d.id}: ${toOther === null ? 'suppressed' : fmt(toOther)}` +
        (toOther === null ? '' : ` (${pct(shareToOther)} of ${selectedNode.id}'s movers)`) + `<br>` +
        `${d.id} → ${selectedNode.id}: ${toSel === null ? 'suppressed' : fmt(toSel)}` +
        (toSel === null ? '' : ` (${pct(shareToSel)} of ${d.id}'s movers)`) + `</span>`;
      if (l.unreliable) {
        html += `<br><span class="warn">Margin of error is large relative to the estimate.</span>`;
      }
    } else {
      html += `<hr style="border:none;border-top:1px solid #444;margin:6px 0">` +
        `<span class="num">No movers between ${selectedNode.id} and ${d.id} in either direction.</span>`;
    }
  }
  tooltip.style('display', 'block').html(html);
  moveTooltip(event);
}

function moveTooltip(event) {
  tooltip.style('left', (event.pageX + 14) + 'px').style('top', (event.pageY - 32) + 'px');
}
function hideTooltip() { tooltip.style('display', 'none'); }

// ── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  const y = state.yearIndex;
  const movers = d3.sum(networkData.nodes, n => n.out[y]);
  const suppressed = d3.sum(networkData.links,
    l => (l.ab[y] === null ? 1 : 0) + (l.ba[y] === null ? 1 : 0));
  // Node totals are the Bureau's published state totals, so this is complete in every year.
  const drawable = allLinks.filter(l => weightOf(l) > 0).length;
  document.getElementById('stat-edges').textContent =
    `${fmt(activeLinks.length)} of ${fmt(drawable)}`;
  document.getElementById('stat-movers').textContent = fmt(movers);
  document.getElementById('stat-suppressed').textContent = fmt(suppressed);
}

// ── Controls ─────────────────────────────────────────────────────────────────
function initControls(data) {
  const years = data.years;
  const slider = document.getElementById('year-slider');
  slider.max = years.length - 1;
  slider.value = state.yearIndex;

  const setYear = i => {
    state.yearIndex = +i;
    document.getElementById('year-val').textContent = years[state.yearIndex];
    initThreshold(false);
    draw();                                    // no reheat: hold the layout still across years
  };
  slider.addEventListener('input', function () { setYear(this.value); });

  document.getElementById('year-note').textContent =
    'No 2020 estimate: the Census Bureau did not release standard 2020 ACS 1-year data.';

  document.getElementById('play').addEventListener('click', function () {
    if (playTimer) {
      clearInterval(playTimer); playTimer = null; this.textContent = '▶';
      return;
    }
    this.textContent = '❚❚';
    playTimer = setInterval(() => {
      const next = (state.yearIndex + 1) % years.length;
      slider.value = next;
      setYear(next);
    }, 1100);
  });

  d3.selectAll('input[name="metric"]').on('change', function () {
    state.metric = this.value;
    initThreshold();
    updateMetricHint();
    draw(0.6);                                 // link strengths all change; relayout is the point
  });

  d3.selectAll('input[name="mode"]').on('change', function () {
    state.mode = this.value;
    draw(0.15);                                // radii change, so let collision resolve gently
  });

  document.getElementById('flag-unreliable').addEventListener('change', function () {
    state.flagUnreliable = this.checked;
    draw();                                    // styling only
  });

  document.getElementById('threshold-slider').addEventListener('input', function () {
    state.threshold = thresholdFromSlider(+this.value);
    document.getElementById('threshold-val').textContent = thresholdLabel();
    draw();                                    // filter only: edges vanish, states stay put
  });

  document.getElementById('year-val').textContent = years[state.yearIndex];
  updateMetricHint();
  initThreshold();
}

function updateMetricHint() {
  document.getElementById('metric-hint').textContent = state.metric === 'share'
    ? 'Each edge is weighted by the larger of the two directional shares, so small states are not drowned out by large ones.'
    : 'Raw counts. Layout is dominated by state population and distance.';
  document.getElementById('mode-hint').textContent =
    'Sizes the states and colours the map. Select a state and its links follow this setting too, ' +
    'with arrows for out- or in-migration; ' +
    'with nothing selected, links are undirected (' +
    (state.metric === 'share' ? 'the larger of the two shares' : 'both directions combined') + ').';
}

// The share slider works in tenths of a percent; the movers slider in people. Both are stored
// in the metric's own units so weightOf() can be compared directly.
const SHARE_STEPS = 150;          // 0 – 15.0%
function thresholdFromSlider(v) {
  return state.metric === 'share' ? v / 1000 : v;
}
function thresholdLabel() {
  return state.metric === 'share' ? pct(state.threshold) : fmt(state.threshold);
}

function initThreshold(reset = true) {
  const slider = document.getElementById('threshold-slider');
  document.getElementById('threshold-label').textContent =
    state.metric === 'share' ? 'Min edge share' : 'Min edge movers';

  if (state.metric === 'share') {
    slider.step = 1;
    slider.max = SHARE_STEPS;
    if (reset) state.threshold = 0.03;           // ~480 edges: dense enough to read structure
    slider.value = Math.round(state.threshold * 1000);
  } else {
    const weights = computeLinks().map(l => l.movers).filter(v => v > 0).sort(d3.ascending);
    slider.step = 100;
    // Every year has its own volume, so the movers range is rebuilt per year. Floor the max at
    // one step so a very thin year cannot produce max < step, which no input can represent.
    slider.max = Math.max(+slider.step, Math.round(d3.quantile(weights, 0.99)));
    if (reset) state.threshold = Math.round(d3.quantile(weights, 0.5));
    slider.value = state.threshold;
  }

  // Read the value back out instead of trusting what was just written. The input clamps to its
  // own max and snaps to its own step, so this round-trip is the only thing that guarantees the
  // thumb, the readout and the number the filter actually compares against are one value.
  // Stepping the year under the movers metric used to shrink the range without clamping the
  // stored threshold, leaving the thumb at 55,300 while the filter still used 57,800.
  state.threshold = thresholdFromSlider(+slider.value);
  document.getElementById('threshold-val').textContent = thresholdLabel();
}

// ── Map ──────────────────────────────────────────────────────────────────────
function initMap(geo, data) {
  data.nodes.forEach((n, i) => { fipsToIndex[n.fips] = i; });

  const r = mapContainer.getBoundingClientRect();
  // geoAlbersUsa insets Alaska and Hawaii, so the GeoJSON can stay in true WGS84 position.
  const projection = d3.geoAlbersUsa().fitSize([r.width * 0.94, r.height * 0.84], geo);
  const path = d3.geoPath(projection);

  moeLayer.selectAll('path')
    .data(geo.features, f => f.properties.fips)
    .enter().append('path')
    .attr('d', path)
    .attr('fill', 'none');

  stateLayer.selectAll('path')
    .data(geo.features, f => f.properties.fips)
    .enter().append('path')
    .attr('d', path)
    .attr('fill', LAND_COLOR)
    .attr('stroke', '#444')
    .attr('stroke-width', 0.5)
    .attr('cursor', 'pointer')
    .on('mouseover', (event, f) => {
      const i = fipsToIndex[f.properties.fips];
      if (i !== undefined) showNodeTooltip(event, simNodes[i]);
    })
    .on('mousemove', moveTooltip)
    .on('mouseout', hideTooltip)
    .on('click', (event, f) => {
      event.stopPropagation();
      const i = fipsToIndex[f.properties.fips];
      if (i === undefined) return;
      select(selectedNode && selectedNode.index === i ? null : simNodes[i]);
    });

  mapSvg.on('click', () => select(null));
  centreMap();

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(onResize, 120);       // resize fires per frame while dragging
  });

  function onResize() {
    const nr = mapContainer.getBoundingClientRect();
    projection.fitSize([nr.width * 0.94, nr.height * 0.84], geo);
    stateLayer.selectAll('path').attr('d', path);
    moeLayer.selectAll('path').attr('d', path);
    centreMap();
    positionMapLegend();

    // The network panel needs the same treatment. forceCenter was built with the width the page
    // happened to load at and nothing updated it, so after a resize the layout kept pulling
    // toward a point that was no longer the middle of the panel -- at narrower widths that left
    // whole states clipped against the panel edge. Re-aim it and let the graph walk over.
    const { w, h } = dims();
    simulation.force('center', d3.forceCenter(w / 2, h / 2));
    updateSizeLegend();                            // anchored to the panel's bottom edge
    applyLayoutScale();
    simulation.alpha(0.3).restart();
  }

  function centreMap() {
    const b = mapG.node().getBBox();
    const nr = mapContainer.getBoundingClientRect();
    mapG.attr('transform',
      `translate(${(nr.width - b.width) / 2 - b.x},${(nr.height - b.height) / 2 - b.y - 10})`);
  }
}

// A classed map needs a classed legend: one swatch per class with the range it stands for,
// highest class at the top, rather than a continuous gradient bar.
const LEGEND_ROW = 15;

const netLabel   = v => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(Math.round(v)));

function buildMapLegend() {
  const pat = mapSvg.append('defs').append('pattern')
    .attr('id', 'suppressed-hatch').attr('patternUnits', 'userSpaceOnUse')
    .attr('width', 5).attr('height', 5).attr('patternTransform', 'rotate(45)');
  pat.append('rect').attr('width', 5).attr('height', 5).attr('fill', LAND_COLOR);
  pat.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 5)
    .attr('stroke', '#8a8a8a').attr('stroke-width', 1.4);

  // Margin-of-error dots: a sparse stipple with a transparent ground, laid over the class colour.
  // Dots, not lines, so it cannot be mistaken for the suppressed hatching.
  const defs = mapSvg.select('defs');
  const dots = (id, dot, ground) => {
    const p = defs.append('pattern').attr('id', id).attr('patternUnits', 'userSpaceOnUse')
      .attr('width', 4).attr('height', 4);
    if (ground) p.append('rect').attr('width', 4).attr('height', 4).attr('fill', ground);
    p.append('circle').attr('cx', 2).attr('cy', 2).attr('r', 0.9).attr('fill', dot);
  };
  dots('moe-dots-dark',   'rgba(0,0,0,0.6)');
  dots('moe-dots-light',  'rgba(255,255,255,0.7)');
  dots('moe-dots-swatch', 'rgba(0,0,0,0.6)', SEQ_COLORS[1]);   // legend: dots on a mid class

  const lg =mapSvg.append('g').attr('class', 'map-legend').attr('pointer-events', 'none');
  lg.append('text').attr('class', 'legend-title')
    .attr('y', -8).attr('fill', '#bbb').attr('font-size', '10px')
    .attr('font-weight', '600').style('font-family', 'system-ui, sans-serif');
  lg.append('g').attr('class', 'legend-classes');
  positionMapLegend();
}

// The legend can carry fewer than CLASS_COUNT rows when the data does not support five classes,
// so it is anchored on the number of rows actually drawn.
let legendRows = CLASS_COUNT;

function positionMapLegend() {
  const r = mapContainer.getBoundingClientRect();
  mapSvg.select('.map-legend')
    .attr('transform', `translate(14, ${r.height - legendRows * LEGEND_ROW - 14})`);
}

// Text for class k, given the k-1 lower and k upper break. Open-ended at both extremes, because
// the outermost classes really are unbounded -- pretending otherwise would misstate the data.
function classRange(k, breaks, label, n, single) {
  if (n === 1)      return label(single);      // one value left: name it rather than bracket it
  if (k === n - 1)  return `≥ ${label(breaks[breaks.length - 1])}`;
  if (k === 0)      return `< ${label(breaks[0])}`;
  return `${label(breaks[k - 1])} – ${label(breaks[k])}`;
}

function updateMapLegend(title, cls, label, hasSuppressed = false, hasMoe = false) {
  mapSvg.select('.legend-title').text(title);

  // Highest class on top, which is how a choropleth legend is conventionally read. A suppressed
  // row goes underneath, apart from the ordered classes it does not belong to.
  const n = cls.colors.length;
  const rows = cls.rows ? cls.rows(label) : d3.range(n).reverse().map(k => ({
    color: cls.colors[k],
    text: classRange(k, cls.breaks, label, n, cls.single),
  }));
  if (hasMoe) rows.push({ color: 'url(#moe-dots-swatch)', text: 'Large margin of error' });
  if (hasSuppressed) rows.push({ color: SUPPRESSED_FILL, text: SUPPRESSED_LABEL });
  legendRows = rows.length;
  positionMapLegend();

  const sel = mapSvg.select('.legend-classes').selectAll('g.legend-class').data(rows);
  const enter = sel.enter().append('g').attr('class', 'legend-class');
  enter.append('rect').attr('width', 12).attr('height', 12)
    .attr('stroke', '#555').attr('stroke-width', 0.5);
  enter.append('text')
    .attr('x', 18).attr('y', 10)
    .attr('fill', '#999').attr('font-size', '9px')
    .style('font-family', 'system-ui, sans-serif');

  const all = enter.merge(sel);
  all.attr('transform', (d, i) => `translate(0, ${i * LEGEND_ROW})`);
  all.select('rect').attr('fill', d => d.color);
  all.select('text').text(d => d.text);
  sel.exit().remove();
}

// ── Size legend (network panel) ──────────────────────────────────────────────
// Nested circles, bottom-aligned, drawn in screen space outside the zoomed group and re-drawn at
// the current zoom factor, so each legend circle is exactly the size a node with that value has
// on screen right now. Reference values come from a 1-2-5 ladder: the largest that fits both the
// data and the corner (zooming in swaps in smaller references rather than growing the legend
// past SIZE_LEGEND_R px), then roughly a quarter and a twentieth of it. A reference value small
// enough to fall under the R_MIN floor is never shown, since its circle would overstate it.
const SIZE_LEGEND_R = 34, SIZE_LEGEND_PAD = 14, SIZE_LABEL_GAP = 11;
const LADDER = d3.range(3, 8).flatMap(e => [1, 2, 5].map(m => m * 10 ** e));   // 1k .. 50M
const sizeFmt = d3.format('~s');

function sizeLegendTitle() {
  return state.mode === 'out' ? 'Node size: movers leaving'
       : state.mode === 'in'  ? 'Node size: movers arriving'
       : 'Node size: movers in + out';
}

function sizeReferences() {
  const fit = sizeMax() * (SIZE_LEGEND_R / (R_MAX * zoomK)) ** 2;
  const below = cap => d3.max(LADDER.filter(v => v <= cap));
  const big = below(Math.min(sizeMax(), fit));
  if (!big) return [];
  const honest = v => v && trueRadius(v) >= R_MIN;
  const refs = [...new Set([big, below(big / 4), below(big / 20)])]
    .filter(v => honest(v) && trueRadius(v) * zoomK >= 1.5);
  // Zoomed far in, everything that fits the corner is under the floor. Show the smallest honest
  // reference anyway, larger than the usual cap, rather than an empty legend.
  return refs.length ? refs : [LADDER.find(honest)].filter(Boolean);
}

function updateSizeLegend() {
  if (!networkData) return;
  let lg = svg.select('g.size-legend');
  if (lg.empty()) {
    lg = svg.append('g').attr('class', 'size-legend').attr('pointer-events', 'none');
    lg.append('rect').attr('class', 'backing').attr('fill', '#141414').attr('fill-opacity', 0.85)
      .attr('rx', 4);
    lg.append('text').attr('class', 'size-title')
      .attr('fill', '#bbb').attr('font-size', '10px').attr('font-weight', '600')
      .style('font-family', 'system-ui, sans-serif');
    lg.append('g').attr('class', 'size-rows');
  }

  const refs = sizeReferences();                       // largest first
  const radii = refs.map(v => trueRadius(v) * zoomK);
  const R = radii[0] || 0;
  const { h } = dims();
  const cx = SIZE_LEGEND_PAD + R, base = h - SIZE_LEGEND_PAD;
  const labelX = cx + R + 10;

  // Label each circle at its top; push a label down when circles are close enough in size that
  // their labels would collide.
  let lastY = -Infinity;
  const rows = refs.map((v, i) => {
    const top = base - 2 * radii[i];
    const y = Math.max(top, lastY + SIZE_LABEL_GAP);
    lastY = y;
    return { v, r: radii[i], top, y };
  });

  const sel = lg.select('g.size-rows').selectAll('g.size-row').data(rows, d => d.v);
  sel.exit().remove();
  const enter = sel.enter().append('g').attr('class', 'size-row');
  enter.append('circle').attr('fill', 'none').attr('stroke', '#999').attr('stroke-width', 1);
  enter.append('line').attr('stroke', '#666').attr('stroke-width', 0.75);
  enter.append('text').attr('fill', '#999').attr('font-size', '9px')
    .attr('dominant-baseline', 'middle').style('font-family', 'system-ui, sans-serif');
  const all = enter.merge(sel);
  all.select('circle').attr('cx', cx).attr('cy', d => base - d.r).attr('r', d => d.r);
  all.select('line').attr('x1', cx).attr('y1', d => d.top).attr('x2', labelX - 3).attr('y2', d => d.y);
  all.select('text').attr('x', labelX).attr('y', d => d.y).text(d => sizeFmt(d.v));

  const titleY = (rows.length ? Math.min(base - 2 * R, rows[0].y) : base) - 12;
  lg.select('text.size-title').attr('x', SIZE_LEGEND_PAD).attr('y', titleY).text(sizeLegendTitle());

  // Backing sized to what was drawn, so nodes passing underneath do not tangle with the labels.
  const box = lg.select('g.size-rows').node().getBBox();
  const tBox = lg.select('text.size-title').node().getBBox();
  const x0 = Math.min(box.x || Infinity, tBox.x) - 6, y0 = tBox.y - 5;
  const x1 = Math.max(box.x + box.width, tBox.x + tBox.width) + 6, y1 = base + 6;
  lg.select('rect.backing').attr('x', x0).attr('y', y0).attr('width', x1 - x0).attr('height', y1 - y0);
}

// ── Legend ───────────────────────────────────────────────────────────────────
function buildLegend() {
  const cont = d3.select('#legend')
    .style('display', 'flex').style('flex-direction', 'column').style('gap', '5px');
  Object.entries(REGION_COLOR).forEach(([name, color]) => {
    const row = cont.append('div').attr('class', 'legend-item');
    row.append('div').attr('class', 'swatch').style('background', color);
    row.append('span').text(name);
  });
}
