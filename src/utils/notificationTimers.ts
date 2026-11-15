import type { HazardAlert, SettingChangeNotice } from '../types/telemetry';

export const NOTIFICATION_AUTO_DISMISS_MS = {
  /** Low Severity / Info: 3 to 4 seconds */
  info: 3500,
  /** Medium Severity / Warnings: 5 to 6 seconds */
  warn: 5500,
  /** High Severity / Critical Alerts: 7 to 8 seconds */
  danger: 7500,
} as const;

export const TOAST_EXIT_TRANSITION_MS = 250;

export function getSettingToastDismissMs(
  notice: Pick<SettingChangeNotice, 'severity' | 'requiresAck' | 'autoDismissMs'> | null | undefined
): number | null {
  if (!notice) return null;
  if (notice.requiresAck) return null;
  if (typeof notice.autoDismissMs === 'number' && notice.autoDismissMs > 0) {
    return notice.autoDismissMs;
  }
  switch (notice.severity) {
    case 'danger':
      return NOTIFICATION_AUTO_DISMISS_MS.danger;
    case 'warn':
      return NOTIFICATION_AUTO_DISMISS_MS.warn;
    case 'info':
    default:
      return NOTIFICATION_AUTO_DISMISS_MS.info;
  }
}

export function getHazardAlertDismissMs(
  alert: Pick<HazardAlert, 'active' | 'severity' | 'code' | 'requiresAck'> | null | undefined,
  emergencyRtbActive: boolean
): number | null {
  if (!alert || !alert.active) return null;
  if (alert.requiresAck || alert.code === 'HZ-EMERGENCY-RTB' || emergencyRtbActive) {
    return null;
  }
  switch (alert.severity) {
    case 'CRITICAL_HAZARD':
      return NOTIFICATION_AUTO_DISMISS_MS.danger;
    case 'CAUTION':
      return NOTIFICATION_AUTO_DISMISS_MS.warn;
    case 'NOMINAL':
    default:
      return NOTIFICATION_AUTO_DISMISS_MS.info;
  }
}
