/**
 * Fase 4 — Túneles.
 *  · Detección: tramos con road_flags.is_tunnel de Overture (con su tramo exacto). Los tramos contiguos del mismo
 *    tipo (carretera / ferrocarril / peatonal) se encadenan: un túnel largo es UNA obra con portales solo en sus extremos.
 *  · Perfil: la rasante baja desde los portales con pendiente máxima (8 % carretera, 4 % tren, 12 % peatonal) hasta
 *    quedar bajo el terreno con cobertura. Donde aún no hay cobertura suficiente es TRINCHERA abierta (sin techo).
 *  · Terreno: en la trinchera se talla la malla de alturas para que el camino no quede tapado por el cerro.
 *  · Geometría: sección en bóveda (hastiales verticales + arco), solera con marcas viales/rieles, portales con
 *    muro de cabecera, trinchera con taludes. El interior es de material sin luz (la luz solar no atraviesa el cerro)
 *    con iluminación "horneada": charcos de luz bajo cada luminaria, penumbra entre ellas, luz de día que decae
 *    desde la boca, y luminarias emisivas en la bóveda.
 *  · floorAt(x,z): cota de la solera para que el vehículo circule por dentro.
 */
import * as THREE from "three";
import type { HeightGrid } from "./elevation";
import { bilinear } from "./flatten";
import { len, resample } from "./bridges";
import type { CityData, Ring, RoadFeature } from "./types";

export type TunnelKind = "road" | "rail" | "ped";
export type TunnelPlan = {
  P: Ring; f: number[]; g: number[]; open: boolean[]; s: number[];
  tx: number[]; tz: number[];
  half: number; H: number; kind: TunnelKind; total: number; step: number;
};
export type TunnelHit = {
  floor: number; ceil: number; half: number;
  /** distancia lateral con signo al eje y normal unitaria (xz) del eje en el punto más cercano */
  d: number; nx: number; nz: number; px: number; pz: number;
};
export type TunnelResult = {
  group: THREE.Group; count: number; floorAt: (x: number, z: number) => number | null; lamps: number;
  /** Consulta en (x,z,y): tramo CUBIERTO cuya solera está a menos de ~3 m de y; null si no hay. */
  query: (x: number, z: number, y: number) => TunnelHit | null;
};

const ROOF = 0.8, COVER_MIN = 0.5, COVER_EXTRA = 0.6;
const kindOf = (cls: string, width: number): TunnelKind => (cls === "rail" ? "rail" : width < 3.5 ? "ped" : "road");

/** Une los tramos de túnel contiguos del mismo tipo en una sola polilínea. */
export function chainTunnels(roads: RoadFeature[]): { pts: Ring; width: number; cls: string; kind: TunnelKind }[] {
  const chains = roads
    .filter((r) => r.tunnel && r.pts.length >= 2)
    .map((r) => ({ pts: r.pts.slice(), width: r.width, cls: r.cls, kind: kindOf(r.cls, r.width) }));
  const close = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1.5;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        const a = chains[i], b = chains[j];
        if (a.kind !== b.kind) continue;
        const a0 = a.pts[0], a1 = a.pts[a.pts.length - 1], b0 = b.pts[0], b1 = b.pts[b.pts.length - 1];
        let np: Ring | null = null;
        if (close(a1, b0)) np = [...a.pts, ...b.pts.slice(1)];
        else if (close(a1, b1)) np = [...a.pts, ...b.pts.slice(0, -1).reverse()];
        else if (close(a0, b1)) np = [...b.pts, ...a.pts.slice(1)];
        else if (close(a0, b0)) np = [...b.pts.slice().reverse(), ...a.pts.slice(1)];
        if (np) {
          chains[i] = { ...a, pts: np, width: Math.max(a.width, b.width) };
          chains.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return chains.filter((c) => len(c.pts) >= 12);
}

/** Planifica rasante, trinchera/cobertura y talla el terreno. Devuelve la malla de alturas (copia) tallada. */
export function planTunnels(data: CityData, grid: HeightGrid, maxTunnels = 60): { grid: HeightGrid; plans: TunnelPlan[] } {
  const chains = chainTunnels(data.roads ?? []).slice(0, maxTunnels);
  const plans: TunnelPlan[] = [];
  const gAt = (x: number, z: number) => bilinear(grid, x, -z);

  for (const c of chains) {
    const kind = c.kind;
    const inner = kind === "road" ? Math.min(11, Math.max(c.width, 5.5)) : kind === "rail" ? 5.2 : Math.max(2.6, c.width);
    const half = inner / 2 + (kind === "ped" ? 0.2 : 0.45);
    const H = kind === "rail" ? 6.0 : kind === "road" ? 5.0 : 3.0;
    const slope = kind === "rail" ? 0.04 : kind === "ped" ? 0.12 : 0.08;
    const total = len(c.pts);
    const step = Math.min(4, Math.max(1.5, total / 700));
    const P = resample(c.pts, step);
    const n = P.length;
    const tx: number[] = [], tz: number[] = [], s: number[] = [0];
    for (let i = 0; i < n; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      tx.push(dx / l); tz.push(dz / l);
      if (i > 0) s.push(s[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    }
    // terreno sobre el túnel: el más bajo entre el eje y los costados (ladera)
    const g = P.map(([x, z], i) => {
      const off = half + 2;
      return Math.min(gAt(x, z), gAt(x - tz[i] * off, z + tx[i] * off), gAt(x + tz[i] * off, z - tx[i] * off));
    });
    const g0 = gAt(P[0][0], P[0][1]), g1 = gAt(P[n - 1][0], P[n - 1][1]);
    const tot = s[n - 1] || 1;
    const sl = Math.max(slope, Math.min(0.2, (H + ROOF + COVER_EXTRA) / (tot * 0.4))); // túneles cortos: rampa más fuerte
    const f = P.map((_, i) => {
      const lin = g0 + (g1 - g0) * (s[i] / tot);
      const cap = g[i] - (H + ROOF + COVER_EXTRA);
      return Math.max(Math.min(lin, cap), g0 - sl * s[i], g1 - sl * (tot - s[i]));
    });
    f[0] = g0 + 0.05; f[n - 1] = g1 + 0.05; // portales a nivel del terreno
    // limita la pendiente en ambos sentidos SOLO bajando la rasante (más cobertura, nunca menos)
    for (let i = 1; i < n; i++) f[i] = Math.min(f[i], f[i - 1] + sl * (s[i] - s[i - 1]));
    for (let i = n - 2; i >= 0; i--) f[i] = Math.min(f[i], f[i + 1] + sl * (s[i + 1] - s[i]));
    for (let pass = 0; pass < 2; pass++) {
      const cp = f.slice();
      for (let i = 1; i < n - 1; i++) f[i] = (cp[i - 1] + 2 * cp[i] + cp[i + 1]) / 4;
    }
    // cubierto con histéresis: para PASAR a cubierto se exige cobertura >= COVER_MIN; una vez cubierto, se sigue así
    // mientras quede >= 0 (evita parpadeo abierto/cubierto, que generaba varios portales seguidos)
    const open: boolean[] = new Array(n).fill(true);
    {
      const cov = (i: number) => g[i] - (f[i] + H + ROOF);
      let state = false;
      for (let i = 0; i < n; i++) {
        state = state ? cov(i) >= 0 : cov(i) >= COVER_MIN;
        open[i] = !state;
      }
    }
    const runs = (val: boolean) => {
      const out: [number, number][] = [];
      for (let i = 0; i < n; ) {
        if (open[i] !== val) { i++; continue; }
        let e = i;
        while (e + 1 < n && open[e + 1] === val) e++;
        out.push([i, e]);
        i = e + 1;
      }
      return out;
    };
    // huecos abiertos cortos entre dos tramos cubiertos (< 14 m): se cubren; tramos cubiertos cortos (< 10 m): se abren
    for (const [a, b] of runs(true)) if (a > 0 && b < n - 1 && s[b] - s[a] < 14) for (let k = a; k <= b; k++) open[k] = false;
    for (const [a, b] of runs(false)) if (s[b] - s[a] < 10) for (let k = a; k <= b; k++) open[k] = true;
    plans.push({ P, f, g, open, s, tx, tz, half, H, kind, total: tot, step });
  }

  // tallar el terreno en las trincheras: la calzada y ~1/3 de celda a cada lado quedan por debajo de la solera;
  // más afuera la transición es suave. Así el terreno no tapa el camino y no quedan muros sueltos.
  const w = grid.width, h = grid.height;
  const hd = Float32Array.from(grid.data);
  const dx = (grid.xs[w - 1] - grid.xs[0]) / (w - 1), dz = (grid.zs[h - 1] - grid.zs[0]) / (h - 1);
  const cellM = Math.max(Math.abs(dx), Math.abs(dz));
  for (const pl of plans) {
    for (let i = 0; i < pl.P.length; i++) {
      if (!pl.open[i]) continue;
      const [x, z] = pl.P[i];
      const hard = pl.half + 0.35 * cellM, reach = pl.half + 0.9 * cellM;
      const ci = Math.round((x - grid.xs[0]) / dx), cj = Math.round((-z - grid.zs[0]) / dz);
      const ri = Math.ceil(reach / Math.abs(dx)) + 1, rj = Math.ceil(reach / Math.abs(dz)) + 1;
      for (let j = Math.max(0, cj - rj); j <= Math.min(h - 1, cj + rj); j++) {
        for (let k = Math.max(0, ci - ri); k <= Math.min(w - 1, ci + ri); k++) {
          const d = Math.hypot(grid.xs[k] - x, -grid.zs[j] - z);
          if (d > reach) continue;
          const wt = d <= hard ? 1 : 1 - (d - hard) / (reach - hard);
          const nh = hd[j * w + k] * (1 - wt) + (pl.f[i] - 0.5) * wt;
          if (nh < hd[j * w + k]) hd[j * w + k] = nh;
        }
      }
    }
  }
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < hd.length; i++) { if (hd[i] < minH) minH = hd[i]; if (hd[i] > maxH) maxH = hd[i]; }
  return { grid: { ...grid, data: hd, minH, maxH }, plans };
}

/** Tramos abiertos (trinchera) como vías, para que los árboles no crezcan dentro. */
export function openCutRoads(plans: TunnelPlan[]): RoadFeature[] {
  const out: RoadFeature[] = [];
  for (const pl of plans) {
    let run: Ring = [];
    const flush = () => { if (run.length >= 2) out.push({ cls: "service", width: pl.half * 2 + 4, bridge: false, tunnel: false, pts: run }); run = []; };
    pl.P.forEach((p, i) => { if (pl.open[i]) run.push(p); else flush(); });
    flush();
  }
  return out;
}

type V = [number, number, number];
type C = [number, number, number];

export function buildTunnels(plans: TunnelPlan[]): TunnelResult | null {
  if (!plans.length) return null;
  const lit = { pos: [] as number[], col: [] as number[] };
  const bak = { pos: [] as number[], col: [] as number[] };
  const tri = (b: typeof lit, a: V, c: V, d: V, ca: C, cc: C, cd: C) => { b.pos.push(...a, ...c, ...d); b.col.push(...ca, ...cc, ...cd); };
  const quad = (b: typeof lit, a: V, c: V, d: V, e: V, k: C, la = 1, lc = 1, ld = 1, le = 1) => {
    const m = (l: number): C => [k[0] * l, k[1] * l, k[2] * l];
    tri(b, a, c, d, m(la), m(lc), m(ld));
    tri(b, a, d, e, m(la), m(ld), m(le));
  };

  const ASPH: C = [0.19, 0.19, 0.2], BALLAST: C = [0.33, 0.31, 0.29], PATH: C = [0.5, 0.48, 0.45];
  const DADO: C = [0.33, 0.34, 0.36], TILE: C = [0.8, 0.79, 0.74], VAULT: C = [0.66, 0.66, 0.64];
  const CONC: C = [0.62, 0.6, 0.57], EARTH: C = [0.5, 0.45, 0.38];
  const LAMP: C = [1, 0.94, 0.76];

  const CELL = 24;
  type Seg = { ax: number; az: number; ay: number; bx: number; bz: number; by: number; half: number };
  const index = new Map<string, Seg[]>();
  const put = (sg: Seg) => {
    const pad = sg.half + 1;
    const i0 = Math.floor((Math.min(sg.ax, sg.bx) - pad) / CELL), i1 = Math.floor((Math.max(sg.ax, sg.bx) + pad) / CELL);
    const j0 = Math.floor((Math.min(sg.az, sg.bz) - pad) / CELL), j1 = Math.floor((Math.max(sg.az, sg.bz) + pad) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = `${i},${j}`;
      const a = index.get(k);
      if (a) a.push(sg); else index.set(k, [sg]);
    }
  };

  // índice de tramos cubiertos con su geometría de bóveda (para colisión y cámara)
  type CSeg = Seg & { tx: number; tz: number; H: number; wallH: number };
  const cidx = new Map<string, CSeg[]>();
  const cput = (sg: CSeg) => {
    const pad = sg.half + 2;
    const i0 = Math.floor((Math.min(sg.ax, sg.bx) - pad) / CELL), i1 = Math.floor((Math.max(sg.ax, sg.bx) + pad) / CELL);
    const j0 = Math.floor((Math.min(sg.az, sg.bz) - pad) / CELL), j1 = Math.floor((Math.max(sg.az, sg.bz) + pad) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = `${i},${j}`;
      const a = cidx.get(k);
      if (a) a.push(sg); else cidx.set(k, [sg]);
    }
  };
  let lamps = 0;
  for (const pl of plans) {
    const { P, f, g, open, s, tx, tz, half, H, kind, step } = pl;
    const n = P.length;
    const wallH = H * 0.5, ry = H - wallH, N = 8;
    // perfil (lateral, altura): pared izquierda → arco → pared derecha
    const prof: [number, number][] = [[-half, 0], [-half, Math.min(1.1, wallH)], [-half, wallH]];
    for (let j = 1; j < N; j++) { const th = Math.PI - (j * Math.PI) / N; prof.push([half * Math.cos(th), wallH + ry * Math.sin(th)]); }
    prof.push([half, wallH], [half, Math.min(1.1, wallH)], [half, 0]);
    const archY = (x: number) => wallH + ry * Math.sqrt(Math.max(0, 1 - (x / half) ** 2));
    const at = (i: number, lat: number, up: number): V => [P[i][0] - tz[i] * lat, f[i] + up, P[i][1] + tx[i] * lat];

    // luz horneada por anillo
    const sp = kind === "rail" ? 14 : kind === "ped" ? 7 : 10;
    const portalS: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!open[i] && (i === 0 || open[i - 1])) portalS.push(s[i]);
      if (!open[i] && (i === n - 1 || open[i + 1])) portalS.push(s[i]);
    }
    const light = s.map((si, i) => {
      if (open[i]) return 1;
      const m = si % sp, dl = Math.abs(m - sp / 2);
      const lp = Math.exp(-((dl / (sp * 0.3)) ** 2));
      let l = 0.26 + 0.78 * lp;
      let dp = Infinity;
      for (const ps of portalS) dp = Math.min(dp, Math.abs(si - ps));
      l = Math.max(l, 0.3 + 0.7 * Math.exp(-dp / 16));
      return Math.min(1.05, l);
    });

    const markings = (b: typeof lit, i: number, j: number, baked: boolean) => {
      const li = baked ? light[i] * 0.85 : 1, lj = baked ? light[j] * 0.85 : 1;
      const strip = (c0: number, wd: number, k: C) =>
        quad(b, at(i, c0 - wd, 0.03), at(i, c0 + wd, 0.03), at(j, c0 + wd, 0.03), at(j, c0 - wd, 0.03), k, li, li, lj, lj);
      if (kind === "road") {
        strip(-(half - 0.65), 0.08, [0.9, 0.9, 0.88]);
        strip(half - 0.65, 0.08, [0.9, 0.9, 0.88]);
        if (half * 2 >= 6.5 && ((s[i] + s[j]) / 2) % 9 < 3) strip(0, 0.08, [0.95, 0.85, 0.35]);
      } else if (kind === "rail") {
        strip(-0.72, 0.05, [0.6, 0.6, 0.62]);
        strip(0.72, 0.05, [0.6, 0.6, 0.62]);
      }
    };

    for (let i = 0; i < n - 1; i++) {
      const j = i + 1;
      const floorCol = kind === "rail" ? BALLAST : kind === "ped" ? PATH : ASPH;
      if (!open[i] && !open[j]) {
        // ---- tramo CUBIERTO: interior horneado ----
        quad(bak, at(i, -half, 0), at(i, half, 0), at(j, half, 0), at(j, -half, 0), floorCol, light[i] * 0.85, light[i] * 0.85, light[j] * 0.85, light[j] * 0.85);
        for (let k = 0; k < prof.length - 1; k++) {
          const [x0, y0] = prof[k], [x1, y1] = prof[k + 1];
          if (y0 === 0 && y1 === 0) continue;
          const ym = (y0 + y1) / 2;
          const base = ym < 1.1 ? DADO : ym < wallH ? TILE : VAULT;
          const mult = ym < wallH ? 0.95 : 1;
          quad(bak, at(i, x0, y0), at(i, x1, y1), at(j, x1, y1), at(j, x0, y0), base, light[i] * mult, light[i] * mult, light[j] * mult, light[j] * mult);
        }
        markings(bak, i, j, true);
        // cáscara exterior (hormigón iluminado) SOLO donde la bóveda asoma sobre el terreno
        if (g[i] - (f[i] + H + ROOF) < 1.0 || g[j] - (f[j] + H + ROOF) < 1.0) {
          const T = 0.6;
          const outerPt = (x: number, y: number): [number, number] => {
            if (y <= wallH + 1e-6) return [x + Math.sign(x) * T, y];
            return [x * (1 + T / half), wallH + (y - wallH) * (1 + T / ry)];
          };
          for (let k = 1; k < prof.length - 2; k++) {
            const [x0, y0] = prof[k], [x1, y1] = prof[k + 1];
            const [ox0, oy0] = outerPt(x0, y0), [ox1, oy1] = outerPt(x1, y1);
            quad(lit, at(i, ox0, oy0), at(j, ox0, oy0), at(j, ox1, oy1), at(i, ox1, oy1), CONC);
          }
        }
        put({ ax: P[i][0], az: P[i][1], ay: f[i], bx: P[j][0], bz: P[j][1], by: f[j], half });
        cput({ ax: P[i][0], az: P[i][1], ay: f[i], bx: P[j][0], bz: P[j][1], by: f[j], half, tx: tx[i], tz: tz[i], H, wallH });
      } else {
        // ---- tramo ABIERTO (trinchera): solera + taludes, con material iluminado por el sol ----
        const floorCol2 = floorCol;
        quad(lit, at(i, -half, 0), at(i, half, 0), at(j, half, 0), at(j, -half, 0), floorCol2);
        markings(lit, i, j, false);
        for (const sd of [-1, 1]) {
          // muro de contención vertical hasta el terreno natural (+ remate), cara interior y exterior
          const di = Math.max(0.2, g[i] + 0.2 - f[i]), dj = Math.max(0.2, g[j] + 0.2 - f[j]);
          quad(lit, at(i, sd * half, 0), at(j, sd * half, 0), at(j, sd * half, dj), at(i, sd * half, di), CONC);
          quad(lit, at(i, sd * (half + 0.45), 0), at(i, sd * (half + 0.45), di), at(j, sd * (half + 0.45), dj), at(j, sd * (half + 0.45), 0), CONC);
          quad(lit, at(i, sd * half, di), at(j, sd * half, dj), at(j, sd * (half + 0.45), dj), at(i, sd * (half + 0.45), di), CONC);
        }
        put({ ax: P[i][0], az: P[i][1], ay: f[i], bx: P[j][0], bz: P[j][1], by: f[j], half });
      }
    }

    // portales: marco de hormigón en arco en cada extremo del tramo cubierto (un solo anillo, sin losas sueltas)
    const headwall = (i: number) => {
      const FR = 1.1; // ancho del marco
      const outerPt = (x: number, y: number): [number, number] => {
        if (y <= wallH + 1e-6) return [x + Math.sign(x) * FR, y];
        return [x * (1 + FR / half), wallH + (y - wallH) * (1 + FR / ry)];
      };
      for (let k = 0; k < prof.length - 1; k++) {
        const [x0, y0] = prof[k], [x1, y1] = prof[k + 1];
        if (y0 === 0 && y1 === 0) continue;
        const [ox0, oy0] = outerPt(x0, y0), [ox1, oy1] = outerPt(x1, y1);
        quad(lit, at(i, x0, y0), at(i, x1, y1), at(i, ox1, oy1), at(i, ox0, oy0), CONC);
      }
    };
    for (let i = 0; i < n; i++) {
      if (!open[i] && (i === 0 || open[i - 1] || i === n - 1 || open[i + 1])) headwall(i);
    }

    // luminarias emisivas en la bóveda
    for (let m = 0; ; m++) {
      const sl = sp * (m + 0.5);
      if (sl > s[n - 1]) break;
      let i = Math.min(n - 2, Math.max(0, Math.floor(sl / step)));
      while (i < n - 2 && s[i + 1] < sl) i++;
      if (open[i] || open[i + 1]) continue;
      const t = (sl - s[i]) / ((s[i + 1] - s[i]) || 1);
      const cx = P[i][0] + (P[i + 1][0] - P[i][0]) * t, cz = P[i][1] + (P[i + 1][1] - P[i][1]) * t;
      const fy = f[i] + (f[i + 1] - f[i]) * t;
      const ux = tx[i], uz = tz[i];
      const lats = kind === "ped" ? [0] : [-half * 0.45, half * 0.45];
      for (const lat of lats) {
        const y = fy + archY(lat) - 0.06;
        const L = 0.8, W = 0.16;
        // (ux,uz) = tangente; (-uz,ux) = normal lateral
        const pp = (a: number, b: number): V => [cx + ux * a - uz * (lat + b), y, cz + uz * a + ux * (lat + b)];
        quad(bak, pp(-L, -W), pp(L, -W), pp(L, W), pp(-L, W), LAMP);
        lamps++;
      }
    }
  }

  const mk = (b: typeof lit, mat: THREE.Material, name: string) => {
    if (!b.pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(b.col, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    return m;
  };
  const litMesh = mk(lit, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02, flatShading: true, side: THREE.DoubleSide }), "tunnels_open");
  if (litMesh) { litMesh.castShadow = false; litMesh.receiveShadow = true; }
  // interior: SIN iluminación del sol (está bajo el cerro); la luz está horneada en los colores de vértice
  const bakMesh = mk(bak, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }), "tunnels_interior");
  const group = new THREE.Group();
  group.name = "tunnels";
  if (litMesh) group.add(litMesh);
  if (bakMesh) group.add(bakMesh);
  if (!group.children.length) return null;

  const floorAt = (x: number, z: number): number | null => {
    const list = index.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!list) return null;
    let best: number | null = null, bd = Infinity;
    for (const sg of list) {
      const dx = sg.bx - sg.ax, dz = sg.bz - sg.az, l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - sg.ax) * dx + (z - sg.az) * dz) / l2)) : 0;
      const d = Math.hypot(x - (sg.ax + dx * t), z - (sg.az + dz * t));
      if (d <= sg.half && d < bd) { bd = d; best = sg.ay + (sg.by - sg.ay) * t; }
    }
    return best;
  };
  const query = (x: number, z: number, y: number): TunnelHit | null => {
    const list = cidx.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!list) return null;
    let best: TunnelHit | null = null, bd = Infinity;
    for (const sg of list) {
      const dx = sg.bx - sg.ax, dz = sg.bz - sg.az, l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - sg.ax) * dx + (z - sg.az) * dz) / l2)) : 0;
      const px = sg.ax + dx * t, pz = sg.az + dz * t;
      const nx = -sg.tz, nz = sg.tx; // normal lateral
      const d = (x - px) * nx + (z - pz) * nz;
      const fl = sg.ay + (sg.by - sg.ay) * t;
      if (Math.abs(d) > sg.half + 0.6 || Math.abs(y - fl) > 3.2) continue;
      const ad = Math.abs(d);
      if (ad < bd) {
        bd = ad;
        const ry = sg.H - sg.wallH;
        const arch = sg.wallH + ry * Math.sqrt(Math.max(0, 1 - Math.min(1, ad / sg.half) ** 2));
        best = { floor: fl, ceil: fl + arch, half: sg.half, d, nx, nz, px, pz };
      }
    }
    return best;
  };
  return { group, count: plans.length, floorAt, lamps, query };
}
