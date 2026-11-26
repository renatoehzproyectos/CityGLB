"""BuildingNet: CNN pequeña multitarea (altura, forma de techo, material de fachada).

Entrada : [N, 4, 96, 96] float32 en [0,1]  → canales R, G, B y máscara de la huella (0/1).
Salidas : height   [N, 2]  → (mu, logvar) de log(altura en metros)  (gaussiana)
          roof     [N, 5]  → logits de ROOF_SHAPES
          material [N, 7]  → logits de MATERIALS
La normalización va DENTRO del modelo, así el navegador solo envía píxeles/255.
"""
import torch
import torch.nn as nn
import torch.nn.functional as F

from common import MATERIALS, ROOF_SHAPES


class Block(nn.Module):
    def __init__(self, cin, cout, stride):
        super().__init__()
        self.c1 = nn.Conv2d(cin, cout, 3, stride, 1, bias=False)
        self.b1 = nn.BatchNorm2d(cout)
        self.c2 = nn.Conv2d(cout, cout, 3, 1, 1, bias=False)
        self.b2 = nn.BatchNorm2d(cout)
        self.skip = None
        if stride != 1 or cin != cout:
            self.skip = nn.Sequential(nn.Conv2d(cin, cout, 1, stride, bias=False), nn.BatchNorm2d(cout))

    def forward(self, x):
        y = F.relu(self.b1(self.c1(x)))
        y = self.b2(self.c2(y))
        return F.relu(y + (x if self.skip is None else self.skip(x)))


class BuildingNet(nn.Module):
    def __init__(self, width=32):
        super().__init__()
        self.register_buffer("mean", torch.tensor([0.45, 0.45, 0.42, 0.0]).view(1, 4, 1, 1))
        self.register_buffer("std", torch.tensor([0.22, 0.22, 0.22, 1.0]).view(1, 4, 1, 1))
        w = width
        self.stem = nn.Sequential(nn.Conv2d(4, w, 3, 1, 1, bias=False), nn.BatchNorm2d(w), nn.ReLU())
        self.body = nn.Sequential(
            Block(w, w, 2), Block(w, 2 * w, 2), Block(2 * w, 4 * w, 2), Block(4 * w, 8 * w, 2),
        )
        self.trunk = nn.Sequential(nn.Linear(8 * w, 256), nn.ReLU(), nn.Dropout(0.2))
        self.height = nn.Linear(256, 2)
        self.roof = nn.Linear(256, len(ROOF_SHAPES))
        self.material = nn.Linear(256, len(MATERIALS))

    def forward(self, x):
        x = (x - self.mean) / self.std
        x = self.body(self.stem(x))
        x = F.adaptive_avg_pool2d(x, 1).flatten(1)
        x = self.trunk(x)
        return self.height(x), self.roof(x), self.material(x)
