import React, { useState, useRef, useEffect } from 'react';
import {
  Compass,
  Maximize2,
  Minimize2,
  Navigation,
  RotateCcw,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
} from 'lucide-react';
import {
  MARS_CRATERS,
  MARS_WAYPOINTS,
  RADIATION_HOTSPOTS,
  WAYPOINT_TYPE_COLORS,
  formatAreographicCoords,
  getTerrainMetricsAt,
  jezeroLocalToLatLng,
} from '../data/marsTerrain';
import { AtlasSpectralMode, renderLocalHiRiseDem } from '../utils/marsTileAtlas';
import type { LiveVehiclePose } from '../utils/vehicleController';

interface MiniMapProps {
  astronautX: number; // meters from base
  astronautY: number; // meters from base
  heading: number; // degrees 0-360
  targetX: number;
  targetY: number;
  targetName: string;
  distanceToTarget: number;
  bearingToTarget: number;
  breadcrumbPath: Array<{ x: number; y: number }>;
  onMove: (direction: 'forward' | 'backward' | 'left' | 'right') => void;
  onDriveInput?: (direction: 'forward' | 'backward' | 'left' | 'right', active: boolean) => void;
  onResetPosition?: () => void;
  activeTargetId?: string;
  astronautLatLng?: { lat: number; lng: number };
  liveVehicleRef?: React.MutableRefObject<LiveVehiclePose>;
}

function rotatePoint(dx: number, dy: number, deg: number): { x: number; y: number } {
  if (Math.abs(deg) < 0.001) return { x: dx, y: dy };
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return {
    x: dx * c - dy * s,
    y: dx * s + dy * c,
  };
}

export const MiniMap: React.FC<MiniMapProps> = ({
  astronautX,
  astronautY,
  heading,
  targetX,
  targetY,
  targetName,
  distanceToTarget,
  bearingToTarget,
  breadcrumbPath,
  onMove,
  onDriveInput,
  onResetPosition,
  activeTargetId,
  astronautLatLng,
  liveVehicleRef: _liveVehicleRef,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [orientation, setOrientation] = useState<'north_up' | 'heading_up'>('north_up');
  const [spectralMode, setSpectralMode] = useState<AtlasSpectralMode>('topographic');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const radarRadiusMeters = isExpanded ? 520 : 360;
  const viewSize = isExpanded ? 240 : 176; // px
  const centerPx = viewSize / 2;
  const pxPerMeter = (viewSize * 0.43) / radarRadiusMeters;
  const rotationDeg = orientation === 'heading_up' ? -heading : 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = viewSize;
    canvas.height = viewSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, viewSize, viewSize);
    renderLocalHiRiseDem(
      ctx,
      viewSize,
      viewSize,
      astronautX,
      astronautY,
      pxPerMeter,
      0,
      0,
      rotationDeg,
      spectralMode,
      3
    );
  }, [astronautX, astronautY, pxPerMeter, rotationDeg, spectralMode, viewSize]);

  // Transform world coords (wx, wy) to radar SVG coords relative to astronaut at center
  const toRadarCoords = (wx: number, wy: number) => {
    const dx = (wx - astronautX) * pxPerMeter;
    const dy = -(wy - astronautY) * pxPerMeter;
    const rot = rotatePoint(dx, dy, rotationDeg);
    return {
      x: centerPx + rot.x,
      y: centerPx + rot.y,
    };
  };

  const targetCoords = toRadarCoords(targetX, targetY);
  const baseCoords = toRadarCoords(0, 0);

  // Calculate vision cone polygon based on effective visual heading
  const displayHeading = orientation === 'heading_up' ? 0 : heading;
  const coneLength = 34 * (viewSize / 176);
  const coneFov = 35; // degrees half-angle
  const radH = (displayHeading * Math.PI) / 180;
  const radLeft = ((displayHeading - coneFov) * Math.PI) / 180;
  const radRight = ((displayHeading + coneFov) * Math.PI) / 180;

  const p1X = centerPx + Math.sin(radLeft) * coneLength;
  const p1Y = centerPx - Math.cos(radLeft) * coneLength;
  const p2X = centerPx + Math.sin(radRight) * coneLength;
  const p2Y = centerPx - Math.cos(radRight) * coneLength;

  // Cardinal tick positions rotated around center
  const cardinalRadius = viewSize * 0.455;
  const cardinals = [
    { label: 'N', angle: 0, color: '#22d3ee', bold: true },
    { label: 'E', angle: 90, color: '#94a3b8', bold: false },
    { label: 'S', angle: 180, color: '#94a3b8', bold: false },
    { label: 'W', angle: 270, color: '#94a3b8', bold: false },
  ].map((c) => {
    const effRad = ((c.angle + rotationDeg) * Math.PI) / 180;
    return {
      ...c,
      x: centerPx + Math.sin(effRad) * cardinalRadius,
      y: centerPx - Math.cos(effRad) * cardinalRadius + 3,
    };
  });

  const resolvedGeo = astronautLatLng ?? jezeroLocalToLatLng(astronautX, astronautY);
  const terrainAtPlayer = getTerrainMetricsAt(astronautX, astronautY);
  const targetBadge = activeTargetId || (targetName.length > 10 ? targetName.slice(0, 10).toUpperCase() : targetName.toUpperCase());

  const cycleSpectralMode = () => {
    setSpectralMode((prev) =>
      prev === 'topographic' ? 'optical' : prev === 'optical' ? 'thermal' : 'topographic'
    );
  };

  return (
    <div
      className={`relative bg-slate-950/90 border border-cyan-500/40 rounded-xl shadow-2xl backdrop-blur-md overflow-hidden transition-all duration-300 pointer-events-auto select-none ${
        isExpanded ? 'w-64 sm:w-72' : 'w-48 sm:w-56'
      }`}
    >
      {/* Mini-Map Header Bar */}
      <div className="flex items-center justify-between px-2 py-1.5 bg-[#090d16] border-b border-slate-800 text-[10px] font-mono">
        <div className="flex items-center gap-1 text-cyan-300 font-bold">
          <Compass className="w-3.5 h-3.5 text-cyan-400" />
          <span>RADAR</span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setOrientation((o) => (o === 'north_up' ? 'heading_up' : 'north_up'))}
            title="Toggle North-Up vs Heading-Up radar orientation"
            className={`px-1.5 py-0.5 rounded border text-[9px] font-bold whitespace-nowrap transition-colors ${
              orientation === 'heading_up'
                ? 'bg-amber-500/20 border-amber-400/50 text-amber-300'
                : 'bg-slate-900 border-slate-700 text-cyan-300 hover:border-cyan-500/50'
            }`}
          >
            {orientation === 'heading_up' ? 'HDG-UP' : 'N-UP'}
          </button>
          <button
            type="button"
            onClick={cycleSpectralMode}
            title="Cycle spectral layer (HiRISE DEM / Optical / Thermal)"
            className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-900 text-slate-300 hover:text-cyan-300 hover:border-cyan-500/50 text-[9px] font-bold whitespace-nowrap transition-colors"
          >
            {spectralMode === 'topographic' ? 'DEM' : spectralMode === 'optical' ? 'OPT' : 'THM'}
          </button>
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? 'Collapse mini-map' : 'Expand mini-map'}
            className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors"
          >
            {isExpanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Radar Map Raster + SVG Overlay */}
      <div className="relative w-full aspect-square bg-[#060810] flex items-center justify-center overflow-hidden">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full object-cover opacity-85"
        />

        <svg
          viewBox={`0 0 ${viewSize} ${viewSize}`}
          className="relative z-10 w-full h-full"
        >
          {/* Radar Background Range Rings */}
          <circle
            cx={centerPx}
            cy={centerPx}
            r={viewSize * 0.15}
            fill="none"
            stroke="rgba(6, 182, 212, 0.25)"
            strokeDasharray="2 2"
          />
          <circle
            cx={centerPx}
            cy={centerPx}
            r={viewSize * 0.3}
            fill="none"
            stroke="rgba(6, 182, 212, 0.3)"
            strokeDasharray="3 3"
          />
          <circle
            cx={centerPx}
            cy={centerPx}
            r={viewSize * 0.44}
            fill="none"
            stroke="rgba(6, 182, 212, 0.45)"
          />

          {/* Crosshair axes */}
          <line x1={centerPx} y1={0} x2={centerPx} y2={viewSize} stroke="rgba(6, 182, 212, 0.18)" />
          <line x1={0} y1={centerPx} x2={viewSize} y2={centerPx} stroke="rgba(6, 182, 212, 0.18)" />

          {/* Rotated Cardinal Directions */}
          {cardinals.map((c) => (
            <text
              key={c.label}
              x={c.x}
              y={c.y}
              textAnchor="middle"
              fill={c.color}
              fontSize={c.bold ? '8.5' : '7'}
              fontFamily="monospace"
              fontWeight={c.bold ? 'bold' : 'normal'}
            >
              {c.label}
            </text>
          ))}

          {/* Real Impact Craters from marsTerrain */}
          {MARS_CRATERS.map((cr) => {
            const c = toRadarCoords(cr.x, cr.z);
            const rPx = cr.radius * pxPerMeter;
            if (c.x < -rPx || c.x > viewSize + rPx || c.y < -rPx || c.y > viewSize + rPx) return null;
            return (
              <circle
                key={cr.name}
                cx={c.x}
                cy={c.y}
                r={Math.max(3, rPx)}
                fill="rgba(15, 23, 42, 0.22)"
                stroke="rgba(251, 146, 60, 0.48)"
                strokeWidth="0.9"
                strokeDasharray="2 2"
              />
            );
          })}

          {/* Real Ionizing Radiation Hotspots */}
          {RADIATION_HOTSPOTS.map((rad) => {
            const c = toRadarCoords(rad.x, rad.z);
            const rPx = rad.radius * pxPerMeter;
            if (c.x < -rPx || c.x > viewSize + rPx || c.y < -rPx || c.y > viewSize + rPx) return null;
            return (
              <circle
                key={rad.id}
                cx={c.x}
                cy={c.y}
                r={Math.max(4, rPx)}
                fill="rgba(244, 63, 94, 0.14)"
                stroke="rgba(244, 63, 94, 0.55)"
                strokeWidth="0.9"
                strokeDasharray="3 2"
              />
            );
          })}

          {/* Breadcrumb Traveled Track */}
          {breadcrumbPath.length > 1 && (
            <polyline
              points={breadcrumbPath
                .map((pt) => {
                  const c = toRadarCoords(pt.x, pt.y);
                  return `${c.x},${c.y}`;
                })
                .join(' ')}
              fill="none"
              stroke="#22d3ee"
              strokeWidth="1.5"
              strokeDasharray="2 2"
              opacity="0.75"
            />
          )}

          {/* Real Jezero Crater Landmarks / Waypoints */}
          {MARS_WAYPOINTS.map((wp) => {
            const c = toRadarCoords(wp.x, wp.z);
            if (c.x < -12 || c.x > viewSize + 12 || c.y < -12 || c.y > viewSize + 12) return null;
            const color = WAYPOINT_TYPE_COLORS[wp.type].hex;
            const isTarget = wp.id === activeTargetId;
            return (
              <g key={wp.id} transform={`translate(${c.x}, ${c.y})`}>
                <circle r={isTarget ? 4.5 : 2.6} fill={color} opacity={isTarget ? 0.95 : 0.78} />
                {isExpanded && !isTarget && (
                  <text
                    y={-5}
                    textAnchor="middle"
                    fill={color}
                    fontSize="5.5"
                    fontFamily="monospace"
                  >
                    {wp.id}
                  </text>
                )}
              </g>
            );
          })}

          {/* Base Habitat Marker (HAB-01) */}
          <rect
            x={baseCoords.x - 3.5}
            y={baseCoords.y - 3.5}
            width="7"
            height="7"
            fill="#10b981"
            opacity="0.85"
          />

          {/* Active Target Waypoint Marker */}
          <g transform={`translate(${targetCoords.x}, ${targetCoords.y})`}>
            <circle r="7" fill="none" stroke="#f59e0b" strokeWidth="1" opacity="0.7" />
            <polygon points="0,-5 5,0 0,5 -5,0" fill="#f59e0b" />
            <text
              y="-8"
              textAnchor="middle"
              fill="#fbbf24"
              fontSize="7"
              fontFamily="monospace"
              fontWeight="bold"
            >
              {targetBadge}
            </text>
          </g>

          {/* Line of Sight Vector from Astronaut to Target Waypoint */}
          <line
            x1={centerPx}
            y1={centerPx}
            x2={targetCoords.x}
            y2={targetCoords.y}
            stroke="rgba(245, 158, 11, 0.55)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />

          {/* Astronaut Vision Cone (FOV) */}
          <polygon
            points={`${centerPx},${centerPx} ${p1X},${p1Y} ${p2X},${p2Y}`}
            fill="rgba(6, 182, 212, 0.2)"
            stroke="rgba(34, 211, 238, 0.65)"
            strokeWidth="0.9"
          />

          {/* Center Astronaut Marker Dot with Heading Pointer */}
          <circle cx={centerPx} cy={centerPx} r="3.5" fill="#ffffff" stroke="#06b6d4" strokeWidth="1.5" />
          <line
            x1={centerPx}
            y1={centerPx}
            x2={centerPx + Math.sin(radH) * 9}
            y2={centerPx - Math.cos(radH) * 9}
            stroke="#ffffff"
            strokeWidth="2"
          />
        </svg>

        {/* Live Areographic & Elevation Coordinate Stamp */}
        <div className="absolute bottom-1 left-1.5 z-20 text-[8.5px] font-mono text-cyan-300 pointer-events-none bg-slate-950/80 px-1.5 py-0.5 rounded border border-cyan-500/20 tabular-nums">
          {formatAreographicCoords(resolvedGeo.lat, resolvedGeo.lng)} · {terrainAtPlayer.elevationMeters}m
        </div>
        <div className="absolute top-1 right-1.5 z-20 text-[9px] font-mono text-amber-300 pointer-events-none bg-slate-950/80 px-1.5 py-0.5 rounded border border-amber-500/20 tabular-nums">
          HDG {Math.round(heading)}° · BRG {Math.round(bearingToTarget)}° · {distanceToTarget}m
        </div>
      </div>

      {/* Movement Directional Controls / Arrow Keys Interface */}
      <div className="p-2 bg-[#090d16] border-t border-slate-800 flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
          <span className="flex items-center gap-1 text-slate-300 font-semibold">
            <Navigation className="w-3 h-3 text-cyan-400" /> NAV KEYS
          </span>
          {onResetPosition && (
            <button
              type="button"
              onClick={onResetPosition}
              className="text-slate-400 hover:text-amber-300 flex items-center gap-0.5 transition-colors whitespace-nowrap"
              title="Reset astronaut position to Sol 244 start point"
            >
              <RotateCcw className="w-2.5 h-2.5" /> Reset
            </button>
          )}
        </div>

        <div className="flex items-center justify-center gap-1 pt-0.5">
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              onDriveInput?.('left', true);
            }}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
              }
              onDriveInput?.('left', false);
            }}
            onPointerCancel={() => onDriveInput?.('left', false)}
            onLostPointerCapture={() => onDriveInput?.('left', false)}
            onBlur={() => onDriveInput?.('left', false)}
            onClick={(e) => {
              if (!onDriveInput || e.detail === 0) onMove('left');
            }}
            title="Turn Left (← or A)"
            className="p-1.5 rounded bg-slate-900 border border-slate-700 hover:bg-cyan-500/20 hover:border-cyan-400 text-slate-200 active:bg-cyan-500/40 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                onDriveInput?.('forward', true);
              }}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }
                onDriveInput?.('forward', false);
              }}
              onPointerCancel={() => onDriveInput?.('forward', false)}
              onLostPointerCapture={() => onDriveInput?.('forward', false)}
              onBlur={() => onDriveInput?.('forward', false)}
              onClick={(e) => {
                if (!onDriveInput || e.detail === 0) onMove('forward');
              }}
              title="Walk Forward (↑ or W)"
              className="p-1.5 rounded bg-slate-900 border border-slate-700 hover:bg-cyan-500/20 hover:border-cyan-400 text-slate-200 active:bg-cyan-500/40 transition-colors"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                onDriveInput?.('backward', true);
              }}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }
                onDriveInput?.('backward', false);
              }}
              onPointerCancel={() => onDriveInput?.('backward', false)}
              onLostPointerCapture={() => onDriveInput?.('backward', false)}
              onBlur={() => onDriveInput?.('backward', false)}
              onClick={(e) => {
                if (!onDriveInput || e.detail === 0) onMove('backward');
              }}
              title="Walk Backward (↓ or S)"
              className="p-1.5 rounded bg-slate-900 border border-slate-700 hover:bg-cyan-500/20 hover:border-cyan-400 text-slate-200 active:bg-cyan-500/40 transition-colors"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              onDriveInput?.('right', true);
            }}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
              }
              onDriveInput?.('right', false);
            }}
            onPointerCancel={() => onDriveInput?.('right', false)}
            onLostPointerCapture={() => onDriveInput?.('right', false)}
            onBlur={() => onDriveInput?.('right', false)}
            onClick={(e) => {
              if (!onDriveInput || e.detail === 0) onMove('right');
            }}
            title="Turn Right (→ or D)"
            className="p-1.5 rounded bg-slate-900 border border-slate-700 hover:bg-cyan-500/20 hover:border-cyan-400 text-slate-200 active:bg-cyan-500/40 transition-colors"
          >
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="text-center text-[9px] font-mono text-slate-500 pt-0.5">
          Press <span className="text-cyan-300 font-bold">↑ ↓ ← →</span> or <span className="text-cyan-300 font-bold">WASD</span> to walk
        </div>
      </div>
    </div>
  );
};
