/**
 * Color real de fachadas desde fotos de calle (Mapillary, CC BY-SA).
 * Solo completa edificios sin color de fachada conocido (b.facade).
 */
import { fetchStreetThumbsFn, listStreetImagesFn } from "./mapillary";
import { project } from "./geo";
import { colorFromCrop } from "./street-color";
import { selectViews, type LocalImage } from "./street-select";
import type { CityData } from "./types";
import { ringArea } from "./geo";

export type StreetResult = {
  applied: number;
  candidates: number;
  notConfigured?: boolean;
  warning?: string;
};

const MAX_BUILDINGS = 600;
const BATCH = 30;
const CONCURRENCY = 3;

async function decode(b64: string): Promise<{ data: Uint8ClampedArray; w: number; h: number } | null> {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    return { data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
  } catch {
    return null;
  }
}

export async function enrichFacadeColorsFromStreet(
  data: CityData,
  onProgress?: (done: number, total: number) => void,
): Promise<StreetResult> {
  const list = await listStreetImagesFn({ data: data.bbox });
  if (!list.ok) {
    return { applied: 0, candidates: 0, notConfigured: list.reason === "not_configured", warning: list.message };
  }
  const { lon: oLon, lat: oLat } = data.origin;
  const images: LocalImage[] = list.images.map((im) => {
    const [x, z] = project(im.lon, im.lat, oLon, oLat);
    return { id: im.id, x, z, h: im.h, t: im.t };
  });

  // Candidatos: edificios sin color de fachada, los más grandes primero
  const order = data.buildings
    .map((b, i) => ({ i, a: ringArea(b.ring), skip: Boolean(b.facade) }))
    .filter((x) => !x.skip && x.a >= 30)
    .sort((p, q) => q.a - p.a)
    .slice(0, MAX_BUILDINGS)
    .map((x) => x.i);
  const picks = selectViews(data.buildings, images, order);
  if (!picks.length) return { applied: 0, candidates: order.length };

  // Una descarga por imagen (varias fachadas pueden salir de la misma foto)
  const ids = [...new Set(picks.map((p) => p.imageId))];
  const byImage = new Map<string, typeof picks>();
  for (const p of picks) (byImage.get(p.imageId) ?? byImage.set(p.imageId, []).get(p.imageId)!).push(p);

  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));

  let applied = 0, done = 0, next = 0;
  let warning: string | undefined;
  let notConfigured = false;
  onProgress?.(0, batches.length);

  const worker = async () => {
    while (!notConfigured) {
      const bi = next++;
      if (bi >= batches.length) return;
      try {
        const res = await fetchStreetThumbsFn({ data: { ids: batches[bi] } });
        if (!res.ok) {
          if (res.reason === "not_configured") notConfigured = true;
          warning ??= res.message;
        } else {
          for (const t of res.thumbs) {
            const img = await decode(t.data);
            if (!img) continue;
            for (const p of byImage.get(t.id) ?? []) {
              const b = data.buildings[p.bi];
              if (b.facade) continue;
              const col = colorFromCrop(img.data, img.w, img.h, {
                x0: p.crop.u0 * img.w, x1: p.crop.u1 * img.w, y0: p.crop.v0 * img.h, y1: p.crop.v1 * img.h,
              });
              if (!col) continue;
              b.facade = [Math.min(1, col.color[0] * 1.06), Math.min(1, col.color[1] * 1.06), Math.min(1, col.color[2] * 1.06)];
              b.street = true;
              applied++;
            }
          }
        }
      } catch (e) {
        warning ??= e instanceof Error ? e.message : String(e);
      }
      onProgress?.(++done, batches.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return { applied, candidates: order.length, notConfigured, warning };
}
