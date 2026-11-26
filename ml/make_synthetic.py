"""Dataset SINTÉTICO solo para probar que el pipeline corre (NO produce un modelo útil).

    python make_synthetic.py --out data_smoke/synth.npz --n 600
    python train.py --data data_smoke --epochs 2 --out /tmp/smoke.onnx
"""
import argparse
import os

import numpy as np

from common import INPUT_SIZE


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=600)
    args = ap.parse_args()
    rng = np.random.default_rng(1)
    S = INPUT_SIZE
    X = np.zeros((args.n, S, S, 3), np.uint8)
    M = np.zeros((args.n, S, S), np.uint8)
    H = np.zeros(args.n, np.float32)
    roof = rng.integers(-1, 5, args.n).astype(np.int8)
    mat = rng.integers(-1, 7, args.n).astype(np.int8)
    for i in range(args.n):
        bg = rng.integers(70, 140)
        X[i] = bg
        w, d = rng.integers(10, 40, 2)
        x0, y0 = rng.integers(10, S - 45, 2)
        h = float(rng.uniform(4, 60))
        X[i, y0:y0 + d, x0:x0 + w] = rng.integers(120, 230, 3)
        sh = int(h / 4)  # "sombra" proporcional a la altura → señal aprendible
        X[i, y0 + d:y0 + d + sh, x0 + sh // 2:x0 + w + sh // 2] = 30
        M[i, y0:y0 + d, x0:x0 + w] = 1
        H[i] = np.nan if rng.random() < 0.3 else h
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    ll = np.stack([rng.uniform(0, 0.2, args.n), rng.uniform(0, 0.2, args.n)], 1)
    np.savez_compressed(args.out, x=X, m=M, h=H, roof=roof, mat=mat, lonlat=ll)
    print("ok", args.out)


if __name__ == "__main__":
    main()
