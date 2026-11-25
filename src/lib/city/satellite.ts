/**
 * Imagen satelital gratuita (sin API key): teselas Esri World Imagery para el bbox.
 *
 * Calidad máxima:
 *  - Elige el zoom MÁS ALTO cuyo mosaico nativo cabe en `maxPx` (sin reescalar ni
 *    recortar de más) y detecta hasta qué zoom hay imagen real en la zona.
 *  - Dibuja las teselas directamente sobre el recorte exacto del bbox (sin mosaico
 *    intermedio gigante ni pérdida por submuestreo).
 *  - Si una tesela falla o es el aviso gris "Map data not yet available", la rellena
 *    con la del zoom superior en vez de dejar un hueco.
 */
import type { BBox } from "./types";

const TILE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TS = 256;

const lon2tile = (lon: number, z: number) => ((lon + 180) / 360) * Math.pow(2, z);
const lat2tile = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
};

/** Lado máximo de textura que conviene pedir en este dispositivo (GPU + memoria del canvas). */
export function satelliteMaxPx(): number {
  try {
    const gl = document.createElement("canvas").getContext("webgl2") as WebGL2RenderingContext | null;
    const maxTex = gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 4096;
    const mobile = typeof navigator !== "undefined" && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    return Math.max(2048, Math.min(mobile ? 4096 : 8192, maxTex));
  } catch {
    return 4096;
  }
}

function loadImage(url: string, retries = 2): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const attempt = (n: number) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => (n < retries ? setTimeout(() => attempt(n + 1), 250 * (n + 1)) : resolve(null));
      img.src = url;
    };
    attempt(0);
  });
}

const tileUrl = (z: number, x: number, y: number) =>
  TILE.replace("{z}", String(z)).replace("{y}", String(y)).replace("{x}", String(x));

/** El aviso "Map data not yet available" es casi uniforme: baja desviación de luminancia. */
function isPlaceholder(img: HTMLImageElement): boolean {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 24;
    const x = c.getContext("2d", { willReadFrequently: true })!;
    x.drawImage(img, 0, 0, 24, 24);
    const d = x.getImageData(0, 0, 24, 24).data;
    let m = 0, m2 = 0;
    const n = 24 * 24;
    for (let i = 0; i < n; i++) {
      const l = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
      m += l; m2 += l * l;
    }
    m /= n;
    return Math.sqrt(Math.max(0, m2 / n - m * m)) < 3.5;
  } catch {
    return false;
  }
}

/** Mayor zoom (≤ zoomCap) con imagen real en el centro del bbox. */
async function probeMaxZoom(bbox: BBox, zoomCap: number): Promise<number> {
  const lon = (bbox.minLon + bbox.maxLon) / 2;
  const lat = (bbox.minLat + bbox.maxLat) / 2;
  for (let z = zoomCap; z >= 15; z--) {
    const img = await loadImage(tileUrl(z, Math.floor(lon2tile(lon, z)), Math.floor(lat2tile(lat, z))), 1);
    if (img && !isPlaceholder(img)) return z;
  }
  return 15;
}

export async function buildSatelliteCanvas(
  bbox: BBox,
  options: { maxPx?: number; zoomCap?: number } = {},
): Promise<HTMLCanvasElement | null> {
  const maxPx = options.maxPx ?? 2048;
  if (bbox.maxLon <= bbox.minLon || bbox.maxLat <= bbox.minLat) return null;

  // Zoom: el mayor cuyo tamaño nativo no supera maxPx (≈15 % de margen), limitado por la cobertura real.
  const zMax = await probeMaxZoom(bbox, options.zoomCap ?? 19);
  const nativeAt = (z: number) => ({
    w: (lon2tile(bbox.maxLon, z) - lon2tile(bbox.minLon, z)) * TS,
    h: (lat2tile(bbox.minLat, z) - lat2tile(bbox.maxLat, z)) * TS,
  });
  let z = zMax;
  while (z > 10) {
    const n = nativeAt(z);
    if (Math.max(n.w, n.h) <= maxPx * 1.15) break;
    z--;
  }

  const x0p = lon2tile(bbox.minLon, z) * TS;
  const y0p = lat2tile(bbox.maxLat, z) * TS;
  const nat = nativeAt(z);
  const s = Math.min(1, maxPx / Math.max(nat.w, nat.h));
  const W = Math.max(64, Math.round(nat.w * s));
  const H = Math.max(64, Math.round(nat.h * s));

  const tx0 = Math.floor(x0p / TS), tx1 = Math.floor((x0p + nat.w) / TS);
  const ty0 = Math.floor(y0p / TS), ty1 = Math.floor((y0p + nat.h) / TS);
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 1300) return null;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#2a3328";
  ctx.fillRect(0, 0, W, H);

  const parentCache = new Map<string, Promise<HTMLImageElement | null>>();
  const getTile = (zz: number, x: number, y: number) => {
    const k = `${zz}/${x}/${y}`;
    let p = parentCache.get(k);
    if (!p) { p = loadImage(tileUrl(zz, x, y)); parentCache.set(k, p); }
    return p;
  };

  const drawTile = async (tx: number, ty: number) => {
    const dx = Math.floor((tx * TS - x0p) * s), dy = Math.floor((ty * TS - y0p) * s);
    const dw = Math.ceil(TS * s) + 1, dh = Math.ceil(TS * s) + 1; // +1 px: evita costuras
    let img = await getTile(z, tx, ty);
    if (img && !isPlaceholder(img)) { ctx.drawImage(img, dx, dy, dw, dh); return; }
    // Respaldo: usa la tesela del zoom superior (recorte del cuadrante correspondiente).
    for (let L = 1; L <= 3 && z - L >= 8; L++) {
      const parent = await getTile(z - L, tx >> L, ty >> L);
      if (!parent || isPlaceholder(parent)) continue;
      const sub = TS >> L;
      ctx.drawImage(parent, (tx & ((1 << L) - 1)) * sub, (ty & ((1 << L) - 1)) * sub, sub, sub, dx, dy, dw, dh);
      return;
    }
  };

  // Cola con concurrencia acotada (cientos de teselas sin saturar la red del navegador).
  const jobs: [number, number][] = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [tx, ty] = jobs[next++];
      await drawTile(tx, ty);
    }
  };
  await Promise.all(Array.from({ length: 20 }, worker));
  console.info(`[satellite] z${z}, ${jobs.length} teselas, ${W}×${H}px (nativo ${Math.round(nat.w)}×${Math.round(nat.h)})`);
  return canvas;
}
