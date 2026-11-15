/**
 * Global geomorphology layer.
 *
 * The real MOLA elevation is only ~463 m/px (and ~15 km/px between the detailed windows), so
 * most of the planet would read as flat desert. This layer adds the landforms that real Martian
 * terrain actually has, chosen by terrain class and generated deterministically in world space
 * so the near terrain and the distant horizon rings always agree:
 *   - impact craters over a wide size range (bowls, raised rims, ejecta)
 *   - hills, ridges and rugged walls (strength follows the real local slope)
 *   - wrinkle ridges, wind-aligned dunes / yardangs, flat-topped mesas, polar troughs
 * Everything below the real data's resolution is generated texture, not NASA data.
 */
import type { MarsBiomeId } from '../types/telemetry';

export type GeoClass = 'HIGHLANDS' | 'LOWLANDS' | 'VOLCANIC' | 'CANYON' | 'POLAR' | 'BASIN' | 'NONE';

interface GeoParams {
  crater: number; // crater density multiplier
  hills: number; // hill / rugged-relief amplitude multiplier
  ridges: number; // wrinkle-ridge / polar-trough strength
  dunes: number; // wind-aligned dune amplitude multiplier
  mesas: number; // mesa / butte frequency multiplier
  windDeg: number;
}

const PARAMS: Record<GeoClass, GeoParams> = {
  HIGHLANDS: { crater: 1.35, hills: 1.0, ridges: 0.25, dunes: 0.25, mesas: 0.2, windDeg: 274 },
  LOWLANDS: { crater: 0.3, hills: 0.35, ridges: 1.0, dunes: 1.0, mesas: 1.0, windDeg: 295 },
  VOLCANIC: { crater: 0.15, hills: 1.7, ridges: 0.5, dunes: 0.15, mesas: 0.3, windDeg: 285 },
  CANYON: { crater: 0.35, hills: 1.5, ridges: 0.3, dunes: 0.4, mesas: 0.5, windDeg: 94 },
  POLAR: { crater: 0.08, hills: 0.4, ridges: 1.4, dunes: 0.5, mesas: 0.0, windDeg: 18 },
  BASIN: { crater: 0.7, hills: 0.7, ridges: 0.6, dunes: 0.8, mesas: 0.6, windDeg: 225 },
  NONE: { crater: 0, hills: 0, ridges: 0, dunes: 0, mesas: 0, windDeg: 0 },
};

export function geoClassForBiome(biome: MarsBiomeId): GeoClass {
  switch (biome) {
    case 'OLYMPUS_MONS':
    case 'THARSIS_BULGE':
      return 'VOLCANIC';
    case 'VALLES_MARINERIS':
      return 'CANYON';
    case 'SOUTHERN_HIGHLANDS':
      return 'HIGHLANDS';
    case 'NORTHERN_LOWLANDS':
    case 'SYRTIS_MAJOR':
      return 'LOWLANDS';
    case 'PLANUM_BOREUM':
    case 'PLANUM_AUSTRALE':
      return 'POLAR';
    default:
      return 'BASIN'; // Hellas, Gale, Jezero
  }
}

function hash2(ix: number, iz: number): number {
  const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function vnoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-9, e1 - e0)));
  return t * t * (3 - 2 * t);
}

function ridged(x: number, z: number, wavelength: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let wl = wavelength;
  for (let i = 0; i < octaves; i++) {
    const c = Math.cos(0.7 * i + 0.3);
    const s = Math.sin(0.7 * i + 0.3);
    const n = vnoise((x * c - z * s) / wl + i * 13.7, (x * s + z * c) / wl - i * 7.1);
    const r = 1 - Math.abs(2 * n - 1);
    sum += r * r * amp;
    norm += amp;
    amp *= 0.5;
    wl *= 0.5;
  }
  return sum / norm; // 0..1
}

interface CraterScale {
  cell: number;
  maxR: number;
  density: number;
  depth: number; // depth / radius
}

// Small craters are shallower (degraded) so slopes stay drivable; the 14 m terrain grid cannot
// resolve craters under ~100 m across anyway, so the smallest scale is left to the fractal layer.
const CRATER_SCALES: CraterScale[] = [
  { cell: 28000, maxR: 11000, density: 0.5, depth: 0.12 },
  { cell: 9000, maxR: 3800, density: 0.55, depth: 0.13 },
  { cell: 3200, maxR: 1300, density: 0.5, depth: 0.13 },
  { cell: 1100, maxR: 430, density: 0.45, depth: 0.11 },
  { cell: 380, maxR: 150, density: 0.4, depth: 0.09 },
];

function craterLayer(x: number, z: number, s: CraterScale, density: number, seed: number): number {
  const cx = Math.floor(x / s.cell);
  const cz = Math.floor(z / s.cell);
  let h = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ix = cx + dx;
      const iz = cz + dz;
      if (hash2(ix + seed, iz * 1.3 + seed) > density) continue;
      const px = (ix + hash2(ix * 1.7 + seed, iz + 3.1)) * s.cell;
      const pz = (iz + hash2(ix + 9.2, iz * 2.3 + seed)) * s.cell;
      const sz = hash2(ix * 3.3 + seed, iz * 0.7 + 5.5);
      const R = s.maxR * (0.3 + 0.7 * sz * sz);
      const d = Math.hypot(x - px, z - pz) / R;
      if (d > 2.4) continue;
      const depth = R * s.depth * (0.75 + 0.5 * hash2(ix + 2.2, iz + seed));
      if (d < 1) {
        // bowl with a flattened floor
        const bowl = 1 - d * d;
        h -= depth * (bowl > 0.55 ? 0.55 + (bowl - 0.55) * 0.5 : bowl);
      }
      h += depth * 0.38 * Math.exp(-Math.pow((d - 1.04) / 0.26, 2)); // raised rim
      if (d > 1.25) h += depth * 0.1 * Math.exp(-(d - 1.25) * 2.2); // ejecta apron
    }
  }
  return h;
}

/**
 * Geomorphic relief in metres at a world position. `rough` (~0.3..1.8) is the local ruggedness
 * derived from the real slope; `minWavelength` drops features a coarse mesh cannot represent.
 */
export function geomorphDetail(
  x: number,
  z: number,
  cls: GeoClass,
  rough: number,
  minWavelength: number
): number {
  if (cls === 'NONE') return 0;
  const p = PARAMS[cls];
  let h = 0;

  // Impact craters, large to small
  if (p.crater > 0) {
    for (let i = 0; i < CRATER_SCALES.length; i++) {
      const s = CRATER_SCALES[i];
      if (s.maxR * 2 < minWavelength * 1.5) continue;
      h += craterLayer(x, z, s, Math.min(0.8, s.density * p.crater), 3 + i * 7);
    }
  }

  // Hills, ridges and rugged relief
  if (p.hills > 0 && minWavelength < 3000) {
    const amp = p.hills * (35 + 150 * rough);
    h += (ridged(x, z, 6500, 3) - 0.35) * amp;
    if (minWavelength < 900) h += (ridged(x + 4000, z - 2500, 1800, 3) - 0.35) * amp * 0.35;
    if (cls === 'CANYON' && minWavelength < 400) h += (ridged(x, z, 650, 3) - 0.35) * 60 * rough;
  }

  const w = (p.windDeg * Math.PI) / 180;
  const sinW = Math.sin(w);
  const cosW = Math.cos(w);
  const along = x * sinW + z * cosW;
  const across = x * cosW - z * sinW;

  // Wrinkle ridges (lowlands/basins) and polar troughs
  if (p.ridges > 0 && minWavelength < 2500) {
    if (cls === 'POLAR') {
      const t = Math.sin(((across / 9000 + vnoise(along / 14000, across / 9000) * 0.8) * Math.PI) * 2);
      if (t > 0.5) h -= Math.pow((t - 0.5) / 0.5, 1.3) * 95 * p.ridges;
    } else {
      const u = across / 4200 + vnoise(along / 20000, across / 9000) * 0.9;
      h += Math.pow(1 - Math.abs(Math.sin(u * Math.PI)), 7) * 24 * p.ridges;
    }
  }

  // Wind-aligned dunes / yardangs
  if (p.dunes > 0 && minWavelength < 90) {
    const wob = vnoise(across / 200, along / 420) * 3;
    const mask = smoothstep(0.35, 0.65, vnoise(x / 1400 + 3, z / 1400 - 5));
    // ~180 m crests, up to ~2.5 m high (about 9% grade): visible ripples, still drivable
    h += Math.sin((along * Math.PI * 2) / 180 + wob) * (0.7 + 1.8 * vnoise(x / 700, z / 700)) * p.dunes * mask;
  }

  // Flat-topped mesas and buttes
  if (p.mesas > 0 && minWavelength < 1600) {
    const cell = 9000;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ix = cx + dx;
        const iz = cz + dz;
        if (hash2(ix + 31, iz * 1.9 + 4) > 0.26 * p.mesas) continue;
        const px = (ix + hash2(ix * 2.1, iz + 8.8)) * cell;
        const pz = (iz + hash2(ix + 6.6, iz * 3.7)) * cell;
        const R = 450 + 1100 * hash2(ix * 5.1 + 2, iz * 1.1);
        const H = 25 + 85 * hash2(ix + 41, iz * 2.9 + 1);
        // flat top inside 0.62 R, smooth shoulder out to R (smoothstep needs ascending edges)
        h += H * (1 - smoothstep(R * 0.62, R, Math.hypot(x - px, z - pz)));
      }
    }
  }

  return h;
}
