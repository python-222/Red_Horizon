import * as THREE from 'three';
import {
  terrainDetailStack,
  getRealBaseElevation,
  getTerrainFrameId,
  terrainRoughnessFromSlope,
} from '../data/marsTerrain';
import type { MarsBiomeId, SeasonalFrostMode } from '../types/telemetry';

/**
 * Distant-horizon terrain: nested square rings (a geometry clipmap) of real NASA MOLA relief
 * out to ~100 km, so mountains, crater rims and canyon walls appear on the horizon exactly where
 * they are on the map. The near 3.6 km chunked terrain draws on top of the innermost ring.
 */

const GRID = 128; // cells per side per level
// half-extent in meters of each level (cell = 2*half/GRID => 47 m ... 1.5 km)
const LEVEL_HALF = [3000, 6000, 12000, 24000, 48000, 96000];
const HOLE_FRACTION = 0.78; // inner cut-out vs previous level's half-extent (overlap hides seams)
const FIRST_HOLE_HALF = 1300; // inside the chunked near terrain
const REBUILD_STEP_CELLS = 16; // re-center a level after the camera moves this many cells

interface Level {
  half: number;
  cell: number;
  holeHalf: number;
  mesh: THREE.Mesh;
  centerX: number;
  centerZ: number;
  dirty: boolean;
}

function albedoFor(biome: MarsBiomeId, slope: number, out: THREE.Color): THREE.Color {
  let dust: [number, number, number] = [0.6, 0.36, 0.25];
  let rock: [number, number, number] = [0.3, 0.2, 0.16];
  if (biome === 'OLYMPUS_MONS' || biome === 'THARSIS_BULGE' || biome === 'SYRTIS_MAJOR') {
    dust = [0.5, 0.33, 0.25];
    rock = [0.3, 0.21, 0.17];
  } else if (biome === 'PLANUM_BOREUM' || biome === 'PLANUM_AUSTRALE') {
    dust = [0.82, 0.84, 0.86];
    rock = [0.5, 0.42, 0.38];
  } else if (biome === 'VALLES_MARINERIS' || biome === 'GALE_CRATER') {
    dust = [0.58, 0.34, 0.23];
    rock = [0.36, 0.22, 0.17];
  }
  const t = Math.max(0, Math.min(1, (slope - 0.08) * 3.2));
  return out.setRGB(
    dust[0] + (rock[0] - dust[0]) * t,
    dust[1] + (rock[1] - dust[1]) * t,
    dust[2] + (rock[2] - dust[2]) * t
  );
}

export class MarsFarTerrain {
  public readonly group = new THREE.Group();
  private readonly levels: Level[] = [];
  private readonly material: THREE.ShaderMaterial;
  private biomeId: MarsBiomeId = 'JEZERO_CRATER';
  private frostMode: SeasonalFrostMode = 'SUBLIMATION';
  private frameId = -1;
  private readonly tmpColor = new THREE.Color();

  constructor(sunDir: { value: THREE.Vector3 }) {
    this.group.name = 'MarsFarTerrain';
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: sunDir,
        uFogColor: { value: new THREE.Color(0xc87d55) },
        uFogDensity: { value: 0.0003 },
        uHazeLength: { value: 180000 },
        uFogCapDist: { value: 3000 },
      },
      vertexColors: true,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vNormalW;
        varying vec3 vColor;
        varying float vDist;
        void main() {
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uHazeLength;
        uniform float uFogCapDist;
        varying vec3 vNormalW;
        varying vec3 vColor;
        varying float vDist;
        void main() {
          vec3 n = normalize(vNormalW);
          float lambert = max(dot(n, normalize(uSunDir)), 0.0);
          vec3 col = vColor * (0.2 + 1.35 * lambert);
          // Same exp2 fog as the near terrain up to a cap distance, then a gentle linear haze so
          // mountains tens of km away stay visible but atmospheric.
          float x = min(vDist, uFogCapDist) * uFogDensity;
          float ext = x * x + vDist / uHazeLength;
          float f = 1.0 - exp(-ext);
          // Distant dust scatters light, so haze is lighter/pinker than the (often dark) sky; this
          // keeps far mountains readable as silhouettes instead of melting into the horizon.
          vec3 haze = mix(uFogColor, vec3(0.80, 0.54, 0.42), 0.5);
          col = mix(col, haze, clamp(f, 0.0, 0.9));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    for (let i = 0; i < LEVEL_HALF.length; i++) {
      const half = LEVEL_HALF[i];
      const holeHalf = i === 0 ? FIRST_HOLE_HALF : LEVEL_HALF[i - 1] * HOLE_FRACTION;
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = -1;
      this.group.add(mesh);
      this.levels.push({
        half,
        cell: (2 * half) / GRID,
        holeHalf,
        mesh,
        centerX: Number.NaN,
        centerZ: Number.NaN,
        dirty: true,
      });
    }
  }

  public setEnvironment(biomeId: MarsBiomeId, frostMode: SeasonalFrostMode): void {
    if (this.biomeId === biomeId && this.frostMode === frostMode) return;
    this.biomeId = biomeId;
    this.frostMode = frostMode;
    this.invalidate();
  }

  private invalidate(): void {
    for (const l of this.levels) l.dirty = true;
  }

  /** Call every frame. Rebuilds at most one level per call to keep frames smooth. */
  public update(
    cameraX: number,
    cameraZ: number,
    fogColor: THREE.Color,
    fogDensity: number,
    visible: boolean
  ): void {
    this.group.visible = visible;
    const u = this.material.uniforms;
    (u.uFogColor.value as THREE.Color).copy(fogColor);
    u.uFogDensity.value = fogDensity;
    u.uFogCapDist.value = 3000;
    if (!visible) return;

    const frame = getTerrainFrameId();
    if (frame !== this.frameId) {
      this.frameId = frame;
      this.invalidate();
    }

    for (const l of this.levels) {
      const snap = l.cell * REBUILD_STEP_CELLS;
      const cx = Math.round(cameraX / snap) * snap;
      const cz = Math.round(cameraZ / snap) * snap;
      if (cx !== l.centerX || cz !== l.centerZ) l.dirty = true;
    }

    for (const l of this.levels) {
      if (!l.dirty) continue;
      const snap = l.cell * REBUILD_STEP_CELLS;
      l.centerX = Math.round(cameraX / snap) * snap;
      l.centerZ = Math.round(cameraZ / snap) * snap;
      this.buildLevel(l, this.levels.indexOf(l));
      l.dirty = false;
      break; // one level per frame
    }
  }

  private buildLevel(l: Level, index: number): void {
    const n = GRID + 1;
    const pad = 2;
    const pn = n + pad * 2;
    // Pass 1: real MOLA base heights on a padded grid (padding gives slope at the borders).
    const base = new Float32Array(pn * pn);
    for (let j = 0; j < pn; j++) {
      const z = l.centerZ - l.half + (j - pad) * l.cell;
      for (let i = 0; i < pn; i++) {
        const x = l.centerX - l.half + (i - pad) * l.cell;
        base[j * pn + i] = getRealBaseElevation(x, z);
      }
    }

    const positions = new Float32Array(n * n * 3);
    const heights = new Float32Array(n * n);
    const colors = new Float32Array(n * n * 3);
    const drop = l.cell * 0.12 + 2 + index * 0.5; // finer levels / near chunks win overlaps

    // Pass 2: local ruggedness from the real slope, then add fractal detail the mesh can resolve.
    for (let j = 0; j < n; j++) {
      const z = l.centerZ - l.half + j * l.cell;
      for (let i = 0; i < n; i++) {
        const x = l.centerX - l.half + i * l.cell;
        const bi = (j + pad) * pn + (i + pad);
        // slope over +/-2 cells, but never narrower than ~120 m so it matches the near terrain
        const k = Math.max(2, Math.round(120 / l.cell));
        const jj0 = Math.max(0, j + pad - k);
        const jj1 = Math.min(pn - 1, j + pad + k);
        const ii0 = Math.max(0, i + pad - k);
        const ii1 = Math.min(pn - 1, i + pad + k);
        const dx = (base[(j + pad) * pn + ii1] - base[(j + pad) * pn + ii0]) / ((ii1 - ii0) * l.cell);
        const dz = (base[jj1 * pn + (i + pad)] - base[jj0 * pn + (i + pad)]) / ((jj1 - jj0) * l.cell);
        const rough = terrainRoughnessFromSlope(Math.hypot(dx, dz));
        const h =
          base[bi] +
          terrainDetailStack(x, z, rough, Math.max(12, l.cell * 4), this.biomeId, this.frostMode);
        const o = j * n + i;
        heights[o] = h;
        positions[o * 3] = x - l.centerX;
        positions[o * 3 + 1] = h - drop;
        positions[o * 3 + 2] = z - l.centerZ;
      }
    }

    // Normals (central differences) + albedo by slope
    const normals = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(n - 1, i + 1);
        const j0 = Math.max(0, j - 1);
        const j1 = Math.min(n - 1, j + 1);
        const dhdx = (heights[j * n + i1] - heights[j * n + i0]) / ((i1 - i0) * l.cell);
        const dhdz = (heights[j1 * n + i] - heights[j0 * n + i]) / ((j1 - j0) * l.cell);
        const inv = 1 / Math.hypot(dhdx, 1, dhdz);
        const o = (j * n + i) * 3;
        normals[o] = -dhdx * inv;
        normals[o + 1] = inv;
        normals[o + 2] = -dhdz * inv;
        albedoFor(this.biomeId, Math.hypot(dhdx, dhdz), this.tmpColor);
        colors[o] = this.tmpColor.r;
        colors[o + 1] = this.tmpColor.g;
        colors[o + 2] = this.tmpColor.b;
      }
    }

    // Indices: skip quads whose centre lies inside this level's cut-out.
    const idx: number[] = [];
    for (let j = 0; j < GRID; j++) {
      const qz = -l.half + (j + 0.5) * l.cell;
      for (let i = 0; i < GRID; i++) {
        const qx = -l.half + (i + 0.5) * l.cell;
        if (Math.abs(qx) < l.holeHalf && Math.abs(qz) < l.holeHalf) continue;
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }

    const g = l.mesh.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    l.mesh.position.set(l.centerX, 0, l.centerZ);
    l.mesh.visible = true;
  }

  public dispose(): void {
    for (const l of this.levels) l.mesh.geometry.dispose();
    this.material.dispose();
  }
}
