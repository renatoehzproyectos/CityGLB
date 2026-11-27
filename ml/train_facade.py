"""Entrena FacadeNet y exporta a ONNX.

    python train_facade.py --data data_facade --epochs 25 --out ../public/models/facade-net.onnx

Validación por bloques espaciales (~500 m). Reporta también la exactitud de "adivinar siempre la
clase más común" (baseline) y el recall por clase: así se ve si el modelo aporta algo real.
"""
import argparse
import glob
import json
import math
import os

import numpy as np
import torch
import torch.nn.functional as F

from common import MATERIALS
from model_facade import INPUT_SIZE, FacadeNet


def load(d):
    files = sorted(glob.glob(os.path.join(d, "*.npz")))
    if not files:
        raise SystemExit(f"No hay .npz en {d}.")
    xs, ys, ll = [], [], []
    for f in files:
        z = np.load(f)
        xs.append(z["x"]); ys.append(z["y"]); ll.append(z["lonlat"])
    return np.concatenate(xs), np.concatenate(ys).astype(np.int64), np.concatenate(ll)


def split(ll, frac, seed):
    cell = np.floor(ll[:, 0] * 200).astype(np.int64) * 1_000_003 + np.floor(ll[:, 1] * 200).astype(np.int64)
    u = np.unique(cell)
    val = set(np.random.default_rng(seed).choice(u, size=max(1, int(len(u) * frac)), replace=False).tolist())
    isv = np.array([c in val for c in cell.tolist()])
    return np.where(~isv)[0], np.where(isv)[0]


def tens(x, idx, dev):
    return torch.from_numpy(x[idx]).float().div_(255).permute(0, 3, 1, 2).to(dev)


def augment(t):
    flip = torch.rand(t.size(0), device=t.device) < 0.5
    t = torch.where(flip.view(-1, 1, 1, 1), torch.flip(t, [3]), t)
    s = float(torch.empty(1).uniform_(0.8, 1.0))  # recorte aleatorio (mismo para el lote)
    n = t.size(2)
    k = max(8, int(n * s))
    oy, ox = np.random.randint(0, n - k + 1, 2)
    t = F.interpolate(t[:, :, oy:oy + k, ox:ox + k], size=(n, n), mode="bilinear", align_corners=False)
    b = 1 + (torch.rand(t.size(0), 1, 1, 1, device=t.device) - 0.5) * 0.3
    c = (torch.rand(t.size(0), 1, 1, 1, device=t.device) - 0.5) * 0.1
    return (t * b + c).clamp(0, 1)


@torch.no_grad()
def evaluate(net, x, y, idx, dev):
    net.eval()
    pred = []
    for i in range(0, len(idx), 256):
        pred.append(net(tens(x, idx[i:i + 256], dev)).argmax(1).cpu().numpy())
    pred = np.concatenate(pred)
    yt = y[idx]
    acc = float((pred == yt).mean())
    recall = {}
    for c in range(len(MATERIALS)):
        m = yt == c
        if m.any():
            recall[MATERIALS[c]] = round(float((pred[m] == c).mean()), 3)
    base = float(np.bincount(yt, minlength=len(MATERIALS)).max() / len(yt))
    return {"acc": acc, "balanced_acc": float(np.mean(list(recall.values()))), "majority_baseline": base,
            "recall": recall, "n_val": int(len(idx))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data_facade")
    ap.add_argument("--out", default="../public/models/facade-net.onnx")
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.15)
    ap.add_argument("--no-pretrained", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()

    torch.manual_seed(a.seed); np.random.seed(a.seed)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    x, y, ll = load(a.data)
    tr, va = split(ll, a.val_frac, a.seed)
    print(f"{len(x)} recortes · train {len(tr)} · val {len(va)} · {dev} · clases {np.bincount(y, minlength=len(MATERIALS)).tolist()}")
    if len(va) == 0 or len(tr) < 20:
        raise SystemExit("Muy pocos datos: agrega más ciudades.")

    net = FacadeNet(pretrained=not a.no_pretrained).to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.epochs * math.ceil(len(tr) / a.batch))
    cnt = np.bincount(y[tr], minlength=len(MATERIALS)).astype(np.float64)
    w = 1 / np.sqrt(np.maximum(cnt, 1)); w = torch.tensor(w / w[cnt > 0].mean(), dtype=torch.float32, device=dev)

    best, state, metrics = -1.0, None, {}
    for ep in range(a.epochs):
        net.train()
        perm = np.random.permutation(tr); tot = 0.0
        for i in range(0, len(perm), a.batch):
            sl = perm[i:i + a.batch]
            if len(sl) < 2:
                continue
            loss = F.cross_entropy(net(augment(tens(x, sl, dev))), torch.from_numpy(y[sl]).to(dev), weight=w, label_smoothing=0.05)
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
            tot += float(loss.detach()) * len(sl)
        ev = evaluate(net, x, y, va, dev)
        print(f"ep {ep + 1:3d} loss {tot / len(perm):.3f} acc {ev['acc']:.3f} balanced {ev['balanced_acc']:.3f} (baseline {ev['majority_baseline']:.3f})")
        if ev["balanced_acc"] > best:
            best, metrics = ev["balanced_acc"], ev
            state = {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}
    net.load_state_dict(state)
    net.eval().cpu()
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    kw = dict(input_names=["input"], output_names=["material"], dynamic_axes={"input": {0: "n"}, "material": {0: "n"}}, opset_version=17)
    dummy = torch.zeros(1, 3, INPUT_SIZE, INPUT_SIZE)
    try:
        torch.onnx.export(net, dummy, a.out, dynamo=False, **kw)
    except TypeError:
        torch.onnx.export(net, dummy, a.out, **kw)
    with open(os.path.splitext(a.out)[0] + ".json", "w") as f:
        json.dump({"version": 1, "input_size": INPUT_SIZE, "materials": MATERIALS, "metrics": metrics}, f, indent=2)
    print("exportado", a.out, json.dumps(metrics))


if __name__ == "__main__":
    main()
