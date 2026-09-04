/**
 * ESA WorldCover 10m v200 (2021) land-cover classification, published as
 * Cloud-Optimized GeoTIFFs on the public "esa-worldcover" AWS Open Data S3
 * bucket (no API key required). Tiles are 3°x3°, named e.g.
 * ESA_WorldCover_10m_2021_v200_N51E000_Map.tif.
 *
 * This drives the "biological/physical material" of the ground: which
 * pixels are tree cover, grassland, cropland, built-up, bare ground, or
 * water, so the terrain shading and vegetation placement approximate real
 * land cover instead of a flat green plane — the same free, no-key source
 * Bmap uses for ground material classification.
 */
import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import type { BBox } from "./types";

const WORLDCOVER_BUCKET = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map";

/** ESA WorldCover discrete class codes. */
export const LandCoverClass = {
  TreeCover: 10,
  Shrubland: 20,
  Grassland: 30,
  Cropland: 40,
  BuiltUp: 50,
  BareOrSparseVeg: 60,
  SnowAndIce: 70,
  PermanentWater: 80,
  HerbaceousWetland: 90,
  Mangroves: 95,
  MossAndLichen: 100,
} as const;

/** Official ESA WorldCover legend colors (sRGB hex). */
export const LAND_COVER_COLORS: Record<number, string> = {
  10: "#006400",
  20: "#ffbb22",
  30: "#ffff4c",
  40: "#f096ff",
  50: "#fa0000",
  60: "#b4b4b4",
  70: "#f0f0f0",
  80: "#0064c8",
  90: "#0096a0",
  95: "#00cf75",
  100: "#fae6a0",
};

export const LAND_COVER_LABELS: Record<number, string> = {
  10: "Tree cover",
  20: "Shrubland",
  30: "Grassland",
  40: "Cropland",
  50: "Built-up",
  60: "Bare / sparse vegetation",
  70: "Snow and ice",
  80: "Permanent water bodies",
  90: "Herbaceous wetland",
  95: "Mangroves",
  100: "Moss and lichen",
};

function tileName(tileLat: number, tileLon: number): string {
  const ns = tileLat >= 0 ? "N" : "S";
  const ew = tileLon >= 0 ? "E" : "W";
  const latStr = String(Math.abs(tileLat)).padStart(2, "0");
  const lonStr = String(Math.abs(tileLon)).padStart(3, "0");
  return `ESA_WorldCover_10m_2021_v200_${ns}${latStr}${ew}${lonStr}_Map`;
}

function tileUrl(tileLat: number, tileLon: number): string {
  const name = tileName(tileLat, tileLon);
  return `${WORLDCOVER_BUCKET}/${name}.tif`;
}

/** Snap to the 3°x3° WorldCover tile grid (tile origin is a multiple of 3). */
function snap3(v: number): number {
  return Math.floor(v / 3) * 3;
}

type CoverTile = {
  image: GeoTIFFImage;
  tiff: GeoTIFF;
  west: number;
  south: number;
  east: number;
  north: number;
  width: number;
  height: number;
};

const tileCache = new Map<string, Promise<CoverTile | null>>();

async function getCoverTile(tileLat: number, tileLon: number): Promise<CoverTile | null> {
  const key = `${tileLat}/${tileLon}`;
  let promise = tileCache.get(key);
  if (!promise) {
    promise = (async () => {
      try {
        const tiff = await fromUrl(tileUrl(tileLat, tileLon));
        const image = await tiff.getImage();
        const [west, south, east, north] = image.getBoundingBox();
        return {
          image,
          tiff,
          west,
          south,
          east,
          north,
          width: image.getWidth(),
          height: image.getHeight(),
        };
      } catch {
        // No land-cover tile (open ocean, etc.)
        return null;
      }
    })();
    tileCache.set(key, promise);
  }
  return promise;
}

export type LandCoverGrid = {
  width: number;
  height: number;
  /** row-major ESA WorldCover class codes (0 = unknown/no data) */
  classes: Uint8Array;
  bbox: BBox;
};

/**
 * Sample a regular grid of ESA WorldCover class codes over the bbox.
 * Grid resolution is independent from the elevation grid; default targets
 * roughly native 10m spacing, capped by maxSamples for perf.
 */
export async function fetchLandCoverGrid(
  bbox: BBox,
  options: {
    targetMeters?: number;
    maxSamples?: number;
    onProgress?: (fraction: number) => void;
  } = {}
): Promise<LandCoverGrid> {
  const targetMeters = options.targetMeters ?? 10;
  const maxSamples = options.maxSamples ?? 512;
  const onProgress = options.onProgress;

  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180);
  const widthM = (bbox.maxLon - bbox.minLon) * mPerDegLon;
  const depthM = (bbox.maxLat - bbox.minLat) * mPerDegLat;

  const cols = Math.max(8, Math.min(maxSamples, Math.ceil(widthM / targetMeters)));
  const rows = Math.max(8, Math.min(maxSamples, Math.ceil(depthM / targetMeters)));

  const classes = new Uint8Array(cols * rows);

  type Sample = { i: number; j: number; lon: number; lat: number; tileLat: number; tileLon: number };
  const samples: Sample[] = [];
  const tileKeys = new Set<string>();

  for (let j = 0; j < rows; j++) {
    const t = j / (rows - 1 || 1);
    const lat = bbox.minLat + t * (bbox.maxLat - bbox.minLat);
    const tileLat = snap3(lat);
    for (let i = 0; i < cols; i++) {
      const s = i / (cols - 1 || 1);
      const lon = bbox.minLon + s * (bbox.maxLon - bbox.minLon);
      const tileLon = snap3(lon);
      tileKeys.add(`${tileLat}/${tileLon}`);
      samples.push({ i, j, lon, lat, tileLat, tileLon });
    }
  }

  const loadedTiles = new Map<string, CoverTile | null>();
  const tileKeyList = Array.from(tileKeys);
  let tilesDone = 0;
  await Promise.all(
    tileKeyList.map(async (key) => {
      const [tLat, tLon] = key.split("/").map(Number);
      loadedTiles.set(key, await getCoverTile(tLat, tLon));
      tilesDone++;
      onProgress?.(0.4 * (tilesDone / Math.max(1, tileKeyList.length)));
    })
  );

  const byTile = new Map<string, Sample[]>();
  for (const s of samples) {
    const key = `${s.tileLat}/${s.tileLon}`;
    let arr = byTile.get(key);
    if (!arr) {
      arr = [];
      byTile.set(key, arr);
    }
    arr.push(s);
  }

  const byTileEntries = Array.from(byTile.entries());
  let readsDone = 0;
  await Promise.all(
    byTileEntries.map(async ([key, tileSamples]) => {
      const tile = loadedTiles.get(key);
      if (!tile) {
        // No tile: treat as bare/no-data (left as 0) so callers can fall back.
        readsDone++;
        onProgress?.(0.4 + 0.55 * (readsDone / Math.max(1, byTileEntries.length)));
        return;
      }

      const px = (lon: number) =>
        Math.max(0, Math.min(tile.width - 1, Math.floor(((lon - tile.west) / (tile.east - tile.west)) * tile.width)));
      const py = (lat: number) =>
        Math.max(0, Math.min(tile.height - 1, Math.floor(((tile.north - lat) / (tile.north - tile.south)) * tile.height)));

      let x0 = tile.width;
      let x1 = 0;
      let y0 = tile.height;
      let y1 = 0;
      const pixels = tileSamples.map((s) => {
        const x = px(s.lon);
        const y = py(s.lat);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        return { s, x, y };
      });
      x1 = Math.min(tile.width, x1 + 1);
      y1 = Math.min(tile.height, y1 + 1);

      try {
        const rasters = await tile.image.readRasters({ window: [x0, y0, x1, y1] });
        const band = rasters[0] as unknown as ArrayLike<number>;
        const winW = x1 - x0;
        for (const { s, x, y } of pixels) {
          const c = band[(y - y0) * winW + (x - x0)] ?? 0;
          classes[s.j * cols + s.i] = c;
        }
      } catch {
        // leave as 0 (unknown)
      }
      readsDone++;
      onProgress?.(0.4 + 0.55 * (readsDone / Math.max(1, byTileEntries.length)));
    })
  );

  onProgress?.(1);
  return { width: cols, height: rows, classes, bbox };
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Render the land-cover grid as a classified color canvas, matching the
 * satellite canvas's coordinate convention (U east, V north→south) so it
 * can be dropped in as the terrain material's texture map.
 */
export function buildLandCoverCanvas(grid: LandCoverGrid): HTMLCanvasElement {
  const { width, height, classes } = grid;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const c = classes[j * width + i];
      const [r, g, b] = hexToRgb(LAND_COVER_COLORS[c] ?? "#3a4a30");
      const idx = (j * width + i) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Nearest-neighbor class lookup at a given lon/lat within the grid. */
export function sampleLandCoverClass(grid: LandCoverGrid, lon: number, lat: number): number {
  const { bbox, width, height, classes } = grid;
  const u = (lon - bbox.minLon) / (bbox.maxLon - bbox.minLon || 1);
  const v = (lat - bbox.minLat) / (bbox.maxLat - bbox.minLat || 1);
  const i = Math.max(0, Math.min(width - 1, Math.round(u * (width - 1))));
  const j = Math.max(0, Math.min(height - 1, Math.round(v * (height - 1))));
  return classes[j * width + i];
}

/** Whether trees / vegetation may plausibly grow on this class. */
export function isVegetatedClass(c: number): boolean {
  return (
    c === LandCoverClass.TreeCover ||
    c === LandCoverClass.Shrubland ||
    c === LandCoverClass.Grassland ||
    c === LandCoverClass.Cropland ||
    c === LandCoverClass.HerbaceousWetland ||
    c === LandCoverClass.Mangroves
  );
}

/** Whether this class should block ground vegetation/trees entirely. */
export function isBuiltOrWaterClass(c: number): boolean {
  return (
    c === LandCoverClass.BuiltUp ||
    c === LandCoverClass.PermanentWater ||
    c === LandCoverClass.SnowAndIce
  );
}
