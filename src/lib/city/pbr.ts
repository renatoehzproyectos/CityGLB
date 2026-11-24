import * as THREE from "three";

/** Texturas PBR CC0 de Poly Haven (CDN con CORS). Slugs verificados en polyhaven.com. */
const BASE = "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k";

export type PbrSet = {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
};

const cache = new Map<string, Promise<PbrSet | null>>();

export function loadPolyHavenPbr(slug: string, tilesPerMeter: number): Promise<PbrSet | null> {
  const key = `${slug}@${tilesPerMeter}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin("anonymous");
      const get = (suffix: string, srgb: boolean) =>
        loader.loadAsync(`${BASE}/${slug}/${slug}_${suffix}_1k.jpg`).then((t) => {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = 8;
          if (srgb) t.colorSpace = THREE.SRGBColorSpace;
          return t;
        });
      try {
        const [map, normalMap, roughnessMap] = await Promise.all([
          get("diff", true),
          get("nor_gl", false),
          get("rough", false),
        ]);
        return { map, normalMap, roughnessMap };
      } catch (e) {
        console.warn(`[pbr] Poly Haven ${slug} no disponible; se usa el color base.`, e);
        return null;
      }
    })();
    cache.set(key, p);
  }
  return p;
}

/** UV planares en mundo (x,z): una repetición cada `meters` metros. */
export function applyPlanarUV(geo: THREE.BufferGeometry, meters: number): void {
  const pos = geo.getAttribute("position");
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / meters;
    uv[i * 2 + 1] = pos.getZ(i) / meters;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/** Aclara los colores de vértice para que el albedo de la textura no quede oscuro. */
export function liftVertexColors(geo: THREE.BufferGeometry, gain: number): void {
  const c = geo.getAttribute("color") as THREE.BufferAttribute | undefined;
  if (!c) return;
  for (let i = 0; i < c.count; i++) {
    c.setXYZ(i, Math.min(1, c.getX(i) * gain), Math.min(1, c.getY(i) * gain), Math.min(1, c.getZ(i) * gain));
  }
  c.needsUpdate = true;
}
