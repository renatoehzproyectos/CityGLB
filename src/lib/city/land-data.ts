import { project, ringArea } from "./geo";
import { roadWidth } from "./roads";
import type { LandResponse } from "./fetch-overture";
import type { CityData } from "./types";

/** Proyecta agua y árboles (lon/lat) a metros locales y los adjunta al CityData. */
export function attachLandData(data: CityData, land: LandResponse): void {
  const { lon: oLon, lat: oLat } = data.origin;
  const proj = (p: [number, number]): [number, number] => project(p[0], p[1], oLon, oLat);
  data.water = land.water
    .map((w) => ({ subtype: w.s, rings: w.r.map((ring) => ring.map(proj)) }))
    .filter((w) => w.rings[0] && w.rings[0].length >= 3 && ringArea(w.rings[0]) >= 30);
  data.osmTrees = land.trees.map(proj);
  data.cover = (land.cover ?? [])
    .map((c) => ({ subtype: c.s, ring: (c.r[0] ?? []).map(proj) }))
    .filter((c) => c.ring.length >= 3 && ringArea(c.ring) >= 40);
  data.roads = (land.roads ?? [])
    .map((r) => ({
      cls: r.c,
      width: roadWidth(r.c),
      bridge: !!r.b,
      tunnel: !!r.t,
      pts: r.l.map(proj),
    }))
    .filter((r) => r.pts.length >= 2 && !r.tunnel);
}
