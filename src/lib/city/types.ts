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

export type CityData = {
  origin: { lon: number; lat: number };
  bbox: BBox;
  placeName: string;
  buildings: BuildingFeature[];
  extent: { minX: number; maxX: number; minZ: number; maxZ: number };
};

export type CityStats = {
  buildings: number;
  vertices: number;
  /** Edificios con datos estimados por IA. */
  aiBuildings?: number;
};

export type PlaceHit = {
  label: string;
  lat: number;
  lon: number;
  bbox: BBox;
};

export type StudioStatus = "idle" | "fetching" | "meshing" | "ready" | "error";
