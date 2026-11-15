import React, { useState, useRef, useEffect } from 'react';
import {
  Eye,
  Flame,
  Mountain,
  ZoomIn,
  ZoomOut,
  Crosshair,
  Navigation,
  Maximize2,
  Minimize2,
  RotateCcw,
  Compass,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ShieldCheck,
  MapPin,
  Cpu,
  X,
  Globe,
} from 'lucide-react';
import { playChirpSound, playAckTone } from '../utils/audioAlerts';
import { vehicleSim, type LiveVehiclePose } from '../utils/vehicleController';
import { slerpLatLng } from '../data/marsCartography';
import {
  MARS_CRATERS,
  MARS_WAYPOINTS,
  MARS_LANDFORMS,
  JEZERO_SCIENCE_FEATURES,
  MARS_REGIONAL_ZONES,
  LANDMARK_BY_ID,
  LANDFORM_CATEGORY_COLORS,
  WAYPOINT_TYPE_COLORS,
  VISOR_PROXIMITY_THRESHOLD_KM,
  RADIATION_HOTSPOTS,
  WORLD_HALF_EXTENT,
  LandmarkTier,
  TraversalDifficulty,
  formatAreographicCoords,
  getTerrainMetricsAt,
  jezeroLocalToLatLng,
  marsDistanceKm,
  marsBearingDeg,
  latLngToAzimuthalMeters,
  azimuthalMetersToLatLng,
  orthographicProject,
  orthographicInverse,
  estimatePlanetaryElevationMeters,
  sampleGreatCircleArc,
  estimateMarsTravelEtaMinutes,
} from '../data/marsTerrain';
import {
  ensureMarsAtlasLoaded,
  isMarsAtlasReady,
  renderLocalHiRiseDem,
  renderRegionalAzimuthalMars,
  renderOrthographicMarsGlobe,
} from '../utils/marsTileAtlas';

const DIFFICULTY_TEXT_CLASS: Record<TraversalDifficulty, string> = {
  LOW: 'text-emerald-300',
  MODERATE: 'text-cyan-300',
  HIGH: 'text-amber-300',
  EXTREME: 'text-rose-400',
};

export type MarsMapMode = 'optical' | 'thermal' | 'topographic';
export type MarsMapScope = 'sector' | 'regional' | 'global';
export type MarsMapOrientation = 'north_up' | 'heading_up';

interface TacticalMarsMapProps {
  astronautX: number;
  astronautY: number;
  heading: number;
  targetX: number;
  targetY: number;
  targetName: string;
  distanceToTarget: number;
  bearingToTarget: number;
  breadcrumbPath: Array<{ x: number; y: number }>;
  onMove?: (direction: 'forward' | 'backward' | 'left' | 'right') => void;
  onDriveInput?: (direction: 'forward' | 'backward' | 'left' | 'right', active: boolean, sourceId?: string) => void;
  onResetPosition?: () => void;
  onSelectWaypoint?: (waypointId: string, options?: { autopilot?: boolean }) => void;
  isFullScreen?: boolean;
  onToggleFullScreen?: () => void;
  showGuidanceTrail?: boolean;
  customWaypoints?: Array<{ id: number; x: number; y: number; isNext: boolean }>;
  astronautLatLng?: { lat: number; lng: number };
  targetLatLng?: { lat: number; lng: number };
  activeTargetId?: string;
  enableAutopilotTravel?: boolean;
  onToggleAutopilotTravel?: (enabled: boolean) => void;
  etaMinutes?: number;
  speedTorqueSetting?: number;
  locomotionMode?: 'rover' | 'eva_walk';
  discoveredFeatureIds?: string[];
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

function smootherstep01(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * c * (c * (c * 6 - 15) + 10);
}

export const TacticalMarsMap: React.FC<TacticalMarsMapProps> = ({
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
  onSelectWaypoint,
  isFullScreen = false,
  onToggleFullScreen,
  showGuidanceTrail = true,
  customWaypoints = [],
  astronautLatLng,
  targetLatLng,
  activeTargetId,
  enableAutopilotTravel = false,
  onToggleAutopilotTravel,
  etaMinutes,
  speedTorqueSetting = 1.0,
  locomotionMode = 'rover',
  discoveredFeatureIds = [],
  liveVehicleRef,
}) => {
  const [mapMode, setMapMode] = useState<MarsMapMode>('topographic');
  const [mapScope, setMapScope] = useState<MarsMapScope>('sector');
  const [orientation, setOrientation] = useState<MarsMapOrientation>('north_up');
  const [zoomLevel, setZoomLevel] = useState<number>(isFullScreen ? 0.55 : 0.44);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [atlasTick, setAtlasTick] = useState(0);
  const [hoverProbe, setHoverProbe] = useState<{
    coordStr: string;
    elevation: number;
    tempK: number;
    tempC: number;
    slope: number | null;
    terrainType: string;
    radiationRate: number | null;
  } | null>(null);
  const [showSafePath, setShowSafePath] = useState(true);
  const [showLandformList, setShowLandformList] = useState(false);
  const [landformTierFilter, setLandformTierFilter] = useState<'all' | LandmarkTier>('all');
  const [selectedPopup, setSelectedPopup] = useState<{
    id: string;
    name: string;
    categoryLabel: string;
    colorHex: string;
    description: string;
    latLng: { lat: number; lng: number };
    isLandform: boolean;
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const coordStampRef = useRef<HTMLDivElement>(null);
  const initialCoordStampRef = useRef<string>(
    `${formatAreographicCoords(
      (astronautLatLng ?? jezeroLocalToLatLng(astronautX, astronautY)).lat,
      (astronautLatLng ?? jezeroLocalToLatLng(astronautX, astronautY)).lng
    )} · ${Math.round(heading)}°`
  );
  const drawMapRef = useRef<(livePose?: LiveVehiclePose) => void>(null);
  const dragStartClientRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const wasDraggedRef = useRef(false);

  // Stream NASA/USGS public planetary tiles once and repaint when ready
  useEffect(() => {
    const unsub = ensureMarsAtlasLoaded(() => {
      setAtlasTick((t) => t + 1);
    });
    return unsub;
  }, []);

  const calcEtaMin = (distMeters: number) =>
    estimateMarsTravelEtaMinutes(distMeters, locomotionMode, speedTorqueSetting);

  const resolvedEtaMin = etaMinutes ?? calcEtaMin(distanceToTarget);

  const originLatLng = astronautLatLng ?? jezeroLocalToLatLng(astronautX, astronautY);
  const originLat = originLatLng.lat;
  const originLng = originLatLng.lng;
  const inJezeroSector = marsDistanceKm(originLatLng, { lat: 18.44, lng: 77.45 }) < 12;

  const visualCamRef = useRef({
    zoom: isFullScreen ? 0.55 : 0.44,
    panX: 0,
    panY: 0,
    curLat: originLat,
    curLng: originLng,
    curX: astronautX,
    curY: astronautY,
  });

  const smoothTransRef = useRef({
    animActive: false,
    startMs: 0,
    durationMs: 1600,
    fromLat: originLat,
    fromLng: originLng,
    toLat: originLat,
    toLng: originLng,
    fromX: astronautX,
    fromY: astronautY,
    toX: astronautX,
    toY: astronautY,
    fromZoom: isFullScreen ? 0.55 : 0.44,
    toZoom: isFullScreen ? 0.55 : 0.44,
    fromPanX: 0,
    fromPanY: 0,
    toPanX: 0,
    toPanY: 0,
    isLongHaul: false,
    prevLat: originLat,
    prevLng: originLng,
    prevX: astronautX,
    prevY: astronautY,
    lastTeleportEpoch: liveVehicleRef?.current?.teleportEpoch ?? 0,
    rafId: 0,
  });

  const startCanvasTransition = (opts: {
    fromLat?: number;
    fromLng?: number;
    toLat?: number;
    toLng?: number;
    fromX?: number;
    fromY?: number;
    toX?: number;
    toY?: number;
    toZoom?: number;
    toPanX?: number;
    toPanY?: number;
    durationMs?: number;
  }) => {
    const tr = smoothTransRef.current;
    const vc = visualCamRef.current;
    if (tr.rafId) {
      cancelAnimationFrame(tr.rafId);
      tr.rafId = 0;
    }

    const fromLat = opts.fromLat ?? (tr.animActive ? vc.curLat : tr.prevLat);
    const fromLng = opts.fromLng ?? (tr.animActive ? vc.curLng : tr.prevLng);
    const toLat = opts.toLat ?? tr.toLat;
    const toLng = opts.toLng ?? tr.toLng;
    const fromX = opts.fromX ?? (tr.animActive ? vc.curX : tr.prevX);
    const fromY = opts.fromY ?? (tr.animActive ? vc.curY : tr.prevY);
    const toX = opts.toX ?? tr.toX;
    const toY = opts.toY ?? tr.toY;
    const fromZoom = tr.animActive ? vc.zoom : zoomLevel;
    const toZoom = opts.toZoom ?? zoomLevel;
    const fromPanX = tr.animActive ? vc.panX : panOffset.x;
    const fromPanY = tr.animActive ? vc.panY : panOffset.y;
    const toPanX = opts.toPanX ?? panOffset.x;
    const toPanY = opts.toPanY ?? panOffset.y;

    const distKm = marsDistanceKm({ lat: fromLat, lng: fromLng }, { lat: toLat, lng: toLng });
    const isLongHaul = distKm > 10;
    const durationMs =
      opts.durationMs ?? Math.round(Math.min(2600, Math.max(1500, 1500 + distKm * 0.45)));

    tr.animActive = true;
    tr.startMs = performance.now();
    tr.durationMs = durationMs;
    tr.fromLat = fromLat;
    tr.fromLng = fromLng;
    tr.toLat = toLat;
    tr.toLng = toLng;
    tr.fromX = fromX;
    tr.fromY = fromY;
    tr.toX = toX;
    tr.toY = toY;
    tr.fromZoom = fromZoom;
    tr.toZoom = toZoom;
    tr.fromPanX = fromPanX;
    tr.fromPanY = fromPanY;
    tr.toPanX = toPanX;
    tr.toPanY = toPanY;
    tr.isLongHaul = isLongHaul;

    const step = (now: number) => {
      if (!smoothTransRef.current.animActive) return;
      const curTr = smoothTransRef.current;
      const rawU = Math.min(1, (now - curTr.startMs) / Math.max(1, curTr.durationMs));
      const easedU = smootherstep01(rawU);

      if (distKm > 0.005) {
        const ll = slerpLatLng(
          { lat: curTr.fromLat, lng: curTr.fromLng },
          { lat: curTr.toLat, lng: curTr.toLng },
          easedU
        );
        vc.curLat = ll.lat;
        vc.curLng = ll.lng;
      } else {
        vc.curLat = curTr.toLat;
        vc.curLng = curTr.toLng;
      }

      vc.curX = curTr.fromX + (curTr.toX - curTr.fromX) * easedU;
      vc.curY = curTr.fromY + (curTr.toY - curTr.fromY) * easedU;
      vc.panX = curTr.fromPanX + (curTr.toPanX - curTr.fromPanX) * easedU;
      vc.panY = curTr.fromPanY + (curTr.toPanY - curTr.fromPanY) * easedU;

      const baseZoom = curTr.fromZoom + (curTr.toZoom - curTr.fromZoom) * easedU;
      vc.zoom = curTr.isLongHaul
        ? Math.max(0.16, baseZoom * (1 - 0.55 * Math.sin(Math.PI * easedU)))
        : baseZoom;

      drawMapRef.current?.(liveVehicleRef?.current);

      if (rawU >= 1) {
        curTr.animActive = false;
        curTr.rafId = 0;
        vc.curLat = curTr.toLat;
        vc.curLng = curTr.toLng;
        vc.curX = curTr.toX;
        vc.curY = curTr.toY;
        vc.panX = curTr.toPanX;
        vc.panY = curTr.toPanY;
        vc.zoom = curTr.toZoom;
        setPanOffset({ x: curTr.toPanX, y: curTr.toPanY });
        setZoomLevel(curTr.toZoom);
        drawMapRef.current?.(liveVehicleRef?.current);
        return;
      }

      curTr.rafId = requestAnimationFrame(step);
    };

    tr.rafId = requestAnimationFrame(step);
  };

  // Detect prop-driven coordinate shifts (> 0.25 km) & launch smooth Slerp/Lerp transition
  useEffect(() => {
    const tr = smoothTransRef.current;
    const vc = visualCamRef.current;
    const distKm = marsDistanceKm(
      { lat: tr.prevLat, lng: tr.prevLng },
      { lat: originLat, lng: originLng }
    );
    if (distKm > 0.25) {
      const fromLat = tr.animActive ? vc.curLat : tr.prevLat;
      const fromLng = tr.animActive ? vc.curLng : tr.prevLng;
      const fromX = tr.animActive ? vc.curX : tr.prevX;
      const fromY = tr.animActive ? vc.curY : tr.prevY;
      tr.prevLat = originLat;
      tr.prevLng = originLng;
      tr.prevX = astronautX;
      tr.prevY = astronautY;
      startCanvasTransition({
        fromLat,
        fromLng,
        toLat: originLat,
        toLng: originLng,
        fromX,
        fromY,
        toX: astronautX,
        toY: astronautY,
        toPanX: 0,
        toPanY: 0,
      });
    } else {
      tr.prevLat = originLat;
      tr.prevLng = originLng;
      tr.prevX = astronautX;
      tr.prevY = astronautY;
      if (!tr.animActive) {
        vc.curLat = originLat;
        vc.curLng = originLng;
        vc.curX = astronautX;
        vc.curY = astronautY;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originLat, originLng, astronautX, astronautY]);

  // Keep idle visual camera synced with React panOffset/zoomLevel & cancel active transition on unmount
  useEffect(() => {
    if (!smoothTransRef.current.animActive) {
      visualCamRef.current.panX = panOffset.x;
      visualCamRef.current.panY = panOffset.y;
      visualCamRef.current.zoom = zoomLevel;
    }
  }, [panOffset, zoomLevel]);

  useEffect(() => {
    const trRef = smoothTransRef;
    return () => {
      if (trRef.current.rafId) {
        cancelAnimationFrame(trRef.current.rafId);
        trRef.current.rafId = 0;
      }
    };
  }, []);

  // Map screen rotation: North-Up = 0°, Heading-Up = -heading°
  const rotationDeg = orientation === 'heading_up' ? -heading : 0;

  // Regional span (meters per pixel) and Global globe radius
  const getRegionalMetersPerPx = (z: number) =>
    (3_200_000 / Math.max(0.16, z)) / (isFullScreen ? 900 : 420);
  const regionalMetersPerPx = getRegionalMetersPerPx(zoomLevel);

  const screenToGeo = (
    canvasX: number,
    canvasY: number,
    width: number,
    height: number,
    scaleX: number,
    scaleY: number
  ): { lat: number; lng: number } | null => {
    const activePanX = smoothTransRef.current.animActive ? visualCamRef.current.panX : panOffset.x;
    const activePanY = smoothTransRef.current.animActive ? visualCamRef.current.panY : panOffset.y;
    const activeZoom = smoothTransRef.current.animActive ? visualCamRef.current.zoom : zoomLevel;
    const activeOrigin = smoothTransRef.current.animActive
      ? { lat: visualCamRef.current.curLat, lng: visualCamRef.current.curLng }
      : originLatLng;
    const centerScreenX = width / 2 + activePanX * scaleX;
    const centerScreenY = height / 2 + activePanY * scaleY;

    if (mapScope === 'global') {
      const globeRadius = Math.min(width, height) * (isFullScreen ? 0.43 : 0.44);
      const sx = (canvasX - width / 2) / globeRadius;
      const sy = (height / 2 - canvasY) / globeRadius;
      if (sx * sx + sy * sy > 1) return null;
      const rotRad = (rotationDeg * Math.PI) / 180;
      const nx = sx * Math.cos(rotRad) + sy * Math.sin(rotRad);
      const ny = -sx * Math.sin(rotRad) + sy * Math.cos(rotRad);
      return orthographicInverse(nx, ny, activeOrigin);
    }

    const dxScreen = canvasX - centerScreenX;
    const dyScreen = centerScreenY - canvasY; // +up
    const rotRad = (rotationDeg * Math.PI) / 180;
    const unrotEast = dxScreen * Math.cos(rotRad) + dyScreen * Math.sin(rotRad);
    const unrotNorth = -dxScreen * Math.sin(rotRad) + dyScreen * Math.cos(rotRad);

    if (mapScope === 'regional') {
      const mpp = getRegionalMetersPerPx(activeZoom);
      return azimuthalMetersToLatLng(
        unrotEast * mpp,
        unrotNorth * mpp,
        activeOrigin
      );
    }

    // Sector scope: meters around astronaut
    const worldScale = (width * 0.42 * activeZoom) / 550;
    const worldDx = unrotEast / worldScale;
    const worldDy = unrotNorth / worldScale;
    if (inJezeroSector) {
      return jezeroLocalToLatLng(astronautX + worldDx, astronautY + worldDy);
    }
    return azimuthalMetersToLatLng(worldDx, worldDy, activeOrigin);
  };

  const handleModeSwitch = (mode: MarsMapMode) => {
    playChirpSound();
    setMapMode(mode);
  };

  const handleScopeSwitch = (scope: MarsMapScope) => {
    playChirpSound();
    setMapScope(scope);
    const targetZoom =
      scope === 'sector' ? (isFullScreen ? 0.55 : 0.44) : scope === 'regional' ? 0.65 : zoomLevel;
    const live = liveVehicleRef?.current;
    const curLat = live?.lat ?? originLat;
    const curLng = live?.lng ?? originLng;
    const curX = live && !live.isGlobalOverride ? live.x : astronautX;
    const curY = live && !live.isGlobalOverride ? live.y : astronautY;
    startCanvasTransition({
      fromLat: curLat,
      fromLng: curLng,
      toLat: curLat,
      toLng: curLng,
      fromX: curX,
      fromY: curY,
      toX: curX,
      toY: curY,
      toZoom: targetZoom,
      toPanX: 0,
      toPanY: 0,
      durationMs: 1500,
    });
  };

  const handleCenterOnAstronaut = () => {
    playAckTone();
    const live = liveVehicleRef?.current;
    const curLat = live?.lat ?? originLat;
    const curLng = live?.lng ?? originLng;
    const curX = live && !live.isGlobalOverride ? live.x : astronautX;
    const curY = live && !live.isGlobalOverride ? live.y : astronautY;
    startCanvasTransition({
      fromLat: curLat,
      fromLng: curLng,
      toLat: curLat,
      toLng: curLng,
      fromX: curX,
      fromY: curY,
      toX: curX,
      toY: curY,
      toPanX: 0,
      toPanY: 0,
      durationMs: 1500,
    });
  };

  const handleSmoothZoomStep = (delta: number) => {
    const tr = smoothTransRef.current;
    const baseZ = tr.animActive ? tr.toZoom : zoomLevel;
    const nextZoom = Math.max(0.18, Math.min(2.8, baseZ + delta));
    const live = liveVehicleRef?.current;
    const curLat = live?.lat ?? originLat;
    const curLng = live?.lng ?? originLng;
    const curX = live && !live.isGlobalOverride ? live.x : astronautX;
    const curY = live && !live.isGlobalOverride ? live.y : astronautY;
    startCanvasTransition({
      fromLat: curLat,
      fromLng: curLng,
      toLat: curLat,
      toLng: curLng,
      fromX: curX,
      fromY: curY,
      toX: curX,
      toY: curY,
      toZoom: nextZoom,
      durationMs: 480,
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (smoothTransRef.current.animActive) {
      if (smoothTransRef.current.rafId) {
        cancelAnimationFrame(smoothTransRef.current.rafId);
        smoothTransRef.current.rafId = 0;
      }
      smoothTransRef.current.animActive = false;
      setPanOffset({ x: visualCamRef.current.panX, y: visualCamRef.current.panY });
    }
    setIsDragging(true);
    wasDraggedRef.current = false;
    dragStartClientRef.current = { x: e.clientX, y: e.clientY };
    const startPanX = visualCamRef.current.panX;
    const startPanY = visualCamRef.current.panY;
    setDragStart({ x: e.clientX - startPanX, y: e.clientY - startPanY });
  };

  const regionalLandforms = React.useMemo(
    () =>
      MARS_LANDFORMS.map((lf) => {
        const ll = { lat: lf.lat, lng: lf.lng };
        const origin = { lat: originLat, lng: originLng };
        const dKm = marsDistanceKm(origin, ll);
        const brgRad = (marsBearingDeg(origin, ll) * Math.PI) / 180;
        const az = latLngToAzimuthalMeters(ll, origin);
        return {
          ...lf,
          distanceKm: dKm,
          azX: az.x,
          azY: az.y,
          plotX: Math.sin(brgRad) * 1550,
          plotZ: Math.cos(brgRad) * 1550,
        };
      }),
    [originLat, originLng]
  );

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (wasDraggedRef.current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const clickCssX = e.clientX - rect.left;
    const clickCssY = e.clientY - rect.top;

    const scaleX = canvasRef.current.width / Math.max(1, rect.width);
    const scaleY = canvasRef.current.height / Math.max(1, rect.height);
    const canvasX = clickCssX * scaleX;
    const canvasY = clickCssY * scaleY;

    const width = canvasRef.current.width;
    const height = canvasRef.current.height;
    const centerScreenX = width / 2 + panOffset.x * scaleX;
    const centerScreenY = height / 2 + panOffset.y * scaleY;

    if (mapScope === 'global') {
      const globeRadius = Math.min(width, height) * (isFullScreen ? 0.43 : 0.44);
      for (const lf of regionalLandforms) {
        const proj = orthographicProject({ lat: lf.lat, lng: lf.lng }, originLatLng);
        if (!proj.visible) continue;
        const rot = rotatePoint(proj.nx * globeRadius, -proj.ny * globeRadius, -rotationDeg);
        const px = width / 2 + rot.x;
        const py = height / 2 + rot.y;
        if (Math.hypot(canvasX - px, canvasY - py) < 18 * scaleX) {
          const cat = LANDFORM_CATEGORY_COLORS[lf.category];
          playAckTone();
          setSelectedPopup({
            id: lf.id,
            name: lf.name,
            categoryLabel: cat.label,
            colorHex: cat.hex,
            description: lf.scienceSummary,
            latLng: { lat: lf.lat, lng: lf.lng },
            isLandform: true,
          });
          onSelectWaypoint?.(lf.id);
          return;
        }
      }
      return;
    }

    if (mapScope === 'regional') {
      for (const lf of regionalLandforms) {
        const pxX = lf.azX / regionalMetersPerPx;
        const pxY = -lf.azY / regionalMetersPerPx;
        const rot = rotatePoint(pxX, pxY, -rotationDeg);
        const sx = centerScreenX + rot.x;
        const sy = centerScreenY + rot.y;
        if (Math.hypot(canvasX - sx, canvasY - sy) < 18 * scaleX) {
          const cat = LANDFORM_CATEGORY_COLORS[lf.category];
          playAckTone();
          setSelectedPopup({
            id: lf.id,
            name: lf.name,
            categoryLabel: cat.label,
            colorHex: cat.hex,
            description: lf.scienceSummary,
            latLng: { lat: lf.lat, lng: lf.lng },
            isLandform: true,
          });
          onSelectWaypoint?.(lf.id);
          return;
        }
      }
      return;
    }

    // Sector scope hit tests
    const worldScale = (width * 0.42 * zoomLevel) / 550;
    const toScreenPx = (wx: number, wy: number) => {
      const rot = rotatePoint((wx - astronautX) * worldScale, -(wy - astronautY) * worldScale, -rotationDeg);
      return {
        x: centerScreenX + rot.x,
        y: centerScreenY + rot.y,
      };
    };

    if (inJezeroSector) {
      for (const feat of JEZERO_SCIENCE_FEATURES) {
        if (!discoveredFeatureIds.includes(feat.id)) continue;
        const pt = toScreenPx(feat.x, feat.z);
        if (Math.hypot(canvasX - pt.x, canvasY - pt.y) < 18 * scaleX) {
          playAckTone();
          const featLL = jezeroLocalToLatLng(feat.x, feat.z);
          setSelectedPopup({
            id: feat.id,
            name: feat.name,
            categoryLabel: `${feat.categoryLabel} · DISCOVERED`,
            colorHex: feat.colorHex,
            description: `${feat.mineralSignature} — ${feat.summary}`,
            latLng: featLL,
            isLandform: false,
          });
          onSelectWaypoint?.(feat.id);
          return;
        }
      }

      for (const wp of MARS_WAYPOINTS) {
        const pt = toScreenPx(wp.x, wp.z);
        if (Math.hypot(canvasX - pt.x, canvasY - pt.y) < 18 * scaleX) {
          playAckTone();
          const wpLL = jezeroLocalToLatLng(wp.x, wp.z);
          setSelectedPopup({
            id: wp.id,
            name: wp.name,
            categoryLabel: wp.type.toUpperCase(),
            colorHex: WAYPOINT_TYPE_COLORS[wp.type].hex,
            description: wp.description,
            latLng: wpLL,
            isLandform: false,
          });
          onSelectWaypoint?.(wp.id);
          return;
        }
      }
    }

    for (const lf of regionalLandforms.filter((l) => l.distanceKm <= VISOR_PROXIMITY_THRESHOLD_KM)) {
      const pt = toScreenPx(astronautX + lf.plotX, astronautY + lf.plotZ);
      if (Math.hypot(canvasX - pt.x, canvasY - pt.y) < 18 * scaleX) {
        const cat = LANDFORM_CATEGORY_COLORS[lf.category];
        playAckTone();
        setSelectedPopup({
          id: lf.id,
          name: lf.name,
          categoryLabel: cat.label,
          colorHex: cat.hex,
          description: lf.scienceSummary,
          latLng: { lat: lf.lat, lng: lf.lng },
          isLandform: true,
        });
        onSelectWaypoint?.(lf.id);
        return;
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      if (Math.hypot(e.clientX - dragStartClientRef.current.x, e.clientY - dragStartClientRef.current.y) > 5) {
        wasDraggedRef.current = true;
      }
      setPanOffset({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }

    if (canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const scaleX = canvasRef.current.width / Math.max(1, rect.width || 1);
      const scaleY = canvasRef.current.height / Math.max(1, rect.height || 1);
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;

      const geo = screenToGeo(
        canvasX,
        canvasY,
        canvasRef.current.width,
        canvasRef.current.height,
        scaleX,
        scaleY
      );
      if (!geo) {
        setHoverProbe(null);
        return;
      }

      if (mapScope === 'sector' && inJezeroSector) {
        const worldScale = (canvasRef.current.width * 0.42 * zoomLevel) / 550;
        const centerX = canvasRef.current.width / 2 + panOffset.x * scaleX;
        const centerY = canvasRef.current.height / 2 + panOffset.y * scaleY;
        const rotRad = (rotationDeg * Math.PI) / 180;
        const dx = canvasX - centerX;
        const dy = centerY - canvasY;
        const worldX = astronautX + (dx * Math.cos(rotRad) + dy * Math.sin(rotRad)) / worldScale;
        const worldZ = astronautY + (-dx * Math.sin(rotRad) + dy * Math.cos(rotRad)) / worldScale;
        const metrics = getTerrainMetricsAt(worldX, worldZ);
        const isBedrock = metrics.geology === 'BASALT_BEDROCK' || metrics.geology === 'BLOCKY_TALUS';
        const tempK = Math.round(isBedrock ? 246 + Math.sin(worldX * 0.01) * 6 : 210 + Math.sin(worldX * 0.01) * 8);
        setHoverProbe({
          coordStr: formatAreographicCoords(geo.lat, geo.lng),
          elevation: metrics.elevationMeters,
          tempK,
          tempC: Math.round(tempK - 273.15),
          slope: metrics.slopePercentage,
          terrainType: metrics.geology.replace('_', ' '),
          radiationRate: metrics.activeHotspot ? metrics.activeHotspot.doseRateMicroSvHr : null,
        });
      } else {
        const elev = estimatePlanetaryElevationMeters(geo.lat, geo.lng);
        const tempK = Math.round(Math.max(145, 224 - Math.abs(geo.lat) * 0.68 - elev * 0.0012));
        setHoverProbe({
          coordStr: formatAreographicCoords(geo.lat, geo.lng),
          elevation: elev,
          tempK,
          tempC: Math.round(tempK - 273.15),
          slope: null,
          terrainType: Math.abs(geo.lat) > 78 ? 'POLAR ICE CAP' : geo.lat > 18 ? 'NORTHERN LOWLANDS' : 'CRATERED HIGHLANDS',
          radiationRate: null,
        });
      }
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Render Mini-Map Canvas (Sector HiRISE DEM / Regional Azimuthal / Global Orthographic Globe)
  useEffect(() => {
    const drawMap = (livePose?: LiveVehiclePose) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const tr = smoothTransRef.current;
      const vc = visualCamRef.current;
      const isAnim = tr.animActive;

      const curHeading = livePose ? livePose.heading : heading;
      const curRotationDeg = orientation === 'heading_up' ? -curHeading : 0;
      const curOriginLatLng = isAnim
        ? { lat: vc.curLat, lng: vc.curLng }
        : livePose?.lat !== undefined && livePose?.lng !== undefined
          ? { lat: livePose.lat, lng: livePose.lng }
          : originLatLng;
      const curInJezeroSector = marsDistanceKm(curOriginLatLng, { lat: 18.44, lng: 77.45 }) < 12;
      const curAstroX = isAnim
        ? vc.curX
        : livePose && !livePose.isGlobalOverride
          ? livePose.x
          : astronautX;
      const curAstroY = isAnim
        ? vc.curY
        : livePose && !livePose.isGlobalOverride
          ? livePose.y
          : astronautY;
      const curZoom = isAnim ? vc.zoom : zoomLevel;
      const curPanX = isAnim ? vc.panX : panOffset.x;
      const curPanY = isAnim ? vc.panY : panOffset.y;
      const curRegionalMpp = getRegionalMetersPerPx(curZoom);

      if (coordStampRef.current) {
        coordStampRef.current.textContent = `${formatAreographicCoords(
          curOriginLatLng.lat,
          curOriginLatLng.lng
        )} · ${Math.round(curHeading)}°`;
      }

      const curLandforms = livePose || isAnim
        ? MARS_LANDFORMS.map((lf) => {
            const ll = { lat: lf.lat, lng: lf.lng };
            const dKm = marsDistanceKm(curOriginLatLng, ll);
            const brgRad = (marsBearingDeg(curOriginLatLng, ll) * Math.PI) / 180;
            return {
              ...lf,
              distanceKm: dKm,
              plotX: Math.sin(brgRad) * 1550,
              plotZ: Math.cos(brgRad) * 1550,
            };
          })
        : regionalLandforms;

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#04070e';
      ctx.fillRect(0, 0, width, height);

      const rect = canvas.getBoundingClientRect();
      const scaleX = width / Math.max(1, rect.width || width);
      const scaleY = height / Math.max(1, rect.height || height);
      const centerScreenX = width / 2 + curPanX * scaleX;
      const centerScreenY = height / 2 + curPanY * scaleY;

      // ------------------------------------------------------------------
      // SCOPE A: GLOBAL SPHERICAL ORTHOGRAPHIC MARS GLOBE (ZERO POLE DISTORTION)
      // ------------------------------------------------------------------
      if (mapScope === 'global') {
        const globeRadius = Math.min(width, height) * (isFullScreen ? 0.43 : 0.44);
        const cx = width / 2;
        const cy = height / 2;

        renderOrthographicMarsGlobe(
          ctx,
          width,
          height,
          curOriginLatLng,
          globeRadius,
          curRotationDeg,
          mapMode,
          isFullScreen ? 260 : 170
        );

        // Clip vector overlays cleanly to sphere horizon
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, globeRadius, 0, Math.PI * 2);
        ctx.clip();

        // Latitude / Longitude Graticule (30° grid)
        ctx.strokeStyle = 'rgba(82, 224, 255, 0.2)';
        ctx.lineWidth = 0.8;
        for (let lat = -60; lat <= 60; lat += 30) {
          ctx.beginPath();
          let penDown = false;
          for (let lng = -180; lng <= 180; lng += 6) {
            const p = orthographicProject({ lat, lng }, curOriginLatLng);
            if (!p.visible) {
              penDown = false;
              continue;
            }
            const rot = rotatePoint(p.nx * globeRadius, -p.ny * globeRadius, -curRotationDeg);
            if (!penDown) {
              ctx.moveTo(cx + rot.x, cy + rot.y);
              penDown = true;
            } else {
              ctx.lineTo(cx + rot.x, cy + rot.y);
            }
          }
          ctx.stroke();
        }
        for (let lng = -180; lng < 180; lng += 30) {
          ctx.beginPath();
          let penDown = false;
          for (let lat = -88; lat <= 88; lat += 6) {
            const p = orthographicProject({ lat, lng }, curOriginLatLng);
            if (!p.visible) {
              penDown = false;
              continue;
            }
            const rot = rotatePoint(p.nx * globeRadius, -p.ny * globeRadius, -curRotationDeg);
            if (!penDown) {
              ctx.moveTo(cx + rot.x, cy + rot.y);
              penDown = true;
            } else {
              ctx.lineTo(cx + rot.x, cy + rot.y);
            }
          }
          ctx.stroke();
        }

        // Project Regional Zones & Dichotomy onto Sphere
        MARS_REGIONAL_ZONES.forEach((zone) => {
          ctx.save();
          ctx.strokeStyle = zone.colorHex;
          ctx.fillStyle = `${zone.colorHex}22`;
          ctx.lineWidth = 1.4;
          ctx.setLineDash([4, 3]);
          if (zone.kind === 'circle' && zone.points[0] && zone.radiusMeters) {
            const [cLat, cLng] = zone.points[0];
            const angularKm = zone.radiusMeters / 1000;
            ctx.beginPath();
            let started = false;
            for (let a = 0; a <= 360; a += 15) {
              const rad = (a * Math.PI) / 180;
              const dLat = (angularKm / 3389.5) * (180 / Math.PI) * Math.cos(rad);
              const dLon =
                ((angularKm / 3389.5) * (180 / Math.PI) * Math.sin(rad)) /
                Math.max(0.15, Math.cos((cLat * Math.PI) / 180));
              const p = orthographicProject({ lat: cLat + dLat, lng: cLng + dLon }, curOriginLatLng);
              if (!p.visible) {
                started = false;
                continue;
              }
              const rot = rotatePoint(p.nx * globeRadius, -p.ny * globeRadius, -curRotationDeg);
              if (!started) {
                ctx.moveTo(cx + rot.x, cy + rot.y);
                started = true;
              } else {
                ctx.lineTo(cx + rot.x, cy + rot.y);
              }
            }
            ctx.stroke();
          } else {
            ctx.beginPath();
            let started = false;
            zone.points.forEach(([zLat, zLng]) => {
              const p = orthographicProject({ lat: zLat, lng: zLng }, curOriginLatLng);
              if (!p.visible) {
                started = false;
                return;
              }
              const rot = rotatePoint(p.nx * globeRadius, -p.ny * globeRadius, -curRotationDeg);
              if (!started) {
                ctx.moveTo(cx + rot.x, cy + rot.y);
                started = true;
              } else {
                ctx.lineTo(cx + rot.x, cy + rot.y);
              }
            });
            if (zone.kind === 'polygon' && started) {
              ctx.closePath();
              ctx.fill();
            }
            ctx.stroke();
          }
          ctx.restore();
        });

        // Great-Circle Guidance Arc to Target
        if (showSafePath && showGuidanceTrail) {
          const destGeo = targetLatLng ?? jezeroLocalToLatLng(targetX, targetY);
          const arc = sampleGreatCircleArc(curOriginLatLng, destGeo, 28);
          ctx.save();
          ctx.strokeStyle = '#52e0ff';
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          let pen = false;
          arc.forEach((pt) => {
            const p = orthographicProject(pt, curOriginLatLng);
            if (!p.visible) {
              pen = false;
              return;
            }
            const rot = rotatePoint(p.nx * globeRadius, -p.ny * globeRadius, -curRotationDeg);
            if (!pen) {
              ctx.moveTo(cx + rot.x, cy + rot.y);
              pen = true;
            } else {
              ctx.lineTo(cx + rot.x, cy + rot.y);
            }
          });
          ctx.stroke();
          ctx.restore();
        }

        // Front-Hemisphere Planetary Landmarks (All 13 proportional & non-distorted)
        curLandforms.forEach((lf) => {
          const p = orthographicProject({ lat: lf.lat, lng: lf.lng }, curOriginLatLng);
          if (!p.visible) return;
          const rot = rotatePoint(p.nx * globeRadius, -p.ny * globeRadius, -curRotationDeg);
          const sx = cx + rot.x;
          const sy = cy + rot.y;
          const cat = LANDFORM_CATEGORY_COLORS[lf.category];
          const isSelected = activeTargetId === lf.id;

          ctx.save();
          if (isSelected) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.arc(sx, sy, 8, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = cat.hex;
          ctx.strokeStyle = '#07090d';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(sx, sy - 5);
          ctx.lineTo(sx + 5, sy);
          ctx.lineTo(sx, sy + 5);
          ctx.lineTo(sx - 5, sy);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          if (isFullScreen || lf.tier === 'primary' || isSelected) {
            ctx.fillStyle = '#e2f1f8';
            ctx.font = 'bold 8px monospace';
            ctx.fillText(lf.name.split(' (')[0], sx + 7, sy + 3);
          }
          ctx.restore();
        });

        ctx.restore(); // end sphere clip

        // Outer Planetary Atmospheric Horizon Ring & North Arrow
        ctx.save();
        ctx.strokeStyle = 'rgba(82, 224, 255, 0.55)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(cx, cy, globeRadius, 0, Math.PI * 2);
        ctx.stroke();

        // Rover marker & FOV cone at sphere center
        const coneBearing = orientation === 'heading_up' ? 0 : curHeading;
        const radH = (coneBearing * Math.PI) / 180;
        const fovHalf = (35 * Math.PI) / 180;
        ctx.fillStyle = 'rgba(82, 224, 255, 0.25)';
        ctx.strokeStyle = 'rgba(82, 224, 255, 0.85)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.sin(radH - fovHalf) * 24, cy - Math.cos(radH - fovHalf) * 24);
        ctx.lineTo(cx + Math.sin(radH + fovHalf) * 24, cy - Math.cos(radH + fovHalf) * 24);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#52e0ff';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Rotated North Indicator on Globe Limb
        const nRot = rotatePoint(0, -(globeRadius + 10), -curRotationDeg);
        ctx.fillStyle = '#22d3ee';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('N', cx + nRot.x, cy + nRot.y + 3);
        ctx.restore();
        return;
      }

      // ------------------------------------------------------------------
      // SCOPE B: REGIONAL AZIMUTHAL EQUIDISTANT (COSINE-CORRECTED PLANETARY MAP)
      // ------------------------------------------------------------------
      if (mapScope === 'regional') {
        renderRegionalAzimuthalMars(
          ctx,
          width,
          height,
          curOriginLatLng,
          curRegionalMpp,
          curPanX * scaleX,
          curPanY * scaleY,
          curRotationDeg,
          mapMode,
          isFullScreen ? 3 : 4
        );

        const toRegionalScreen = (lat: number, lng: number) => {
          const az = latLngToAzimuthalMeters({ lat, lng }, curOriginLatLng);
          const rot = rotatePoint(
            az.x / curRegionalMpp,
            -az.y / curRegionalMpp,
            -curRotationDeg
          );
          return { x: centerScreenX + rot.x, y: centerScreenY + rot.y };
        };

        // Concentric Geodesic Range Rings (500 km, 1,000 km, 2,000 km)
        ctx.save();
        ctx.strokeStyle = 'rgba(82, 224, 255, 0.22)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        [500_000, 1_000_000, 2_000_000].forEach((rM) => {
          const rPx = rM / curRegionalMpp;
          ctx.beginPath();
          ctx.arc(centerScreenX, centerScreenY, rPx, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(148, 226, 248, 0.6)';
          ctx.font = '9px monospace';
          ctx.fillText(`${rM / 1000}km`, centerScreenX + rPx + 4, centerScreenY);
        });
        ctx.restore();

        // Regional Zones
        MARS_REGIONAL_ZONES.forEach((zone) => {
          ctx.save();
          ctx.strokeStyle = zone.colorHex;
          ctx.fillStyle = `${zone.colorHex}1e`;
          ctx.lineWidth = 1.6;
          ctx.setLineDash([5, 4]);
          if (zone.kind === 'circle' && zone.points[0] && zone.radiusMeters) {
            const c = toRegionalScreen(zone.points[0][0], zone.points[0][1]);
            const rPx = zone.radiusMeters / curRegionalMpp;
            ctx.beginPath();
            ctx.arc(c.x, c.y, rPx, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          } else {
            ctx.beginPath();
            zone.points.forEach(([lat, lng], idx) => {
              const p = toRegionalScreen(lat, lng);
              if (idx === 0) ctx.moveTo(p.x, p.y);
              else ctx.lineTo(p.x, p.y);
            });
            if (zone.kind === 'polygon') {
              ctx.closePath();
              ctx.fill();
            }
            ctx.stroke();
          }
          ctx.restore();
        });

        // Guidance Arc
        if (showSafePath && showGuidanceTrail) {
          const destGeo = targetLatLng ?? jezeroLocalToLatLng(targetX, targetY);
          const arc = sampleGreatCircleArc(curOriginLatLng, destGeo, 24);
          ctx.save();
          ctx.strokeStyle = '#52e0ff';
          ctx.lineWidth = 2.6;
          ctx.beginPath();
          arc.forEach((pt, idx) => {
            const p = toRegionalScreen(pt.lat, pt.lng);
            if (idx === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          });
          ctx.stroke();
          ctx.restore();
        }

        // All 13 Landforms
        curLandforms.forEach((lf) => {
          const p = toRegionalScreen(lf.lat, lf.lng);
          const cat = LANDFORM_CATEGORY_COLORS[lf.category];
          const isSelected = activeTargetId === lf.id;
          ctx.save();
          if (isSelected) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = cat.hex;
          ctx.strokeStyle = '#07090d';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - 6);
          ctx.lineTo(p.x + 6, p.y);
          ctx.lineTo(p.x, p.y + 6);
          ctx.lineTo(p.x - 6, p.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = cat.hex;
          ctx.font = 'bold 8px monospace';
          ctx.fillText(`${lf.name.split(' (')[0]} (${lf.distanceKm.toFixed(0)}km)`, p.x + 8, p.y + 3);
          ctx.restore();
        });

        // Rover / Astronaut Marker + Heading Cone at Center
        const coneBearing = orientation === 'heading_up' ? 0 : curHeading;
        const radH = (coneBearing * Math.PI) / 180;
        const fovHalf = (35 * Math.PI) / 180;
        ctx.save();
        ctx.fillStyle = 'rgba(6, 182, 212, 0.25)';
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.85)';
        ctx.beginPath();
        ctx.moveTo(centerScreenX, centerScreenY);
        ctx.lineTo(centerScreenX + Math.sin(radH - fovHalf) * 32, centerScreenY - Math.cos(radH - fovHalf) * 32);
        ctx.lineTo(centerScreenX + Math.sin(radH + fovHalf) * 32, centerScreenY - Math.cos(radH + fovHalf) * 32);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(centerScreenX, centerScreenY, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#06b6d4';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();

        // Rotated North Marker
        const nRot = rotatePoint(0, -(Math.min(width, height) * 0.42), -curRotationDeg);
        ctx.fillStyle = '#22d3ee';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('N', width / 2 + nRot.x, height / 2 + nRot.y);
        return;
      }

      // ------------------------------------------------------------------
      // SCOPE C: LOCAL 3.6 KM SECTOR (REAL HiRISE DEM HILLSHADED RASTER)
      // ------------------------------------------------------------------
      const scale = (width * 0.42 * curZoom) / 550; // px per meter
      const toScreen = (wx: number, wy: number) => {
        const rot = rotatePoint((wx - curAstroX) * scale, -(wy - curAstroY) * scale, -curRotationDeg);
        return {
          x: centerScreenX + rot.x,
          y: centerScreenY + rot.y,
        };
      };

      const demStep = isFullScreen ? 3 : 4;
      if (curInJezeroSector) {
        renderLocalHiRiseDem(
          ctx,
          width,
          height,
          curAstroX,
          curAstroY,
          scale,
          curPanX * scaleX,
          curPanY * scaleY,
          curRotationDeg,
          mapMode,
          demStep
        );
      } else {
        // Globally deployed rover: render real USGS/MOLA tiles centered on rover!
        renderRegionalAzimuthalMars(
          ctx,
          width,
          height,
          curOriginLatLng,
          1 / scale,
          curPanX * scaleX,
          curPanY * scaleY,
          curRotationDeg,
          mapMode,
          demStep
        );
      }

      if (curInJezeroSector) {
        // OUTER 3.6KM SECTOR PERIMETER RING
        const centerPt = toScreen(0, 0);
        ctx.save();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.42)';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.arc(centerPt.x, centerPt.y, 1550 * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // IMPACT CRATERS
        MARS_CRATERS.forEach((crater) => {
          const cp = toScreen(crater.x, crater.z);
          const rPx = crater.radius * scale;
          ctx.save();
          ctx.strokeStyle = 'rgba(251, 191, 36, 0.5)';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, rPx, 0, Math.PI * 2);
          ctx.stroke();

          if (rPx > 14) {
            ctx.fillStyle = 'rgba(253, 230, 138, 0.8)';
            ctx.font = 'bold 9px monospace';
            ctx.fillText(crater.name.toUpperCase(), cp.x - rPx * 0.6, cp.y + 3);
          }
          ctx.restore();
        });

        // RADIATION HOTSPOTS
        RADIATION_HOTSPOTS.forEach((hs) => {
          const hp = toScreen(hs.x, hs.z);
          const rPx = hs.radius * scale;
          ctx.save();
          ctx.fillStyle = 'rgba(244, 63, 94, 0.2)';
          ctx.strokeStyle = '#fb7185';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.arc(hp.x, hp.y, rPx, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#fda4af';
          ctx.font = 'bold 9px monospace';
          ctx.fillText(`☢ ${hs.doseRateMicroSvHr} µSv/h`, hp.x - 28, hp.y);
          ctx.restore();
        });

        // STEEP ESCARPMENT SLIP HAZARD LINE
        ctx.save();
        ctx.strokeStyle = 'rgba(244, 63, 94, 0.85)';
        ctx.lineWidth = 2.2;
        ctx.setLineDash([6, 4]);
        const scarpStart = toScreen(-1400, 1180);
        const scarpMid = toScreen(-520, 790);
        const scarpEnd = toScreen(650, 420);
        ctx.beginPath();
        ctx.moveTo(scarpStart.x, scarpStart.y);
        ctx.quadraticCurveTo(scarpMid.x, scarpMid.y, scarpEnd.x, scarpEnd.y);
        ctx.stroke();
        ctx.restore();
      }

      // GUIDANCE CORRIDOR (#52e0ff)
      if (showSafePath && showGuidanceTrail) {
        ctx.save();

        let endWorldX = targetX;
        let endWorldY = targetY;
        const localDist = Math.hypot(targetX - curAstroX, targetY - curAstroY);
        if ((localDist > 2600 || !curInJezeroSector) && targetLatLng) {
          const brgRad = (marsBearingDeg(curOriginLatLng, targetLatLng) * Math.PI) / 180;
          endWorldX = curAstroX + Math.sin(brgRad) * 1800;
          endWorldY = curAstroY + Math.cos(brgRad) * 1800;
        }

        const pStart = toScreen(curAstroX, curAstroY);
        const pMid = toScreen((curAstroX + endWorldX) * 0.5, (curAstroY + endWorldY) * 0.5);
        const pEnd = toScreen(endWorldX, endWorldY);

        ctx.beginPath();
        ctx.moveTo(pStart.x, pStart.y);
        ctx.quadraticCurveTo(pMid.x, pMid.y, pEnd.x, pEnd.y);
        ctx.strokeStyle = 'rgba(82, 224, 255, 0.28)';
        ctx.lineWidth = 6.5;
        ctx.stroke();

        ctx.strokeStyle = '#52e0ff';
        ctx.lineWidth = 2.6;
        ctx.stroke();

        ctx.fillStyle = '#52e0ff';
        for (let t = 0.2; t <= 0.85; t += 0.2) {
          const cx = (1 - t) * (1 - t) * pStart.x + 2 * (1 - t) * t * pMid.x + t * t * pEnd.x;
          const cy = (1 - t) * (1 - t) * pStart.y + 2 * (1 - t) * t * pMid.y + t * t * pEnd.y;
          ctx.beginPath();
          ctx.arc(cx, cy, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // BREADCRUMB TRAVELED TRAIL
      if (curInJezeroSector && breadcrumbPath.length > 1) {
        ctx.save();
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.72)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        const first = toScreen(breadcrumbPath[0].x, breadcrumbPath[0].y);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < breadcrumbPath.length; i++) {
          const pt = toScreen(breadcrumbPath[i].x, breadcrumbPath[i].y);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
        ctx.restore();
      }

      // JEZERO WAYPOINTS
      if (curInJezeroSector) {
        MARS_WAYPOINTS.forEach((wp) => {
          const pt = toScreen(wp.x, wp.z);
          const isSelectedTarget = Math.hypot(wp.x - targetX, wp.z - targetY) < 5;

          ctx.save();
          if (wp.type === 'habitat') {
            ctx.fillStyle = '#10b981';
            ctx.fillRect(pt.x - 6, pt.y - 6, 12, 12);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(pt.x - 6, pt.y - 6, 12, 12);
            ctx.fillStyle = '#6ee7b7';
            ctx.font = 'bold 9px monospace';
            ctx.fillText('HAB-01 SHELTER', pt.x - 32, pt.y + 18);
          } else {
            if (isSelectedTarget) {
              ctx.strokeStyle = '#f59e0b';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, 11, 0, Math.PI * 2);
              ctx.stroke();
            }
            ctx.fillStyle = isSelectedTarget ? '#fbbf24' : wp.type === 'cache' ? '#38bdf8' : '#22d3ee';
            ctx.beginPath();
            ctx.moveTo(pt.x, pt.y - 6);
            ctx.lineTo(pt.x + 6, pt.y);
            ctx.lineTo(pt.x, pt.y + 6);
            ctx.lineTo(pt.x - 6, pt.y);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = isSelectedTarget ? '#fde68a' : '#bae6fd';
            ctx.font = 'bold 9px monospace';
            const distLabel = distanceToTarget >= 1000 ? `${(distanceToTarget / 1000).toFixed(1)}km` : `${distanceToTarget}m`;
            ctx.fillText(
              isSelectedTarget ? `${wp.id} (${distLabel})` : wp.id,
              pt.x - 22,
              pt.y - 10
            );
          }
          ctx.restore();
        });

        // DISCOVERED JEZERO SCIENCE FEATURES (DELTA / SUBSURFACE ICE / MINERAL RESERVES)
        JEZERO_SCIENCE_FEATURES.forEach((feat) => {
          if (!discoveredFeatureIds.includes(feat.id)) return;
          const pt = toScreen(feat.x, feat.z);
          const isSelected = activeTargetId === feat.id || Math.hypot(feat.x - targetX, feat.z - targetY) < 5;

          ctx.save();
          if (isSelected) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 11, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = feat.colorHex;
          ctx.strokeStyle = '#07090d';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(pt.x, pt.y - 7);
          ctx.lineTo(pt.x + 6.5, pt.y + 5);
          ctx.lineTo(pt.x - 6.5, pt.y + 5);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = feat.colorHex;
          ctx.font = 'bold 8px monospace';
          ctx.fillText(feat.id.replace('SCI-', ''), pt.x + 9, pt.y + 3);
          ctx.restore();
        });
      }

      // REGIONAL LANDFORM BEACONS ON SECTOR RING (<= 300 km)
      curLandforms
        .filter((lf) => lf.distanceKm <= VISOR_PROXIMITY_THRESHOLD_KM)
        .forEach((lf) => {
          const pt = toScreen(curAstroX + lf.plotX, curAstroY + lf.plotZ);
          const cat = LANDFORM_CATEGORY_COLORS[lf.category];
          const isSelected = activeTargetId === lf.id;
          ctx.save();
          if (isSelected) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = cat.hex;
          ctx.strokeStyle = '#07090d';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(pt.x, pt.y - 6.5);
          ctx.lineTo(pt.x + 6.5, pt.y);
          ctx.lineTo(pt.x, pt.y + 6.5);
          ctx.lineTo(pt.x - 6.5, pt.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = cat.hex;
          ctx.font = 'bold 8px monospace';
          ctx.fillText(`${lf.id.replace('LF-', '')} ${lf.distanceKm.toFixed(0)}km`, pt.x + 9, pt.y + 3);
          ctx.restore();
        });

      // CUSTOM WAYPOINT PINS
      customWaypoints.forEach((wp) => {
        const pt = toScreen(wp.x, wp.y);
        ctx.save();
        ctx.fillStyle = wp.isNext ? '#52e0ff' : '#ffb347';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, wp.isNext ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = wp.isNext ? '#52e0ff' : '#fde68a';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(wp.isNext ? `WP${wp.id}·NEXT` : `WP${wp.id}`, pt.x + 8, pt.y + 3);
        ctx.restore();
      });

      // ROVER / ASTRONAUT POSITION & VISION CONE
      const astroPt = toScreen(curAstroX, curAstroY);
      const coneHeading = orientation === 'heading_up' ? 0 : curHeading;
      const radH = (coneHeading * Math.PI) / 180;
      const coneLen = 36;

      ctx.save();
      const fovHalf = (35 * Math.PI) / 180;
      ctx.fillStyle = 'rgba(6, 182, 212, 0.24)';
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.78)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(astroPt.x, astroPt.y);
      ctx.lineTo(astroPt.x + Math.sin(radH - fovHalf) * coneLen, astroPt.y - Math.cos(radH - fovHalf) * coneLen);
      ctx.lineTo(astroPt.x + Math.sin(radH + fovHalf) * coneLen, astroPt.y - Math.cos(radH + fovHalf) * coneLen);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(astroPt.x, astroPt.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(astroPt.x, astroPt.y);
      ctx.lineTo(astroPt.x + Math.sin(radH) * 12, astroPt.y - Math.cos(radH) * 12);
      ctx.stroke();

      // Dynamic Compass North Indicator when rotated
      const nVec = rotatePoint(0, -(height * 0.43), -curRotationDeg);
      ctx.fillStyle = '#22d3ee';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('N', width / 2 + nVec.x, height / 2 + nVec.y);
      ctx.restore();
    };

    drawMapRef.current = drawMap;
    drawMap(liveVehicleRef?.current);
  }, [
    astronautX,
    astronautY,
    heading,
    targetX,
    targetY,
    targetLatLng,
    originLatLng,
    inJezeroSector,
    distanceToTarget,
    activeTargetId,
    regionalLandforms,
    mapMode,
    mapScope,
    orientation,
    rotationDeg,
    regionalMetersPerPx,
    zoomLevel,
    panOffset,
    breadcrumbPath,
    showSafePath,
    showGuidanceTrail,
    customWaypoints,
    atlasTick,
    isFullScreen,
    discoveredFeatureIds,
    liveVehicleRef,
  ]);

  // Unified master rAF canvas sync throttled to 10 Hz (never steals 60fps WebGL frame budget)
  useEffect(() => {
    let lastSig = '';
    let lastDrawMs = 0;

    const syncLiveCanvas = (_dt: number, nowMs: number, simPose: LiveVehiclePose) => {
      const p = liveVehicleRef?.current ?? simPose;
      if (!p) return;

      const tr = smoothTransRef.current;
      if (p.teleportEpoch !== tr.lastTeleportEpoch) {
        tr.lastTeleportEpoch = p.teleportEpoch;
        const fromLat =
          p.lastTeleportFromLat ?? (tr.animActive ? visualCamRef.current.curLat : tr.prevLat);
        const fromLng =
          p.lastTeleportFromLng ?? (tr.animActive ? visualCamRef.current.curLng : tr.prevLng);
        const fromX =
          p.lastTeleportFromX ?? (tr.animActive ? visualCamRef.current.curX : tr.prevX);
        const fromY =
          p.lastTeleportFromY ?? (tr.animActive ? visualCamRef.current.curY : tr.prevY);
        const toX = !p.isGlobalOverride ? p.x : astronautX;
        const toY = !p.isGlobalOverride ? p.y : astronautY;
        tr.prevLat = p.lat;
        tr.prevLng = p.lng;
        tr.prevX = toX;
        tr.prevY = toY;
        startCanvasTransition({
          fromLat,
          fromLng,
          toLat: p.lat,
          toLng: p.lng,
          fromX,
          fromY,
          toX,
          toY,
          toPanX: 0,
          toPanY: 0,
        });
        return;
      }

      if (tr.animActive) return;

      const minInterval = isFullScreen || mapScope !== 'sector' ? 110 : 100;
      if (nowMs - lastDrawMs >= minInterval) {
        const sig = `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.heading.toFixed(1)},${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
        if (sig !== lastSig) {
          lastSig = sig;
          lastDrawMs = nowMs;
          tr.prevLat = p.lat;
          tr.prevLng = p.lng;
          if (!p.isGlobalOverride) {
            tr.prevX = p.x;
            tr.prevY = p.y;
          }
          visualCamRef.current.curLat = p.lat;
          visualCamRef.current.curLng = p.lng;
          if (!p.isGlobalOverride) {
            visualCamRef.current.curX = p.x;
            visualCamRef.current.curY = p.y;
          }
          drawMapRef.current?.(p);
        }
      }
    };

    return vehicleSim.addHudFrameListener(syncLiveCanvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveVehicleRef, isFullScreen, mapScope]);

  const viewWidthMeters = Math.round(550 / (0.42 * zoomLevel));
  const dataSourceTag =
    mapScope === 'sector' && inJezeroSector
      ? 'HiRISE DEM + CRATERS'
      : isMarsAtlasReady(mapMode)
        ? mapMode === 'topographic'
          ? 'NASA MGS MOLA 463M'
          : mapMode === 'optical'
            ? 'USGS VIKING MDIM 2.1'
            : 'THEMIS ALBEDO-THERMAL'
        : 'MOLA ANALYTICAL DATUM';

  return (
    <div
      className={`relative bg-slate-950/95 border border-cyan-500/45 rounded-xl shadow-2xl overflow-hidden flex flex-col pointer-events-auto select-none transition-all ${
        isFullScreen ? 'w-full h-full max-h-[90vh]' : 'w-80 sm:w-[440px]'
      }`}
    >
      {/* MAP HEADER */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#090e18] border-b border-slate-800 shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Compass className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="font-display text-xs font-bold tracking-wider text-slate-100 uppercase truncate">
            {mapScope === 'global'
              ? 'Mars Spherical Globe'
              : mapScope === 'regional'
                ? 'Mars Regional Projection'
                : inJezeroSector
                  ? 'Jezero HiRISE Map (3.6 km)'
                  : 'Local Planetary Map'}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* North-Up vs Heading-Up Orientation Toggle */}
          <button
            type="button"
            onClick={() => {
              playChirpSound();
              setOrientation((o) => (o === 'north_up' ? 'heading_up' : 'north_up'));
            }}
            title="Toggle North-Up vs Heading-Up orientation"
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border transition-colors whitespace-nowrap ${
              orientation === 'heading_up'
                ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                : 'bg-slate-900 border-slate-700 text-cyan-300 hover:border-cyan-500/40'
            }`}
          >
            {orientation === 'heading_up' ? 'HDG-UP' : 'N-UP'}
          </button>

          {mapScope !== 'global' && (
            <>
              <button
                type="button"
                onClick={() => handleSmoothZoomStep(0.2)}
                title="Zoom In"
                className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleSmoothZoomStep(-0.14)}
                title="Zoom Out"
                className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handleCenterOnAstronaut}
            title="Recenter on Rover/Astronaut"
            className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors"
          >
            <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
          </button>
          {onToggleFullScreen && (
            <button
              type="button"
              onClick={onToggleFullScreen}
              title={isFullScreen ? 'Minimize map' : 'Enlarge Map'}
              className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors ml-0.5"
            >
              {isFullScreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* SCOPE & SPECTRAL LAYER SELECTOR */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-1.5 bg-[#060a12] border-b border-slate-800/80 text-xs font-mono">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => handleModeSwitch('topographic')}
            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-all flex items-center gap-1 whitespace-nowrap ${
              mapMode === 'topographic'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Mountain className="w-3 h-3 text-amber-400" />
            <span>MOLA</span>
          </button>
          <button
            type="button"
            onClick={() => handleModeSwitch('thermal')}
            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-all flex items-center gap-1 whitespace-nowrap ${
              mapMode === 'thermal'
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Flame className="w-3 h-3 text-rose-400" />
            <span>THEMIS</span>
          </button>
          <button
            type="button"
            onClick={() => handleModeSwitch('optical')}
            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-all flex items-center gap-1 whitespace-nowrap ${
              mapMode === 'optical'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Eye className="w-3 h-3 text-cyan-400" />
            <span>MDIM</span>
          </button>
        </div>

        <div className="flex items-center gap-1">
          {(
            [
              { id: 'sector', label: 'Sector' },
              { id: 'regional', label: 'Region' },
              { id: 'global', label: 'Globe' },
            ] as const
          ).map((sc) => (
            <button
              key={sc.id}
              type="button"
              onClick={() => handleScopeSwitch(sc.id)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors whitespace-nowrap ${
                mapScope === sc.id
                  ? 'bg-cyan-500 text-slate-950 border-cyan-400'
                  : 'bg-slate-900 text-slate-300 border-slate-700 hover:border-cyan-500/40'
              }`}
            >
              {sc.id === 'global' && <Globe className="w-2.5 h-2.5 inline mr-0.5" />}
              {sc.label}
            </button>
          ))}

          <button
            type="button"
            onClick={() => {
              playChirpSound();
              setShowLandformList((s) => !s);
            }}
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors flex items-center gap-1 whitespace-nowrap ${
              showLandformList
                ? 'bg-amber-500/25 text-amber-200 border border-amber-400/50'
                : 'bg-slate-900 text-slate-300 border border-slate-700 hover:border-cyan-500/40'
            }`}
            title="Select regional or planetary Martian landforms"
          >
            <MapPin className="w-3 h-3 text-amber-400" />
            <span>Atlas</span>
          </button>
          {isFullScreen && (
            <button
              type="button"
              onClick={() => setShowSafePath(!showSafePath)}
              className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors flex items-center gap-1 whitespace-nowrap ${
                showSafePath
                  ? 'bg-cyan-900/40 text-cyan-300 border border-cyan-500/30'
                  : 'bg-slate-900 text-slate-500 border border-slate-800'
              }`}
            >
              <ShieldCheck className="w-3 h-3 text-cyan-400" />
              <span>{showSafePath ? 'PATH ON' : 'PATH OFF'}</span>
            </button>
          )}
        </div>
      </div>

      {/* COMPACT LIVE TARGET & VECTOR TELEMETRY STRIP */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-1 bg-[#080d17] border-b border-slate-800/80 text-[10px] font-mono tabular-nums">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-slate-500 uppercase shrink-0">TGT:</span>
          <span className="text-amber-300 font-bold truncate" title={targetName}>
            {activeTargetId || targetName}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-slate-300">
          <span>
            BRG <strong className="text-cyan-300">{bearingToTarget}°</strong>
          </span>
          <span className="text-slate-600">·</span>
          <span>
            DIST{' '}
            <strong className="text-cyan-300">
              {distanceToTarget >= 1000 ? `${(distanceToTarget / 1000).toFixed(1)}km` : `${distanceToTarget}m`}
            </strong>
          </span>
          <span className="text-slate-600">·</span>
          <span>
            ETA <strong className="text-amber-300">{resolvedEtaMin}m</strong>
          </span>
        </div>
      </div>

      {/* MAP CANVAS VIEWPORT */}
      <div
        className={`relative w-full flex-1 bg-[#050810] overflow-hidden cursor-crosshair ${
          isFullScreen ? 'min-h-[540px]' : 'min-h-[260px]'
        }`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          handleMouseUp();
          setHoverProbe(null);
        }}
        onClick={handleCanvasClick}
      >
        <canvas
          ref={canvasRef}
          width={isFullScreen ? 1280 : 460}
          height={isFullScreen ? 760 : 280}
          className="w-full h-full block"
        />

        {hoverProbe && (
          <div className="absolute top-2 left-2 bg-slate-950/92 border border-cyan-500/40 rounded p-2 text-[10px] font-mono shadow-xl pointer-events-none space-y-0.5">
            <div className="text-cyan-300 font-bold tabular-nums">{hoverProbe.coordStr}</div>
            <div className="text-slate-300 tabular-nums">
              Elev: <strong className="text-amber-300">{hoverProbe.elevation} m</strong>
              {hoverProbe.slope !== null ? (
                <>
                  {' · Slope: '}
                  <strong className={hoverProbe.slope > 15 ? 'text-rose-400' : 'text-emerald-400'}>
                    {hoverProbe.slope}%
                  </strong>
                </>
              ) : (
                <> · {hoverProbe.terrainType}</>
              )}
            </div>
            <div className="text-slate-300 tabular-nums">
              Temp: <strong className="text-rose-300">{hoverProbe.tempK} K ({hoverProbe.tempC}°C)</strong>
            </div>
            {hoverProbe.radiationRate && (
              <div className="text-rose-400 font-bold">
                ☢ HOTSPOT: {hoverProbe.radiationRate} µSv/h
              </div>
            )}
          </div>
        )}

        <div className="absolute bottom-2 left-2 flex items-center gap-2 bg-slate-950/88 border border-slate-800 rounded px-2 py-1 text-[9px] font-mono text-slate-400 pointer-events-none tabular-nums">
          <span className="text-cyan-300 font-bold">
            {mapScope === 'global'
              ? 'ORTHOGRAPHIC SPHERE'
              : mapScope === 'regional'
                ? 'AZIMUTHAL EQUIDISTANT'
                : `SPAN ${viewWidthMeters}m`}
          </span>
          <span>·</span>
          <span>{dataSourceTag}</span>
        </div>

        <div
          ref={coordStampRef}
          className="absolute bottom-2 right-2 bg-slate-950/88 border border-slate-800 rounded px-2 py-1 text-[9px] font-mono text-cyan-300 pointer-events-none tabular-nums"
        >
          {liveVehicleRef
            ? initialCoordStampRef.current
            : `${formatAreographicCoords(originLat, originLng)} · ${Math.round(heading)}°`}
        </div>

        {distanceToTarget <= 25 && (
          <div className="absolute top-2 right-2 bg-emerald-950/92 border border-emerald-400/80 rounded px-2.5 py-1 text-[10px] font-mono font-bold text-emerald-300 shadow-lg pointer-events-none">
            ✓ DESTINATION REACHED
          </div>
        )}

        {/* LANDFORMS SELECTOR DRAWER */}
        {showLandformList && (
          <div
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute inset-y-2 right-2 w-64 sm:w-72 bg-slate-950/95 border border-cyan-500/50 rounded-lg shadow-2xl p-2 flex flex-col gap-1.5 z-20"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-1">
              <span className="text-[10px] font-mono font-bold text-cyan-300 uppercase">
                Martian Landforms ({MARS_LANDFORMS.length})
              </span>
              <button
                type="button"
                onClick={() => setShowLandformList(false)}
                className="text-slate-400 hover:text-white p-0.5"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {onToggleAutopilotTravel && (
              <label className="flex items-center justify-between gap-2 px-1.5 py-1 rounded bg-slate-900/90 border border-slate-800 text-[10px] font-mono text-slate-200 cursor-pointer">
                <span className="flex items-center gap-1">
                  <Cpu className="w-3 h-3 text-cyan-400" />
                  Autopilot to Location
                </span>
                <input
                  type="checkbox"
                  checked={enableAutopilotTravel}
                  onChange={(e) => {
                    playChirpSound();
                    onToggleAutopilotTravel(e.target.checked);
                  }}
                  className="accent-cyan-400 cursor-pointer"
                />
              </label>
            )}
            <div className="grid grid-cols-4 gap-1 text-[9px] font-mono">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'primary', label: 'Primary' },
                  { id: 'regional', label: 'Regional' },
                  { id: 'surface', label: 'Surface' },
                ] as const
              ).map((tier) => (
                <button
                  key={tier.id}
                  type="button"
                  onClick={() => {
                    playChirpSound();
                    setLandformTierFilter(tier.id);
                  }}
                  className={`py-0.5 px-1 rounded border transition-colors whitespace-nowrap ${
                    landformTierFilter === tier.id
                      ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200 font-bold'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tier.label}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto space-y-1 pr-0.5">
              {MARS_LANDFORMS.filter((lf) =>
                landformTierFilter === 'all' ? true : lf.tier === landformTierFilter
              )
                .map((lf) => ({
                  lf,
                  dKm: marsDistanceKm(originLatLng, { lat: lf.lat, lng: lf.lng }),
                }))
                .sort((a, b) => a.dKm - b.dKm)
                .map(({ lf, dKm }) => {
                  const cat = LANDFORM_CATEGORY_COLORS[lf.category];
                  const inVisor = dKm <= VISOR_PROXIMITY_THRESHOLD_KM;
                  const isSelected = activeTargetId === lf.id;
                  return (
                    <button
                      key={lf.id}
                      type="button"
                      onClick={() => {
                        playAckTone();
                        setSelectedPopup({
                          id: lf.id,
                          name: lf.name,
                          categoryLabel: cat.label,
                          colorHex: cat.hex,
                          description: lf.scienceSummary,
                          latLng: { lat: lf.lat, lng: lf.lng },
                          isLandform: true,
                        });
                        onSelectWaypoint?.(lf.id);
                      }}
                      className={`w-full text-left p-1.5 rounded border text-[10px] font-mono transition-colors ${
                        isSelected
                          ? 'bg-cyan-950/70 border-cyan-400 text-white'
                          : 'bg-slate-900/75 border-slate-800 hover:border-slate-600 text-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="flex items-center gap-1.5 font-bold truncate">
                          <span
                            className="w-2 h-2 rotate-45 shrink-0"
                            style={{ backgroundColor: cat.hex }}
                          />
                          <span className="truncate">{lf.name}</span>
                        </span>
                        <span className="text-cyan-300 shrink-0 tabular-nums">
                          {dKm < 1 ? `${Math.round(dKm * 1000)}m` : `${dKm.toFixed(0)}km`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[9px] text-slate-400 mt-0.5 tabular-nums">
                        <span style={{ color: cat.hex }}>{cat.label}</span>
                        <span className={DIFFICULTY_TEXT_CLASS[lf.difficulty]}>
                          DIFF: {lf.difficulty}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[9px] text-slate-400 mt-0.5 tabular-nums">
                        <span>{formatAreographicCoords(lf.lat, lf.lng)}</span>
                        <span>
                          ETA {calcEtaMin(dKm * 1000)}m · {inVisor ? 'VISOR <=300km' : 'MAP >300km'}
                        </span>
                      </div>
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        {/* TACTICAL MAP POPUP WITH LIVE DIST/ETA & AUTOPILOT TO LOCATION TOGGLE */}
        {selectedPopup && (() => {
          const liveDistKm = marsDistanceKm(originLatLng, selectedPopup.latLng);
          const liveBrg = Math.round(marsBearingDeg(originLatLng, selectedPopup.latLng));
          const liveEta = calcEtaMin(liveDistKm * 1000);
          const landmark = selectedPopup.isLandform ? LANDMARK_BY_ID[selectedPopup.id] : undefined;
          return (
            <div
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              className="absolute bottom-8 left-2 right-2 sm:right-auto sm:w-88 bg-slate-950/96 border rounded-lg p-2.5 shadow-2xl z-30 text-[10px] font-mono space-y-1.5"
              style={{ borderColor: selectedPopup.colorHex }}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5 font-bold text-slate-100 text-[11px]">
                    <span
                      className="w-2 h-2 rotate-45 shrink-0"
                      style={{ backgroundColor: selectedPopup.colorHex }}
                    />
                    <span>{selectedPopup.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[9px] text-slate-400 mt-0.5 tabular-nums flex-wrap">
                    <span style={{ color: selectedPopup.colorHex }}>{selectedPopup.categoryLabel}</span>
                    <span>·</span>
                    <span className="text-cyan-300 font-bold">
                      {liveDistKm < 1
                        ? `${Math.round(liveDistKm * 1000)} m`
                        : `${liveDistKm.toFixed(1)} km`}
                    </span>
                    <span>·</span>
                    <span>BRG {liveBrg}°</span>
                    <span>·</span>
                    <span className="text-amber-300">ETA {liveEta}m</span>
                    {landmark && (
                      <>
                        <span>·</span>
                        <span className={DIFFICULTY_TEXT_CLASS[landmark.difficulty]}>
                          DIFFICULTY: {landmark.difficulty}
                        </span>
                      </>
                    )}
                  </div>
                  {landmark && (
                    <div className="text-[9px] text-slate-400 mt-0.5 tabular-nums">
                      {formatAreographicCoords(landmark.lat, landmark.lng)} · Elev{' '}
                      {landmark.elevationMeters >= 0 ? '+' : ''}
                      {landmark.elevationMeters.toLocaleString()} m · {landmark.dimensions.verticalMetric}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedPopup(null)}
                  className="text-slate-400 hover:text-white p-0.5"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-slate-200 leading-snug">
                {landmark ? landmark.visualCharacteristics : selectedPopup.description}
              </p>
              {landmark?.terrainConstraints[0] && (
                <div className="text-[9px] text-amber-300/90 leading-snug">
                  Constraint: {landmark.terrainConstraints[0]}
                </div>
              )}
              <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-800 flex-wrap">
                {onToggleAutopilotTravel && (
                  <label className="flex items-center gap-1.5 text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enableAutopilotTravel}
                      onChange={(e) => {
                        playChirpSound();
                        onToggleAutopilotTravel(e.target.checked);
                      }}
                      className="accent-cyan-400 cursor-pointer"
                    />
                    <span>Autopilot to Location</span>
                  </label>
                )}
                <div className="flex items-center gap-1 ml-auto">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectWaypoint?.(selectedPopup.id, { autopilot: enableAutopilotTravel });
                    }}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/40 font-bold"
                  >
                    Set Target
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectWaypoint?.(selectedPopup.id, { autopilot: true });
                    }}
                    className="px-2 py-0.5 rounded bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold"
                  >
                    Autopilot
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* FOOTER: MOVEMENT KEYPAD & RESET */}
      {onMove && (
        <div className="px-3 py-2 bg-[#090e18] border-t border-slate-800 flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-1.5 text-slate-300">
            <Navigation className="w-3.5 h-3.5 text-cyan-400" />
            <span className="font-semibold text-[11px]">Drive / Walk (WASD)</span>
          </div>

          <div className="flex items-center gap-1">
            {(
              [
                { dir: 'left', Icon: ArrowLeft, title: 'Turn Left' },
                { dir: 'forward', Icon: ArrowUp, title: 'Forward' },
                { dir: 'backward', Icon: ArrowDown, title: 'Reverse' },
                { dir: 'right', Icon: ArrowRight, title: 'Turn Right' },
              ] as const
            ).map(({ dir, Icon, title }) => (
              <button
                key={dir}
                type="button"
                title={title}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  onDriveInput?.(dir, true, isFullScreen ? 'fullmap' : 'minimap');
                }}
                onPointerUp={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }
                  onDriveInput?.(dir, false, isFullScreen ? 'fullmap' : 'minimap');
                }}
                onPointerCancel={() => onDriveInput?.(dir, false, isFullScreen ? 'fullmap' : 'minimap')}
                onLostPointerCapture={() => onDriveInput?.(dir, false, isFullScreen ? 'fullmap' : 'minimap')}
                onBlur={() => onDriveInput?.(dir, false, isFullScreen ? 'fullmap' : 'minimap')}
                onClick={(e) => {
                  if (!onDriveInput || e.detail === 0) {
                    onMove(dir);
                  }
                }}
                className="p-1 rounded bg-slate-900 border border-slate-700 hover:bg-cyan-500/20 text-slate-200 transition-colors"
              >
                <Icon className="w-3 h-3" />
              </button>
            ))}
          </div>

          {onResetPosition && (
            <button
              type="button"
              onClick={onResetPosition}
              className="text-[10px] text-slate-400 hover:text-amber-300 flex items-center gap-1 transition-colors"
              title="Reset Position"
            >
              <RotateCcw className="w-3 h-3" /> Reset
            </button>
          )}
        </div>
      )}
    </div>
  );
};
