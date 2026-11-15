/**
 * Olympus Mons climb / navigation telemetry measured from the red-marker baseline
 * (LF-OLYMPUS-MONS, at the foot of the north-west basal escarpment).
 */
import { marsBearingDeg, marsDistanceKm } from './marsCartography';
import { computeMarsPressurePa } from './marsClimateEngine';
import { sampleMolaMeters, isMarsDemReady } from './marsDem';
import {
  OLYMPUS_CALDERA_CRATERS,
  OLYMPUS_ESCARPMENT_INNER_KM,
  OLYMPUS_ESCARPMENT_OUTER_KM,
  OLYMPUS_MARKER,
  OLYMPUS_SUMMIT,
  OLYMPUS_SUMMIT_ELEVATION_M,
  olympusEscarpmentReliefAt,
} from './tharsisFeatures';
import type { SeasonalFrostMode } from '../types/telemetry';

export type OlympusZone =
  | 'BASAL_PLAINS'
  | 'ESCARPMENT'
  | 'LOWER_FLANK'
  | 'UPPER_FLANK'
  | 'SUMMIT_DOME'
  | 'CALDERA_COMPLEX';

export type AltitudeLevel = 'NORMAL' | 'HIGH' | 'VERY_HIGH' | 'EXTREME';
export type SlopeWarning = 'NONE' | 'CAUTION' | 'WARNING' | 'CRITICAL';

export interface OlympusClimbTelemetry {
  active: boolean;
  zone: OlympusZone;
  zoneLabel: string;
  elevationM: number;
  baselineElevationM: number;
  climbedM: number; // height gained above the red-marker baseline
  remainingToSummitM: number;
  distFromBaselineKm: number;
  distToSummitKm: number;
  bearingToSummitDeg: number;
  pressurePa: number;
  pressurePctOfDatum: number; // % of the 610 Pa Mars datum pressure
  atmosphereLabel: string;
  altitudeLevel: AltitudeLevel;
  slopePct: number;
  slopeWarning: SlopeWarning;
  escarpmentDistKm: number; // distance to the cliff ring (negative = inside the ring)
  escarpmentReliefM: number; // cliff height in this direction
  nearestCaldera: { name: string; distKm: number; depthM: number } | null;
  warnings: string[];
}

const BASELINE_FALLBACK_ELEVATION_M = -1_700;

let cachedBaseline: number | null = null;
function baselineElevation(): number {
  if (cachedBaseline !== null) return cachedBaseline;
  if (!isMarsDemReady()) return BASELINE_FALLBACK_ELEVATION_M;
  cachedBaseline = Math.round(sampleMolaMeters(OLYMPUS_MARKER.lat, OLYMPUS_MARKER.lng));
  return cachedBaseline;
}

/** True when the rover is close enough to Olympus Mons for the climb telemetry to apply. */
export function isNearOlympus(lat: number, lng: number): boolean {
  return marsDistanceKm({ lat, lng }, OLYMPUS_SUMMIT) <= 450;
}

export function computeOlympusClimbTelemetry(
  lat: number,
  lng: number,
  slopePct: number,
  frostMode: SeasonalFrostMode = 'SUBLIMATION'
): OlympusClimbTelemetry {
  const here = { lat, lng };
  const distToSummitKm = marsDistanceKm(here, OLYMPUS_SUMMIT);
  const distFromBaselineKm = marsDistanceKm(here, OLYMPUS_MARKER);
  const bearingToSummit = marsBearingDeg(here, OLYMPUS_SUMMIT);
  const baseline = baselineElevation();
  const elevationM = isMarsDemReady() ? Math.round(sampleMolaMeters(lat, lng)) : baseline;
  const climbedM = Math.max(0, elevationM - baseline);
  const remaining = Math.max(0, OLYMPUS_SUMMIT_ELEVATION_M - elevationM);

  const pressurePa = computeMarsPressurePa(elevationM, frostMode, 'OLYMPUS_MONS');
  const pressurePct = Math.round((pressurePa / 610) * 100);

  let zone: OlympusZone;
  let zoneLabel: string;
  if (distToSummitKm > OLYMPUS_ESCARPMENT_OUTER_KM) {
    zone = 'BASAL_PLAINS';
    zoneLabel = 'Basal plains (red-marker baseline)';
  } else if (distToSummitKm >= OLYMPUS_ESCARPMENT_INNER_KM) {
    zone = 'ESCARPMENT';
    zoneLabel = 'Basal escarpment: sheer cliff band';
  } else if (distToSummitKm <= 45 && elevationM > 19_000) {
    zone = 'CALDERA_COMPLEX';
    zoneLabel = 'Summit caldera complex';
  } else if (distToSummitKm <= 110) {
    zone = 'SUMMIT_DOME';
    zoneLabel = 'Summit dome';
  } else if (distToSummitKm <= 200) {
    zone = 'UPPER_FLANK';
    zoneLabel = 'Upper flank';
  } else {
    zone = 'LOWER_FLANK';
    zoneLabel = 'Lower flank';
  }

  let altitudeLevel: AltitudeLevel = 'NORMAL';
  if (elevationM > 18_000) altitudeLevel = 'EXTREME';
  else if (elevationM > 12_000) altitudeLevel = 'VERY_HIGH';
  else if (elevationM > 6_000) altitudeLevel = 'HIGH';

  const atmosphereLabel =
    pressurePa < 120
      ? 'Near-vacuum: ' + pressurePa + ' Pa (' + pressurePct + '% of Mars datum)'
      : pressurePa < 300
        ? 'Very thin: ' + pressurePa + ' Pa (' + pressurePct + '% of Mars datum)'
        : 'Thin: ' + pressurePa + ' Pa (' + pressurePct + '% of Mars datum)';

  let slopeWarning: SlopeWarning = 'NONE';
  if (slopePct >= 40) slopeWarning = 'CRITICAL';
  else if (slopePct >= 25) slopeWarning = 'WARNING';
  else if (slopePct >= 15) slopeWarning = 'CAUTION';

  const bearingFromSummit = marsBearingDeg(OLYMPUS_SUMMIT, here);
  const escarpmentDistKm = Math.round((distToSummitKm - 300) * 10) / 10;
  const escarpmentReliefM = olympusEscarpmentReliefAt(bearingFromSummit);

  let nearestCaldera: OlympusClimbTelemetry['nearestCaldera'] = null;
  if (distToSummitKm < 150) {
    for (const c of OLYMPUS_CALDERA_CRATERS) {
      const d = marsDistanceKm(here, c);
      if (!nearestCaldera || d < nearestCaldera.distKm) {
        nearestCaldera = { name: c.name, distKm: Math.round(d * 10) / 10, depthM: c.depthMeters };
      }
    }
  }

  const warnings: string[] = [];
  if (altitudeLevel === 'EXTREME') {
    warnings.push('EXTREME ALTITUDE: suit pressure and thermal load at maximum; limit time above 18 km.');
  } else if (altitudeLevel === 'VERY_HIGH') {
    warnings.push('Very high altitude: air density under 30% of datum, reduced convective cooling.');
  }
  if (zone === 'ESCARPMENT') {
    warnings.push(`CLIFF BAND: up to ${(escarpmentReliefM / 1000).toFixed(1)} km vertical relief on this side.`);
  } else if (zone === 'BASAL_PLAINS' && escarpmentDistKm < 25) {
    warnings.push(`Basal escarpment ${escarpmentDistKm.toFixed(0)} km ahead (${(escarpmentReliefM / 1000).toFixed(1)} km high).`);
  }
  if (slopeWarning === 'CRITICAL') warnings.push(`SLOPE ${slopePct.toFixed(0)}%: beyond rover limit, stop and reverse.`);
  else if (slopeWarning === 'WARNING') warnings.push(`Steep slope ${slopePct.toFixed(0)}%: reduce torque, traverse diagonally.`);
  else if (slopeWarning === 'CAUTION') warnings.push(`Slope ${slopePct.toFixed(0)}%: caution on loose lava-flow regolith.`);
  if (nearestCaldera && nearestCaldera.distKm < 6) {
    warnings.push(`Caldera rim: ${nearestCaldera.name}, ${nearestCaldera.distKm} km, ${(nearestCaldera.depthM / 1000).toFixed(1)} km drop.`);
  }

  return {
    active: isNearOlympus(lat, lng),
    zone,
    zoneLabel,
    elevationM,
    baselineElevationM: baseline,
    climbedM,
    remainingToSummitM: remaining,
    distFromBaselineKm: Math.round(distFromBaselineKm * 10) / 10,
    distToSummitKm: Math.round(distToSummitKm * 10) / 10,
    bearingToSummitDeg: Math.round(bearingToSummit),
    pressurePa,
    pressurePctOfDatum: pressurePct,
    atmosphereLabel,
    altitudeLevel,
    slopePct,
    slopeWarning,
    escarpmentDistKm,
    escarpmentReliefM,
    nearestCaldera,
    warnings,
  };
}
