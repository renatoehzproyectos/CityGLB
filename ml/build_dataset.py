"""Construye el dataset de entrenamiento: parches de imagen aérea + etiquetas reales de Overture.

Cada edificio con altura / niveles / forma de techo / material conocidos se convierte en un
ejemplo: parche 96×96 (96 m de terreno) centrado en el edificio + máscara de su huella.
Los campos que no existen quedan sin etiqueta (el entrenamiento los ignora).

    python build_dataset.py --bbox -0.141 51.495 -0.105 51.515 --out data/london.npz

Repite --bbox para varias zonas (mezcla ciudades distintas: el modelo generaliza mejor).

IMPORTANTE (licencias): la imagen por defecto son teselas Esri World Imagery. Revisa sus
condiciones antes de entrenar y distribuir un modelo; con --tiles-url puedes usar imagen
propia o con licencia abierta (p. ej. NAIP, Sentinel-2 de alta resolución, ortofotos oficiales).
"""
import argparse
import io
import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import numpy as np
import requests
from PIL import Image, ImageDraw

from common import INPUT_SIZE, LEVEL_HEIGHT_M, WINDOW_M, material_index, roof_index

OVERTURE_RELEASE = "2026-08-19.0"  # mantener igual que src/lib/city/parse-overture.ts
ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
TS = 256
_RING = re.compile(r"\(([^()]*)\)")


def outer_ring(wkt):
    """Anillo exterior del primer polígono de un WKT POLYGON / MULTIPOLYGON → [(lon, lat), ...]."""
    m = _RING.search(wkt)
    if not m:
        return None
    pts = []
    for pair in m.group(1).split(","):
        xy = pair.split()
        if len(xy) >= 2:
            pts.append((float(xy[0]), float(xy[1])))
    return pts if len(pts) >= 4 else None


def query_overture(bbox, release):
    import duckdb

    min_lon, min_lat, max_lon, max_lat = bbox
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    sql = f"""
      SELECT id, height, num_floors, roof_shape, facade_material, ST_AsText(geometry) AS wkt
      FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=buildings/type=building/*',
                        hive_partitioning=1)
      WHERE bbox.xmin >= {min_lon} AND bbox.xmax <= {max_lon}
        AND bbox.ymin >= {min_lat} AND bbox.ymax <= {max_lat}
    """
    return con.execute(sql).fetchall()


def lonlat_to_px(lon, lat, z):
    n = TS * 2**z
    x = (lon + 180.0) / 360.0 * n
    r = math.radians(lat)
    y = (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n
    return x, y


class Tiles:
    def __init__(self, url, z, cache_dir):
        self.url, self.z, self.cache = url, z, cache_dir
        self.session = requests.Session()

    def _path(self, x, y):
        return os.path.join(self.cache, str(self.z), str(x), f"{y}.jpg")

    def fetch(self, x, y):
        p = self._path(x, y)
        if os.path.exists(p):
            return
        os.makedirs(os.path.dirname(p), exist_ok=True)
        r = self.session.get(self.url.format(z=self.z, x=x, y=y), timeout=30)
        r.raise_for_status()
        with open(p, "wb") as f:
            f.write(r.content)

    @lru_cache(maxsize=1024)
    def image(self, x, y):
        p = self._path(x, y)
        try:
            return np.asarray(Image.open(p).convert("RGB"))
        except Exception:
            return np.zeros((TS, TS, 3), np.uint8)


def window_px(lat, z):
    mpp = 156543.03392 * math.cos(math.radians(lat)) / 2**z
    return WINDOW_M / mpp


def patch(tiles, ring, lon_c, lat_c):
    """Parche RGB + máscara de huella de WINDOW_M metros centrado en (lon_c, lat_c)."""
    z = tiles.z
    cx, cy = lonlat_to_px(lon_c, lat_c, z)
    half = window_px(lat_c, z) / 2
    x0, y0, x1, y1 = cx - half, cy - half, cx + half, cy + half
    tx0, ty0, tx1, ty1 = int(x0 // TS), int(y0 // TS), int(x1 // TS), int(y1 // TS)
    mosaic = np.zeros(((ty1 - ty0 + 1) * TS, (tx1 - tx0 + 1) * TS, 3), np.uint8)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            mosaic[(ty - ty0) * TS:(ty - ty0 + 1) * TS, (tx - tx0) * TS:(tx - tx0 + 1) * TS] = tiles.image(tx, ty)
    ox, oy = tx0 * TS, ty0 * TS
    box = (x0 - ox, y0 - oy, x1 - ox, y1 - oy)
    rgb = Image.fromarray(mosaic).resize((INPUT_SIZE, INPUT_SIZE), Image.BICUBIC, box=box)
    scale = INPUT_SIZE / (x1 - x0)
    poly = []
    for lon, lat in ring:
        px, py = lonlat_to_px(lon, lat, z)
        poly.append(((px - x0) * scale, (py - y0) * scale))
    m = Image.new("L", (INPUT_SIZE, INPUT_SIZE), 0)
    ImageDraw.Draw(m).polygon(poly, fill=1)
    return np.asarray(rgb), np.asarray(m)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", nargs=4, type=float, action="append", required=True,
                    metavar=("MIN_LON", "MIN_LAT", "MAX_LON", "MAX_LAT"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--release", default=OVERTURE_RELEASE)
    ap.add_argument("--tiles-url", default=ESRI)
    ap.add_argument("--zoom", type=int, default=18)
    ap.add_argument("--cache", default="cache/tiles")
    ap.add_argument("--max", type=int, default=60000, help="máximo de edificios etiquetados")
    ap.add_argument("--min-area-px", type=float, default=30.0, help="descarta huellas más pequeñas (px² del parche)")
    args = ap.parse_args()

    rows = []
    for bb in args.bbox:
        got = query_overture(bb, args.release)
        print(f"bbox {bb}: {len(got)} edificios")
        rows += got

    items = []
    for _id, height, floors, roof_shape, facade_material, wkt in rows:
        h = height if height and height > 1 else (floors * LEVEL_HEIGHT_M if floors and floors > 0 else None)
        ri, mi = roof_index(roof_shape), material_index(facade_material)
        if h is None and ri < 0 and mi < 0:
            continue  # sin ninguna etiqueta: no sirve para supervisar
        ring = outer_ring(wkt)
        if ring:
            items.append((ring, h, ri, mi))
    np.random.default_rng(0).shuffle(items)
    items = items[: args.max]
    print(f"{len(items)} edificios con al menos una etiqueta")

    tiles = Tiles(args.tiles_url, args.zoom, args.cache)
    need = set()
    for ring, *_ in items:
        lon_c = sum(p[0] for p in ring) / len(ring)
        lat_c = sum(p[1] for p in ring) / len(ring)
        cx, cy = lonlat_to_px(lon_c, lat_c, tiles.z)
        half = window_px(lat_c, tiles.z) / 2
        for ty in range(int((cy - half) // TS), int((cy + half) // TS) + 1):
            for tx in range(int((cx - half) // TS), int((cx + half) // TS) + 1):
                need.add((tx, ty))
    print(f"descargando {len(need)} teselas…")

    def get(t):
        try:
            tiles.fetch(*t)
        except Exception as e:  # noqa: BLE001
            print("tesela falló", t, e)

    with ThreadPoolExecutor(8) as ex:
        list(ex.map(get, sorted(need)))

    X, M, H, R, MAT, LL = [], [], [], [], [], []
    for ring, h, ri, mi in items:
        lon_c = sum(p[0] for p in ring) / len(ring)
        lat_c = sum(p[1] for p in ring) / len(ring)
        rgb, mask = patch(tiles, ring, lon_c, lat_c)
        if mask.sum() < args.min_area_px or not rgb.any():
            continue
        X.append(rgb); M.append(mask)
        H.append(np.nan if h is None else h); R.append(ri); MAT.append(mi); LL.append((lon_c, lat_c))

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    np.savez_compressed(
        args.out,
        x=np.stack(X).astype(np.uint8), m=np.stack(M).astype(np.uint8),
        h=np.array(H, np.float32), roof=np.array(R, np.int8), mat=np.array(MAT, np.int8),
        lonlat=np.array(LL, np.float64),
    )
    print(f"guardado {args.out}: {len(X)} ejemplos "
          f"(altura {int(np.sum(~np.isnan(H)))}, techo {int(np.sum(np.array(R) >= 0))}, "
          f"material {int(np.sum(np.array(MAT) >= 0))})")


if __name__ == "__main__":
    main()
