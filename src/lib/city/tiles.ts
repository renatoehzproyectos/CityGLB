import type { BuildingFeature, CityData } from "./types";
import { cfg } from "./config";
import { ringArea } from "./geo";

export type Tile = { u0: number; u1: number; w0: number; w1: number; depth: number };

/** Rejilla inicial: ~1,5 km por lado (una sola tesela en zonas pequeñas). */
export function planTiles(spanMeters: number): Tile[] {
  const n = Math.max(1, Math.ceil(spanMeters / 1500));
  const out: Tile[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out.push({ u0: i / n, u1: (i + 1) / n, w0: j / n, w1: (j + 1) / n, depth: 0 });
  return out;
}

function split(t: Tile): Tile[] {
  const um = (t.u0 + t.u1) / 2, wm = (t.w0 + t.w1) / 2, d = t.depth + 1;
  return [
    { u0: t.u0, u1: um, w0: t.w0, w1: wm, depth: d }, { u0: um, u1: t.u1, w0: t.w0, w1: wm, depth: d },
    { u0: t.u0, u1: um, w0: wm, w1: t.w1, depth: d }, { u0: um, u1: t.u1, w0: wm, w1: t.w1, depth: d },
  ];
}

const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : typeof e === "string" ? e : (() => { try { return JSON.stringify(e); } catch { return String(e); } })();

/**
 * Pide la ciudad por teselas: cada respuesta es pequeña (límite de serialización y de 4,5 MB
 * por respuesta en funciones serverless). Si una tesela es demasiado densa, el servidor
 * responde TILE_TOO_BIG y se divide en 4 automáticamente.
 */
export async function fetchCityTiled(
  fetchTile: (t: Tile) => Promise<CityData>,
  spanMeters: number,
  onProgress?: (done: number, total: number) => void,
  concurrency = 4,
): Promise<CityData> {
  const queue = planTiles(spanMeters);
  const parts: CityData[] = [];
  let total = queue.length, done = 0, active = 0, failure: unknown = null;

  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (failure) return;
      if (queue.length === 0 && active === 0) return resolve();
      while (active < concurrency && queue.length) {
        const t = queue.shift()!;
        active++;
        (async () => {
          let lastErr: unknown;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              parts.push(await fetchTile(t));
              done++;
              onProgress?.(done, total);
              return;
            } catch (e) {
              lastErr = e;
              if (errMsg(e).includes("TILE_TOO_BIG") && t.depth < 4) {
                const kids = split(t);
                total += kids.length - 1;
                queue.push(...kids);
                return;
              }
            }
          }
          throw lastErr;
        })()
          .catch((e) => { failure = e; reject(new Error(errMsg(e))); })
          .finally(() => { active--; pump(); });
      }
    };
    pump();
  });

  const base = parts[0];
  let buildings: BuildingFeature[] = parts.flatMap((p) => p.buildings);
  if (buildings.length > cfg.MAX_BUILDINGS) {
    buildings = buildings.sort((a, b) => ringArea(b.ring) - ringArea(a.ring)).slice(0, cfg.MAX_BUILDINGS);
  }
  return {
    ...base,
    buildings,
  };
}
