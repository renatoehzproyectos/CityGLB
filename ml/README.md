# Modelo propio de edificios (BuildingNet)

Red convolucional pequeña (~1 M parámetros) que, a partir de un parche de imagen aérea de
96 m × 96 m (1 m/px) y la huella del edificio, predice:

- **altura** (con incertidumbre: media y varianza de log-altura),
- **forma de techo** (flat, gabled, hipped, pyramidal, dome),
- **material de fachada** (brick, concrete, glass, stucco, stone, metal, wood).

Se entrena con las etiquetas reales de Overture (edificios que sí traen altura, niveles, forma de
techo o material). Los campos sin etiqueta se ignoran en la pérdida. En el navegador corre con
onnxruntime-web y solo rellena lo que los datos no traen.

## 1. Entorno

    cd ml
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt

## 2. Prueba de humo (2 minutos, no produce un modelo útil)

    python make_synthetic.py --out data_smoke/synth.npz --n 600
    python train.py --data data_smoke --epochs 2 --out /tmp/smoke.onnx

## 3. Dataset real

Mezcla varias ciudades distintas (estilos y alturas variadas) para que generalice:

    python build_dataset.py --out data/ciudad1.npz --bbox MIN_LON MIN_LAT MAX_LON MAX_LAT
    python build_dataset.py --out data/ciudad2.npz --bbox ...

Cada zona de ~3×3 km suele dar miles de ejemplos; apunta a decenas de miles en total.
**Licencias:** la imagen por defecto son teselas Esri World Imagery; revisa sus condiciones antes de
entrenar o distribuir un modelo. Con `--tiles-url` puedes usar imagen propia o abierta (NAIP,
ortofotos oficiales…). Las etiquetas de Overture traen sus propias licencias por fuente.

## 4. Entrenar y desplegar

Con GPU, 30 épocas sobre ~50 000 ejemplos tardan minutos:

    python train.py --data data --epochs 30 --out ../public/models/building-net.onnx

Genera `building-net.onnx` y `building-net.json` (clases + métricas de validación). Con ambos en
`public/models/`, el interruptor "IA propia de edificios" ya funciona. La validación es por bloques
espaciales (~500 m), así que las métricas no se inflan por vecindad.

## Notas de diseño

- Las clases viven en `ml/common.py` y `src/lib/city/ai-schema.ts`; deben coincidir (el visor lo
  comprueba y rechaza un modelo incompatible).
- Si cambias `INPUT_SIZE` o `WINDOW_M`, reentrena: el visor los lee del `.json`.
- Mejora típica: más ciudades, más épocas, y datos de zonas con alturas verificadas.

---

# Modelo de fachadas (FacadeNet) — fotos de calle

Clasifica el **material** de una fachada (brick, concrete, glass, stucco, stone, metal, wood) desde el
recorte de una foto de calle de Mapillary. Es un fine-tuning de MobileNetV3-small (pesos ImageNet),
porque hay pocos edificios con material etiquetado en Overture.

Flujo: `build_facade_dataset.py` (Overture + Mapillary) → `train_facade.py` → `facade-net.onnx` + `.json`.
`street.py` es un port exacto de `street-select.ts` / `street-color.ts`: la app y el entrenamiento
recortan igual (verificado: misma selección, mismo color, remuestreo a ≤1/255 de PIL).

    export MAPILLARY_TOKEN='MLY|...'
    python build_facade_dataset.py --bbox MIN_LON MIN_LAT MAX_LON MAX_LAT --count-only   # ¿hay datos?
    python build_facade_dataset.py --bbox ... --out data_facade/ciudad1.npz
    python train_facade.py --data data_facade --epochs 25 --out ../public/models/facade-net.onnx

El entrenamiento imprime la exactitud y la de "adivinar siempre la clase más común": si no la
supera, el modelo no aporta. Ojo con las licencias de las fotos (CC BY-SA, Mapillary).
