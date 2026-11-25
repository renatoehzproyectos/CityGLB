/** Solo servidor: llama al modelo de visión. La clave nunca llega al navegador. */
import { AiBuildingSchema, type AiBuilding, type TileRequest, type TileResponse } from "./ai-schema";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5-5";

// Límite en memoria por usuario (protege el gasto de la clave).
const WINDOW_MS = 60 * 60 * 1000;
const MAX_CALLS_PER_WINDOW = 600;
const calls = new Map<string, { count: number; resetAt: number }>();

function allow(userId: string): boolean {
  const now = Date.now();
  const e = calls.get(userId);
  if (!e || e.resetAt < now) {
    calls.set(userId, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (e.count >= MAX_CALLS_PER_WINDOW) return false;
  e.count++;
  return true;
}

const SYSTEM = `You are a photogrammetry analyst, like the system that builds Microsoft Flight Simulator's world from aerial imagery.
You receive ONE top-down aerial image. Building footprints are outlined in magenta, each with a numeric tag.
For each tagged building, estimate what the real building looks like. Respond with JSON only, no prose, no code fences:
{"buildings":[{"id":1,"height_m":14,"roof_shape":"flat","roof_color":"#8a8a86","facade_color":"#c9b79c","material":"stucco","confidence":0.7}]}

Rules:
- height_m: total height from ground to roof top (eave for pitched roofs) in meters. One storey ≈ 3 m. Use cast shadow length (shadows point away from the sun), footprint size and shape, building type, and the surrounding urban context. Remember typical heights differ by region and neighborhood.
- roof_shape: one of flat, gabled, hipped, pyramidal, dome. Judge it from visible ridge lines, shading and footprint.
- roof_color: the real roof color as seen from above, as #rrggbb. Ignore the magenta outline and shadows.
- facade_color: the most likely wall color as #rrggbb. Walls are barely visible from above, so infer from roof, neighbors and regional architecture and lower the confidence.
- material: one of brick, concrete, glass, stucco, stone, metal, wood.
- confidence: 0 to 1 for the whole entry. Be honest: if the image gives weak evidence, use a low value instead of guessing.
- If a field is marked as known for a building, OMIT that field for it.
- Skip a building entirely if it is not visible or unclear. Never invent ids.`;

function buildPrompt(req: TileRequest): string {
  const lines = req.buildings.map((b) => {
    const known = [
      b.heightKnown ? "height known" : `prior height ≈ ${Math.round(b.priorHeight)} m (a guess)`,
      b.roofKnown ? "roof known" : "",
      b.facadeKnown ? "facade known" : "",
    ]
      .filter(Boolean)
      .join(", ");
    return `#${b.id}: footprint ${Math.round(b.areaM2)} m², type "${b.kind}", ${known}`;
  });
  return `Image scale ≈ ${req.metersPerPixel.toFixed(2)} m/pixel, latitude ${req.lat.toFixed(2)}.\nBuildings:\n${lines.join("\n")}`;
}

function extractJson(text: string): unknown {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON in model output");
  return JSON.parse(text.slice(a, b + 1));
}

export async function analyzeTile(req: TileRequest, userId: string): Promise<TileResponse> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    return { ok: false, reason: "not_configured", message: "ANTHROPIC_API_KEY no está definida en el servidor." };
  }
  if (!allow(userId)) {
    return { ok: false, reason: "rate_limited", message: "Límite de análisis por hora alcanzado." };
  }
  const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: req.image } },
              { type: "text", text: buildPrompt(req) },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      return { ok: false, reason: "failed", message: `Modelo respondió ${res.status}: ${detail}` };
    }
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (body.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
    const raw = extractJson(text) as { buildings?: unknown };
    const validIds = new Set(req.buildings.map((b) => b.id));
    const out: AiBuilding[] = [];
    for (const item of Array.isArray(raw.buildings) ? raw.buildings : []) {
      const p = AiBuildingSchema.safeParse(item);
      if (p.success && validIds.has(p.data.id)) out.push(p.data);
    }
    return { ok: true, buildings: out };
  } catch (e) {
    return { ok: false, reason: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}
