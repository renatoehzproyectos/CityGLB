"""Port EXACTO de src/lib/city/street-select.ts y street-color.ts.
Si cambias uno, cambia el otro: el entrenamiento debe ver los mismos recortes que la app."""
import math

M_PER_DEG = 111_320
FOV_DEG = 70
MAX_DIST = 45
MIN_DIST = 4
MIN_EDGE = 4
MAX_ANGLE = 30
V0, V1 = 0.3, 0.62
CELL = 50


def project(lon, lat, olon, olat):
    return (lon - olon) * M_PER_DEG * math.cos(math.radians(olat)), (olat - lat) * M_PER_DEG


def signed_area(ring):
    a = 0.0
    j = len(ring) - 1
    for i in range(len(ring)):
        a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
        j = i
    return a / 2


def ang_diff(a, b):
    return ((a - b + 540) % 360) - 180


def select_views(rings, images, order, top_k=1):
    """rings: lista de anillos [(x,z),...] cerrados. images: dicts {id,x,z,h,t}.
    Devuelve [{bi, image_id, crop:(u0,v0,u1,v1), dist}] (top_k fotos distintas por edificio)."""
    grid = {}
    for im in images:
        grid.setdefault((math.floor(im["x"] / CELL), math.floor(im["z"] / CELL)), []).append(im)
    newest = max((i["t"] for i in images), default=0)
    tan = math.tan(math.radians(FOV_DEG / 2))
    picks = []

    for bi in order:
        ring = rings[bi]
        sgn = 1 if signed_area(ring) >= 0 else -1
        cands = []  # (score, order_idx, pick)
        n_edges = max(len(ring) - 1, 1)
        for i in range(n_edges):
            p, q = ring[i], ring[(i + 1) % len(ring)]
            ex, ez = q[0] - p[0], q[1] - p[1]
            ln = math.hypot(ex, ez)
            if ln < MIN_EDGE:
                continue
            nx, nz = (ez / ln) * sgn, (-ex / ln) * sgn
            mx, mz = (p[0] + q[0]) / 2, (p[1] + q[1]) / 2
            cx, cz = math.floor(mx / CELL), math.floor(mz / CELL)
            for gx in range(cx - 1, cx + 2):
                for gz in range(cz - 1, cz + 2):
                    for im in grid.get((gx, gz), []):
                        dx, dz = mx - im["x"], mz - im["z"]
                        dist = math.hypot(dx, dz)
                        if dist < MIN_DIST or dist > MAX_DIST:
                            continue
                        if nx * -dx + nz * -dz <= 0:
                            continue
                        bearing = (math.degrees(math.atan2(dx, -dz)) + 360) % 360
                        delta = ang_diff(bearing, im["h"])
                        if abs(delta) > MAX_ANGLE:
                            continue
                        uc = 0.5 + math.tan(math.radians(delta)) / (2 * tan)
                        w = min(0.6, max(0.12, (ln / dist) / (2 * tan))) * 0.7
                        u0, u1 = max(0.0, uc - w / 2), min(1.0, uc + w / 2)
                        if u1 - u0 < w * 0.6:
                            continue
                        age = (newest - im["t"]) / (365.25 * 86400 * 1000)
                        score = dist + 0.6 * abs(delta) + 2 * max(0.0, age) - ln * 0.15
                        cands.append((score, len(cands), {"bi": bi, "image_id": im["id"], "crop": (u0, V0, u1, V1), "dist": dist}))
        cands.sort(key=lambda c: (c[0], c[1]))
        seen = set()
        for _, _, pk in cands:
            if pk["image_id"] in seen:
                continue
            seen.add(pk["image_id"])
            picks.append(pk)
            if len(seen) >= top_k:
                break
    return picks


def facade_color(rgb, w, h, rect):
    """rgb: bytes/array plano RGB(A) con `stride` canales (3 o 4). Igual que colorFromCrop().
    rect=(x0,y0,x1,y1) en píxeles. Devuelve (r,g,b 0..1, frac) o None."""
    data, stride = rgb
    R, G, B = [], [], []
    total = 0
    x0, x1 = max(0, math.floor(rect[0])), min(w, math.ceil(rect[2]))
    y0, y1 = max(0, math.floor(rect[1])), min(h, math.ceil(rect[3]))
    for y in range(y0, y1):
        for x in range(x0, x1):
            total += 1
            i = (y * w + x) * stride
            r, g, b = data[i], data[i + 1], data[i + 2]
            s = r + g + b
            lum = s / 765
            if lum < 0.1 or lum > 0.93:
                continue
            if b > r + 14 and b > g and lum > 0.55:
                continue
            if (2 * g - r - b) / s > 0.07:
                continue
            R.append(r); G.append(g); B.append(b)
    if not total or len(R) / total < 0.3 or len(R) < 12:
        return None
    med = lambda a: sorted(a)[len(a) >> 1]
    return (med(R) / 255, med(G) / 255, med(B) / 255, len(R) / total)
