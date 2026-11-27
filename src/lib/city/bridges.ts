/**
 * Fase 3 — Puentes.
 *  · Detección: tramos marcados como puente en Overture (road_flags.is_bridge, con su tramo exacto) +
 *    inferidos: toda vía/ferrocarril que cruza un cuerpo de agua sin estar marcado (sobre ≥6 m de agua).
 *  · Tipos: carretera, calle, peatonal/ciclovía y ferroviario (ancho y acabado según clase).
 *  · Geometría: tablero con espesor, laterales, parapetos y pilas. Los extremos se anclan al terreno; si el vano
 *    no tiene holgura suficiente (río, quebrada) se arquea hasta tenerla. Pilas donde hay altura libre.
 *  · deckAt(x,z): altura del tablero para que el vehículo circule sobre el puente.
 */
import * as THREE from "three";
import type { CityData, Ring } from "./types";

export type Bridge = { pts: Ring; width: number; cls: string; inferred: boolean };
export type BridgeResult = { group: THREE.Group; count: number; deckAt: (x: number, z: number) => number | null };

const STEP = 3; // m entre secciones del tablero

const len = (pts: Ring) => {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
};

/** Puntos a distancia constante a lo largo de la polilínea. */
function resample(pts: Ring, step: number): Ring {
  const total = len(pts);
  const n = Math.max(2, Math.ceil(total / step) + 1);
  const out: Ring = [];
  let seg = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const d = (k / (n - 1)) * total;
    while (seg < pts.length - 2 && acc + Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]) < d) {
      acc += Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
      seg++;
    }
    const sl = Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]) || 1;
    const t = Math.min(1, Math.max(0, (d - acc) / sl));
    out.push([pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * t, pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * t]);
  }
  return out;
}

function pointInRing(x: number, z: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Puentes marcados + puentes inferidos por cruce de agua. */
export function collectBridges(data: CityData, maxBridges = 400): Bridge[] {
  const out: Bridge[] = [];
  const roads = data.roads ?? [];
  for (const r of roads) {
    if (r.bridge && !r.tunnel && r.pts.length >= 2 && len(r.pts) >= 6) {
      out.push({ pts: r.pts, width: r.width, cls: r.cls, inferred: false });
    }
  }
  const flagged = out.length;

  // inferidos por agua
  const water = (data.water ?? []).map((w) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of w.rings[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    return { rings: w.rings, x0, x1, z0, z1 };
  });
  if (water.length) {
    const inWater = (x: number, z: number) => {
      for (const w of water) {
        if (x < w.x0 || x > w.x1 || z < w.z0 || z > w.z1) continue;
        if (!pointInRing(x, z, w.rings[0])) continue;
        let hole = false;
        for (let k = 1; k < w.rings.length; k++) if (pointInRing(x, z, w.rings[k])) { hole = true; break; }
        if (!hole) return true;
      }
      return false;
    };
    const nearFlagged = (x: number, z: number, r: number) => {
      for (let b = 0; b < flagged; b++) for (const p of out[b].pts) if (Math.hypot(p[0] - x, p[1] - z) < r) return true;
      return false;
    };
    for (const r of roads) {
      if (out.length >= maxBridges) break;
      if (r.bridge || r.tunnel || r.pts.length < 2) continue;
      const S = resample(r.pts, 2);
      let k = 0;
      while (k < S.length) {
        if (!inWater(S[k][0], S[k][1])) { k++; continue; }
        let e = k;
        while (e + 1 < S.length && inWater(S[e + 1][0], S[e + 1][1])) e++;
        if ((e - k) * 2 >= 6) {
          const a = Math.max(0, k - 3), b = Math.min(S.length - 1, e + 3); // llega a las orillas
          const piece = S.slice(a, b + 1);
          const mid = piece[piece.length >> 1];
          if (!nearFlagged(mid[0], mid[1], 14 + r.width) && out.length < maxBridges) {
            out.push({ pts: piece, width: r.width, cls: r.cls, inferred: true });
          }
        }
        k = e + 1;
      }
    }
  }
  return out;
}

type Seg = { ax: number; az: number; ay: number; bx: number; bz: number; by: number; half: number };
const CELL = 24;

export function buildBridges(bridges: Bridge[], groundAt: ((x: number, z: number) => number) | null): BridgeResult | null {
  if (!bridges.length) return null;
  const g0 = groundAt ?? (() => 0);
  const pos: number[] = [];
  const col: number[] = [];
  type V = [number, number, number];
  type C = [number, number, number];
  const tri = (a: V, b: V, c: V, k: C) => { pos.push(...a, ...b, ...c); col.push(...k, ...k, ...k); };
  const quad = (a: V, b: V, c: V, d: V, k: C) => { tri(a, b, c, k); tri(a, c, d, k); };
  const box = (c: [number, number], ux: number, uz: number, hl: number, hw: number, y0: number, y1: number, k: C) => {
    const vx = -uz, vz = ux;
    const P = (sl: number, sw: number, y: number): V => [c[0] + ux * hl * sl + vx * hw * sw, y, c[1] + uz * hl * sl + vz * hw * sw];
    const b = [P(-1, -1, y0), P(1, -1, y0), P(1, 1, y0), P(-1, 1, y0)], t = [P(-1, -1, y1), P(1, -1, y1), P(1, 1, y1), P(-1, 1, y1)];
    quad(t[0], t[1], t[2], t[3], k);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; quad(b[i], b[j], t[j], t[i], k); }
  };

  const ASPHALT: C = [0.17, 0.17, 0.19], BALLAST: C = [0.3, 0.28, 0.26], DECKPATH: C = [0.5, 0.48, 0.45];
  const CONCRETE: C = [0.68, 0.67, 0.64], DARK: C = [0.5, 0.49, 0.47];
  const index = new Map<string, Seg[]>();
  const put = (s: Seg) => {
    const pad = s.half + 1;
    const i0 = Math.floor((Math.min(s.ax, s.bx) - pad) / CELL), i1 = Math.floor((Math.max(s.ax, s.bx) + pad) / CELL);
    const j0 = Math.floor((Math.min(s.az, s.bz) - pad) / CELL), j1 = Math.floor((Math.max(s.az, s.bz) + pad) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = `${i},${j}`;
      const a = index.get(k);
      if (a) a.push(s); else index.set(k, [s]);
    }
  };

  let built = 0;
  for (const br of bridges) {
    const P = resample(br.pts, STEP);
    const n = P.length;
    if (n < 2) continue;
    const rail = br.cls === "rail";
    const ped = br.width < 3.5 && !rail;
    const half = br.width / 2 + (rail ? 0.4 : ped ? 0.25 : 0.5);
    const ground = P.map(([x, z]) => g0(x, z));
    const total = len(P);

    // perfil del tablero: recta entre los apoyos + arco si falta holgura
    const y0 = ground[0] + 0.1, y1 = ground[n - 1] + 0.1;
    const base = P.map((_, i) => y0 + (y1 - y0) * (i / (n - 1)));
    const need = br.inferred || total > 25 ? 4.5 : 3;
    let minClear = Infinity;
    for (let i = 1; i < n - 1; i++) minClear = Math.min(minClear, base[i] - ground[i]);
    const amp = minClear < need ? Math.min(need - minClear, 9, total * 0.12) : 0;
    const deck = base.map((b, i) => b + amp * Math.sin(Math.PI * (i / (n - 1))));
    for (let pass = 0; pass < 3; pass++) {
      const c = deck.slice();
      for (let i = 1; i < n - 1; i++) deck[i] = (c[i - 1] + c[i] * 2 + c[i + 1]) / 4;
    }
    deck[0] = y0; deck[n - 1] = y1;
    const TH = rail ? 1.1 : ped ? 0.4 : 0.9;

    const tx: number[] = [], tz: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      tx.push(dx / l); tz.push(dz / l);
    }
    const edge = (i: number, side: number, off: number, y: number): V => [P[i][0] - tz[i] * off * side, y, P[i][1] + tx[i] * off * side];
    const topCol = rail ? BALLAST : ped ? DECKPATH : ASPHALT;
    const parH = rail ? 0.45 : 1.05, parW = 0.22;
    for (let i = 0; i < n - 1; i++) {
      const j = i + 1;
      quad(edge(i, -1, half, deck[i]), edge(i, 1, half, deck[i]), edge(j, 1, half, deck[j]), edge(j, -1, half, deck[j]), topCol); // calzada
      quad(edge(i, -1, half, deck[i] - TH), edge(j, -1, half, deck[j] - TH), edge(j, 1, half, deck[j] - TH), edge(i, 1, half, deck[i] - TH), DARK); // fondo
      for (const s of [-1, 1]) {
        quad(edge(i, s, half, deck[i]), edge(i, s, half, deck[i] - TH), edge(j, s, half, deck[j] - TH), edge(j, s, half, deck[j]), CONCRETE); // lateral
        // parapeto
        const o1 = half, o0 = half - parW;
        quad(edge(i, s, o1, deck[i]), edge(j, s, o1, deck[j]), edge(j, s, o1, deck[j] + parH), edge(i, s, o1, deck[i] + parH), CONCRETE);
        quad(edge(i, s, o0, deck[i]), edge(i, s, o0, deck[i] + parH), edge(j, s, o0, deck[j] + parH), edge(j, s, o0, deck[j]), CONCRETE);
        quad(edge(i, s, o0, deck[i] + parH), edge(i, s, o1, deck[i] + parH), edge(j, s, o1, deck[j] + parH), edge(j, s, o0, deck[j] + parH), CONCRETE);
      }
      put({ ax: P[i][0], az: P[i][1], ay: deck[i], bx: P[j][0], bz: P[j][1], by: deck[j], half });
    }

    // pilas: cada ~22 m donde hay altura libre; nunca junto a los estribos
    const every = Math.max(1, Math.round(22 / STEP));
    for (let i = every; i < n - 1; i += every) {
      if (i * STEP < 7 || (n - 1 - i) * STEP < 7) continue;
      const clear = deck[i] - TH - ground[i];
      if (clear < 2.2) continue;
      const w = Math.min(half * 2 * 0.62, rail ? 3.2 : 5);
      box(P[i], tx[i], tz[i], 0.85, w / 2, ground[i] - 1.5, deck[i] - TH, CONCRETE);
    }
    built++;
  }
  if (!built) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02, flatShading: true, side: THREE.DoubleSide }),
  );
  mesh.name = "bridges";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const group = new THREE.Group();
  group.name = "bridges";
  group.add(mesh);

  const deckAt = (x: number, z: number): number | null => {
    const list = index.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!list) return null;
    let best: number | null = null;
    for (const s of list) {
      const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2)) : 0;
      if (Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t)) <= s.half) {
        const y = s.ay + (s.by - s.ay) * t;
        if (best === null || y > best) best = y;
      }
    }
    return best;
  };
  return { group, count: built, deckAt };
}
