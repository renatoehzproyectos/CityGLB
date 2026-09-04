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
};

export type RoadFeature = {
  path: Ring;
  width: number;
  highway: string;
};

export type WaterFeature = {
  rings: Ring[];
};

/** Ports, quays, breakwaters, piers, jetties, marinas — linear or area
 * waterfront infrastructure. Line-shaped features (piers, breakwaters,
 * groynes) use `path` + `width` like a road; area features (quays,
 * marina basins, harbour grounds) use `ring`. Exactly one of the two
 * is populated depending on `shape`. */
export type PortFeature = {
  kind: "pier" | "breakwater" | "quay" | "marina" | "harbour" | "groyne" | "dock" | "slipway";
  shape: "line" | "area";
  path?: Ring;
  width?: number;
  ring?: Ring;
};

/** The land/sea boundary itself, reconstructed from OSM natural=coastline
 * ways, independent of any water polygon. Used to give the shoreline a
 * distinct, precise edge rather than relying only on water polygon rims. */
export type CoastlineFeature = {
  path: Ring;
};

export type CityData = {
  origin: { lon: number; lat: number };
  bbox: BBox;
  placeName: string;
  buildings: BuildingFeature[];
  roads: RoadFeature[];
  water: WaterFeature[];
  ports: PortFeature[];
  coastline: CoastlineFeature[];
  extent: { minX: number; maxX: number; minZ: number; maxZ: number };
};

export type CityStats = {
  buildings: number;
  roads: number;
  water: number;
  ports: number;
  vertices: number;
  trees?: number;
};

export type PlaceHit = {
  label: string;
  lat: number;
  lon: number;
  bbox: BBox;
};

export type StudioStatus = "idle" | "fetching" | "meshing" | "ready" | "error";
