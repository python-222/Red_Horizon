/**
 * Ravine / trough / steep-wall hazard detection.
 *
 * Probes the live terrain height field ahead of the rover (centre ray plus +/-35 degree side
 * rays) and flags drops, steep walls and trough edges before the rover reaches them. Also reports
 * the nearest mapped ravine or trough from the regional feature layer for context.
 */
import { sampleTerrainGridElevation } from '../data/marsTerrain';
import { nearestRavineOrTrough, type RegionalFeatureKind } from '../data/tharsisFeatures';
import type { MarsBiomeId, SeasonalFrostMode } from '../types/telemetry';

export type TerrainHazardKind = 'NONE' | 'STEEP_SLOPE' | 'RAVINE_WALL' | 'TROUGH_EDGE';
export type TerrainHazardLevel = 'CLEAR' | 'CAUTION' | 'WARNING' | 'CRITICAL';

export interface TerrainHazard {
  level: TerrainHazardLevel;
  kind: TerrainHazardKind;
  headline: string;
  detail: string;
  distanceM: number;
  dropM: number; // positive = ground falls away
  riseM: number; // positive = ground rises (wall)
  slopePct: number;
  bearingOffsetDeg: number; // 0 = dead ahead, negative = left, positive = right
  mapped: { name: string; kind: RegionalFeatureKind; distanceKm: number } | null;
}

const PROBE_DISTANCES_M = [15, 30, 50, 80, 120, 170, 240];
const RAY_OFFSETS_DEG = [0, -35, 35];

const LEVEL_RANK: Record<TerrainHazardLevel, number> = { CLEAR: 0, CAUTION: 1, WARNING: 2, CRITICAL: 3 };

export const CLEAR_HAZARD: TerrainHazard = {
  level: 'CLEAR',
  kind: 'NONE',
  headline: 'Terrain ahead clear',
  detail: '',
  distanceM: 0,
  dropM: 0,
  riseM: 0,
  slopePct: 0,
  bearingOffsetDeg: 0,
  mapped: null,
};

function evaluateRay(
  x: number,
  y: number,
  headingDeg: number,
  offsetDeg: number,
  h0: number,
  biomeId: MarsBiomeId,
  frostMode: SeasonalFrostMode
): TerrainHazard {
  const rad = ((headingDeg + offsetDeg) * Math.PI) / 180;
  const sx = Math.sin(rad);
  const sz = Math.cos(rad);

  let prevH = h0;
  let prevD = 0;
  let maxSlope = 0;
  let maxSlopeDist = 0;
  let maxDrop = 0;
  let maxDropDist = 0;
  let maxRise = 0;
  let maxRiseDist = 0;
  let steepestDown = 0;
  let steepestDownDist = 0;

  for (const d of PROBE_DISTANCES_M) {
    const h = sampleTerrainGridElevation(x + sx * d, y + sz * d, biomeId, frostMode);
    const run = d - prevD;
    const rise = h - prevH;
    const slope = Math.abs(rise) / run;
    if (slope > maxSlope) {
      maxSlope = slope;
      maxSlopeDist = d;
    }
    if (-rise / run > steepestDown) {
      steepestDown = -rise / run;
      steepestDownDist = d;
    }
    const drop = h0 - h;
    if (drop > maxDrop) {
      maxDrop = drop;
      maxDropDist = d;
    }
    if (-drop > maxRise) {
      maxRise = -drop;
      maxRiseDist = d;
    }
    prevH = h;
    prevD = d;
  }

  const base = {
    dropM: Math.round(maxDrop),
    riseM: Math.round(maxRise),
    slopePct: Math.round(maxSlope * 100),
    bearingOffsetDeg: offsetDeg,
    mapped: null as TerrainHazard['mapped'],
  };

  // Trough / ravine edge: ground falls away steeply
  if ((steepestDown >= 0.35 && maxDrop >= 20) || (maxDrop >= 60 && steepestDown >= 0.2)) {
    const critical = maxDrop >= 120 && steepestDown >= 0.5;
    return {
      ...base,
      level: critical ? 'CRITICAL' : 'WARNING',
      kind: 'TROUGH_EDGE',
      headline: critical ? 'DEEP TROUGH EDGE' : 'TROUGH EDGE AHEAD',
      detail: `Drop of ${Math.round(maxDrop)} m starting ${Math.round(steepestDownDist)} m out`,
      distanceM: steepestDownDist || maxDropDist,
    };
  }
  // Steep ravine wall (ascending or descending face)
  if (maxSlope >= 0.5) {
    const critical = maxSlope >= 0.8;
    return {
      ...base,
      level: critical ? 'CRITICAL' : 'WARNING',
      kind: 'RAVINE_WALL',
      headline: critical ? 'SHEER RAVINE WALL' : 'STEEP RAVINE WALL',
      detail: `${Math.round(maxSlope * 100)}% face at ${Math.round(maxSlopeDist)} m, ${
        maxRise > maxDrop ? `${Math.round(maxRise)} m rise` : `${Math.round(maxDrop)} m drop`
      }`,
      distanceM: maxSlopeDist,
    };
  }
  if (maxSlope >= 0.25) {
    return {
      ...base,
      level: 'CAUTION',
      kind: 'STEEP_SLOPE',
      headline: 'STEEP SLOPE AHEAD',
      detail: `${Math.round(maxSlope * 100)}% grade at ${Math.round(maxSlopeDist)} m`,
      distanceM: maxSlopeDist || maxRiseDist,
    };
  }
  return { ...CLEAR_HAZARD, ...base, level: 'CLEAR' };
}

export function analyzeTerrainAhead(
  x: number,
  y: number,
  headingDeg: number,
  biomeId: MarsBiomeId,
  frostMode: SeasonalFrostMode,
  lat: number,
  lng: number
): TerrainHazard {
  const h0 = sampleTerrainGridElevation(x, y, biomeId, frostMode);
  let worst: TerrainHazard = CLEAR_HAZARD;
  for (const offset of RAY_OFFSETS_DEG) {
    const r = evaluateRay(x, y, headingDeg, offset, h0, biomeId, frostMode);
    if (LEVEL_RANK[r.level] > LEVEL_RANK[worst.level]) worst = r;
    // prefer the dead-ahead ray when severities tie
  }
  const near = nearestRavineOrTrough(lat, lng, 60);
  const mapped = near
    ? { name: near.feature.name, kind: near.feature.kind, distanceKm: Math.round(near.distanceKm * 10) / 10 }
    : null;
  return { ...worst, mapped };
}
