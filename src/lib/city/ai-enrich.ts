/**
 * Enriquecimiento de edificios con el modelo propio (ONNX en el navegador).
 * Solo completa lo que los datos reales no traen: nunca pisa altura, techo o fachada conocidos.
 */
import { cfg } from "./config";
import { clampHeight } from "./height";
import { pickCandidates, predictBuildings } from "./building-net";
import type { CityData } from "./types";

export type AiEnrichResult = {
  enriched: number;
  analyzed: number;
  /** El modelo no está desplegado en /models (hay que entrenarlo y copiarlo). */
  noModel?: boolean;
  warning?: string;
};

const MAX_BUILDINGS = 3000;
const MIN_AREA_M2 = 40;

export async function enrichBuildingsWithAI(
  data: CityData,
  sat: HTMLCanvasElement,
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<AiEnrichResult> {
  const idx = pickCandidates(data, MIN_AREA_M2, MAX_BUILDINGS).filter((i) => data.buildings[i].height >= cfg.MIN_BUILDING_HEIGHT);
  if (!idx.length) return { enriched: 0, analyzed: 0 };

  let preds;
  try {
    preds = await predictBuildings(sat, data, idx, opts.onProgress);
  } catch (e) {
    return { enriched: 0, analyzed: 0, warning: e instanceof Error ? e.message : String(e) };
  }
  if (!preds) return { enriched: 0, analyzed: 0, noModel: true };

  let enriched = 0;
  for (const [i, p] of preds) {
    const b = data.buildings[i];
    let touched = false;

    // Altura: confianza = 1 − sigma/0.5 (sigma en log-altura; 0.25 ≈ ±28 %). Mezcla con la estimación previa.
    const conf = Math.min(1, Math.max(0, 1 - p.sigma / 0.5));
    if (!b.heightKnown && conf >= 0.25) {
      b.height = clampHeight(b.height * (1 - conf) + p.height * conf);
      touched = true;
    }
    if (!b.roof?.shape && p.roof.p >= 0.5) {
      b.roof = { ...b.roof, shape: p.roof.cls };
      touched = true;
    }
    if (!b.streetMaterial && p.material.p >= 0.3) {
      b.material = p.material.cls;
      touched = true;
    }
    if (touched) {
      b.ai = true;
      enriched++;
    }
  }
  return { enriched, analyzed: preds.size };
}
