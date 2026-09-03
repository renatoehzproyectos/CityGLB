import { cfg } from "./config";
import {
  bboxCenter,
  bboxSizeMeters,
  bboxToLocalBox,
  clipPolygonToBox,
  clipPolylineToBox,
  pathLength,
  project,
  ringArea,
  roundMeters,
} from "./geo";
import { clampHeight } from "./height";
import { simplifyRing, uniqueRing } from "./simplify";
import type { BBox, BuildingFeature, CityData, RoadFeature, WaterFeature } from "./types";

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
};

export type OvertureSegmentProps = {
  id?: string;
  subtype?: string | null; // "road", "rail", etc.
  class?: string | null; // "motorway", "residential", ...
};

export type OvertureWaterProps = {
  id?: string;
  subtype?: string | null;
};

export type OvertureGeometry =
  | { type: "Polygon"; coordinates: LonLat[][] }
  | { type: "MultiPolygon"; coordinates: LonLat[][][] };

export type OvertureLineGeometry =
  | { type: "LineString"; coordinates: LonLat[] }
  | { type: "MultiLineString"; coordinates: LonLat[][] };

export type OvertureBuildingFeature = {
  type: "Feature";
  geometry: OvertureGeometry | null;
  properties: OvertureBuildingProps | null;
};

export type OvertureSegmentFeature = {
  type: "Feature";
  geometry: OvertureLineGeometry | null;
  properties: OvertureSegmentProps | null;
};

export type OvertureWaterFeature = {
  type: "Feature";
  geometry: OvertureGeometry | null;
  properties: OvertureWaterProps | null;
};

export type OvertureBuildingCollection = {
  type: "FeatureCollection";
  features: OvertureBuildingFeature[];
};

export type OvertureSegmentCollection = {
  type: "FeatureCollection";
  features: OvertureSegmentFeature[];
};

export type OvertureWaterCollection = {
  type: "FeatureCollection";
  features: OvertureWaterFeature[];
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

function heightFromProps(props: OvertureBuildingProps): number {
  if (typeof props.height === "number" && props.height > 0) {
    return clampHeight(props.height);
  }
  if (typeof props.num_floors === "number" && props.num_floors > 0) {
    return clampHeight(props.num_floors * cfg.LEVEL_HEIGHT);
  }
  return cfg.DEFAULT_BUILDING_HEIGHT;
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
    const height = heightFromProps(props);
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

      out.push({ ring, holes, height, kind });
    }
  }

  return out;
}

function roadWidthFor(cls: string | null | undefined): number {
  const key = (cls ?? "").toLowerCase();
  return cfg.ROAD_WIDTH_MAP[key] ?? cfg.DEFAULT_ROAD_WIDTH;
}

function projectPath(path: LonLat[], originLon: number, originLat: number): [number, number][] {
  return uniqueRing(
    path.map(([lon, lat]) => {
      const [x, z] = project(lon, lat, originLon, originLat);
      return [roundMeters(x), roundMeters(z)] as [number, number];
    }),
  );
}

/**
 * Converts Overture `theme=transportation/type=segment` into RoadFeature[],
 * mirroring parse-osm.ts: only `subtype=road` segments, simplified with the
 * same (slightly looser) tolerance used for OSM highways.
 */
export function overtureSegmentsToRoads(
  fc: OvertureSegmentCollection,
  originLon: number,
  originLat: number,
): RoadFeature[] {
  const out: RoadFeature[] = [];

  for (const f of fc.features ?? []) {
    const geom = f.geometry;
    if (!geom) continue;
    const props = f.properties ?? {};
    if ((props.subtype ?? "road") !== "road") continue;

    const lines: LonLat[][] = geom.type === "LineString" ? [geom.coordinates] : geom.coordinates;
    for (const line of lines) {
      if (!line || line.length < 2) continue;
      const projected = projectPath(line, originLon, originLat);
      const simplified = simplifyRing(projected, Math.max(cfg.SIMPLIFY_TOLERANCE, 1.2));
      if (simplified.length < 2) continue;
      if (pathLength(simplified) < cfg.MIN_ROAD_LENGTH) continue;
      const highway = (props.class ?? "unclassified").toLowerCase();
      out.push({ path: simplified, width: roadWidthFor(highway), highway });
      if (out.length >= cfg.MAX_ROADS) return out;
    }
  }

  return out;
}

/**
 * Converts Overture `theme=base/type=water` into WaterFeature[], mirroring
 * the OSM water handling (outer ring per feature, min-area filter).
 */
export function overtureWaterToFeatures(
  fc: OvertureWaterCollection,
  originLon: number,
  originLat: number,
): WaterFeature[] {
  const out: WaterFeature[] = [];

  for (const f of fc.features ?? []) {
    if (!f.geometry) continue;
    if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") continue;

    const rings: [number, number][][] = [];
    for (const poly of extractPolygons(f.geometry)) {
      const [outerLonLat] = poly;
      if (!outerLonLat || outerLonLat.length < 3) continue;
      const ring = prepareRing(outerLonLat, originLon, originLat);
      if (ring && ringArea(ring) > 40) rings.push(ring);
    }
    if (rings.length) {
      out.push({ rings });
      if (out.length >= cfg.MAX_WATER) return out;
    }
  }

  return out;
}

/**
 * Builds a full CityData from Overture data. Buildings always come from
 * Overture; roads/water are optional (Overture `transportation`/`base`
 * themes). Every feature is clipped to the requested bbox so nothing
 * protrudes past the terrain tile.
 */
export function overtureToCityData(
  fc: OvertureBuildingCollection,
  bbox: BBox,
  placeName: string,
  extra?: { segments?: OvertureSegmentCollection; water?: OvertureWaterCollection },
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
    buildings.push({ ring: clipped, holes, height: b.height, kind: b.kind });
  }

  const roads: RoadFeature[] = [];
  if (extra?.segments) {
    const rawRoads = overtureSegmentsToRoads(extra.segments, origin.lon, origin.lat);
    for (const r of rawRoads) {
      if (roads.length >= cfg.MAX_ROADS) break;
      const segs = clipPolylineToBox(r.path, box);
      for (const seg of segs) {
        if (seg.length < 2) continue;
        if (pathLength(seg) < cfg.MIN_ROAD_LENGTH) continue;
        roads.push({ path: seg, width: r.width, highway: r.highway });
        if (roads.length >= cfg.MAX_ROADS) break;
      }
    }
  }

  const water: WaterFeature[] = [];
  if (extra?.water) {
    const rawWater = overtureWaterToFeatures(extra.water, origin.lon, origin.lat);
    for (const w of rawWater) {
      if (water.length >= cfg.MAX_WATER) break;
      const rings: [number, number][][] = [];
      for (const ring of w.rings) {
        const clipped = clipPolygonToBox(ring, box);
        if (clipped && ringArea(clipped) > 40) rings.push(clipped);
      }
      if (rings.length) {
        water.push({ rings });
      }
    }
  }

  const { width, depth } = bboxSizeMeters(bbox);
  const minX = -width / 2;
  const maxX = width / 2;
  const minZ = -depth / 2;
  const maxZ = depth / 2;

  // TODO: Overture's `base` theme carries piers/breakwaters under
  // theme=base/type=infrastructure (subtype=pier|breakwater|...) and the
  // coastline under type=land / type=water boundaries. Not wired up yet —
  // the Overpass/OSM pipeline (parse-osm.ts) is the one that currently
  // populates ports + coastline.
  return {
    origin,
    bbox,
    placeName,
    buildings,
    roads,
    water,
    ports: [],
    coastline: [],
    extent: { minX, maxX, minZ, maxZ },
  };
}
