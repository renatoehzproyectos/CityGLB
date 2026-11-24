import type { BBox } from "./types";

export type CityPreset = {
  id: string;
  name: string;
  city: string;
  bbox: BBox;
};

export const PRESETS: CityPreset[] = [
  {
    id: "eiffel",
    name: "Champ de Mars",
    city: "Paris",
    bbox: { minLon: 2.2945, minLat: 48.8584, maxLon: 2.31, maxLat: 48.865 },
  },
  {
    id: "midtown",
    name: "Midtown",
    city: "New York",
    bbox: { minLon: -73.992, minLat: 40.748, maxLon: -73.98, maxLat: 40.758 },
  },
  {
    id: "san-marco",
    name: "San Marco",
    city: "Venice",
    bbox: { minLon: 12.335, minLat: 45.432, maxLon: 12.342, maxLat: 45.437 },
  },
  {
    id: "westminster",
    name: "Westminster",
    city: "London",
    bbox: { minLon: -0.129, minLat: 51.497, maxLon: -0.118, maxLat: 51.504 },
  },
  {
    id: "shibuya",
    name: "Shibuya",
    city: "Tokyo",
    bbox: { minLon: 139.697, minLat: 35.657, maxLon: 139.705, maxLat: 35.662 },
  },
  {
    id: "gothic",
    name: "Barri Gòtic",
    city: "Barcelona",
    bbox: { minLon: 2.174, minLat: 41.38, maxLon: 2.183, maxLat: 41.387 },
  },
];

/** Santiago de Chile: zonas de ~1.5 km (editables). */
export const SANTIAGO_PRESETS: CityPreset[] = [
  { id: "scl-centro", name: "Centro y La Moneda", city: "Santiago",
    bbox: { minLon: -70.6585, minLat: -33.4485, maxLon: -70.6425, maxLat: -33.4365 } },
  { id: "scl-bellasartes", name: "Cerro Santa Lucía", city: "Santiago",
    bbox: { minLon: -70.6485, minLat: -33.4480, maxLon: -70.6330, maxLat: -33.4380 } },
  { id: "scl-providencia", name: "Providencia", city: "Santiago",
    bbox: { minLon: -70.6290, minLat: -33.4290, maxLon: -70.6130, maxLat: -33.4190 } },
  { id: "scl-costanera", name: "Costanera Center", city: "Santiago",
    bbox: { minLon: -70.6120, minLat: -33.4220, maxLon: -70.5960, maxLat: -33.4120 } },
];

export const DEFAULT_PRESET = PRESETS[0];
