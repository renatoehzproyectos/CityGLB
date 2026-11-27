/**
 * Modelo propio de fachadas (ONNX, entrenado con ml/train_facade.py) en el navegador.
 * Entrada: recorte 112×112 de una foto de calle, [N,3,S,S] en 0..1. Salida: logits de material.
 */
import { FACADE_MATERIALS } from "./ai-schema";

const MODEL_URL = "/models/facade-net.onnx";
const META_URL = "/models/facade-net.json";

type Meta = { version: number; input_size: number; materials: string[] };
type Loaded = { ort: typeof import("onnxruntime-web"); session: import("onnxruntime-web").InferenceSession; size: number };
let loading: Promise<Loaded | null> | null = null;

/** null si el modelo no está desplegado (la app sigue solo con el color). */
export function loadFacadeNet(): Promise<Loaded | null> {
  loading ??= (async () => {
    try {
      const mres = await fetch(META_URL, { cache: "no-cache" });
      if (!mres.ok) return null;
      let meta: Meta;
      try {
        meta = (await mres.json()) as Meta;
      } catch {
        return null; // 404 con fallback SPA devuelve HTML
      }
      if (meta.materials.length !== FACADE_MATERIALS.length || meta.materials.some((m, i) => m !== FACADE_MATERIALS[i])) {
        console.warn("[facade-net] las clases del modelo no coinciden con ai-schema.ts");
        return null;
      }
      const ort = await import("onnxruntime-web");
      const session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"] });
      return { ort, session, size: meta.input_size };
    } catch (e) {
      console.warn("[facade-net] no se pudo cargar el modelo", e);
      return null;
    }
  })();
  return loading;
}

/**
 * Recorte + remuestreo bilineal a S×S (RGB). Imita PIL `Image.resize(..., BILINEAR, box=...)`
 * (dos pasadas, soporte ampliado al reducir) para que la app vea lo mismo que el entrenamiento.
 */
export function resizeCropRGB(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  box: [number, number, number, number],
  S: number,
): Uint8ClampedArray {
  const [bx0, by0, bx1, by1] = box;
  const coeffs = (n: number, b0: number, b1: number, size: number) => {
    const scale = (b1 - b0) / S;
    const fs = Math.max(scale, 1);
    const support = fs; // bilineal: soporte 1 × filterscale
    const out: { min: number; w: number[] }[] = [];
    for (let o = 0; o < S; o++) {
      const center = (o + 0.5) * scale + b0;
      const min = Math.max(0, Math.floor(center - support + 0.5));
      const max = Math.min(size, Math.ceil(center + support + 0.5));
      const ws: number[] = [];
      let sum = 0;
      for (let k = min; k < max; k++) {
        const x = (k - center + 0.5) / fs;
        const wk = Math.max(0, 1 - Math.abs(x));
        ws.push(wk);
        sum += wk;
      }
      out.push({ min, w: sum ? ws.map((v) => v / sum) : [1] });
    }
    return out;
  };
  const cx = coeffs(S, bx0, bx1, w);
  const cy = coeffs(S, by0, by1, h);
  // filas de origen necesarias
  const yMin = Math.min(...cy.map((c) => c.min));
  const yMax = Math.max(...cy.map((c) => c.min + c.w.length));
  const rows = yMax - yMin;
  const tmp = new Float32Array(rows * S * 3);
  for (let r = 0; r < rows; r++) {
    const y = yMin + r;
    for (let ox = 0; ox < S; ox++) {
      const c = cx[ox];
      let a = 0, g = 0, b = 0;
      for (let k = 0; k < c.w.length; k++) {
        const i = (y * w + c.min + k) * 4;
        a += rgba[i] * c.w[k];
        g += rgba[i + 1] * c.w[k];
        b += rgba[i + 2] * c.w[k];
      }
      const t = (r * S + ox) * 3;
      tmp[t] = Math.min(255, Math.max(0, Math.round(a))); // PIL redondea entre pasadas
      tmp[t + 1] = Math.min(255, Math.max(0, Math.round(g)));
      tmp[t + 2] = Math.min(255, Math.max(0, Math.round(b)));
    }
  }
  const out = new Uint8ClampedArray(S * S * 3);
  for (let oy = 0; oy < S; oy++) {
    const c = cy[oy];
    for (let ox = 0; ox < S; ox++) {
      let a = 0, g = 0, b = 0;
      for (let k = 0; k < c.w.length; k++) {
        const t = ((c.min + k - yMin) * S + ox) * 3;
        a += tmp[t] * c.w[k];
        g += tmp[t + 1] * c.w[k];
        b += tmp[t + 2] * c.w[k];
      }
      const o = (oy * S + ox) * 3;
      out[o] = Math.round(a);
      out[o + 1] = Math.round(g);
      out[o + 2] = Math.round(b);
    }
  }
  return out;
}

/** RGB S×S (entrelazado) → bloque NCHW float 0..1 dentro de `dst` en la posición n. */
export function writeTensor(rgb: Uint8ClampedArray, S: number, dst: Float32Array, n: number): void {
  const plane = S * S;
  const base = n * 3 * plane;
  for (let i = 0; i < plane; i++) {
    dst[base + i] = rgb[i * 3] / 255;
    dst[base + plane + i] = rgb[i * 3 + 1] / 255;
    dst[base + 2 * plane + i] = rgb[i * 3 + 2] / 255;
  }
}

export type MaterialPrediction = { cls: (typeof FACADE_MATERIALS)[number]; p: number };

export async function predictFacadeMaterials(
  net: Loaded,
  input: Float32Array,
  count: number,
): Promise<MaterialPrediction[]> {
  const S = net.size;
  const t = new net.ort.Tensor("float32", input, [count, 3, S, S]);
  const out = await net.session.run({ input: t });
  t.dispose();
  const logits = out.material.data as Float32Array;
  const K = FACADE_MATERIALS.length;
  const res: MaterialPrediction[] = [];
  for (let n = 0; n < count; n++) {
    let max = -Infinity;
    for (let k = 0; k < K; k++) max = Math.max(max, logits[n * K + k]);
    const e = Array.from({ length: K }, (_, k) => Math.exp(logits[n * K + k] - max));
    const s = e.reduce((a, b) => a + b, 0);
    const p = e.map((v) => v / s);
    const bi = p.indexOf(Math.max(...p));
    res.push({ cls: FACADE_MATERIALS[bi], p: p[bi] });
  }
  return res;
}
