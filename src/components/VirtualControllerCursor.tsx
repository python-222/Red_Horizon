import React, { useEffect, useRef } from 'react';
import { dualSense, type DualSenseLiveState } from '../utils/dualsenseController';

interface VirtualControllerCursorProps {
  active: boolean;
}

/**
 * High-visibility virtual pointer overlay for DualSense Cursor Mode (Square toggle).
 * Updates screen coordinates via direct DOM transform inside the 60fps gamepad listener
 * so cursor movement produces ZERO React re-renders.
 */
export const VirtualControllerCursor: React.FC<VirtualControllerCursorProps> = ({ active }) => {
  const cursorWrapRef = useRef<HTMLDivElement>(null);
  const pulseRingRef = useRef<HTMLDivElement>(null);
  const lastClickMsRef = useRef<number>(0);

  useEffect(() => {
    if (!active) return;

    const applyPosition = (snap: DualSenseLiveState) => {
      if (cursorWrapRef.current) {
        cursorWrapRef.current.style.transform = `translate3d(${snap.cursorX}px, ${snap.cursorY}px, 0)`;
      }
      if (snap.lastClickMs !== lastClickMsRef.current && snap.lastClickMs > 0) {
        lastClickMsRef.current = snap.lastClickMs;
        if (pulseRingRef.current) {
          pulseRingRef.current.classList.remove('scale-150', 'opacity-0');
          pulseRingRef.current.classList.add('scale-75', 'opacity-100');
          // Trigger reflow cleanly only on discrete click events
          void pulseRingRef.current.offsetWidth;
          pulseRingRef.current.classList.remove('scale-75', 'opacity-100');
          pulseRingRef.current.classList.add('scale-150', 'opacity-0');
        }
      }
    };

    applyPosition(dualSense.inputRef.current);
    return dualSense.addCursorListener(applyPosition);
  }, [active]);

  if (!active) return null;

  return (
    <div
      ref={cursorWrapRef}
      aria-hidden="true"
      className="fixed top-0 left-0 z-[9999] pointer-events-none select-none will-change-transform"
      style={{
        transform: `translate3d(${dualSense.inputRef.current.cursorX}px, ${dualSense.inputRef.current.cursorY}px, 0)`,
      }}
    >
      {/* Crosshair Reticle Centered on Hot-Spot (0, 0) */}
      <div className="relative -translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
        <div
          ref={pulseRingRef}
          className="absolute w-9 h-9 rounded-full border-2 border-cyan-300 opacity-0 scale-150 transition-all duration-200"
        />
        <div className="w-7 h-7 rounded-full border-2 border-cyan-300 bg-cyan-500/15 shadow-[0_0_12px_rgba(34,211,238,0.65)] flex items-center justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-300" />
        </div>
        <div className="absolute w-9 h-[1.5px] bg-cyan-300/80" />
        <div className="absolute h-9 w-[1.5px] bg-cyan-300/80" />

        <div className="absolute top-6 left-5 whitespace-nowrap px-2 py-0.5 rounded bg-slate-950/92 border border-cyan-400/60 text-[10px] font-mono font-bold text-cyan-200 shadow-lg">
          CURSOR · ✕ CLICK · L1 SLOW · □ EXIT
        </div>
      </div>
    </div>
  );
};
