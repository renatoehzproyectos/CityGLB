# Modelo propio de edificios

Aquí va el modelo que entrenan ustedes (ver `ml/README.md`):

- `building-net.onnx`
- `building-net.json`

Sin estos dos archivos, el interruptor "IA propia de edificios" avisa y la app sigue con los datos normales.

## Vegetación (árboles y césped 3D)
- `tree.glb` — 3 variantes de árbol (alto normalizado = 1). Texturas de hoja en gris para teñir con el color real del satélite.
- `grass.glb` — parche de césped (ancho normalizado = 1).
Ambos salen de modelos originales (Draco/WebP/spec-gloss) convertidos a glTF estándar y simplificados.
