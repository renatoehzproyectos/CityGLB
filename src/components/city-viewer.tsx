import type { RealisticOptions } from "@/lib/city/build-scene";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CityData, CityStats } from "@/lib/city/types";
import { bboxSizeMeters } from "@/lib/city/geo";
import { cityFilename } from "@/lib/city/filename";
import {
  createVehicleController,
  updateFollowCamera,
  EMPTY_INPUT,
  type PlayMode,
  type VehicleController,
  type VehicleInput,
} from "@/lib/city/vehicle";
import { VehicleHud } from "@/components/vehicle-hud";
import { cn } from "@/lib/utils";
import { useStudio } from "@/store/studio";

type Layers = {
  buildings: boolean;
  terrain: boolean;
  water: boolean;
  vegetation: boolean;
};

type Props = {
  city: CityData | null;
  layers: Layers;
  satellite?: boolean;
  realistic?: RealisticOptions;
  onReady: (stats: CityStats) => void;
  onError: (message: string) => void;
  onExportReady: (exportFn: (() => Promise<void>) | null) => void;
  className?: string;
};

export function CityViewer({
  city,
  layers,
  satellite = false,
  realistic,
  onReady,
  onError,
  onExportReady,
  className,
}: Props) {
  const realisticRef = useRef(realistic);
  realisticRef.current = realistic;
  const realisticKey = realistic ? JSON.stringify(realistic) : "";
  const setMeshProgress = useStudio((s) => s.setMeshProgress);
  const hostRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef(layers);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onExportReadyRef = useRef(onExportReady);
  layersRef.current = layers;
  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  onExportReadyRef.current = onExportReady;

  const applyLayersRef = useRef<((l: Layers) => void) | null>(null);


  useEffect(() => {
    applyLayersRef.current?.(layers);
  }, [layers]);

  // Play mode lives outside the mesh-rebuild effect so switching car/plane
  // does not recreate the WebGL context.
  const [playMode, setPlayMode] = useState<PlayMode>("orbit");
  const [phase, setPhase] = useState<"pick" | "drive">("pick");
  const playModeRef = useRef<PlayMode>("orbit");
  const phaseRef = useRef<"pick" | "drive">("pick");
  const inputRef = useRef<VehicleInput>({ ...EMPTY_INPUT });
  const vehicleRef = useRef<VehicleController | null>(null);
  const sceneApiRef = useRef<{
    THREE: typeof import("three");
    scene: import("three").Scene;
    camera: import("three").PerspectiveCamera;
    orbit: import("three/addons/controls/OrbitControls.js").OrbitControls;
    renderer: import("three").WebGLRenderer;
    city: CityData;
    heightGrid: import("@/lib/city/elevation").HeightGrid | null | undefined;
    spawnMarker: import("three").Mesh | null;
  } | null>(null);

  playModeRef.current = playMode;
  phaseRef.current = phase;

  const handleMode = useCallback((m: PlayMode) => {
    setPlayMode(m);
    playModeRef.current = m;
    if (m === "orbit") {
      setPhase("pick");
      phaseRef.current = "pick";
      vehicleRef.current?.dispose();
      vehicleRef.current = null;
      const api = sceneApiRef.current;
      if (api) {
        api.orbit.enabled = true;
        if (api.spawnMarker) api.spawnMarker.visible = false;
      }
    } else {
      setPhase("pick");
      phaseRef.current = "pick";
      vehicleRef.current?.dispose();
      vehicleRef.current = null;
      const api = sceneApiRef.current;
      if (api) {
        api.orbit.enabled = true; // still orbit until spawn picked
        if (api.spawnMarker) api.spawnMarker.visible = true;
      }
    }
    inputRef.current = { ...EMPTY_INPUT };
  }, []);

  const handleInput = useCallback((input: VehicleInput) => {
    inputRef.current = input;
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !city) {
      onExportReadyRef.current(null);
      return;
    }

    let dead = false;
    let cleanup = () => {};

    (async () => {
      const THREE = await import("three");
      const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
      const { buildCityMeshes, disposeCityMeshes } = await import("@/lib/city/build-scene");
      const { exportGroupToGlb, downloadBuffer } = await import("@/lib/city/export-glb");
      if (dead || !hostRef.current) return;

      await new Promise((r) => setTimeout(r, 50));
      if (dead || !hostRef.current) return;

      const scene = new THREE.Scene();

      // Sky gradient (horizon haze → zenith blue) instead of a flat void, plus
      // matching fog color so distant geometry fades into the same atmosphere
      // rather than a black wall. Built once as a small vertical canvas.
      const skyCanvas = document.createElement("canvas");
      skyCanvas.width = 2;
      skyCanvas.height = 128;
      const skyCtx = skyCanvas.getContext("2d")!;
      const grad = skyCtx.createLinearGradient(0, 0, 0, 128);
      grad.addColorStop(0, "#3d6fb0"); // zenith
      grad.addColorStop(0.55, "#a8c7e0"); // mid sky
      grad.addColorStop(0.82, "#dbe8ee"); // haze near horizon
      grad.addColorStop(1, "#eef3f2"); // horizon
      skyCtx.fillStyle = grad;
      skyCtx.fillRect(0, 0, 2, 128);
      const atmosphere = Boolean(realisticRef.current?.atmosphere);
      let skyTex: import("three").Texture;
      if (atmosphere) {
        const { createSkyTexture } = await import("@/lib/city/sky");
        skyTex = createSkyTexture();
      } else {
        skyTex = new THREE.CanvasTexture(skyCanvas);
        skyTex.colorSpace = THREE.SRGBColorSpace;
      }
      const skyGeo = new THREE.SphereGeometry(6000, 24, 16);
      const skyMat = new THREE.MeshBasicMaterial({
        map: skyTex,
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
      });
      const skyMesh = new THREE.Mesh(skyGeo, skyMat);
      skyMesh.name = "sky";
      skyMesh.renderOrder = -10;
      scene.add(skyMesh);
      scene.background = new THREE.Color(0xdbe8ee);
      scene.fog = atmosphere ? new THREE.Fog(0xe2d8c6, 700, 6000) : new THREE.Fog(0xd7e6ea, 500, 3200);
      if (atmosphere) scene.background = new THREE.Color(0xe2d8c6);

      const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 8000);
      const { width, depth } = bboxSizeMeters(city.bbox);
      const span = Math.max(width, depth, 80);
      camera.position.set(span * 0.55, span * 0.42, span * 0.7);

      const isMobile = host.clientWidth < 500 || /Android|iPhone|iPad/i.test(navigator.userAgent);
      const tryCreateRenderer = (opts: ConstructorParameters<typeof THREE.WebGLRenderer>[0]) => {
        try {
          const r = new THREE.WebGLRenderer(opts);
          if (!r.getContext()) {
            r.dispose();
            return null;
          }
          return r;
        } catch {
          return null;
        }
      };
      let renderer =
        tryCreateRenderer({
          antialias: !isMobile,
          alpha: false,
          powerPreference: isMobile ? "low-power" : "high-performance",
          failIfMajorPerformanceCaveat: false,
        }) ??
        tryCreateRenderer({
          antialias: false,
          alpha: false,
          powerPreference: "low-power",
          failIfMajorPerformanceCaveat: false,
        });
      if (!renderer) {
        onErrorRef.current(
          "WebGL failed to start (GPU context limit). Try a smaller area, turn off satellite, or reload the page.",
        );
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.25 : 2));
      renderer.setSize(host.clientWidth, host.clientHeight);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.shadowMap.enabled = !isMobile || atmosphere;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      host.appendChild(renderer.domElement);
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.touchAction = "none";
      renderer.domElement.style.userSelect = "none";
      renderer.domElement.style.setProperty("-webkit-user-select", "none");
      renderer.domElement.style.setProperty("-webkit-touch-callout", "none");
      renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

      const hemi = atmosphere
        ? new THREE.HemisphereLight(0xb9d0e8, 0x7a6552, 0.8)
        : new THREE.HemisphereLight(0xcfe0ee, 0x3a342c, 0.9);
      scene.add(hemi);
      const dir = atmosphere
        ? new THREE.DirectionalLight(0xffe0b8, 2.1)
        : new THREE.DirectionalLight(0xfff1e0, 1.35);
      // Sol cálido y bajo (~30°) para sombras largas, como en el reel.
      if (atmosphere) dir.position.set(span * 0.75, span * 0.5, span * 0.35);
      else dir.position.set(span * 0.4, span * 0.9, span * 0.25);
      dir.target.position.set(0, 0, 0);
      scene.add(dir);
      scene.add(dir.target);
      if (renderer.shadowMap.enabled) {
        dir.castShadow = true;
        dir.shadow.mapSize.set(isMobile ? 1024 : 2048, isMobile ? 1024 : 2048);
        const shadowSpan = Math.min(span * 0.8, 1400);
        dir.shadow.camera.left = -shadowSpan;
        dir.shadow.camera.right = shadowSpan;
        dir.shadow.camera.top = shadowSpan;
        dir.shadow.camera.bottom = -shadowSpan;
        dir.shadow.camera.near = span * 0.05;
        dir.shadow.camera.far = span * 2.2;
        dir.shadow.bias = -0.0006;
        dir.shadow.normalBias = 0.4;
      }
      // Stronger ambient so satellite albedo stays readable from above
      // (ACES tone-mapping otherwise crushes photo textures into mud).
      scene.add(new THREE.AmbientLight(0xffffff, satellite ? 0.35 : 0.22));
      if (satellite) {
        renderer.toneMappingExposure = 1.2;
      }

      let meshes: Awaited<ReturnType<typeof buildCityMeshes>>;
      try {
        meshes = await buildCityMeshes(city, {
          satellite,
          realistic: realisticRef.current,
          onProgress: (fraction, label) => setMeshProgress(fraction, label),
        });
      } catch (err) {
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        onErrorRef.current(err instanceof Error ? err.message : "Mesh build failed.");
        return;
      }
      scene.add(meshes.group);
      // El agua refleja el cielo real de la escena y el sol
      meshes.configureWater?.({ sun: dir.position.clone().normalize(), sky: skyTex, atmosphere });

      const applyLayers = (l: Layers) => {
        for (const m of meshes.buildings) m.visible = l.buildings;
        if (meshes.water) meshes.water.visible = l.water;
        if (meshes.trees) meshes.trees.visible = l.vegetation;
        if (meshes.grass) meshes.grass.visible = l.vegetation;
        if (meshes.roofs) meshes.roofs.visible = l.buildings;
        meshes.terrain.visible = l.terrain;
      };
      applyLayers(layersRef.current);
      applyLayersRef.current = applyLayers;

      const orbit = new OrbitControls(camera, renderer.domElement);
      orbit.enableDamping = true;
      orbit.dampingFactor = 0.08;
      orbit.target.set(0, 8, 0);
      orbit.maxPolarAngle = Math.PI * 0.49;
      orbit.minDistance = 20;
      orbit.maxDistance = span * 4;
      orbit.autoRotate = false;

      // Spawn marker (visible in pick phase)
      const markerGeo = new THREE.SphereGeometry(1.2, 12, 12);
      const markerMat = new THREE.MeshStandardMaterial({
        color: 0xffcc33,
        emissive: 0xaa6600,
        emissiveIntensity: 0.4,
      });
      const spawnMarker = new THREE.Mesh(markerGeo, markerMat);
      spawnMarker.visible = false;
      spawnMarker.position.set(0, 2, 0);
      scene.add(spawnMarker);

      sceneApiRef.current = {
        THREE,
        scene,
        camera,
        orbit,
        renderer,
        city,
        heightGrid: meshes.heightGrid,
        spawnMarker,
      };

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();

      const pickSpawn = (clientX: number, clientY: number) => {
        if (playModeRef.current === "orbit" || phaseRef.current !== "pick") return;
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObject(meshes.terrain, false);
        if (!hits.length) return;
        const p = hits[0].point;
        spawnMarker.position.set(p.x, p.y + 1.5, p.z);
        spawnMarker.visible = true;

        // Start vehicle
        vehicleRef.current?.dispose();
        const mode = playModeRef.current as "car" | "plane";
        const vehicle = createVehicleController(mode, city, meshes.heightGrid, scene, meshes.deckAt);
        const y = mode === "car" ? p.y + 0.5 : p.y + 12;
        vehicle.spawnAt(p.x, y, p.z, 0);
        vehicleRef.current = vehicle;
        spawnMarker.visible = false;
        orbit.enabled = false;
        setPhase("drive");
        phaseRef.current = "drive";
        inputRef.current = { ...EMPTY_INPUT };
      };

      const onPointerUp = (e: PointerEvent) => {
        // Ignore UI taps (HUD is outside canvas, but safety: only canvas)
        if (e.target !== renderer.domElement) return;
        if (playModeRef.current === "orbit") return;
        if (phaseRef.current === "pick") {
          pickSpawn(e.clientX, e.clientY);
        }
      };
      renderer.domElement.addEventListener("pointerup", onPointerUp);

      const onResize = () => {
        if (!hostRef.current) return;
        const w = hostRef.current.clientWidth;
        const h = hostRef.current.clientHeight;
        camera.aspect = w / Math.max(h, 1);
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      onResize();
      const ro = new ResizeObserver(onResize);
      ro.observe(host);

      const timer = new THREE.Timer();
      timer.connect(document);
      let raf = 0;
      let last = performance.now();
      const loop = () => {
        if (dead) return;
        raf = requestAnimationFrame(loop);
        timer.update();
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;

        const mode = playModeRef.current;
        if (mode !== "orbit" && phaseRef.current === "drive" && vehicleRef.current) {
          vehicleRef.current.update(dt, inputRef.current);
          updateFollowCamera(camera, vehicleRef.current.group, mode, dt);
        } else {
          orbit.update();
        }
        meshes.update?.(timer.getElapsed());
        renderer.render(scene, camera);
      };
      loop();

      if (dead) {
        cancelAnimationFrame(raf);
        ro.disconnect();
        timer.dispose();
        orbit.dispose();
        vehicleRef.current?.dispose();
        skyGeo.dispose();
        skyMat.dispose();
        skyTex.dispose();
        disposeCityMeshes(meshes);
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        return;
      }

      onReadyRef.current(meshes.stats);
      const group = meshes.group;
      const filename = cityFilename(city.placeName);
      onExportReadyRef.current(async () => {
        const buf = await exportGroupToGlb(group);
        downloadBuffer(buf, filename);
      });

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        timer.dispose();
        orbit.dispose();
        renderer.domElement.removeEventListener("pointerup", onPointerUp);
        vehicleRef.current?.dispose();
        vehicleRef.current = null;
        sceneApiRef.current = null;
        applyLayersRef.current = null;
        markerGeo.dispose();
        markerMat.dispose();
        skyGeo.dispose();
        skyMat.dispose();
        skyTex.dispose();
        disposeCityMeshes(meshes);
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      };
    })().catch((err) => {
      if (!dead) onErrorRef.current(err instanceof Error ? err.message : "Viewer failed to start.");
    });

    return () => {
      dead = true;
      onExportReadyRef.current(null);
      cleanup();
    };
  }, [city, satellite, realisticKey]);

  if (!city) {
    return (
      <div className={cn("flex h-full items-center justify-center bg-map text-sm text-muted", className)}>
        Generate a city to inspect the model.
      </div>
    );
  }

  return (
    <div
      className={cn("no-touch-callout relative h-full min-h-0 w-full bg-map", className)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={hostRef} className="absolute inset-0" />
      <VehicleHud mode={playMode} phase={phase} onMode={handleMode} onInput={handleInput} />
    </div>
  );
}
