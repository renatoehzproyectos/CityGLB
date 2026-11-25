/**
 * Enriquecimiento de edificios por IA (idea tipo MSFS: imagen aérea + visión → altura,
 * techo, color y material por edificio).
 *
 *  1. Elige los edificios más grandes (tope AI_MAX_BUILDINGS_TOTAL).
 *  2. Los agrupa en zonas con un quadtree (≤ AI_MAX_BUILDINGS_PER_TILE por imagen).
 *  3. Recorta la imagen satelital de cada zona y dibuja contornos numerados.
 *  4. Pide al modelo (server fn) alturas/techos/colores/materiales y los aplica
 *     SOLO donde los datos reales no existen.
 */
import { analyzeBuildingTileFn } from "./ai-buildings";
import { AI_MAX_BUILDINGS_PER_TILE, AI_MAX_BUILDINGS_TOTAL, type AiBuilding } from "./ai-schema";
import { cfg } from "./config";
import { ringArea } from "./geo";
import { clampHeight } from "./height";
import type { RGB } from "./roof-data";
import type { BuildingFeature, CityData } from "./types";

export type AiEnrichResult = {
  enriched: number;
  analyzed: number;
  /** Si no se pudo (o solo parcialmente), el motivo para mostrarlo al usuario. */
  warning?: string;
  notConfigured?: boolean;
};

type Box = { minX: number; maxX: number; minZ: number; maxZ: number };
type Item = { idx: number; cx: number; cz: number; box: Box };

const CONCURRENCY = 3;
const MIN_TILE_M = 70; // lado mínimo de recorte (m)
const MAX_PX = 1024;
const MIN_PX = 512;

const cache = new Map<string, AiBuilding[]>();
const CACHE_MAX = 300;

function bboxOf(b: BuildingFeature): Box {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of b.ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Quadtree: divide hasta que cada celda tenga pocos edificios o sea pequeña. */
function partition(items: Item[], region: Box, out: Item[][]): void {
  if (!items.length) return;
  const w = region.maxX - region.minX;
  const d = region.maxZ - region.minZ;
  if (items.length <= AI_MAX_BUILDINGS_PER_TILE || Math.max(w, d) <= MIN_TILE_M) {
    for (let i = 0; i < items.length; i += AI_MAX_BUILDINGS_PER_TILE) out.push(items.slice(i, i + AI_MAX_BUILDINGS_PER_TILE));
    return;
  }
  const mx = (region.minX + region.maxX) / 2;
  const mz = (region.minZ + region.maxZ) / 2;
  const quads: [Item[], Box][] = [
    [[], { minX: region.minX, maxX: mx, minZ: region.minZ, maxZ: mz }],
    [[], { minX: mx, maxX: region.maxX, minZ: region.minZ, maxZ: mz }],
    [[], { minX: region.minX, maxX: mx, minZ: mz, maxZ: region.maxZ }],
    [[], { minX: mx, maxX: region.maxX, minZ: mz, maxZ: region.maxZ }],
  ];
  for (const it of items) quads[(it.cx >= mx ? 1 : 0) + (it.cz >= mz ? 2 : 0)][0].push(it);
  for (const [list, box] of quads) partition(list, box, out);
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

type TilePayload = {
  image: string;
  metersPerPixel: number;
  buildings: { id: number; areaM2: number; kind: string; priorHeight: number; heightKnown: boolean; roofKnown: boolean; facadeKnown: boolean }[];
  /** id local (1..n) → índice global */
  map: number[];
  key: string;
};

function renderTile(sat: HTMLCanvasElement, data: CityData, group: Item[]): TilePayload | null {
  const ext = data.extent;
  const W = ext.maxX - ext.minX;
  const D = ext.maxZ - ext.minZ;
  // Recorte = unión de las cajas + margen, con tamaño mínimo y relación de aspecto libre.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const it of group) {
    minX = Math.min(minX, it.box.minX);
    maxX = Math.max(maxX, it.box.maxX);
    minZ = Math.min(minZ, it.box.minZ);
    maxZ = Math.max(maxZ, it.box.maxZ);
  }
  const pad = 12;
  minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
  const grow = (lo: number, hi: number) => {
    const span = hi - lo;
    if (span >= MIN_TILE_M) return [lo, hi] as const;
    const c = (lo + hi) / 2;
    return [c - MIN_TILE_M / 2, c + MIN_TILE_M / 2] as const;
  };
  [minX, maxX] = grow(minX, maxX);
  [minZ, maxZ] = grow(minZ, maxZ);
  minX = Math.max(ext.minX, minX); maxX = Math.min(ext.maxX, maxX);
  minZ = Math.max(ext.minZ, minZ); maxZ = Math.min(ext.maxZ, maxZ);
  const wM = maxX - minX;
  const dM = maxZ - minZ;
  if (wM < 10 || dM < 10) return null;

  const sx = ((minX - ext.minX) / W) * sat.width;
  const sy = ((minZ - ext.minZ) / D) * sat.height;
  const sw = (wM / W) * sat.width;
  const sh = (dM / D) * sat.height;
  const scale = Math.min(MAX_PX / Math.max(sw, sh), Math.max(1, MIN_PX / Math.max(sw, sh)));
  const outW = Math.max(64, Math.round(sw * scale));
  const outH = Math.max(64, Math.round(sh * scale));

  const c = document.createElement("canvas");
  c.width = outW;
  c.height = outH;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(sat, sx, sy, sw, sh, 0, 0, outW, outH);
  } catch {
    return null;
  }
  const toPx = (x: number, z: number): [number, number] => [((x - minX) / wM) * outW, ((z - minZ) / dM) * outH];

  const buildings: TilePayload["buildings"] = [];
  const map: number[] = [];
  ctx.lineJoin = "round";
  group.forEach((it, i) => {
    const b = data.buildings[it.idx];
    const id = i + 1;
    ctx.beginPath();
    b.ring.forEach(([x, z], k) => {
      const [px, py] = toPx(x, z);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.strokeStyle = "#ff2bd6";
    ctx.lineWidth = 2;
    ctx.stroke();
    // etiqueta en el centro de la caja
    const [lx, ly] = toPx(it.cx, it.cz);
    const label = String(id);
    ctx.font = "bold 13px sans-serif";
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(lx - tw / 2 - 3, ly - 8, tw + 6, 16);
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(label, lx, ly + 1);
    buildings.push({
      id,
      areaM2: ringArea(b.ring),
      kind: b.kind,
      priorHeight: b.height,
      heightKnown: Boolean(b.heightKnown),
      roofKnown: Boolean(b.roof?.shape && b.roof?.color),
      facadeKnown: Boolean(b.facade),
    });
    map.push(it.idx);
  });

  let jpeg: string;
  try {
    jpeg = c.toDataURL("image/jpeg", 0.82);
  } catch {
    return null; // canvas contaminado (CORS)
  }
  const image = jpeg.slice(jpeg.indexOf(",") + 1);
  const key = hash(
    [minX.toFixed(1), maxX.toFixed(1), minZ.toFixed(1), maxZ.toFixed(1), ...buildings.map((b) => `${b.id}:${Math.round(b.areaM2)}:${Math.round(b.priorHeight)}`)].join("|") +
      `|${data.bbox.minLon.toFixed(5)},${data.bbox.minLat.toFixed(5)},${data.bbox.maxLon.toFixed(5)},${data.bbox.maxLat.toFixed(5)}`,
  );
  return { image, metersPerPixel: wM / outW, buildings, map, key };
}

function apply(b: BuildingFeature, r: AiBuilding): boolean {
  const conf = r.confidence;
  if (conf < 0.3) return false;
  let touched = false;

  if (!b.heightKnown && r.height_m != null && conf >= 0.35) {
    const w = Math.min(1, conf * 1.25); // confianza baja → se queda cerca de la estimación previa
    b.height = clampHeight(b.height * (1 - w) + r.height_m * w);
    touched = true;
  }
  if (!b.roof?.shape && r.roof_shape && conf >= 0.4) {
    b.roof = { ...b.roof, shape: r.roof_shape };
    touched = true;
  }
  if (!b.roof?.color && r.roof_color && conf >= 0.4) {
    b.roof = { ...b.roof, color: hexToRgb(r.roof_color) };
    touched = true;
  }
  if (!b.facade && r.facade_color && conf >= 0.4) {
    b.facade = hexToRgb(r.facade_color);
    touched = true;
  }
  if (r.material && conf >= 0.4) {
    b.material = r.material;
    touched = true;
  }
  if (touched) b.ai = true;
  return touched;
}

export async function enrichBuildingsWithAI(
  data: CityData,
  sat: HTMLCanvasElement,
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<AiEnrichResult> {
  // 1. Candidatos: los más grandes, ya dentro de cfg.MAX_BUILDINGS.
  const candidates: Item[] = data.buildings
    .map((b, idx) => ({ idx, area: ringArea(b.ring) }))
    .filter((x) => x.area >= 40 && data.buildings[x.idx].height >= cfg.MIN_BUILDING_HEIGHT)
    .sort((a, b) => b.area - a.area)
    .slice(0, AI_MAX_BUILDINGS_TOTAL)
    .map(({ idx }) => {
      const box = bboxOf(data.buildings[idx]);
      return { idx, box, cx: (box.minX + box.maxX) / 2, cz: (box.minZ + box.maxZ) / 2 };
    });
  if (!candidates.length) return { enriched: 0, analyzed: 0 };

  // 2. Zonas.
  const groups: Item[][] = [];
  partition(candidates, data.extent, groups);

  // 3. Render de recortes.
  const tiles = groups.map((g) => renderTile(sat, data, g)).filter((t): t is TilePayload => t !== null);
  if (!tiles.length) {
    return { enriched: 0, analyzed: 0, warning: "No se pudo leer la imagen satelital (bloqueada por el navegador)." };
  }

  // 4. Llamadas con concurrencia limitada.
  let done = 0;
  let enriched = 0;
  let analyzed = 0;
  let warning: string | undefined;
  let notConfigured = false;
  let next = 0;
  opts.onProgress?.(0, tiles.length);

  const worker = async () => {
    while (!notConfigured) {
      const i = next++;
      if (i >= tiles.length) return;
      const t = tiles[i];
      let results = cache.get(t.key);
      if (!results) {
        let lastMsg = "";
        for (let attempt = 0; attempt < 2 && !results; attempt++) {
          try {
            const res = await analyzeBuildingTileFn({
              data: { image: t.image, buildings: t.buildings, metersPerPixel: t.metersPerPixel, lat: data.origin.lat },
            });
            if (res.ok) {
              results = res.buildings;
            } else {
              lastMsg = res.message;
              if (res.reason === "not_configured") notConfigured = true;
              if (res.reason !== "failed") break;
            }
          } catch (e) {
            lastMsg = e instanceof Error ? e.message : String(e);
          }
        }
        if (results) {
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
          cache.set(t.key, results);
        } else if (!warning) {
          warning = lastMsg || "El análisis por IA falló en algunas zonas.";
        }
      }
      if (results) {
        analyzed += t.buildings.length;
        for (const r of results) {
          const gi = t.map[r.id - 1];
          if (gi != null && apply(data.buildings[gi], r)) enriched++;
        }
      }
      opts.onProgress?.(++done, tiles.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tiles.length) }, worker));

  return { enriched, analyzed, warning, notConfigured };
}
