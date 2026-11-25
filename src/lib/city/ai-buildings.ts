import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { TileRequestSchema, type TileResponse } from "./ai-schema";

/** Analiza una zona (imagen aérea + edificios marcados) con el modelo de visión. */
export const analyzeBuildingTileFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data) => TileRequestSchema.parse(data))
  .handler(async ({ data, context }): Promise<TileResponse> => {
    const { analyzeTile } = await import("./ai-vision.server");
    return analyzeTile(data, context.userId);
  });
