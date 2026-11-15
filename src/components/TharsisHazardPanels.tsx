import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Mountain, Layers } from 'lucide-react';
import { vehicleSim } from '../utils/vehicleController';
import { analyzeTerrainAhead, type TerrainHazard, type TerrainHazardLevel } from '../utils/terrainHazard';
import { setHazardOverlayEnabled, useHazardOverlayEnabled } from '../utils/hazardOverlayStore';
import {
  computeOlympusClimbTelemetry,
  isNearOlympus,
  type OlympusClimbTelemetry,
} from '../data/olympusTelemetry';
import { playCautionTone } from '../utils/audioAlerts';
import type { MarsBiomeId, SeasonalFrostMode } from '../types/telemetry';

interface LivePose {
  lat: number;
  lng: number;
  x: number;
  y: number;
  heading: number;
}

/** Polls the live vehicle pose a few times a second (cheap; avoids re-rendering at 60 fps). */
function useLivePose(intervalMs = 250): LivePose {
  const read = (): LivePose => {
    const p = vehicleSim.poseRef.current;
    return { lat: p.lat, lng: p.lng, x: p.x, y: p.y, heading: p.heading };
  };
  const [pose, setPose] = useState<LivePose>(read);
  useEffect(() => {
    const id = window.setInterval(() => setPose(read()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return pose;
}

const LEVEL_STYLE: Record<TerrainHazardLevel, { box: string; text: string; label: string }> = {
  CLEAR: { box: 'border-emerald-500/30 bg-emerald-950/40', text: 'text-emerald-300', label: 'CLEAR' },
  CAUTION: { box: 'border-amber-400/60 bg-amber-950/60', text: 'text-amber-300', label: 'CAUTION' },
  WARNING: { box: 'border-orange-500/70 bg-orange-950/70', text: 'text-orange-300', label: 'WARNING' },
  CRITICAL: { box: 'border-rose-500/80 bg-rose-950/80', text: 'text-rose-300', label: 'CRITICAL' },
};

const ALTITUDE_STYLE: Record<OlympusClimbTelemetry['altitudeLevel'], string> = {
  NORMAL: 'text-emerald-300',
  HIGH: 'text-amber-300',
  VERY_HIGH: 'text-orange-300',
  EXTREME: 'text-rose-300',
};

const SLOPE_STYLE: Record<OlympusClimbTelemetry['slopeWarning'], string> = {
  NONE: 'text-emerald-300',
  CAUTION: 'text-amber-300',
  WARNING: 'text-orange-300',
  CRITICAL: 'text-rose-300',
};

export const HazardOverlayToggle: React.FC<{ className?: string }> = ({ className = '' }) => {
  const on = useHazardOverlayEnabled();
  return (
    <button
      type="button"
      onClick={() => setHazardOverlayEnabled(!on)}
      title="Tint steep ravine walls and trough edges on the 3D terrain and minimap"
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide ${
        on
          ? 'border-rose-400/60 bg-rose-950/60 text-rose-200'
          : 'border-slate-600 bg-slate-900/70 text-slate-400'
      } ${className}`}
    >
      <Layers className="h-3 w-3" />
      Hazard overlay {on ? 'ON' : 'OFF'}
    </button>
  );
};

/** Live ravine / trough / steep-wall detection ahead of the rover. */
export const TerrainHazardBanner: React.FC<{
  biomeId: MarsBiomeId;
  frostMode: SeasonalFrostMode;
  className?: string;
}> = ({ biomeId, frostMode, className = '' }) => {
  const pose = useLivePose(250);
  const hazard: TerrainHazard = analyzeTerrainAhead(
    pose.x,
    pose.y,
    pose.heading,
    biomeId,
    frostMode,
    pose.lat,
    pose.lng
  );
  const lastLevel = useRef<TerrainHazardLevel>('CLEAR');
  useEffect(() => {
    const rank = { CLEAR: 0, CAUTION: 1, WARNING: 2, CRITICAL: 3 };
    if (rank[hazard.level] >= 2 && rank[hazard.level] > rank[lastLevel.current]) playCautionTone();
    lastLevel.current = hazard.level;
  }, [hazard.level]);

  const style = LEVEL_STYLE[hazard.level];
  const side =
    hazard.bearingOffsetDeg === 0 ? 'dead ahead' : hazard.bearingOffsetDeg < 0 ? 'to the left' : 'to the right';

  return (
    <div className={`pointer-events-auto rounded-lg border px-2.5 py-1.5 font-mono text-[11px] ${style.box} ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center gap-1.5 font-bold ${style.text}`}>
          <AlertTriangle className="h-3.5 w-3.5" />
          {hazard.level === 'CLEAR' ? 'TERRAIN SCAN: CLEAR' : `${style.label}: ${hazard.headline}`}
        </span>
        <HazardOverlayToggle />
      </div>
      {hazard.level !== 'CLEAR' && (
        <div className="mt-1 text-slate-200">
          {hazard.detail} ({side}, {hazard.distanceM} m). Max grade {hazard.slopePct}%.
        </div>
      )}
      {hazard.mapped && (
        <div className="mt-0.5 text-sky-300/90">
          Mapped {hazard.mapped.kind === 'RAVINE' ? 'ravine' : 'trough'}: {hazard.mapped.name},{' '}
          {hazard.mapped.distanceKm} km
        </div>
      )}
    </div>
  );
};

const Row: React.FC<{ label: string; value: React.ReactNode; valueClass?: string }> = ({
  label,
  value,
  valueClass = 'text-slate-100',
}) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-slate-400">{label}</span>
    <span className={`text-right font-semibold ${valueClass}`}>{value}</span>
  </div>
);

/** Olympus Mons climb telemetry, measured from the red-marker baseline. Hidden away from Olympus. */
export const OlympusClimbPanel: React.FC<{
  biomeId: MarsBiomeId;
  slopePct: number;
  frostMode: SeasonalFrostMode;
  className?: string;
}> = ({ slopePct, frostMode, className = '' }) => {
  const pose = useLivePose(500);
  // Collapsed by default so the panel never covers the 3D terrain; click the strip to expand.
  const [open, setOpen] = useState(false);
  if (!isNearOlympus(pose.lat, pose.lng)) return null;
  const t = computeOlympusClimbTelemetry(pose.lat, pose.lng, slopePct, frostMode);
  const km = (m: number) => `${(m / 1000).toFixed(2)} km`;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Expand Olympus Mons climb telemetry"
        className={`pointer-events-auto flex w-full items-center gap-2 rounded-lg border border-orange-500/40 bg-slate-950/70 px-2.5 py-1 text-left font-mono text-[11px] ${className}`}
      >
        <Mountain className="h-3.5 w-3.5 shrink-0 text-orange-300" />
        <span className="truncate">
          <span className="text-orange-300">OLYMPUS</span>{' '}
          <span className={ALTITUDE_STYLE[t.altitudeLevel]}>{t.elevationM.toLocaleString()} m</span>
          <span className="text-slate-400"> · +{km(t.climbedM)} · </span>
          <span className={ALTITUDE_STYLE[t.altitudeLevel]}>{t.pressurePa} Pa</span>
          <span className="text-slate-400"> · slope </span>
          <span className={SLOPE_STYLE[t.slopeWarning]}>
            {t.slopePct.toFixed(0)}%{t.slopeWarning === 'NONE' ? '' : ` ${t.slopeWarning}`}
          </span>
          {t.warnings.length > 0 && <span className="text-orange-300"> · {t.warnings.length} warn</span>}
        </span>
        <span className="ml-auto shrink-0 text-slate-400">▾</span>
      </button>
    );
  }

  return (
    <div
      className={`pointer-events-auto max-h-[46vh] overflow-y-auto rounded-lg border border-orange-500/40 bg-slate-950/85 p-2.5 font-mono text-[11px] leading-snug ${className}`}
    >
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mb-1.5 flex w-full items-center gap-1.5 border-b border-orange-500/30 pb-1 text-left text-orange-300"
      >
        <Mountain className="h-3.5 w-3.5" />
        <span className="font-bold uppercase tracking-wide">Olympus Mons climb telemetry</span>
        <span className="ml-auto text-slate-400">▴</span>
      </button>
      <div className="mb-1 text-[10px] uppercase text-slate-400">Baseline: red marker, {t.baselineElevationM.toLocaleString()} m</div>
      <div className="space-y-0.5">
        <Row label="Zone" value={t.zoneLabel} />
        <Row label="Elevation (MOLA)" value={`${t.elevationM.toLocaleString()} m`} valueClass={ALTITUDE_STYLE[t.altitudeLevel]} />
        <Row label="Climbed from baseline" value={km(t.climbedM)} />
        <Row label="To summit (21,229 m)" value={km(t.remainingToSummitM)} />
        <Row label="From baseline" value={`${t.distFromBaselineKm} km`} />
        <Row label="To summit" value={`${t.distToSummitKm} km @ ${t.bearingToSummitDeg}°`} />
        <Row label="Air pressure" value={`${t.pressurePa} Pa (${t.pressurePctOfDatum}%)`} valueClass={ALTITUDE_STYLE[t.altitudeLevel]} />
        <Row label="Altitude level" value={t.altitudeLevel.replace('_', ' ')} valueClass={ALTITUDE_STYLE[t.altitudeLevel]} />
        <Row
          label="Slope"
          value={`${t.slopePct.toFixed(1)}%${t.slopeWarning === 'NONE' ? '' : ` ${t.slopeWarning}`}`}
          valueClass={SLOPE_STYLE[t.slopeWarning]}
        />
        <Row
          label="Escarpment"
          value={
            t.escarpmentDistKm >= 0
              ? `${t.escarpmentDistKm.toFixed(0)} km out, ${km(t.escarpmentReliefM)} high`
              : `${Math.abs(t.escarpmentDistKm).toFixed(0)} km inside, ${km(t.escarpmentReliefM)} high`
          }
        />
        {t.nearestCaldera && (
          <Row label="Nearest caldera" value={`${t.nearestCaldera.distKm} km, ${km(t.nearestCaldera.depthM)} deep`} />
        )}
      </div>
      {t.warnings.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 border-t border-orange-500/30 pt-1 text-orange-200">
          {t.warnings.map((w, i) => (
            <li key={i}>! {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
};
