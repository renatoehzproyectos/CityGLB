/**
 * NASA SRTM 1 arc-second (~30 m) desde AWS Open Data (bucket elevation-tiles-prod,
 * carpeta "skadi"): archivos .hgt.gz de 3601×3601 enteros de 16 bits big-endian.
 */
const SKADI = "https://s3.amazonaws.com/elevation-tiles-prod/skadi";

export type SrtmTile = { lat: number; lon: number; size: number; data: Int16Array };

const cache = new Map<string, Promise<SrtmTile | null>>();

function tileName(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${ns}${String(Math.abs(lat)).padStart(2, "0")}${ew}${String(Math.abs(lon)).padStart(3, "0")}`;
}

export function loadSrtmTile(lat: number, lon: number): Promise<SrtmTile | null> {
  const name = tileName(lat, lon);
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(`${SKADI}/${name.slice(0, 3)}/${name}.hgt.gz`);
        if (!res.ok || !res.body) return null;
        const ds = res.body.pipeThrough(new DecompressionStream("gzip"));
        const buf = await new Response(ds).arrayBuffer();
        const n = buf.byteLength / 2;
        const size = Math.round(Math.sqrt(n));
        if (size * size !== n) return null;
        const view = new DataView(buf);
        const data = new Int16Array(n);
        for (let i = 0; i < n; i++) data[i] = view.getInt16(i * 2, false);
        return { lat, lon, size, data };
      } catch {
        return null;
      }
    })();
    cache.set(name, p);
  }
  return p;
}

/** Altura bilineal en (lon, lat); null si falta el tile. Vacíos (-32768) → 0. */
export function sampleSrtm(tiles: Map<string, SrtmTile | null>, lon: number, lat: number): number | null {
  const tl = Math.floor(lat);
  const tn = Math.floor(lon);
  const t = tiles.get(`${tl}/${tn}`);
  if (!t) return null;
  const n = t.size - 1;
  const fx = (lon - tn) * n;
  const fy = (tl + 1 - lat) * n;
  const x0 = Math.min(n - 1, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(n - 1, Math.max(0, Math.floor(fy)));
  const tx = fx - x0;
  const ty = fy - y0;
  const h = (x: number, y: number) => {
    const v = t.data[y * t.size + x];
    return v === -32768 ? 0 : v;
  };
  const a = h(x0, y0) * (1 - tx) + h(x0 + 1, y0) * tx;
  const b = h(x0, y0 + 1) * (1 - tx) + h(x0 + 1, y0 + 1) * tx;
  return a * (1 - ty) + b * ty;
}
