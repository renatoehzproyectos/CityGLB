import type { BBox } from "./types";

export type CityPreset = {
  id: string;
  name: string;
  city: string;
  bbox: BBox;
};

/** Zona inicial del mapa (solo punto de partida, no una opción de la UI). */
export const DEFAULT_PRESET: CityPreset = {
  id: "default",
  name: "Champ de Mars",
  city: "Paris",
  bbox: { minLon: 2.2945, minLat: 48.8584, maxLon: 2.31, maxLat: 48.865 },
};
