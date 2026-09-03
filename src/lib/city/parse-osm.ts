import { cfg } from "./config";
import { bboxCenter, pathLength, project, ringArea, roundMeters } from "./geo";
import { clampHeight, estimateHeight, hash01 } from "./height";
import { simplifyRing, uniqueRing } from "./simplify";
import type { BBox, BuildingFeature, CityData, CoastlineFeature, PortFeature, RoadFeature, WaterFeature } from "./types";

type OsmTags = Record<string, string>;

type OsmNode = { type: "node"; id: number; lat: number; lon: number };
type OsmWay = { type: "way"; id: number; nodes: number[]; tags?: OsmTags };
type OsmRel = {
  type: "relation";
  id: number;
  tags?: OsmTags;
  members?: Array<{ type: string; ref: number; role?: string }>;
};
type OsmEl = OsmNode | OsmWay | OsmRel;

type OsmResponse = { elements?: OsmEl[] };

export type OsmJson = OsmResponse;

function samePt(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function joinWays(parts: [number, number][][]): [number, number][][] {
  const remaining = parts.map((p) => p.slice());
  const rings: [number, number][][] = [];

  while (remaining.length) {
    let chain = remaining.pop()!;
    let joined = true;
    while (joined) {
      joined = false;
      for (let i = 0; i < remaining.length; i++) {
        const part = remaining[i];
        const head = chain[0];
        const tail = chain[chain.length - 1];
        const p0 = part[0];
        const p1 = part[part.length - 1];
        if (samePt(tail, p0)) {
          chain = chain.concat(part.slice(1));
        } else if (samePt(tail, p1)) {
          chain = chain.concat(part.slice(0, -1).reverse());
        } else if (samePt(head, p1)) {
          chain = part.concat(chain.slice(1));
        } else if (samePt(head, p0)) {
          chain = part.slice().reverse().concat(chain.slice(1));
        } else {
          continue;
        }
        remaining.splice(i, 1);
        joined = true;
        break;
      }
    }
    if (chain.length >= 4 && samePt(chain[0], chain[chain.length - 1])) {
      rings.push(chain);
    } else if (chain.length >= 3) {
      const closed: [number, number][] = chain.slice();
      if (!samePt(closed[0], closed[closed.length - 1])) {
        closed.push([closed[0][0], closed[0][1]]);
      }
      if (closed.length >= 4) rings.push(closed);
    }
  }
  return rings;
}

function wayCoords(
  way: OsmWay,
  nodes: Map<number, [number, number]>,
): [number, number][] | null {
  const pts: [number, number][] = [];
  for (const id of way.nodes) {
    const n = nodes.get(id);
    if (!n) return null;
    pts.push(n);
  }
  return pts.length >= 2 ? pts : null;
}

function projectRing(
  ring: [number, number][],
  originLon: number,
  originLat: number,
): [number, number][] {
  return uniqueRing(
    ring.map(([lon, lat]) => {
      const [x, z] = project(lon, lat, originLon, originLat);
      return [roundMeters(x), roundMeters(z)];
    }),
  );
}

function prepareRing(
  ring: [number, number][],
  originLon: number,
  originLat: number,
  simplify: boolean,
): [number, number][] | null {
  const projected = projectRing(ring, originLon, originLat);
  const simplified = simplify ? simplifyRing(projected, cfg.SIMPLIFY_TOLERANCE) : projected;
  const pts = uniqueRing(simplified);
  if (pts.length < 3) return null;
  if (!samePt(pts[0], pts[pts.length - 1])) {
    pts.push([pts[0][0], pts[0][1]]);
  }
  return pts.length >= 4 ? pts : null;
}

function roadWidth(highway: string): number {
  return cfg.ROAD_WIDTH_MAP[highway] ?? cfg.DEFAULT_ROAD_WIDTH;
}

function jitterDefaultHeight(id: number, height: number, tags: OsmTags | undefined): number {
  const explicit = tags?.height || tags?.["building:height"] || tags?.["building:levels"];
  if (explicit) return height;
  const j = 0.88 + hash01(id) * 0.24;
  return clampHeight(height * j);
}

export function parseOsm(json: OsmResponse, bbox: BBox, placeName: string, opts: { includeRoads: boolean; includeWater: boolean }): CityData {
  const origin = bboxCenter(bbox);
  const elements = json.elements ?? [];
  const nodes = new Map<number, [number, number]>();
  const ways = new Map<number, OsmWay>();
  const relations: OsmRel[] = [];

  for (const el of elements) {
    if (el.type === "node") nodes.set(el.id, [el.lon, el.lat]);
    else if (el.type === "way") ways.set(el.id, el);
    else if (el.type === "relation") relations.push(el);
  }

  const usedBuildingWays = new Set<number>();
  const buildings: BuildingFeature[] = [];

  const pushBuilding = (ringLonLat: [number, number][], holesLonLat: [number, number][][], tags: OsmTags | undefined, id: number) => {
    const ring = prepareRing(ringLonLat, origin.lon, origin.lat, true);
    if (!ring) return;
    const area = ringArea(ring);
    if (area < cfg.MIN_BUILDING_AREA) return;
    const holes: [number, number][][] = [];
    for (const h of holesLonLat) {
      const hr = prepareRing(h, origin.lon, origin.lat, true);
      if (hr && ringArea(hr) > 4) holes.push(hr);
    }
    const kind = tags?.building && tags.building !== "yes" ? tags.building : "yes";
    buildings.push({
      ring,
      holes,
      height: jitterDefaultHeight(id, estimateHeight(tags), tags),
      kind,
    });
  };

  for (const rel of relations) {
    if (!rel.tags?.building) continue;
    const outers: [number, number][][] = [];
    const inners: [number, number][][] = [];
    for (const m of rel.members ?? []) {
      if (m.type !== "way") continue;
      const way = ways.get(m.ref);
      if (!way) continue;
      const coords = wayCoords(way, nodes);
      if (!coords) continue;
      usedBuildingWays.add(way.id);
      if (m.role === "inner") inners.push(coords);
      else outers.push(coords);
    }
    const rings = joinWays(outers);
    for (const ring of rings) {
      pushBuilding(ring, inners, rel.tags, rel.id);
    }
  }

  for (const way of ways.values()) {
    if (!way.tags?.building) continue;
    if (usedBuildingWays.has(way.id)) continue;
    const coords = wayCoords(way, nodes);
    if (!coords || coords.length < 3) continue;
    pushBuilding(coords, [], way.tags, way.id);
  }

  buildings.sort((a, b) => ringArea(b.ring) - ringArea(a.ring));
  const clippedBuildings = buildings.slice(0, cfg.MAX_BUILDINGS);

  const roads: RoadFeature[] = [];
  if (opts.includeRoads) {
    for (const way of ways.values()) {
      const highway = way.tags?.highway;
      if (!highway) continue;
      if (way.tags?.area === "yes") continue;
      const coords = wayCoords(way, nodes);
      if (!coords) continue;
      const path = uniqueRing(
        coords.map(([lon, lat]) => {
          const [x, z] = project(lon, lat, origin.lon, origin.lat);
          return [roundMeters(x), roundMeters(z)] as [number, number];
        }),
      );
      const simplified = simplifyRing(path, Math.max(cfg.SIMPLIFY_TOLERANCE, 1.2));
      if (simplified.length < 2) continue;
      if (pathLength(simplified) < cfg.MIN_ROAD_LENGTH) continue;
      roads.push({
        path: simplified,
        width: roadWidth(highway),
        highway,
      });
      if (roads.length >= cfg.MAX_ROADS) break;
    }
  }

  const water: WaterFeature[] = [];
  if (opts.includeWater) {
    const usedWaterWays = new Set<number>();
    const pushWater = (ringsLonLat: [number, number][][]) => {
      const rings: [number, number][][] = [];
      for (const r of ringsLonLat) {
        const pr = prepareRing(r, origin.lon, origin.lat, true);
        if (pr && ringArea(pr) > 40) rings.push(pr);
      }
      if (rings.length) water.push({ rings });
    };

    for (const rel of relations) {
      const tags = rel.tags ?? {};
      const isWater =
        tags.natural === "water" ||
        tags.waterway === "riverbank" ||
        tags.landuse === "reservoir" ||
        Boolean(tags.water);
      if (!isWater) continue;
      const outers: [number, number][][] = [];
      for (const m of rel.members ?? []) {
        if (m.type !== "way" || m.role === "inner") continue;
        const way = ways.get(m.ref);
        if (!way) continue;
        const coords = wayCoords(way, nodes);
        if (!coords) continue;
        usedWaterWays.add(way.id);
        outers.push(coords);
      }
      for (const ring of joinWays(outers)) pushWater([ring]);
      if (water.length >= cfg.MAX_WATER) break;
    }

    if (water.length < cfg.MAX_WATER) {
      for (const way of ways.values()) {
        if (usedWaterWays.has(way.id)) continue;
        const tags = way.tags ?? {};
        const isWater =
          tags.natural === "water" ||
          tags.waterway === "riverbank" ||
          tags.landuse === "reservoir" ||
          Boolean(tags.water);
        if (!isWater) continue;
        const coords = wayCoords(way, nodes);
        if (!coords || coords.length < 4) continue;
        pushWater([coords]);
        if (water.length >= cfg.MAX_WATER) break;
      }
    }
  }

  // Ports, quays, breakwaters, piers, marinas, harbours, docks, groynes,
  // slipways — waterfront infrastructure kept as its own layer, separate
  // from generic water polygons.
  const ports: PortFeature[] = [];
  if (opts.includeWater) {
    const usedPortWays = new Set<number>();

    const portKind = (tags: OsmTags): PortFeature["kind"] | null => {
      if (tags.man_made === "pier") return "pier";
      if (tags.man_made === "breakwater") return "breakwater";
      if (tags.man_made === "groyne") return "groyne";
      if (tags.man_made === "quay") return "quay";
      if (tags.man_made === "dock") return "dock";
      if (tags.leisure === "marina") return "marina";
      if (tags.harbour) return "harbour";
      if (tags.slipway === "yes" || tags.man_made === "slipway") return "slipway";
      return null;
    };

    // Line-shaped structures: piers, breakwaters, groynes, slipways.
    const lineKinds = new Set(["pier", "breakwater", "groyne", "slipway"]);

    for (const way of ways.values()) {
      const tags = way.tags ?? {};
      const kind = portKind(tags);
      if (!kind) continue;
      const coords = wayCoords(way, nodes);
      if (!coords) continue;

      if (lineKinds.has(kind) && tags.area !== "yes") {
        const path = uniqueRing(
          coords.map(([lon, lat]) => {
            const [x, z] = project(lon, lat, origin.lon, origin.lat);
            return [roundMeters(x), roundMeters(z)] as [number, number];
          }),
        );
        const simplified = simplifyRing(path, cfg.SIMPLIFY_TOLERANCE);
        if (simplified.length < 2) continue;
        if (pathLength(simplified) < cfg.MIN_ROAD_LENGTH) continue;
        ports.push({
          kind,
          shape: "line",
          path: simplified,
          width: cfg.PORT_WIDTH_MAP[kind] ?? 4,
        });
      } else {
        // Area-shaped: quays, docks, marina basins, harbour grounds.
        if (coords.length < 4) continue;
        usedPortWays.add(way.id);
        const ring = prepareRing(coords, origin.lon, origin.lat, true);
        if (!ring || ringArea(ring) < 20) continue;
        ports.push({ kind, shape: "area", ring });
      }
      if (ports.length >= cfg.MAX_PORT) break;
    }

    if (ports.length < cfg.MAX_PORT) {
      for (const rel of relations) {
        const tags = rel.tags ?? {};
        const kind = portKind(tags);
        if (!kind || lineKinds.has(kind)) continue;
        const outers: [number, number][][] = [];
        for (const m of rel.members ?? []) {
          if (m.type !== "way" || m.role === "inner") continue;
          const way = ways.get(m.ref);
          if (!way || usedPortWays.has(way.id)) continue;
          const coords = wayCoords(way, nodes);
          if (!coords) continue;
          outers.push(coords);
        }
        for (const ring of joinWays(outers)) {
          const pr = prepareRing(ring, origin.lon, origin.lat, true);
          if (pr && ringArea(pr) >= 20) ports.push({ kind, shape: "area", ring: pr });
          if (ports.length >= cfg.MAX_PORT) break;
        }
        if (ports.length >= cfg.MAX_PORT) break;
      }
    }
  }

  // Coastline: the real land/sea boundary, reconstructed independently of
  // any water polygon so the shoreline itself is precise.
  const coastline: CoastlineFeature[] = [];
  if (opts.includeWater) {
    const rawChains: [number, number][][] = [];
    for (const way of ways.values()) {
      if (way.tags?.natural !== "coastline") continue;
      const coords = wayCoords(way, nodes);
      if (!coords) continue;
      rawChains.push(coords);
    }
    for (const chain of joinWays(rawChains)) {
      const path = projectRing(chain, origin.lon, origin.lat);
      const simplified = simplifyRing(path, cfg.SIMPLIFY_TOLERANCE);
      if (simplified.length < 2) continue;
      coastline.push({ path: simplified });
      if (coastline.length >= cfg.MAX_COASTLINE) break;
    }
  }

  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  const consider = (x: number, z: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (const b of clippedBuildings) for (const p of b.ring) consider(p[0], p[1]);
  for (const r of roads) for (const p of r.path) consider(p[0], p[1]);
  for (const w of water) for (const ring of w.rings) for (const p of ring) consider(p[0], p[1]);
  for (const p of ports) {
    if (p.path) for (const pt of p.path) consider(pt[0], pt[1]);
    if (p.ring) for (const pt of p.ring) consider(pt[0], pt[1]);
  }
  for (const c of coastline) for (const p of c.path) consider(p[0], p[1]);

  const { width, depth } = (() => {
    const w = (bbox.maxLon - bbox.minLon) * 111320 * Math.cos((origin.lat * Math.PI) / 180);
    const d = (bbox.maxLat - bbox.minLat) * 111320;
    return { width: w, depth: d };
  })();

  if (!Number.isFinite(minX)) {
    minX = -width / 2;
    maxX = width / 2;
    minZ = -depth / 2;
    maxZ = depth / 2;
  }

  return {
    origin,
    bbox,
    placeName,
    buildings: clippedBuildings,
    roads,
    water,
    ports,
    coastline,
    extent: { minX, maxX, minZ, maxZ },
  };
}

function xmlAttrs(openTag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z:_]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(openTag))) out[m[1]] = m[2];
  return out;
}

function xmlTags(block: string): OsmTags | undefined {
  const tags: OsmTags = {};
  const re = /<tag k="([^"]*)" v="([^"]*)"\s*\/>/g;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(block))) {
    tags[m[1]] = m[2];
    any = true;
  }
  return any ? tags : undefined;
}

export function parseOsmXml(xml: string): OsmResponse {
  const elements: OsmEl[] = [];

  const nodeRe = /<node\b([^>]*)(?:\/>|>([\s\S]*?)<\/node>)/g;
  let nm: RegExpExecArray | null;
  while ((nm = nodeRe.exec(xml))) {
    const a = xmlAttrs(nm[1]);
    const id = Number(a.id);
    const lat = Number(a.lat);
    const lon = Number(a.lon);
    if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    elements.push({ type: "node", id, lat, lon });
  }

  const wayRe = /<way\b([^>]*)>([\s\S]*?)<\/way>/g;
  let wm: RegExpExecArray | null;
  while ((wm = wayRe.exec(xml))) {
    const a = xmlAttrs(wm[1]);
    const id = Number(a.id);
    if (!Number.isFinite(id)) continue;
    const nodes: number[] = [];
    const ndRe = /<nd ref="([^"]+)"\s*\/>/g;
    let nd: RegExpExecArray | null;
    while ((nd = ndRe.exec(wm[2]))) nodes.push(Number(nd[1]));
    elements.push({ type: "way", id, nodes, tags: xmlTags(wm[2]) });
  }

  const relRe = /<relation\b([^>]*)>([\s\S]*?)<\/relation>/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(xml))) {
    const a = xmlAttrs(rm[1]);
    const id = Number(a.id);
    if (!Number.isFinite(id)) continue;
    const members: Array<{ type: string; ref: number; role?: string }> = [];
    const memRe = /<member type="([^"]*)" ref="([^"]*)" role="([^"]*)"\s*\/>/g;
    let mem: RegExpExecArray | null;
    while ((mem = memRe.exec(rm[2]))) {
      members.push({ type: mem[1], ref: Number(mem[2]), role: mem[3] });
    }
    elements.push({ type: "relation", id, tags: xmlTags(rm[2]), members });
  }

  return { elements };
}
