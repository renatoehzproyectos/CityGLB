import type { BBox } from "./types";
import { cfg } from "./config";

const M_PER_DEG = 111_320;

export function bboxCenter(bbox: BBox): { lon: number; lat: number } {
  return {
    lon: (bbox.minLon + bbox.maxLon) / 2,
    lat: (bbox.minLat + bbox.maxLat) / 2,
  };
}

export function project(
  lon: number,
  lat: number,
  originLon: number,
  originLat: number,
): [number, number] {
  const x = (lon - originLon) * M_PER_DEG * Math.cos((originLat * Math.PI) / 180);
  const z = (originLat - lat) * M_PER_DEG;
  return [x, z];
}

/** Inverse of project(): feature-local (x, z) meters → (lon, lat). */
export function unproject(
  x: number,
  z: number,
  originLon: number,
  originLat: number,
): [number, number] {
  const lon = originLon + x / (M_PER_DEG * Math.cos((originLat * Math.PI) / 180));
  const lat = originLat - z / M_PER_DEG;
  return [lon, lat];
}

export function bboxSizeMeters(bbox: BBox): { width: number; depth: number } {
  const { lat } = bboxCenter(bbox);
  const width = Math.abs(bbox.maxLon - bbox.minLon) * M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const depth = Math.abs(bbox.maxLat - bbox.minLat) * M_PER_DEG;
  return { width, depth };
}

export function normalizeBBox(bbox: BBox): BBox {
  return {
    minLon: Math.min(bbox.minLon, bbox.maxLon),
    minLat: Math.min(bbox.minLat, bbox.maxLat),
    maxLon: Math.max(bbox.minLon, bbox.maxLon),
    maxLat: Math.max(bbox.minLat, bbox.maxLat),
  };
}

export function validateBBox(bbox: BBox): string | null {
  const b = normalizeBBox(bbox);
  if (!Number.isFinite(b.minLon) || !Number.isFinite(b.minLat) || !Number.isFinite(b.maxLon) || !Number.isFinite(b.maxLat)) {
    return "Coordinates are invalid.";
  }
  if (b.minLon < -180 || b.maxLon > 180 || b.minLat < -85 || b.maxLat > 85) {
    return "Coordinates are out of range.";
  }
  if (b.maxLon - b.minLon > 180) {
    return "The area crosses the antimeridian. Choose a smaller window.";
  }
  const { width, depth } = bboxSizeMeters(b);
  const span = Math.max(width, depth);
  if (span < cfg.MIN_SPAN_M) {
    return `The area is too small (${Math.round(span)} m). Use at least ${cfg.MIN_SPAN_M} m.`;
  }
  return null;
}

export function ringArea(pts: [number, number][]): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return Math.abs(a) / 2;
}

export function pathLength(pts: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return len;
}

export function roundMeters(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatSpan(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

export function shrinkBBoxToSpan(bbox: BBox, maxSpan: number): BBox {
  const b = normalizeBBox(bbox);
  const { width, depth } = bboxSizeMeters(b);
  const span = Math.max(width, depth);
  if (span <= maxSpan) return b;
  const c = bboxCenter(b);
  const scale = maxSpan / span;
  const halfW = ((b.maxLon - b.minLon) * scale) / 2;
  const halfD = ((b.maxLat - b.minLat) * scale) / 2;
  return {
    minLon: c.lon - halfW,
    maxLon: c.lon + halfW,
    minLat: c.lat - halfD,
    maxLat: c.lat + halfD,
  };
}

export function bboxFromCenter(lon: number, lat: number, spanM: number): BBox {
  const half = spanM / 2;
  const dLon = half / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  const dLat = half / M_PER_DEG;
  return {
    minLon: lon - dLon,
    maxLon: lon + dLon,
    minLat: lat - dLat,
    maxLat: lat + dLat,
  };
}

/** Local-space axis-aligned box in feature meters (x right, z south-positive from project). */
export type LocalBox = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Convert a geographic BBox into a LocalBox centered on the bbox center (origin). */
export function bboxToLocalBox(bbox: BBox): LocalBox {
  const { width, depth } = bboxSizeMeters(bbox);
  return {
    minX: -width / 2,
    maxX: width / 2,
    minZ: -depth / 2,
    maxZ: depth / 2,
  };
}

function isInside(p: [number, number], edge: 0 | 1 | 2 | 3, box: LocalBox): boolean {
  switch (edge) {
    case 0: return p[0] >= box.minX; // left
    case 1: return p[0] <= box.maxX; // right
    case 2: return p[1] >= box.minZ; // bottom (minZ)
    case 3: return p[1] <= box.maxZ; // top (maxZ)
  }
}

function intersect(
  a: [number, number],
  b: [number, number],
  edge: 0 | 1 | 2 | 3,
  box: LocalBox,
): [number, number] {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  let t = 0;
  switch (edge) {
    case 0: // left x = minX
      t = dx === 0 ? 0 : (box.minX - a[0]) / dx;
      break;
    case 1: // right x = maxX
      t = dx === 0 ? 0 : (box.maxX - a[0]) / dx;
      break;
    case 2: // bottom z = minZ
      t = dz === 0 ? 0 : (box.minZ - a[1]) / dz;
      break;
    case 3: // top z = maxZ
      t = dz === 0 ? 0 : (box.maxZ - a[1]) / dz;
      break;
  }
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dz];
}

/**
 * Sutherland–Hodgman polygon clipping against an axis-aligned LocalBox.
 * Input ring may be open or closed; output is open (no repeated first point).
 * Returns null if the polygon is entirely outside or degenerates.
 */
export function clipPolygonToBox(
  ring: [number, number][],
  box: LocalBox,
): [number, number][] | null {
  let pts = closedRingLocal(ring);
  if (pts.length < 3) return null;

  for (let edge = 0; edge < 4; edge++) {
    const input = pts;
    pts = [];
    if (input.length === 0) break;
    let prev = input[input.length - 1];
    let prevIn = isInside(prev, edge as 0 | 1 | 2 | 3, box);
    for (const curr of input) {
      const currIn = isInside(curr, edge as 0 | 1 | 2 | 3, box);
      if (currIn) {
        if (!prevIn) pts.push(intersect(prev, curr, edge as 0 | 1 | 2 | 3, box));
        pts.push(curr);
      } else if (prevIn) {
        pts.push(intersect(prev, curr, edge as 0 | 1 | 2 | 3, box));
      }
      prev = curr;
      prevIn = currIn;
    }
  }

  // Deduplicate consecutive points
  const out: [number, number][] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) {
      out.push([p[0], p[1]]);
    }
  }
  if (out.length >= 3) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) out.pop();
  }
  return out.length >= 3 ? out : null;
}

function closedRingLocal(ring: [number, number][]): [number, number][] {
  if (ring.length < 2) return ring.slice();
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  return ring.slice();
}

/**
 * Liang–Barsky style polyline clipping that correctly handles multi-segment
 * paths that exit and re-enter the box. Returns zero or more clipped segments.
 */
export function clipPolylineToBox(
  path: [number, number][],
  box: LocalBox,
): [number, number][][] {
  if (path.length < 2) return [];
  const segments: [number, number][][] = [];
  let current: [number, number][] | null = null;

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const clipped = clipSegment(a, b, box);
    if (!clipped) {
      if (current && current.length >= 2) segments.push(current);
      current = null;
      continue;
    }
    const [ca, cb] = clipped;
    if (!current) {
      current = [ca, cb];
    } else {
      const last = current[current.length - 1];
      if (Math.hypot(last[0] - ca[0], last[1] - ca[1]) < 1e-6) {
        current.push(cb);
      } else {
        if (current.length >= 2) segments.push(current);
        current = [ca, cb];
      }
    }
  }
  if (current && current.length >= 2) segments.push(current);
  return segments;
}

function clipSegment(
  a: [number, number],
  b: [number, number],
  box: LocalBox,
): [[number, number], [number, number]] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];

  const edges: [number, number, number][] = [
    [-dx, a[0] - box.minX, 0], // left
    [dx, box.maxX - a[0], 0],  // right
    [-dz, a[1] - box.minZ, 0], // bottom
    [dz, box.maxZ - a[1], 0],  // top
  ];

  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  if (t0 > t1) return null;
  return [
    [a[0] + t0 * dx, a[1] + t0 * dz],
    [a[0] + t1 * dx, a[1] + t1 * dz],
  ];
}
