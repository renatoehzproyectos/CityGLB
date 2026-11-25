import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BUILDING_TINTS, FACADE_PALETTES, ROOF_TINTS, cfg } from "./config";
import { bboxSizeMeters, ringArea, unproject } from "./geo";
import type { BuildingFeature, CityData, CoastlineFeature, PortFeature, RoadFeature, WaterFeature } from "./types";
import { fetchHeightGrid, sampleHeight, type HeightGrid } from "./elevation";
import { buildSatelliteCanvas } from "./satellite";
import { getCityAssets } from "./prefetch";
import { computeOBB, createRoofSampler, fanRoof, isConvex, ridgeRoof, type OBB, type RoofSampler } from "./roofs";
import type { RGB, RoofShape } from "./roof-data";
import { COLOSSEUM, ROME_LANDMARKS, ROME_STATUE_SLOTS, CREDITS } from "./rome";
import { buildColosseum, findColosseumBuilding, type EllipseFit } from "./colosseum";
import { project } from "./geo";
import { applyPlanarUV, liftVertexColors, loadPolyHavenPbr } from "./pbr";
import {
  fetchLandCoverGrid,
  buildLandCoverCanvas,
  sampleLandCoverClass,
  isBuiltOrWaterClass,
  type LandCoverGrid,
} from "./landcover";

function closedRing(ring: [number, number][]): [number, number][] {
  if (ring.length < 3) return ring;
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  return ring;
}

function toShape(ring: [number, number][], holes: [number, number][][] = []): THREE.Shape | null {
  const outer = closedRing(ring);
  if (outer.length < 3) return null;
  const shape = new THREE.Shape();
  shape.moveTo(outer[0][0], -outer[0][1]);
  for (let i = 1; i < outer.length; i++) {
    shape.lineTo(outer[i][0], -outer[i][1]);
  }
  shape.closePath();

  for (const hole of holes) {
    const h = closedRing(hole);
    if (h.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(h[0][0], -h[0][1]);
    for (let i = 1; i < h.length; i++) path.lineTo(h[i][0], -h[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

function extrudeShape(shape: THREE.Shape, depth: number): THREE.BufferGeometry | null {
  try {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: false,
      steps: 1,
    });
    geo.rotateX(-Math.PI / 2);
    geo.computeVertexNormals();
    return geo;
  } catch {
    return null;
  }
}

function paintGeometry(geo: THREE.BufferGeometry, color: [number, number, number]): void {
  const count = geo.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color[0];
    colors[i * 3 + 1] = color[1];
    colors[i * 3 + 2] = color[2];
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/** Stable 0..1 hash from a building footprint so the same building always
 * gets the same facade/roof variant (no flicker on rebuilds). */
function buildingHash(b: BuildingFeature): number {
  let h = 0x811c9dc5;
  for (const [x, z] of b.ring) {
    h ^= Math.round(x * 37) | 0;
    h = Math.imul(h, 16777619);
    h ^= Math.round(z * 37) | 0;
    h = Math.imul(h, 16777619);
  }
  h ^= Math.round(b.height * 97) | 0;
  h = Math.imul(h, 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

function pickVariant<T>(list: T[], t: number): T {
  const i = Math.min(list.length - 1, Math.floor(t * list.length));
  return list[i];
}

const WARM_FACADES: [number, number, number][] = [
  [0.86, 0.66, 0.46], // ocre
  [0.9, 0.78, 0.6], // crema
  [0.82, 0.52, 0.36], // terracota
  [0.88, 0.6, 0.45], // salmón
  [0.8, 0.68, 0.52], // arena
  [0.92, 0.84, 0.7], // marfil
  [0.78, 0.46, 0.32], // siena
];
const WARM_ROOFS: [number, number, number][] = [
  [0.74, 0.3, 0.17],
  [0.66, 0.26, 0.15],
  [0.8, 0.36, 0.2],
  [0.58, 0.24, 0.16],
  [0.7, 0.4, 0.3],
];
const WARM_FLAT_ROOF: [number, number, number] = [0.66, 0.5, 0.4];
const NEUTRAL_FACADES: [number, number, number][] = [
  [0.82, 0.78, 0.7],
  [0.72, 0.64, 0.56],
  [0.64, 0.42, 0.34], // ladrillo
  [0.86, 0.84, 0.8],
  [0.74, 0.72, 0.7],
  [0.7, 0.6, 0.5],
];
const NEUTRAL_ROOFS: [number, number, number][] = [
  [0.34, 0.35, 0.38], // pizarra
  [0.44, 0.4, 0.38],
  [0.56, 0.3, 0.24],
  [0.4, 0.38, 0.36],
];
let WARM = false;
let FACADES = WARM_FACADES;
let ROOFS = WARM_ROOFS;

/** Mediterráneo, Oriente Medio, N. de África y América Latina → paleta cálida; resto → neutra. */
function regionIsWarm(lat: number, lon: number): boolean {
  if (lat > 12 && lat < 47 && lon > -12 && lon < 62) return true;
  if (lat > -56 && lat < 33 && lon > -118 && lon < -34) return true;
  return false;
}
/** Estilo de vegetación por región. */
function regionTreeStyle(lat: number, lon: number): "mediterranean" | "tropical" | "temperate" {
  const med =
    (lat > 30 && lat < 46 && lon > -10 && lon < 36) ||
    (lat > -40 && lat < -28 && lon > -75 && lon < -68) || // Chile central
    (lat > 32 && lat < 38 && lon > -124 && lon < -116); // California
  if (med) return "mediterranean";
  if (Math.abs(lat) < 23) return "tropical";
  return "temperate";
}

/** Individualized facade color: palette variant per kind, shaded slightly by height. */
function buildingColor(b: BuildingFeature): [number, number, number] {
  if (b.facade) return b.facade;
  if (WARM) {
    const w = pickVariant(FACADES, buildingHash(b));
    const th = Math.min(1, Math.max(0, (b.height - 8) / 80));
    return [w[0] * (1 - th * 0.1), w[1] * (1 - th * 0.08), w[2] * (1 - th * 0.04)];
  }
  const palette = FACADE_PALETTES[b.kind] ?? FACADE_PALETTES.default;
  const t = buildingHash(b);
  const base = pickVariant(palette, t) ?? BUILDING_TINTS[b.kind] ?? cfg.BUILDING_COLOR;
  const th = Math.min(1, Math.max(0, (b.height - 8) / 80));
  return [
    base[0] * (1 - th * 0.12),
    base[1] * (1 - th * 0.08),
    base[2] * (1 - th * 0.02) + th * 0.04,
  ];
}

/** Roof tint variant per building, following the same stable hash as the facade. */
function roofColor(b: BuildingFeature): [number, number, number] {
  if (WARM) return pickVariant(ROOFS, 1 - buildingHash(b) * 0.999);
  const palette = ROOF_TINTS[b.kind] ?? ROOF_TINTS.default;
  const t = 1 - buildingHash(b); // decorrelate from facade pick
  return pickVariant(palette, t < 0 ? 0 : t > 1 ? 1 : t);
}

function bufferPolyline(pts: [number, number][], half: number): [number, number][] | null {
  if (pts.length < 2) return null;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let tx = next[0] - prev[0];
    let tz = next[1] - prev[1];
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const nx = -tz;
    const nz = tx;
    left.push([pts[i][0] + nx * half, pts[i][1] + nz * half]);
    right.push([pts[i][0] - nx * half, pts[i][1] - nz * half]);
  }
  const ring = left.concat(right.reverse());
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

function mergeOrEmpty(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!geos.length) return null;
  let merged: THREE.BufferGeometry | null = null;
  try {
    merged = mergeGeometries(geos, false);
  } catch (e) {
    console.warn("mergeGeometries failed (mismatched attributes?)", e);
    merged = null;
  }
  if (!merged) {
    // Attribute sets didn't line up across the batch (e.g. one geometry has
    // uv/color and another doesn't) — three.js merges nothing in that case
    // instead of throwing, so fall back to keeping just the first geometry
    // rather than silently losing the whole batch or propagating a null.
    console.warn(`mergeGeometries returned null for ${geos.length} geometries; keeping first only`);
    merged = geos[0] ?? null;
    for (const g of geos.slice(1)) g.dispose();
    return merged;
  }
  for (const g of geos) g.dispose();
  return merged;
}

function centroid(ring: [number, number][]): [number, number] {
  let sx = 0, sz = 0;
  for (const p of ring) {
    sx += p[0];
    sz += p[1];
  }
  const n = ring.length || 1;
  return [sx / n, sz / n];
}

/**
 * Feature rings use project(): z = (originLat - lat) (north → negative).
 * HeightGrid.zs uses (lat - origin) (north → positive).
 * Terrain mesh places vertices at Three Z = -gridZs = feature z.
 * Convert feature (x, z) → height on the DEM.
 */
function heightAtFeature(grid: HeightGrid, x: number, zFeat: number): number {
  return sampleHeight(grid, x, -zFeat);
}

/** Min height under a footprint so the object sits on the ground (no floating). */
function footprintMinHeight(grid: HeightGrid, pts: [number, number][]): number {
  let minH = Infinity;
  for (const [x, z] of pts) {
    const h = heightAtFeature(grid, x, z);
    if (h < minH) minH = h;
  }
  if (pts.length >= 3) {
    const [cx, cz] = centroid(pts);
    const hc = heightAtFeature(grid, cx, cz);
    if (hc < minH) minH = hc;
  }
  return Number.isFinite(minH) ? minH : 0;
}

/**
 * Drape extruded geometry onto terrain: each vertex keeps its relative
 * extrusion height and is lifted so its base follows the DEM at (x, z).
 * After extrudeShape, positions are (x, yExtrude, zFeat) matching terrain Z.
 */
function drapeOntoTerrain(
  geo: THREE.BufferGeometry,
  grid: HeightGrid,
  yBias = 0
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ground = heightAtFeature(grid, x, z);
    pos.setY(i, ground + y + yBias);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/**
 * Pyramid/hip roof for a building footprint: eave ring (slightly overhanging
 * the walls) lofted up to an apex above the centroid. Cheap to compute for
 * arbitrary polygons (no straight-skeleton needed) and reads as a proper
 * pitched roof from any angle, unlike a flat extrusion cap.
 */
const isTerracotta = (c: RGB) => c[0] > c[1] * 1.18 && c[0] > c[2] * 1.35;

/** Color de techo observado en el satélite bajo la huella (evita sombras y copas de árboles). */
function sampleRoofColor(o: OBB, sampler: RoofSampler): RGB | null {
  const vx = -o.uz, vz = o.ux;
  const offs: [number, number][] = [[0, 0], [0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]];
  let best: RGB | null = null, bestL = -1;
  for (const [fu, fv] of offs) {
    const u = fu * o.a, v = fv * o.c;
    const c = sampler(o.cx + u * o.ux + v * vx, o.cz + u * o.uz + v * vz);
    if (!c) continue;
    if (c[1] > c[0] * 1.04 && c[1] > c[2]) continue; // vegetación sobre la huella
    const l = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
    if (l > bestL) { bestL = l; best = c; }
  }
  return best;
}

function resolveRoofColor(b: BuildingFeature, sat: RGB | null): RGB {
  if (b.roof?.color) return b.roof.color;
  const pal = roofColor(b);
  if (!sat) return pal;
  // La imagen ya trae luz y sombra: se aclara un poco y se mezcla con la paleta.
  const k = 1.18;
  return [
    Math.min(1, sat[0] * k) * 0.8 + pal[0] * 0.2,
    Math.min(1, sat[1] * k) * 0.8 + pal[1] * 0.2,
    Math.min(1, sat[2] * k) * 0.8 + pal[2] * 0.2,
  ];
}

function planRoof(b: BuildingFeature, o: OBB, sat: RGB | null): { shape: RoofShape; rise: number } {
  const area = ringArea(b.ring);
  const rectLike = o.fill >= 0.8 && !b.holes.length;
  const convex = !b.holes.length && isConvex(b.ring);
  const r = Math.sqrt(area / Math.PI);
  let shape: RoofShape = "flat";
  const explicit = b.roof?.shape;
  if (explicit) {
    shape = explicit;
    if ((shape === "gabled" || shape === "hipped") && !rectLike) shape = convex ? "pyramidal" : "flat";
    if ((shape === "pyramidal" || shape === "dome") && !convex) shape = "flat";
  } else if (b.height <= 26 && area >= 20 && !b.holes.length) {
    const prob = sat ? (isTerracotta(sat) ? 1 : 0.12) : WARM ? 0.7 : 0.45;
    if (buildingHash(b) < prob) {
      if (rectLike) shape = area < 260 ? "gabled" : "hipped";
      else if (convex) shape = "pyramidal";
    }
  }
  let rise = b.roof?.height;
  if (rise == null) {
    rise = shape === "dome" ? Math.min(14, Math.max(2, r * 0.7))
      : shape === "pyramidal" ? Math.min(5, Math.max(1.2, r * 0.35))
      : Math.min(5.5, Math.max(1.4, o.c * 0.5));
  }
  return { shape, rise };
}

/**
 * Small rooftop clutter (AC units / mechanical boxes) for flat/tall roofs
 * that don't get a pitched roof — cheap microdetail that reads at close range
 * without needing real MEP modeling.
 */
function roofClutterGeometry(b: BuildingFeature): THREE.BufferGeometry | null {
  const area = ringArea(b.ring);
  if (area < 120) return null;
  const [cx, cz] = centroid(b.ring);
  const r = Math.sqrt(area / Math.PI);
  const seed = buildingHash(b);
  const count = Math.min(4, Math.max(1, Math.floor(area / 260)));
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const t1 = (seed * 97 + i * 53.7) % 1;
    const t2 = (seed * 193 + i * 29.3) % 1;
    const t3 = (seed * 311 + i * 71.1) % 1;
    const ang = t1 * Math.PI * 2;
    const dist = t2 * r * 0.45;
    const w = 1.1 + t3 * 1.3;
    const d = 1.1 + ((t2 + t3) % 1) * 1.3;
    const h = 0.7 + ((t1 + t3) % 1) * 0.9;
    const box = new THREE.BoxGeometry(w, h, d);
    box.deleteAttribute("uv"); // keep attribute set identical to pyramid roofs (position/normal/color only)
    box.translate(cx + Math.cos(ang) * dist, h / 2, cz + Math.sin(ang) * dist);
    geos.push(box);
  }
  const merged = mergeOrEmpty(geos);
  if (merged) paintGeometry(merged, [0.52, 0.53, 0.55]);
  return merged;
}

function buildingsGeometry(
  features: BuildingFeature[],
  grid: HeightGrid | null,
  sampler: RoofSampler | null = null
): { walls: THREE.BufferGeometry | null; roofs: THREE.BufferGeometry | null } {
  const wallGeos: THREE.BufferGeometry[] = [];
  const roofGeos: THREE.BufferGeometry[] = [];
  for (const b of features) {
    if (b.height < cfg.MIN_BUILDING_HEIGHT) continue;
    if (ringArea(b.ring) < cfg.MIN_BUILDING_AREA) continue;
    const shape = toShape(b.ring, b.holes);
    if (!shape) continue;
    const geo = extrudeShape(shape, b.height);
    if (!geo) continue;

    const baseY = grid ? footprintMinHeight(grid, b.ring) : 0;
    geo.translate(0, baseY, 0);
    paintGeometry(geo, buildingColor(b));
    // AO barato: base de los muros más oscura (contacto con la calle) → volumen y profundidad.
    {
      const pos = geo.getAttribute("position");
      const nrm0 = geo.getAttribute("normal");
      const col0 = geo.getAttribute("color");
      for (let i = 0; i < pos.count; i++) {
        if (Math.abs(nrm0.getY(i)) > 0.5) continue;
        const t = Math.min(1, Math.max(0, (pos.getY(i) - baseY) / 6));
        const f = 0.7 + 0.3 * (t * t * (3 - 2 * t));
        col0.setXYZ(i, col0.getX(i) * f, col0.getY(i) * f, col0.getZ(i) * f);
      }
    }
    // Techo: forma/color reales (Overture/OSM) o inferidos del satélite y de la huella.
    const ob = computeOBB(b.ring, b.roof?.dir);
    const sat = ob && sampler ? sampleRoofColor(ob, sampler) : null;
    const roofCol = resolveRoofColor(b, sat);
    let rGeo: THREE.BufferGeometry | null = null;
    if (cfg.ENABLE_ROOFS && ob) {
      const plan = planRoof(b, ob, sat);
      if (plan.shape === "gabled" || plan.shape === "hipped") rGeo = ridgeRoof(plan.shape, ob, plan.rise, 0.5);
      else if (plan.shape === "pyramidal") rGeo = fanRoof(b.ring, plan.rise, false, 0.5);
      else if (plan.shape === "dome") rGeo = fanRoof(b.ring, plan.rise, true, 0);
    }

    // Las tapas (normal ±Y) heredaban UV en metros y mostraban la rejilla de ventanas
    // sobre los techos. Las apuntamos a una zona lisa de la textura y, si el techo es
    // plano, las pintamos con el color real/observado de la azotea.
    {
      const nrm = geo.getAttribute("normal");
      const uv = geo.getAttribute("uv");
      const col = geo.getAttribute("color");
      if (nrm && uv) {
        const flat: RGB | null = rGeo ? null : sat || b.roof?.color || WARM ? roofCol : null;
        for (let i = 0; i < nrm.count; i++) {
          if (Math.abs(nrm.getY(i)) > 0.9) {
            uv.setXY(i, 0.03, 0.03);
            if (flat && col) col.setXYZ(i, flat[0], flat[1], flat[2]);
          }
        }
        uv.needsUpdate = true;
        if (col) col.needsUpdate = true;
      }
    }
    wallGeos.push(geo);

    if (rGeo) {
      rGeo.translate(0, baseY + b.height, 0);
      const j = 0.94 + ((buildingHash(b) * 7.7) % 1) * 0.12; // variación tejado a tejado
      paintGeometry(rGeo, [roofCol[0] * j, roofCol[1] * j, roofCol[2] * j]);
      roofGeos.push(rGeo);
    } else {
      // Azotea plana: pequeños equipos en el techo.
      const clutter = roofClutterGeometry(b);
      if (clutter) {
        clutter.translate(0, baseY + b.height, 0);
        roofGeos.push(clutter);
      }
    }
  }
  return { walls: mergeOrEmpty(wallGeos), roofs: mergeOrEmpty(roofGeos) };
}

/**
 * Procedural window/facade texture: a light neutral base (so the per-building
 * vertex-color tint reads through) with a grid of darker glass rectangles and
 * thin frame lines. Applied with real-world-scaled repeat so window size stays
 * consistent across small and large buildings.
 */
let cachedWindowNormalMap: THREE.Texture | null = null;
function createWindowNormalMap(): THREE.Texture {
  if (cachedWindowNormalMap) return cachedWindowNormalMap;
  const size = cfg.WINDOW_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  // Heightmap pass: recessed glass, raised frame/sill — same layout as the
  // color texture so the relief lines up with the visible windows.
  ctx.fillStyle = "#808080"; // neutral height
  ctx.fillRect(0, 0, size, size);
  const cols = 4;
  const rows = 5;
  const padX = size / cols;
  const padY = size / rows;
  const winW = padX * 0.62;
  const winH = padY * 0.68;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * padX + (padX - winW) / 2;
      const y = r * padY + (padY - winH) / 2;
      // frame: slightly raised ring
      ctx.fillStyle = "#9c9c9c";
      ctx.fillRect(x - 3, y - 3, winW + 6, winH + 6);
      // glass: recessed
      ctx.fillStyle = "#5c5c5c";
      ctx.fillRect(x, y, winW, winH);
      // sill: raised strip under the window
      ctx.fillStyle = "#a8a8a8";
      ctx.fillRect(x - 3, y + winH + 3, winW + 6, size * 0.02);
    }
  }

  const heightData = ctx.getImageData(0, 0, size, size);
  const normalData = ctx.createImageData(size, size);
  const strength = 2.2;
  const at = (x: number, y: number) => {
    const xi = (x + size) % size;
    const yi = (y + size) % size;
    return heightData.data[(yi * size + xi) * 4] / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hl = at(x - 1, y);
      const hr = at(x + 1, y);
      const hd = at(x, y - 1);
      const hu = at(x, y + 1);
      let nx = (hl - hr) * strength;
      let ny = (hd - hu) * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const nzn = nz / len;
      const idx = (y * size + x) * 4;
      normalData.data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      normalData.data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalData.data[idx + 2] = Math.round((nzn * 0.5 + 0.5) * 255);
      normalData.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(normalData, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / cfg.FACADE_METERS_PER_TILE, 1 / cfg.FACADE_METERS_PER_TILE);
  tex.needsUpdate = true;
  cachedWindowNormalMap = tex;
  return tex;
}
let cachedWindowTexture: THREE.Texture | null = null;
let cachedWarmWindowTexture: THREE.Texture | null = null;
function createWindowTexture(warm = false): THREE.Texture {
  if (warm && cachedWarmWindowTexture) return cachedWarmWindowTexture;
  if (!warm && cachedWindowTexture) return cachedWindowTexture;
  const size = cfg.WINDOW_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = warm ? "#fbf6ec" : "#e9e6df";
  ctx.fillRect(0, 0, size, size);

  const cols = 4;
  const rows = 5;
  const padX = size / cols;
  const padY = size / rows;
  const winW = padX * 0.62;
  const winH = padY * 0.68;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * padX + (padX - winW) / 2;
      const y = r * padY + (padY - winH) / 2;
      const shade = 30 + Math.round(((c * 7 + r * 13) % 5) * 6); // subtle per-window variation
      // Cálido: ventanas pardas de bajo contraste (sombra de postigo), no vidrio negro.
      ctx.fillStyle = warm
        ? `rgb(${176 + shade * 0.3}, ${152 + shade * 0.25}, ${126 + shade * 0.2})`
        : `rgb(${shade + 10}, ${shade + 18}, ${shade + 30})`;
      ctx.fillRect(x, y, winW, winH);
      ctx.strokeStyle = warm ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.35)";
      ctx.lineWidth = Math.max(1, size * 0.006);
      ctx.strokeRect(x, y, winW, winH);
      // mullion
      ctx.beginPath();
      ctx.moveTo(x + winW / 2, y);
      ctx.lineTo(x + winW / 2, y + winH);
      ctx.moveTo(x, y + winH / 2);
      ctx.lineTo(x + winW, y + winH / 2);
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = Math.max(1, size * 0.004);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const tileM = warm ? 13 : cfg.FACADE_METERS_PER_TILE; // ventanas más espaciadas y grandes
  tex.repeat.set(1 / tileM, 1 / tileM);
  tex.needsUpdate = true;
  if (warm) cachedWarmWindowTexture = tex;
  else cachedWindowTexture = tex;
  return tex;
}

/**
 * Terrain-following road ribbon: left/right edges along the centerline.
 * Each edge samples the DEM independently so cross-slopes don't bury one side,
 * and we lift clearly above the terrain mesh to avoid z-fighting with coarse DEM.
 */
function roadRibbonGeometry(
  path: [number, number][],
  halfWidth: number,
  grid: HeightGrid | null,
  thickness = cfg.ROAD_HEIGHT
): THREE.BufferGeometry | null {
  if (path.length < 2 || halfWidth <= 0) return null;

  // Deduplicate consecutive points
  const raw: [number, number][] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = raw[raw.length - 1];
    const b = path[i];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.4) raw.push(b);
  }
  if (raw.length < 2) return null;

  // Densify so the ribbon follows DEM gradients instead of long chords that
  // cut through hills (looks like roads "mixed into" terrain).
  const STEP = 6; // meters between stations
  const pts: [number, number][] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1];
    const b = raw[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(seg / STEP));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }

  const n = pts.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  // Clearance above DEM: coarse elevation grids (15–40 m) can undershoot the
  // rendered terrain triangle by several decimeters; keep roads clearly on top.
  const LIFT = 0.35;
  // 4 verts per station: edge(curb/sidewalk, light) — inner(asphalt, dark) x2 — edge(light).
  // Skip the curb band on very narrow paths (footways etc.) where it'd be visually noisy.
  const hasCurb = halfWidth > 2.2;
  const innerFrac = hasCurb ? 0.86 : 1;
  const roadC: [number, number, number] = [...cfg.ROAD_COLOR];
  const edgeC: [number, number, number] = [...cfg.ROAD_EDGE_COLOR];

  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    let tx = next[0] - prev[0];
    let tz = next[1] - prev[1];
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const nx = -tz;
    const nz = tx;

    const x = pts[i][0];
    const z = pts[i][1];
    const innerHalf = halfWidth * innerFrac;

    const offsets: [number, [number, number, number]][] = [
      [halfWidth, edgeC],
      [innerHalf, roadC],
      [-innerHalf, roadC],
      [-halfWidth, edgeC],
    ];

    for (const [off, col] of offsets) {
      const vx = x + nx * off;
      const vz = z + nz * off;
      let y = LIFT;
      if (grid) {
        const hV = heightAtFeature(grid, vx, vz);
        const hC = heightAtFeature(grid, x, z);
        y = Math.max(hV, hC) + LIFT;
      }
      positions.push(vx, y + thickness, vz);
      colors.push(col[0], col[1], col[2]);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    const base = i * 4;
    const nextBase = base + 4;
    for (let k = 0; k < 3; k++) {
      const a = base + k;
      const b = base + k + 1;
      const c = nextBase + k;
      const d = nextBase + k + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function roadsGeometry(features: RoadFeature[], grid: HeightGrid | null): THREE.BufferGeometry | null {
  const geos: THREE.BufferGeometry[] = [];
  for (const r of features) {
    if (r.path.length < 2) continue;
    if (r.width < 1.2) continue; // skip tiny footpaths for cleaner mesh
    const geo = roadRibbonGeometry(r.path, r.width / 2, grid);
    if (!geo) continue;
    geos.push(geo);
  }
  const junctions = roadJunctionsGeometry(features, grid);
  if (junctions) geos.push(junctions);
  return mergeOrEmpty(geos);
}

/**
 * Fills the gaps at street intersections with a flat paved disc sized to the
 * widest road meeting there, so junctions read as continuous pavement instead
 * of two ribbons crossing with visible notches (real streets have a merged
 * intersection surface, not raw crossing strips).
 */
function roadJunctionsGeometry(features: RoadFeature[], grid: HeightGrid | null): THREE.BufferGeometry | null {
  type Node = { x: number; z: number; maxHalf: number; roads: number };
  const cellSize = 3; // meters — endpoints within this snap together
  const buckets = new Map<string, Node>();

  const key = (x: number, z: number) => `${Math.round(x / cellSize)}:${Math.round(z / cellSize)}`;

  for (const r of features) {
    if (r.path.length < 2 || r.width < 1.2) continue;
    const half = r.width / 2;
    for (const [x, z] of [r.path[0], r.path[r.path.length - 1]]) {
      const k = key(x, z);
      const existing = buckets.get(k);
      if (existing) {
        existing.x = (existing.x * existing.roads + x) / (existing.roads + 1);
        existing.z = (existing.z * existing.roads + z) / (existing.roads + 1);
        existing.maxHalf = Math.max(existing.maxHalf, half);
        existing.roads += 1;
      } else {
        buckets.set(k, { x, z, maxHalf: half, roads: 1 });
      }
    }
  }

  const geos: THREE.BufferGeometry[] = [];
  const roadC: [number, number, number] = [...cfg.ROAD_COLOR];
  for (const node of buckets.values()) {
    if (node.roads < 2) continue; // only real junctions, not dead ends
    const r = node.maxHalf * 1.08;
    const segs = 12;
    const positions: number[] = [];
    const indices: number[] = [];
    const LIFT = 0.35 + cfg.ROAD_HEIGHT + 0.03; // sit just above ribbon tops to cleanly cover seams
    const yc = grid ? heightAtFeature(grid, node.x, node.z) : 0;
    positions.push(node.x, yc + LIFT, node.z);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const px = node.x + Math.cos(a) * r;
      const pz = node.z + Math.sin(a) * r;
      const y = grid ? Math.max(yc, heightAtFeature(grid, px, pz)) : 0;
      positions.push(px, y + LIFT, pz);
    }
    for (let i = 1; i <= segs; i++) indices.push(0, i, i + 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    paintGeometry(geo, roadC);
    geos.push(geo);
  }
  return mergeOrEmpty(geos);
}

function waterGeometry(features: WaterFeature[], grid: HeightGrid | null): THREE.BufferGeometry | null {
  const geos: THREE.BufferGeometry[] = [];
  for (const w of features) {
    if (!w.rings.length) continue;
    const shape = toShape(w.rings[0], w.rings.slice(1));
    if (!shape) continue;
    const geo = extrudeShape(shape, 0.35);
    if (!geo) continue;
    if (grid) {
      drapeOntoTerrain(geo, grid, 0.04);
    } else {
      geo.translate(0, 0.02, 0);
    }
    geos.push(geo);
  }
  return mergeOrEmpty(geos);
}

function portGeometry(features: PortFeature[], grid: HeightGrid | null): THREE.BufferGeometry | null {
  const geos: THREE.BufferGeometry[] = [];
  for (const p of features) {
    let geo: THREE.BufferGeometry | null = null;
    if (p.shape === "line" && p.path) {
      geo = roadRibbonGeometry(p.path, (p.width ?? 4) / 2, grid, 0.3);
    } else if (p.shape === "area" && p.ring) {
      const shape = toShape(p.ring);
      if (shape) geo = extrudeShape(shape, 0.3);
      if (geo) {
        geo.deleteAttribute("uv"); // match ribbon-derived geometries (position/normal/color only) before merge
        if (grid) drapeOntoTerrain(geo, grid, 0.05);
        else geo.translate(0, 0.05, 0);
      }
    }
    if (!geo) continue;
    const color = cfg.PORT_COLOR_MAP[p.kind] ?? [0.5, 0.49, 0.47];
    paintGeometry(geo, color);
    geos.push(geo);
  }
  const merged = mergeOrEmpty(geos);
  return merged;
}

function coastlineGeometry(features: CoastlineFeature[], grid: HeightGrid | null): THREE.BufferGeometry | null {
  const geos: THREE.BufferGeometry[] = [];
  for (const c of features) {
    const geo = roadRibbonGeometry(c.path, 0.6, grid, 0.12);
    if (!geo) continue;
    paintGeometry(geo, [...cfg.COASTLINE_COLOR]);
    geos.push(geo);
  }
  return mergeOrEmpty(geos);
}

function terrainGeometryFromGrid(
  grid: HeightGrid,
  extent?: { minX: number; maxX: number; minZ: number; maxZ: number }
): THREE.BufferGeometry {
  const { width: cols, height: rows, data, xs, zs } = grid;
  const geo = new THREE.PlaneGeometry(1, 1, cols - 1, rows - 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uvs = geo.attributes.uv as THREE.BufferAttribute;

  const minX = extent?.minX ?? xs[0];
  const maxX = extent?.maxX ?? xs[cols - 1];
  const minZ = extent?.minZ ?? -zs[rows - 1]; // feature Z (north negative)
  const maxZ = extent?.maxZ ?? -zs[0];
  const spanX = maxX - minX || 1;
  const spanZ = maxZ - minZ || 1;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      const x = xs[i];
      const zNorth = zs[j]; // local Z north
      const h = data[idx];
      // Three Z = -north = feature z
      const zFeat = -zNorth;
      pos.setXYZ(idx, x, h, zFeat);
      // UV: u east, v north→south so satellite orientation matches
      const u = (x - minX) / spanX;
      const v = 1 - (zFeat - minZ) / spanZ;
      uvs.setXY(idx, u, v);
    }
  }
  pos.needsUpdate = true;
  uvs.needsUpdate = true;
  geo.computeVertexNormals();
  // Ensure normals point skyward (+Y). PlaneGeometry remapped onto XZ can end up
  // with either winding; sample the average Y and flip only if needed.
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  let avgY = 0;
  for (let i = 0; i < nrm.count; i++) avgY += nrm.getY(i);
  avgY /= Math.max(1, nrm.count);
  if (avgY < 0) {
    for (let i = 0; i < nrm.count; i++) {
      nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
    }
  }
  nrm.needsUpdate = true;
  return geo;
}

function flatTerrainGeometry(data: CityData): THREE.BufferGeometry {
  const { width, depth } = bboxSizeMeters(data.bbox);
  const pad = 1.08;
  const geo = new THREE.BoxGeometry(Math.max(width, 40) * pad, 1.2, Math.max(depth, 40) * pad);
  geo.translate(0, -0.6, 0);
  return geo;
}

// Procedural trees: a small family of shapes (conifer / rounded broadleaf /
// layered) so a scattered forest doesn't read as one repeated cookie-cutter
// mesh. Trunk + volumetric canopy, colored via vertex colors for instancing.
type TreeKind = "conifer" | "round" | "layered" | "stonepine";

function paintTree(merged: THREE.BufferGeometry, trunkTopY: number, canopyTint: [number, number, number]): void {
  const count = merged.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  const pos = merged.getAttribute("position");
  for (let i = 0; i < count; i++) {
    const y = pos.getY(i);
    if (y < trunkTopY) {
      colors[i * 3] = 0.2 + (i % 5) * 0.008;
      colors[i * 3 + 1] = 0.13;
      colors[i * 3 + 2] = 0.08;
    } else {
      colors[i * 3] = canopyTint[0];
      colors[i * 3 + 1] = canopyTint[1];
      colors[i * 3 + 2] = canopyTint[2];
    }
  }
  merged.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/** three ≥0.18x: Cylinder/Cone son indexados e Icosahedron no; unifica antes de fusionar. */
function mergeTreeParts(parts: THREE.BufferGeometry[], useGroups: boolean): THREE.BufferGeometry | null {
  const flat = parts.map((g) => {
    const f = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(f.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "uv") f.deleteAttribute(name);
    }
    return f;
  });
  return mergeGeometries(flat, useGroups);
}

export function createTreeGeometry(kind: TreeKind, tint: [number, number, number]): THREE.BufferGeometry {
  let merged: THREE.BufferGeometry;
  let trunkTop: number;
  if (kind === "conifer") {
    const trunk = new THREE.CylinderGeometry(0.22, 0.38, 3.4, 6);
    trunk.translate(0, 1.7, 0);
    const c1 = new THREE.ConeGeometry(2.1, 3.6, 8);
    c1.translate(0, 4.6, 0);
    const c2 = new THREE.ConeGeometry(1.55, 3.2, 8);
    c2.translate(0, 6.6, 0);
    const c3 = new THREE.ConeGeometry(0.95, 2.4, 8);
    c3.translate(0, 8.4, 0);
    merged = mergeTreeParts([trunk, c1, c2, c3], false)!;
    [trunk, c1, c2, c3].forEach((g) => g.dispose());
    trunkTop = 3.0;
  } else if (kind === "stonepine") {
    // Pino piñonero (Pinus pinea): tronco alto y desnudo + copa plana tipo sombrilla.
    const trunk = new THREE.CylinderGeometry(0.34, 0.6, 9.4, 6);
    trunk.translate(0, 4.7, 0);
    const lobes: THREE.BufferGeometry[] = [];
    const spots: [number, number, number, number][] = [
      [0, 11.2, 0, 4.6],
      [-3.1, 10.4, 1.2, 3.4],
      [2.9, 10.7, -1.6, 3.6],
      [0.6, 10.2, 3.2, 3.1],
      [-0.9, 10.5, -3.3, 3.0],
    ];
    for (const [x, y, z, r] of spots) {
      const g = new THREE.IcosahedronGeometry(r, 0);
      g.scale(1, 0.42, 1);
      g.translate(x, y, z);
      lobes.push(g);
    }
    merged = mergeTreeParts([trunk, ...lobes], false)!;
    [trunk, ...lobes].forEach((g) => g.dispose());
    trunkTop = 8.6;
  } else if (kind === "round") {
    const trunk = new THREE.CylinderGeometry(0.26, 0.42, 3.6, 6);
    trunk.translate(0, 1.8, 0);
    const canopy = new THREE.IcosahedronGeometry(2.6, 1);
    canopy.scale(1, 0.85, 1);
    canopy.translate(0, 5.4, 0);
    merged = mergeTreeParts([trunk, canopy], false)!;
    [trunk, canopy].forEach((g) => g.dispose());
    trunkTop = 3.4;
  } else {
    const trunk = new THREE.CylinderGeometry(0.24, 0.4, 3.8, 6);
    trunk.translate(0, 1.9, 0);
    const lobe1 = new THREE.IcosahedronGeometry(1.9, 0);
    lobe1.translate(-1.1, 5.0, 0.3);
    const lobe2 = new THREE.IcosahedronGeometry(2.1, 0);
    lobe2.translate(1.0, 5.6, -0.4);
    const lobe3 = new THREE.IcosahedronGeometry(1.7, 0);
    lobe3.translate(0.1, 6.6, 0.7);
    merged = mergeTreeParts([trunk, lobe1, lobe2, lobe3], false)!;
    [trunk, lobe1, lobe2, lobe3].forEach((g) => g.dispose());
    trunkTop = 3.6;
  }
  paintTree(merged, trunkTop, tint);
  return merged;
}

// A handful of shape/tint combos so the tree canopy of a scattered forest
// looks naturally varied rather than a single repeated instance.
const TREE_VARIANTS: { kind: TreeKind; tint: [number, number, number] }[] = [
  { kind: "conifer", tint: [0.15, 0.34, 0.17] },
  { kind: "conifer", tint: [0.19, 0.4, 0.21] },
  { kind: "round", tint: [0.26, 0.46, 0.22] },
  { kind: "round", tint: [0.32, 0.5, 0.24] },
  { kind: "layered", tint: [0.24, 0.42, 0.2] },
  { kind: "layered", tint: [0.29, 0.47, 0.26] },
];

const TROPICAL_TREE_VARIANTS: { kind: TreeKind; tint: [number, number, number] }[] = [
  { kind: "round", tint: [0.12, 0.3, 0.1] },
  { kind: "round", tint: [0.16, 0.34, 0.12] },
  { kind: "round", tint: [0.1, 0.26, 0.11] },
  { kind: "layered", tint: [0.14, 0.31, 0.13] },
  { kind: "round", tint: [0.2, 0.36, 0.14] },
  { kind: "layered", tint: [0.11, 0.27, 0.12] },
];
const TEMPERATE_TREE_VARIANTS: { kind: TreeKind; tint: [number, number, number] }[] = [
  { kind: "round", tint: [0.16, 0.3, 0.12] },
  { kind: "round", tint: [0.2, 0.34, 0.13] },
  { kind: "round", tint: [0.13, 0.27, 0.12] },
  { kind: "layered", tint: [0.15, 0.3, 0.14] },
  { kind: "conifer", tint: [0.08, 0.2, 0.12] },
  { kind: "round", tint: [0.24, 0.33, 0.12] },
];
const ROME_TREE_VARIANTS: { kind: TreeKind; tint: [number, number, number] }[] = [
  { kind: "stonepine", tint: [0.07, 0.17, 0.09] },
  { kind: "stonepine", tint: [0.09, 0.2, 0.1] },
  { kind: "stonepine", tint: [0.11, 0.23, 0.1] },
  { kind: "stonepine", tint: [0.08, 0.19, 0.11] },
  { kind: "stonepine", tint: [0.1, 0.21, 0.12] },
  { kind: "conifer", tint: [0.07, 0.18, 0.1] }, // cipreses
];

/** Ruido de valor 2D suave (0..1) para agrupar árboles en bosquecillos. */
function valueNoise(x: number, z: number, seed: number): number {
  const h = (ix: number, iz: number) => {
    const v = Math.sin(ix * 127.1 + iz * 311.7 + seed * 74.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = h(ix, iz) * (1 - ux) + h(ix + 1, iz) * ux;
  const b = h(ix, iz + 1) * (1 - ux) + h(ix + 1, iz + 1) * ux;
  return a * (1 - uz) + b * uz;
}

function scatterTrees(
  grid: HeightGrid,
  data: CityData,
  count: number,
  landCoverGrid: LandCoverGrid | null = null,
  pines = false,
  satCanvas: HTMLCanvasElement | null = null
): THREE.Group | null {
  if (count <= 0) return null;

  // Máscara de vegetación a partir del satélite (ExG = 2G − R − B): los árboles
  // se concentran en parques y jardines, como en la escena real, en vez de repartirse parejo.
  let greenMask: { w: number; h: number; data: Uint8Array } | null = null;
  if (satCanvas && pines) {
    try {
      const w = 512;
      const h = Math.max(64, Math.round((512 * satCanvas.height) / satCanvas.width));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const cx = c.getContext("2d", { willReadFrequently: true })!;
      cx.drawImage(satCanvas, 0, 0, w, h);
      const px = cx.getImageData(0, 0, w, h).data;
      const data = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
        const exg = 2 * g - r - b;
        data[i] = exg > 20 && g < 160 ? 2 : exg > 8 && g < 140 ? 1 : 0;
      }
      greenMask = { w, h, data };
    } catch {
      greenMask = null; // canvas "tainted": se usa el reparto por ruido
    }
  }
  const style = regionTreeStyle(data.origin.lat, data.origin.lon);
  const variants = pines
    ? style === "mediterranean"
      ? ROME_TREE_VARIANTS
      : style === "tropical"
        ? TROPICAL_TREE_VARIANTS
        : TEMPERATE_TREE_VARIANTS
    : TREE_VARIANTS;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    flatShading: true,
  });

  const matrix = new THREE.Matrix4();
  const dummy = new THREE.Object3D();

  // Simple rejection sampling over the grid
  const widthM = data.extent.maxX - data.extent.minX;
  const depthM = data.extent.maxZ - data.extent.minZ;
  let placed = 0;
  let attempts = 0;
  const maxAttempts = count * (greenMask ? 24 : 8);
  const seed = (data.origin.lon * 1000 + data.origin.lat * 100) | 0;

  function rand(i: number) {
    const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  // Exclusion zones: buildings (centroid + radius) and dense samples along every road
  const exclude: { x: number; z: number; r: number }[] = [];
  for (const b of data.buildings) {
    const [cx, cz] = centroid(b.ring);
    const area = ringArea(b.ring);
    const r = Math.sqrt(area / Math.PI) * 1.35 + 4;
    exclude.push({ x: cx, z: cz, r });
  }
  for (const road of data.roads) {
    if (road.path.length < 2) continue;
    const clearR = Math.max(road.width * 0.6 + 3.5, 5);
    // Sample every ~8 m along the path so trees never sit on carriageways
    let acc = 0;
    exclude.push({ x: road.path[0][0], z: road.path[0][1], r: clearR });
    for (let i = 1; i < road.path.length; i++) {
      const a = road.path[i - 1];
      const b = road.path[i];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      acc += seg;
      if (acc >= 8 || i === road.path.length - 1) {
        exclude.push({ x: b[0], z: b[1], r: clearR });
        acc = 0;
      }
    }
  }
  for (const w of data.water.slice(0, 200)) {
    for (const ring of w.rings.slice(0, 1)) {
      const [cx, cz] = centroid(ring);
      const area = ringArea(ring);
      exclude.push({ x: cx, z: cz, r: Math.sqrt(area / Math.PI) * 1.1 + 6 });
    }
  }

  // Rejilla espacial: con decenas de miles de exclusiones, el barrido lineal por
  // cada intento era inviable. Cada círculo se registra en las celdas que toca.
  const CELL = 32;
  const cellKey = (cx: number, cz: number) => cx * 73856093 ^ cz * 19349663;
  const grid2 = new Map<number, { x: number; z: number; r: number }[]>();
  for (const e of exclude) {
    const x0 = Math.floor((e.x - e.r) / CELL), x1 = Math.floor((e.x + e.r) / CELL);
    const z0 = Math.floor((e.z - e.r) / CELL), z1 = Math.floor((e.z + e.r) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = cellKey(cx, cz);
        const arr = grid2.get(k);
        if (arr) arr.push(e);
        else grid2.set(k, [e]);
      }
    }
  }
  const isExcluded = (x: number, z: number) => {
    const list = grid2.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return false;
    for (const e of list) if (Math.hypot(x - e.x, z - e.z) < e.r) return true;
    return false;
  };

  const buckets: THREE.Matrix4[][] = variants.map(() => []);

  while (placed < count && attempts < maxAttempts) {
    attempts++;
    const u = rand(attempts * 2);
    const v = rand(attempts * 2 + 1);
    const x = data.extent.minX + u * widthM;
    const z = data.extent.minZ + v * depthM; // feature-local Z (north → negative)

    const h = heightAtFeature(grid, x, z);

    // Slope estimate in feature space
    const eps = 8;
    const hx = heightAtFeature(grid, x + eps, z) - heightAtFeature(grid, x - eps, z);
    const hz = heightAtFeature(grid, x, z + eps) - heightAtFeature(grid, x, z - eps);
    const slope = Math.hypot(hx, hz) / (2 * eps);
    if (slope > cfg.TREE_MAX_SLOPE) continue;

    // Exclusion: no trees on roads, buildings, or water
    if (isExcluded(x, z)) continue;

    // Where we have ESA WorldCover, only let trees grow on vegetated/land
    // pixels — never on built-up, water, or snow/ice classification.
    if (landCoverGrid) {
      const [lon, lat] = unproject(x, z, data.origin.lon, data.origin.lat);
      const cls = sampleLandCoverClass(landCoverGrid, lon, lat);
      if (cls !== 0 && isBuiltOrWaterClass(cls)) continue;
    }

    if (greenMask) {
      const mu = Math.min(greenMask.w - 1, Math.max(0, Math.floor(((x - data.extent.minX) / widthM) * greenMask.w)));
      const mv = Math.min(greenMask.h - 1, Math.max(0, Math.floor(((z - data.extent.minZ) / depthM) * greenMask.h)));
      const g = greenMask.data[mv * greenMask.w + mu];
      if (g === 0 && rand(attempts * 11) > 0.015) continue; // casi nunca fuera de zonas verdes
      if (g === 1 && rand(attempts * 13) > 0.35) continue;
    } else if (pines) {
      const n = valueNoise(x / 90, z / 90, seed) * 0.65 + valueNoise(x / 35, z / 35, seed + 3) * 0.35;
      if (n < 0.5 && rand(attempts * 7) > 0.1) continue;
    }

    // Slight random scale / rotation / variant pick, and cluster same-variant
    // trees loosely (real forests aren't a uniform shuffle of species).
    const s = pines ? (greenMask ? 0.7 : 0.7) + rand(attempts * 3) * 0.55 : 0.65 + rand(attempts * 3) * 1.0;
    const rot = rand(attempts * 4) * Math.PI * 2;
    const clusterSeed = Math.floor(x / 40) * 13 + Math.floor(z / 40) * 7;
    const variantT = (rand(clusterSeed) * 0.7 + rand(attempts * 5) * 0.3) % 1;
    const variantIdx = Math.min(variants.length - 1, Math.floor(variantT * variants.length));

    dummy.position.set(x, h, z);
    dummy.rotation.set(0, rot, 0);
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    buckets[variantIdx].push(dummy.matrix.clone());
    placed++;
  }

  const group = new THREE.Group();
  group.name = "trees";
  for (let vi = 0; vi < variants.length; vi++) {
    const list = buckets[vi];
    if (!list.length) continue;
    const geometry = createTreeGeometry(variants[vi].kind, variants[vi].tint);
    const im = new THREE.InstancedMesh(geometry, material, list.length);
    im.castShadow = true;
    im.receiveShadow = true;
    for (let i = 0; i < list.length; i++) im.setMatrixAt(i, list[i]);
    im.instanceMatrix.needsUpdate = true;
    im.count = list.length;
    group.add(im);
  }

  if (placed === 0) {
    material.dispose();
    return null;
  }
  return group;
}

export type CityMeshes = {
  group: THREE.Group;
  buildings?: THREE.Mesh;
  roofs?: THREE.Mesh;
  roads?: THREE.Mesh;
  water?: THREE.Mesh;
  ports?: THREE.Mesh;
  coastline?: THREE.Mesh;
  terrain: THREE.Mesh;
  trees?: THREE.Group;
  stats: { buildings: number; roads: number; water: number; ports: number; vertices: number; trees?: number };
  heightGrid?: HeightGrid | null;
  /** Rótulos Cinzel (fuera de `group`, no se exportan al GLB). */
  labels?: THREE.Group;
};

export type BuildSceneOptions = {
  /** Trees per m². Defaults to cfg.TREE_DENSITY. */
  treeDensity?: number;
  /** Drape Esri World Imagery (no API key) onto the terrain. */
  satellite?: boolean;
  /**
   * Drape ESA WorldCover land-cover classification (no API key) onto the
   * terrain as its "biological/physical material" — tree cover, grassland,
   * cropland, built-up, bare ground, water, etc. Takes priority over
   * `satellite` when both are enabled, and also gates where trees can grow.
   */
  landCover?: boolean;
  /** Modo Roma: monumentos, rótulos, estatuas, PBR, SRTM, satélite HD. */
  rome?: RomeOptions;
  /** Called with overall meshing fraction 0–1 and a stage label. */
  onProgress?: (fraction: number, label: string) => void;
};

export type RomeOptions = {
  landmarks: boolean;
  labels: boolean;
  statues: boolean;
  pbr: boolean;
  srtm: boolean;
  hdSatellite: boolean;
  /** Pinos piñoneros densos y en bosquecillos. */
  vegetation: boolean;
  /** Cielo con nubes, neblina y luz cálida (lo aplica el visor). */
  atmosphere: boolean;
  /** Paleta mediterránea: muros ocre/crema/terracota, tejas, techos planos sin rejilla. */
  warmBuildings: boolean;
};

export async function buildCityMeshes(
  data: CityData,
  options: BuildSceneOptions = {}
): Promise<CityMeshes> {
  const group = new THREE.Group();
  group.name = "CityGLB";

  const treeDensity =
    options.treeDensity !== undefined && Number.isFinite(options.treeDensity)
      ? Math.max(0, options.treeDensity)
      : cfg.TREE_DENSITY;
  const wantSatellite = Boolean(options.satellite);
  const wantLandCover = Boolean(options.landCover);
  const onProgress = options.onProgress;
  const rome = options.rome;
  group.userData.credits = CREDITS;
  WARM = Boolean(rome?.warmBuildings);
  {
    const warmRegion = regionIsWarm(data.origin.lat, data.origin.lon);
    FACADES = warmRegion ? WARM_FACADES : NEUTRAL_FACADES;
    ROOFS = warmRegion ? WARM_ROOFS : NEUTRAL_ROOFS;
  }

  // Elevación, cobertura y satélite dependen solo del bbox: normalmente ya se están
  // descargando desde que se pulsó "Generate" (ver prefetch.ts).
  const assets = getCityAssets(data.bbox, {
    satellite: wantSatellite,
    landCover: wantLandCover,
    hdSatellite: Boolean(rome?.hdSatellite),
    pbr: Boolean(rome?.pbr),
    flatTerrain: Boolean(cfg.FLAT_TERRAIN),
  });
  const elevPromise = assets.elev;
  const coverPromise = assets.cover;
  const satPromise = assets.sat;
  onProgress?.(0.1, "Loading terrain data…");

  const [grid, landCoverGrid] = await Promise.all([elevPromise, coverPromise]);
  let satCanvasForTrees: HTMLCanvasElement | null = null;
  onProgress?.(0.55, "Building terrain…");

  const buildingMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.04,
    flatShading: true,
    color: 0xffffff,
  });
  if (cfg.ENABLE_WINDOWS) {
    try {
      buildingMat.map = createWindowTexture(WARM);
      buildingMat.normalMap = createWindowNormalMap();
      buildingMat.normalScale = new THREE.Vector2(WARM ? 0.2 : 0.6, WARM ? 0.2 : 0.6);
      buildingMat.needsUpdate = true;
    } catch (e) {
      console.warn("Window texture failed", e);
    }
  }
  const roadMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0,
    flatShading: true,
    // Pull roads toward the camera in the depth buffer so they win against
    // coplanar / near-coplanar terrain triangles (z-fighting).
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    depthWrite: true,
  });
  const roofMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.75,
    metalness: 0.02,
    flatShading: true,
    color: 0xffffff,
  });
  const waterMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().fromArray([...cfg.WATER_COLOR]),
    roughness: 0.18,
    metalness: 0.22,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  });
  const portMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.05,
    flatShading: true,
    color: 0xffffff,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const coastlineMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
    color: 0xffffff,
  });
  const terrainMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().fromArray([...cfg.TERRAIN_COLOR]),
    roughness: 1,
    metalness: 0,
    flatShading: !wantSatellite && !wantLandCover,
    // FrontSide once normals are guaranteed +Y; avoids the dark "backface"
    // look when viewing the terrain from above with inverted lighting.
    side: THREE.DoubleSide,
  });

  const terrainGeo = grid
    ? terrainGeometryFromGrid(grid, data.extent)
    : flatTerrainGeometry(data);
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.name = "terrain";
  terrainMesh.receiveShadow = true;
  group.add(terrainMesh);

  // Land cover (ESA WorldCover) takes priority as the ground material since
  // it's a classification, not just an image — it also drives tree gating
  // below. Falls back to satellite imagery if land cover wasn't requested
  // or failed to load.
  if (wantLandCover && landCoverGrid) {
    try {
      const canvas = buildLandCoverCanvas(landCoverGrid);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      terrainMat.map = tex;
      terrainMat.color.set(0xffffff);
      // Photo/class textures look crushed under full PBR roughness + ACES.
      // Slightly lower roughness and a gentle emissive lift keep albedo readable
      // from above without washing out relief shading.
      terrainMat.roughness = 0.78;
      terrainMat.metalness = 0;
      terrainMat.emissiveMap = tex;
      terrainMat.emissive.setHex(0xffffff);
      terrainMat.emissiveIntensity = 0.22;
      terrainMat.flatShading = false;
      terrainMat.needsUpdate = true;
    } catch (e) {
      console.warn("Land cover texture failed", e);
    }
  } else if (wantSatellite) {
    try {
      const canvas = await satPromise;
      if (canvas) {
        satCanvasForTrees = canvas;
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 16; // three lo limita al máximo de la GPU
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.userData.mimeType = "image/jpeg"; // foto: JPEG en el GLB (un PNG de 8192² pesaría ~100 MB)
        tex.needsUpdate = true;
        terrainMat.map = tex;
        terrainMat.color.set(0xffffff);
        terrainMat.roughness = 0.78;
        terrainMat.metalness = 0;
        terrainMat.emissiveMap = tex;
        terrainMat.emissive.setHex(0xffffff);
        terrainMat.emissiveIntensity = 0.28;
        terrainMat.flatShading = false;
        terrainMat.needsUpdate = true;
      }
    } catch (e) {
      console.warn("Satellite texture failed", e);
    }
  }

  onProgress?.(0.62, "Extruding buildings…");

  let vertices = terrainMesh.geometry.getAttribute("position").count;

  let buildingsMesh: THREE.Mesh | undefined;
  let roofsMesh: THREE.Mesh | undefined;
  let roadsMesh: THREE.Mesh | undefined;
  let waterMesh: THREE.Mesh | undefined;
  let portsMesh: THREE.Mesh | undefined;
  let coastlineMesh: THREE.Mesh | undefined;
  let treesMesh: THREE.Group | undefined;
  let treeStatsCount = 0;

  // Colosseo procedural: sustituye el bloque extruido de OSM/Overture.
  let buildingsForMesh = data.buildings;
  let colosseumGroup: THREE.Group | undefined;
  if (rome?.landmarks) {
    const [lx, lz] = project(COLOSSEUM.lon, COLOSSEUM.lat, data.origin.lon, data.origin.lat);
    const inside =
      lx > data.extent.minX - 100 && lx < data.extent.maxX + 100 && lz > data.extent.minZ - 100 && lz < data.extent.maxZ + 100;
    if (inside) {
      const found = findColosseumBuilding(data.buildings, lx, lz);
      let fit: EllipseFit;
      if (found) {
        fit = found.fit;
        buildingsForMesh = data.buildings.filter((_, i) => i !== found.index);
      } else {
        console.warn("[rome] Colosseo no encontrado en los datos; se usa posición y orientación aproximadas.");
        const bearing = (COLOSSEUM.fallbackBearingDeg * Math.PI) / 180;
        fit = { cx: lx, cz: lz, a: COLOSSEUM.semiMajor, b: COLOSSEUM.semiMinor, angle: Math.atan2(-Math.cos(bearing), Math.sin(bearing)) };
      }
      const ring: [number, number][] = [];
      for (let k = 0; k < 24; k++) {
        const t = (k / 24) * Math.PI * 2;
        ring.push([fit.cx + Math.cos(t) * fit.a * Math.cos(fit.angle) - Math.sin(t) * fit.b * Math.sin(fit.angle),
                   fit.cz + Math.cos(t) * fit.a * Math.sin(fit.angle) + Math.sin(t) * fit.b * Math.cos(fit.angle)]);
      }
      const baseY = (grid ? footprintMinHeight(grid, ring) : 0) - 0.3;
      colosseumGroup = buildColosseum({ fit, baseY });
      group.add(colosseumGroup);
      vertices += 40000;
    }
  }

  const roofSampler = satCanvasForTrees ? createRoofSampler(satCanvasForTrees, data.extent) : null;
  const { walls: bGeo, roofs: roofGeo } = buildingsGeometry(buildingsForMesh, grid, roofSampler);
  if (bGeo) {
    buildingsMesh = new THREE.Mesh(bGeo, buildingMat);
    buildingsMesh.name = "buildings";
    buildingsMesh.castShadow = true;
    buildingsMesh.receiveShadow = true;
    group.add(buildingsMesh);
    vertices += bGeo.getAttribute("position").count;
  }
  if (roofGeo) {
    roofsMesh = new THREE.Mesh(roofGeo, roofMat);
    roofsMesh.name = "roofs";
    roofsMesh.castShadow = true;
    roofsMesh.receiveShadow = true;
    group.add(roofsMesh);
    vertices += roofGeo.getAttribute("position").count;
  }

  onProgress?.(0.75, "Meshing water…");

  const wGeo = waterGeometry(data.water, grid);
  if (wGeo) {
    waterMesh = new THREE.Mesh(wGeo, waterMat);
    waterMesh.name = "water";
    waterMesh.renderOrder = 1;
    group.add(waterMesh);
    vertices += wGeo.getAttribute("position").count;
  }

  onProgress?.(0.8, "Meshing ports & coastline…");

  const pGeo = portGeometry(data.ports, grid);
  if (pGeo) {
    portsMesh = new THREE.Mesh(pGeo, portMat);
    portsMesh.name = "ports";
    portsMesh.renderOrder = 2;
    group.add(portsMesh);
    vertices += pGeo.getAttribute("position").count;
  }

  const cGeo = coastlineGeometry(data.coastline, grid);
  if (cGeo) {
    coastlineMesh = new THREE.Mesh(cGeo, coastlineMat);
    coastlineMesh.name = "coastline";
    coastlineMesh.renderOrder = 2;
    group.add(coastlineMesh);
    vertices += cGeo.getAttribute("position").count;
  }

  onProgress?.(0.85, "Meshing roads…");

  const rGeo = roadsGeometry(data.roads, grid);
  if (rGeo && rome?.pbr) {
    const pbr = await loadPolyHavenPbr("cobblestone_floor_001", 1 / 2);
    if (pbr) {
      applyPlanarUV(rGeo, 2.2);
      liftVertexColors(rGeo, 2.6);
      roadMat.map = pbr.map;
      roadMat.normalMap = pbr.normalMap;
      roadMat.normalScale = new THREE.Vector2(0.9, 0.9);
      roadMat.roughnessMap = pbr.roughnessMap;
      roadMat.roughness = 1;
      roadMat.flatShading = false;
      roadMat.needsUpdate = true;
    }
  }
  if (rGeo) {
    roadsMesh = new THREE.Mesh(rGeo, roadMat);
    roadsMesh.name = "roads";
    roadsMesh.renderOrder = 2; // after terrain & water
    group.add(roadsMesh);
    vertices += rGeo.getAttribute("position").count;
  }

  onProgress?.(0.93, "Placing trees…");

  // Trees
  if (cfg.ENABLE_TREES && grid && treeDensity > 0) {
    const area = (data.extent.maxX - data.extent.minX) * (data.extent.maxZ - data.extent.minZ);
    const dense = Boolean(rome?.vegetation);
    // Con máscara verde del satélite se sube mucho la densidad: solo cae en parques.
    const mult = dense ? (satCanvasForTrees ? 6 : 2.4) : 1;
    const desired = Math.min(dense ? cfg.MAX_TREES * 1.5 : cfg.MAX_TREES, Math.floor(area * treeDensity * mult));
    treesMesh = scatterTrees(grid, data, desired, landCoverGrid, dense, satCanvasForTrees) ?? undefined;
    if (treesMesh) {
      group.add(treesMesh);
      let treeVerts = 0;
      let treeCount = 0;
      treesMesh.traverse((obj) => {
        const im = obj as THREE.InstancedMesh;
        if ((im as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) {
          treeVerts += im.geometry.getAttribute("position").count * (im.count || 0);
          treeCount += im.count || 0;
        }
      });
      vertices += treeVerts;
      treeStatsCount = treeCount;
    }
  }

  const groundAt = (x: number, z: number) => (grid ? heightAtFeature(grid, x, z) : 0);
  const inExtent = (x: number, z: number) =>
    x > data.extent.minX && x < data.extent.maxX && z > data.extent.minZ && z < data.extent.maxZ;

  if (rome?.statues) {
    onProgress?.(0.96, "Placing statues…");
    const { buildStatues } = await import("./statues");
    const slots = ROME_STATUE_SLOTS.map((sl) => {
      const [x, z] = project(sl.lon, sl.lat, data.origin.lon, data.origin.lat);
      return { ...sl, x, z, groundY: groundAt(x, z) };
    }).filter((sl) => inExtent(sl.x, sl.z));
    if (slots.length) {
      const { group: sg, placed } = await buildStatues(slots);
      if (placed > 0) group.add(sg);
      else console.info("[rome] Sin estatuas: coloca GLB en public/models/statues/ (ver README).");
    }
  }

  let labelsGroup: THREE.Group | undefined;
  if (rome?.labels) {
    onProgress?.(0.98, "Lettering…");
    const { buildLabels } = await import("./labels");
    const items = ROME_LANDMARKS.map((lm) => {
      const [x, z] = project(lm.lon, lm.lat, data.origin.lon, data.origin.lat);
      return { text: lm.label, x, z, groundY: groundAt(x, z), height: lm.labelHeight };
    }).filter((it) => inExtent(it.x, it.z));
    if (items.length) labelsGroup = await buildLabels(items);
  }

  onProgress?.(0.99, "Finalizing…");

  return {
    group,
    buildings: buildingsMesh,
    roofs: roofsMesh,
    roads: roadsMesh,
    water: waterMesh,
    ports: portsMesh,
    coastline: coastlineMesh,
    terrain: terrainMesh,
    trees: treesMesh,
    stats: {
      buildings: data.buildings.length,
      roads: data.roads.length,
      water: data.water.length,
      ports: data.ports.length,
      vertices,
      trees: treeStatsCount,
    },
    heightGrid: grid,
    labels: labelsGroup,
  };
}

export function disposeCityMeshes(meshes: CityMeshes): void {
  meshes.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
}
