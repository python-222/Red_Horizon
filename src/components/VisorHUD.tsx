import React, { useState, useEffect, useMemo, useRef, Suspense, lazy } from 'react';
import { ExcursionState, HudDisplayMode, EquipmentControlState, SeasonalFrostMode } from '../types/telemetry';
import { TacticalMarsMap } from './TacticalMarsMap';
import { Mars3DViewport, MarsSpectralViewMode, VisorLandformBeacon, VisorWaypointBeacon } from './Mars3DViewport';
import { vehicleSim, type DriveDirection, type LiveVehiclePose } from '../utils/vehicleController';
import {
  CustomWaypoint,
  jezeroMetersToLatLng,
  latLngToJezeroMeters,
  orderWaypointsNearestFirst,
} from '../utils/marsCoords';

const RoverPhotoViewer = lazy(() =>
  import('./RoverPhotoViewer').then((m) => ({ default: m.RoverPhotoViewer }))
);
import {
  getMarsElevation,
  MARS_WAYPOINTS,
  MARS_LANDFORMS,
  JEZERO_SCIENCE_FEATURES,
  ScienceFeature,
  LANDFORM_CATEGORY_COLORS,
  VISOR_PROXIMITY_THRESHOLD_KM,
  jezeroLocalToLatLng,
  marsDistanceKm,
  marsBearingDeg,
  estimateMarsTravelEtaMinutes,
} from '../data/marsTerrain';
import { 
  AlertTriangle, 
  Activity, 
  Radiation, 
  Thermometer, 
  Crosshair, 
  SlidersHorizontal, 
  ArrowRightCircle, 
  ArrowLeftCircle, 
  MapPin,
  Camera,
  Sun,
  Lightbulb,
  Cpu,
  Radio,
  Trophy,
  Gauge,
  Footprints,
  Truck,
  CheckCircle2
} from 'lucide-react';
import { playChirpSound, playAckTone } from '../utils/audioAlerts';
import { OlympusClimbPanel, TerrainHazardBanner } from './TharsisHazardPanels';
import {
  NOTIFICATION_AUTO_DISMISS_MS,
  getHazardAlertDismissMs,
  getSettingToastDismissMs,
} from '../utils/notificationTimers';

interface VisorHUDProps {
  state: ExcursionState;
  hudMode: HudDisplayMode;
  setHudMode: (mode: HudDisplayMode) => void;
  astronautPos: { x: number; y: number; heading: number; path: Array<{ x: number; y: number }> };
  liveVehicleRef?: React.MutableRefObject<LiveVehiclePose>;
  targetPos?: { x: number; y: number };
  targetLatLng?: { lat: number; lng: number };
  onMoveAstronaut: (direction: 'forward' | 'backward' | 'left' | 'right') => void;
  onDriveInput?: (direction: DriveDirection, active: boolean, sourceId?: string) => void;
  onResetPosition?: () => void;
  onWaypointLock?: () => void;
  onAcknowledgeHazard?: () => void;
  onSetNavTarget?: (
    waypointId: string,
    options?: { autopilot?: boolean; switchToTab?: 'hud' | 'visor' | 'console' | 'sensors' }
  ) => void;
  onUpdateEquipment: (patch: Partial<EquipmentControlState>) => void;
  onInjectWorstCase?: () => void;
  destinationReached?: {
    waypointId: string;
    waypointName: string;
    dismissed: boolean;
    exiting?: boolean;
  } | null;
  onDismissDestinationReached?: () => void;
  onTriggerSolarEvent?: (level?: 'NONE' | 'ELEVATED_FLUX' | 'HIGH_FLUX_WARNING' | 'EXTREME_CME_STORM') => void;
  onDismissSettingChange?: () => void;
  onEngageEmergencyRtb?: () => void;
  onHazardOverride?: () => void;
  anyHazardActive?: boolean;
  hasGuidanceTarget?: boolean;
  customWaypoints?: CustomWaypoint[];
  globalOverrideLatLng?: { lat: number; lng: number } | null;
  onTogglePolarFrostMode?: (mode?: SeasonalFrostMode) => void;
  discoveredFeatureIds?: string[];
  activeProximityFeature?: ScienceFeature | null;
  recentDiscovery?: { feature: ScienceFeature; dismissed: boolean; exiting?: boolean } | null;
  onDismissRecentDiscovery?: () => void;
  showMiniMap?: boolean;
  onToggleMiniMap?: (open?: boolean) => void;
  onCycleLandmark?: (direction: 'prev' | 'next') => void;
}

export const VisorHUD: React.FC<VisorHUDProps> = ({
  state,
  hudMode,
  setHudMode,
  astronautPos,
  liveVehicleRef,
  targetPos = { x: -580, y: 860 },
  targetLatLng,
  onMoveAstronaut,
  onDriveInput,
  onResetPosition,
  onWaypointLock,
  onAcknowledgeHazard,
  onSetNavTarget,
  onUpdateEquipment,
  onInjectWorstCase,
  destinationReached = null,
  onDismissDestinationReached,
  onTriggerSolarEvent,
  onDismissSettingChange,
  onEngageEmergencyRtb,
  onHazardOverride,
  anyHazardActive = false,
  hasGuidanceTarget = false,
  customWaypoints = [],
  globalOverrideLatLng = null,
  onTogglePolarFrostMode,
  discoveredFeatureIds = [],
  activeProximityFeature = null,
  recentDiscovery = null,
  onDismissRecentDiscovery,
  showMiniMap: showMiniMapProp,
  onToggleMiniMap,
  onCycleLandmark,
}) => {
  const [reticleLocked, setReticleLocked] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showHorizon, setShowHorizon] = useState(true);
  const [localShowMiniMap, setLocalShowMiniMap] = useState(true);
  const [isMapEnlarged, setIsMapEnlarged] = useState(false);
  const [spectralMode, setSpectralMode] = useState<MarsSpectralViewMode>('optical');
  const [selectedPhotoWaypointId, setSelectedPhotoWaypointId] = useState<string | null>(null);

  const showMiniMap = showMiniMapProp !== undefined ? showMiniMapProp : localShowMiniMap;
  const setShowMiniMap = (next: boolean) => {
    if (onToggleMiniMap) onToggleMiniMap(next);
    else setLocalShowMiniMap(next);
    if (!next) setIsMapEnlarged(false);
  };

  useEffect(() => {
    if (!showMiniMap && isMapEnlarged) {
      setIsMapEnlarged(false);
    }
  }, [showMiniMap, isMapEnlarged]);

  const compassLeft45Ref = useRef<HTMLSpanElement>(null);
  const compassLeft25Ref = useRef<HTMLSpanElement>(null);
  const compassCenterHdgRef = useRef<HTMLSpanElement>(null);
  const compassRight25Ref = useRef<HTMLSpanElement>(null);
  const compassRight45Ref = useRef<HTMLSpanElement>(null);
  const reticleWrapRef = useRef<HTMLDivElement>(null);
  const initialHeadingRef = useRef<number>(Math.round(astronautPos.heading));

  const handleReticleClick = () => {
    playChirpSound();
    setReticleLocked(!reticleLocked);
    if (onWaypointLock) onWaypointLock();
  };

  const handleModeChange = (mode: HudDisplayMode) => {
    playChirpSound();
    setHudMode(mode);
  };

  const {
    vitals,
    environmental,
    atmospheric,
    topography,
    navigation,
    hazardAlert,
    mission,
    equipment,
    comms,
    activeChallenge,
    consequences,
    lastSettingChange,
  } = state;

  const settingToastDismissMs = getSettingToastDismissMs(lastSettingChange);
  const hazardAlertDismissMs = getHazardAlertDismissMs(hazardAlert, state.emergencyRtbActive);

  const isSpeVisualActive = environmental.solarParticleEventActive || environmental.radiationDoseRateMicroSvHr > 25;
  const isExtremeSpe = environmental.radiationDoseRateMicroSvHr >= 100 || environmental.speIntensityLevel === 'EXTREME_CME_STORM';
  const isWindShearRisk =
    equipment.solarPanelsDeployed && (atmospheric.windGustMps > 13.5 || atmospheric.dustOpacityTau > 0.75);
  const isEmergencyRtbEligible =
    atmospheric.dustOpacityTau >= 0.9 ||
    atmospheric.windGustMps >= 15 ||
    atmospheric.dustStormStatus === 'GLOBAL_DUST_STORM' ||
    environmental.radiationDoseRateMicroSvHr >= 50 ||
    equipment.suitRoverIntegrityPercent < 65 ||
    vitals.oxygenPercentage < 25 ||
    vitals.batteryPercentage < 25 ||
    (hazardAlert.active && hazardAlert.severity === 'CRITICAL_HAZARD') ||
    state.returnToBaseTimerSeconds !== null;

  const effectiveAstroPos = useMemo(() => {
    if (!globalOverrideLatLng) return astronautPos;
    const m = latLngToJezeroMeters(globalOverrideLatLng.lat, globalOverrideLatLng.lng);
    return { ...astronautPos, x: m.x, y: m.y };
  }, [astronautPos, globalOverrideLatLng]);

  const currentAstroLatLng = useMemo(() => {
    if (globalOverrideLatLng) return globalOverrideLatLng;
    const [lat, lng] = jezeroMetersToLatLng(astronautPos.x, astronautPos.y);
    return { lat, lng };
  }, [globalOverrideLatLng, astronautPos.x, astronautPos.y]);

  const visorWaypoints = useMemo<VisorWaypointBeacon[]>(() => {
    return MARS_WAYPOINTS.map((wp) => {
      const ll = jezeroLocalToLatLng(wp.x, wp.z);
      const distanceKm = marsDistanceKm(currentAstroLatLng, ll);
      return {
        id: wp.id,
        name: wp.name,
        x: wp.x,
        z: wp.z,
        distanceKm,
        type: wp.type,
        description: wp.description,
      };
    }).filter((wp) => wp.distanceKm <= VISOR_PROXIMITY_THRESHOLD_KM);
  }, [currentAstroLatLng]);

  const visorLandforms = useMemo<VisorLandformBeacon[]>(() => {
    return MARS_LANDFORMS.map((lf) => {
      const cat = LANDFORM_CATEGORY_COLORS[lf.category];
      const ll = { lat: lf.lat, lng: lf.lng };
      const distanceKm = marsDistanceKm(currentAstroLatLng, ll);
      const bearingDeg = Math.round(marsBearingDeg(currentAstroLatLng, ll));
      const m = latLngToJezeroMeters(lf.lat, lf.lng);
      return {
        id: lf.id,
        name: lf.name,
        category: lf.category,
        categoryLabel: cat.label,
        colorHex: cat.hex,
        colorNum: cat.num,
        x: m.x,
        z: m.y,
        distanceKm,
        bearingDeg,
        elevationMeters: lf.elevationMeters,
        scienceSummary: lf.scienceSummary,
      };
    })
      .filter((lf) => lf.distanceKm <= VISOR_PROXIMITY_THRESHOLD_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }, [currentAstroLatLng]);

  const culledBeaconsCount =
    MARS_LANDFORMS.length - visorLandforms.length + (MARS_WAYPOINTS.length - visorWaypoints.length);

  const orderedCustomWaypoints = useMemo(
    () => orderWaypointsNearestFirst(currentAstroLatLng, customWaypoints),
    [currentAstroLatLng, customWaypoints]
  );

  const customMarkersMeters = useMemo(
    () =>
      orderedCustomWaypoints.map((wp, idx) => {
        const m = latLngToJezeroMeters(wp.lat, wp.lng);
        return { id: wp.id, x: m.x, y: m.y, isNext: idx === 0 };
      }),
    [orderedCustomWaypoints]
  );

  const nearestCustomWp = orderedCustomWaypoints[0] ?? null;
  const nearestCustomMeters = customMarkersMeters[0] ?? null;
  const effectiveTargetPos = nearestCustomMeters
    ? { x: nearestCustomMeters.x, y: nearestCustomMeters.y }
    : targetPos;
  const showTrail = customWaypoints.length > 0 || hasGuidanceTarget;

  const displayNav = useMemo(() => {
    if (nearestCustomMeters && nearestCustomWp) {
      const distM = Math.round(marsDistanceKm(currentAstroLatLng, nearestCustomWp) * 1000);
      const bearingDeg = Math.round(marsBearingDeg(currentAstroLatLng, nearestCustomWp));
      const elevDelta =
        distM <= 2500 && !globalOverrideLatLng
          ? Math.round(
              (getMarsElevation(nearestCustomMeters.x, nearestCustomMeters.y) -
                getMarsElevation(effectiveAstroPos.x, effectiveAstroPos.y)) *
                10
            ) / 10
          : 0;
      return {
        ...navigation,
        targetWaypointId: `WP${nearestCustomMeters.id}`,
        targetName: `Custom Waypoint #${nearestCustomMeters.id}`,
        distanceMeters: distM,
        bearingDegrees: bearingDeg,
        relativeElevationDeltaMeters: elevDelta,
        etaMinutes: estimateMarsTravelEtaMinutes(
          distM,
          equipment.locomotionMode,
          equipment.speedTorqueSetting
        ),
      };
    }

    if (targetLatLng && (globalOverrideLatLng || navigation.distanceMeters >= 1800)) {
      const distM = Math.round(marsDistanceKm(currentAstroLatLng, targetLatLng) * 1000);
      const bearingDeg = Math.round(marsBearingDeg(currentAstroLatLng, targetLatLng));
      return {
        ...navigation,
        distanceMeters: distM,
        bearingDegrees: bearingDeg,
        etaMinutes: estimateMarsTravelEtaMinutes(
          distM,
          equipment.locomotionMode,
          equipment.speedTorqueSetting
        ),
      };
    }

    return navigation;
  }, [
    nearestCustomMeters,
    nearestCustomWp,
    effectiveAstroPos.x,
    effectiveAstroPos.y,
    equipment.locomotionMode,
    equipment.speedTorqueSetting,
    navigation,
    targetLatLng,
    globalOverrideLatLng,
    currentAstroLatLng,
  ]);

  const targetTrailDirectionDeg = useMemo(() => {
    if (!showTrail) return null;
    if (nearestCustomMeters) return displayNav.bearingDegrees;
    if (targetLatLng) return Math.round(marsBearingDeg(currentAstroLatLng, targetLatLng));
    return displayNav.bearingDegrees;
  }, [showTrail, nearestCustomMeters, displayNav.bearingDegrees, targetLatLng, currentAstroLatLng]);

  // Calculate relative bearing offset between astronaut heading and target waypoint
  let relativeAzimuth = displayNav.bearingDegrees - astronautPos.heading;
  while (relativeAzimuth > 180) relativeAzimuth -= 360;
  while (relativeAzimuth < -180) relativeAzimuth += 360;

  const maxFovDeg = 45;
  const isTargetInFov = Math.abs(relativeAzimuth) <= maxFovDeg;
  const clampedAzimuth = Math.max(-maxFovDeg, Math.min(maxFovDeg, relativeAzimuth));
  const reticlePixelOffset = (clampedAzimuth / maxFovDeg) * 220;

  // 60fps direct-DOM sync for compass azimuth tape & targeting reticle while React telemetry commits at ~4.5 Hz
  const hudSyncRef = useRef({
    bearingDegrees: displayNav.bearingDegrees,
    fallbackHeading: astronautPos.heading,
  });
  hudSyncRef.current = {
    bearingDegrees: displayNav.bearingDegrees,
    fallbackHeading: astronautPos.heading,
  };

  useEffect(() => {
    let lastRenderedHeading = -9999;
    let lastReticleX = -9999;
    let lastReticleY = -9999;

    const syncCompassAndReticle = (_dt: number, nowMs: number, simPose: LiveVehiclePose) => {
      const liveHdg = liveVehicleRef?.current?.heading ?? simPose.heading ?? hudSyncRef.current.fallbackHeading;
      const roundedHdg = ((Math.round(liveHdg) % 360) + 360) % 360;
      if (roundedHdg !== lastRenderedHeading) {
        lastRenderedHeading = roundedHdg;
        if (compassLeft45Ref.current) {
          compassLeft45Ref.current.textContent = `${(roundedHdg - 45 + 360) % 360}°`;
        }
        if (compassLeft25Ref.current) {
          compassLeft25Ref.current.textContent = `${(roundedHdg - 25 + 360) % 360}°`;
        }
        if (compassCenterHdgRef.current) {
          compassCenterHdgRef.current.textContent = `HDG ${roundedHdg}°`;
        }
        if (compassRight25Ref.current) {
          compassRight25Ref.current.textContent = `${(roundedHdg + 25) % 360}°`;
        }
        if (compassRight45Ref.current) {
          compassRight45Ref.current.textContent = `${(roundedHdg + 45) % 360}°`;
        }
      }

      const tSec = nowMs * 0.001;
      const idleRoll = Math.sin(tSec * 0.55) * 0.55;
      const idlePitch = Math.sin(tSec * 0.72) * 0.75;

      let relAz = hudSyncRef.current.bearingDegrees - liveHdg;
      while (relAz > 180) relAz -= 360;
      while (relAz < -180) relAz += 360;
      const clampedAz = Math.max(-45, Math.min(45, relAz));
      const nextX = Math.round(((clampedAz / 45) * 220 + idleRoll * 2) * 10) / 10;
      const nextY = Math.round(idlePitch * 3 * 10) / 10;
      if (reticleWrapRef.current && (nextX !== lastReticleX || nextY !== lastReticleY)) {
        lastReticleX = nextX;
        lastReticleY = nextY;
        reticleWrapRef.current.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
      }
    };

    syncCompassAndReticle(0, performance.now(), vehicleSim.poseRef.current);
    return vehicleSim.addHudFrameListener(syncCompassAndReticle);
  }, [liveVehicleRef]);

  const viewportVitals = useMemo(
    () => ({
      batteryPercentage: vitals.batteryPercentage,
      ambientTempCelsius: environmental.ambientTempCelsius,
    }),
    [vitals.batteryPercentage, environmental.ambientTempCelsius]
  );

  return (
    <div className="relative w-full h-[calc(100vh-60px)] min-h-[760px] bg-[#05070c] overflow-hidden flex flex-col justify-between p-3 sm:p-4 select-none border-x border-b border-slate-800">
      
      {/* Real-Time 3D Martian Terrain & Holographic Safe Path Viewport */}
      <Mars3DViewport
        astronautPos={astronautPos}
        liveVehicleRef={liveVehicleRef}
        targetPos={effectiveTargetPos}
        showGuidanceTrail={showTrail}
        customWaypoints={customMarkersMeters}
        visorLandforms={visorLandforms}
        visorWaypoints={visorWaypoints}
        targetTrailDirectionDeg={targetTrailDirectionDeg}
        activeTargetId={navigation.targetWaypointId}
        enableAutopilotTravel={equipment.enableAutopilotTravel}
        onToggleAutopilotTravel={(enabled) => onUpdateEquipment({ enableAutopilotTravel: enabled })}
        onSelectBeacon={(id, opts) => {
          onSetNavTarget?.(id, opts);
        }}
        pitchOffset={0}
        rollOffset={0}
        spectralMode={spectralMode}
        equipment={equipment}
        dustOpacityTau={atmospheric.dustOpacityTau}
        windGustMps={atmospheric.windGustMps}
        radiationDoseRateMicroSvHr={environmental.radiationDoseRateMicroSvHr}
        solarParticleEventActive={environmental.solarParticleEventActive}
        wheelSlipPercent={consequences.wheelSlipPercent}
        onSelectWaypoint={(wpId) => {
          playAckTone();
          setSelectedPhotoWaypointId(wpId);
        }}
        vitals={viewportVitals}
        activeEnvironment={state.activeEnvironment}
        discoveredFeatureIds={discoveredFeatureIds}
        onCycleLandmark={onCycleLandmark}
      />

      {/* Visor Optical Curvature Vignette, Dust Storm & SPE Proton Snow Overlay */}
      <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_58%,rgba(7,9,14,0.78)_100%)]" />
        {atmospheric.dustOpacityTau > 0.5 && (
          <div
            className="absolute inset-0 transition-opacity duration-500"
            style={{
              background:
                'radial-gradient(circle at 50% 40%, rgba(194,92,42,0.18), rgba(110,38,14,0.62) 95%)',
              opacity: Math.min(0.85, (atmospheric.dustOpacityTau - 0.45) * 0.55),
            }}
          />
        )}
        {isSpeVisualActive && (
          <div
            className={`absolute inset-0 transition-opacity duration-300 ${isExtremeSpe ? 'animate-pulse' : ''}`}
            style={{
              background: isExtremeSpe
                ? 'radial-gradient(circle at center, transparent 40%, rgba(244,63,94,0.42) 100%), repeating-linear-gradient(0deg, rgba(255,180,80,0.06) 0 1px, transparent 1px 5px)'
                : 'radial-gradient(circle at center, transparent 52%, rgba(245,158,11,0.28) 100%)',
            }}
          />
        )}
        <div className="absolute inset-0 ring-1 ring-inset ring-cyan-500/15 pointer-events-none rounded-2xl" />
        {showGrid && hudMode !== 'minimalist' && (
          <div className="absolute inset-0 hud-visor-grid opacity-20" />
        )}
        <div className="absolute inset-0 hud-crt-scanlines opacity-10" />
      </div>

      {/* TOP HUD SECTION: Compass Tape, Comms Latency, Challenge & Density Switcher */}
      <div className="relative z-10 w-full max-w-6xl mx-auto flex flex-col items-center">
        
        {/* Top Control & Density Ribbon */}
        <div className="flex flex-wrap items-center justify-between w-full px-2 mb-2 text-xs gap-2">
          <div className="flex items-center gap-2 font-mono text-cyan-400/95 tracking-wider uppercase text-[11px] bg-slate-950/90 px-2.5 py-1 rounded-lg border border-slate-800">
            <span className="font-bold">{mission.mission}</span>
            <span className="text-slate-500">·</span>
            <span>Sol {mission.currentSol}</span>
            <span className="text-slate-500">·</span>
            <span className={`flex items-center gap-1 font-bold ${comms.commBlackoutActive ? 'text-rose-400' : 'text-amber-300'}`}>
              <Radio className="w-3 h-3" />
              {comms.commBlackoutActive ? `COMM BLACKOUT (${comms.earthMarsDelayMinutes}m)` : `EARTH DELAY: ${comms.earthMarsDelayMinutes}m`}
            </span>
          </div>

          {/* Emergency Return-to-Base Countdown & Command */}
          {state.returnToBaseTimerSeconds !== null && (
            <div
              className={`px-3 py-1 rounded-lg border font-mono text-[11px] flex items-center gap-1.5 font-bold tabular-nums ${
                state.returnToBaseTimerSeconds <= 30
                  ? 'bg-rose-950/95 border-rose-500 text-rose-300'
                  : 'bg-amber-950/95 border-amber-500/80 text-amber-300'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>
                {state.returnToBaseTimerSeconds === 0
                  ? 'RTB EXPIRED — CRITICAL DMG'
                  : `RTB ${String(Math.floor(state.returnToBaseTimerSeconds / 60)).padStart(2, '0')}:${String(state.returnToBaseTimerSeconds % 60).padStart(2, '0')}`}
              </span>
            </div>
          )}

          {state.emergencyRtbActive ? (
            <div className="px-3 py-1 rounded-lg border border-rose-500 bg-rose-950/95 text-rose-200 font-mono text-[11px] font-bold flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span>▲ EMERGENCY RTB ACTIVE → HAB-01 (WP LOCKED)</span>
            </div>
          ) : (
            isEmergencyRtbEligible &&
            onEngageEmergencyRtb && (
              <button
                type="button"
                onClick={onEngageEmergencyRtb}
                className="px-3 py-1 rounded-lg border border-rose-400 bg-rose-600 hover:bg-rose-500 text-white font-mono text-[11px] font-bold flex items-center gap-1.5 shadow-lg shadow-rose-500/30 transition-colors"
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>ENGAGE EMERGENCY RTB</span>
              </button>
            )
          )}

          {/* Active Gamified Challenge Banner */}
          {activeChallenge && (
            <div className={`px-3 py-1 rounded-lg border font-mono text-[11px] flex items-center gap-2 ${
              activeChallenge.completed
                ? 'bg-emerald-950/92 border-emerald-500/70 text-emerald-300'
                : 'bg-amber-950/92 border-amber-500/70 text-amber-200'
            }`}>
              <Trophy className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="font-bold">
                {activeChallenge.completed ? `CHALLENGE COMPLETE: ${activeChallenge.title}` : `${activeChallenge.title} · ${activeChallenge.elapsedSeconds}s`}
              </span>
            </div>
          )}

          {/* DENSITY MODE SWITCHER */}
          <div className="flex items-center gap-1 p-1 bg-slate-950/92 border border-slate-800 rounded-lg">
            <span className="text-[10px] font-mono text-slate-400 px-2 uppercase hidden sm:inline">
              HUD Density:
            </span>
            <button
              type="button"
              onClick={() => handleModeChange('minimalist')}
              className={`px-2.5 py-1 text-xs font-mono font-medium rounded transition-all whitespace-nowrap ${
                hudMode === 'minimalist'
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm shadow-cyan-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Minimalist
            </button>
            <button
              type="button"
              onClick={() => handleModeChange('standard')}
              className={`px-2.5 py-1 text-xs font-mono font-medium rounded transition-all whitespace-nowrap ${
                hudMode === 'standard'
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm shadow-cyan-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Standard
            </button>
            <button
              type="button"
              onClick={() => handleModeChange('verbose')}
              className={`px-2.5 py-1 text-xs font-mono font-medium rounded transition-all whitespace-nowrap ${
                hudMode === 'verbose'
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm shadow-cyan-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Verbose
            </button>
          </div>
        </div>

        {/* Dynamic Compass Azimuth Tape (Rotates dynamically with astronaut heading) */}
        <div className={`w-full bg-slate-950/90 border border-cyan-500/35 rounded-lg p-2 shadow-lg flex flex-col items-center ${
          hudMode === 'minimalist' ? 'max-w-xl' : 'max-w-4xl'
        }`}>
          <div className="flex items-center justify-between w-full text-xs font-mono text-slate-400 px-3">
            <span ref={compassLeft45Ref}>{(initialHeadingRef.current - 45 + 360) % 360}°</span>
            <span ref={compassLeft25Ref} className="hidden sm:inline">{(initialHeadingRef.current - 25 + 360) % 360}°</span>
            <span ref={compassCenterHdgRef} className="text-cyan-300 font-bold">HDG {initialHeadingRef.current}°</span>
            <span className="text-amber-400 font-extrabold flex items-center gap-1">
              ▼ {displayNav.bearingDegrees}° [{displayNav.targetWaypointId}]
            </span>
            <span ref={compassRight25Ref} className="hidden sm:inline">{(initialHeadingRef.current + 25) % 360}°</span>
            <span ref={compassRight45Ref}>{(initialHeadingRef.current + 45) % 360}°</span>
          </div>

          {/* Compass Tick Ladder */}
          {hudMode !== 'minimalist' && (
            <div className="w-full flex justify-between items-end h-2.5 px-2 pt-1 border-t border-cyan-500/20 mt-1">
              {Array.from({ length: 25 }).map((_, i) => (
                <div 
                  key={i} 
                  className={`w-[1px] ${
                    i === 12 
                      ? 'h-2.5 bg-cyan-300 w-[2px]' 
                      : i % 4 === 0 
                        ? 'h-2 bg-cyan-400/80' 
                        : 'h-1 bg-slate-700'
                  }`}
                />
              ))}
            </div>
          )}
        </div>

        {/* 300 KM PROXIMITY FILTERED LANDFORM BEACONS STRIP */}
        {hudMode !== 'minimalist' && (
          <div className="w-full max-w-4xl mt-1.5 flex items-center gap-1.5 overflow-x-auto px-2 py-1 bg-slate-950/92 border border-slate-800 rounded-lg pointer-events-auto">
            <span className="text-[10px] font-mono text-cyan-300 font-bold shrink-0">
              VISOR &lt;={VISOR_PROXIMITY_THRESHOLD_KM}KM ({visorLandforms.length} LANDFORMS · {culledBeaconsCount} CULLED):
            </span>
            {visorLandforms.length === 0 ? (
              <span className="text-[10px] font-mono text-slate-400">
                No landforms within 300 km — select distant sites in Minimap or Datasets.
              </span>
            ) : (
              visorLandforms.map((lf) => {
                const isSelected = navigation.targetWaypointId === lf.id;
                return (
                  <button
                    key={lf.id}
                    type="button"
                    onClick={() => {
                      playAckTone();
                      onSetNavTarget?.(lf.id);
                    }}
                    className={`px-2 py-0.5 rounded border text-[10px] font-mono flex items-center gap-1.5 shrink-0 transition-colors ${
                      isSelected
                        ? 'bg-cyan-950/90 border-cyan-400 text-white font-bold'
                        : 'bg-slate-900/90 border-slate-700 hover:border-slate-500 text-slate-200'
                    }`}
                    title={`${lf.name} (${lf.categoryLabel}) · ${lf.distanceKm.toFixed(1)} km at ${lf.bearingDeg}°`}
                  >
                    <span
                      className="w-2 h-2 rotate-45 shrink-0"
                      style={{ backgroundColor: lf.colorHex }}
                    />
                    <span className="truncate max-w-[140px]">{lf.name}</span>
                    <span className="text-cyan-300">{lf.distanceKm.toFixed(0)}km</span>
                  </button>
                );
              })
            )}
          </div>
        )}

        {/* CRITICAL HAZARD ALERT WINDOW */}
        {hazardAlert.active && (
          <div 
            className={`relative overflow-hidden w-full mt-2 rounded-lg border p-2.5 shadow-xl transition-all duration-200 ${
              hazardAlert.exiting ? 'opacity-0 -translate-y-1.5 pointer-events-none' : 'opacity-100 translate-y-0'
            } ${
              hazardAlert.severity === 'CRITICAL_HAZARD'
                ? 'bg-rose-950/92 border-rose-500/80 text-rose-100'
                : 'bg-amber-950/92 border-amber-500/80 text-amber-100'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-display text-xs sm:text-sm font-bold tracking-wider uppercase text-rose-300">
                      [HAZARD ALERT] {hazardAlert.title}
                    </span>
                    <span className="text-[11px] font-mono text-rose-300/80">({hazardAlert.code})</span>
                  </div>
                  <p className="text-xs text-rose-200 mt-0.5 leading-relaxed">
                    {hazardAlert.message}
                  </p>
                  
                  {hudMode !== 'minimalist' && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {hazardAlert.trippedParameters.map((param, idx) => (
                        <span 
                          key={idx}
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-900/60 border border-rose-500/40 text-rose-200"
                        >
                          ⚠ {param}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {onAcknowledgeHazard && (
                  <button
                    type="button"
                    onClick={onAcknowledgeHazard}
                    className="px-2.5 py-1 text-xs font-mono font-bold bg-rose-600 hover:bg-rose-500 text-white rounded border border-rose-400 transition-colors"
                  >
                    ACK
                  </button>
                )}
              </div>
            </div>
            {hazardAlertDismissMs !== null && (
              <div
                key={`${hazardAlert.code}-${hazardAlert.title}`}
                className={`absolute bottom-0 left-0 right-0 h-0.5 origin-left ${
                  hazardAlert.severity === 'CRITICAL_HAZARD' ? 'bg-rose-400/80' : 'bg-amber-400/80'
                }`}
                style={{
                  animation: `hud-toast-countdown ${hazardAlertDismissMs}ms linear forwards`,
                }}
              />
            )}
          </div>
        )}
        {/* RAVINE / TROUGH HAZARD SCAN + OLYMPUS MONS CLIMB TELEMETRY */}
        <div className="w-full mt-2 space-y-2">
          <TerrainHazardBanner
            biomeId={state.activeEnvironment.biomeId}
            frostMode={state.activeEnvironment.seasonalCo2FrostMode}
          />
          <OlympusClimbPanel
            biomeId={state.activeEnvironment.biomeId}
            slopePct={topography.slopePercentage}
            frostMode={state.activeEnvironment.seasonalCo2FrostMode}
          />
        </div>
        {/* DESTINATION REACHED ARRIVAL BANNER */}
        {destinationReached && !destinationReached.dismissed && (
          <div
            role="status"
            aria-live="polite"
            className={`relative overflow-hidden w-full mt-2 rounded-lg border border-emerald-400/80 bg-emerald-950/92 text-emerald-100 p-2.5 shadow-xl transition-all duration-200 ${
              destinationReached.exiting ? 'opacity-0 -translate-y-1.5 pointer-events-none' : 'opacity-100 translate-y-0'
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <div>
                  <div className="font-display text-xs sm:text-sm font-bold tracking-wider uppercase text-emerald-300">
                    DESTINATION REACHED
                  </div>
                  <p className="text-xs text-emerald-200 mt-0.5 font-mono">
                    Arrived at {destinationReached.waypointId}: {destinationReached.waypointName} (within {navigation.distanceMeters} m)
                  </p>
                </div>
              </div>
              {onDismissDestinationReached && (
                <button
                  type="button"
                  onClick={onDismissDestinationReached}
                  className="px-2.5 py-1 text-xs font-mono font-bold bg-emerald-600 hover:bg-emerald-500 text-white rounded border border-emerald-400 transition-colors shrink-0"
                >
                  ACK
                </button>
              )}
            </div>
            <div
              key={destinationReached.waypointId}
              className="absolute bottom-0 left-0 right-0 h-0.5 origin-left bg-emerald-400/85"
              style={{
                animation: `hud-toast-countdown ${NOTIFICATION_AUTO_DISMISS_MS.info}ms linear forwards`,
              }}
            />
          </div>
        )}

        {/* SETTING / SOLAR EVENT CONSEQUENCE BANNER */}
        {lastSettingChange && (
          <div
            role="status"
            aria-live="polite"
            className={`relative overflow-hidden w-full mt-2 rounded-lg border p-2.5 shadow-xl transition-all duration-200 flex items-center justify-between gap-3 ${
              lastSettingChange.exiting ? 'opacity-0 -translate-y-1.5 pointer-events-none' : 'opacity-100 translate-y-0'
            } ${
              lastSettingChange.severity === 'danger'
                ? 'bg-rose-950/92 border-rose-500/80 text-rose-100'
                : lastSettingChange.severity === 'warn'
                  ? 'bg-amber-950/92 border-amber-500/80 text-amber-100'
                  : 'bg-cyan-950/92 border-cyan-500/70 text-cyan-100'
            }`}
          >
            <div>
              <div className="font-display text-xs font-bold tracking-wider uppercase">
                {lastSettingChange.title}
              </div>
              <div className="text-[11px] font-mono opacity-90 mt-0.5">{lastSettingChange.detail}</div>
            </div>
            {onDismissSettingChange && (
              <button
                type="button"
                onClick={onDismissSettingChange}
                className="px-2 py-0.5 text-xs font-mono border border-current/40 rounded hover:bg-white/10 shrink-0"
              >
                {lastSettingChange.requiresAck ? 'ACK' : '×'}
              </button>
            )}
            {settingToastDismissMs !== null && (
              <div
                key={lastSettingChange.id}
                className={`absolute bottom-0 left-0 right-0 h-0.5 origin-left ${
                  lastSettingChange.severity === 'danger'
                    ? 'bg-rose-400/85'
                    : lastSettingChange.severity === 'warn'
                      ? 'bg-amber-400/85'
                      : 'bg-cyan-400/85'
                }`}
                style={{
                  animation: `hud-toast-countdown ${settingToastDismissMs}ms linear forwards`,
                }}
              />
            )}
          </div>
        )}

        {/* PROXIMITY SCIENCE DISCOVERY PROMPT WITH AUTOPILOT TO LOCATION */}
        {(() => {
          const isDiscoveryToast = Boolean(recentDiscovery && !recentDiscovery.dismissed);
          const promptFeat = isDiscoveryToast
            ? recentDiscovery!.feature
            : activeProximityFeature;
          if (!promptFeat || globalOverrideLatLng) return null;
          const isCurrentTarget = navigation.targetWaypointId === promptFeat.id;
          const isDiscoveryExiting = isDiscoveryToast && Boolean(recentDiscovery?.exiting);
          return (
            <div
              role="status"
              aria-live="polite"
              className={`w-full max-w-4xl mt-2 rounded-lg border bg-slate-950/94 p-2.5 shadow-xl flex flex-wrap items-center justify-between gap-2.5 pointer-events-auto transition-all duration-200 ${
                isDiscoveryExiting ? 'opacity-0 -translate-y-1.5 pointer-events-none' : 'opacity-100 translate-y-0'
              }`}
              style={{ borderColor: promptFeat.colorHex }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap font-mono text-[10px]">
                  <span
                    className="px-1.5 py-0.5 rounded font-bold uppercase border"
                    style={{
                      color: promptFeat.colorHex,
                      borderColor: promptFeat.colorHex,
                    }}
                  >
                    {activeProximityFeature?.id === promptFeat.id ? 'PROXIMITY SCAN' : 'DISCOVERED'} · {promptFeat.categoryLabel}
                  </span>
                  <span className="text-slate-400 tabular-nums">
                    {discoveredFeatureIds.length}/{JEZERO_SCIENCE_FEATURES.length} SCIENCE POIs LOGGED
                  </span>
                </div>
                <div className="font-display text-xs sm:text-sm font-bold text-slate-100 mt-0.5">
                  {promptFeat.name}
                </div>
                <div className="text-[11px] font-mono text-slate-300 truncate">
                  {promptFeat.mineralSignature}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {onSetNavTarget && (
                  <button
                    type="button"
                    onClick={() => onSetNavTarget(promptFeat.id, { autopilot: true })}
                    className="px-2.5 py-1 text-xs font-mono font-bold rounded bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition-colors"
                  >
                    {isCurrentTarget && equipment.autonomousAiPilot
                      ? 'AUTOPILOTING...'
                      : 'Autopilot to Location'}
                  </button>
                )}
                {recentDiscovery && !recentDiscovery.dismissed && onDismissRecentDiscovery && (
                  <button
                    type="button"
                    onClick={onDismissRecentDiscovery}
                    className="px-2 py-1 text-xs font-mono border border-slate-700 rounded text-slate-300 hover:bg-white/10"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      {/* MIDDLE HUD SECTION: Wings, Reticle, and Tactical Corner Mini-Map */}
      <div className="relative z-10 w-full flex-1 flex items-center justify-between py-2 pointer-events-none">
        
        {/* LEFT HUD WING (Core Telemetry, Life Support & Mars Equipment Control) */}
        {hudMode !== 'minimalist' ? (
          <div className="w-68 lg:w-76 flex flex-col gap-2 pointer-events-auto max-h-[540px] overflow-y-auto pr-1">
            {/* Core Telemetry & Life Support Box */}
            <div className="bg-slate-950/92 border border-cyan-500/35 rounded-lg p-2.5">
              <div className="flex items-center justify-between border-b border-cyan-500/20 pb-1 mb-2">
                <span className="text-xs font-display font-semibold tracking-wider text-cyan-300 uppercase">
                  Core Telemetry &amp; Suit
                </span>
                <span
                  className={`text-[10px] font-mono font-bold tabular-nums ${
                    equipment.suitRoverIntegrityPercent < 60 ? 'text-rose-400' : 'text-emerald-400'
                  }`}
                >
                  INT {equipment.suitRoverIntegrityPercent.toFixed(1)}%
                  {consequences.damageRatePercentPerSec > 0 && (
                    <span className="text-rose-400 ml-1">
                      (-{consequences.damageRatePercentPerSec.toFixed(1)}%/s)
                    </span>
                  )}
                </span>
              </div>

              {/* 4 Core Telemetry Metrics Grid: Battery, O2 Flow, Thermal Status, Regolith Slip Risk */}
              <div className="grid grid-cols-2 gap-1.5 mb-2 font-mono tabular-nums">
                <div className="bg-slate-900/90 border border-slate-800 rounded px-2 py-1">
                  <div className="text-[9px] text-slate-400 uppercase tracking-wider">Battery Reserves</div>
                  <div className={`text-xs font-bold ${vitals.batteryPercentage < 25 ? 'text-rose-400' : 'text-amber-300'}`}>
                    {vitals.batteryPercentage.toFixed(1)}%{' '}
                    <span className="text-[10px] font-normal text-slate-400">({vitals.batteryReserveHours}h)</span>
                  </div>
                </div>
                <div className="bg-slate-900/90 border border-slate-800 rounded px-2 py-1">
                  <div className="text-[9px] text-slate-400 uppercase tracking-wider">Oxygen Flow</div>
                  <div className={`text-xs font-bold ${vitals.oxygenPercentage < 25 ? 'text-rose-400' : 'text-cyan-300'}`}>
                    {vitals.oxygenFlowRateLpm.toFixed(2)}{' '}
                    <span className="text-[10px] font-normal text-slate-400">L/min</span>
                  </div>
                </div>
                <div className="bg-slate-900/90 border border-slate-800 rounded px-2 py-1">
                  <div className="text-[9px] text-slate-400 uppercase tracking-wider">Thermal Status</div>
                  <div
                    className={`text-xs font-bold ${
                      vitals.suitThermalLoopStatus === 'NOMINAL'
                        ? 'text-emerald-400'
                        : vitals.suitThermalLoopStatus === 'ELEVATED'
                          ? 'text-amber-300'
                          : 'text-sky-300'
                    }`}
                  >
                    {vitals.suitThermalLoopStatus}{' '}
                    <span className="text-[10px] font-normal text-slate-400">{vitals.coreTempCelsius.toFixed(1)}°C</span>
                  </div>
                </div>
                <div className="bg-slate-900/90 border border-slate-800 rounded px-2 py-1">
                  <div className="text-[9px] text-slate-400 uppercase tracking-wider">Regolith Slip Risk</div>
                  <div
                    className={`text-xs font-bold ${
                      topography.slipHazardRisk === 'SEVERE'
                        ? 'text-rose-400'
                        : topography.slipHazardRisk === 'MODERATE'
                          ? 'text-amber-300'
                          : 'text-emerald-400'
                    }`}
                  >
                    {topography.slipHazardRisk}{' '}
                    <span className="text-[10px] font-normal text-slate-400">{consequences.wheelSlipPercent}%</span>
                  </div>
                </div>
              </div>

              {/* O2 Status Bar */}
              <div className="mb-1.5">
                <div className="flex justify-between text-[11px] mb-0.5">
                  <span className="text-slate-400">O2 Tank</span>
                  <span className="font-mono font-bold text-cyan-300 tabular-nums">
                    {vitals.oxygenPercentage.toFixed(1)}% ({vitals.oxygenReserveDurationHours}h)
                  </span>
                </div>
                <div className="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden border border-slate-800">
                  <div 
                    className={`h-full transition-all duration-500 ${
                      vitals.oxygenPercentage < 25 ? 'bg-rose-500' : 'bg-cyan-400'
                    }`}
                    style={{ width: `${vitals.oxygenPercentage}%` }}
                  />
                </div>
              </div>

              {/* Battery Bar & Power Balance */}
              <div className="pt-1 border-t border-slate-900">
                <div className="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden border border-slate-800">
                  <div 
                    className="h-full bg-amber-400 transition-all duration-500"
                    style={{ width: `${vitals.batteryPercentage}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1 tabular-nums">
                  <span>Draw {vitals.batteryPowerDrawWatts}W · Sol +{consequences.solarOutputWatts}W</span>
                  <span>Dust {equipment.solarDustCoatingPercent}%</span>
                </div>
              </div>

              {/* Biometrics & Avionics */}
              <div className="flex justify-between items-center text-[10px] pt-1.5 mt-1.5 border-t border-slate-900 font-mono text-slate-300 tabular-nums">
                <span>HR <strong className="text-cyan-300">{vitals.heartRateBpm}</strong></span>
                <span>CO2 <strong className="text-slate-200">{vitals.co2PartialPressureMmhg}</strong>mmHg</span>
                <span>SEU <strong className={consequences.seuBitFlipsCount > 3 ? 'text-rose-400' : 'text-amber-300'}>{consequences.seuBitFlipsCount}</strong></span>
              </div>

              {consequences.activeFailureModes.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1.5 mt-1.5 border-t border-slate-900">
                  {consequences.activeFailureModes.map((fm) => (
                    <span
                      key={fm}
                      className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-rose-950/90 border border-rose-500/60 text-rose-300"
                    >
                      ⚠ {fm.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* CONTROLLABLE MARS HARDWARE SETTINGS */}
            <div className="bg-slate-950/92 border border-cyan-500/40 rounded-lg p-2.5 text-[11px] font-mono space-y-2">
              <div className="flex items-center justify-between border-b border-cyan-500/20 pb-1">
                <span className="text-cyan-300 font-bold uppercase flex items-center gap-1">
                  <SlidersHorizontal className="w-3 h-3" /> Mars Equipment Control
                </span>
              </div>

              {/* Rover vs EVA Walk Toggle */}
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={() => {
                    playChirpSound();
                    onUpdateEquipment({ locomotionMode: 'rover' });
                  }}
                  className={`py-1 px-2 rounded flex items-center justify-center gap-1 text-[10px] font-bold transition-colors ${
                    equipment.locomotionMode === 'rover'
                      ? 'bg-cyan-500 text-slate-950'
                      : 'bg-slate-900 text-slate-400 border border-slate-800'
                  }`}
                >
                  <Truck className="w-3 h-3" />
                  <span>Rover</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    playChirpSound();
                    onUpdateEquipment({ locomotionMode: 'eva_walk' });
                  }}
                  className={`py-1 px-2 rounded flex items-center justify-center gap-1 text-[10px] font-bold transition-colors ${
                    equipment.locomotionMode === 'eva_walk'
                      ? 'bg-cyan-500 text-slate-950'
                      : 'bg-slate-900 text-slate-400 border border-slate-800'
                  }`}
                >
                  <Footprints className="w-3 h-3" />
                  <span>EVA (0.38g)</span>
                </button>
              </div>

              {/* Speed & Torque Slider */}
              <div className="space-y-0.5">
                <div className="flex justify-between text-[10px]">
                  <span className="text-slate-400 flex items-center gap-1">
                    <Gauge className="w-3 h-3 text-cyan-400" /> Speed / Torque:
                  </span>
                  <span className="text-cyan-300 font-bold">{equipment.speedTorqueSetting.toFixed(1)}x</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="2.5"
                  step="0.25"
                  value={equipment.speedTorqueSetting}
                  onChange={(e) => onUpdateEquipment({ speedTorqueSetting: parseFloat(e.target.value) })}
                  className="w-full accent-cyan-400 cursor-pointer h-1.5"
                />
              </div>

              {/* O2 Flow Modulation */}
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 block">O2 Flow Modulation:</span>
                <div className="grid grid-cols-3 gap-1">
                  {(['conserve', 'nominal', 'high_flow'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        playChirpSound();
                        onUpdateEquipment({ oxygenFlowMode: m });
                      }}
                      className={`py-0.5 rounded text-[9px] font-bold uppercase transition-colors ${
                        equipment.oxygenFlowMode === m
                          ? 'bg-cyan-500/30 text-cyan-200 border border-cyan-400'
                          : 'bg-slate-900 text-slate-400 border border-slate-800'
                      }`}
                    >
                      {m === 'high_flow' ? 'High' : m}
                    </button>
                  ))}
                </div>
              </div>

              {/* Headlights, Sensors, Solar Panels */}
              <div className="grid grid-cols-2 gap-1 pt-0.5">
                <button
                  type="button"
                  onClick={() => {
                    playChirpSound();
                    onUpdateEquipment({ headlightsEnabled: !equipment.headlightsEnabled });
                  }}
                  className={`py-1 px-1.5 rounded text-[10px] font-bold flex items-center justify-center gap-1 border transition-colors ${
                    equipment.headlightsEnabled
                      ? 'bg-amber-500/25 text-amber-200 border-amber-400/60'
                      : 'bg-slate-900 text-slate-400 border-slate-800'
                  }`}
                >
                  <Lightbulb className="w-3 h-3" />
                  <span>Lights {equipment.headlightsEnabled ? 'ON' : 'OFF'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    playChirpSound();
                    onUpdateEquipment({ solarPanelsDeployed: !equipment.solarPanelsDeployed });
                  }}
                  className={`py-1 px-1.5 rounded text-[10px] font-bold flex items-center justify-center gap-1 border transition-colors ${
                    isWindShearRisk
                      ? 'bg-rose-600/90 text-white border-rose-400'
                      : equipment.solarPanelsDeployed
                        ? 'bg-emerald-500/25 text-emerald-200 border-emerald-400/60'
                        : 'bg-slate-900 text-slate-400 border-slate-800'
                  }`}
                >
                  <Sun className="w-3 h-3" />
                  <span>{isWindShearRisk ? 'SHEAR! STOW' : `Solar ${equipment.solarPanelsDeployed ? 'OUT' : 'STOW'}`}</span>
                </button>
              </div>

              {/* Science Sensors Toggle + Solar Event Escalator */}
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={() => {
                    playChirpSound();
                    onUpdateEquipment({ sensorArrayEnabled: !equipment.sensorArrayEnabled });
                  }}
                  className={`py-1 px-1.5 rounded text-[10px] font-bold flex items-center justify-center gap-1 border transition-colors ${
                    equipment.sensorArrayEnabled
                      ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400/50'
                      : 'bg-slate-900 text-slate-400 border-slate-800'
                  }`}
                  title="Power down science sensors during extreme CME storms to reduce SEU upsets"
                >
                  <span>Sensors {equipment.sensorArrayEnabled ? 'ON' : 'SAFE'}</span>
                </button>
                {onTriggerSolarEvent && (
                  <button
                    type="button"
                    onClick={() => onTriggerSolarEvent()}
                    className={`py-1 px-1.5 rounded text-[10px] font-bold flex items-center justify-center gap-1 border transition-colors ${
                      isExtremeSpe
                        ? 'bg-rose-600 text-white border-rose-300'
                        : isSpeVisualActive
                          ? 'bg-amber-500/30 text-amber-200 border-amber-400'
                          : 'bg-slate-900 text-amber-300 border-amber-500/40'
                    }`}
                    title="Trigger or escalate Mars Solar Particle Event (SPE / CME)"
                  >
                    <Radiation className="w-3 h-3" />
                    <span>{isExtremeSpe ? 'X-CME!' : isSpeVisualActive ? 'SPE+' : 'Solar Storm'}</span>
                  </button>
                )}
              </div>

              {/* Autonomous AI Fallback Pilot */}
              <button
                type="button"
                onClick={() => {
                  playAckTone();
                  onUpdateEquipment({ autonomousAiPilot: !equipment.autonomousAiPilot });
                }}
                className={`w-full py-1.5 px-2 rounded text-[10px] font-bold flex items-center justify-center gap-1.5 border transition-colors ${
                  equipment.autonomousAiPilot
                    ? 'bg-cyan-500 text-slate-950 border-cyan-300 shadow-md shadow-cyan-500/30'
                    : 'bg-slate-900 text-cyan-300 border-cyan-500/40 hover:bg-cyan-950/60'
                }`}
              >
                <Cpu className="w-3.5 h-3.5" />
                <span>{equipment.autonomousAiPilot ? 'AI CO-PILOT: ACTIVE (AUTONAV)' : 'ENGAGE AI CO-PILOT FALLBACK'}</span>
              </button>

              {/* Autopilot to Location on Landmark Selection */}
              <label className="w-full py-1 px-2 rounded border border-slate-800 bg-slate-900/90 flex items-center justify-between text-[10px] text-slate-200 cursor-pointer">
                <span>Autopilot to Location</span>
                <input
                  type="checkbox"
                  checked={equipment.enableAutopilotTravel}
                  onChange={(e) => {
                    playChirpSound();
                    onUpdateEquipment({ enableAutopilotTravel: e.target.checked });
                  }}
                  className="accent-cyan-400 cursor-pointer"
                />
              </label>

              {(state.emergencyRtbActive || isEmergencyRtbEligible) && onEngageEmergencyRtb && (
                <button
                  type="button"
                  disabled={state.emergencyRtbActive}
                  onClick={onEngageEmergencyRtb}
                  className={`w-full py-1.5 px-2 rounded text-[10px] font-bold flex items-center justify-center gap-1.5 border transition-colors ${
                    state.emergencyRtbActive
                      ? 'bg-rose-950 text-rose-200 border-rose-500/80 cursor-default'
                      : 'bg-rose-600 hover:bg-rose-500 text-white border-rose-300 shadow-md shadow-rose-500/30'
                  }`}
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>
                    {state.emergencyRtbActive ? 'EMERGENCY RTB LOCKED → HAB-01' : 'ENGAGE EMERGENCY RTB'}
                  </span>
                </button>
              )}
            </div>

            {/* In VERBOSE Mode: Deep Subsystem Avionics Diagnostics */}
            {hudMode === 'verbose' && (
              <div className="bg-slate-950/92 border border-cyan-500/40 rounded-lg p-2.5 text-[10px] font-mono space-y-1">
                <div className="text-cyan-300 font-bold uppercase border-b border-cyan-500/20 pb-1">
                  PLSS & Surface Telemetry
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Terrain Roughness:</span>
                  <span className="text-cyan-300 font-bold">{topography.terrainRoughnessRmsMeters}m RMS</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Surface Geology:</span>
                  <span className="text-amber-300 font-bold">{topography.dominantGeology}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">CO2 Scrubbing:</span>
                  <span className="text-emerald-400 font-bold">99.4% (LiOH)</span>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* MINIMALIST MODE: Core 4 telemetry metrics (Battery, O2 Flow, Thermal, Regolith Slip) + Autopilot quick toggle */
          <div className="bg-slate-950/92 border border-cyan-500/35 rounded-lg p-2.5 text-xs font-mono pointer-events-auto space-y-1.5 tabular-nums">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
              <div>
                <span className="text-slate-400">BAT </span>
                <strong className={vitals.batteryPercentage < 25 ? 'text-rose-400' : 'text-amber-300'}>
                  {vitals.batteryPercentage.toFixed(0)}%
                </strong>
                <span className="text-slate-500"> ({vitals.batteryReserveHours}h)</span>
              </div>
              <div>
                <span className="text-slate-400">O2 FLOW </span>
                <strong className="text-cyan-300">{vitals.oxygenFlowRateLpm.toFixed(2)}</strong>
                <span className="text-slate-500"> L/m</span>
              </div>
              <div>
                <span className="text-slate-400">THERMAL </span>
                <strong className={vitals.suitThermalLoopStatus === 'NOMINAL' ? 'text-emerald-400' : 'text-amber-300'}>
                  {vitals.suitThermalLoopStatus}
                </strong>
              </div>
              <div>
                <span className="text-slate-400">SLIP </span>
                <strong className={topography.slipHazardRisk === 'SEVERE' ? 'text-rose-400' : topography.slipHazardRisk === 'MODERATE' ? 'text-amber-300' : 'text-emerald-400'}>
                  {topography.slipHazardRisk}
                </strong>
                <span className="text-slate-500"> ({consequences.wheelSlipPercent}%)</span>
              </div>
            </div>
            <div className="flex items-center justify-between pt-1 border-t border-slate-800 text-[10px]">
              <button
                type="button"
                onClick={() => {
                  playAckTone();
                  onUpdateEquipment({ autonomousAiPilot: !equipment.autonomousAiPilot });
                }}
                className={`px-1.5 py-0.5 rounded border font-bold ${
                  equipment.autonomousAiPilot
                    ? 'bg-cyan-500 text-slate-950 border-cyan-300'
                    : 'bg-slate-900 text-cyan-300 border-cyan-500/40'
                }`}
              >
                {equipment.autonomousAiPilot ? 'AI PILOT: ON' : 'AI PILOT'}
              </button>
              <span className="text-slate-400">
                O2 {vitals.oxygenPercentage.toFixed(0)}%
              </span>
            </div>
          </div>
        )}

        {/* CENTER VIEWPORT: Reticle & Waypoint Guidance (shifts horizontally with relative azimuth) */}
        <div 
          ref={reticleWrapRef}
          className="relative flex flex-col items-center justify-center pointer-events-auto will-change-transform"
          style={liveVehicleRef ? undefined : { transform: `translate3d(${reticlePixelOffset}px, 0px, 0)` }}
        >
          {/* Artificial Horizon Pitch Ladder */}
          {showHorizon && hudMode !== 'minimalist' && (
            <div className="absolute pointer-events-none opacity-40 flex flex-col items-center gap-6">
              <div className="flex items-center gap-8 text-[10px] font-mono text-cyan-400">
                <div className="w-12 h-[1px] bg-cyan-400" />
                <span>+10°</span>
                <div className="w-12 h-[1px] bg-cyan-400" />
              </div>
              <div className="flex items-center gap-12 text-[10px] font-mono text-cyan-400">
                <div className="w-16 h-[2px] bg-cyan-300" />
                <span>0° HORIZON</span>
                <div className="w-16 h-[2px] bg-cyan-300" />
              </div>
              <div className="flex items-center gap-8 text-[10px] font-mono text-cyan-400">
                <div className="w-12 h-[1px] bg-cyan-400" />
                <span>-10°</span>
                <div className="w-12 h-[1px] bg-cyan-400" />
              </div>
            </div>
          )}

          {/* Out-of-FOV Turn Indicators if Waypoint is far to the side */}
          {!isTargetInFov && (
            <div className="absolute -top-10 px-3 py-1 rounded bg-amber-950/90 border border-amber-500/80 text-amber-300 font-mono text-xs flex items-center gap-1.5 animate-bounce shadow-lg">
              {relativeAzimuth < 0 ? <ArrowLeftCircle className="w-4 h-4" /> : null}
              <span>TURN {relativeAzimuth < 0 ? 'LEFT' : 'RIGHT'} ({Math.abs(Math.round(relativeAzimuth))}°) TO REACQUIRE</span>
              {relativeAzimuth > 0 ? <ArrowRightCircle className="w-4 h-4" /> : null}
            </div>
          )}

          {/* TARGETING RETICLE */}
          <div 
            onClick={handleReticleClick}
            className="group relative cursor-pointer p-4 flex flex-col items-center"
            title="Click to toggle waypoint guidance lock"
          >
            {/* Outer Target Circle */}
            <div className={`rounded-full border border-dashed transition-all duration-300 flex items-center justify-center ${
              hudMode === 'minimalist' ? 'w-20 h-20' : 'w-26 h-26 sm:w-28 sm:h-28'
            } ${
              reticleLocked 
                ? 'border-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.4)] animate-spin-slow' 
                : 'border-slate-600'
            }`}>
              {/* Inner Crosshair Ring */}
              <div className={`rounded-full border border-cyan-400/60 flex items-center justify-center ${
                hudMode === 'minimalist' ? 'w-10 h-10' : 'w-14 h-14'
              }`}>
                <Crosshair className={`transition-colors ${
                  hudMode === 'minimalist' ? 'w-4 h-4' : 'w-5 h-5 sm:w-6 sm:h-6'
                } ${reticleLocked ? 'text-amber-400' : 'text-slate-500'}`} />
              </div>
            </div>

            {/* Crosshair Cardinal Lines */}
            <div className={`absolute h-[1px] bg-cyan-400/50 pointer-events-none ${
              hudMode === 'minimalist' ? 'w-28' : 'w-36'
            }`} />
            <div className={`absolute w-[1px] bg-cyan-400/50 pointer-events-none ${
              hudMode === 'minimalist' ? 'h-28' : 'h-36'
            }`} />

            {/* Target Waypoint Readout Tag */}
            <div className="mt-2.5 bg-slate-950/92 border border-amber-500/60 rounded px-2.5 py-1 text-center shadow-lg">
              <div className="text-[11px] font-display font-bold text-amber-300 tracking-wide">
                {displayNav.targetWaypointId}: {displayNav.targetName}
              </div>
              {displayNav.distanceMeters <= 25 && (
                <div className="mt-1 px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/60 text-emerald-300 text-[10px] font-mono font-bold tracking-wider uppercase">
                  ✓ DESTINATION REACHED
                </div>
              )}
              <div className="flex items-center justify-center gap-1.5 text-xs font-mono text-cyan-300 tabular-nums">
                <span className="font-bold">
                  {displayNav.distanceMeters >= 1000
                    ? `${(displayNav.distanceMeters / 1000).toFixed(1)} km`
                    : `${displayNav.distanceMeters} m`}
                </span>
                <span className="text-slate-500">·</span>
                <span>BRG {displayNav.bearingDegrees}°</span>
                <span className="text-slate-500">·</span>
                <span className="text-amber-300">ETA {displayNav.etaMinutes}m</span>
              </div>

              {/* In Verbose Mode: Extra closure and azimuth tracking details */}
              {hudMode === 'verbose' && (
                <div className="text-[10px] font-mono text-slate-400 border-t border-slate-800 mt-1 pt-0.5 flex justify-between gap-2 tabular-nums">
                  <span>REL AZ: {relativeAzimuth > 0 ? `+${Math.round(relativeAzimuth)}°` : `${Math.round(relativeAzimuth)}°`}</span>
                  <span>ΔZ: {displayNav.relativeElevationDeltaMeters >= 0 ? '+' : ''}{displayNav.relativeElevationDeltaMeters}m</span>
                  <span>LOS: OK</span>
                </div>
              )}

              {/* Inspect Real NASA Photos for Target */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  playAckTone();
                  setSelectedPhotoWaypointId(navigation.targetWaypointId);
                }}
                className="mt-1.5 w-full text-[10px] font-mono py-0.5 px-2 rounded bg-cyan-950/80 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-900/90 transition-colors flex items-center justify-center gap-1.5"
                title="Inspect authentic NASA Mars 2020 raw telemetry photos"
              >
                <Camera className="w-3 h-3 text-cyan-400" />
                <span>NASA Downlink Photos</span>
              </button>
            </div>

            {/* Lock status hint */}
            <span className="text-[9px] font-mono text-slate-500 uppercase mt-0.5 group-hover:text-cyan-400 transition-colors">
              {reticleLocked ? "LOCK: ACTIVE" : "ACQUIRE LOCK"}
            </span>
          </div>
        </div>

        {/* RIGHT HUD WING: Environmental & Dynamic Corner Mini-Map */}
        <div className="flex flex-col gap-3 items-end pointer-events-auto">
          
          {/* Environmental Telemetry (Standard & Verbose) */}
          {hudMode !== 'minimalist' ? (
            <div className="w-64 lg:w-72 flex flex-col gap-2">
              <div className="bg-slate-950/92 border border-cyan-500/35 rounded-lg p-2.5">
                <div className="flex items-center justify-between border-b border-cyan-500/20 pb-1 mb-2">
                  <span className="text-xs font-display font-semibold tracking-wider text-cyan-300 uppercase">
                    Active Environment State
                  </span>
                  <Thermometer className="w-3.5 h-3.5 text-cyan-400" />
                </div>

                {/* Regional Profile, Elevation & Surface Type */}
                <div className="mb-1.5 pb-1.5 border-b border-slate-900 space-y-0.5">
                  <div className="flex justify-between items-baseline gap-2 text-[11px]">
                    <span className="font-bold text-cyan-300 truncate" title={state.activeEnvironment.regionName}>
                      {state.activeEnvironment.regionName}
                    </span>
                    <span className="font-mono font-bold text-amber-300 shrink-0 tabular-nums">
                      {state.activeEnvironment.elevationMeters >= 0 ? '+' : ''}
                      {state.activeEnvironment.elevationMeters.toLocaleString()}m
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-300 leading-snug">
                    <span className="text-slate-500 font-mono">Surface: </span>
                    {state.activeEnvironment.surfaceType}
                  </div>
                  <div className="text-[10px] text-amber-200/90 leading-snug">
                    <span className="text-slate-500 font-mono">Weather: </span>
                    {state.activeEnvironment.activeWeather}
                  </div>
                  {state.activeEnvironment.navigationBoundaryNote && (
                    <div className="text-[9px] font-mono text-amber-300 bg-amber-950/60 border border-amber-500/40 rounded px-1.5 py-1 mt-1 leading-snug">
                      {state.activeEnvironment.navigationBoundaryNote}
                    </div>
                  )}
                </div>

                {/* Ambient Temp */}
                <div className="mb-1.5">
                  <div className="flex justify-between text-xs mb-0.5">
                    <span className="text-slate-400">Ambient Air Temp</span>
                    <span className="font-mono font-bold text-cyan-300 tabular-nums">
                      {environmental.ambientTempCelsius.toFixed(1)} °C
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-slate-400 tabular-nums">
                    <span>Surface: {environmental.surfaceTempCelsius.toFixed(1)} °C</span>
                    <span className="text-amber-400">{atmospheric.thermalTrendCelsiusPerHour} °C/hr</span>
                  </div>
                </div>

                {/* Pressure & Visibility (MEDA Pa) */}
                <div className="mb-1.5 pt-1.5 border-t border-slate-900">
                  <div className="flex justify-between text-xs mb-0.5">
                    <span className="text-slate-400">Pressure / Vis</span>
                    <span className="font-mono font-bold text-slate-200 tabular-nums">
                      {environmental.atmosphericPressurePa} Pa
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-slate-400 tabular-nums gap-2">
                    <span>{environmental.atmosphericPressureMbar.toFixed(2)} mbar</span>
                    <span className="text-cyan-300 truncate" title={state.activeEnvironment.visibilityLabel}>
                      {state.activeEnvironment.visibilityLabel}
                    </span>
                  </div>
                </div>

                {/* Radiation Sieverts (RAD Detector) */}
                <div className="mb-1.5 pt-1.5 border-t border-slate-900">
                  <div className="flex justify-between text-xs mb-0.5">
                    <span className="text-slate-400">Surface Radiation</span>
                    <span className={`font-mono font-bold tabular-nums ${
                      environmental.radiationDoseRateMicroSvHr > 25 ? 'text-rose-400' : 'text-cyan-300'
                    }`}>
                      {environmental.radiationDoseRateMicroSvHr.toFixed(1)} µSv/h
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-slate-400 tabular-nums">
                    <span className="flex items-center gap-1 text-rose-300">
                      <Radiation className="w-3 h-3 text-rose-400" />
                      {environmental.speIntensityLevel}
                    </span>
                    <span className="text-amber-300">{environmental.cumulativeEvaDoseMilliSv} mSv</span>
                  </div>
                </div>

                {/* Wind Speeds & Dust Opacity */}
                <div className="pt-1.5 border-t border-slate-900">
                  <div className="flex justify-between text-xs mb-0.5">
                    <span className="text-slate-400">Wind &amp; Dust (MEDA)</span>
                    <span className="font-mono font-bold text-cyan-300 tabular-nums">
                      {atmospheric.windSpeedMps} m/s (G {atmospheric.windGustMps})
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-slate-400 tabular-nums">
                    <span>Tau: <strong className={atmospheric.dustOpacityTau > 0.5 ? 'text-rose-400' : 'text-slate-200'}>{atmospheric.dustOpacityTau}</strong></span>
                    <span>Slope: <strong className={topography.slopePercentage > 15 ? 'text-rose-400' : 'text-emerald-400'}>{topography.slopePercentage}%</strong></span>
                  </div>
                </div>

                {/* Polar / Seasonal CO2 Dry-Ice Frost Cycle Toggle */}
                {onTogglePolarFrostMode && (
                  <div className="pt-1.5 mt-1.5 border-t border-slate-900">
                    <button
                      type="button"
                      onClick={() => onTogglePolarFrostMode()}
                      className={`w-full py-1 px-2 rounded border font-mono text-[10px] font-bold flex items-center justify-between transition-colors ${
                        state.activeEnvironment.profileGroup === 'POLAR_ICE_CAP'
                          ? 'bg-sky-500/25 border-sky-400 text-sky-200'
                          : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-cyan-500/50'
                      }`}
                      title="Toggle seasonal CO2 dry-ice frost deposition vs sublimation"
                    >
                      <span>CO₂ FROST CYCLE</span>
                      <span className="text-cyan-300">{state.activeEnvironment.seasonalCo2FrostMode}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* MINIMALIST MODE: Sleek compact environmental + target ETA chip */
            <div className="bg-slate-950/92 border border-cyan-500/35 rounded-lg p-2 text-xs font-mono tabular-nums">
              <div className="flex flex-col gap-1 text-[10px]">
                <div className="flex items-center justify-between gap-2 text-cyan-300 font-bold">
                  <span className="truncate max-w-[140px]">{state.activeEnvironment.regionName}</span>
                  <span className="text-amber-300">
                    {state.activeEnvironment.elevationMeters >= 0 ? '+' : ''}
                    {state.activeEnvironment.elevationMeters.toLocaleString()}m
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">AIR</span>
                  <strong className="text-cyan-300">{environmental.ambientTempCelsius.toFixed(1)}°C</strong>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-400">PRS</span>
                  <strong className="text-cyan-300">{environmental.atmosphericPressurePa}Pa</strong>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className={environmental.radiationDoseRateMicroSvHr > 25 ? 'text-rose-300 font-bold' : 'text-slate-300'}>
                    RAD {environmental.radiationDoseRateMicroSvHr.toFixed(1)} µSv/h
                  </span>
                  <span className="text-amber-300 font-bold">
                    ETA {displayNav.etaMinutes}m
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* TACTICAL MULTI-SPECTRAL HUGE MARS MAP (Rendered in Corner with Arrow Movement) */}
          {showMiniMap && (
            <div className="mt-1">
              <TacticalMarsMap
                astronautX={effectiveAstroPos.x}
                astronautY={effectiveAstroPos.y}
                heading={astronautPos.heading}
                liveVehicleRef={liveVehicleRef}
                targetX={effectiveTargetPos.x}
                targetY={effectiveTargetPos.y}
                targetName={displayNav.targetName}
                distanceToTarget={displayNav.distanceMeters}
                bearingToTarget={displayNav.bearingDegrees}
                etaMinutes={displayNav.etaMinutes}
                speedTorqueSetting={equipment.speedTorqueSetting}
                locomotionMode={equipment.locomotionMode}
                breadcrumbPath={astronautPos.path}
                showGuidanceTrail={showTrail}
                customWaypoints={customMarkersMeters}
                astronautLatLng={currentAstroLatLng}
                targetLatLng={targetLatLng}
                activeTargetId={navigation.targetWaypointId}
                enableAutopilotTravel={equipment.enableAutopilotTravel}
                onToggleAutopilotTravel={(enabled) => onUpdateEquipment({ enableAutopilotTravel: enabled })}
                onMove={onMoveAstronaut}
                onDriveInput={onDriveInput}
                onResetPosition={onResetPosition}
                onSelectWaypoint={onSetNavTarget}
                isFullScreen={false}
                onToggleFullScreen={() => setIsMapEnlarged(true)}
                discoveredFeatureIds={discoveredFeatureIds}
              />
            </div>
          )}

        </div>

      </div>

      {/* BOTTOM HUD STATUS RIBBON & VIEWPORT TOGGLES */}
      <div className="relative z-10 w-full flex flex-wrap items-center justify-between gap-2 bg-slate-950/92 border border-slate-800 rounded-lg p-2 text-xs font-mono text-slate-400">
        <div className="flex items-center gap-3">
          <span className="text-cyan-400 font-semibold">
            {equipment.locomotionMode === 'rover' ? 'ROVER ACTIVE' : 'EVA-02 WALK'}
          </span>
          <span className="hidden sm:inline">TRACTION: {(topography.surfaceTrafficabilityIndex * 100).toFixed(0)}%</span>
          <span className="hidden md:inline">ETA: {displayNav.etaMinutes} MIN</span>
          <span
            className={`px-2 py-0.5 rounded font-bold text-[10px] border ${
              showTrail
                ? 'bg-cyan-950 border-cyan-500/50 text-[#52e0ff]'
                : 'bg-slate-900 border-slate-700 text-slate-400'
            }`}
          >
            {showTrail ? 'GUIDANCE TRAIL ACTIVE' : 'TRAIL STANDBY'}
          </span>
          {onInjectWorstCase && (
            <button
              type="button"
              onClick={onInjectWorstCase}
              className="px-2 py-0.5 rounded bg-rose-950/90 border border-rose-500/60 text-rose-300 hover:bg-rose-900 font-bold text-[10px] transition-colors"
            >
              INJECT FAILURE
            </button>
          )}
        </div>

        {/* Quick HUD toggles */}
        <div className="flex items-center gap-2">
          {/* NASA Mars Rover Photos Button */}
          <button
            type="button"
            onClick={() => {
              playChirpSound();
              setSelectedPhotoWaypointId(navigation.targetWaypointId);
            }}
            className="px-2 py-0.5 rounded text-[11px] bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-500/30 transition-colors flex items-center gap-1"
            title="Open NASA Mars 2020 raw telemetry images"
          >
            <Camera className="w-3 h-3 text-cyan-400" />
            <span>NASA PHOTOS</span>
          </button>

          {/* 3D Mars Spectral View Selector (Real Mars / Thermal IR / Topo DTM) */}
          <div className="flex items-center gap-1 bg-slate-900/90 rounded border border-slate-800 p-0.5">
            <span className="text-[10px] text-slate-400 px-1 hidden md:inline">3D MARS:</span>
            <button
              type="button"
              onClick={() => { playChirpSound(); setSpectralMode('optical'); }}
              className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                spectralMode === 'optical' ? 'bg-cyan-500/30 text-cyan-200 border border-cyan-400/50' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Real Mars
            </button>
            <button
              type="button"
              onClick={() => { playChirpSound(); setSpectralMode('thermal'); }}
              className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                spectralMode === 'thermal' ? 'bg-rose-500/30 text-rose-200 border border-rose-400/50' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Thermal IR
            </button>
            <button
              type="button"
              onClick={() => { playChirpSound(); setSpectralMode('topographic'); }}
              className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                spectralMode === 'topographic' ? 'bg-amber-500/30 text-amber-200 border border-amber-400/50' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Topo DTM
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowMiniMap(!showMiniMap)}
            className={`px-2 py-0.5 rounded text-[11px] transition-colors flex items-center gap-1 ${
              showMiniMap ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-slate-900 text-slate-400'
            }`}
          >
            <MapPin className="w-3 h-3" />
            <span>MAP {showMiniMap ? 'ON' : 'OFF'}</span>
          </button>

          {hudMode !== 'minimalist' && (
            <>
              <button
                type="button"
                onClick={() => setShowGrid(!showGrid)}
                className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                  showGrid ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-slate-900 text-slate-400'
                }`}
              >
                GRID
              </button>
              <button
                type="button"
                onClick={() => setShowHorizon(!showHorizon)}
                className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                  showHorizon ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-slate-900 text-slate-400'
                }`}
              >
                HORIZON
              </button>
              <span className="text-slate-700">|</span>
            </>
          )}
          <span className="text-slate-400 text-[11px]">NASA MEDA/HiRISE/RAD</span>
        </div>
      </div>

      {/* ENLARGED FULL-SCREEN HUGE TACTICAL MAP MODAL OVERLAY */}
      {isMapEnlarged && (
        <div className="absolute inset-3 z-50 bg-slate-950/95 border border-cyan-500/60 rounded-2xl shadow-2xl p-4 flex flex-col pointer-events-auto">
          <TacticalMarsMap
            astronautX={effectiveAstroPos.x}
            astronautY={effectiveAstroPos.y}
            heading={astronautPos.heading}
            liveVehicleRef={liveVehicleRef}
            targetX={effectiveTargetPos.x}
            targetY={effectiveTargetPos.y}
            targetName={displayNav.targetName}
            distanceToTarget={displayNav.distanceMeters}
            bearingToTarget={displayNav.bearingDegrees}
            etaMinutes={displayNav.etaMinutes}
            speedTorqueSetting={equipment.speedTorqueSetting}
            locomotionMode={equipment.locomotionMode}
            breadcrumbPath={astronautPos.path}
            showGuidanceTrail={showTrail}
            customWaypoints={customMarkersMeters}
            astronautLatLng={currentAstroLatLng}
            targetLatLng={targetLatLng}
            activeTargetId={navigation.targetWaypointId}
            enableAutopilotTravel={equipment.enableAutopilotTravel}
            onToggleAutopilotTravel={(enabled) => onUpdateEquipment({ enableAutopilotTravel: enabled })}
            onMove={onMoveAstronaut}
            onDriveInput={onDriveInput}
            onResetPosition={onResetPosition}
            onSelectWaypoint={(wpId, opts) => {
              if (onSetNavTarget) onSetNavTarget(wpId, opts);
            }}
            isFullScreen={true}
            onToggleFullScreen={() => setIsMapEnlarged(false)}
            discoveredFeatureIds={discoveredFeatureIds}
          />
        </div>
      )}

      {/* NASA ROVER PHOTOS MODAL OVERLAY */}
      {selectedPhotoWaypointId && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center font-mono text-xs text-cyan-300">
              LOADING TELEMETRY IMAGE ARCHIVE...
            </div>
          }
        >
          <RoverPhotoViewer
            selectedWaypointId={selectedPhotoWaypointId}
            onClose={() => setSelectedPhotoWaypointId(null)}
            onSetNavTarget={(wpId) => {
              if (onSetNavTarget) {
                onSetNavTarget(wpId);
              }
              setSelectedPhotoWaypointId(null);
            }}
          />
        </Suspense>
      )}

    </div>
  );
};

