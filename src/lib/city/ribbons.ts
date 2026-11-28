/**
 * Calzadas niveladas ("cintas").
 * La malla del terreno es gruesa (≈3–12 m por celda) y no puede representar una calle de 6 m sin que quede
 * inclinada de costado (roll). Cada calle se dibuja entonces como una cinta de geometría propia: sección
 * transversal PLANA, perfil longitudinal = perfil suavizado del terreno. Usa el mismo material y las mismas
 * UV que el terreno, así que muestra exactamente la misma foto satelital, pero plana. Bajo los bordes lleva
 * faldones de tierra para que no se vea el aire en rellenos.
 */
import * as THREE from "three";
import type { RoadProfile } from "./flatten";

export type RibbonResult = {
  group: THREE.Group;
  count: number;
  /** altura de la calzada en (x,z) o null */
  ribbonAt: (x: number, z: number) => number | null;
};

type Extent = { minX: number; maxX: number; minZ: number; maxZ: number };
const CELL = 24;

export function buildRibbons(
  profiles: RoadProfile[],
  extent: Extent,
  terrainMat: THREE.Material,
  groundAt?: ((x: number, z: number) => number) | null,
): RibbonResult | null {
  if (!profiles.length) return null;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const spanX = extent.maxX - extent.minX || 1, spanZ = extent.maxZ - extent.minZ || 1;
  const U = (x: number) => (x - extent.minX) / spanX;
  const Vv = (z: number) => 1 - (z - extent.minZ) / spanZ;

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

  let count = 0;
  for (const pr of profiles) {
    const n = pr.pts.length;
    const half = pr.width / 2 + 0.3; // un poco más ancha que la vía (desfase foto/mapa)
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const a = pr.pts[Math.max(0, i - 1)], b = pr.pts[Math.min(n - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      const [x, z] = pr.pts[i], y = pr.y[i];
      for (const sd of [-1, 1]) {
        const ex = x + nx * half * sd, ez = z + nz * half * sd;
        pos.push(ex, y, ez);
        uv.push(U(ex), Vv(ez));
      }
    }
    // Talud (relleno): desde el borde de la cinta baja en pendiente 1:1.5 hasta tocar el terreno. Lleva la MISMA foto
    // del terreno (mismas UV), así que se ve como ladera y no como un muro. Cada fila: [borde, pie] × [izq, der].
    const eb = pos.length / 3;
    const ebN = groundAt ? n : 0;
    for (let i = 0; i < ebN; i++) {
      const a = pr.pts[Math.max(0, i - 1)], b = pr.pts[Math.min(n - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      const [x, z] = pr.pts[i], y = pr.y[i];
      for (const sd of [-1, 1]) {
        const ex = x + nx * half * sd, ez = z + nz * half * sd;
        let tEnd = 0;
        for (let t = 0.6; t <= 24; t += 0.6) {
          tEnd = t;
          if (groundAt!(ex + nx * sd * t, ez + nz * sd * t) >= y - t * 0.67) break;
        }
        const fx = ex + nx * sd * tEnd, fz = ez + nz * sd * tEnd;
        const fy = Math.min(y - tEnd * 0.67, groundAt!(fx, fz)) ;
        pos.push(ex, y - 0.02, ez, fx, Math.max(fy, y - tEnd * 0.67 - 0.5), fz);
        uv.push(U(ex), Vv(ez), U(fx), Vv(fz));
      }
    }
    for (let i = 0; i < ebN - 1; i++) {
      const a = eb + i * 4, c = a + 4; // [L borde, L pie, R borde, R pie]
      idx.push(a, a + 1, c, c, a + 1, c + 1);
      idx.push(a + 2, c + 2, a + 3, c + 2, c + 3, a + 3);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
      put({ ax: pr.pts[i][0], az: pr.pts[i][1], ay: pr.y[i], bx: pr.pts[i + 1][0], bz: pr.pts[i + 1][1], by: pr.y[i + 1], half: pr.width / 2 + 0.3 });
    }
    count++;
  }
  if (!count) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // el sentido de giro de los triángulos también varía: material de doble cara
  const mat = (terrainMat as THREE.MeshStandardMaterial).clone();
  mat.side = THREE.DoubleSide;
  // la textura se asigna al material del terreno de forma asíncrona: se sincroniza en cada render
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "roads";
  mesh.receiveShadow = true;
  mesh.onBeforeRender = () => {
    const t = terrainMat as THREE.MeshStandardMaterial;
    if (mat.map !== t.map) {
      mat.map = t.map; mat.emissiveMap = t.emissiveMap; mat.color.copy(t.color);
      mat.emissive.copy(t.emissive); mat.emissiveIntensity = t.emissiveIntensity;
      mat.roughness = t.roughness; mat.metalness = t.metalness; mat.needsUpdate = true;
    }
  };

  const group = new THREE.Group();
  group.name = "road_ribbons";
  group.add(mesh);

  const ribbonAt = (x: number, z: number): number | null => {
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
  return { group, count, ribbonAt };
}
