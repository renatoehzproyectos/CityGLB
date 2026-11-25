export const cfg = {
  DEFAULT_BUILDING_HEIGHT: 12,
  MIN_BUILDING_HEIGHT: 3,
  MAX_BUILDING_HEIGHT: 180,
  LEVEL_HEIGHT: 3.2,

  FLAT_TERRAIN: false, // now uses real elevation
  MAX_BUILDINGS: 80000,
  SIMPLIFY_TOLERANCE: 0.6,
  MIN_BUILDING_AREA: 15,

  MAX_SPAN_M: 50_000,
  MIN_SPAN_M: 80,


  // Roofs
  ENABLE_ROOFS: true,
  ROOF_MAX_HEIGHT_FOR_PITCH: 42, // buildings taller than this get a flat cap instead
  ROOF_RISE_MIN: 2.4,
  ROOF_RISE_MAX: 6.5,
  ROOF_INSET: 0.65, // how far the eave overhangs past the wall (m)

  // Facade / window texture
  ENABLE_WINDOWS: true,
  WINDOW_TEXTURE_SIZE: 256,
  FACADE_METERS_PER_TILE: 9, // world meters spanned by one texture tile

  BUILDING_COLOR: [0.78, 0.76, 0.73] as const,
  TERRAIN_COLOR: [0.32, 0.42, 0.26] as const,

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

/**
 * Per-building-kind palette of facade variants (white / beige / ochre / grey…)
 * so neighbouring buildings of the same kind don't all read as one flat color.
 * One is picked per building via a stable hash of its footprint.
 */
export const FACADE_PALETTES: Record<string, [number, number, number][]> = {
  residential: [
    [0.88, 0.85, 0.78],
    [0.8, 0.74, 0.62],
    [0.9, 0.87, 0.82],
    [0.76, 0.7, 0.6],
    [0.84, 0.79, 0.7],
  ],
  house: [
    [0.9, 0.87, 0.79],
    [0.82, 0.75, 0.63],
    [0.87, 0.83, 0.74],
    [0.78, 0.72, 0.6],
  ],
  apartments: [
    [0.8, 0.77, 0.71],
    [0.74, 0.72, 0.68],
    [0.85, 0.81, 0.74],
    [0.7, 0.68, 0.63],
    [0.78, 0.73, 0.63],
  ],
  commercial: [
    [0.74, 0.75, 0.76],
    [0.68, 0.7, 0.72],
    [0.8, 0.81, 0.82],
  ],
  retail: [
    [0.76, 0.73, 0.68],
    [0.7, 0.68, 0.62],
    [0.82, 0.78, 0.7],
  ],
  industrial: [
    [0.66, 0.64, 0.6],
    [0.6, 0.59, 0.56],
    [0.7, 0.68, 0.63],
  ],
  warehouse: [
    [0.68, 0.66, 0.61],
    [0.62, 0.6, 0.56],
  ],
  office: [
    [0.72, 0.75, 0.77],
    [0.65, 0.7, 0.74],
    [0.78, 0.8, 0.81],
  ],
  default: [
    [0.8, 0.77, 0.71],
    [0.74, 0.72, 0.67],
    [0.86, 0.82, 0.75],
    [0.7, 0.67, 0.6],
  ],
};

/** Roof color per building kind (terracotta / tile / slate variety). */
export const ROOF_TINTS: Record<string, [number, number, number][]> = {
  residential: [
    [0.72, 0.36, 0.24],
    [0.66, 0.31, 0.22],
    [0.6, 0.28, 0.2],
  ],
  house: [
    [0.74, 0.38, 0.25],
    [0.68, 0.33, 0.23],
    [0.58, 0.27, 0.19],
  ],
  apartments: [
    [0.58, 0.42, 0.36],
    [0.5, 0.36, 0.32],
    [0.44, 0.32, 0.3],
  ],
  commercial: [[0.45, 0.44, 0.43], [0.4, 0.4, 0.4]],
  retail: [[0.5, 0.36, 0.3], [0.44, 0.42, 0.4]],
  industrial: [[0.42, 0.4, 0.38], [0.38, 0.37, 0.36]],
  warehouse: [[0.42, 0.4, 0.38]],
  office: [[0.4, 0.42, 0.44], [0.36, 0.38, 0.4]],
  church: [[0.35, 0.32, 0.34], [0.3, 0.28, 0.3]],
  cathedral: [[0.32, 0.3, 0.32]],
  school: [[0.55, 0.4, 0.34]],
  university: [[0.5, 0.38, 0.34]],
  hospital: [[0.42, 0.42, 0.42]],
  hotel: [[0.58, 0.4, 0.34]],
  default: [
    [0.65, 0.34, 0.24],
    [0.55, 0.4, 0.36],
    [0.42, 0.4, 0.38],
  ],
};
