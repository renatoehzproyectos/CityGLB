import type { Group, Material, Mesh, MeshStandardMaterial } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

/**
 * Sustituye temporalmente lo que un .glb no puede llevar (shader de agua, tinte por instancia)
 * por su equivalente PBR estándar, exporta y lo restaura.
 */
function swapForExport(group: Group): () => void {
  const undo: (() => void)[] = [];
  group.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    const exp = mesh.userData?.exportMaterial as Material | undefined;
    if (exp) {
      const prev = mesh.material;
      mesh.material = exp;
      undo.push(() => { mesh.material = prev; });
    }
    // Foliage instanciado: el color por instancia no viaja en glTF → color medio de todas las instancias
    const tint = mesh.userData?.avgTint as [number, number, number] | undefined;
    const m = mesh.material as MeshStandardMaterial;
    if (tint && m && !Array.isArray(m)) {
      const prev = m.color.clone();
      m.color.setRGB(tint[0], tint[1], tint[2]);
      undo.push(() => { m.color.copy(prev); });
    }
  });
  return () => undo.forEach((f) => f());
}

export function exportGroupToGlb(group: Group): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  const restore = swapForExport(group);
  return new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      group,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error("GLB export did not return binary data."));
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary: true, onlyVisible: false },
    );
  }).finally(restore);
}

export function downloadBuffer(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], { type: "model/gltf-binary" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
