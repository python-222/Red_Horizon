import React, { useMemo, useState } from 'react';
import { ExcursionState, EquipmentControlState, HudDisplayMode, SeasonalFrostMode } from '../types/telemetry';
import { PRESET_SCENARIOS, TRAINING_CHALLENGES } from '../data/nasaDatasets';
import {
  MARS_LANDFORMS,
  LANDFORM_CATEGORY_COLORS,
  VISOR_PROXIMITY_THRESHOLD_KM,
  LandmarkTier,
  TraversalDifficulty,
  formatAreographicCoords,
  marsDistanceKm,
} from '../data/marsTerrain';
import { resolveRegionalEnvironment } from '../data/marsClimateEngine';
import { Sliders, Satellite, Radio, Wind, AlertCircle, Trophy, Zap, MapPin, Cpu, Navigation, Snowflake, Terminal, Lock, Unlock } from 'lucide-react';
import { playChirpSound, playAckTone } from '../utils/audioAlerts';
import {
  DeveloperAuthModal,
  DeveloperCommandCenter,
  clearDevSessionUnlocked,
  readDevSessionUnlocked,
} from './DeveloperCommandCenter';

const DIFFICULTY_TEXT_CLASS: Record<TraversalDifficulty, string> = {
  LOW: 'text-emerald-300',
  MODERATE: 'text-cyan-300',
  HIGH: 'text-amber-300',
  EXTREME: 'text-rose-400',
};

const TIER_LABEL: Record<LandmarkTier, string> = {
  primary: 'Primary Landmark',
  regional: 'Regional Topography',
  surface: 'Surface & Weather',
};

interface NasaDatasetMatrixProps {
  state: ExcursionState;
  onUpdateState: (newState: ExcursionState) => void;
  onLoadScenario: (scenarioKey: keyof typeof PRESET_SCENARIOS) => void;
  currentScenarioKey: string;
  onStartChallenge?: (challengeId: string) => void;
  onInjectWorstCase?: () => void;
  onTriggerSolarEvent?: (level?: 'NONE' | 'ELEVATED_FLUX' | 'HIGH_FLUX_WARNING' | 'EXTREME_CME_STORM') => void;
  astronautLatLng?: { lat: number; lng: number };
  onSelectLandform?: (id: string, autopilot?: boolean) => void;
  onUpdateEquipment?: (patch: Partial<EquipmentControlState>) => void;
  onTogglePolarFrostMode?: (mode?: SeasonalFrostMode) => void;
  onEngageEmergencyRtb?: () => void;
  onHazardOverride?: () => void;
  onResetPosition?: () => void;
  onTeleportLocal?: (x: number, y: number, heading?: number) => void;
  onTeleportGlobal?: (lat: number, lng: number) => void;
  onDispatchTestNotification?: (tier: 'info' | 'warn' | 'danger' | 'emergency_ack') => void;
  hudMode?: HudDisplayMode;
  onSetHudMode?: (mode: HudDisplayMode) => void;
  onSwitchTab?: (tab: 'hud' | 'visor' | 'console' | 'sensors') => void;
  isMuted?: boolean;
  onToggleMute?: (muted: boolean) => void;
  globalOverrideActive?: boolean;
}

export const NasaDatasetMatrix: React.FC<NasaDatasetMatrixProps> = ({
  state,
  onUpdateState,
  onLoadScenario,
  currentScenarioKey,
  onStartChallenge,
  onInjectWorstCase,
  onTriggerSolarEvent,
  astronautLatLng = { lat: 18.44, lng: 77.45 },
  onSelectLandform,
  onUpdateEquipment,
  onTogglePolarFrostMode,
  onEngageEmergencyRtb,
  onHazardOverride,
  onResetPosition,
  onTeleportLocal,
  onTeleportGlobal,
  onDispatchTestNotification,
  hudMode = 'standard',
  onSetHudMode,
  onSwitchTab,
  isMuted = false,
  onToggleMute,
  globalOverrideActive = false,
}) => {
  const { environmental, atmospheric, topography, comms, equipment, activeChallenge, activeEnvironment } = state;
  const [landformTierFilter, setLandformTierFilter] = useState<'all' | LandmarkTier>('all');
  const [isDevUnlocked, setIsDevUnlocked] = useState<boolean>(() => readDevSessionUnlocked());
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [activeSubView, setActiveSubView] = useState<'datasets' | 'dev_console'>('datasets');

  const sortedLandforms = useMemo(() => {
    return MARS_LANDFORMS.filter((lf) =>
      landformTierFilter === 'all' ? true : lf.tier === landformTierFilter
    )
      .map((lf) => {
        const distanceKm = marsDistanceKm(astronautLatLng, { lat: lf.lat, lng: lf.lng });
        return {
          ...lf,
          distanceKm,
          inVisorRange: distanceKm <= VISOR_PROXIMITY_THRESHOLD_KM,
          categoryMeta: LANDFORM_CATEGORY_COLORS[lf.category],
        };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }, [astronautLatLng, landformTierFilter]);

  const handleWindChange = (newWind: number) => {
    const gust = Math.round(newWind * 1.55 * 10) / 10;
    const windShear = equipment.solarPanelsDeployed && gust > 13.5;
    const isHazard =
      gust > 12.0 ||
      atmospheric.dustOpacityTau > 0.5 ||
      topography.slopePercentage > 15 ||
      environmental.radiationDoseRateMicroSvHr > 35;

    onUpdateState({
      ...state,
      atmospheric: {
        ...state.atmospheric,
        windSpeedMps: newWind,
        windGustMps: gust,
      },
      hazardAlert: {
        ...state.hazardAlert,
        active: isHazard,
        severity: windShear || gust > 16 || environmental.radiationDoseRateMicroSvHr > 40 ? 'CRITICAL_HAZARD' : isHazard ? 'CAUTION' : 'NOMINAL',
        title: windShear ? 'SOLAR WING WIND SHEAR DAMAGE' : gust > 12 ? `HIGH WIND GUSTS (${gust} m/s)` : state.hazardAlert.title,
      },
      lastSettingChange: {
        id: Date.now(),
        title: `MEDA WIND: ${newWind.toFixed(1)} m/s (GUST ${gust.toFixed(1)} m/s)`,
        detail: windShear
          ? 'DANGER: Wind shear damaging deployed solar wings! Retract immediately.'
          : gust > 12
            ? 'Exceeds 12.0 m/s EVA wind gust limit; saltating dust accelerating.'
            : 'Wind within nominal Mars boundary-layer limits.',
        severity: windShear ? 'danger' : gust > 12 ? 'warn' : 'info',
        timestamp: Date.now(),
      },
    });
  };

  const handleTauChange = (newTau: number) => {
    const isHazard =
      atmospheric.windGustMps > 12.0 ||
      newTau > 0.5 ||
      topography.slopePercentage > 15 ||
      environmental.radiationDoseRateMicroSvHr > 35;
    const transmissionPct = Math.round(Math.max(4, Math.exp(-newTau * 0.85) * 100));
    const stormStatus =
      newTau >= 1.5
        ? 'GLOBAL_DUST_STORM'
        : newTau > 0.6
          ? 'REGIONAL_DUST_DEVIL_FRONT'
          : newTau > 0.4
            ? 'ELEVATED_HAZE'
            : 'CLEAR';

    onUpdateState({
      ...state,
      atmospheric: {
        ...state.atmospheric,
        dustOpacityTau: newTau,
        dustStormStatus: stormStatus,
      },
      hazardAlert: {
        ...state.hazardAlert,
        active: isHazard,
        severity: newTau >= 1.2 || environmental.radiationDoseRateMicroSvHr > 40 ? 'CRITICAL_HAZARD' : isHazard ? 'CAUTION' : 'NOMINAL',
        title: newTau >= 1.5 ? `GLOBAL DUST STORM (TAU ${newTau.toFixed(2)})` : newTau > 0.8 ? `REGIONAL DUST STORM (TAU ${newTau.toFixed(2)})` : state.hazardAlert.title,
      },
      lastSettingChange: {
        id: Date.now(),
        title: `DUST OPACITY: ${newTau.toFixed(2)} τ (${stormStatus.replace(/_/g, ' ')})`,
        detail: `Solar irradiance transmission dropped to ${transmissionPct}%; ${newTau > 0.8 ? 'rapid dust coating on deployed panels!' : 'moderate atmospheric scattering.'}`,
        severity: newTau >= 1.2 ? 'danger' : newTau > 0.5 ? 'warn' : 'info',
        timestamp: Date.now(),
      },
    });
  };

  const handleSlopeChange = (newSlope: number) => {
    const isHazard =
      atmospheric.windGustMps > 12.0 ||
      atmospheric.dustOpacityTau > 0.5 ||
      newSlope > 15 ||
      environmental.radiationDoseRateMicroSvHr > 35;
    const angle = Math.round(Math.atan(newSlope / 100) * (180 / Math.PI) * 10) / 10;
    onUpdateState({
      ...state,
      topography: {
        ...state.topography,
        slopePercentage: newSlope,
        slopeAngleDegrees: angle,
        slipHazardRisk: newSlope > 15 ? 'SEVERE' : newSlope > 10 ? 'MODERATE' : 'LOW',
        surfaceTrafficabilityIndex: Math.max(0.2, 0.95 - newSlope * 0.025),
      },
      hazardAlert: {
        ...state.hazardAlert,
        active: isHazard,
        severity: newSlope > 20 || environmental.radiationDoseRateMicroSvHr > 40 ? 'CRITICAL_HAZARD' : isHazard ? 'CAUTION' : 'NOMINAL',
      },
      lastSettingChange: {
        id: Date.now(),
        title: `SLOPE INCLINE: ${newSlope}% (${angle}°)`,
        detail: newSlope > 15 ? 'Severe wheel slip & rocker-bogie over-torque risk on loose regolith.' : 'Traversable slope within wheel traction envelope.',
        severity: newSlope > 18 ? 'danger' : newSlope > 15 ? 'warn' : 'info',
        timestamp: Date.now(),
      },
    });
  };

  const handleRadiationChange = (newRad: number) => {
    const speActive = newRad > 20.0;
    const speLevel =
      newRad >= 100
        ? 'EXTREME_CME_STORM'
        : newRad > 40
          ? 'HIGH_FLUX_WARNING'
          : speActive
            ? 'ELEVATED_FLUX'
            : 'NONE';
    const isHazard =
      newRad > 35 ||
      atmospheric.windGustMps > 12.0 ||
      atmospheric.dustOpacityTau > 0.5 ||
      topography.slopePercentage > 15;
    const signalPct = newRad >= 120 ? 24 : newRad >= 60 ? 52 : speActive ? 76 : 90;

    onUpdateState({
      ...state,
      environmental: {
        ...state.environmental,
        radiationDoseRateMicroSvHr: newRad,
        solarParticleEventActive: speActive,
        speIntensityLevel: speLevel,
      },
      comms: {
        ...state.comms,
        signalStrengthPercent: state.comms.commBlackoutActive ? 0 : signalPct,
      },
      hazardAlert: {
        ...state.hazardAlert,
        active: isHazard,
        severity: newRad > 40 ? 'CRITICAL_HAZARD' : isHazard ? 'CAUTION' : 'NOMINAL',
        title:
          newRad >= 100
            ? `EXTREME CME SOLAR STORM (${newRad} µSv/h)`
            : newRad > 40
              ? `SPE RADIATION ALERT (${newRad} µSv/h)`
              : state.hazardAlert.title,
      },
      lastSettingChange: {
        id: Date.now(),
        title: `RAD PROTON FLUX: ${newRad} µSv/h (${speLevel.replace(/_/g, ' ')})`,
        detail:
          newRad >= 100
            ? 'DANGER: Frequent RAM SEU bit-flips, MastCam static, UHF fade & electronics degradation!'
            : newRad > 40
              ? 'High proton flux causing SEU upsets & UHF attenuation; seek HAB-01 shelter.'
              : 'Within nominal GCR / mild solar wind baseline.',
        severity: newRad >= 100 ? 'danger' : newRad > 40 ? 'warn' : 'info',
        timestamp: Date.now(),
      },
    });
  };

  const handleLockDevSession = () => {
    clearDevSessionUnlocked();
    setIsDevUnlocked(false);
    setActiveSubView('datasets');
  };

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-6 space-y-6">
      <DeveloperAuthModal
        open={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onAuthenticated={() => {
          setIsDevUnlocked(true);
          setIsAuthModalOpen(false);
          setActiveSubView('dev_console');
        }}
      />

      {/* NASA Datasets Command & Developer Audit Gate Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/95 px-4 py-3 shadow-lg">
        <div className="flex items-center gap-3">
          <Satellite className="w-5 h-5 text-cyan-400 shrink-0" />
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-cyan-400">
              NASA MARS 2020 // TELEMETRY &amp; DIAGNOSTICS
            </div>
            <h1 className="font-display text-sm font-bold text-slate-100">
              NASA Datasets &amp; Engineering Matrix
            </h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          {isDevUnlocked ? (
            <>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-900 border border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    playChirpSound();
                    setActiveSubView('datasets');
                  }}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    activeSubView === 'datasets'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  NASA Datasets
                </button>
                <button
                  type="button"
                  onClick={() => {
                    playChirpSound();
                    setActiveSubView('dev_console');
                  }}
                  className={`px-3 py-1 rounded-md flex items-center gap-1.5 transition-colors ${
                    activeSubView === 'dev_console'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Terminal className="w-3.5 h-3.5" />
                  <span>Developer Command Center</span>
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  playChirpSound();
                  handleLockDevSession();
                }}
                title="Lock Developer Command Center and clear sessionStorage clearance"
                className="px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:border-rose-500/50 text-slate-300 hover:text-rose-200 text-[11px] flex items-center gap-1.5 transition-colors"
              >
                <Unlock className="w-3.5 h-3.5 text-emerald-400" />
                <span>Lock</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                playChirpSound();
                setIsAuthModalOpen(true);
              }}
              className="px-3.5 py-1.5 rounded-lg border border-amber-500/50 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 font-bold flex items-center gap-2 transition-colors shadow-sm"
            >
              <Lock className="w-3.5 h-3.5 text-amber-400" />
              <span>Developer Command Center</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-950/80 border border-amber-500/40 text-amber-300">
                AUTH
              </span>
            </button>
          )}
        </div>
      </div>

      {isDevUnlocked && activeSubView === 'dev_console' ? (
        <DeveloperCommandCenter
          state={state}
          onUpdateState={onUpdateState}
          onUpdateEquipment={onUpdateEquipment}
          onTogglePolarFrostMode={onTogglePolarFrostMode}
          onTriggerSolarEvent={onTriggerSolarEvent}
          onInjectWorstCase={onInjectWorstCase}
          onEngageEmergencyRtb={onEngageEmergencyRtb}
          onHazardOverride={onHazardOverride}
          onResetPosition={onResetPosition}
          onTeleportLocal={onTeleportLocal}
          onTeleportGlobal={onTeleportGlobal}
          onDispatchTestNotification={onDispatchTestNotification}
          hudMode={hudMode}
          onSetHudMode={onSetHudMode}
          onSwitchTab={onSwitchTab}
          isMuted={isMuted}
          onToggleMute={onToggleMute}
          astronautLatLng={astronautLatLng}
          globalOverrideActive={globalOverrideActive}
          onLockSession={handleLockDevSession}
        />
      ) : (
        <>
      {/* Active Environment State & Dynamic Climate Engine Summary */}
      <section className="bg-slate-950 rounded-xl border border-cyan-500/40 p-5 shadow-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div>
            <div className="text-[11px] font-mono text-cyan-400 uppercase tracking-wider">
              Dynamic Terrain &amp; Climate Engine · {activeEnvironment.profileGroup.replace(/_/g, ' ')}
            </div>
            <h2 className="font-display text-base font-bold text-slate-100 mt-0.5">
              Active Environment State: {activeEnvironment.regionName}
            </h2>
          </div>

          {onTogglePolarFrostMode && (
            <button
              type="button"
              onClick={() => onTogglePolarFrostMode()}
              className={`px-3 py-1.5 rounded-lg border font-mono text-xs font-bold flex items-center gap-1.5 transition-colors ${
                activeEnvironment.seasonalCo2FrostMode === 'DEPOSITION'
                  ? 'bg-sky-500/25 border-sky-400 text-sky-200'
                  : 'bg-slate-900 border-slate-700 text-slate-200 hover:border-cyan-500/50'
              }`}
              title="Toggle Polar Seasonal CO2 Dry-Ice Frost Deposition vs Sublimation"
            >
              <Snowflake className="w-3.5 h-3.5 text-sky-300" />
              <span>CO₂ Frost Cycle: {activeEnvironment.seasonalCo2FrostMode}</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 font-mono text-xs tabular-nums">
          <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-3">
            <div className="text-[10px] text-slate-400 uppercase">Elevation (MOLA)</div>
            <div className="text-sm font-bold text-amber-300 mt-0.5">
              {activeEnvironment.elevationMeters >= 0 ? '+' : ''}
              {activeEnvironment.elevationMeters.toLocaleString()} m
            </div>
            <div className="text-[10px] text-slate-400 mt-1">
              {formatAreographicCoords(activeEnvironment.lat, activeEnvironment.lng)}
            </div>
          </div>

          <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-3">
            <div className="text-[10px] text-slate-400 uppercase">Surface Type</div>
            <div className="text-[11px] font-semibold text-slate-100 mt-0.5 leading-snug">
              {activeEnvironment.surfaceType}
            </div>
          </div>

          <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-3">
            <div className="text-[10px] text-slate-400 uppercase">Pressure / Visibility</div>
            <div className="text-sm font-bold text-cyan-300 mt-0.5">
              {environmental.atmosphericPressurePa} Pa ({environmental.atmosphericPressureMbar.toFixed(2)} mbar)
            </div>
            <div className="text-[10px] text-slate-300 mt-1">{activeEnvironment.visibilityLabel}</div>
          </div>

          <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-3">
            <div className="text-[10px] text-slate-400 uppercase">Active Weather</div>
            <div className="text-[11px] font-semibold text-amber-200 mt-0.5 leading-snug">
              {activeEnvironment.activeWeather}
            </div>
          </div>
        </div>

        {(activeEnvironment.navigationBoundaryNote || activeEnvironment.routingAdvisory) && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px] font-mono bg-slate-900/60 border border-slate-800 rounded-lg px-3 py-2">
            <span className="text-slate-300">{activeEnvironment.routingAdvisory}</span>
            {activeEnvironment.navigationBoundaryNote && (
              <span className="text-amber-300 font-bold shrink-0">
                {activeEnvironment.navigationBoundaryNote}
              </span>
            )}
          </div>
        )}
      </section>
      
      {/* Gamified Training Modules & Procedural Worst-Case Failure Injection */}
      <section className="bg-slate-950 rounded-xl border border-slate-800 p-5 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3 mb-4">
          <div className="flex items-center gap-2">
            <Trophy className="w-5 h-5 text-amber-400" />
            <h2 className="font-display text-sm font-bold tracking-wider text-slate-100 uppercase">
              Mission Rehearsal Challenges & Failure Injection
            </h2>
          </div>
          {onInjectWorstCase && (
            <button
              type="button"
              onClick={() => {
                playAckTone();
                onInjectWorstCase();
              }}
              className="px-3 py-1.5 rounded-lg bg-rose-500/20 border border-rose-500/50 text-rose-300 hover:bg-rose-500/30 font-mono text-xs font-bold flex items-center gap-1.5 transition-colors"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Generate Procedural Worst-Case</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          {TRAINING_CHALLENGES.map((ch) => {
            const isActive = activeChallenge?.id === ch.id;
            return (
              <div
                key={ch.id}
                className={`p-3.5 rounded-lg border flex flex-col justify-between gap-3 ${
                  isActive
                    ? 'bg-amber-950/35 border-amber-500/60'
                    : 'bg-slate-900/60 border-slate-800'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between text-[11px] font-mono mb-1">
                    <span className="text-amber-300 font-bold">{ch.id}</span>
                    <span className="text-slate-400">Limit: {ch.timeLimitSeconds}s</span>
                  </div>
                  <h3 className="font-display text-xs font-bold text-slate-100">{ch.title}</h3>
                  <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{ch.objective}</p>
                </div>
                {onStartChallenge && (
                  <button
                    type="button"
                    onClick={() => {
                      playAckTone();
                      onStartChallenge(ch.id);
                    }}
                    className="w-full py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 font-mono text-xs font-bold transition-colors"
                  >
                    {isActive ? 'Restart Challenge' : 'Launch Training Module'}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Earth-Mars Communication Latency & Blackout Simulator */}
        <div className="bg-slate-900/70 p-3.5 rounded-lg border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1 flex-1">
            <div className="flex justify-between text-xs">
              <span className="text-slate-300 font-semibold">Earth-Mars Light-Time Latency (4–24 min)</span>
              <span className="font-mono text-amber-300 font-bold">{comms.earthMarsDelayMinutes.toFixed(1)} min</span>
            </div>
            <input
              type="range"
              min="4"
              max="24"
              step="0.5"
              value={comms.earthMarsDelayMinutes}
              onChange={(e) =>
                onUpdateState({
                  ...state,
                  comms: { ...comms, earthMarsDelayMinutes: parseFloat(e.target.value) },
                })
              }
              className="w-full accent-amber-400 cursor-pointer"
            />
          </div>
          <button
            type="button"
            onClick={() =>
              onUpdateState({
                ...state,
                comms: {
                  ...comms,
                  commBlackoutActive: !comms.commBlackoutActive,
                  signalStrengthPercent: !comms.commBlackoutActive ? 0 : 88,
                },
              })
            }
            className={`px-3.5 py-2 rounded-lg font-mono text-xs font-bold border transition-colors shrink-0 ${
              comms.commBlackoutActive
                ? 'bg-rose-500/25 text-rose-300 border-rose-500/60'
                : 'bg-slate-950 text-slate-300 border-slate-700 hover:border-cyan-500/50'
            }`}
          >
            {comms.commBlackoutActive ? 'Comm Blackout: ACTIVE (Restore)' : 'Simulate Comm Blackout'}
          </button>
        </div>
      </section>

      {/* Planetary Mars Cartography & Scientific Landmarks (300 km Visor Proximity Filter) */}
      <section className="bg-slate-950 rounded-xl border border-slate-800 p-5 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3 mb-4">
          <div className="flex items-center gap-2">
            <MapPin className="w-5 h-5 text-cyan-400" />
            <div>
              <h2 className="font-display text-sm font-bold tracking-wider text-slate-100 uppercase">
                Global Mars Cartography &amp; Landmark Database ({MARS_LANDFORMS.length})
              </h2>
              <p className="text-[11px] text-slate-400 font-mono">
                Areocentric East datum (R = 3,389.5 km) · 3D Visor renders beacons &le; {VISOR_PROXIMITY_THRESHOLD_KM} km; all planetary regions remain routable.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800 font-mono text-[11px]">
              {(
                [
                  { id: 'all', label: `All (${MARS_LANDFORMS.length})` },
                  { id: 'primary', label: 'Primary' },
                  { id: 'regional', label: 'Regional' },
                  { id: 'surface', label: 'Surface & Weather' },
                ] as const
              ).map((tier) => (
                <button
                  key={tier.id}
                  type="button"
                  onClick={() => {
                    playChirpSound();
                    setLandformTierFilter(tier.id);
                  }}
                  className={`px-2 py-1 rounded transition-colors whitespace-nowrap shrink-0 ${
                    landformTierFilter === tier.id
                      ? 'bg-cyan-500 text-slate-950 font-bold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {tier.label}
                </button>
              ))}
            </div>

            {onUpdateEquipment && (
              <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-cyan-500/40 text-xs font-mono text-cyan-200 cursor-pointer whitespace-nowrap">
                <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                <span>Autopilot on Select</span>
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
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {sortedLandforms.map((lf) => {
            const isTarget = state.navigation.targetWaypointId === lf.id;
            const elevStr = `${lf.elevationMeters >= 0 ? '+' : ''}${lf.elevationMeters.toLocaleString()} m`;
            const lfEnv = resolveRegionalEnvironment(lf.lat, lf.lng, {
              seasonalCo2FrostMode: activeEnvironment.seasonalCo2FrostMode,
            }).environment;
            return (
              <div
                key={lf.id}
                className={`p-3.5 rounded-lg border flex flex-col justify-between gap-2.5 transition-colors ${
                  isTarget
                    ? 'bg-cyan-950/35 border-cyan-400'
                    : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-[10px] font-mono tabular-nums">
                    <span className="flex items-center gap-1.5 font-bold" style={{ color: lf.categoryMeta.hex }}>
                      <span
                        className="w-2.5 h-2.5 rotate-45 inline-block shrink-0"
                        style={{ backgroundColor: lf.categoryMeta.hex }}
                      />
                      <span>{lf.categoryMeta.label.toUpperCase()}</span>
                    </span>
                    <span className={lf.inVisorRange ? 'text-emerald-300 font-semibold' : 'text-slate-400'}>
                      {TIER_LABEL[lf.tier]} · {lf.inVisorRange ? 'VISOR ≤300KM' : 'GLOBAL MAP'}
                    </span>
                  </div>

                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="font-display text-xs font-bold text-slate-100">{lf.name}</h3>
                    <span className={`text-[10px] font-mono font-bold shrink-0 ${DIFFICULTY_TEXT_CLASS[lf.difficulty]}`}>
                      DIFFICULTY: {lf.difficulty}
                    </span>
                  </div>

                  <div className="text-[10px] font-mono text-cyan-300 tabular-nums">
                    {lf.distanceKm < 1
                      ? `${Math.round(lf.distanceKm * 1000)} m`
                      : `${lf.distanceKm.toFixed(1)} km`}{' '}
                    · Elev {elevStr} · {formatAreographicCoords(lf.lat, lf.lng)}
                  </div>

                  <div className="text-[10px] font-mono text-slate-300 tabular-nums">
                    <span className="text-slate-500">Metrics:</span> {lf.dimensions.verticalMetric} ·{' '}
                    {lf.dimensions.horizontalMetric}
                  </div>

                  <div className="text-[10px] font-mono text-amber-200/90 tabular-nums">
                    <span className="text-slate-500">Atmo:</span> {lfEnv.atmosphericPressurePa} Pa · {lfEnv.visibilityLabel}
                  </div>

                  <p className="text-[11px] text-slate-300 leading-relaxed">{lf.visualCharacteristics}</p>

                  <div className="text-[10px] text-slate-400 leading-snug">
                    <span className="font-mono text-slate-500">Weather:</span> {lfEnv.activeWeather}
                  </div>

                  <ul className="text-[10px] text-slate-400 list-disc pl-4 space-y-0.5">
                    {lf.terrainConstraints.slice(0, 2).map((constraint) => (
                      <li key={constraint}>{constraint}</li>
                    ))}
                  </ul>
                </div>

                {onSelectLandform && (
                  <div className="flex items-center gap-2 pt-1.5 border-t border-slate-800/80">
                    <button
                      type="button"
                      onClick={() => {
                        playAckTone();
                        onSelectLandform(lf.id, equipment.enableAutopilotTravel);
                      }}
                      className="flex-1 py-1.5 px-2 rounded bg-slate-950 hover:bg-slate-800 text-cyan-300 border border-cyan-500/40 font-mono text-[11px] font-bold transition-colors whitespace-nowrap"
                    >
                      {equipment.enableAutopilotTravel ? 'Select & Autopilot' : 'Set Target'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        playAckTone();
                        onSelectLandform(lf.id, true);
                      }}
                      className="py-1.5 px-2.5 rounded bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-[11px] font-bold flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
                      title="Set destination, draw #52e0ff trail, and engage autonomous navigation"
                    >
                      <Navigation className="w-3 h-3" />
                      <span>Autopilot</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Scenarios Preset Selector */}
      <section className="bg-slate-950 rounded-xl border border-slate-800 p-5 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
          <div className="flex items-center gap-2">
            <Satellite className="w-5 h-5 text-cyan-400" />
            <h2 className="font-display text-sm font-bold tracking-wider text-slate-100 uppercase">
              Mission Context & Scenario Presets (Jezero Crater)
            </h2>
          </div>
          <span className="text-xs font-mono text-cyan-400">Sol 244 Telemetry</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {Object.entries(PRESET_SCENARIOS).map(([key, item]) => {
            const isSelected = currentScenarioKey === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  playChirpSound();
                  onLoadScenario(key as keyof typeof PRESET_SCENARIOS);
                }}
                className={`p-3 text-left rounded-lg border transition-all flex flex-col justify-between ${
                  isSelected
                    ? 'bg-cyan-950/40 border-cyan-500/60 text-slate-100 shadow-md shadow-cyan-950'
                    : 'bg-slate-900/60 border-slate-800 hover:border-slate-700 text-slate-300'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-[11px] font-mono font-bold ${isSelected ? 'text-cyan-300' : 'text-slate-400'}`}>
                      {key.toUpperCase()}
                    </span>
                    {isSelected && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <h3 className="font-display text-xs font-bold text-slate-200 line-clamp-1">
                    {item.name}
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-1 line-clamp-2 leading-relaxed">
                    {item.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Interactive Telemetry Parameter Scrubbers */}
      <section className="bg-slate-950 rounded-xl border border-slate-800 p-5 shadow-xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-amber-400" />
            <h2 className="font-display text-sm font-bold tracking-wider text-slate-100 uppercase">
              Interactive Mars Telemetry & Solar Event Controls
            </h2>
          </div>
          <span className="text-xs font-mono text-slate-400">Live Physics & Rover Damage Simulation</span>
        </div>

        {/* Direct 1-Click Solar Particle Event (SPE / CME) Tier Selector */}
        {onTriggerSolarEvent && (
          <div className="bg-slate-900/75 p-4 rounded-lg border border-rose-500/30 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-display font-bold uppercase tracking-wider text-rose-300">
                Solar Particle Event (SPE / CME) Intensity
              </span>
              <span className="text-[11px] font-mono text-amber-300">
                Current: {environmental.speIntensityLevel.replace(/_/g, ' ')} ({environmental.radiationDoseRateMicroSvHr.toFixed(1)} µSv/h)
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(
                [
                  { id: 'NONE', label: 'Nominal GCR (9.2 µSv/h)' },
                  { id: 'ELEVATED_FLUX', label: 'M-Class SPE (32.5 µSv/h)' },
                  { id: 'HIGH_FLUX_WARNING', label: 'High Flux (78.4 µSv/h)' },
                  { id: 'EXTREME_CME_STORM', label: 'X-Class CME (168 µSv/h)' },
                ] as const
              ).map((tier) => {
                const active = environmental.speIntensityLevel === tier.id;
                return (
                  <button
                    key={tier.id}
                    type="button"
                    onClick={() => onTriggerSolarEvent(tier.id)}
                    className={`py-2 px-2.5 rounded-lg border font-mono text-[11px] font-bold transition-all ${
                      active
                        ? tier.id === 'EXTREME_CME_STORM'
                          ? 'bg-rose-600 text-white border-rose-300 shadow-lg shadow-rose-900/50'
                          : tier.id === 'HIGH_FLUX_WARNING'
                            ? 'bg-amber-500 text-slate-950 border-amber-300'
                            : 'bg-cyan-500 text-slate-950 border-cyan-300'
                        : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-600'
                    }`}
                  >
                    {tier.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          
          {/* Atmospheric Wind Speed */}
          <div className="bg-slate-900/60 p-4 rounded-lg border border-slate-800 space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                <Wind className="w-3.5 h-3.5 text-cyan-400" /> MEDA Wind Speed
              </span>
              <span className="font-mono text-cyan-300 font-bold tabular-nums">
                {atmospheric.windSpeedMps} m/s (Gust: {atmospheric.windGustMps} m/s)
              </span>
            </div>
            <input
              type="range"
              min="1"
              max="25"
              step="0.5"
              value={atmospheric.windSpeedMps}
              onChange={(e) => handleWindChange(parseFloat(e.target.value))}
              className="w-full accent-cyan-400 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] font-mono text-slate-400">
              <span>1.0 m/s (Calm)</span>
              <span className="text-rose-400">12.0 m/s (Abort Limit)</span>
              <span>25.0 m/s (Severe Gale)</span>
            </div>
          </div>

          {/* Dust Opacity Tau */}
          <div className="bg-slate-900/60 p-4 rounded-lg border border-slate-800 space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5 text-amber-400" /> MEDA Dust Opacity (Tau)
              </span>
              <span className={`font-mono font-bold tabular-nums ${
                atmospheric.dustOpacityTau > 0.5 ? 'text-rose-400' : 'text-slate-200'
              }`}>
                {atmospheric.dustOpacityTau} tau
              </span>
            </div>
            <input
              type="range"
              min="0.10"
              max="2.80"
              step="0.05"
              value={atmospheric.dustOpacityTau}
              onChange={(e) => handleTauChange(parseFloat(e.target.value))}
              className="w-full accent-amber-400 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] font-mono text-slate-400">
              <span>0.20 (Clear)</span>
              <span className="text-amber-400">0.80 (Dust Storm)</span>
              <span className="text-rose-400">2.50+ (Global Storm)</span>
            </div>
            <div className="text-[10px] font-mono text-amber-300/90 pt-1">
              Solar Transmission: {Math.round(Math.max(4, Math.exp(-atmospheric.dustOpacityTau * 0.85) * 100))}% ·{' '}
              {equipment.solarPanelsDeployed && atmospheric.dustOpacityTau > 0.75
                ? '⚠ Rapid electrostatic dust coating on deployed arrays!'
                : 'Beer-Lambert attenuation'}
            </div>
          </div>

          {/* Topographic Slope % */}
          <div className="bg-slate-900/60 p-4 rounded-lg border border-slate-800 space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 text-cyan-400" /> HiRISE Escarpment Slope
              </span>
              <span className={`font-mono font-bold tabular-nums ${
                topography.slopePercentage > 15 ? 'text-rose-400' : 'text-emerald-400'
              }`}>
                {topography.slopePercentage}% ({topography.slopeAngleDegrees}°)
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="35"
              step="0.5"
              value={topography.slopePercentage}
              onChange={(e) => handleSlopeChange(parseFloat(e.target.value))}
              className="w-full accent-cyan-400 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] font-mono text-slate-400">
              <span>0% (Flat Pavement)</span>
              <span className="text-amber-400">15% (Slip Limit)</span>
              <span>35% (Vertical Scarp)</span>
            </div>
          </div>

          {/* Radiation Dose Rate */}
          <div className="bg-slate-900/60 p-4 rounded-lg border border-slate-800 space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5 text-rose-400" /> RAD Ionizing Dose Rate
              </span>
              <span className={`font-mono font-bold tabular-nums ${
                environmental.radiationDoseRateMicroSvHr > 25 ? 'text-rose-400' : 'text-cyan-300'
              }`}>
                {environmental.radiationDoseRateMicroSvHr} µSv/h
              </span>
            </div>
            <input
              type="range"
              min="5"
              max="220"
              step="1"
              value={environmental.radiationDoseRateMicroSvHr}
              onChange={(e) => handleRadiationChange(parseFloat(e.target.value))}
              className="w-full accent-rose-400 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] font-mono text-slate-400">
              <span>9.2 µSv/h (GCR)</span>
              <span className="text-amber-400">40 µSv/h (SPE Alert)</span>
              <span className="text-rose-400">150+ µSv/h (X-CME SEU)</span>
            </div>
            <div className="text-[10px] font-mono text-rose-300/90 pt-1">
              {environmental.radiationDoseRateMicroSvHr >= 100
                ? '⚠ Extreme CME: Frequent SEU bit-flips, UHF fade & avionics degradation!'
                : environmental.radiationDoseRateMicroSvHr > 40
                  ? '⚠ High proton flux: RAM bit-flips & ionospheric signal drop.'
                  : 'Nominal galactic cosmic ray background.'}
            </div>
          </div>

        </div>
      </section>

      {/* NASA Instrument Citation Badges */}
      <section className="p-4 bg-slate-900/40 rounded-xl border border-slate-800/80 text-xs text-slate-400 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <strong className="text-slate-300">NASA Mars 2020 & MRO Verified Datasets:</strong>
          <p className="text-[11px] leading-relaxed">
            Perseverance MEDA (Mars Environmental Dynamics Analyzer) atmospheric pressure & optical depth records;
            MRO HiRISE (High Resolution Imaging Science Experiment) Digital Terrain Model PSP_001415_1985;
            MSL / M2020 RAD (Radiation Assessment Detector) surface dosimetry.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 font-mono text-[11px] text-cyan-400">
          <span>JEZERO DELTA SECTOR 04</span>
          <span>·</span>
          <span>SOL 244 ARCHIVE</span>
        </div>
      </section>
        </>
      )}

    </div>
  );
};
