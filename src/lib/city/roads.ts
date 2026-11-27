/**
 * Vías: anchos por clase e índice espacial para consultas rápidas.
 * Fase 1: los árboles nunca quedan sobre una vía (se mueven a su orilla).
 */
import type { RoadFeature } from "./types";

/** Ancho total estimado de la calzada (m) según la clase de Overture. */
export function roadWidth(cls: string): number {
  switch (cls) {
    case "motorway": return 13;
    case "trunk": return 11;
    case "primary": return 10;
    case "secondary": return 8.5;
    case "tertiary": return 7.5;
    case "residential": case "living_street": case "unclassified": return 6;
    case "service": case "driveway": case "alley": case "parking_aisle": return 3.8;
    case "rail": return 5;
    case "pedestrian": return 4;
    case "track": return 3.2;
    case "footway": case "path": case "steps": case "cycleway": case "bridleway": case "sidewalk": case "crosswalk": return 2;
    default: return 5.5;
  }
}

type Seg = { ax: number; az: number; bx: number; bz: number; half: number };

export type RoadIndex = {
  /** Vía más cercana al punto dentro de `maxDist` (borde a borde NO: distancia al eje). */
  nearest(x: number, z: number, maxDist: number): { dist: number; px: number; pz: number; half: number; nx: number; nz: number } | null;
};

const CELL = 24;

export function buildRoadIndex(roads: RoadFeature[]): RoadIndex {
  const grid = new Map<string, Seg[]>();
  const key = (i: number, j: number) => `${i},${j}`;
  for (const r of roads) {
    const half = r.width / 2;
    for (let k = 0; k < r.pts.length - 1; k++) {
      const [ax, az] = r.pts[k], [bx, bz] = r.pts[k + 1];
      const seg: Seg = { ax, az, bx, bz, half };
      const pad = half + 12; // alcance máximo de consulta
      const i0 = Math.floor((Math.min(ax, bx) - pad) / CELL), i1 = Math.floor((Math.max(ax, bx) + pad) / CELL);
      const j0 = Math.floor((Math.min(az, bz) - pad) / CELL), j1 = Math.floor((Math.max(az, bz) + pad) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const kk = key(i, j);
        const a = grid.get(kk);
        if (a) a.push(seg); else grid.set(kk, [seg]);
      }
    }
  }
  return {
    nearest(x, z, maxDist) {
      const list = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!list) return null;
      let best: { dist: number; px: number; pz: number; half: number; nx: number; nz: number } | null = null;
      for (const s of list) {
        const dx = s.bx - s.ax, dz = s.bz - s.az;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2)) : 0;
        const px = s.ax + dx * t, pz = s.az + dz * t;
        const d = Math.hypot(x - px, z - pz);
        // se compara por "holgura": distancia al eje menos medio ancho
        if (d - s.half < maxDist && (!best || d - s.half < best.dist - best.half)) {
          const ll = Math.sqrt(l2) || 1; // normal de la vía (perpendicular al tramo)
          best = { dist: d, px, pz, half: s.half, nx: -dz / ll, nz: dx / ll };
        }
      }
      return best;
    },
  };
}

/**
 * Empuja un punto fuera de las vías: lo deja justo al borde (semiancho + margen), nunca encima.
 * Devuelve la nueva posición, o la misma si ya estaba libre.
 */
export function pushOffRoads(idx: RoadIndex, x: number, z: number, margin: number, iterations = 4): [number, number] {
  for (let it = 0; it < iterations; it++) {
    const n = idx.nearest(x, z, margin);
    if (!n) return [x, z];
    const need = n.half + margin;
    if (n.dist >= need) return [x, z];
    let dx = x - n.px, dz = z - n.pz;
    let len = Math.hypot(dx, dz);
    if (len < 1e-6) { dx = n.nx; dz = n.nz; len = 1; } // justo sobre el eje: sale por la perpendicular
    x = n.px + (dx / len) * (need + 0.05);
    z = n.pz + (dz / len) * (need + 0.05);
  }
  return [x, z];
}
