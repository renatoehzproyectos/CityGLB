import { useEffect, useRef } from "react";
import type { Map as LeafletMap, Rectangle } from "leaflet";
import { bboxFromCenter, bboxSizeMeters, formatSpan, validateBBox } from "@/lib/city/geo";
import type { BBox } from "@/lib/city/types";
import { cn } from "@/lib/utils";

type Props = {
  bbox: BBox;
  boxSizeM: number;
  focusSerial: number;
  onBbox: (bbox: BBox) => void;
  className?: string;
};

export function MapPicker({ bbox, boxSizeM, focusSerial, onBbox, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const rectRef = useRef<Rectangle | null>(null);
  const onBboxRef = useRef(onBbox);
  const boxSizeRef = useRef(boxSizeM);
  const suppressMoveRef = useRef(false);
  onBboxRef.current = onBbox;
  boxSizeRef.current = boxSizeM;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let map: LeafletMap | null = null;
    let resize: ResizeObserver | null = null;

    (async () => {
      const L = await import("leaflet");
      await import("leaflet/dist/leaflet.css");
      if (cancelled || !hostRef.current) return;

      map = L.map(hostRef.current, {
        zoomControl: false,
        attributionControl: true,
        minZoom: 3,
        maxZoom: 18,
      });
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap &copy; CARTO",
        subdomains: "abcd",
        maxZoom: 19,
      }).addTo(map);

      const b = bbox;
      const bounds = L.latLngBounds([b.minLat, b.minLon], [b.maxLat, b.maxLon]);
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16, animate: false });
      const rect = L.rectangle(bounds, {
        color: "#c9c3b6",
        weight: 1.5,
        fillColor: "#c9c3b6",
        fillOpacity: 0.14,
      }).addTo(map);
      rectRef.current = rect;
      mapRef.current = map;

      const syncFromMap = () => {
        if (suppressMoveRef.current || !map) return;
        const center = map.getCenter();
        const next = bboxFromCenter(center.lng, center.lat, boxSizeRef.current);
        onBboxRef.current(next);
      };

      map.on("moveend", syncFromMap);
      map.on("zoomend", syncFromMap);

      resize = new ResizeObserver(() => map?.invalidateSize());
      resize.observe(hostRef.current);
    })();

    return () => {
      cancelled = true;
      resize?.disconnect();
      map?.remove();
      mapRef.current = null;
      rectRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus / preset change: re-center map on the box
  useEffect(() => {
    const map = mapRef.current;
    const rect = rectRef.current;
    if (!map || !rect) return;
    void import("leaflet").then((L) => {
      const bounds = L.latLngBounds(
        [bbox.minLat, bbox.minLon],
        [bbox.maxLat, bbox.maxLon],
      );
      suppressMoveRef.current = true;
      rect.setBounds(bounds);
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
      requestAnimationFrame(() => {
        suppressMoveRef.current = false;
      });
    });
  }, [focusSerial]);

  // Size change: keep map center, rebuild box from size
  useEffect(() => {
    const map = mapRef.current;
    const rect = rectRef.current;
    if (!map || !rect) return;
    void import("leaflet").then((L) => {
      const center = map.getCenter();
      const next = bboxFromCenter(center.lng, center.lat, boxSizeM);
      const bounds = L.latLngBounds(
        [next.minLat, next.minLon],
        [next.maxLat, next.maxLon],
      );
      rect.setBounds(bounds);
      const cur = bbox;
      const drifted =
        Math.abs(cur.minLon - next.minLon) > 1e-7 ||
        Math.abs(cur.maxLon - next.maxLon) > 1e-7 ||
        Math.abs(cur.minLat - next.minLat) > 1e-7 ||
        Math.abs(cur.maxLat - next.maxLat) > 1e-7;
      if (drifted) onBboxRef.current(next);
    });
  }, [boxSizeM]);

  // External bbox (e.g. from place search) while not focusing: update rect only
  useEffect(() => {
    const map = mapRef.current;
    const rect = rectRef.current;
    if (!map || !rect) return;
    void import("leaflet").then((L) => {
      rect.setBounds(
        L.latLngBounds([bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]),
      );
    });
  }, [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat]);

  const { width, depth } = bboxSizeMeters(bbox);
  const warn = validateBBox(bbox);

  return (
    <div className={cn("relative h-full min-h-0 w-full overflow-hidden bg-map", className)}>
      <div ref={hostRef} className="h-full w-full" />
      <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-border bg-surface/90 px-3 py-2">
        <p className="font-mono text-xs tabular-nums text-fg">
          {formatSpan(width)} × {formatSpan(depth)}
        </p>
        <p className={cn("mt-0.5 text-[11px]", warn ? "text-danger" : "text-muted")}>
          {warn ? warn : "Box follows the map — pan to move it"}
        </p>
      </div>
    </div>
  );
}
