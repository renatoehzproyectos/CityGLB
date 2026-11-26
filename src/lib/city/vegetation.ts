/**
 * Vegetación a partir de lo que MUESTRA la imagen satelital (no de una densidad inventada):
 *  1. Máscara de copas: verde (ExG) y oscuro; fuera de edificios y agua.
 *  2. Un árbol por celda en el máximo local de "oscuridad verde"; la celda se ajusta para
 *     no pasar de MAX_TREES en bosques enormes.
 *  3. Árboles reales de Overture/OSM (puntos) tienen prioridad sobre los detectados.
 *  4. Color de cada copa = color real de la imagen en ese punto.
 * Es detección clásica (sin ML): se puede sustituir por un modelo entrenado después.
 */
import * as THREE from "three";
import type { LocalBox } from "./geo";
import type { RoofSampler } from "./roofs";
import type { CityData } from "./types";

export type Tree = {
  x: number; z: number;
  /** radio de copa en m */
  r: number;
  /** color real de la imagen (0..1) */
  color: [number, number, number];
  lum: number;
  /** densidad local de copa 0..1 */
  dens: number;
};

export const MAX_TREES = 14000;
const EXG_T = 0.1;

/** Detección pura sobre RGBA (testeable sin navegador). Devuelve píxeles y metros. */
export function detectCanopy(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  mPerPx: number,
  exclude: Uint8Array | null,
  maxTrees = MAX_TREES,
): { px: number; py: number; r: number; color: [number, number, number]; lum: number; dens: number }[] {
  const n = w * h;
  const mask = new Uint8Array(n);
  const dark = new Float32Array(n);
  let N = 0;
  for (let i = 0; i < n; i++) {
    if (exclude && exclude[i]) continue;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const s = r + g + b;
    if (s < 45) continue;
    const exg = (2 * g - r - b) / s;
    const lum = s / 765;
    if (exg > EXG_T && lum > 0.06 && lum < 0.36) {
      mask[i] = 1;
      dark[i] = 0.4 - lum + exg;
      N++;
    }
  }
  if (!N) return [];

  // Imágenes integrales: máscara y "oscuridad"
  const W1 = w + 1;
  const iM = new Uint32Array(W1 * (h + 1));
  const iD = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rm = 0, rd = 0;
    for (let x = 0; x < w; x++) {
      rm += mask[y * w + x];
      rd += dark[y * w + x];
      iM[(y + 1) * W1 + x + 1] = iM[y * W1 + x + 1] + rm;
      iD[(y + 1) * W1 + x + 1] = iD[y * W1 + x + 1] + rd;
    }
  }
  const box = (I: Uint32Array | Float64Array, x0: number, y0: number, x1: number, y1: number) => {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
    if (x1 <= x0 || y1 <= y0) return 0;
    return I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
  };

  const baseCell = Math.max(3, Math.round(6 / mPerPx));
  const cell = Math.max(baseCell, Math.ceil(Math.sqrt(N / maxTrees)));
  const sR = Math.max(1, Math.round(1.5 / mPerPx)); // suavizado del score
  const dR = Math.max(4, Math.round(12 / mPerPx)); // ventana de densidad
  const out: { px: number; py: number; r: number; color: [number, number, number]; lum: number; dens: number }[] = [];

  for (let cy = 0; cy < h; cy += cell) {
    for (let cx = 0; cx < w; cx += cell) {
      const x1 = Math.min(w, cx + cell), y1 = Math.min(h, cy + cell);
      const cnt = box(iM, cx, cy, x1, y1);
      if (cnt < 0.35 * (x1 - cx) * (y1 - cy)) continue; // la celda no es mayormente copa
      let best = -1, bx = 0, by = 0;
      for (let y = cy; y < y1; y++) {
        for (let x = cx; x < x1; x++) {
          if (!mask[y * w + x]) continue;
          const sc = box(iD, x - sR, y - sR, x + sR + 1, y + sR + 1);
          if (sc > best) { best = sc; bx = x; by = y; }
        }
      }
      if (best < 0) continue;
      let r = 0, g = 0, b = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(w - 1, Math.max(0, bx + dx)), yy = Math.min(h - 1, Math.max(0, by + dy));
        const i = (yy * w + xx) * 4;
        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; k++;
      }
      const wA = (Math.min(w, bx + dR + 1) - Math.max(0, bx - dR)) * (Math.min(h, by + dR + 1) - Math.max(0, by - dR));
      const dens = wA > 0 ? box(iM, bx - dR, by - dR, bx + dR + 1, by + dR + 1) / wA : 0;
      out.push({
        px: bx, py: by,
        r: Math.min(6.5, Math.max(1.5, cell * mPerPx * 0.62)),
        color: [r / (k * 255), g / (k * 255), b / (k * 255)],
        lum: (r + g + b) / (k * 765),
        dens,
      });
    }
  }
  return out;
}

/** Envoltorio de navegador: imagen satelital + exclusión de edificios/agua + árboles de los datos. */
export function detectTrees(sat: HTMLCanvasElement, data: CityData, sampler: RoofSampler | null): Tree[] {
  const ext = data.extent;
  const W = ext.maxX - ext.minX, D = ext.maxZ - ext.minZ;
  const scale = Math.min(1, 2048 / Math.max(sat.width, sat.height));
  const w = Math.max(16, Math.round(sat.width * scale)), h = Math.max(16, Math.round(sat.height * scale));
  const mPerPx = W / w;

  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(sat, 0, 0, w, h);
  let rgba: Uint8ClampedArray;
  try { rgba = ctx.getImageData(0, 0, w, h).data; } catch { return []; }

  // Exclusión: edificios (con un margen de ~3 m por sombras/muros) y agua
  const ex = document.createElement("canvas");
  ex.width = w; ex.height = h;
  const ectx = ex.getContext("2d", { willReadFrequently: true })!;
  ectx.fillStyle = "#000"; ectx.fillRect(0, 0, w, h);
  ectx.fillStyle = "#fff"; ectx.strokeStyle = "#fff"; ectx.lineJoin = "round";
  const px = (x: number) => ((x - ext.minX) / W) * w, pz = (z: number) => ((z - ext.minZ) / D) * h;
  const draw = (ring: [number, number][], margin: number) => {
    ectx.beginPath();
    ring.forEach(([x, z], i) => (i ? ectx.lineTo(px(x), pz(z)) : ectx.moveTo(px(x), pz(z))));
    ectx.closePath();
    ectx.lineWidth = margin / mPerPx;
    if (margin > 0) ectx.stroke();
    ectx.fill();
  };
  for (const b of data.buildings) draw(b.ring, 3);
  for (const wf of data.water ?? []) draw(wf.rings[0], 0);
  const em = ectx.getImageData(0, 0, w, h).data;
  const exclude = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) exclude[i] = em[i * 4] > 127 ? 1 : 0;

  const found = detectCanopy(rgba, w, h, mPerPx, exclude);
  const trees: Tree[] = [];

  // Árboles reales (puntos) primero
  const hash = new Map<string, true>();
  const key = (x: number, z: number) => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
  for (const [x, z] of data.osmTrees ?? []) {
    if (x < ext.minX || x > ext.maxX || z < ext.minZ || z > ext.maxZ) continue;
    const ix = Math.min(w - 1, Math.max(0, Math.floor(px(x)))), iz = Math.min(h - 1, Math.max(0, Math.floor(pz(z))));
    if (exclude[iz * w + ix]) continue;
    const col = sampler?.(x, z) ?? [0.2, 0.36, 0.16];
    trees.push({ x, z, r: 2.6, color: col, lum: (col[0] + col[1] + col[2]) / 3, dens: 0.2 });
    hash.set(key(x, z), true);
  }
  for (const f of found) {
    const x = ext.minX + ((f.px + 0.5) / w) * W, z = ext.minZ + ((f.py + 0.5) / h) * D;
    let near = false;
    for (let dx = -1; dx <= 1 && !near; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (hash.has(key(x + dx * 4, z + dz * 4))) { near = true; break; }
    }
    if (!near) trees.push({ x, z, r: f.r, color: f.color, lum: f.lum, dens: f.dens });
  }
  return trees;
}

const sm = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hashN = (x: number, z: number) => Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;

/**
 * Malla fusionada de árboles. El DSM de 30 m ya incluye la altura del dosel, así que en zonas
 * densas la base se hunde proporcionalmente para que las copas no queden flotando.
 */
export function buildTreesMesh(trees: Tree[], groundAt: ((x: number, z: number) => number) | null): THREE.Mesh | null {
  if (!trees.length) return null;
  const ico = new THREE.IcosahedronGeometry(1, 0).getAttribute("position");
  const cone = new THREE.ConeGeometry(1, 1, 6, 1).translate(0, 0.5, 0).toNonIndexed().getAttribute("position");
  const trunk = new THREE.CylinderGeometry(0.7, 1, 1, 5, 1, true).translate(0, 0.5, 0).toNonIndexed().getAttribute("position");

  const pos: number[] = [];
  const col: number[] = [];
  const push = (src: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, sx: number, sy: number, sz: number, tx: number, ty: number, tz: number, c: [number, number, number]) => {
    for (let i = 0; i < src.count; i++) {
      pos.push(src.getX(i) * sx + tx, src.getY(i) * sy + ty, src.getZ(i) * sz + tz);
      col.push(c[0], c[1], c[2]);
    }
  };
  const TRUNK: [number, number, number] = [0.28, 0.2, 0.14];

  for (const t of trees) {
    const hgt = Math.min(16, Math.max(3, 3 + 1.7 * t.r));
    const g = groundAt ? groundAt(t.x, t.z) : 0;
    const base = g - (groundAt ? hgt * 0.8 * sm(0.35, 0.85, t.dens) : 0);
    const v = 0.9 + hashN(t.x, t.z) * 0.25;
    const c: [number, number, number] = [Math.min(1, t.color[0] * 1.2 * v), Math.min(1, t.color[1] * 1.3 * v), Math.min(1, t.color[2] * 1.15 * v)];
    if (t.lum < 0.2) {
      // conífera / sombra densa
      push(trunk, t.r * 0.08, hgt * 0.2, t.r * 0.08, t.x, base, t.z, TRUNK);
      push(cone, t.r * 0.85, hgt * 0.85, t.r * 0.85, t.x, base + hgt * 0.15, t.z, c);
    } else {
      push(trunk, t.r * 0.07, hgt * 0.5, t.r * 0.07, t.x, base, t.z, TRUNK);
      push(ico, t.r, hgt * 0.38, t.r, t.x, base + hgt * 0.62, t.z, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true, side: THREE.DoubleSide }),
  );
  mesh.name = "trees";
  mesh.castShadow = true;
  return mesh;
}
