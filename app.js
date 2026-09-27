'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const REGION_COLOR = {
  'Northeast': '#4e79a7',
  'Midwest':   '#59a14f',
  'South':     '#e15759',
  'West':      '#f28e2b',
};
const DEFAULT_COLOR = '#aaa';
const LAND_COLOR    = '#2a2a2a';

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

// ── SVG / layout ─────────────────────────────────────────────────────────────
const container = document.getElementById('chart-container');
const svg       = d3.select('#chart');
const g         = svg.append('g');
const linkLayer = g.append('g').attr('class', 'links');
const nodeLayer = g.append('g').attr('class', 'nodes');

const mapContainer = document.getElementById('map-container');
const mapSvg       = d3.select('#map');
const mapG         = mapSvg.append('g');

// Five-class schemes rather than continuous ramps, so every colour on the map corresponds to a
// stated range of values.
//
// Both ramps are chosen for a DARK ground, where the rule is the reverse of print: brightness
// advances and darkness recedes. ColorBrewer's schemes put their palest colour at the class
// meaning "least" or "no change", which is right on white paper and backwards here -- schemeRdBu
// midpoint is #f7f7f7, so on a #141414 map the states that did nothing were the loudest thing
// on screen, and schemeYlGnBu did the same for the smallest shares.
const CLASS_COUNT = 5;

// Sequential: viridis is built dark-to-bright and stays monotonic for colourblind readers, so
// the largest share is the brightest patch and the smallest recedes toward the ground.
const SEQ_COLORS = d3.quantize(d3.interpolateViridis, CLASS_COUNT);

// Diverging: red = losing, blue = gaining, magnitude carried by brightness away from a neutral
// that stays quiet. The neutral has to clear two other greys to read as a filled state rather
// than a hole in the map -- LAND_COLOR #2a2a2a below it and the #444 state stroke above -- so it
// sits just above the stroke while still being much the darkest of the five classes.
// scaleThreshold assigns range[0] to the most negative class, so this array runs loss -> gain.
// Do not reverse it.
const DIV_COLORS = ['#e2603f', '#96503f', '#4a4a4a', '#3c6a8e', '#4fa8dc'];

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

svg.call(d3.zoom().scaleExtent([0.2, 10]).on('zoom', e => g.attr('transform', e.transform)));
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
  }).filter(l => l.movers > 0);
}

function weightOf(l) { return state.metric === 'share' ? l.share : l.movers; }

// The value the choropleth paints for state `other` when `sel` is selected.
function pairValue(l, selIndex) {
  const selIsS = l.s === selIndex;
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
function nodeMetric(i) {
  const n = networkData.nodes[i], y = state.yearIndex;
  if (state.mode === 'out') return n.out[y];
  if (state.mode === 'in')  return n.in[y];
  return n.out[y] + n.in[y];
}

function netMigration(i) {
  const n = networkData.nodes[i], y = state.yearIndex;
  return n.in[y] - n.out[y];
}

// ── Suppressed denominators ──────────────────────────────────────────────────
// A state's out/in totals are sums over the cells the Bureau published. Through 2023 nothing is
// suppressed and they reproduce the published marginals exactly; from 2024 they are FLOORS.
// That matters more than it sounds, because the share metric divides by `out`: an understated
// denominator is an overstated share, and suppression lands hardest on the small states the
// share metric exists to surface. Vermont loses 11 of its 50 outbound cells, which lifts every
// Vermont share by roughly a fifth. The app cannot recover the missing movers, so it says so.
function outSuppressed(i) {
  const n = networkData.nodes[i];
  return (n.out_sup && n.out_sup[state.yearIndex]) || 0;
}
function inSuppressed(i) {
  const n = networkData.nodes[i];
  return (n.in_sup && n.in_sup[state.yearIndex]) || 0;
}
const DAGGER = '†';
function shareDagger(originIndex) { return outSuppressed(originIndex) ? DAGGER : ''; }

// ── Classification ───────────────────────────────────────────────────────────
// True quintiles: equal counts of states per class. Appropriate for the selected-state view,
// where values are unsigned shares or counts and the distribution is heavily right-skewed --
// equal-interval breaks would put nearly every state in the bottom class.
// scaleQuantile will happily cut five classes out of two distinct values, and then every break
// lands on the same number: a legend reading "12.5% - 12.5%" three times over. Never ask for more
// classes than there are distinct values to put in them. The reduced ramp is the TOP of viridis,
// so the brightest colour still means the largest value and the legend stays comparable with the
// full five-class case.
function classifyQuantile(values) {
  const vals = values.filter(v => v != null && !Number.isNaN(v));
  const distinct = new Set(vals).size;
  const k = Math.max(1, Math.min(CLASS_COUNT, distinct));
  const colors = k === CLASS_COUNT
    ? SEQ_COLORS
    : d3.quantize(d3.interpolateViridis, CLASS_COUNT).slice(CLASS_COUNT - k);
  const scale = d3.scaleQuantile().domain(vals).range(colors);
  return { scale, breaks: scale.quantiles(), colors, single: k === 1 ? vals[0] : null };
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
  activeLinks = allLinks.filter(l => weightOf(l) >= state.threshold);

  const maxMetric = d3.max(simNodes, d => nodeMetric(d.index)) || 1;
  const maxWeight = d3.max(activeLinks, weightOf) || 1;
  const rScale = d3.scaleSqrt().domain([0, maxMetric]).range([4, 26]);
  const wScale = d3.scalePow().exponent(0.5).domain([0, maxWeight]).range([0.4, 8]).clamp(true);

  const simLinks = activeLinks.map(l => ({ ...l, source: l.s, target: l.t }));

  // ── Links ──
  const linkSel = linkLayer.selectAll('line').data(simLinks, l => `${l.s}-${l.t}`);
  linkSel.exit().remove();
  linkSel.enter().append('line')
    .attr('stroke', '#888')
    .merge(linkSel)
    .attr('stroke-width', l => wScale(weightOf(l)))
    .attr('stroke-dasharray', l => state.flagUnreliable && l.unreliable ? '2 3' : null);

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
  nodeAll.select('circle').attr('r', d => rScale(nodeMetric(d.index)));
  nodeAll.select('text').attr('dy', d => rScale(nodeMetric(d.index)) + 3);

  simulation.force('collision', d3.forceCollide().radius(d => rScale(nodeMetric(d.index)) + 3));
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
  }

  let colorOf;
  const vals = Array.from(values.values());
  if (sel === null) {
    const cls = classifyDiverging(vals);
    colorOf = i => cls.scale(values.get(i) || 0);
    updateMapLegend('Net migration (in − out)', cls, netLabel);
  } else {
    const cls = classifyQuantile(vals);
    colorOf = i => (values.has(i) ? cls.scale(values.get(i)) : LAND_COLOR);
    updateMapLegend(legendTitle(), cls, valueLabel);
  }

  // Dimming in the network still follows the DRAWN edges, so raising the threshold visibly
  // prunes the neighbourhood in the panel the threshold controls.
  let neighbours = null;
  if (sel !== null) {
    neighbours = new Set();
    for (const l of activeLinks) {
      if (l.s === sel) neighbours.add(l.t);
      else if (l.t === sel) neighbours.add(l.s);
    }
  }

  nodeLayer.selectAll('g.node')
    .attr('opacity', d => sel === null || d.index === sel || neighbours.has(d.index) ? 1 : 0.08);

  nodeLayer.selectAll('g.node circle')
    .attr('fill', d => d.index === sel
      ? (REGION_COLOR[d.region] || DEFAULT_COLOR)
      : (sel === null ? (REGION_COLOR[d.region] || DEFAULT_COLOR) : colorOf(d.index)))
    .attr('stroke', d => d.index === sel ? '#fff' : 'rgba(0,0,0,0.4)')
    .attr('stroke-width', d => d.index === sel ? 3 : 0.9);

  linkLayer.selectAll('line')
    .attr('stroke-opacity', l => {
      const base = state.flagUnreliable && l.unreliable ? 0.18 : 0.4;
      if (sel === null) return base;
      return (l.source.index === sel || l.target.index === sel) ? Math.max(base, 0.85) : 0.04;
    });

  mapG.selectAll('path')
    .attr('fill', f => {
      const i = fipsToIndex[f.properties.fips];
      if (i === undefined) return LAND_COLOR;
      if (i === sel) return REGION_COLOR[simNodes[i].region] || DEFAULT_COLOR;
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
function ticked() {
  linkLayer.selectAll('line')
    .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
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
    `<span class="num">Left the state: ${supOut ? '≥ ' : ''}${fmt(n.out[y])}<br>` +
    `Arrived: ${supIn ? '≥ ' : ''}${fmt(n.in[y])}<br>` +
    `Net: ${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}</span>`;

  if (supOut || supIn) {
    html += `<br><span class="warn">${supOut} of ${peers} outbound and ${supIn} of ${peers} ` +
      `inbound flows are too small to publish, so these totals are floors.</span>`;
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
      // Each share is divided by its own origin's out total, so each carries its own dagger.
      const dagOther = shareDagger(selectedNode.index);
      const dagSel   = shareDagger(d.index);
      html += `<hr style="border:none;border-top:1px solid #444;margin:6px 0">` +
        `<span class="num">${selectedNode.id} → ${d.id}: ${toOther === null ? 'suppressed' : fmt(toOther)}` +
        (toOther === null ? '' : ` (${pct(shareToOther)}${dagOther} of ${selectedNode.id}'s movers)`) + `<br>` +
        `${d.id} → ${selectedNode.id}: ${toSel === null ? 'suppressed' : fmt(toSel)}` +
        (toSel === null ? '' : ` (${pct(shareToSel)}${dagSel} of ${d.id}'s movers)`) + `</span>`;
      if (dagOther || dagSel) {
        html += `<br><span class="warn">${DAGGER} divided by a total that excludes suppressed ` +
          `flows, so the share is an upper bound.</span>`;
      }
      if (l.unreliable) {
        html += `<br><span class="warn">Margin of error is large relative to the estimate.</span>`;
      }
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
  // Suppressed cells never reach the node totals, so in a year with any suppression the headline
  // figure is a floor. Say "≥" rather than quietly printing a total that is short by ~66,000.
  const anySuppressed = d3.sum(networkData.nodes, n => (n.out_sup ? n.out_sup[y] : 0));
  document.getElementById('stat-edges').textContent =
    `${fmt(activeLinks.length)} of ${fmt(allLinks.length)}`;
  document.getElementById('stat-movers').textContent =
    (anySuppressed ? '≥ ' : '') + fmt(movers);
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
    const weights = computeLinks().map(l => l.movers).sort(d3.ascending);
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

  mapG.selectAll('path')
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
    mapG.selectAll('path').attr('d', path);
    centreMap();
    positionMapLegend();

    // The network panel needs the same treatment. forceCenter was built with the width the page
    // happened to load at and nothing updated it, so after a resize the layout kept pulling
    // toward a point that was no longer the middle of the panel -- at narrower widths that left
    // whole states clipped against the panel edge. Re-aim it and let the graph walk over.
    const { w, h } = dims();
    simulation.force('center', d3.forceCenter(w / 2, h / 2));
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
const valueLabel = v => state.metric === 'share' ? pct(v) : fmt(Math.round(v));

function buildMapLegend() {
  const lg = mapSvg.append('g').attr('class', 'map-legend').attr('pointer-events', 'none');
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

function updateMapLegend(title, cls, label) {
  mapSvg.select('.legend-title').text(title);

  // Highest class on top, which is how a choropleth legend is conventionally read.
  const n = cls.colors.length;
  legendRows = n;
  positionMapLegend();
  const rows = d3.range(n).reverse().map(k => ({
    color: cls.colors[k],
    text: classRange(k, cls.breaks, label, n, cls.single),
  }));

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
