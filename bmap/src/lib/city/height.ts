import { cfg } from "./config";

function firstNumber(raw: string): number | null {
  const m = raw.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

export function parseHeightMeters(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    return raw > 1 ? raw : null;
  }
  const s = String(raw).toLowerCase().trim();
  if (!s) return null;
  const n = firstNumber(s);
  if (n == null || n <= 0) return null;
  if (s.includes("ft") || s.includes("feet")) return n * 0.3048;
  return n;
}

export function estimateHeight(tags: Record<string, string> | undefined): number {
  if (!tags) return cfg.DEFAULT_BUILDING_HEIGHT;

  const explicit = parseHeightMeters(tags.height ?? tags["building:height"]);
  if (explicit != null) {
    return clampHeight(explicit);
  }

  const levels = firstNumber(String(tags["building:levels"] ?? tags.levels ?? ""));
  if (levels != null && levels > 0) {
    return clampHeight(levels * cfg.LEVEL_HEIGHT);
  }

  return cfg.DEFAULT_BUILDING_HEIGHT;
}

export function clampHeight(h: number): number {
  return Math.min(cfg.MAX_BUILDING_HEIGHT, Math.max(cfg.MIN_BUILDING_HEIGHT, h));
}

export function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
