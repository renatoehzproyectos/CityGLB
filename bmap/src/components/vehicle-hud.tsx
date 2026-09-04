import { useCallback, useRef } from "react";
import type { PlayMode, VehicleInput } from "@/lib/city/vehicle";
import { EMPTY_INPUT } from "@/lib/city/vehicle";
import { cn } from "@/lib/utils";

type Props = {
  mode: PlayMode;
  phase: "pick" | "drive";
  onMode: (m: PlayMode) => void;
  onInput: (input: VehicleInput) => void;
  className?: string;
};

/**
 * Mobile-first on-screen controls.
 * Car: D-pad + throttle/brake pedals.
 * Plane: left joystick (yaw/pitch) + throttle slider.
 */
export function VehicleHud({ mode, phase, onMode, onInput, className }: Props) {
  const inputRef = useRef<VehicleInput>({ ...EMPTY_INPUT });
  const emit = useCallback(() => onInput({ ...inputRef.current }), [onInput]);

  const setSteer = (v: number) => {
    inputRef.current.steer = v;
    emit();
  };
  const setThrottle = (v: number) => {
    inputRef.current.throttle = v;
    emit();
  };
  const setBrake = (on: boolean) => {
    inputRef.current.brake = on;
    emit();
  };
  const setPitch = (v: number) => {
    inputRef.current.pitch = v;
    emit();
  };

  return (
    <div
      className={cn("no-touch-callout pointer-events-none absolute inset-0 z-20", className)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Mode switch */}
      <div className="pointer-events-auto absolute left-2 top-2 flex gap-1 rounded-lg border border-border bg-surface/95 p-1 text-xs shadow-md">
        {(
          [
            ["orbit", "Look"],
            ["car", "Car"],
            ["plane", "Plane"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={cn(
              "rounded-md px-3 py-1.5 font-medium transition",
              mode === id ? "bg-accent text-bg" : "text-fg hover:bg-surface-2",
            )}
            onClick={() => onMode(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {mode !== "orbit" && phase === "pick" && (
        <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center px-4">
          <p className="rounded-lg border border-border bg-surface/95 px-3 py-2 text-center text-sm text-fg shadow">
            Tap the map to set your start point
          </p>
        </div>
      )}

      {mode === "car" && phase === "drive" && (
        <>
          {/* D-pad */}
          <div className="pointer-events-auto absolute bottom-6 left-3 grid grid-cols-3 gap-1">
            <span />
            <Pad onHold={(on) => setThrottle(on ? 1 : 0)} label="▲" />
            <span />
            <Pad onHold={(on) => setSteer(on ? -1 : 0)} label="◀" />
            <Pad onHold={(on) => setThrottle(on ? -0.7 : 0)} label="▼" />
            <Pad onHold={(on) => setSteer(on ? 1 : 0)} label="▶" />
          </div>
          {/* Pedals */}
          <div className="pointer-events-auto absolute bottom-6 right-3 flex flex-col gap-2">
            <Pad
              className="h-16 w-20 bg-emerald-700/90"
              onHold={(on) => setThrottle(on ? 1 : 0)}
              label="Gas"
            />
            <Pad
              className="h-14 w-20 bg-rose-800/90"
              onHold={(on) => setBrake(on)}
              label="Brake"
            />
          </div>
        </>
      )}

      {mode === "plane" && phase === "drive" && (
        <>
          <Joystick
            className="pointer-events-auto absolute bottom-8 left-4"
            onMove={(x, y) => {
              inputRef.current.steer = x;
              inputRef.current.pitch = -y;
              emit();
            }}
          />
          <div className="pointer-events-auto absolute bottom-8 right-4 flex h-36 w-12 flex-col items-center gap-1">
            <span className="text-[10px] text-muted">Throttle</span>
            <input
              type="range"
              min={0}
              max={100}
              defaultValue={40}
              className="h-28 w-8 cursor-pointer appearance-none rounded-full bg-surface-2 accent-accent"
              style={{ writingMode: "vertical-lr", direction: "rtl" }}
              onChange={(e) => setThrottle(Number(e.target.value) / 100)}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Pad({
  label,
  onHold,
  className,
}: {
  label: string;
  onHold: (pressed: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-12 w-12 touch-none select-none items-center justify-center rounded-xl border border-border bg-surface/90 text-sm font-semibold text-fg shadow active:bg-accent active:text-bg",
        className,
      )}
      style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none", touchAction: "none" }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        onHold(true);
      }}
      onPointerUp={(e) => {
        e.preventDefault();
        onHold(false);
      }}
      onPointerCancel={() => onHold(false)}
      onLostPointerCapture={() => onHold(false)}
    >
      {label}
    </button>
  );
}

function Joystick({
  onMove,
  className,
}: {
  onMove: (x: number, y: number) => void;
  className?: string;
}) {
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const active = useRef(false);

  const handle = (clientX: number, clientY: number) => {
    const el = baseRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const max = rect.width * 0.38;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const len = Math.hypot(dx, dy) || 1;
    if (len > max) {
      dx = (dx / len) * max;
      dy = (dy / len) * max;
    }
    if (knobRef.current) {
      knobRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    onMove(dx / max, dy / max);
  };

  const end = () => {
    active.current = false;
    if (knobRef.current) knobRef.current.style.transform = "translate(0,0)";
    onMove(0, 0);
  };

  return (
    <div
      ref={baseRef}
      className={cn(
        "relative h-28 w-28 touch-none select-none rounded-full border border-border bg-surface/80 shadow-inner",
        className,
      )}
      style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none", touchAction: "none" }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        active.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        handle(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (!active.current) return;
        e.preventDefault();
        handle(e.clientX, e.clientY);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
    >
      <div
        ref={knobRef}
        className="absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/90 shadow transition-transform"
      />
    </div>
  );
}
