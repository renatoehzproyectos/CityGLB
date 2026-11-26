import { create } from "zustand";
import { fetchOvertureLayerFn } from "@/lib/city/fetch-overture";
import { bboxFromCenter, bboxSizeMeters, formatSpan, normalizeBBox, validateBBox } from "@/lib/city/geo";
import { cfg } from "@/lib/city/config";
import { DEFAULT_PRESET } from "@/lib/city/presets";
import type { RealisticOptions } from "@/lib/city/build-scene";
import type { BBox, CityData, CityStats, PlaceHit, StudioStatus } from "@/lib/city/types";
import { searchPlaces, fetchCity } from "@/lib/city/fetch-city";
import { getCityAssets } from "@/lib/city/prefetch";
import { fetchCityTiled } from "@/lib/city/tiles";
import { enrichBuildingsWithAI } from "@/lib/city/ai-enrich";
import { fetchLandLayersFn } from "@/lib/city/fetch-overture";
import { attachLandData } from "@/lib/city/land-data";
import { enrichFacadeColorsFromStreet } from "@/lib/city/street-enrich";
import { toast } from "sonner";

type Layers = {
  buildings: boolean;
  terrain: boolean;
  water: boolean;
  vegetation: boolean;
};

type StudioState = {
  bbox: BBox;
  boxSizeM: number;
  placeName: string;
  drawMode: boolean;
  focusSerial: number;
  view: "map" | "model";
  status: StudioStatus;
  error: string | null;
  city: CityData | null;
  stats: CityStats | null;
  layers: Layers;
  /** Drape free Esri World Imagery on the terrain (no API key). */
  satellite: boolean;
  /** Modelo propio (ONNX): altura, techo y material de edificios desde la imagen aérea. */
  aiBuildings: boolean;
  setAiBuildings: (on: boolean) => void;
  /** Color real de fachadas desde fotos de calle (Mapillary). */
  streetColors: boolean;
  setStreetColors: (on: boolean) => void;
  /** Modo realista: satélite HD y cielo. */
  realistic: RealisticOptions;
  setRealistic: (partial: Partial<RealisticOptions>) => void;
  /** Activa todo el modo realista (y satélite). */
  setRealisticMode: (on: boolean) => void;
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
  setView: (view: "map" | "model") => void;
  setLayers: (partial: Partial<Layers>) => void;
  setSatellite: (on: boolean) => void;
  setSearchQuery: (q: string) => void;
  runSearch: () => Promise<void>;
  applyPlace: (place: PlaceHit) => void;
  generate: () => Promise<void>;
  setReady: (stats: CityStats) => void;
  setMeshError: (message: string) => void;
  /** Drive meshing-phase progress from build-scene (fraction 0–1 within meshing). */
  setMeshProgress: (fraction: number, label: string) => void;
};

const REALISTIC_OFF: RealisticOptions = { hdSatellite: false, atmosphere: false };
const REALISTIC_ON: RealisticOptions = { hdSatellite: true, atmosphere: true };

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
  view: "map",
  status: "idle",
  error: null,
  city: null,
  stats: null,
  layers: { buildings: true, terrain: true, water: true, vegetation: true },
  satellite: true,
  aiBuildings: true,
  setAiBuildings: (on) => set({ aiBuildings: on }),
  streetColors: true,
  setStreetColors: (on) => set({ streetColors: on }),
  realistic: REALISTIC_ON,
  setRealistic: (partial) => set((s) => ({ realistic: { ...s.realistic, ...partial } })),
  setRealisticMode: (on) =>
    set((s) => ({
      realistic: on ? REALISTIC_ON : REALISTIC_OFF,
      satellite: on ? true : s.satellite,
    })),
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
  setView: (view) => set({ view }),
  setLayers: (partial) => set((s) => ({ layers: { ...s.layers, ...partial } })),
  setSatellite: (on) => set({ satellite: on }),
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
    const { bbox, placeName } = get();
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
      // Arranca YA las descargas que solo dependen del bbox (elevación, satélite, texturas)
      // para que viajen mientras el servidor lee Overture.
      {
        const st = get();
        void getCityAssets(box, {
          satellite: st.satellite,
          hdSatellite: st.realistic.hdSatellite,
          flatTerrain: false,
        });
      }

      // Una sola petición: el servidor consulta edificios, calles y agua en paralelo.
      set({ progress: 8, progressLabel: "Loading buildings…" });
      const { width, depth } = bboxSizeMeters(box);
      let data = await fetchCityTiled(
        (tile) =>
          fetchOvertureLayerFn({
            data: { ...base, layer: "tile", tile },
          }) as Promise<CityData>,
        Math.max(width, depth),
        (done, total) =>
          set({
            progress: 8 + Math.round((done / total) * 32),
            progressLabel: `Loading city tiles ${done}/${total}…`,
          }),
      );
      const overtureBuildings = data?.buildings?.length ?? 0;

      // Respaldo: si Overture no dio edificios, probar OpenStreetMap (Overpass).
      if (!data?.buildings?.length) {
        console.warn(`[generate] Overture devolvió ${overtureBuildings} edificios; probando OSM/Overpass`);
        set({ progress: 42, progressLabel: "Overture sin edificios; probando OpenStreetMap…" });
        try {
          const osm = (await fetchCity({
            data: { ...base },
          })) as CityData;
          if (osm?.buildings?.length) data = osm;
        } catch (e) {
          console.warn("[generate] Overpass también falló", e);
        }
      }
      if (!data?.buildings?.length) {
        throw new Error(
          "No se encontraron edificios en esta zona (Overture y OpenStreetMap devolvieron 0). " +
            "Prueba una zona más pequeña o revisa los logs del servidor ([overture] files ok/failed).",
        );
      }

      if (!data || !data.extent) {
        throw new Error("No map data returned for this area.");
      }
      // Agua y árboles reales (opcional: si falla, se genera sin ellos)
      try {
        set({ progress: 39, progressLabel: "Cargando agua y vegetación…" });
        const land = await fetchLandLayersFn({
          data: { minLon: box.minLon, minLat: box.minLat, maxLon: box.maxLon, maxLat: box.maxLat },
        });
        attachLandData(data, land);
      } catch (e) {
        console.warn("[generate] agua/árboles no disponibles", e);
      }
      if (get().streetColors) {
        try {
          set({ progress: 40, progressLabel: "Fotos de calle: buscando fachadas…" });
          const res = await enrichFacadeColorsFromStreet(data, (done, total) =>
            set({ progress: 40, progressLabel: `Fotos de calle: ${done}/${total}…` }),
          );
          if (res.notConfigured) {
            toast.warning("Fotos de calle no configuradas: define MAPILLARY_TOKEN en el servidor. Se usan los colores estándar.");
          } else if (res.warning && res.applied === 0) {
            toast.warning(`Fotos de calle: ${res.warning}`);
          }
        } catch (e) {
          console.warn("[generate] fotos de calle fallaron", e);
        }
      }
      if (get().aiBuildings) {
        try {
          set({ progress: 40, progressLabel: "IA: preparando imagen aérea…" });
          const st = get();
          const sat = await getCityAssets(box, {
            satellite: true,
            hdSatellite: st.satellite && st.realistic.hdSatellite,
            flatTerrain: false,
          }).sat;
          if (!sat) {
            toast.warning("IA propia: no se pudo descargar la imagen aérea. Se usan los datos estándar.");
          } else {
            const res = await enrichBuildingsWithAI(data, sat, {
              onProgress: (done, total) =>
                set({ progress: 40 + Math.round((done / Math.max(1, total)) * 5), progressLabel: `IA: analizando edificios ${done}/${total}…` }),
            });
            if (res.noModel) {
              toast.warning("IA propia: no hay modelo en /models (building-net.onnx). Entrénalo con ml/ y cópialo. Se usan los datos estándar.");
            } else if (res.warning) {
              toast.warning(`IA propia: ${res.warning}`);
            }
          }
        } catch (e) {
          console.warn("[generate] IA de edificios falló", e);
          toast.warning("IA propia falló; se usan los datos estándar.");
        }
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
        error: e instanceof Error && e.message ? e.message : typeof e === "string" && e ? e : "Could not fetch map data.",
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
