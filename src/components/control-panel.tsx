import { Download, LoaderCircle, MapPinned, RotateCw, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { bboxSizeMeters, formatSpan, validateBBox } from "@/lib/city/geo";
import { cityFilename } from "@/lib/city/filename";
import { cn } from "@/lib/utils";
import { currentSpanLabel, useStudio } from "@/store/studio";

type Props = {
  exportFn: (() => Promise<void>) | null;
};

export function ControlPanel({ exportFn }: Props) {
  const bbox = useStudio((s) => s.bbox);
  const boxSizeM = useStudio((s) => s.boxSizeM);
  const placeName = useStudio((s) => s.placeName);
  const includeRoads = useStudio((s) => s.includeRoads);
  const includeWater = useStudio((s) => s.includeWater);
  const autoRotate = useStudio((s) => s.autoRotate);
  const view = useStudio((s) => s.view);
  const status = useStudio((s) => s.status);
  const error = useStudio((s) => s.error);
  const stats = useStudio((s) => s.stats);
  const layers = useStudio((s) => s.layers);
  const treeDensity = useStudio((s) => s.treeDensity);
  const satellite = useStudio((s) => s.satellite);
  const landCover = useStudio((s) => s.landCover);
  const searchQuery = useStudio((s) => s.searchQuery);
  const searchResults = useStudio((s) => s.searchResults);
  const searching = useStudio((s) => s.searching);
  const setIncludeRoads = useStudio((s) => s.setIncludeRoads);
  const setIncludeWater = useStudio((s) => s.setIncludeWater);
  const setAutoRotate = useStudio((s) => s.setAutoRotate);
  const setView = useStudio((s) => s.setView);
  const setLayers = useStudio((s) => s.setLayers);
  const setTreeDensity = useStudio((s) => s.setTreeDensity);
  const setSatellite = useStudio((s) => s.setSatellite);
  const setLandCover = useStudio((s) => s.setLandCover);
  const setSearchQuery = useStudio((s) => s.setSearchQuery);
  const runSearch = useStudio((s) => s.runSearch);
  const applyPlace = useStudio((s) => s.applyPlace);
  const generate = useStudio((s) => s.generate);
  const setBbox = useStudio((s) => s.setBbox);
  const setBoxSizeM = useStudio((s) => s.setBoxSizeM);

  const [busyExport, setBusyExport] = useState(false);
  const busy = status === "fetching" || status === "meshing";
  const warn = validateBBox(bbox);
  const { width, depth } = bboxSizeMeters(bbox);

  const onGenerate = async () => {
    await generate();
    const st = useStudio.getState();
    if (st.status === "error" && st.error) toast.error(st.error);
  };

  const onExport = async () => {
    if (!exportFn) return;
    setBusyExport(true);
    try {
      await exportFn();
      toast.success(`Saved ${cityFilename(placeName)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusyExport(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-4">
          <section className="relative">
            <Label htmlFor="place-search">Place</Label>
            <form
              className="mt-1.5 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void runSearch();
              }}
            >
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
                <Input
                  id="place-search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search a district"
                  className="pl-9"
                  autoComplete="off"
                />
              </div>
              <Button type="submit" variant="secondary" disabled={searching || searchQuery.trim().length < 2}>
                {searching ? <LoaderCircle className="animate-spin" /> : "Go"}
              </Button>
            </form>
            {searchResults.length > 0 && (
              <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-border bg-bg py-1 shadow-sm">
                {searchResults.map((hit) => (
                  <li key={`${hit.lat}-${hit.lon}-${hit.label}`}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm text-fg hover:bg-surface-2"
                      onClick={() => applyPlace(hit)}
                    >
                      {hit.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <Label>Bounding box</Label>
              <Badge>{currentSpanLabel(bbox)}</Badge>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="box-size">Box size</Label>
                <span className="font-mono text-xs tabular-nums text-muted">
                  {boxSizeM < 1000 ? `${boxSizeM} m` : `${(boxSizeM / 1000).toFixed(2)} km`}
                </span>
              </div>
              <input
                id="box-size"
                type="range"
                min={100}
                max={10000}
                step={50}
                value={Math.min(10000, Math.max(100, boxSizeM))}
                onChange={(e) => setBoxSizeM(Number(e.target.value))}
                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-accent"
              />
              <div className="flex justify-between text-[10px] text-subtle">
                <span>100 m</span>
                <span>10 km</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <CoordField
                label="Min lon"
                value={bbox.minLon}
                onChange={(minLon) => setBbox({ ...bbox, minLon })}
              />
              <CoordField
                label="Min lat"
                value={bbox.minLat}
                onChange={(minLat) => setBbox({ ...bbox, minLat })}
              />
              <CoordField
                label="Max lon"
                value={bbox.maxLon}
                onChange={(maxLon) => setBbox({ ...bbox, maxLon })}
              />
              <CoordField
                label="Max lat"
                value={bbox.maxLat}
                onChange={(maxLat) => setBbox({ ...bbox, maxLat })}
              />
            </div>
            {warn && <p className="text-xs text-danger">{warn}</p>}
            <p className="text-[11px] text-subtle">Pan the map to move the box. Use the slider to resize it.</p>
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <Label>Layers in the model</Label>
            <RowSwitch label="Roads" checked={includeRoads} onCheckedChange={setIncludeRoads} />
            <RowSwitch
              label="Water, ports & coastline"
              checked={includeWater}
              onCheckedChange={setIncludeWater}
            />
          </section>

          {status === "ready" && stats && (
            <>
              <Separator />
              <section className="flex flex-col gap-3">
                <Label>Scene</Label>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 font-mono text-xs tabular-nums text-fg">
                  <dt className="text-muted">Buildings</dt>
                  <dd className="text-right">{stats.buildings.toLocaleString()}</dd>
                  <dt className="text-muted">Roads</dt>
                  <dd className="text-right">{stats.roads.toLocaleString()}</dd>
                  <dt className="text-muted">Water</dt>
                  <dd className="text-right">{stats.water.toLocaleString()}</dd>
                  <dt className="text-muted">Ports & coast</dt>
                  <dd className="text-right">{stats.ports.toLocaleString()}</dd>
                  <dt className="text-muted">Trees</dt>
                  <dd className="text-right">{(stats.trees ?? 0).toLocaleString()}</dd>
                  <dt className="text-muted">Vertices</dt>
                  <dd className="text-right">{stats.vertices.toLocaleString()}</dd>
                </dl>
                <div className="grid grid-cols-2 gap-2">
                  <RowSwitch
                    label="Buildings"
                    checked={layers.buildings}
                    onCheckedChange={(on) => setLayers({ buildings: on })}
                  />
                  <RowSwitch
                    label="Roads"
                    checked={layers.roads}
                    onCheckedChange={(on) => setLayers({ roads: on })}
                  />
                  <RowSwitch
                    label="Water"
                    checked={layers.water}
                    onCheckedChange={(on) => setLayers({ water: on })}
                  />
                  <RowSwitch
                    label="Terrain"
                    checked={layers.terrain}
                    onCheckedChange={(on) => setLayers({ terrain: on })}
                  />
                  <RowSwitch
                    label="Trees"
                    checked={layers.trees}
                    onCheckedChange={(on) => setLayers({ trees: on })}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="tree-density">Trees density</Label>
                    <span className="font-mono text-xs tabular-nums text-muted">
                      {treeDensity === 0
                        ? "off"
                        : `${Math.round(treeDensity * 1e6)} /km²`}
                    </span>
                  </div>
                  <input
                    id="tree-density"
                    type="range"
                    min={0}
                    max={2000}
                    step={10}
                    value={Math.round(treeDensity * 1e6)}
                    onChange={(e) => setTreeDensity(Number(e.target.value) / 1e6)}
                    className="h-2 w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-accent"
                  />
                  <div className="flex justify-between text-[10px] text-subtle">
                    <span>None</span>
                    <span>2000 /km²</span>
                  </div>
                </div>
                <RowSwitch label="Auto-rotate" checked={autoRotate} onCheckedChange={setAutoRotate} />
                <RowSwitch
                  label="Land cover material"
                  checked={landCover}
                  onCheckedChange={(on) => {
                    setLandCover(on);
                    if (on) setSatellite(false);
                  }}
                />
                <p className="text-[10px] leading-snug text-subtle">
                  ESA WorldCover 10m · no API key · classifies ground as tree cover, grassland,
                  cropland, built-up, water, etc. — also keeps trees off built-up/water pixels.
                  Takes priority over satellite terrain.
                </p>
                <RowSwitch
                  label="Satellite terrain"
                  checked={satellite}
                  onCheckedChange={(on) => {
                    setSatellite(on);
                    if (on) setLandCover(false);
                  }}
                />
                <p className="text-[10px] leading-snug text-subtle">
                  Esri World Imagery · no API key · remeshes the scene
                </p>
              </section>
            </>
          )}
        </div>
      </ScrollArea>

      <div className="border-t border-border p-4">
        {error && status === "error" && (
          <p className="mb-3 text-xs text-danger">{error}</p>
        )}
        <div className="flex flex-col gap-2">
          <Button type="button" size="lg" className="w-full" disabled={busy || Boolean(warn)} onClick={() => void onGenerate()}>
            {busy ? (
              <>
                <LoaderCircle className="animate-spin" />
                {status === "fetching" ? "Fetching Overture Maps" : "Extruding city"}
              </>
            ) : (
              <>
                <MapPinned />
                Generate city
              </>
            )}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setView(view === "map" ? "model" : "map")}
              disabled={view === "model" ? false : status !== "ready" && status !== "meshing"}
            >
              <RotateCw />
              {view === "map" ? "3D view" : "Map"}
            </Button>
            <Button type="button" variant="secondary" disabled={!exportFn || busyExport} onClick={() => void onExport()}>
              {busyExport ? <LoaderCircle className="animate-spin" /> : <Download />}
              GLB
            </Button>
          </div>
          <p className="text-[11px] leading-snug text-subtle">
            {placeName} · {formatSpan(width)} × {formatSpan(depth)} · Overture Maps
          </p>
        </div>
      </div>
    </div>
  );
}

function RowSwitch({
  label,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", disabled && "opacity-50")}>
      <Label className="text-sm font-normal text-fg">{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

function CoordField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <Input
        className="h-9 font-mono text-xs tabular-nums"
        defaultValue={value.toFixed(5)}
        key={value.toFixed(5)}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </div>
  );
}
