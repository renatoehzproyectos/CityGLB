/**
 * Free satellite / aerial texture (no API key).
 * Uses Esri World Imagery XYZ tiles for the given bbox.
 */
import type { BBox } from "./types";

const TILE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

function lon2tile(lon: number, z: number) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}
function lat2tile(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z)
  );
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Composite World Imagery tiles covering bbox into a canvas.
 * Returns null if fetch fails.
 */
export async function buildSatelliteCanvas(
  bbox: BBox,
  options: { maxTiles?: number; targetPx?: number } = {}
): Promise<HTMLCanvasElement | null> {
  const maxTiles = options.maxTiles ?? 36;
  const targetPx = options.targetPx ?? 1024;

  const widthDeg = bbox.maxLon - bbox.minLon;
  const heightDeg = bbox.maxLat - bbox.minLat;
  if (widthDeg <= 0 || heightDeg <= 0) return null;

  // Choose zoom so ~maxTiles cover the area
  let z = 14;
  for (let trial = 18; trial >= 10; trial--) {
    const x0 = lon2tile(bbox.minLon, trial);
    const x1 = lon2tile(bbox.maxLon, trial);
    const y0 = lat2tile(bbox.maxLat, trial);
    const y1 = lat2tile(bbox.minLat, trial);
    const nx = Math.ceil(x1) - Math.floor(x0);
    const ny = Math.ceil(y1) - Math.floor(y0);
    if (nx * ny <= maxTiles) {
      z = trial;
      break;
    }
    z = trial;
  }

  const tx0 = Math.floor(lon2tile(bbox.minLon, z));
  const tx1 = Math.ceil(lon2tile(bbox.maxLon, z)) - 1;
  const ty0 = Math.floor(lat2tile(bbox.maxLat, z));
  const ty1 = Math.ceil(lat2tile(bbox.minLat, z)) - 1;

  const tilesX = tx1 - tx0 + 1;
  const tilesY = ty1 - ty0 + 1;
  if (tilesX <= 0 || tilesY <= 0 || tilesX * tilesY > maxTiles * 2) return null;

  const tileSize = 256;
  const fullW = tilesX * tileSize;
  const fullH = tilesY * tileSize;

  const canvas = document.createElement("canvas");
  // Downscale if huge
  const scale = Math.min(1, targetPx / Math.max(fullW, fullH));
  canvas.width = Math.max(64, Math.round(fullW * scale));
  canvas.height = Math.max(64, Math.round(fullH * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#2a3328";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const url = TILE.replace("{z}", String(z)).replace("{y}", String(ty)).replace("{x}", String(tx));
      jobs.push(
        loadImage(url).then((img) => {
          if (!img) return;
          const dx = (tx - tx0) * tileSize * scale;
          const dy = (ty - ty0) * tileSize * scale;
          ctx.drawImage(img, dx, dy, tileSize * scale, tileSize * scale);
        })
      );
    }
  }
  await Promise.all(jobs);

  // Crop to exact bbox within the tile mosaic
  const lon0 = (tx0 / Math.pow(2, z)) * 360 - 180;
  const lon1 = ((tx1 + 1) / Math.pow(2, z)) * 360 - 180;
  const n0 = Math.PI - (2 * Math.PI * ty0) / Math.pow(2, z);
  const lat0 = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n0) - Math.exp(-n0)));
  const n1 = Math.PI - (2 * Math.PI * (ty1 + 1)) / Math.pow(2, z);
  const lat1 = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n1) - Math.exp(-n1)));

  const u0 = (bbox.minLon - lon0) / (lon1 - lon0);
  const u1 = (bbox.maxLon - lon0) / (lon1 - lon0);
  // lat decreases downward in tiles
  const v0 = (lat0 - bbox.maxLat) / (lat0 - lat1);
  const v1 = (lat0 - bbox.minLat) / (lat0 - lat1);

  const sx = Math.max(0, Math.floor(u0 * canvas.width));
  const sy = Math.max(0, Math.floor(v0 * canvas.height));
  const sw = Math.max(1, Math.min(canvas.width - sx, Math.ceil((u1 - u0) * canvas.width)));
  const sh = Math.max(1, Math.min(canvas.height - sy, Math.ceil((v1 - v0) * canvas.height)));

  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  const octx = out.getContext("2d");
  if (!octx) return canvas;
  octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}
