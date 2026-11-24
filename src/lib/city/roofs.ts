import * as THREE from "three";
import type { RGB, RoofShape } from "./roof-data";

export type OBB = { cx: number; cz: number; ux: number; uz: number; a: number; c: number; fill: number };

function area2(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}

function extents(ring: [number, number][], ux: number, uz: number) {
  const vx = -uz, vz = ux;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [x, z] of ring) {
    const u = x * ux + z * uz, v = x * vx + z * vz;
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  return { minU, maxU, minV, maxV };
}

function fromDir(ring: [number, number][], ux: number, uz: number, areaRing: number): OBB {
  let e = extents(ring, ux, uz);
  if (e.maxU - e.minU < e.maxV - e.minV) {
    const nux = -uz, nuz = ux; // gira 90° para que u sea el eje largo
    ux = nux; uz = nuz;
    e = extents(ring, ux, uz);
  }
  const vx = -uz, vz = ux;
  const mu = (e.minU + e.maxU) / 2, mv = (e.minV + e.maxV) / 2;
  const a = (e.maxU - e.minU) / 2, c = (e.maxV - e.minV) / 2;
  return { cx: ux * mu + vx * mv, cz: uz * mu + vz * mv, ux, uz, a, c, fill: areaRing / Math.max(1e-6, 4 * a * c) };
}

/** Rectángulo orientado de mínima área (o con rumbo dado, p. ej. `roof_direction`). */
export function computeOBB(ring: [number, number][], bearingDeg?: number): OBB | null {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  if (pts.length < 3) return null;
  const ar = area2(pts);
  if (ar < 1) return null;
  if (bearingDeg != null) {
    const t = (bearingDeg * Math.PI) / 180; // 0° = norte; en el plano XZ norte = −z
    return fromDir(pts, Math.sin(t), -Math.cos(t), ar);
  }
  let best: OBB | null = null, bestArea = Infinity;
  const step = Math.max(1, Math.floor(pts.length / 24));
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const dx = q[0] - p[0], dz = q[1] - p[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.5) continue;
    const e = extents(pts, dx / len, dz / len);
    const A = (e.maxU - e.minU) * (e.maxV - e.minV);
    if (A < bestArea) { bestArea = A; best = fromDir(pts, dx / len, dz / len, ar); }
  }
  return best;
}

export function isConvex(ring: [number, number][]): boolean {
  const n = ring.length;
  if (n < 4) return true;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], c = ring[(i + 2) % n];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}

type V3 = [number, number, number];

class TriBuilder {
  pos: number[] = [];
  idx: number[] = [];
  constructor(private pivot: V3) {}
  tri(a: V3, b: V3, c: V3) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const n: V3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const t: V3 = [(a[0] + b[0] + c[0]) / 3 - this.pivot[0], (a[1] + b[1] + c[1]) / 3 - this.pivot[1], (a[2] + b[2] + c[2]) / 3 - this.pivot[2]];
    if (n[0] * t[0] + n[1] * t[1] + n[2] * t[2] < 0) [b, c] = [c, b];
    const i = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c);
    this.idx.push(i, i + 1, i + 2);
  }
  quad(a: V3, b: V3, c: V3, d: V3) { this.tri(a, b, c); this.tri(a, c, d); }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

/** Techo a dos aguas / cuatro aguas / piramidal sobre el rectángulo orientado (y=0 = alero). */
export function ridgeRoof(shape: "gabled" | "hipped" | "pyramidal", o: OBB, rise: number, overhang: number): THREE.BufferGeometry {
  const A = o.a + overhang, C = o.c + overhang;
  const vx = -o.uz, vz = o.ux;
  const W = (u: number, v: number, y: number): V3 => [o.cx + u * o.ux + v * vx, y, o.cz + u * o.uz + v * vz];
  const tb = new TriBuilder([o.cx, rise * 0.3, o.cz]);
  const P0 = W(-A, -C, 0), P1 = W(A, -C, 0), P2 = W(A, C, 0), P3 = W(-A, C, 0);
  let rh = shape === "gabled" ? A : Math.max(0, A - C);
  if (shape === "pyramidal" || rh < 0.6) {
    const apex = W(0, 0, rise);
    tb.tri(P0, P1, apex); tb.tri(P1, P2, apex); tb.tri(P2, P3, apex); tb.tri(P3, P0, apex);
    return tb.build();
  }
  const R0 = W(-rh, 0, rise), R1 = W(rh, 0, rise);
  tb.quad(P0, P1, R1, R0);
  tb.quad(P2, P3, R0, R1);
  tb.tri(P3, P0, R0);
  tb.tri(P1, P2, R1);
  return tb.build();
}

/** Techo en abanico desde el centroide (huellas convexas no rectangulares y cúpulas). */
export function fanRoof(ring: [number, number][], rise: number, dome: boolean, overhang: number): THREE.BufferGeometry | null {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  const n = pts.length;
  if (n < 3) return null;
  let cx = 0, cz = 0;
  for (const p of pts) { cx += p[0]; cz += p[1]; }
  cx /= n; cz /= n;
  const levels: [number, number][] = dome ? [[0, 0], [0.4, 0.62], [0.72, 0.9]] : [[0, 0]];
  const tb = new TriBuilder([cx, rise * 0.3, cz]);
  const ringAt = (s: number, h: number): V3[] =>
    pts.map(([x, z]) => {
      let dx = x - cx, dz = z - cz;
      const len = Math.hypot(dx, dz) || 1;
      const ex = s === 0 ? overhang : 0;
      return [cx + dx * (1 - s) + (dx / len) * ex, h * rise, cz + dz * (1 - s) + (dz / len) * ex] as V3;
    });
  const rings = levels.map(([s, h]) => ringAt(s, h));
  const apex: V3 = [cx, rise, cz];
  for (let l = 0; l < rings.length - 1; l++) {
    for (let i = 0; i < n; i++) tb.quad(rings[l][i], rings[l][(i + 1) % n], rings[l + 1][(i + 1) % n], rings[l + 1][i]);
  }
  const top = rings[rings.length - 1];
  for (let i = 0; i < n; i++) tb.tri(top[i], top[(i + 1) % n], apex);
  return tb.build();
}

export type RoofSampler = (x: number, z: number) => RGB | null;

/** Muestreador de color de techo sobre la imagen satelital (cubre exactamente el extent). */
export function createRoofSampler(
  canvas: HTMLCanvasElement,
  extent: { minX: number; maxX: number; minZ: number; maxZ: number },
): RoofSampler | null {
  try {
    const scale = Math.min(1, 2048 / Math.max(canvas.width, canvas.height));
    const w = Math.max(16, Math.round(canvas.width * scale)), h = Math.max(16, Math.round(canvas.height * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const cx = c.getContext("2d", { willReadFrequently: true })!;
    cx.drawImage(canvas, 0, 0, w, h);
    const data = cx.getImageData(0, 0, w, h).data;
    const W = extent.maxX - extent.minX, D = extent.maxZ - extent.minZ;
    return (x, z) => {
      const px = Math.floor(((x - extent.minX) / W) * w), py = Math.floor(((z - extent.minZ) / D) * h);
      if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) return null;
      let r = 0, g = 0, b = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const i = ((py + dy) * w + (px + dx)) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2];
      }
      return [r / 2295, g / 2295, b / 2295];
    };
  } catch {
    return null; // canvas contaminado (CORS)
  }
}
