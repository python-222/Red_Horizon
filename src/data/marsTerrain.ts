/**
 * Shared Huge Martian World Model (3,600m x 3,600m Jezero Crater & Belva Delta Sector)
 * Grounded in NASA MRO HiRISE DTM (PSP_001415_1985), Mars Odyssey THEMIS Thermal Inertia,
 * and Mars 2020 Perseverance Traverse Landmarks.
 */

import {
  MarsBiomeId,
  SeasonalFrostMode,
  TopographicTelemetry,
} from '../types/telemetry';
import { getMarsDemVersion, isMarsDemReady, sampleMolaMeters } from './marsDem';
import { geoClassForBiome, geomorphDetail, type GeoClass } from './terrainGeomorph';
import {
  MARS_PLANETARY_LANDMARKS,
  LANDFORM_CATEGORY_COLORS,
  LandformCategory,
  MarsLandform,
  LandmarkTier,
  TraversalDifficulty,
  PlanetaryRoutePlan,
  RegionalZoneOverlay,
  MARS_REGIONAL_ZONES,
  LANDMARK_BY_ID,
  MARS_METERS_PER_DEG_LAT,
  marsDistanceKm,
  marsBearingDeg,
  marsStepGreatCircle,
  latLngToAzimuthalMeters,
  azimuthalMetersToLatLng,
  orthographicProject,
  orthographicInverse,
  estimatePlanetaryElevationMeters,
  estimateMarsTravelEtaMinutes,
  formatAreographicCoords,
  toEastLongitude360,
  normalizeSignedLng180,
  shortestLngDeltaDeg,
  slerpLatLng,
  computePlanetaryRoute,
  sampleGreatCircleArc,
  generateAdaptiveGreatCircleWaypoints,
  splitAntimeridianPolyline,
} from './marsCartography';

export type {
  LandformCategory,
  MarsLandform,
  LandmarkTier,
  TraversalDifficulty,
  PlanetaryRoutePlan,
  RegionalZoneOverlay,
};

export {
  LANDFORM_CATEGORY_COLORS,
  MARS_REGIONAL_ZONES,
  LANDMARK_BY_ID,
  MARS_METERS_PER_DEG_LAT,
  marsDistanceKm,
  marsBearingDeg,
  marsStepGreatCircle,
  latLngToAzimuthalMeters,
  azimuthalMetersToLatLng,
  orthographicProject,
  orthographicInverse,
  estimatePlanetaryElevationMeters,
  estimateMarsTravelEtaMinutes,
  formatAreographicCoords,
  toEastLongitude360,
  normalizeSignedLng180,
  shortestLngDeltaDeg,
  slerpLatLng,
  computePlanetaryRoute,
  sampleGreatCircleArc,
  generateAdaptiveGreatCircleWaypoints,
  splitAntimeridianPolyline,
};

export interface MarsWaypoint {
  id: string;
  name: string;
  x: number;
  z: number;
  type: 'habitat' | 'science' | 'cache' | 'landmark';
  description: string;
}

export const VISOR_PROXIMITY_THRESHOLD_KM = 300;

export const WAYPOINT_TYPE_COLORS: Record<MarsWaypoint['type'], { hex: string; num: number }> = {
  habitat: { hex: '#10b981', num: 0x10b981 },
  cache: { hex: '#38bdf8', num: 0x38bdf8 },
  science: { hex: '#f59e0b', num: 0xf59e0b },
  landmark: { hex: '#06b6d4', num: 0x06b6d4 },
};

export interface RadiationHotspot {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
  doseRateMicroSvHr: number;
}

export interface CraterFeature {
  name: string;
  x: number;
  z: number;
  radius: number;
  depth: number;
  rimHeight: number;
}

export const WORLD_HALF_EXTENT = 1800; // 3,600m x 3,600m total playable terrain

// Official & Extended Jezero Crater Landmarks across the 3.6 km map
export const MARS_WAYPOINTS: MarsWaypoint[] = [
  {
    id: 'HAB-01',
    name: 'Jezero Pressurized Habitat',
    x: 0,
    z: 0,
    type: 'habitat',
    description: 'Primary life-support airlock, O2 recharge manifold & radiation shelter.',
  },
  {
    id: 'WP-01',
    name: 'Octavia E. Butler Touchdown',
    x: 160,
    z: -140,
    type: 'landmark',
    description: 'Perseverance landing pad & basaltic crater floor benchmark.',
  },
  {
    id: 'WP-02',
    name: 'Séítah Aeolian Sand Dunes',
    x: -220,
    z: 280,
    type: 'science',
    description: 'Olivine-rich bedrock exposed beneath migrating dark sand ripples.',
  },
  {
    id: 'WP-03',
    name: 'Kodiak Butte Overlook',
    x: -440,
    z: 490,
    type: 'landmark',
    description: 'Isolated flat-topped delta remnant showing ancient river cross-bedding.',
  },
  {
    id: 'WP-DELTA-04',
    name: 'Belva Outcrop / Delta Rim',
    x: -580,
    z: 860,
    type: 'science',
    description: 'Primary geological drill target perched above the 18.4% delta escarpment.',
  },
  {
    id: 'WP-CRATER-05',
    name: 'Belva Impact Bowl Rim',
    x: -920,
    z: 1080,
    type: 'science',
    description: '900m-wide impact crater exposing deep Noachian crustal stratigraphy.',
  },
  {
    id: 'WP-RIDGE-06',
    name: 'Neretva Vallis Channel Ridge',
    x: 540,
    z: 920,
    type: 'landmark',
    description: 'Ancient river inlet valley carving through the western crater wall.',
  },
  {
    id: 'WP-CACHE-07',
    name: 'Emergency O2 & Power Depot',
    x: 340,
    z: 420,
    type: 'cache',
    description: 'Autonomous surface supply cache with reserve O2 canisters & RTG link.',
  },
];

// Global Planetary Landmarks, Broad Regional Features & Surface Zones
export const MARS_LANDFORMS: MarsLandform[] = MARS_PLANETARY_LANDMARKS;

const JEZERO_ORIGIN_LAT = 18.44;
const JEZERO_ORIGIN_LON = 77.45;
const METERS_PER_DEG_LAT_CONST = 59274;
const METERS_PER_DEG_LON_CONST = METERS_PER_DEG_LAT_CONST * Math.cos((JEZERO_ORIGIN_LAT * Math.PI) / 180);

export function jezeroLocalToLatLng(x: number, y: number): { lat: number; lng: number } {
  return {
    lat: JEZERO_ORIGIN_LAT + y / METERS_PER_DEG_LAT_CONST,
    lng: JEZERO_ORIGIN_LON + x / METERS_PER_DEG_LON_CONST,
  };
}

export type ScienceFeatureCategory = 'DELTA_FORMATION' | 'SUBSURFACE_ICE' | 'MINERAL_RESERVE';

export interface ScienceFeature {
  id: string;
  name: string;
  category: ScienceFeatureCategory;
  categoryLabel: string;
  x: number;
  z: number;
  discoveryRadiusMeters: number;
  colorHex: string;
  colorNum: number;
  mineralSignature: string;
  summary: string;
}

export const JEZERO_SCIENCE_FEATURES: ScienceFeature[] = [
  {
    id: 'SCI-DELTA-01',
    name: 'Neretva Delta Escarpment Bench',
    category: 'DELTA_FORMATION',
    categoryLabel: 'DELTA FORMATION',
    x: -260,
    z: 340,
    discoveryRadiusMeters: 120,
    colorHex: '#f59e0b',
    colorNum: 0xf59e0b,
    mineralSignature: 'Cross-bedded Fluvial Sandstone & Siltstone',
    summary: 'Stratified ancient river delta terrace with horizontal bedding planes and eroded basal talus aprons.',
  },
  {
    id: 'SCI-DELTA-02',
    name: 'Kodiak Stratified Mesa Terrace',
    category: 'DELTA_FORMATION',
    categoryLabel: 'DELTA FORMATION',
    x: -440,
    z: 490,
    discoveryRadiusMeters: 120,
    colorHex: '#f59e0b',
    colorNum: 0xf59e0b,
    mineralSignature: 'Prograding Gilbert Delta Foreset Beds',
    summary: 'Isolated flat-topped delta remnant preserving ancient lake-level cross-bedding and conglomerate lenses.',
  },
  {
    id: 'SCI-DELTA-03',
    name: 'Belva Delta Stratigraphy Scarp',
    category: 'DELTA_FORMATION',
    categoryLabel: 'DELTA FORMATION',
    x: -580,
    z: 860,
    discoveryRadiusMeters: 120,
    colorHex: '#f59e0b',
    colorNum: 0xf59e0b,
    mineralSignature: 'Lacustrine Mudstone & Phyllosilicates',
    summary: '18.4% delta escarpment exposing layered lacustrine mudstone prime for astrobiological core sampling.',
  },
  {
    id: 'SCI-ICE-01',
    name: 'Séítah North-Wall Subsurface Ice',
    category: 'SUBSURFACE_ICE',
    categoryLabel: 'SUBSURFACE ICE',
    x: -490,
    z: -310,
    discoveryRadiusMeters: 120,
    colorHex: '#38bdf8',
    colorNum: 0x38bdf8,
    mineralSignature: 'Exposed H₂O Ice Clasts & Regolith Frost',
    summary: 'Shadowed north-facing crater wall pocket exposing translucent blue-white subsurface water-ice boulders.',
  },
  {
    id: 'SCI-ICE-02',
    name: 'South Micro-Crater Shadow Ice Lens',
    category: 'SUBSURFACE_ICE',
    categoryLabel: 'SUBSURFACE ICE',
    x: -175,
    z: -705,
    discoveryRadiusMeters: 120,
    colorHex: '#38bdf8',
    colorNum: 0x38bdf8,
    mineralSignature: 'Crystalline Water-Ice & Ferric Dust Coating',
    summary: 'Deep micro-crater shadow trap preserving jagged subsurface water-ice formations dusted with red regolith.',
  },
  {
    id: 'SCI-ICE-03',
    name: 'North Escarpment Ice Pocket',
    category: 'SUBSURFACE_ICE',
    categoryLabel: 'SUBSURFACE ICE',
    x: 155,
    z: 1180,
    discoveryRadiusMeters: 120,
    colorHex: '#38bdf8',
    colorNum: 0x38bdf8,
    mineralSignature: 'Subsurface Permafrost & Brine-Altered Ice',
    summary: 'North-facing escarpment recess revealing fractured translucent water-ice veins beneath basaltic talus.',
  },
  {
    id: 'SCI-MIN-01',
    name: 'Séítah Olivine & Carbonate Vein',
    category: 'MINERAL_RESERVE',
    categoryLabel: 'MINERAL RESERVE',
    x: -140,
    z: 220,
    discoveryRadiusMeters: 120,
    colorHex: '#a3e635',
    colorNum: 0xa3e635,
    mineralSignature: 'Mg-Carbonate, Forsterite Olivine & Sulfates',
    summary: 'Dark vesicular volcanic basalt outcrop cut by iridescent green-gold olivine and carbonate mineral veins.',
  },
  {
    id: 'SCI-MIN-02',
    name: 'Butler Basalt & Hydrated Silica Reserve',
    category: 'MINERAL_RESERVE',
    categoryLabel: 'MINERAL RESERVE',
    x: 245,
    z: -85,
    discoveryRadiusMeters: 120,
    colorHex: '#2dd4bf',
    colorNum: 0x2dd4bf,
    mineralSignature: 'Opalescent Hydrated Silica & Basaltic Glass',
    summary: 'Vesicular crater-floor basalt spire laced with iridescent hydrated silica and metallic oxide seams.',
  },
  {
    id: 'SCI-MIN-03',
    name: 'East Basin Carbonate & Olivine Ridge',
    category: 'MINERAL_RESERVE',
    categoryLabel: 'MINERAL RESERVE',
    x: 490,
    z: 240,
    discoveryRadiusMeters: 120,
    colorHex: '#a3e635',
    colorNum: 0xa3e635,
    mineralSignature: 'Authigenic Carbonate & Fe/Mg-Smectite',
    summary: 'High-value mineral reserve ridge featuring dark pitted basalt and iridescent carbonate fracture fills.',
  },
];

// Realistic impact craters embedded in the heightfield
export const MARS_CRATERS: CraterFeature[] = [
  { name: 'Belva Crater', x: -980, z: 1180, radius: 240, depth: 36, rimHeight: 11 },
  { name: 'Séítah Bowl', x: -520, z: -380, radius: 145, depth: 20, rimHeight: 6 },
  { name: 'Neretva Depression', x: 680, z: 640, radius: 185, depth: 26, rimHeight: 8 },
  { name: 'East Basin Crater', x: 820, z: -520, radius: 210, depth: 30, rimHeight: 9 },
  { name: 'South Micro-Crater', x: -180, z: -760, radius: 95, depth: 14, rimHeight: 4.5 },
  { name: 'North Escarpment Pit', x: 140, z: 1250, radius: 130, depth: 22, rimHeight: 7 },
];

// Secondary micro-craters for fine HiRISE surface authenticity
const SECONDARY_MICRO_CRATERS: ReadonlyArray<{ x: number; z: number; radius: number; depth: number; rimHeight: number }> = [
  { x: 260, z: 180, radius: 38, depth: 5.5, rimHeight: 1.8 },
  { x: -310, z: 110, radius: 44, depth: 6.2, rimHeight: 2.1 },
  { x: 420, z: -260, radius: 52, depth: 7.4, rimHeight: 2.4 },
  { x: -720, z: 240, radius: 64, depth: 8.8, rimHeight: 2.8 },
  { x: 110, z: -430, radius: 48, depth: 6.8, rimHeight: 2.2 },
  { x: -85, z: 610, radius: 42, depth: 5.8, rimHeight: 1.9 },
  { x: 960, z: 260, radius: 58, depth: 8.0, rimHeight: 2.5 },
  { x: -1120, z: -680, radius: 75, depth: 10.5, rimHeight: 3.2 },
];

/**
 * Evaluates a realistic Martian impact crater profile:
 * flat dust-filled floor -> terraced/sloped inner wall -> raised ejecta rim -> hummocky ejecta apron.
 */
function evalSculptedCrater(
  x: number,
  z: number,
  cx: number,
  cz: number,
  radius: number,
  depth: number,
  rimHeight: number,
  scaleMult = 1.0
): number {
  const dx = x - cx;
  const dz = z - cz;
  const maxR = radius * 1.65;
  if (Math.abs(dx) > maxR || Math.abs(dz) > maxR) return 0;
  const d = Math.hypot(dx, dz);
  if (d >= maxR) return 0;

  const norm = d / radius;
  const angle = Math.atan2(dz, dx);

  if (norm < 1.0) {
    // Flat dust-filled floor for inner 44% of radius, smoothly curving up a sloped wall to rim crest
    const floorRadius = 0.44;
    let bowl = -depth;
    if (norm >= floorRadius) {
      const t = (norm - floorRadius) / (1.0 - floorRadius); // 0 at floor edge, 1 at rim
      // Smooth S-curve wall with subtle slump terrace around mid-wall
      const smoothWall = t * t * (3 - 2 * t);
      const terrace = Math.sin(t * Math.PI * 2.0) * 0.045 * (1 - t);
      bowl = -depth * (1.0 - Math.min(1.0, smoothWall + terrace));
    } else {
      // Very gentle saucer settling on flat dust floor
      const ft = norm / floorRadius;
      bowl = -depth * (1.0 - ft * ft * 0.06);
    }
    const rim = Math.exp(-Math.pow((norm - 1.0) / 0.14, 2)) * rimHeight;
    return (bowl + rim) * scaleMult;
  }

  // Outer ejecta rim + hummocky radial ejecta blanket decaying smoothly to zero at 1.65R
  const rimFalloff = Math.exp(-Math.pow((norm - 1.0) / 0.22, 2)) * rimHeight;
  const ejectaFade = Math.max(0, 1.0 - (norm - 1.0) / 0.65);
  const ejectaLobes =
    (Math.sin(angle * 11 + norm * 5.0) * 0.5 + 0.5) * rimHeight * 0.22 * ejectaFade * ejectaFade;
  return (rimFalloff + ejectaLobes) * scaleMult;
}

// Ionizing radiation / solar proton exposure hotspots (elevated secondary neutron albedo)
export const RADIATION_HOTSPOTS: RadiationHotspot[] = [
  {
    id: 'RAD-ZONE-A',
    name: 'Belva Rim Albedo Hotspot',
    x: -760,
    z: 740,
    radius: 135,
    doseRateMicroSvHr: 54.0,
  },
  {
    id: 'RAD-ZONE-B',
    name: 'Neretva Fault Ionizing Pocket',
    x: 360,
    z: 780,
    radius: 120,
    doseRateMicroSvHr: 48.5,
  },
  {
    id: 'RAD-ZONE-C',
    name: 'East Basin Secondary Neutron Field',
    x: 560,
    z: -240,
    radius: 145,
    doseRateMicroSvHr: 42.0,
  },
];

// --- REAL NASA MOLA TERRAIN FRAME -------------------------------------------------------------
// Local (x east, z north) meters map to Mars lat/lng so every system samples the same real DEM.
// Without an anchor the frame is the Jezero frame (hab at 0,0). During a global override the
// viewport/vehicle anchors the frame at the rover's position so the 3D terrain is the actual
// MOLA surface around that exact latitude/longitude.
interface TerrainAnchor {
  id: number;
  lat: number;
  lng: number;
  x0: number;
  z0: number;
  baseMola: number; // MOLA elevation at the anchor (NaN until sampled)
}

let terrainAnchor: TerrainAnchor | null = null;
let terrainAnchorSeq = 0;
// Re-anchoring discards every terrain chunk, so only do it for a real jump. During autopilot the
// lat/lng advances faster than the local x/y (long legs run at hundreds of m/s), which used to
// trip a 1.5 km threshold about once a second and made the autopilot visibly choppy.
const ANCHOR_REBASE_METERS = 8000;
const JEZERO_DATUM_METERS = 2552; // hab/telemetry datum: telemetry elevation = h - 2552 = real MOLA

function localToLatLng(x: number, z: number): { lat: number; lng: number } {
  const a = terrainAnchor;
  if (!a) return jezeroLocalToLatLng(x, z);
  const lat = a.lat + (z - a.z0) / METERS_PER_DEG_LAT_CONST;
  const cosLat = Math.max(0.05, Math.cos((a.lat * Math.PI) / 180));
  const lng = a.lng + (x - a.x0) / (METERS_PER_DEG_LAT_CONST * cosLat);
  return { lat, lng };
}

/**
 * Compass heading (degrees clockwise from north) toward the largest real relief within 40 km of
 * a point: the bearing with the greatest elevation angle to the horizon. Returns null when the
 * DEM is not loaded or the surroundings are flat (< 1.5 deg). Used so teleports face the mountain.
 */
export function findScenicHeadingDeg(lat: number, lng: number): number | null {
  if (!isMarsDemReady()) return null;
  const e0 = sampleMolaMeters(lat, lng);
  const mPerDegLng = METERS_PER_DEG_LAT_CONST * Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  let bestAngle = 0;
  let bestHeading = 0;
  for (let brg = 0; brg < 360; brg += 10) {
    const rad = (brg * Math.PI) / 180;
    for (let km = 2; km <= 40; km += 2) {
      const d = km * 1000;
      const e = sampleMolaMeters(
        lat + (d * Math.cos(rad)) / METERS_PER_DEG_LAT_CONST,
        lng + (d * Math.sin(rad)) / mPerDegLng
      );
      const angle = Math.atan2(e - e0, d);
      if (angle > bestAngle) {
        bestAngle = angle;
        bestHeading = brg;
      }
    }
  }
  return bestAngle * (180 / Math.PI) >= 1.5 ? bestHeading : null;
}

/** Stable id of the active terrain frame; changes whenever the frame is re-anchored. */
export function getTerrainFrameId(): number {
  return (terrainAnchor ? terrainAnchor.id : 0) * 1000 + (getMarsDemVersion() % 1000);
}

/**
 * Keeps the terrain frame in sync with the rover pose. Returns true when the frame changed
 * (callers should rebuild any cached terrain).
 */
export function syncTerrainAnchor(
  isGlobalOverride: boolean,
  lat: number,
  lng: number,
  x: number,
  z: number,
  isPlanetaryWarp = false
): boolean {
  if (!isGlobalOverride) {
    if (!terrainAnchor) return false;
    terrainAnchor = null;
    return true;
  }
  if (terrainAnchor) {
    // Mid-warp the lat/lng races ahead of the local frame; keep the terrain steady and re-anchor
    // once, after the rover slows to a normal speed.
    if (isPlanetaryWarp) return false;
    const exp = localToLatLng(x, z);
    const dLat = (lat - exp.lat) * METERS_PER_DEG_LAT_CONST;
    let dLng = lng - exp.lng;
    dLng = ((((dLng + 180) % 360) + 360) % 360) - 180;
    const dEast = dLng * METERS_PER_DEG_LAT_CONST * Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    if (Math.hypot(dLat, dEast) < ANCHOR_REBASE_METERS) return false;
  }
  terrainAnchor = { id: ++terrainAnchorSeq, lat, lng, x0: x, z0: z, baseMola: Number.NaN };
  return true;
}

function hash2(ix: number, iz: number): number {
  const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function valueNoise2(x: number, z: number): number {
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

/**
 * Self-similar fractal relief layered on the real DEM. MOLA is ~463 m/px, so structure below
 * that scale is NOT NASA data; it is statistically plausible texture whose amplitude follows
 * the real local ruggedness (`rough`, derived from the real slope), octave by octave:
 * ~0.5% of wavelength, i.e. ~3% slope per octave on rough terrain, much less on plains.
 */
const DETAIL_TOP_WAVELENGTH = 2000;
const DETAIL_OCTAVES = 8; // 2000 m down to ~16 m
const DETAIL_AMP_PER_WAVELENGTH = 0.0048;

export function terrainRoughnessFromSlope(slopeRiseOverRun: number): number {
  return Math.max(0.3, Math.min(1.8, 0.3 + slopeRiseOverRun * 14));
}

/** Fractal relief in meters. `minWavelength` drops octaves a coarse mesh cannot represent. */
export function fractalTerrainDetail(
  x: number,
  z: number,
  rough: number,
  minWavelength: number
): number {
  let sum = 0;
  let lambda = DETAIL_TOP_WAVELENGTH;
  for (let i = 0; i < DETAIL_OCTAVES; i++, lambda *= 0.5) {
    if (lambda < minWavelength) break;
    const c = Math.cos(0.61 * i + 0.4);
    const s = Math.sin(0.61 * i + 0.4);
    const u = (x * c - z * s) / lambda + i * 17.31;
    const v = (x * s + z * c) / lambda - i * 9.17;
    sum += (valueNoise2(u, v) - 0.5) * 2 * DETAIL_AMP_PER_WAVELENGTH * lambda;
  }
  return sum * rough;
}

/**
 * Real MOLA height (no fractal detail) in the active terrain frame, in the same vertical
 * datum as getMarsElevation. Used by the distant-horizon meshes.
 */
export function getRealBaseElevation(x: number, z: number): number {
  const { lat, lng } = localToLatLng(x, z);
  const mola = sampleMolaMeters(lat, lng);
  const a = terrainAnchor;
  if (!a) return mola + JEZERO_DATUM_METERS;
  if (Number.isNaN(a.baseMola)) a.baseMola = sampleMolaMeters(a.lat, a.lng);
  return 16 + (mola - a.baseMola);
}

/**
 * All detail layered on the real elevation: fractal roughness plus the geomorphology layer
 * (craters, hills, ridges, dunes, mesas, troughs) for the active biome's terrain class.
 */
export function terrainDetailStack(
  x: number,
  z: number,
  rough: number,
  minWavelength: number,
  biomeId: MarsBiomeId,
  frostMode: SeasonalFrostMode
): number {
  const polar = biomeId === 'PLANUM_BOREUM' || biomeId === 'PLANUM_AUSTRALE';
  const smooth = polar && frostMode === 'DEPOSITION' ? 0.5 : 1;
  // Jezero's local window is real HiRISE data; keep it untouched up close, but give the distant
  // crater rim the same geology as everywhere else.
  const cls: GeoClass =
    !terrainAnchor && biomeId === 'JEZERO_CRATER' && minWavelength < 100 ? 'NONE' : geoClassForBiome(biomeId);
  return (
    (fractalTerrainDetail(x, z, rough, minWavelength) + geomorphDetail(x, z, cls, rough, minWavelength)) *
    smooth
  );
}

/** Full terrain height as seen from a mesh with the given cell size (0 = finest). */
export function getMarsElevationLod(
  x: number,
  z: number,
  rough: number,
  cellSize: number,
  biomeId: MarsBiomeId,
  frostMode: SeasonalFrostMode
): number {
  return (
    getRealBaseElevation(x, z) +
    terrainDetailStack(x, z, rough, Math.max(12, cellSize * 4), biomeId, frostMode)
  );
}

const ROUGH_PROBE_M = 120;

function getRealTerrainElevation(
  x: number,
  z: number,
  biomeId: MarsBiomeId,
  frostMode: SeasonalFrostMode
): number {
  const base = getRealBaseElevation(x, z);
  // forward differences (2 extra samples instead of 4): the roughness only needs a rough slope
  const hE = getRealBaseElevation(x + ROUGH_PROBE_M, z);
  const hN = getRealBaseElevation(x, z + ROUGH_PROBE_M);
  const slope = Math.hypot(hE - base, hN - base) / ROUGH_PROBE_M;
  const rough = terrainRoughnessFromSlope(slope);
  return base + terrainDetailStack(x, z, rough, 12, biomeId, frostMode);
}

/**
 * Mars terrain heightfield in the local frame. Real NASA MOLA elevation (see marsDem.ts) once
 * loaded; the legacy procedural model is only a fallback while the DEM is unavailable.
 */
export function getMarsElevation(
  x: number,
  z: number,
  biomeId: MarsBiomeId = 'JEZERO_CRATER',
  frostMode: SeasonalFrostMode = 'SUBLIMATION'
): number {
  if (isMarsDemReady()) return getRealTerrainElevation(x, z, biomeId, frostMode);
  return getProceduralMarsElevation(x, z, biomeId, frostMode);
}

function getProceduralMarsElevation(
  x: number,
  z: number,
  biomeId: MarsBiomeId,
  frostMode: SeasonalFrostMode
): number {
  if (biomeId === 'OLYMPUS_MONS' || biomeId === 'THARSIS_BULGE') {
    const isOlympus = biomeId === 'OLYMPUS_MONS';
    const r = Math.hypot(x, z);
    const angle = Math.atan2(z, x);
    const lavaLobes =
      Math.sin(angle * 14 + r * 0.005) * 4.5 +
      Math.cos(angle * 7 - r * 0.003) * 6.2 +
      Math.sin(x * 0.022 + z * 0.018) * 1.8;

    if (isOlympus) {
      // Towering Olympus Mons volcanic shield rising steeply toward summit caldera + sheer basal cliff collar
      const peakRise = Math.max(0, 148 - Math.pow(r / 18, 0.88) * 1.35);
      // Multi-ring summit caldera collapse crater centered near (-320, 380)
      const calDist = Math.hypot(x + 320, z - 380);
      const calderaRim = Math.exp(-Math.pow((calDist - 240) / 55, 2)) * 34;
      const calderaPit = calDist < 220 ? -Math.min(46, Math.cos((calDist / 220) * (Math.PI * 0.5)) * 46) : 0;
      // Sheer 8km-scaled basal escarpment cliff plunging abruptly at r > 1180m
      const basalCliffDrop =
        r > 1160 ? -Math.min(118, Math.pow((r - 1160) / 85, 1.35) * 38) : 0;
      return 32 + peakRise + lavaLobes + calderaRim + calderaPit + basalCliffDrop;
    }

    // THARSIS_BULGE: Sculpted Tharsis Montes shield volcano cones + caldera pits + tectonic graben rifts
    const mainConeDist = Math.hypot(x + 420, z - 460);
    const mainCone = Math.max(0, 158 - Math.pow(mainConeDist / 16, 0.92) * 1.75);
    const mainCaldera =
      mainConeDist < 170 ? -Math.cos((mainConeDist / 170) * (Math.PI * 0.5)) * 38 : 0;

    const flankConeDist = Math.hypot(x - 640, z + 520);
    const flankCone = Math.max(0, 102 - Math.pow(flankConeDist / 15, 0.95) * 1.65);

    const grabenDist = Math.abs(z + x * 0.42 - 180);
    const grabenCleft = grabenDist < 95 ? -(Math.cos((grabenDist / 95) * Math.PI) + 1) * 18 : 0;
    return 18 + mainCone + mainCaldera + flankCone + grabenCleft + lavaLobes;
  }

  if (biomeId === 'VALLES_MARINERIS') {
    // Deep negative tectonic chasm trench (-135m floor -> +78m equatorial canyon plateau rim = >210m terraced canyon walls)
    const chasmCenterZ = Math.sin(x * 0.0024) * 145;
    const chasmHalfWidth = 310 + Math.sin(x * 0.0032 + 1.1) * 85;
    const distFromCenter = Math.abs(z - chasmCenterZ);

    // Branching tributary side-chasma cutting north/south
    const sideChasmDist = Math.min(
      Math.hypot((x + 360) * 1.35, Math.max(0, z - 240)),
      Math.hypot((x - 480) * 1.35, Math.max(0, -z - 220))
    );
    const effectiveWallDist = Math.min(
      Math.max(0, distFromCenter - chasmHalfWidth),
      Math.max(0, sideChasmDist - 140)
    );

    // Deep canyon floor at -135m stepping steeply up terraced strata benches to +78m plateau
    const rawClimb = Math.min(215, Math.pow(effectiveWallDist / 22, 1.25) * 24);
    const strataStep = Math.floor(rawClimb / 16) * 16 + (rawClimb % 16) * 0.42;
    const talusApron =
      effectiveWallDist > 0 && effectiveWallDist < 210
        ? (Math.sin(x * 0.032 + z * 0.025) * 4.2 + Math.cos(x * 0.07) * 2.4) * (1 - effectiveWallDist / 210)
        : 0;
    const floorRipples = Math.sin(x * 0.012) * Math.cos(z * 0.018) * 1.8;
    return -135 + strataStep + talusApron + floorRipples;
  }

  if (biomeId === 'GALE_CRATER') {
    // Concave crater basin (-42m floor) + outer crater rim ridge (+62m at r > 1160m) + Mount Sharp layered central mound (+155m)
    const r = Math.hypot(x, z);
    const rimDist = Math.min(r, 1850);
    const outerCraterRim =
      rimDist > 1140 ? Math.min(104, Math.pow((rimDist - 1140) / 145, 1.45) * 24) : 0;

    // Aeolis Mons / Mount Sharp physical central peak with stepped sedimentary strata terraces
    const distMound = Math.hypot(x + 220, z - 260);
    const rawMound = Math.max(0, 158 - Math.pow(distMound / 14.5, 0.92) * 1.85);
    const layeredTerraces = Math.floor(rawMound / 11) * 11 + (rawMound % 11) * 0.48;
    const slabFractures = Math.floor((Math.sin(x * 0.016) + Math.cos(z * 0.016)) * 2.2) * 1.1;
    const bagnoldDunes = Math.sin(x * 0.045 + z * 0.03) * 2.2;
    return -42 + layeredTerraces + outerCraterRim + slabFractures + bagnoldDunes;
  }

  if (biomeId === 'PLANUM_BOREUM' || biomeId === 'PLANUM_AUSTRALE') {
    // Bright smooth water-ice dome etched with deep spiral troughs + outer circumpolar dark dune ergs
    const r = Math.hypot(x, z);
    const theta = Math.atan2(z, x);
    const iceDome = Math.max(0, 42 - r * 0.014);
    // Deep spiral troughs curving around the polar dome
    const spiralPhase = Math.sin(r * 0.014 - theta * 3.0);
    const spiralTrough = spiralPhase > 0.42 ? -Math.pow((spiralPhase - 0.42) / 0.58, 1.35) * 30 : 0;
    const frostSmooth = frostMode === 'DEPOSITION' ? 0.45 : 1.0;
    const ergDunes = r > 1100 ? Math.sin(x * 0.038 + z * 0.022) * 4.2 * ((r - 1100) / 700) : 0;
    return 18 + iceDome + spiralTrough * frostSmooth + ergDunes * frostSmooth;
  }

  if (biomeId === 'HELLAS_PLANITIA') {
    // Deep negative impact basin floor (-95m) ringed by rugged +85m rim mountain scarps at r > 840m
    const r = Math.hypot(x, z);
    const smoothFloor = Math.sin(x * 0.008 + z * 0.007) * 1.6 + Math.cos(x * 0.02) * 0.8;
    const rimMountains =
      r > 840
        ? Math.min(182, Math.pow((r - 840) / 145, 1.42) * 34 * (0.72 + 0.36 * Math.sin(Math.atan2(z, x) * 9 + r * 0.01)))
        : 0;
    return -95 + smoothFloor + rimMountains;
  }

  if (biomeId === 'SOUTHERN_HIGHLANDS') {
    // High-density impact craters, rugged fault escarpments, and incised dried river valley (Reull Vallis)
    const escarps = Math.sin(x * 0.005 + z * 0.004) * 14 + Math.cos(x * 0.012 - z * 0.009) * 8;
    // Dried river valley channel meandering across x/z
    const valleyCenterZ = Math.sin(x * 0.0025) * 260;
    const valleyDist = Math.abs(z - valleyCenterZ);
    const riverChannel = valleyDist < 140 ? -(Math.cos((valleyDist / 140) * Math.PI) + 1) * 11 : 0;
    // High-density sculpted craters
    let craters = 0;
    for (let i = 0; i < MARS_CRATERS.length; i++) {
      const c = MARS_CRATERS[i];
      craters += evalSculptedCrater(x, z, c.x, c.z, c.radius, c.depth, c.rimHeight, 1.18);
    }
    for (let i = 0; i < SECONDARY_MICRO_CRATERS.length; i++) {
      const mc = SECONDARY_MICRO_CRATERS[i];
      craters += evalSculptedCrater(x, z, mc.x, mc.z, mc.radius, mc.depth, mc.rimHeight, 1.15);
    }
    return Math.max(1, 24 + escarps + riverChannel + craters);
  }

  if (biomeId === 'NORTHERN_LOWLANDS' || biomeId === 'SYRTIS_MAJOR') {
    // Smooth flat plains with streamlined eolian yardang ridges & occasional dark basalt shield rises
    const yardang =
      Math.sin(x * 0.014 + z * 0.032) * 1.8 +
      Math.sin(x * 0.004 - z * 0.005) * (biomeId === 'SYRTIS_MAJOR' ? 9.5 : 3.2);
    const duneField = Math.cos(x * 0.042 + z * 0.018) * 1.1;
    return Math.max(1, 8 + yardang + duneField);
  }

  // Default: JEZERO_CRATER Western Delta (NASA Mars Trek HiRISE DTM model)
  // 1. Rising Western Delta escarpment toward NW with terraced sedimentary benches
  const rawScarp = Math.max(0, (z - 160) * 0.048 - (x + 180) * 0.025);
  const scarpBench =
    rawScarp > 8
      ? rawScarp + Math.sin(rawScarp * 0.55) * 1.15
      : rawScarp;

  // 2. Outer Jezero Crater Wall rise near map perimeter (natural amphitheater boundary)
  const distFromCenter = Math.hypot(x, z);
  const rimDist = Math.min(distFromCenter, 2200);
  const rimWall = rimDist > 1350 ? Math.pow((rimDist - 1350) / 140, 1.55) * 14 : 0;

  // 3. Aeolian sand ripples and rolling ridges
  const dune =
    Math.sin(x * 0.018) * Math.cos(z * 0.016) * 2.8 +
    Math.sin(x * 0.006 + z * 0.008) * 5.6 +
    Math.cos(x * 0.058 - z * 0.044) * 0.95;

  // 4. Kodiak Butte flat-topped mesa plateau
  const distToKodiak = Math.hypot(x + 440, z - 490);
  const kodiakButte =
    distToKodiak < 105
      ? Math.min(24, (Math.cos((distToKodiak / 105) * Math.PI) + 1) * 15.5)
      : 0;

  // 5. Realistic flat-floored Impact Craters + raised ejecta rims
  let craterDelta = 0;
  for (let i = 0; i < MARS_CRATERS.length; i++) {
    const c = MARS_CRATERS[i];
    craterDelta += evalSculptedCrater(x, z, c.x, c.z, c.radius, c.depth, c.rimHeight, 1.0);
  }
  for (let i = 0; i < SECONDARY_MICRO_CRATERS.length; i++) {
    const mc = SECONDARY_MICRO_CRATERS[i];
    craterDelta += evalSculptedCrater(x, z, mc.x, mc.z, mc.radius, mc.depth, mc.rimHeight, 1.0);
  }

  return Math.max(0, 12 + scarpBench + dune + kodiakButte + rimWall + craterDelta);
}

// --- O(1) PRECOMPUTED 2D HEIGHTMAP LOOKUP GRID (COMPACT 257x257 QUANTIZED UINT16 BUFFER) ---
export const TERRAIN_GRID_RES = 256; // 257x257 grid -> ~14.06m cell spacing across 3,600m x 3,600m
const TERRAIN_GRID_STRIDE = TERRAIN_GRID_RES + 1;
const TERRAIN_GRID_SPAN = WORLD_HALF_EXTENT * 2;
const TERRAIN_GRID_CELL = TERRAIN_GRID_SPAN / TERRAIN_GRID_RES;
const INV_GRID_CELL = 1 / TERRAIN_GRID_CELL;

interface CompactElevationGrid {
  data: Uint16Array;
  minElev: number;
  decodeScale: number;
}

const elevationGridCache = new Map<string, CompactElevationGrid>();

/** Center of the precomputed grid in local meters (the active terrain anchor, else Jezero origin). */
function gridCenter(): { cx: number; cz: number } {
  return terrainAnchor ? { cx: terrainAnchor.x0, cz: terrainAnchor.z0 } : { cx: 0, cz: 0 };
}

function gridKey(biomeId: MarsBiomeId, frostMode: SeasonalFrostMode): string {
  // The geomorphology layer depends on the biome's terrain class; polar frost smooths the detail.
  return isMarsDemReady()
    ? `dem:${getTerrainFrameId()}:${geoClassForBiome(biomeId)}:${!terrainAnchor && biomeId === 'JEZERO_CRATER' ? 'j' : ''}:${biomeId === 'PLANUM_BOREUM' || biomeId === 'PLANUM_AUSTRALE' ? frostMode : ''}`
    : `${biomeId}:${frostMode}`;
}

function getOrBuildElevationGrid(
  biomeId: MarsBiomeId,
  frostMode: SeasonalFrostMode
): CompactElevationGrid {
  const key = gridKey(biomeId, frostMode);
  const { cx, cz } = gridCenter();
  const existing = elevationGridCache.get(key);
  if (existing) return existing;

  // Keep memory lean: evict oldest cached biome grid if > 3 biomes cached
  if (elevationGridCache.size >= 3) {
    const oldestKey = elevationGridCache.keys().next().value;
    if (oldestKey) elevationGridCache.delete(oldestKey);
  }

  const count = TERRAIN_GRID_STRIDE * TERRAIN_GRID_STRIDE;
  const scratch = new Float32Array(count);
  let minElev = Infinity;
  let maxElev = -Infinity;

  for (let iz = 0; iz <= TERRAIN_GRID_RES; iz++) {
    const wz = cz - WORLD_HALF_EXTENT + iz * TERRAIN_GRID_CELL;
    const rowOffset = iz * TERRAIN_GRID_STRIDE;
    for (let ix = 0; ix <= TERRAIN_GRID_RES; ix++) {
      const wx = cx - WORLD_HALF_EXTENT + ix * TERRAIN_GRID_CELL;
      const elev = getMarsElevation(wx, wz, biomeId, frostMode);
      scratch[rowOffset + ix] = elev;
      if (elev < minElev) minElev = elev;
      if (elev > maxElev) maxElev = elev;
    }
  }

  const span = Math.max(1e-3, maxElev - minElev);
  const encodeScale = 65535 / span;
  const data = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    data[i] = Math.round((scratch[i] - minElev) * encodeScale);
  }

  const compactGrid: CompactElevationGrid = {
    data,
    minElev,
    decodeScale: span / 65535,
  };
  elevationGridCache.set(key, compactGrid);
  return compactGrid;
}

/**
 * O(1) bilinearly interpolated terrain elevation lookup from precomputed 257x257 quantized heightmap grid.
 * Eliminates expensive per-frame Three.js mesh raycasting during manual rover driving.
 */
export function sampleTerrainGridElevation(
  x: number,
  z: number,
  biomeId: MarsBiomeId = 'JEZERO_CRATER',
  frostMode: SeasonalFrostMode = 'SUBLIMATION'
): number {
  const { cx, cz } = gridCenter();
  const lx = x - cx;
  const lz = z - cz;
  if (Math.abs(lx) >= WORLD_HALF_EXTENT || Math.abs(lz) >= WORLD_HALF_EXTENT) {
    return getMarsElevation(x, z, biomeId, frostMode);
  }
  const { data, minElev, decodeScale } = getOrBuildElevationGrid(biomeId, frostMode);
  const fx = Math.max(0, Math.min(TERRAIN_GRID_RES - 1e-4, (lx + WORLD_HALF_EXTENT) * INV_GRID_CELL));
  const fz = Math.max(0, Math.min(TERRAIN_GRID_RES - 1e-4, (lz + WORLD_HALF_EXTENT) * INV_GRID_CELL));

  const ix = fx | 0;
  const iz = fz | 0;
  const tx = fx - ix;
  const tz = fz - iz;

  // Catmull-Rom bicubic: heights AND slopes are continuous across grid cells. (Plain bilinear made
  // every 14 m cell a flat facet with a crease at its edges, which is what read as "low poly".)
  const last = TERRAIN_GRID_RES;
  const xa = ix > 0 ? ix - 1 : 0;
  const xb = ix;
  const xc = ix + 1 > last ? last : ix + 1;
  const xd = ix + 2 > last ? last : ix + 2;
  const rowAt = (z0: number): number => {
    const o = (z0 < 0 ? 0 : z0 > last ? last : z0) * TERRAIN_GRID_STRIDE;
    const p0 = data[o + xa];
    const p1 = data[o + xb];
    const p2 = data[o + xc];
    const p3 = data[o + xd];
    return (
      p1 +
      0.5 * tx * (p2 - p0 + tx * (2 * p0 - 5 * p1 + 4 * p2 - p3 + tx * (3 * (p1 - p2) + p3 - p0)))
    );
  };
  const q0 = rowAt(iz - 1);
  const q1 = rowAt(iz);
  const q2 = rowAt(iz + 1);
  const q3 = rowAt(iz + 2);
  const h =
    q1 +
    0.5 * tz * (q2 - q0 + tz * (2 * q0 - 5 * q1 + 4 * q2 - q3 + tz * (3 * (q1 - q2) + q3 - q0)));
  return minElev + h * decodeScale;
}

/**
 * O(1) surface normal and gradient lookup using precomputed heightmap grid central differences.
 */
export function sampleTerrainGridNormalAndSlope(
  x: number,
  z: number,
  biomeId: MarsBiomeId = 'JEZERO_CRATER',
  frostMode: SeasonalFrostMode = 'SUBLIMATION',
  outNormal?: { x: number; y: number; z: number }
): { elevation: number; gradient: number } {
  const step = 3.5;
  const hC = sampleTerrainGridElevation(x, z, biomeId, frostMode);
  const hL = sampleTerrainGridElevation(x - step, z, biomeId, frostMode);
  const hR = sampleTerrainGridElevation(x + step, z, biomeId, frostMode);
  const hD = sampleTerrainGridElevation(x, z - step, biomeId, frostMode);
  const hU = sampleTerrainGridElevation(x, z + step, biomeId, frostMode);

  const dhdx = (hR - hL) / (2 * step);
  const dhdz = (hU - hD) / (2 * step);
  const nx = -dhdx;
  const ny = 1.0;
  const nz = -dhdz;
  const invLen = 1 / Math.hypot(nx, ny, nz);

  if (outNormal) {
    outNormal.x = nx * invLen;
    outNormal.y = ny * invLen;
    outNormal.z = nz * invLen;
  }

  return {
    elevation: hC,
    gradient: Math.hypot(dhdx, dhdz),
  };
}

/**
 * Compute terrain slope (%) and dominant geology at any (x, z) coordinate for the active biome
 */
export function getTerrainMetricsAt(
  x: number,
  z: number,
  biomeId: MarsBiomeId = 'JEZERO_CRATER',
  frostMode: SeasonalFrostMode = 'SUBLIMATION',
  datumBaseMeters = -2552
): {
  elevationMeters: number;
  slopePercentage: number;
  slopeAngleDegrees: number;
  geology: TopographicTelemetry['dominantGeology'];
  trafficability: number;
  activeHotspot: RadiationHotspot | null;
} {
  const { elevation: h0, gradient } = sampleTerrainGridNormalAndSlope(x, z, biomeId, frostMode);

  const slopePercentage = Math.round(Math.min(45, gradient * 100) * 10) / 10;
  const slopeAngleDegrees = Math.round(Math.atan(gradient) * (180 / Math.PI) * 10) / 10;

  let geology: TopographicTelemetry['dominantGeology'] = 'BASALT_BEDROCK';
  if (biomeId === 'OLYMPUS_MONS' || biomeId === 'THARSIS_BULGE' || biomeId === 'SYRTIS_MAJOR') {
    geology = slopePercentage > 22 ? 'BLOCKY_TALUS' : 'BASALT_BEDROCK';
  } else if (biomeId === 'VALLES_MARINERIS') {
    geology = slopePercentage > 16 ? 'BLOCKY_TALUS' : 'LOOSE_REGOLITH';
  } else if (biomeId === 'HELLAS_PLANITIA' || biomeId === 'NORTHERN_LOWLANDS') {
    geology = slopePercentage > 12 ? 'BLOCKY_TALUS' : 'AEOLIAN_RIPPLES';
  } else if (biomeId === 'PLANUM_BOREUM' || biomeId === 'PLANUM_AUSTRALE') {
    geology = slopePercentage > 14 ? 'BLOCKY_TALUS' : 'AEOLIAN_RIPPLES';
  } else {
    if (slopePercentage > 19) geology = 'BLOCKY_TALUS';
    else if (slopePercentage > 12) geology = 'LOOSE_REGOLITH';
    else if (Math.sin(x * 0.015 + z * 0.015) > 0.2) geology = 'AEOLIAN_RIPPLES';
  }

  const trafficability = Math.max(0.22, Math.min(0.96, Math.round((0.95 - slopePercentage * 0.025) * 100) / 100));

  let activeHotspot: RadiationHotspot | null = null;
  if (biomeId === 'JEZERO_CRATER') {
    for (const hs of RADIATION_HOTSPOTS) {
      if (Math.hypot(x - hs.x, z - hs.z) <= hs.radius) {
        activeHotspot = hs;
        break;
      }
    }
  }

  return {
    elevationMeters: Math.round((datumBaseMeters + h0) * 10) / 10,
    slopePercentage,
    slopeAngleDegrees,
    geology,
    trafficability,
    activeHotspot,
  };
}


