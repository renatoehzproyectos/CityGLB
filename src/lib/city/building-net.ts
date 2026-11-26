/**
 * Inferencia en el navegador del modelo propio (ONNX, entrenado con ml/train.py).
 * Entrada: parche 96×96 (96 m de terreno) por edificio, canales R,G,B (0..1) + máscara de huella.
 * Salida: altura (media y log-varianza de log(m)), forma de techo y material de fachada.
 */
import { FACADE_MATERIALS, ROOF_SHAPES } from "./ai-schema";
import { ringArea } from "./geo";
import type { BuildingFeature, CityData } from "./types";

export const MODEL_URL = "/models/building-net.onnx";
const META_URL = "/models/building-net.json";

type Meta = { version: number; input_size: number; window_m: number; roof_shapes: string[]; materials: string[] };

export type Prediction = {
  /** Altura estimada (m) y su incertidumbre relativa (sigma de log-altura). */
  height: number;
  sigma: number;
  roof: { cls: (typeof ROOF_SHAPES)[number]; p: number };
  material: { cls: (typeof FACADE_MATERIALS)[number]; p: number };
};

type Ort = typeof import("onnxruntime-web");
type Loaded = { ort: Ort; session: import("onnxruntime-web").InferenceSession; meta: Meta };
let loading: Promise<Loaded | null> | null = null;

/** null si el modelo no está desplegado (o no es compatible). Se carga una sola vez. */
export function loadBuildingNet(): Promise<Loaded | null> {
  loading ??= (async () => {
    try {
      const mres = await fetch(META_URL, { cache: "no-cache" });
      if (!mres.ok) return null;
      let meta: Meta;
      try {
        meta = (await mres.json()) as Meta; // un 404 con fallback SPA devuelve HTML → falla aquí
      } catch {
        return null;
      }
      const same = (a: string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
      if (!same(meta.roof_shapes, ROOF_SHAPES) || !same(meta.materials, FACADE_MATERIALS)) {
        console.warn("[building-net] las clases del modelo no coinciden con ai-schema.ts; reentrena o actualiza.");
        return null;
      }
      const ort = await import("onnxruntime-web");
      const session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"] });
      return { ort, session, meta };
    } catch (e) {
      console.warn("[building-net] no se pudo cargar el modelo", e);
      return null;
    }
  })();
  return loading;
}

const softmax = (v: Float32Array, off: number, n: number): number[] => {
  let max = -Infinity;
  for (let i = 0; i < n; i++) max = Math.max(max, v[off + i]);
  const e = Array.from({ length: n }, (_, i) => Math.exp(v[off + i] - max));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
};

/** Arma el tensor [n,4,S,S] de un grupo de edificios a partir de la imagen satelital. */
function buildBatch(sat: HTMLCanvasElement, data: CityData, feats: BuildingFeature[], S: number, windowM: number): Float32Array {
  const ext = data.extent;
  const W = ext.maxX - ext.minX;
  const D = ext.maxZ - ext.minZ;
  const plane = S * S;
  const out = new Float32Array(feats.length * 4 * plane);
  const img = document.createElement("canvas");
  img.width = img.height = S;
  const ictx = img.getContext("2d", { willReadFrequently: true })!;
  const msk = document.createElement("canvas");
  msk.width = msk.height = S;
  const mctx = msk.getContext("2d", { willReadFrequently: true })!;
  const sx = sat.width / W; // px de imagen por metro
  const sy = sat.height / D;

  feats.forEach((b, n) => {
    let cx = 0, cz = 0;
    for (const [x, z] of b.ring) { cx += x; cz += z; }
    cx /= b.ring.length; cz /= b.ring.length;
    const x0 = cx - windowM / 2;
    const z0 = cz - windowM / 2;

    ictx.fillStyle = "#000";
    ictx.fillRect(0, 0, S, S);
    ictx.drawImage(sat, (x0 - ext.minX) * sx, (z0 - ext.minZ) * sy, windowM * sx, windowM * sy, 0, 0, S, S);
    mctx.fillStyle = "#000";
    mctx.fillRect(0, 0, S, S);
    mctx.fillStyle = "#fff";
    mctx.beginPath();
    b.ring.forEach(([x, z], i) => {
      const px = ((x - x0) / windowM) * S;
      const py = ((z - z0) / windowM) * S;
      if (i === 0) mctx.moveTo(px, py);
      else mctx.lineTo(px, py);
    });
    mctx.closePath();
    mctx.fill();

    const rgba = ictx.getImageData(0, 0, S, S).data;
    const m = mctx.getImageData(0, 0, S, S).data;
    const base = n * 4 * plane;
    for (let i = 0; i < plane; i++) {
      out[base + i] = rgba[i * 4] / 255;
      out[base + plane + i] = rgba[i * 4 + 1] / 255;
      out[base + 2 * plane + i] = rgba[i * 4 + 2] / 255;
      out[base + 3 * plane + i] = m[i * 4] > 127 ? 1 : 0;
    }
  });
  return out;
}

/** Predice para una lista de edificios. Devuelve null si el modelo no está disponible. */
export async function predictBuildings(
  sat: HTMLCanvasElement,
  data: CityData,
  indices: number[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, Prediction> | null> {
  const loaded = await loadBuildingNet();
  if (!loaded) return null;
  const { ort, session, meta } = loaded;
  const S = meta.input_size;
  const result = new Map<number, Prediction>();
  const BATCH = 32;

  for (let i = 0; i < indices.length; i += BATCH) {
    const slice = indices.slice(i, i + BATCH);
    const feats = slice.map((k) => data.buildings[k]);
    const input = new ort.Tensor("float32", buildBatch(sat, data, feats, S, meta.window_m), [slice.length, 4, S, S]);
    const out = await session.run({ input });
    input.dispose();
    const h = out.height.data as Float32Array;
    const r = out.roof.data as Float32Array;
    const m = out.material.data as Float32Array;
    slice.forEach((k, n) => {
      const logvar = Math.min(2, Math.max(-6, h[n * 2 + 1]));
      const pr = softmax(r, n * ROOF_SHAPES.length, ROOF_SHAPES.length);
      const pm = softmax(m, n * FACADE_MATERIALS.length, FACADE_MATERIALS.length);
      const ri = pr.indexOf(Math.max(...pr));
      const mi = pm.indexOf(Math.max(...pm));
      result.set(k, {
        height: Math.exp(h[n * 2]),
        sigma: Math.exp(0.5 * logvar),
        roof: { cls: ROOF_SHAPES[ri], p: pr[ri] },
        material: { cls: FACADE_MATERIALS[mi], p: pm[mi] },
      });
    });
    onProgress?.(Math.min(indices.length, i + BATCH), indices.length);
    await new Promise((r2) => setTimeout(r2, 0)); // cede el hilo: la UI no se congela
  }
  return result;
}

/** Edificios candidatos: los de mayor huella primero. */
export function pickCandidates(data: CityData, minArea: number, max: number): number[] {
  return data.buildings
    .map((b, i) => ({ i, a: ringArea(b.ring) }))
    .filter((x) => x.a >= minArea)
    .sort((p, q) => q.a - p.a)
    .slice(0, max)
    .map((x) => x.i);
}
