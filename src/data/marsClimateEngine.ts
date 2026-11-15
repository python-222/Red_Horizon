/**
 * Dynamic Martian Terrain & Climate Engine
 *
 * Resolves regional geophysical, atmospheric, weather, and 3D rendering profiles
 * across Mars from any areographic coordinate (lat, lng), grounded in NASA MOLA,
 * Mars Odyssey THEMIS, MRO HiRISE/MCS, and MSL/M2020 MEDA + RAD measurements.
 */

import {
  ActiveEnvironmentState,
  MarsBiomeId,
  MarsTerrainProfileGroup,
  SeasonalFrostMode,
  TopographicTelemetry,
  AtmosphericDynamicsTelemetry,
} from '../types/telemetry';
import {
  marsDistanceKm,
  normalizeSignedLng180,
  formatAreographicCoords,
  marsStepGreatCircle,
  marsBearingDeg,
} from './marsCartography';

export const OLYMPUS_CENTER = { lat: 18.65, lng: -133.8 };
export const OLYMPUS_BASAL_CLIFF_INNER_KM = 285;
export const OLYMPUS_BASAL_CLIFF_OUTER_KM = 315;

export interface RegionalClimateInputs {
  ambientTempCelsius: number;
  surfaceTempCelsius: number;
  windSpeedMps: number;
  windGustMps: number;
  windDirectionDegrees: number;
  dustOpacityTau: number;
  thermalTrendCelsiusPerHour: number;
  dustStormStatus: AtmosphericDynamicsTelemetry['dustStormStatus'];
  slopePercentage: number;
  slopeAngleDegrees: number;
  terrainRoughnessRmsMeters: number;
  dominantGeology: TopographicTelemetry['dominantGeology'];
  regolithDepthCm: number;
  surfaceTrafficabilityIndex: number;
  slipHazardRisk: TopographicTelemetry['slipHazardRisk'];
}

export interface RegionalEnvironmentBundle {
  environment: ActiveEnvironmentState;
  climate: RegionalClimateInputs;
}

/**
 * Computes barometric pressure in Pascals from Mars MOLA elevation (meters)
 * using the Mars atmospheric scale height H ≈ 11,100 m and P0 ≈ 610 Pa.
 */
export function computeMarsPressurePa(elevationMeters: number, seasonalFrostMode: SeasonalFrostMode, biomeId: MarsBiomeId): number {
  const scaleHeight = 11100;
  let basePa = 610 * Math.exp(-elevationMeters / scaleHeight);
  // Polar winter CO2 condensation lowers polar/global column pressure slightly (~12%)
  if (
    (biomeId === 'PLANUM_BOREUM' || biomeId === 'PLANUM_AUSTRALE') &&
    seasonalFrostMode === 'DEPOSITION'
  ) {
    basePa *= 0.88;
  }
  return Math.max(55, Math.min(1320, Math.round(basePa)));
}

/**
 * Classifies any global Martian coordinate (lat, lng) into one of the core planetary biomes.
 */
export function classifyMarsBiome(lat: number, lng: number): MarsBiomeId {
  const normLng = normalizeSignedLng180(lng);

  // 1. Polar Regions (Planum Boreum & Planum Australe + circumpolar ergs)
  const capWobble = Math.sin((normLng * Math.PI) / 45) * 2.0;
  if (lat >= 74 + capWobble) return 'PLANUM_BOREUM';
  if (lat <= -74 + capWobble) return 'PLANUM_AUSTRALE';

  // 2. Olympus Mons Shield & 8 km Basal Escarpment (~300 km radius around 18.65N, -133.8E)
  const distOlympusKm = marsDistanceKm({ lat, lng: normLng }, OLYMPUS_CENTER);
  if (distOlympusKm <= 420) return 'OLYMPUS_MONS';

  // 3. Tharsis Volcanic Bulge & Shield Volcanoes
  const distTharsisKm = marsDistanceKm({ lat, lng: normLng }, { lat: 1.5, lng: -112.0 });
  if (distTharsisKm <= 1650 || (lat >= -22 && lat <= 36 && normLng >= -145 && normLng <= -88)) {
    // Exclude Valles Marineris eastern rift mouth
    if (!(lat >= -17 && lat <= -4 && normLng >= -96)) {
      return 'THARSIS_BULGE';
    }
  }

  // 4. Valles Marineris Tectonic Rift Chasm
  if (lat >= -19 && lat <= -2 && normLng >= -98 && normLng <= -30) {
    return 'VALLES_MARINERIS';
  }

  // 5. Gale Crater & Mount Sharp
  if (marsDistanceKm({ lat, lng: normLng }, { lat: -5.4, lng: 137.8 }) <= 260) {
    return 'GALE_CRATER';
  }

  // 6. Jezero Crater Western Delta Sector
  if (marsDistanceKm({ lat, lng: normLng }, { lat: 18.44, lng: 77.45 }) <= 220) {
    return 'JEZERO_CRATER';
  }

  // 7. Hellas Planitia Deep Impact Basin
  if (marsDistanceKm({ lat, lng: normLng }, { lat: -42.4, lng: 70.5 }) <= 1250) {
    return 'HELLAS_PLANITIA';
  }

  // 8. Syrtis Major Dark Volcanic Shield
  if (lat >= -3 && lat <= 21 && normLng >= 58 && normLng <= 76) {
    return 'SYRTIS_MAJOR';
  }

  // 9. Hemispheric Dichotomy Boundary (approx -10° to +35° variation by longitude)
  const dichotomyLat =
    normLng >= -180 && normLng < -60
      ? 12 + Math.sin(((normLng + 120) * Math.PI) / 90) * 10
      : normLng >= -60 && normLng < 60
        ? 22 + Math.cos((normLng * Math.PI) / 70) * 8
        : 10 + Math.sin(((normLng - 90) * Math.PI) / 90) * 11;

  return lat >= dichotomyLat ? 'NORTHERN_LOWLANDS' : 'SOUTHERN_HIGHLANDS';
}

/**
 * Resolves exact regional terrain, atmosphere, sky, fog, and active weather state
 * for any Martian coordinate (lat, lng).
 */
export function resolveRegionalEnvironment(
  lat: number,
  lng: number,
  options?: {
    seasonalCo2FrostMode?: SeasonalFrostMode;
    localElevationOffsetMeters?: number;
    globalDustStormOverride?: boolean;
  }
): RegionalEnvironmentBundle {
  const normLng = normalizeSignedLng180(lng);
  const biomeId = classifyMarsBiome(lat, normLng);
  const frostMode: SeasonalFrostMode = options?.seasonalCo2FrostMode ?? 'SUBLIMATION';
  const isGlobalStorm = Boolean(options?.globalDustStormOverride);
  const coordStr = formatAreographicCoords(lat, normLng);

  // Subtle spatial variation deterministic hash
  const microWave = Math.sin(lat * 0.7 + normLng * 0.45);
  const microSlope = Math.abs(Math.cos(lat * 1.1 - normLng * 0.85));

  if (biomeId === 'OLYMPUS_MONS') {
    const distKm = marsDistanceKm({ lat, lng: normLng }, OLYMPUS_CENTER);
    // Caldera/summit up to ~21,229 m (26 km above surrounding Amazonis plains)
    const shieldFraction = Math.max(0, 1 - distKm / 305);
    const elevationMeters =
      distKm <= 315
        ? Math.round(5200 + Math.pow(shieldFraction, 0.72) * 16030 + (options?.localElevationOffsetMeters ?? 0))
        : Math.round(-2600 + microWave * 350);
    const pressurePa = computeMarsPressurePa(elevationMeters, frostMode, biomeId);
    const tau = isGlobalStorm ? 1.45 : 0.14;
    const visibilityKm = isGlobalStorm ? 1.8 : 88;
    const cliffStatus =
      distKm <= OLYMPUS_BASAL_CLIFF_INNER_KM
        ? 'Inside Olympus Mons 8 km Basal Scarp Perimeter — sheer cliff drop-off boundary enforced at rim.'
        : distKm <= OLYMPUS_BASAL_CLIFF_OUTER_KM
          ? 'At Olympus Mons 8 km Basal Cliff Wall — vertical basaltic escarpment blocks ground ascent.'
          : 'Approaching Olympus Mons Basal Aureole — 8 km sheer cliff perimeter ahead (~295 km radius).';

    return {
      environment: {
        biomeId,
        profileGroup: 'VOLCANIC_HIGHLANDS',
        regionName: 'Olympus Mons Shield',
        lat,
        lng: normLng,
        elevationMeters,
        surfaceType: 'Basaltic Shield Slopes, Cooled Lava Flows & Caldera Rims',
        atmosphericPressurePa: pressurePa,
        atmosphericPressureMbar: Math.round((pressurePa / 100) * 100) / 100,
        visibilityKm,
        visibilityLabel: isGlobalStorm ? '1.8 km (Global Storm)' : '88+ km (Ultra-Clear)',
        activeWeather: isGlobalStorm
          ? 'High-Altitude Suspended Dust Plume'
          : 'Clear Ultra-Thin High-Altitude Sky (Minimal Dust)',
        weatherPhenomena: isGlobalStorm
          ? ['Global Dust Plume', 'High-Altitude Winds']
          : ['Dark-Violet / Butterscotch Sky', 'Ultra-Thin Air', 'Freezing High-Altitude Cold'],
        skyColorHex: isGlobalStorm ? '#6e3d2e' : '#35243d',
        fogColorHex: isGlobalStorm ? '#7c4534' : '#4d3346',
        fogDensity: isGlobalStorm ? 0.0022 : 0.00024,
        particleMode: 'dust',
        seasonalCo2FrostMode: frostMode,
        navigationBoundaryNote: cliffStatus,
        routingAdvisory:
          '8 km sheer basal scarp acts as a hard navigation boundary around the ~295 km perimeter. Steep cooled lava levees require conservative torque.',
      },
      climate: {
        ambientTempCelsius: Math.round((-68.5 - shieldFraction * 16 + microWave * 2.5) * 10) / 10,
        surfaceTempCelsius: Math.round((-49.0 - shieldFraction * 14) * 10) / 10,
        windSpeedMps: isGlobalStorm ? 16.4 : 4.2,
        windGustMps: isGlobalStorm ? 23.5 : 6.8,
        windDirectionDegrees: 285,
        dustOpacityTau: tau,
        thermalTrendCelsiusPerHour: -5.4,
        dustStormStatus: isGlobalStorm ? 'GLOBAL_DUST_STORM' : 'CLEAR',
        slopePercentage: Math.round((8.5 + microSlope * 11.5) * 10) / 10,
        slopeAngleDegrees: Math.round((4.8 + microSlope * 6.4) * 10) / 10,
        terrainRoughnessRmsMeters: 0.44,
        dominantGeology: 'BASALT_BEDROCK',
        regolithDepthCm: 3,
        surfaceTrafficabilityIndex: 0.72,
        slipHazardRisk: microSlope > 0.72 ? 'MODERATE' : 'LOW',
      },
    };
  }

  if (biomeId === 'THARSIS_BULGE') {
    const distTharsis = marsDistanceKm({ lat, lng: normLng }, { lat: 1.5, lng: -112.0 });
    const domeFactor = Math.max(0.15, 1 - distTharsis / 1700);
    const elevationMeters = Math.round(4200 + domeFactor * 4800 + microWave * 420);
    const pressurePa = computeMarsPressurePa(elevationMeters, frostMode, biomeId);
    const tau = isGlobalStorm ? 1.55 : 0.21;
    const visibilityKm = isGlobalStorm ? 1.5 : 64;

    return {
      environment: {
        biomeId,
        profileGroup: 'VOLCANIC_HIGHLANDS',
        regionName: 'Tharsis Volcanic Highlands',
        lat,
        lng: normLng,
        elevationMeters,
        surfaceType: 'Basaltic Shield Plateaus & Cooled Pahoehoe/Aa Lava Flows',
        atmosphericPressurePa: pressurePa,
        atmosphericPressureMbar: Math.round((pressurePa / 100) * 100) / 100,
        visibilityKm,
        visibilityLabel: isGlobalStorm ? '1.5 km (Global Dust)' : '64 km (High-Altitude Clear)',
        activeWeather: isGlobalStorm
          ? 'Global Dust Storm Enveloping Plateau'
          : 'Crisp High-Altitude Butterscotch Sky & Freezing Breeze',
        weatherPhenomena: ['Ultra-Thin High-Altitude Air', 'Dark-Violet Zenith', 'Minimal Dust'],
        skyColorHex: isGlobalStorm ? '#7a442d' : '#4a2f3b',
        fogColorHex: isGlobalStorm ? '#854c33' : '#6b423b',
        fogDensity: isGlobalStorm ? 0.0024 : 0.00032,
        particleMode: 'dust',
        seasonalCo2FrostMode: frostMode,
        navigationBoundaryNote:
          'Olympus Mons 8 km sheer basal cliff boundary lies to the NW; Tharsis Montes shield slopes increase climb draw.',
        routingAdvisory:
          'High basaltic plateau with low air density (~310 Pa) reduces convective cooling; watch lava flow ridges and caldera rim slopes.',
      },
      climate: {
        ambientTempCelsius: Math.round((-58.2 - domeFactor * 9.5 + microWave * 2) * 10) / 10,
        surfaceTempCelsius: Math.round((-34.8 - domeFactor * 8) * 10) / 10,
        windSpeedMps: isGlobalStorm ? 15.2 : 5.4,
        windGustMps: isGlobalStorm ? 21.8 : 8.1,
        windDirectionDegrees: 292,
        dustOpacityTau: tau,
        thermalTrendCelsiusPerHour: -4.9,
        dustStormStatus: isGlobalStorm ? 'GLOBAL_DUST_STORM' : 'CLEAR',
        slopePercentage: Math.round((7.2 + microSlope * 8.4) * 10) / 10,
        slopeAngleDegrees: Math.round((4.1 + microSlope * 4.8) * 10) / 10,
        terrainRoughnessRmsMeters: 0.36,
        dominantGeology: 'BASALT_BEDROCK',
        regolithDepthCm: 5,
        surfaceTrafficabilityIndex: 0.78,
        slipHazardRisk: 'LOW',
      },
    };
  }

  if (biomeId === 'VALLES_MARINERIS') {
    const floorLatFactor = Math.max(0, 1 - Math.abs(lat + 11.5) / 6.5);
    const elevationMeters = Math.round(-6200 - floorLatFactor * 3400 + microWave * 350);
    const pressurePa = computeMarsPressurePa(elevationMeters, frostMode, biomeId);
    const tau = isGlobalStorm ? 1.85 : 0.74;
    const visibilityKm = isGlobalStorm ? 0.9 : 4.2;

    return {
      environment: {
        biomeId,
        profileGroup: 'TECTONIC_CHASM',
        regionName: 'Valles Marineris Rift Chasm',
        lat,
        lng: normLng,
        elevationMeters,
        surfaceType: 'Stratified Canyon Walls, Landslide Debris Aprons & Flat Rift Floor',
        atmosphericPressurePa: pressurePa,
        atmosphericPressureMbar: Math.round((pressurePa / 100) * 100) / 100,
        visibilityKm,
        visibilityLabel: `${visibilityKm.toFixed(1)} km (Canyon Fog & Trapped Haze)`,
        activeWeather: 'Morning Water-Ice Fog, Trapped Dust Haze & Funneling Canyon Winds',
        weatherPhenomena: [
          'Morning Water-Ice Canyon Fog',
          'Trapped Low-Lying Dust Haze',
          'Strong Funneling Chasm Winds',
        ],
        skyColorHex: '#7d6e68',
        fogColorHex: '#a39f9a',
        fogDensity: 0.00175,
        particleMode: 'fog_mist',
        seasonalCo2FrostMode: frostMode,
        navigationBoundaryNote:
          'Extreme 7 km stratified canyon walls flank the north/south chasm margins; restrict traverse to flat rift floor & talus aprons.',
        routingAdvisory:
          'Funneling chasm winds (12–18 m/s) & trapped low-lying water-ice mist degrade optical MastCam range; keep headlights ON.',
      },
      climate: {
        ambientTempCelsius: Math.round((-44.6 + floorLatFactor * 5.2 + microWave * 2.5) * 10) / 10,
        surfaceTempCelsius: Math.round((-26.4 + floorLatFactor * 4.1) * 10) / 10,
        windSpeedMps: Math.round((10.8 + microSlope * 3.8) * 10) / 10,
        windGustMps: Math.round((15.4 + microSlope * 4.5) * 10) / 10,
        windDirectionDegrees: 94, // Funneling W -> E along rift axis
        dustOpacityTau: tau,
        thermalTrendCelsiusPerHour: -2.6,
        dustStormStatus: isGlobalStorm ? 'GLOBAL_DUST_STORM' : 'ELEVATED_HAZE',
        slopePercentage: Math.round((11.5 + (1 - floorLatFactor) * 14.5) * 10) / 10,
        slopeAngleDegrees: Math.round((6.6 + (1 - floorLatFactor) * 8.1) * 10) / 10,
        terrainRoughnessRmsMeters: 0.56,
        dominantGeology: floorLatFactor > 0.55 ? 'LOOSE_REGOLITH' : 'BLOCKY_TALUS',
        regolithDepthCm: 14,
        surfaceTrafficabilityIndex: floorLatFactor > 0.55 ? 0.62 : 0.44,
        slipHazardRisk: floorLatFactor > 0.55 ? 'MODERATE' : 'SEVERE',
      },
    };
  }

  if (biomeId === 'GALE_CRATER') {
    const distMountSharp = marsDistanceKm({ lat, lng: normLng }, { lat: -5.08, lng: 137.85 });
    const moundLift = Math.max(0, 1 - distMountSharp / 45) * 4800;
    const elevationMeters = Math.round(-4520 + moundLift + microWave * 160);
    const pressurePa = computeMarsPressurePa(elevationMeters, frostMode, biomeId);
    const tau = isGlobalStorm ? 1.7 : 0.52;
    const visibilityKm = isGlobalStorm ? 1.2 : 11.5;

    return {
      environment: {
        biomeId,
        profileGroup: 'SEDIMENTARY_BASIN',
        regionName: 'Gale Crater & Mount Sharp',
        lat,
        lng: normLng,
        elevationMeters,
        surfaceType: 'Fractured Tan Sedimentary Bedrock, Layered Mound & Dark Basalt Sand',
        atmosphericPressurePa: pressurePa,
        atmosphericPressureMbar: Math.round((pressurePa / 100) * 100) / 100,
        visibilityKm,
        visibilityLabel: `${visibilityKm.toFixed(1)} km (Afternoon Convective Haze)`,
        activeWeather: 'Afternoon Convective Dust Devils & Mount Sharp Katabatic Winds',
        weatherPhenomena: [
          'Afternoon Convective Vortices (Dust Devils)',
          'Katabatic Downslope Winds',
          'Moderate Diurnal Temp Swings',
        ],
        skyColorHex: '#a16847',
        fogColorHex: '#b87b56',
        fogDensity: 0.00092,
        particleMode: 'dust_devil',
        seasonalCo2FrostMode: frostMode,
        navigationBoundaryNote: null,
        routingAdvisory:
          'Avoid loose Bagnold dark sand ripple traps along Mount Sharp foothills; prefer fractured tan mudstone slabs for wheel traction.',
      },
      climate: {
        ambientTempCelsius: Math.round((-32.4 + microWave * 4.5) * 10) / 10,
        surfaceTempCelsius: Math.round((-9.6 + microWave * 5.2) * 10) / 10,
        windSpeedMps: 7.8,
        windGustMps: 12.6,
        windDirectionDegrees: 196, // Katabatic flow down Mount Sharp
        dustOpacityTau: tau,
        thermalTrendCelsiusPerHour: -3.9,
        dustStormStatus: isGlobalStorm ? 'GLOBAL_DUST_STORM' : 'REGIONAL_DUST_DEVIL_FRONT',
        slopePercentage: Math.round((8.4 + microSlope * 10.2) * 10) / 10,
        slopeAngleDegrees: Math.round((4.8 + microSlope * 5.8) * 10) / 10,
        terrainRoughnessRmsMeters: 0.28,
        dominantGeology: microSlope > 0.55 ? 'AEOLIAN_RIPPLES' : 'BASALT_BEDROCK',
        regolithDepthCm: 8,
        surfaceTrafficabilityIndex: 0.71,
        slipHazardRisk: microSlope > 0.7 ? 'MODERATE' : 'LOW',
      },
    };
  }

  if (biomeId === 'JEZERO_CRATER') {
    const elevationMeters = Math.round(-2552 + (options?.localElevationOffsetMeters ?? 14));
    const pressurePa = computeMarsPressurePa(elevationMeters, frostMode, biomeId);
    const tau = isGlobalStorm ? 1.75 : 0.68;
    const visibilityKm = isGlobalStorm ? 1.1 : 8.4;

    return {
      environment: {
        biomeId,
        profileGroup: 'SEDIMENTARY_BASIN',
        regionName: 'Jezero Crater Western Delta',
        lat,
        lng: normLng,
        elevationMeters,
        surfaceType: 'Ancient Deltaic Deposits, Fractured Sedimentary Slabs & Dark Sand Ripples',
        atmosphericPressurePa: pressurePa,
        atmosphericPressureMbar: Math.round((pressurePa / 100) * 100) / 100,
        visibilityKm,
        visibilityLabel: `${visibilityKm.toFixed(1)} km (Delta Dust Front)`,
        activeWeather: 'Localized Convective Dust Devils & Katabatic Rim Winds',
        weatherPhenomena: [
          'Convective Dust Devil Front',
          'Moderate Diurnal Swing',
          'Katabatic Rim Breeze',
        ],
        skyColorHex: '#9a4930',
        fogColorHex: '#9a4930',
        fogDensity: 0.00085,
        particleMode: 'dust_devil',
        seasonalCo2FrostMode: frostMode,
        navigationBoundaryNote: null,
        routingAdvisory:
          'Belva & Western Delta escarpment exceeds 15% slope on loose regolith; follow exposed basalt floor corridors.',
      },
      climate: {
        ambientTempCelsius: -38.4,
        surfaceTempCelsius: -14.2,
        windSpeedMps: 8.4,
        windGustMps: 13.2,
        windDirectionDegrees: 308,
        dustOpacityTau: tau,
        thermalTrendCelsiusPerHour: -4.8,
        dustStormStatus: isGlobalStorm ? 'GLOBAL_DUST_STORM' : 'REGIONAL_DUST_DEVIL_FRONT',
        slopePercentage: 11.4,
        slopeAngleDegrees: 6.5,
        terrainRoughnessRmsMeters: 0.32,
        dominantGeology: 'LOOSE_REGOLITH',
        regolithDepthCm: 12,
        surfaceTrafficabilityIndex: 0.68,
        slipHazardRisk: 'MODERATE',
      },
    };
  }

  if (biomeId === 'PLANUM_BOREUM' || biomeId === 'PLANUM_AUSTRALE') {
    const isNorth = biomeId === 'PLANUM_BOREUM';
    const isDeposition = frostMode === 'DEPOSITION';
    const absLat = Math.abs(lat);
    const capCore = Math.max(0, (absLat - 74) / 16);
    const elevationMeters = isNorth
      ? Math.round(-4800 + capCore * 2900 + microWave * 180)
      : Math.round(1400 + capCore * 2100 + microWave * 220);
    const pressurePa = computeMarsPressurePa(elevationMeters, frostMode, biomeId);
    const tau = isGlobalStorm ? 1.2 : 0.24;
    const visibilityKm = isGlobalStorm ? 2.2 : isDeposition ? 14.0 : 32.0;

    return {
      environment: {
        biomeId,
        profileGroup: 'POLAR_ICE_CAP',
        regionName: isNorth
          ? 'Planum Boreum (North Polar Ice Cap)'
          : 'Planum Australe (South Polar Ice Cap)',
        lat,
        lng: normLng,
        elevationMeters,
        surfaceType: isDeposition
          ? 'Seasonal CO2 Dry-Ice Frost Over Water-Ice Dome, Spiral Troughs & Dark Ergs'
          : 'Exposed Water-Ice Dome, Reddish-Brown Spiral Troughs & Circumpolar Sand Ergs',
        atmosphericPressurePa: pressurePa,
        atmosphericPressureMbar: Math.round((pressurePa / 100) * 100) / 100,
        visibilityKm,
        visibilityLabel: `${visibilityKm.toFixed(1)} km (${isDeposition ? 'Ice-Crystal Haze' : 'Crisp Polar Sky'})`,
        activeWeather: isDeposition
          ? 'CO2 Dry-Ice Frost Deposition, Katabatic Polar Winds & Ice-Crystal Clouds'
          : 'Seasonal CO2 Sublimation Venting, Strong Katabatic Winds & Ice Clouds',
        weatherPhenomena: [
          isDeposition ? 'CO2 Dry-Ice Frost Deposition' : 'Seasonal CO2 Sublimation',
          'Strong Katabatic Polar Winds',
          'Localized Ice-Crystal Clouds',
        ],
        skyColorHex: isDeposition ? '#8ea8be' : '#96a9ba',
        fogColorHex: isDeposition ? '#b8cedf' : '#afc2d1',
        fogDensity: isDeposition ? 0.00125 : 0.00072,
        particleMode: 'ice_crystals',
        seasonalCo2FrostMode: frostMode,
        navigationBoundaryNote:
          'Extreme polar sub-zero thermal load increases suit battery heater draw (+24 W); avoid steep spiral trough walls.',
        routingAdvisory:
          'Polar ice-cap traction drops sharply across glazed CO2 frost & dark circumpolar sand ergs; toggle seasonal frost state to inspect albedo shifts.',
      },
      climate: {
        ambientTempCelsius: isDeposition ? -125.0 : -92.4,
        surfaceTempCelsius: isDeposition ? -128.5 : -96.0,
        windSpeedMps: isDeposition ? 14.2 : 11.4,
        windGustMps: isDeposition ? 19.6 : 15.8,
        windDirectionDegrees: isNorth ? 18 : 198,
        dustOpacityTau: tau,
        thermalTrendCelsiusPerHour: isDeposition ? -6.2 : +2.4,
        dustStormStatus: isGlobalStorm ? 'GLOBAL_DUST_STORM' : 'CLEAR',
        slopePercentage: Math.round((5.5 + microSlope * 9.8) * 10) / 10,
        slopeAngleDegrees: Math.round((3.1 + microSlope * 5.6) * 10) / 10,
        terrainRoughnessRmsMeters: isDeposition ? 0.14 : 0.24,
        dominantGeology: absLat < 78 ? 'AEOLIAN_RIPPLES' : 'BASALT_BEDROCK',
        regolithDepthCm: absLat < 78 ? 16 : 2,
        surfaceTrafficabilityIndex: isDeposition ? 0.56 : 0.66,
        slipHazardRisk: isDeposition ? 'MODERATE' : 'LOW',
      },
    };
  }

  if (biomeId === 'HELLAS_PLANITIA') {
    const distCenter = marsDistanceKm({ lat, lng: normLng }, { lat: -42.4, lng: 70.5 });
    const rimBlend = Math.max(0, (distCenter - 780) / 470);
    const elevationMeters = Math.round(-7152 + rimBlend * 4800 + microWave * 140);
    const pressurePa = computeMarsPressurePa(elevationMeters, frostMode, biomeId);
    const tau = isGlobalStorm ? 2.1 : 0.88;
    const visibilityKm = isGlobalStorm ? 0.6 : 2.8;

    return {
      environment: {
        biomeId,
        profileGroup: 'DEEP_IMPACT_BASIN',
        regionName: 'Hellas Planitia Deep Impact Basin',
        lat,
        lng: normLng,
        elevationMeters,
        surfaceType:
          rimBlend > 0.45
            ? 'Rugged Eroded Basin Rim Mountains & Impact Ejecta'
            : 'Vast Smooth Low-Elevation Basin Floor with Morning Frost',
        atmosphericPressurePa: pressurePa,
        atmosphericPressureMbar: Math.round((pressurePa / 100) * 100) / 100,
        visibilityKm,
        visibilityLabel: `${visibilityKm.toFixed(1)} km (Thick Basin Haze & Frost Clouds)`,
        activeWeather: 'Bright Morning Frost, Low-Lying Water-Ice Clouds & Thick Orbital Haze',
        weatherPhenomena: [
          'Highest Mars Surface Pressure (~1,155 Pa)',
          'Bright Morning Frost',
          'Low-Lying Water-Ice Clouds & Thick Haze',
        ],
        skyColorHex: '#b3957f',
        fogColorHex: '#cdb5a3',
        fogDensity: 0.0021,
        particleMode: 'fog_mist',
        seasonalCo2FrostMode: frostMode,
        navigationBoundaryNote: null,
        routingAdvisory:
          'Deepest Martian basin produces thick orbital-obscuring haze & frost mist; rely on radar beacons and keep headlights ON.',
      },
      climate: {
        ambientTempCelsius: Math.round((-54.2 + microWave * 3.8) * 10) / 10,
        surfaceTempCelsius: Math.round((-39.5 + microWave * 4.2) * 10) / 10,
        windSpeedMps: 6.2,
        windGustMps: 9.8,
        windDirectionDegrees: 225,
        dustOpacityTau: tau,
        thermalTrendCelsiusPerHour: -3.1,
        dustStormStatus: isGlobalStorm ? 'GLOBAL_DUST_STORM' : 'ELEVATED_HAZE',
        slopePercentage: Math.round((2.4 + rimBlend * 16.5) * 10) / 10,
        slopeAngleDegrees: Math.round((1.4 + rimBlend * 9.4) * 10) / 10,
        terrainRoughnessRmsMeters: rimBlend > 0.45 ? 0.48 : 0.12,
        dominantGeology: rimBlend > 0.45 ? 'BLOCKY_TALUS' : 'AEOLIAN_RIPPLES',
        regolithDepthCm: rimBlend > 0.45 ? 9 : 15,
        surfaceTrafficabilityIndex: rimBlend > 0.45 ? 0.54 : 0.88,
        slipHazardRisk: rimBlend > 0.45 ? 'MODERATE' : 'LOW',
      },
    };
  }

  if (biomeId === 'SYRTIS_MAJOR') {
    const elevationMeters = Math.round(-1450 + microWave * 340);
    const pressurePa = computeMarsPressurePa(elevationMeters, frostMode, biomeId);
    const tau = isGlobalStorm ? 1.65 : 0.34;
    const visibilityKm = isGlobalStorm ? 1.4 : 34.0;

    return {
      environment: {
        biomeId,
        profileGroup: 'NORTHERN_LOWLANDS',
        regionName: 'Syrtis Major Volcanic Plains',
        lat,
        lng: normLng,
        elevationMeters,
        surfaceType: 'Exposed Dark Low-Albedo Basaltic Bedrock & Wind-Swept Yardangs',
        atmosphericPressurePa: pressurePa,
        atmosphericPressureMbar: Math.round((pressurePa / 100) * 100) / 100,
        visibilityKm,
        visibilityLabel: `${visibilityKm.toFixed(1)} km (Clear Low-Dust Shield)`,
        activeWeather: 'Steady Trade Winds Across Dark Basalt & Eolian Sand Streaks',
        weatherPhenomena: ['High Thermal Inertia Basalt', 'Sweeping Eolian Yardangs', 'Clear Sky'],
        skyColorHex: '#7d4b3a',
        fogColorHex: '#8a5542',
        fogDensity: 0.00052,
        particleMode: 'dust',
        seasonalCo2FrostMode: frostMode,
        navigationBoundaryNote: null,
        routingAdvisory:
          'Exposed dark basaltic bedrock offers prime wheel traction (0.86+) and warm afternoon thermal inertia.',
      },
      climate: {
        ambientTempCelsius: Math.round((-26.8 + microWave * 3.2) * 10) / 10,
        surfaceTempCelsius: Math.round((-2.4 + microWave * 3.8) * 10) / 10,
        windSpeedMps: 7.4,
        windGustMps: 10.6,
        windDirectionDegrees: 262,
        dustOpacityTau: tau,
        thermalTrendCelsiusPerHour: -2.9,
        dustStormStatus: isGlobalStorm ? 'GLOBAL_DUST_STORM' : 'CLEAR',
        slopePercentage: Math.round((4.2 + microSlope * 5.2) * 10) / 10,
        slopeAngleDegrees: Math.round((2.4 + microSlope * 3.0) * 10) / 10,
        terrainRoughnessRmsMeters: 0.21,
        dominantGeology: 'BASALT_BEDROCK',
        regolithDepthCm: 2,
        surfaceTrafficabilityIndex: 0.89,
        slipHazardRisk: 'LOW',
      },
    };
  }

  if (biomeId === 'NORTHERN_LOWLANDS') {
    const elevationMeters = Math.round(-5400 + microWave * 620);
    const pressurePa = computeMarsPressurePa(elevationMeters, frostMode, biomeId);
    const tau = isGlobalStorm ? 1.7 : 0.39;
    const visibilityKm = isGlobalStorm ? 1.3 : 24.0;

    return {
      environment: {
        biomeId,
        profileGroup: 'NORTHERN_LOWLANDS',
        regionName: `Northern Lowlands (Vastitas Borealis · ${coordStr})`,
        lat,
        lng: normLng,
        elevationMeters,
        surfaceType: 'Smooth Flat Volcanic/Sedimentary Plains, Yardangs & Dune Fields',
        atmosphericPressurePa: pressurePa,
        atmosphericPressureMbar: Math.round((pressurePa / 100) * 100) / 100,
        visibilityKm,
        visibilityLabel: `${visibilityKm.toFixed(1)} km (Clear Northern Plains)`,
        activeWeather: 'Low-Relief Boundary Layer Breeze & Eolian Sand Transport',
        weatherPhenomena: ['Smooth Low-Elevation Plains', 'Yardangs & Dune Fields', 'Higher Surface Pressure'],
        skyColorHex: '#945841',
        fogColorHex: '#a3644b',
        fogDensity: 0.00064,
        particleMode: 'dust',
        seasonalCo2FrostMode: frostMode,
        navigationBoundaryNote: null,
        routingAdvisory:
          'Smooth northern basin floor enables high-speed rover cruising; watch for yardang ridges and barchan dune pockets.',
      },
      climate: {
        ambientTempCelsius: Math.round((-48.4 + microWave * 4.5) * 10) / 10,
        surfaceTempCelsius: Math.round((-29.2 + microWave * 4.0) * 10) / 10,
        windSpeedMps: 6.4,
        windGustMps: 9.6,
        windDirectionDegrees: 295,
        dustOpacityTau: tau,
        thermalTrendCelsiusPerHour: -3.5,
        dustStormStatus: isGlobalStorm ? 'GLOBAL_DUST_STORM' : 'CLEAR',
        slopePercentage: Math.round((2.6 + microSlope * 3.8) * 10) / 10,
        slopeAngleDegrees: Math.round((1.5 + microSlope * 2.2) * 10) / 10,
        terrainRoughnessRmsMeters: 0.16,
        dominantGeology: microSlope > 0.6 ? 'AEOLIAN_RIPPLES' : 'BASALT_BEDROCK',
        regolithDepthCm: 7,
        surfaceTrafficabilityIndex: 0.87,
        slipHazardRisk: 'LOW',
      },
    };
  }

  // Default: SOUTHERN_HIGHLANDS (Ancient cratered terrain, Reull Vallis outflow valleys, higher dust-lifting)
  const nearReull = marsDistanceKm({ lat, lng: normLng }, { lat: -42.1, lng: 104.5 }) <= 480;
  const elevationMeters = Math.round(1850 + microWave * 950);
  const pressurePa = computeMarsPressurePa(elevationMeters, frostMode, biomeId);
  const tau = isGlobalStorm ? 1.85 : 0.62;
  const visibilityKm = isGlobalStorm ? 1.0 : 9.2;

  return {
    environment: {
      biomeId: 'SOUTHERN_HIGHLANDS',
      profileGroup: 'SOUTHERN_HIGHLANDS',
      regionName: nearReull
        ? 'Southern Highlands · Reull Vallis'
        : `Southern Highlands (${coordStr})`,
      lat,
      lng: normLng,
      elevationMeters,
      surfaceType: nearReull
        ? 'Ancient Dried River Valley (Reull Vallis), Impact Craters & Rugged Escarpments'
        : 'High-Density Impact Craters, Rugged Escarpments & Ancient Fluvial Valleys',
      atmosphericPressurePa: pressurePa,
      atmosphericPressureMbar: Math.round((pressurePa / 100) * 100) / 100,
      visibilityKm,
      visibilityLabel: `${visibilityKm.toFixed(1)} km (High Dust-Lifting Potential)`,
      activeWeather: 'Elevated Dust-Lifting Winds & Highland Thermal Turbulence',
      weatherPhenomena: [
        'High Dust-Lifting Potential',
        'Crater-Rim Wind Shear',
        'Ancient Noachian Valley Escarpments',
      ],
      skyColorHex: '#a14d31',
      fogColorHex: '#ab593a',
      fogDensity: 0.00105,
      particleMode: 'dust',
      seasonalCo2FrostMode: frostMode,
      navigationBoundaryNote: null,
      routingAdvisory:
        'High crater density and rugged escarpments increase slope slip risk; route around crater rims and incised valley walls.',
    },
    climate: {
      ambientTempCelsius: Math.round((-41.5 + microWave * 5.2) * 10) / 10,
      surfaceTempCelsius: Math.round((-18.8 + microWave * 5.8) * 10) / 10,
      windSpeedMps: 9.2,
      windGustMps: 13.8,
      windDirectionDegrees: 274,
      dustOpacityTau: tau,
      thermalTrendCelsiusPerHour: -4.4,
      dustStormStatus: isGlobalStorm ? 'GLOBAL_DUST_STORM' : 'ELEVATED_HAZE',
      slopePercentage: Math.round((11.8 + microSlope * 11.4) * 10) / 10,
      slopeAngleDegrees: Math.round((6.7 + microSlope * 6.4) * 10) / 10,
      terrainRoughnessRmsMeters: 0.46,
      dominantGeology: microSlope > 0.62 ? 'BLOCKY_TALUS' : 'LOOSE_REGOLITH',
      regolithDepthCm: 13,
      surfaceTrafficabilityIndex: 0.54,
      slipHazardRisk: microSlope > 0.5 ? 'SEVERE' : 'MODERATE',
    },
  };
}

/**
 * Enforces the sheer 8 km high basal cliff drop-off around Olympus Mons (~295 km perimeter)
 * as a hard ground-navigation boundary.
 */
export function checkOlympusCliffBoundary(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): {
  allowed: boolean;
  clampedLatLng: { lat: number; lng: number };
  reason: string | null;
} {
  const fromDistKm = marsDistanceKm(from, OLYMPUS_CENTER);
  const toDistKm = marsDistanceKm(to, OLYMPUS_CENTER);

  const fromInside = fromDistKm < OLYMPUS_BASAL_CLIFF_INNER_KM;
  const fromOutside = fromDistKm > OLYMPUS_BASAL_CLIFF_OUTER_KM;
  const toInside = toDistKm < OLYMPUS_BASAL_CLIFF_INNER_KM;
  const toOutside = toDistKm > OLYMPUS_BASAL_CLIFF_OUTER_KM;
  const toInCliffBand = !toInside && !toOutside;

  // Attempting to cross or enter the sheer 8 km cliff scarp band from outside or inside
  if ((fromOutside && (toInCliffBand || toInside)) || (fromInside && (toInCliffBand || toOutside))) {
    const radialBearing = marsBearingDeg(OLYMPUS_CENTER, from);
    const safeRadiusMeters = fromInside
      ? (OLYMPUS_BASAL_CLIFF_INNER_KM - 1.5) * 1000
      : (OLYMPUS_BASAL_CLIFF_OUTER_KM + 1.5) * 1000;
    const clampedLatLng = marsStepGreatCircle(OLYMPUS_CENTER, radialBearing, safeRadiusMeters);

    return {
      allowed: false,
      clampedLatLng,
      reason: fromInside
        ? 'OLYMPUS MONS 8 KM CLIFF RIM BOUNDARY: Sheer basal drop-off blocks ground exit from shield.'
        : 'OLYMPUS MONS 8 KM BASAL CLIFF BOUNDARY: Vertical basaltic escarpment blocks ground ascent. Use Set Position or Atlas Deploy for orbital drop onto shield.',
    };
  }

  return {
    allowed: true,
    clampedLatLng: to,
    reason: null,
  };
}

export function formatActiveEnvironmentSummary(env: ActiveEnvironmentState): string {
  const elevStr = `${env.elevationMeters >= 0 ? '+' : ''}${env.elevationMeters.toLocaleString()} m`;
  return `Elev ${elevStr} · Surface: ${env.surfaceType} · Pressure: ${env.atmosphericPressurePa} Pa (Vis: ${env.visibilityLabel}) · Weather: ${env.activeWeather}`;
}
