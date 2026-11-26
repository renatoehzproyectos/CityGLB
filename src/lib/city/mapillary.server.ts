/** Solo servidor: la clave MAPILLARY_TOKEN nunca llega al navegador. */
import type { BBox } from "./types";

const GRAPH = "https://graph.mapillary.com";
export type StreetImage = { id: string; lon: number; lat: number; h: number; t: number };
export type ListResult =
  | { ok: true; images: StreetImage[] }
  | { ok: false; reason: "not_configured" | "failed"; message: string };
export type ThumbResult =
  | { ok: true; thumbs: { id: string; data: string }[] }
  | { ok: false; reason: "not_configured" | "failed"; message: string };

const token = () => process.env.MAPILLARY_TOKEN?.trim() || "";
const auth = (t: string) => ({ Authorization: `OAuth ${t}` });

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Imágenes de calle (no panorámicas) dentro del bbox. Se divide en celdas: cada consulta tope 2000. */
export async function listImages(bbox: BBox): Promise<ListResult> {
  const t = token();
  if (!t) return { ok: false, reason: "not_configured", message: "MAPILLARY_TOKEN no está definida en el servidor." };

  const N = 3;
  const cells: BBox[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      cells.push({
        minLon: bbox.minLon + ((bbox.maxLon - bbox.minLon) * i) / N,
        maxLon: bbox.minLon + ((bbox.maxLon - bbox.minLon) * (i + 1)) / N,
        minLat: bbox.minLat + ((bbox.maxLat - bbox.minLat) * j) / N,
        maxLat: bbox.minLat + ((bbox.maxLat - bbox.minLat) * (j + 1)) / N,
      });
    }
  }
  const seen = new Map<string, StreetImage>();
  let failures = 0;
  let lastMsg = "";
  await pool(cells, 3, async (c) => {
    const url = new URL(`${GRAPH}/images`);
    url.searchParams.set("bbox", `${c.minLon},${c.minLat},${c.maxLon},${c.maxLat}`);
    url.searchParams.set("fields", "id,computed_geometry,geometry,computed_compass_angle,compass_angle,captured_at,is_pano");
    url.searchParams.set("limit", "2000");
    try {
      const res = await fetch(url, { headers: auth(t), signal: AbortSignal.timeout(25_000) });
      if (!res.ok) {
        failures++;
        lastMsg = `Mapillary respondió ${res.status}: ${(await res.text()).slice(0, 160)}`;
        return;
      }
      const body = (await res.json()) as { data?: Record<string, any>[] };
      for (const im of body.data ?? []) {
        if (im.is_pano) continue;
        const geom = im.computed_geometry ?? im.geometry;
        const heading = im.computed_compass_angle ?? im.compass_angle;
        const coords = geom?.coordinates;
        if (!Array.isArray(coords) || typeof heading !== "number" || !im.id) continue;
        seen.set(String(im.id), {
          id: String(im.id),
          lon: Math.round(coords[0] * 1e6) / 1e6,
          lat: Math.round(coords[1] * 1e6) / 1e6,
          h: Math.round(heading),
          t: Number(im.captured_at) || 0,
        });
      }
    } catch (e) {
      failures++;
      lastMsg = e instanceof Error ? e.message : String(e);
    }
  });
  if (failures === cells.length) return { ok: false, reason: "failed", message: lastMsg || "Mapillary no respondió." };
  return { ok: true, images: [...seen.values()] };
}

const okHost = (u: string) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && (x.hostname.endsWith("fbcdn.net") || x.hostname.endsWith("mapillary.com"));
  } catch {
    return false;
  }
};

/** Miniaturas (256 px) en base64 de las imágenes pedidas. */
export async function fetchThumbs(ids: string[]): Promise<ThumbResult> {
  const t = token();
  if (!t) return { ok: false, reason: "not_configured", message: "MAPILLARY_TOKEN no está definida en el servidor." };
  const got = await pool(ids, 8, async (id) => {
    try {
      const meta = await fetch(`${GRAPH}/${id}?fields=thumb_256_url`, { headers: auth(t), signal: AbortSignal.timeout(15_000) });
      if (!meta.ok) return null;
      const url = ((await meta.json()) as { thumb_256_url?: string }).thumb_256_url;
      if (!url || !okHost(url)) return null;
      const img = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!img.ok) return null;
      return { id, data: Buffer.from(await img.arrayBuffer()).toString("base64") };
    } catch {
      return null;
    }
  });
  return { ok: true, thumbs: got.filter((x): x is { id: string; data: string } => x !== null) };
}
