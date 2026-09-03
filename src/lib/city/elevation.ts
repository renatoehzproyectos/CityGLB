/**
 * Elevation from the Copernicus DEM GLO-30 (Digital Surface Model), ~30m /
 * 10 arc-second resolution, published as Cloud-Optimized GeoTIFFs on the
 * public "copernicus-dem-30m" AWS Open Data S3 bucket (Sinergise, no API
 * key required). Tiles are 1°x1° and named e.g.
 * Copernicus_DSM_COG_10_N51_00_E000_00_DEM. Ocean tiles don't exist; those
 * areas are treated as 0m. This is the same free, no-key DSM source used by
 * Bmap, chosen over SRTM/Terrarium because it also captures buildings and
 * vegetation surface height, not just bare terrain.
 */
import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import type { BBox } from "./types";

const DEM_BUCKET = "https://copernicus-dem-30m.s3.amazonaws.com";

function demTileName(tileLat: number, tileLon: number): string {
  const ns = tileLat >= 0 ? "N" : "S";
  const ew = tileLon >= 0 ? "E" : "W";
  const latStr = String(Math.abs(tileLat)).padStart(2, "0");
  const lonStr = String(Math.abs(tileLon)).padStart(3, "0");
  return `Copernicus_DSM_COG_10_${ns}${latStr}_00_${ew}${lonStr}_00_DEM`;
}

function demTileUrl(tileLat: number, tileLon: number): string {
  const name = demTileName(tileLat, tileLon);
  return `${DEM_BUCKET}/${name}/${name}.tif`;
}

type DemTile = {
  image: GeoTIFFImage;
  tiff: GeoTIFF;
  west: number;
  south: number;
  east: number;
  north: number;
  width: number;
  height: number;
};

const tileCache = new Map<string, Promise<DemTile | null>>();

async function getDemTile(tileLat: number, tileLon: number): Promise<DemTile | null> {
  const key = `${tileLat}/${tileLon}`;
  let promise = tileCache.get(key);
  if (!promise) {
    promise = (async () => {
      try {
        const tiff = await fromUrl(demTileUrl(tileLat, tileLon));
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
        // Tile doesn't exist (ocean / not yet released) — treat as sea level.
        return null;
      }
    })();
    tileCache.set(key, promise);
  }
  return promise;
}

export type HeightGrid = {
  width: number;
  height: number;
  /** row-major, meters above sea level */
  data: Float32Array;
  /** local X (meters east of origin) for each column */
  xs: Float32Array;
  /** local Z (meters north of origin, note Three.js -Z often south) */
  zs: Float32Array;
  minH: number;
  maxH: number;
  originLon: number;
  originLat: number;
};

/**
 * Sample a regular grid of elevations over the bbox using Copernicus GLO-30.
 * Uses grid resolution chosen so sample spacing ≈ targetMeters (default 25m).
 *
 * The "copernicus-dem-30m" AWS Open Data bucket is built for CLI/SDK
 * (no-sign-request) access and, unlike tile servers meant for browsers,
 * doesn't always answer the CORS preflight that geotiff.js's ranged fetches
 * need. If every tile in the grid fails to load (a strong CORS/network
 * signal, as opposed to a few tiles legitimately being ocean), we
 * automatically fall back to CORS-friendly Terrarium PNG elevation tiles so
 * the scene never silently goes flat.
 */
export async function fetchHeightGrid(
  bbox: BBox,
  origin: { lon: number; lat: number },
  options: {
    targetMeters?: number;
    maxSamples?: number;
    /** Called with fraction 0–1 as work completes. */
    onProgress?: (fraction: number) => void;
  } = {}
): Promise<HeightGrid> {
  const targetMeters = options.targetMeters ?? 25;
  const maxSamples = options.maxSamples ?? 96;
  const onProgress = options.onProgress;

  // Approximate meters per degree
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180);

  const widthM = (bbox.maxLon - bbox.minLon) * mPerDegLon;
  const depthM = (bbox.maxLat - bbox.minLat) * mPerDegLat;

  const cols = Math.max(8, Math.min(maxSamples, Math.ceil(widthM / targetMeters)));
  const rows = Math.max(8, Math.min(maxSamples, Math.ceil(depthM / targetMeters)));

  const xs = new Float32Array(cols);
  const zs = new Float32Array(rows);
  const data = new Float32Array(cols * rows);

  type Sample = { i: number; j: number; lon: number; lat: number; tileLat: number; tileLon: number };
  const samples: Sample[] = [];
  const tileKeys = new Set<string>();

  for (let j = 0; j < rows; j++) {
    const t = j / (rows - 1 || 1);
    const lat = bbox.minLat + t * (bbox.maxLat - bbox.minLat);
    zs[j] = (lat - origin.lat) * mPerDegLat;
    const tileLat = Math.floor(lat);
    for (let i = 0; i < cols; i++) {
      const s = i / (cols - 1 || 1);
      const lon = bbox.minLon + s * (bbox.maxLon - bbox.minLon);
      xs[i] = (lon - origin.lon) * mPerDegLon;
      const tileLon = Math.floor(lon);
      tileKeys.add(`${tileLat}/${tileLon}`);
      samples.push({ i, j, lon, lat, tileLat, tileLon });
    }
  }

  // Load every distinct 1x1deg DEM tile touched by the grid, then read a
  // pixel window per tile that covers all the samples that fall inside it.
  const loadedTiles = new Map<string, DemTile | null>();
  const tileKeyList = Array.from(tileKeys);
  let tilesDone = 0;
  await Promise.all(
    tileKeyList.map(async (key) => {
      const [tLat, tLon] = key.split("/").map(Number);
      loadedTiles.set(key, await getDemTile(tLat, tLon));
      tilesDone++;
      // Tile load is ~40% of this phase.
      onProgress?.(0.4 * (tilesDone / tileKeyList.length));
    })
  );

  // If literally every tile failed to load, this is almost certainly a
  // CORS/network block against the S3 bucket rather than "the whole area is
  // ocean" — fall back to Terrarium tiles instead of rendering flat ground.
  const allFailed = tileKeys.size > 0 && Array.from(loadedTiles.values()).every((t) => t === null);
  if (allFailed) {
    console.warn(
      "[elevation] Copernicus GLO-30 COG tiles failed to load (likely CORS) — falling back to Terrarium elevation tiles."
    );
    return fetchHeightGridTerrarium(bbox, origin, cols, rows, mPerDegLat, mPerDegLon, onProgress);
  }

  // Group samples by tile so we issue one ranged read per tile.
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

  let minH = Infinity;
  let maxH = -Infinity;

  const byTileEntries = Array.from(byTile.entries());
  let readsDone = 0;
  await Promise.all(
    byTileEntries.map(async ([key, tileSamples]) => {
      const tile = loadedTiles.get(key);
      if (!tile) {
        // Ocean / missing tile: sea level.
        for (const s of tileSamples) {
          data[s.j * cols + s.i] = 0;
        }
        readsDone++;
        onProgress?.(0.4 + 0.55 * (readsDone / byTileEntries.length));
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
          const h = band[(y - y0) * winW + (x - x0)] ?? 0;
          // DEM nodata is typically a large negative sentinel.
          data[s.j * cols + s.i] = h < -1000 ? 0 : h;
        }
      } catch {
        for (const { s } of pixels) {
          data[s.j * cols + s.i] = 0;
        }
      }
      readsDone++;
      onProgress?.(0.4 + 0.55 * (readsDone / byTileEntries.length));
    })
  );

  for (let n = 0; n < data.length; n++) {
    const h = data[n];
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  if (!Number.isFinite(minH)) {
    minH = 0;
    maxH = 0;
  }

  onProgress?.(1);

  return {
    width: cols,
    height: rows,
    data,
    xs,
    zs,
    minH,
    maxH,
    originLon: origin.lon,
    originLat: origin.lat,
  };
}

// ---------------------------------------------------------------------------
// Fallback: CORS-friendly Terrarium PNG elevation tiles (AWS Open Data
// "elevation-tiles-prod" bucket, built specifically for client-side/browser
// terrain rendering). Height is encoded per-pixel as:
//   height = (R * 256 + G + B / 256) - 32768
// ---------------------------------------------------------------------------

const TERRARIUM_TILE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

function lon2tileF(lon: number, z: number) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}
function lat2tileF(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
}

function loadImageEl(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function fetchHeightGridTerrarium(
  bbox: BBox,
  origin: { lon: number; lat: number },
  cols: number,
  rows: number,
  mPerDegLat: number,
  mPerDegLon: number,
  onProgress?: (fraction: number) => void
): Promise<HeightGrid> {
  const xs = new Float32Array(cols);
  const zs = new Float32Array(rows);
  const data = new Float32Array(cols * rows);

  // Pick a zoom level that keeps the mosaic to a reasonable tile count.
  let z = 13;
  for (let trial = 15; trial >= 8; trial--) {
    const x0 = lon2tileF(bbox.minLon, trial);
    const x1 = lon2tileF(bbox.maxLon, trial);
    const y0 = lat2tileF(bbox.maxLat, trial);
    const y1 = lat2tileF(bbox.minLat, trial);
    const nx = Math.ceil(x1) - Math.floor(x0);
    const ny = Math.ceil(y1) - Math.floor(y0);
    z = trial;
    if (nx * ny <= 36) break;
  }

  const tx0 = Math.floor(lon2tileF(bbox.minLon, z));
  const tx1 = Math.floor(lon2tileF(bbox.maxLon, z));
  const ty0 = Math.floor(lat2tileF(bbox.maxLat, z));
  const ty1 = Math.floor(lat2tileF(bbox.minLat, z));

  const tilesX = tx1 - tx0 + 1;
  const tilesY = ty1 - ty0 + 1;
  const TILE_PX = 256;

  const canvas = document.createElement("canvas");
  canvas.width = tilesX * TILE_PX;
  canvas.height = tilesY * TILE_PX;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  let anyLoaded = false;
  const totalTiles = tilesX * tilesY;
  let terrTilesDone = 0;
  await Promise.all(
    Array.from({ length: totalTiles }, (_, idx) => idx).map(async (idx) => {
      const dx = idx % tilesX;
      const dy = Math.floor(idx / tilesX);
      const url = TERRARIUM_TILE.replace("{z}", String(z))
        .replace("{x}", String(tx0 + dx))
        .replace("{y}", String(ty0 + dy));
      const img = await loadImageEl(url);
      terrTilesDone++;
      onProgress?.(0.9 * (terrTilesDone / totalTiles));
      if (img) {
        anyLoaded = true;
        ctx.drawImage(img, dx * TILE_PX, dy * TILE_PX, TILE_PX, TILE_PX);
      }
    })
  );

  if (!anyLoaded) {
    console.warn("[elevation] Terrarium fallback also failed to load — terrain will be flat.");
  }

  const imgData = anyLoaded ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;

  const worldPx = TILE_PX * Math.pow(2, z);
  const heightAtLonLat = (lon: number, lat: number): number => {
    if (!imgData) return 0;
    const px = Math.floor(lon2tileF(lon, z) * TILE_PX - tx0 * TILE_PX);
    const py = Math.floor(lat2tileF(lat, z) * TILE_PX - ty0 * TILE_PX);
    const cx = Math.max(0, Math.min(canvas.width - 1, px));
    const cy = Math.max(0, Math.min(canvas.height - 1, py));
    const idx = (cy * canvas.width + cx) * 4;
    const r = imgData.data[idx];
    const g = imgData.data[idx + 1];
    const b = imgData.data[idx + 2];
    return r * 256 + g + b / 256 - 32768;
  };
  void worldPx;

  let minH = Infinity;
  let maxH = -Infinity;
  for (let j = 0; j < rows; j++) {
    const t = j / (rows - 1 || 1);
    const lat = bbox.minLat + t * (bbox.maxLat - bbox.minLat);
    zs[j] = (lat - origin.lat) * mPerDegLat;
    for (let i = 0; i < cols; i++) {
      const s = i / (cols - 1 || 1);
      const lon = bbox.minLon + s * (bbox.maxLon - bbox.minLon);
      xs[i] = (lon - origin.lon) * mPerDegLon;
      const h = heightAtLonLat(lon, lat);
      data[j * cols + i] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  if (!Number.isFinite(minH)) {
    minH = 0;
    maxH = 0;
  }

  onProgress?.(1);

  return {
    width: cols,
    height: rows,
    data,
    xs,
    zs,
    minH,
    maxH,
    originLon: origin.lon,
    originLat: origin.lat,
  };
}

/** Bilinear sample height at local (x, z) meters */
export function sampleHeight(grid: HeightGrid, x: number, z: number): number {
  const { width, height, data, xs, zs } = grid;
  if (width < 2 || height < 2) return data[0] ?? 0;

  // Find i,j
  let i = 0;
  while (i < width - 1 && xs[i + 1] < x) i++;
  let j = 0;
  while (j < height - 1 && zs[j + 1] < z) j++;

  const i1 = Math.min(i + 1, width - 1);
  const j1 = Math.min(j + 1, height - 1);

  const x0 = xs[i];
  const x1 = xs[i1];
  const z0 = zs[j];
  const z1 = zs[j1];
  const tx = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
  const tz = z1 === z0 ? 0 : (z - z0) / (z1 - z0);

  const h00 = data[j * width + i];
  const h10 = data[j * width + i1];
  const h01 = data[j1 * width + i];
  const h11 = data[j1 * width + i1];

  const h0 = h00 * (1 - tx) + h10 * tx;
  const h1 = h01 * (1 - tx) + h11 * tx;
  return h0 * (1 - tz) + h1 * tz;
}
