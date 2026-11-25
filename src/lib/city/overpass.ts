import { parseOsm, parseOsmXml } from "./parse-osm";
import type { BBox, CityData } from "./types";

const OVERPASS_ENDPOINTS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

const UA = "CityGLB/1.0 (real-world city GLB generator)";

function buildQuery(bbox: BBox): string {
  const south = bbox.minLat.toFixed(6);
  const west = bbox.minLon.toFixed(6);
  const north = bbox.maxLat.toFixed(6);
  const east = bbox.maxLon.toFixed(6);
  const parts = [`way["building"]`, `relation["building"]`];
  return `[out:json][timeout:40][bbox:${south},${west},${north},${east}];(${parts.join(";")};);out body;>;out skel qt;`;
}

async function postOverpass(endpoint: string, query: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  });
  if (!res.ok) {
    throw new Error(`Overpass ${res.status} from ${new URL(endpoint).host}`);
  }
  return res.json();
}

async function fetchOsmApiXml(bbox: BBox, signal: AbortSignal): Promise<string> {
  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`;
  const res = await fetch(url, {
    headers: { Accept: "application/xml", "User-Agent": UA },
    signal,
  });
  if (!res.ok) throw new Error(`OSM API ${res.status}`);
  return res.text();
}

export async function fetchOverpassCity(
  bbox: BBox,
  opts: { placeName: string },
): Promise<CityData> {
  const query = buildQuery(bbox);
  let lastError: Error | null = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const json = await postOverpass(endpoint, query, controller.signal);
      return parseOsm(json as Parameters<typeof parseOsm>[0], bbox, opts.placeName);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const xml = await fetchOsmApiXml(bbox, controller.signal);
    return parseOsm(parseOsmXml(xml), bbox, opts.placeName);
  } catch (err) {
    lastError = err instanceof Error ? err : lastError;
  } finally {
    clearTimeout(timer);
  }

  throw new Error(lastError?.message ?? "OpenStreetMap did not respond. Try a smaller area.");
}
