/**
 * Árboles y césped 3D con los modelos reales (public/models/tree.glb y grass.glb).
 *
 *  · Los dos .glb se prepararon aparte: sin Draco/WebP/spec-gloss, geometría simplificada
 *    (árbol ≈ 300–750 tris según variante, parche de césped ≈ 320 tris) y texturas en gris
 *    normalizado para teñirlas con el color REAL de la imagen satelital (color por instancia).
 *  · InstancedMesh: miles de árboles/parches con pocas llamadas de dibujo.
 *  · Viento: balanceo en el vertex shader (la animación "MorphBake" original no es viable a esta escala).
 *  · Si los modelos no cargan, se usa la malla simple anterior (buildTreesMesh).
 *  · Los árboles que exceden el cupo de la GPU (cupo menor en móvil) usan la malla simple.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { buildTreesMesh, type GrassPatch, type Tree } from "./vegetation";

const TREE_URL = "/models/tree.glb";
const GRASS_URL = "/models/grass.glb";

type Part = { kind: string; geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial };
type VegAssets = {
  treeVariants: { parts: Part[]; width: number }[]; // altura normalizada = 1
  grassParts: Part[]; // ancho normalizado = 1
};

let assetsPromise: Promise<VegAssets | null> | null = null;

function isMobile(): boolean {
  return typeof navigator !== "undefined" && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
}

function collect(root: THREE.Object3D): { mesh: THREE.Mesh; owner: THREE.Object3D }[] {
  root.updateMatrixWorld(true);
  const out: { mesh: THREE.Mesh; owner: THREE.Object3D }[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) out.push({ mesh: m, owner: m });
  });
  return out;
}

function loadAssets(): Promise<VegAssets | null> {
  if (assetsPromise) return assetsPromise;
  assetsPromise = (async () => {
    try {
      const loader = new GLTFLoader();
      const [tree, grass] = await Promise.all([loader.loadAsync(TREE_URL), loader.loadAsync(GRASS_URL)]);

      // ---- árboles: nodo tree_v0/1/2 → partes por material
      const variants: VegAssets["treeVariants"] = [];
      for (let k = 0; k < 6; k++) {
        const node = tree.scene.getObjectByName(`tree_v${k}`);
        if (!node) break;
        const parts: Part[] = [];
        const box = new THREE.Box3();
        for (const { mesh } of collect(node)) {
          const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
          const mat = mesh.material as THREE.MeshStandardMaterial;
          parts.push({ kind: mat.name || "Leaf", geometry: geo, material: mat });
          geo.computeBoundingBox();
          box.union(geo.boundingBox!);
        }
        if (parts.length) variants.push({ parts, width: Math.max(0.3, box.max.x - box.min.x) });
      }
      if (!variants.length) return null;

      // ---- césped: se fusionan las mallas que comparten material
      const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
      for (const { mesh } of collect(grass.scene)) {
        const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        const m = mesh.material as THREE.Material;
        if (!byMat.has(m)) byMat.set(m, []);
        byMat.get(m)!.push(geo);
      }
      const grassParts: Part[] = [];
      for (const [mat, geos] of byMat) {
        const merged = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
        if (merged) grassParts.push({ kind: "Grass", geometry: merged, material: mat as THREE.MeshStandardMaterial });
      }
      return { treeVariants: variants, grassParts };
    } catch (e) {
      console.warn("[vegetation] no se pudieron cargar tree.glb / grass.glb; se usa la malla simple", e);
      return null;
    }
  })();
  return assetsPromise;
}

const hash = (x: number, z: number) => Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;

/** Balanceo por viento (vertex shader). Compartido: un solo uniform para todo. */
function addWind(mat: THREE.MeshStandardMaterial, uniform: { value: number }, amp: number, key: string) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWind = uniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uWind;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  float ph = instanceMatrix[3].x * 0.11 + instanceMatrix[3].z * 0.17;
#else
  float ph = 0.0;
#endif
  float sway = (sin(uWind * 1.7 + ph) + 0.5 * sin(uWind * 3.1 + ph * 1.7)) * ${amp.toFixed(4)} * max(position.y - 0.2, 0.0);
  transformed.x += sway;
  transformed.z += sway * 0.6;`,
      );
  };
  mat.customProgramCacheKey = () => `wind-${key}`;
}

function cloneMat(m: THREE.MeshStandardMaterial, o: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  const c = m.clone();
  c.side = THREE.DoubleSide;
  c.roughness = 0.92;
  c.metalness = 0;
  c.transparent = false; // recorte por alphaTest: sin problemas de orden de transparencias
  if (m.alphaTest > 0) c.alphaTest = m.alphaTest;
  Object.assign(c, o);
  return c;
}

export type VegetationResult = {
  trees?: THREE.Group;
  grass?: THREE.Group;
  treeCount: number;
  grassCount: number;
  /** vértices de las mallas base (estadística) */
  vertices: number;
  tick: (timeSec: number) => void;
};

type Ground = ((x: number, z: number) => number) | null;

const sm = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export async function buildVegetation(trees: Tree[], grass: GrassPatch[], groundAt: Ground): Promise<VegetationResult> {
  const wind = { value: 0 };
  const res: VegetationResult = { treeCount: trees.length, grassCount: 0, vertices: 0, tick: (t) => { wind.value = t; } };
  if (!trees.length && !grass.length) return res;

  const assets = await loadAssets();
  const mobile = isMobile();

  // ---------------- ÁRBOLES ----------------
  if (trees.length) {
    const group = new THREE.Group();
    group.name = "trees";
    const cap = assets ? (mobile ? 1000 : 4000) : 0;
    // los de copa más grande (más visibles) usan el modelo 3D; el resto, la malla simple
    const sorted = trees.slice().sort((a, b) => b.r - a.r || a.x - b.x);
    const detailed = sorted.slice(0, cap);
    const simple = sorted.slice(cap);

    if (assets && detailed.length) {
      const V = assets.treeVariants;
      const per: { m: THREE.Matrix4; c: THREE.Color }[][] = V.map(() => []);
      const dummy = new THREE.Object3D();
      for (const t of detailed) {
        const h = hash(t.x, t.z);
        const hgt = Math.min(18, Math.max(3.5, 3.2 + 1.9 * t.r));
        const vi = Math.min(V.length - 1, Math.floor(h * V.length * 0.999));
        const g = groundAt ? groundAt(t.x, t.z) : 0;
        // el DSM ya incluye el dosel: en zonas densas la base se hunde para no flotar
        const base = g - (groundAt ? hgt * 0.55 * sm(0.35, 0.85, t.dens) : 0);
        const sxz = Math.min(hgt * 1.5, (2 * t.r * 1.15) / V[vi].width);
        const jitter = 0.9 + hash(t.z, t.x) * 0.25;
        dummy.position.set(t.x, base, t.z);
        dummy.rotation.set(0, h * Math.PI * 2, 0);
        dummy.scale.set(sxz * jitter, hgt, sxz * jitter);
        dummy.updateMatrix();
        const v = 0.9 + hash(t.x * 1.3, t.z * 0.7) * 0.25;
        per[vi].push({
          m: dummy.matrix.clone(),
          c: new THREE.Color(Math.min(1, t.color[0] * 1.4 * v), Math.min(1, t.color[1] * 1.55 * v), Math.min(1, t.color[2] * 1.35 * v)),
        });
      }
      V.forEach((variant, vi) => {
        const inst = per[vi];
        if (!inst.length) return;
        for (const part of variant.parts) {
          const foliage = part.kind === "Leaf";
          const mat = cloneMat(
            part.material,
            part.kind === "Branch" ? { color: new THREE.Color(0.55, 0.4, 0.28) } : part.kind === "Bark" ? {} : {},
          );
          if (part.kind !== "Bark") addWind(mat, wind, part.kind === "Leaf" ? 0.035 : 0.02, `tree-${part.kind}`);
          const mesh = new THREE.InstancedMesh(part.geometry.clone(), mat, inst.length);
          mesh.name = `tree_v${vi}_${part.kind}`;
          let ar = 0, ag = 0, ab = 0;
          inst.forEach((it, i) => {
            mesh.setMatrixAt(i, it.m);
            if (foliage) { mesh.setColorAt(i, it.c); ar += it.c.r; ag += it.c.g; ab += it.c.b; }
          });
          if (foliage) mesh.userData.avgTint = [ar / inst.length, ag / inst.length, ab / inst.length];
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          mesh.computeBoundingSphere();
          mesh.castShadow = true;
          mesh.receiveShadow = false;
          group.add(mesh);
          res.vertices += part.geometry.getAttribute("position").count;
        }
      });
    }

    const rest = assets ? simple : sorted;
    const legacy = buildTreesMesh(rest, groundAt);
    if (legacy) {
      group.add(legacy);
      res.vertices += legacy.geometry.getAttribute("position").count;
    }
    if (group.children.length) res.trees = group;
  }

  // ---------------- CÉSPED ----------------
  if (assets && grass.length) {
    const cap = mobile ? 2500 : 9000;
    const use = grass.length > cap ? grass.filter((_, i) => i % Math.ceil(grass.length / cap) === 0) : grass;
    const group = new THREE.Group();
    group.name = "grass";
    const dummy = new THREE.Object3D();
    const mats: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    for (const g of use) {
      const h = hash(g.x * 0.37, g.z * 0.91);
      const y = groundAt ? groundAt(g.x, g.z) : 0;
      dummy.position.set(g.x, y - 0.02, g.z);
      dummy.rotation.set(0, h * Math.PI * 2, 0);
      const s = g.size * (0.9 + h * 0.3);
      dummy.scale.set(s, s * (0.9 + hash(g.z, g.x) * 0.5), s);
      dummy.updateMatrix();
      const v = 0.92 + hash(g.x, g.z) * 0.2;
      mats.push({
        m: dummy.matrix.clone(),
        c: new THREE.Color(Math.min(1, g.color[0] * 1.45 * v), Math.min(1, g.color[1] * 1.6 * v), Math.min(1, g.color[2] * 1.35 * v)),
      });
    }
    for (const part of assets.grassParts) {
      const mat = cloneMat(part.material);
      addWind(mat, wind, 0.16, "grass");
      const mesh = new THREE.InstancedMesh(part.geometry.clone(), mat, mats.length);
      mesh.name = "grass_patch";
      let ar = 0, ag = 0, ab = 0;
      mats.forEach((it, i) => {
        mesh.setMatrixAt(i, it.m);
        mesh.setColorAt(i, it.c);
        ar += it.c.r; ag += it.c.g; ab += it.c.b;
      });
      mesh.userData.avgTint = [ar / mats.length, ag / mats.length, ab / mats.length];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      group.add(mesh);
      res.vertices += part.geometry.getAttribute("position").count;
    }
    res.grassCount = mats.length;
    res.grass = group;
  }

  return res;
}
