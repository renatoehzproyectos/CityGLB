/**
 * Agua realista en tiempo real.
 *
 * Basada en el shader "Seascape" del repo sea-water-effect (ruido de octavas con olas picudas),
 * pero adaptada para una malla dentro de la escena en vez de un raymarcher a pantalla completa:
 *  · Las olas solo perturban la NORMAL (la geometría sigue plana: costas y puentes no se rompen).
 *  · Reflejo del cielo REAL de la escena (textura del visor) + brillo del sol.
 *  · Fresnel de Schlick: desde arriba se ve el color real del agua (de la imagen satelital),
 *    a ras de superficie domina el reflejo del cielo.
 *  · Niebla de la escena y tone mapping del renderer.
 *  · Cada vértice lleva `wave` (0 = estanque/río, 1 = mar abierto) que escala amplitud y frecuencia.
 *  · El detalle se desvanece con la distancia para evitar parpadeo (aliasing).
 *
 * Un GLB no puede llevar shaders propios: para exportar se usa createExportWaterMaterial()
 * (PBR estándar con mapa de normales de olas, tileable).
 */
import * as THREE from "three";

export type WaterConfig = {
  sun: THREE.Vector3;
  sky?: THREE.Texture | null;
  atmosphere?: boolean;
};

const VERT = /* glsl */ `
attribute float wave;
varying vec3 vWorld;
varying vec3 vColor;
varying float vWave;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vColor = color;
  vWave = wave;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uSun;
uniform sampler2D uSky;
uniform float uHasSky;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
varying vec3 vWorld;
varying vec3 vColor;
varying float vWave;
#include <fog_pars_fragment>

#ifndef ITER_FRAGMENT
#define ITER_FRAGMENT 5
#endif

const float PI = 3.14159265;
const float SEA_CHOPPY = 1.0;
const vec3 SEA_BASE = vec3(0.012, 0.045, 0.06);
const vec3 SEA_WATER_COLOR = vec3(0.8, 0.9, 0.6);
const mat2 OCTAVE_M = mat2(1.6, 1.2, -1.2, 1.6);

float hash(vec2 p) {
  // hash sin-free: estable en GPUs móviles con coordenadas grandes
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return -1.0 + 2.0 * mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

float seaOctave(vec2 uv, float choppy) {
  uv += noise(uv);
  vec2 wv = 1.0 - abs(sin(uv));
  vec2 swv = abs(cos(uv));
  wv = mix(wv, swv, wv);
  return pow(1.0 - pow(wv.x * wv.y, 0.65), choppy);
}

// Altura de ola en metros para un punto del plano XZ.
float seaHeight(vec2 xz, float t, float freq0, float amp0, float footprint) {
  float freq = freq0;
  float amp = amp0;
  float choppy = SEA_CHOPPY;
  vec2 uv = xz;
  uv.x *= 0.75;
  float h = 0.0;
  for (int i = 0; i < ITER_FRAGMENT; i++) {
    // longitud de onda de esta octava (m) vs. tamaño del píxel en el mundo: si es más fina, se apaga
    float lambda = 6.2832 / (freq * 0.9);
    float vis = smoothstep(footprint * 2.0, footprint * 7.0, lambda);
    float d = seaOctave((uv + t) * freq, choppy);
    d += seaOctave((uv - t) * freq, choppy);
    h += d * amp * vis;
    uv *= OCTAVE_M;
    freq *= 1.9;
    amp *= 0.22;
    choppy = mix(choppy, 1.0, 0.2);
  }
  return h;
}

vec3 skyColor(vec3 e) {
  e.y = max(e.y, 0.02);
  if (uHasSky > 0.5) {
    float u = fract(atan(e.z, -e.x) / (2.0 * PI));
    float v = 0.5 + asin(clamp(e.y, -1.0, 1.0)) / PI;
    return texture2D(uSky, vec2(u, v)).rgb;
  }
  float k = pow(1.0 - e.y, 2.0);
  return mix(uSkyZenith, uSkyHorizon, k);
}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-3);

  // Mar abierto: olas largas y altas. Estanque/río: ondas pequeñas y suaves.
  float sea = clamp(vWave, 0.0, 1.0);
  float freq = mix(0.55, 0.16, sea);
  float amp = mix(0.10, 0.6, sea);
  float speed = mix(0.55, 0.9, sea);
  float t = uTime * speed;

  // Normal por diferencias finitas; el paso crece con la distancia (menos aliasing).
  float footprint = max(dist * 0.0016, 0.02); // metros por píxel aprox.
  float eps = clamp(footprint * 1.5, 0.04, 8.0);
  float h0 = seaHeight(vWorld.xz, t, freq, amp, footprint);
  float hx = seaHeight(vWorld.xz + vec2(eps, 0.0), t, freq, amp, footprint);
  float hz = seaHeight(vWorld.xz + vec2(0.0, eps), t, freq, amp, footprint);
  vec2 slope = vec2(hx - h0, hz - h0) / eps;
  // el relieve se apaga a lo lejos: el agua lejana es un espejo uniforme sin parpadeo
  float far = 1.0 - smoothstep(350.0, 2600.0, dist);
  slope *= mix(0.12, 1.0, far) * 2.2;
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

  // Fresnel de Schlick
  float ndv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  fres = clamp(fres * 1.15, 0.03, 1.0);

  vec3 R = reflect(-V, N);
  vec3 reflected = skyColor(R);

  // Color del cuerpo del agua: mezcla entre el color REAL (satélite) y un azul profundo
  vec3 body = mix(SEA_BASE, vColor * 0.85, 0.7);
  float diff = pow(max(dot(N, normalize(uSun)), 0.0) * 0.4 + 0.6, 80.0);
  body += diff * SEA_WATER_COLOR * 0.04;
  // las crestas dispersan algo de luz (subsurface barato)
  float crest = clamp((h0 / max(amp, 1e-3)) * 0.5, 0.0, 1.0);
  body += SEA_WATER_COLOR * crest * 0.025 * sea;

  vec3 col = mix(body, reflected, fres);

  // Brillo del sol (Blinn-Phong normalizado, como en el repo original)
  vec3 L = normalize(uSun);
  vec3 H = normalize(L + V);
  float s1 = pow(max(dot(N, H), 0.0), 220.0) * (220.0 + 8.0) / (PI * 8.0);
  float s2 = pow(max(dot(N, H), 0.0), 28.0) * 0.06;
  float glint = mix(0.15, 1.0, far); // lejos, el destello puntual se vuelve un brillo suave (evita el granulado)
  col += vec3(1.0, 0.93, 0.8) * (s1 * 0.08 * glint + s2) * step(0.0, L.y);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export type SeaMaterial = THREE.ShaderMaterial & {
  configure: (c: WaterConfig) => void;
  tick: (timeSec: number) => void;
};

export function createSeaMaterial(mobile: boolean): SeaMaterial {
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    vertexColors: true,
    fog: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    defines: { ITER_FRAGMENT: mobile ? 3 : 5 },
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSun: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
        uSky: { value: null },
        uHasSky: { value: 0 },
        uSkyHorizon: { value: new THREE.Color(0.62, 0.74, 0.84) },
        uSkyZenith: { value: new THREE.Color(0.12, 0.28, 0.55) },
      },
    ]),
  }) as SeaMaterial;
  mat.name = "water-sea";
  mat.configure = (c) => {
    mat.uniforms.uSun.value.copy(c.sun).normalize();
    mat.uniforms.uSky.value = c.sky ?? null;
    mat.uniforms.uHasSky.value = c.sky ? 1 : 0;
    if (c.atmosphere) {
      mat.uniforms.uSkyHorizon.value.setRGB(0.76, 0.7, 0.6);
      mat.uniforms.uSkyZenith.value.setRGB(0.1, 0.25, 0.55);
    }
  };
  mat.tick = (t) => {
    mat.uniforms.uTime.value = t;
  };
  return mat;
}

/**
 * Material para el GLB exportado: PBR estándar con mapa de normales de olas (tileable).
 * Se usa solo al exportar; el visor usa el shader.
 */
export function createExportWaterMaterial(): THREE.MeshStandardMaterial {
  const N = 256;
  // Suma de ondas con número de onda entero sobre el toro N×N ⇒ el mapa es perfectamente tileable.
  const waves: [number, number, number, number][] = [
    [2, 1, 0.9, 0.3], [1, 3, 0.7, 1.7], [-3, 2, 0.5, 2.9], [4, -1, 0.4, 4.1],
    [5, 3, 0.25, 5.3], [-2, 6, 0.2, 0.7], [7, -4, 0.14, 2.2], [3, 8, 0.1, 3.6],
  ];
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let v = 0;
      for (const [kx, ky, a, p] of waves) v += a * Math.sin((2 * Math.PI * (kx * x + ky * y)) / N + p);
      h[y * N + x] = v;
    }
  }
  const data = new Uint8Array(N * N * 4);
  const strength = 2.2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = h[y * N + ((x + 1) % N)] - h[y * N + ((x + N - 1) % N)];
      const dy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
      const nx = -dx * strength, ny = -dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const i = (y * N + x) * 4;
      data[i] = Math.round((nx / l * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz / l * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  tex.name = "water-normal";
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.06,
    metalness: 0.0,
    normalMap: tex,
    normalScale: new THREE.Vector2(0.6, 0.6),
    envMapIntensity: 1.2,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  m.name = "water";
  return m;
}
