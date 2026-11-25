import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { normalizeBBox, validateBBox } from "./geo";
import { cfg } from "./config";
import {
  OVERTURE_RELEASE,
  overtureToCityData,
  type OvertureBuildingCollection,
} from "./parse-overture";
import type { BBox, CityData } from "./types";

const FetchInput = z.object({
  minLon: z.number(),
  minLat: z.number(),
  maxLon: z.number(),
  maxLat: z.number(),
  placeName: z.string().max(120).optional(),
});

const OVERTURE_S3_HTTP = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com";
const STAC_BASE = "https://stac.overturemaps.org";

/**
 * Loaded dynamically so Vite never resolves hyparquet / fzstd into the client
 * bundle. Only reached from the server handler.
 */
async function getQueryOvertureFiles() {
  const mod = await import("./duckdb-client");
  return mod.queryOvertureFiles;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 12; // entradas grandes (decenas de MB): pocas

type CacheEntry = { data: unknown; expiresAt: number };
const overtureCache = new Map<string, CacheEntry>();

function cacheKey(theme: string, bbox: BBox, release: string): string {
  const r = (n: number) => n.toFixed(6);
  return `${theme}|${release}|${r(bbox.minLon)}|${r(bbox.minLat)}|${r(bbox.maxLon)}|${r(bbox.maxLat)}`;
}

function cacheGet<T>(key: string): T | null {
  const entry = overtureCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    overtureCache.delete(key);
    return null;
  }
  overtureCache.delete(key);
  overtureCache.set(key, entry);
  return entry.data as T;
}

function cacheSet<T>(key: string, data: T): void {
  if (overtureCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = overtureCache.keys().next().value;
    if (oldest !== undefined) overtureCache.delete(oldest);
  }
  overtureCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}


// ---------------------------------------------------------------------------
// Release discovery. Overture retira releases antiguos del bucket, así que la
// constante OVERTURE_RELEASE puede dejar de existir. Si no tiene archivos,
// se busca el release más reciente que sí los tenga.
// ---------------------------------------------------------------------------
const RELEASE_RE = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const RELEASE_CACHE_TTL_MS = 60 * 60 * 1000;
let resolvedRelease: { preferred: string; value: string; expiresAt: number } | null = null;

async function releaseHasBuildings(release: string): Promise<boolean> {
  const url = new URL(OVERTURE_S3_HTTP);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", `release/${release}/theme=buildings/type=building/`);
  url.searchParams.set("max-keys", "1");
  try {
    const res = await fetch(url.toString());
    if (!res.ok) return false;
    return /<Key>[^<]+\.parquet<\/Key>/.test(await res.text());
  } catch {
    return false;
  }
}

async function listOvertureReleases(): Promise<string[]> {
  const url = new URL(OVERTURE_S3_HTTP);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", "release/");
  url.searchParams.set("delimiter", "/");
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const xml = await res.text();
  const out: string[] = [];
  for (const m of xml.matchAll(/<Prefix>release\/([^/<]+)\/<\/Prefix>/g)) {
    if (RELEASE_RE.test(m[1])) out.push(m[1]);
  }
  return out.sort().reverse();
}

async function resolveRelease(preferred: string): Promise<string> {
  const now = Date.now();
  if (resolvedRelease && resolvedRelease.preferred === preferred && resolvedRelease.expiresAt > now) {
    return resolvedRelease.value;
  }
  let value = preferred;
  if (!(await releaseHasBuildings(preferred))) {
    const releases = await listOvertureReleases();
    for (const r of releases.slice(0, 6)) {
      if (await releaseHasBuildings(r)) {
        console.warn(`[overture] release ${preferred} no existe; usando ${r}`);
        value = r;
        break;
      }
    }
  }
  resolvedRelease = { preferred, value, expiresAt: now + RELEASE_CACHE_TTL_MS };
  return value;
}

type PartitionFile = { key: string; size: number; partIndex: number };

/** Extract part index from keys like `.../part-00042-uuid-c000.zstd.parquet`. */
function partIndexFromKey(key: string): number {
  const m = key.match(/part-(\d+)-/);
  return m ? Number(m[1]) : -1;
}

/**
 * Lists `.parquet` object keys under a theme/type partition via S3 ListObjectsV2.
 * Returns size so hyparquet can skip HEAD requests.
 */
async function listOverturePartitionFiles(
  theme: string,
  type: string,
  release: string,
): Promise<PartitionFile[]> {
  const prefix = `release/${release}/theme=${theme}/type=${type}/`;
  const files: PartitionFile[] = [];
  let continuationToken: string | undefined;

  do {
    const url = new URL(OVERTURE_S3_HTTP);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (continuationToken) url.searchParams.set("continuation-token", continuationToken);

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`S3 listing failed for ${prefix} (HTTP ${res.status})`);
    }
    const xml = await res.text();
    for (const m of xml.matchAll(
      /<Contents>\s*<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
    )) {
      if (m[1].endsWith(".parquet")) {
        files.push({ key: m[1], size: Number(m[2]), partIndex: partIndexFromKey(m[1]) });
      }
    }
    const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    continuationToken = isTruncated ? tokenMatch?.[1] : undefined;
  } while (continuationToken);

  return files;
}

function toHttpsUrl(key: string): string {
  return `${OVERTURE_S3_HTTP}/${key}`;
}

const LISTING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const listingCache = new Map<string, { files: PartitionFile[]; expiresAt: number }>();

async function getPartitionFiles(theme: string, type: string, release: string): Promise<PartitionFile[]> {
  const key = `${theme}/${type}/${release}`;
  const cached = listingCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.files;

  const files = await listOverturePartitionFiles(theme, type, release);
  if (files.length === 0) {
    throw new Error(`No Overture files found for theme=${theme}/type=${type} at release ${release}`);
  }
  listingCache.set(key, { files, expiresAt: Date.now() + LISTING_CACHE_TTL_MS });
  return files;
}

/** STAC file-level bbox: [minLon, minLat, maxLon, maxLat] */
type StacFileBBox = [number, number, number, number];

type StacIndex = {
  /** Parallel arrays: index i is part-NNNNN */
  bboxes: StacFileBBox[];
};

const stacCache = new Map<string, { index: StacIndex; expiresAt: number }>();
const STAC_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Fetch Overture STAC collection for a theme/type. The collection's
 * extent.spatial.bbox is a list of per-file bounding boxes in the same order
 * as the item links (part-00000, part-00001, ...). One ~150KB JSON instead of
 * opening hundreds of parquet footers.
 */
async function getStacFileBBoxes(theme: string, type: string, release: string): Promise<StacIndex | null> {
  const cacheKey = `${theme}/${type}/${release}`;
  const cached = stacCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.index;

  const url = `${STAC_BASE}/${release}/${theme}/${type}/collection.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[overture] STAC ${url} → HTTP ${res.status}`);
      return null;
    }
    const collection = (await res.json()) as {
      extent?: { spatial?: { bbox?: StacFileBBox[] } };
      links?: { rel?: string; href?: string }[];
    };
    const bboxes = collection.extent?.spatial?.bbox;
    if (!Array.isArray(bboxes) || bboxes.length === 0) return null;

    // extent.spatial.bbox[0] is sometimes the overall union in STAC — but for
    // Overture, all entries are per-file and match item count. Prefer item count.
    const itemCount = (collection.links ?? []).filter((l) => l.rel === "item").length;
    // Si el nº de bboxes no coincide con el nº de ítems, el orden NO es fiable:
    // podar con él puede descartar justo los archivos de la zona (→ 0 edificios).
    // STAC permite que bbox[0] sea la unión de todo: en ese caso hay itemCount+1 entradas.
    const perFile = bboxes.length === itemCount + 1 ? bboxes.slice(1) : bboxes;
    if (itemCount === 0 || perFile.length !== itemCount) {
      console.warn(`[overture] STAC bboxes (${bboxes.length}) != items (${itemCount}); sin poda`);
      return null;
    }
    const index: StacIndex = { bboxes: perFile };
    stacCache.set(cacheKey, { index, expiresAt: Date.now() + STAC_CACHE_TTL_MS });
    return index;
  } catch (err) {
    console.warn(`[overture] STAC fetch failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function bboxesIntersect(
  a: { minLon: number; minLat: number; maxLon: number; maxLat: number },
  b: StacFileBBox,
): boolean {
  // b = [minLon, minLat, maxLon, maxLat]
  return a.maxLon >= b[0] && a.minLon <= b[2] && a.maxLat >= b[1] && a.minLat <= b[3];
}

/**
 * Keep only partition files whose STAC bbox intersects the query.
 * Falls back to all files if STAC is unavailable (still works, just slower).
 */
async function filterFilesByStacBBox(
  files: PartitionFile[],
  theme: string,
  type: string,
  release: string,
  bbox: BBox,
): Promise<PartitionFile[]> {
  const stac = await getStacFileBBoxes(theme, type, release);
  if (!stac) return files;

  const filtered = files.filter((f) => {
    if (f.partIndex < 0 || f.partIndex >= stac.bboxes.length) return true; // unknown → keep
    return bboxesIntersect(bbox, stac.bboxes[f.partIndex]);
  });

  // Safety: never return empty when STAC said none — data might still exist
  // (bbox edge cases). Caller can still get zero rows from the row filter.
  return filtered.length > 0 ? filtered : files;
}

function bboxIntersectFilter(bbox: BBox) {
  return {
    $and: [
      { "bbox.xmin": { $lte: bbox.maxLon } },
      { "bbox.xmax": { $gte: bbox.minLon } },
      { "bbox.ymin": { $lte: bbox.maxLat } },
      { "bbox.ymax": { $gte: bbox.minLat } },
    ],
  };
}

async function runOvertureQuery(
  theme: string,
  type: string,
  release: string,
  columns: string[],
  bbox: BBox,
  rowLimit: number,
  extraFilter?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const allFiles = await getPartitionFiles(theme, type, release);
  const files = await filterFilesByStacBBox(allFiles, theme, type, release, bbox);

  console.info(
    `[overture] ${theme}/${type}: ${files.length}/${allFiles.length} files after STAC prune`,
  );

  const queryOvertureFiles = await getQueryOvertureFiles();
  const filter = extraFilter
    ? { $and: [bboxIntersectFilter(bbox), extraFilter] }
    : bboxIntersectFilter(bbox);

  const run = (list: PartitionFile[]) =>
    queryOvertureFiles({
      urls: list.map((f) => toHttpsUrl(f.key)),
      byteLengths: list.map((f) => f.size),
      columns,
      filter,
      rowLimit,
    });

  let rows = await run(files);
  // Red de seguridad: si la poda por STAC dejó 0 filas pero había más archivos,
  // reintenta sin poda (la poda puede estar desalineada con el listado S3).
  if (rows.length === 0 && files.length < allFiles.length) {
    console.warn(`[overture] ${theme}/${type}: 0 filas tras poda; reintentando con ${allFiles.length} archivos`);
    rows = await run(allFiles);
  }
  return rows;
}

function asGeoJsonGeometry(value: unknown): { type: string; coordinates: unknown } | null {
  if (!value || typeof value !== "object") return null;
  const g = value as { type?: string; coordinates?: unknown };
  if (typeof g.type !== "string" || g.coordinates == null) return null;
  return g as { type: string; coordinates: unknown };
}

async function queryOvertureBuildings(bbox: BBox, release = OVERTURE_RELEASE): Promise<OvertureBuildingCollection> {
  release = await resolveRelease(release);
  const key = cacheKey("buildings", bbox, release);
  const cached = cacheGet<OvertureBuildingCollection>(key);
  if (cached) return cached;

  const baseCols = ["id", "height", "num_floors", "class", "subtype", "names", "geometry"];
  const extraCols = ["facade_color", "facade_material", "roof_shape", "roof_color", "roof_material", "roof_height", "roof_direction"];
  let rows: Record<string, unknown>[];
  try {
    rows = await runOvertureQuery("buildings", "building", release, [...baseCols, ...extraCols], bbox, cfg.MAX_BUILDINGS * 2);
  } catch (e) {
    // Releases antiguos pueden no tener las columnas de techo/fachada: reintenta con las básicas.
    console.warn("[overture] columnas de techo/fachada no disponibles; reintentando sin ellas", e);
    rows = await runOvertureQuery("buildings", "building", release, baseCols, bbox, cfg.MAX_BUILDINGS * 2);
  }

  const features: OvertureBuildingCollection["features"] = [];
  for (const row of rows) {
    const geometry = asGeoJsonGeometry(row.geometry);
    if (!geometry) continue;
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") continue;
    const names = row.names as { primary?: string | null } | null | undefined;
    features.push({
      type: "Feature",
      geometry: geometry as any,
      properties: {
        id: row.id as string,
        height: (row.height as number | null) ?? null,
        num_floors: (row.num_floors as number | null) ?? null,
        class: (row.class as string | null) ?? null,
        subtype: (row.subtype as string | null) ?? null,
        names: { primary: names?.primary ?? null },
        facade_color: (row.facade_color as string | null) ?? null,
        facade_material: (row.facade_material as string | null) ?? null,
        roof_shape: (row.roof_shape as string | null) ?? null,
        roof_color: (row.roof_color as string | null) ?? null,
        roof_material: (row.roof_material as string | null) ?? null,
        roof_height: (row.roof_height as number | null) ?? null,
        roof_direction: (row.roof_direction as number | null) ?? null,
      },
    });
  }
  const result: OvertureBuildingCollection = { type: "FeatureCollection", features };
  cacheSet(key, result);
  return result;
}

export async function fetchOvertureCity(
  bbox: BBox,
  opts: { placeName: string; release?: string },
): Promise<CityData> {
  const buildings = await queryOvertureBuildings(bbox, opts.release);
  return overtureToCityData(buildings, bbox, opts.placeName);
}

/** Full one-shot fetch (kept for compatibility). */
export const fetchOvertureCityFn = createServerFn({ method: "POST" })
  .validator((data) => FetchInput.parse(data))
  .handler(async ({ data }) => {
    const bbox = normalizeBBox({
      minLon: data.minLon,
      minLat: data.minLat,
      maxLon: data.maxLon,
      maxLat: data.maxLat,
    });
    const err = validateBBox(bbox);
    if (err) throw new Error(err);
    try {
      return await fetchOvertureCity(bbox, { placeName: data.placeName?.trim() || "Custom area" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Overture Maps did not respond (${msg}). Try again in a moment.`);
    }
  });

const LayerInput = z.object({
  minLon: z.number(),
  minLat: z.number(),
  maxLon: z.number(),
  maxLat: z.number(),
  placeName: z.string().max(120).optional(),
  layer: z.enum(["buildings", "assemble", "tile"]),
  /** layer=tile: fracciones (u: oeste→este, w: norte→sur) de la caja global. */
  tile: z.object({ u0: z.number(), u1: z.number(), w0: z.number(), w1: z.number() }).optional(),
});

/**
 *   layer=buildings → solo cuenta edificios (los deja en caché del servidor)
 *   layer=assemble  → CityData completo (recorta y proyecta)
 *   layer=tile      → CityData de una tesela (respuestas pequeñas; ver tiles.ts)
 */
export const fetchOvertureLayerFn = createServerFn({ method: "POST" })
  .validator((data) => LayerInput.parse(data))
  .handler(async ({ data }) => {
    const bbox = normalizeBBox({
      minLon: data.minLon,
      minLat: data.minLat,
      maxLon: data.maxLon,
      maxLat: data.maxLat,
    });
    const err = validateBBox(bbox);
    if (err) throw new Error(err);
    const placeName = data.placeName?.trim() || "Custom area";

    try {
      if (data.layer === "buildings") {
        const fc = await queryOvertureBuildings(bbox);
        return { count: fc.features.length };
      }
      if (data.layer === "tile" && data.tile) {
        const { u0, u1, w0, w1 } = data.tile;
        const lonSpan = bbox.maxLon - bbox.minLon, latSpan = bbox.maxLat - bbox.minLat;
        const tb: BBox = {
          minLon: bbox.minLon + u0 * lonSpan, maxLon: bbox.minLon + u1 * lonSpan,
          maxLat: bbox.maxLat - w0 * latSpan, minLat: bbox.maxLat - w1 * latSpan,
        };
        // Proyecta/recorta contra la caja GLOBAL (mismo origen para todas las teselas)...
        const city = overtureToCityData(await queryOvertureBuildings(tb), bbox, placeName);
        const W = city.extent.maxX - city.extent.minX, D = city.extent.maxZ - city.extent.minZ;
        const inTile = (x: number, z: number) => {
          const u = (x - city.extent.minX) / W, v = (z - city.extent.minZ) / D; // v: 0 = norte
          return u >= u0 && (u < u1 || u1 >= 1 - 1e-9) && v >= w0 && (v < w1 || w1 >= 1 - 1e-9);
        };
        // ...y cada edificio se queda en UNA sola tesela (por centroide): sin duplicados al fusionar.
        city.buildings = city.buildings.filter((f) => {
          let x = 0, z = 0;
          for (const p of f.ring) { x += p[0]; z += p[1]; }
          return inTile(x / f.ring.length, z / f.ring.length);
        });
        if (JSON.stringify(city).length > 3_400_000) throw new Error("TILE_TOO_BIG");
        return city;
      }
      return overtureToCityData(await queryOvertureBuildings(bbox), bbox, placeName);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Overture Maps did not respond (${msg}). Try again in a moment.`);
    }
  });
