"""Download the Census cartographic-boundary state file and emit a small WGS84 GeoJSON.

Source: Census Bureau 2024 Cartographic Boundary Files, 1:20,000,000 (most generalized).
Native CRS is NAD83 (EPSG:4269); the NAD83/WGS84 difference is sub-meter, far below the
resolution of a 1:20M generalized boundary, so coordinates are emitted as EPSG:4326.
Alaska and Hawaii are left in true position -- d3.geoAlbersUsa() relocates them at draw time.
"""
import io, json, os, zipfile, requests, shapefile

URL = 'https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_state_20m.zip'
CACHE = 'data/cache/cb_2024_us_state_20m.zip'
OUT = 'data/states.geojson'
# 50 states + DC; excludes PR and the island areas, which the migration table treats separately.
SKIP_FIPS = {'60', '66', '69', '72', '78'}

os.makedirs('data/cache', exist_ok=True)
if not os.path.exists(CACHE):
    r = requests.get(URL, timeout=300); r.raise_for_status()
    open(CACHE, 'wb').write(r.content)
    print('downloaded', len(r.content), 'bytes')

zf = zipfile.ZipFile(CACHE)
base = next(n[:-4] for n in zf.namelist() if n.endswith('.shp'))
rd = shapefile.Reader(shp=io.BytesIO(zf.read(base + '.shp')),
                      dbf=io.BytesIO(zf.read(base + '.dbf')),
                      shx=io.BytesIO(zf.read(base + '.shx')))
fields = [f[0] for f in rd.fields[1:]]

def round_geom(g, nd=4):
    if isinstance(g, (list, tuple)):
        if len(g) == 2 and all(isinstance(v, (int, float)) for v in g):
            return [round(g[0], nd), round(g[1], nd)]
        return [round_geom(x, nd) for x in g]
    return g

feats = []
for sr in rd.iterShapeRecords():
    rec = dict(zip(fields, sr.record))
    if rec['STATEFP'] in SKIP_FIPS:
        continue
    geom = sr.shape.__geo_interface__
    feats.append({
        'type': 'Feature',
        'properties': {'fips': rec['STATEFP'], 'usps': rec['STUSPS'], 'name': rec['NAME']},
        'geometry': {'type': geom['type'], 'coordinates': round_geom(geom['coordinates'])},
    })

feats.sort(key=lambda f: f['properties']['name'])
json.dump({'type': 'FeatureCollection', 'features': feats}, open(OUT, 'w'), separators=(',', ':'))
print(f'wrote {OUT}: {len(feats)} features, {os.path.getsize(OUT)/1e6:.2f} MB')
print('names:', ', '.join(f['properties']['usps'] for f in feats))
