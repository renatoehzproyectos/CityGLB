/** Esquema compartido (cliente + servidor) del análisis de edificios por IA. */
import { z } from "zod";

export const FACADE_MATERIALS = ["brick", "concrete", "glass", "stucco", "stone", "metal", "wood"] as const;
export type FacadeMaterial = (typeof FACADE_MATERIALS)[number];

export const ROOF_SHAPES = ["flat", "gabled", "hipped", "pyramidal", "dome"] as const;

/** Edificios por imagen (más de ~40 baja la precisión y sube el costo). */
export const AI_MAX_BUILDINGS_PER_TILE = 40;
/** Tope de edificios analizados por generación (los más grandes primero). */
export const AI_MAX_BUILDINGS_TOTAL = 800;

export const TileRequestSchema = z.object({
  /** JPEG en base64 (sin prefijo data:). */
  image: z.string().min(100).max(3_000_000),
  buildings: z
    .array(
      z.object({
        id: z.number().int().min(1).max(999),
        areaM2: z.number().min(0).max(1e6),
        kind: z.string().max(40),
        priorHeight: z.number().min(0).max(300),
        heightKnown: z.boolean(),
        roofKnown: z.boolean(),
        facadeKnown: z.boolean(),
      }),
    )
    .min(1)
    .max(AI_MAX_BUILDINGS_PER_TILE),
  metersPerPixel: z.number().min(0.02).max(10),
  lat: z.number().min(-90).max(90),
});
export type TileRequest = z.infer<typeof TileRequestSchema>;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Cada campo es tolerante: si el modelo devuelve basura en uno, solo se descarta ese campo. */
export const AiBuildingSchema = z.object({
  id: z.number().int(),
  height_m: z.number().min(2).max(500).optional().catch(undefined),
  roof_shape: z.enum(ROOF_SHAPES).optional().catch(undefined),
  roof_color: hex.optional().catch(undefined),
  facade_color: hex.optional().catch(undefined),
  material: z.enum(FACADE_MATERIALS).optional().catch(undefined),
  confidence: z.number().min(0).max(1).catch(0.5),
});
export type AiBuilding = z.infer<typeof AiBuildingSchema>;

export type TileResponse =
  | { ok: true; buildings: AiBuilding[] }
  | { ok: false; reason: "not_configured" | "rate_limited" | "failed"; message: string };
