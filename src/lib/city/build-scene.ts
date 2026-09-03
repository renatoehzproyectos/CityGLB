import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BUILDING_TINTS, cfg } from "./config";
import { bboxSizeMeters, ringArea, unproject } from "./geo";
import type { BuildingFeature, CityData, CoastlineFeature, PortFeature, RoadFeature, WaterFeature } from "./types";
import { fetchHeightGrid, sampleHeight, type HeightGrid } from "./elevation";
import { buildSatelliteCanvas } from "./satellite";
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

function buildingColor(b: BuildingFeature): [number, number, number] {
  const base = BUILDING_TINTS[b.kind] ?? cfg.BUILDING_COLOR;
  const t = Math.min(1, Math.max(0, (b.height - 8) / 80));
  return [
    base[0] * (1 - t * 0.12),
    base[1] * (1 - t * 0.08),
    base[2] * (1 - t * 0.02) + t * 0.04,
  ];
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
  const merged = mergeGeometries(geos, false);
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

function buildingsGeometry(features: BuildingFeature[], grid: HeightGrid | null): THREE.BufferGeometry | null {
  const geos: THREE.BufferGeometry[] = [];
  for (const b of features) {
    if (b.height < cfg.MIN_BUILDING_HEIGHT) continue;
    if (ringArea(b.ring) < cfg.MIN_BUILDING_AREA) continue;
    const shape = toShape(b.ring, b.holes);
    if (!shape) continue;
    const geo = extrudeShape(shape, b.height);
    if (!geo) continue;
    if (grid) {
      // Rigid vertical lift to the lowest ground under the footprint so walls stay
      // straight and nothing floats or sinks through the terrain.
      const h = footprintMinHeight(grid, b.ring);
      geo.translate(0, h, 0);
    }
    paintGeometry(geo, buildingColor(b));
    geos.push(geo);
  }
  return mergeOrEmpty(geos);
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
  const indices: number[] = [];
  // Clearance above DEM: coarse elevation grids (15–40 m) can undershoot the
  // rendered terrain triangle by several decimeters; keep roads clearly on top.
  const LIFT = 0.35;

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
    const lx = x + nx * halfWidth;
    const lz = z + nz * halfWidth;
    const rx = x - nx * halfWidth;
    const rz = z - nz * halfWidth;

    let yL = LIFT;
    let yR = LIFT;
    if (grid) {
      const hL = heightAtFeature(grid, lx, lz);
      const hR = heightAtFeature(grid, rx, rz);
      const hC = heightAtFeature(grid, x, z);
      // Use max of center + edges so neither side sinks into a slope
      const base = Math.max(hL, hR, hC);
      yL = base + LIFT;
      yR = base + LIFT;
    }

    positions.push(lx, yL + thickness, lz);
    positions.push(rx, yR + thickness, rz);
  }

  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b);
    indices.push(b, c, d);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
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

// Simple procedural tree (fallback if EZ-Tree not loaded). Trunk + foliage.
function createSimpleTreeGeometry(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  const trunk = new THREE.CylinderGeometry(0.25, 0.4, 4, 6);
  trunk.translate(0, 2, 0);
  const foliage = new THREE.ConeGeometry(2.2, 5, 7);
  foliage.translate(0, 5.5, 0);
  const merged = mergeGeometries([trunk, foliage], false)!;
  trunk.dispose();
  foliage.dispose();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x3d6b3a,
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
  });
  // Color trunk darker via vertex colors? For simplicity uniform greenish, or separate but for instancing one mat.
  // Better two materials but InstancedMesh one. Use vertex colors.
  const count = merged.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  // Rough: lower half trunk brown
  const pos = merged.getAttribute("position");
  for (let i = 0; i < count; i++) {
    const y = pos.getY(i);
    if (y < 3.5) {
      colors[i * 3] = 0.35; colors[i * 3 + 1] = 0.22; colors[i * 3 + 2] = 0.12;
    } else {
      colors[i * 3] = 0.25; colors[i * 3 + 1] = 0.45; colors[i * 3 + 2] = 0.22;
    }
  }
  merged.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  mat.vertexColors = true;
  return { geometry: merged, material: mat };
}

function scatterTrees(
  grid: HeightGrid,
  data: CityData,
  count: number,
  landCoverGrid: LandCoverGrid | null = null
): THREE.InstancedMesh | null {
  if (count <= 0) return null;
  const { geometry, material } = createSimpleTreeGeometry();
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = "trees";
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const dummy = new THREE.Object3D();

  // Simple rejection sampling over the grid
  const widthM = data.extent.maxX - data.extent.minX;
  const depthM = data.extent.maxZ - data.extent.minZ;
  let placed = 0;
  let attempts = 0;
  const maxAttempts = count * 8;
  const seed = (data.origin.lon * 1000 + data.origin.lat * 100) | 0;

  function rand(i: number) {
    const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  // Exclusion zones: buildings (centroid + radius) and dense samples along every road
  const exclude: { x: number; z: number; r: number }[] = [];
  for (const b of data.buildings.slice(0, 1200)) {
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
    let ok = true;
    for (const e of exclude) {
      if (Math.hypot(x - e.x, z - e.z) < e.r) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // Where we have ESA WorldCover, only let trees grow on vegetated/land
    // pixels — never on built-up, water, or snow/ice classification.
    if (landCoverGrid) {
      const [lon, lat] = unproject(x, z, data.origin.lon, data.origin.lat);
      const cls = sampleLandCoverClass(landCoverGrid, lon, lat);
      if (cls !== 0 && isBuiltOrWaterClass(cls)) continue;
    }

    // Slight random scale / rotation
    const s = 0.7 + rand(attempts * 3) * 0.9;
    const rot = rand(attempts * 4) * Math.PI * 2;

    // Terrain mesh uses Three Z = feature z
    dummy.position.set(x, h, z);
    dummy.rotation.set(0, rot, 0);
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed, dummy.matrix);
    placed++;
  }

  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (placed === 0) {
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    return null;
  }
  return mesh;
}

export type CityMeshes = {
  group: THREE.Group;
  buildings?: THREE.Mesh;
  roads?: THREE.Mesh;
  water?: THREE.Mesh;
  ports?: THREE.Mesh;
  coastline?: THREE.Mesh;
  terrain: THREE.Mesh;
  trees?: THREE.InstancedMesh;
  stats: { buildings: number; roads: number; water: number; ports: number; vertices: number; trees?: number };
  heightGrid?: HeightGrid | null;
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
  /** Called with overall meshing fraction 0–1 and a stage label. */
  onProgress?: (fraction: number, label: string) => void;
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

  // Parallelize elevation + land-cover fetches (they are independent network work).
  // Weighted progress: elevation 0–35%, landcover 0–20% of total meshing budget.
  let elevFrac = 0;
  let coverFrac = 0;
  const reportFetch = () => {
    // Combined fetch stage occupies first 55% of meshing.
    const combined = (elevFrac * 0.35 + coverFrac * 0.2) / 0.55;
    onProgress?.(Math.min(0.55, combined * 0.55), "Loading terrain data…");
  };

  const elevPromise = !cfg.FLAT_TERRAIN
    ? fetchHeightGrid(data.bbox, data.origin, {
        targetMeters: Math.max(15, Math.min(40, (data.extent.maxX - data.extent.minX) / 64)),
        maxSamples: 80,
        onProgress: (f) => {
          elevFrac = f;
          reportFetch();
        },
      }).catch((e) => {
        console.warn("Elevation fetch failed, falling back to flat", e);
        return null as HeightGrid | null;
      })
    : Promise.resolve(null as HeightGrid | null);

  const coverPromise = wantLandCover
    ? fetchLandCoverGrid(data.bbox, {
        targetMeters: 10,
        maxSamples: 512,
        onProgress: (f) => {
          coverFrac = f;
          reportFetch();
        },
      }).catch((e) => {
        console.warn("Land cover fetch failed", e);
        return null as LandCoverGrid | null;
      })
    : Promise.resolve(null as LandCoverGrid | null);

  // Kick off satellite texture early so it overlaps with DEM/landcover + meshing.
  const satPromise =
    wantSatellite && !wantLandCover
      ? buildSatelliteCanvas(data.bbox, { maxTiles: 48, targetPx: 1536 }).catch((e) => {
          console.warn("Satellite texture failed", e);
          return null;
        })
      : Promise.resolve(null);

  const [grid, landCoverGrid] = await Promise.all([elevPromise, coverPromise]);
  onProgress?.(0.55, "Building terrain…");

  const buildingMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.04,
    flatShading: true,
    color: 0xffffff,
  });
  const roadMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().fromArray([...cfg.ROAD_COLOR]),
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
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
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
  let roadsMesh: THREE.Mesh | undefined;
  let waterMesh: THREE.Mesh | undefined;
  let portsMesh: THREE.Mesh | undefined;
  let coastlineMesh: THREE.Mesh | undefined;
  let treesMesh: THREE.InstancedMesh | undefined;

  const bGeo = buildingsGeometry(data.buildings, grid);
  if (bGeo) {
    buildingsMesh = new THREE.Mesh(bGeo, buildingMat);
    buildingsMesh.name = "buildings";
    buildingsMesh.castShadow = true;
    group.add(buildingsMesh);
    vertices += bGeo.getAttribute("position").count;
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
    const desired = Math.min(cfg.MAX_TREES, Math.floor(area * treeDensity));
    treesMesh = scatterTrees(grid, data, desired, landCoverGrid) ?? undefined;
    if (treesMesh) {
      group.add(treesMesh);
      vertices += treesMesh.geometry.getAttribute("position").count * (treesMesh.count || 0);
    }
  }

  onProgress?.(0.99, "Finalizing…");

  return {
    group,
    buildings: buildingsMesh,
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
      trees: treesMesh?.count ?? 0,
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
