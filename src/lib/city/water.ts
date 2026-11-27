/**
 * Agua real: polígonos de Overture (base/water) → malla plana por cuerpo de agua.
 *  · Lagos, estanques, embalses y océano: un solo nivel por polígono.
 *  · Ríos y canales: se parten en celdas de 250 m y cada una toma su nivel (siguen la pendiente).
 *  · El nivel sale del terreno (Copernicus DSM ya viene "aplanado" sobre el agua).
 *  · El color sale de la imagen satelital bajo el polígono (agua turbia, verde, azul…).
 */
import * as THREE from "three";
import { clipPolygonToBox, ringArea, type LocalBox } from "./geo";
import type { RoofSampler } from "./roofs";
import type { Ring, WaterFeature } from "./types";
import { createExportWaterMaterial, createSeaMaterial } from "./water-material";

/** 0 = estanque/río (ondas pequeñas), 1 = mar abierto (olas largas). */
function waveFor(kind: string): number {
  if (kind === "ocean" || kind === "sea" || kind === "bay") return 1;
  if (kind === "lake" || kind === "reservoir" || kind === "lagoon" || kind === "water" || !kind) return 0.5;
  if (kind === "river" || kind === "stream" || kind === "canal" || kind === "drain" || kind === "ditch") return 0.3;
  return 0.15; // estanques, piscinas, balsas…
}

const CELL_M = 250;
const FLAT_KINDS = new Set(["lake", "pond", "reservoir", "ocean", "sea", "basin", "lagoon", "oxbow", "wastewater", "pool", "water", "bay"]);
const DEFAULT_COLOR: [number, number, number] = [0.1, 0.32, 0.42];

function inside(x: number, z: number, ring: Ring): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

function bounds(ring: Ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Puntos de muestreo dentro del polígono (rejilla n×n sobre su caja). */
function samplePoints(ring: Ring, n = 6): [number, number][] {
  const b = bounds(ring);
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = b.minX + ((i + 0.5) / n) * (b.maxX - b.minX);
      const z = b.minZ + ((j + 0.5) / n) * (b.maxZ - b.minZ);
      if (inside(x, z, ring)) pts.push([x, z]);
    }
  }
  if (!pts.length) for (const p of ring.slice(0, 12)) pts.push(p);
  return pts;
}

const median = (v: number[]) => {
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

type Piece = { outer: Ring; holes: Ring[]; flatLevel?: number; flatColor?: [number, number, number]; wave: number };

export function buildWaterMesh(
  features: WaterFeature[],
  extent: LocalBox,
  groundAt: (x: number, z: number) => number,
  sampler: RoofSampler | null,
): { mesh: THREE.Mesh; count: number } | null {
  const pos: number[] = [];
  const col: number[] = [];
  const wav: number[] = [];
  const uvs: number[] = [];
  let count = 0;

  const emit = (p: Piece) => {
    if (ringArea(p.outer) < 4) return;
    // Nivel y color a partir de los puntos interiores
    const pts = samplePoints(p.outer);
    const level = (p.flatLevel ?? median(pts.map(([x, z]) => groundAt(x, z)))) + 0.05;
    let color = p.flatColor;
    if (!color) {
      let r = 0, g = 0, b = 0, n = 0;
      for (const [x, z] of pts) {
        const c = sampler?.(x, z);
        if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
      }
      color = n ? [r / n, g / n, b / n] : DEFAULT_COLOR;
    }
    const contour = p.outer.map(([x, z]) => new THREE.Vector2(x, z));
    const holes = p.holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
    let faces: number[][];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, holes);
    } catch {
      return;
    }
    const verts = contour.concat(...holes); // triangulateShape quita duplicados en contour/holes antes de indexar
    for (const f of faces) {
      let [a, b, c] = f.map((i) => verts[i]);
      // normal hacia arriba (+Y): cross.y > 0
      if ((b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y) < 0) [b, c] = [c, b];
      for (const v of [a, b, c]) {
        pos.push(v.x, level, v.y);
        col.push(color[0], color[1], color[2]);
        wav.push(p.wave);
        uvs.push(v.x / 24, v.y / 24);
      }
    }
    count++;
  };

  for (const f of features) {
    const outer0 = f.rings[0];
    if (!outer0 || outer0.length < 3) continue;
    const kind = (f.subtype || "").toLowerCase();
    const flat = FLAT_KINDS.has(kind) || !kind;
    const clipped = clipPolygonToBox(outer0, extent);
    if (!clipped) continue;

    if (flat) {
      const pts = samplePoints(clipped, 8);
      const level = median(pts.map(([x, z]) => groundAt(x, z)));
      const holes = f.rings.slice(1).filter((h) => h.length >= 3 && ringArea(h) > 9 && h.every(([x, z]) => inside(x, z, clipped)));
      emit({ outer: clipped, holes, flatLevel: level, wave: waveFor(kind) });
      continue;
    }
    // Ríos / canales: celdas de CELL_M, cada una con su nivel
    const b = bounds(clipped);
    for (let x = b.minX; x < b.maxX; x += CELL_M) {
      for (let z = b.minZ; z < b.maxZ; z += CELL_M) {
        const cell: LocalBox = { minX: x, maxX: Math.min(x + CELL_M, b.maxX), minZ: z, maxZ: Math.min(z + CELL_M, b.maxZ) };
        const piece = clipPolygonToBox(clipped, cell);
        if (piece) emit({ outer: piece, holes: [], wave: waveFor(kind || "river") });
      }
    }
  }

  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const normals = new Float32Array(pos.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("wave", new THREE.Float32BufferAttribute(wav, 1));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  const mobile = typeof navigator !== "undefined" && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const mat = createSeaMaterial(mobile);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "water";
  // material PBR para el GLB exportado (los shaders propios no viajan en un .glb)
  mesh.userData.exportMaterial = createExportWaterMaterial();
  return { mesh, count };
}
