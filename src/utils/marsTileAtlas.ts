/**
 * Zero-Network / Offline-First Global Mars Surface Texture Atlas & Local HiRISE DEM Rasterizer.
 *
 * Generates crisp self-contained planetary MDIM optical albedo & MOLA shaded-relief buffers
 * completely in code (zero external WMTS/CDN requests), supporting:
 *  - Spherical Orthographic Globe & Azimuthal Equidistant Regional maps (TacticalMarsMap)
 *  - Custom EPSG:4326 Canvas Tile Rasterizer for offline Leaflet layers (MarsWalkHud)
 *  - Local Jezero Crater HiRISE DEM hillshade & thermal inertia rendering
 */

import {
  sampleTerrainGridElevation,
  orthographicInverse,
  azimuthalMetersToLatLng,
} from '../data/marsTerrain';
import {
  evalPlanetaryTopography,
  normalizeSignedLng180,
} from '../data/marsCartography';
import { getHazardOverlayEnabled } from './hazardOverlayStore';

export type AtlasSpectralMode = 'optical' | 'thermal' | 'topographic';

interface AtlasBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  loaded: boolean;
}

const ATLAS_WIDTH = 512;
const ATLAS_HEIGHT = 256;

let mdimBuffer: AtlasBuffer = {
  width: ATLAS_WIDTH,
  height: ATLAS_HEIGHT,
  data: new Uint8ClampedArray(ATLAS_WIDTH * ATLAS_HEIGHT * 4),
  loaded: false,
};

let molaBuffer: AtlasBuffer = {
  width: ATLAS_WIDTH,
  height: ATLAS_HEIGHT,
  data: new Uint8ClampedArray(ATLAS_WIDTH * ATLAS_HEIGHT * 4),
  loaded: false,
};

const listeners = new Set<() => void>();

function hash2D(ix: number, iy: number): number {
  const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function noise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2D(ix, iy);
  const b = hash2D(ix + 1, iy);
  const c = hash2D(ix, iy + 1);
  const d = hash2D(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/**
 * Evaluates normalized planetary MOLA elevation [0..1] and surface biome factors
 * using the unified Martian topographic elevation model.
 */
function evalPlanetaryRelief(lat: number, lng: number) {
  return evalPlanetaryTopography(lat, lng);
}

function buildProceduralGlobalBuffers() {
  if (mdimBuffer.loaded && molaBuffer.loaded) return;

  const w = ATLAS_WIDTH;
  const h = ATLAS_HEIGHT;
  const mdim = mdimBuffer.data;
  const mola = molaBuffer.data;
  const elevMap = new Float32Array(w * h);

  // First pass: evaluate elevation field
  for (let py = 0; py < h; py++) {
    const lat = 90 - ((py + 0.5) / h) * 180;
    for (let px = 0; px < w; px++) {
      const lng = -180 + ((px + 0.5) / w) * 360;
      const r = evalPlanetaryRelief(lat, lng);
      elevMap[py * w + px] = r.normElev;

      const idx = (py * w + px) * 4;
      let optR = 166;
      let optG = 94;
      let optB = 58;

      if (r.isPolarCap) {
        if (r.isSpiralTrough) {
          optR = 128;
          optG = 72;
          optB = 54;
        } else {
          optR = 232;
          optG = 240;
          optB = 248;
        }
      } else if (r.isSyrtis) {
        optR = 76 + r.grain * 24;
        optG = 50 + r.grain * 16;
        optB = 42 + r.grain * 12;
      } else if (r.isValles) {
        optR = 88 + r.grain * 30;
        optG = 46 + r.grain * 18;
        optB = 34 + r.grain * 12;
      } else if (r.isOlympus) {
        optR = 132 + r.grain * 26;
        optG = 78 + r.grain * 18;
        optB = 60 + r.grain * 14;
      } else if (r.isHellas) {
        optR = 198 + r.grain * 22;
        optG = 142 + r.grain * 18;
        optB = 104 + r.grain * 16;
      } else {
        const highlandShade = r.normElev > 0.42 ? 1.06 : 0.92;
        const darkStreak = r.grain < 0.36 ? 0.72 : 1.0;
        optR = (158 + r.grain * 44) * highlandShade * darkStreak;
        optG = (88 + r.grain * 28) * highlandShade * darkStreak;
        optB = (54 + r.grain * 18) * highlandShade * darkStreak;
      }

      mdim[idx] = Math.max(0, Math.min(255, Math.round(optR)));
      mdim[idx + 1] = Math.max(0, Math.min(255, Math.round(optG)));
      mdim[idx + 2] = Math.max(0, Math.min(255, Math.round(optB)));
      mdim[idx + 3] = 255;
    }
  }

  // Second pass: directional NW hillshading on MOLA hypsometric color ramp & optical MDIM
  for (let py = 0; py < h; py++) {
    const pyU = Math.max(0, py - 1);
    const pyD = Math.min(h - 1, py + 1);
    for (let px = 0; px < w; px++) {
      const pxL = (px - 1 + w) % w;
      const pxR = (px + 1) % w;
      const dhdx = (elevMap[py * w + pxR] - elevMap[py * w + pxL]) * 9.5;
      const dhdy = (elevMap[pyD * w + px] - elevMap[pyU * w + px]) * 9.5;
      const invL = 1 / Math.hypot(-dhdx, -dhdy, 1);
      const shade = Math.max(
        0.58,
        Math.min(1.24, 0.78 + ((-dhdx * invL) * -0.55 + (-dhdy * invL) * -0.45 + invL * 0.7) * 0.48)
      );

      const idx = (py * w + px) * 4;
      mdim[idx] = Math.min(255, Math.round(mdim[idx] * shade));
      mdim[idx + 1] = Math.min(255, Math.round(mdim[idx + 1] * shade));
      mdim[idx + 2] = Math.min(255, Math.round(mdim[idx + 2] * shade));

      const e = elevMap[py * w + px];
      let mr = 32;
      let mg = 74;
      let mb = 152;
      if (e < 0.25) {
        const u = e / 0.25;
        mr = 22 + u * 20;
        mg = 52 + u * 86;
        mb = 148 + u * 34;
      } else if (e < 0.5) {
        const u = (e - 0.25) / 0.25;
        mr = 42 + u * 144;
        mg = 138 + u * 38;
        mb = 182 - u * 118;
      } else if (e < 0.78) {
        const u = (e - 0.5) / 0.28;
        mr = 186 + u * 40;
        mg = 176 - u * 88;
        mb = 64 - u * 22;
      } else {
        const u = (e - 0.78) / 0.22;
        mr = 226 + u * 24;
        mg = 88 + u * 136;
        mb = 42 + u * 172;
      }

      mola[idx] = Math.max(0, Math.min(255, Math.round(mr * shade)));
      mola[idx + 1] = Math.max(0, Math.min(255, Math.round(mg * shade)));
      mola[idx + 2] = Math.max(0, Math.min(255, Math.round(mb * shade)));
      mola[idx + 3] = 255;
    }
  }

  mdimBuffer.loaded = true;
  molaBuffer.loaded = true;
}

export function ensureMarsAtlasLoaded(onReady?: () => void): () => void {
  if (!mdimBuffer.loaded || !molaBuffer.loaded) {
    buildProceduralGlobalBuffers();
  }
  if (onReady) {
    listeners.add(onReady);
    // Notify on next microtask/frame cleanly without blocking
    Promise.resolve().then(() => {
      if (listeners.has(onReady)) onReady();
    });
  }
  return () => {
    if (onReady) listeners.delete(onReady);
  };
}

export function isMarsAtlasReady(mode: AtlasSpectralMode): boolean {
  if (!mdimBuffer.loaded || !molaBuffer.loaded) {
    buildProceduralGlobalBuffers();
  }
  if (mode === 'topographic') return molaBuffer.loaded;
  if (mode === 'optical') return mdimBuffer.loaded;
  return mdimBuffer.loaded || molaBuffer.loaded;
}

function sampleBufferBilinear(buf: AtlasBuffer, lat: number, lng: number): [number, number, number] {
  const normLng = normalizeSignedLng180(lng);
  const u = Math.max(0, Math.min(0.9999, (normLng + 180) / 360));
  const v = Math.max(0, Math.min(0.9999, (90 - lat) / 180));

  const fx = u * (buf.width - 1);
  const fy = v * (buf.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = (x0 + 1) % buf.width;
  const y1 = Math.min(buf.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const i00 = (y0 * buf.width + x0) * 4;
  const i10 = (y0 * buf.width + x1) * 4;
  const i01 = (y1 * buf.width + x0) * 4;
  const i11 = (y1 * buf.width + x1) * 4;

  const d = buf.data;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  return [
    d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11,
    d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11,
    d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11,
  ];
}

export function sampleMarsPlanetPixel(
  lat: number,
  lng: number,
  mode: AtlasSpectralMode
): [number, number, number] {
  if (!mdimBuffer.loaded || !molaBuffer.loaded) {
    buildProceduralGlobalBuffers();
  }

  if (mode === 'optical') {
    return sampleBufferBilinear(mdimBuffer, lat, lng);
  }
  if (mode === 'topographic') {
    return sampleBufferBilinear(molaBuffer, lat, lng);
  }
  // Thermal inertia mode derived from albedo buffer
  const [r, g, b] = sampleBufferBilinear(mdimBuffer, lat, lng);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const thermalInertia = Math.max(0, Math.min(1, 1.12 - lum * 1.15));
  if (thermalInertia < 0.33) {
    const t = thermalInertia / 0.33;
    return [Math.round(28 + t * 8), Math.round(32 + t * 92), Math.round(98 + t * 92)];
  }
  if (thermalInertia < 0.66) {
    const t = (thermalInertia - 0.33) / 0.33;
    return [Math.round(36 + t * 185), Math.round(124 + t * 38), Math.round(190 - t * 145)];
  }
  const t = (thermalInertia - 0.66) / 0.34;
  return [Math.round(221 + t * 22), Math.round(162 - t * 105), Math.round(45 - t * 15)];
}

/**
 * Renders a self-contained EPSG:4326 planetary map tile directly onto a Leaflet GridLayer canvas.
 * Zero network fetches — renders instantaneously offline & on 3G.
 */
export function renderProceduralMarsTile(
  canvas: HTMLCanvasElement,
  z: number,
  x: number,
  y: number,
  mode: 'optical' | 'hillshade'
) {
  if (!mdimBuffer.loaded || !molaBuffer.loaded) {
    buildProceduralGlobalBuffers();
  }

  const size = 256;
  const sampleStep = 4; // 64x64 raster upscaled smoothly -> <1.5ms per tile
  const rw = size / sampleStep;
  const rh = size / sampleStep;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Leaflet L.CRS.EPSG4326 default tiling: zoom z has 2^(z+1) columns across 360° and 2^z rows across 180°
  const tilesX = Math.pow(2, z + 1);
  const tilesY = Math.pow(2, z);
  const degPerTileX = 360 / tilesX;
  const degPerTileY = 180 / tilesY;

  const minLng = -180 + x * degPerTileX;
  const maxLat = 90 - y * degPerTileY;

  if (x < 0 || x >= tilesX || y < 0 || y >= tilesY) {
    ctx.clearRect(0, 0, size, size);
    return;
  }

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = rw;
  tmpCanvas.height = rh;
  const tmpCtx = tmpCanvas.getContext('2d');
  if (!tmpCtx) return;

  const img = tmpCtx.createImageData(rw, rh);
  const out = img.data;
  const buf = mode === 'hillshade' ? molaBuffer : mdimBuffer;
  const highZoomDetail = z >= 5;

  for (let py = 0; py < rh; py++) {
    const lat = maxLat - ((py + 0.5) / rh) * degPerTileY;
    for (let px = 0; px < rw; px++) {
      const lng = minLng + ((px + 0.5) / rw) * degPerTileX;
      const [baseR, baseG, baseB] = sampleBufferBilinear(buf, lat, lng);
      let r = baseR;
      let g = baseG;
      let b = baseB;

      // Procedural micro-crater / regolith detail when zoomed into Jezero or regional sites
      if (highZoomDetail) {
        const fine = (noise2(lng * (2.5 * Math.min(16, z)), lat * (2.5 * Math.min(16, z))) - 0.5) * 26;
        const microRipple = Math.sin(lng * 38 + lat * 26) * 5;
        r = Math.max(0, Math.min(255, r + fine + microRipple));
        g = Math.max(0, Math.min(255, g + fine * 0.72 + microRipple * 0.6));
        b = Math.max(0, Math.min(255, b + fine * 0.5 + microRipple * 0.4));
      }

      const idx = (py * rw + px) * 4;
      out[idx] = r;
      out[idx + 1] = g;
      out[idx + 2] = b;
      out[idx + 3] = 255;
    }
  }

  tmpCtx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmpCanvas, 0, 0, size, size);
}

let _scratchCanvas: HTMLCanvasElement | null = null;
let _scratchCtx: CanvasRenderingContext2D | null = null;
let _scratchImg: ImageData | null = null;
let _scratchW = 0;
let _scratchH = 0;

function getScratchRasterTarget(rw: number, rh: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  img: ImageData;
} | null {
  if (!_scratchCanvas) {
    _scratchCanvas = document.createElement('canvas');
    _scratchCtx = _scratchCanvas.getContext('2d');
  }
  if (!_scratchCtx) return null;
  if (_scratchW !== rw || _scratchH !== rh || !_scratchImg) {
    _scratchW = rw;
    _scratchH = rh;
    _scratchCanvas.width = rw;
    _scratchCanvas.height = rh;
    _scratchImg = _scratchCtx.createImageData(rw, rh);
  }
  return { canvas: _scratchCanvas, ctx: _scratchCtx, img: _scratchImg };
}

/**
 * Renders a spherical Orthographic Mars globe centered on `centerLatLng`,
 * rotated by `rotationDeg` (0 = North-Up, -heading = Heading-Up).
 */
export function renderOrthographicMarsGlobe(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  centerLatLng: { lat: number; lng: number },
  radiusPx: number,
  rotationDeg: number,
  mode: AtlasSpectralMode,
  rasterRes = 156
) {
  if (!mdimBuffer.loaded || !molaBuffer.loaded) {
    buildProceduralGlobalBuffers();
  }

  const scratch = getScratchRasterTarget(rasterRes, rasterRes);
  if (!scratch) return;

  const { canvas: tmpCanvas, ctx: tmpCtx, img } = scratch;
  const out = img.data;
  const half = rasterRes / 2;
  const rotRad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);

  for (let py = 0; py < rasterRes; py++) {
    const sy = (half - py) / half;
    for (let px = 0; px < rasterRes; px++) {
      const sx = (px - half) / half;
      const r2 = sx * sx + sy * sy;
      const idx = (py * rasterRes + px) * 4;
      if (r2 > 1) {
        out[idx + 3] = 0;
        continue;
      }

      const nx = sx * cosR + sy * sinR;
      const ny = -sx * sinR + sy * cosR;

      const geo = orthographicInverse(nx, ny, centerLatLng);
      if (!geo) {
        out[idx + 3] = 0;
        continue;
      }

      const [r, g, b] = sampleMarsPlanetPixel(geo.lat, geo.lng, mode);
      const cosLimb = Math.sqrt(Math.max(0, 1 - r2));
      const limbShade = 0.56 + 0.44 * Math.pow(cosLimb, 0.48);

      out[idx] = Math.min(255, Math.round(r * limbShade));
      out[idx + 1] = Math.min(255, Math.round(g * limbShade));
      out[idx + 2] = Math.min(255, Math.round(b * limbShade));
      out[idx + 3] = 255;
    }
  }

  tmpCtx.putImageData(img, 0, 0);
  const cx = width / 2;
  const cy = height / 2;
  ctx.drawImage(tmpCanvas, cx - radiusPx, cy - radiusPx, radiusPx * 2, radiusPx * 2);
}

/**
 * Renders a cosine-corrected Azimuthal Equidistant Regional Mars raster
 * centered on `originLatLng` rotated by `rotationDeg`.
 */
export function renderRegionalAzimuthalMars(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  originLatLng: { lat: number; lng: number },
  metersPerPx: number,
  panScreenX: number,
  panScreenY: number,
  rotationDeg: number,
  mode: AtlasSpectralMode,
  rasterStep = 3
) {
  if (!mdimBuffer.loaded || !molaBuffer.loaded) {
    buildProceduralGlobalBuffers();
  }

  const rw = Math.max(48, Math.ceil(width / rasterStep));
  const rh = Math.max(48, Math.ceil(height / rasterStep));
  const scratch = getScratchRasterTarget(rw, rh);
  if (!scratch) return;

  const { canvas: tmpCanvas, ctx: tmpCtx, img } = scratch;
  const out = img.data;
  const centerX = width / 2 + panScreenX;
  const centerY = height / 2 + panScreenY;
  const rotRad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);

  for (let py = 0; py < rh; py++) {
    const screenY = (py + 0.5) * rasterStep;
    const dyScreen = centerY - screenY;
    for (let px = 0; px < rw; px++) {
      const screenX = (px + 0.5) * rasterStep;
      const dxScreen = screenX - centerX;

      const dxEastM = (dxScreen * cosR + dyScreen * sinR) * metersPerPx;
      const dyNorthM = (-dxScreen * sinR + dyScreen * cosR) * metersPerPx;

      const geo = azimuthalMetersToLatLng(dxEastM, dyNorthM, originLatLng);
      const [r, g, b] = sampleMarsPlanetPixel(geo.lat, geo.lng, mode);
      const idx = (py * rw + px) * 4;
      out[idx] = r;
      out[idx + 1] = g;
      out[idx + 2] = b;
      out[idx + 3] = 255;
    }
  }

  tmpCtx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmpCanvas, 0, 0, width, height);
}

/**
 * Rasterizes local Jezero Crater HiRISE DEM elevation (getMarsElevation) with directional hillshading,
 * slope steepness, and THEMIS thermal inertia contrast onto the Sector mini-map canvas.
 */
export function renderLocalHiRiseDem(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  astronautX: number,
  astronautY: number,
  pxPerMeter: number,
  panScreenX: number,
  panScreenY: number,
  rotationDeg: number,
  mode: AtlasSpectralMode,
  sampleStep = 3
) {
  const rw = Math.max(48, Math.ceil(width / sampleStep));
  const rh = Math.max(48, Math.ceil(height / sampleStep));
  const scratch = getScratchRasterTarget(rw, rh);
  if (!scratch) return;

  const { canvas: tmpCanvas, ctx: tmpCtx, img } = scratch;
  const out = img.data;
  const centerX = width / 2 + panScreenX;
  const centerY = height / 2 + panScreenY;
  const rotRad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const gradStep = Math.max(6, sampleStep / Math.max(0.05, pxPerMeter));
  const hazardOverlay = getHazardOverlayEnabled() && mode !== 'topographic';

  for (let py = 0; py < rh; py++) {
    const sy = centerY - (py + 0.5) * sampleStep;
    for (let px = 0; px < rw; px++) {
      const sx = (px + 0.5) * sampleStep - centerX;
      const wx = astronautX + (sx * cosR + sy * sinR) / pxPerMeter;
      const wz = astronautY + (-sx * sinR + sy * cosR) / pxPerMeter;

      const h0 = sampleTerrainGridElevation(wx, wz);
      const hx = sampleTerrainGridElevation(wx + gradStep, wz);
      const hz = sampleTerrainGridElevation(wx, wz + gradStep);
      const dhdx = (hx - h0) / gradStep;
      const dhdz = (hz - h0) / gradStep;
      const slope = Math.hypot(dhdx, dhdz);

      const len = Math.hypot(-dhdx, 1, -dhdz);
      const nx = -dhdx / len;
      const ny = 1 / len;
      const nz = -dhdz / len;
      const shade = Math.max(0.42, Math.min(1.22, 0.65 + (nx * -0.58 + ny * 0.64 + nz * 0.5) * 0.62));

      let r = 130;
      let g = 62;
      let b = 42;

      if (mode === 'topographic') {
        const t = Math.max(0, Math.min(1, h0 / 155));
        if (t < 0.25) {
          const u = t / 0.25;
          r = 18 + u * 18;
          g = 46 + u * 88;
          b = 112 + u * 64;
        } else if (t < 0.55) {
          const u = (t - 0.25) / 0.3;
          r = 36 + u * 168;
          g = 134 + u * 36;
          b = 176 - u * 124;
        } else {
          const u = (t - 0.55) / 0.45;
          r = 204 + u * 34;
          g = 170 - u * 102;
          b = 52 - u * 12;
        }
        if (Math.abs((h0 % 12) - 6) < 0.6) {
          r *= 1.15;
          g *= 1.15;
          b *= 1.15;
        }
      } else if (mode === 'thermal') {
        const bedrockExposure = Math.min(1, slope * 3.8 + (h0 > 55 ? 0.22 : 0));
        const ti = Math.max(0, Math.min(1, bedrockExposure * 0.78 + (1 - Math.sin(wx * 0.015 + wz * 0.015) * 0.5) * 0.22));
        if (ti < 0.4) {
          const u = ti / 0.4;
          r = 26 + u * 22;
          g = 28 + u * 116;
          b = 112 + u * 64;
        } else if (ti < 0.72) {
          const u = (ti - 0.4) / 0.32;
          r = 48 + u * 185;
          g = 144 + u * 28;
          b = 176 - u * 136;
        } else {
          const u = (ti - 0.72) / 0.28;
          r = 233 + u * 18;
          g = 172 - u * 118;
          b = 40 - u * 12;
        }
      } else {
        const rockBlend = Math.min(1, Math.max(0, (slope - 0.14) * 3.6));
        const dune = Math.sin(wx * 0.04 + wz * 0.03) * 8;
        r = (158 + dune) * (1 - rockBlend) + 84 * rockBlend;
        g = (76 + dune * 0.6) * (1 - rockBlend) + 52 * rockBlend;
        b = (48 + dune * 0.4) * (1 - rockBlend) + 44 * rockBlend;
      }

      // Ravine wall / trough hazard overlay on the sector minimap (same thresholds as the 3D terrain)
      if (hazardOverlay && slope >= 0.25) {
        const crit = Math.min(1, (slope - 0.25) / 0.3);
        const stripe = Math.floor((wx + wz) * 0.1) % 2 === 0 ? 1 : 0.78;
        const hr = (crit > 0.5 ? 255 : 255) * stripe;
        const hg = (crit > 0.5 ? 40 : 160) * stripe;
        const hb = (crit > 0.5 ? 30 : 36) * stripe;
        const k = 0.35 + crit * 0.35;
        r = r * (1 - k) + hr * k;
        g = g * (1 - k) + hg * k;
        b = b * (1 - k) + hb * k;
      }

      const idx = (py * rw + px) * 4;
      out[idx] = Math.max(0, Math.min(255, Math.round(r * shade)));
      out[idx + 1] = Math.max(0, Math.min(255, Math.round(g * shade)));
      out[idx + 2] = Math.max(0, Math.min(255, Math.round(b * shade)));
      out[idx + 3] = 255;
    }
  }

  tmpCtx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmpCanvas, 0, 0, width, height);
}
