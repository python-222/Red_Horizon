import React, { useState, useMemo } from 'react';
import {
  Compass,
  Route,
  MapPin,
  ArrowLeftRight,
  Navigation,
  Eye,
  X,
  Search,
  AlertTriangle,
  Mountain,
} from 'lucide-react';
import {
  MARS_LANDFORMS,
  LANDFORM_CATEGORY_COLORS,
  LANDMARK_BY_ID,
  LandmarkTier,
  MarsLandform,
  PlanetaryRoutePlan,
  TraversalDifficulty,
  computePlanetaryRoute,
  formatAreographicCoords,
  marsDistanceKm,
} from '../data/marsTerrain';
import { resolveRegionalEnvironment } from '../data/marsClimateEngine';
import { playChirpSound, playAckTone } from '../utils/audioAlerts';

interface PlanetaryAtlasDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  currentAstroLatLng: { lat: number; lng: number };
  currentAstroElevMeters: number;
  locomotionMode: 'rover' | 'eva_walk';
  speedTorqueSetting: number;
  activeTargetId: string;
  plannedRoute: PlanetaryRoutePlan | null;
  onSetPlannedRoute: (route: PlanetaryRoutePlan | null) => void;
  onFocusMapLatLng: (lat: number, lng: number, zoom?: number) => void;
  onFocusRouteBounds: (route: PlanetaryRoutePlan) => void;
  onSelectTarget: (id: string, options?: { autopilot?: boolean }) => void;
  onDeployAndAutopilotRoute: (route: PlanetaryRoutePlan) => void;
  emergencyRtbActive?: boolean;
}

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

const ROUTE_PRESETS: Array<{ label: string; fromId: string; toId: string }> = [
  { label: 'Tharsis Bulge → Valles Marineris', fromId: 'LF-THARSIS-BULGE', toId: 'LF-VALLES-MARINERIS' },
  { label: 'Olympus Mons → Northern Lowlands', fromId: 'LF-OLYMPUS-MONS', toId: 'LF-NORTHERN-LOWLANDS' },
  { label: 'Southern Highlands → Hellas Planitia', fromId: 'LF-SOUTHERN-HIGHLANDS', toId: 'LF-HELLAS-PLANITIA' },
  { label: 'Planum Boreum → Syrtis Major', fromId: 'LF-PLANUM-BOREUM', toId: 'LF-SYRTIS-MAJOR' },
];

export const PlanetaryAtlasDrawer: React.FC<PlanetaryAtlasDrawerProps> = ({
  isOpen,
  onClose,
  currentAstroLatLng,
  currentAstroElevMeters,
  locomotionMode,
  speedTorqueSetting,
  activeTargetId,
  plannedRoute,
  onSetPlannedRoute,
  onFocusMapLatLng,
  onFocusRouteBounds,
  onSelectTarget,
  onDeployAndAutopilotRoute,
  emergencyRtbActive = false,
}) => {
  const [subTab, setSubTab] = useState<'atlas' | 'route'>('atlas');
  const [tierFilter, setTierFilter] = useState<'all' | LandmarkTier>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string>('LF-OLYMPUS-MONS');

  const [originId, setOriginId] = useState<string>('LF-THARSIS-BULGE');
  const [destinationId, setDestinationId] = useState<string>('LF-VALLES-MARINERIS');

  const sortedLandmarks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return MARS_LANDFORMS.map((lf) => ({
      ...lf,
      distanceKm: marsDistanceKm(currentAstroLatLng, { lat: lf.lat, lng: lf.lng }),
      categoryMeta: LANDFORM_CATEGORY_COLORS[lf.category],
    }))
      .filter((lf) => (tierFilter === 'all' ? true : lf.tier === tierFilter))
      .filter((lf) =>
        q.length === 0
          ? true
          : lf.name.toLowerCase().includes(q) ||
            lf.region.toLowerCase().includes(q) ||
            lf.visualCharacteristics.toLowerCase().includes(q) ||
            lf.scienceSummary.toLowerCase().includes(q)
      )
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }, [currentAstroLatLng, tierFilter, searchQuery]);

  const computedRoute = useMemo<PlanetaryRoutePlan | null>(() => {
    const originNode =
      originId === '__CURRENT__'
        ? {
            id: '__CURRENT__',
            name: 'Current Rover / EVA Position',
            lat: currentAstroLatLng.lat,
            lng: currentAstroLatLng.lng,
            elevationMeters: currentAstroElevMeters,
          }
        : LANDMARK_BY_ID[originId]
          ? {
              id: LANDMARK_BY_ID[originId].id,
              name: LANDMARK_BY_ID[originId].name,
              lat: LANDMARK_BY_ID[originId].lat,
              lng: LANDMARK_BY_ID[originId].lng,
              elevationMeters: LANDMARK_BY_ID[originId].elevationMeters,
            }
          : null;

    if (!originNode) return null;
    return computePlanetaryRoute(originNode, destinationId, locomotionMode, speedTorqueSetting);
  }, [originId, destinationId, currentAstroLatLng, currentAstroElevMeters, locomotionMode, speedTorqueSetting]);

  if (!isOpen) return null;

  const handleRouteFromLandmark = (lf: MarsLandform) => {
    playChirpSound();
    setOriginId(lf.id);
    if (destinationId === lf.id) {
      const alt = MARS_LANDFORMS.find((item) => item.id !== lf.id);
      if (alt) setDestinationId(alt.id);
    }
    setSubTab('route');
  };

  const handlePlotRoute = () => {
    if (!computedRoute) return;
    playAckTone();
    onSetPlannedRoute(computedRoute);
    onFocusRouteBounds(computedRoute);
  };

  return (
    <section
      aria-label="Global Mars Atlas and Route Planner"
      className="planetary-atlas-drawer"
      style={{
        background: 'rgba(7, 11, 18, 0.95)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(80, 220, 255, 0.42)',
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '10px 14px',
          borderBottom: '1px solid rgba(80, 220, 255, 0.2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Compass className="w-4 h-4 text-cyan-400 shrink-0" />
          <div style={{ minWidth: 0 }}>
            <div className="text-xs font-semibold tracking-wider text-cyan-300 uppercase whitespace-nowrap">
              Planetary Atlas &amp; Route Engine
            </div>
            <div className="text-[10px] text-slate-400 font-mono tabular-nums">
              13 Martian Regions · Areocentric East Datum (R = 3,389.5 km)
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            playChirpSound();
            onClose();
          }}
          title="Close Planetary Atlas"
          style={{ padding: '4px 8px' }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Mode Switcher */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          padding: '8px 14px',
          borderBottom: '1px solid rgba(80, 220, 255, 0.14)',
        }}
      >
        <button
          type="button"
          className={subTab === 'atlas' ? 'active-tab' : ''}
          onClick={() => {
            playChirpSound();
            setSubTab('atlas');
          }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
        >
          <MapPin className="w-3.5 h-3.5" />
          <span>Landmarks ({MARS_LANDFORMS.length})</span>
        </button>
        <button
          type="button"
          className={subTab === 'route' ? 'active-tab' : ''}
          onClick={() => {
            playChirpSound();
            setSubTab('route');
          }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
        >
          <Route className="w-3.5 h-3.5" />
          <span>Route Planner</span>
        </button>
      </div>

      {/* Body */}
      {subTab === 'atlas' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Search + Tier Filters */}
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid rgba(80, 220, 255, 0.14)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Search className="w-3.5 h-3.5 text-slate-400" style={{ position: 'absolute', left: 9 }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search Olympus Mons, Valles Marineris, dunes..."
                style={{
                  width: '100%',
                  background: 'rgba(15, 23, 42, 0.85)',
                  border: '1px solid rgba(80, 220, 255, 0.25)',
                  color: '#e2f1f8',
                  padding: '6px 10px 6px 28px',
                  fontSize: 11,
                  outline: 'none',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'primary', label: 'Primary' },
                  { id: 'regional', label: 'Regional' },
                  { id: 'surface', label: 'Surface' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={tierFilter === f.id ? 'active-tab' : ''}
                  onClick={() => {
                    playChirpSound();
                    setTierFilter(f.id);
                  }}
                  style={{ flex: 1, padding: '4px 6px', fontSize: 9 }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Landmarks List */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sortedLandmarks.length === 0 ? (
              <div className="text-xs text-slate-400 py-6 text-center">
                No Martian landmarks match "{searchQuery}".
              </div>
            ) : (
              sortedLandmarks.map((lf) => {
                const isExpanded = expandedId === lf.id;
                const isSelected = activeTargetId === lf.id;
                const elevStr = `${lf.elevationMeters >= 0 ? '+' : ''}${lf.elevationMeters.toLocaleString()} m`;
                return (
                  <div
                    key={lf.id}
                    style={{
                      border: isSelected
                        ? `1px solid ${lf.categoryMeta.hex}`
                        : '1px solid rgba(80, 220, 255, 0.16)',
                      background: isSelected ? 'rgba(14, 30, 48, 0.85)' : 'rgba(10, 17, 28, 0.72)',
                      padding: '10px 12px',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        playChirpSound();
                        setExpandedId(isExpanded ? '' : lf.id);
                      }}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        border: 0,
                        padding: 0,
                        clipPath: 'none',
                        textTransform: 'none',
                        letterSpacing: 'normal',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, width: '100%' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              background: lf.categoryMeta.hex,
                              transform: 'rotate(45deg)',
                              flexShrink: 0,
                            }}
                          />
                          <span className="text-xs font-semibold text-slate-100 truncate">{lf.name}</span>
                        </span>
                        <span className="text-[11px] font-mono text-cyan-300 tabular-nums shrink-0">
                          {lf.distanceKm < 1 ? `${Math.round(lf.distanceKm * 1000)} m` : `${lf.distanceKm.toFixed(0)} km`}
                        </span>
                      </div>

                      <div className="text-[10px] font-mono text-slate-400 tabular-nums" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        <span style={{ color: lf.categoryMeta.hex }}>{lf.categoryMeta.label}</span>
                        <span>·</span>
                        <span>{TIER_LABEL[lf.tier]}</span>
                        <span>·</span>
                        <span>{formatAreographicCoords(lf.lat, lf.lng)}</span>
                        <span>·</span>
                        <span>Elev {elevStr}</span>
                      </div>
                    </button>

                    {isExpanded && (() => {
                      const regionalEnv = resolveRegionalEnvironment(lf.lat, lf.lng).environment;
                      return (
                        <div
                          style={{
                            marginTop: 8,
                            paddingTop: 8,
                            borderTop: '1px dashed rgba(80, 220, 255, 0.2)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                          }}
                        >
                          <div className="text-[10px] font-mono text-slate-300 tabular-nums">
                            <span className="text-slate-400">Dimensions:</span> {lf.dimensions.verticalMetric} · {lf.dimensions.horizontalMetric}
                          </div>
                          <div
                            style={{
                              background: 'rgba(8, 22, 36, 0.72)',
                              border: '1px solid rgba(82, 224, 255, 0.22)',
                              padding: '6px 8px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 3,
                            }}
                            className="text-[10px] font-mono tabular-nums"
                          >
                            <div className="text-cyan-300 font-semibold uppercase tracking-wider text-[9px]">
                              Regional Environment Profile
                            </div>
                            <div className="text-slate-200">
                              <span className="text-slate-400">Surface:</span> {regionalEnv.surfaceType}
                            </div>
                            <div className="text-slate-200">
                              <span className="text-slate-400">Pressure / Vis:</span> {regionalEnv.atmosphericPressurePa} Pa · {regionalEnv.visibilityLabel}
                            </div>
                            <div className="text-amber-300">
                              <span className="text-slate-400">Weather:</span> {regionalEnv.activeWeather}
                            </div>
                            {regionalEnv.navigationBoundaryNote && (
                              <div className="text-rose-300">
                                <span className="text-slate-400">Boundary:</span> {regionalEnv.navigationBoundaryNote}
                              </div>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-200 leading-relaxed" style={{ margin: 0 }}>
                            {lf.visualCharacteristics}
                          </p>
                          <div className="text-[10px] text-slate-300">
                            <span className="text-slate-400 font-mono">Weather:</span> {lf.weatherProfile}
                          </div>
                          <div className="text-[10px] font-mono">
                            <span className="text-slate-400">Traversal Difficulty:</span>{' '}
                            <span className={DIFFICULTY_TEXT_CLASS[lf.difficulty]}>{lf.difficulty}</span>
                          </div>
                          <ul style={{ margin: 0, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {lf.terrainConstraints.map((c) => (
                              <li key={c} className="text-[10px] text-slate-300 leading-snug">
                                {c}
                              </li>
                            ))}
                          </ul>

                          <div className="btns" style={{ marginTop: 4 }}>
                          <button
                            type="button"
                            onClick={() => {
                              playChirpSound();
                              onFocusMapLatLng(lf.lat, lf.lng, 4);
                            }}
                          >
                            <Eye className="w-3 h-3 inline mr-1" />
                            Fly Map
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRouteFromLandmark(lf)}
                          >
                            <Route className="w-3 h-3 inline mr-1" />
                            Route From Here
                          </button>
                          <button
                            type="button"
                            disabled={emergencyRtbActive}
                            onClick={() => onSelectTarget(lf.id, { autopilot: false })}
                          >
                            Set Target
                          </button>
                          <button
                            type="button"
                            className="on"
                            disabled={emergencyRtbActive}
                            onClick={() => onSelectTarget(lf.id, { autopilot: true })}
                          >
                            Autopilot
                          </button>
                        </div>
                      </div>
                      );
                    })()}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : (
        /* ROUTE PLANNER */
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Quick Regional Traversal Presets */}
          <div>
            <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1.5">
              Planetary Route Presets
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              {ROUTE_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    playChirpSound();
                    setOriginId(preset.fromId);
                    setDestinationId(preset.toId);
                  }}
                  style={{
                    fontSize: 9,
                    padding: '5px 7px',
                    textAlign: 'left',
                    textTransform: 'none',
                    letterSpacing: '0.02em',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={preset.label}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Origin & Destination Selectors */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <label className="text-[10px] font-mono text-slate-400 uppercase block mb-1">
                Origin Region / Coordinates
              </label>
              <select
                value={originId}
                onChange={(e) => {
                  playChirpSound();
                  setOriginId(e.target.value);
                }}
                style={{
                  width: '100%',
                  background: 'rgba(15, 23, 42, 0.92)',
                  border: '1px solid rgba(80, 220, 255, 0.3)',
                  color: '#e2f1f8',
                  padding: '6px 8px',
                  fontSize: 11,
                }}
              >
                <option value="__CURRENT__">
                  Current Rover / EVA Position ({formatAreographicCoords(currentAstroLatLng.lat, currentAstroLatLng.lng)})
                </option>
                {MARS_LANDFORMS.map((lf) => (
                  <option key={lf.id} value={lf.id}>
                    {lf.name} ({formatAreographicCoords(lf.lat, lf.lng)})
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <label className="text-[10px] font-mono text-slate-400 uppercase">
                Destination Landmark
              </label>
              <button
                type="button"
                onClick={() => {
                  if (originId === '__CURRENT__') return;
                  playChirpSound();
                  const prevOrig = originId;
                  setOriginId(destinationId);
                  setDestinationId(prevOrig);
                }}
                disabled={originId === '__CURRENT__'}
                style={{ padding: '2px 7px', fontSize: 9, opacity: originId === '__CURRENT__' ? 0.45 : 1 }}
              >
                <ArrowLeftRight className="w-3 h-3 inline mr-1" />
                Swap
              </button>
            </div>

            <select
              value={destinationId}
              onChange={(e) => {
                playChirpSound();
                setDestinationId(e.target.value);
              }}
              style={{
                width: '100%',
                background: 'rgba(15, 23, 42, 0.92)',
                border: '1px solid rgba(80, 220, 255, 0.3)',
                color: '#e2f1f8',
                padding: '6px 8px',
                fontSize: 11,
              }}
            >
              {MARS_LANDFORMS.map((lf) => (
                <option key={lf.id} value={lf.id}>
                  {lf.name} ({formatAreographicCoords(lf.lat, lf.lng)})
                </option>
              ))}
            </select>
          </div>

          {/* Computed Planetary Route Readout */}
          {computedRoute && (
            <div
              style={{
                border: '1px solid rgba(80, 220, 255, 0.25)',
                background: 'rgba(10, 18, 28, 0.86)',
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span className="text-[11px] font-semibold text-cyan-300 uppercase tracking-wider">
                  Route Telemetry &amp; Relief
                </span>
                <span className={`text-[10px] font-mono font-bold ${DIFFICULTY_TEXT_CLASS[computedRoute.overallDifficulty]}`}>
                  DIFFICULTY: {computedRoute.overallDifficulty}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }} className="font-mono tabular-nums">
                <div>
                  <div className="text-[9px] text-slate-400 uppercase">Corridor / Direct</div>
                  <div className="text-xs text-slate-100 font-semibold">
                    {computedRoute.corridorDistanceKm.toFixed(0)} km{' '}
                    <span className="text-[10px] text-slate-400">
                      ({computedRoute.directDistanceKm.toFixed(0)} km arc)
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-[9px] text-slate-400 uppercase">Elevation Delta</div>
                  <div
                    className={`text-xs font-semibold ${
                      computedRoute.elevationDeltaMeters >= 0 ? 'text-amber-300' : 'text-cyan-300'
                    }`}
                  >
                    {computedRoute.elevationDeltaMeters >= 0 ? '+' : ''}
                    {computedRoute.elevationDeltaMeters.toLocaleString()} m
                  </div>
                </div>
                <div>
                  <div className="text-[9px] text-slate-400 uppercase">Initial Bearing</div>
                  <div className="text-xs text-slate-100 font-semibold">{computedRoute.initialBearingDeg}°</div>
                </div>
                <div>
                  <div className="text-[9px] text-slate-400 uppercase">Est. Transit ETA</div>
                  <div className="text-xs text-amber-300 font-semibold">
                    {computedRoute.corridorEtaMinutes.toFixed(1)} min
                  </div>
                </div>
              </div>

              {/* Logical Adjacency Corridor */}
              <div style={{ borderTop: '1px dashed rgba(80, 220, 255, 0.2)', paddingTop: 7 }}>
                <div className="text-[10px] font-mono text-slate-400 uppercase mb-1 flex items-center gap-1">
                  <Mountain className="w-3 h-3 text-cyan-400" />
                  <span>Topological Traversal Segments ({computedRoute.segments.length})</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {computedRoute.segments.map((seg, idx) => (
                    <div
                      key={`${seg.fromId}-${seg.toId}-${idx}`}
                      style={{
                        background: 'rgba(15, 23, 42, 0.72)',
                        border: '1px solid rgba(80, 220, 255, 0.14)',
                        padding: '6px 8px',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }} className="text-[10px] font-mono tabular-nums">
                        <span className="text-slate-100 font-semibold truncate">
                          {idx + 1}. {seg.fromName} → {seg.toName}
                        </span>
                        <span className={DIFFICULTY_TEXT_CLASS[seg.difficulty]}>{seg.difficulty}</span>
                      </div>
                      <div className="text-[9px] font-mono text-slate-400 tabular-nums mt-0.5">
                        {seg.distanceKm.toFixed(0)} km · BRG {seg.bearingDeg}° · ΔElev{' '}
                        {seg.elevationDeltaMeters >= 0 ? '+' : ''}
                        {seg.elevationDeltaMeters.toLocaleString()} m
                      </div>
                      <div className="text-[10px] text-slate-300 mt-0.5 leading-snug">
                        {seg.hazards[0]}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Destination Active Environment Shift Preview */}
              {(() => {
                const destLandmark = LANDMARK_BY_ID[computedRoute.destinationId];
                if (!destLandmark) return null;
                const destEnv = resolveRegionalEnvironment(destLandmark.lat, destLandmark.lng).environment;
                return (
                  <div style={{ borderTop: '1px dashed rgba(80, 220, 255, 0.2)', paddingTop: 7 }} className="text-[10px] font-mono space-y-1">
                    <div className="text-cyan-300 uppercase">Destination Active Environment State</div>
                    <div className="text-slate-200">
                      Elev {destEnv.elevationMeters >= 0 ? '+' : ''}
                      {destEnv.elevationMeters.toLocaleString()} m · {destEnv.atmosphericPressurePa} Pa ({destEnv.visibilityLabel})
                    </div>
                    <div className="text-slate-300">{destEnv.surfaceType}</div>
                    <div className="text-amber-300">{destEnv.activeWeather}</div>
                  </div>
                );
              })()}

              {/* Terrain Constraints & Logistical Context */}
              <div style={{ borderTop: '1px dashed rgba(80, 220, 255, 0.2)', paddingTop: 7 }}>
                <div className="text-[10px] font-mono text-amber-300 uppercase mb-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  <span>Logistical &amp; Terrain Constraints</span>
                </div>
                <p className="text-[10px] text-slate-200 leading-relaxed" style={{ margin: '0 0 5px' }}>
                  {computedRoute.logisticalAdvisory}
                </p>
                <ul style={{ margin: 0, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {computedRoute.constraintsSummary.map((item) => (
                    <li key={item} className="text-[10px] text-slate-300 leading-snug">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Route Actions */}
              <div className="btns" style={{ marginTop: 2 }}>
                <button type="button" onClick={handlePlotRoute}>
                  <Eye className="w-3 h-3 inline mr-1" />
                  Show on Map
                </button>
                <button
                  type="button"
                  className="on"
                  disabled={emergencyRtbActive}
                  onClick={() => {
                    playAckTone();
                    onSetPlannedRoute(computedRoute);
                    onDeployAndAutopilotRoute(computedRoute);
                  }}
                >
                  <Navigation className="w-3 h-3 inline mr-1" />
                  {originId === '__CURRENT__' ? 'Autopilot Route' : 'Deploy & Autopilot'}
                </button>
                {plannedRoute && (
                  <button
                    type="button"
                    onClick={() => {
                      playChirpSound();
                      onSetPlannedRoute(null);
                    }}
                  >
                    Clear Preview
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
