import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BUILDING_TINTS, FACADE_PALETTES, ROOF_TINTS, cfg } from "./config";
import { bboxSizeMeters, ringArea, unproject } from "./geo";
import type { BuildingFeature, CityData } from "./types";
import type { FacadeMaterial } from "./ai-schema";
import { fetchHeightGrid, sampleHeight, type HeightGrid } from "./elevation";
import { buildSatelliteCanvas } from "./satellite";
import { getCityAssets } from "./prefetch";
import { MATERIAL_TINT, createFacadeMaterial } from "./facade-materials";
import { buildWaterMesh } from "./water";
import { analyzeVegetation } from "./vegetation";
import { flattenTerrain } from "./flatten";
import { buildBridges, collectBridges } from "./bridges";
import { buildTunnels, openCutRoads, planTunnels, type TunnelPlan } from "./tunnels";
import { buildVegetation } from "./vegetation-gl";
import type { SeaMaterial, WaterConfig } from "./water-material";
import { computeOBB, createRoofSampler, fanRoof, isConvex, ridgeRoof, type OBB, type RoofSampler } from "./roofs";
import type { RGB, RoofShape } from "./roof-data";

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

/** Individualized facade color: palette variant per kind, shaded slightly by height. */
function buildingColor(b: BuildingFeature): [number, number, number] {
  if (b.facade) return b.facade;
  if (b.material) {
    const m = MATERIAL_TINT[b.material];
    const j = 0.93 + buildingHash(b) * 0.14;
    return [Math.min(1, m[0] * j), Math.min(1, m[1] * j), Math.min(1, m[2] * j)];
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
    const prob = sat ? (isTerracotta(sat) ? 1 : 0.12) : 0.45;
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
): { walls: Map<string, THREE.BufferGeometry>; roofs: THREE.BufferGeometry | null } {
  const wallGeos = new Map<string, THREE.BufferGeometry[]>();
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
        const flat: RGB | null = rGeo ? null : sat || b.roof?.color ? roofCol : null;
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
    {
      const k = b.material ?? "default";
      const list = wallGeos.get(k);
      if (list) list.push(geo);
      else wallGeos.set(k, [geo]);
    }

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
  const walls = new Map<string, THREE.BufferGeometry>();
  for (const [k, list] of wallGeos) {
    const g = mergeOrEmpty(list);
    if (g) walls.set(k, g);
  }
  return { walls, roofs: mergeOrEmpty(roofGeos) };
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
function createWindowTexture(): THREE.Texture {
  if (cachedWindowTexture) return cachedWindowTexture;
  const size = cfg.WINDOW_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#e9e6df";
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
      const shade = 92 + Math.round(((c * 7 + r * 13) % 5) * 8); // vidrio gris azulado, no negro
      ctx.fillStyle = `rgb(${shade + 8}, ${shade + 18}, ${shade + 32})`;
      ctx.fillRect(x, y, winW, winH);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
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
  tex.repeat.set(1 / cfg.FACADE_METERS_PER_TILE, 1 / cfg.FACADE_METERS_PER_TILE);
  tex.needsUpdate = true;
  cachedWindowTexture = tex;
  return tex;
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

export type CityMeshes = {
  group: THREE.Group;
  /** Un mesh por material de fachada (el "default" lleva la textura de ventanas). */
  buildings: THREE.Mesh[];
  roofs?: THREE.Mesh;
  terrain: THREE.Mesh;
  water?: THREE.Mesh;
  /** Árboles (modelo 3D instanciado + malla simple de respaldo). */
  trees?: THREE.Object3D;
  /** Césped instanciado en zonas verdes sin árboles. */
  grass?: THREE.Object3D;
  /** Puentes (tablero, parapetos, pilas). */
  bridges?: THREE.Object3D;
  /** Altura del tablero de un puente en (x,z), o null si no hay puente ahí. */
  deckAt?: (x: number, z: number) => number | null;
  /** Túneles (interior con luminarias, portales, trincheras). */
  tunnels?: THREE.Object3D;
  /** Cotas por las que puede circular un vehículo en (x,z): tablero de puente y/o solera de túnel. */
  surfacesAt?: (x: number, z: number) => number[];
  /** Avanza animaciones (olas, viento). Llamar cada fotograma con el tiempo en segundos. */
  update?: (timeSec: number) => void;
  /** Pasa al agua el sol y el cielo de la escena para sus reflejos. */
  configureWater?: (c: WaterConfig) => void;
  stats: { buildings: number; vertices: number; aiBuildings: number; trees: number; treeModels: number; grassPatches: number; waterBodies: number; bridges: number; tunnels: number; streetBuildings: number; streetMaterials: number };
  heightGrid?: HeightGrid | null;
};

export type BuildSceneOptions = {
  /** Drape Esri World Imagery (no API key) onto the terrain. */
  satellite?: boolean;
  /** Modo realista: satélite HD y cielo. */
  realistic?: RealisticOptions;
  /** Called with overall meshing fraction 0–1 and a stage label. */
  onProgress?: (fraction: number, label: string) => void;
};

export type RealisticOptions = {
  hdSatellite: boolean;
  /** Cielo con nubes, neblina y luz cálida (lo aplica el visor). */
  atmosphere: boolean;
};

export async function buildCityMeshes(
  data: CityData,
  options: BuildSceneOptions = {}
): Promise<CityMeshes> {
  const group = new THREE.Group();
  group.name = "CityGLB";

  const wantSatellite = Boolean(options.satellite);
  const onProgress = options.onProgress;
  const realistic = options.realistic;

  // Elevación, cobertura y satélite dependen solo del bbox: normalmente ya se están
  // descargando desde que se pulsó "Generate" (ver prefetch.ts).
  const assets = getCityAssets(data.bbox, {
    satellite: wantSatellite,
    hdSatellite: Boolean(realistic?.hdSatellite),
    flatTerrain: Boolean(cfg.FLAT_TERRAIN),
  });
  const elevPromise = assets.elev;
  const satPromise = assets.sat;
  onProgress?.(0.1, "Loading terrain data…");

  const rawGrid = await elevPromise;
  let gridW = rawGrid; // se reasigna (aplanado, túneles); luego se congela en `grid`
  if (rawGrid && cfg.FLATTEN_URBAN) {
    try {
      onProgress?.(0.3, "Flattening urban terrain…");
      const f = flattenTerrain(rawGrid, data);
      gridW = f.grid;
      console.info("[flatten]", f.stats);
    } catch (e) {
      console.warn("Flatten failed; using raw terrain", e);
    }
  }
  let satCanvas: HTMLCanvasElement | null = null;
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
      buildingMat.map = createWindowTexture();
      buildingMat.normalMap = createWindowNormalMap();
      buildingMat.normalScale = new THREE.Vector2(0.6, 0.6);
      buildingMat.needsUpdate = true;
    } catch (e) {
      console.warn("Window texture failed", e);
    }
  }
  const roofMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.75,
    metalness: 0.02,
    flatShading: true,
    color: 0xffffff,
  });
  const terrainMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().fromArray([...cfg.TERRAIN_COLOR]),
    roughness: 1,
    metalness: 0,
    flatShading: !wantSatellite,
    // FrontSide once normals are guaranteed +Y; avoids the dark "backface"
    // look when viewing the terrain from above with inverted lighting.
    side: THREE.DoubleSide,
  });

  // Túneles: planifica rasante y talla las trincheras en la malla de alturas ANTES de crear el terreno
  let tunnelPlans: TunnelPlan[] = [];
  if (gridW && data.roads?.some((r) => r.tunnel)) {
    try {
      onProgress?.(0.5, "Planning tunnels…");
      const tp = planTunnels(data, gridW);
      gridW = tp.grid;
      tunnelPlans = tp.plans;
    } catch (e) {
      console.warn("Tunnels planning failed", e);
    }
  }

  const grid = gridW;
  const terrainGeo = grid
    ? terrainGeometryFromGrid(grid, data.extent)
    : flatTerrainGeometry(data);
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.name = "terrain";
  terrainMesh.receiveShadow = true;
  group.add(terrainMesh);

  if (wantSatellite) {
    try {
      const canvas = await satPromise;
      if (canvas) {
        satCanvas = canvas;
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

  const buildingMeshes: THREE.Mesh[] = [];
  let roofsMesh: THREE.Mesh | undefined;

  const buildingsForMesh = data.buildings;

  const roofSampler = satCanvas ? createRoofSampler(satCanvas, data.extent) : null;
  const { walls: bGeo, roofs: roofGeo } = buildingsGeometry(buildingsForMesh, grid, roofSampler);
  for (const [kind, geo] of bGeo) {
    const mat = kind === "default" ? buildingMat : createFacadeMaterial(kind as FacadeMaterial);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = kind === "default" ? "buildings" : `buildings-${kind}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    buildingMeshes.push(mesh);
    vertices += geo.getAttribute("position").count;
  }
  if (roofGeo) {
    roofsMesh = new THREE.Mesh(roofGeo, roofMat);
    roofsMesh.name = "roofs";
    roofsMesh.castShadow = true;
    roofsMesh.receiveShadow = true;
    group.add(roofsMesh);
    vertices += roofGeo.getAttribute("position").count;
  }

  // Agua real y vegetación (cada una aislada: si falla, la escena sigue)
  const groundAt = grid ? (x: number, z: number) => heightAtFeature(grid, x, z) : null;
  let waterMesh: THREE.Mesh | undefined;
  let waterBodies = 0;
  if (data.water?.length) {
    try {
      onProgress?.(0.9, "Building water…");
      const w = buildWaterMesh(data.water, data.extent, groundAt ?? (() => 0), roofSampler);
      if (w) {
        waterMesh = w.mesh;
        waterBodies = w.count;
        group.add(w.mesh);
        vertices += w.mesh.geometry.getAttribute("position").count;
      }
    } catch (e) {
      console.warn("Water failed", e);
    }
  }
  let bridgesObj: THREE.Object3D | undefined;
  let deckAt: ((x: number, z: number) => number | null) | undefined;
  let bridgeCount = 0;
  if (data.roads?.length) {
    try {
      onProgress?.(0.92, "Building bridges…");
      const b = buildBridges(collectBridges(data), groundAt);
      if (b) {
        bridgesObj = b.group;
        deckAt = b.deckAt;
        bridgeCount = b.count;
        group.add(b.group);
        vertices += (b.group.children[0] as THREE.Mesh).geometry.getAttribute("position").count;
      }
    } catch (e) {
      console.warn("Bridges failed", e);
    }
  }
  let tunnelsObj: THREE.Object3D | undefined;
  let tunnelFloorAt: ((x: number, z: number) => number | null) | undefined;
  let tunnelCount = 0;
  if (tunnelPlans.length) {
    try {
      onProgress?.(0.93, "Building tunnels…");
      const t = buildTunnels(tunnelPlans);
      if (t) {
        tunnelsObj = t.group;
        tunnelFloorAt = t.floorAt;
        tunnelCount = t.count;
        group.add(t.group);
        t.group.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) vertices += m.geometry.getAttribute("position").count;
        });
      }
    } catch (e) {
      console.warn("Tunnels failed", e);
    }
  }
  let treesObj: THREE.Object3D | undefined;
  let grassObj: THREE.Object3D | undefined;
  let treeCount = 0;
  let treeModels = 0;
  let grassPatches = 0;
  let vegTick: ((t: number) => void) | undefined;
  // los árboles crecen SOBRE los túneles (no se apartan), pero no dentro de las trincheras abiertas
  const vegData: CityData = { ...data, roads: [...(data.roads ?? []).filter((r) => !r.tunnel), ...openCutRoads(tunnelPlans)] };
  if (satCanvas || data.osmTrees?.length) {
    try {
      onProgress?.(0.94, "Placing vegetation…");
      const veg = satCanvas
        ? analyzeVegetation(satCanvas, vegData, roofSampler)
        : { trees: [], grass: [], coverUsed: false };
      const built = await buildVegetation(veg.trees, veg.grass, groundAt, {
        x: (data.extent.minX + data.extent.maxX) / 2,
        z: (data.extent.minZ + data.extent.maxZ) / 2,
      });
      treeModels = built.treeModels;
      grassPatches = built.grassCount;
      vegTick = built.tick;
      if (built.trees) {
        treesObj = built.trees;
        treeCount = veg.trees.length;
        group.add(built.trees);
      }
      if (built.grass) {
        grassObj = built.grass;
        group.add(built.grass);
      }
      vertices += built.vertices;
    } catch (e) {
      console.warn("Vegetation failed", e);
    }
  }

  onProgress?.(0.99, "Finalizing…");

  return {
    group,
    buildings: buildingMeshes,
    roofs: roofsMesh,
    terrain: terrainMesh,
    water: waterMesh,
    trees: treesObj,
    grass: grassObj,
    bridges: bridgesObj,
    deckAt,
    tunnels: tunnelsObj,
    surfacesAt: (x, z) => {
      const out: number[] = [];
      const d = deckAt?.(x, z);
      if (d != null) out.push(d);
      const t = tunnelFloorAt?.(x, z);
      if (t != null) out.push(t);
      return out;
    },
    update: (t) => {
      if (waterMesh) (waterMesh.material as SeaMaterial).tick?.(t);
      vegTick?.(t);
    },
    configureWater: (c) => {
      if (waterMesh) (waterMesh.material as SeaMaterial).configure?.(c);
    },
    stats: {
      buildings: data.buildings.length,
      vertices,
      aiBuildings: data.buildings.reduce((n, b) => n + (b.ai ? 1 : 0), 0),
      trees: treeCount,
      treeModels,
      grassPatches,
      waterBodies,
      bridges: bridgeCount,
      tunnels: tunnelCount,
      streetBuildings: data.buildings.reduce((n, b) => n + (b.street ? 1 : 0), 0),
      streetMaterials: data.buildings.reduce((n, b) => n + (b.streetMaterial ? 1 : 0), 0),
    },
    heightGrid: grid,
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
