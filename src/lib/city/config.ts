export const cfg = {
  DEFAULT_BUILDING_HEIGHT: 12,
  MIN_BUILDING_HEIGHT: 3,
  MAX_BUILDING_HEIGHT: 180,
  LEVEL_HEIGHT: 3.2,

  DEFAULT_ROAD_WIDTH: 9,
  ROAD_HEIGHT: 0.18,
  ROAD_WIDTH_MAP: {
    motorway: 22,
    trunk: 18,
    primary: 14,
    secondary: 11,
    tertiary: 9,
    unclassified: 8,
    residential: 7.5,
    living_street: 6.5,
    service: 5.5,
    footway: 2.5,
    path: 2,
    cycleway: 2.5,
    pedestrian: 4,
  } as Record<string, number>,

  FLAT_TERRAIN: false, // now uses real elevation
  MAX_BUILDINGS: 20000,
  MAX_ROADS: 12000,
  MAX_WATER: 1200,
  MAX_PORT: 2000, // piers, breakwaters, quays, marinas, harbours, groynes
  MAX_COASTLINE: 800, // natural=coastline segments
  SIMPLIFY_TOLERANCE: 0.6,
  MIN_BUILDING_AREA: 15,
  MIN_ROAD_LENGTH: 2,

  MAX_SPAN_M: 50_000,
  MIN_SPAN_M: 80,

  // Trees
  ENABLE_TREES: true,
  TREE_DENSITY: 0.00008, // trees per m² (sparse-moderate forest/park feel)
  MAX_TREE_DENSITY: 0.002, // 2000 trees/km² — upper bound for the density slider
  MAX_TREES: 15000,
  TREE_MIN_SLOPE: 0.0,
  TREE_MAX_SLOPE: 0.45, // avoid steep cliffs

  BUILDING_COLOR: [0.78, 0.76, 0.73] as const,
  ROAD_COLOR: [0.22, 0.22, 0.22] as const,
  TERRAIN_COLOR: [0.32, 0.42, 0.26] as const,
  WATER_COLOR: [0.12, 0.32, 0.52] as const,
  COASTLINE_COLOR: [0.86, 0.82, 0.68] as const, // sand/shore edge

  // Waterfront infrastructure widths (m), used when OSM doesn't tag one
  PORT_WIDTH_MAP: {
    pier: 4,
    breakwater: 6,
    groyne: 3,
    dock: 8,
    slipway: 5,
  } as Record<string, number>,
  PORT_COLOR_MAP: {
    pier: [0.55, 0.42, 0.28],
    breakwater: [0.5, 0.49, 0.47],
    groyne: [0.5, 0.49, 0.47],
    dock: [0.45, 0.44, 0.42],
    quay: [0.47, 0.46, 0.44],
    marina: [0.45, 0.44, 0.42],
    harbour: [0.45, 0.44, 0.42],
    slipway: [0.5, 0.49, 0.47],
  } as Record<string, [number, number, number]>,
};

export const BUILDING_TINTS: Record<string, [number, number, number]> = {
  residential: [0.82, 0.78, 0.72],
  house: [0.84, 0.8, 0.73],
  apartments: [0.76, 0.74, 0.7],
  commercial: [0.72, 0.73, 0.74],
  retail: [0.74, 0.72, 0.69],
  industrial: [0.68, 0.66, 0.62],
  warehouse: [0.7, 0.68, 0.64],
  office: [0.73, 0.75, 0.76],
  church: [0.8, 0.78, 0.74],
  cathedral: [0.79, 0.77, 0.73],
  school: [0.77, 0.75, 0.7],
  university: [0.75, 0.74, 0.7],
  hospital: [0.78, 0.76, 0.74],
  hotel: [0.76, 0.74, 0.71],
  yes: [0.78, 0.76, 0.73],
};
