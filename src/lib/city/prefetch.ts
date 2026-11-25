import type { BBox } from "./types";
import { fetchHeightGrid, type HeightGrid } from "./elevation";
import { fetchLandCoverGrid, type LandCoverGrid } from "./landcover";
import { buildSatelliteCanvas, satelliteMaxPx } from "./satellite";
import { loadPolyHavenPbr } from "./pbr";

export type AssetOpts = { satellite: boolean; landCover: boolean; hdSatellite: boolean; pbr: boolean; flatTerrain: boolean };
export type CityAssets = {
  elev: Promise<HeightGrid | null>;
  cover: Promise<LandCoverGrid | null>;
  sat: Promise<HTMLCanvasElement | null>;
};

const MAX_ENTRIES = 2;
const store = new Map<string, CityAssets>();
const key = (b: BBox, o: AssetOpts) =>
  [b.minLon, b.minLat, b.maxLon, b.maxLat].map((n) => n.toFixed(6)).join(",") + JSON.stringify(o);

function widthMeters(b: BBox): number {
  const midLat = (b.minLat + b.maxLat) / 2;
  return (b.maxLon - b.minLon) * 111320 * Math.cos((midLat * Math.PI) / 180);
}

/**
 * Descargas que dependen solo del bbox (elevación, satélite, cobertura, texturas PBR).
 * Se lanzan al pulsar "Generate", EN PARALELO con la consulta a Overture, en vez de
 * esperar a tener los edificios. La entrada queda en caché para reconstruir sin re-descargar.
 */
export function getCityAssets(bbox: BBox, o: AssetOpts): CityAssets {
  const k = key(bbox, o);
  const hit = store.get(k);
  if (hit) return hit;
  const origin = { lon: (bbox.minLon + bbox.maxLon) / 2, lat: (bbox.minLat + bbox.maxLat) / 2 };

  // Terrarium (PNG pequeños) en vez de baldosas SRTM/COG de ~10–25 MB: misma zona, segundos menos.
  const elev = !o.flatTerrain
    ? fetchHeightGrid(bbox, origin, {
        targetMeters: Math.max(8, Math.min(24, widthMeters(bbox) / 96)),
        maxSamples: 140,
        source: "terrarium",
      }).catch((e) => {
        console.warn("Elevation fetch failed, falling back to flat", e);
        return null as HeightGrid | null;
      })
    : Promise.resolve(null as HeightGrid | null);

  const cover = o.landCover
    ? fetchLandCoverGrid(bbox, { targetMeters: 10, maxSamples: 512 }).catch((e) => {
        console.warn("Land cover fetch failed", e);
        return null as LandCoverGrid | null;
      })
    : Promise.resolve(null as LandCoverGrid | null);

  const sat =
    o.satellite && !o.landCover
      ? buildSatelliteCanvas(bbox, o.hdSatellite ? { maxPx: satelliteMaxPx(), zoomCap: 19 } : { maxPx: 2048, zoomCap: 18 }).catch((e) => {
          console.warn("Satellite texture failed", e);
          return null;
        })
      : Promise.resolve(null as HTMLCanvasElement | null);

  if (o.pbr) void loadPolyHavenPbr("cobblestone_floor_001", 1 / 2); // calienta la caché de texturas

  const assets = { elev, cover, sat };
  store.set(k, assets);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value as string);
  return assets;
}
