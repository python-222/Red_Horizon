import React, { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck,
  Lock,
  Unlock,
  KeyRound,
  Eye,
  EyeOff,
  Search,
  Terminal,
  BellRing,
  Sliders,
  Crosshair,
  Gamepad2,
  RotateCcw,
  Zap,
  AlertTriangle,
  CheckCircle2,
  X,
  Compass,
  Activity,
} from 'lucide-react';
import type { ExcursionState, EquipmentControlState, HudDisplayMode, SeasonalFrostMode } from '../types/telemetry';
import {
  DEVELOPER_FEATURE_INVENTORY,
  type DeveloperFeatureEntry,
  type FeatureAuditStatus,
  type FeatureInventoryCategory,
} from '../data/developerFeatureRegistry';
import { dualSense } from '../utils/dualsenseController';
import { vehicleSim } from '../utils/vehicleController';
import { playAckTone, playCautionTone, playChirpSound, playHazardAlarm } from '../utils/audioAlerts';
import { NOTIFICATION_AUTO_DISMISS_MS } from '../utils/notificationTimers';

export const DEV_SESSION_STORAGE_KEY = 'mars_eva_dev_command_session_v1';

interface StoredDevSession {
  authenticated: boolean;
  issuedAt: number;
  clearanceTier: string;
}

export function getExpectedDevAccessCode(): string {
  const envVal = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_DEV_ACCESS_CODE;
  return envVal && envVal.trim().length > 0 ? envVal.trim() : '12345';
}

export function readDevSessionUnlocked(): boolean {
  try {
    const raw = window.sessionStorage.getItem(DEV_SESSION_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<StoredDevSession>;
    return parsed.authenticated === true && typeof parsed.issuedAt === 'number';
  } catch {
    return false;
  }
}

export function persistDevSessionUnlocked(): void {
  try {
    const payload: StoredDevSession = {
      authenticated: true,
      issuedAt: Date.now(),
      clearanceTier: 'FLIGHT-DEV-L4',
    };
    window.sessionStorage.setItem(DEV_SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore sessionStorage quota/privacy errors gracefully
  }
}

export function clearDevSessionUnlocked(): void {
  try {
    window.sessionStorage.removeItem(DEV_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage errors gracefully
  }
}

interface DeveloperAuthModalProps {
  open: boolean;
  onClose: () => void;
  onAuthenticated: () => void;
}

export const DeveloperAuthModal: React.FC<DeveloperAuthModalProps> = ({
  open,
  onClose,
  onAuthenticated,
}) => {
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setCode('');
      setErrorMsg(null);
      setShowCode(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    const expected = getExpectedDevAccessCode();
    if (trimmed === expected) {
      persistDevSessionUnlocked();
      playAckTone();
      setErrorMsg(null);
      onAuthenticated();
    } else {
      playCautionTone();
      setErrorMsg('ACCESS DENIED · INVALID FLIGHT-DEV CLEARANCE CODE');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dev-auth-title"
    >
      <div className="w-full max-w-md rounded-xl border border-cyan-500/50 bg-[#070b14] shadow-2xl shadow-cyan-950/60 overflow-hidden">
        {/* Top aerospace header */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-slate-900/90 border-b border-cyan-500/30">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[10px] font-mono tracking-[0.2em] text-cyan-400 uppercase">
                MARS-2020 // FLIGHT-DEV GATE
              </div>
              <h2 id="dev-auth-title" className="font-display text-sm font-bold text-slate-100">
                Developer Command Center Authorization
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
            aria-label="Close authorization modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="rounded-lg bg-slate-900/70 border border-slate-800 p-3 text-[11px] font-mono text-slate-300 leading-relaxed space-y-1">
            <div className="text-amber-300 font-bold flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5" />
              <span>RESTRICTED AEROSPACE DIAGNOSTICS</span>
            </div>
            <p className="text-slate-400">
              Enter your mission engineering access code to unlock the Feature Audit Matrix, live DualSense/physics monitors, coordinate overrides, and alert tier force-testers.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="dev-access-code-input" className="block text-[11px] font-mono uppercase tracking-wider text-cyan-300">
              Developer Access Code
            </label>
            <div className="relative flex items-center">
              <input
                id="dev-access-code-input"
                type={showCode ? 'text' : 'password'}
                autoFocus
                autoComplete="off"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  if (errorMsg) setErrorMsg(null);
                }}
                placeholder="Enter clearance code..."
                className="w-full rounded-lg bg-slate-950 border border-cyan-500/40 focus:border-cyan-400 focus:outline-none px-3.5 py-2.5 pr-10 font-mono text-sm text-slate-100 tracking-wider placeholder:text-slate-600"
              />
              <button
                type="button"
                onClick={() => setShowCode((s) => !s)}
                className="absolute right-2.5 p-1 text-slate-400 hover:text-cyan-300 transition-colors"
                aria-label={showCode ? 'Hide access code' : 'Show access code'}
              >
                {showCode ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="text-[10px] font-mono text-slate-500">
              Configured via <code className="text-slate-400">VITE_DEV_ACCESS_CODE</code> or mission default clearance key. Session persists in <code className="text-slate-400">sessionStorage</code>.
            </div>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg bg-rose-950/70 border border-rose-500/60 px-3 py-2 text-xs font-mono text-rose-200"
            >
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:text-white font-mono text-xs transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-bold flex items-center gap-1.5 transition-colors shadow-md shadow-cyan-950"
            >
              <Unlock className="w-3.5 h-3.5" />
              <span>Verify Clearance</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export interface DeveloperCommandCenterProps {
  state: ExcursionState;
  onUpdateState: (newState: ExcursionState) => void;
  onUpdateEquipment?: (patch: Partial<EquipmentControlState>) => void;
  onTogglePolarFrostMode?: (mode?: SeasonalFrostMode) => void;
  onTriggerSolarEvent?: (level?: 'NONE' | 'ELEVATED_FLUX' | 'HIGH_FLUX_WARNING' | 'EXTREME_CME_STORM') => void;
  onInjectWorstCase?: () => void;
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
  astronautLatLng: { lat: number; lng: number };
  globalOverrideActive?: boolean;
  onLockSession: () => void;
}

const STATUS_BADGE_CLASS: Record<FeatureAuditStatus, string> = {
  Active: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50',
  Configured: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50',
  Standby: 'bg-amber-500/20 text-amber-300 border-amber-500/50',
  Deprecated: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
};

const ACTION_BTN_CLASS: Record<'cyan' | 'amber' | 'rose' | 'emerald', string> = {
  cyan: 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/30',
  amber: 'border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/30',
  rose: 'border-rose-500/50 bg-rose-500/15 text-rose-200 hover:bg-rose-500/30',
  emerald: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/30',
};

export const DeveloperCommandCenter: React.FC<DeveloperCommandCenterProps> = ({
  state,
  onUpdateState,
  onUpdateEquipment,
  onTogglePolarFrostMode,
  onTriggerSolarEvent,
  onInjectWorstCase,
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
  astronautLatLng,
  globalOverrideActive = false,
  onLockSession,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'All' | FeatureInventoryCategory>('All');
  const [statusFilter, setStatusFilter] = useState<'All' | FeatureAuditStatus>('All');

  // Coordinate override form state
  const [localXInput, setLocalXInput] = useState('120');
  const [localYInput, setLocalYInput] = useState('160');
  const [headingInput, setHeadingInput] = useState('318');
  const [globalLatInput, setGlobalLatInput] = useState(() => astronautLatLng.lat.toFixed(3));
  const [globalLngInput, setGlobalLngInput] = useState(() => astronautLatLng.lng.toFixed(3));

  // Lightweight live poll of vehicleSim & DualSense mutable refs while dev console is mounted
  const [liveSnapshot, setLiveSnapshot] = useState(() => ({
    pose: { ...vehicleSim.poseRef.current },
    ds: { ...dualSense.inputRef.current },
  }));

  useEffect(() => {
    const id = setInterval(() => {
      setLiveSnapshot({
        pose: { ...vehicleSim.poseRef.current },
        ds: { ...dualSense.inputRef.current },
      });
    }, 150);
    return () => clearInterval(id);
  }, []);

  const resolvedInventory = useMemo(() => {
    return DEVELOPER_FEATURE_INVENTORY.map((entry) => {
      const resolved = entry.resolveStatus({
        state,
        hudMode,
        dualsenseConnected: liveSnapshot.ds.connected,
        dualsenseCursorMode: liveSnapshot.ds.cursorMode,
        isMuted,
        globalOverrideActive,
      });
      return { entry, ...resolved };
    });
  }, [
    state,
    hudMode,
    liveSnapshot.ds.connected,
    liveSnapshot.ds.cursorMode,
    isMuted,
    globalOverrideActive,
  ]);

  const statusCounts = useMemo(() => {
    const counts: Record<FeatureAuditStatus, number> = {
      Active: 0,
      Configured: 0,
      Standby: 0,
      Deprecated: 0,
    };
    for (const item of resolvedInventory) {
      counts[item.status] += 1;
    }
    return counts;
  }, [resolvedInventory]);

  const filteredInventory = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return resolvedInventory.filter(({ entry, status, detail }) => {
      if (categoryFilter !== 'All' && entry.category !== categoryFilter) return false;
      if (statusFilter !== 'All' && status !== statusFilter) return false;
      if (!q) return true;
      return (
        entry.id.toLowerCase().includes(q) ||
        entry.name.toLowerCase().includes(q) ||
        entry.category.toLowerCase().includes(q) ||
        entry.summary.toLowerCase().includes(q) ||
        entry.symbols.toLowerCase().includes(q) ||
        detail.toLowerCase().includes(q) ||
        entry.filePaths.some((fp) => fp.toLowerCase().includes(q))
      );
    });
  }, [resolvedInventory, searchQuery, categoryFilter, statusFilter]);

  const runDebugAction = (actionId: NonNullable<DeveloperFeatureEntry['debugAction']>['id']) => {
    switch (actionId) {
      case 'toggle_ai_pilot':
        playAckTone();
        onUpdateEquipment?.({ autonomousAiPilot: !state.equipment.autonomousAiPilot });
        break;
      case 'toggle_autopilot_on_select':
        playChirpSound();
        onUpdateEquipment?.({ enableAutopilotTravel: !state.equipment.enableAutopilotTravel });
        break;
      case 'toggle_locomotion':
        playChirpSound();
        onUpdateEquipment?.({
          locomotionMode: state.equipment.locomotionMode === 'rover' ? 'eva_walk' : 'rover',
        });
        break;
      case 'cycle_torque': {
        playChirpSound();
        const cur = state.equipment.speedTorqueSetting;
        const next = cur < 0.9 ? 1.0 : cur < 1.9 ? 2.5 : 0.5;
        onUpdateEquipment?.({ speedTorqueSetting: next });
        break;
      }
      case 'toggle_solar_wings':
        playChirpSound();
        onUpdateEquipment?.({ solarPanelsDeployed: !state.equipment.solarPanelsDeployed });
        break;
      case 'toggle_headlights':
        playChirpSound();
        onUpdateEquipment?.({ headlightsEnabled: !state.equipment.headlightsEnabled });
        break;
      case 'toggle_sensors':
        playChirpSound();
        onUpdateEquipment?.({ sensorArrayEnabled: !state.equipment.sensorArrayEnabled });
        break;
      case 'cycle_o2_mode': {
        playChirpSound();
        const modes: EquipmentControlState['oxygenFlowMode'][] = ['conserve', 'nominal', 'high_flow'];
        const next = modes[(modes.indexOf(state.equipment.oxygenFlowMode) + 1) % modes.length];
        onUpdateEquipment?.({ oxygenFlowMode: next });
        break;
      }
      case 'toggle_frost_mode':
        onTogglePolarFrostMode?.();
        break;
      case 'toggle_blackout': {
        const nextBlackout = !state.comms.commBlackoutActive;
        if (nextBlackout) playCautionTone();
        else playAckTone();
        onUpdateState({
          ...state,
          comms: {
            ...state.comms,
            commBlackoutActive: nextBlackout,
            signalStrengthPercent: nextBlackout ? 0 : 92,
          },
          lastSettingChange: {
            id: Date.now(),
            title: nextBlackout ? 'COMMS ALERT: UHF BLACKOUT INJECTED' : 'UHF RELAY LINK RESTORED',
            detail: nextBlackout
              ? 'Simulated Earth-Mars carrier blackout active (0% signal).'
              : 'Telemetry downlink restored to 92% signal.',
            severity: nextBlackout ? 'danger' : 'info',
            timestamp: Date.now(),
          },
        });
        break;
      }
      case 'cycle_spe':
        onTriggerSolarEvent?.();
        break;
      case 'inject_worst_case':
        onInjectWorstCase?.();
        break;
      case 'engage_rtb':
        onEngageEmergencyRtb?.();
        break;
      case 'hazard_override':
        onHazardOverride?.();
        break;
      case 'reset_pose':
        onResetPosition?.();
        break;
      case 'test_notif_info':
        playChirpSound();
        onDispatchTestNotification?.('info');
        break;
      case 'test_notif_warn':
        playCautionTone();
        onDispatchTestNotification?.('warn');
        break;
      case 'test_notif_danger':
        playHazardAlarm();
        onDispatchTestNotification?.('danger');
        break;
      case 'test_notif_ack':
        playHazardAlarm();
        onDispatchTestNotification?.('emergency_ack');
        break;
      case 'test_audio_chirp':
        playChirpSound();
        break;
      case 'test_audio_alarm':
        playHazardAlarm();
        break;
      case 'toggle_mute':
        onToggleMute?.(!isMuted);
        break;
      case 'cycle_hud_mode': {
        playChirpSound();
        const modes: HudDisplayMode[] = ['minimalist', 'standard', 'verbose'];
        onSetHudMode?.(modes[(modes.indexOf(hudMode) + 1) % modes.length]);
        break;
      }
      case 'goto_hud':
        playChirpSound();
        onSwitchTab?.('hud');
        break;
      case 'goto_visor':
        playChirpSound();
        onSwitchTab?.('visor');
        break;
      case 'goto_console':
        playChirpSound();
        onSwitchTab?.('console');
        break;
    }
  };

  const handleApplyLocalTeleport = (e: React.FormEvent) => {
    e.preventDefault();
    const x = parseFloat(localXInput);
    const y = parseFloat(localYInput);
    const hdg = parseFloat(headingInput);
    if (Number.isNaN(x) || Number.isNaN(y)) return;
    playAckTone();
    onTeleportLocal?.(x, y, Number.isNaN(hdg) ? undefined : hdg);
  };

  const handleApplyGlobalTeleport = (e: React.FormEvent) => {
    e.preventDefault();
    const lat = parseFloat(globalLatInput);
    const lng = parseFloat(globalLngInput);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;
    playAckTone();
    onTeleportGlobal?.(Math.max(-90, Math.min(90, lat)), lng);
  };

  const categories: Array<'All' | FeatureInventoryCategory> = [
    'All',
    'Controls & Input',
    'Physics & AI',
    'HUD & Visor',
    'Telemetry & Climate',
    'Notifications & Audio',
    'Map & Cartography',
  ];

  const statuses: Array<'All' | FeatureAuditStatus> = [
    'All',
    'Active',
    'Configured',
    'Standby',
    'Deprecated',
  ];

  return (
    <div className="space-y-6">
      {/* Developer Clearance Banner */}
      <section className="rounded-xl border border-cyan-500/50 bg-slate-950 p-5 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.18em] text-emerald-400">
                <span>SESSION AUTHENTICATED · CLEARANCE FLIGHT-DEV-L4</span>
              </div>
              <h2 className="font-display text-base font-bold text-slate-100">
                Developer Command Center &amp; Feature Audit Matrix
              </h2>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
            <span className="px-2.5 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
              Active: {statusCounts.Active}
            </span>
            <span className="px-2.5 py-1 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-300">
              Configured: {statusCounts.Configured}
            </span>
            <span className="px-2.5 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300">
              Standby: {statusCounts.Standby}
            </span>
            <span className="px-2.5 py-1 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300">
              Deprecated: {statusCounts.Deprecated}
            </span>
            <button
              type="button"
              onClick={() => {
                playChirpSound();
                onLockSession();
              }}
              className="ml-1 px-3 py-1 rounded-lg border border-rose-500/50 bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 font-bold flex items-center gap-1.5 transition-colors"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Lock Session</span>
            </button>
          </div>
        </div>

        {/* Live Telemetry, DualSense & Physics Bus Readout */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mt-4 font-mono text-[11px] tabular-nums">
          <div className="rounded-lg bg-slate-900/75 border border-slate-800 p-2.5">
            <div className="text-[10px] text-slate-400 uppercase">Local Pose</div>
            <div className="text-cyan-300 font-bold mt-0.5">
              {liveSnapshot.pose.x.toFixed(1)}m, {liveSnapshot.pose.y.toFixed(1)}m
            </div>
            <div className="text-[10px] text-slate-400">HDG {liveSnapshot.pose.heading.toFixed(1)}°</div>
          </div>
          <div className="rounded-lg bg-slate-900/75 border border-slate-800 p-2.5">
            <div className="text-[10px] text-slate-400 uppercase">Velocity / Slip</div>
            <div className="text-amber-300 font-bold mt-0.5">
              {liveSnapshot.pose.speedMps.toFixed(2)} m/s
            </div>
            <div className="text-[10px] text-slate-400">
              Slip {(liveSnapshot.pose.wheelSlipRatio * 100).toFixed(0)}%
            </div>
          </div>
          <div className="rounded-lg bg-slate-900/75 border border-slate-800 p-2.5">
            <div className="text-[10px] text-slate-400 uppercase">Areographic GPS</div>
            <div className="text-slate-100 font-bold mt-0.5">
              {liveSnapshot.pose.lat.toFixed(3)}°, {liveSnapshot.pose.lng.toFixed(3)}°
            </div>
            <div className="text-[10px] text-slate-400">{state.activeEnvironment.biomeId}</div>
          </div>
          <div className="rounded-lg bg-slate-900/75 border border-slate-800 p-2.5">
            <div className="text-[10px] text-slate-400 uppercase flex items-center gap-1">
              <Gamepad2 className="w-3 h-3 text-cyan-400" /> DualSense Bus
            </div>
            <div className={`font-bold mt-0.5 ${liveSnapshot.ds.connected ? 'text-emerald-300' : 'text-slate-400'}`}>
              {liveSnapshot.ds.connected ? 'CONNECTED' : 'OFFLINE'}
            </div>
            <div className="text-[10px] text-slate-400">
              SteerX {liveSnapshot.ds.steerX.toFixed(2)} · Thr {liveSnapshot.ds.throttle.toFixed(2)}
            </div>
          </div>
          <div className="rounded-lg bg-slate-900/75 border border-slate-800 p-2.5">
            <div className="text-[10px] text-slate-400 uppercase">Vitals / Power</div>
            <div className="text-emerald-300 font-bold mt-0.5">
              O₂ {state.vitals.oxygenPercentage.toFixed(1)}% · BAT {state.vitals.batteryPercentage.toFixed(1)}%
            </div>
            <div className="text-[10px] text-slate-400">
              Net {state.consequences.netPowerWatts}W · Int {state.equipment.suitRoverIntegrityPercent}%
            </div>
          </div>
          <div className="rounded-lg bg-slate-900/75 border border-slate-800 p-2.5">
            <div className="text-[10px] text-slate-400 uppercase">Alert State</div>
            <div className={`font-bold mt-0.5 ${state.hazardAlert.active ? 'text-rose-400' : 'text-emerald-300'}`}>
              {state.hazardAlert.active ? state.hazardAlert.severity : 'NOMINAL'}
            </div>
            <div className="text-[10px] text-slate-400 truncate">
              {state.lastSettingChange ? state.lastSettingChange.title : 'No active toast'}
            </div>
          </div>
        </div>
      </section>

      {/* Live Debug Control Hooks */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* 1. Notification Force-Testers */}
        <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 space-y-3 shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
            <div className="flex items-center gap-2">
              <BellRing className="w-4 h-4 text-amber-400" />
              <h3 className="font-display text-xs font-bold uppercase tracking-wider text-slate-100">
                Notification Force-Testers
              </h3>
            </div>
            <span className="text-[10px] font-mono text-slate-400">Auto-Dismiss Tiers</span>
          </div>

          <p className="text-[11px] font-mono text-slate-400 leading-relaxed">
            Dispatch live alerts across HUD &amp; 3D Visor to verify severity-based auto-dismissal timers and smooth 250ms fade cleanup.
          </p>

          <div className="grid grid-cols-1 gap-2 font-mono text-xs">
            <button
              type="button"
              onClick={() => runDebugAction('test_notif_info')}
              className="px-3 py-2 rounded-lg border border-cyan-500/40 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 font-bold flex items-center justify-between transition-colors"
            >
              <span>Low / Info Alert</span>
              <span className="text-[10px] text-cyan-300">{(NOTIFICATION_AUTO_DISMISS_MS.info / 1000).toFixed(1)}s</span>
            </button>
            <button
              type="button"
              onClick={() => runDebugAction('test_notif_warn')}
              className="px-3 py-2 rounded-lg border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 font-bold flex items-center justify-between transition-colors"
            >
              <span>Medium / Warning Alert</span>
              <span className="text-[10px] text-amber-300">{(NOTIFICATION_AUTO_DISMISS_MS.warn / 1000).toFixed(1)}s</span>
            </button>
            <button
              type="button"
              onClick={() => runDebugAction('test_notif_danger')}
              className="px-3 py-2 rounded-lg border border-rose-500/40 bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 font-bold flex items-center justify-between transition-colors"
            >
              <span>High / Critical Comms Alert</span>
              <span className="text-[10px] text-rose-300">{(NOTIFICATION_AUTO_DISMISS_MS.danger / 1000).toFixed(1)}s</span>
            </button>
            <button
              type="button"
              onClick={() => runDebugAction('test_notif_ack')}
              className="px-3 py-2 rounded-lg border border-rose-400/60 bg-rose-950/60 hover:bg-rose-900/60 text-rose-100 font-bold flex items-center justify-between transition-colors"
            >
              <span>Emergency Override (Manual ACK)</span>
              <span className="text-[10px] text-rose-300">PERSISTENT</span>
            </button>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => runDebugAction('hazard_override')}
              className="flex-1 py-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 font-mono text-[11px] font-bold flex items-center justify-center gap-1.5"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Clear All Hazards</span>
            </button>
            <button
              type="button"
              onClick={() => runDebugAction('toggle_mute')}
              className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:text-white font-mono text-[11px]"
            >
              {isMuted ? 'Unmute SFX' : 'Mute SFX'}
            </button>
          </div>
        </div>

        {/* 2. Live Telemetry & Equipment Injectors */}
        <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 space-y-3 shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-cyan-400" />
              <h3 className="font-display text-xs font-bold uppercase tracking-wider text-slate-100">
                Live Telemetry &amp; Torque Hooks
              </h3>
            </div>
            <span className="text-[10px] font-mono text-cyan-400">Direct State</span>
          </div>

          <div className="space-y-2.5 font-mono text-[11px]">
            <div>
              <div className="flex justify-between text-slate-300 mb-1">
                <span>Speed / Torque Multiplier</span>
                <span className="text-cyan-300 font-bold">{state.equipment.speedTorqueSetting.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="2.5"
                step="0.1"
                value={state.equipment.speedTorqueSetting}
                onChange={(e) => onUpdateEquipment?.({ speedTorqueSetting: parseFloat(e.target.value) })}
                className="w-full accent-cyan-400 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-slate-300 mb-1">
                <span>Oxygen Reserve (%)</span>
                <span className="text-emerald-300 font-bold">{state.vitals.oxygenPercentage.toFixed(1)}%</span>
              </div>
              <input
                type="range"
                min="5"
                max="100"
                step="1"
                value={state.vitals.oxygenPercentage}
                onChange={(e) =>
                  onUpdateState({
                    ...state,
                    vitals: { ...state.vitals, oxygenPercentage: parseFloat(e.target.value) },
                  })
                }
                className="w-full accent-emerald-400 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-slate-300 mb-1">
                <span>Battery Reserve (%)</span>
                <span className="text-amber-300 font-bold">{state.vitals.batteryPercentage.toFixed(1)}%</span>
              </div>
              <input
                type="range"
                min="5"
                max="100"
                step="1"
                value={state.vitals.batteryPercentage}
                onChange={(e) =>
                  onUpdateState({
                    ...state,
                    vitals: { ...state.vitals, batteryPercentage: parseFloat(e.target.value) },
                  })
                }
                className="w-full accent-amber-400 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-slate-300 mb-1">
                <span>Suit / Rover Integrity (%)</span>
                <span className="text-rose-300 font-bold">{state.equipment.suitRoverIntegrityPercent.toFixed(1)}%</span>
              </div>
              <input
                type="range"
                min="5"
                max="100"
                step="1"
                value={state.equipment.suitRoverIntegrityPercent}
                onChange={(e) =>
                  onUpdateState({
                    ...state,
                    equipment: { ...state.equipment, suitRoverIntegrityPercent: parseFloat(e.target.value) },
                  })
                }
                className="w-full accent-rose-400 cursor-pointer"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1 font-mono text-[11px]">
            <button
              type="button"
              onClick={() => runDebugAction('toggle_ai_pilot')}
              className={`py-1.5 px-2 rounded border font-bold transition-colors ${
                state.equipment.autonomousAiPilot
                  ? 'border-cyan-400 bg-cyan-500/25 text-cyan-200'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-cyan-500/40'
              }`}
            >
              AI Pilot: {state.equipment.autonomousAiPilot ? 'ON' : 'OFF'}
            </button>
            <button
              type="button"
              onClick={() => runDebugAction('toggle_locomotion')}
              className="py-1.5 px-2 rounded border border-slate-700 bg-slate-900 hover:border-cyan-500/40 text-slate-200 font-bold"
            >
              Mode: {state.equipment.locomotionMode === 'rover' ? 'ROVER' : 'EVA'}
            </button>
            <button
              type="button"
              onClick={() => runDebugAction('toggle_blackout')}
              className={`py-1.5 px-2 rounded border font-bold transition-colors ${
                state.comms.commBlackoutActive
                  ? 'border-rose-500 bg-rose-500/25 text-rose-200'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-rose-500/40'
              }`}
            >
              Blackout: {state.comms.commBlackoutActive ? 'ACTIVE' : 'OFF'}
            </button>
            <button
              type="button"
              onClick={() => runDebugAction('engage_rtb')}
              className="py-1.5 px-2 rounded border border-rose-500/50 bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 font-bold"
            >
              Force Emergency RTB
            </button>
          </div>
        </div>

        {/* 3. Coordinate, Heading & Camera / View Overrides */}
        <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 space-y-3 shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
            <div className="flex items-center gap-2">
              <Crosshair className="w-4 h-4 text-emerald-400" />
              <h3 className="font-display text-xs font-bold uppercase tracking-wider text-slate-100">
                Coordinate &amp; View Overrides
              </h3>
            </div>
            <span className="text-[10px] font-mono text-emerald-400">Teleport / Mode</span>
          </div>

          <form onSubmit={handleApplyLocalTeleport} className="space-y-2 font-mono text-[11px]">
            <div className="text-[10px] text-slate-400 uppercase">Jezero Local Pose (X, Y, Heading°)</div>
            <div className="grid grid-cols-3 gap-1.5">
              <input
                type="number"
                step="10"
                value={localXInput}
                onChange={(e) => setLocalXInput(e.target.value)}
                aria-label="Local X meters"
                placeholder="X (m)"
                className="rounded bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100 focus:border-cyan-400 focus:outline-none"
              />
              <input
                type="number"
                step="10"
                value={localYInput}
                onChange={(e) => setLocalYInput(e.target.value)}
                aria-label="Local Y meters"
                placeholder="Y (m)"
                className="rounded bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100 focus:border-cyan-400 focus:outline-none"
              />
              <input
                type="number"
                step="5"
                value={headingInput}
                onChange={(e) => setHeadingInput(e.target.value)}
                aria-label="Heading degrees"
                placeholder="HDG°"
                className="rounded bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100 focus:border-cyan-400 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              className="w-full py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 font-bold"
            >
              Teleport Local Pose
            </button>
          </form>

          <form onSubmit={handleApplyGlobalTeleport} className="space-y-2 font-mono text-[11px] pt-1 border-t border-slate-800/80">
            <div className="text-[10px] text-slate-400 uppercase">Global Areographic (Lat°, Lon°E)</div>
            <div className="grid grid-cols-2 gap-1.5">
              <input
                type="number"
                step="0.1"
                value={globalLatInput}
                onChange={(e) => setGlobalLatInput(e.target.value)}
                aria-label="Global Latitude"
                placeholder="Lat°"
                className="rounded bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100 focus:border-cyan-400 focus:outline-none"
              />
              <input
                type="number"
                step="0.1"
                value={globalLngInput}
                onChange={(e) => setGlobalLngInput(e.target.value)}
                aria-label="Global Longitude"
                placeholder="Lon°E"
                className="rounded bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100 focus:border-cyan-400 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              className="w-full py-1.5 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 font-bold"
            >
              Override Global Coordinates
            </button>
            <div className="grid grid-cols-2 gap-1 pt-1">
              {(
                [
                  { label: 'HAB-01 Base', type: 'local' as const, x: 0, y: 0, hdg: 0 },
                  { label: 'Olympus Mons', type: 'global' as const, lat: 22.17, lng: 221.84 },
                  { label: 'Olympus Summit', type: 'global' as const, lat: 18.65, lng: 226.2 },
                  { label: 'Valles Marineris', type: 'global' as const, lat: -7.89, lng: 282.59 },
                  { label: 'Planum Boreum', type: 'global' as const, lat: 84.35, lng: 1.66 },
                ] as const
              ).map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    playAckTone();
                    if (preset.type === 'local') {
                      onTeleportLocal?.(preset.x, preset.y, preset.hdg);
                    } else {
                      setGlobalLatInput(preset.lat.toFixed(2));
                      setGlobalLngInput(preset.lng.toFixed(2));
                      onTeleportGlobal?.(preset.lat, preset.lng);
                    }
                  }}
                  className="py-1 px-1.5 rounded border border-slate-800 bg-slate-900/90 hover:border-cyan-500/40 text-[10px] text-slate-300 hover:text-cyan-200 truncate"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </form>

          <div className="space-y-1.5 pt-1 border-t border-slate-800/80 font-mono text-[10px]">
            <div className="text-slate-400 uppercase">Visor HUD Mode &amp; Quick Jump</div>
            <div className="grid grid-cols-3 gap-1.5">
              {(['minimalist', 'standard', 'verbose'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    playChirpSound();
                    onSetHudMode?.(m);
                  }}
                  className={`py-1 rounded border uppercase font-bold ${
                    hudMode === m
                      ? 'border-cyan-400 bg-cyan-500/25 text-cyan-200'
                      : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => runDebugAction('goto_hud')}
                className="py-1 rounded border border-slate-700 bg-slate-900 hover:border-cyan-500/40 text-cyan-300 font-bold flex items-center justify-center gap-1"
              >
                <Compass className="w-3 h-3" /> HUD
              </button>
              <button
                type="button"
                onClick={() => runDebugAction('goto_visor')}
                className="py-1 rounded border border-slate-700 bg-slate-900 hover:border-cyan-500/40 text-cyan-300 font-bold flex items-center justify-center gap-1"
              >
                <Activity className="w-3 h-3" /> 3D Visor
              </button>
              <button
                type="button"
                onClick={() => runDebugAction('reset_pose')}
                className="py-1 rounded border border-slate-700 bg-slate-900 hover:border-amber-500/40 text-amber-300 font-bold flex items-center justify-center gap-1"
              >
                <RotateCcw className="w-3 h-3" /> Reset
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Searchable Feature & Control Inventory Matrix */}
      <section className="rounded-xl border border-slate-800 bg-slate-950 p-5 shadow-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-cyan-400" />
            <div>
              <h3 className="font-display text-sm font-bold tracking-wider text-slate-100 uppercase">
                Feature &amp; Control Inventory Matrix ({filteredInventory.length}/{resolvedInventory.length})
              </h3>
              <p className="text-[11px] font-mono text-slate-400">
                Live audit of all HUD modules, DualSense bindings, physics loops, telemetry streams, and overrides.
              </p>
            </div>
          </div>

          {/* Search box */}
          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search feature, path, symbol..."
              className="w-full rounded-lg bg-slate-900 border border-slate-700 focus:border-cyan-400 focus:outline-none pl-8 pr-3 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-500"
            />
          </div>
        </div>

        {/* Category & Status Filters */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5 font-mono text-[11px]">
          <div className="flex flex-wrap items-center gap-1.5">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => {
                  playChirpSound();
                  setCategoryFilter(cat);
                }}
                className={`px-2.5 py-1 rounded-md border transition-colors ${
                  categoryFilter === cat
                    ? 'bg-cyan-500 text-slate-950 border-cyan-400 font-bold'
                    : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-slate-600'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {statuses.map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => {
                  playChirpSound();
                  setStatusFilter(st);
                }}
                className={`px-2 py-1 rounded-md border transition-colors ${
                  statusFilter === st
                    ? 'bg-amber-500 text-slate-950 border-amber-400 font-bold'
                    : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>

        {/* Inventory Table */}
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-900/90 border-b border-slate-800 text-[10px] font-mono uppercase tracking-wider text-slate-400">
                <th className="py-2.5 px-3">ID / Category</th>
                <th className="py-2.5 px-3">Feature &amp; Architecture</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3">File Paths &amp; Symbols</th>
                <th className="py-2.5 px-3 text-right">Debug Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-xs">
              {filteredInventory.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center font-mono text-slate-400">
                    No features match the current filter query.
                  </td>
                </tr>
              ) : (
                filteredInventory.map(({ entry, status, detail }) => (
                  <tr
                    key={entry.id}
                    className="bg-slate-950 hover:bg-slate-900/55 transition-colors align-top"
                  >
                    <td className="py-3 px-3 font-mono whitespace-nowrap">
                      <div className="text-[11px] font-bold text-cyan-300">{entry.id}</div>
                      <div className="text-[10px] text-slate-500 mt-0.5">{entry.category}</div>
                    </td>
                    <td className="py-3 px-3 min-w-[240px]">
                      <div className="font-display text-xs font-bold text-slate-100">{entry.name}</div>
                      <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{entry.summary}</p>
                    </td>
                    <td className="py-3 px-3 font-mono whitespace-nowrap">
                      <span
                        className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded border ${STATUS_BADGE_CLASS[status]}`}
                      >
                        {status.toUpperCase()}
                      </span>
                      <div className="text-[10px] text-slate-400 mt-1 max-w-[180px] whitespace-normal">
                        {detail}
                      </div>
                    </td>
                    <td className="py-3 px-3 font-mono text-[10px] min-w-[210px]">
                      <div className="space-y-0.5 text-slate-300">
                        {entry.filePaths.map((fp) => (
                          <div key={fp} className="text-cyan-200/90">
                            {fp}
                          </div>
                        ))}
                      </div>
                      <div className="text-slate-500 mt-1">{entry.symbols}</div>
                    </td>
                    <td className="py-3 px-3 text-right whitespace-nowrap">
                      {entry.debugAction ? (
                        <button
                          type="button"
                          onClick={() => runDebugAction(entry.debugAction!.id)}
                          className={`px-2.5 py-1 rounded border font-mono text-[10px] font-bold transition-colors inline-flex items-center gap-1 ${
                            ACTION_BTN_CLASS[entry.debugAction.tone ?? 'cyan']
                          }`}
                        >
                          <Zap className="w-3 h-3" />
                          <span>{entry.debugAction.label}</span>
                        </button>
                      ) : (
                        <span className="text-[10px] font-mono text-slate-600">PASSIVE AUDIT</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
