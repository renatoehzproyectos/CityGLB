/**
 * Lightweight car / plane controller for exploring a generated city tile.
 * Soft collisions only — never "die", just bounce / slide.
 */

import * as THREE from "three";
import type { BuildingFeature, CityData } from "./types";
import type { HeightGrid } from "./elevation";
import { sampleHeight } from "./elevation";

export type PlayMode = "orbit" | "car" | "plane";

export type VehicleInput = {
  /** -1..1 steer / yaw */
  steer: number;
  /** -1..1 throttle (car) or forward thrust (plane) */
  throttle: number;
  /** plane pitch stick -1..1 (nose down / up) */
  pitch: number;
  /** plane roll stick -1..1 */
  roll: number;
  brake: boolean;
};

export const EMPTY_INPUT: VehicleInput = {
  steer: 0,
  throttle: 0,
  pitch: 0,
  roll: 0,
  brake: false,
};

type BuildingCircle = { x: number; z: number; r: number; h: number };

function buildingCircles(buildings: BuildingFeature[]): BuildingCircle[] {
  const out: BuildingCircle[] = [];
  for (const b of buildings) {
    if (!b.ring?.length) continue;
    let sx = 0;
    let sz = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of b.ring) {
      sx += x;
      sz += z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const n = b.ring.length;
    const cx = sx / n;
    const cz = sz / n;
    const r = Math.max(Math.hypot(maxX - minX, maxZ - minZ) * 0.45, 2);
    out.push({ x: cx, z: cz, r, h: Math.max(b.height || 8, 4) });
  }
  return out;
}

function groundY(grid: HeightGrid | null | undefined, x: number, z: number): number {
  if (!grid) return 0;
  // feature z → grid north = -z
  return sampleHeight(grid, x, -z);
}

export type VehicleController = {
  mode: PlayMode;
  group: THREE.Group;
  /** Call each frame with dt in seconds */
  update: (dt: number, input: VehicleInput) => void;
  /** Place at world position (feature coords) */
  spawnAt: (x: number, y: number, z: number, yaw?: number) => void;
  getPosition: () => THREE.Vector3;
  dispose: () => void;
};

function makeCarMesh(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 0.7, 4.2),
    new THREE.MeshStandardMaterial({ color: 0xe8a317, roughness: 0.55, metalness: 0.15 }),
  );
  body.position.y = 0.55;
  g.add(body);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 0.55, 2.2),
    new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.4, metalness: 0.2 }),
  );
  cabin.position.set(0, 1.05, -0.2);
  g.add(cabin);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 });
  for (const [x, z] of [
    [-0.95, 1.3],
    [0.95, 1.3],
    [-0.95, -1.3],
    [0.95, -1.3],
  ] as const) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.28, 10), wheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.35, z);
    g.add(w);
  }
  return g;
}

function makePlaneMesh(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x6ec8ff, roughness: 0.45, metalness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1e2936, roughness: 0.5 });
  const fuselage = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 5.5), mat);
  fuselage.position.y = 0.2;
  g.add(fuselage);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(8, 0.12, 1.4), mat);
  wing.position.set(0, 0.25, 0.3);
  g.add(wing);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.2, 0.9), mat);
  tail.position.set(0, 0.8, -2.4);
  g.add(tail);
  const stab = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.1, 0.7), mat);
  stab.position.set(0, 0.5, -2.4);
  g.add(stab);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.8), dark);
  nose.position.set(0, 0.15, 2.8);
  g.add(nose);
  return g;
}

export function createVehicleController(
  mode: "car" | "plane",
  city: CityData,
  heightGrid: HeightGrid | null | undefined,
  scene: THREE.Scene,
): VehicleController {
  const group = mode === "car" ? makeCarMesh() : makePlaneMesh();
  group.name = mode === "car" ? "player-car" : "player-plane";
  scene.add(group);

  const circles = buildingCircles(city.buildings);
  const pos = new THREE.Vector3(0, 5, 0);
  let yaw = 0;
  let pitch = 0;
  let speed = 0;
  let vy = 0;

  const CAR = {
    accel: 18,
    brake: 28,
    maxSpeed: 32,
    reverseMax: 10,
    turnRate: 1.8,
    drag: 0.6,
    radius: 1.6,
  };
  const PLANE = {
    thrust: 22,
    maxSpeed: 55,
    drag: 0.35,
    turnRate: 1.4,
    pitchRate: 1.1,
    gravity: 9,
    lift: 11,
    radius: 2.2,
  };

  function collideBuildings(px: number, pz: number, radius: number, maxHitY: number): { x: number; z: number } {
    let x = px;
    let z = pz;
    for (const c of circles) {
      if (maxHitY > c.h + 1.5) continue; // fly over short buildings
      const dx = x - c.x;
      const dz = z - c.z;
      const dist = Math.hypot(dx, dz);
      const minD = c.r + radius;
      if (dist < minD && dist > 1e-4) {
        const push = (minD - dist) / dist;
        x += dx * push;
        z += dz * push;
        // kill lateral speed a bit via caller reading position snap
      } else if (dist < minD) {
        x += minD;
      }
    }
    // Soft world bounds from city extent
    const { minX, maxX, minZ, maxZ } = city.extent;
    const pad = 8;
    x = Math.min(maxX - pad, Math.max(minX + pad, x));
    z = Math.min(maxZ - pad, Math.max(minZ + pad, z));
    return { x, z };
  }

  function updateCar(dt: number, input: VehicleInput) {
    const throttle = input.brake ? -Math.abs(input.throttle) || -0.6 : input.throttle;
    if (throttle > 0.05) speed += CAR.accel * throttle * dt;
    else if (throttle < -0.05) speed += CAR.accel * throttle * dt;
    else speed *= Math.max(0, 1 - CAR.drag * dt);

    if (input.brake) speed *= Math.max(0, 1 - CAR.brake * 0.04 * dt * 60);

    speed = Math.max(-CAR.reverseMax, Math.min(CAR.maxSpeed, speed));

    const turnScale = Math.min(1, Math.abs(speed) / 6);
    yaw -= input.steer * CAR.turnRate * turnScale * Math.sign(speed || 1) * dt;

    pos.x += Math.sin(yaw) * speed * dt;
    pos.z += Math.cos(yaw) * speed * dt;

    const ground = groundY(heightGrid, pos.x, pos.z);
    pos.y = ground + 0.4;

    const before = pos.clone();
    const hit = collideBuildings(pos.x, pos.z, CAR.radius, pos.y + 1);
    if (hit.x !== pos.x || hit.z !== pos.z) {
      pos.x = hit.x;
      pos.z = hit.z;
      speed *= 0.35; // soft bump
      // tiny bounce away
      pos.x += (pos.x - before.x) * 0.5;
      pos.z += (pos.z - before.z) * 0.5;
    }

    group.position.set(pos.x, pos.y, pos.z);
    group.rotation.set(0, yaw, 0);
  }

  function updatePlane(dt: number, input: VehicleInput) {
    speed += input.throttle * PLANE.thrust * dt;
    speed *= Math.max(0, 1 - PLANE.drag * dt);
    speed = Math.max(4, Math.min(PLANE.maxSpeed, speed)); // always some airspeed

    yaw -= input.steer * PLANE.turnRate * dt;
    pitch += input.pitch * PLANE.pitchRate * dt;
    pitch = Math.max(-0.85, Math.min(0.85, pitch));

    const forwardX = Math.sin(yaw) * Math.cos(pitch);
    const forwardY = Math.sin(pitch);
    const forwardZ = Math.cos(yaw) * Math.cos(pitch);

    pos.x += forwardX * speed * dt;
    pos.y += forwardY * speed * dt;
    pos.z += forwardZ * speed * dt;

    // Gravity vs crude lift from speed
    const lift = Math.min(1.2, speed / 30) * PLANE.lift;
    vy += (lift - PLANE.gravity) * dt;
    vy *= 0.98;
    pos.y += vy * dt;

    const ground = groundY(heightGrid, pos.x, pos.z) + 1.2;
    if (pos.y < ground) {
      pos.y = ground;
      if (vy < 0) vy = -vy * 0.35; // bounce, never die
      speed *= 0.85;
      pitch = Math.max(pitch, 0.05);
    }

    // Ceiling
    if (pos.y > ground + 220) {
      pos.y = ground + 220;
      vy = Math.min(0, vy);
    }

    const hit = collideBuildings(pos.x, pos.z, PLANE.radius, pos.y);
    if (Math.hypot(hit.x - pos.x, hit.z - pos.z) > 0.01) {
      pos.x = hit.x;
      pos.z = hit.z;
      speed *= 0.5;
      vy = Math.max(vy, 2); // bounce up a bit
    }

    group.position.set(pos.x, pos.y, pos.z);
    group.rotation.set(pitch * 0.85, yaw, -input.steer * 0.45);
  }

  return {
    mode,
    group,
    update(dt, input) {
      const d = Math.min(dt, 0.05);
      if (mode === "car") updateCar(d, input);
      else updatePlane(d, input);
    },
    spawnAt(x, y, z, y0 = 0) {
      pos.set(x, y, z);
      yaw = y0;
      pitch = 0;
      speed = 0;
      vy = 0;
      group.position.copy(pos);
      group.rotation.set(0, yaw, 0);
    },
    getPosition: () => pos.clone(),
    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          const mat = m.material;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else (mat as THREE.Material)?.dispose();
        }
      });
    },
  };
}

/** Follow camera behind vehicle */
export function updateFollowCamera(
  camera: THREE.PerspectiveCamera,
  vehicle: THREE.Object3D,
  mode: "car" | "plane",
  dt: number,
) {
  const behind = mode === "car" ? 12 : 18;
  const height = mode === "car" ? 5.5 : 7;
  const yaw = vehicle.rotation.y;
  const target = new THREE.Vector3(
    vehicle.position.x - Math.sin(yaw) * behind,
    vehicle.position.y + height,
    vehicle.position.z - Math.cos(yaw) * behind,
  );
  camera.position.lerp(target, 1 - Math.pow(0.001, dt));
  camera.lookAt(vehicle.position.x, vehicle.position.y + 1.2, vehicle.position.z);
}
