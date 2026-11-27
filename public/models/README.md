# Modelo propio de edificios

Aquí va el modelo que entrenan ustedes (ver `ml/README.md`):

- `building-net.onnx`
- `building-net.json`

Sin estos dos archivos, el interruptor "IA propia de edificios" avisa y la app sigue con los datos normales.

## Vegetación (árboles y césped 3D)
Los modelos van incrustados en `src/lib/city/vegetation-assets.ts` (base64, carga diferida), así no dependen de que
los `.glb` se publiquen como archivos estáticos. Árbol: 3 variantes en 2 niveles de detalle; césped: un parche.
Salen de modelos originales (Draco/WebP/spec-gloss) convertidos a glTF estándar y simplificados.
