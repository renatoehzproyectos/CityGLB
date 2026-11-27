"""Datos SINTÉTICOS de fachadas (patrones distintos por clase) solo para probar el pipeline."""
import argparse
import os

import numpy as np

from common import MATERIALS
from model_facade import INPUT_SIZE


def tile(c, rng, S=INPUT_SIZE):
    img = np.full((S, S, 3), 150, np.float32) + rng.normal(0, 6, (S, S, 3))
    yy, xx = np.mgrid[0:S, 0:S]
    if c == 0: img[(yy // 8 + (xx // 16 + yy // 8) % 2) % 2 == 0] *= 0.7   # ladrillo: franjas
    if c == 1: img *= 0.9 + 0.1 * rng.random((S, S, 1))                    # hormigón: ruido
    if c == 2: img[:, :, 2] += 60; img[(xx // 28 + yy // 28) % 2 == 0] += 20   # vidrio: azul en rejilla
    if c == 3: img[:, :, 0] += 40                                          # estuco: cálido liso
    if c == 4: img[(yy // 14 + xx // 14) % 2 == 0] *= 0.8                  # piedra: bloques
    if c == 5: img[xx % 10 < 2] *= 0.6                                     # metal: líneas verticales
    if c == 6: img[yy % 6 < 2] *= 0.65                                     # madera: líneas horizontales
    return np.clip(img, 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=700)
    a = ap.parse_args()
    rng = np.random.default_rng(3)
    y = rng.integers(0, len(MATERIALS), a.n)
    x = np.stack([tile(int(c), rng) for c in y])
    ll = np.stack([rng.uniform(0, 0.2, a.n), rng.uniform(0, 0.2, a.n)], 1)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    np.savez_compressed(a.out, x=x, y=y.astype(np.int8), lonlat=ll, bid=np.arange(a.n))
    print("ok", a.out)


if __name__ == "__main__":
    main()
