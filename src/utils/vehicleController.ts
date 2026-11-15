import {
  CustomWaypoint,
  haversineKm,
  jezeroMetersToLatLng,
  latLngToJezeroMeters,
} from './marsCoords';
import {
  WORLD_HALF_EXTENT,
  RADIATION_HOTSPOTS,
  getTerrainMetricsAt,
  jezeroLocalToLatLng,
  marsDistanceKm,
  marsBearingDeg,
  marsStepGreatCircle,
  normalizeSignedLng180,
  slerpLatLng,
  syncTerrainAnchor,
  findScenicHeadingDeg,
} from '../data/marsTerrain';
import {
  checkOlympusCliffBoundary,
  OLYMPUS_CENTER,
  OLYMPUS_BASAL_CLIFF_INNER_KM,
  OLYMPUS_BASAL_CLIFF_OUTER_KM,
} from '../data/marsClimateEngine';
import type { MarsBiomeId, SeasonalFrostMode } from '../types/telemetry';
import { dualSense } from './dualsenseController';

export type DriveDirection = 'forward' | 'backward' | 'left' | 'right';

export interface DriveInputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  analogThrottle?: number;
  analogSteer?: number;
}

export interface LiveVehiclePose {
  x: number;
  y: number;
  heading: number;
  speedMps: number;
  angularVelDegSec: number;
  wheelRotationRad: number;
  wheelSlipRatio: number;
  lat: number;
  lng: number;
  isGlobalOverride: boolean;
  isPlanetaryWarp: boolean;
  teleportEpoch: number;
  lastTeleportFromLat?: number;
  lastTeleportFromLng?: number;
  lastTeleportFromX?: number;
  lastTeleportFromY?: number;
  lastTeleportTimestampMs?: number;
}

export interface VehicleStepParams {
  locomotionMode: 'rover' | 'eva_walk';
  speedTorqueSetting: number;
  slopePercentage: number;
  dominantGeology: string;
  batteryPercentage: number;
  suitRoverIntegrityPercent: number;
}

export interface VehicleStepResult {
  deltaDistanceM: number;
  deltaHeadingDeg: number;
  linearVelocityMps: number;
  angularVelocityDegSec: number;
  wheelSlipRatio: number;
  isMoving: boolean;
}

export interface SimTargetConfig {
  id: string;
  x: number;
  y: number;
  lat: number;
  lng: number;
  isLandform?: boolean;
}

export interface SimRuntimeConfig {
  physicsEnabled: boolean;
  locomotionMode: 'rover' | 'eva_walk';
  speedTorqueSetting: number;
  batteryPercentage: number;
  suitRoverIntegrityPercent: number;
  autonomousAiPilot: boolean;
  biomeId: MarsBiomeId;
  frostMode: SeasonalFrostMode;
  targetWp: SimTargetConfig;
  customWaypoints: CustomWaypoint[];
  continueToTargetAfterWaypoints?: boolean;
}

export interface SimTenHzSnapshot {
  x: number;
  y: number;
  heading: number;
  lat: number;
  lng: number;
  isGlobalOverride: boolean;
  isPlanetaryWarp: boolean;
  speedMps: number;
  wheelSlipRatio: number;
  lastMovedTimestamp: number;
  path: Array<{ x: number; y: number }> | null;
  isRestingCommit: boolean;
  aiPilotDisengaged: boolean;
  reenteredJezero: boolean;
  cliffBlockedReason: string | null;
  watchdogRecoveryNotice: string | null;
  arrivedCustomWpId: number | null;
  arrivedTarget: boolean;
}

export type ViewportFrameCallback = (dt: number, nowMs: number, pose: LiveVehiclePose) => void;
export type HudFrameListener = (dt: number, nowMs: number, pose: LiveVehiclePose) => void;
export type TenHzCommitCallback = (snapshot: SimTenHzSnapshot) => void;

const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.05;
const MAX_SUBSTEPS_PER_FRAME = 6;
const WHEEL_RADIUS_M = 0.44;
const TELEMETRY_COMMIT_INTERVAL_MS = 100; // 10 Hz React commit rate

function expDamp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function wrapAngleDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function shortestAngleDiffDeg(fromDeg: number, toDeg: number): number {
  let diff = toDeg - fromDeg;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return diff;
}

/**
 * Delta-time scaled manual vehicle & EVA physics controller with momentum,
 * acceleration ramping, braking, and exponential coasting/steering damping.
 */
export class VehiclePhysicsController {
  public linearVelocityMps = 0;
  public angularVelocityDegSec = 0;

  public reset(): void {
    this.linearVelocityMps = 0;
    this.angularVelocityDegSec = 0;
  }

  public stopLinear(): void {
    this.linearVelocityMps = 0;
  }

  public isActive(input: DriveInputState): boolean {
    return (
      input.forward ||
      input.backward ||
      input.left ||
      input.right ||
      Math.abs(input.analogThrottle ?? 0) > 0.04 ||
      Math.abs(input.analogSteer ?? 0) > 0.04 ||
      Math.abs(this.linearVelocityMps) > 0.025 ||
      Math.abs(this.angularVelocityDegSec) > 0.18
    );
  }

  public step(dtRaw: number, input: DriveInputState, params: VehicleStepParams): VehicleStepResult {
    const dt = Math.min(Math.max(dtRaw, 0), MAX_FRAME_DT);
    const isRover = params.locomotionMode === 'rover';
    const torqueMult = Math.max(0.5, params.speedTorqueSetting);

    const looseFactor =
      params.dominantGeology === 'LOOSE_REGOLITH' || params.dominantGeology === 'AEOLIAN_RIPPLES'
        ? 1.0
        : 0.45;
    const wheelSlipRatio = Math.min(
      0.72,
      Math.max(0, ((params.slopePercentage - 8) / 28) * looseFactor * (0.6 + torqueMult * 0.35))
    );

    const lowBatMult = params.batteryPercentage < 15 ? 0.65 : 1.0;
    const lowIntegrityMult = params.suitRoverIntegrityPercent < 50 ? 0.7 : 1.0;

    const maxForwardMps =
      (isRover ? 22.0 : 8.5) * torqueMult * (1 - wheelSlipRatio * 0.48) * lowBatMult * lowIntegrityMult;
    const maxReverseMps = maxForwardMps * 0.62;
    const maxTurnDegSec = (isRover ? 82 : 112) * (0.85 + 0.15 * torqueMult) * lowBatMult;

    const digitalThrottle = (input.forward ? 1 : 0) - (input.backward ? 1 : 0);
    const digitalSteer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    const throttleAxis = Math.max(-1, Math.min(1, digitalThrottle + (input.analogThrottle ?? 0)));
    const steerAxis = Math.max(-1, Math.min(1, digitalSteer + (input.analogSteer ?? 0)));

    const targetLinearMps =
      throttleAxis > 0
        ? throttleAxis * maxForwardMps
        : throttleAxis < 0
          ? throttleAxis * maxReverseMps
          : 0;
    const targetAngularDegSec = steerAxis * maxTurnDegSec;

    if (throttleAxis !== 0) {
      const opposingMotion =
        Math.sign(targetLinearMps) !== 0 &&
        Math.sign(this.linearVelocityMps) !== 0 &&
        Math.sign(targetLinearMps) !== Math.sign(this.linearVelocityMps);
      const accelLambda = opposingMotion ? (isRover ? 9.5 : 13.0) : isRover ? 4.4 : 7.8;
      this.linearVelocityMps = expDamp(this.linearVelocityMps, targetLinearMps, accelLambda, dt);
    } else {
      const coastLambda = isRover ? 4.8 : 9.2;
      this.linearVelocityMps = expDamp(this.linearVelocityMps, 0, coastLambda, dt);
      if (Math.abs(this.linearVelocityMps) < 0.025) {
        this.linearVelocityMps = 0;
      }
    }

    if (steerAxis !== 0) {
      const steerAccelLambda = isRover ? 8.5 : 12.5;
      this.angularVelocityDegSec = expDamp(
        this.angularVelocityDegSec,
        targetAngularDegSec,
        steerAccelLambda,
        dt
      );
    } else {
      const steerCoastLambda = isRover ? 10.5 : 14.0;
      this.angularVelocityDegSec = expDamp(this.angularVelocityDegSec, 0, steerCoastLambda, dt);
      if (Math.abs(this.angularVelocityDegSec) < 0.18) {
        this.angularVelocityDegSec = 0;
      }
    }

    const deltaDistanceM = this.linearVelocityMps * dt;
    const deltaHeadingDeg = this.angularVelocityDegSec * dt;
    const isMoving =
      Math.abs(this.linearVelocityMps) > 0.025 || Math.abs(this.angularVelocityDegSec) > 0.18;

    return {
      deltaDistanceM,
      deltaHeadingDeg,
      linearVelocityMps: this.linearVelocityMps,
      angularVelocityDegSec: this.angularVelocityDegSec,
      wheelSlipRatio,
      isMoving,
    };
  }
}

interface InternalPhysicsState {
  x: number;
  y: number;
  heading: number;
  lat: number;
  lng: number;
  speedMps: number;
  angularVelDegSec: number;
  wheelRotationRad: number;
  wheelSlipRatio: number;
  isGlobalOverride: boolean;
  isPlanetaryWarp: boolean;
}

/**
 * Single Source of Truth Simulation Engine & Unified Master rAF Scheduler.
 *
 * - Owns all mutable physics, position, velocity, heading, wheel rotation, and Set-based inputs.
 * - Integrates at fixed 120 Hz steps (with clamped frame dt <= 0.05s) and interpolates per-frame pose.
 * - Drives 3D WebGL render + HUD listeners immediately after physics in the EXACT same rAF tick.
 * - Throttles React state/telemetry commits strictly to 10 Hz (every 100ms).
 */
class VehicleSimulationEngine {
  private readonly controller = new VehiclePhysicsController();

  // Synchronous input Sets (NEVER cause React re-renders on keydown/keyup or pointerdown/pointerup)
  private readonly heldKeys = new Map<string, DriveDirection>();
  private readonly heldButtons = new Map<string, DriveDirection>();
  private readonly tapPulseUntil: Record<DriveDirection, number> = {
    forward: 0,
    backward: 0,
    left: 0,
    right: 0,
  };

  private prevState: InternalPhysicsState;
  private currState: InternalPhysicsState;
  private breadcrumbPath: Array<{ x: number; y: number }>;
  private pathDirty = false;
  private teleportEpoch = 0;

  // Mutable ref object shared directly with Three.js / Canvas / Leaflet consumers
  public readonly poseRef: { current: LiveVehiclePose };

  private config: SimRuntimeConfig = {
    physicsEnabled: true,
    locomotionMode: 'rover',
    speedTorqueSetting: 1.0,
    batteryPercentage: 81.4,
    suitRoverIntegrityPercent: 100,
    autonomousAiPilot: false,
    biomeId: 'JEZERO_CRATER',
    frostMode: 'SUBLIMATION',
    targetWp: {
      id: 'WP-DELTA-04',
      x: -580,
      y: 860,
      lat: 18.454,
      lng: 77.441,
      isLandform: false,
    },
    customWaypoints: [],
    continueToTargetAfterWaypoints: false,
  };

  // Master rAF loop & subscribers
  private rafId = 0;
  private running = false;
  private lastRafMs = 0;
  private accumulator = 0;
  private lastCommitMs = 0;
  private lastMovedWallMs = 0;
  private lastBoundaryWallMs = 0;
  private dirtyForReact = false;
  private wasMovingLastFrame = false;

  // DualSense override sustain timer (prevents stick jitter from killing autopilot)
  private gamepadOverrideStartMs = 0;

  // Self-healing Expedition Watchdog state (>2s stall detector & Slerp leg recalculator)
  private watchdogLegKey = '';
  private watchdogBestDistMeters = Infinity;
  private watchdogLastProgressWallMs = 0;
  private watchdogLastRecoveryWallMs = 0;
  private watchdogRecoveryCount = 0;

  // Pending discrete events flushed on the 10 Hz React commit
  private pendingAiPilotDisengaged = false;
  private pendingReenteredJezero = false;
  private pendingCliffReason: string | null = null;
  private pendingWatchdogNotice: string | null = null;
  private pendingArrivedCustomWpId: number | null = null;
  private pendingArrivedTarget = false;

  private viewportCallback: ViewportFrameCallback | null = null;
  private readonly hudListeners = new Set<HudFrameListener>();
  private tenHzCommitCallback: TenHzCommitCallback | null = null;
  private onFreshInputPressCallback: (() => void) | null = null;

  constructor(initialX = 120, initialY = 160, initialHeading = 318) {
    const ll = jezeroLocalToLatLng(initialX, initialY);
    this.prevState = {
      x: initialX,
      y: initialY,
      heading: initialHeading,
      lat: ll.lat,
      lng: ll.lng,
      speedMps: 0,
      angularVelDegSec: 0,
      wheelRotationRad: 0,
      wheelSlipRatio: 0,
      isGlobalOverride: false,
      isPlanetaryWarp: false,
    };
    this.currState = { ...this.prevState };
    this.breadcrumbPath = [{ x: initialX, y: initialY }];
    this.poseRef = {
      current: {
        ...this.currState,
        teleportEpoch: 0,
        lastTeleportFromLat: ll.lat,
        lastTeleportFromLng: ll.lng,
        lastTeleportFromX: initialX,
        lastTeleportFromY: initialY,
        lastTeleportTimestampMs: 0,
      },
    };
  }

  public setTenHzCommitCallback(cb: TenHzCommitCallback | null): void {
    this.tenHzCommitCallback = cb;
  }

  public setFreshInputPressCallback(cb: (() => void) | null): void {
    this.onFreshInputPressCallback = cb;
  }

  public setViewportCallback(cb: ViewportFrameCallback | null): void {
    this.viewportCallback = cb;
  }

  public addHudFrameListener(listener: HudFrameListener): () => void {
    this.hudListeners.add(listener);
    return () => {
      this.hudListeners.delete(listener);
    };
  }

  public syncConfig(patch: Partial<SimRuntimeConfig>): void {
    const prevAi = this.config.autonomousAiPilot;
    Object.assign(this.config, patch);
    if (patch.autonomousAiPilot === true && !prevAi) {
      // Clear any leftover manual tap pulses when AI pilot engages
      this.tapPulseUntil.forward = 0;
      this.tapPulseUntil.backward = 0;
      this.tapPulseUntil.left = 0;
      this.tapPulseUntil.right = 0;
      this.gamepadOverrideStartMs = 0;
      this.pendingArrivedTarget = false;
      this.pendingArrivedCustomWpId = null;
      this.pendingWatchdogNotice = null;
      this.watchdogLegKey = '';
      this.watchdogBestDistMeters = Infinity;
      this.watchdogLastProgressWallMs = Date.now();
      this.watchdogRecoveryCount = 0;
    } else if (patch.autonomousAiPilot === false && prevAi) {
      this.gamepadOverrideStartMs = 0;
      this.watchdogLegKey = '';
    }
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.lastRafMs = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.masterTick);
  }

  public stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  public setKeyHeld(code: string, dir: DriveDirection, active: boolean): void {
    const prevActive = this.hasDirectionHeld(dir);
    if (active) {
      this.heldKeys.set(code, dir);
      this.onManualInputActivated(prevActive);
    } else {
      this.heldKeys.delete(code);
    }
  }

  public setButtonHeld(buttonId: string, dir: DriveDirection, active: boolean): void {
    const prevActive = this.hasDirectionHeld(dir);
    if (active) {
      this.heldButtons.set(buttonId, dir);
      this.onManualInputActivated(prevActive);
    } else {
      this.heldButtons.delete(buttonId);
    }
  }

  public triggerTapPulse(dir: DriveDirection, durationMs = 150): void {
    const prevActive = this.hasDirectionHeld(dir);
    this.tapPulseUntil[dir] = Math.max(this.tapPulseUntil[dir], performance.now() + durationMs);
    this.onManualInputActivated(prevActive);
  }

  public clearAllInputs(): void {
    this.heldKeys.clear();
    this.heldButtons.clear();
    this.tapPulseUntil.forward = 0;
    this.tapPulseUntil.backward = 0;
    this.tapPulseUntil.left = 0;
    this.tapPulseUntil.right = 0;
  }

  private hasDirectionHeld(dir: DriveDirection): boolean {
    for (const d of this.heldKeys.values()) {
      if (d === dir) return true;
    }
    for (const d of this.heldButtons.values()) {
      if (d === dir) return true;
    }
    return false;
  }

  private onManualInputActivated(wasDirectionAlreadyHeld: boolean): void {
    if (this.config.autonomousAiPilot) {
      this.config.autonomousAiPilot = false;
      this.pendingAiPilotDisengaged = true;
      this.dirtyForReact = true;
    }
    if (!wasDirectionAlreadyHeld) {
      this.onFreshInputPressCallback?.();
    }
  }

  private readDriveInput(nowMs: number): DriveInputState {
    let forward = nowMs < this.tapPulseUntil.forward;
    let backward = nowMs < this.tapPulseUntil.backward;
    let left = nowMs < this.tapPulseUntil.left;
    let right = nowMs < this.tapPulseUntil.right;

    for (const d of this.heldKeys.values()) {
      if (d === 'forward') forward = true;
      else if (d === 'backward') backward = true;
      else if (d === 'left') left = true;
      else if (d === 'right') right = true;
    }
    for (const d of this.heldButtons.values()) {
      if (d === 'forward') forward = true;
      else if (d === 'backward') backward = true;
      else if (d === 'left') left = true;
      else if (d === 'right') right = true;
    }

    const ds = dualSense.inputRef.current;
    const analogThrottle = ds.connected ? ds.throttle : 0;
    const analogSteer = ds.connected ? ds.steerX : 0;

    // Require deliberate sustained DualSense stick/trigger deflection (>240ms, outside cursor mode)
    // so minor resting stick drift or UI navigation never cancels a long-distance expedition.
    if (this.config.autonomousAiPilot && this.config.physicsEnabled && !ds.cursorMode) {
      const deliberateManual = Math.abs(analogThrottle) > 0.35 || Math.abs(analogSteer) > 0.38;
      if (deliberateManual) {
        if (this.gamepadOverrideStartMs === 0) {
          this.gamepadOverrideStartMs = nowMs;
        } else if (nowMs - this.gamepadOverrideStartMs >= 240) {
          this.gamepadOverrideStartMs = 0;
          this.onManualInputActivated(false);
        }
      } else {
        this.gamepadOverrideStartMs = 0;
      }
    } else {
      this.gamepadOverrideStartMs = 0;
    }

    return { forward, backward, left, right, analogThrottle, analogSteer };
  }

  public teleportLocal(
    x: number,
    y: number,
    heading?: number,
    resetPath = true
  ): void {
    const prevLat = this.currState.lat;
    const prevLng = this.currState.lng;
    const prevX = this.currState.x;
    const prevY = this.currState.y;

    this.controller.reset();
    const hdg = heading !== undefined ? wrapAngleDeg(heading) : this.currState.heading;
    const ll = jezeroLocalToLatLng(x, y);
    this.currState = {
      x,
      y,
      heading: hdg,
      lat: ll.lat,
      lng: ll.lng,
      speedMps: 0,
      angularVelDegSec: 0,
      wheelRotationRad: this.currState.wheelRotationRad,
      wheelSlipRatio: 0,
      isGlobalOverride: false,
      isPlanetaryWarp: false,
    };
    this.prevState = { ...this.currState };
    this.accumulator = 0;
    this.wasMovingLastFrame = false;
    this.dirtyForReact = false;
    this.pendingArrivedTarget = false;
    this.pendingArrivedCustomWpId = null;
    this.pendingCliffReason = null;
    this.pendingReenteredJezero = false;
    if (resetPath) {
      this.breadcrumbPath = [{ x, y }];
    } else {
      this.breadcrumbPath = [...this.breadcrumbPath, { x, y }];
    }
    this.teleportEpoch += 1;
    this.poseRef.current.lastTeleportFromLat = prevLat;
    this.poseRef.current.lastTeleportFromLng = prevLng;
    this.poseRef.current.lastTeleportFromX = prevX;
    this.poseRef.current.lastTeleportFromY = prevY;
    this.poseRef.current.lastTeleportTimestampMs = performance.now();
    this.writePoseRef(1);
  }

  public teleportGlobal(lat: number, lng: number): void {
    const prevLat = this.currState.lat;
    const prevLng = this.currState.lng;
    const prevX = this.currState.x;
    const prevY = this.currState.y;

    this.controller.reset();
    // Face the biggest real mountain/escarpment nearby so the arrival view shows terrain relief.
    const scenicHeading = findScenicHeadingDeg(lat, lng);
    this.currState = {
      ...this.currState,
      heading: scenicHeading !== null ? scenicHeading : this.currState.heading,
      lat,
      lng,
      speedMps: 0,
      angularVelDegSec: 0,
      wheelSlipRatio: 0,
      isGlobalOverride: true,
      isPlanetaryWarp: false,
    };
    this.prevState = { ...this.currState };
    this.accumulator = 0;
    this.wasMovingLastFrame = false;
    this.dirtyForReact = false;
    this.pendingArrivedTarget = false;
    this.pendingArrivedCustomWpId = null;
    this.pendingCliffReason = null;
    this.teleportEpoch += 1;
    this.poseRef.current.lastTeleportFromLat = prevLat;
    this.poseRef.current.lastTeleportFromLng = prevLng;
    this.poseRef.current.lastTeleportFromX = prevX;
    this.poseRef.current.lastTeleportFromY = prevY;
    this.poseRef.current.lastTeleportTimestampMs = performance.now();
    this.writePoseRef(1);
  }

  public getBreadcrumbPathSnapshot(): Array<{ x: number; y: number }> {
    return this.breadcrumbPath.slice();
  }

  private pushBreadcrumb(x: number, y: number): void {
    const lastPt = this.breadcrumbPath[this.breadcrumbPath.length - 1];
    if (!lastPt || Math.hypot(x - lastPt.x, y - lastPt.y) > 16) {
      this.breadcrumbPath.push({ x, y });
      if (this.breadcrumbPath.length > 900) {
        this.breadcrumbPath.shift();
      }
      this.pathDirty = true;
    }
  }

  private writePoseRef(alpha: number): void {
    const p = this.prevState;
    const c = this.currState;
    const pose = this.poseRef.current;

    const hDiff = shortestAngleDiffDeg(p.heading, c.heading);
    const lngDiff = shortestAngleDiffDeg(p.lng, c.lng);
    pose.x = p.x + (c.x - p.x) * alpha;
    pose.y = p.y + (c.y - p.y) * alpha;
    pose.heading = wrapAngleDeg(p.heading + hDiff * alpha);
    pose.speedMps = p.speedMps + (c.speedMps - p.speedMps) * alpha;
    pose.angularVelDegSec = p.angularVelDegSec + (c.angularVelDegSec - p.angularVelDegSec) * alpha;
    pose.wheelRotationRad = p.wheelRotationRad + (c.wheelRotationRad - p.wheelRotationRad) * alpha;
    pose.wheelSlipRatio = c.wheelSlipRatio;
    pose.lat = Math.max(-90, Math.min(90, p.lat + (c.lat - p.lat) * alpha));
    pose.lng = normalizeSignedLng180(p.lng + lngDiff * alpha);
    pose.isGlobalOverride = c.isGlobalOverride;
    pose.isPlanetaryWarp = c.isPlanetaryWarp;
    pose.teleportEpoch = this.teleportEpoch;
    // Keep the real-DEM terrain frame centered on the rover's actual lat/lng.
    syncTerrainAnchor(c.isGlobalOverride, c.lat, c.lng, c.x, c.y, c.isPlanetaryWarp);
  }

  private stepFixed(dt: number, nowMs: number, input: DriveInputState): boolean {
    if (this.config.autonomousAiPilot) {
      return this.stepAutopilotFixed(dt, nowMs);
    }

    if (!this.controller.isActive(input)) {
      this.currState.speedMps = 0;
      this.currState.angularVelDegSec = 0;
      this.currState.wheelSlipRatio = 0;
      this.currState.isPlanetaryWarp = false;
      return false;
    }

    const activeBiome = this.currState.isGlobalOverride ? this.config.biomeId : 'JEZERO_CRATER';
    const currentMetrics = getTerrainMetricsAt(
      this.currState.x,
      this.currState.y,
      activeBiome,
      this.config.frostMode
    );

    const stepRes = this.controller.step(dt, input, {
      locomotionMode: this.config.locomotionMode,
      speedTorqueSetting: this.config.speedTorqueSetting,
      slopePercentage: currentMetrics.slopePercentage,
      dominantGeology: currentMetrics.geology,
      batteryPercentage: this.config.batteryPercentage,
      suitRoverIntegrityPercent: this.config.suitRoverIntegrityPercent,
    });

    const newHeading = wrapAngleDeg(this.currState.heading + stepRes.deltaHeadingDeg);
    let newX = this.currState.x;
    let newY = this.currState.y;
    let nextLat = this.currState.lat;
    let nextLng = this.currState.lng;
    let nextGlobalOverride = this.currState.isGlobalOverride;

    if (Math.abs(stepRes.deltaDistanceM) > 1e-5) {
      const moveBearing = stepRes.deltaDistanceM >= 0 ? newHeading : wrapAngleDeg(newHeading + 180);
      const moveDist = Math.abs(stepRes.deltaDistanceM);

      if (nextGlobalOverride) {
        const curLatLng = { lat: this.currState.lat, lng: this.currState.lng };
        const candidateLatLng = marsStepGreatCircle(curLatLng, moveBearing, moveDist);
        const cliffCheck = checkOlympusCliffBoundary(curLatLng, candidateLatLng);

        if (!cliffCheck.allowed) {
          this.controller.stopLinear();
          nextLat = cliffCheck.clampedLatLng.lat;
          nextLng = cliffCheck.clampedLatLng.lng;
          const wallNow = Date.now();
          if (wallNow - this.lastBoundaryWallMs > 2200) {
            this.lastBoundaryWallMs = wallNow;
            this.pendingCliffReason =
              cliffCheck.reason ?? 'Sheer basaltic scarp blocks ground traversal.';
          }
        } else {
          const localM = latLngToJezeroMeters(candidateLatLng.lat, candidateLatLng.lng);
          const limit = WORLD_HALF_EXTENT - 90;
          const reenteredJezero =
            Math.abs(localM.x) <= limit && Math.abs(localM.y) <= limit;

          if (reenteredJezero) {
            nextGlobalOverride = false;
            newX = localM.x;
            newY = localM.y;
            nextLat = candidateLatLng.lat;
            nextLng = candidateLatLng.lng;
            this.breadcrumbPath = [{ x: newX, y: newY }];
            this.pathDirty = true;
            this.pendingReenteredJezero = true;
          } else {
            nextLat = candidateLatLng.lat;
            nextLng = candidateLatLng.lng;
            const rad = (newHeading * Math.PI) / 180;
            newX += Math.sin(rad) * stepRes.deltaDistanceM;
            newY += Math.cos(rad) * stepRes.deltaDistanceM;
          }
        }
      } else {
        const rad = (newHeading * Math.PI) / 180;
        newX += Math.sin(rad) * stepRes.deltaDistanceM;
        newY += Math.cos(rad) * stepRes.deltaDistanceM;
      }
    }

    if (!nextGlobalOverride) {
      const limit = WORLD_HALF_EXTENT - 90;
      newX = Math.max(-limit, Math.min(limit, newX));
      newY = Math.max(-limit, Math.min(limit, newY));
      const ll = jezeroLocalToLatLng(newX, newY);
      nextLat = ll.lat;
      nextLng = ll.lng;

      const lastPt = this.breadcrumbPath[this.breadcrumbPath.length - 1];
      if (!lastPt || Math.hypot(newX - lastPt.x, newY - lastPt.y) > 16) {
        this.pushBreadcrumb(newX, newY);
      }
    }

    const slipBoost = 1 + stepRes.wheelSlipRatio * 1.6;
    this.currState.x = newX;
    this.currState.y = newY;
    this.currState.heading = newHeading;
    this.currState.lat = nextLat;
    this.currState.lng = nextLng;
    this.currState.speedMps = stepRes.linearVelocityMps;
    this.currState.angularVelDegSec = stepRes.angularVelocityDegSec;
    this.currState.wheelRotationRad += (stepRes.linearVelocityMps / WHEEL_RADIUS_M) * dt * slipBoost;
    this.currState.wheelSlipRatio = stepRes.wheelSlipRatio;
    this.currState.isGlobalOverride = nextGlobalOverride;
    this.currState.isPlanetaryWarp = false;

    if (stepRes.isMoving) {
      this.lastMovedWallMs = Date.now();
      dualSense.hapticSlopeSlip(
        stepRes.wheelSlipRatio,
        currentMetrics.slopePercentage,
        stepRes.linearVelocityMps
      );
    }
    this.dirtyForReact = true;
    return stepRes.isMoving;
  }

  private computeCruiseSpeedMps(
    distMeters: number,
    isRover: boolean,
    torqueMult: number,
    lowBatMult: number,
    lowIntegrityMult: number
  ): number {
    if (distMeters > 200_000) return 240_000;
    if (distMeters > 10_000) return 18_000;
    if (distMeters > 1_800) return 1_400;
    const localMax = (isRover ? 52 : 22) * torqueMult * lowBatMult * lowIntegrityMult;
    if (distMeters < 60) {
      return Math.min(localMax, Math.max(5, distMeters * 1.35));
    }
    return localMax;
  }

  /**
   * Resolves Olympus Mons 8 km basal cliff encounters without halting long-distance expeditions:
   * - Same-side transit: steers tangentially along the outer cliff perimeter (321 km safe corridor).
   * - Cross-scarp destination (landing on or departing Olympus plateau): engages Orbital-Hop Slerp breach.
   */
  private resolveGlobalTerrainStep(
    from: { lat: number; lng: number },
    target: { lat: number; lng: number },
    desiredBearing: number,
    stepBearing: number,
    stepM: number,
    totalDistMeters: number
  ): {
    nextLatLng: { lat: number; lng: number };
    usedDetourBearing: number;
    cliffAdvisory: string | null;
  } {
    const rawNext = marsStepGreatCircle(from, stepBearing, stepM);
    const cliffCheck = checkOlympusCliffBoundary(from, rawNext);
    if (cliffCheck.allowed) {
      return { nextLatLng: rawNext, usedDetourBearing: stepBearing, cliffAdvisory: null };
    }

    const fromDistKm = marsDistanceKm(from, OLYMPUS_CENTER);
    const targetDistKm = marsDistanceKm(target, OLYMPUS_CENTER);
    const fromOutside = fromDistKm > OLYMPUS_BASAL_CLIFF_OUTER_KM;
    const targetOutside = targetDistKm > OLYMPUS_BASAL_CLIFF_OUTER_KM;
    const fromInside = fromDistKm < OLYMPUS_BASAL_CLIFF_INNER_KM;
    const targetInside = targetDistKm < OLYMPUS_BASAL_CLIFF_INNER_KM;

    // Both endpoints are outside the shield plateau -> skirt tangentially around the 321 km perimeter
    if (fromOutside && targetOutside) {
      const radialFromCenter = marsBearingDeg(OLYMPUS_CENTER, from);
      const cwTangent = wrapAngleDeg(radialFromCenter + 90);
      const ccwTangent = wrapAngleDeg(radialFromCenter - 90);
      const tangentBrg =
        Math.abs(shortestAngleDiffDeg(desiredBearing, cwTangent)) <=
        Math.abs(shortestAngleDiffDeg(desiredBearing, ccwTangent))
          ? cwTangent
          : ccwTangent;

      // Gently nudge outward to keep a ~6 km clearance buffer off the basal scarp
      const outwardSign = fromDistKm < OLYMPUS_BASAL_CLIFF_OUTER_KM + 6 ? 12 : 0;
      const steerTangent =
        tangentBrg === cwTangent
          ? wrapAngleDeg(tangentBrg - outwardSign)
          : wrapAngleDeg(tangentBrg + outwardSign);

      const detourNext = marsStepGreatCircle(from, steerTangent, stepM);
      if (checkOlympusCliffBoundary(from, detourNext).allowed) {
        return {
          nextLatLng: detourNext,
          usedDetourBearing: steerTangent,
          cliffAdvisory:
            'OLYMPUS CLIFF DETOUR ACTIVE: Rerouting tangentially around 8 km basal escarpment.',
        };
      }
    }

    // Cross-scarp expedition (ascending onto or descending off Olympus shield) -> Orbital-Hop Slerp bridge
    const frac = Math.min(1, Math.max(1e-6, stepM / Math.max(1, totalDistMeters)));
    const bridgeNext = slerpLatLng(from, target, frac);
    const hopNotice =
      fromInside && !targetInside
        ? 'ORBITAL-HOP SCARP DESCENT: Bridging 8 km Olympus Mons basal cliff via Slerp trajectory.'
        : !fromInside && targetInside
          ? 'ORBITAL-HOP SCARP ASCENT: Bridging 8 km Olympus Mons basal cliff to shield plateau.'
          : 'SLOPE-SMOOTHING DETOUR: Bypassing steep basaltic escarpment via Slerp arc.';

    return {
      nextLatLng: bridgeNext,
      usedDetourBearing: marsBearingDeg(from, bridgeNext),
      cliffAdvisory: hopNotice,
    };
  }

  private runExpeditionWatchdog(
    legKey: string,
    currentLatLng: { lat: number; lng: number },
    targetLatLng: { lat: number; lng: number },
    remainingMeters: number,
    arrivalThresholdM: number
  ): { recovered: boolean; nextLatLng: { lat: number; lng: number }; nextHeading: number } {
    const wallNow = Date.now();

    // Guard against NaN / Infinity / polar coordinate corruption
    if (
      !Number.isFinite(currentLatLng.lat) ||
      !Number.isFinite(currentLatLng.lng) ||
      !Number.isFinite(remainingMeters)
    ) {
      const safeLat = Number.isFinite(this.prevState.lat)
        ? Math.max(-90, Math.min(90, this.prevState.lat))
        : targetLatLng.lat;
      const safeLng = Number.isFinite(this.prevState.lng)
        ? normalizeSignedLng180(this.prevState.lng)
        : normalizeSignedLng180(targetLatLng.lng);
      const recoveredPt = slerpLatLng({ lat: safeLat, lng: safeLng }, targetLatLng, 0.05);
      this.controller.reset();
      this.watchdogLastProgressWallMs = wallNow;
      this.watchdogLastRecoveryWallMs = wallNow;
      this.watchdogRecoveryCount += 1;
      this.pendingWatchdogNotice =
        'Coordinate anomaly detected — Watchdog restored spherical Slerp leg traversal.';
      this.dirtyForReact = true;
      return {
        recovered: true,
        nextLatLng: recoveredPt,
        nextHeading: marsBearingDeg(recoveredPt, targetLatLng),
      };
    }

    if (legKey !== this.watchdogLegKey) {
      this.watchdogLegKey = legKey;
      this.watchdogBestDistMeters = remainingMeters;
      this.watchdogLastProgressWallMs = wallNow;
      this.watchdogRecoveryCount = 0;
      return { recovered: false, nextLatLng: currentLatLng, nextHeading: this.currState.heading };
    }

    const minProgressM = Math.max(0.35, this.watchdogBestDistMeters * 0.00025);
    if (remainingMeters < this.watchdogBestDistMeters - minProgressM) {
      this.watchdogBestDistMeters = remainingMeters;
      this.watchdogLastProgressWallMs = wallNow;
      return { recovered: false, nextLatLng: currentLatLng, nextHeading: this.currState.heading };
    }

    // Stall threshold: > 2.0 seconds with no net progress toward destination
    if (
      remainingMeters > arrivalThresholdM &&
      wallNow - this.watchdogLastProgressWallMs > 2000 &&
      wallNow - this.watchdogLastRecoveryWallMs > 1200
    ) {
      this.watchdogLastRecoveryWallMs = wallNow;
      this.watchdogLastProgressWallMs = wallNow;
      this.watchdogRecoveryCount += 1;
      this.controller.reset();

      const hopMeters =
        remainingMeters > 1800
          ? Math.min(remainingMeters - arrivalThresholdM * 0.5, Math.max(600, remainingMeters * 0.08))
          : Math.min(remainingMeters - arrivalThresholdM * 0.4, Math.max(30, remainingMeters * 0.25));
      const frac = Math.min(1, Math.max(0.01, hopMeters / Math.max(1, remainingMeters)));
      const recoveredPt = slerpLatLng(currentLatLng, targetLatLng, frac);
      const nextDistM = marsDistanceKm(recoveredPt, targetLatLng) * 1000;
      this.watchdogBestDistMeters = nextDistM;

      this.pendingWatchdogNotice = `Stall detected (>2.0s) — Watchdog recalculated remaining leg (${(
        nextDistM / 1000
      ).toFixed(1)} km) via Spherical Slerp (#${this.watchdogRecoveryCount}).`;
      this.dirtyForReact = true;

      return {
        recovered: true,
        nextLatLng: recoveredPt,
        nextHeading: marsBearingDeg(recoveredPt, targetLatLng),
      };
    }

    return { recovered: false, nextLatLng: currentLatLng, nextHeading: this.currState.heading };
  }

  private stepAutopilotFixed(dt: number, _nowMs: number): boolean {
    const isRover = this.config.locomotionMode === 'rover';
    const torqueMult = Math.max(0.5, this.config.speedTorqueSetting);
    const lowBatMult = this.config.batteryPercentage < 15 ? 0.65 : 1.0;
    const lowIntegrityMult = this.config.suitRoverIntegrityPercent < 50 ? 0.7 : 1.0;

    let currentLatLng = {
      lat: Math.max(-90, Math.min(90, this.currState.lat)),
      lng: normalizeSignedLng180(this.currState.lng),
    };
    const customWps = this.config.customWaypoints;

    let activeCustom: CustomWaypoint | null = null;
    let minCustomKm = Infinity;
    for (let i = 0; i < customWps.length; i++) {
      const w = customWps[i];
      const d = haversineKm(currentLatLng, w);
      if (d < minCustomKm) {
        minCustomKm = d;
        activeCustom = w;
      }
    }

    const customArrivalM = 25;
    if (activeCustom && minCustomKm * 1000 <= customArrivalM) {
      this.pendingArrivedCustomWpId = activeCustom.id;
      this.dirtyForReact = true;
      const remaining = customWps.filter(
        (w) => w.id !== activeCustom!.id && haversineKm(currentLatLng, w) * 1000 > customArrivalM
      );
      this.config.customWaypoints = remaining;
      if (remaining.length === 0) {
        if (this.config.continueToTargetAfterWaypoints) {
          // Proceed seamlessly to Phase 2 primary target leg
          activeCustom = null;
        } else {
          this.controller.reset();
          this.currState.speedMps = 0;
          this.currState.angularVelDegSec = 0;
          this.currState.isPlanetaryWarp = false;
          this.config.autonomousAiPilot = false;
          this.pendingAiPilotDisengaged = true;
          return false;
        }
      } else {
        // Continue immediately toward nearest remaining waypoint
        let nextWp = remaining[0];
        let nextMinKm = Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const d = haversineKm(currentLatLng, remaining[i]);
          if (d < nextMinKm) {
            nextMinKm = d;
            nextWp = remaining[i];
          }
        }
        activeCustom = nextWp;
      }
    }

    const limit = WORLD_HALF_EXTENT - 90;

    // Phase 1: Custom / Corridor Waypoint Queue Traverse (Spherical Great-Circle + Local Jezero)
    if (activeCustom) {
      const customTargetLL = { lat: activeCustom.lat, lng: normalizeSignedLng180(activeCustom.lng) };
      const customDistMeters = marsDistanceKm(currentLatLng, customTargetLL) * 1000;
      const watchdog = this.runExpeditionWatchdog(
        `custom:${activeCustom.id}`,
        currentLatLng,
        customTargetLL,
        customDistMeters,
        22
      );
      if (watchdog.recovered) {
        currentLatLng = watchdog.nextLatLng;
        const localM = latLngToJezeroMeters(currentLatLng.lat, currentLatLng.lng);
        const insideJezero = Math.abs(localM.x) <= limit && Math.abs(localM.y) <= limit;
        this.currState.lat = currentLatLng.lat;
        this.currState.lng = currentLatLng.lng;
        this.currState.heading = watchdog.nextHeading;
        this.currState.isGlobalOverride = !insideJezero;
        if (insideJezero) {
          this.currState.x = localM.x;
          this.currState.y = localM.y;
          this.pushBreadcrumb(localM.x, localM.y);
        }
        this.lastMovedWallMs = Date.now();
        this.dirtyForReact = true;
        return true;
      }

      const customLocalM = latLngToJezeroMeters(customTargetLL.lat, customTargetLL.lng);
      const customTargetOutsideJezero =
        Math.abs(customLocalM.x) > limit || Math.abs(customLocalM.y) > limit;
      const isGlobalCustomLeg =
        this.currState.isGlobalOverride || customDistMeters > 1800 || customTargetOutsideJezero;

      if (isGlobalCustomLeg) {
        const desiredBearing = marsBearingDeg(currentLatLng, customTargetLL);
        const diff = shortestAngleDiffDeg(this.currState.heading, desiredBearing);
        const targetAngVel = Math.max(-320, Math.min(320, diff * 9.0));
        this.controller.angularVelocityDegSec = expDamp(
          this.controller.angularVelocityDegSec,
          targetAngVel,
          14,
          dt
        );
        const newHeading = wrapAngleDeg(
          this.currState.heading + this.controller.angularVelocityDegSec * dt
        );

        const turnFactor = Math.max(0.32, Math.cos((diff * Math.PI) / 180));
        const cruiseSpeedMps = this.computeCruiseSpeedMps(
          customDistMeters,
          isRover,
          torqueMult,
          lowBatMult,
          lowIntegrityMult
        );

        const stepBearing =
          customDistMeters < 180 || Math.abs(diff) >= 25 ? desiredBearing : newHeading;
        const stepM = Math.min(
          customDistMeters,
          Math.max(0, cruiseSpeedMps * turnFactor * dt)
        );

        const terrainStep = this.resolveGlobalTerrainStep(
          currentLatLng,
          customTargetLL,
          desiredBearing,
          stepBearing,
          stepM,
          customDistMeters
        );

        if (terrainStep.cliffAdvisory) {
          const wallNow = Date.now();
          if (wallNow - this.lastBoundaryWallMs > 2600) {
            this.lastBoundaryWallMs = wallNow;
            this.pendingCliffReason = terrainStep.cliffAdvisory;
          }
        }

        const nextLL = terrainStep.nextLatLng;
        const nextLocalM = latLngToJezeroMeters(nextLL.lat, nextLL.lng);
        const enteringJezero =
          !customTargetOutsideJezero &&
          marsDistanceKm(nextLL, customTargetLL) * 1000 <= 1800 &&
          Math.abs(nextLocalM.x) <= limit &&
          Math.abs(nextLocalM.y) <= limit;

        const visualSpeed = Math.min(95, Math.max(6, cruiseSpeedMps * turnFactor));
        this.controller.linearVelocityMps = expDamp(
          this.controller.linearVelocityMps,
          visualSpeed,
          6.0,
          dt
        );

        if (enteringJezero) {
          this.currState.x = nextLocalM.x;
          this.currState.y = nextLocalM.y;
          this.currState.isGlobalOverride = false;
          this.currState.isPlanetaryWarp = false;
          this.pendingReenteredJezero = true;
          this.pushBreadcrumb(nextLocalM.x, nextLocalM.y);
        } else {
          const rad = (newHeading * Math.PI) / 180;
          this.currState.x += Math.sin(rad) * this.controller.linearVelocityMps * dt;
          this.currState.y += Math.cos(rad) * this.controller.linearVelocityMps * dt;
          this.currState.isGlobalOverride = true;
          this.currState.isPlanetaryWarp = cruiseSpeedMps > 120;
        }

        this.currState.heading = newHeading;
        this.currState.lat = nextLL.lat;
        this.currState.lng = nextLL.lng;
        this.currState.speedMps = this.controller.linearVelocityMps;
        this.currState.angularVelDegSec = this.controller.angularVelocityDegSec;
        this.currState.wheelRotationRad +=
          (this.controller.linearVelocityMps / WHEEL_RADIUS_M) * dt;
        this.currState.wheelSlipRatio = 0;
        this.lastMovedWallMs = Date.now();
        this.dirtyForReact = true;
        return true;
      }

      // Local Jezero custom waypoint traverse with hotspot curl avoidance
      const aiOrigin = { x: this.currState.x, y: this.currState.y };
      const dx = customLocalM.x - aiOrigin.x;
      const dy = customLocalM.y - aiOrigin.y;
      const dist = Math.hypot(dx, dy);

      let steerX = dx / Math.max(1e-6, dist);
      let steerY = dy / Math.max(1e-6, dist);
      for (let i = 0; i < RADIATION_HOTSPOTS.length; i++) {
        const hs = RADIATION_HOTSPOTS[i];
        const hx = this.currState.x - hs.x;
        const hy = this.currState.y - hs.z;
        const hDist = Math.hypot(hx, hy);
        if (hDist < hs.radius + 75 && hDist > 1) {
          const push = ((hs.radius + 75 - hDist) / 75) * 1.8;
          steerX += (hx / hDist) * push;
          steerY += (hy / hDist) * push;
          // Tangential curl prevents opposing vectors from cancelling into a local minimum
          if (Math.hypot(steerX, steerY) < 0.35) {
            const side = dx * hy - dy * hx >= 0 ? 1 : -1;
            steerX += (-hy / hDist) * side * 0.9;
            steerY += (hx / hDist) * side * 0.9;
          }
        }
      }

      const desiredBearing = (Math.atan2(steerX, steerY) * 180) / Math.PI;
      const diff = shortestAngleDiffDeg(this.currState.heading, desiredBearing);
      const targetAngVel = Math.max(-220, Math.min(220, diff * 7.5));
      this.controller.angularVelocityDegSec = expDamp(
        this.controller.angularVelocityDegSec,
        targetAngVel,
        12,
        dt
      );
      const newHeading = wrapAngleDeg(
        this.currState.heading + this.controller.angularVelocityDegSec * dt
      );

      const turnFactor = Math.max(0.38, Math.cos((diff * Math.PI) / 180));
      const baseSpeedMps = (isRover ? 52 : 22) * torqueMult * lowBatMult * lowIntegrityMult;
      const arrivalBrakeMps = dist < 45 ? Math.max(4, dist * 1.2) : baseSpeedMps;
      const targetSpeed = Math.min(baseSpeedMps * turnFactor, arrivalBrakeMps);
      this.controller.linearVelocityMps = expDamp(
        this.controller.linearVelocityMps,
        targetSpeed,
        5.5,
        dt
      );

      const stepM = Math.min(dist, Math.max(0, this.controller.linearVelocityMps * dt));
      const stepBrg = dist < 90 ? desiredBearing : newHeading;
      const rad = (stepBrg * Math.PI) / 180;
      const newX = Math.max(-limit, Math.min(limit, this.currState.x + Math.sin(rad) * stepM));
      const newY = Math.max(-limit, Math.min(limit, this.currState.y + Math.cos(rad) * stepM));
      const ll = jezeroLocalToLatLng(newX, newY);
      this.pushBreadcrumb(newX, newY);

      this.currState.x = newX;
      this.currState.y = newY;
      this.currState.heading = newHeading;
      this.currState.lat = ll.lat;
      this.currState.lng = ll.lng;
      this.currState.speedMps = this.controller.linearVelocityMps;
      this.currState.angularVelDegSec = this.controller.angularVelocityDegSec;
      this.currState.wheelRotationRad +=
        (this.controller.linearVelocityMps / WHEEL_RADIUS_M) * dt;
      this.currState.wheelSlipRatio = 0;
      this.currState.isPlanetaryWarp = false;
      this.lastMovedWallMs = Date.now();
      this.dirtyForReact = true;
      return true;
    }

    // Phase 2: Primary Target Navigation
    const curTarget = this.config.targetWp;
    const targetLatLng = {
      lat: Math.max(-90, Math.min(90, curTarget.lat)),
      lng: normalizeSignedLng180(curTarget.lng),
    };
    const distMeters = marsDistanceKm(currentLatLng, targetLatLng) * 1000;
    const arrivalThresholdM = 22;

    if (distMeters <= arrivalThresholdM) {
      this.controller.reset();
      this.currState.speedMps = 0;
      this.currState.angularVelDegSec = 0;
      this.currState.wheelSlipRatio = 0;
      this.currState.isPlanetaryWarp = false;
      this.config.autonomousAiPilot = false;
      this.pendingArrivedTarget = true;
      this.pendingAiPilotDisengaged = true;
      this.dirtyForReact = true;
      return false;
    }

    const watchdog = this.runExpeditionWatchdog(
      `target:${curTarget.id}`,
      currentLatLng,
      targetLatLng,
      distMeters,
      arrivalThresholdM
    );
    if (watchdog.recovered) {
      currentLatLng = watchdog.nextLatLng;
      const localM = latLngToJezeroMeters(currentLatLng.lat, currentLatLng.lng);
      const insideJezero =
        !curTarget.isLandform &&
        Math.abs(localM.x) <= limit &&
        Math.abs(localM.y) <= limit;
      this.currState.lat = currentLatLng.lat;
      this.currState.lng = currentLatLng.lng;
      this.currState.heading = watchdog.nextHeading;
      this.currState.isGlobalOverride = !insideJezero;
      if (insideJezero) {
        this.currState.x = localM.x;
        this.currState.y = localM.y;
        this.pushBreadcrumb(localM.x, localM.y);
      }
      this.lastMovedWallMs = Date.now();
      this.dirtyForReact = true;
      return true;
    }

    const targetLocalM = latLngToJezeroMeters(targetLatLng.lat, targetLatLng.lng);
    const targetOutsideJezero =
      Boolean(curTarget.isLandform) ||
      Math.abs(targetLocalM.x) > limit ||
      Math.abs(targetLocalM.y) > limit;

    const isLongRangeCruise =
      targetOutsideJezero || distMeters > 1800 || this.currState.isGlobalOverride;

    if (isLongRangeCruise) {
      const desiredBearing = marsBearingDeg(currentLatLng, targetLatLng);
      const diff = shortestAngleDiffDeg(this.currState.heading, desiredBearing);
      const targetAngVel = Math.max(-320, Math.min(320, diff * 9.0));
      this.controller.angularVelocityDegSec = expDamp(
        this.controller.angularVelocityDegSec,
        targetAngVel,
        14,
        dt
      );
      const newHeading = wrapAngleDeg(
        this.currState.heading + this.controller.angularVelocityDegSec * dt
      );

      const turnFactor = Math.max(0.32, Math.cos((diff * Math.PI) / 180));
      const cruiseSpeedMps = this.computeCruiseSpeedMps(
        distMeters,
        isRover,
        torqueMult,
        lowBatMult,
        lowIntegrityMult
      );

      // Direct bearing on terminal approach (<180m) eliminates waypoint orbiting
      const stepBearing = distMeters < 180 || Math.abs(diff) >= 25 ? desiredBearing : newHeading;
      const stepM = Math.min(distMeters, Math.max(0, cruiseSpeedMps * turnFactor * dt));

      const terrainStep = this.resolveGlobalTerrainStep(
        currentLatLng,
        targetLatLng,
        desiredBearing,
        stepBearing,
        stepM,
        distMeters
      );

      if (terrainStep.cliffAdvisory) {
        const wallNow = Date.now();
        if (wallNow - this.lastBoundaryWallMs > 2600) {
          this.lastBoundaryWallMs = wallNow;
          this.pendingCliffReason = terrainStep.cliffAdvisory;
        }
      }

      const nextLatLng = terrainStep.nextLatLng;
      const remainingMeters = marsDistanceKm(nextLatLng, targetLatLng) * 1000;
      const localMeters = latLngToJezeroMeters(nextLatLng.lat, nextLatLng.lng);
      const enteringJezeroTarget =
        !curTarget.isLandform &&
        remainingMeters <= 1800 &&
        Math.abs(localMeters.x) <= limit &&
        Math.abs(localMeters.y) <= limit;

      const targetVisualCruiseMps = Math.min(95, Math.max(6, cruiseSpeedMps * turnFactor));
      this.controller.linearVelocityMps = expDamp(
        this.controller.linearVelocityMps,
        targetVisualCruiseMps,
        6.0,
        dt
      );
      const visualSpeed = this.controller.linearVelocityMps;

      if (enteringJezeroTarget) {
        this.currState.x = localMeters.x;
        this.currState.y = localMeters.y;
        this.currState.isGlobalOverride = false;
        this.currState.isPlanetaryWarp = false;
        this.pendingReenteredJezero = true;
        this.pushBreadcrumb(localMeters.x, localMeters.y);
      } else {
        const rad = (newHeading * Math.PI) / 180;
        this.currState.x += Math.sin(rad) * visualSpeed * dt;
        this.currState.y += Math.cos(rad) * visualSpeed * dt;
        this.currState.isGlobalOverride = true;
        this.currState.isPlanetaryWarp = cruiseSpeedMps > 120;
      }

      this.currState.heading = newHeading;
      this.currState.lat = nextLatLng.lat;
      this.currState.lng = nextLatLng.lng;
      this.currState.speedMps = visualSpeed;
      this.currState.angularVelDegSec = this.controller.angularVelocityDegSec;
      this.currState.wheelRotationRad += (visualSpeed / WHEEL_RADIUS_M) * dt;
      this.currState.wheelSlipRatio = 0;
      this.lastMovedWallMs = Date.now();
      this.dirtyForReact = true;
      return true;
    }

    // Local Jezero Crater traverse with radiation hotspot curl avoidance
    const aiOrigin = { x: this.currState.x, y: this.currState.y };
    const dx = curTarget.x - aiOrigin.x;
    const dy = curTarget.y - aiOrigin.y;
    const dist = Math.hypot(dx, dy);

    let steerX = dx / Math.max(1e-6, dist);
    let steerY = dy / Math.max(1e-6, dist);
    for (let i = 0; i < RADIATION_HOTSPOTS.length; i++) {
      const hs = RADIATION_HOTSPOTS[i];
      const hx = this.currState.x - hs.x;
      const hy = this.currState.y - hs.z;
      const hDist = Math.hypot(hx, hy);
      if (hDist < hs.radius + 75 && hDist > 1) {
        const push = ((hs.radius + 75 - hDist) / 75) * 1.8;
        steerX += (hx / hDist) * push;
        steerY += (hy / hDist) * push;
        if (Math.hypot(steerX, steerY) < 0.35) {
          const side = dx * hy - dy * hx >= 0 ? 1 : -1;
          steerX += (-hy / hDist) * side * 0.9;
          steerY += (hx / hDist) * side * 0.9;
        }
      }
    }

    const desiredBearing = (Math.atan2(steerX, steerY) * 180) / Math.PI;
    const diff = shortestAngleDiffDeg(this.currState.heading, desiredBearing);
    const targetAngVel = Math.max(-220, Math.min(220, diff * 7.5));
    this.controller.angularVelocityDegSec = expDamp(
      this.controller.angularVelocityDegSec,
      targetAngVel,
      12,
      dt
    );
    const newHeading = wrapAngleDeg(
      this.currState.heading + this.controller.angularVelocityDegSec * dt
    );

    const currentMetrics = getTerrainMetricsAt(this.currState.x, this.currState.y);
    const looseFactor =
      currentMetrics.geology === 'LOOSE_REGOLITH' || currentMetrics.geology === 'AEOLIAN_RIPPLES'
        ? 1.0
        : 0.45;
    const wheelSlipRatio = Math.min(
      0.55,
      Math.max(0, ((currentMetrics.slopePercentage - 8) / 28) * looseFactor * (0.5 + torqueMult * 0.3))
    );
    const turnFactor = Math.max(0.38, Math.cos((diff * Math.PI) / 180));
    const baseSpeedMps =
      (isRover ? 52 : 22) * torqueMult * (1 - wheelSlipRatio * 0.45) * lowBatMult * lowIntegrityMult;
    const arrivalBrakeMps = dist < 45 ? Math.max(4, dist * 1.2) : baseSpeedMps;
    const targetSpeed = Math.min(baseSpeedMps * turnFactor, arrivalBrakeMps);

    this.controller.linearVelocityMps = expDamp(
      this.controller.linearVelocityMps,
      targetSpeed,
      5.5,
      dt
    );

    const stepM = Math.min(dist, Math.max(0, this.controller.linearVelocityMps * dt));
    const stepBrg = dist < 90 ? desiredBearing : newHeading;
    const rad = (stepBrg * Math.PI) / 180;
    const newX = Math.max(-limit, Math.min(limit, this.currState.x + Math.sin(rad) * stepM));
    const newY = Math.max(-limit, Math.min(limit, this.currState.y + Math.cos(rad) * stepM));
    const localLL = jezeroLocalToLatLng(newX, newY);
    this.pushBreadcrumb(newX, newY);

    const slipBoost = 1 + wheelSlipRatio * 1.6;
    this.currState.x = newX;
    this.currState.y = newY;
    this.currState.heading = newHeading;
    this.currState.lat = localLL.lat;
    this.currState.lng = localLL.lng;
    this.currState.speedMps = this.controller.linearVelocityMps;
    this.currState.angularVelDegSec = this.controller.angularVelocityDegSec;
    this.currState.wheelRotationRad +=
      (this.controller.linearVelocityMps / WHEEL_RADIUS_M) * dt * slipBoost;
    this.currState.wheelSlipRatio = wheelSlipRatio;
    this.currState.isGlobalOverride = false;
    this.currState.isPlanetaryWarp = false;
    this.lastMovedWallMs = Date.now();
    this.dirtyForReact = true;
    return true;
  }

  private flushTenHzCommit(nowMs: number, isRestingCommit: boolean): void {
    this.lastCommitMs = nowMs;
    if (!this.tenHzCommitCallback) return;

    const snapshot: SimTenHzSnapshot = {
      x: this.currState.x,
      y: this.currState.y,
      heading: this.currState.heading,
      lat: this.currState.lat,
      lng: this.currState.lng,
      isGlobalOverride: this.currState.isGlobalOverride,
      isPlanetaryWarp: this.currState.isPlanetaryWarp,
      speedMps: this.currState.speedMps,
      wheelSlipRatio: this.currState.wheelSlipRatio,
      lastMovedTimestamp: this.lastMovedWallMs,
      path: this.pathDirty ? this.breadcrumbPath.slice() : null,
      isRestingCommit,
      aiPilotDisengaged: this.pendingAiPilotDisengaged,
      reenteredJezero: this.pendingReenteredJezero,
      cliffBlockedReason: this.pendingCliffReason,
      watchdogRecoveryNotice: this.pendingWatchdogNotice,
      arrivedCustomWpId: this.pendingArrivedCustomWpId,
      arrivedTarget: this.pendingArrivedTarget,
    };

    this.pathDirty = false;
    this.dirtyForReact = false;
    this.pendingAiPilotDisengaged = false;
    this.pendingReenteredJezero = false;
    this.pendingCliffReason = null;
    this.pendingWatchdogNotice = null;
    this.pendingArrivedCustomWpId = null;
    this.pendingArrivedTarget = false;

    this.tenHzCommitCallback(snapshot);
  }

  private readonly masterTick = (nowMs: number): void => {
    if (!this.running) return;

    // Sample latest DualSense Gamepad API axes/buttons right before physics on this exact rAF tick
    dualSense.pollAt(nowMs);

    const rawDt = (nowMs - this.lastRafMs) / 1000;
    this.lastRafMs = nowMs;
    const dt = Math.min(Math.max(rawDt, 0), MAX_FRAME_DT);

    let isMovingNow = false;
    let hasImportantEvent = false;

    if (this.config.physicsEnabled || this.config.autonomousAiPilot) {
      const input = this.readDriveInput(nowMs);
      const activeAtStart = this.config.autonomousAiPilot || this.controller.isActive(input);

      if (activeAtStart) {
        this.accumulator += dt;
        let substeps = 0;
        while (this.accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS_PER_FRAME) {
          this.prevState = { ...this.currState };
          const stepActive = this.stepFixed(FIXED_DT, nowMs, input);
          if (stepActive) isMovingNow = true;
          this.accumulator -= FIXED_DT;
          substeps++;
        }
        if (this.accumulator >= FIXED_DT) {
          this.accumulator = 0;
        }
        const alpha = this.accumulator / FIXED_DT;
        this.writePoseRef(alpha);
      } else {
        this.accumulator = 0;
        this.prevState = { ...this.currState };
        this.currState.speedMps = 0;
        this.currState.angularVelDegSec = 0;
        this.currState.wheelSlipRatio = 0;
        this.currState.isPlanetaryWarp = false;
        this.writePoseRef(1);
      }

      hasImportantEvent =
        this.pendingAiPilotDisengaged ||
        this.pendingReenteredJezero ||
        this.pendingCliffReason !== null ||
        this.pendingWatchdogNotice !== null ||
        this.pendingArrivedCustomWpId !== null ||
        this.pendingArrivedTarget;
    }

    // 1. Render 3D Viewport immediately after physics in the EXACT same rAF tick
    //    (Rover mesh transform first -> camera follow lerp -> WebGL render)
    if (this.viewportCallback) {
      this.viewportCallback(dt, nowMs, this.poseRef.current);
    }

    // 2. Notify lightweight direct-DOM HUD subscribers (compass/reticle/Leaflet/mini-map)
    if (this.hudListeners.size > 0) {
      for (const listener of this.hudListeners) {
        listener(dt, nowMs, this.poseRef.current);
      }
    }

    // 3. Strictly throttle React state/telemetry commits to 10 Hz (every 100ms), or on rest/event
    const justStopped = this.wasMovingLastFrame && !isMovingNow;
    this.wasMovingLastFrame = isMovingNow;

    if (hasImportantEvent || justStopped) {
      this.flushTenHzCommit(nowMs, justStopped);
    } else if (this.dirtyForReact && nowMs - this.lastCommitMs >= TELEMETRY_COMMIT_INTERVAL_MS) {
      this.flushTenHzCommit(nowMs, false);
    }

    if (this.running) {
      this.rafId = requestAnimationFrame(this.masterTick);
    }
  };
}

export const vehicleSim = new VehicleSimulationEngine(120, 160, 318);
