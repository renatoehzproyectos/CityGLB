import * as THREE from "three";

/** Rótulos flotantes en Cinzel (sprites de tamaño constante en pantalla) + línea guía. */
export async function buildLabels(
  items: { text: string; x: number; z: number; groundY: number; height: number }[],
): Promise<THREE.Group> {
  const group = new THREE.Group();
  group.name = "labels";
  try {
    await document.fonts.load('600 64px "Cinzel"');
  } catch {
    /* usa fallback serif */
  }
  const linePts: number[] = [];
  for (const it of items) {
    const c = document.createElement("canvas");
    const g = c.getContext("2d")!;
    const font = '600 64px "Cinzel", "Trajan Pro", Georgia, serif';
    g.font = font;
    const w = Math.ceil(g.measureText(it.text).width) + 60;
    c.width = w;
    c.height = 120;
    g.font = font;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineJoin = "round";
    g.lineWidth = 10;
    g.strokeStyle = "rgba(20,14,8,0.85)";
    g.strokeText(it.text, w / 2, 60);
    g.fillStyle = "#f4ead2";
    g.fillText(it.text, w / 2, 60);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      sizeAttenuation: false,
      fog: false,
    });
    const sp = new THREE.Sprite(mat);
    const hScreen = 0.035;
    sp.scale.set(hScreen * (w / 120), hScreen, 1);
    sp.position.set(it.x, it.groundY + it.height, it.z);
    sp.renderOrder = 50;
    sp.name = `label-${it.text}`;
    group.add(sp);
    linePts.push(it.x, it.groundY, it.z, it.x, it.groundY + it.height - 2, it.z);
  }
  if (linePts.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(linePts, 3));
    const lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0xf4ead2, transparent: true, opacity: 0.55 }),
    );
    lines.name = "label-leaders";
    group.add(lines);
  }
  return group;
}
