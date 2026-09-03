function distToSeg(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function isClosed(pts: [number, number][]): boolean {
  if (pts.length < 2) return false;
  const a = pts[0];
  const b = pts[pts.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

export function simplifyRing(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length <= 4 || tolerance <= 0) return points;
  const closed = isClosed(points);
  const pts = closed ? points.slice(0, -1) : points.slice();
  if (pts.length <= 3) return points;

  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];

  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = 0;
    for (let i = s + 1; i < e; i++) {
      const d = distToSeg(pts[i], pts[s], pts[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }

  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) out.push(pts[i]);
  }
  if (closed && out.length) out.push([out[0][0], out[0][1]]);
  if (out.length < (closed ? 4 : 3)) return points;
  return out;
}

export function uniqueRing(points: [number, number][]): [number, number][] {
  if (points.length === 0) return points;
  const out: [number, number][] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const p = points[i];
    if (p[0] !== prev[0] || p[1] !== prev[1]) out.push(p);
  }
  return out;
}
