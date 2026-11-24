/** Datos de techo/fachada (sin dependencias de three: lo usan también los parsers del servidor). */
export type RGB = [number, number, number];
export type RoofShape = "flat" | "gabled" | "hipped" | "pyramidal" | "dome";
export type RoofInfo = { shape?: RoofShape; color?: RGB; height?: number; dir?: number };

const NAMED: Record<string, RGB> = {
  red: [0.72, 0.2, 0.15], brown: [0.45, 0.3, 0.2], grey: [0.55, 0.55, 0.56], gray: [0.55, 0.55, 0.56],
  white: [0.92, 0.92, 0.9], black: [0.15, 0.15, 0.16], beige: [0.85, 0.78, 0.62], yellow: [0.9, 0.78, 0.4],
  orange: [0.85, 0.48, 0.2], green: [0.3, 0.5, 0.3], blue: [0.3, 0.4, 0.65], pink: [0.88, 0.62, 0.6],
  tan: [0.78, 0.65, 0.48], cream: [0.93, 0.88, 0.72], terracotta: [0.72, 0.32, 0.2],
};

export function parseColor(raw: unknown): RGB | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  const m = s.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function parseRoofShape(raw: unknown): RoofShape | null {
  if (typeof raw !== "string") return null;
  switch (raw.trim().toLowerCase()) {
    case "flat": return "flat";
    case "gabled": case "gambrel": case "saltbox": case "skillion": case "sawtooth": case "gable": return "gabled";
    case "hipped": case "half_hipped": case "mansard": case "hip": case "half-hipped": return "hipped";
    case "pyramidal": case "pyramid": return "pyramidal";
    case "dome": case "spherical": case "onion": case "round": return "dome";
    default: return null;
  }
}

const ROOF_MATERIAL: Record<string, RGB> = {
  roof_tiles: [0.72, 0.32, 0.2], tiles: [0.72, 0.32, 0.2], tile: [0.72, 0.32, 0.2], clay: [0.72, 0.34, 0.22],
  slate: [0.3, 0.31, 0.34], copper: [0.42, 0.62, 0.55], metal: [0.6, 0.62, 0.64], concrete: [0.65, 0.63, 0.6],
  gravel: [0.5, 0.48, 0.46], tar_paper: [0.42, 0.41, 0.4], grass: [0.3, 0.45, 0.22], thatch: [0.6, 0.5, 0.3],
  wood: [0.5, 0.35, 0.22], solar_panels: [0.2, 0.25, 0.4], glass: [0.5, 0.65, 0.7], eternit: [0.55, 0.55, 0.54],
  plastic: [0.6, 0.6, 0.6],
};
const FACADE_MATERIAL: Record<string, RGB> = {
  brick: [0.62, 0.38, 0.3], clay: [0.75, 0.55, 0.4], stone: [0.78, 0.72, 0.62], plaster: [0.88, 0.82, 0.7],
  cement_block: [0.72, 0.7, 0.67], concrete: [0.7, 0.69, 0.67], glass: [0.5, 0.62, 0.7], metal: [0.7, 0.72, 0.74],
  wood: [0.6, 0.45, 0.3], timber_framing: [0.82, 0.75, 0.62], plastic: [0.85, 0.85, 0.82],
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

export function roofFromProps(p: {
  shape?: unknown; color?: unknown; material?: unknown; height?: unknown; direction?: unknown;
}): RoofInfo | undefined {
  const shape = parseRoofShape(p.shape) ?? undefined;
  const color = parseColor(p.color) ?? ROOF_MATERIAL[String(p.material ?? "").toLowerCase()] ?? undefined;
  const h = num(p.height);
  const height = h != null && h > 0.3 && h < 20 ? h : undefined;
  const d = num(p.direction);
  const dir = d != null && d >= 0 && d < 360 ? d : undefined;
  if (!shape && !color && height == null && dir == null) return undefined;
  return { shape, color, height, dir };
}

export function facadeFromProps(color: unknown, material: unknown): RGB | undefined {
  return parseColor(color) ?? FACADE_MATERIAL[String(material ?? "").toLowerCase()] ?? undefined;
}
