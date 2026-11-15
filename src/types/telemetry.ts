/**
 * Telemetry and Mission types for Martian Excursion Navigation AI
 * Calibrated against NASA Perseverance (MEDA), MRO (HiRISE DTM), and MSL/M2020 (RAD) datasets.
 */

export interface LifeSupportTelemetry {
  oxygenPercentage: number; // e.g. 78.4 %
  oxygenFlowRateLpm: number; // e.g. 0.82 L/min
  oxygenReserveDurationHours: number; // e.g. 4.8 hrs remaining
  suitPressureKpa: number; // e.g. 29.6 kPa (~4.29 psi 100% O2)
  suitPressurePsi: number; // 4.29 psi
  batteryPercentage: number; // e.g. 81.6 %
  batteryPowerDrawWatts: number; // e.g. 142 W
  batteryReserveHours: number; // e.g. 5.2 hrs
  heartRateBpm: number; // e.g. 88 bpm
  coreTempCelsius: number; // e.g. 37.1 °C
  co2PartialPressureMmhg: number; // e.g. 3.2 mmHg (limit: 7.6 mmHg)
  suitThermalLoopStatus: 'NOMINAL' | 'ELEVATED' | 'CHILLED';
}

export interface EnvironmentalTelemetry {
  ambientTempCelsius: number; // e.g. -38.4 °C (MEDA Sol 244 14:22 UTC reading)
  surfaceTempCelsius: number; // e.g. -14.2 °C (MEDA thermal infrared sensor)
  atmosphericPressurePa: number; // e.g. 748 Pa (MEDA pressure sensor)
  atmosphericPressureMbar: number; // 7.48 mbar
  radiationDoseRateMicroSvHr: number; // e.g. 28.4 µSv/hr (RAD surface detector)
  cumulativeEvaDoseMilliSv: number; // e.g. 0.42 mSv
  solarParticleEventActive: boolean; // SPE status flag
  speIntensityLevel: 'NONE' | 'ELEVATED_FLUX' | 'HIGH_FLUX_WARNING' | 'EXTREME_CME_STORM';
  radiationGcrBaselineMicroGyDay: number; // e.g. 210 µGy/day galactic cosmic ray background
}

export interface AtmosphericDynamicsTelemetry {
  windSpeedMps: number; // e.g. 8.4 m/s (MEDA wind sensor)
  windGustMps: number; // e.g. 13.2 m/s (gust threshold 12.0 m/s)
  windDirectionDegrees: number; // e.g. 308° (NW)
  dustOpacityTau: number; // e.g. 0.68 (MEDA Optical Depth sensor, nominal < 0.40)
  thermalTrendCelsiusPerHour: number; // e.g. -4.8 °C/hr diurnal cooldown
  dustStormStatus: 'CLEAR' | 'ELEVATED_HAZE' | 'REGIONAL_DUST_DEVIL_FRONT' | 'GLOBAL_DUST_STORM';
}

export interface TopographicTelemetry {
  slopePercentage: number; // e.g. 18.4 %
  slopeAngleDegrees: number; // ~10.4°
  terrainRoughnessRmsMeters: number; // e.g. 0.32 m (HiRISE DTM high-res surface roughness)
  dominantGeology: 'LOOSE_REGOLITH' | 'AEOLIAN_RIPPLES' | 'BASALT_BEDROCK' | 'BLOCKY_TALUS';
  regolithDepthCm: number; // e.g. 12 cm
  slipHazardRisk: 'LOW' | 'MODERATE' | 'SEVERE';
  surfaceTrafficabilityIndex: number; // 0.0 to 1.0 (e.g. 0.54)
}

export interface WaypointNavigation {
  targetWaypointId: string; // e.g. "WP-DELTA-04"
  targetName: string; // "Belva Outcrop / Delta Rim"
  distanceMeters: number; // e.g. 480 m
  bearingDegrees: number; // e.g. 314° (NW)
  relativeElevationDeltaMeters: number; // e.g. +34.2 m
  etaMinutes: number; // e.g. 14 min at 0.55 m/s march pace
  lineOfSightClear: boolean;
}

export interface HazardAlert {
  active: boolean;
  severity: 'NOMINAL' | 'CAUTION' | 'CRITICAL_HAZARD';
  title: string;
  code: string;
  message: string;
  trippedParameters: string[];
  recommendedImmediateAction: string;
  requiresAck?: boolean;
  exiting?: boolean;
}

export interface EvaCommandRecommendation {
  id: string;
  priority: 'CRITICAL' | 'HIGH' | 'ADVISORY';
  category: 'SAFETY' | 'NAVIGATION' | 'SCIENCE';
  title: string;
  command: string;
  justification: string;
  operationalConstraint: string;
  acknowledged: boolean;
  executed: boolean;
}

export interface NasaMissionContext {
  mission: string; // "NASA Mars 2020 / Perseverance Expedition"
  landingSite: string; // "Jezero Crater (-77.45°E, 18.44°N)"
  currentSol: number; // 244
  missionTimeUtc: string; // "14:22 UTC"
  localTrueSolarTime: string; // "13:48 LTST"
  evaDesignation: string; // "EVA-02 Delta Escarpment Recon"
  evaElapsedDuration: string; // "03:42:15"
}

export type HudDisplayMode = 'minimalist' | 'standard' | 'verbose';
export type LocomotionMode = 'rover' | 'eva_walk';
export type OxygenModulationMode = 'conserve' | 'nominal' | 'high_flow';

export interface EquipmentControlState {
  locomotionMode: LocomotionMode;
  speedTorqueSetting: number; // 0.5x to 2.5x multiplier
  oxygenFlowMode: OxygenModulationMode;
  headlightsEnabled: boolean;
  sensorArrayEnabled: boolean;
  solarPanelsDeployed: boolean;
  solarDustCoatingPercent: number; // 0 to 100% dust accumulation on panels
  autonomousAiPilot: boolean; // Autonomous AI fallback co-pilot
  enableAutopilotTravel: boolean; // Auto-engage AI pilot when selecting a landmark/beacon
  suitRoverIntegrityPercent: number; // 0 to 100% structural integrity
}

export interface CommLatencyState {
  earthMarsDelayMinutes: number; // 4 to 24 minutes realistic light-time delay
  commBlackoutActive: boolean;
  signalStrengthPercent: number;
}

export interface TrainingChallenge {
  id: string;
  title: string;
  objective: string;
  targetWaypointId: string;
  completed: boolean;
  timeLimitSeconds?: number;
  elapsedSeconds: number;
}

export interface RoverConsequenceTelemetry {
  solarOutputWatts: number;
  netPowerWatts: number; // solarOutputWatts - batteryPowerDrawWatts
  wheelSlipPercent: number; // 0 to 100%
  motorTempCelsius: number; // actuator / avionics deck temp (-40 to +95 °C)
  seuBitFlipsCount: number; // Single-Event Upsets from solar proton flux
  solarWingStressPercent: number; // 0 to 100% mechanical wind-shear load
  isSheltered: boolean; // True when inside HAB-01 or WP-CACHE-07 shelter radius
  damageRatePercentPerSec: number; // Current rover/suit integrity loss rate per second
  activeFailureModes: string[];
}

export interface SettingChangeNotice {
  id: number;
  title: string;
  detail: string;
  severity: 'info' | 'warn' | 'danger';
  timestamp: number;
  requiresAck?: boolean;
  autoDismissMs?: number;
  exiting?: boolean;
}

export type MarsBiomeId =
  | 'OLYMPUS_MONS'
  | 'THARSIS_BULGE'
  | 'VALLES_MARINERIS'
  | 'GALE_CRATER'
  | 'JEZERO_CRATER'
  | 'PLANUM_BOREUM'
  | 'PLANUM_AUSTRALE'
  | 'HELLAS_PLANITIA'
  | 'SOUTHERN_HIGHLANDS'
  | 'NORTHERN_LOWLANDS'
  | 'SYRTIS_MAJOR';

export type MarsTerrainProfileGroup =
  | 'VOLCANIC_HIGHLANDS'
  | 'TECTONIC_CHASM'
  | 'SEDIMENTARY_BASIN'
  | 'POLAR_ICE_CAP'
  | 'DEEP_IMPACT_BASIN'
  | 'SOUTHERN_HIGHLANDS'
  | 'NORTHERN_LOWLANDS';

export type SeasonalFrostMode = 'DEPOSITION' | 'SUBLIMATION';

export type WeatherParticleMode = 'dust' | 'ice_crystals' | 'fog_mist' | 'dust_devil';

export interface ActiveEnvironmentState {
  biomeId: MarsBiomeId;
  profileGroup: MarsTerrainProfileGroup;
  regionName: string;
  lat: number;
  lng: number;
  elevationMeters: number;
  surfaceType: string;
  atmosphericPressurePa: number;
  atmosphericPressureMbar: number;
  visibilityKm: number;
  visibilityLabel: string;
  activeWeather: string;
  weatherPhenomena: string[];
  skyColorHex: string;
  fogColorHex: string;
  fogDensity: number;
  particleMode: WeatherParticleMode;
  seasonalCo2FrostMode: SeasonalFrostMode;
  navigationBoundaryNote: string | null;
  routingAdvisory: string;
}

export interface ExcursionState {
  mission: NasaMissionContext;
  vitals: LifeSupportTelemetry;
  environmental: EnvironmentalTelemetry;
  atmospheric: AtmosphericDynamicsTelemetry;
  topography: TopographicTelemetry;
  navigation: WaypointNavigation;
  hazardAlert: HazardAlert;
  recommendations: EvaCommandRecommendation[];
  equipment: EquipmentControlState;
  comms: CommLatencyState;
  activeChallenge: TrainingChallenge | null;
  consequences: RoverConsequenceTelemetry;
  lastSettingChange: SettingChangeNotice | null;
  returnToBaseTimerSeconds: number | null;
  returnToBaseTotalSeconds: number | null;
  emergencyRtbActive: boolean;
  activeEnvironment: ActiveEnvironmentState;
}
