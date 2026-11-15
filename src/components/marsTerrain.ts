import * as THREE from 'three';
import {
  getMarsElevation,
  getTerrainFrameId,
  sampleTerrainGridElevation,
  WORLD_HALF_EXTENT,
} from '../data/marsTerrain';
import { MarsBiomeId, SeasonalFrostMode } from '../types/telemetry';
import { getHazardOverlayEnabled } from '../utils/hazardOverlayStore';

export type TerrainSpectralMode = 'optical' | 'thermal' | 'topographic';

export interface TerrainLodLevelConfig {
  level: number;
  segments: number;
  distance: number;
  hysteresis: number;
}

export const TERRAIN_CHUNK_SIZE = 300; // meters per chunk tile
export const TERRAIN_HEIGHTMAP_RES = 64; // 65x65 samples per chunk
export const TERRAIN_DIFFUSE_RES = 64; // 64x64 procedural regional palette map per chunk
export const TERRAIN_SKIRT_DEPTH = 12; // downward skirt meters to prevent LOD seam cracks
export const ACTIVE_VIEWPORT_LOAD_RADIUS_CHUNKS = 6.2; // ~1,860m active radius around camera
export const ACTIVE_VIEWPORT_UNLOAD_RADIUS_CHUNKS = 7.2; // ~2,160m eviction boundary (with hysteresis)
export const MAX_CHUNKS_BUILT_PER_FRAME = 1;

export const TERRAIN_LOD_LEVELS: readonly TerrainLodLevelConfig[] = [
  { level: 0, segments: 64, distance: 0, hysteresis: 0.05 }, // ~4.7m vertex resolution near camera
  // segments must divide TERRAIN_HEIGHTMAP_RES (64) so every vertex reads a real heightmap sample
  { level: 1, segments: 32, distance: 420, hysteresis: 0.08 }, // ~9.4m mid-range resolution
  { level: 2, segments: 16, distance: 1000, hysteresis: 0.08 }, // ~19m distant mesh
];

export interface TerrainChunk {
  key: string;
  cx: number;
  cz: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  lod: THREE.LOD;
  meshes: THREE.Mesh[];
  geometries: THREE.BufferGeometry[];
  material: THREE.MeshStandardMaterial;
  heightmapData: Float32Array;
  heightmapTexture: THREE.DataTexture;
  diffuseTexture: THREE.DataTexture;
}

export interface TerrainManagerMetrics {
  activeChunks: number;
  lod0Count: number;
  lod1Count: number;
  lod2Count: number;
  totalCreated: number;
  totalDisposed: number;
}

function hash2D(ix: number, iz: number): number {
  const n = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function periodicHash2D(ix: number, iz: number, period: number): number {
  const px = ((ix % period) + period) % period;
  const pz = ((iz % period) + period) % period;
  return hash2D(px, pz);
}

function periodicValueNoise2D(x: number, z: number, period: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);

  const a = periodicHash2D(ix, iz, period);
  const b = periodicHash2D(ix + 1, iz, period);
  const c = periodicHash2D(ix, iz + 1, period);
  const d = periodicHash2D(ix + 1, iz + 1, period);

  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function periodicFbm2D(u: number, v: number, basePeriod: number): number {
  return (
    periodicValueNoise2D(u * basePeriod, v * basePeriod, basePeriod) * 0.52 +
    periodicValueNoise2D(u * basePeriod * 2, v * basePeriod * 2, basePeriod * 2) * 0.28 +
    periodicValueNoise2D(u * basePeriod * 4, v * basePeriod * 4, basePeriod * 4) * 0.14 +
    periodicValueNoise2D(u * basePeriod * 8, v * basePeriod * 8, basePeriod * 8) * 0.06
  );
}

function valueNoise2D(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);

  const a = hash2D(ix, iz);
  const b = hash2D(ix + 1, iz);
  const c = hash2D(ix, iz + 1);
  const d = hash2D(ix + 1, iz + 1);

  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm2D(x: number, z: number): number {
  return (
    valueNoise2D(x, z) * 0.55 +
    valueNoise2D(x * 2.13, z * 2.13) * 0.3 +
    valueNoise2D(x * 4.47, z * 4.47) * 0.15
  );
}

function getChunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

interface ProceduralPbrMaps {
  albedoDetailTex: THREE.DataTexture;
  normalDetailTex: THREE.DataTexture;
  roughnessDetailTex: THREE.DataTexture;
  strataNormalTex: THREE.DataTexture;
}

function isLowMemoryDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof dm === 'number' && dm <= 4;
}

/**
 * Generates seamless tileable procedural PBR maps (albedo detail, tangent normal,
 * roughness, and sedimentary strata normal) completely in code with zero external assets.
 */
function createProceduralMarsPbrMaps(maxAnisotropy: number, texSize: number): ProceduralPbrMaps {
  const size = texSize;
  const cappedAniso = Math.min(2, Math.max(1, maxAnisotropy));
  const heightField = new Float32Array(size * size);
  const strataHeight = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;
      const macro = periodicFbm2D(u, v, 8);
      const grit = periodicValueNoise2D(u * 48, v * 48, 48);
      const ripple = Math.sin((u * 6 + v * 3 + macro * 1.6) * Math.PI * 2) * 0.5 + 0.5;
      heightField[idx] = macro * 0.52 + ripple * 0.28 + grit * 0.2;

      const bed =
        Math.sin((v * 10 + macro * 0.8) * Math.PI * 2) * 0.45 +
        Math.sin((v * 24 - u * 2) * Math.PI * 2) * 0.2 +
        grit * 0.35;
      strataHeight[idx] = bed * 0.5 + 0.5;
    }
  }

  const albedoBytes = new Uint8Array(size * size * 4);
  const normalBytes = new Uint8Array(size * size * 4);
  const roughBytes = new Uint8Array(size * size * 4);
  const strataBytes = new Uint8Array(size * size * 4);

  const sampleWrap = (buf: Float32Array, x: number, y: number) => {
    const wx = ((x % size) + size) % size;
    const wy = ((y % size) + size) % size;
    return buf[wy * size + wx];
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const p = idx * 4;
      const h = heightField[idx];
      const sh = strataHeight[idx];

      const pebbleSpeck = periodicValueNoise2D((x / size) * 64, (y / size) * 64, 64);
      const mod = 0.78 + h * 0.32 + (pebbleSpeck - 0.5) * 0.14;
      albedoBytes[p] = Math.max(0, Math.min(255, Math.round(mod * 246)));
      albedoBytes[p + 1] = Math.max(0, Math.min(255, Math.round(mod * 224)));
      albedoBytes[p + 2] = Math.max(0, Math.min(255, Math.round(mod * 208)));
      albedoBytes[p + 3] = 255;

      const roughVal = Math.max(0.55, Math.min(0.98, 0.94 - (h - 0.42) * 0.42));
      const roughByte = Math.round(roughVal * 255);
      roughBytes[p] = roughByte;
      roughBytes[p + 1] = roughByte;
      roughBytes[p + 2] = roughByte;
      roughBytes[p + 3] = 255;

      const dx = (sampleWrap(heightField, x + 1, y) - sampleWrap(heightField, x - 1, y)) * 2.8;
      const dy = (sampleWrap(heightField, x, y + 1) - sampleWrap(heightField, x, y - 1)) * 2.8;
      const invLen = 1 / Math.hypot(-dx, -dy, 1.0);
      normalBytes[p] = Math.round(((-dx * invLen) * 0.5 + 0.5) * 255);
      normalBytes[p + 1] = Math.round(((-dy * invLen) * 0.5 + 0.5) * 255);
      normalBytes[p + 2] = Math.round(((1.0 * invLen) * 0.5 + 0.5) * 255);
      normalBytes[p + 3] = 255;

      const sdx = (sampleWrap(strataHeight, x + 1, y) - sampleWrap(strataHeight, x - 1, y)) * 3.4;
      const sdy = (sampleWrap(strataHeight, x, y + 1) - sampleWrap(strataHeight, x, y - 1)) * 3.4;
      const sInv = 1 / Math.hypot(-sdx, -sdy, 1.0);
      strataBytes[p] = Math.round(((-sdx * sInv) * 0.5 + 0.5) * 255);
      strataBytes[p + 1] = Math.round(((-sdy * sInv) * 0.5 + 0.5) * 255);
      strataBytes[p + 2] = Math.round(((1.0 * sInv) * 0.5 + 0.5) * 255);
      strataBytes[p + 3] = Math.max(0, Math.min(255, Math.round(sh * 255)));
    }
  }

  const makeRepeatTex = (bytes: Uint8Array, isColor: boolean) => {
    const tex = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
    tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = cappedAniso;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  };

  return {
    albedoDetailTex: makeRepeatTex(albedoBytes, true),
    normalDetailTex: makeRepeatTex(normalBytes, false),
    roughnessDetailTex: makeRepeatTex(roughBytes, false),
    strataNormalTex: makeRepeatTex(strataBytes, false),
  };
}

/**
 * Generates a chunk's CPU elevation heightmap (65x65) and linear GPU DataTexture.
 */
function createChunkHeightmap(
  cx: number,
  cz: number,
  biomeId: MarsBiomeId,
  frostMode: SeasonalFrostMode
): {
  centerX: number;
  centerY: number;
  centerZ: number;
  heightmapData: Float32Array;
  heightmapTexture: THREE.DataTexture;
} {
  const centerX = cx * TERRAIN_CHUNK_SIZE;
  const centerZ = cz * TERRAIN_CHUNK_SIZE;
  const half = TERRAIN_CHUNK_SIZE * 0.5;
  const startX = centerX - half;
  const startZ = centerZ - half;
  const res = TERRAIN_HEIGHTMAP_RES;
  const stride = res + 1;
  const step = TERRAIN_CHUNK_SIZE / res;

  const heightmapData = new Float32Array(stride * stride);
  let minY = Infinity;
  let maxY = -Infinity;

  for (let iz = 0; iz <= res; iz++) {
    const wz = startZ + iz * step;
    const zInGrid = Math.abs(wz) < WORLD_HALF_EXTENT;
    for (let ix = 0; ix <= res; ix++) {
      const wx = startX + ix * step;
      const y =
        zInGrid && Math.abs(wx) < WORLD_HALF_EXTENT
          ? sampleTerrainGridElevation(wx, wz, biomeId, frostMode)
          : getMarsElevation(wx, wz, biomeId, frostMode);
      heightmapData[iz * stride + ix] = y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const centerY = heightmapData[(res >> 1) * stride + (res >> 1)];
  const rangeY = Math.max(1, maxY - minY);

  const texPixels = new Uint8Array(res * res * 4);
  for (let iz = 0; iz < res; iz++) {
    const wz = startZ + (iz + 0.5) * step;
    for (let ix = 0; ix < res; ix++) {
      const wx = startX + (ix + 0.5) * step;
      const h = heightmapData[iz * stride + ix];
      const normalized = (h - minY) / rangeY;
      const ripple = Math.sin(wx * 0.14 + wz * 0.09) * 0.08 + (fbm2D(wx * 0.06, wz * 0.06) - 0.5) * 0.22;
      const val = Math.max(0, Math.min(255, Math.round((normalized * 0.72 + 0.14 + ripple) * 255)));
      const idx = (iz * res + ix) * 4;
      texPixels[idx] = val;
      texPixels[idx + 1] = val;
      texPixels[idx + 2] = val;
      texPixels[idx + 3] = 255;
    }
  }

  const heightmapTexture = new THREE.DataTexture(texPixels, res, res, THREE.RGBAFormat);
  heightmapTexture.colorSpace = THREE.NoColorSpace;
  heightmapTexture.wrapS = THREE.ClampToEdgeWrapping;
  heightmapTexture.wrapT = THREE.ClampToEdgeWrapping;
  heightmapTexture.minFilter = THREE.LinearMipmapLinearFilter;
  heightmapTexture.magFilter = THREE.LinearFilter;
  heightmapTexture.anisotropy = 2;
  heightmapTexture.generateMipmaps = true;
  heightmapTexture.needsUpdate = true;

  return { centerX, centerY, centerZ, heightmapData, heightmapTexture };
}

/**
 * Generates a chunk-specific sRGB diffuse DataTexture using world-space deterministic
 * noise, local slope steepness, and regional Martian geology coloration.
 */
function createChunkDiffuseTexture(
  cx: number,
  cz: number,
  heightmapData: Float32Array,
  maxAnisotropy: number,
  biomeId: MarsBiomeId,
  frostMode: SeasonalFrostMode
): THREE.DataTexture {
  const centerX = cx * TERRAIN_CHUNK_SIZE;
  const centerZ = cz * TERRAIN_CHUNK_SIZE;
  const half = TERRAIN_CHUNK_SIZE * 0.5;
  const startX = centerX - half;
  const startZ = centerZ - half;
  const res = TERRAIN_DIFFUSE_RES;
  const stride = TERRAIN_HEIGHTMAP_RES + 1;
  const cellStep = TERRAIN_CHUNK_SIZE / TERRAIN_HEIGHTMAP_RES;
  const texStep = TERRAIN_CHUNK_SIZE / res;

  const data = new Uint8Array(res * res * 4);

  for (let iz = 0; iz < res; iz++) {
    const wz = startZ + (iz + 0.5) * texStep;
    const hmZ = Math.min(TERRAIN_HEIGHTMAP_RES - 1, Math.floor((iz / res) * TERRAIN_HEIGHTMAP_RES));
    for (let ix = 0; ix < res; ix++) {
      const wx = startX + (ix + 0.5) * texStep;
      const hmX = Math.min(TERRAIN_HEIGHTMAP_RES - 1, Math.floor((ix / res) * TERRAIN_HEIGHTMAP_RES));

      const h00 = heightmapData[hmZ * stride + hmX];
      const h10 = heightmapData[hmZ * stride + hmX + 1];
      const h01 = heightmapData[(hmZ + 1) * stride + hmX];
      const slope = Math.hypot((h10 - h00) / cellStep, (h01 - h00) / cellStep);

      const grain = fbm2D(wx * 0.045, wz * 0.045);
      const fine = hash2D(Math.floor(wx * 0.45), Math.floor(wz * 0.45));
      const aeolian = Math.sin(wx * 0.09 + wz * 0.06 + grain * 2.2) * 0.5 + 0.5;

      let r = 178;
      let g = 104;
      let b = 68;

      if (biomeId === 'OLYMPUS_MONS' || biomeId === 'THARSIS_BULGE') {
        const lavaBand = Math.sin(Math.atan2(wz, wx) * 14 + Math.hypot(wx, wz) * 0.005) * 0.5 + 0.5;
        r = 82 + grain * 34 + lavaBand * 24 + (fine - 0.5) * 14;
        g = 58 + grain * 22 + lavaBand * 14 + (fine - 0.5) * 10;
        b = 52 + grain * 18 + lavaBand * 11 + (fine - 0.5) * 9;
        const steepBasalt = Math.min(1, Math.max(0, (slope - 0.12) * 3.5));
        r = r * (1 - steepBasalt) + (54 + grain * 14) * steepBasalt;
        g = g * (1 - steepBasalt) + (44 + grain * 12) * steepBasalt;
        b = b * (1 - steepBasalt) + (46 + grain * 12) * steepBasalt;
      } else if (biomeId === 'VALLES_MARINERIS') {
        const strata = Math.sin(h00 * 0.36 + grain * 1.4) * 0.5 + 0.5;
        const depthDark = Math.max(0, Math.min(0.45, (-40 - h00) / 220));
        r = (162 + strata * 44 + grain * 22 + (fine - 0.5) * 14) * (1 - depthDark * 0.55);
        g = (96 + strata * 32 + grain * 16 + (fine - 0.5) * 10) * (1 - depthDark * 0.52);
        b = (64 + strata * 20 + grain * 10 + (fine - 0.5) * 8) * (1 - depthDark * 0.42);
        const talusBlend = Math.min(1, Math.max(0, (slope - 0.18) * 2.6));
        if (talusBlend > 0) {
          r = r * (1 - talusBlend) + (112 + strata * 36) * talusBlend;
          g = g * (1 - talusBlend) + (76 + strata * 26) * talusBlend;
          b = b * (1 - talusBlend) + (56 + strata * 18) * talusBlend;
        }
      } else if (biomeId === 'GALE_CRATER') {
        const sandMask = Math.max(0, Math.min(1, (aeolian - 0.56) * 2.4));
        const strata = Math.sin(h00 * 0.42) * 0.5 + 0.5;
        const moundHighlight = Math.max(0, Math.min(0.35, (h00 + 15) / 240));
        const slabR = 184 + strata * 28 + grain * 20 + (fine - 0.5) * 12 + moundHighlight * 28;
        const slabG = 138 + strata * 22 + grain * 16 + (fine - 0.5) * 10 + moundHighlight * 22;
        const slabB = 96 + strata * 16 + grain * 12 + (fine - 0.5) * 8 + moundHighlight * 14;
        r = slabR * (1 - sandMask * 0.65) + 68 * (sandMask * 0.65);
        g = slabG * (1 - sandMask * 0.65) + 56 * (sandMask * 0.65);
        b = slabB * (1 - sandMask * 0.65) + 50 * (sandMask * 0.65);
      } else if (biomeId === 'PLANUM_BOREUM' || biomeId === 'PLANUM_AUSTRALE') {
        const dist = Math.hypot(wx, wz);
        const ergBlend = Math.max(0, Math.min(1, (dist - 1100) / 520));
        const troughWall = Math.min(1, Math.max(0, (slope - 0.08) * 5.2));
        let iceR = 232 + grain * 18 + (fine - 0.5) * 10;
        let iceG = 240 + grain * 12 + (fine - 0.5) * 8;
        let iceB = 248 + grain * 6 + (fine - 0.5) * 6;
        iceR = iceR * (1 - troughWall * 0.78) + 114 * (troughWall * 0.78);
        iceG = iceG * (1 - troughWall * 0.82) + 58 * (troughWall * 0.82);
        iceB = iceB * (1 - troughWall * 0.85) + 46 * (troughWall * 0.85);
        r = iceR * (1 - ergBlend) + (62 + aeolian * 18) * ergBlend;
        g = iceG * (1 - ergBlend) + (50 + aeolian * 12) * ergBlend;
        b = iceB * (1 - ergBlend) + (46 + aeolian * 10) * ergBlend;
        if (frostMode === 'DEPOSITION') {
          const frostCoat = 0.52 + grain * 0.25;
          r = r * (1 - frostCoat) + 236 * frostCoat;
          g = g * (1 - frostCoat) + 245 * frostCoat;
          b = b * (1 - frostCoat) + 252 * frostCoat;
        }
      } else if (biomeId === 'HELLAS_PLANITIA') {
        const rimFactor = Math.min(1, Math.max(0, (h00 + 60) / 140));
        const frostPatch = Math.max(0, grain - 0.36) * 1.15 * (1 - rimFactor * 0.75);
        r = 186 + grain * 26 + aeolian * 10 - rimFactor * 28;
        g = 128 + grain * 24 + aeolian * 8 - rimFactor * 36;
        b = 98 + grain * 22 + aeolian * 8 - rimFactor * 34;
        const frostBlend = Math.min(0.68, frostPatch);
        r = r * (1 - frostBlend) + 228 * frostBlend;
        g = g * (1 - frostBlend) + 232 * frostBlend;
        b = b * (1 - frostBlend) + 236 * frostBlend;
      } else if (biomeId === 'SYRTIS_MAJOR') {
        r = 72 + grain * 26 + aeolian * 14 + (fine - 0.5) * 12;
        g = 56 + grain * 18 + aeolian * 10 + (fine - 0.5) * 9;
        b = 50 + grain * 15 + aeolian * 8 + (fine - 0.5) * 8;
      } else if (biomeId === 'NORTHERN_LOWLANDS') {
        r = 156 + grain * 26 + aeolian * 16 + (fine - 0.5) * 12;
        g = 94 + grain * 18 + aeolian * 10 + (fine - 0.5) * 9;
        b = 68 + grain * 14 + aeolian * 6 + (fine - 0.5) * 7;
      } else {
        // JEZERO_CRATER / SOUTHERN_HIGHLANDS: Warm NASA Mastcam-Z butterscotch/ochre iron-oxide regolith
        // combined with dark aeolian basaltic sand troughs & exposed sedimentary/basalt outcrops
        const sandTrough = Math.max(0, (aeolian - 0.58) * 1.8);
        r = 178 + grain * 36 + aeolian * 12 + (fine - 0.5) * 16;
        g = 104 + grain * 24 + aeolian * 8 + (fine - 0.5) * 11;
        b = 66 + grain * 16 + aeolian * 5 + (fine - 0.5) * 8;

        // Dark basaltic sand ripples
        r = r * (1 - sandTrough * 0.42) + 84 * (sandTrough * 0.42);
        g = g * (1 - sandTrough * 0.42) + 56 * (sandTrough * 0.42);
        b = b * (1 - sandTrough * 0.42) + 48 * (sandTrough * 0.42);

        const rockBlend = Math.min(1, Math.max(0, (slope - 0.14) * 3.6));
        if (rockBlend > 0) {
          const strataBand = Math.sin(h00 * 0.48) * 0.5 + 0.5;
          r = r * (1 - rockBlend) + (116 + strataBand * 34 + grain * 18) * rockBlend;
          g = g * (1 - rockBlend) + (74 + strataBand * 24 + grain * 12) * rockBlend;
          b = b * (1 - rockBlend) + (54 + strataBand * 16 + grain * 10) * rockBlend;
        }

        const highBlend = Math.min(0.32, Math.max(0, (h00 - 46) / 135));
        if (highBlend > 0) {
          r = r * (1 - highBlend) + 206 * highBlend;
          g = g * (1 - highBlend) + 144 * highBlend;
          b = b * (1 - highBlend) + 102 * highBlend;
        }
      }

      const idx = (iz * res + ix) * 4;
      data[idx] = Math.max(0, Math.min(255, Math.round(r)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      data[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      data[idx + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = Math.min(2, Math.max(1, maxAnisotropy));
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  return texture;
}

const sharedLodIndexAttributes = new Map<number, THREE.BufferAttribute>();

function getSharedLodIndexAttribute(segments: number): THREE.BufferAttribute {
  const cached = sharedLodIndexAttributes.get(segments);
  if (cached) return cached;

  const gridVertsPerSide = segments + 1;
  const mainVertCount = gridVertsPerSide * gridVertsPerSide;
  const mainQuadCount = segments * segments;
  const skirtQuadCount = 4 * segments;
  const indices = new Uint16Array((mainQuadCount + skirtQuadCount) * 6);

  let ptr = 0;
  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iz * gridVertsPerSide + ix;
      const b = a + 1;
      const c = (iz + 1) * gridVertsPerSide + ix;
      const d = c + 1;

      indices[ptr++] = a;
      indices[ptr++] = c;
      indices[ptr++] = b;

      indices[ptr++] = b;
      indices[ptr++] = c;
      indices[ptr++] = d;
    }
  }

  let skirtOffset = mainVertCount;
  const appendSkirtIndices = (getEdgeIdx: (k: number) => number, flipWinding: boolean) => {
    const startSkirt = skirtOffset;
    for (let k = 0; k < segments; k++) {
      const top0 = getEdgeIdx(k);
      const top1 = getEdgeIdx(k + 1);
      const bot0 = startSkirt + k;
      const bot1 = startSkirt + k + 1;

      if (flipWinding) {
        indices[ptr++] = top0;
        indices[ptr++] = top1;
        indices[ptr++] = bot0;
        indices[ptr++] = top1;
        indices[ptr++] = bot1;
        indices[ptr++] = bot0;
      } else {
        indices[ptr++] = top0;
        indices[ptr++] = bot0;
        indices[ptr++] = top1;
        indices[ptr++] = top1;
        indices[ptr++] = bot0;
        indices[ptr++] = bot1;
      }
    }
    skirtOffset += gridVertsPerSide;
  };

  appendSkirtIndices((k) => k, false);
  appendSkirtIndices((k) => segments * gridVertsPerSide + k, true);
  appendSkirtIndices((k) => k * gridVertsPerSide, true);
  appendSkirtIndices((k) => k * gridVertsPerSide + segments, false);

  const attr = new THREE.BufferAttribute(indices, 1);
  sharedLodIndexAttributes.set(segments, attr);
  return attr;
}

/**
 * Builds an indexed BufferGeometry for a specific LOD level of a terrain chunk,
 * sharing static LOD index buffers across all chunks to reduce memory overhead.
 */
function buildChunkLodGeometry(
  segments: number,
  heightmapData: Float32Array,
  centerX: number,
  centerY: number,
  centerZ: number,
  biomeId: MarsBiomeId,
  frostMode: SeasonalFrostMode
): THREE.BufferGeometry {
  const half = TERRAIN_CHUNK_SIZE * 0.5;
  const gridVertsPerSide = segments + 1;
  const mainVertCount = gridVertsPerSide * gridVertsPerSide;
  const skirtVertCount = 4 * gridVertsPerSide;
  const totalVerts = mainVertCount + skirtVertCount;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);

  const hmStride = TERRAIN_HEIGHTMAP_RES + 1;
  const hmRatio = TERRAIN_HEIGHTMAP_RES / segments;
  const normalStep = 3.0;

  for (let iz = 0; iz <= segments; iz++) {
    const v = iz / segments;
    const localZ = -half + v * TERRAIN_CHUNK_SIZE;
    const wz = centerZ + localZ;
    const hmZ = Math.round(iz * hmRatio);

    for (let ix = 0; ix <= segments; ix++) {
      const u = ix / segments;
      const localX = -half + u * TERRAIN_CHUNK_SIZE;
      const wx = centerX + localX;
      const hmX = Math.round(ix * hmRatio);

      const elev = heightmapData[hmZ * hmStride + hmX];
      const localY = elev - centerY;

      const hL = sampleTerrainGridElevation(wx - normalStep, wz, biomeId, frostMode);
      const hR = sampleTerrainGridElevation(wx + normalStep, wz, biomeId, frostMode);
      const hD = sampleTerrainGridElevation(wx, wz - normalStep, biomeId, frostMode);
      const hU = sampleTerrainGridElevation(wx, wz + normalStep, biomeId, frostMode);

      const nx = hL - hR;
      const ny = 2 * normalStep;
      const nz = hD - hU;
      const invLen = 1 / Math.hypot(nx, ny, nz);

      const idx = iz * gridVertsPerSide + ix;
      positions[idx * 3] = localX;
      positions[idx * 3 + 1] = localY;
      positions[idx * 3 + 2] = localZ;

      normals[idx * 3] = nx * invLen;
      normals[idx * 3 + 1] = ny * invLen;
      normals[idx * 3 + 2] = nz * invLen;

      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = v;
    }
  }

  let skirtOffset = mainVertCount;
  const appendSkirtEdgeVerts = (getEdgeIdx: (k: number) => number) => {
    const startSkirt = skirtOffset;
    for (let k = 0; k <= segments; k++) {
      const srcIdx = getEdgeIdx(k);
      const dstIdx = startSkirt + k;

      positions[dstIdx * 3] = positions[srcIdx * 3];
      positions[dstIdx * 3 + 1] = positions[srcIdx * 3 + 1] - TERRAIN_SKIRT_DEPTH;
      positions[dstIdx * 3 + 2] = positions[srcIdx * 3 + 2];

      normals[dstIdx * 3] = normals[srcIdx * 3];
      normals[dstIdx * 3 + 1] = normals[srcIdx * 3 + 1];
      normals[dstIdx * 3 + 2] = normals[srcIdx * 3 + 2];

      uvs[dstIdx * 2] = uvs[srcIdx * 2];
      uvs[dstIdx * 2 + 1] = uvs[srcIdx * 2 + 1];
    }
    skirtOffset += gridVertsPerSide;
  };

  appendSkirtEdgeVerts((k) => k);
  appendSkirtEdgeVerts((k) => segments * gridVertsPerSide + k);
  appendSkirtEdgeVerts((k) => k * gridVertsPerSide);
  appendSkirtEdgeVerts((k) => k * gridVertsPerSide + segments);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(getSharedLodIndexAttribute(segments));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}

function createSharedSpectralTexture(kind: 'thermal' | 'topographic', maxAnisotropy: number): THREE.CanvasTexture {
  const size = isLowMemoryDevice() ? 256 : 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const s = size / 512;

  if (kind === 'thermal') {
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, '#1e1b4b');
    grad.addColorStop(0.35, '#0284c7');
    grad.addColorStop(0.65, '#059669');
    grad.addColorStop(0.9, '#d97706');
    grad.addColorStop(1, '#dc2626');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
    ctx.lineWidth = Math.max(2, 4 * s);
    for (let y = 30 * s; y < size; y += 42 * s) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.quadraticCurveTo(size * 0.5, y + 24 * s, size, y - 16 * s);
      ctx.stroke();
    }
  } else {
    const grad = ctx.createLinearGradient(0, size, 0, 0);
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(0.3, '#0284c7');
    grad.addColorStop(0.7, '#eab308');
    grad.addColorStop(1, '#dc2626');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = Math.max(1, 2 * s);
    for (let y = 15 * s; y < size; y += 30 * s) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(160 * s, y + 10 * s, 360 * s, y - 10 * s, size, y);
      ctx.stroke();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = Math.min(2, Math.max(1, maxAnisotropy));
  return texture;
}

function getBiomeShaderStyleIndex(biomeId: MarsBiomeId): number {
  if (biomeId === 'PLANUM_BOREUM' || biomeId === 'PLANUM_AUSTRALE') return 4.0;
  if (biomeId === 'OLYMPUS_MONS' || biomeId === 'THARSIS_BULGE' || biomeId === 'SYRTIS_MAJOR') return 1.0;
  if (biomeId === 'VALLES_MARINERIS') return 2.0;
  if (biomeId === 'GALE_CRATER') return 3.0;
  if (biomeId === 'HELLAS_PLANITIA') return 5.0;
  return 0.0;
}

/**
 * Manages chunked THREE.LOD Mars terrain tiles with multi-layered tri-planar procedural PBR shading,
 * automatic frustum culling, spectral mode switching, and strict GPU disposal.
 */
export class MarsTerrainManager {
  public readonly group = new THREE.Group();
  private readonly chunks = new Map<string, TerrainChunk>();
  private readonly maxAnisotropy: number;
  private readonly thermalTexture: THREE.CanvasTexture;
  private readonly topoTexture: THREE.CanvasTexture;
  private pbrMaps: ProceduralPbrMaps;
  private upgradedPbr = false;
  private readonly sharedUniforms: {
    uDetailAlbedo: { value: THREE.DataTexture };
    uDetailNormal: { value: THREE.DataTexture };
    uDetailRoughness: { value: THREE.DataTexture };
    uStrataNormal: { value: THREE.DataTexture };
    uSpectralMode: { value: number };
    uBiomeStyle: { value: number };
    uHazardOverlay: { value: number };
  };
  private spectralMode: TerrainSpectralMode = 'optical';
  private biomeId: MarsBiomeId = 'JEZERO_CRATER';
  private frostMode: SeasonalFrostMode = 'SUBLIMATION';
  private terrainFrameId = getTerrainFrameId();
  private totalCreated = 0;
  private totalDisposed = 0;
  private readonly raycastTargetBuffer: THREE.Mesh[] = [];
  private lastScanCamCx = Number.NaN;
  private lastScanCamCz = Number.NaN;
  private hasPendingChunks = true;
  private lastLodCamX = Number.NaN;
  private lastLodCamZ = Number.NaN;

  constructor(options: {
    maxAnisotropy: number;
    initialSpectralMode?: TerrainSpectralMode;
    initialBiomeId?: MarsBiomeId;
    initialFrostMode?: SeasonalFrostMode;
  }) {
    this.maxAnisotropy = Math.min(2, Math.max(1, options.maxAnisotropy));
    this.spectralMode = options.initialSpectralMode ?? 'optical';
    this.biomeId = options.initialBiomeId ?? 'JEZERO_CRATER';
    this.frostMode = options.initialFrostMode ?? 'SUBLIMATION';
    this.group.name = 'MarsChunkedTerrain';
    this.thermalTexture = createSharedSpectralTexture('thermal', this.maxAnisotropy);
    this.topoTexture = createSharedSpectralTexture('topographic', this.maxAnisotropy);
    // Boot immediately with compact 64x64 procedural PBR maps (<1ms), then upgrade across idle frames
    this.pbrMaps = createProceduralMarsPbrMaps(this.maxAnisotropy, 64);
    this.sharedUniforms = {
      uDetailAlbedo: { value: this.pbrMaps.albedoDetailTex },
      uDetailNormal: { value: this.pbrMaps.normalDetailTex },
      uDetailRoughness: { value: this.pbrMaps.roughnessDetailTex },
      uStrataNormal: { value: this.pbrMaps.strataNormalTex },
      uSpectralMode: {
        value: this.spectralMode === 'thermal' ? 1.0 : this.spectralMode === 'topographic' ? 2.0 : 0.0,
      },
      uBiomeStyle: { value: getBiomeShaderStyleIndex(this.biomeId) },
      uHazardOverlay: { value: getHazardOverlayEnabled() ? 1 : 0 },
    };
  }

  public upgradePbrDetailMaps(): void {
    if (this.upgradedPbr) return;
    this.upgradedPbr = true;
    const targetRes = isLowMemoryDevice() ? 256 : 512;
    const hiResMaps = createProceduralMarsPbrMaps(this.maxAnisotropy, targetRes);
    const prevMaps = this.pbrMaps;
    this.pbrMaps = hiResMaps;
    this.sharedUniforms.uDetailAlbedo.value = hiResMaps.albedoDetailTex;
    this.sharedUniforms.uDetailNormal.value = hiResMaps.normalDetailTex;
    this.sharedUniforms.uDetailRoughness.value = hiResMaps.roughnessDetailTex;
    this.sharedUniforms.uStrataNormal.value = hiResMaps.strataNormalTex;
    prevMaps.albedoDetailTex.dispose();
    prevMaps.normalDetailTex.dispose();
    prevMaps.roughnessDetailTex.dispose();
    prevMaps.strataNormalTex.dispose();
  }

  public setEnvironment(
    biomeId: MarsBiomeId,
    frostMode: SeasonalFrostMode,
    terrainFrameId = 0
  ): boolean {
    if (
      this.biomeId === biomeId &&
      this.frostMode === frostMode &&
      this.terrainFrameId === terrainFrameId
    ) {
      return false;
    }
    this.biomeId = biomeId;
    this.frostMode = frostMode;
    this.terrainFrameId = terrainFrameId;
    this.sharedUniforms.uBiomeStyle.value = getBiomeShaderStyleIndex(biomeId);
    const allChunks = Array.from(this.chunks.values());
    for (const chunk of allChunks) {
      this.disposeChunk(chunk);
    }
    this.chunks.clear();
    this.lastScanCamCx = Number.NaN;
    this.lastScanCamCz = Number.NaN;
    this.hasPendingChunks = true;
    this.lastLodCamX = Number.NaN;
    this.lastLodCamZ = Number.NaN;
    return true;
  }

  public setSpectralMode(mode: TerrainSpectralMode): void {
    if (this.spectralMode === mode) return;
    this.spectralMode = mode;
    this.sharedUniforms.uSpectralMode.value =
      mode === 'thermal' ? 1.0 : mode === 'topographic' ? 2.0 : 0.0;

    this.chunks.forEach((chunk) => {
      this.applySpectralModeToChunk(chunk);
    });
  }

  private applySpectralModeToChunk(chunk: TerrainChunk): void {
    if (this.spectralMode === 'thermal') {
      chunk.material.map = this.thermalTexture;
      chunk.material.color.setHex(0xffffff);
    } else if (this.spectralMode === 'topographic') {
      chunk.material.map = this.topoTexture;
      chunk.material.color.setHex(0xffffff);
    } else {
      chunk.material.map = chunk.diffuseTexture;
      chunk.material.color.setHex(0xffffff);
    }
    chunk.material.needsUpdate = true;
  }

  private createTriplanarTerrainMaterial(
    diffuseTexture: THREE.DataTexture,
    heightmapTexture: THREE.DataTexture
  ): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      map: diffuseTexture,
      bumpMap: heightmapTexture,
      bumpScale: 1.15,
      roughness:
        this.biomeId === 'PLANUM_BOREUM' || this.biomeId === 'PLANUM_AUSTRALE' ? 0.56 : 0.9,
      metalness: 0.05,
      color: 0xffffff,
    });

    const uniforms = this.sharedUniforms;
    material.customProgramCacheKey = () => 'mars-triplanar-pbr-v3-hazard';

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uHazardOverlay = uniforms.uHazardOverlay;
      shader.uniforms.uDetailAlbedo = uniforms.uDetailAlbedo;
      shader.uniforms.uDetailNormal = uniforms.uDetailNormal;
      shader.uniforms.uDetailRoughness = uniforms.uDetailRoughness;
      shader.uniforms.uStrataNormal = uniforms.uStrataNormal;
      shader.uniforms.uSpectralMode = uniforms.uSpectralMode;
      shader.uniforms.uBiomeStyle = uniforms.uBiomeStyle;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vMarsWorldPos;
varying vec3 vMarsWorldNormal;
varying vec3 vMarsViewAxisX;
varying vec3 vMarsViewAxisY;
varying vec3 vMarsViewAxisZ;`
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
vec4 marsWorldPos4 = modelMatrix * vec4( transformed, 1.0 );
vMarsWorldPos = marsWorldPos4.xyz;
vMarsWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
vMarsViewAxisX = normalize( ( viewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz );
vMarsViewAxisY = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
vMarsViewAxisZ = normalize( ( viewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D uDetailAlbedo;
uniform sampler2D uDetailNormal;
uniform sampler2D uDetailRoughness;
uniform sampler2D uStrataNormal;
uniform float uSpectralMode;
uniform float uBiomeStyle;
uniform float uHazardOverlay;
varying vec3 vMarsWorldPos;
varying vec3 vMarsWorldNormal;
varying vec3 vMarsViewAxisX;
varying vec3 vMarsViewAxisY;
varying vec3 vMarsViewAxisZ;

vec4 marsTriplanarSample(sampler2D tex, vec3 wp, vec3 wNorm, float scale) {
  vec3 blend = pow(abs(wNorm), vec3(4.0));
  blend /= max(blend.x + blend.y + blend.z, 0.0001);
  vec4 cx = texture2D(tex, wp.zy * scale);
  vec4 cy = texture2D(tex, wp.xz * scale);
  vec4 cz = texture2D(tex, wp.xy * scale);
  return cx * blend.x + cy * blend.y + cz * blend.z;
}

vec3 marsTriplanarWorldNormalPerturb(sampler2D normTex, vec3 wp, vec3 wNorm, float scale, float strength) {
  vec3 blend = pow(abs(wNorm), vec3(4.0));
  blend /= max(blend.x + blend.y + blend.z, 0.0001);

  vec3 nxSample = texture2D(normTex, wp.zy * scale).xyz * 2.0 - 1.0;
  vec3 nySample = texture2D(normTex, wp.xz * scale).xyz * 2.0 - 1.0;
  vec3 nzSample = texture2D(normTex, wp.xy * scale).xyz * 2.0 - 1.0;

  vec3 px = vec3(0.0, nxSample.y, nxSample.x);
  vec3 py = vec3(nySample.x, 0.0, nySample.y);
  vec3 pz = vec3(nzSample.x, nzSample.y, 0.0);

  return (px * blend.x + py * blend.y + pz * blend.z) * strength;
}`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
vec3 marsAbsNorm = normalize(vMarsWorldNormal);
float marsSlope = clamp(1.0 - marsAbsNorm.y, 0.0, 1.0);
if (uSpectralMode < 0.5) {
  vec3 macroTex = marsTriplanarSample(uDetailAlbedo, vMarsWorldPos, marsAbsNorm, 0.022).rgb;
  vec3 microTex = marsTriplanarSample(uDetailAlbedo, vMarsWorldPos, marsAbsNorm, 0.14).rgb;
  vec3 detailMod = mix(vec3(1.0), macroTex * microTex * 1.15, 0.68);
  diffuseColor.rgb *= detailMod;

  // Wind-rippled sand dunes on gentle slopes & exposed horizontal strata on steep crater/delta walls
  float rippleWave = sin(vMarsWorldPos.x * 0.28 + vMarsWorldPos.z * 0.19 + macroTex.r * 3.8) * 0.5 + 0.5;
  float flatMask = 1.0 - smoothstep(0.05, 0.24, marsSlope);
  float steepMask = smoothstep(0.11, 0.36, marsSlope);

  if (uBiomeStyle < 3.5) {
    // Wind-rippled dune crest highlight & dark basaltic trough contrast
    vec3 duneTint = mix(vec3(0.76, 0.66, 0.62), vec3(1.12, 1.02, 0.92), rippleWave);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * duneTint, flatMask * 0.45);

    // Horizontal sedimentary strata bedding bands on steep crater walls & delta scarps (no UV stretching)
    float strataSample = marsTriplanarSample(uStrataNormal, vMarsWorldPos, marsAbsNorm, 0.055).a;
    float bedding = sin(vMarsWorldPos.y * 1.45 + strataSample * 2.6) * 0.5 + 0.5;
    vec3 strataColor = mix(vec3(0.28, 0.15, 0.11), vec3(0.74, 0.48, 0.33), bedding);
    diffuseColor.rgb = mix(diffuseColor.rgb, strataColor * microTex * 1.18, steepMask * 0.62);
  }

  // Ravine wall / trough edge hazard overlay: amber from ~25% grade, red hazard stripes from ~50%.
  // marsSlope = 1 - cos(tilt): 25% -> 0.03, 50% -> 0.106, 80% -> 0.22
  if (uHazardOverlay > 0.5) {
    float warnMask = smoothstep(0.03, 0.065, marsSlope);
    float critMask = smoothstep(0.106, 0.17, marsSlope);
    float stripe = step(0.5, fract((vMarsWorldPos.x + vMarsWorldPos.z) * 0.1));
    vec3 amber = vec3(1.0, 0.62, 0.12) * (0.78 + 0.22 * stripe);
    vec3 red = vec3(1.0, 0.14, 0.1) * (0.6 + 0.4 * stripe);
    diffuseColor.rgb = mix(diffuseColor.rgb, amber, warnMask * 0.38);
    diffuseColor.rgb = mix(diffuseColor.rgb, red, critMask * 0.62);
  }
}`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
if (uSpectralMode < 0.5) {
  float roughSample = marsTriplanarSample(uDetailRoughness, vMarsWorldPos, normalize(vMarsWorldNormal), 0.085).r;
  float steepBedrock = smoothstep(0.14, 0.38, clamp(1.0 - normalize(vMarsWorldNormal).y, 0.0, 1.0));
  roughnessFactor = clamp(roughnessFactor * mix(0.78, 1.08, roughSample) - steepBedrock * 0.14, 0.38, 0.98);
}`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
if (uSpectralMode < 0.5) {
  vec3 wNorm = normalize(vMarsWorldNormal);
  float steepN = smoothstep(0.08, 0.34, clamp(1.0 - wNorm.y, 0.0, 1.0));
  vec3 worldPerturbFine = marsTriplanarWorldNormalPerturb(uDetailNormal, vMarsWorldPos, wNorm, 0.12, 0.48);
  vec3 worldPerturbStrata = marsTriplanarWorldNormalPerturb(uStrataNormal, vMarsWorldPos, wNorm, 0.048, 0.55 * steepN);
  vec3 wpTotal = worldPerturbFine + worldPerturbStrata;
  vec3 viewPerturb = vMarsViewAxisX * wpTotal.x + vMarsViewAxisY * wpTotal.y + vMarsViewAxisZ * wpTotal.z;
  normal = normalize(normal + viewPerturb);
}`
        );
    };

    return material;
  }

  private createChunk(cx: number, cz: number): TerrainChunk {
    const key = getChunkKey(cx, cz);
    const { centerX, centerY, centerZ, heightmapData, heightmapTexture } = createChunkHeightmap(
      cx,
      cz,
      this.biomeId,
      this.frostMode
    );
    const diffuseTexture = createChunkDiffuseTexture(
      cx,
      cz,
      heightmapData,
      this.maxAnisotropy,
      this.biomeId,
      this.frostMode
    );

    const material = this.createTriplanarTerrainMaterial(diffuseTexture, heightmapTexture);

    const lod = new THREE.LOD();
    lod.name = `MarsTerrainChunk_${key}`;
    lod.position.set(centerX, centerY, centerZ);
    lod.frustumCulled = true;
    lod.autoUpdate = true;
    lod.updateMatrix();
    lod.updateMatrixWorld(true);

    const meshes: THREE.Mesh[] = [];
    const geometries: THREE.BufferGeometry[] = [];

    for (const levelCfg of TERRAIN_LOD_LEVELS) {
      const geom = buildChunkLodGeometry(
        levelCfg.segments,
        heightmapData,
        centerX,
        centerY,
        centerZ,
        this.biomeId,
        this.frostMode
      );
      const mesh = new THREE.Mesh(geom, material);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.frustumCulled = true;

      lod.addLevel(mesh, levelCfg.distance, levelCfg.hysteresis);
      geometries.push(geom);
      meshes.push(mesh);
    }

    const chunk: TerrainChunk = {
      key,
      cx,
      cz,
      centerX,
      centerY,
      centerZ,
      lod,
      meshes,
      geometries,
      material,
      heightmapData,
      heightmapTexture,
      diffuseTexture,
    };

    this.applySpectralModeToChunk(chunk);
    this.group.add(lod);
    this.chunks.set(key, chunk);
    this.totalCreated++;

    return chunk;
  }

  private disposeChunk(chunk: TerrainChunk): void {
    this.group.remove(chunk.lod);

    for (const mesh of chunk.meshes) {
      chunk.lod.remove(mesh);
    }
    chunk.lod.levels.length = 0;

    for (const geom of chunk.geometries) {
      geom.setIndex(null);
      geom.dispose();
    }
    chunk.geometries.length = 0;
    chunk.meshes.length = 0;

    chunk.material.map = null;
    chunk.material.bumpMap = null;
    chunk.material.dispose();

    chunk.heightmapTexture.dispose();
    chunk.diffuseTexture.dispose();

    this.chunks.delete(chunk.key);
    this.totalDisposed++;
  }

  public update(camera: THREE.Camera, forceImmediate = false): void {
    this.sharedUniforms.uHazardOverlay.value = getHazardOverlayEnabled() ? 1 : 0;
    camera.updateMatrixWorld();
    const camCx = Math.round(camera.position.x / TERRAIN_CHUNK_SIZE);
    const camCz = Math.round(camera.position.z / TERRAIN_CHUNK_SIZE);
    const chunkCellChanged = camCx !== this.lastScanCamCx || camCz !== this.lastScanCamCz;

    if (forceImmediate || chunkCellChanged || this.hasPendingChunks) {
      this.lastScanCamCx = camCx;
      this.lastScanCamCz = camCz;

      if (chunkCellChanged || forceImmediate) {
        const unloadRadiusSq =
          ACTIVE_VIEWPORT_UNLOAD_RADIUS_CHUNKS * ACTIVE_VIEWPORT_UNLOAD_RADIUS_CHUNKS;
        const toDispose: TerrainChunk[] = [];
        this.chunks.forEach((chunk) => {
          const dx = chunk.cx - camCx;
          const dz = chunk.cz - camCz;
          if (dx * dx + dz * dz > unloadRadiusSq) {
            toDispose.push(chunk);
          }
        });
        for (let i = 0; i < toDispose.length; i++) {
          this.disposeChunk(toDispose[i]);
        }
      }

      const gridRadius = Math.ceil(ACTIVE_VIEWPORT_LOAD_RADIUS_CHUNKS);
      const loadRadiusSq = ACTIVE_VIEWPORT_LOAD_RADIUS_CHUNKS * ACTIVE_VIEWPORT_LOAD_RADIUS_CHUNKS;
      const pending: Array<{ cx: number; cz: number; distSq: number }> = [];

      for (let dz = -gridRadius; dz <= gridRadius; dz++) {
        for (let dx = -gridRadius; dx <= gridRadius; dx++) {
          const distSq = dx * dx + dz * dz;
          if (distSq > loadRadiusSq) continue;
          const cx = camCx + dx;
          const cz = camCz + dz;
          if (!this.chunks.has(getChunkKey(cx, cz))) {
            pending.push({ cx, cz, distSq });
          }
        }
      }

      if (pending.length > 0) {
        pending.sort((a, b) => a.distSq - b.distSq);
        const budget = forceImmediate
          ? pending.length
          : Math.min(pending.length, MAX_CHUNKS_BUILT_PER_FRAME);
        for (let i = 0; i < budget; i++) {
          const chunk = this.createChunk(pending[i].cx, pending[i].cz);
          chunk.lod.update(camera);
        }
        this.hasPendingChunks = pending.length > budget;
      } else {
        this.hasPendingChunks = false;
      }
    }

    const lodMovedDist = Number.isNaN(this.lastLodCamX)
      ? Infinity
      : Math.hypot(camera.position.x - this.lastLodCamX, camera.position.z - this.lastLodCamZ);
    if (forceImmediate || lodMovedDist > 12) {
      this.lastLodCamX = camera.position.x;
      this.lastLodCamZ = camera.position.z;
      this.chunks.forEach((chunk) => {
        chunk.lod.update(camera);
      });
    }
  }

  public getActiveRaycastMeshes(
    worldX: number,
    worldZ: number,
    radiusMeters = 450
  ): THREE.Mesh[] {
    this.raycastTargetBuffer.length = 0;
    this.chunks.forEach((chunk) => {
      if (
        Math.abs(chunk.centerX - worldX) <= radiusMeters &&
        Math.abs(chunk.centerZ - worldZ) <= radiusMeters
      ) {
        const rawLvl = chunk.lod.getCurrentLevel();
        const lvl = rawLvl >= 0 && rawLvl < chunk.meshes.length ? rawLvl : 0;
        const mesh = chunk.meshes[lvl];
        if (mesh) {
          this.raycastTargetBuffer.push(mesh);
        }
      }
    });
    return this.raycastTargetBuffer;
  }

  public getMetrics(): TerrainManagerMetrics {
    let lod0Count = 0;
    let lod1Count = 0;
    let lod2Count = 0;
    this.chunks.forEach((chunk) => {
      const lvl = chunk.lod.getCurrentLevel();
      if (lvl === 0) lod0Count++;
      else if (lvl === 1) lod1Count++;
      else lod2Count++;
    });

    return {
      activeChunks: this.chunks.size,
      lod0Count,
      lod1Count,
      lod2Count,
      totalCreated: this.totalCreated,
      totalDisposed: this.totalDisposed,
    };
  }

  public disposeAll(): void {
    const allChunks = Array.from(this.chunks.values());
    for (const chunk of allChunks) {
      this.disposeChunk(chunk);
    }
    this.chunks.clear();
    this.thermalTexture.dispose();
    this.topoTexture.dispose();
    this.pbrMaps.albedoDetailTex.dispose();
    this.pbrMaps.normalDetailTex.dispose();
    this.pbrMaps.roughnessDetailTex.dispose();
    this.pbrMaps.strataNormalTex.dispose();
    this.group.parent?.remove(this.group);
  }
}
