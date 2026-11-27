"""FacadeNet: clasifica el material de una fachada desde una foto de calle (recorte 112×112).
Entrada [N,3,112,112] float32 en [0,1] (la normalización va dentro). Salida: logits [N,7] (MATERIALS)."""
import torch
import torch.nn as nn

from common import MATERIALS

INPUT_SIZE = 112


class FacadeNet(nn.Module):
    def __init__(self, pretrained=True):
        super().__init__()
        self.register_buffer("mean", torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1))
        if pretrained:
            # Fine-tuning de MobileNetV3-small (pesos ImageNet): con pocos datos etiquetados rinde mucho más.
            from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

            net = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.IMAGENET1K_V1)
            net.classifier[3] = nn.Linear(net.classifier[3].in_features, len(MATERIALS))
            self.net = net
        else:
            from model import Block  # CNN pequeña desde cero (pruebas / sin torchvision)

            w = 24
            self.net = nn.Sequential(
                nn.Conv2d(3, w, 3, 2, 1, bias=False), nn.BatchNorm2d(w), nn.ReLU(),
                Block(w, w, 2), Block(w, 2 * w, 2), Block(2 * w, 4 * w, 2),
                nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Dropout(0.2), nn.Linear(4 * w, len(MATERIALS)),
            )

    def forward(self, x):
        return self.net((x - self.mean) / self.std)
