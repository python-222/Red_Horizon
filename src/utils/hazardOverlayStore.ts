import { useSyncExternalStore } from 'react';

/** Shared on/off switch for the terrain hazard overlays (3D terrain tint + minimap tint). */
let enabled = true;
const listeners = new Set<() => void>();

export function getHazardOverlayEnabled(): boolean {
  return enabled;
}

export function setHazardOverlayEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  listeners.forEach((l) => l());
}

export function subscribeHazardOverlay(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useHazardOverlayEnabled(): boolean {
  return useSyncExternalStore(subscribeHazardOverlay, getHazardOverlayEnabled, getHazardOverlayEnabled);
}
