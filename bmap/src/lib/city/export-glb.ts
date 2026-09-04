import type { Group } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

export function exportGroupToGlb(group: Group): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      group,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error("GLB export did not return binary data."));
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary: true, onlyVisible: false },
    );
  });
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
