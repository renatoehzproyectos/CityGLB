import * as THREE from "three";
import { ringArea } from "./geo";
import type { BuildingFeature } from "./types";

export type EllipseFit = { cx: number; cz: number; a: number; b: number; angle: number };

/** Ajusta una elipse (PCA + extensiones) a un anillo en coords locales (x este, z sur). */
export function fitEllipse(ring: [number, number][]): EllipseFit {
  const n = ring.length;
  let mx = 0,
    mz = 0;
  for (const [x, z] of ring) {
    mx += x;
    mz += z;
  }
  mx /= n;
  mz /= n;
  let sxx = 0,
    szz = 0,
    sxz = 0;
  for (const [x, z] of ring) {
    sxx += (x - mx) ** 2;
    szz += (z - mz) ** 2;
    sxz += (x - mx) * (z - mz);
  }
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ux = Math.cos(angle),
    uz = Math.sin(angle);
  let pMin = Infinity,
    pMax = -Infinity,
    qMin = Infinity,
    qMax = -Infinity;
  for (const [x, z] of ring) {
    const p = (x - mx) * ux + (z - mz) * uz;
    const q = -(x - mx) * uz + (z - mz) * ux;
    pMin = Math.min(pMin, p);
    pMax = Math.max(pMax, p);
    qMin = Math.min(qMin, q);
    qMax = Math.max(qMax, q);
  }
  const pc = (pMin + pMax) / 2,
    qc = (qMin + qMax) / 2;
  return {
    cx: mx + pc * ux - qc * uz,
    cz: mz + pc * uz + qc * ux,
    a: (pMax - pMin) / 2,
    b: (qMax - qMin) / 2,
    angle,
  };
}

/** Busca el edificio del Colosseo (anillo grande, casi elíptico, cerca del centro dado). */
export function findColosseumBuilding(
  buildings: BuildingFeature[],
  cx: number,
  cz: number,
): { index: number; fit: EllipseFit } | null {
  let bestIdx = -1;
  let bestFit: EllipseFit | null = null;
  let bestScore = Infinity;
  for (let index = 0; index < buildings.length; index++) {
    const b = buildings[index];
    const area = ringArea(b.ring);
    if (area < 12000 || area > 45000) continue;
    const fit = fitEllipse(b.ring);
    const d = Math.hypot(fit.cx - cx, fit.cz - cz);
    if (d > 160) continue;
    const ratio = area / (Math.PI * fit.a * fit.b);
    if (ratio < 0.75 || ratio > 1.15) continue;
    const score = d + Math.abs(1 - ratio) * 200;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = index;
      bestFit = fit;
    }
  }
  return bestFit ? { index: bestIdx, fit: bestFit } : null;
}

function archTexture(): THREE.CanvasTexture {
  const W = 256,
    H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#d9cfb6";
  g.fillRect(0, 0, W, H);
  // ruido de travertino
  for (let i = 0; i < 1400; i++) {
    const v = 190 + Math.random() * 50;
    g.fillStyle = `rgba(${v},${v - 8},${v - 30},0.12)`;
    g.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 6, 1 + Math.random() * 3);
  }
  const tiers = [
    { y: 0.5, h: 0.2 }, // base (abajo en textura = y mayor)
  ];
  void tiers;
  // v=0 arriba (ático) … v=1 abajo. Tres arcadas + ático.
  const atticH = H * 0.26;
  const tierH = (H - atticH) / 3;
  const cornice = (y: number) => {
    g.fillStyle = "rgba(120,105,80,0.55)";
    g.fillRect(0, y - 2, W, 4);
    g.fillStyle = "rgba(255,250,235,0.35)";
    g.fillRect(0, y - 4, W, 2);
  };
  for (let t = 0; t < 3; t++) {
    const top = atticH + t * tierH;
    const archW = W * 0.7;
    const x0 = (W - archW) / 2;
    const archTop = top + tierH * 0.12;
    const archBottom = top + tierH - 4;
    const r = archW / 2;
    g.beginPath();
    g.moveTo(x0, archBottom);
    g.lineTo(x0, archTop + r);
    g.arc(W / 2, archTop + r, r, Math.PI, 0);
    g.lineTo(x0 + archW, archBottom);
    g.closePath();
    const grd = g.createLinearGradient(0, archTop, 0, archBottom);
    grd.addColorStop(0, "#2a241c");
    grd.addColorStop(1, "#4a4031");
    g.fillStyle = grd;
    g.fill();
    // moldura del arco
    g.strokeStyle = "rgba(255,250,235,0.35)";
    g.lineWidth = 3;
    g.stroke();
    cornice(top);
  }
  cornice(atticH);
  // ático: ventanas rectangulares pequeñas cada bahía
  g.fillStyle = "#3a3226";
  g.fillRect(W / 2 - 14, atticH * 0.35, 28, atticH * 0.3);
  cornice(2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false; // v=0 arriba (ático), v=1 abajo
  tex.anisotropy = 8;
  return tex;
}

function stepsTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#cfc4aa";
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = "rgba(90,78,58,0.55)";
  g.fillRect(0, 0, 64, 5);
  g.fillStyle = "rgba(255,248,230,0.35)";
  g.fillRect(0, 5, 64, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function arenaTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#bfa275";
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1200; i++) {
    g.fillStyle = `rgba(${130 + Math.random() * 60},${105 + Math.random() * 50},70,0.18)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  // hipogeo: muros cruzados (sutil)
  g.strokeStyle = "rgba(70,55,40,0.45)";
  g.lineWidth = 3;
  for (let i = 1; i < 8; i++) {
    g.beginPath();
    g.moveTo(i * 32, 20);
    g.lineTo(i * 32, 236);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(20, 128);
  g.lineTo(236, 128);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

type Loft = { rings: { sa: number; sb: number; y: number }[]; segments: number };

function ellipsePoint(t: number, sa: number, sb: number) {
  return { x: sa * Math.cos(t), z: sb * Math.sin(t) };
}

/** Superficie loft entre anillos elípticos (normales hacia fuera/arriba según orden). */
function loftGeometry(loft: Loft, uRepeat: number, vRepeat: number, flip: boolean): THREE.BufferGeometry {
  const { rings, segments } = loft;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const ref = rings[0];
  const cum: number[] = [0];
  let prev = ellipsePoint(0, ref.sa, ref.sb);
  for (let s = 1; s <= segments; s++) {
    const p = ellipsePoint((s / segments) * Math.PI * 2, ref.sa, ref.sb);
    cum.push(cum[s - 1] + Math.hypot(p.x - prev.x, p.z - prev.z));
    prev = p;
  }
  const total = cum[segments];
  rings.forEach((r, ri) => {
    for (let s = 0; s <= segments; s++) {
      const p = ellipsePoint((s / segments) * Math.PI * 2, r.sa, r.sb);
      pos.push(p.x, r.y, p.z);
      uv.push((cum[s] / total) * uRepeat, (ri / (rings.length - 1)) * vRepeat);
    }
  });
  const row = segments + 1;
  for (let ri = 0; ri < rings.length - 1; ri++) {
    for (let s = 0; s < segments; s++) {
      const a = ri * row + s,
        b = a + 1,
        c = a + row,
        d = c + 1;
      if (flip) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export type ColosseumOptions = {
  fit: EllipseFit;
  /** Altura del suelo (m) en el pie del muro. */
  baseY: number;
};

/** Colosseo procedural: muro con 3 arcadas + ático, cavea escalonada, arena. */
export function buildColosseum({ fit, baseY }: ColosseumOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = "Colosseum";
  const { a, b } = fit;
  const H = 48.5;
  const wallT = Math.min(9, b * 0.12);
  const SEG = 160;
  const skirt = 4;

  // Muro exterior (80 bahías).
  const wallGeo = loftGeometry(
    {
      segments: SEG,
      rings: [
        { sa: a, sb: b, y: H },
        { sa: a, sb: b, y: 0 },
        { sa: a, sb: b, y: -skirt },
      ],
    },
    80,
    1,
    true,
  );
  // la franja de skirt reutiliza la parte baja de la textura
  const uvAttr = wallGeo.getAttribute("uv") as THREE.BufferAttribute;
  const row = SEG + 1;
  for (let i = 0; i < row; i++) {
    uvAttr.setY(i, 0);
    uvAttr.setY(row + i, 0.985);
    uvAttr.setY(2 * row + i, 1);
  }
  const wallMat = new THREE.MeshStandardMaterial({
    map: archTexture(),
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const wall = new THREE.Mesh(wallGeo, wallMat);
  wall.name = "colosseum-wall";
  wall.castShadow = wall.receiveShadow = true;
  group.add(wall);

  // Remate superior y muro interior del ático.
  const topGeo = loftGeometry(
    {
      segments: SEG,
      rings: [
        { sa: a, sb: b, y: H },
        { sa: a - wallT, sb: b - wallT, y: H },
      ],
    },
    1,
    1,
    false,
  );
  const stone = new THREE.MeshStandardMaterial({ color: 0xcdc2a6, roughness: 0.95, side: THREE.DoubleSide });
  const top = new THREE.Mesh(topGeo, stone);
  top.name = "colosseum-top";
  group.add(top);

  // Cavea escalonada: de la corona (y≈38) al podio (y≈5), perfil cóncavo.
  const arenaA = a * 0.44,
    arenaB = b * 0.31;
  const podA = arenaA + 4,
    podB = arenaB + 4;
  const caveaTopA = a - wallT,
    caveaTopB = b - wallT;
  const rings: { sa: number; sb: number; y: number }[] = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const k = Math.pow(t, 1.35);
    rings.push({
      sa: caveaTopA + (podA - caveaTopA) * t,
      sb: caveaTopB + (podB - caveaTopB) * t,
      y: 38 + (5.2 - 38) * k,
    });
  }
  // muro interior del ático (de H a 38)
  rings.unshift({ sa: caveaTopA, sb: caveaTopB, y: H });
  const caveaGeo = loftGeometry({ segments: SEG, rings }, 60, 1, false);
  const steps = stepsTexture();
  steps.repeat.set(1, 1);
  const caveaUV = caveaGeo.getAttribute("uv") as THREE.BufferAttribute;
  for (let r = 0; r < rings.length; r++) {
    for (let s = 0; s <= SEG; s++) caveaUV.setY(r * row + s, r <= 1 ? 0.2 : (r - 1) * 1.5);
  }
  const caveaMat = new THREE.MeshStandardMaterial({
    map: steps,
    roughness: 0.95,
    side: THREE.DoubleSide,
  });
  const cavea = new THREE.Mesh(caveaGeo, caveaMat);
  cavea.name = "colosseum-cavea";
  cavea.receiveShadow = true;
  group.add(cavea);

  // Podio vertical + arena.
  const podium = new THREE.Mesh(
    loftGeometry(
      {
        segments: SEG,
        rings: [
          { sa: podA, sb: podB, y: 5.2 },
          { sa: arenaA, sb: arenaB, y: 5.2 },
        ],
      },
      1,
      1,
      false,
    ),
    stone,
  );
  podium.name = "colosseum-podium";
  group.add(podium);

  const arenaGeo = new THREE.CircleGeometry(1, SEG);
  arenaGeo.rotateX(-Math.PI / 2);
  arenaGeo.scale(arenaA, 1, arenaB);
  const arenaUV = arenaGeo.getAttribute("uv") as THREE.BufferAttribute;
  void arenaUV;
  const arena = new THREE.Mesh(
    arenaGeo,
    new THREE.MeshStandardMaterial({ map: arenaTexture(), roughness: 1, side: THREE.DoubleSide }),
  );
  arena.position.y = 5.1;
  arena.name = "colosseum-arena";
  arena.receiveShadow = true;
  group.add(arena);

  // Orientación y posición. Local: x = eje mayor. Feature (x este, z sur).
  group.rotation.y = -fit.angle;
  group.position.set(fit.cx, baseY, fit.cz);
  return group;
}
