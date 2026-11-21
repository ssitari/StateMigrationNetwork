"""Fetch, parse, and package Census ACS state-to-state migration flows for the visualization.

Downloads the annual "State-to-State Migration Flows" tables from the Census Bureau, parses
the two different sheet layouts they ship in, and writes data/migration_network.json.

  2005-2023   wide matrix: rows = current residence, columns = residence 1 year ago,
              wrapped into horizontal blocks of 5 origins. Row 6 labels each Estimate column.
  2024        tidy: Current residence | Residence 1 year ago | Estimate | MOE

Notes on the source data:
  * The ACS asks about residence ONE year ago, so each year is a one-year flow. These are not
    comparable to the 1980/1990/2000 census long-form tables, which asked about FIVE years ago.
  * There is no 2020 table. The Census Bureau did not release standard 2020 ACS 1-year
    estimates because of pandemic-driven collection problems. The gap is real, not an omission.
  * From 2024 the Bureau suppresses small cells as "N" (too few sample cases). Earlier years
    published an estimate for every pair. Suppressed cells are written as null. State totals
    for those years come from the workbook's supplemental tables, which suppression does not
    reduce, rather than from summing the cells.
  * Every estimate carries a 90% margin of error. For small state pairs the MOE can exceed the
    estimate itself; the app uses these to flag unreliable edges rather than hiding the problem.

Run:  python build_migration_data.py
"""
import hashlib, json, os, re, sys
import pandas as pd
import requests

BASE = 'https://www2.census.gov/programs-surveys/demo/tables/geographic-mobility/'
CACHE = 'data/cache'
OUT = 'data/migration_network.json'
OUT_CSV = 'data/s2s_flows_long.csv'      # tidy long form, useful on its own

# Path under BASE for each year's table. 2020 is absent from the source, by design.
SOURCES = {
    2005: '2005/state-to-state-migration/state_to_state_migrations_table_2005.xls',
    2006: '2006/state-to-state-migration/state_to_state_migrations_table_2006.xls',
    2007: '2007/state-to-state-migration/state_to_state_migrations_table_2007.xls',
    2008: '2008/state-to-state-migration/state_to_state_migrations_table_2008.xls',
    2009: '2009/state-to-state-migration/state_to_state_migrations_table_2009.xls',
    2010: '2010/state-to-state-migration/state_to_state_migrations_table_2010.xls',
    2011: '2011/state-to-state-migration/state_to_state_migrations_table_2011.xls',
    2012: '2012/state-to-state-migration/state_to_state_migrations_table_2012.xls',
    2013: '2013/state-to-state-migration/state_to_state_migrations_table_2013.xls',
    2014: '2014/state-to-state-migration/State_to_State_Migrations_Table_2014.xls',
    2015: '2015/state-to-state-migration/State_to_State_Migrations_Table_2015.xls',
    2016: '2016/state-to-state-migration/State_to_State_Migrations_Table_2016.xls',
    2017: '2017/state-to-state-migration/State_to_State_Migrations_Table_2017.xls',
    2018: '2018/state-to-state-migration/State_to_State_Migrations_Table_2018.xls',
    2019: '2019/state-to-state-migration/State_to_State_Migrations_Table_2019.xls',
    2021: '2021/state-to-state-migration/State_to_State_Migrations_Table_2021.xls',
    2022: '2022/state-to-state-migration/State_to_State_Migration_Table_2022_T13_updated_2024_06_27.xlsx',
    2023: '2023/state-to-state-migration/State_to_State_Migration_Table_2023_T13.xlsx',
    2024: '2024/state-to-state-migration/State_to_State_Migration_Table_2024_T13.xlsx',
}
GEOCODES = ('https://www2.census.gov/programs-surveys/popest/geographies/2023/'
            'state-geocodes-v2023.xlsx')

STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
"Delaware", "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana",
"Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
"Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
"New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma",
"Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas",
"Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"]
SSET = set(STATES)


def fetch(url, dest):
    if not os.path.exists(dest):
        r = requests.get(url, timeout=300)
        r.raise_for_status()
        open(dest, 'wb').write(r.content)
    return dest


def state(v):
    """Normalise a cell to a canonical state name, or None if it is not one."""
    if not isinstance(v, str):
        return None
    s = re.sub(r'\s+', ' ', v).strip().rstrip('*').strip()
    s = re.sub(r'\d+$', '', s).strip()      # strip trailing footnote markers
    return s if s in SSET else None


def num(v):
    """Numeric value, or None for the Bureau's X (not applicable) and N (suppressed)."""
    if isinstance(v, (int, float)) and pd.notna(v):
        return float(v)
    if isinstance(v, str):
        s = v.replace(',', '').strip()
        if re.fullmatch(r'-?\d+(\.\d+)?', s):
            return float(s)
    return None


def parse_wide(d):
    hdr = next(i for i in range(15) if (d.iloc[i].astype(str).str.strip() == 'Estimate').any())
    names = d.iloc[hdr - 1]
    origins = {c: state(names[c]) for c in range(d.shape[1])
               if str(d.iloc[hdr, c]).strip() == 'Estimate' and state(names.get(c))}
    dests = {r: state(d.iat[r, 0]) for r in range(hdr + 1, len(d)) if state(d.iat[r, 0])}
    return [(o, dst, num(d.iat[r, c]), num(d.iat[r, c + 1]))
            for r, dst in dests.items() for c, o in origins.items()]


def parse_tidy(d):
    hdr = next(i for i in range(15) if (d.iloc[i].astype(str).str.strip() == 'Estimate').any())
    out = []
    for r in range(hdr + 1, len(d)):
        dst, o = state(d.iat[r, 0]), state(d.iat[r, 1])
        if dst and o:
            out.append((o, dst, num(d.iat[r, 2]), num(d.iat[r, 3])))
    return out


def parse_totals(path, engine):
    """Published per-state interstate mover totals, where the workbook ships them.

    From 2024 the workbook carries two supplemental sheets beside the flow matrix: Table 2
    (by current residence, "Movers to current residence from different state") and Table 3 (by
    residence 1 year ago, "Movers from residence 1 year ago to different state"). Both cover the
    50 states and DC only -- movers from/to Puerto Rico are excluded, per the sheets' own
    footnotes -- which is the same universe as the 51 x 51 flow matrix. They are published
    independently of the cells, so they are NOT reduced by cell suppression.

    Returns {'in': {state: n}, 'out': {state: n}}, or None if the workbook has no such sheets.
    """
    sheets = pd.read_excel(path, sheet_name=None, header=None, engine=engine)
    found = {}
    for d in sheets.values():
        title = ' '.join(str(v) for v in d.iloc[:3, 0])
        if 'Supplemental' not in title:
            continue
        key = ('in' if 'Current Residence' in title else
               'out' if 'Residence 1 Year Ago' in title else None)
        hdr = next(i for i in range(15) if (d.iloc[i].astype(str).str.strip() == 'Estimate').any())
        col = next(c for c in range(d.shape[1])
                   if 'different state' in ' '.join(str(d.iat[r, c]) for r in range(hdr)))
        found[key] = {state(d.iat[r, 0]): num(d.iat[r, col])
                      for r in range(hdr + 1, len(d)) if state(d.iat[r, 0])}
    if not found:
        return None
    if set(found) != {'in', 'out'} or any(set(v) != SSET for v in found.values()):
        sys.exit('%s: supplemental totals incomplete' % path)
    return found


def main():
    os.makedirs(CACHE, exist_ok=True)
    years = sorted(SOURCES)
    flows, provenance, published = {}, {}, {}

    for y in years:
        path = SOURCES[y]
        dest = os.path.join(CACHE, 's2s_%d%s' % (y, os.path.splitext(path)[1]))
        fetch(BASE + path, dest)
        blob = open(dest, 'rb').read()
        provenance[y] = {'url': BASE + path, 'bytes': len(blob),
                         'sha256': hashlib.sha256(blob).hexdigest()}

        engine = 'xlrd' if dest.endswith('.xls') else 'openpyxl'
        d = pd.read_excel(dest, sheet_name=0, header=None, engine=engine)
        recs = (parse_wide if d.shape[1] > 10 else parse_tidy)(d)
        recs = [t for t in recs if t[0] != t[1]]        # drop within-state non-movers

        if len(recs) != 2550:
            sys.exit('%d: expected 2550 ordered state pairs, parsed %d' % (y, len(recs)))
        flows[y] = {(o, dst): (e, m) for o, dst, e, m in recs}
        miss = sum(1 for e, _ in flows[y].values() if e is None)
        if miss:
            published[y] = parse_totals(dest, engine)
            if published[y] is None:
                sys.exit('%d: cells are suppressed but no published state totals were found, so '
                         'state totals would silently be floors' % y)
        print('%d  pairs=%d  suppressed=%3d  total=%s'
              % (y, len(recs), miss, format(sum(e or 0 for e, _ in flows[y].values()), ',.0f')))

    # Census region for each state, for node colouring.
    g = pd.read_excel(fetch(GEOCODES, os.path.join(CACHE, 'state-geocodes-v2023.xlsx')),
                      header=None, engine='openpyxl')
    region_of, current = {}, None
    for _, row in g.iloc[5:].iterrows():
        name, fips = str(row[3]).strip(), str(row[2]).strip()
        if fips == '00' and name.endswith('Region'):
            current = name.replace(' Region', '')
        elif name in SSET:
            region_of[name] = current
    gap = SSET - set(region_of)
    if gap:
        sys.exit('no region for: %s' % sorted(gap))

    # USPS codes and FIPS come from the boundary file, so node ids match map features exactly.
    gj = json.load(open('data/states.geojson'))
    props = {f['properties']['name']: f['properties'] for f in gj['features']}
    gap = SSET - set(props)
    if gap:
        sys.exit('not in states.geojson: %s -- run build_states_geojson.py' % sorted(gap))

    # A state's out/in totals. Through 2023 nothing is suppressed, and the row and column sums
    # of the matrix reproduce the Bureau's own published marginals exactly. From 2024 the sums
    # would be FLOORS -- short by whatever the suppressed cells held -- and the app builds net
    # migration and the share denominators on them. So in a year with suppression the totals
    # come from the Bureau's published supplemental tables instead, which are not reduced by
    # suppression. out_sup/in_sup still count the suppressed cells, because the individual flows
    # behind them remain unknown.
    def cell_sum(y, s, direction):
        pairs = ((s, d) for d in STATES if d != s) if direction == 'out' else \
                ((o, s) for o in STATES if o != s)
        return sum(flows[y][p][0] or 0 for p in pairs)

    def total(y, s, direction):
        summed = cell_sum(y, s, direction)
        if y not in published:
            return summed
        pub = published[y][direction][s]
        # Published totals can only exceed the cell sum by what suppression hid. Anything else
        # means the two tables disagree on definitions, and mixing them would be wrong.
        n_sup = sum(flows[y][p][0] is None for p in
                    (((s, d) for d in STATES if d != s) if direction == 'out' else
                     ((o, s) for o in STATES if o != s)))
        if pub < summed or (n_sup == 0 and pub != summed):
            sys.exit('%d %s %s: published total %d vs cell sum %d with %d suppressed cells'
                     % (y, s, direction, pub, summed, n_sup))
        return pub

    for y in published:
        gap = sum(total(y, s, 'out') - cell_sum(y, s, 'out') for s in STATES)
        print('%d  published totals used; suppressed cells held %s movers' % (y, format(gap, ',.0f')))

    nodes = [{'id': props[s]['usps'], 'name': s, 'fips': props[s]['fips'],
              'region': region_of[s],
              'out': [int(total(y, s, 'out')) for y in years],
              'in': [int(total(y, s, 'in')) for y in years],
              'out_sup': [sum(flows[y][(s, d)][0] is None for d in STATES if d != s) for y in years],
              'in_sup': [sum(flows[y][(o, s)][0] is None for o in STATES if o != s) for y in years]}
             for s in STATES]

    def cell(y, o, d):
        e, m = flows[y][(o, d)]
        return (None if e is None else int(e), None if m is None else int(m))

    links = []
    for i, a in enumerate(STATES):
        for j in range(i + 1, len(STATES)):
            b = STATES[j]
            ab = [cell(y, a, b) for y in years]
            ba = [cell(y, b, a) for y in years]
            # Omit a pair only when every cell is a published 0. A suppressed (None) cell is
            # unknown, not zero, and the app has to be able to draw it as suppressed.
            if all(v == 0 for v, _ in ab + ba):
                continue
            links.append({'s': i, 't': j,
                          'ab': [v for v, _ in ab], 'abm': [v for _, v in ab],
                          'ba': [v for v, _ in ba], 'bam': [v for _, v in ba]})

    out = {'years': years,
           'metric': 'movers in the 12 months before the survey (ACS 1-year estimates)',
           'note': 'No 2020 table: the Census Bureau did not release standard 2020 ACS 1-year '
                   'estimates. Nulls are cells the Bureau suppressed as unreliable.',
           'totals_note': 'node out/in are the Bureau\'s published state totals of interstate '
                          'movers (50 states + DC, excluding Puerto Rico). Through 2023 they equal '
                          'the matrix row/column sums; in years with suppressed cells they come '
                          'from the supplemental tables and exceed the sum of published cells. '
                          'out_sup/in_sup count the suppressed cells per state.',
           'nodes': nodes, 'links': links, 'provenance': provenance}
    json.dump(out, open(OUT, 'w'), separators=(',', ':'))

    pd.DataFrame([(y, o, d, flows[y][(o, d)][0], flows[y][(o, d)][1])
                  for y in years for o in STATES for d in STATES if o != d],
                 columns=['year', 'origin', 'destination', 'movers', 'moe'])       .to_csv(OUT_CSV, index=False)
    print('wrote %s' % OUT_CSV)
    print('\nwrote %s: %d nodes, %d undirected links, %d years, %.2f MB'
          % (OUT, len(nodes), len(links), len(years), os.path.getsize(OUT) / 1e6))


if __name__ == '__main__':
    main()
