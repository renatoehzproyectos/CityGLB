/**
 * Fase 2 — Aplanado de terreno urbano.
 *
 * El DEM (Copernicus GLO-30) es un DSM: incluye edificios y copas, y a 30 m de resolución no puede
 * representar calles ni parcelas. Resultado: barrios enteros parecen montañas con la foto pegada encima.
 * Aquí se corrige sobre la propia malla de alturas (así terreno, edificios, árboles y vehículo la usan igual):
 *   1. Se densifica la malla (≈8 m) para poder representar calles y parcelas.
 *   2. Máscara "debería ser plano": calzadas (sin puentes) + huellas de edificio con margen, cerrando los huecos
 *      entre ellos (manzanas/parcelas).
 *   3. En esa máscara la altura pasa a una estimación de suelo: mínimo local (quita el bulto de edificios y copas)
 *      y suavizado fuerte (conserva la pendiente general del cerro). Transición con borde difuso.
 *   4. Cada edificio queda sobre una plataforma plana propia (nivel medio bajo su huella).
 * No muta la malla original (está en caché): devuelve una nueva.
 */
import type { HeightGrid } from "./elevation";
import type { CityData } from "./types";

const TARGET_SPACING_M = 3; // para que una calle de 6 m ocupe varias celdas
const MAX_DIM = 448; // tope de la malla densificada (≈200k vértices)


function lowerBound(a: Float32Array, v: number): number {
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid + 1] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function bilinear(g: HeightGrid, x: number, zN: number): number {
  const { width, height, data, xs, zs } = g;
  const i = lowerBound(xs, x), j = lowerBound(zs, zN);
  const i1 = Math.min(i + 1, width - 1), j1 = Math.min(j + 1, height - 1);
  const tx = xs[i1] === xs[i] ? 0 : Math.min(1, Math.max(0, (x - xs[i]) / (xs[i1] - xs[i])));
  const tz = zs[j1] === zs[j] ? 0 : Math.min(1, Math.max(0, (zN - zs[j]) / (zs[j1] - zs[j])));
  const a = data[j * width + i] * (1 - tx) + data[j * width + i1] * tx;
  const b = data[j1 * width + i] * (1 - tx) + data[j1 * width + i1] * tx;
  return a * (1 - tz) + b * tz;
}

function densify(g: HeightGrid): HeightGrid {
  const spX = (g.xs[g.width - 1] - g.xs[0]) / Math.max(1, g.width - 1);
  const spZ = (g.zs[g.height - 1] - g.zs[0]) / Math.max(1, g.height - 1);
  const sp = Math.max(Math.abs(spX), Math.abs(spZ));
  let f = Math.max(1, Math.ceil(sp / TARGET_SPACING_M));
  f = Math.min(f, Math.floor((MAX_DIM - 1) / Math.max(1, Math.max(g.width, g.height) - 1)) || 1);
  if (f <= 1) return { ...g, data: Float32Array.from(g.data) };
  const cols = (g.width - 1) * f + 1, rows = (g.height - 1) * f + 1;
  const xs = new Float32Array(cols), zs = new Float32Array(rows), data = new Float32Array(cols * rows);
  for (let i = 0; i < cols; i++) {
    const k = Math.min(g.width - 2, Math.floor(i / f)), t = (i - k * f) / f;
    xs[i] = g.xs[k] + (g.xs[k + 1] - g.xs[k]) * t;
  }
  for (let j = 0; j < rows; j++) {
    const k = Math.min(g.height - 2, Math.floor(j / f)), t = (j - k * f) / f;
    zs[j] = g.zs[k] + (g.zs[k + 1] - g.zs[k]) * t;
  }
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const h = bilinear(g, xs[i], zs[j]);
    data[j * cols + i] = h;
    if (h < minH) minH = h; if (h > maxH) maxH = h;
  }
  return { ...g, width: cols, height: rows, data, xs, zs, minH, maxH };
}

/** Filtro separable de caja (media) con borde replicado. */
function blur(src: Float32Array, w: number, h: number, r: number, passes = 1): Float32Array {
  if (r < 1) return Float32Array.from(src);
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += a[y * w + Math.min(w - 1, Math.max(0, x + k))];
        b[y * w + x] = s / (2 * r + 1);
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += b[Math.min(h - 1, Math.max(0, y + k)) * w + x];
        a[y * w + x] = s / (2 * r + 1);
      }
    }
  }
  return a;
}

/** Mínimo (erosión) o máximo (dilatación) separable con ventana cuadrada. */
function morph(src: Float32Array, w: number, h: number, r: number, mode: "min" | "max"): Float32Array {
  if (r < 1) return Float32Array.from(src);
  const pick = mode === "min" ? Math.min : Math.max;
  const init = mode === "min" ? Infinity : -Infinity;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = init;
    for (let k = -r; k <= r; k++) v = pick(v, src[y * w + Math.min(w - 1, Math.max(0, x + k))]);
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = init;
    for (let k = -r; k <= r; k++) v = pick(v, tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]);
    out[y * w + x] = v;
  }
  return out;
}

function pointInRing(x: number, z: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distToRing(x: number, z: number, ring: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j], [bx, bz] = ring[i];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return best;
}

export type FlattenStats = { cells: number; flatCells: number; pads: number; roadsLeveled: number; spacing: number };

export type RoadProfile = { pts: [number, number][]; y: number[]; width: number; cls: string };

export function flattenTerrain(src: HeightGrid, data: CityData): { grid: HeightGrid; stats: FlattenStats; profiles: RoadProfile[] } {
  const g = densify(src);
  const { width: w, height: h, xs, zs } = g;
  const n = w * h;
  const sp = Math.max(1, Math.abs((xs[w - 1] - xs[0]) / (w - 1)));
  const fx = (i: number) => xs[i];
  const fz = (j: number) => -zs[j]; // z "feature" (norte negativo)
  // celdas candidatas por x (ascendente) y z feature (descendente si zs asciende): se recorre todo el rango
  const cellsIn = (x0: number, x1: number, z0: number, z1: number, cb: (i: number, j: number, x: number, z: number) => void) => {
    const i0 = Math.max(0, lowerBound(xs, x0) - 1), i1 = Math.min(w - 1, lowerBound(xs, x1) + 1);
    const jA = lowerBound(zs, -z1) - 1, jB = lowerBound(zs, -z0) + 1;
    const j0 = Math.max(0, Math.min(jA, jB)), j1 = Math.min(h - 1, Math.max(jA, jB));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cb(i, j, fx(i), fz(j));
  };

  // 1) Máscara de "debería ser plano"
  let mask: Float32Array = new Float32Array(n);
  for (const b of data.buildings) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of b.ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    cellsIn(x0 - 4, x1 + 4, z0 - 4, z1 + 4, (i, j, x, z) => {
      if (pointInRing(x, z, b.ring) || distToRing(x, z, b.ring) < 4) mask[j * w + i] = 1;
    });
  }
  // cierre morfológico: une calles y edificios cercanos en bloques/parcelas continuos
  const rc = Math.max(1, Math.round(10 / sp));
  mask = morph(morph(mask, w, h, rc, "max"), w, h, rc, "min");
  let flatCells = 0;
  for (let i = 0; i < n; i++) if (mask[i] > 0.5) flatCells++;

  // 2) Estimación de suelo: mínimo local pequeño + suavizado fuerte
  const E = morph(g.data, w, h, 1, "min");
  const S = blur(E, w, h, Math.max(2, Math.round(18 / sp)), 2);
  const wt = blur(mask, w, h, Math.max(1, Math.round(10 / sp)), 1); // borde difuso
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, wt[i] * 1.4);
    const s = t * t * (3 - 2 * t);
    out[i] = g.data[i] * (1 - s) + S[i] * s;
  }

  // 3) Plataforma plana bajo cada edificio
  let pads = 0;
  for (const b of data.buildings) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of b.ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const cells: number[] = [], inner: number[] = [];
    cellsIn(x0 - 2, x1 + 2, z0 - 2, z1 + 2, (i, j, x, z) => {
      const ins = pointInRing(x, z, b.ring);
      if (ins) inner.push(j * w + i);
      if (ins || distToRing(x, z, b.ring) < 2) cells.push(j * w + i);
    });
    if (!cells.length) continue;
    const use = inner.length ? inner : cells;
    let level = 0;
    for (const c of use) level += out[c];
    level /= use.length;
    for (const c of cells) out[c] = out[c] * 0.1 + level * 0.9;
    pads++;
  }

  // 4) Perfil de cada calzada + "cono de influencia" sobre la malla. La calzada en sí se dibuja aparte como una CINTA
  //    plana (ribbons.ts) a la altura del perfil: así queda exactamente nivelada de lado a lado aunque la malla del
  //    terreno sea gruesa. Aquí solo se baja/sube la malla para que no tape la cinta ni deje huecos:
  //    - dentro de (semiancho + ~1.5 celdas) la malla nunca queda por encima de 0.25 m bajo la cinta (corte);
  //    - fuera, la malla no puede subir más de 0.9 m por metro de distancia sobre ese nivel (talud de corte).
  const profiles: RoadProfile[] = [];
  const G = blur(g.data, w, h, 1, 1); // terreno casi crudo (sin erosión) para leer el perfil
  const gG: HeightGrid = { ...g, data: G };
  const hAt = (x: number, z: number) => bilinear(gG, x, -z);
  let totalLen = 0;
  for (const r of data.roads ?? []) {
    if (r.bridge || r.tunnel || r.width < 3 || r.cls === "rail") continue;
    for (let k = 0; k < r.pts.length - 1; k++) totalLen += Math.hypot(r.pts[k + 1][0] - r.pts[k][0], r.pts[k + 1][1] - r.pts[k][1]);
  }
  const baseStep = Math.max(sp, 2.5, totalLen / 60000); // tope ≈ 60k muestras de calzada
  for (const r of data.roads ?? []) {
    if (r.bridge || r.tunnel || r.width < 3 || r.cls === "rail") continue; // puentes/túneles: fases 3-4
    const half = r.width / 2;
    const S: [number, number][] = [];
    let next = 0;
    for (let k = 0; k < r.pts.length - 1; k++) {
      const [ax, az] = r.pts[k], [bx, bz] = r.pts[k + 1];
      const L = Math.hypot(bx - ax, bz - az);
      while (next < L) { S.push([ax + ((bx - ax) * next) / L, az + ((bz - az) * next) / L]); next += baseStep; }
      next -= L;
    }
    S.push(r.pts[r.pts.length - 1]);
    if (S.length < 2) continue;
    // perfil: altura en el eje, suavizada a lo largo de la vía (quita ruido de edificios/copas)
    const p = S.map(([x, z]) => hAt(x, z));
    const win = Math.max(2, Math.round(24 / baseStep));
    for (let pass = 0; pass < 3; pass++) {
      const q = p.slice();
      for (let i = 0; i < p.length; i++) {
        let sum = 0, c = 0;
        for (let k = Math.max(0, i - win); k <= Math.min(p.length - 1, i + win); k++) { sum += q[k]; c++; }
        p[i] = sum / c;
      }
    }
    profiles.push({ pts: S, y: p, width: r.width, cls: r.cls });
    // los triángulos que cubren el borde de la cinta tienen vértices hasta ~1.41 celdas lejos: todos deben quedar bajo ella
    const hard = half + 1.45 * sp + 0.3;
    const reach = hard + 30;
    for (let k = 0; k < S.length; k++) {
      const [x, z] = S[k];
      const lvl = p[k] - 0.25;
      cellsIn(x - reach, x + reach, z - reach, z + reach, (i, j, cx, cz) => {
        const d = Math.hypot(cx - x, cz - z);
        if (d > reach) return;
        const slack = d <= hard ? 0 : 0.9 * (d - hard);
        const c = j * w + i;
        const v = out[c];
        // SOLO se baja (corte); el relleno no se levanta: los faldones de la cinta bajan hasta el suelo real
        if (v > lvl + slack) out[c] = lvl + slack;
      });
    }
  }

  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < n; i++) { if (out[i] < minH) minH = out[i]; if (out[i] > maxH) maxH = out[i]; }
  return { grid: { ...g, data: out, minH, maxH }, stats: { cells: n, flatCells, pads, roadsLeveled: profiles.length, spacing: sp }, profiles };
}
