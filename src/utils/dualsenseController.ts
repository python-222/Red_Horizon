/**
 * Native PlayStation 5 DualSense (W3C Gamepad API) Manager
 *
 * - Listens for `gamepadconnected` / `gamepaddisconnected` events
 * - Polls at 60fps via `requestAnimationFrame` (with same-frame timestamp dedupe for `vehicleSim`)
 * - Applies deadzones, non-linear precision curves, and exponential smoothing
 * - Writes analog channels into a mutable `inputRef` with ZERO React state updates per frame
 * - Provides debounced edge-detected discrete actions (Triangle, Square, Touchpad, Options, R3, Cross, Circle)
 * - Drives DualSense `vibrationActuator.playEffect("dual-rumble", ...)` tactile cues
 */

export type DualSenseAction =
  | 'toggle_autopilot'
  | 'toggle_cursor_mode'
  | 'toggle_minimap'
  | 'toggle_eva_hud'
  | 'recenter_camera';

export interface DualSenseLiveState {
  connected: boolean;
  gamepadIndex: number | null;
  gamepadId: string;
  /** Smoothed Left Stick X (+1 left .. -1 right, inverted for 3D yaw heading) mapped to angular velocity */
  steerX: number;
  /** Combined smoothed analog throttle (-1 reverse .. +1 forward) from L2/R2 */
  throttle: number;
  /** Smoothed R2 analog trigger (0..1) */
  r2: number;
  /** Smoothed L2 analog trigger (0..1) */
  l2: number;
  /** Smoothed Right Stick X (-1..1) for 3D camera pan (0 while cursorMode active) */
  cameraX: number;
  /** Smoothed Right Stick Y (-1..1) for 3D camera tilt (0 while cursorMode active) */
  cameraY: number;
  /** Virtual cursor mode state toggled by Square (buttons[2]) */
  cursorMode: boolean;
  /** Virtual cursor screen X coordinate (px) */
  cursorX: number;
  /** Virtual cursor screen Y coordinate (px) */
  cursorY: number;
  /** Timestamp of latest virtual Cross click for DOM pulse visual */
  lastClickMs: number;
}

export interface DualSenseCallbacks {
  onConnectionChange?: (connected: boolean, gamepadId: string) => void;
  onAction?: (action: DualSenseAction) => void;
  onCursorModeChange?: (active: boolean) => void;
}

interface GamepadHapticActuatorLike {
  playEffect?: (
    type: 'dual-rumble',
    params: {
      startDelay?: number;
      duration: number;
      weakMagnitude: number;
      strongMagnitude: number;
    }
  ) => Promise<string>;
}

type GamepadWithHaptics = Gamepad & {
  vibrationActuator?: GamepadHapticActuatorLike;
};

// Standard DualSense W3C Gamepad Mapping Indices
const AXIS_LEFT_X = 0;
const AXIS_RIGHT_X = 2;
const AXIS_RIGHT_Y = 3;

const BTN_CROSS = 0;
const BTN_CIRCLE = 1;
const BTN_SQUARE = 2;
const BTN_TRIANGLE = 3;
const BTN_L1 = 4;
const BTN_L2 = 6;
const BTN_R2 = 7;
const BTN_OPTIONS = 9;
const BTN_R3 = 11;
const BTN_DPAD_UP = 12;
const BTN_DPAD_DOWN = 13;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;
const BTN_TOUCHPAD = 17;

const STICK_DEADZONE = 0.11;
const TRIGGER_DEADZONE = 0.04;
const BUTTON_DEBOUNCE_MS = 180;
const CURSOR_SPEED_PX_SEC = 920;
const CURSOR_PRECISION_SPEED_PX_SEC = 340;

function shapeAxis(raw: number, deadzone: number, curvePow = 1.45): number {
  const abs = Math.abs(raw);
  if (abs <= deadzone) return 0;
  const norm = Math.min(1, (abs - deadzone) / (1 - deadzone));
  return Math.sign(raw) * Math.pow(norm, curvePow);
}

function shapeTrigger(btn: GamepadButton | undefined): number {
  if (!btn) return 0;
  const val = typeof btn.value === 'number' ? btn.value : btn.pressed ? 1 : 0;
  if (val <= TRIGGER_DEADZONE) return 0;
  return Math.min(1, (val - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE));
}

function expDamp(current: number, target: number, lambda: number, dt: number): number {
  const next = current + (target - current) * (1 - Math.exp(-lambda * dt));
  return Math.abs(next) < 1e-4 && Math.abs(target) < 1e-4 ? 0 : next;
}

function isDualSenseName(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes('dualsense') ||
    lower.includes('054c') ||
    lower.includes('wireless controller') ||
    lower.includes('ps5')
  );
}

function readButtonPressed(pad: Gamepad, index: number): boolean {
  const b = pad.buttons[index];
  if (!b) return false;
  return Boolean(b.pressed || b.value > 0.55);
}

export class DualSenseMarsController {
  public readonly inputRef: { current: DualSenseLiveState };
  public cameraRecenterEpoch = 0;

  private callbacks: DualSenseCallbacks = {};
  private readonly cursorListeners = new Set<(state: DualSenseLiveState) => void>();

  private rafId = 0;
  private running = false;
  private listenersAttached = false;
  private lastPollNowMs = 0;
  private lastSampledFrameMs = -1;

  private prevButtons = new Map<number, boolean>();
  private lastButtonFireMs = new Map<number, number>();

  private lastHazardRumbleMs = 0;
  private lastSlopeRumbleMs = 0;
  private lastAutopilotRumbleMs = 0;
  private cursorRawVelX = 0;
  private cursorRawVelY = 0;

  constructor() {
    const initW = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const initH = typeof window !== 'undefined' ? window.innerHeight : 800;
    this.inputRef = {
      current: {
        connected: false,
        gamepadIndex: null,
        gamepadId: '',
        steerX: 0,
        throttle: 0,
        r2: 0,
        l2: 0,
        cameraX: 0,
        cameraY: 0,
        cursorMode: false,
        cursorX: Math.round(initW * 0.5),
        cursorY: Math.round(initH * 0.5),
        lastClickMs: 0,
      },
    };
  }

  public setCallbacks(callbacks: DualSenseCallbacks): void {
    this.callbacks = callbacks;
  }

  public addCursorListener(listener: (state: DualSenseLiveState) => void): () => void {
    this.cursorListeners.add(listener);
    return () => {
      this.cursorListeners.delete(listener);
    };
  }

  public setCursorMode(active: boolean): void {
    if (this.inputRef.current.cursorMode === active) return;
    this.inputRef.current.cursorMode = active;

    if (active) {
      // Release any pointer lock constraints so UI controls can be interacted with freely
      if (typeof document !== 'undefined' && document.pointerLockElement) {
        try {
          document.exitPointerLock?.();
        } catch {
          // Ignore browser pointer lock exit restrictions
        }
      }
      // Zero camera motion immediately on entering cursor mode
      this.inputRef.current.cameraX = 0;
      this.inputRef.current.cameraY = 0;
      const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const h = typeof window !== 'undefined' ? window.innerHeight : 800;
      this.inputRef.current.cursorX = Math.max(8, Math.min(w - 8, this.inputRef.current.cursorX));
      this.inputRef.current.cursorY = Math.max(8, Math.min(h - 8, this.inputRef.current.cursorY));
    }

    this.hapticUiTick();
    this.callbacks.onCursorModeChange?.(active);
    this.notifyCursorListeners();
  }

  public start(): void {
    if (typeof window === 'undefined') return;
    if (!this.listenersAttached) {
      window.addEventListener('gamepadconnected', this.handleGamepadConnected);
      window.addEventListener('gamepaddisconnected', this.handleGamepadDisconnected);
      this.listenersAttached = true;
    }

    this.scanConnectedGamepads();

    if (!this.running) {
      this.running = true;
      this.lastPollNowMs = performance.now();
      this.rafId = requestAnimationFrame(this.pollLoop);
    }
  }

  public stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.listenersAttached && typeof window !== 'undefined') {
      window.removeEventListener('gamepadconnected', this.handleGamepadConnected);
      window.removeEventListener('gamepaddisconnected', this.handleGamepadDisconnected);
      this.listenersAttached = false;
    }
    this.resetAnalogAxes();
  }

  private readonly handleGamepadConnected = (e: GamepadEvent): void => {
    const pad = e.gamepad;
    if (!pad) return;
    const currentIdx = this.inputRef.current.gamepadIndex;
    // Prefer Sony DualSense over generic virtual gamepads if another was already active
    if (currentIdx === null || isDualSenseName(pad.id)) {
      this.attachGamepad(pad);
    }
  };

  private readonly handleGamepadDisconnected = (e: GamepadEvent): void => {
    const pad = e.gamepad;
    if (!pad) return;
    if (this.inputRef.current.gamepadIndex === pad.index) {
      this.inputRef.current.connected = false;
      this.inputRef.current.gamepadIndex = null;
      const oldId = this.inputRef.current.gamepadId;
      this.inputRef.current.gamepadId = '';
      this.resetAnalogAxes();
      this.prevButtons.clear();
      this.callbacks.onConnectionChange?.(false, oldId);
      // Fallback to another attached gamepad if available
      this.scanConnectedGamepads();
    }
  };

  private attachGamepad(pad: Gamepad): void {
    const wasConnected =
      this.inputRef.current.connected && this.inputRef.current.gamepadIndex === pad.index;
    this.inputRef.current.connected = true;
    this.inputRef.current.gamepadIndex = pad.index;
    this.inputRef.current.gamepadId = pad.id;
    if (!wasConnected) {
      this.prevButtons.clear();
      this.callbacks.onConnectionChange?.(true, pad.id);
      this.triggerRumble({ duration: 110, weakMagnitude: 0.35, strongMagnitude: 0.15 });
    }
  }

  private scanConnectedGamepads(): void {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    const pads = navigator.getGamepads();
    let fallback: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      if (isDualSenseName(p.id)) {
        this.attachGamepad(p);
        return;
      }
      if (!fallback) fallback = p;
    }
    if (fallback) {
      this.attachGamepad(fallback);
    }
  }

  private getActiveGamepad(): GamepadWithHaptics | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return null;
    }
    const pads = navigator.getGamepads();
    const targetIdx = this.inputRef.current.gamepadIndex;
    if (targetIdx !== null && pads[targetIdx]?.connected) {
      return pads[targetIdx] as GamepadWithHaptics;
    }
    // Re-acquire if user pressed a button before gamepadconnected fired
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected) {
        this.attachGamepad(p);
        return p as GamepadWithHaptics;
      }
    }
    return null;
  }

  private resetAnalogAxes(): void {
    const s = this.inputRef.current;
    s.steerX = 0;
    s.throttle = 0;
    s.r2 = 0;
    s.l2 = 0;
    s.cameraX = 0;
    s.cameraY = 0;
    this.cursorRawVelX = 0;
    this.cursorRawVelY = 0;
  }

  private readonly pollLoop = (nowMs: number): void => {
    if (!this.running) return;
    this.pollAt(nowMs);
    if (this.running) {
      this.rafId = requestAnimationFrame(this.pollLoop);
    }
  };

  /**
   * High-performance polling entry point. Deduplicates calls sharing the same rAF timestamp
   * so `vehicleSim.masterTick` and `pollLoop` never double-process a single vsync tick.
   */
  public pollAt(nowMs: number): void {
    if (nowMs === this.lastSampledFrameMs) return;
    this.lastSampledFrameMs = nowMs;

    const rawDt = (nowMs - this.lastPollNowMs) / 1000;
    this.lastPollNowMs = nowMs;
    const dt = Math.min(Math.max(rawDt, 1 / 240), 0.05);

    const pad = this.getActiveGamepad();
    const state = this.inputRef.current;

    if (!pad) {
      if (state.connected) {
        const oldId = state.gamepadId;
        state.connected = false;
        state.gamepadIndex = null;
        state.gamepadId = '';
        this.resetAnalogAxes();
        this.prevButtons.clear();
        this.callbacks.onConnectionChange?.(false, oldId);
      } else {
        // Decay residual smoothed axes cleanly
        state.steerX = expDamp(state.steerX, 0, 18, dt);
        state.throttle = expDamp(state.throttle, 0, 18, dt);
        state.r2 = expDamp(state.r2, 0, 18, dt);
        state.l2 = expDamp(state.l2, 0, 18, dt);
        state.cameraX = expDamp(state.cameraX, 0, 18, dt);
        state.cameraY = expDamp(state.cameraY, 0, 18, dt);
      }
      return;
    }

    // 1. Analog Steering (Left Stick X, inverted so stick left -> +steerX / left turn) & Throttle (R2 forward, L2 reverse)
    const shapedSteerX = shapeAxis(pad.axes[AXIS_LEFT_X] ?? 0, STICK_DEADZONE, 1.45);
    const rawSteerX = shapedSteerX === 0 ? 0 : -shapedSteerX;
    const rawR2 = shapeTrigger(pad.buttons[BTN_R2]);
    const rawL2 = shapeTrigger(pad.buttons[BTN_L2]);
    const rawThrottle = Math.max(-1, Math.min(1, rawR2 - rawL2));

    state.steerX = expDamp(state.steerX, rawSteerX, 16, dt);
    state.r2 = expDamp(state.r2, rawR2, 14, dt);
    state.l2 = expDamp(state.l2, rawL2, 14, dt);
    state.throttle = expDamp(state.throttle, rawThrottle, 14, dt);

    // 2. Right Stick (axes[2], axes[3]) -> Camera Orbit/Look OR Virtual Screen Cursor
    const rawRightX = shapeAxis(pad.axes[AXIS_RIGHT_X] ?? 0, STICK_DEADZONE, 1.35);
    const rawRightY = shapeAxis(pad.axes[AXIS_RIGHT_Y] ?? 0, STICK_DEADZONE, 1.35);

    if (state.cursorMode) {
      // Gate 3D camera panning while navigating UI menus
      state.cameraX = expDamp(state.cameraX, 0, 18, dt);
      state.cameraY = expDamp(state.cameraY, 0, 18, dt);

      const precisionMode = readButtonPressed(pad, BTN_L1);
      const maxSpeed = precisionMode ? CURSOR_PRECISION_SPEED_PX_SEC : CURSOR_SPEED_PX_SEC;

      const dpadX =
        (readButtonPressed(pad, BTN_DPAD_RIGHT) ? 0.35 : 0) -
        (readButtonPressed(pad, BTN_DPAD_LEFT) ? 0.35 : 0);
      const dpadY =
        (readButtonPressed(pad, BTN_DPAD_DOWN) ? 0.35 : 0) -
        (readButtonPressed(pad, BTN_DPAD_UP) ? 0.35 : 0);

      const targetVx = (Math.abs(rawRightX) > 0 ? rawRightX : dpadX) * maxSpeed;
      const targetVy = (Math.abs(rawRightY) > 0 ? rawRightY : dpadY) * maxSpeed;

      this.cursorRawVelX = expDamp(this.cursorRawVelX, targetVx, 20, dt);
      this.cursorRawVelY = expDamp(this.cursorRawVelY, targetVy, 20, dt);

      if (Math.abs(this.cursorRawVelX) > 0.25 || Math.abs(this.cursorRawVelY) > 0.25) {
        const maxW = typeof window !== 'undefined' ? window.innerWidth - 4 : 1276;
        const maxH = typeof window !== 'undefined' ? window.innerHeight - 4 : 796;
        state.cursorX = Math.max(4, Math.min(maxW, state.cursorX + this.cursorRawVelX * dt));
        state.cursorY = Math.max(4, Math.min(maxH, state.cursorY + this.cursorRawVelY * dt));
        this.notifyCursorListeners();
      }
    } else {
      this.cursorRawVelX = 0;
      this.cursorRawVelY = 0;
      state.cameraX = expDamp(state.cameraX, rawRightX, 15, dt);
      state.cameraY = expDamp(state.cameraY, rawRightY, 15, dt);
    }

    // 3. Debounced Rising-Edge Discrete Button Bindings
    if (this.consumeRisingEdge(pad, BTN_TRIANGLE, nowMs)) {
      this.callbacks.onAction?.('toggle_autopilot');
    }

    if (this.consumeRisingEdge(pad, BTN_SQUARE, nowMs)) {
      this.setCursorMode(!state.cursorMode);
      this.callbacks.onAction?.('toggle_cursor_mode');
    }

    if (this.consumeRisingEdge(pad, BTN_TOUCHPAD, nowMs)) {
      this.hapticUiTick();
      this.callbacks.onAction?.('toggle_minimap');
    }

    if (this.consumeRisingEdge(pad, BTN_OPTIONS, nowMs)) {
      this.hapticUiTick();
      this.callbacks.onAction?.('toggle_eva_hud');
    }

    if (this.consumeRisingEdge(pad, BTN_R3, nowMs)) {
      this.cameraRecenterEpoch += 1;
      this.hapticUiTick();
      this.callbacks.onAction?.('recenter_camera');
    }

    if (state.cursorMode) {
      if (this.consumeRisingEdge(pad, BTN_CROSS, nowMs)) {
        state.lastClickMs = nowMs;
        this.triggerVirtualClickAtCursor(state.cursorX, state.cursorY);
        this.notifyCursorListeners();
      }
      if (this.consumeRisingEdge(pad, BTN_CIRCLE, nowMs)) {
        this.setCursorMode(false);
        this.callbacks.onAction?.('toggle_cursor_mode');
      }
      // Support D-Pad Up/Down continuous scroll on overflow containers while in Cursor Mode
      if (Math.abs(rawRightY) < 0.05) {
        const scrollDir =
          (readButtonPressed(pad, BTN_DPAD_DOWN) ? 1 : 0) -
          (readButtonPressed(pad, BTN_DPAD_UP) ? 1 : 0);
        if (scrollDir !== 0) {
          this.scrollContainerAt(state.cursorX, state.cursorY, scrollDir * 420 * dt);
        }
      }
    } else {
      // Keep prevButtons in sync for Cross/Circle so entering cursor mode never triggers a stale edge
      this.prevButtons.set(BTN_CROSS, readButtonPressed(pad, BTN_CROSS));
      this.prevButtons.set(BTN_CIRCLE, readButtonPressed(pad, BTN_CIRCLE));
    }
  }

  private consumeRisingEdge(pad: Gamepad, buttonIndex: number, nowMs: number): boolean {
    const isPressed = readButtonPressed(pad, buttonIndex);
    const wasPressed = this.prevButtons.get(buttonIndex) ?? false;
    this.prevButtons.set(buttonIndex, isPressed);

    if (isPressed && !wasPressed) {
      const lastFired = this.lastButtonFireMs.get(buttonIndex) ?? -Infinity;
      if (nowMs - lastFired >= BUTTON_DEBOUNCE_MS) {
        this.lastButtonFireMs.set(buttonIndex, nowMs);
        return true;
      }
    }
    return false;
  }

  private notifyCursorListeners(): void {
    const snap = this.inputRef.current;
    for (const listener of this.cursorListeners) {
      listener(snap);
    }
  }

  private triggerVirtualClickAtCursor(x: number, y: number): void {
    if (typeof document === 'undefined') return;
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!hit) return;

    this.hapticUiTick();

    // Handle <input type="range"> sliders cleanly by setting proportional value at cursor X
    if (hit instanceof HTMLInputElement && hit.type === 'range') {
      const rect = hit.getBoundingClientRect();
      const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (x - rect.left) / rect.width)) : 0.5;
      const min = parseFloat(hit.min || '0');
      const max = parseFloat(hit.max || '100');
      const step = parseFloat(hit.step || '1');
      const rawVal = min + ratio * (max - min);
      const stepped = Math.round((rawVal - min) / step) * step + min;
      const clamped = Math.max(min, Math.min(max, Number(stepped.toFixed(4))));

      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set;
      nativeSetter?.call(hit, String(clamped));
      hit.dispatchEvent(new Event('input', { bubbles: true }));
      hit.dispatchEvent(new Event('change', { bubbles: true }));
      hit.focus();
      return;
    }

    const target =
      (hit.closest(
        'button, a, input, select, textarea, label, [role="button"], [tabindex]'
      ) as HTMLElement | null) ?? hit;

    // For <select> dropdowns, cycle to next option on Cross press (native OS popups can't open synthetically)
    if (target instanceof HTMLSelectElement) {
      target.focus();
      if (target.options.length > 0) {
        const nextIdx = (target.selectedIndex + 1) % target.options.length;
        target.selectedIndex = nextIdx;
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }

    const pointerInit: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
    };
    const mouseInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    };

    target.focus?.();
    target.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
    target.dispatchEvent(new MouseEvent('mousedown', mouseInit));
    target.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
    target.click?.();
  }

  private scrollContainerAt(x: number, y: number, deltaY: number): void {
    if (typeof document === 'undefined' || Math.abs(deltaY) < 0.5) return;
    let el = document.elementFromPoint(x, y) as HTMLElement | null;
    while (el) {
      const style = window.getComputedStyle(el);
      const canScrollY =
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 2;
      if (canScrollY) {
        el.scrollTop += deltaY;
        return;
      }
      el = el.parentElement;
    }
    window.scrollBy(0, deltaY);
  }

  // --- HAPTIC FEEDBACK (dual-rumble) ---

  public triggerRumble(params: {
    duration: number;
    strongMagnitude: number;
    weakMagnitude: number;
    startDelay?: number;
  }): void {
    const pad = this.getActiveGamepad();
    const actuator = pad?.vibrationActuator;
    if (!pad || !actuator?.playEffect) return;
    try {
      void actuator
        .playEffect('dual-rumble', {
          startDelay: params.startDelay ?? 0,
          duration: Math.max(20, Math.min(1200, Math.round(params.duration))),
          strongMagnitude: Math.max(0, Math.min(1, params.strongMagnitude)),
          weakMagnitude: Math.max(0, Math.min(1, params.weakMagnitude)),
        })
        ?.catch(() => {});
    } catch {
      // Ignore unsupported vibration implementations
    }
  }

  public hapticUiTick(): void {
    this.triggerRumble({
      duration: 42,
      weakMagnitude: 0.24,
      strongMagnitude: 0.08,
    });
  }

  public hapticAutopilot(engaged: boolean): void {
    const now = performance.now();
    if (now - this.lastAutopilotRumbleMs < 200) return;
    this.lastAutopilotRumbleMs = now;
    if (engaged) {
      this.triggerRumble({ duration: 135, weakMagnitude: 0.45, strongMagnitude: 0.28 });
    } else {
      this.triggerRumble({ duration: 85, weakMagnitude: 0.22, strongMagnitude: 0.14 });
    }
  }

  public hapticHazard(severity: 'caution' | 'critical'): void {
    const now = performance.now();
    if (now - this.lastHazardRumbleMs < 1800) return;
    this.lastHazardRumbleMs = now;
    if (severity === 'critical') {
      this.triggerRumble({ duration: 300, weakMagnitude: 0.72, strongMagnitude: 0.9 });
    } else {
      this.triggerRumble({ duration: 190, weakMagnitude: 0.48, strongMagnitude: 0.55 });
    }
  }

  public hapticSlopeSlip(wheelSlipRatio: number, slopePercentage: number, speedMps: number): void {
    if (Math.abs(speedMps) < 0.6) return;
    if (slopePercentage <= 13 && wheelSlipRatio <= 0.18) return;

    const now = performance.now();
    if (now - this.lastSlopeRumbleMs < 185) return;
    this.lastSlopeRumbleMs = now;

    const slopeIntensity = Math.min(1, Math.max(0, (slopePercentage - 12) / 18));
    const slipIntensity = Math.min(1, Math.max(0, wheelSlipRatio / 0.65));
    const mag = Math.max(slopeIntensity * 0.55, slipIntensity * 0.65);

    this.triggerRumble({
      duration: 125,
      strongMagnitude: Math.min(0.8, 0.16 + mag * 0.6),
      weakMagnitude: Math.min(0.65, 0.12 + mag * 0.45),
    });
  }
}

export const dualSense = new DualSenseMarsController();
