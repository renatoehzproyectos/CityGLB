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
  const view = useStudio((s) => s.view);
  const status = useStudio((s) => s.status);
  const error = useStudio((s) => s.error);
  const stats = useStudio((s) => s.stats);
  const layers = useStudio((s) => s.layers);
  const satellite = useStudio((s) => s.satellite);
  const streetColors = useStudio((s) => s.streetColors);
  const setStreetColors = useStudio((s) => s.setStreetColors);
  const aiBuildings = useStudio((s) => s.aiBuildings);
  const setAiBuildings = useStudio((s) => s.setAiBuildings);
  const realistic = useStudio((s) => s.realistic);
  const setRealistic = useStudio((s) => s.setRealistic);
  const setRealisticMode = useStudio((s) => s.setRealisticMode);
  const searchQuery = useStudio((s) => s.searchQuery);
  const searchResults = useStudio((s) => s.searchResults);
  const searching = useStudio((s) => s.searching);
  const setView = useStudio((s) => s.setView);
  const setLayers = useStudio((s) => s.setLayers);
  const setSatellite = useStudio((s) => s.setSatellite);
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

          {status === "ready" && stats && (
            <>
              <Separator />
              <section className="flex flex-col gap-3">
                <Label>Scene</Label>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 font-mono text-xs tabular-nums text-fg">
                  <dt className="text-muted">Buildings</dt>
                  <dd className="text-right">{stats.buildings.toLocaleString()}</dd>
                  {(stats.aiBuildings ?? 0) > 0 && (
                    <>
                      <dt className="text-muted">AI-enriched</dt>
                      <dd className="text-right">{(stats.aiBuildings ?? 0).toLocaleString()}</dd>
                    </>
                  )}
                  {(stats.streetBuildings ?? 0) > 0 && (
                    <>
                      <dt className="text-muted">Street-photo colors</dt>
                      <dd className="text-right">{(stats.streetBuildings ?? 0).toLocaleString()}</dd>
                    </>
                  )}
                  {(stats.streetMaterials ?? 0) > 0 && (
                    <>
                      <dt className="text-muted">Street-photo materials</dt>
                      <dd className="text-right">{(stats.streetMaterials ?? 0).toLocaleString()}</dd>
                    </>
                  )}
                  {(stats.trees ?? 0) > 0 && (
                    <>
                      <dt className="text-muted">Trees</dt>
                      <dd className="text-right">{(stats.trees ?? 0).toLocaleString()}</dd>
                    </>
                  )}
                  {(stats.treeModels ?? 0) > 0 && (
                    <>
                      <dt className="text-muted">3D trees</dt>
                      <dd className="text-right">{(stats.treeModels ?? 0).toLocaleString()}</dd>
                    </>
                  )}
                  {(stats.bridges ?? 0) > 0 && (
                    <>
                      <dt className="text-muted">Bridges</dt>
                      <dd className="text-right">{(stats.bridges ?? 0).toLocaleString()}</dd>
                    </>
                  )}
                  {(stats.grassPatches ?? 0) > 0 && (
                    <>
                      <dt className="text-muted">Grass patches</dt>
                      <dd className="text-right">{(stats.grassPatches ?? 0).toLocaleString()}</dd>
                    </>
                  )}
                  {(stats.waterBodies ?? 0) > 0 && (
                    <>
                      <dt className="text-muted">Water bodies</dt>
                      <dd className="text-right">{(stats.waterBodies ?? 0).toLocaleString()}</dd>
                    </>
                  )}
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
                    label="Terrain"
                    checked={layers.terrain}
                    onCheckedChange={(on) => setLayers({ terrain: on })}
                  />
                  <RowSwitch
                    label="Water"
                    checked={layers.water}
                    onCheckedChange={(on) => setLayers({ water: on })}
                  />
                  <RowSwitch
                    label="Vegetation"
                    checked={layers.vegetation}
                    onCheckedChange={(on) => setLayers({ vegetation: on })}
                  />
                </div>
                <RowSwitch
                  label="Satellite terrain"
                  checked={satellite}
                  onCheckedChange={setSatellite}
                />
                <p className="text-[10px] leading-snug text-subtle">
                  Esri World Imagery · no API key · remeshes the scene
                </p>
                <RowSwitch
                  label="Fachadas reales (color y material, fotos de calle)"
                  checked={streetColors}
                  onCheckedChange={setStreetColors}
                />
                <p className="text-[10px] leading-snug text-subtle">
                  Toma el color de cada fachada de la foto de calle más cercana y, si existe facade-net.onnx en
                  /models, también su material. Requiere MAPILLARY_TOKEN en el servidor. Imágenes: Mapillary, CC BY-SA.
                </p>
                <RowSwitch
                  label="IA propia de edificios (altura, techo, material)"
                  checked={aiBuildings}
                  onCheckedChange={setAiBuildings}
                />
                <p className="text-[10px] leading-snug text-subtle">
                  Modelo entrenado por ustedes (ml/), ejecutado en el navegador sobre la imagen aérea. Solo
                  completa lo que los datos no traen. Requiere public/models/building-net.onnx · regenera la escena.
                </p>
                <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
                  <RowSwitch
                    label="Modo realista (satélite HD y cielo)"
                    checked={Object.values(realistic).every(Boolean)}
                    onCheckedChange={setRealisticMode}
                  />
                  <RowSwitch label="Cielo con nubes y luz cálida" checked={realistic.atmosphere} onCheckedChange={(on) => setRealistic({ atmosphere: on })} />
                  <RowSwitch label="Satélite HD (4096 px)" checked={realistic.hdSatellite} onCheckedChange={(on) => setRealistic({ hdSatellite: on })} />
                </div>
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
