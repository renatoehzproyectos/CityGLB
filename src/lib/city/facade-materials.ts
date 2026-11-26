/**
 * Texturas procedurales por material de fachada (ladrillo, hormigón, vidrio, estuco,
 * piedra, metal, madera). Son claras/neutras: el color por vértice de cada edificio las
 * tiñe, así un mismo material sirve para muchos colores.
 */
import * as THREE from "three";
import type { FacadeMaterial } from "./ai-schema";
import type { RGB } from "./roof-data";

/** Color base cuando la IA da material pero no color de fachada. */
export const MATERIAL_TINT: Record<FacadeMaterial, RGB> = {
  brick: [0.62, 0.38, 0.3],
  concrete: [0.7, 0.69, 0.67],
  glass: [0.55, 0.68, 0.76],
  stucco: [0.88, 0.82, 0.7],
  stone: [0.78, 0.72, 0.62],
  metal: [0.7, 0.72, 0.74],
  wood: [0.6, 0.45, 0.3],
};

type Spec = {
  metersPerTile: number;
  roughness: number;
  metalness: number;
  bump: number;
  draw: (ctx: CanvasRenderingContext2D, s: number) => void;
};

function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const gray = (v: number) => `rgb(${v | 0},${v | 0},${v | 0})`;

function windows(
  ctx: CanvasRenderingContext2D,
  s: number,
  cols: number,
  rows: number,
  wr: number,
  hr: number,
  glass: (c: number, r: number) => string,
  frame = "rgba(255,255,255,0.3)",
) {
  const pw = s / cols;
  const ph = s / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const w = pw * wr;
      const h = ph * hr;
      const x = c * pw + (pw - w) / 2;
      const y = r * ph + (ph - h) / 2;
      ctx.fillStyle = glass(c, r);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = frame;
      ctx.lineWidth = Math.max(1, s * 0.006);
      ctx.strokeRect(x, y, w, h);
    }
  }
}

const darkGlass = (c: number, r: number) => {
  const shade = 92 + ((c * 7 + r * 13) % 5) * 8;
  return `rgb(${shade + 8},${shade + 18},${shade + 32})`;
};

const SPECS: Record<FacadeMaterial, Spec> = {
  brick: {
    metersPerTile: 6, roughness: 0.92, metalness: 0, bump: 0.8,
    draw: (ctx, s) => {
      const rand = rng(11);
      ctx.fillStyle = gray(244);
      ctx.fillRect(0, 0, s, s);
      const rows = 16, bw = s / 8, bh = s / rows;
      for (let r = 0; r < rows; r++) {
        const off = r % 2 ? bw / 2 : 0;
        for (let c = -1; c < 9; c++) {
          ctx.fillStyle = gray(200 + rand() * 40);
          ctx.fillRect(c * bw + off + 1, r * bh + 1, bw - 2, bh - 2);
        }
      }
      windows(ctx, s, 2, 2, 0.46, 0.5, darkGlass);
    },
  },
  concrete: {
    metersPerTile: 9, roughness: 0.95, metalness: 0, bump: 0.5,
    draw: (ctx, s) => {
      const rand = rng(23);
      ctx.fillStyle = gray(226);
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 2400; i++) {
        ctx.fillStyle = `rgba(${rand() > 0.5 ? "255,255,255" : "90,90,90"},${0.04 + rand() * 0.07})`;
        ctx.fillRect(rand() * s, rand() * s, 1 + rand() * 2, 1 + rand() * 2);
      }
      ctx.strokeStyle = "rgba(60,60,60,0.35)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(0, (i * s) / 5);
        ctx.lineTo(s, (i * s) / 5);
        ctx.stroke();
      }
      windows(ctx, s, 4, 5, 0.62, 0.55, darkGlass);
    },
  },
  glass: {
    metersPerTile: 12, roughness: 0.18, metalness: 0.15, bump: 0,
    draw: (ctx, s) => {
      ctx.fillStyle = gray(190);
      ctx.fillRect(0, 0, s, s);
      const cols = 4, rows = 6;
      windows(
        ctx, s, cols, rows, 0.94, 0.94,
        (c, r) => {
          const t = ((c + r) % 3) / 3;
          return `rgb(${150 + t * 30},${185 + t * 25},${210 + t * 20})`;
        },
        "rgba(40,50,60,0.55)",
      );
    },
  },
  stucco: {
    metersPerTile: 9, roughness: 0.95, metalness: 0, bump: 0.25,
    draw: (ctx, s) => {
      const rand = rng(37);
      ctx.fillStyle = gray(246);
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 1800; i++) {
        ctx.fillStyle = `rgba(0,0,0,${0.02 + rand() * 0.035})`;
        ctx.fillRect(rand() * s, rand() * s, 1 + rand() * 2, 1 + rand() * 2);
      }
      windows(ctx, s, 3, 3, 0.4, 0.58, (c, r) => `rgb(${150 + ((c + r) % 3) * 8},${130 + ((c + r) % 3) * 6},${108})`, "rgba(255,255,255,0.12)");
    },
  },
  stone: {
    metersPerTile: 8, roughness: 0.9, metalness: 0, bump: 0.9,
    draw: (ctx, s) => {
      const rand = rng(51);
      ctx.fillStyle = gray(232);
      ctx.fillRect(0, 0, s, s);
      let y = 0;
      while (y < s) {
        const h = 22 + rand() * 18;
        let x = -rand() * 40;
        while (x < s) {
          const w = 38 + rand() * 50;
          ctx.fillStyle = gray(196 + rand() * 40);
          ctx.fillRect(x + 1.5, y + 1.5, w - 3, h - 3);
          x += w;
        }
        y += h;
      }
      windows(ctx, s, 3, 3, 0.36, 0.52, darkGlass);
    },
  },
  metal: {
    metersPerTile: 10, roughness: 0.4, metalness: 0.25, bump: 0.2,
    draw: (ctx, s) => {
      ctx.fillStyle = gray(228);
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = "rgba(0,0,0,0.18)";
      ctx.lineWidth = 1;
      for (let x = 0; x <= s; x += s / 16) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, s);
        ctx.stroke();
      }
      // ventanas en banda (ribbon)
      windows(ctx, s, 1, 3, 0.94, 0.3, darkGlass);
    },
  },
  wood: {
    metersPerTile: 6, roughness: 0.85, metalness: 0, bump: 0.5,
    draw: (ctx, s) => {
      const rand = rng(73);
      ctx.fillStyle = gray(236);
      ctx.fillRect(0, 0, s, s);
      const rows = 18, ph = s / rows;
      for (let r = 0; r < rows; r++) {
        ctx.fillStyle = gray(205 + rand() * 40);
        ctx.fillRect(0, r * ph + 1, s, ph - 2);
        ctx.strokeStyle = "rgba(0,0,0,0.07)";
        ctx.beginPath();
        ctx.moveTo(0, r * ph + ph / 2);
        ctx.lineTo(s, r * ph + ph / 2 + (rand() - 0.5) * 2);
        ctx.stroke();
      }
      windows(ctx, s, 2, 2, 0.4, 0.46, darkGlass);
    },
  },
};

const texCache = new Map<FacadeMaterial, { map: THREE.Texture; bump: THREE.Texture | null }>();

function textures(kind: FacadeMaterial) {
  const hit = texCache.get(kind);
  if (hit) return hit;
  const spec = SPECS[kind];
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  spec.draw(canvas.getContext("2d")!, size);
  const make = () => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / spec.metersPerTile, 1 / spec.metersPerTile);
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  const map = make();
  map.colorSpace = THREE.SRGBColorSpace;
  const entry = { map, bump: spec.bump > 0 ? make() : null };
  texCache.set(kind, entry);
  return entry;
}

/** Material de muros para un tipo de fachada (la textura se comparte; el material es nuevo). */
export function createFacadeMaterial(kind: FacadeMaterial): THREE.MeshStandardMaterial {
  const spec = SPECS[kind];
  const t = textures(kind);
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: 0xffffff,
    map: t.map,
    bumpMap: t.bump ?? undefined,
    bumpScale: spec.bump,
    roughness: spec.roughness,
    metalness: spec.metalness,
    flatShading: true,
  });
}
