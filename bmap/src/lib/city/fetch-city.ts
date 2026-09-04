import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { fetchOverpassCity } from "./overpass";
import { normalizeBBox, shrinkBBoxToSpan, validateBBox } from "./geo";
import { cfg } from "./config";
import type { BBox, PlaceHit } from "./types";

const FetchInput = z.object({
  minLon: z.number(),
  minLat: z.number(),
  maxLon: z.number(),
  maxLat: z.number(),
  includeRoads: z.boolean(),
  includeWater: z.boolean(),
  placeName: z.string().max(120).optional(),
});

const SearchInput = z.object({
  q: z.string().trim().min(2).max(80),
});

export const fetchCity = createServerFn({ method: "POST" })
  .validator((data) => FetchInput.parse(data))
  .handler(async ({ data }) => {
    const bbox = normalizeBBox({
      minLon: data.minLon,
      minLat: data.minLat,
      maxLon: data.maxLon,
      maxLat: data.maxLat,
    });
    const err = validateBBox(bbox);
    if (err) throw new Error(err);
    return fetchOverpassCity(bbox, {
      includeRoads: data.includeRoads,
      includeWater: data.includeWater,
      placeName: data.placeName?.trim() || "Custom area",
    });
  });

type NominatimHit = {
  display_name?: string;
  lat?: string;
  lon?: string;
  boundingbox?: [string, string, string, string];
};

export const searchPlaces = createServerFn({ method: "POST" })
  .validator((data) => SearchInput.parse(data))
  .handler(async ({ data }): Promise<PlaceHit[]> => {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", data.q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "6");
    url.searchParams.set("addressdetails", "0");

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CityGLB/1.0 (real-world city GLB generator)",
      },
    });
    if (!res.ok) throw new Error("Place search is unavailable right now.");
    const json = (await res.json()) as NominatimHit[];
    if (!Array.isArray(json)) return [];

    return json
      .map((hit) => {
        const lat = Number(hit.lat);
        const lon = Number(hit.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        let bbox: BBox;
        if (hit.boundingbox && hit.boundingbox.length === 4) {
          const south = Number(hit.boundingbox[0]);
          const north = Number(hit.boundingbox[1]);
          const west = Number(hit.boundingbox[2]);
          const east = Number(hit.boundingbox[3]);
          bbox = shrinkBBoxToSpan(
            { minLon: west, minLat: south, maxLon: east, maxLat: north },
            1400,
          );
        } else {
          bbox = shrinkBBoxToSpan(
            { minLon: lon - 0.01, minLat: lat - 0.008, maxLon: lon + 0.01, maxLat: lat + 0.008 },
            1400,
          );
        }
        const err = validateBBox(bbox);
        if (err) {
          bbox = shrinkBBoxToSpan(bbox, cfg.MAX_SPAN_M);
        }
        const label = (hit.display_name ?? "Place").split(",").slice(0, 3).join(",").trim();
        return { label, lat, lon, bbox };
      })
      .filter((h): h is PlaceHit => h != null);
  });
