/**
 * Elige, para cada edificio, la foto de calle que mejor mira a una de sus fachadas y calcula
 * qué región de la foto la contiene. Geometría pura (testeable sin navegador).
 *
 * Coordenadas locales: x = este, z = sur. Rumbo = grados horarios desde el norte.
 */
import type { BuildingFeature } from "./types";

export type LocalImage = { id: string; x: number; z: number; h: number; t: number };
export type Pick = {
  bi: number;
  imageId: string;
  /** región de la foto (0..1): u derecha, v abajo */
  crop: { u0: number; v0: number; u1: number; v1: number };
  dist: number;
};

export const FOV_DEG = 70; // campo de visión horizontal supuesto de una foto de calle
const MAX_DIST = 45;
const MIN_DIST = 4;
const MIN_EDGE = 4;
const MAX_ANGLE = 30; // la fachada debe caer cerca del centro de la imagen
const V0 = 0.3, V1 = 0.62; // banda vertical: fachada a altura de ojos, sin cielo ni suelo

const rad = (d: number) => (d * Math.PI) / 180;
const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180; // −180..180

function signedArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

export function selectViews(buildings: BuildingFeature[], images: LocalImage[], order: number[]): Pick[] {
  // Rejilla espacial de imágenes (celdas de 50 m)
  const cell = 50;
  const grid = new Map<string, LocalImage[]>();
  const key = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  for (const im of images) {
    const k = key(im.x, im.z);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(im);
  }
  const newest = images.reduce((m, i) => Math.max(m, i.t), 0);
  const tan = Math.tan(rad(FOV_DEG / 2));
  const picks: Pick[] = [];

  for (const bi of order) {
    const ring = buildings[bi].ring;
    const sgn = signedArea(ring) >= 0 ? 1 : -1;
    let best: { score: number; pick: Pick } | null = null;

    for (let i = 0; i < ring.length - 1 || i < 1; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const ex = q[0] - p[0], ez = q[1] - p[1];
      const len = Math.hypot(ex, ez);
      if (len < MIN_EDGE) continue;
      const nx = (ez / len) * sgn, nz = (-ex / len) * sgn; // normal exterior
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;

      const cx = Math.floor(mx / cell), cz = Math.floor(mz / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
          for (const im of grid.get(`${gx},${gz}`) ?? []) {
            const dx = mx - im.x, dz = mz - im.z;
            const dist = Math.hypot(dx, dz);
            if (dist < MIN_DIST || dist > MAX_DIST) continue;
            if (nx * -dx + nz * -dz <= 0) continue; // la fachada no mira a la cámara
            const bearing = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
            const delta = angDiff(bearing, im.h);
            if (Math.abs(delta) > MAX_ANGLE) continue;
            // Posición horizontal de la fachada en la foto y su ancho aparente
            const uc = 0.5 + Math.tan(rad(delta)) / (2 * tan);
            const w = Math.min(0.6, Math.max(0.12, (len / dist) / (2 * tan))) * 0.7;
            const u0 = Math.max(0, uc - w / 2), u1 = Math.min(1, uc + w / 2);
            if (u1 - u0 < w * 0.6) continue; // casi fuera de cuadro
            const ageYears = (newest - im.t) / (365.25 * 86400 * 1000);
            const score = dist + 0.6 * Math.abs(delta) + 2 * Math.max(0, ageYears) - len * 0.15;
            if (!best || score < best.score) {
              best = { score, pick: { bi, imageId: im.id, crop: { u0, v0: V0, u1, v1: V1 }, dist } };
            }
          }
        }
      }
    }
    if (best) picks.push(best.pick);
  }
  return picks;
}
