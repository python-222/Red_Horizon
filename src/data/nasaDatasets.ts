import { ExcursionState } from '../types/telemetry';
import { resolveRegionalEnvironment } from './marsClimateEngine';

/**
 * Baseline Mission Telemetry for Jezero Crater outside Delta Front
 * Current Mission Time: Sol 244, 14:22 UTC.
 * 
 * NASA Datasets Integrated:
 * 1. MEDA (Mars Environmental Dynamics Analyzer) - Sol 244 records:
 *    - Ambient air temperature: -38.4 °C (diurnal swing from -21°C midday to -78°C nighttime)
 *    - Surface ground temperature: -14.2 °C (TIRS sensor)
 *    - Atmospheric pressure: 748 Pa (7.48 mbar)
 *    - Wind speeds: 8.4 m/s sustained, gusts to 13.2 m/s from NW (308°)
 *    - Dust opacity (tau): 0.68 (elevated due to regional perihelion dust front)
 * 2. HiRISE DTM (Digital Terrain Model PSP_001415_1985 & Western Delta Scarp):
 *    - Slope percentage: 18.4% (steep delta escarpment)
 *    - Terrain: Loose regolith scree (12cm depth) over fragmented basalt bedrock
 *    - Terrain roughness RMS: 0.32 m
 * 3. RAD (Radiation Assessment Detector - MSL & M2020 surface dosimetry):
 *    - Surface dose rate: 28.4 µSv/hr (elevated during solar proton flare / coronal enhancement)
 *    - Cumulative EVA dose: 0.42 mSv (against 1.0 mSv single-EVA flight rule limit)
 */
export const SOL_244_BASELINE_STATE: ExcursionState = {
  mission: {
    mission: "NASA Mars Expedition / Jezero Outpost",
    landingSite: "Jezero Crater Western Delta (-77.45°E, 18.44°N)",
    currentSol: 244,
    missionTimeUtc: "14:22 UTC",
    localTrueSolarTime: "13:48 LTST",
    evaDesignation: "EVA-02 Delta Escarpment Recon",
    evaElapsedDuration: "03:42:15",
  },
  vitals: {
    oxygenPercentage: 78.4,
    oxygenFlowRateLpm: 0.84,
    oxygenReserveDurationHours: 4.6,
    suitPressureKpa: 29.6,
    suitPressurePsi: 4.29,
    batteryPercentage: 81.6,
    batteryPowerDrawWatts: 146,
    batteryReserveHours: 5.1,
    heartRateBpm: 92,
    coreTempCelsius: 37.1,
    co2PartialPressureMmhg: 3.4,
    suitThermalLoopStatus: 'NOMINAL',
  },
  environmental: {
    ambientTempCelsius: -38.4,
    surfaceTempCelsius: -14.2,
    atmosphericPressurePa: 748,
    atmosphericPressureMbar: 7.48,
    radiationDoseRateMicroSvHr: 28.4,
    cumulativeEvaDoseMilliSv: 0.42,
    solarParticleEventActive: true,
    speIntensityLevel: 'ELEVATED_FLUX',
    radiationGcrBaselineMicroGyDay: 210,
  },
  atmospheric: {
    windSpeedMps: 8.4,
    windGustMps: 13.2,
    windDirectionDegrees: 308,
    dustOpacityTau: 0.68,
    thermalTrendCelsiusPerHour: -4.8,
    dustStormStatus: 'REGIONAL_DUST_DEVIL_FRONT',
  },
  topography: {
    slopePercentage: 18.4,
    slopeAngleDegrees: 10.4,
    terrainRoughnessRmsMeters: 0.32,
    dominantGeology: 'LOOSE_REGOLITH',
    regolithDepthCm: 12,
    slipHazardRisk: 'SEVERE',
    surfaceTrafficabilityIndex: 0.48,
  },
  navigation: {
    targetWaypointId: "WP-DELTA-04",
    targetName: "Belva Outcrop / Delta Rim",
    distanceMeters: 992,
    bearingDegrees: 318,
    relativeElevationDeltaMeters: 42.6,
    etaMinutes: 24.8,
    lineOfSightClear: false,
  },
  hazardAlert: {
    active: true,
    severity: 'CRITICAL_HAZARD',
    title: "COMPOUND EVA THRESHOLD EXCEEDED",
    code: "HZ-244-TAU-GUST-SLOPE",
    message: "High wind gusts (13.2 m/s > 12.0 m/s) coupled with steep regolith slip slope (18.4% > 15.0%) and elevated atmospheric dust opacity (tau 0.68 > 0.50).",
    trippedParameters: [
      "Wind Gusts: 13.2 m/s (Limit: 12.0 m/s)",
      "Delta Slope: 18.4% on Loose Regolith (Limit: 15.0%)",
      "Dust Opacity: 0.68 tau (Limit: 0.50 tau)",
      "Solar Proton Flux: 28.4 µSv/hr (Limit: 25.0 µSv/hr)"
    ],
    recommendedImmediateAction: "Halt ascent; anchor traversing tether into basalt bedrock outcrop at 10 o'clock.",
  },
  recommendations: [
    {
      id: "CMD-REC-01",
      priority: "CRITICAL",
      category: "SAFETY",
      title: "Abort Science Package Deployment",
      command: "Immediately abort secondary drill sampling & deploy mast anchor tether.",
      justification: "MEDA telemetry registers sustained wind gusts reaching 13.2 m/s with dust opacity (tau) spiking to 0.68. Fine regolith saltation threatens optical lens contamination and drill shaft jamming.",
      operationalConstraint: "Deploy ground anchoring stakes into exposed basalt bedrock before wind reaches 15.0 m/s threshold.",
      acknowledged: false,
      executed: false,
    },
    {
      id: "CMD-REC-02",
      priority: "HIGH",
      category: "NAVIGATION",
      title: "Reroute Excursion Path Around Delta Escarpment",
      command: "Divert trajectory 18° west toward Kodiak scree bench; avoid direct 18.4% loose regolith scarp.",
      justification: "HiRISE DTM shows 12cm unconsolidated aeolian regolith over steep 18.4% slope. Foot slip index exceeds safety margin (0.48 vs 0.70 required); traversing basalt bedrock reduces metabolic load by 34%.",
      operationalConstraint: "Increases distance to Waypoint Delta-4 by +110m, but guarantees continuous solid footing and reduces suit tear risk.",
      acknowledged: false,
      executed: false,
    },
    {
      id: "CMD-REC-03",
      priority: "HIGH",
      category: "SAFETY",
      title: "Commence 45-Minute Habitat Ingress Timeline",
      command: "Initiate egress checklist and vector toward Rover Pressurized Habitat.",
      justification: "RAD sensor registers instantaneous surface ionizing flux of 28.4 µSv/hr with active Solar Particle Event (SPE) alert. Cumulative EVA dose has reached 0.42 mSv, projected to cross the 0.60 mSv mission safety cap within 42 minutes.",
      operationalConstraint: "Maintain maximum sustained walking speed of 0.65 m/s while preserving O2 consumption below 1.1 L/min.",
      acknowledged: false,
      executed: false,
    },
  ],
  equipment: {
    locomotionMode: 'rover',
    speedTorqueSetting: 1.0,
    oxygenFlowMode: 'nominal',
    headlightsEnabled: false,
    sensorArrayEnabled: true,
    solarPanelsDeployed: false,
    solarDustCoatingPercent: 18,
    autonomousAiPilot: false,
    enableAutopilotTravel: false,
    suitRoverIntegrityPercent: 96,
  },
  comms: {
    earthMarsDelayMinutes: 14.2,
    commBlackoutActive: false,
    signalStrengthPercent: 88,
  },
  activeChallenge: null,
  consequences: {
    solarOutputWatts: 0,
    netPowerWatts: -146,
    wheelSlipPercent: 34,
    motorTempCelsius: 18.4,
    seuBitFlipsCount: 1,
    solarWingStressPercent: 0,
    isSheltered: false,
    damageRatePercentPerSec: 0,
    activeFailureModes: ['REGOLITH_WHEEL_SLIP', 'ELEVATED_SOLAR_PROTON_FLUX'],
  },
  lastSettingChange: null,
  returnToBaseTimerSeconds: 180,
  returnToBaseTotalSeconds: 180,
  emergencyRtbActive: false,
  activeEnvironment: resolveRegionalEnvironment(18.44, 77.45).environment,
};

/**
 * Pre-configured alternate scenarios for testing and simulation
 */
export const PRESET_SCENARIOS = {
  baseline: {
    id: "baseline",
    name: "Sol 244 14:22 UTC - Dust Front & Delta Escarpment (Current Event)",
    description: "Wind gusts 13.2 m/s, dust tau 0.68, 18.4% slope on loose regolith, active SPE alert.",
    state: SOL_244_BASELINE_STATE,
  },
  kodiakAscent: {
    id: "kodiakAscent",
    name: "Sol 244 11:00 UTC - Kodiak Butte Traverse",
    description: "Steep 24.2% blocky basalt talus slope, clear skies tau 0.36, light wind 4.8 m/s.",
    state: {
      ...SOL_244_BASELINE_STATE,
      mission: {
        ...SOL_244_BASELINE_STATE.mission,
        missionTimeUtc: "11:00 UTC",
        localTrueSolarTime: "10:32 LTST",
        evaElapsedDuration: "01:20:00",
      },
      atmospheric: {
        ...SOL_244_BASELINE_STATE.atmospheric,
        windSpeedMps: 4.8,
        windGustMps: 7.2,
        windDirectionDegrees: 240,
        dustOpacityTau: 0.36,
        thermalTrendCelsiusPerHour: +3.2,
        dustStormStatus: 'CLEAR' as const,
      },
      topography: {
        ...SOL_244_BASELINE_STATE.topography,
        slopePercentage: 24.2,
        slopeAngleDegrees: 13.6,
        terrainRoughnessRmsMeters: 0.58,
        dominantGeology: 'BLOCKY_TALUS' as const,
        slipHazardRisk: 'SEVERE' as const,
      },
      environmental: {
        ...SOL_244_BASELINE_STATE.environmental,
        solarParticleEventActive: false,
        speIntensityLevel: 'NONE' as const,
        radiationDoseRateMicroSvHr: 9.8,
        cumulativeEvaDoseMilliSv: 0.14,
      },
      hazardAlert: {
        active: true,
        severity: 'CAUTION' as const,
        title: "STEEP TALUS INCLINE CAUTION",
        code: "HZ-244-SLOPE-TALUS",
        message: "Slope exceeds 20% on fractured blocky basalt. Micro-fractures detected underfoot.",
        trippedParameters: ["Slope: 24.2% (Caution > 20%)"],
        recommendedImmediateAction: "Engage walking pole stabilizers and maintain 3-point contact.",
      },
      returnToBaseTimerSeconds: null,
      returnToBaseTotalSeconds: null,
    },
  },
  solarFlare: {
    id: "solarFlare",
    name: "Sol 244 16:45 UTC - X-Class Solar Particle Event (CME)",
    description: "Extreme solar proton storm strikes Mars (148.5 µSv/h); SEU avionics bit-flips, MastCam static & UHF fade.",
    state: {
      ...SOL_244_BASELINE_STATE,
      mission: {
        ...SOL_244_BASELINE_STATE.mission,
        missionTimeUtc: "16:45 UTC",
        localTrueSolarTime: "16:04 LTST",
        evaElapsedDuration: "05:05:00",
      },
      environmental: {
        ...SOL_244_BASELINE_STATE.environmental,
        radiationDoseRateMicroSvHr: 148.5,
        cumulativeEvaDoseMilliSv: 0.84,
        solarParticleEventActive: true,
        speIntensityLevel: 'EXTREME_CME_STORM' as const,
      },
      comms: {
        earthMarsDelayMinutes: 16.4,
        commBlackoutActive: false,
        signalStrengthPercent: 34,
      },
      consequences: {
        solarOutputWatts: 0,
        netPowerWatts: -162,
        wheelSlipPercent: 28,
        motorTempCelsius: 34.2,
        seuBitFlipsCount: 9,
        solarWingStressPercent: 0,
        isSheltered: false,
        damageRatePercentPerSec: 2.4,
        activeFailureModes: ['SPE_AVIONICS_SEU', 'UHF_IONOSPHERIC_FADE', 'RADIATION_OVEREXPOSURE'],
      },
      returnToBaseTimerSeconds: 120,
      returnToBaseTotalSeconds: 120,
      hazardAlert: {
        active: true,
        severity: 'CRITICAL_HAZARD' as const,
        title: "EXTREME CME: SOLAR PROTON STORM ON MARS SURFACE",
        code: "HZ-244-CME-148USV",
        message: "X-class Coronal Mass Ejection penetrating thin 7.5 mbar CO2 atmosphere at 148.5 µSv/h. Unshielded rover electronics experiencing SEU bit-flips and UHF ionospheric attenuation.",
        trippedParameters: [
          "Proton Flux: 148.5 µSv/h (Emergency limit: 40.0 µSv/h)",
          "Cumulative EVA Dose: 0.84 mSv (1.00 mSv Abort Cap)",
          "UHF Relay Link: 34% (Ionospheric Scintillation)",
          "Avionics RAM: Active Single-Event Upsets"
        ],
        recommendedImmediateAction: "Disable non-essential Science Sensors to prevent SEU lockup; sprint to HAB-01 shelter.",
      },
    },
  },
  nominalDelta: {
    id: "nominalDelta",
    name: "Sol 244 09:30 UTC - Nominal Crater Floor Survey",
    description: "Calm morning exploration on flat basalt pavement; all instruments nominal.",
    state: {
      ...SOL_244_BASELINE_STATE,
      mission: {
        ...SOL_244_BASELINE_STATE.mission,
        missionTimeUtc: "09:30 UTC",
        localTrueSolarTime: "08:58 LTST",
        evaElapsedDuration: "00:45:00",
      },
      atmospheric: {
        ...SOL_244_BASELINE_STATE.atmospheric,
        windSpeedMps: 3.2,
        windGustMps: 5.4,
        windDirectionDegrees: 120,
        dustOpacityTau: 0.32,
        thermalTrendCelsiusPerHour: +6.1,
        dustStormStatus: 'CLEAR' as const,
      },
      topography: {
        ...SOL_244_BASELINE_STATE.topography,
        slopePercentage: 3.4,
        slopeAngleDegrees: 1.9,
        terrainRoughnessRmsMeters: 0.08,
        dominantGeology: 'BASALT_BEDROCK' as const,
        slipHazardRisk: 'LOW' as const,
        surfaceTrafficabilityIndex: 0.92,
      },
      environmental: {
        ...SOL_244_BASELINE_STATE.environmental,
        solarParticleEventActive: false,
        speIntensityLevel: 'NONE' as const,
        radiationDoseRateMicroSvHr: 8.6,
        cumulativeEvaDoseMilliSv: 0.06,
      },
      consequences: {
        solarOutputWatts: 0,
        netPowerWatts: -134,
        wheelSlipPercent: 4,
        motorTempCelsius: 8.2,
        seuBitFlipsCount: 0,
        solarWingStressPercent: 0,
        isSheltered: false,
        damageRatePercentPerSec: 0,
        activeFailureModes: [],
      },
      returnToBaseTimerSeconds: null,
      returnToBaseTotalSeconds: null,
      hazardAlert: {
        active: false,
        severity: 'NOMINAL' as const,
        title: "SYSTEMS NOMINAL",
        code: "HZ-NOMINAL",
        message: "All life support, environmental, and terrain metrics within safe EVA parameters.",
        trippedParameters: [],
        recommendedImmediateAction: "Proceed along planned primary survey transect.",
      },
    },
  },
};

export const TRAINING_CHALLENGES = [
  {
    id: 'CH-01',
    title: 'O2 Depletion Return-to-Habitat',
    objective: 'Reach Jezero Pressurized Habitat (HAB-01) before Oxygen drops below 10%. Conserve O2 flow!',
    targetWaypointId: 'HAB-01',
    initialO2: 24.5,
    initialBattery: 62.0,
    startX: -540,
    startZ: 740,
    timeLimitSeconds: 180,
  },
  {
    id: 'CH-02',
    title: 'Dust Storm Traverse & Solar Protection',
    objective: 'Retract solar panels, engage headlights, and navigate to Emergency Depot (WP-CACHE-07) in Tau 1.15 storm.',
    targetWaypointId: 'WP-CACHE-07',
    initialO2: 68.0,
    initialBattery: 44.0,
    startX: -220,
    startZ: 280,
    timeLimitSeconds: 210,
  },
  {
    id: 'CH-03',
    title: 'Comm Blackout Autonomous AI Extraction',
    objective: 'Earth-Mars signal lost (22 min delay + blackout). Engage Autonomous AI Co-Pilot to reach Belva Rim safely.',
    targetWaypointId: 'WP-DELTA-04',
    initialO2: 74.0,
    initialBattery: 72.0,
    startX: 160,
    startZ: -140,
    timeLimitSeconds: 240,
  },
];

export function generateProceduralWorstCase(base: ExcursionState): ExcursionState {
  const templates = [
    {
      title: 'GLOBAL DUST STORM (TAU 2.25) + IONOSPHERIC COMM BLACKOUT',
      code: 'PROC-STORM-BLK',
      message: 'Planet-encircling dust front dropped solar irradiance by 91% (Tau 2.25, Gusts 29.4 m/s). Deployed solar wings risk immediate hinge shear!',
      windSpeed: 19.6,
      dustTau: 2.25,
      radRate: 38.4,
      commBlackout: true,
      delayMin: 22.4,
      integrityDrop: 22,
      rtbSeconds: 90,
      action: 'RETRACT solar panels immediately, switch ON headlights, and return to HAB-01 or any checkpoint.',
    },
    {
      title: 'X-CLASS CME SOLAR PROTON STORM (184 µSv/h) + O2 REGULATOR FAULT',
      code: 'PROC-CME-184',
      message: 'Coronal Mass Ejection struck Mars at 184.0 µSv/h causing RAM SEU bit-flips, MastCam proton snow, and UHF attenuation.',
      windSpeed: 11.8,
      dustTau: 0.58,
      radRate: 184.0,
      commBlackout: false,
      delayMin: 18.6,
      integrityDrop: 26,
      rtbSeconds: 90,
      action: 'Shut down Science Sensors to protect electronics, modulate O2 to Conserve, and shelter at HAB-01 or any checkpoint.',
    },
    {
      title: 'AEOLIAN SAND TRAP BOGGING + ELECTROSTATIC SOLAR DUST COATING',
      code: 'PROC-TRAP-PWR',
      message: 'Triboelectric dust coated solar arrays (78% occlusion) while high-torque wheels sank into loose regolith ripples.',
      windSpeed: 16.4,
      dustTau: 1.35,
      radRate: 46.2,
      commBlackout: false,
      delayMin: 16.0,
      integrityDrop: 18,
      rtbSeconds: 120,
      action: 'Reduce Speed/Torque to 0.75x to break wheel slip and return to base or nearest checkpoint.',
    },
  ];

  const pick = templates[Math.floor(Math.random() * templates.length)];
  const gust = Math.round(pick.windSpeed * 1.5 * 10) / 10;
  const speLevel =
    pick.radRate >= 100
      ? ('EXTREME_CME_STORM' as const)
      : pick.radRate > 40
        ? ('HIGH_FLUX_WARNING' as const)
        : ('ELEVATED_FLUX' as const);

  return {
    ...base,
    atmospheric: {
      ...base.atmospheric,
      windSpeedMps: pick.windSpeed,
      windGustMps: gust,
      dustOpacityTau: pick.dustTau,
      dustStormStatus: pick.dustTau >= 1.5 ? 'GLOBAL_DUST_STORM' : 'REGIONAL_DUST_DEVIL_FRONT',
    },
    environmental: {
      ...base.environmental,
      radiationDoseRateMicroSvHr: pick.radRate,
      solarParticleEventActive: pick.radRate > 22,
      speIntensityLevel: speLevel,
    },
    comms: {
      earthMarsDelayMinutes: pick.delayMin,
      commBlackoutActive: pick.commBlackout,
      signalStrengthPercent: pick.commBlackout ? 0 : pick.radRate >= 100 ? 32 : 52,
    },
    equipment: {
      ...base.equipment,
      solarDustCoatingPercent: Math.min(94, base.equipment.solarDustCoatingPercent + 48),
      suitRoverIntegrityPercent: Math.max(5, Math.round((base.equipment.suitRoverIntegrityPercent - pick.integrityDrop) * 10) / 10),
    },
    consequences: {
      ...base.consequences,
      seuBitFlipsCount: base.consequences.seuBitFlipsCount + (pick.radRate >= 100 ? 8 : 3),
    },
    returnToBaseTimerSeconds:
      base.returnToBaseTimerSeconds !== null
        ? Math.min(base.returnToBaseTimerSeconds, pick.rtbSeconds)
        : pick.rtbSeconds,
    returnToBaseTotalSeconds: pick.rtbSeconds,
    emergencyRtbActive: base.emergencyRtbActive,
    lastSettingChange: {
      id: Date.now(),
      title: pick.title,
      detail: pick.action,
      severity: 'danger',
      timestamp: Date.now(),
    },
    hazardAlert: {
      active: true,
      severity: 'CRITICAL_HAZARD',
      title: pick.title,
      code: pick.code,
      message: pick.message,
      trippedParameters: [
        `Wind Gust: ${gust} m/s`,
        `Dust Tau: ${pick.dustTau}`,
        `Radiation: ${pick.radRate} µSv/h`,
        pick.commBlackout ? 'Earth-Mars Relay: BLACKOUT' : `Latency: ${pick.delayMin} min`,
      ],
      recommendedImmediateAction: pick.action,
    },
  };
}


