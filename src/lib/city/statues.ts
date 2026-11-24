import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { StatueSlot } from "./rome";

/**
 * Coloca estatuas (GLB decimados, p. ej. de Three D Scans) sobre pedestales.
 * Los archivos que no existan en /models/statues/ se omiten sin error.
 */
export async function buildStatues(
  slots: (StatueSlot & { x: number; z: number; groundY: number })[],
): Promise<{ group: THREE.Group; placed: number }> {
  const group = new THREE.Group();
  group.name = "statues";
  const loader = new GLTFLoader();
  const marble = new THREE.MeshStandardMaterial({ color: 0xe9e4d8, roughness: 0.55, metalness: 0 });
  const plinth = new THREE.MeshStandardMaterial({ color: 0xcfc4a8, roughness: 0.9 });
  let placed = 0;
  await Promise.all(
    slots.map(async (s) => {
      try {
        const gltf = await loader.loadAsync(`/models/statues/${s.file}`);
        const obj = gltf.scene;
        obj.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.material = marble;
            m.castShadow = true;
            m.receiveShadow = true;
          }
        });
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        if (!(size.y > 0)) return;
        const k = s.height / size.y;
        obj.scale.multiplyScalar(k);
        const b2 = new THREE.Box3().setFromObject(obj);
        const c = b2.getCenter(new THREE.Vector3());
        obj.position.set(-c.x, -b2.min.y, -c.z);

        const holder = new THREE.Group();
        const foot = Math.max(size.x, size.z) * k;
        const base = new THREE.Mesh(
          new THREE.BoxGeometry(foot * 0.9 + 1.2, s.pedestal, foot * 0.9 + 1.2),
          plinth,
        );
        base.position.y = s.pedestal / 2;
        base.castShadow = base.receiveShadow = true;
        obj.position.y += s.pedestal;
        holder.add(base, obj);
        holder.rotation.y = (s.rotationDeg * Math.PI) / 180;
        holder.position.set(s.x, s.groundY, s.z);
        group.add(holder);
        placed++;
      } catch {
        /* archivo ausente o inválido */
      }
    }),
  );
  return { group, placed };
}
