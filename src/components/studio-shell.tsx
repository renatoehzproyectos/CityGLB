import { useEffect, useState } from "react";
import { CityViewer } from "@/components/city-viewer";
import { ControlPanel } from "@/components/control-panel";
import { MapPicker } from "@/components/map-picker";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useStudio } from "@/store/studio";

export function StudioShell() {
  const bbox = useStudio((s) => s.bbox);
  const boxSizeM = useStudio((s) => s.boxSizeM);
  const focusSerial = useStudio((s) => s.focusSerial);
  const setBbox = useStudio((s) => s.setBbox);
  const view = useStudio((s) => s.view);
  const city = useStudio((s) => s.city);
  const status = useStudio((s) => s.status);
  const autoRotate = useStudio((s) => s.autoRotate);
  const layers = useStudio((s) => s.layers);
  const treeDensity = useStudio((s) => s.treeDensity);
  const satellite = useStudio((s) => s.satellite);
  const landCover = useStudio((s) => s.landCover);
  const progress = useStudio((s) => s.progress);
  const progressLabel = useStudio((s) => s.progressLabel);
  const setReady = useStudio((s) => s.setReady);
  const setMeshError = useStudio((s) => s.setMeshError);
  const [exportFn, setExportFn] = useState<(() => Promise<void>) | null>(null);

  const showModel = view === "model";
  const isLoading = status === "fetching" || status === "meshing";

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-dvh min-h-0 flex-col bg-bg text-fg">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Mark />
            <div className="min-w-0">
              <h1 className="font-display text-xl leading-tight tracking-tight text-fg">CityGLB</h1>
              <p className="hidden text-[11px] text-muted sm:block">Bounding box to a game-ready city model</p>
            </div>
          </div>
          <p className="hidden font-mono text-[11px] text-subtle md:block">Overture · GLB · Three.js</p>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="order-2 min-h-0 max-h-[46vh] border-t border-border lg:order-1 lg:max-h-none lg:border-r lg:border-t-0">
            <ControlPanel exportFn={exportFn} />
          </aside>

          <main className="relative order-1 min-h-0 min-w-0 lg:order-2">
            <div className={cn("absolute inset-0", showModel ? "pointer-events-none invisible" : "visible")}>
              <MapPicker
                bbox={bbox}
                boxSizeM={boxSizeM}
                focusSerial={focusSerial}
                onBbox={(b) => setBbox(b, "Custom area")}
              />
            </div>
            <div className={cn("absolute inset-0", showModel ? "visible" : "pointer-events-none invisible")}>
              <CityViewer
                city={city}
                autoRotate={autoRotate}
                layers={layers}
                treeDensity={treeDensity}
                satellite={satellite}
                landCover={landCover}
                onReady={setReady}
                onError={setMeshError}
                onExportReady={setExportFn}
              />
            </div>

            {isLoading && <LoadingOverlay progress={progress} label={progressLabel} status={status} />}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

function LoadingOverlay({
  progress,
  label,
  status,
}: {
  progress: number;
  label: string;
  status: string;
}) {
  // Smooth displayed percent so the bar never jumps backward and feels continuous.
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setDisplay((prev) => {
        const target = Math.max(0, Math.min(100, progress));
        // Ease toward target; never go backwards.
        if (target <= prev) return prev;
        const next = prev + Math.max(0.15, (target - prev) * 0.12);
        return next >= target ? target : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [progress]);

  const pct = Math.round(display);
  const stage =
    status === "fetching"
      ? "Downloading map data"
      : status === "meshing"
        ? "Building 3D city"
        : "Working";

  return (
    <div className="pointer-events-none absolute inset-0 z-[2000] flex items-center justify-center bg-bg/70 backdrop-blur-[2px]">
      <div className="pointer-events-auto w-[min(92vw,380px)] rounded-2xl border border-border bg-surface/95 p-6 shadow-2xl shadow-black/40">
        <div className="mb-4 flex items-center gap-3">
          <div className="relative size-10 shrink-0">
            <div className="absolute inset-0 rounded-full border-2 border-border" />
            <div
              className="absolute inset-0 rounded-full border-2 border-accent border-t-transparent animate-spin"
              style={{ animationDuration: "0.85s" }}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <MarkSmall />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-display text-base leading-tight text-fg">{stage}</p>
            <p className="mt-0.5 truncate text-xs text-muted">{label || "Preparing…"}</p>
          </div>
          <div className="shrink-0 font-mono text-2xl tabular-nums tracking-tight text-accent">
            {pct}
            <span className="text-sm text-muted">%</span>
          </div>
        </div>

        <div className="relative h-2.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent/80 to-accent transition-[width] duration-150 ease-out"
            style={{ width: `${display}%` }}
          />
          {/* Shimmer */}
          <div
            className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent"
            style={{
              left: `${Math.max(0, display - 18)}%`,
              opacity: display > 2 && display < 98 ? 1 : 0,
              transition: "left 0.2s linear, opacity 0.3s",
            }}
          />
        </div>

        <div className="mt-3 flex justify-between text-[10px] uppercase tracking-wider text-subtle">
          <span>{status === "fetching" ? "Network" : "GPU / mesh"}</span>
          <span className="font-mono tabular-nums">{pct < 100 ? "in progress" : "done"}</span>
        </div>
      </div>
    </div>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 28 28" className="size-8 shrink-0 text-accent" aria-hidden="true">
      <rect x="1" y="1" width="26" height="26" rx="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6" y="14" width="5" height="8" fill="currentColor" />
      <rect x="12" y="8" width="5" height="14" fill="currentColor" />
      <rect x="18" y="11" width="4" height="11" fill="currentColor" />
    </svg>
  );
}

function MarkSmall() {
  return (
    <svg viewBox="0 0 28 28" className="size-4 text-accent" aria-hidden="true">
      <rect x="6" y="14" width="5" height="8" fill="currentColor" />
      <rect x="12" y="8" width="5" height="14" fill="currentColor" />
      <rect x="18" y="11" width="4" height="11" fill="currentColor" />
    </svg>
  );
}
