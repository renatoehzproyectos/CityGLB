export type BBox = {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
};

export type Ring = [number, number][];

export type BuildingFeature = {
  ring: Ring;
  holes: Ring[];
  height: number;
  kind: string;
  /** Datos reales de techo (Overture/OSM) cuando existen. */
  roof?: import("./roof-data").RoofInfo;
  /** Color de fachada real (color o material) cuando existe. */
  facade?: import("./roof-data").RGB;
  /** La altura viene de los datos (height / niveles), no de una estimación por huella. */
  heightKnown?: boolean;
  /** Material de fachada (IA); decide la textura. */
  material?: import("./ai-schema").FacadeMaterial;
  /** Algún campo de este edificio fue estimado por IA a partir de la imagen aérea. */
  ai?: boolean;
};

/** Cuerpo de agua real (Overture base/water), en metros locales. rings[0] = exterior, el resto islas. */
export type WaterFeature = {
  subtype: string;
  rings: Ring[];
};

export type CityData = {
  origin: { lon: number; lat: number };
  bbox: BBox;
  placeName: string;
  buildings: BuildingFeature[];
  extent: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Agua real (opcional: si falla la descarga, la escena sigue sin ella). */
  water?: WaterFeature[];
  /** Árboles individuales reales (OSM vía Overture), en metros locales. */
  osmTrees?: [number, number][];
};

export type CityStats = {
  buildings: number;
  vertices: number;
  /** Edificios con datos estimados por IA. */
  aiBuildings?: number;
  trees?: number;
  waterBodies?: number;
};

export type PlaceHit = {
  label: string;
  lat: number;
  lon: number;
  bbox: BBox;
};

export type StudioStatus = "idle" | "fetching" | "meshing" | "ready" | "error";
