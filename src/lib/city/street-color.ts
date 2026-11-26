/** Color real de una fachada a partir de los píxeles de una foto de calle. */
export type FacadeColor = { color: [number, number, number]; frac: number };

/**
 * Mediana de color en `rect` (píxeles) descartando cielo, vegetación, sombras profundas y
 * brillos. Devuelve null si queda muy poco (coches, árboles o cielo tapan la fachada).
 */
export function colorFromCrop(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
): FacadeColor | null {
  const R: number[] = [], G: number[] = [], B: number[] = [];
  let total = 0;
  const x0 = Math.max(0, Math.floor(rect.x0)), x1 = Math.min(w, Math.ceil(rect.x1));
  const y0 = Math.max(0, Math.floor(rect.y0)), y1 = Math.min(h, Math.ceil(rect.y1));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total++;
      const i = (y * w + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const s = r + g + b;
      const lum = s / 765;
      if (lum < 0.1 || lum > 0.93) continue; // sombra profunda / brillo quemado
      if (b > r + 14 && b > g && lum > 0.55) continue; // cielo
      if ((2 * g - r - b) / s > 0.07) continue; // vegetación
      R.push(r); G.push(g); B.push(b);
    }
  }
  if (!total || R.length / total < 0.3 || R.length < 12) return null;
  const med = (a: number[]) => {
    a.sort((p, q) => p - q);
    return a[a.length >> 1];
  };
  return { color: [med(R) / 255, med(G) / 255, med(B) / 255], frac: R.length / total };
}
