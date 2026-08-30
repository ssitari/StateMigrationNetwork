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

// Sequential ramp for "share of a selected state's movers"; diverging ramp for net migration,
// which is signed and needs a meaningful zero.
const shareScale = d3.scaleSequential(d3.interpolateYlGnBu);
const netScale   = d3.scaleDiverging(d3.interpolateRdBu);

const tooltip = d3.select('#tooltip');

function dims() {
  const r = container.getBoundingClientRect();
  return { w: r.width, h: r.height };
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
  draw();
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
      suppressed: ab === null || ba === null,
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

// ── Main render ──────────────────────────────────────────────────────────────
function draw() {
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
  simulation.alpha(0.6).restart();

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

  // Values keyed by node index, for both panels.
  const values = new Map();
  if (sel === null) {
    simNodes.forEach(d => values.set(d.index, netMigration(d.index)));
  } else {
    for (const l of activeLinks) {
      if (l.s === sel) values.set(l.t, pairValue(l, sel));
      else if (l.t === sel) values.set(l.s, pairValue(l, sel));
    }
  }

  let colorOf;
  if (sel === null) {
    const extent = d3.max(Array.from(values.values()), Math.abs) || 1;
    netScale.domain([-extent, 0, extent]);        // red = losing, blue = gaining
    colorOf = i => netScale(values.get(i) || 0);
    updateMapLegend(-extent, extent, 'Net migration (in − out)', true);
  } else {
    const maxVal = d3.max(Array.from(values.values())) || 1;
    shareScale.domain([0, maxVal]);
    colorOf = i => (values.has(i) ? shareScale(values.get(i)) : LAND_COLOR);
    updateMapLegend(0, maxVal, legendTitle(), false);
  }

  const neighbours = sel === null ? null : new Set(values.keys());

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
  let html = `<strong>${d.name}</strong><br>${d.region} · ${networkData.years[y]}<br>` +
    `<span class="num">Left the state: ${fmt(n.out[y])}<br>` +
    `Arrived: ${fmt(n.in[y])}<br>` +
    `Net: ${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}</span>`;

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
  document.getElementById('stat-edges').textContent =
    `${fmt(activeLinks.length)} of ${fmt(allLinks.length)}`;
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
    draw();
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
    draw();
  });

  d3.selectAll('input[name="mode"]').on('change', function () {
    state.mode = this.value;
    draw();
  });

  document.getElementById('flag-unreliable').addEventListener('change', function () {
    state.flagUnreliable = this.checked;
    draw();
  });

  document.getElementById('threshold-slider').addEventListener('input', function () {
    state.threshold = thresholdFromSlider(+this.value);
    document.getElementById('threshold-val').textContent = thresholdLabel();
    draw();
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
    slider.max = SHARE_STEPS;
    slider.step = 1;
    if (reset) state.threshold = 0.03;           // ~480 edges: dense enough to read structure
    slider.value = Math.round(state.threshold * 1000);
  } else {
    const weights = computeLinks().map(l => l.movers).sort(d3.ascending);
    slider.max = Math.round(d3.quantile(weights, 0.99));
    slider.step = 100;
    if (reset) state.threshold = Math.round(d3.quantile(weights, 0.5));
    slider.value = Math.min(state.threshold, slider.max);
  }
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

  window.addEventListener('resize', () => {
    const nr = mapContainer.getBoundingClientRect();
    projection.fitSize([nr.width * 0.94, nr.height * 0.84], geo);
    mapG.selectAll('path').attr('d', path);
    centreMap();
    positionMapLegend();
  });

  function centreMap() {
    const b = mapG.node().getBBox();
    const nr = mapContainer.getBoundingClientRect();
    mapG.attr('transform',
      `translate(${(nr.width - b.width) / 2 - b.x},${(nr.height - b.height) / 2 - b.y - 10})`);
  }
}

function buildMapLegend() {
  const defs = mapSvg.append('defs');
  ['share', 'net'].forEach(kind => {
    const grad = defs.append('linearGradient').attr('id', `grad-${kind}`);
    d3.range(0, 1.001, 0.05).forEach(t => {
      grad.append('stop')
        .attr('offset', `${(t * 100).toFixed(0)}%`)
        .attr('stop-color', kind === 'share'
          ? d3.interpolateYlGnBu(t)
          : d3.interpolateRdBu(t));           // red = losing, on the left
    });
  });

  const lg = mapSvg.append('g').attr('class', 'map-legend').attr('pointer-events', 'none');
  lg.append('text').attr('class', 'legend-title')
    .attr('y', -6).attr('fill', '#bbb').attr('font-size', '10px')
    .attr('font-weight', '600').style('font-family', 'system-ui, sans-serif');
  lg.append('rect').attr('class', 'legend-bar').attr('y', 0).attr('height', 8);
  lg.append('text').attr('class', 'legend-min')
    .attr('y', 19).attr('fill', '#888').attr('font-size', '9px')
    .style('font-family', 'system-ui, sans-serif');
  lg.append('text').attr('class', 'legend-max')
    .attr('y', 19).attr('text-anchor', 'end').attr('fill', '#888').attr('font-size', '9px')
    .style('font-family', 'system-ui, sans-serif');
  positionMapLegend();
}

function positionMapLegend() {
  const r = mapContainer.getBoundingClientRect();
  const lw = Math.min(200, r.width - 24);
  mapSvg.select('.map-legend').attr('transform', `translate(12, ${r.height - 30})`);
  mapSvg.select('.legend-bar').attr('width', lw);
  mapSvg.select('.legend-max').attr('x', lw);
}

function updateMapLegend(min, max, title, diverging) {
  const label = v => state.metric === 'share' && !diverging
    ? pct(v)
    : (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(Math.round(v)));
  mapSvg.select('.legend-title').text(title);
  mapSvg.select('.legend-bar').attr('fill', `url(#grad-${diverging ? 'net' : 'share'})`);
  mapSvg.select('.legend-min').text(label(min));
  mapSvg.select('.legend-max').text(label(max));
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
