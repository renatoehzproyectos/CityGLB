import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { normalizeBBox, validateBBox } from "./geo";
import {
  OVERTURE_RELEASE,
  overtureToCityData,
  type OvertureBuildingCollection,
  type OvertureSegmentCollection,
  type OvertureWaterCollection,
} from "./parse-overture";
import type { BBox, CityData } from "./types";

const FetchInput = z.object({
  minLon: z.number(),
  minLat: z.number(),
  maxLon: z.number(),
  maxLat: z.number(),
  includeRoads: z.boolean().optional(),
  includeWater: z.boolean().optional(),
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
const CACHE_MAX_ENTRIES = 300;

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
    const index: StacIndex = {
      bboxes: itemCount > 0 && bboxes.length === itemCount ? bboxes : bboxes,
    };
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

  return queryOvertureFiles({
    urls: files.map((f) => toHttpsUrl(f.key)),
    byteLengths: files.map((f) => f.size),
    columns,
    filter,
    rowLimit,
  });
}

function asGeoJsonGeometry(value: unknown): { type: string; coordinates: unknown } | null {
  if (!value || typeof value !== "object") return null;
  const g = value as { type?: string; coordinates?: unknown };
  if (typeof g.type !== "string" || g.coordinates == null) return null;
  return g as { type: string; coordinates: unknown };
}

async function queryOvertureBuildings(bbox: BBox, release = OVERTURE_RELEASE): Promise<OvertureBuildingCollection> {
  const key = cacheKey("buildings", bbox, release);
  const cached = cacheGet<OvertureBuildingCollection>(key);
  if (cached) return cached;

  const rows = await runOvertureQuery(
    "buildings",
    "building",
    release,
    ["id", "height", "num_floors", "class", "subtype", "names", "geometry"],
    bbox,
    20000,
  );

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
      },
    });
  }
  const result: OvertureBuildingCollection = { type: "FeatureCollection", features };
  cacheSet(key, result);
  return result;
}

async function queryOvertureSegments(bbox: BBox, release = OVERTURE_RELEASE): Promise<OvertureSegmentCollection> {
  const key = cacheKey("segments", bbox, release);
  const cached = cacheGet<OvertureSegmentCollection>(key);
  if (cached) return cached;

  const rows = await runOvertureQuery(
    "transportation",
    "segment",
    release,
    ["id", "subtype", "class", "geometry"],
    bbox,
    20000,
    { subtype: { $eq: "road" } },
  );

  const features: OvertureSegmentCollection["features"] = [];
  for (const row of rows) {
    const geometry = asGeoJsonGeometry(row.geometry);
    if (!geometry) continue;
    if (geometry.type !== "LineString" && geometry.type !== "MultiLineString") continue;
    features.push({
      type: "Feature",
      geometry: geometry as any,
      properties: {
        id: row.id as string,
        subtype: (row.subtype as string | null) ?? null,
        class: (row.class as string | null) ?? null,
      },
    });
  }
  const result: OvertureSegmentCollection = { type: "FeatureCollection", features };
  cacheSet(key, result);
  return result;
}

async function queryOvertureWater(bbox: BBox, release = OVERTURE_RELEASE): Promise<OvertureWaterCollection> {
  const key = cacheKey("water", bbox, release);
  const cached = cacheGet<OvertureWaterCollection>(key);
  if (cached) return cached;

  const rows = await runOvertureQuery(
    "base",
    "water",
    release,
    ["id", "subtype", "geometry"],
    bbox,
    5000,
  );

  const features: OvertureWaterCollection["features"] = [];
  for (const row of rows) {
    const geometry = asGeoJsonGeometry(row.geometry);
    if (!geometry) continue;
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") continue;
    features.push({
      type: "Feature",
      geometry: geometry as any,
      properties: {
        id: row.id as string,
        subtype: (row.subtype as string | null) ?? null,
      },
    });
  }
  const result: OvertureWaterCollection = { type: "FeatureCollection", features };
  cacheSet(key, result);
  return result;
}

export async function fetchOvertureCity(
  bbox: BBox,
  opts: { placeName: string; includeRoads?: boolean; includeWater?: boolean; release?: string },
): Promise<CityData> {
  const buildings = await queryOvertureBuildings(bbox, opts.release);
  const segments = opts.includeRoads ? await queryOvertureSegments(bbox, opts.release) : undefined;
  const water = opts.includeWater ? await queryOvertureWater(bbox, opts.release) : undefined;
  return overtureToCityData(buildings, bbox, opts.placeName, { segments, water });
}

/** Full one-shot fetch (kept for compatibility). Prefer staged layer fetches for progress. */
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
      return await fetchOvertureCity(bbox, {
        placeName: data.placeName?.trim() || "Custom area",
        includeRoads: data.includeRoads,
        includeWater: data.includeWater,
      });
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
  layer: z.enum(["buildings", "roads", "water", "assemble"]),
  /** Only used for the assemble step — pass previous layer payloads. */
  buildings: z.any().optional(),
  segments: z.any().optional(),
  water: z.any().optional(),
});

/**
 * Staged Overture fetch so the client can drive an honest progress bar:
 *   1. layer=buildings → FeatureCollection
 *   2. layer=roads     → FeatureCollection | null
 *   3. layer=water     → FeatureCollection | null
 *   4. layer=assemble  → CityData (clips + projects everything)
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
        return await queryOvertureBuildings(bbox);
      }
      if (data.layer === "roads") {
        return await queryOvertureSegments(bbox);
      }
      if (data.layer === "water") {
        return await queryOvertureWater(bbox);
      }
      // assemble
      const buildings = (data.buildings ?? {
        type: "FeatureCollection",
        features: [],
      }) as OvertureBuildingCollection;
      const segments = data.segments as OvertureSegmentCollection | undefined;
      const water = data.water as OvertureWaterCollection | undefined;
      return overtureToCityData(buildings, bbox, placeName, { segments, water });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Overture Maps did not respond (${msg}). Try again in a moment.`);
    }
  });
