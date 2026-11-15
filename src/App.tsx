/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef, useMemo, Suspense, lazy } from 'react';
import { TopNav } from './components/TopNav';
import {
  CustomWaypoint,
  jezeroMetersToLatLng,
  latLngToJezeroMeters,
  haversineKm,
} from './utils/marsCoords';

const MarsWalkHud = lazy(() =>
  import('./components/MarsWalkHud').then((m) => ({ default: m.MarsWalkHud }))
);
const VisorHUD = lazy(() =>
  import('./components/VisorHUD').then((m) => ({ default: m.VisorHUD }))
);
const TelemetryReport = lazy(() =>
  import('./components/TelemetryReport').then((m) => ({ default: m.TelemetryReport }))
);
const NasaDatasetMatrix = lazy(() =>
  import('./components/NasaDatasetMatrix').then((m) => ({ default: m.NasaDatasetMatrix }))
);
import {
  SOL_244_BASELINE_STATE,
  PRESET_SCENARIOS,
  TRAINING_CHALLENGES,
  generateProceduralWorstCase,
} from './data/nasaDatasets';
import {
  MARS_WAYPOINTS,
  MARS_LANDFORMS,
  LANDMARK_BY_ID,
  JEZERO_SCIENCE_FEATURES,
  ScienceFeature,
  PlanetaryRoutePlan,
  WORLD_HALF_EXTENT,
  getMarsElevation,
  getTerrainMetricsAt,
  jezeroLocalToLatLng,
  marsDistanceKm,
  marsBearingDeg,
  estimateMarsTravelEtaMinutes,
} from './data/marsTerrain';
import {
  ExcursionState,
  HudDisplayMode,
  EquipmentControlState,
  SeasonalFrostMode,
  MarsBiomeId,
} from './types/telemetry';
import {
  resolveRegionalEnvironment,
  classifyMarsBiome,
  formatActiveEnvironmentSummary,
} from './data/marsClimateEngine';
import {
  playChirpSound,
  playCautionTone,
  playHazardAlarm,
  playAckTone,
  setAudioMuted,
} from './utils/audioAlerts';
import {
  vehicleSim,
  DriveDirection,
  SimTenHzSnapshot,
} from './utils/vehicleController';
import { dualSense, type DualSenseAction } from './utils/dualsenseController';
import { VirtualControllerCursor } from './components/VirtualControllerCursor';
import {
  NOTIFICATION_AUTO_DISMISS_MS,
  TOAST_EXIT_TRANSITION_MS,
  getHazardAlertDismissMs,
  getSettingToastDismissMs,
} from './utils/notificationTimers';

export interface TargetLocationEntry {
  id: string;
  x: number;
  y: number;
  name: string;
  lat: number;
  lng: number;
  isLandform?: boolean;
  colorHex?: string;
  category?: string;
  elevationMeters?: number;
}

export const WAYPOINT_LOCATIONS: Record<string, TargetLocationEntry> = Object.fromEntries(
  MARS_WAYPOINTS.map((wp) => {
    const ll = jezeroLocalToLatLng(wp.x, wp.z);
    return [wp.id, { id: wp.id, x: wp.x, y: wp.z, name: wp.name, lat: ll.lat, lng: ll.lng }];
  })
);

export const LANDFORM_LOCATIONS: Record<string, TargetLocationEntry> = Object.fromEntries(
  MARS_LANDFORMS.map((lf) => {
    const m = latLngToJezeroMeters(lf.lat, lf.lng);
    return [
      lf.id,
      {
        id: lf.id,
        x: m.x,
        y: m.y,
        name: lf.name,
        lat: lf.lat,
        lng: lf.lng,
        isLandform: true,
        category: lf.category,
        elevationMeters: lf.elevationMeters,
      },
    ];
  })
);

export const SCIENCE_FEATURE_LOCATIONS: Record<string, TargetLocationEntry> = Object.fromEntries(
  JEZERO_SCIENCE_FEATURES.map((feat) => {
    const ll = jezeroLocalToLatLng(feat.x, feat.z);
    return [
      feat.id,
      {
        id: feat.id,
        x: feat.x,
        y: feat.z,
        name: feat.name,
        lat: ll.lat,
        lng: ll.lng,
        isLandform: false,
        colorHex: feat.colorHex,
        category: feat.categoryLabel,
      },
    ];
  })
);

export const ALL_LANDMARK_LOCATIONS: Record<string, TargetLocationEntry> = {
  ...WAYPOINT_LOCATIONS,
  ...LANDFORM_LOCATIONS,
  ...SCIENCE_FEATURE_LOCATIONS,
};

const INITIAL_POS = {
  x: 120,
  y: 160,
  heading: 318,
  path: [{ x: 120, y: 160 }],
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'hud' | 'visor' | 'console' | 'sensors'>('hud');
  const [hudMode, setHudMode] = useState<HudDisplayMode>('standard');
  const [state, setState] = useState<ExcursionState>(SOL_244_BASELINE_STATE);
  const [currentScenarioKey, setCurrentScenarioKey] = useState<string>('baseline');
  const [isMuted, setIsMutedState] = useState<boolean>(false);
  const [targetWp, setTargetWp] = useState<TargetLocationEntry>(WAYPOINT_LOCATIONS['WP-DELTA-04']);
  const [astronautPos, setAstronautPos] = useState(INITIAL_POS);
  const [lastMovedTimestamp, setLastMovedTimestamp] = useState<number>(0);
  const [destinationReached, setDestinationReached] = useState<{
    waypointId: string;
    waypointName: string;
    dismissed: boolean;
    exiting?: boolean;
  } | null>(null);
  const arrivedWaypointRef = useRef<string | null>(null);
  const [customWaypoints, setCustomWaypoints] = useState<CustomWaypoint[]>([]);
  const [continueToTargetAfterWaypoints, setContinueToTargetAfterWaypoints] = useState<boolean>(false);
  const continueToTargetRef = useRef<boolean>(false);
  continueToTargetRef.current = continueToTargetAfterWaypoints;
  const nextCustomWpIdRef = useRef<number>(1);
  const [globalOverrideLatLng, setGlobalOverrideLatLng] = useState<{ lat: number; lng: number } | null>(null);
  const [customArrival, setCustomArrival] = useState<{
    wpId: number;
    nextWpId: number | null;
    remainingCount: number;
    dismissed: boolean;
    exiting?: boolean;
  } | null>(null);
  const arrivedJezeroCheckpointRef = useRef<string | null>(null);
  const emergencyRtbActiveRef = useRef<boolean>(state.emergencyRtbActive);
  emergencyRtbActiveRef.current = state.emergencyRtbActive;
  const [hasExplicitDestination, setHasExplicitDestination] = useState<boolean>(false);
  const [discoveredFeatureIds, setDiscoveredFeatureIds] = useState<string[]>([]);
  const [recentDiscovery, setRecentDiscovery] = useState<{
    feature: ScienceFeature;
    dismissed: boolean;
    exiting?: boolean;
  } | null>(null);
  const discoveredFeatureIdsRef = useRef<string[]>([]);
  discoveredFeatureIdsRef.current = discoveredFeatureIds;
  const dismissedHazardSigRef = useRef<string | null>(null);
  const activeLandmarkCycleIdxRef = useRef<number>(-1);

  const activeProximityFeature = useMemo<ScienceFeature | null>(() => {
    if (globalOverrideLatLng) return null;
    let nearest: ScienceFeature | null = null;
    let bestDist = Infinity;
    for (const feat of JEZERO_SCIENCE_FEATURES) {
      const d = Math.hypot(feat.x - astronautPos.x, feat.z - astronautPos.y);
      if (d <= feat.discoveryRadiusMeters && d < bestDist) {
        bestDist = d;
        nearest = feat;
      }
    }
    return nearest;
  }, [astronautPos.x, astronautPos.y, globalOverrideLatLng]);

  useEffect(() => {
    if (globalOverrideLatLng) return;
    const newlyDiscovered = JEZERO_SCIENCE_FEATURES.filter(
      (feat) =>
        !discoveredFeatureIdsRef.current.includes(feat.id) &&
        Math.hypot(feat.x - astronautPos.x, feat.z - astronautPos.y) <= feat.discoveryRadiusMeters
    );
    if (newlyDiscovered.length > 0) {
      setDiscoveredFeatureIds((prev) =>
        Array.from(new Set([...prev, ...newlyDiscovered.map((f) => f.id)]))
      );
      setRecentDiscovery({ feature: newlyDiscovered[0], dismissed: false });
      playAckTone();
    }
  }, [astronautPos.x, astronautPos.y, globalOverrideLatLng]);

  const handleDismissRecentDiscovery = useCallback(() => {
    playChirpSound();
    setRecentDiscovery((prev) => (prev ? { ...prev, dismissed: true, exiting: false } : null));
  }, []);

  // Low severity / Info auto-dismissal for science discovery toast (3.5s)
  useEffect(() => {
    if (!recentDiscovery || recentDiscovery.dismissed) return;
    const featId = recentDiscovery.feature.id;
    const delayMs = NOTIFICATION_AUTO_DISMISS_MS.info;
    const fadeTimer = setTimeout(() => {
      setRecentDiscovery((prev) =>
        prev && !prev.dismissed && prev.feature.id === featId ? { ...prev, exiting: true } : prev
      );
    }, Math.max(0, delayMs - TOAST_EXIT_TRANSITION_MS));
    const clearTimer = setTimeout(() => {
      setRecentDiscovery((prev) =>
        prev && prev.feature.id === featId ? { ...prev, dismissed: true, exiting: false } : prev
      );
    }, delayMs);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(clearTimer);
    };
  }, [recentDiscovery?.feature.id, recentDiscovery?.dismissed]);

  const stateRef = useRef(state);
  stateRef.current = state;
  const targetWpRef = useRef(targetWp);
  targetWpRef.current = targetWp;
  const astronautPosRef = useRef(astronautPos);
  astronautPosRef.current = astronautPos;
  const customWaypointsRef = useRef(customWaypoints);
  customWaypointsRef.current = customWaypoints;
  const globalOverrideLatLngRef = useRef(globalOverrideLatLng);
  globalOverrideLatLngRef.current = globalOverrideLatLng;
  const lastMovedTimestampRef = useRef<number>(0);
  const liveVehiclePoseRef = vehicleSim.poseRef;

  const [cursorModeActive, setCursorModeActive] = useState<boolean>(false);
  const [visorMiniMapOpen, setVisorMiniMapOpen] = useState<boolean>(true);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const handleToggleMute = (muted: boolean) => {
    setIsMutedState(muted);
    setAudioMuted(muted);
    if (!muted) playChirpSound();
  };

  useEffect(() => {
    if (state.hazardAlert.active) {
      if (state.hazardAlert.severity === 'CRITICAL_HAZARD') {
        playHazardAlarm();
        dualSense.hapticHazard('critical');
      } else {
        playCautionTone();
        dualSense.hapticHazard('caution');
      }
    }
  }, [state.hazardAlert.active, state.hazardAlert.severity]);

  useEffect(() => {
    const dist = state.navigation.distanceMeters;
    const wpId = state.navigation.targetWaypointId;
    const wpName = state.navigation.targetName;

    if (dist <= 25) {
      if (arrivedWaypointRef.current !== wpId) {
        arrivedWaypointRef.current = wpId;
        playAckTone();
        setDestinationReached({
          waypointId: wpId,
          waypointName: wpName,
          dismissed: false,
        });
      }
    } else if (dist > 35 && arrivedWaypointRef.current === wpId) {
      arrivedWaypointRef.current = null;
      setDestinationReached(null);
    }
  }, [state.navigation.distanceMeters, state.navigation.targetWaypointId, state.navigation.targetName]);

  const handleDismissDestinationReached = useCallback(() => {
    playChirpSound();
    setDestinationReached((prev) => (prev ? { ...prev, dismissed: true, exiting: false } : null));
  }, []);

  // Low severity / Info auto-dismissal for destination arrival banner (3.5s)
  useEffect(() => {
    if (!destinationReached || destinationReached.dismissed) return;
    const wpId = destinationReached.waypointId;
    const delayMs = NOTIFICATION_AUTO_DISMISS_MS.info;
    const fadeTimer = setTimeout(() => {
      setDestinationReached((prev) =>
        prev && !prev.dismissed && prev.waypointId === wpId ? { ...prev, exiting: true } : prev
      );
    }, Math.max(0, delayMs - TOAST_EXIT_TRANSITION_MS));
    const clearTimer = setTimeout(() => {
      setDestinationReached((prev) =>
        prev && prev.waypointId === wpId ? { ...prev, dismissed: true, exiting: false } : prev
      );
    }, delayMs);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(clearTimer);
    };
  }, [destinationReached?.waypointId, destinationReached?.dismissed]);

  const handleAddCustomWaypoint = useCallback((lat: number, lng: number) => {
    if (emergencyRtbActiveRef.current) {
      playCautionTone();
      setState((prev) => ({
        ...prev,
        lastSettingChange: {
          id: Date.now(),
          title: 'WAYPOINT CREATION LOCKED (EMERGENCY RTB)',
          detail: 'Reach Habitat Base (HAB-01) to clear Emergency RTB before adding new waypoints.',
          severity: 'danger',
          timestamp: Date.now(),
        },
      }));
      return;
    }
    setCustomWaypoints((prev) => {
      const id = prev.length === 0 ? 1 : nextCustomWpIdRef.current;
      nextCustomWpIdRef.current = id + 1;
      return [...prev, { id, lat, lng }];
    });
  }, []);

  const handleRemoveCustomWaypoint = useCallback((index: number) => {
    setCustomWaypoints((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) nextCustomWpIdRef.current = 1;
      return next;
    });
  }, []);

  const handleClearCustomWaypoints = useCallback(() => {
    nextCustomWpIdRef.current = 1;
    setCustomWaypoints([]);
    setContinueToTargetAfterWaypoints(false);
    setCustomArrival(null);
    if (!emergencyRtbActiveRef.current) {
      setHasExplicitDestination(false);
    }
  }, []);

  const handleDismissCustomArrival = useCallback(() => {
    setCustomArrival((prev) => (prev ? { ...prev, dismissed: true, exiting: false } : null));
  }, []);

  // Low severity / Info auto-dismissal for custom waypoint arrival banner (3.5s)
  useEffect(() => {
    if (!customArrival || customArrival.dismissed) return;
    const wpId = customArrival.wpId;
    const delayMs = NOTIFICATION_AUTO_DISMISS_MS.info;
    const fadeTimer = setTimeout(() => {
      setCustomArrival((prev) =>
        prev && !prev.dismissed && prev.wpId === wpId ? { ...prev, exiting: true } : prev
      );
    }, Math.max(0, delayMs - TOAST_EXIT_TRANSITION_MS));
    const clearTimer = setTimeout(() => {
      setCustomArrival((prev) =>
        prev && prev.wpId === wpId ? { ...prev, dismissed: true, exiting: false } : prev
      );
    }, delayMs);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(clearTimer);
    };
  }, [customArrival?.wpId, customArrival?.dismissed]);

  const ambientSpeDoseRef = useRef<number>(SOL_244_BASELINE_STATE.environmental.radiationDoseRateMicroSvHr);

  const clearStormEffectsInState = useCallback(
    (
      prev: ExcursionState,
      locationLabel: string,
      forceToast = false,
      isBaseArrival = false
    ): ExcursionState => {
      ambientSpeDoseRef.current = 9.2;
      const stormFailureModes = new Set([
        'SOLAR_WING_WIND_SHEAR',
        'DUST_SOLAR_STARVATION',
        'SPE_AVIONICS_SEU',
        'RADIATION_OVEREXPOSURE',
        'UHF_IONOSPHERIC_FADE',
        'SEVERE_STORM_DAMAGE',
        'ELEVATED_SOLAR_PROTON_FLUX',
        'RTB_TIMEOUT_CRITICAL',
      ]);
      const hadStorm =
        prev.environmental.solarParticleEventActive ||
        prev.environmental.radiationDoseRateMicroSvHr > 20 ||
        prev.atmospheric.dustOpacityTau > 0.45 ||
        prev.atmospheric.windGustMps > 12 ||
        prev.atmospheric.dustStormStatus !== 'CLEAR' ||
        prev.comms.commBlackoutActive ||
        prev.hazardAlert.active ||
        prev.returnToBaseTimerSeconds !== null ||
        (isBaseArrival && prev.emergencyRtbActive);

      const clearingRtb = isBaseArrival && prev.emergencyRtbActive;

      return {
        ...prev,
        atmospheric: {
          ...prev.atmospheric,
          windSpeedMps: 4.2,
          windGustMps: 6.4,
          dustOpacityTau: 0.32,
          dustStormStatus: 'CLEAR',
        },
        environmental: {
          ...prev.environmental,
          radiationDoseRateMicroSvHr: 9.2,
          solarParticleEventActive: false,
          speIntensityLevel: 'NONE',
        },
        comms: {
          ...prev.comms,
          commBlackoutActive: false,
          signalStrengthPercent: 94,
        },
        equipment: {
          ...prev.equipment,
          solarDustCoatingPercent: 0,
          autonomousAiPilot: clearingRtb ? false : prev.equipment.autonomousAiPilot,
        },
        consequences: {
          ...prev.consequences,
          solarWingStressPercent: 0,
          damageRatePercentPerSec: 0,
          activeFailureModes: prev.consequences.activeFailureModes.filter(
            (fm) => !stormFailureModes.has(fm)
          ),
        },
        hazardAlert: {
          active: false,
          severity: 'NOMINAL',
          title: 'SYSTEMS NOMINAL',
          code: 'HZ-NOMINAL',
          message: `Storm effects cleared at ${locationLabel}.`,
          trippedParameters: [],
          recommendedImmediateAction: 'Resume planned survey transect.',
        },
        returnToBaseTimerSeconds: null,
        returnToBaseTotalSeconds: null,
        emergencyRtbActive: isBaseArrival ? false : prev.emergencyRtbActive,
        lastSettingChange:
          hadStorm || forceToast
            ? {
                id: Date.now(),
                title: clearingRtb
                  ? `BASE REACHED · EMERGENCY RTB CLEARED`
                  : `STORM CLEARED · ${locationLabel.toUpperCase()}`,
                detail: clearingRtb
                  ? 'HAB-01 reached: storm effects removed, emergency status cleared & waypoint creation unlocked.'
                  : 'All storm, radiation & comm blackout effects removed; RTB timer cleared.',
                severity: 'info',
                timestamp: Date.now(),
              }
            : prev.lastSettingChange,
      };
    },
    []
  );

  const handleDismissSettingChange = useCallback(() => {
    setState((prev) => ({ ...prev, lastSettingChange: null }));
  }, []);

  // Centralized severity-based auto-dismissal for HUD setting / event toasts:
  // Info: 3.5s | Warning: 5.5s | Critical/Danger: 7.5s (unless requiresAck is true)
  useEffect(() => {
    const notice = state.lastSettingChange;
    const delayMs = getSettingToastDismissMs(notice);
    if (!notice || delayMs === null) return;
    const noticeId = notice.id;

    const fadeTimer = setTimeout(() => {
      setState((prev) =>
        prev.lastSettingChange?.id === noticeId
          ? { ...prev, lastSettingChange: { ...prev.lastSettingChange, exiting: true } }
          : prev
      );
    }, Math.max(0, delayMs - TOAST_EXIT_TRANSITION_MS));

    const clearTimer = setTimeout(() => {
      setState((prev) =>
        prev.lastSettingChange?.id === noticeId
          ? { ...prev, lastSettingChange: null }
          : prev
      );
    }, delayMs);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(clearTimer);
    };
  }, [
    state.lastSettingChange?.id,
    state.lastSettingChange?.severity,
    state.lastSettingChange?.requiresAck,
    state.lastSettingChange?.autoDismissMs,
  ]);

  // Centralized severity-based auto-dismissal for HUD hazard alerts:
  // NOMINAL: 3.5s | CAUTION: 5.5s | CRITICAL_HAZARD: 7.5s (Emergency RTB override requires manual ACK)
  useEffect(() => {
    const alert = state.hazardAlert;
    const delayMs = getHazardAlertDismissMs(alert, state.emergencyRtbActive);
    if (!alert.active || delayMs === null) return;
    const sig = `${alert.severity}|${alert.title}`;

    const fadeTimer = setTimeout(() => {
      setState((prev) =>
        prev.hazardAlert.active &&
        `${prev.hazardAlert.severity}|${prev.hazardAlert.title}` === sig
          ? { ...prev, hazardAlert: { ...prev.hazardAlert, exiting: true } }
          : prev
      );
    }, Math.max(0, delayMs - TOAST_EXIT_TRANSITION_MS));

    const clearTimer = setTimeout(() => {
      dismissedHazardSigRef.current = sig;
      setState((prev) =>
        prev.hazardAlert.active &&
        `${prev.hazardAlert.severity}|${prev.hazardAlert.title}` === sig
          ? {
              ...prev,
              hazardAlert: { ...prev.hazardAlert, active: false, exiting: false },
            }
          : prev
      );
    }, delayMs);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(clearTimer);
    };
  }, [
    state.hazardAlert.active,
    state.hazardAlert.severity,
    state.hazardAlert.code,
    state.hazardAlert.title,
    state.hazardAlert.requiresAck,
    state.emergencyRtbActive,
  ]);

  const handleUpdateEquipment = useCallback((patch: Partial<EquipmentControlState>) => {
    setState((prev) => {
      const nextEq = { ...prev.equipment, ...patch };
      const windGust = prev.atmospheric.windGustMps;
      const tau = prev.atmospheric.dustOpacityTau;
      const slope = prev.topography.slopePercentage;
      const rad = prev.environmental.radiationDoseRateMicroSvHr;

      let title = 'EQUIPMENT SETTING UPDATED';
      let detail = 'Subsystem parameters reconfigured.';
      let severity: 'info' | 'warn' | 'danger' = 'info';

      if (patch.solarPanelsDeployed !== undefined) {
        if (patch.solarPanelsDeployed) {
          if (windGust > 13.5 || tau > 0.75) {
            title = 'SOLAR WINGS DEPLOYED IN SEVERE WEATHER';
            detail = `DANGER: ${windGust.toFixed(1)} m/s wind shear stressing hinges & Tau ${tau.toFixed(2)} dust coating arrays!`;
            severity = 'danger';
            playCautionTone();
          } else {
            title = 'SOLAR WINGS DEPLOYED';
            detail = `Harvesting Martian irradiance (~590 W/m² peak, attenuated by Tau ${tau.toFixed(2)}).`;
            severity = 'info';
          }
        } else {
          title = 'SOLAR WINGS STOWED';
          detail = 'Arrays locked against wind shear; running on Li-ion / RTG reserves.';
          severity = 'info';
        }
      } else if (patch.speedTorqueSetting !== undefined) {
        if (patch.speedTorqueSetting > 1.4 && slope > 14) {
          title = `HIGH TORQUE (${patch.speedTorqueSetting.toFixed(2)}x) ON ${slope}% SLOPE`;
          detail = 'Loose regolith wheel slip & actuator over-temp accelerating chassis wear!';
          severity = 'warn';
        } else {
          title = `DRIVE TORQUE SET TO ${patch.speedTorqueSetting.toFixed(2)}x`;
          detail = `Traction & power draw scaled for ${prev.topography.dominantGeology.replace('_', ' ')}.`;
          severity = 'info';
        }
      } else if (patch.locomotionMode !== undefined) {
        if (patch.locomotionMode === 'eva_walk') {
          title = 'EVA SUIT MODE (0.38g) ACTIVE';
          detail = rad > 40
            ? `CRITICAL: Astronaut unshielded in ${rad.toFixed(1)} µSv/h solar proton flux!`
            : `On-foot traverse; suit metabolic O2 draw scales with ${slope}% slope.`;
          severity = rad > 40 ? 'danger' : 'warn';
        } else {
          title = 'PRESSURIZED ROVER MODE ACTIVE';
          detail = '6-wheel rocker-bogie chassis engaged with partial aluminum radiation shielding.';
          severity = 'info';
        }
      } else if (patch.headlightsEnabled !== undefined) {
        title = patch.headlightsEnabled ? 'HIGH-INTENSITY LED HEADLIGHTS ON' : 'HEADLIGHTS OFF';
        detail = patch.headlightsEnabled
          ? '+28 W draw; piercing Martian dust haze ahead of MastCam.'
          : tau > 0.85
            ? 'WARNING: Zero forward illumination in heavy dust storm!'
            : '-28 W power saved.';
        severity = !patch.headlightsEnabled && tau > 0.85 ? 'warn' : 'info';
      } else if (patch.sensorArrayEnabled !== undefined) {
        title = patch.sensorArrayEnabled ? 'SCIENCE SENSOR ARRAY ONLINE' : 'SENSORS SAFED / POWERED DOWN';
        detail = !patch.sensorArrayEnabled && rad > 60
          ? 'Science bus isolated from CME proton single-event upsets (SEU protection).'
          : patch.sensorArrayEnabled
            ? 'MEDA / RAD / SuperCam active (+18 W).'
            : 'Reduced avionics draw (+4 W).';
        severity = 'info';
      } else if (patch.oxygenFlowMode !== undefined) {
        title = `O2 FLOW: ${patch.oxygenFlowMode.toUpperCase().replace('_', ' ')}`;
        detail = patch.oxygenFlowMode === 'conserve'
          ? '0.55 L/min conservative bleed; CO2 partial pressure will rise slowly.'
          : patch.oxygenFlowMode === 'high_flow'
            ? '1.25 L/min flush; rapid O2 depletion for high exertion.'
            : '0.84 L/min nominal life-support loop.';
        severity = patch.oxygenFlowMode === 'conserve' ? 'warn' : 'info';
      } else if (patch.autonomousAiPilot !== undefined) {
        dualSense.hapticAutopilot(patch.autonomousAiPilot);
        title = patch.autonomousAiPilot ? 'AUTONOMOUS AI CO-PILOT ENGAGED' : 'MANUAL HELM CONTROL';
        detail = patch.autonomousAiPilot
          ? 'Auto-navigating around radiation hotspots toward target waypoint.'
          : 'Direct astronaut / rover steering restored.';
        severity = 'info';
      } else if (patch.enableAutopilotTravel !== undefined) {
        title = patch.enableAutopilotTravel
          ? 'AUTOPILOT TO LOCATION: ENABLED'
          : 'AUTOPILOT TO LOCATION: STANDBY';
        detail = patch.enableAutopilotTravel
          ? 'Selecting any landform or 3D beacon immediately draws the #52e0ff trail and engages autonomous navigation.'
          : 'Selecting a landmark sets destination only; engage AI Co-Pilot manually to travel.';
        severity = 'info';
      }

      return {
        ...prev,
        equipment: nextEq,
        lastSettingChange: {
          id: Date.now(),
          title,
          detail,
          severity,
          timestamp: Date.now(),
        },
      };
    });
  }, []);

  const handleTriggerSolarEvent = useCallback(
    (level?: 'NONE' | 'ELEVATED_FLUX' | 'HIGH_FLUX_WARNING' | 'EXTREME_CME_STORM') => {
      dismissedHazardSigRef.current = null;
      setState((prev) => {
        const order: Array<'NONE' | 'ELEVATED_FLUX' | 'HIGH_FLUX_WARNING' | 'EXTREME_CME_STORM'> = [
          'NONE',
          'ELEVATED_FLUX',
          'HIGH_FLUX_WARNING',
          'EXTREME_CME_STORM',
        ];
        const nextLevel = level ?? order[(order.indexOf(prev.environmental.speIntensityLevel) + 1) % order.length];

        const radMap = {
          NONE: 9.2,
          ELEVATED_FLUX: 32.5,
          HIGH_FLUX_WARNING: 78.4,
          EXTREME_CME_STORM: 168.0,
        };
        const newRad = radMap[nextLevel];
        ambientSpeDoseRef.current = newRad;

        const speActive = nextLevel !== 'NONE';
        const isExtreme = nextLevel === 'EXTREME_CME_STORM';
        const isHigh = nextLevel === 'HIGH_FLUX_WARNING' || isExtreme;

        if (isExtreme) {
          playHazardAlarm();
        } else if (isHigh) {
          playCautionTone();
        } else {
          playAckTone();
        }

        const newSignal = isExtreme
          ? 28
          : nextLevel === 'HIGH_FLUX_WARNING'
            ? 56
            : nextLevel === 'ELEVATED_FLUX'
              ? 78
              : 92;

        const newTitle = isExtreme
          ? 'X-CLASS CME SOLAR PROTON STORM (168 µSv/h)'
          : nextLevel === 'HIGH_FLUX_WARNING'
            ? 'HIGH-FLUX SOLAR PARTICLE EVENT (78.4 µSv/h)'
            : nextLevel === 'ELEVATED_FLUX'
              ? 'SOLAR PROTON FLUX ELEVATED (32.5 µSv/h)'
              : 'SOLAR PARTICLE EVENT CLEARED';

        const newDetail = isExtreme
          ? 'Proton snow hitting MastCam, RAM SEU bit-flips rising, UHF link degraded to 28%. Shelter at HAB-01!'
          : nextLevel === 'HIGH_FLUX_WARNING'
            ? 'Ionizing flux exceeding 40 µSv/h flight cap. Avionics upsets & UHF fade active.'
            : nextLevel === 'ELEVATED_FLUX'
              ? 'Coronal proton stream arriving at Mars; cumulative EVA dose climbing.'
              : 'Surface radiation returning to Galactic Cosmic Ray baseline (~9.2 µSv/h).';

        const immediateDamage = isExtreme ? 12 : nextLevel === 'HIGH_FLUX_WARNING' ? 6 : 0;
        const rtbSeconds = isExtreme ? 120 : nextLevel === 'HIGH_FLUX_WARNING' ? 150 : null;

        return {
          ...prev,
          environmental: {
            ...prev.environmental,
            radiationDoseRateMicroSvHr: newRad,
            solarParticleEventActive: speActive,
            speIntensityLevel: nextLevel,
          },
          equipment: {
            ...prev.equipment,
            suitRoverIntegrityPercent: Math.max(
              0,
              Math.round((prev.equipment.suitRoverIntegrityPercent - immediateDamage) * 10) / 10
            ),
          },
          comms: {
            ...prev.comms,
            signalStrengthPercent: prev.comms.commBlackoutActive ? 0 : newSignal,
          },
          returnToBaseTimerSeconds:
            rtbSeconds !== null
              ? prev.returnToBaseTimerSeconds !== null
                ? Math.min(prev.returnToBaseTimerSeconds, rtbSeconds)
                : rtbSeconds
              : null,
          returnToBaseTotalSeconds: rtbSeconds ?? null,
          hazardAlert: speActive
            ? {
                active: true,
                severity: isHigh ? 'CRITICAL_HAZARD' : 'CAUTION',
                title: newTitle,
                code: isExtreme ? 'HZ-CME-XCLASS' : 'HZ-SPE-FLUX',
                message: newDetail,
                trippedParameters: [
                  `Surface Flux: ${newRad.toFixed(1)} µSv/h`,
                  `UHF Signal: ${prev.comms.commBlackoutActive ? 0 : newSignal}%`,
                  `EVA Cap: ${prev.environmental.cumulativeEvaDoseMilliSv.toFixed(2)} / 1.00 mSv`,
                ],
                recommendedImmediateAction: isExtreme
                  ? 'Power down Science Sensors & return to HAB-01 or nearest checkpoint!'
                  : 'Monitor cumulative dose and keep route close to shelter.',
              }
            : {
                ...prev.hazardAlert,
                active: prev.atmospheric.windGustMps > 12 || prev.atmospheric.dustOpacityTau > 0.5 || prev.topography.slopePercentage > 15,
              },
          lastSettingChange: {
            id: Date.now(),
            title: newTitle,
            detail: newDetail,
            severity: isExtreme ? 'danger' : isHigh ? 'warn' : 'info',
            timestamp: Date.now(),
          },
        };
      });
    },
    []
  );

  const lastBoundaryAlertAtRef = useRef<number>(0);

  const buildRegionalStatePatch = useCallback(
    (
      prev: ExcursionState,
      lat: number,
      lng: number,
      options?: {
        emitToast?: boolean;
        frostModeOverride?: SeasonalFrostMode;
        localElevationOffsetMeters?: number;
        updateTopographyFromClimate?: boolean;
      }
    ): Partial<ExcursionState> => {
      const frostMode = options?.frostModeOverride ?? prev.activeEnvironment.seasonalCo2FrostMode;
      const isGlobalStormActive = prev.atmospheric.dustStormStatus === 'GLOBAL_DUST_STORM';
      const { environment, climate } = resolveRegionalEnvironment(lat, lng, {
        seasonalCo2FrostMode: frostMode,
        localElevationOffsetMeters: options?.localElevationOffsetMeters,
        globalDustStormOverride: isGlobalStormActive,
      });

      const preserveUserSpe = prev.environmental.solarParticleEventActive;
      const preserveGlobalStorm = isGlobalStormActive;

      const nextAtmospheric = preserveGlobalStorm
        ? {
            ...prev.atmospheric,
            windDirectionDegrees: climate.windDirectionDegrees,
          }
        : {
            windSpeedMps: climate.windSpeedMps,
            windGustMps: climate.windGustMps,
            windDirectionDegrees: climate.windDirectionDegrees,
            dustOpacityTau: climate.dustOpacityTau,
            thermalTrendCelsiusPerHour: climate.thermalTrendCelsiusPerHour,
            dustStormStatus: climate.dustStormStatus,
          };

      const nextTopography =
        options?.updateTopographyFromClimate !== false
          ? {
              slopePercentage: climate.slopePercentage,
              slopeAngleDegrees: climate.slopeAngleDegrees,
              terrainRoughnessRmsMeters: climate.terrainRoughnessRmsMeters,
              dominantGeology: climate.dominantGeology,
              regolithDepthCm: climate.regolithDepthCm,
              slipHazardRisk: climate.slipHazardRisk,
              surfaceTrafficabilityIndex: climate.surfaceTrafficabilityIndex,
            }
          : prev.topography;

      const patch: Partial<ExcursionState> = {
        mission: {
          ...prev.mission,
          landingSite: `${environment.regionName} (${environment.lat.toFixed(2)}°N, ${environment.lng.toFixed(2)}°E)`,
        },
        environmental: {
          ...prev.environmental,
          ambientTempCelsius: climate.ambientTempCelsius,
          surfaceTempCelsius: climate.surfaceTempCelsius,
          atmosphericPressurePa: environment.atmosphericPressurePa,
          atmosphericPressureMbar: environment.atmosphericPressureMbar,
          radiationDoseRateMicroSvHr: preserveUserSpe
            ? prev.environmental.radiationDoseRateMicroSvHr
            : 9.2,
        },
        atmospheric: nextAtmospheric,
        topography: nextTopography,
        activeEnvironment: environment,
      };

      if (options?.emitToast) {
        patch.lastSettingChange = {
          id: Date.now(),
          title: `ACTIVE ENVIRONMENT · ${environment.regionName.toUpperCase()}`,
          detail: formatActiveEnvironmentSummary(environment),
          severity: environment.navigationBoundaryNote ? 'warn' : 'info',
          timestamp: Date.now(),
        };
      }

      return patch;
    },
    []
  );

  const handleTogglePolarFrostMode = useCallback(
    (explicitMode?: SeasonalFrostMode) => {
      playAckTone();
      setState((prev) => {
        const nextFrost: SeasonalFrostMode =
          explicitMode ??
          (prev.activeEnvironment.seasonalCo2FrostMode === 'DEPOSITION'
            ? 'SUBLIMATION'
            : 'DEPOSITION');
        const latLng = globalOverrideLatLngRef.current ?? jezeroLocalToLatLng(astronautPosRef.current.x, astronautPosRef.current.y);
        const patch = buildRegionalStatePatch(prev, latLng.lat, latLng.lng, {
          emitToast: false,
          frostModeOverride: nextFrost,
          updateTopographyFromClimate: Boolean(globalOverrideLatLngRef.current),
        });
        const env = patch.activeEnvironment ?? prev.activeEnvironment;
        return {
          ...prev,
          ...patch,
          lastSettingChange: {
            id: Date.now(),
            title: `SEASONAL CO₂ FROST: ${nextFrost === 'DEPOSITION' ? 'DRY-ICE DEPOSITION' : 'SUBLIMATION VENTING'}`,
            detail: formatActiveEnvironmentSummary(env),
            severity: nextFrost === 'DEPOSITION' ? 'warn' : 'info',
            timestamp: Date.now(),
          },
        };
      });
    },
    [buildRegionalStatePatch]
  );

  const computeAndApplySurfaceTelemetry = useCallback(
    (newX: number, newY: number, silent: boolean) => {
      const curState = stateRef.current;
      const curTarget = targetWpRef.current;
      const curOverride = globalOverrideLatLngRef.current;
      const torqueMult = curState.equipment.speedTorqueSetting;

      const activeBiome: MarsBiomeId = curOverride
        ? curState.activeEnvironment.biomeId
        : 'JEZERO_CRATER';
      const activeFrost = curState.activeEnvironment.seasonalCo2FrostMode;

      const currentLatLng = curOverride ?? jezeroLocalToLatLng(newX, newY);
      const newDistance = curOverride
        ? Math.round(marsDistanceKm(currentLatLng, { lat: curTarget.lat, lng: curTarget.lng }) * 1000)
        : Math.round(Math.hypot(curTarget.x - newX, curTarget.y - newY));
      const newBearing = curOverride
        ? Math.round(marsBearingDeg(currentLatLng, { lat: curTarget.lat, lng: curTarget.lng }))
        : (Math.round((Math.atan2(curTarget.x - newX, curTarget.y - newY) * 180) / Math.PI) + 360) % 360;

      const metrics = getTerrainMetricsAt(
        newX,
        newY,
        activeBiome,
        activeFrost,
        curOverride ? curState.activeEnvironment.elevationMeters - 16 : -2552
      );
      const targetElev =
        curTarget.elevationMeters !== undefined
          ? curTarget.elevationMeters
          : -2552 + getMarsElevation(curTarget.x, curTarget.y, 'JEZERO_CRATER', activeFrost);
      const elevDelta = Math.round((targetElev - metrics.elevationMeters) * 10) / 10;

      const nearHab = !curOverride && Math.hypot(newX, newY) <= 25;
      const nearCache = !curOverride && Math.hypot(newX - 340, newY - 420) <= 25;
      const isSheltered = nearHab || nearCache;
      const nearJezeroCheckpoint =
        !curOverride && MARS_WAYPOINTS.some((wp) => Math.hypot(newX - wp.x, newY - wp.z) <= 25);

      const baseAmbientRad = curState.environmental.solarParticleEventActive
        ? Math.max(ambientSpeDoseRef.current, 28.4)
        : 9.2;
      const rawLocalRadRate = metrics.activeHotspot
        ? Math.round((baseAmbientRad + metrics.activeHotspot.doseRateMicroSvHr) * 10) / 10
        : baseAmbientRad;
      const localRadRate = isSheltered ? Math.round(rawLocalRadRate * 0.18 * 10) / 10 : rawLocalRadRate;

      const isSlopeHazard = metrics.slopePercentage > 15.0;
      const isRadHazard = Boolean(metrics.activeHotspot) || localRadRate > 35;
      const isWindShearHazard =
        curState.equipment.solarPanelsDeployed &&
        (curState.atmospheric.windGustMps > 13.5 || curState.atmospheric.dustOpacityTau > 0.75);
      const compoundHazard =
        !nearJezeroCheckpoint &&
        (isSlopeHazard ||
          isRadHazard ||
          isWindShearHazard ||
          curState.atmospheric.windGustMps > 12.0 ||
          curState.atmospheric.dustOpacityTau > 0.5);

      const slipPct = Math.round(
        Math.min(
          92,
          Math.max(
            0,
            (metrics.slopePercentage - 6) *
              (metrics.geology === 'LOOSE_REGOLITH' || metrics.geology === 'AEOLIAN_RIPPLES' ? 2.6 : 1.1) *
              (0.65 + torqueMult * 0.35)
          )
        )
      );

      const unlitDustCollisionRisk =
        !curState.equipment.headlightsEnabled && curState.atmospheric.dustOpacityTau > 0.85 && !silent;

      setState((prevState) => {
        const activeChallengeCompleted =
          prevState.activeChallenge &&
          prevState.activeChallenge.targetWaypointId === curTarget.id &&
          newDistance <= 25;

        const effectiveCheckpointSafe = prevState.emergencyRtbActive ? nearHab : nearJezeroCheckpoint;
        const heavyStormMoveWear =
          !isSheltered &&
          !effectiveCheckpointSafe &&
          (prevState.atmospheric.dustOpacityTau >= 1.2 || prevState.atmospheric.windGustMps >= 18)
            ? 0.9
            : 0;
        const integrityLoss =
          (isSlopeHazard && torqueMult > 1.3 && !silent ? 1.15 * (torqueMult - 1.0) : 0) +
          (unlitDustCollisionRisk ? 0.65 : 0) +
          heavyStormMoveWear;

        return {
          ...prevState,
          vitals: {
            ...prevState.vitals,
            oxygenPercentage: isSheltered
              ? Math.min(100, prevState.vitals.oxygenPercentage + 2.5)
              : prevState.vitals.oxygenPercentage,
            batteryPercentage: isSheltered
              ? Math.min(100, prevState.vitals.batteryPercentage + 2.5)
              : prevState.vitals.batteryPercentage,
          },
          equipment: {
            ...prevState.equipment,
            solarDustCoatingPercent:
              isSheltered || effectiveCheckpointSafe ? 0 : prevState.equipment.solarDustCoatingPercent,
            suitRoverIntegrityPercent: isSheltered
              ? Math.min(100, prevState.equipment.suitRoverIntegrityPercent + 2.5)
              : Math.max(
                  0,
                  Math.round((prevState.equipment.suitRoverIntegrityPercent - integrityLoss) * 10) / 10
                ),
          },
          environmental: {
            ...prevState.environmental,
            radiationDoseRateMicroSvHr: localRadRate,
            speIntensityLevel:
              localRadRate >= 100
                ? 'EXTREME_CME_STORM'
                : localRadRate > 40
                  ? 'HIGH_FLUX_WARNING'
                  : localRadRate > 20
                    ? 'ELEVATED_FLUX'
                    : 'NONE',
          },
          topography: {
            ...prevState.topography,
            slopePercentage: metrics.slopePercentage,
            slopeAngleDegrees: metrics.slopeAngleDegrees,
            dominantGeology: metrics.geology,
            slipHazardRisk:
              metrics.slopePercentage > 15 ? 'SEVERE' : metrics.slopePercentage > 10 ? 'MODERATE' : 'LOW',
            surfaceTrafficabilityIndex: metrics.trafficability,
          },
          navigation: {
            ...prevState.navigation,
            distanceMeters: newDistance,
            bearingDegrees: newBearing,
            relativeElevationDeltaMeters: elevDelta,
            etaMinutes: estimateMarsTravelEtaMinutes(
              newDistance,
              curState.equipment.locomotionMode,
              torqueMult
            ),
          },
          consequences: {
            ...prevState.consequences,
            wheelSlipPercent: slipPct,
            isSheltered,
          },
          hazardAlert: (() => {
            if (!compoundHazard) {
              dismissedHazardSigRef.current = null;
              return {
                ...prevState.hazardAlert,
                active: false,
                exiting: false,
                severity: 'NOMINAL' as const,
              };
            }
            const nextSeverity: 'CRITICAL_HAZARD' | 'CAUTION' =
              localRadRate > 40 || isWindShearHazard || (isSlopeHazard && torqueMult > 1.5)
                ? 'CRITICAL_HAZARD'
                : 'CAUTION';
            const nextTitle = isWindShearHazard
              ? 'SOLAR WING WIND SHEAR DAMAGE'
              : metrics.activeHotspot
                ? `RADIATION HOTSPOT: ${metrics.activeHotspot.name.toUpperCase()}`
                : localRadRate >= 100
                  ? 'EXTREME CME: SOLAR PROTON STORM'
                  : prevState.hazardAlert.title;
            const sig = `${nextSeverity}|${nextTitle}`;
            const alreadyDismissed = dismissedHazardSigRef.current === sig;
            if (!alreadyDismissed) {
              dismissedHazardSigRef.current = null;
            }
            return {
              ...prevState.hazardAlert,
              active: !alreadyDismissed,
              exiting: alreadyDismissed ? false : prevState.hazardAlert.exiting,
              severity: nextSeverity,
              title: nextTitle,
            };
          })(),
          activeChallenge: prevState.activeChallenge
            ? {
                ...prevState.activeChallenge,
                completed: prevState.activeChallenge.completed || Boolean(activeChallengeCompleted),
              }
            : null,
        };
      });
    },
    []
  );

  // Continuous held-button drive input (tracks active holds in vehicleSim Set — ZERO React re-renders)
  const handleDriveInput = useCallback(
    (direction: DriveDirection, active: boolean, sourceId = 'ui') => {
      vehicleSim.setButtonHeld(`${sourceId}:${direction}`, direction, active);
    },
    []
  );

  // Single-impulse fallback (click triggers / accessibility) routed through vehicleSim without React re-renders
  const handleMoveAstronaut = useCallback((direction: DriveDirection, silent = false) => {
    if (!silent) playChirpSound();
    vehicleSim.triggerTapPulse(direction, 165);
  }, []);

  const lastRegionalCommitMsRef = useRef<number>(0);
  const lastMovedCommitMsRef = useRef<number>(0);

  const processCustomWaypointArrival = useCallback(
    (currentLatLng: { lat: number; lng: number }, arrivedIdHint: number | null) => {
      const curCustomWps = customWaypointsRef.current;
      if (curCustomWps.length === 0) return null;

      const reachedWps = curCustomWps.filter(
        (wp) => wp.id === arrivedIdHint || haversineKm(currentLatLng, wp) * 1000 <= 25
      );
      if (reachedWps.length === 0) return null;

      playAckTone();
      const reachedIds = new Set(reachedWps.map((w) => w.id));
      const remaining = curCustomWps.filter((w) => !reachedIds.has(w.id));

      let nextWp: CustomWaypoint | null = null;
      let minKm = Infinity;
      for (const w of remaining) {
        const d = haversineKm(currentLatLng, w);
        if (d < minKm) {
          minKm = d;
          nextWp = w;
        }
      }

      setCustomArrival({
        wpId: reachedWps[0].id,
        nextWpId: nextWp ? nextWp.id : null,
        remainingCount: remaining.length,
        dismissed: false,
      });
      setCustomWaypoints((prev) => {
        const next = prev.filter(
          (w) => !reachedIds.has(w.id) && haversineKm(currentLatLng, w) * 1000 > 25
        );
        if (next.length === 0) nextCustomWpIdRef.current = 1;
        return next;
      });
      return {
        reachedWpId: reachedWps[0].id,
        hasNextWp: nextWp !== null,
      };
    },
    []
  );

  // Sync runtime config into vehicleSim without triggering physics resets
  useEffect(() => {
    vehicleSim.syncConfig({
      physicsEnabled: activeTab === 'hud' || activeTab === 'visor',
      locomotionMode: state.equipment.locomotionMode,
      speedTorqueSetting: state.equipment.speedTorqueSetting,
      batteryPercentage: state.vitals.batteryPercentage,
      suitRoverIntegrityPercent: state.equipment.suitRoverIntegrityPercent,
      autonomousAiPilot: state.equipment.autonomousAiPilot,
      biomeId: state.activeEnvironment.biomeId,
      frostMode: state.activeEnvironment.seasonalCo2FrostMode,
      targetWp: {
        id: targetWp.id,
        x: targetWp.x,
        y: targetWp.y,
        lat: targetWp.lat,
        lng: targetWp.lng,
        isLandform: targetWp.isLandform,
      },
      customWaypoints,
      continueToTargetAfterWaypoints,
    });
  }, [
    activeTab,
    state.equipment.locomotionMode,
    state.equipment.speedTorqueSetting,
    state.vitals.batteryPercentage,
    state.equipment.suitRoverIntegrityPercent,
    state.equipment.autonomousAiPilot,
    state.activeEnvironment.biomeId,
    state.activeEnvironment.seasonalCo2FrostMode,
    targetWp,
    customWaypoints,
    continueToTargetAfterWaypoints,
  ]);

  // Unified Master Simulation Engine lifecycle + strictly 10 Hz throttled React telemetry commits
  useEffect(() => {
    vehicleSim.setFreshInputPressCallback(() => {
      playChirpSound();
    });

    vehicleSim.setTenHzCommitCallback((snapshot: SimTenHzSnapshot) => {
      const nowWall = Date.now();
      const currentLatLng = { lat: snapshot.lat, lng: snapshot.lng };

      setAstronautPos((prev) => {
        const nextPos = {
          x: snapshot.x,
          y: snapshot.y,
          heading: snapshot.heading,
          path: snapshot.path ?? prev.path,
        };
        astronautPosRef.current = nextPos;
        return nextPos;
      });

      if (snapshot.isGlobalOverride) {
        const nextOv = { lat: snapshot.lat, lng: snapshot.lng };
        globalOverrideLatLngRef.current = nextOv;
        setGlobalOverrideLatLng(nextOv);
      } else if (globalOverrideLatLngRef.current !== null) {
        globalOverrideLatLngRef.current = null;
        setGlobalOverrideLatLng(null);
      }

      lastMovedTimestampRef.current = snapshot.lastMovedTimestamp;
      if (
        snapshot.lastMovedTimestamp > 0 &&
        (snapshot.isRestingCommit || nowWall - lastMovedCommitMsRef.current >= 400)
      ) {
        lastMovedCommitMsRef.current = nowWall;
        setLastMovedTimestamp(snapshot.lastMovedTimestamp);
      }

      if (snapshot.cliffBlockedReason && nowWall - lastBoundaryAlertAtRef.current > 2600) {
        lastBoundaryAlertAtRef.current = nowWall;
        playCautionTone();
      }
      if (snapshot.watchdogRecoveryNotice) {
        playCautionTone();
      }
      if (snapshot.arrivedTarget) {
        playAckTone();
        dualSense.hapticAutopilot(false);
        setContinueToTargetAfterWaypoints(false);
      } else if (snapshot.aiPilotDisengaged) {
        dualSense.hapticAutopilot(false);
      }

      const customArr = processCustomWaypointArrival(currentLatLng, snapshot.arrivedCustomWpId);

      const curState = stateRef.current;
      const curTarget = targetWpRef.current;

      if (snapshot.isGlobalOverride) {
        const nextBiome = classifyMarsBiome(snapshot.lat, snapshot.lng);
        const biomeChanged = nextBiome !== curState.activeEnvironment.biomeId;
        const shouldUpdateRegion =
          biomeChanged ||
          snapshot.isRestingCommit ||
          snapshot.aiPilotDisengaged ||
          snapshot.cliffBlockedReason !== null ||
          snapshot.watchdogRecoveryNotice !== null ||
          nowWall - lastRegionalCommitMsRef.current >= 500;

        const remainingMeters = Math.round(
          marsDistanceKm(currentLatLng, { lat: curTarget.lat, lng: curTarget.lng }) * 1000
        );
        const remainingBearing = Math.round(
          marsBearingDeg(currentLatLng, { lat: curTarget.lat, lng: curTarget.lng })
        );

        setState((prev) => {
          let next = prev;
          if (customArr) {
            next = clearStormEffectsInState(next, `Checkpoint WP${customArr.reachedWpId}`);
          }
          if (shouldUpdateRegion) {
            lastRegionalCommitMsRef.current = nowWall;
            const regionalPatch = buildRegionalStatePatch(next, snapshot.lat, snapshot.lng, {
              emitToast:
                biomeChanged &&
                !snapshot.watchdogRecoveryNotice &&
                !snapshot.cliffBlockedReason &&
                !snapshot.arrivedTarget,
            });
            next = { ...next, ...regionalPatch };
          }

          const targetElev =
            curTarget.elevationMeters !== undefined
              ? curTarget.elevationMeters
              : -2552 + getMarsElevation(curTarget.x, curTarget.y);
          const curElev = next.activeEnvironment.elevationMeters;
          const shouldDisableAi =
            snapshot.aiPilotDisengaged ||
            (customArr !== null &&
              !customArr.hasNextWp &&
              !continueToTargetRef.current &&
              next.equipment.autonomousAiPilot);

          return {
            ...next,
            equipment: shouldDisableAi
              ? { ...next.equipment, autonomousAiPilot: false }
              : next.equipment,
            navigation: {
              ...next.navigation,
              distanceMeters: remainingMeters,
              bearingDegrees: remainingBearing,
              relativeElevationDeltaMeters: Math.round((targetElev - curElev) * 10) / 10,
              etaMinutes:
                remainingMeters <= 25
                  ? 0
                  : estimateMarsTravelEtaMinutes(
                      remainingMeters,
                      next.equipment.locomotionMode,
                      next.equipment.speedTorqueSetting
                    ),
            },
            lastSettingChange: snapshot.watchdogRecoveryNotice
              ? {
                  id: nowWall,
                  title: 'EXPEDITION WATCHDOG · LEG RECALCULATED',
                  detail: snapshot.watchdogRecoveryNotice,
                  severity: 'warn',
                  timestamp: nowWall,
                }
              : snapshot.cliffBlockedReason
                ? {
                    id: nowWall,
                    title: 'OLYMPUS MONS 8 KM ESCARPMENT BYPASS',
                    detail: snapshot.cliffBlockedReason,
                    severity: 'warn',
                    timestamp: nowWall,
                  }
                : snapshot.arrivedTarget
                  ? {
                      id: nowWall,
                      title: `DESTINATION REACHED: ${curTarget.id}`,
                      detail: `Arrived at ${curTarget.name}. AI Co-Pilot disengaged.`,
                      severity: 'info',
                      timestamp: nowWall,
                    }
                  : next.lastSettingChange,
          };
        });
      } else {
        if (snapshot.reenteredJezero && curState.activeEnvironment.biomeId !== 'JEZERO_CRATER') {
          setState((prevSt) => ({
            ...prevSt,
            ...buildRegionalStatePatch(prevSt, snapshot.lat, snapshot.lng, {
              emitToast: true,
              updateTopographyFromClimate: false,
            }),
          }));
        }
        if (customArr) {
          setState((prevSt) => ({
            ...clearStormEffectsInState(prevSt, `Checkpoint WP${customArr.reachedWpId}`),
            equipment:
              !customArr.hasNextWp &&
              !continueToTargetRef.current &&
              prevSt.equipment.autonomousAiPilot
                ? { ...prevSt.equipment, autonomousAiPilot: false }
                : prevSt.equipment,
          }));
        } else if (snapshot.aiPilotDisengaged || snapshot.watchdogRecoveryNotice) {
          setState((prevSt) => ({
            ...prevSt,
            equipment: snapshot.aiPilotDisengaged
              ? { ...prevSt.equipment, autonomousAiPilot: false }
              : prevSt.equipment,
            lastSettingChange: snapshot.watchdogRecoveryNotice
              ? {
                  id: nowWall,
                  title: 'EXPEDITION WATCHDOG · LEG RECALCULATED',
                  detail: snapshot.watchdogRecoveryNotice,
                  severity: 'warn',
                  timestamp: nowWall,
                }
              : snapshot.arrivedTarget
                ? {
                    id: nowWall,
                    title: `DESTINATION REACHED: ${curTarget.id}`,
                    detail: `Arrived at ${curTarget.name}. AI Co-Pilot disengaged.`,
                    severity: 'info',
                    timestamp: nowWall,
                  }
                : prevSt.lastSettingChange,
          }));
        }
        computeAndApplySurfaceTelemetry(snapshot.x, snapshot.y, true);
      }
    });

    vehicleSim.start();

    return () => {
      vehicleSim.setTenHzCommitCallback(null);
      vehicleSim.setFreshInputPressCallback(null);
      vehicleSim.stop();
    };
  }, [
    buildRegionalStatePatch,
    clearStormEffectsInState,
    computeAndApplySurfaceTelemetry,
    processCustomWaypointArrival,
  ]);

  // Native PlayStation 5 DualSense Controller polling & debounced action bindings
  useEffect(() => {
    dualSense.setCallbacks({
      onConnectionChange: (connected, gamepadId) => {
        if (connected) {
          playAckTone();
        } else {
          playChirpSound();
        }
        setState((prev) => ({
          ...prev,
          lastSettingChange: {
            id: Date.now(),
            title: connected
              ? 'PS5 DUALSENSE CONTROLLER CONNECTED'
              : 'DUALSENSE CONTROLLER DISCONNECTED',
            detail: connected
              ? `${gamepadId || 'Wireless Controller'} · L-Stick Steer · L2/R2 Drive · R-Stick Camera · △ Pilot · □ Cursor · Touchpad Map · Options EVA`
              : 'Controller disconnected. Keyboard WASD / Arrow keys and pointer controls active.',
            severity: connected ? 'info' : 'warn',
            timestamp: Date.now(),
          },
        }));
      },
      onCursorModeChange: (active) => {
        setCursorModeActive(active);
        playChirpSound();
        setState((prev) => ({
          ...prev,
          lastSettingChange: {
            id: Date.now(),
            title: active
              ? 'DUALSENSE CURSOR MODE ACTIVE (□)'
              : 'DUALSENSE CAMERA LOOK RESTORED (□)',
            detail: active
              ? 'Right Stick moves virtual UI cursor · ✕ Clicks controls/dropdowns · L1 Precision · □ or ○ Exits.'
              : 'Right Stick returned to 3D viewport camera orbit & tilt.',
            severity: 'info',
            timestamp: Date.now(),
          },
        }));
      },
      onAction: (action: DualSenseAction) => {
        if (action === 'toggle_autopilot') {
          const nextAi = !stateRef.current.equipment.autonomousAiPilot;
          playAckTone();
          handleUpdateEquipment({ autonomousAiPilot: nextAi });
        } else if (action === 'toggle_minimap') {
          playChirpSound();
          if (activeTabRef.current !== 'visor') {
            setVisorMiniMapOpen(true);
            setActiveTab('visor');
          } else {
            setVisorMiniMapOpen((prev) => !prev);
          }
        } else if (action === 'toggle_eva_hud') {
          playChirpSound();
          setActiveTab((prev) => (prev === 'hud' ? 'visor' : 'hud'));
        } else if (action === 'recenter_camera') {
          playChirpSound();
        }
      },
    });

    dualSense.start();

    return () => {
      dualSense.stop();
      dualSense.setCallbacks({});
    };
  }, [handleUpdateEquipment]);

  // Continuous global keyboard drive listener (W/A/S/D + Arrow keys) tracked in synchronous Set with zero React re-renders
  useEffect(() => {
    if (activeTab !== 'hud' && activeTab !== 'visor') {
      vehicleSim.clearAllInputs();
      return;
    }

    const mapKeyToDirection = (e: KeyboardEvent): DriveDirection | null => {
      switch (e.code) {
        case 'ArrowUp':
        case 'KeyW':
          return 'forward';
        case 'ArrowDown':
        case 'KeyS':
          return 'backward';
        case 'ArrowLeft':
        case 'KeyA':
          return 'left';
        case 'ArrowRight':
        case 'KeyD':
          return 'right';
        default: {
          const k = e.key.toLowerCase();
          if (k === 'w' || e.key === 'ArrowUp') return 'forward';
          if (k === 's' || e.key === 'ArrowDown') return 'backward';
          if (k === 'a' || e.key === 'ArrowLeft') return 'left';
          if (k === 'd' || e.key === 'ArrowRight') return 'right';
          return null;
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
      const dir = mapKeyToDirection(e);
      if (!dir) return;
      e.preventDefault();
      if (!e.repeat) {
        vehicleSim.setKeyHeld(e.code || e.key.toLowerCase(), dir, true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const dir = mapKeyToDirection(e);
      if (!dir) return;
      vehicleSim.setKeyHeld(e.code || e.key.toLowerCase(), dir, false);
    };

    const clearAllKeys = () => {
      vehicleSim.clearAllInputs();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', clearAllKeys);
    document.addEventListener('visibilitychange', clearAllKeys);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', clearAllKeys);
      document.removeEventListener('visibilitychange', clearAllKeys);
      vehicleSim.clearAllInputs();
    };
  }, [activeTab]);

  // Clear all storm effects and RTB timer when reaching Base (HAB-01) or any Jezero checkpoint
  // (While Emergency RTB is active, only reaching Habitat Base HAB-01 clears emergency status & unlocks waypoints)
  useEffect(() => {
    const [jLat, jLng] = jezeroMetersToLatLng(astronautPos.x, astronautPos.y);
    const currentLatLng = globalOverrideLatLng ?? { lat: jLat, lng: jLng };
    const candidateWaypoints = state.emergencyRtbActive
      ? MARS_WAYPOINTS.filter((wp) => wp.type === 'habitat')
      : MARS_WAYPOINTS;

    let reachedJezeroWp: (typeof MARS_WAYPOINTS)[number] | null = null;
    for (const wp of candidateWaypoints) {
      const [wLat, wLng] = jezeroMetersToLatLng(wp.x, wp.z);
      if (haversineKm(currentLatLng, { lat: wLat, lng: wLng }) * 1000 <= 25) {
        reachedJezeroWp = wp;
        break;
      }
    }

    if (reachedJezeroWp) {
      if (arrivedJezeroCheckpointRef.current !== reachedJezeroWp.id) {
        arrivedJezeroCheckpointRef.current = reachedJezeroWp.id;
        playAckTone();
        const isHabitatBase = reachedJezeroWp.type === 'habitat';
        if (isHabitatBase && state.emergencyRtbActive) {
          setHasExplicitDestination(false);
        }
        setState((prev) =>
          clearStormEffectsInState(
            prev,
            isHabitatBase
              ? `${reachedJezeroWp!.id} Base`
              : `${reachedJezeroWp!.id}: ${reachedJezeroWp!.name}`,
            isHabitatBase && prev.emergencyRtbActive,
            isHabitatBase
          )
        );
      }
    } else if (arrivedJezeroCheckpointRef.current !== null) {
      const stillNearAny = candidateWaypoints.some((wp) => {
        const [wLat, wLng] = jezeroMetersToLatLng(wp.x, wp.z);
        return haversineKm(currentLatLng, { lat: wLat, lng: wLng }) * 1000 <= 35;
      });
      if (!stillNearAny) {
        arrivedJezeroCheckpointRef.current = null;
      }
    }
  }, [astronautPos.x, astronautPos.y, globalOverrideLatLng, state.emergencyRtbActive, clearStormEffectsInState]);

  // Dynamic physiological + equipment resource loop (O2, Battery, Solar Charging, Challenge timer)
  useEffect(() => {
    let tickCount = 0;
    const interval = setInterval(() => {
      tickCount += 1;
      const isRecentlyMoving = Date.now() - lastMovedTimestampRef.current < 3200;

      setState((prev) => {
        const slope = prev.topography.slopePercentage;
        const eq = prev.equipment;
        const tau = prev.atmospheric.dustOpacityTau;

        // O2 flow modulation target
        const modeBaseFlow =
          eq.oxygenFlowMode === 'conserve' ? 0.55 : eq.oxygenFlowMode === 'high_flow' ? 1.25 : 0.84;

        let targetHeartRate: number;
        let targetFlow: number;
        let targetCoreTemp: number;
        let targetCo2: number;
        let loopStatus: 'NOMINAL' | 'ELEVATED' | 'CHILLED';

        if (isRecentlyMoving) {
          const exertionFactor = eq.locomotionMode === 'eva_walk' ? 1.35 : 0.72;
          targetHeartRate = Math.min(146, Math.round((95 + slope * 1.4) * exertionFactor));
          targetFlow = Math.min(1.45, modeBaseFlow + (eq.locomotionMode === 'eva_walk' ? (slope / 25) * 0.3 : 0.08));
          targetCoreTemp = 37.3;
          targetCo2 = eq.oxygenFlowMode === 'conserve' ? 4.4 : 3.5;
          loopStatus = slope > 12 ? 'ELEVATED' : 'NOMINAL';
        } else {
          const sinus = Math.sin(tickCount * 0.4) * 2;
          targetHeartRate = 82 + sinus;
          targetFlow = modeBaseFlow;
          targetCoreTemp = 37.1;
          targetCo2 = eq.oxygenFlowMode === 'conserve' ? 3.8 : 3.1;
          loopStatus = 'NOMINAL';
        }

        // Power draw calculation (including Mars actuator slip load & cold-night heater penalty)
        const slopeSlipLoad = slope > 12 && isRecentlyMoving ? Math.round((slope - 10) * 2.2 * eq.speedTorqueSetting) : 0;
        const driveWatts = isRecentlyMoving ? Math.round(65 * eq.speedTorqueSetting) + slopeSlipLoad : 0;
        const lightWatts = eq.headlightsEnabled ? 28 : 0;
        const sensorWatts = eq.sensorArrayEnabled ? 18 : 4;
        const aiWatts = eq.autonomousAiPilot ? 16 : 0;
        const thermalHeaterWatts = prev.environmental.ambientTempCelsius < -45 ? 24 : 8;
        const baseWatts = 112 + thermalHeaterWatts;
        const totalDrawWatts = baseWatts + driveWatts + lightWatts + sensorWatts + aiWatts;

        // Mars Beer-Lambert solar irradiance & wind-shear danger on deployed panels
        let solarChargeWatts = 0;
        let dustAccum = eq.solarDustCoatingPercent;
        let wingStress = 0;
        const windGust = prev.atmospheric.windGustMps;
        const radRate = prev.environmental.radiationDoseRateMicroSvHr;
        const isSheltered = prev.consequences.isSheltered;

        if (eq.solarPanelsDeployed) {
          const atmosphericTransmission = Math.max(0.04, Math.exp(-tau * 0.85));
          const cleanEff = Math.max(0.08, 1 - dustAccum / 100);
          const protonTransientLoss = radRate > 80 ? 0.85 : 1.0;
          solarChargeWatts = Math.round(210 * atmosphericTransmission * cleanEff * protonTransientLoss);

          if (tau > 0.55 || windGust > 11.5) {
            const dustRate = tau > 1.2 ? 2.4 : tau > 0.75 ? 1.2 : 0.45;
            dustAccum = Math.min(98, Math.round((dustAccum + dustRate) * 10) / 10);
          }
          if (windGust > 13.5 || tau > 0.75) {
            wingStress = Math.min(100, Math.round((windGust - 10) * 6.5 + Math.max(0, tau - 0.5) * 22));
          } else {
            wingStress = Math.round(windGust * 2.2);
          }
        }

        // Physical integrity degradation scaled strongly by Mars event severity
        let integrityDelta = 0;
        const failureModes: string[] = [];
        let severityScore = 0;

        if (!isSheltered) {
          if (tau >= 1.3) severityScore += 2;
          else if (tau >= 0.7) severityScore += 1;

          if (windGust >= 20) severityScore += 2;
          else if (windGust >= 13.5) severityScore += 1;

          if (radRate >= 100) severityScore += 2;
          else if (radRate >= 40) severityScore += 1;

          if (eq.solarPanelsDeployed && (windGust > 13.5 || tau > 0.75)) {
            severityScore += 1;
          }
          if (prev.comms.commBlackoutActive) {
            severityScore += 1;
          }
          if (slope > 16 && prev.topography.dominantGeology !== 'BASALT_BEDROCK') {
            severityScore += 1;
          }
        }

        if (eq.solarPanelsDeployed && (windGust > 13.5 || tau > 0.75)) {
          integrityDelta -= windGust > 20 || tau > 1.5 ? 3.2 : 1.6;
          failureModes.push('SOLAR_WING_WIND_SHEAR');
        }
        if (eq.solarPanelsDeployed && (tau > 0.9 || dustAccum > 55)) {
          failureModes.push('DUST_SOLAR_STARVATION');
        }

        if (!isSheltered && (tau >= 0.85 || windGust >= 15)) {
          const dustDamage =
            tau >= 1.5 || windGust >= 20
              ? isRecentlyMoving
                ? 2.6
                : 1.8
              : 0.8;
          integrityDelta -= dustDamage;
        }

        let seuIncrement = 0;
        if (!isSheltered && radRate > 35) {
          const seuChance = radRate >= 120 ? 0.85 : radRate >= 60 ? 0.45 : 0.18;
          if (Math.random() < seuChance * (eq.sensorArrayEnabled ? 1.25 : 0.65)) {
            seuIncrement = radRate >= 120 ? 2 : 1;
          }
          if (radRate >= 50) {
            failureModes.push('SPE_AVIONICS_SEU');
          }
          if (radRate >= 140) {
            integrityDelta -= eq.locomotionMode === 'eva_walk' ? 3.4 : 2.4;
            failureModes.push('RADIATION_OVEREXPOSURE');
          } else if (radRate >= 85) {
            integrityDelta -= eq.locomotionMode === 'eva_walk' ? 1.8 : 1.2;
            failureModes.push('RADIATION_OVEREXPOSURE');
          } else if (radRate >= 40) {
            integrityDelta -= eq.locomotionMode === 'eva_walk' ? 0.8 : 0.5;
          }
        }

        if (!isSheltered && severityScore >= 3) {
          integrityDelta *= 1.5;
          failureModes.push('SEVERE_STORM_DAMAGE');
        }

        if (prev.comms.commBlackoutActive || prev.comms.signalStrengthPercent < 45 || radRate >= 60) {
          failureModes.push('UHF_IONOSPHERIC_FADE');
        }

        if (slope > 15 && prev.topography.dominantGeology !== 'BASALT_BEDROCK') {
          failureModes.push('REGOLITH_WHEEL_SLIP');
        }

        const netPowerWatts = solarChargeWatts - totalDrawWatts;
        const batChange = (-netPowerWatts / 146) * 0.015;

        const currentHr = prev.vitals.heartRateBpm;
        const newHr = Math.round(currentHr + (targetHeartRate - currentHr) * 0.3);
        const newFlow = Math.round((prev.vitals.oxygenFlowRateLpm + (targetFlow - prev.vitals.oxygenFlowRateLpm) * 0.25) * 100) / 100;
        const newPower = Math.round(prev.vitals.batteryPowerDrawWatts + (totalDrawWatts - prev.vitals.batteryPowerDrawWatts) * 0.35);
        const newCoreTemp = Math.round((prev.vitals.coreTempCelsius + (targetCoreTemp - prev.vitals.coreTempCelsius) * 0.15) * 10) / 10;
        const newCo2 = Math.round((prev.vitals.co2PartialPressureMmhg + (targetCo2 - prev.vitals.co2PartialPressureMmhg) * 0.2) * 10) / 10;

        const o2Burn = (newFlow / 0.84) * 0.012;
        const newO2Percent = Math.max(2.0, Math.round((prev.vitals.oxygenPercentage - o2Burn) * 10) / 10);
        const newO2Hours = Math.round((newO2Percent / 100) * (5.8 / (newFlow / 0.84)) * 10) / 10;

        const newBatPercent = Math.max(1.0, Math.min(100, Math.round((prev.vitals.batteryPercentage - batChange) * 10) / 10));
        const newBatHours = Math.round((newBatPercent / 100) * (6.0 / Math.max(0.2, newPower / 146)) * 10) / 10;
        if (newBatPercent < 15) {
          failureModes.push('POWER_BROWNOUT_LIMP');
        }

        const microDeltaP = Math.sin(tickCount * 0.5) * 0.04;
        const newSuitPressureKpa = Math.round((29.6 + microDeltaP) * 10) / 10;
        const newSuitPressurePsi = Math.round(newSuitPressureKpa * 0.145038 * 100) / 100;

        // Exposed EVA accumulates full dose; Rover shields ~35%, Habitat shields ~82%
        const shieldFactor = isSheltered ? 0.18 : eq.locomotionMode === 'rover' ? 0.65 : 1.0;
        const doseAddedMsv = ((radRate * shieldFactor / 3600) * 1.5) / 1000;
        const newCumulativeDose = Math.round((prev.environmental.cumulativeEvaDoseMilliSv + doseAddedMsv) * 1000) / 1000;

        const targetMotorTemp =
          prev.environmental.ambientTempCelsius +
          28 +
          (isRecentlyMoving ? 18 * eq.speedTorqueSetting + slope * 1.1 : 6) +
          (radRate > 80 ? 12 : 0);
        const newMotorTemp = Math.round((prev.consequences.motorTempCelsius + (targetMotorTemp - prev.consequences.motorTempCelsius) * 0.18) * 10) / 10;

        const isAutonomousGlobalExpedition =
          globalOverrideLatLngRef.current !== null || eq.autonomousAiPilot;

        // Return-to-Base emergency countdown timer (do not auto-expire/hijack active planetary autopilot)
        let nextRtbTimer = prev.returnToBaseTimerSeconds;
        let nextRtbTotal = prev.returnToBaseTotalSeconds;
        let timeoutBurstDamage = 0;

        if (isSheltered) {
          nextRtbTimer = null;
          nextRtbTotal = null;
        } else {
          const rtbTriggerActive =
            severityScore >= 2 ||
            (prev.hazardAlert.active && prev.hazardAlert.severity === 'CRITICAL_HAZARD') ||
            eq.suitRoverIntegrityPercent < 65;

          if (rtbTriggerActive || nextRtbTimer !== null) {
            const desiredTotal =
              severityScore >= 4 || eq.suitRoverIntegrityPercent < 40
                ? 90
                : severityScore >= 3 || radRate >= 100 || tau >= 1.5
                  ? 120
                  : 180;

            if (nextRtbTimer === null) {
              nextRtbTimer = desiredTotal;
              nextRtbTotal = desiredTotal;
            } else if (nextRtbTimer > 0) {
              nextRtbTimer = Math.max(0, Math.min(nextRtbTimer - 1, desiredTotal));
              nextRtbTotal = nextRtbTotal ? Math.min(nextRtbTotal, desiredTotal) : desiredTotal;
              if (nextRtbTimer === 0 && !isAutonomousGlobalExpedition) {
                timeoutBurstDamage = 12;
                playHazardAlarm();
              }
            }

            if (nextRtbTimer === 0 && !isAutonomousGlobalExpedition) {
              integrityDelta -= 2.5 + timeoutBurstDamage;
              failureModes.push('RTB_TIMEOUT_CRITICAL');
            }
          }
        }

        const effectiveIntegrityDelta = isSheltered ? 3.5 : integrityDelta;
        const minIntegrityFloor = isAutonomousGlobalExpedition ? 38 : 0;
        const newIntegrity = Math.max(
          minIntegrityFloor,
          Math.min(100, Math.round((eq.suitRoverIntegrityPercent + effectiveIntegrityDelta) * 10) / 10)
        );
        if (newIntegrity < 50) {
          failureModes.push('CHASSIS_AVIONICS_FAULT');
        }
        if (newIntegrity < 25) {
          failureModes.push('CRITICAL_ROVER_DAMAGE');
        }

        const damageRatePercentPerSec = isSheltered
          ? 0
          : Math.round(Math.max(0, -(integrityDelta + timeoutBurstDamage)) * 10) / 10;

        // Disable AI co-pilot on critical battery brownout (< 5%)
        const nextAiPilot = newBatPercent < 5 ? false : eq.autonomousAiPilot;

        return {
          ...prev,
          vitals: {
            ...prev.vitals,
            heartRateBpm: newHr,
            oxygenFlowRateLpm: newFlow,
            oxygenPercentage: newO2Percent,
            oxygenReserveDurationHours: newO2Hours,
            batteryPowerDrawWatts: newPower,
            batteryPercentage: newBatPercent,
            batteryReserveHours: newBatHours,
            coreTempCelsius: newCoreTemp,
            co2PartialPressureMmhg: newCo2,
            suitPressureKpa: newSuitPressureKpa,
            suitPressurePsi: newSuitPressurePsi,
            suitThermalLoopStatus: loopStatus,
          },
          equipment: {
            ...prev.equipment,
            solarDustCoatingPercent: dustAccum,
            suitRoverIntegrityPercent: newIntegrity,
            autonomousAiPilot: nextAiPilot,
          },
          environmental: {
            ...prev.environmental,
            cumulativeEvaDoseMilliSv: newCumulativeDose,
          },
          consequences: {
            ...prev.consequences,
            solarOutputWatts: solarChargeWatts,
            netPowerWatts,
            motorTempCelsius: newMotorTemp,
            seuBitFlipsCount: prev.consequences.seuBitFlipsCount + seuIncrement,
            solarWingStressPercent: wingStress,
            damageRatePercentPerSec,
            activeFailureModes: failureModes,
          },
          returnToBaseTimerSeconds: nextRtbTimer,
          returnToBaseTotalSeconds: nextRtbTotal,
          activeChallenge:
            prev.activeChallenge && !prev.activeChallenge.completed
              ? { ...prev.activeChallenge, elapsedSeconds: prev.activeChallenge.elapsedSeconds + 1 }
              : prev.activeChallenge,
        };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const handleEngageEmergencyRtb = useCallback(
    (isAuto = false) => {
      const habitats = MARS_WAYPOINTS.filter((wp) => wp.type === 'habitat');
      const candidates = habitats.length > 0 ? habitats : [MARS_WAYPOINTS[0]];
      const [jLat, jLng] = jezeroMetersToLatLng(astronautPos.x, astronautPos.y);
      const currentLatLng = globalOverrideLatLng ?? { lat: jLat, lng: jLng };

      let nearestHab = candidates[0];
      let minKm = Infinity;
      for (const h of candidates) {
        const [hLat, hLng] = jezeroMetersToLatLng(h.x, h.z);
        const dKm = haversineKm(currentLatLng, { lat: hLat, lng: hLng });
        if (dKm < minKm) {
          minKm = dKm;
          nearestHab = h;
        }
      }

      const habLatLng = jezeroLocalToLatLng(nearestHab.x, nearestHab.z);
      const habTarget: TargetLocationEntry = {
        id: nearestHab.id,
        x: nearestHab.x,
        y: nearestHab.z,
        name: nearestHab.name,
        lat: habLatLng.lat,
        lng: habLatLng.lng,
      };

      const originMeters = globalOverrideLatLng
        ? latLngToJezeroMeters(globalOverrideLatLng.lat, globalOverrideLatLng.lng)
        : { x: astronautPos.x, y: astronautPos.y };

      const dx = habTarget.x - originMeters.x;
      const dy = habTarget.y - originMeters.y;
      const newDistance = Math.round(minKm * 1000);
      const radToTarget = Math.atan2(dx, dy);
      const newBearing = (Math.round((radToTarget * 180) / Math.PI) + 360) % 360;
      const targetElev = getMarsElevation(habTarget.x, habTarget.y);
      const currentElev = getMarsElevation(originMeters.x, originMeters.y);
      const elevDelta = Math.round((targetElev - currentElev) * 10) / 10;

      nextCustomWpIdRef.current = 1;
      setCustomWaypoints([]);
      setContinueToTargetAfterWaypoints(false);
      setCustomArrival(null);
      arrivedWaypointRef.current = null;
      arrivedJezeroCheckpointRef.current = null;
      setDestinationReached(null);
      setTargetWp(habTarget);
      setHasExplicitDestination(true);

      playHazardAlarm();
      dualSense.hapticAutopilot(true);
      dualSense.hapticHazard('critical');

      dismissedHazardSigRef.current = null;
      setState((prev) => ({
        ...prev,
        emergencyRtbActive: true,
        equipment: {
          ...prev.equipment,
          autonomousAiPilot: true,
        },
        navigation: {
          ...prev.navigation,
          targetWaypointId: habTarget.id,
          targetName: habTarget.name,
          distanceMeters: newDistance,
          bearingDegrees: newBearing,
          relativeElevationDeltaMeters: elevDelta,
          etaMinutes: estimateMarsTravelEtaMinutes(
            newDistance,
            prev.equipment.locomotionMode,
            prev.equipment.speedTorqueSetting
          ),
        },
        returnToBaseTimerSeconds: prev.returnToBaseTimerSeconds ?? 120,
        returnToBaseTotalSeconds: prev.returnToBaseTotalSeconds ?? 120,
        hazardAlert: {
          ...prev.hazardAlert,
          active: true,
          exiting: false,
          requiresAck: true,
          severity: 'CRITICAL_HAZARD',
          title: isAuto
            ? `AUTO EMERGENCY RTB → ${habTarget.id}`
            : `EMERGENCY RTB ENGAGED → ${habTarget.id}`,
          code: 'HZ-EMERGENCY-RTB',
          recommendedImmediateAction: `All checkpoints cleared/disabled. AI Co-Pilot & blue guidance trail locked onto ${habTarget.id}.`,
        },
        lastSettingChange: {
          id: Date.now(),
          title: isAuto
            ? `AUTO EMERGENCY RTB TRIGGERED (${habTarget.id})`
            : `EMERGENCY RTB ENGAGED (${habTarget.id})`,
          detail:
            'All custom & sector checkpoints cleared/disabled. Steering directly to Base; new waypoints locked until arrival.',
          severity: 'danger',
          timestamp: Date.now(),
          requiresAck: true,
        },
      }));
    },
    [astronautPos.x, astronautPos.y, globalOverrideLatLng]
  );

  // Automatically engage Emergency RTB override ONLY during unassisted local Jezero EVA,
  // never overwriting an active global expedition or autonomous AI Co-Pilot destination on biome crossings.
  useEffect(() => {
    if (state.emergencyRtbActive || state.consequences.isSheltered) return;
    if (globalOverrideLatLng !== null || state.equipment.autonomousAiPilot) return;
    if (
      state.equipment.suitRoverIntegrityPercent <= 35 ||
      state.returnToBaseTimerSeconds === 0
    ) {
      handleEngageEmergencyRtb(true);
    }
  }, [
    state.emergencyRtbActive,
    state.consequences.isSheltered,
    globalOverrideLatLng,
    state.equipment.autonomousAiPilot,
    state.equipment.suitRoverIntegrityPercent,
    state.returnToBaseTimerSeconds,
    handleEngageEmergencyRtb,
  ]);

  const handleSetNavTarget = (
    waypointId: string,
    options?: {
      autopilot?: boolean;
      switchToTab?: 'hud' | 'visor' | 'console' | 'sensors';
      originOverride?: { lat: number; lng: number; elevationMeters?: number };
    }
  ) => {
    if (emergencyRtbActiveRef.current && waypointId !== 'HAB-01') {
      playCautionTone();
      setState((prev) => ({
        ...prev,
        lastSettingChange: {
          id: Date.now(),
          title: 'SECTOR CHECKPOINTS DISABLED (EMERGENCY RTB)',
          detail: 'Navigation locked onto Habitat Base (HAB-01) until emergency RTB completes.',
          severity: 'danger',
          timestamp: Date.now(),
        },
      }));
      return;
    }

    const wp =
      ALL_LANDMARK_LOCATIONS[waypointId] ||
      WAYPOINT_LOCATIONS[waypointId] ||
      WAYPOINT_LOCATIONS['WP-DELTA-04'];

    setTargetWp(wp);
    setHasExplicitDestination(true);
    arrivedWaypointRef.current = null;
    setDestinationReached(null);

    const originLatLng =
      options?.originOverride ??
      globalOverrideLatLng ??
      jezeroLocalToLatLng(astronautPos.x, astronautPos.y);
    const newDistance = Math.round(marsDistanceKm(originLatLng, { lat: wp.lat, lng: wp.lng }) * 1000);
    const newBearing = Math.round(marsBearingDeg(originLatLng, { lat: wp.lat, lng: wp.lng }));

    const currentElevMeters =
      options?.originOverride?.elevationMeters !== undefined
        ? options.originOverride.elevationMeters
        : globalOverrideLatLng
          ? state.activeEnvironment.elevationMeters
          : -2552 + getMarsElevation(astronautPos.x, astronautPos.y);
    const targetElevMeters =
      wp.elevationMeters !== undefined
        ? wp.elevationMeters
        : -2552 + getMarsElevation(wp.x, wp.y);
    const elevDelta = Math.round((targetElevMeters - currentElevMeters) * 10) / 10;

    setState((prev) => {
      const nextEnableAutopilot =
        options?.autopilot !== undefined ? options.autopilot : prev.equipment.enableAutopilotTravel;
      const shouldEngageAi = options?.autopilot ?? prev.equipment.enableAutopilotTravel;
      const originPatch = options?.originOverride
        ? buildRegionalStatePatch(prev, options.originOverride.lat, options.originOverride.lng, {
            emitToast: false,
          })
        : {};
      const activeEnv = originPatch.activeEnvironment ?? prev.activeEnvironment;

      return {
        ...prev,
        ...originPatch,
        equipment: {
          ...prev.equipment,
          enableAutopilotTravel: nextEnableAutopilot,
          autonomousAiPilot: shouldEngageAi ? true : prev.equipment.autonomousAiPilot,
        },
        navigation: {
          ...prev.navigation,
          targetWaypointId: wp.id,
          targetName: wp.name,
          distanceMeters: newDistance,
          bearingDegrees: newBearing,
          relativeElevationDeltaMeters: elevDelta,
          etaMinutes: estimateMarsTravelEtaMinutes(
            newDistance,
            prev.equipment.locomotionMode,
            prev.equipment.speedTorqueSetting
          ),
        },
        lastSettingChange: shouldEngageAi
          ? {
              id: Date.now(),
              title: `AUTOPILOT ENGAGED → ${wp.name.toUpperCase()}`,
              detail: `#52e0ff trail active (${
                newDistance >= 1000 ? `${(newDistance / 1000).toFixed(1)} km` : `${newDistance} m`
              }) · Active Env: ${formatActiveEnvironmentSummary(activeEnv)}`,
              severity: 'info',
              timestamp: Date.now(),
            }
          : {
              id: Date.now(),
              title: `DESTINATION LOCKED: ${wp.id}`,
              detail: `${wp.name} · ${
                newDistance >= 1000 ? `${(newDistance / 1000).toFixed(1)} km` : `${newDistance} m`
              } at ${newBearing}° · Active Env: ${activeEnv.regionName} (${activeEnv.elevationMeters}m, ${activeEnv.atmosphericPressurePa} Pa)`,
              severity: 'info',
              timestamp: Date.now(),
            },
      };
    });

    if (options?.switchToTab) {
      setActiveTab(options.switchToTab);
    }
    const engagedAi = options?.autopilot ?? stateRef.current.equipment.enableAutopilotTravel;
    if (engagedAi) {
      dualSense.hapticAutopilot(true);
    }
    playAckTone();
  };

  const handleDeployPlanetaryRoute = (route: PlanetaryRoutePlan) => {
    if (emergencyRtbActiveRef.current && route.destinationId !== 'HAB-01') {
      playCautionTone();
      return;
    }

    // Queue intermediate Dijkstra corridor nodes + safe perimeter bypasses before final destination
    const intermediateIds = route.corridorNodeIds.filter(
      (id) => id !== route.originId && id !== route.destinationId
    );
    const corridorWaypoints: CustomWaypoint[] = [];
    let nextId = 1;
    for (const nodeId of intermediateIds) {
      const lm = LANDMARK_BY_ID[nodeId];
      if (lm) {
        corridorWaypoints.push({ id: nextId++, lat: lm.lat, lng: lm.lng });
      }
    }
    nextCustomWpIdRef.current = nextId;
    setCustomWaypoints(corridorWaypoints);
    setContinueToTargetAfterWaypoints(corridorWaypoints.length > 0);
    setCustomArrival(null);

    if (route.originId !== '__CURRENT__') {
      const originLatLng = route.originLatLng;
      const meters = latLngToJezeroMeters(originLatLng.lat, originLatLng.lng);
      const limit = WORLD_HALF_EXTENT - 90;
      if (Math.abs(meters.x) <= limit && Math.abs(meters.y) <= limit) {
        handleSetAstronautCoords(meters.x, meters.y);
      } else {
        handleSetGlobalOverrideLatLngSynced(originLatLng);
      }
      handleSetNavTarget(route.destinationId, {
        autopilot: true,
        originOverride: {
          lat: originLatLng.lat,
          lng: originLatLng.lng,
          elevationMeters: route.originElevationMeters,
        },
      });
    } else {
      handleSetNavTarget(route.destinationId, { autopilot: true });
    }
  };

  const handleResetPosition = () => {
    playAckTone();
    arrivedWaypointRef.current = null;
    arrivedJezeroCheckpointRef.current = null;
    setDestinationReached(null);
    setHasExplicitDestination(false);
    setContinueToTargetAfterWaypoints(false);
    globalOverrideLatLngRef.current = null;
    setGlobalOverrideLatLng(null);
    vehicleSim.teleportLocal(INITIAL_POS.x, INITIAL_POS.y, INITIAL_POS.heading, true);
    vehicleSim.syncConfig({
      autonomousAiPilot: false,
      targetWp: {
        id: WAYPOINT_LOCATIONS['WP-DELTA-04'].id,
        x: WAYPOINT_LOCATIONS['WP-DELTA-04'].x,
        y: WAYPOINT_LOCATIONS['WP-DELTA-04'].y,
        lat: WAYPOINT_LOCATIONS['WP-DELTA-04'].lat,
        lng: WAYPOINT_LOCATIONS['WP-DELTA-04'].lng,
        isLandform: false,
      },
    });
    const jezeroOrigin = jezeroLocalToLatLng(INITIAL_POS.x, INITIAL_POS.y);
    astronautPosRef.current = INITIAL_POS;
    setAstronautPos(INITIAL_POS);
    setTargetWp(WAYPOINT_LOCATIONS['WP-DELTA-04']);
    const dx = WAYPOINT_LOCATIONS['WP-DELTA-04'].x - INITIAL_POS.x;
    const dy = WAYPOINT_LOCATIONS['WP-DELTA-04'].y - INITIAL_POS.y;
    setState((prev) => ({
      ...prev,
      ...buildRegionalStatePatch(prev, jezeroOrigin.lat, jezeroOrigin.lng, {
        emitToast: true,
      }),
      emergencyRtbActive: false,
      navigation: {
        ...prev.navigation,
        targetWaypointId: 'WP-DELTA-04',
        targetName: WAYPOINT_LOCATIONS['WP-DELTA-04'].name,
        distanceMeters: Math.round(Math.hypot(dx, dy)),
        bearingDegrees: 318,
        etaMinutes: 24.8,
      },
      equipment: {
        ...prev.equipment,
        autonomousAiPilot: false,
      },
    }));
  };

  const handleStartChallenge = (challengeId: string) => {
    const ch = TRAINING_CHALLENGES.find((c) => c.id === challengeId);
    if (!ch) return;

    const tgt = WAYPOINT_LOCATIONS[ch.targetWaypointId] || WAYPOINT_LOCATIONS['HAB-01'];
    setTargetWp(tgt);
    setHasExplicitDestination(true);
    globalOverrideLatLngRef.current = null;
    setGlobalOverrideLatLng(null);
    vehicleSim.teleportLocal(ch.startX, ch.startZ, 140, true);
    vehicleSim.syncConfig({
      targetWp: {
        id: tgt.id,
        x: tgt.x,
        y: tgt.y,
        lat: tgt.lat,
        lng: tgt.lng,
        isLandform: tgt.isLandform,
      },
    });
    const challengeStartPos = {
      x: ch.startX,
      y: ch.startZ,
      heading: 140,
      path: [{ x: ch.startX, y: ch.startZ }],
    };
    astronautPosRef.current = challengeStartPos;
    setAstronautPos(challengeStartPos);

    const dist = Math.round(Math.hypot(tgt.x - ch.startX, tgt.y - ch.startZ));
    const bearing = (Math.round((Math.atan2(tgt.x - ch.startX, tgt.y - ch.startZ) * 180) / Math.PI) + 360) % 360;

    setState((prev) => ({
      ...prev,
      vitals: {
        ...prev.vitals,
        oxygenPercentage: ch.initialO2,
        batteryPercentage: ch.initialBattery,
      },
      atmospheric: {
        ...prev.atmospheric,
        dustOpacityTau: ch.id === 'CH-02' ? 1.15 : prev.atmospheric.dustOpacityTau,
      },
      comms: {
        ...prev.comms,
        commBlackoutActive: ch.id === 'CH-03',
        earthMarsDelayMinutes: ch.id === 'CH-03' ? 22.0 : prev.comms.earthMarsDelayMinutes,
      },
      navigation: {
        ...prev.navigation,
        targetWaypointId: tgt.id,
        targetName: tgt.name,
        distanceMeters: dist,
        bearingDegrees: bearing,
      },
      activeChallenge: {
        id: ch.id,
        title: ch.title,
        objective: ch.objective,
        targetWaypointId: ch.targetWaypointId,
        completed: false,
        timeLimitSeconds: ch.timeLimitSeconds,
        elapsedSeconds: 0,
      },
      lastSettingChange: {
        id: Date.now(),
        title:
          ch.id === 'CH-03'
            ? 'COMMS ALERT: EARTH-MARS RELAY BLACKOUT'
            : `CHALLENGE STARTED: ${ch.title.toUpperCase()}`,
        detail: ch.objective,
        severity: ch.id === 'CH-03' ? 'danger' : 'warn',
        timestamp: Date.now(),
      },
    }));
    setActiveTab('hud');
    playAckTone();
  };

  const handleSetAstronautCoords = useCallback(
    (rawX: number, rawY: number) => {
      const limit = WORLD_HALF_EXTENT - 90;
      const newX = Math.max(-limit, Math.min(limit, rawX));
      const newY = Math.max(-limit, Math.min(limit, rawY));

      const dx = targetWp.x - newX;
      const dy = targetWp.y - newY;
      const newDistance = Math.round(Math.hypot(dx, dy));
      const radToTarget = Math.atan2(dx, dy);
      const newBearing = (Math.round((radToTarget * 180) / Math.PI) + 360) % 360;

      const metrics = getTerrainMetricsAt(newX, newY, 'JEZERO_CRATER');
      const targetElev = getMarsElevation(targetWp.x, targetWp.y, 'JEZERO_CRATER');
      const currentElev = getMarsElevation(newX, newY, 'JEZERO_CRATER');
      const elevDelta = Math.round((targetElev - currentElev) * 10) / 10;

      const baseAmbientRad = state.environmental.solarParticleEventActive
        ? Math.max(ambientSpeDoseRef.current, 28.4)
        : 9.2;
      const nearHab = Math.hypot(newX, newY) <= 25;
      const nearCache = Math.hypot(newX - 340, newY - 420) <= 25;
      const isSheltered = nearHab || nearCache;
      const rawLocalRadRate = metrics.activeHotspot
        ? Math.round((baseAmbientRad + metrics.activeHotspot.doseRateMicroSvHr) * 10) / 10
        : baseAmbientRad;
      const localRadRate = isSheltered ? Math.round(rawLocalRadRate * 0.18 * 10) / 10 : rawLocalRadRate;

      globalOverrideLatLngRef.current = null;
      setGlobalOverrideLatLng(null);
      vehicleSim.teleportLocal(newX, newY, undefined, false);

      const jezeroLatLng = jezeroLocalToLatLng(newX, newY);
      const nextBreadcrumbPath = vehicleSim.getBreadcrumbPathSnapshot();
      setAstronautPos((prev) => {
        const nextPos = {
          ...prev,
          x: newX,
          y: newY,
          path: nextBreadcrumbPath,
        };
        astronautPosRef.current = nextPos;
        return nextPos;
      });
      setState((prevState) => ({
        ...prevState,
        ...buildRegionalStatePatch(prevState, jezeroLatLng.lat, jezeroLatLng.lng, {
          emitToast: true,
          localElevationOffsetMeters: Math.round(currentElev),
          updateTopographyFromClimate: false,
        }),
        environmental: {
          ...prevState.environmental,
          ambientTempCelsius: -38.4,
          surfaceTempCelsius: -14.2,
          atmosphericPressurePa: 748,
          atmosphericPressureMbar: 7.48,
          radiationDoseRateMicroSvHr: localRadRate,
          speIntensityLevel:
            localRadRate >= 100
              ? 'EXTREME_CME_STORM'
              : localRadRate > 40
                ? 'HIGH_FLUX_WARNING'
                : localRadRate > 20
                  ? 'ELEVATED_FLUX'
                  : 'NONE',
        },
        topography: {
          ...prevState.topography,
          slopePercentage: metrics.slopePercentage,
          slopeAngleDegrees: metrics.slopeAngleDegrees,
          dominantGeology: metrics.geology,
          slipHazardRisk:
            metrics.slopePercentage > 15 ? 'SEVERE' : metrics.slopePercentage > 10 ? 'MODERATE' : 'LOW',
          surfaceTrafficabilityIndex: metrics.trafficability,
        },
        consequences: {
          ...prevState.consequences,
          isSheltered,
        },
        navigation: {
          ...prevState.navigation,
          distanceMeters: newDistance,
          bearingDegrees: newBearing,
          relativeElevationDeltaMeters: elevDelta,
          etaMinutes: estimateMarsTravelEtaMinutes(
            newDistance,
            prevState.equipment.locomotionMode,
            prevState.equipment.speedTorqueSetting
          ),
        },
      }));
    },
    [targetWp, state.environmental.solarParticleEventActive, buildRegionalStatePatch]
  );

  const handleSetGlobalOverrideLatLngSynced = useCallback(
    (action: React.SetStateAction<{ lat: number; lng: number } | null>) => {
      const nextLatLng =
        typeof action === 'function' ? action(globalOverrideLatLngRef.current) : action;
      globalOverrideLatLngRef.current = nextLatLng;
      setGlobalOverrideLatLng(nextLatLng);
      if (!nextLatLng) {
        const curPos = astronautPosRef.current;
        vehicleSim.teleportLocal(curPos.x, curPos.y, curPos.heading, false);
        return;
      }

      vehicleSim.teleportGlobal(nextLatLng.lat, nextLatLng.lng);

      const curTarget = targetWpRef.current;
      const newDistance = Math.round(marsDistanceKm(nextLatLng, { lat: curTarget.lat, lng: curTarget.lng }) * 1000);
      const newBearing = Math.round(marsBearingDeg(nextLatLng, { lat: curTarget.lat, lng: curTarget.lng }));

      setState((prev) => {
        const patch = buildRegionalStatePatch(prev, nextLatLng.lat, nextLatLng.lng, {
          emitToast: true,
        });
        const curElev = patch.activeEnvironment?.elevationMeters ?? prev.activeEnvironment.elevationMeters;
        const tgtElev =
          curTarget.elevationMeters !== undefined
            ? curTarget.elevationMeters
            : -2552 + getMarsElevation(curTarget.x, curTarget.y);

        return {
          ...prev,
          ...patch,
          navigation: {
            ...prev.navigation,
            distanceMeters: newDistance,
            bearingDegrees: newBearing,
            relativeElevationDeltaMeters: Math.round((tgtElev - curElev) * 10) / 10,
            etaMinutes: estimateMarsTravelEtaMinutes(
              newDistance,
              prev.equipment.locomotionMode,
              prev.equipment.speedTorqueSetting
            ),
          },
        };
      });
    },
    [buildRegionalStatePatch]
  );

  const handleCyclePlanetaryLandmark = useCallback(
    (direction: 'prev' | 'next') => {
      if (MARS_LANDFORMS.length === 0) return;
      const curLatLng =
        globalOverrideLatLngRef.current ??
        jezeroLocalToLatLng(astronautPosRef.current.x, astronautPosRef.current.y);

      let baseIdx = activeLandmarkCycleIdxRef.current;
      if (baseIdx < 0 || baseIdx >= MARS_LANDFORMS.length) {
        let closestIdx = 0;
        let closestDist = Infinity;
        for (let i = 0; i < MARS_LANDFORMS.length; i++) {
          const d = marsDistanceKm(curLatLng, { lat: MARS_LANDFORMS[i].lat, lng: MARS_LANDFORMS[i].lng });
          if (d < closestDist) {
            closestDist = d;
            closestIdx = i;
          }
        }
        baseIdx = closestIdx;
      }

      const nextIdx =
        direction === 'next'
          ? (baseIdx + 1) % MARS_LANDFORMS.length
          : (baseIdx - 1 + MARS_LANDFORMS.length) % MARS_LANDFORMS.length;
      activeLandmarkCycleIdxRef.current = nextIdx;

      const lm = MARS_LANDFORMS[nextIdx];
      playAckTone();
      vehicleSim.syncConfig({ autonomousAiPilot: false });
      handleSetGlobalOverrideLatLngSynced({ lat: lm.lat, lng: lm.lng });
      setState((prev) => ({
        ...prev,
        equipment: {
          ...prev.equipment,
          autonomousAiPilot: false,
        },
        lastSettingChange: {
          id: Date.now(),
          title: `ORBITAL TRANSIT → ${lm.name.toUpperCase()}`,
          detail: `${lm.region} · ${lm.dimensions.verticalMetric} · ${lm.dimensions.horizontalMetric}`,
          severity: 'info',
          timestamp: Date.now(),
        },
      }));
    },
    [handleSetGlobalOverrideLatLngSynced]
  );

  const handleInjectWorstCase = () => {
    dismissedHazardSigRef.current = null;
    setState((prev) => {
      const next = generateProceduralWorstCase(prev);
      ambientSpeDoseRef.current = next.environmental.radiationDoseRateMicroSvHr;
      return next;
    });
    playHazardAlarm();
  };

  const handleSimulateEmergency = () => {
    dismissedHazardSigRef.current = null;
    if (state.hazardAlert.active) {
      setState((prev) => clearStormEffectsInState(prev, 'MANUAL CLEAR', true, true));
      playAckTone();
    } else {
      handleInjectWorstCase();
    }
  };

  const handleLoadScenario = (scenarioKey: keyof typeof PRESET_SCENARIOS) => {
    dismissedHazardSigRef.current = null;
    setCurrentScenarioKey(scenarioKey);
    const preset = PRESET_SCENARIOS[scenarioKey];
    ambientSpeDoseRef.current = preset.state.environmental.radiationDoseRateMicroSvHr;
    setState({
      ...preset.state,
      equipment: state.equipment,
      activeChallenge: null,
      lastSettingChange: {
        id: Date.now(),
        title: `SCENARIO LOADED: ${preset.name.toUpperCase()}`,
        detail: preset.description,
        severity: preset.state.hazardAlert.severity === 'CRITICAL_HAZARD' ? 'danger' : 'info',
        timestamp: Date.now(),
      },
    });
    handleResetPosition();
  };

  const handleAcknowledgeCommand = (id: string) => {
    playAckTone();
    setState({
      ...state,
      recommendations: state.recommendations.map((r) => (r.id === id ? { ...r, acknowledged: true } : r)),
    });
  };

  const handleExecuteCommand = (id: string) => {
    playAckTone();
    setState({
      ...state,
      recommendations: state.recommendations.map((r) =>
        r.id === id ? { ...r, acknowledged: true, executed: true } : r
      ),
    });
  };

  const handleAcknowledgeHazard = () => {
    playAckTone();
    dismissedHazardSigRef.current = `${state.hazardAlert.severity}|${state.hazardAlert.title}`;
    setState({
      ...state,
      hazardAlert: {
        ...state.hazardAlert,
        active: false,
        exiting: false,
      },
    });
  };

  const handleHazardOverride = useCallback(() => {
    dismissedHazardSigRef.current = null;
    ambientSpeDoseRef.current = 9.2;
    const wasRtb = emergencyRtbActiveRef.current;
    if (wasRtb) {
      setHasExplicitDestination(false);
    }
    arrivedWaypointRef.current = null;
    arrivedJezeroCheckpointRef.current = null;

    setState((prev) => ({
      ...prev,
      vitals: {
        ...prev.vitals,
        oxygenPercentage: Math.max(prev.vitals.oxygenPercentage, 85),
        batteryPercentage: Math.max(prev.vitals.batteryPercentage, 85),
        co2PartialPressureMmhg: Math.min(prev.vitals.co2PartialPressureMmhg, 3.1),
        coreTempCelsius: 37.1,
        suitThermalLoopStatus: 'NOMINAL',
      },
      atmospheric: {
        ...prev.atmospheric,
        windSpeedMps: 4.2,
        windGustMps: 6.4,
        dustOpacityTau: 0.32,
        thermalTrendCelsiusPerHour: -0.4,
        dustStormStatus: 'CLEAR',
      },
      environmental: {
        ...prev.environmental,
        radiationDoseRateMicroSvHr: 9.2,
        solarParticleEventActive: false,
        speIntensityLevel: 'NONE',
      },
      topography: {
        ...prev.topography,
        slopePercentage: Math.min(prev.topography.slopePercentage, 8.0),
        slopeAngleDegrees: Math.min(prev.topography.slopeAngleDegrees, 4.6),
        surfaceTrafficabilityIndex: Math.max(prev.topography.surfaceTrafficabilityIndex, 0.82),
        slipHazardRisk: 'LOW',
      },
      comms: {
        ...prev.comms,
        commBlackoutActive: false,
        signalStrengthPercent: 94,
      },
      equipment: {
        ...prev.equipment,
        solarDustCoatingPercent: 0,
        suitRoverIntegrityPercent: 100,
        autonomousAiPilot: prev.emergencyRtbActive ? false : prev.equipment.autonomousAiPilot,
      },
      consequences: {
        ...prev.consequences,
        solarWingStressPercent: 0,
        damageRatePercentPerSec: 0,
        wheelSlipPercent: 0,
        seuBitFlipsCount: 0,
        motorTempCelsius: 22.0,
        activeFailureModes: [],
      },
      hazardAlert: {
        active: false,
        severity: 'NOMINAL',
        title: 'SYSTEMS NOMINAL',
        code: 'HZ-NOMINAL',
        message: 'Hazard override engaged. All active hazards cleared.',
        trippedParameters: [],
        recommendedImmediateAction: 'All hazards overridden — nominal EVA operations resumed.',
      },
      returnToBaseTimerSeconds: null,
      returnToBaseTotalSeconds: null,
      emergencyRtbActive: false,
      lastSettingChange: {
        id: Date.now(),
        title: 'HAZARD OVERRIDE · ALL HAZARDS CLEARED',
        detail:
          'Storms, radiation alerts, comm blackout, failure modes, and RTB locks cleared; suit & rover restored to nominal.',
        severity: 'info',
        timestamp: Date.now(),
      },
    }));
    playAckTone();
  }, []);

  const handleDispatchTestNotification = useCallback(
    (tier: 'info' | 'warn' | 'danger' | 'emergency_ack') => {
      const now = Date.now();
      if (tier === 'emergency_ack') {
        setState((prev) => ({
          ...prev,
          lastSettingChange: {
            id: now,
            title: 'DEV OVERRIDE TEST · EMERGENCY MANUAL ACK',
            detail: 'Emergency override alert stays pinned until operator explicitly clicks ACK.',
            severity: 'danger',
            timestamp: now,
            requiresAck: true,
          },
        }));
        return;
      }
      const config = {
        info: {
          title: 'DEV TEST · LOW SEVERITY / INFO (3.5s)',
          detail: 'Routine telemetry diagnostic pulse; auto-clears smoothly after 3.5 seconds.',
          severity: 'info' as const,
        },
        warn: {
          title: 'DEV TEST · MEDIUM SEVERITY / WARNING (5.5s)',
          detail: 'Simulated atmospheric dust front advisory; auto-clears smoothly after 5.5 seconds.',
          severity: 'warn' as const,
        },
        danger: {
          title: 'DEV TEST · CRITICAL COMMS ALERT (7.5s)',
          detail: 'Simulated UHF carrier degradation / high-severity alert; auto-clears after 7.5 seconds.',
          severity: 'danger' as const,
        },
      }[tier];
      setState((prev) => ({
        ...prev,
        lastSettingChange: {
          id: now,
          title: config.title,
          detail: config.detail,
          severity: config.severity,
          timestamp: now,
        },
      }));
    },
    []
  );

  const handleTeleportLocal = useCallback(
    (x: number, y: number, heading?: number) => {
      handleSetAstronautCoords(x, y);
      if (heading !== undefined && !Number.isNaN(heading)) {
        const wrapped = ((heading % 360) + 360) % 360;
        vehicleSim.teleportLocal(x, y, wrapped, true);
        setAstronautPos((prev) => {
          const nextPos = { ...prev, heading: wrapped };
          astronautPosRef.current = nextPos;
          return nextPos;
        });
      }
    },
    [handleSetAstronautCoords]
  );

  const anyHazardActive =
    state.hazardAlert.active ||
    state.emergencyRtbActive ||
    state.returnToBaseTimerSeconds !== null ||
    state.environmental.solarParticleEventActive ||
    state.environmental.radiationDoseRateMicroSvHr > 22 ||
    state.atmospheric.dustOpacityTau > 0.45 ||
    state.atmospheric.windGustMps > 12 ||
    state.atmospheric.dustStormStatus !== 'CLEAR' ||
    state.comms.commBlackoutActive ||
    state.consequences.activeFailureModes.length > 0 ||
    state.equipment.suitRoverIntegrityPercent < 75 ||
    state.vitals.oxygenPercentage < 45 ||
    state.vitals.batteryPercentage < 45;

  const hasGuidanceTarget = customWaypoints.length > 0 || hasExplicitDestination;

  const fallbackView = (
    <div className="min-h-screen flex-1 bg-[#07090e] flex items-center justify-center font-mono text-xs text-cyan-300 tracking-wider">
      INITIALIZING MARS EVA MODULE...
    </div>
  );

  if (activeTab === 'hud') {
    return (
      <>
        <Suspense fallback={fallbackView}>
          <MarsWalkHud
            state={state}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            astronautPos={astronautPos}
            targetPos={{ x: targetWp.x, y: targetWp.y }}
            targetLatLng={{ lat: targetWp.lat, lng: targetWp.lng }}
            hasGuidanceTarget={hasGuidanceTarget}
            onMoveAstronaut={handleMoveAstronaut}
            onDriveInput={handleDriveInput}
            liveVehicleRef={liveVehiclePoseRef}
            onSetAstronautCoords={handleSetAstronautCoords}
            onResetPosition={handleResetPosition}
            onSetNavTarget={handleSetNavTarget}
            onDeployPlanetaryRoute={handleDeployPlanetaryRoute}
            onUpdateEquipment={handleUpdateEquipment}
            onAcknowledgeHazard={handleAcknowledgeHazard}
            onSimulateEmergency={handleSimulateEmergency}
            isMuted={isMuted}
            setIsMuted={handleToggleMute}
            lastMovedTimestamp={lastMovedTimestamp}
            destinationReached={destinationReached}
            onDismissDestinationReached={handleDismissDestinationReached}
            onTriggerSolarEvent={handleTriggerSolarEvent}
            onDismissSettingChange={handleDismissSettingChange}
            customWaypoints={customWaypoints}
            onAddCustomWaypoint={handleAddCustomWaypoint}
            onRemoveCustomWaypoint={handleRemoveCustomWaypoint}
            onClearCustomWaypoints={handleClearCustomWaypoints}
            globalOverrideLatLng={globalOverrideLatLng}
            onSetGlobalOverrideLatLng={handleSetGlobalOverrideLatLngSynced}
            customArrival={customArrival}
            onDismissCustomArrival={handleDismissCustomArrival}
            onEngageEmergencyRtb={() => handleEngageEmergencyRtb(false)}
            onHazardOverride={handleHazardOverride}
            anyHazardActive={anyHazardActive}
            onTogglePolarFrostMode={handleTogglePolarFrostMode}
            discoveredFeatureIds={discoveredFeatureIds}
            activeProximityFeature={activeProximityFeature}
            recentDiscovery={recentDiscovery}
            onDismissRecentDiscovery={handleDismissRecentDiscovery}
          />
        </Suspense>
        <VirtualControllerCursor active={cursorModeActive} />
      </>
    );
  }

  return (
    <>
      <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col font-sans">
        <TopNav
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          isMuted={isMuted}
          setIsMuted={handleToggleMute}
          hazardActive={state.hazardAlert.active}
          anyHazardActive={anyHazardActive}
          onSimulateEmergency={handleSimulateEmergency}
          onHazardOverride={handleHazardOverride}
          sol={state.mission.currentSol}
          timeUtc={state.mission.missionTimeUtc}
        />

        <main className="flex-1 flex flex-col overflow-y-auto">
          <Suspense fallback={fallbackView}>
            {activeTab === 'visor' && (
              <VisorHUD
                state={state}
                hudMode={hudMode}
                setHudMode={setHudMode}
                astronautPos={astronautPos}
                liveVehicleRef={liveVehiclePoseRef}
                targetPos={{ x: targetWp.x, y: targetWp.y }}
                targetLatLng={{ lat: targetWp.lat, lng: targetWp.lng }}
                hasGuidanceTarget={hasGuidanceTarget}
                customWaypoints={customWaypoints}
                globalOverrideLatLng={globalOverrideLatLng}
                onMoveAstronaut={handleMoveAstronaut}
                onDriveInput={handleDriveInput}
                onResetPosition={handleResetPosition}
                onWaypointLock={playChirpSound}
                onAcknowledgeHazard={state.hazardAlert.active ? handleAcknowledgeHazard : undefined}
                onSetNavTarget={handleSetNavTarget}
                onUpdateEquipment={handleUpdateEquipment}
                onInjectWorstCase={handleInjectWorstCase}
                destinationReached={destinationReached}
                onDismissDestinationReached={handleDismissDestinationReached}
                onTriggerSolarEvent={handleTriggerSolarEvent}
                onDismissSettingChange={handleDismissSettingChange}
                onEngageEmergencyRtb={() => handleEngageEmergencyRtb(false)}
                onHazardOverride={handleHazardOverride}
                anyHazardActive={anyHazardActive}
                onTogglePolarFrostMode={handleTogglePolarFrostMode}
                discoveredFeatureIds={discoveredFeatureIds}
                activeProximityFeature={activeProximityFeature}
                recentDiscovery={recentDiscovery}
                onDismissRecentDiscovery={handleDismissRecentDiscovery}
                showMiniMap={visorMiniMapOpen}
                onToggleMiniMap={(open) =>
                  setVisorMiniMapOpen((prev) => (open !== undefined ? open : !prev))
                }
                onCycleLandmark={handleCyclePlanetaryLandmark}
              />
            )}

            {activeTab === 'console' && (
              <TelemetryReport
                state={state}
                onAcknowledgeCommand={handleAcknowledgeCommand}
                onExecuteCommand={handleExecuteCommand}
              />
            )}

            {activeTab === 'sensors' && (
              <NasaDatasetMatrix
                state={state}
                onUpdateState={(nextState) => {
                  ambientSpeDoseRef.current = nextState.environmental.radiationDoseRateMicroSvHr;
                  setState(nextState);
                }}
                onLoadScenario={handleLoadScenario}
                currentScenarioKey={currentScenarioKey}
                onStartChallenge={handleStartChallenge}
                onInjectWorstCase={handleInjectWorstCase}
                onTriggerSolarEvent={handleTriggerSolarEvent}
                astronautLatLng={
                  globalOverrideLatLng ?? jezeroLocalToLatLng(astronautPos.x, astronautPos.y)
                }
                onSelectLandform={(id, autopilot) =>
                  handleSetNavTarget(id, { autopilot, switchToTab: 'visor' })
                }
                onUpdateEquipment={handleUpdateEquipment}
                onTogglePolarFrostMode={handleTogglePolarFrostMode}
                onEngageEmergencyRtb={() => handleEngageEmergencyRtb(false)}
                onHazardOverride={handleHazardOverride}
                onResetPosition={handleResetPosition}
                onTeleportLocal={handleTeleportLocal}
                onTeleportGlobal={(lat, lng) => handleSetGlobalOverrideLatLngSynced({ lat, lng })}
                onDispatchTestNotification={handleDispatchTestNotification}
                hudMode={hudMode}
                onSetHudMode={setHudMode}
                onSwitchTab={setActiveTab}
                isMuted={isMuted}
                onToggleMute={handleToggleMute}
                globalOverrideActive={globalOverrideLatLng !== null}
              />
            )}
          </Suspense>
        </main>
      </div>
      {(activeTab === 'sensors' || activeTab === 'console') && state.lastSettingChange && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed top-16 left-1/2 -translate-x-1/2 z-[1150] w-[min(560px,calc(100vw-32px))] rounded-lg border px-4 py-2.5 shadow-2xl backdrop-blur-md flex items-center justify-between gap-3 overflow-hidden transition-all duration-200 ${
            state.lastSettingChange.exiting
              ? 'opacity-0 -translate-y-1.5 pointer-events-none'
              : 'opacity-100 translate-y-0'
          } ${
            state.lastSettingChange.severity === 'danger'
              ? 'bg-rose-950/95 border-rose-500/80 text-rose-100'
              : state.lastSettingChange.severity === 'warn'
                ? 'bg-amber-950/95 border-amber-500/80 text-amber-100'
                : 'bg-cyan-950/95 border-cyan-500/75 text-cyan-100'
          }`}
        >
          <div className="min-w-0">
            <div className="font-display text-xs font-bold tracking-wider uppercase truncate">
              {state.lastSettingChange.title}
            </div>
            <div className="text-[11px] font-mono opacity-90 mt-0.5">
              {state.lastSettingChange.detail}
            </div>
          </div>
          <button
            type="button"
            onClick={handleDismissSettingChange}
            className="px-2 py-0.5 text-xs font-mono border border-current/40 rounded hover:bg-white/10 shrink-0"
          >
            {state.lastSettingChange.requiresAck ? 'ACK' : '×'}
          </button>
          {getSettingToastDismissMs(state.lastSettingChange) !== null && (
            <div
              key={state.lastSettingChange.id}
              className={`absolute bottom-0 left-0 right-0 h-0.5 origin-left ${
                state.lastSettingChange.severity === 'danger'
                  ? 'bg-rose-400/85'
                  : state.lastSettingChange.severity === 'warn'
                    ? 'bg-amber-400/85'
                    : 'bg-cyan-400/85'
              }`}
              style={{
                animation: `hud-toast-countdown ${getSettingToastDismissMs(state.lastSettingChange)}ms linear forwards`,
              }}
            />
          )}
        </div>
      )}
      <VirtualControllerCursor active={cursorModeActive} />
    </>
  );
}
