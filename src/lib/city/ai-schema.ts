/** Clases del modelo propio. DEBEN coincidir con ml/common.py. */
export const FACADE_MATERIALS = ["brick", "concrete", "glass", "stucco", "stone", "metal", "wood"] as const;
export type FacadeMaterial = (typeof FACADE_MATERIALS)[number];

export const ROOF_SHAPES = ["flat", "gabled", "hipped", "pyramidal", "dome"] as const;
export type RoofClass = (typeof ROOF_SHAPES)[number];
