"""Entrena BuildingNet con los .npz de build_dataset.py y exporta a ONNX para el navegador.

    python train.py --data data --epochs 30 --out ../public/models/building-net.onnx

Validación por bloques espaciales (celdas de ~500 m): ningún edificio de validación comparte
manzana con los de entrenamiento, así las métricas no se inflan por vecindad.
"""
import argparse
import glob
import json
import math
import os

import numpy as np
import torch
import torch.nn.functional as F

from common import INPUT_SIZE, MATERIALS, ROOF_SHAPES, WINDOW_M
from model import BuildingNet


def load(data_dir):
    xs, ms, hs, rs, mats, lls = [], [], [], [], [], []
    files = sorted(glob.glob(os.path.join(data_dir, "*.npz")))
    if not files:
        raise SystemExit(f"No hay .npz en {data_dir}. Ejecuta build_dataset.py primero.")
    for f in files:
        d = np.load(f)
        xs.append(d["x"]); ms.append(d["m"]); hs.append(d["h"]); rs.append(d["roof"]); mats.append(d["mat"]); lls.append(d["lonlat"])
    return (np.concatenate(xs), np.concatenate(ms), np.concatenate(hs), np.concatenate(rs).astype(np.int64),
            np.concatenate(mats).astype(np.int64), np.concatenate(lls))


def spatial_split(lonlat, val_frac, seed):
    cell = np.floor(lonlat[:, 0] * 200).astype(np.int64) * 1_000_003 + np.floor(lonlat[:, 1] * 200).astype(np.int64)
    rng = np.random.default_rng(seed)
    uniq = np.unique(cell)
    val_cells = set(rng.choice(uniq, size=max(1, int(len(uniq) * val_frac)), replace=False).tolist())
    is_val = np.array([c in val_cells for c in cell.tolist()])
    return ~is_val, is_val


def to_tensor(x, m, idx, device):
    rgb = torch.from_numpy(x[idx]).float().div_(255).permute(0, 3, 1, 2)
    mask = torch.from_numpy(m[idx]).float().unsqueeze(1)
    return torch.cat([rgb, mask], 1).to(device)


def augment(t):
    # Mismo giro para imagen y máscara. Brillo/contraste solo en RGB.
    if torch.rand(1) < 0.5: t = torch.flip(t, [3])
    if torch.rand(1) < 0.5: t = torch.flip(t, [2])
    t = torch.rot90(t, int(torch.randint(0, 4, (1,))), [2, 3])
    b = 1 + (torch.rand(t.size(0), 1, 1, 1, device=t.device) - 0.5) * 0.3
    c = (torch.rand(t.size(0), 1, 1, 1, device=t.device) - 0.5) * 0.1
    rgb = (t[:, :3] * b + c).clamp(0, 1)
    return torch.cat([rgb, t[:, 3:]], 1)


def class_weights(y, n):
    cnt = np.bincount(y[y >= 0], minlength=n).astype(np.float64)
    w = 1.0 / np.sqrt(np.maximum(cnt, 1.0))
    return torch.tensor(w / w[cnt > 0].mean() if (cnt > 0).any() else w, dtype=torch.float32)


def losses(out, h, roof, mat, wr, wm):
    ph, pr, pm = out
    lh = torch.zeros((), device=ph.device)
    ok = ~torch.isnan(h)
    if ok.any():
        mu, logvar = ph[ok, 0], ph[ok, 1].clamp(-6, 2)
        y = torch.log(h[ok].clamp(min=1.5))
        lh = (0.5 * (logvar + (y - mu) ** 2 / logvar.exp())).mean()
    lr = F.cross_entropy(pr, roof, weight=wr, ignore_index=-1, label_smoothing=0.05) if (roof >= 0).any() else torch.zeros((), device=ph.device)
    lm = F.cross_entropy(pm, mat, weight=wm, ignore_index=-1, label_smoothing=0.05) if (mat >= 0).any() else torch.zeros((), device=ph.device)
    return lh + lr + lm


@torch.no_grad()
def evaluate(net, x, m, h, roof, mat, idx, device, bs=256):
    net.eval()
    P_h, P_s, P_r, P_m = [], [], [], []
    for i in range(0, len(idx), bs):
        sl = idx[i:i + bs]
        ph, pr, pm = net(to_tensor(x, m, sl, device))
        P_h.append(ph[:, 0].exp().cpu().numpy()); P_s.append((0.5 * ph[:, 1].clamp(-6, 2)).exp().cpu().numpy())
        P_r.append(pr.argmax(1).cpu().numpy()); P_m.append(pm.argmax(1).cpu().numpy())
    ph, ps, pr, pm = map(np.concatenate, (P_h, P_s, P_r, P_m))
    out = {}
    ok = ~np.isnan(h[idx])
    if ok.any():
        err = np.abs(ph[ok] - h[idx][ok])
        out["height_mae_m"] = float(err.mean())
        out["height_within_30pct"] = float((err / h[idx][ok] <= 0.3).mean())
        out["height_n"] = int(ok.sum())
    for name, pred, y in (("roof", pr, roof), ("material", pm, mat)):
        okc = y[idx] >= 0
        if okc.any():
            out[f"{name}_acc"] = float((pred[okc] == y[idx][okc]).mean())
            out[f"{name}_n"] = int(okc.sum())
    return out


def export_onnx(net, path, metrics):
    net.eval().cpu()
    dummy = torch.zeros(1, 4, INPUT_SIZE, INPUT_SIZE)
    kw = dict(input_names=["input"], output_names=["height", "roof", "material"],
              dynamic_axes={"input": {0: "n"}, "height": {0: "n"}, "roof": {0: "n"}, "material": {0: "n"}},
              opset_version=17)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    try:
        torch.onnx.export(net, dummy, path, dynamo=False, **kw)
    except TypeError:
        torch.onnx.export(net, dummy, path, **kw)
    meta = {
        "version": 1,
        "input_size": INPUT_SIZE,
        "window_m": WINDOW_M,
        "roof_shapes": ROOF_SHAPES,
        "materials": MATERIALS,
        "metrics": metrics,
    }
    with open(os.path.splitext(path)[0] + ".json", "w") as f:
        json.dump(meta, f, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--out", default="../public/models/building-net.onnx")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--val-frac", type=float, default=0.15)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed); np.random.seed(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    x, m, h, roof, mat, ll = load(args.data)
    tr, va = spatial_split(ll, args.val_frac, args.seed)
    tr_idx, va_idx = np.where(tr)[0], np.where(va)[0]
    print(f"{len(x)} ejemplos · train {len(tr_idx)} · val {len(va_idx)} · {device}")
    if len(va_idx) == 0:
        raise SystemExit("Validación vacía: necesitas más datos / más zonas.")

    net = BuildingNet().to(device)
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = args.epochs * math.ceil(len(tr_idx) / args.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps)
    wr = class_weights(roof[tr_idx], len(ROOF_SHAPES)).to(device)
    wm = class_weights(mat[tr_idx], len(MATERIALS)).to(device)

    best, best_state, metrics = float("inf"), None, {}
    for ep in range(args.epochs):
        net.train()
        perm = np.random.permutation(tr_idx)
        tot = 0.0
        for i in range(0, len(perm), args.batch):
            sl = perm[i:i + args.batch]
            if len(sl) < 2:
                continue
            xb = augment(to_tensor(x, m, sl, device))
            hb = torch.from_numpy(h[sl]).to(device)
            rb = torch.from_numpy(roof[sl]).to(device)
            mb = torch.from_numpy(mat[sl]).to(device)
            loss = losses(net(xb), hb, rb, mb, wr, wm)
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
            tot += float(loss.detach()) * len(sl)
        ev = evaluate(net, x, m, h, roof, mat, va_idx, device)
        # criterio de "mejor": error de altura + error de clasificación
        score = ev.get("height_mae_m", 0) / 10 + (1 - ev.get("roof_acc", 1)) + (1 - ev.get("material_acc", 1))
        print(f"ep {ep + 1:3d}  loss {tot / len(perm):.3f}  val {json.dumps({k: round(v, 3) for k, v in ev.items()})}")
        if score < best:
            best, metrics = score, ev
            best_state = {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}
    net.load_state_dict(best_state)
    export_onnx(net, args.out, metrics)
    print(f"exportado {args.out}  métricas val: {metrics}")


if __name__ == "__main__":
    main()
