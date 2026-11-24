import type { CityPreset } from "./presets";

/** Roma: presets de zona (bbox aprox., editables). */
export const ROME_PRESETS: CityPreset[] = [
  {
    id: "roma-colosseo",
    name: "Colosseo y Foro",
    city: "Roma",
    bbox: { minLon: 12.479, minLat: 41.884, maxLon: 12.5, maxLat: 41.896 },
  },
  {
    id: "roma-pantheon",
    name: "Pantheon y Navona",
    city: "Roma",
    bbox: { minLon: 12.466, minLat: 41.894, maxLon: 12.488, maxLat: 41.906 },
  },
  {
    id: "roma-vaticano",
    name: "San Pietro",
    city: "Roma",
    bbox: { minLon: 12.448, minLat: 41.899, maxLon: 12.47, maxLat: 41.91 },
  },
  {
    id: "roma-centro",
    name: "Centro (pesado)",
    city: "Roma",
    bbox: { minLon: 12.465, minLat: 41.883, maxLon: 12.503, maxLat: 41.908 },
  },
];

export type Landmark = {
  id: string;
  /** Rótulo en latín (Cinzel solo tiene capitales; U se escribe V). */
  label: string;
  lon: number;
  lat: number;
  /** Altura sobre el suelo a la que flota el rótulo (m). */
  labelHeight: number;
};

/** Coordenadas aproximadas (±50 m). Edita aquí para afinar. */
export const ROME_LANDMARKS: Landmark[] = [
  { id: "colosseo", label: "COLOSSEVM", lon: 12.49223, lat: 41.89021, labelHeight: 85 },
  { id: "costantino", label: "ARCVS CONSTANTINI", lon: 12.4906, lat: 41.88985, labelHeight: 40 },
  { id: "tito", label: "ARCVS TITI", lon: 12.48893, lat: 41.89063, labelHeight: 35 },
  { id: "foro", label: "FORVM ROMANVM", lon: 12.4853, lat: 41.8925, labelHeight: 50 },
  { id: "palatino", label: "PALATINVM", lon: 12.4876, lat: 41.8888, labelHeight: 55 },
  { id: "circo", label: "CIRCVS MAXIMVS", lon: 12.485, lat: 41.886, labelHeight: 45 },
  { id: "traiano", label: "COLVMNA TRAIANI", lon: 12.48445, lat: 41.8958, labelHeight: 60 },
  { id: "vittoriano", label: "VITTORIANO", lon: 12.48245, lat: 41.89455, labelHeight: 75 },
  { id: "campidoglio", label: "CAPITOLIVM", lon: 12.4828, lat: 41.893, labelHeight: 50 },
  { id: "pantheon", label: "PANTHEON", lon: 12.47688, lat: 41.89861, labelHeight: 55 },
  { id: "navona", label: "STADIVM DOMITIANI", lon: 12.4731, lat: 41.89893, labelHeight: 45 },
  { id: "castello", label: "MAVSOLEVM HADRIANI", lon: 12.46633, lat: 41.90306, labelHeight: 60 },
  { id: "sanpietro", label: "BASILICA S. PETRI", lon: 12.45394, lat: 41.90217, labelHeight: 150 },
  { id: "caracalla", label: "THERMAE ANTONINIANAE", lon: 12.4923, lat: 41.8786, labelHeight: 55 },
];

/** El Colosseo: centro aprox. y fallback de orientación (rumbo del eje mayor). */
export const COLOSSEUM = {
  lon: 12.49223,
  lat: 41.89021,
  fallbackBearingDeg: 120,
  semiMajor: 94,
  semiMinor: 78,
};

export type StatueSlot = {
  /** Archivo en /public/models/statues/ (GLB decimado, p. ej. de Three D Scans). */
  file: string;
  lon: number;
  lat: number;
  /** Altura de la figura sin pedestal (m). */
  height: number;
  pedestal: number;
  rotationDeg: number;
};

/** Ranuras: coloca los GLB con estos nombres y aparecen. Los que falten se omiten. */
export const ROME_STATUE_SLOTS: StatueSlot[] = [
  { file: "statue-01.glb", lon: 12.4913, lat: 41.8908, height: 4.5, pedestal: 2.5, rotationDeg: 200 },
  { file: "statue-02.glb", lon: 12.4909, lat: 41.8912, height: 4.5, pedestal: 2.5, rotationDeg: 160 },
  { file: "statue-03.glb", lon: 12.4868, lat: 41.8921, height: 4.5, pedestal: 2.5, rotationDeg: 90 },
  { file: "statue-04.glb", lon: 12.4851, lat: 41.8926, height: 4.5, pedestal: 2.5, rotationDeg: 270 },
  { file: "statue-05.glb", lon: 12.4837, lat: 41.8945, height: 5, pedestal: 3, rotationDeg: 0 },
  { file: "statue-06.glb", lon: 12.4775, lat: 41.8984, height: 4.5, pedestal: 2.5, rotationDeg: 180 },
];

export const CREDITS =
  "Mapas: OpenStreetMap · Imágenes: Esri, Vantor, Earthstar Geographics, GIS User Community · Elevación: NASA SRTM · Texturas: Poly Haven, ambientCG · Estatuas: Three D Scans · Tipografía: Cinzel";
