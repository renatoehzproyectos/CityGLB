"""Dataset de fachadas: edificios con material conocido (Overture) + su foto de calle (Mapillary).

    export MAPILLARY_TOKEN='MLY|...'
    python build_facade_dataset.py --bbox MIN_LON MIN_LAT MAX_LON MAX_LAT --out data_facade/paris.npz
    python build_facade_dataset.py --bbox ... --count-only      # solo cuenta etiquetas y fotos útiles

Las fotos se eligen y recortan con street.py (idéntico a la app). Licencia: las fotos son CC BY-SA
de Mapillary; revisa sus condiciones antes de distribuir un modelo entrenado con ellas.
"""
import argparse
import contextlib
import hashlib
import json
import os
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from PIL import Image

from build_dataset import OVERTURE_RELEASE, outer_ring
from common import MATERIALS, material_index
from model_facade import INPUT_SIZE
from street import facade_color, project, select_views

GRAPH = "https://graph.mapillary.com"
CACHE_META = "cache/meta"
IMAGES_TTL = 6 * 3600  # las URL de miniaturas de Mapillary caducan: la lista se reutiliza solo unas horas


def cached(kind, key, ttl, fn):
    """Reutiliza el resultado de una consulta lenta (p. ej. de la celda «contar» a la celda «crear»)."""
    h = hashlib.sha1(json.dumps(key, sort_keys=True).encode()).hexdigest()[:16]
    path = os.path.join(CACHE_META, f"{kind}-{h}.json")
    if os.path.exists(path) and (ttl is None or time.time() - os.path.getmtime(path) < ttl):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:  # noqa: BLE001
            pass
    value = fn()
    os.makedirs(CACHE_META, exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(value, f)
    os.replace(path + ".tmp", path)
    return value


@contextlib.contextmanager
def _install_lock():
    """Serializa la instalación de extensiones entre procesos (si no, dos procesos se pisan el archivo)."""
    try:
        import fcntl
    except ImportError:  # no-Linux: sin bloqueo
        yield
        return
    with open("/tmp/duckdb_install.lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lk, fcntl.LOCK_UN)


def duckdb_connect():
    import duckdb

    con = duckdb.connect()
    for ext in ("spatial", "httpfs"):
        try:
            con.execute(f"LOAD {ext}")
        except Exception:  # noqa: BLE001 — aún no instalada: instálala con un solo proceso a la vez
            with _install_lock():
                try:
                    con.execute(f"LOAD {ext}")  # otro proceso pudo instalarla mientras esperábamos
                except Exception:  # noqa: BLE001
                    con.execute(f"INSTALL {ext}")
                    con.execute(f"LOAD {ext}")
    con.execute("SET s3_region='us-west-2'")
    return con


def labeled_buildings(bbox, release):
    a, b, c, d = bbox
    con = duckdb_connect()
    rows = con.execute(f"""
      SELECT id, facade_material, ST_AsText(geometry) FROM read_parquet(
        's3://overturemaps-us-west-2/release/{release}/theme=buildings/type=building/*', hive_partitioning=1)
      WHERE facade_material IS NOT NULL
        AND bbox.xmin >= {a} AND bbox.xmax <= {c} AND bbox.ymin >= {b} AND bbox.ymax <= {d}
    """).fetchall()
    out = []
    for bid, mat, wkt in rows:
        mi = material_index(mat)
        ring = outer_ring(wkt)
        if mi >= 0 and ring:
            out.append((bid, mi, ring))
    return out


def _fetch_cell(cell, token):
    for attempt in range(3):
        try:
            r = requests.get(f"{GRAPH}/images", headers={"Authorization": f"OAuth {token}"}, timeout=60, params={
                "bbox": ",".join(map(str, cell)), "limit": 2000,
                "fields": "id,computed_geometry,geometry,computed_compass_angle,compass_angle,captured_at,is_pano,thumb_256_url",
            })
        except requests.RequestException as e:
            print("Mapillary", e); time.sleep(1 + attempt); continue
        if r.status_code == 200:
            return r.json().get("data", [])
        if r.status_code in (429, 500, 502, 503, 504):
            time.sleep(2 * (attempt + 1)); continue
        print("Mapillary", r.status_code, r.text[:160])
        return []
    return []


def list_images(bbox, token, n=4):
    a, b, c, d = bbox
    cells = [(a + (c - a) * i / n, b + (d - b) * j / n, a + (c - a) * (i + 1) / n, b + (d - b) * (j + 1) / n)
             for i in range(n) for j in range(n)]
    done = [0]

    def fetch(cell):
        r = _fetch_cell(cell, token)
        done[0] += 1
        print(f"  Mapillary: celda {done[0]}/{len(cells)}", flush=True)
        return r

    with ThreadPoolExecutor(4) as ex:  # las 16 celdas en paralelo; se fusionan en el mismo orden que antes
        results = list(ex.map(fetch, cells))
    seen = {}
    for data in results:
        for im in data:
            geom = im.get("computed_geometry") or im.get("geometry")
            h = im.get("computed_compass_angle", im.get("compass_angle"))
            if im.get("is_pano") or not geom or h is None or not im.get("thumb_256_url"):
                continue
            seen[str(im["id"])] = {"id": str(im["id"]), "lon": geom["coordinates"][0], "lat": geom["coordinates"][1],
                                   "h": round(h), "t": int(im.get("captured_at") or 0), "url": im["thumb_256_url"]}
    return list(seen.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", nargs=4, type=float, required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--release", default=OVERTURE_RELEASE)
    ap.add_argument("--top-k", type=int, default=3, help="fotos distintas por edificio")
    ap.add_argument("--cache", default="cache/mapillary")
    ap.add_argument("--count-only", action="store_true")
    args = ap.parse_args()
    token = os.environ.get("MAPILLARY_TOKEN", "").strip()
    if not token:
        raise SystemExit("Define MAPILLARY_TOKEN.")

    olon, olat = (args.bbox[0] + args.bbox[2]) / 2, (args.bbox[1] + args.bbox[3]) / 2
    print("1/3 Overture: consultando edificios con material (la primera vez tarda unos minutos)…", flush=True)
    blds = cached("blds", [args.release, [round(v, 6) for v in args.bbox]], None,
                  lambda: labeled_buildings(args.bbox, args.release))
    print(f"edificios con material: {len(blds)}  {dict(Counter(MATERIALS[m] for _, m, _ in blds))}")
    print("2/3 Mapillary: listando fotos de calle…", flush=True)
    imgs = cached("imgs", [[round(v, 6) for v in args.bbox]], IMAGES_TTL, lambda: list_images(args.bbox, token))
    print(f"fotos de calle (no panorámicas): {len(imgs)}")
    local = [{"id": i["id"], "x": project(i["lon"], i["lat"], olon, olat)[0], "z": project(i["lon"], i["lat"], olon, olat)[1],
              "h": i["h"], "t": i["t"]} for i in imgs]
    url = {i["id"]: i["url"] for i in imgs}
    rings = [[project(lon, lat, olon, olat) for lon, lat in r] for _, _, r in blds]
    picks = select_views(rings, local, list(range(len(rings))), top_k=args.top_k)
    usable = {p["bi"] for p in picks}
    print(f"edificios con foto útil: {len(usable)}  por material: "
          f"{dict(Counter(MATERIALS[blds[b][1]] for b in usable))}  · recortes candidatos: {len(picks)}")
    if args.count_only or not args.out:
        return

    print("3/3 descargando fotos y recortando…", flush=True)
    os.makedirs(args.cache, exist_ok=True)
    ids = sorted({p["image_id"] for p in picks})

    def get(i):
        path = os.path.join(args.cache, f"{i}.jpg")
        if not os.path.exists(path):
            try:
                r = requests.get(url[i], timeout=30); r.raise_for_status()
                open(path, "wb").write(r.content)
            except Exception:  # noqa: BLE001
                return None
        return path

    with ThreadPoolExecutor(16) as ex:
        paths = dict(zip(ids, ex.map(get, ids)))

    X, Y, LL, BID, kept, bad = [], [], [], [], 0, 0
    for p in picks:
        path = paths.get(p["image_id"])
        if not path:
            continue
        try:
            im = Image.open(path).convert("RGB")
        except Exception:  # noqa: BLE001
            continue
        w, h = im.size
        u0, v0, u1, v1 = p["crop"]
        box = (u0 * w, v0 * h, u1 * w, v1 * h)
        col = facade_color((im.tobytes(), 3), w, h, box)
        if col is None:  # mismo filtro de calidad que la app
            bad += 1
            continue
        X.append(np.asarray(im.resize((INPUT_SIZE, INPUT_SIZE), Image.BILINEAR, box=box)))
        _, m, ring = blds[p["bi"]]
        Y.append(m)
        LL.append((sum(q[0] for q in ring) / len(ring), sum(q[1] for q in ring) / len(ring)))
        BID.append(p["bi"])
        kept += 1
    if not X:
        raise SystemExit("Sin recortes válidos.")
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    np.savez_compressed(args.out, x=np.stack(X), y=np.array(Y, np.int8), lonlat=np.array(LL), bid=np.array(BID))
    print(f"guardado {args.out}: {kept} recortes ({bad} descartados por cielo/árboles) "
          f"{dict(Counter(MATERIALS[y] for y in Y))}")


if __name__ == "__main__":
    main()
