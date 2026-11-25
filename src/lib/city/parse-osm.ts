import { cfg } from "./config";
import { bboxCenter, project, ringArea, roundMeters } from "./geo";
import { clampHeight, estimateHeight, hash01 } from "./height";
import { facadeFromProps, roofFromProps } from "./roof-data";
import { simplifyRing, uniqueRing } from "./simplify";
import type { BBox, BuildingFeature, CityData } from "./types";

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

function jitterDefaultHeight(id: number, height: number, tags: OsmTags | undefined): number {
  const explicit = tags?.height || tags?.["building:height"] || tags?.["building:levels"];
  if (explicit) return height;
  const j = 0.88 + hash01(id) * 0.24;
  return clampHeight(height * j);
}

export function parseOsm(json: OsmResponse, bbox: BBox, placeName: string): CityData {
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
      heightKnown: Boolean(tags?.height || tags?.["building:height"] || tags?.["building:levels"] || tags?.levels),
      roof: roofFromProps({
        shape: tags?.["roof:shape"], color: tags?.["roof:colour"] ?? tags?.["roof:color"],
        material: tags?.["roof:material"], height: tags?.["roof:height"], direction: tags?.["roof:direction"],
      }),
      facade: facadeFromProps(
        tags?.["building:colour"] ?? tags?.["building:color"],
        tags?.["building:material"] ?? tags?.["building:facade:material"],
      ),
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
