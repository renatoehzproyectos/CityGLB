"""Constantes compartidas. DEBEN coincidir con src/lib/city/ai-schema.ts."""
ROOF_SHAPES = ["flat", "gabled", "hipped", "pyramidal", "dome"]
MATERIALS = ["brick", "concrete", "glass", "stucco", "stone", "metal", "wood"]

INPUT_SIZE = 96   # píxeles del parche (lado)
WINDOW_M = 96.0   # metros de terreno que cubre el parche → 1 m/px

ROOF_MAP = {
    "flat": "flat",
    "gabled": "gabled", "gambrel": "gabled", "saltbox": "gabled", "skillion": "gabled",
    "sawtooth": "gabled", "gable": "gabled",
    "hipped": "hipped", "half_hipped": "hipped", "mansard": "hipped", "hip": "hipped", "half-hipped": "hipped",
    "pyramidal": "pyramidal", "pyramid": "pyramidal",
    "dome": "dome", "spherical": "dome", "onion": "dome", "round": "dome",
}
MATERIAL_MAP = {
    "brick": "brick",
    "cement_block": "concrete", "concrete": "concrete",
    "glass": "glass",
    "plaster": "stucco", "stucco": "stucco",
    "stone": "stone",
    "metal": "metal",
    "wood": "wood", "timber_framing": "wood",
}
LEVEL_HEIGHT_M = 3.0


def roof_index(raw):
    v = ROOF_MAP.get(str(raw).strip().lower()) if raw else None
    return ROOF_SHAPES.index(v) if v else -1


def material_index(raw):
    v = MATERIAL_MAP.get(str(raw).strip().lower()) if raw else None
    return MATERIALS.index(v) if v else -1
