import { cfg } from "./config";
import {
  bboxCenter,
  bboxSizeMeters,
  bboxToLocalBox,
  clipPolygonToBox,
  project,
  ringArea,
  roundMeters,
} from "./geo";
import { clampHeight } from "./height";
import { facadeFromProps, roofFromProps } from "./roof-data";
import { simplifyRing, uniqueRing } from "./simplify";
import type { BBox, BuildingFeature, CityData } from "./types";

/**
 * Overture Maps release pinned for this build. Bump deliberately and note the
 * date when you do — see docs.overturemaps.org/release for the changelog.
 */
export const OVERTURE_RELEASE = "2026-08-19.0";

type LonLat = [number, number];

export type OvertureBuildingProps = {
  id?: string;
  height?: number | null;
  num_floors?: number | null;
  class?: string | null;
  subtype?: string | null;
  names?: { primary?: string | null } | null;
  facade_color?: string | null;
  facade_material?: string | null;
  roof_shape?: string | null;
  roof_color?: string | null;
  roof_material?: string | null;
  roof_height?: number | null;
  roof_direction?: number | null;
};

export type OvertureGeometry =
  | { type: "Polygon"; coordinates: LonLat[][] }
  | { type: "MultiPolygon"; coordinates: LonLat[][][] };

export type OvertureBuildingFeature = {
  type: "Feature";
  geometry: OvertureGeometry | null;
  properties: OvertureBuildingProps | null;
};

export type OvertureBuildingCollection = {
  type: "FeatureCollection";
  features: OvertureBuildingFeature[];
};

function samePt(a: LonLat, b: LonLat): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function projectRing(ring: LonLat[], originLon: number, originLat: number): [number, number][] {
  return uniqueRing(
    ring.map(([lon, lat]) => {
      const [x, z] = project(lon, lat, originLon, originLat);
      return [roundMeters(x), roundMeters(z)] as [number, number];
    }),
  );
}

function prepareRing(
  ring: LonLat[],
  originLon: number,
  originLat: number,
): [number, number][] | null {
  const projected = projectRing(ring, originLon, originLat);
  const simplified = simplifyRing(projected, cfg.SIMPLIFY_TOLERANCE);
  const pts = uniqueRing(simplified);
  if (pts.length < 3) return null;
  if (!samePt(pts[0], pts[pts.length - 1])) {
    pts.push([pts[0][0], pts[0][1]]);
  }
  return pts.length >= 4 ? pts : null;
}

function extractPolygons(geom: OvertureGeometry): LonLat[][][] {
  // Returns an array of polygons, each polygon = [outerRing, ...holeRings]
  return geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
}

function knownHeight(props: OvertureBuildingProps): number | null {
  if (typeof props.height === "number" && props.height > 0) {
    return clampHeight(props.height);
  }
  if (typeof props.num_floors === "number" && props.num_floors > 0) {
    return clampHeight(props.num_floors * cfg.LEVEL_HEIGHT);
  }
  return null;
}

/**
 * La mayoría de edificios de Overture/OSM no traen altura: todos salían a 12 m y el
 * skyline quedaba plano. Se estima por huella y tipo, con variación determinista
 * (misma altura en cada regeneración). Heurística global, no específica de una ciudad.
 */
function estimatedHeight(kind: string, area: number, seed: number): number {
  const v = Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
  if (kind === "church" || kind === "cathedral" || kind === "religious") return 16 + v * 14;
  if (kind === "industrial" || kind === "warehouse" || kind === "garage" || kind === "shed") return 6 + v * 5;
  if (kind === "house" || kind === "detached" || kind === "garage" || area < 90) return 5 + v * 4;
  if (area < 400) return 11 + v * 9; // 3–6 plantas
  return 14 + v * 11;
}

function kindFromProps(props: OvertureBuildingProps): string {
  const raw = props.subtype || props.class || "yes";
  return String(raw).toLowerCase();
}

/**
 * Converts an Overture `theme=buildings/type=building` GeoJSON FeatureCollection
 * into the same BuildingFeature[] shape parse-osm.ts produces (rings projected
 * to local meters around `origin`, already simplified and area-filtered).
 */
export function overtureBuildingsToFeatures(
  fc: OvertureBuildingCollection,
  originLon: number,
  originLat: number,
): BuildingFeature[] {
  const out: BuildingFeature[] = [];

  for (const f of fc.features ?? []) {
    if (!f.geometry) continue;
    if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") continue;

    const props = f.properties ?? {};
    const known = knownHeight(props);
    const kind = kindFromProps(props);

    for (const poly of extractPolygons(f.geometry)) {
      const [outerLonLat, ...holesLonLat] = poly;
      if (!outerLonLat || outerLonLat.length < 3) continue;

      const ring = prepareRing(outerLonLat, originLon, originLat);
      if (!ring) continue;
      const area = ringArea(ring);
      if (area < cfg.MIN_BUILDING_AREA) continue;

      const holes: [number, number][][] = [];
      for (const h of holesLonLat) {
        const hr = prepareRing(h, originLon, originLat);
        if (hr && ringArea(hr) > 4) holes.push(hr);
      }

      const height =
        known ?? clampHeight(estimatedHeight(kind, area, ring[0][0] * 7.31 + ring[0][1] * 3.17));
      out.push({
        ring, holes, height, kind, heightKnown: known != null,
        roof: roofFromProps({
          shape: props.roof_shape, color: props.roof_color, material: props.roof_material,
          height: props.roof_height, direction: props.roof_direction,
        }),
        facade: facadeFromProps(props.facade_color, props.facade_material),
      });
    }
  }

  return out;
}

/**
 * Builds a full CityData from Overture data. Buildings always come from
 * Overture. Every feature is clipped to the requested bbox so nothing
 * protrudes past the terrain tile.
 */
export function overtureToCityData(
  fc: OvertureBuildingCollection,
  bbox: BBox,
  placeName: string,
): CityData {
  const origin = bboxCenter(bbox);
  const box = bboxToLocalBox(bbox);

  const rawBuildings = overtureBuildingsToFeatures(fc, origin.lon, origin.lat);
  rawBuildings.sort((a, b) => ringArea(b.ring) - ringArea(a.ring));

  const buildings: BuildingFeature[] = [];
  for (const b of rawBuildings) {
    if (buildings.length >= cfg.MAX_BUILDINGS) break;
    const clipped = clipPolygonToBox(b.ring, box);
    if (!clipped || ringArea(clipped) < cfg.MIN_BUILDING_AREA) continue;
    const holes: [number, number][][] = [];
    for (const h of b.holes) {
      const ch = clipPolygonToBox(h, box);
      if (ch && ringArea(ch) > 4) holes.push(ch);
    }
    buildings.push({ ring: clipped, holes, height: b.height, kind: b.kind, roof: b.roof, facade: b.facade, heightKnown: b.heightKnown });
  }

  const { width, depth } = bboxSizeMeters(bbox);
  const minX = -width / 2;
  const maxX = width / 2;
  const minZ = -depth / 2;
  const maxZ = depth / 2;

  return {
    origin,
    bbox,
    placeName,
    buildings,
    extent: { minX, maxX, minZ, maxZ },
  };
}
