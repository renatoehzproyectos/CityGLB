import * as THREE from "three";

/**
 * Cielo procedural tipo "mediterráneo": degradado azul → horizonte cálido y
 * cúmulos con base plana y cima iluminada. Textura equirectangular 2048×1024
 * (arriba = cenit, mitad = horizonte). Determinista (semilla fija).
 */
export function createSkyTexture(): THREE.CanvasTexture {
  const W = 2048;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;

  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#2f5f9e");
  grad.addColorStop(0.22, "#5b8cc4");
  grad.addColorStop(0.38, "#7fa6cf");
  grad.addColorStop(0.46, "#a9c4dd");
  grad.addColorStop(0.5, "#e3d6c0"); // horizonte: neblina cálida
  grad.addColorStop(0.56, "#d8cdb9");
  grad.addColorStop(1, "#cbbfa9");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  let seed = 1337;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  const puff = (x: number, y: number, r: number, light: number) => {
    const rg = g.createRadialGradient(x, y - r * 0.25, r * 0.1, x, y, r);
    const top = Math.round(255 * light);
    rg.addColorStop(0, `rgba(${top},${top - 2},${top - 8},0.95)`);
    rg.addColorStop(0.55, `rgba(${top - 45},${top - 42},${top - 38},0.6)`);
    rg.addColorStop(1, "rgba(235,235,240,0)");
    g.fillStyle = rg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };

  // Más cerca del horizonte (y≈512) las nubes se ven más pequeñas y aplastadas.
  const clouds = 46;
  for (let i = 0; i < clouds; i++) {
    const cx = rnd() * W;
    const cy = 150 + Math.pow(rnd(), 0.8) * 320; // entre cenit medio y horizonte
    const persp = 0.45 + ((512 - cy) / 360) * 0.9; // 0.45 (cerca horizonte) … 1.35
    const scale = 38 * persp;
    const puffs = 7 + Math.floor(rnd() * 7);
    for (const dx of [-W, 0, W]) {
      // base gris azulada
      g.save();
      g.globalAlpha = 0.4;
      g.fillStyle = "#6f819b";
      g.beginPath();
      g.ellipse(cx + dx, cy + scale * 0.55, scale * puffs * 0.42, scale * 0.35, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    for (let k = 0; k < puffs; k++) {
      const px = cx + (k - puffs / 2) * scale * 0.7 + (rnd() - 0.5) * scale;
      const py = cy - Math.sin((k / puffs) * Math.PI) * scale * 0.9 + (rnd() - 0.5) * scale * 0.3;
      const r = scale * (0.7 + rnd() * 0.8);
      const light = 0.93 + rnd() * 0.07;
      for (const dx of [-W, 0, W]) puff(px + dx, py, r, light);
    }
  }

  // Velo de neblina sobre el horizonte.
  const haze = g.createLinearGradient(0, 468, 0, 540);
  haze.addColorStop(0, "rgba(227,214,192,0)");
  haze.addColorStop(0.6, "rgba(227,214,192,0.8)");
  haze.addColorStop(1, "rgba(214,202,184,0.9)");
  g.fillStyle = haze;
  g.fillRect(0, 468, W, 72);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
