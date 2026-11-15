/**
 * Global Planetary Cartography, Landmark Database & Traversal Routing Engine for Mars.
 * Uses Martian Areographic coordinates (Latitude -90..90, Longitude -180..180 for projection
 * and 0..360°E Areocentric East convention) on a spherical Mars datum (R = 3,389.5 km).
 */

import { sampleMolaMeters } from './marsDem';

export type LandformCategory =
  | 'volcano'
  | 'canyon'
  | 'crater'
  | 'delta'
  | 'plains'
  | 'ridge'
  | 'polar'
  | 'highlands'
  | 'aeolian'
  | 'fluvial';

export type LandmarkTier = 'primary' | 'regional' | 'surface';
export type TraversalDifficulty = 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';

export interface MarsLandform {
  id: string;
  name: string;
  tier: LandmarkTier;
  region: string;
  category: LandformCategory;
  lat: number; // -90 to +90
  lng: number; // -180 to +180 (for Leaflet EPSG:4326)
  elevationMeters: number; // MOLA datum elevation in meters
  dimensions: {
    verticalMetric: string; // e.g. "~22–26 km high" or "8–10 km deep"
    horizontalMetric: string; // e.g. "~600 km wide base" or "3,000–5,000 km span"
  };
  scienceSummary: string;
  visualCharacteristics: string;
  terrainConstraints: string[];
  weatherProfile: string;
  difficulty: TraversalDifficulty;
  adjacentIds: string[];
}

export interface RegionalZoneOverlay {
  id: string;
  name: string;
  kind: 'polygon' | 'polyline' | 'circle';
  colorHex: string;
  points: Array<[number, number]>; // [lat, lng]
  radiusMeters?: number;
  subtitle: string;
}

export interface RouteSegment {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  distanceKm: number;
  bearingDeg: number;
  elevationDeltaMeters: number;
  difficulty: TraversalDifficulty;
  hazards: string[];
  points: Array<{ lat: number; lng: number }>;
}

export interface PlanetaryRoutePlan {
  originId: string;
  originName: string;
  originLatLng: { lat: number; lng: number };
  originElevationMeters: number;
  destinationId: string;
  destinationName: string;
  destinationLatLng: { lat: number; lng: number };
  destinationElevationMeters: number;
  directDistanceKm: number;
  corridorDistanceKm: number;
  initialBearingDeg: number;
  elevationDeltaMeters: number;
  overallDifficulty: TraversalDifficulty;
  directEtaMinutes: number;
  corridorEtaMinutes: number;
  corridorNodeIds: string[];
  segments: RouteSegment[];
  constraintsSummary: string[];
  logisticalAdvisory: string;
}

export const MARS_RADIUS_KM = 3389.5;
export const MARS_METERS_PER_DEG_LAT = (Math.PI / 180) * MARS_RADIUS_KM * 1000;

export const LANDFORM_CATEGORY_COLORS: Record<
  LandformCategory,
  { hex: string; num: number; label: string }
> = {
  volcano: { hex: '#fb7185', num: 0xfb7185, label: 'Volcanic Shield' },
  canyon: { hex: '#f59e0b', num: 0xf59e0b, label: 'Tectonic Canyon' },
  crater: { hex: '#38bdf8', num: 0x38bdf8, label: 'Impact Crater' },
  delta: { hex: '#5dffa0', num: 0x5dffa0, label: 'Fluvial Delta' },
  plains: { hex: '#a78bfa', num: 0xa78bfa, label: 'Planitia Basin' },
  ridge: { hex: '#facc15', num: 0xfacc15, label: 'Mineral Ridge' },
  polar: { hex: '#e0f2fe', num: 0xe0f2fe, label: 'Polar Ice Cap' },
  highlands: { hex: '#fb923c', num: 0xfb923c, label: 'Ancient Highlands' },
  aeolian: { hex: '#fcd34d', num: 0xfcd34d, label: 'Aeolian Dune Field' },
  fluvial: { hex: '#2dd4bf', num: 0x2dd4bf, label: 'Ancient River Valley' },
};

export function toEastLongitude360(lng: number): number {
  return ((lng % 360) + 360) % 360;
}

export function normalizeSignedLng180(lng: number): number {
  const w = (((lng + 180) % 360) + 360) % 360 - 180;
  return w === -180 && lng > 0 ? 180 : w;
}

export function formatAreographicCoords(lat: number, lng: number): string {
  const latStr = `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'}`;
  const eastLon = toEastLongitude360(lng);
  return `${latStr}, ${eastLon.toFixed(2)}° E`;
}

export interface UnitVec3 {
  x: number;
  y: number;
  z: number;
}

export function shortestLngDeltaDeg(fromLng: number, toLng: number): number {
  return ((((toLng - fromLng + 180) % 360) + 360) % 360) - 180;
}

export function latLngToUnitVec(p: { lat: number; lng: number }): UnitVec3 {
  const degToRad = Math.PI / 180;
  const latR = Math.max(-90, Math.min(90, p.lat)) * degToRad;
  const lngR = normalizeSignedLng180(p.lng) * degToRad;
  const cosLat = Math.cos(latR);
  return {
    x: cosLat * Math.cos(lngR),
    y: cosLat * Math.sin(lngR),
    z: Math.sin(latR),
  };
}

export function unitVecToLatLng(v: UnitVec3): { lat: number; lng: number } {
  const mag = Math.hypot(v.x, v.y, v.z) || 1;
  const nx = v.x / mag;
  const ny = v.y / mag;
  const nz = Math.max(-1, Math.min(1, v.z / mag));
  const radToDeg = 180 / Math.PI;
  const lat = Math.asin(nz) * radToDeg;
  const lng = Math.atan2(ny, nx) * radToDeg;
  return {
    lat: Math.max(-90, Math.min(90, lat)),
    lng: normalizeSignedLng180(lng),
  };
}

/**
 * Spherical Linear Interpolation (Slerp) on the Martian sphere (R = 3,389.5 km).
 * Immune to ±180° antimeridian wrapping and ±90° polar singularities.
 */
export function slerpLatLng(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  t: number
): { lat: number; lng: number } {
  const clampedT = Math.max(0, Math.min(1, t));
  if (clampedT <= 0) return { lat: Math.max(-90, Math.min(90, from.lat)), lng: normalizeSignedLng180(from.lng) };
  if (clampedT >= 1) return { lat: Math.max(-90, Math.min(90, to.lat)), lng: normalizeSignedLng180(to.lng) };

  const a = latLngToUnitVec(from);
  const b = latLngToUnitVec(to);
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));

  if (dot > 0.999999999) {
    // Nearly identical points: normalized linear interpolation avoids sin(omega) ~ 0 division
    return unitVecToLatLng({
      x: a.x + (b.x - a.x) * clampedT,
      y: a.y + (b.y - a.y) * clampedT,
      z: a.z + (b.z - a.z) * clampedT,
    });
  }

  if (dot < -0.999999) {
    // Near-antipodal points: construct deterministic orthogonal great-circle normal
    const ref = Math.abs(a.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const perpX = a.y * ref.z - a.z * ref.y;
    const perpY = a.z * ref.x - a.x * ref.z;
    const perpZ = a.x * ref.y - a.y * ref.x;
    const perpMag = Math.hypot(perpX, perpY, perpZ) || 1;
    const angle = Math.PI * clampedT;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    return unitVecToLatLng({
      x: a.x * cosA + (perpX / perpMag) * sinA,
      y: a.y * cosA + (perpY / perpMag) * sinA,
      z: a.z * cosA + (perpZ / perpMag) * sinA,
    });
  }

  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  const wA = Math.sin((1 - clampedT) * omega) / sinOmega;
  const wB = Math.sin(clampedT * omega) / sinOmega;

  return unitVecToLatLng({
    x: a.x * wA + b.x * wB,
    y: a.y * wA + b.y * wB,
    z: a.z * wA + b.z * wB,
  });
}

export function marsDistanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = shortestLngDeltaDeg(a.lng, b.lng) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * MARS_RADIUS_KM * Math.asin(Math.min(1, Math.max(0, Math.sqrt(Math.max(0, h)))));
}

export function marsBearingDeg(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): number {
  if (Math.abs(from.lat) > 89.999) {
    return from.lat >= 0 ? 180 : 0;
  }
  const r = Math.PI / 180;
  const lat1 = from.lat * r;
  const lat2 = to.lat * r;
  const dLon = shortestLngDeltaDeg(from.lng, to.lng) * r;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * 3D spherical tangent-frame stepping: numerically exact for both sub-meter steps
 * and multi-thousand-kilometer hops, and safe across ±90° poles and ±180° seam.
 */
export function marsStepGreatCircle(
  from: { lat: number; lng: number },
  bearingDeg: number,
  distanceMeters: number
): { lat: number; lng: number } {
  if (!Number.isFinite(distanceMeters) || Math.abs(distanceMeters) < 1e-6) {
    return { lat: Math.max(-90, Math.min(90, from.lat)), lng: normalizeSignedLng180(from.lng) };
  }
  const degToRad = Math.PI / 180;
  const latR = Math.max(-90, Math.min(90, from.lat)) * degToRad;
  const lonR = normalizeSignedLng180(from.lng) * degToRad;
  const brgR = bearingDeg * degToRad;

  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const sinLon = Math.sin(lonR);
  const cosLon = Math.cos(lonR);

  // Unit surface position p
  const px = cosLat * cosLon;
  const py = cosLat * sinLon;
  const pz = sinLat;

  // Orthonormal local East & North tangent vectors
  const eastX = -sinLon;
  const eastY = cosLon;
  const eastZ = 0;

  const northX = -sinLat * cosLon;
  const northY = -sinLat * sinLon;
  const northZ = cosLat;

  const cosB = Math.cos(brgR);
  const sinB = Math.sin(brgR);
  const dirX = northX * cosB + eastX * sinB;
  const dirY = northY * cosB + eastY * sinB;
  const dirZ = northZ * cosB + eastZ * sinB;

  const delta = distanceMeters / (MARS_RADIUS_KM * 1000);
  const cosD = Math.cos(delta);
  const sinD = Math.sin(delta);

  return unitVecToLatLng({
    x: px * cosD + dirX * sinD,
    y: py * cosD + dirY * sinD,
    z: pz * cosD + dirZ * sinD,
  });
}

/**
 * Azimuthal Equidistant projection centered on `origin`:
 * Zero polar distortion — preserves exact great-circle distance & azimuth at all latitudes.
 * Returns { x: East meters, y: North meters }.
 */
export function latLngToAzimuthalMeters(
  target: { lat: number; lng: number },
  origin: { lat: number; lng: number }
): { x: number; y: number } {
  const distMeters = marsDistanceKm(origin, target) * 1000;
  if (distMeters < 1e-3) return { x: 0, y: 0 };
  const brgRad = (marsBearingDeg(origin, target) * Math.PI) / 180;
  return {
    x: Math.sin(brgRad) * distMeters,
    y: Math.cos(brgRad) * distMeters,
  };
}

/**
 * Exact inverse Azimuthal Equidistant transform from local { dxEastMeters, dyNorthMeters }
 * back to Martian Areographic (lat, lng).
 */
export function azimuthalMetersToLatLng(
  dxEastMeters: number,
  dyNorthMeters: number,
  origin: { lat: number; lng: number }
): { lat: number; lng: number } {
  const distMeters = Math.hypot(dxEastMeters, dyNorthMeters);
  if (distMeters < 1e-3) return { lat: origin.lat, lng: normalizeSignedLng180(origin.lng) };
  const bearingDeg = ((Math.atan2(dxEastMeters, dyNorthMeters) * 180) / Math.PI + 360) % 360;
  return marsStepGreatCircle(origin, bearingDeg, distMeters);
}

/**
 * Spherical Orthographic projection centered on `center` for the Global Mars Mini-Globe.
 * Returns normalized coordinates nx, ny in [-1, 1] (ny positive = North/Up before canvas flip)
 * and `cosC` (visible hemisphere if cosC >= 0).
 */
export function orthographicProject(
  target: { lat: number; lng: number },
  center: { lat: number; lng: number }
): { nx: number; ny: number; cosC: number; visible: boolean } {
  const r = Math.PI / 180;
  const lat0 = center.lat * r;
  const lat = target.lat * r;
  const dLon = (target.lng - center.lng) * r;
  const sinLat0 = Math.sin(lat0);
  const cosLat0 = Math.cos(lat0);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const cosC = sinLat0 * sinLat + cosLat0 * cosLat * Math.cos(dLon);
  const nx = cosLat * Math.sin(dLon);
  const ny = cosLat0 * sinLat - sinLat0 * cosLat * Math.cos(dLon);
  return { nx, ny, cosC, visible: cosC >= 0 };
}

/**
 * Inverse Spherical Orthographic projection: maps normalized sphere coordinates (nx, ny)
 * with nx^2 + ny^2 <= 1 (where +ny is North/Up) back to Martian (lat, lng).
 */
export function orthographicInverse(
  nx: number,
  ny: number,
  center: { lat: number; lng: number }
): { lat: number; lng: number } | null {
  const rho2 = nx * nx + ny * ny;
  if (rho2 > 1) return null;
  if (rho2 < 1e-10) return { lat: center.lat, lng: normalizeSignedLng180(center.lng) };

  const rho = Math.sqrt(rho2);
  const c = Math.asin(Math.min(1, rho));
  const sinC = Math.sin(c);
  const cosC = Math.cos(c);

  const degToRad = Math.PI / 180;
  const radToDeg = 180 / Math.PI;
  const lat0 = center.lat * degToRad;
  const lon0 = center.lng * degToRad;
  const sinLat0 = Math.sin(lat0);
  const cosLat0 = Math.cos(lat0);

  const sinLat = Math.max(-1, Math.min(1, cosC * sinLat0 + (ny * sinC * cosLat0) / rho));
  const lat = Math.asin(sinLat) * radToDeg;
  const lon =
    lon0 + Math.atan2(nx * sinC, rho * cosLat0 * cosC - ny * sinLat0 * sinC);

  return {
    lat: Math.max(-90, Math.min(90, lat)),
    lng: normalizeSignedLng180(lon * radToDeg),
  };
}

export interface PlanetaryTopographySample {
  elevationMeters: number;
  normElev: number;
  regionId: string;
  isPolarCap: boolean;
  isSpiralTrough: boolean;
  isSyrtis: boolean;
  isValles: boolean;
  isHellas: boolean;
  isOlympus: boolean;
  isTharsisVolcano: boolean;
  isGaleCrater: boolean;
  isMountSharp: boolean;
  grain: number;
}

export const THARSIS_VOLCANOES = [
  { id: 'ASCRAEUS', name: 'Ascraeus Mons', lat: 11.9, lng: -104.1, radiusDeg: 3.4, peakMeters: 18225, calderaMeters: 14900 },
  { id: 'PAVONIS', name: 'Pavonis Mons', lat: 1.5, lng: -112.9, radiusDeg: 3.1, peakMeters: 14058, calderaMeters: 9400 },
  { id: 'ARSIA', name: 'Arsia Mons', lat: -8.3, lng: -120.1, radiusDeg: 3.6, peakMeters: 17761, calderaMeters: 12100 },
] as const;

function hashPlanet(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function noisePlanet(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hashPlanet(ix, iy);
  const b = hashPlanet(ix + 1, iy);
  const c = hashPlanet(ix, iy + 1);
  const d = hashPlanet(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbmPlanetary(x: number, y: number): number {
  return (
    noisePlanet(x, y) * 0.54 +
    noisePlanet(x * 2.13, y * 2.13) * 0.28 +
    noisePlanet(x * 4.37, y * 4.37) * 0.13 +
    noisePlanet(x * 8.91, y * 8.91) * 0.05
  );
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Evaluates true 3D Martian planetary elevation (MOLA datum meters, ~ -10,000 m to +25,000 m)
 * and regional geological masks for any (lat, lng) coordinate. Shared across the 3D displaced
 * global Mars sphere, orbital tile atlas, and MOLA elevation probes.
 */
export function evalPlanetaryTopography(lat: number, lng: number): PlanetaryTopographySample {
  const normLng = normalizeSignedLng180(lng);
  const absLat = Math.abs(lat);
  const lonRad = (normLng * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;
  const cosLat = Math.max(0.18, Math.cos(latRad));

  // Periodic spherical noise coordinates (seamless across +/-180 deg)
  const sx = Math.cos(latRad) * Math.cos(lonRad) * 4.8 + 10;
  const sy = Math.cos(latRad) * Math.sin(lonRad) * 4.8 + 20;
  const sz = Math.sin(latRad) * 4.8 + 30;
  const grain = fbmPlanetary(sx + sz * 0.42, sy - sz * 0.31);
  const ridgeNoise = fbmPlanetary(sx * 2.2 - 7, sy * 2.2 + sz * 0.5);

  const polarBoundary = 78.5 + Math.sin(lonRad * 3) * 2.1 + (grain - 0.5) * 3.0;
  const isPolarCap = absLat > polarBoundary;
  const spiralPhase = absLat * 0.96 + normLng * 0.08 + grain * 1.45;
  const isSpiralTrough = isPolarCap && Math.sin(spiralPhase) > 0.64;

  // 1. Hemispheric crustal dichotomy: Northern Lowlands (-4,500m) vs Southern Highlands (+2,200m)
  const dichotomyLat = -5 + Math.sin(lonRad * 2 + 0.6) * 14 + Math.cos(lonRad * 3) * 6;
  const highlandBlend = smoothstep(dichotomyLat + 14, dichotomyLat - 14, lat);
  let elevMeters = -4400 + highlandBlend * 6500 + (grain - 0.5) * 2200;
  let regionId = highlandBlend > 0.55 ? 'SOUTHERN_HIGHLANDS' : 'NORTHERN_LOWLANDS';

  // Highland crater pockmarks (raises rims, excavates bowls across Noachis Terra)
  if (highlandBlend > 0.35 && !isPolarCap) {
    const craterCell = noisePlanet(sx * 3.4 + 41, sy * 3.4 - sz * 1.2 + 19);
    if (craterCell > 0.72) {
      const cStrength = (craterCell - 0.72) / 0.28;
      elevMeters += (cStrength > 0.55 ? -950 : 780) * highlandBlend;
    }
  }

  // 2. Hellas Planitia (-7,200 m deep oval basin ringed by +2,100 m rim mountains)
  const dHellas = Math.hypot((lat + 42.4) / 14.5, (shortestLngDeltaDeg(70.5, normLng) * cosLat) / 17.5);
  const isHellas = dHellas < 1.02;
  if (dHellas < 1.32) {
    const bowlT = 1 - smoothstep(0.42, 1.0, dHellas);
    const floorDepth = -7200 + (grain - 0.5) * 420;
    elevMeters = elevMeters * (1 - bowlT) + floorDepth * bowlT;
    // Rugged Hellas Rim Mountain Ring
    const rimRing = Math.exp(-Math.pow((dHellas - 1.02) / 0.14, 2));
    elevMeters += rimRing * (2200 + ridgeNoise * 1400);
    if (dHellas < 1.05) regionId = 'HELLAS_PLANITIA';
  }

  // 3. Argyre & Isidis impact basins
  const dArgyre = Math.hypot((lat + 49.7) / 8.0, (shortestLngDeltaDeg(-44.0, normLng) * cosLat) / 8.5);
  if (dArgyre < 1.18) {
    const t = 1 - smoothstep(0.45, 1.05, dArgyre);
    elevMeters = elevMeters * (1 - t) + (-5200 + grain * 400) * t;
    elevMeters += Math.exp(-Math.pow((dArgyre - 1.02) / 0.12, 2)) * 1800;
  }
  const dIsidis = Math.hypot((lat - 12.9) / 7.5, (shortestLngDeltaDeg(87.0, normLng) * cosLat) / 8.8);
  if (dIsidis < 1.15) {
    const t = 1 - smoothstep(0.35, 1.0, dIsidis);
    elevMeters = elevMeters * (1 - t) + (-3900 + grain * 300) * t;
  }

  // 4. Syrtis Major dark basaltic shield
  const isSyrtis =
    lat > -4 &&
    lat < 20 &&
    normLng > 58 &&
    normLng < 78 &&
    lat + (normLng - 68) * 1.35 < 24 &&
    grain > 0.28;
  if (isSyrtis) {
    const dSyrtis = Math.hypot((lat - 8.4) / 10, (shortestLngDeltaDeg(69.5, normLng) * cosLat) / 9);
    if (dSyrtis < 1) elevMeters += (1 - dSyrtis) * 1650;
  }

  // 5. Tharsis Bulge (+9,800 m broad volcanic plateau) + Three Aligned Tharsis Montes Shield Cones
  const dTharsis = Math.hypot(lat / 27.0, (shortestLngDeltaDeg(-110.0, normLng) * cosLat) / 31.0);
  if (dTharsis < 1.15) {
    const bulgeProfile = Math.pow(1 - smoothstep(0.0, 1.15, dTharsis), 0.9);
    const tharsisFloor = 9800 * bulgeProfile + (ridgeNoise - 0.5) * 900 * bulgeProfile;
    elevMeters = Math.max(elevMeters, elevMeters * (1 - bulgeProfile) + tharsisFloor);
    if (dTharsis < 0.92) regionId = 'THARSIS_BULGE';
  }

  let isTharsisVolcano = false;
  for (let i = 0; i < THARSIS_VOLCANOES.length; i++) {
    const v = THARSIS_VOLCANOES[i];
    const dv = Math.hypot((lat - v.lat) / v.radiusDeg, (shortestLngDeltaDeg(v.lng, normLng) * cosLat) / v.radiusDeg);
    if (dv < 1.25) {
      isTharsisVolcano = dv < 1.0;
      const flank = Math.pow(1 - smoothstep(0.18, 1.18, dv), 1.15);
      let shieldH = v.peakMeters * flank;
      // Summit collapse caldera depression
      if (dv < 0.24) {
        const calderaT = 1 - smoothstep(0.08, 0.24, dv);
        shieldH = shieldH * (1 - calderaT) + v.calderaMeters * calderaT;
      }
      elevMeters = Math.max(elevMeters, shieldH);
      regionId = 'THARSIS_BULGE';
    }
  }

  // Elysium Mons volcanic shield
  const dElysium = Math.hypot((lat - 25.0) / 7.5, (shortestLngDeltaDeg(147.2, normLng) * cosLat) / 8.5);
  if (dElysium < 1.1) {
    const ef = Math.pow(1 - smoothstep(0.12, 1.1, dElysium), 1.2);
    elevMeters = Math.max(elevMeters, 13800 * ef - 1200 * (1 - ef));
  }

  // 6. Olympus Mons (22-26 km physical extrusion, sheer 8 km basal cliff scarp collar, summit caldera)
  const dOlympus = Math.hypot((lat - 18.65) / 5.4, (shortestLngDeltaDeg(-133.8, normLng) * cosLat) / 5.4);
  const isOlympus = dOlympus < 1.02;
  if (dOlympus < 1.18) {
    // Sheer basal cliff collar drops ~8 km abruptly between r=0.86 and r=1.02
    const basalScarpMask = 1 - smoothstep(0.84, 1.02, dOlympus);
    const slopeRise = Math.pow(Math.max(0, 1 - dOlympus / 0.92), 0.72);
    let olyElev = basalScarpMask * (8200 + slopeRise * 16300);
    // Multi-ring summit caldera collapse crater
    if (dOlympus < 0.2) {
      const caldera = 1 - smoothstep(0.08, 0.2, dOlympus);
      olyElev -= caldera * 3200;
    }
    elevMeters = Math.max(elevMeters, -2600 + olyElev);
    if (isOlympus) regionId = 'OLYMPUS_MONS';
  }

  // 7. Valles Marineris (-8 to -10 km deep tectonic chasm canyon carved into equatorial plateau)
  const vallesCenterLat = -12.6 + Math.sin((normLng + 65) * 0.068) * 1.9;
  const vallesWidthDeg = 1.85 + Math.exp(-Math.pow((normLng + 62) / 14, 2)) * 1.4 + (ridgeNoise - 0.5) * 0.7;
  const distToMainChasm = Math.abs(lat - vallesCenterLat) / vallesWidthDeg;
  // Parallel Candor / Ophir northern branching chasma near -74..-56 deg lon
  const candorCenterLat = -6.8 + Math.sin((normLng + 70) * 0.14) * 0.9;
  const distToCandor =
    normLng > -78 && normLng < -54 ? Math.abs(lat - candorCenterLat) / 1.35 : 99;
  const chasmNorm = Math.min(distToMainChasm, distToCandor);
  const inVallesLon = normLng > -96 && normLng < -33;
  const isValles = inVallesLon && chasmNorm < 1.1;

  if (inVallesLon && chasmNorm < 1.9) {
    const lonTaper = smoothstep(-97, -86, normLng) * (1 - smoothstep(-40, -31, normLng));
    // Raised tectonic shoulder rim just outside canyon walls
    const rimShoulder = Math.exp(-Math.pow((chasmNorm - 1.25) / 0.35, 2)) * 1900 * lonTaper;
    elevMeters += rimShoulder;
    if (chasmNorm < 1.22) {
      const trenchWall = 1 - smoothstep(0.32, 1.15, chasmNorm);
      const trenchFloor = -9400 + (grain - 0.5) * 650;
      const blend = trenchWall * lonTaper;
      elevMeters = elevMeters * (1 - blend) + trenchFloor * blend;
      regionId = 'VALLES_MARINERIS';
    }
  }

  // 8. Gale Crater (-4,500 m bowl) & Mount Sharp / Aeolis Mons (+5,500 m central layered peak)
  const dGale = Math.hypot((lat + 5.4) / 2.6, (shortestLngDeltaDeg(137.8, normLng) * cosLat) / 2.6);
  const isGaleCrater = dGale < 1.05;
  const isMountSharp = dGale < 0.42;
  if (dGale < 1.28) {
    const craterBowl = 1 - smoothstep(0.76, 1.04, dGale);
    const craterRim = Math.exp(-Math.pow((dGale - 1.0) / 0.14, 2)) * 2200;
    const floorElev = -4500 + (grain - 0.5) * 320;
    elevMeters = elevMeters * (1 - craterBowl) + floorElev * craterBowl + craterRim;
    if (dGale < 0.48) {
      // Mount Sharp central peak rises +5,500 m physically inside Gale Crater!
      const sharpCone = Math.pow(1 - smoothstep(0.0, 0.46, dGale), 1.1);
      const sharpBench = Math.floor(sharpCone * 5) * 0.12 + sharpCone * 0.4;
      elevMeters += (sharpCone * 0.72 + sharpBench * 0.28) * 5600;
    }
    if (isGaleCrater) regionId = 'GALE_CRATER';
  }

  // 9. Polar Ice Caps (Planum Boreum & Planum Australe) with spiral wind troughs
  if (isPolarCap) {
    const capThickness = 2900 * smoothstep(polarBoundary, 88, absLat);
    if (lat > 0) {
      elevMeters = Math.max(elevMeters, -4300 + capThickness - (isSpiralTrough ? 950 : 0));
      regionId = 'PLANUM_BOREUM';
    } else {
      elevMeters = Math.max(elevMeters, 1500 + capThickness - (isSpiralTrough ? 1100 : 0));
      regionId = 'PLANUM_AUSTRALE';
    }
  }

  // Real NASA MGS MOLA elevation replaces the synthetic relief model above (the model is
  // only kept for region masks/albedo and as a fallback until the DEM has loaded).
  const molaMeters = sampleMolaMeters(lat, lng);
  if (!Number.isNaN(molaMeters)) elevMeters = molaMeters;

  const clampedElev = Math.max(-10200, Math.min(24800, elevMeters));
  // Normalize over Martian MOLA global range (-9,500 m .. +22,000 m) for tile hypsometry
  const normElev = Math.max(0, Math.min(1, (clampedElev + 8800) / 29800));

  return {
    elevationMeters: Math.round(clampedElev),
    normElev,
    regionId,
    isPolarCap,
    isSpiralTrough,
    isSyrtis,
    isValles,
    isHellas,
    isOlympus,
    isTharsisVolcano,
    isGaleCrater,
    isMountSharp,
    grain,
  };
}

/**
 * Estimates MOLA datum elevation (meters) at any planetary coordinate using the unified
 * high-resolution Martian topographic elevation field.
 */
export function estimatePlanetaryElevationMeters(lat: number, lng: number): number {
  return evalPlanetaryTopography(lat, lng).elevationMeters;
}

export function estimateMarsTravelEtaMinutes(
  distanceMeters: number,
  locomotionMode: 'rover' | 'eva_walk' = 'rover',
  speedTorqueSetting = 1.0
): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return 0;
  let rem = distanceMeters;
  let totalSec = 0;

  if (rem > 200_000) {
    totalSec += (rem - 200_000) / 240_000;
    rem = 200_000;
  }
  if (rem > 10_000) {
    totalSec += (rem - 10_000) / 18_000;
    rem = 10_000;
  }
  if (rem > 1_800) {
    totalSec += (rem - 1_800) / 1_400;
    rem = 1_800;
  }

  const localSpeedMps =
    (locomotionMode === 'eva_walk' ? 22 : 52) * Math.max(0.25, speedTorqueSetting);
  totalSec += rem / localSpeedMps;

  return Math.max(0.1, Math.round((totalSec / 60) * 10) / 10);
}

/**
 * Core Planetary Landmark & Regional Topography Database
 */
export const MARS_PLANETARY_LANDMARKS: MarsLandform[] = [
  // 1. PRIMARY LANDMARKS
  {
    // Arrival point is the NW foot of the basal escarpment (22.17°N, 221.84°E, ~322 km from the
    // summit, real MOLA elevation about -1,700 m). From here the real data rises about 7.7 km
    // within 20 km, so the mountain wall is genuinely visible on the horizon. The summit is
    // its own landmark below. Found by scanning the baked MOLA window for the largest visible rise.
    id: 'LF-OLYMPUS-MONS',
    name: 'Olympus Mons',
    tier: 'primary',
    region: 'Tharsis Province',
    category: 'volcano',
    lat: 22.17,
    lng: -138.16, // 221.84° E
    elevationMeters: -1700,
    dimensions: {
      verticalMetric: '~22–26 km high above base',
      horizontalMetric: '~600 km wide volcanic shield',
    },
    scienceSummary:
      'Largest volcano in the solar system; gently sloping basaltic shield crowned by a multi-ringed summit caldera and ringed by an abrupt sheer basal cliff. Viewed here from the plains at the foot of its northwest basal escarpment.',
    visualCharacteristics:
      'A colossal wall of basalt rising roughly 7–8 km above the plains in only a few tens of kilometres, the basal escarpment of the shield, filling the horizon toward the southeast.',
    terrainConstraints: [
      'RED-MARKER BASELINE (~-1,700 m): climbing telemetry is measured from here to the 21,229 m summit',
      'Sheer basal cliff scarp, 2-8 km vertical (tallest on the NW/N side), ringing the 285-315 km perimeter',
      'Gentle 2°–6° lava-flow flanks above the basal escarpment; aureole debris lobes to the NW',
      'Summit caldera complex: six nested collapse craters, 9-32 km wide and up to 3.2 km deep',
      'Summit air pressure ~100 Pa (about 16% of the Mars datum): extreme-altitude suit load',
    ],
    weatherProfile: 'Ultra-thin summit atmosphere (~72 Pa); afternoon orographic water-ice clouds.',
    difficulty: 'EXTREME',
    adjacentIds: ['LF-THARSIS-BULGE', 'LF-NORTHERN-LOWLANDS', 'LF-OLYMPIA-UNDAE', 'LF-OLYMPUS-SUMMIT'],
  },
  {
    id: 'LF-OLYMPUS-SUMMIT',
    name: 'Olympus Mons Summit Caldera',
    tier: 'primary',
    region: 'Tharsis Province',
    category: 'volcano',
    lat: 18.65,
    lng: -133.8, // 226.2° E
    elevationMeters: 21900,
    dimensions: {
      verticalMetric: '~22–26 km high above base',
      horizontalMetric: '~80 km wide summit caldera complex',
    },
    scienceSummary:
      'Summit of the largest volcano in the solar system: a multi-ringed collapse caldera on a very broad, gently sloping shield.',
    visualCharacteristics:
      'Standing on the summit the shield falls away so gently (a few degrees) that it reads as a vast plateau with the caldera walls as the only relief.',
    terrainConstraints: [
      'Summit elevation 21,229 m (MOLA); caldera rim ~21,000 m, crater floors down to ~18,000 m',
      'Six nested collapse craters, 9-32 km across, 1.2-3.2 km deep, with fractured basalt ledges',
      'Gentle 2°–6° lava-flow flanks; near-vacuum air (~100 Pa)',
    ],
    weatherProfile: 'Ultra-thin summit atmosphere (~72 Pa); afternoon orographic water-ice clouds.',
    difficulty: 'EXTREME',
    adjacentIds: ['LF-OLYMPUS-MONS', 'LF-THARSIS-BULGE'],
  },
  {
    id: 'LF-VALLES-MARINERIS',
    name: 'Valles Marineris',
    tier: 'primary',
    region: 'Equatorial Rift Belt',
    category: 'canyon',
    lat: -7.89,
    lng: -77.41, // 282.59° E, Melas/Candor chasma wall: ~6.8 km real rise within 20 km
    elevationMeters: -2850,
    dimensions: {
      verticalMetric: '8–10 km deep chasm floor',
      horizontalMetric: '3,000–5,000 km equatorial length',
    },
    scienceSummary:
      'Colossal tectonic rift canyon system slicing across a quarter of Mars’s circumference along the equator.',
    visualCharacteristics:
      'Jagged, branching tectonic scar with steep layered canyon walls dropping precipitously into dark, flat-bottomed chasms frequently veiled in morning water-ice fog or dusty haze.',
    terrainConstraints: [
      'Steep layered canyon walls (30°–55° talus & bedrock cliffs)',
      'Deep flat-bottomed chasms prone to morning fog & visibility drops',
      'Massive landslide aprons and chaotic outflow terrain at eastern mouth',
    ],
    weatherProfile: 'Higher floor pressure (~1,100 Pa); morning canyon fog and katabatic slope gusts.',
    difficulty: 'EXTREME',
    adjacentIds: ['LF-THARSIS-BULGE', 'LF-SOUTHERN-HIGHLANDS', 'LF-NORTHERN-LOWLANDS'],
  },
  {
    id: 'LF-GALE-CRATER',
    name: 'Gale Crater & Mount Sharp',
    tier: 'primary',
    region: 'Aeolis Quadrangle',
    category: 'crater',
    lat: -4.66,
    lng: 137.53, // 137.53° E, crater floor beside Mount Sharp: ~4.4 km real rise within 20 km
    elevationMeters: -4149,
    dimensions: {
      verticalMetric: '5.5 km central peak (Aeolis Mons)',
      horizontalMetric: '154 km wide impact basin',
    },
    scienceSummary:
      'Ancient 154 km impact basin and landing site of NASA’s Curiosity Rover, preserving an eroded lacustrine record in Mount Sharp.',
    visualCharacteristics:
      'Eroded circular crater bowl with Aeolis Mons (Mount Sharp)—a towering, layered mountain of sedimentary rock—rising from the center; surrounded by fractured tan sedimentary slabs and wind-sculpted dark sand ripples (Bagnold Dunes).',
    terrainConstraints: [
      'Fractured tan sedimentary bedrock slabs and sharp ventifacts',
      'Active wind-sculpted dark basaltic sand ripples (slip hazard)',
      'Steep layered sulfate-bearing slopes ascending Mount Sharp',
    ],
    weatherProfile: 'Strong diurnal thermal tides; frequent convective dust vortices and seasonal dust haze.',
    difficulty: 'HIGH',
    adjacentIds: ['LF-REULL-VALLIS', 'LF-SYRTIS-MAJOR', 'LF-OLYMPIA-UNDAE'],
  },
  {
    id: 'LF-PLANUM-BOREUM',
    name: 'Planum Boreum (North Polar Cap)',
    tier: 'primary',
    region: 'North Polar Basin',
    category: 'polar',
    lat: 84.35,
    lng: 1.66, // 1.66° E, Chasma Boreale (inside real MOLA window)
    elevationMeters: -4560,
    dimensions: {
      verticalMetric: '~3 km thick layered ice dome',
      horizontalMetric: '~1,000 km circular polar dome',
    },
    scienceSummary:
      'Permanent water-ice cap topped by seasonal carbon dioxide (dry ice) frost layers in the northern hemisphere.',
    visualCharacteristics:
      'Brilliant white circular dome etched with dark reddish-brown spiral troughs carved by strong Coriolis-deflected polar winds, bordered by sweeping rings of dark sand dunes.',
    terrainConstraints: [
      'Steep dark reddish-brown spiral troughs (Chasma Boreale scarp)',
      'Slippery sublimating CO2 dry ice & water-ice crust',
      'Encircling rings of dark polar sand dunes along cap margin',
    ],
    weatherProfile: 'Extreme cryogenic cold (-125 °C winter); ferocious katabatic polar winds.',
    difficulty: 'EXTREME',
    adjacentIds: ['LF-OLYMPIA-UNDAE', 'LF-NORTHERN-LOWLANDS'],
  },
  {
    id: 'LF-PLANUM-AUSTRALE',
    name: 'Planum Australe (South Polar Cap)',
    tier: 'primary',
    region: 'South Polar Highlands',
    category: 'polar',
    lat: -85.0,
    lng: 160.0, // 160.0° E
    elevationMeters: 1500,
    dimensions: {
      verticalMetric: '~3.5 km thick ice & CO2 stack',
      horizontalMetric: '~400–800 km seasonal polar cap',
    },
    scienceSummary:
      'High-elevation southern polar ice dome combining permanent water ice with persistent residual carbon dioxide dry-ice layers.',
    visualCharacteristics:
      'Brilliant white layered dome etched with dark spiraling troughs and pitted "Swiss-cheese" CO2 sublimation depressions above ancient cratered highland terrain.',
    terrainConstraints: [
      'Steep polar spiral troughs and collapsed CO2 sublimation pits',
      'Rugged high-altitude highland transitions along cap boundary',
      'Low solar illumination angles restricting solar array charging',
    ],
    weatherProfile: 'Persistent CO2 frost deposition; intense polar vortex winds and sub-150 K nights.',
    difficulty: 'EXTREME',
    adjacentIds: ['LF-HELLAS-PLANITIA', 'LF-SOUTHERN-HIGHLANDS', 'LF-REULL-VALLIS'],
  },

  // 2. BROAD REGIONAL FEATURES & TOPOGRAPHY
  {
    id: 'LF-THARSIS-BULGE',
    name: 'Tharsis Bulge',
    tier: 'regional',
    region: 'Western Hemisphere Dome',
    category: 'volcano',
    lat: 0.35,
    lng: -112.9, // 247.1° E, Pavonis Mons flank: ~4.8 km real rise within 20 km
    elevationMeters: 9224,
    dimensions: {
      verticalMetric: '~10 km high volcanic plateau',
      horizontalMetric: '~4,000 km wide equatorial dome',
    },
    scienceSummary:
      'Colossal volcanic dome straddling the equator; anchors Olympus Mons and the aligned Tharsis Montes shield volcanoes.',
    visualCharacteristics:
      'Broad, raised dusty plateau punctuated by the three aligned Tharsis Montes shield volcanoes (Ascraeus, Pavonis, Arsia Mons) appearing as dark circular spots with summit calderas on the high dome.',
    terrainConstraints: [
      'Sustained +10 km regional elevation gain lowering air pressure',
      'Extensive fractured lava plains and radial graben fault troughs',
      'Direct tectonic transition eastward into Valles Marineris canyon head',
    ],
    weatherProfile: 'Thin high-plateau atmosphere (~320 Pa); persistent afternoon summit cloud bands.',
    difficulty: 'HIGH',
    adjacentIds: ['LF-OLYMPUS-MONS', 'LF-VALLES-MARINERIS', 'LF-NORTHERN-LOWLANDS', 'LF-SOUTHERN-HIGHLANDS'],
  },
  {
    id: 'LF-HELLAS-PLANITIA',
    name: 'Hellas Planitia',
    tier: 'regional',
    region: 'Southern Impact Basin',
    category: 'plains',
    lat: -45.37,
    lng: 71.78, // 71.78° E, deep basin floor under the real rim scarps
    elevationMeters: -7189,
    dimensions: {
      verticalMetric: '~7.2 km below datum (deepest basin)',
      horizontalMetric: '~2,300 km wide oval depression',
    },
    scienceSummary:
      'Deepest impact basin in the southern hemisphere; high surface pressure makes it a major sink for frost, clouds, and regional dust storms.',
    visualCharacteristics:
      'Vast, smooth oval depression sitting far below the cratered rim, frequently filled with bright white morning clouds, winter water-ice frost, or thick swirling dust hazes.',
    terrainConstraints: [
      'Steep concentric basin rim escarpments dropping >7 km into floor',
      'Soft dust-mantled basin floor and bright frost/ice patches',
      'Major dust storm nucleation basin during southern summer',
    ],
    weatherProfile: 'Highest atmospheric pressure on Mars (~1,155 Pa); dense morning cloud/fog decks.',
    difficulty: 'HIGH',
    adjacentIds: ['LF-REULL-VALLIS', 'LF-SYRTIS-MAJOR', 'LF-SOUTHERN-HIGHLANDS', 'LF-PLANUM-AUSTRALE'],
  },
  {
    id: 'LF-SYRTIS-MAJOR',
    name: 'Syrtis Major',
    tier: 'regional',
    region: 'Syrtis / Isidis Border',
    category: 'volcano',
    lat: 8.4,
    lng: 69.5, // 69.5° E
    elevationMeters: -1200,
    dimensions: {
      verticalMetric: '~2 km low-relief shield rise',
      horizontalMetric: '~1,100 km dark triangular shield',
    },
    scienceSummary:
      'Prominent dark low-albedo basaltic volcanic shield lying just south-west of Isidis Planitia and Jezero Crater.',
    visualCharacteristics:
      'Unmistakable dark triangular volcanic shield standing out starkly against surrounding bright dusty orange plains, swept clean of bright dust by regional winds.',
    terrainConstraints: [
      'Coarse dark basaltic sand sheets and wind-scoured volcanic bedrock',
      'Low-albedo surfaces exhibiting high daytime thermal inertia',
      'Gateway corridor linking Jezero Crater to Hellas and Gale sectors',
    ],
    weatherProfile: 'Strong seasonal winds sweeping dust off dark basalt; low dust cover, crisp visibility.',
    difficulty: 'MODERATE',
    adjacentIds: ['LF-JEZERO-RIM', 'LF-HELLAS-PLANITIA', 'LF-GALE-CRATER', 'LF-SOUTHERN-HIGHLANDS'],
  },
  {
    id: 'LF-SOUTHERN-HIGHLANDS',
    name: 'Southern Highlands (Noachis Terra)',
    tier: 'regional',
    region: 'Hemispheric Dichotomy · South',
    category: 'highlands',
    lat: -40.38,
    lng: 11.91, // 11.91° E, cratered Noachis Terra scarp (inside real MOLA window)
    elevationMeters: -39,
    dimensions: {
      verticalMetric: '~+2 to +4 km crustal elevation',
      horizontalMetric: 'Southern planetary hemisphere',
    },
    scienceSummary:
      'Ancient, heavily cratered highland crust (>3.5 billion years old) forming the elevated half of Mars’s global hemispheric dichotomy.',
    visualCharacteristics:
      'Rugged, densely pitted landscape of overlapping ancient impact craters, weathered ejecta blankets, and dendritic valley networks across thick Noachian crust.',
    terrainConstraints: [
      'Dense overlapping impact crater rims requiring constant detours',
      'Rough rocky regolith and ancient valley-network crossings',
      'Abrupt 4–6 km topographic drop northward across the dichotomy boundary',
    ],
    weatherProfile: 'Cold highland nights; frequent regional dust lifting along the dichotomy scarp.',
    difficulty: 'HIGH',
    adjacentIds: ['LF-VALLES-MARINERIS', 'LF-HELLAS-PLANITIA', 'LF-SYRTIS-MAJOR', 'LF-NORTHERN-LOWLANDS', 'LF-PLANUM-AUSTRALE'],
  },
  {
    id: 'LF-NORTHERN-LOWLANDS',
    name: 'Northern Lowlands (Vastitas Borealis)',
    tier: 'regional',
    region: 'Hemispheric Dichotomy · North',
    category: 'plains',
    lat: 68.33,
    lng: -124.61, // 235.39° E, Vastitas Borealis near Phoenix (inside real MOLA window)
    elevationMeters: -4682,
    dimensions: {
      verticalMetric: '~6 km lower than Southern Highlands',
      horizontalMetric: 'Circumpolar northern plains',
    },
    scienceSummary:
      'Smooth, low-lying northern plains with a thinner crust, likely resurfaced by ancient ocean sediments and flood-lava flows.',
    visualCharacteristics:
      'Exceptionally flat, smooth dust-blanketed plains punctuated by sparse buried craters, polygonal patterned ground, and thumbprint terrain sitting ~6 km below the southern highlands.',
    terrainConstraints: [
      'High rover trafficability on smooth flat plains once past dichotomy cliff',
      'Polygonal permafrost fractures and fine windblown dust mantles',
      'Long-range featureless horizons with few natural radar landmarks',
    ],
    weatherProfile: 'Moderate-to-high surface pressure (~900 Pa); winter seasonal frost and polar storm fronts.',
    difficulty: 'LOW',
    adjacentIds: ['LF-PLANUM-BOREUM', 'LF-OLYMPUS-MONS', 'LF-THARSIS-BULGE', 'LF-VALLES-MARINERIS', 'LF-SOUTHERN-HIGHLANDS', 'LF-JEZERO-RIM'],
  },

  // 3. SURFACE & WEATHER CHARACTERISTICS
  {
    id: 'LF-JEZERO-RIM',
    name: 'Jezero Crater & Western Delta',
    tier: 'surface',
    region: 'Isidis Rim · Primary EVA Sector',
    category: 'delta',
    lat: 18.58,
    lng: 76.92, // 76.92° E
    elevationMeters: -2510,
    dimensions: {
      verticalMetric: '~1.2 km crater rim relief',
      horizontalMetric: '45 km wide ancient lake crater',
    },
    scienceSummary:
      'Active Perseverance rover sector; impact crater basin featuring a preserved fan-delta structure and ancient river inlet valley (Neretva Vallis).',
    visualCharacteristics:
      'Fractured Noachian crater rim escarpment descending into layered fan-delta mudstones, exposed Mg-carbonate shoreline deposits, and migrating dark aeolian sand ripples.',
    terrainConstraints: [
      '18.4% loose regolith delta escarpment slope',
      'Blocky talus outcrops and olivine-rich aeolian sand ripples',
      'Secondary neutron radiation pockets along Belva and Neretva faults',
    ],
    weatherProfile: 'MEDA Sol 244 baseline (~748 Pa, -38 °C, afternoon dust devil fronts).',
    difficulty: 'MODERATE',
    adjacentIds: ['LF-SYRTIS-MAJOR', 'LF-NORTHERN-LOWLANDS', 'LF-GALE-CRATER'],
  },
  {
    id: 'LF-OLYMPIA-UNDAE',
    name: 'Olympia Undae (Aeolian Dune Sea)',
    tier: 'surface',
    region: 'Circumpolar Eolian Belt',
    category: 'aeolian',
    lat: 81.2,
    lng: 175.0, // 175.0° E
    elevationMeters: -3800,
    dimensions: {
      verticalMetric: '20–60 m tall barchan dune crests',
      horizontalMetric: '~1,200 km continuous dark sand sea',
    },
    scienceSummary:
      'Largest gypsum- and basalt-rich active sand dune sea on Mars, showcasing intense eolian sediment transport.',
    visualCharacteristics:
      'Sweeping dark wave-trains of active barchan and transverse sand dunes, wind-sculpted yardang ridges, and bright crossing dust devil tracks driven by thin CO2 winds.',
    terrainConstraints: [
      'Active loose sand dune crests (severe rover wheel sinkage/slip)',
      'Sharp wind-sculpted yardangs and abrasive saltating dust plumes',
      'Crosses 180° antimeridian corridor toward northern Tharsis plains',
    ],
    weatherProfile: 'High-velocity polar-margin winds; frequent dust devil tracks and seasonal frost.',
    difficulty: 'HIGH',
    adjacentIds: ['LF-PLANUM-BOREUM', 'LF-OLYMPUS-MONS', 'LF-GALE-CRATER'],
  },
  {
    id: 'LF-REULL-VALLIS',
    name: 'Reull Vallis (Ancient River Channel)',
    tier: 'surface',
    region: 'Promethei Terra · East Hellas',
    category: 'fluvial',
    lat: -40.68,
    lng: 103.47, // 103.47° E, channel wall: ~4.9 km real rise within 20 km
    elevationMeters: -516,
    dimensions: {
      verticalMetric: '~1.5 km incised canyon walls',
      horizontalMetric: '~1,500 km sinuous river valley',
    },
    scienceSummary:
      'Classic dried-up Martian river channel and network valley carving west-southwest toward Hellas Planitia, preserving evidence of ancient liquid water flow.',
    visualCharacteristics:
      'Winding, steep-walled dried riverbed with tributary valley networks, streamlined teardrop islands, and smooth glacier-like lineated floor deposits.',
    terrainConstraints: [
      'Deep incised valley walls (up to 1,500 m steep drop into channel)',
      'Lineated ice-rich viscous floor deposits and fractured talus',
      'Funneling corridor descending directly westward into Hellas Planitia',
    ],
    weatherProfile: 'Cold southern mid-latitude air; morning channel frost and katabatic valley breezes.',
    difficulty: 'HIGH',
    adjacentIds: ['LF-HELLAS-PLANITIA', 'LF-GALE-CRATER', 'LF-PLANUM-AUSTRALE'],
  },
];

/**
 * Regional Structural & Topographical Overlays for the Global Mars Map
 */
export const MARS_REGIONAL_ZONES: RegionalZoneOverlay[] = [
  {
    id: 'ZONE-THARSIS',
    name: 'Tharsis Bulge Volcanic Dome',
    kind: 'circle',
    colorHex: '#fb7185',
    points: [[0.0, -110.0]],
    radiusMeters: 2_000_000,
    subtitle: '+10 km high · 4,000 km wide plateau',
  },
  {
    id: 'ZONE-VALLES',
    name: 'Valles Marineris Rift System',
    kind: 'polyline',
    colorHex: '#f59e0b',
    points: [
      [-6.5, -94.0],
      [-10.2, -80.0],
      [-13.9, -59.2],
      [-15.5, -45.0],
      [-11.8, -32.0],
    ],
    subtitle: '4,000 km tectonic canyon · 8–10 km deep',
  },
  {
    id: 'ZONE-HELLAS',
    name: 'Hellas Planitia Basin',
    kind: 'circle',
    colorHex: '#a78bfa',
    points: [[-42.4, 70.5]],
    radiusMeters: 1_150_000,
    subtitle: '2,300 km impact basin · -7,152 m floor',
  },
  {
    id: 'ZONE-SYRTIS',
    name: 'Syrtis Major Dark Volcanic Shield',
    kind: 'polygon',
    colorHex: '#facc15',
    points: [
      [18.5, 67.0],
      [14.0, 74.5],
      [-1.0, 76.0],
      [2.0, 62.0],
    ],
    subtitle: 'Dark basaltic triangular shield',
  },
  {
    id: 'ZONE-DICHOTOMY',
    name: 'Hemispheric Dichotomy Scarp',
    kind: 'polyline',
    colorHex: '#fb923c',
    points: [
      [35.0, -170.0],
      [28.0, -145.0],
      [22.0, -110.0],
      [12.0, -60.0],
      [8.0, -10.0],
      [16.0, 40.0],
      [18.0, 85.0],
      [5.0, 125.0],
      [-4.0, 155.0],
      [10.0, 175.0],
    ],
    subtitle: 'Northern Lowlands (-6 km) vs. Southern Highlands (>3.5 Ga)',
  },
  {
    id: 'ZONE-REULL',
    name: 'Reull Vallis Fluvial Channel',
    kind: 'polyline',
    colorHex: '#2dd4bf',
    points: [
      [-37.5, 118.0],
      [-40.5, 110.0],
      [-42.1, 104.0],
      [-43.2, 95.0],
      [-42.5, 86.0],
    ],
    subtitle: '1,500 km dried ancient riverbed',
  },
  {
    id: 'ZONE-CAP-NORTH',
    name: 'Planum Boreum Ice Dome',
    kind: 'circle',
    colorHex: '#e0f2fe',
    points: [[85.0, 15.0]],
    radiusMeters: 520_000,
    subtitle: '~1,000 km water & CO2 ice cap',
  },
  {
    id: 'ZONE-CAP-SOUTH',
    name: 'Planum Australe Ice Dome',
    kind: 'circle',
    colorHex: '#e0f2fe',
    points: [[-85.0, 160.0]],
    radiusMeters: 420_000,
    subtitle: 'Southern polar ice & spiral troughs',
  },
];

export const LANDMARK_BY_ID: Record<string, MarsLandform> = Object.fromEntries(
  MARS_PLANETARY_LANDMARKS.map((lf) => [lf.id, lf])
);

const DIFFICULTY_RANK: Record<TraversalDifficulty, number> = {
  LOW: 1,
  MODERATE: 2,
  HIGH: 3,
  EXTREME: 4,
};

function maxDifficulty(a: TraversalDifficulty, b: TraversalDifficulty): TraversalDifficulty {
  return DIFFICULTY_RANK[a] >= DIFFICULTY_RANK[b] ? a : b;
}

function classifySegmentDifficulty(
  from: { elevationMeters: number; difficulty?: TraversalDifficulty },
  to: { elevationMeters: number; difficulty?: TraversalDifficulty }
): TraversalDifficulty {
  const elevDelta = Math.abs(to.elevationMeters - from.elevationMeters);
  let diff: TraversalDifficulty = maxDifficulty(from.difficulty ?? 'MODERATE', to.difficulty ?? 'MODERATE');
  if (elevDelta >= 10000) diff = 'EXTREME';
  else if (elevDelta >= 4500) diff = maxDifficulty(diff, 'HIGH');
  return diff;
}

function buildSegmentHazards(
  fromNode: MarsLandform | null,
  toNode: MarsLandform,
  elevDelta: number
): string[] {
  const hazards: string[] = [];
  if (Math.abs(elevDelta) > 4000) {
    hazards.push(
      elevDelta > 0
        ? `+${(elevDelta / 1000).toFixed(1)} km net climb across planetary relief`
        : `${(elevDelta / 1000).toFixed(1)} km net descent into low basin/chasm`
    );
  }
  if (fromNode?.id === 'LF-OLYMPUS-MONS' || toNode.id === 'LF-OLYMPUS-MONS') {
    hazards.push('Sheer 8 km Olympus Mons basal cliff wall requires scarp breach routing');
  }
  if (fromNode?.id === 'LF-VALLES-MARINERIS' || toNode.id === 'LF-VALLES-MARINERIS') {
    hazards.push('Steep Valles Marineris canyon walls & morning fog inside deep chasms');
  }
  if (toNode.category === 'aeolian' || fromNode?.category === 'aeolian') {
    hazards.push('Active sand dunes & wind-sculpted yardangs increase wheel slip');
  }
  if (toNode.category === 'polar' || fromNode?.category === 'polar') {
    hazards.push('Spiral polar wind troughs, dry-ice crust & low solar angle');
  }
  if (
    (fromNode?.id === 'LF-SOUTHERN-HIGHLANDS' && toNode.id === 'LF-NORTHERN-LOWLANDS') ||
    (fromNode?.id === 'LF-NORTHERN-LOWLANDS' && toNode.id === 'LF-SOUTHERN-HIGHLANDS')
  ) {
    hazards.push('Hemispheric Dichotomy boundary: ~6 km elevation drop from >3.5 Ga crust to flat plains');
  }
  if (hazards.length === 0) {
    hazards.push(toNode.terrainConstraints[0] ?? 'Standard Martian regolith traversal');
  }
  return hazards;
}

/**
 * Computes a data-driven planetary route between an arbitrary origin (landmark ID or live coordinates)
 * and any destination landmark, using the planetary adjacency graph (Dijkstra) + great-circle geodesy.
 */
export function computePlanetaryRoute(
  origin: {
    id: string;
    name: string;
    lat: number;
    lng: number;
    elevationMeters: number;
  },
  destinationId: string,
  locomotionMode: 'rover' | 'eva_walk' = 'rover',
  speedTorqueSetting = 1.0
): PlanetaryRoutePlan | null {
  const dest = LANDMARK_BY_ID[destinationId];
  if (!dest) return null;

  const originLandmark = LANDMARK_BY_ID[origin.id] ?? null;
  const directDistanceKm = marsDistanceKm(origin, dest);
  const initialBearingDeg = Math.round(marsBearingDeg(origin, dest));
  const elevationDeltaMeters = Math.round(dest.elevationMeters - origin.elevationMeters);

  // Determine start node in planetary graph
  let startNode: MarsLandform;
  let attachFromCurrent = false;
  if (originLandmark) {
    startNode = originLandmark;
  } else {
    // Pick nearest planetary node as graph entry
    attachFromCurrent = true;
    startNode = MARS_PLANETARY_LANDMARKS.reduce((best, cand) =>
      marsDistanceKm(origin, cand) < marsDistanceKm(origin, best) ? cand : best
    );
  }

  // Dijkstra shortest-cost path across planetary adjacency graph
  const distMap: Record<string, number> = {};
  const prevMap: Record<string, string | null> = {};
  const unvisited = new Set<string>();

  for (const lf of MARS_PLANETARY_LANDMARKS) {
    distMap[lf.id] = Infinity;
    prevMap[lf.id] = null;
    unvisited.add(lf.id);
  }
  distMap[startNode.id] = 0;

  while (unvisited.size > 0) {
    let uId: string | null = null;
    let bestD = Infinity;
    for (const id of unvisited) {
      if (distMap[id] < bestD) {
        bestD = distMap[id];
        uId = id;
      }
    }
    if (!uId || bestD === Infinity || uId === dest.id) break;
    unvisited.delete(uId);

    const uNode = LANDMARK_BY_ID[uId];
    for (const vId of uNode.adjacentIds) {
      if (!unvisited.has(vId)) continue;
      const vNode = LANDMARK_BY_ID[vId];
      if (!vNode) continue;
      const geoKm = marsDistanceKm(uNode, vNode);
      const diffPenalty = 1 + (DIFFICULTY_RANK[vNode.difficulty] - 1) * 0.08;
      const alt = bestD + geoKm * diffPenalty;
      if (alt < distMap[vId]) {
        distMap[vId] = alt;
        prevMap[vId] = uId;
      }
    }
  }

  // Reconstruct node chain
  const nodeChain: MarsLandform[] = [];
  let cursorId: string | null = dest.id;
  while (cursorId) {
    const n = LANDMARK_BY_ID[cursorId];
    if (n) nodeChain.unshift(n);
    cursorId = prevMap[cursorId] ?? null;
  }
  if (nodeChain.length === 0 || nodeChain[0].id !== startNode.id) {
    nodeChain.splice(0, nodeChain.length, startNode, ...(startNode.id !== dest.id ? [dest] : []));
  }

  // Build segments using adaptive great-circle Slerp (plus Olympus cliff perimeter bypass when needed)
  const segments: RouteSegment[] = [];
  if (attachFromCurrent && marsDistanceKm(origin, startNode) > 1.0 && startNode.id !== dest.id) {
    const segKm = marsDistanceKm(origin, startNode);
    const segElev = Math.round(startNode.elevationMeters - origin.elevationMeters);
    segments.push({
      fromId: origin.id,
      fromName: origin.name,
      toId: startNode.id,
      toName: startNode.name,
      distanceKm: segKm,
      bearingDeg: Math.round(marsBearingDeg(origin, startNode)),
      elevationDeltaMeters: segElev,
      difficulty: classifySegmentDifficulty({ elevationMeters: origin.elevationMeters }, startNode),
      hazards: buildSegmentHazards(null, startNode, segElev),
      points: generateAdaptiveGreatCircleWaypoints(origin, startNode, {
        maxPoints: 48,
        avoidOlympusCliff: true,
      }),
    });
  }

  for (let i = 0; i < nodeChain.length - 1; i++) {
    const a = nodeChain[i];
    const b = nodeChain[i + 1];
    const segKm = marsDistanceKm(a, b);
    const segElev = Math.round(b.elevationMeters - a.elevationMeters);
    segments.push({
      fromId: a.id,
      fromName: a.name,
      toId: b.id,
      toName: b.name,
      distanceKm: segKm,
      bearingDeg: Math.round(marsBearingDeg(a, b)),
      elevationDeltaMeters: segElev,
      difficulty: classifySegmentDifficulty(a, b),
      hazards: buildSegmentHazards(a, b, segElev),
      points: generateAdaptiveGreatCircleWaypoints(a, b, {
        maxPoints: 56,
        avoidOlympusCliff: true,
      }),
    });
  }

  // If origin === dest (or single-hop direct from non-landmark close to dest)
  if (segments.length === 0 && directDistanceKm > 0.05) {
    segments.push({
      fromId: origin.id,
      fromName: origin.name,
      toId: dest.id,
      toName: dest.name,
      distanceKm: directDistanceKm,
      bearingDeg: initialBearingDeg,
      elevationDeltaMeters,
      difficulty: classifySegmentDifficulty({ elevationMeters: origin.elevationMeters }, dest),
      hazards: buildSegmentHazards(originLandmark, dest, elevationDeltaMeters),
      points: generateAdaptiveGreatCircleWaypoints(origin, dest, {
        maxPoints: 48,
        avoidOlympusCliff: true,
      }),
    });
  }

  const corridorDistanceKm =
    segments.length > 0
      ? segments.reduce((acc, s) => acc + s.distanceKm, 0)
      : directDistanceKm;

  let overallDifficulty: TraversalDifficulty = dest.difficulty;
  if (originLandmark) {
    overallDifficulty = maxDifficulty(overallDifficulty, originLandmark.difficulty);
  }
  for (const s of segments) {
    overallDifficulty = maxDifficulty(overallDifficulty, s.difficulty);
  }

  const constraintsSummary = Array.from(
    new Set([
      ...segments.flatMap((s) => s.hazards),
      ...dest.terrainConstraints.slice(0, 2),
    ])
  ).slice(0, 5);

  const directEtaMinutes = estimateMarsTravelEtaMinutes(
    directDistanceKm * 1000,
    locomotionMode,
    speedTorqueSetting
  );
  const corridorEtaMinutes = estimateMarsTravelEtaMinutes(
    corridorDistanceKm * 1000,
    locomotionMode,
    speedTorqueSetting
  );

  const elevSign = elevationDeltaMeters >= 0 ? '+' : '';
  const logisticalAdvisory =
    overallDifficulty === 'EXTREME'
      ? `Extreme planetary relief (${elevSign}${(elevationDeltaMeters / 1000).toFixed(1)} km Δelev across ${corridorDistanceKm.toFixed(0)} km). Pressurized Rover mode recommended with autonomous hazard avoidance and orbital relay.`
      : overallDifficulty === 'HIGH'
        ? `High-difficulty corridor (${corridorDistanceKm.toFixed(0)} km, ${elevSign}${(elevationDeltaMeters / 1000).toFixed(1)} km Δelev). Expect steep escarpments or eolian slip zones; monitor battery reserves.`
        : `Traversable regional corridor (${corridorDistanceKm.toFixed(0)} km). Maintain standard solar dust management and UHF telemetry checks.`;

  return {
    originId: origin.id,
    originName: origin.name,
    originLatLng: { lat: origin.lat, lng: origin.lng },
    originElevationMeters: origin.elevationMeters,
    destinationId: dest.id,
    destinationName: dest.name,
    destinationLatLng: { lat: dest.lat, lng: dest.lng },
    destinationElevationMeters: dest.elevationMeters,
    directDistanceKm,
    corridorDistanceKm,
    initialBearingDeg,
    elevationDeltaMeters,
    overallDifficulty,
    directEtaMinutes,
    corridorEtaMinutes,
    corridorNodeIds: nodeChain.map((n) => n.id),
    segments,
    constraintsSummary,
    logisticalAdvisory,
  };
}

export function sampleGreatCircleArc(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  steps = 24
): Array<{ lat: number; lng: number }> {
  const totalMeters = marsDistanceKm(from, to) * 1000;
  if (totalMeters <= 10 || steps <= 1) {
    return [
      { lat: from.lat, lng: normalizeSignedLng180(from.lng) },
      { lat: to.lat, lng: normalizeSignedLng180(to.lng) },
    ];
  }
  const safeSteps = Math.max(2, Math.min(256, Math.round(steps)));
  const pts: Array<{ lat: number; lng: number }> = [];
  for (let i = 0; i <= safeSteps; i++) {
    pts.push(slerpLatLng(from, to, i / safeSteps));
  }
  return pts;
}

const OLYMPUS_CLIFF_CENTER = { lat: 18.65, lng: -133.8 };
const OLYMPUS_SAFE_DETOUR_RADIUS_KM = 328;

/**
 * Generates adaptive spherical great-circle waypoints between `from` and `to`:
 * - Uses coarse macro-waypoints (~350 km) across smooth lowland plains and finer micro-waypoints
 *   (~70 km) near steep canyons, polar troughs, or rugged cratered highlands.
 * - Automatically inserts a perimeter tangent detour around the 315 km Olympus Mons sheer basal
 *   cliff ring when neither endpoint is inside the shield plateau.
 */
export function generateAdaptiveGreatCircleWaypoints(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  options?: {
    maxPoints?: number;
    avoidOlympusCliff?: boolean;
  }
): Array<{ lat: number; lng: number }> {
  const maxPoints = Math.max(4, Math.min(120, options?.maxPoints ?? 48));
  const avoidOlympus = options?.avoidOlympusCliff !== false;
  const totalKm = marsDistanceKm(from, to);

  if (totalKm < 0.05) {
    return [{ lat: from.lat, lng: normalizeSignedLng180(from.lng) }];
  }

  // Check if a straight great-circle arc intersects the Olympus Mons 315 km cliff ring
  const anchorNodes: Array<{ lat: number; lng: number }> = [
    { lat: from.lat, lng: normalizeSignedLng180(from.lng) },
  ];

  if (avoidOlympus) {
    const fromDist = marsDistanceKm(from, OLYMPUS_CLIFF_CENTER);
    const toDist = marsDistanceKm(to, OLYMPUS_CLIFF_CENTER);
    if (fromDist > OLYMPUS_SAFE_DETOUR_RADIUS_KM && toDist > OLYMPUS_SAFE_DETOUR_RADIUS_KM) {
      let intersectsCliff = false;
      const probeCount = 16;
      for (let i = 1; i < probeCount; i++) {
        const probe = slerpLatLng(from, to, i / probeCount);
        if (marsDistanceKm(probe, OLYMPUS_CLIFF_CENTER) <= 316) {
          intersectsCliff = true;
          break;
        }
      }
      if (intersectsCliff) {
        const brgStart = marsBearingDeg(OLYMPUS_CLIFF_CENTER, from);
        const brgEnd = marsBearingDeg(OLYMPUS_CLIFF_CENTER, to);
        let delta = ((brgEnd - brgStart + 540) % 360) - 180;
        if (Math.abs(delta) < 1) delta = 90;
        const arcSamples = Math.max(2, Math.min(5, Math.ceil(Math.abs(delta) / 45)));
        for (let k = 1; k <= arcSamples; k++) {
          const brg = (brgStart + (delta * k) / (arcSamples + 1) + 360) % 360;
          anchorNodes.push(
            marsStepGreatCircle(OLYMPUS_CLIFF_CENTER, brg, OLYMPUS_SAFE_DETOUR_RADIUS_KM * 1000)
          );
        }
      }
    }
  }

  anchorNodes.push({ lat: to.lat, lng: normalizeSignedLng180(to.lng) });

  const result: Array<{ lat: number; lng: number }> = [anchorNodes[0]];
  for (let segIdx = 0; segIdx < anchorNodes.length - 1; segIdx++) {
    const segA = anchorNodes[segIdx];
    const segB = anchorNodes[segIdx + 1];
    const segKm = marsDistanceKm(segA, segB);
    if (segKm < 1) {
      result.push(segB);
      continue;
    }

    // Coarse 350 km stepping on smooth lowlands, refine near high-relief landmarks or poles
    const probeSteps = Math.max(4, Math.min(24, Math.ceil(segKm / 260)));
    let prevIncluded = segA;
    for (let i = 1; i < probeSteps; i++) {
      if (result.length >= maxPoints - 2) break;
      const pt = slerpLatLng(segA, segB, i / probeSteps);
      const nearHighRelief =
        Math.abs(pt.lat) > 74 ||
        marsDistanceKm(pt, { lat: -13.9, lng: -59.2 }) < 900 || // Valles Marineris
        marsDistanceKm(pt, OLYMPUS_CLIFF_CENTER) < 550;
      const targetSpacingKm = nearHighRelief ? 110 : 340;
      if (marsDistanceKm(prevIncluded, pt) >= targetSpacingKm) {
        result.push(pt);
        prevIncluded = pt;
      }
    }
    result.push(segB);
  }

  return result;
}

/**
 * Splits a lat/lng sequence into non-wrapping Leaflet polyline segments across the ±180° antimeridian,
 * inserting exact interpolated seam vertices at ±180° so polylines connect cleanly to the map boundary.
 */
export function splitAntimeridianPolyline(
  points: Array<{ lat: number; lng: number }>
): Array<Array<[number, number]>> {
  if (points.length === 0) return [];
  const chunks: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [
    [points[0].lat, normalizeSignedLng180(points[0].lng)],
  ];

  for (let i = 1; i < points.length; i++) {
    const prevLat = points[i - 1].lat;
    const prevLng = normalizeSignedLng180(points[i - 1].lng);
    const currLat = points[i].lat;
    const currLng = normalizeSignedLng180(points[i].lng);
    const rawDiff = currLng - prevLng;

    if (Math.abs(rawDiff) > 180) {
      // Shortest signed delta across ±180°
      const signedDelta = shortestLngDeltaDeg(prevLng, currLng);
      const exitBoundary = signedDelta > 0 ? 180 : -180;
      const entryBoundary = -exitBoundary;
      const distToSeam = exitBoundary - prevLng;
      const t = Math.abs(signedDelta) > 1e-6 ? Math.max(0, Math.min(1, distToSeam / signedDelta)) : 0.5;
      const crossLat = prevLat + (currLat - prevLat) * t;

      current.push([crossLat, exitBoundary]);
      chunks.push(current);
      current = [
        [crossLat, entryBoundary],
        [currLat, currLng],
      ];
    } else {
      current.push([currLat, currLng]);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
