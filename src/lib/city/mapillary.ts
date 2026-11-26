import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { normalizeBBox, validateBBox } from "./geo";
import type { ListResult, ThumbResult } from "./mapillary.server";

const BBoxInput = z.object({ minLon: z.number(), minLat: z.number(), maxLon: z.number(), maxLat: z.number() });
const IdsInput = z.object({ ids: z.array(z.string().regex(/^\d{5,20}$/)).min(1).max(30) });

export const listStreetImagesFn = createServerFn({ method: "POST" })
  .validator((d) => BBoxInput.parse(d))
  .handler(async ({ data }): Promise<ListResult> => {
    const bbox = normalizeBBox(data);
    const err = validateBBox(bbox);
    if (err) return { ok: false, reason: "failed", message: err };
    const { listImages } = await import("./mapillary.server");
    return listImages(bbox);
  });

export const fetchStreetThumbsFn = createServerFn({ method: "POST" })
  .validator((d) => IdsInput.parse(d))
  .handler(async ({ data }): Promise<ThumbResult> => {
    const { fetchThumbs } = await import("./mapillary.server");
    return fetchThumbs(data.ids);
  });
