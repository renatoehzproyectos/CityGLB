import { create } from "zustand";
import { fetchOvertureLayerFn } from "@/lib/city/fetch-overture";
import { bboxFromCenter, bboxSizeMeters, formatSpan, normalizeBBox, validateBBox } from "@/lib/city/geo";
import { cfg } from "@/lib/city/config";
import { DEFAULT_PRESET } from "@/lib/city/presets";
import type { BBox, CityData, CityStats, PlaceHit, StudioStatus } from "@/lib/city/types";
import { searchPlaces } from "@/lib/city/fetch-city";

type Layers = {
  buildings: boolean;
  roads: boolean;
  water: boolean;
  terrain: boolean;
  trees: boolean;
};

type StudioState = {
  bbox: BBox;
  boxSizeM: number;
  placeName: string;
  drawMode: boolean;
  focusSerial: number;
  includeRoads: boolean;
  includeWater: boolean;
  autoRotate: boolean;
  view: "map" | "model";
  status: StudioStatus;
  error: string | null;
  city: CityData | null;
  stats: CityStats | null;
  layers: Layers;
  /** Trees per m² used when meshing (0 = none). */
  treeDensity: number;
  /** Drape free Esri World Imagery on the terrain (no API key). */
  satellite: boolean;
  /**
   * Drape ESA WorldCover land-cover classification on the terrain (no API
   * key) — the ground's biological/physical material (tree cover,
   * grassland, cropland, built-up, water, etc). Takes priority over
   * `satellite` and also gates where trees can be placed.
   */
  landCover: boolean;
  searchQuery: string;
  searchResults: PlaceHit[];
  searching: boolean;
  /** 0–100 overall generation progress. */
  progress: number;
  /** Human-readable label for the current stage. */
  progressLabel: string;
  setBbox: (bbox: BBox, placeName?: string) => void;
  setBoxSizeM: (sizeM: number) => void;
  setDrawMode: (on: boolean) => void;
  setIncludeRoads: (on: boolean) => void;
  setIncludeWater: (on: boolean) => void;
  setAutoRotate: (on: boolean) => void;
  setView: (view: "map" | "model") => void;
  setLayers: (partial: Partial<Layers>) => void;
  setTreeDensity: (density: number) => void;
  setSatellite: (on: boolean) => void;
  setLandCover: (on: boolean) => void;
  setSearchQuery: (q: string) => void;
  runSearch: () => Promise<void>;
  applyPlace: (place: PlaceHit) => void;
  generate: () => Promise<void>;
  setReady: (stats: CityStats) => void;
  setMeshError: (message: string) => void;
  /** Drive meshing-phase progress from build-scene (fraction 0–1 within meshing). */
  setMeshProgress: (fraction: number, label: string) => void;
};

function spanOf(bbox: BBox): number {
  const { width, depth } = bboxSizeMeters(bbox);
  return Math.max(width, depth);
}

export const useStudio = create<StudioState>((set, get) => ({
  bbox: DEFAULT_PRESET.bbox,
  boxSizeM: Math.round(spanOf(DEFAULT_PRESET.bbox)),
  placeName: `${DEFAULT_PRESET.name}, ${DEFAULT_PRESET.city}`,
  drawMode: false,
  focusSerial: 1,
  includeRoads: true,
  includeWater: true,
  autoRotate: false,
  view: "map",
  status: "idle",
  error: null,
  city: null,
  stats: null,
  layers: { buildings: true, roads: true, water: true, terrain: true, trees: true },
  treeDensity: cfg.TREE_DENSITY,
  satellite: false,
  landCover: false,
  searchQuery: "",
  searchResults: [],
  searching: false,
  progress: 0,
  progressLabel: "",

  setBbox: (bbox, placeName) => {
    const next = normalizeBBox(bbox);
    set((s) => ({
      bbox: next,
      boxSizeM: Math.round(spanOf(next)),
      placeName: placeName ?? s.placeName,
      focusSerial: s.focusSerial + 1,
      view: "map",
      error: null,
    }));
  },

  setBoxSizeM: (sizeM) => {
    const size = Math.max(cfg.MIN_SPAN_M, Math.min(cfg.MAX_SPAN_M, sizeM));
    const { lon, lat } = {
      lon: (get().bbox.minLon + get().bbox.maxLon) / 2,
      lat: (get().bbox.minLat + get().bbox.maxLat) / 2,
    };
    const next = bboxFromCenter(lon, lat, size);
    set((s) => ({
      bbox: next,
      boxSizeM: Math.round(size),
      focusSerial: s.focusSerial + 1,
      view: "map",
      error: null,
    }));
  },

  setDrawMode: (on) => set({ drawMode: on }),
  setIncludeRoads: (on) => set({ includeRoads: on }),
  setIncludeWater: (on) => set({ includeWater: on }),
  setAutoRotate: (on) => set({ autoRotate: on }),
  setView: (view) => set({ view }),
  setLayers: (partial) => set((s) => ({ layers: { ...s.layers, ...partial } })),
  setTreeDensity: (density) => set({ treeDensity: Math.max(0, density) }),
  setSatellite: (on) => set({ satellite: on }),
  setLandCover: (on) => set({ landCover: on }),
  setSearchQuery: (q) => set({ searchQuery: q }),

  runSearch: async () => {
    const q = get().searchQuery.trim();
    if (q.length < 2) {
      set({ searchResults: [], searching: false });
      return;
    }
    set({ searching: true });
    try {
      // TanStack server fn expects `{ data: … }` payload (same as fetchOvertureCityFn).
      const results = await searchPlaces({ data: { q } });
      set({ searchResults: results ?? [], searching: false });
    } catch (e) {
      console.warn("Place search failed", e);
      set({ searchResults: [], searching: false });
    }
  },

  applyPlace: (place) => {
    set((s) => {
      const next = normalizeBBox(place.bbox);
      return {
        bbox: next,
        boxSizeM: Math.round(spanOf(next)),
        placeName: place.label,
        searchResults: [],
        searchQuery: place.label,
        drawMode: false,
        focusSerial: s.focusSerial + 1,
        view: "map",
        error: null,
      };
    });
  },

  generate: async () => {
    const { bbox, includeRoads, includeWater, placeName } = get();
    const box = normalizeBBox(bbox);
    const err = validateBBox(box);
    if (err) {
      set({ status: "error", error: err, progress: 0, progressLabel: "" });
      return;
    }
    set({
      status: "fetching",
      error: null,
      city: null,
      stats: null,
      progress: 2,
      progressLabel: "Preparing Overture query…",
    });

    const base = {
      minLon: box.minLon,
      minLat: box.minLat,
      maxLon: box.maxLon,
      maxLat: box.maxLat,
      placeName,
    };

    try {
      // Real staged progress matching the server STAC/parquet work the user sees in logs.
      set({ progress: 5, progressLabel: "Loading buildings (STAC + parquet)…" });
      const buildings = await fetchOvertureLayerFn({
        data: { ...base, layer: "buildings" },
      });

      let segments: unknown = undefined;
      if (includeRoads) {
        set({ progress: 18, progressLabel: "Loading roads (STAC + parquet)…" });
        segments = await fetchOvertureLayerFn({
          data: { ...base, layer: "roads" },
        });
      } else {
        set({ progress: 22, progressLabel: "Skipping roads…" });
      }

      let water: unknown = undefined;
      if (includeWater) {
        set({ progress: 30, progressLabel: "Loading water (STAC + parquet)…" });
        water = await fetchOvertureLayerFn({
          data: { ...base, layer: "water" },
        });
      } else {
        set({ progress: 34, progressLabel: "Skipping water…" });
      }

      set({ progress: 40, progressLabel: "Clipping features to bbox…" });
      const data = (await fetchOvertureLayerFn({
        data: {
          ...base,
          layer: "assemble",
          buildings,
          segments: includeRoads ? segments : undefined,
          water: includeWater ? water : undefined,
        },
      })) as CityData;

      if (!data || !data.extent) {
        throw new Error("No map data returned for this area.");
      }
      set({
        city: data,
        status: "meshing",
        view: "model",
        progress: 45,
        progressLabel: "Building 3D scene…",
      });
    } catch (e) {
      set({
        status: "error",
        error: e instanceof Error ? e.message : "Could not fetch map data.",
        view: "map",
        progress: 0,
        progressLabel: "",
      });
    }
  },

  setReady: (stats) =>
    set({ status: "ready", stats, error: null, progress: 100, progressLabel: "Done" }),

  setMeshError: (message) =>
    set({ status: "error", error: message, progress: 0, progressLabel: "" }),

  setMeshProgress: (fraction, label) => {
    // Meshing occupies 45% → 99%. Clamp so we never hit 100 before setReady.
    const pct = 45 + Math.max(0, Math.min(1, fraction)) * 54;
    set({ progress: pct, progressLabel: label });
  },
}));

export function currentSpanLabel(bbox: BBox): string {
  const { width, depth } = bboxSizeMeters(bbox);
  return `${formatSpan(width)} × ${formatSpan(depth)}`;
}
