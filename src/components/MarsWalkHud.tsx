import React, { useEffect, useRef, useState, useMemo, useCallback, Suspense, lazy } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  ExcursionState,
  EquipmentControlState,
  SeasonalFrostMode,
} from '../types/telemetry';
import {
  MARS_WAYPOINTS,
  MARS_LANDFORMS,
  JEZERO_SCIENCE_FEATURES,
  ScienceFeature,
  MARS_REGIONAL_ZONES,
  LANDFORM_CATEGORY_COLORS,
  WAYPOINT_TYPE_COLORS,
  VISOR_PROXIMITY_THRESHOLD_KM,
  RADIATION_HOTSPOTS,
  WORLD_HALF_EXTENT,
  PlanetaryRoutePlan,
  marsDistanceKm,
  marsBearingDeg,
  estimateMarsTravelEtaMinutes,
  formatAreographicCoords,
  sampleGreatCircleArc,
  splitAntimeridianPolyline,
} from '../data/marsTerrain';
import { slerpLatLng } from '../data/marsCartography';
import {
  THARSIS_FEATURES,
  FEATURE_KIND_STYLE,
  OLYMPUS_CALDERA_CRATERS,
} from '../data/tharsisFeatures';
import { OlympusClimbPanel, TerrainHazardBanner } from './TharsisHazardPanels';
import {
  CustomWaypoint,
  JEZERO_ORIGIN,
  jezeroMetersToLatLng,
  latLngToJezeroMeters,
  haversineKm,
  orderWaypointsNearestFirst,
} from '../utils/marsCoords';
import { playChirpSound, playAckTone } from '../utils/audioAlerts';
import { vehicleSim, type DriveDirection, type LiveVehiclePose } from '../utils/vehicleController';
import {
  NOTIFICATION_AUTO_DISMISS_MS,
  getSettingToastDismissMs,
} from '../utils/notificationTimers';

export type { CustomWaypoint };
export { jezeroMetersToLatLng, latLngToJezeroMeters, haversineKm, orderWaypointsNearestFirst };

const PlanetaryAtlasDrawer = lazy(() =>
  import('./PlanetaryAtlasDrawer').then((m) => ({ default: m.PlanetaryAtlasDrawer }))
);

const GLOBAL_VIEW = { center: [0, 0] as [number, number], zoom: 1 };
const fmtLat = (v: number) => `${Math.abs(v).toFixed(3)}° ${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v: number) => `${(((v % 360) + 360) % 360).toFixed(3)}° E`;

const MARS_TILE_LAYERS = {
  mdimUrl: 'https://astro.arcgis.com/arcgis/rest/services/OnMars/MDIM/MapServer/tile/{z}/{y}/{x}',
  mdimOpts: { maxNativeZoom: 7, maxZoom: 13, tileSize: 256, noWrap: true } satisfies L.TileLayerOptions,
  hillshadeUrl:
    'https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
  hillshadeOpts: { opacity: 0.55, noWrap: true, maxNativeZoom: 6, maxZoom: 13 } satisfies L.TileLayerOptions,
};

const fmtDist = (km: number) => (km < 1 ? `${(km * 1000).toFixed(0)} m` : `${km.toFixed(1)} km`);

const pad = (n: number) => String(n).padStart(2, '0');
const hms = (s: number) =>
  `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s) % 60)}`;
const mmss = (s: number) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s) % 60)}`;

function parseHmsToSeconds(str: string): number {
  const parts = str.split(':').map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

interface MarsWalkHudProps {
  state: ExcursionState;
  activeTab: 'hud' | 'visor' | 'console' | 'sensors';
  setActiveTab: (tab: 'hud' | 'visor' | 'console' | 'sensors') => void;
  astronautPos: { x: number; y: number; heading: number; path: Array<{ x: number; y: number }> };
  targetPos: { x: number; y: number };
  targetLatLng?: { lat: number; lng: number };
  hasGuidanceTarget?: boolean;
  onMoveAstronaut: (direction: 'forward' | 'backward' | 'left' | 'right', silent?: boolean) => void;
  onDriveInput?: (direction: DriveDirection, active: boolean, sourceId?: string) => void;
  liveVehicleRef?: React.MutableRefObject<LiveVehiclePose>;
  onSetAstronautCoords: (x: number, y: number) => void;
  onResetPosition: () => void;
  onSetNavTarget: (
    waypointId: string,
    options?: {
      autopilot?: boolean;
      switchToTab?: 'hud' | 'visor' | 'console' | 'sensors';
      originOverride?: { lat: number; lng: number; elevationMeters?: number };
    }
  ) => void;
  onDeployPlanetaryRoute?: (route: PlanetaryRoutePlan) => void;
  onUpdateEquipment: (patch: Partial<EquipmentControlState>) => void;
  onAcknowledgeHazard: () => void;
  onSimulateEmergency: () => void;
  isMuted: boolean;
  setIsMuted: (muted: boolean) => void;
  lastMovedTimestamp: number;
  destinationReached?: {
    waypointId: string;
    waypointName: string;
    dismissed: boolean;
    exiting?: boolean;
  } | null;
  onDismissDestinationReached?: () => void;
  onTriggerSolarEvent?: (level?: 'NONE' | 'ELEVATED_FLUX' | 'HIGH_FLUX_WARNING' | 'EXTREME_CME_STORM') => void;
  onDismissSettingChange?: () => void;
  customWaypoints: CustomWaypoint[];
  onAddCustomWaypoint: (lat: number, lng: number) => void;
  onRemoveCustomWaypoint: (index: number) => void;
  onClearCustomWaypoints: () => void;
  globalOverrideLatLng: { lat: number; lng: number } | null;
  onSetGlobalOverrideLatLng: React.Dispatch<React.SetStateAction<{ lat: number; lng: number } | null>>;
  customArrival: {
    wpId: number;
    nextWpId: number | null;
    remainingCount: number;
    dismissed: boolean;
    exiting?: boolean;
  } | null;
  onDismissCustomArrival: () => void;
  onEngageEmergencyRtb?: () => void;
  onHazardOverride?: () => void;
  anyHazardActive?: boolean;
  onTogglePolarFrostMode?: (mode?: SeasonalFrostMode) => void;
  discoveredFeatureIds?: string[];
  activeProximityFeature?: ScienceFeature | null;
  recentDiscovery?: { feature: ScienceFeature; dismissed: boolean; exiting?: boolean } | null;
  onDismissRecentDiscovery?: () => void;
}

export const MarsWalkHud: React.FC<MarsWalkHudProps> = ({
  state,
  activeTab,
  setActiveTab,
  astronautPos,
  targetPos,
  targetLatLng,
  hasGuidanceTarget = false,
  onMoveAstronaut,
  onDriveInput,
  liveVehicleRef,
  onSetAstronautCoords,
  onResetPosition,
  onSetNavTarget,
  onDeployPlanetaryRoute,
  onUpdateEquipment,
  onAcknowledgeHazard,
  onSimulateEmergency,
  isMuted,
  setIsMuted,
  lastMovedTimestamp,
  destinationReached = null,
  onDismissDestinationReached,
  onTriggerSolarEvent,
  onDismissSettingChange,
  customWaypoints: waypoints,
  onAddCustomWaypoint,
  onRemoveCustomWaypoint,
  onClearCustomWaypoints,
  globalOverrideLatLng,
  onSetGlobalOverrideLatLng: setGlobalOverrideLatLng,
  customArrival,
  onDismissCustomArrival,
  onEngageEmergencyRtb,
  onHazardOverride,
  anyHazardActive = false,
  onTogglePolarFrostMode,
  discoveredFeatureIds = [],
  activeProximityFeature = null,
  recentDiscovery = null,
  onDismissRecentDiscovery,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const mdimLayerRef = useRef<L.TileLayer | null>(null);
  const hillshadeLayerRef = useRef<L.TileLayer | null>(null);
  const astroMarkerRef = useRef<L.Marker | null>(null);
  const blueTrailRef = useRef<L.Polyline | null>(null);
  const routeLineRef = useRef<L.Polyline | null>(null);
  const wpLayerRef = useRef<L.LayerGroup | null>(null);
  const breadcrumbLayerRef = useRef<L.Polyline | null>(null);
  const jezeroLayerRef = useRef<L.LayerGroup | null>(null);
  const regionalZoneLayerRef = useRef<L.LayerGroup | null>(null);
  const plannedRouteLayerRef = useRef<L.LayerGroup | null>(null);
  const landformLayerRef = useRef<L.LayerGroup | null>(null);
  const tharsisLayerRef = useRef<L.LayerGroup | null>(null);
  const compassNeedleRef = useRef<HTMLDivElement>(null);
  const headingOutRef = useRef<HTMLOutputElement>(null);
  const paceOutRef = useRef<HTMLOutputElement>(null);
  const posOutRef = useRef<HTMLOutputElement>(null);
  const continuousHeadingRef = useRef<number>(astronautPos.heading);

  const [showMdim, setShowMdim] = useState(true);
  const [showHillshade, setShowHillshade] = useState(false);
  const [showJezeroOverlay, setShowJezeroOverlay] = useState(true);
  const [showLandforms, setShowLandforms] = useState(true);
  const [showRegions, setShowRegions] = useState(true);
  const [showTharsis, setShowTharsis] = useState(true);
  const [showAtlas, setShowAtlas] = useState(false);
  const [plannedRoute, setPlannedRoute] = useState<PlanetaryRoutePlan | null>(null);
  const [selectedLandmarkPopup, setSelectedLandmarkPopup] = useState<{
    id: string;
    name: string;
    categoryLabel: string;
    colorHex: string;
    lat: number;
    lng: number;
    elevationMeters?: number;
    dimensionsText?: string;
    visualText?: string;
    constraints?: string[];
    summary: string;
    isLandform: boolean;
  } | null>(null);
  const [mapMode, setMapMode] = useState<'place' | 'waypoint' | null>(null);
  const [cursorCoords, setCursorCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(7);
  const [tileNotice, setTileNotice] = useState<string>('');
  const [evaSecondsElapsed, setEvaSecondsElapsed] = useState<number>(() =>
    parseHmsToSeconds(state.mission.evaElapsedDuration)
  );
  const [mobilePanel, setMobilePanel] = useState<'none' | 'left' | 'right'>('none');

  // Keep refs to current callbacks/mode for Leaflet click handler
  const mapModeRef = useRef(mapMode);
  mapModeRef.current = mapMode;
  const onAddCustomWaypointRef = useRef(onAddCustomWaypoint);
  onAddCustomWaypointRef.current = onAddCustomWaypoint;
  const emergencyRtbActiveRef = useRef(state.emergencyRtbActive);
  emergencyRtbActiveRef.current = state.emergencyRtbActive;

  useEffect(() => {
    if (state.emergencyRtbActive && mapMode === 'waypoint') {
      setMapMode(null);
    }
  }, [state.emergencyRtbActive, mapMode]);

  const currentAstroLatLng = useMemo(() => {
    if (globalOverrideLatLng) return globalOverrideLatLng;
    const [lat, lng] = jezeroMetersToLatLng(astronautPos.x, astronautPos.y);
    return { lat, lng };
  }, [globalOverrideLatLng, astronautPos.x, astronautPos.y]);
  const currentAstroLatLngRef = useRef(currentAstroLatLng);
  currentAstroLatLngRef.current = currentAstroLatLng;

  const orderedWaypoints = useMemo(
    () => orderWaypointsNearestFirst(currentAstroLatLng, waypoints),
    [currentAstroLatLng, waypoints]
  );
  const nearestWaypoint = orderedWaypoints[0] ?? null;

  // Live EVA clock ticking every second
  useEffect(() => {
    const id = setInterval(() => {
      setEvaSecondsElapsed((s) => s + 1);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Medium severity / Warning auto-dismissal for degraded tile stream notice (5.5s)
  useEffect(() => {
    if (!tileNotice) return;
    const t = setTimeout(() => setTileNotice(''), NOTIFICATION_AUTO_DISMISS_MS.warn);
    return () => clearTimeout(t);
  }, [tileNotice]);

  // Initialize Leaflet Map once
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      crs: L.CRS.EPSG4326,
      center: [JEZERO_ORIGIN.lat, JEZERO_ORIGIN.lon],
      zoom: 7,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      minZoom: 0,
      maxZoom: 13,
      zoomControl: false,
      attributionControl: false,
      worldCopyJump: false,
      maxBounds: [
        [-90, -180],
        [90, 180],
      ],
      maxBoundsViscosity: 1,
    });

    const mdimLayer = L.tileLayer(MARS_TILE_LAYERS.mdimUrl, MARS_TILE_LAYERS.mdimOpts);
    const hillshadeLayer = L.tileLayer(
      MARS_TILE_LAYERS.hillshadeUrl,
      MARS_TILE_LAYERS.hillshadeOpts
    );

    let tileErrors = 0;
    const attachTileListeners = (layer: L.TileLayer) => {
      layer.on('tileerror', () => {
        tileErrors += 1;
        if (tileErrors === 6) {
          setTileNotice('External Mars tile stream degraded — fallback surface active.');
        }
      });
      layer.on('tileload', () => {
        if (tileErrors > 0) {
          tileErrors = 0;
          setTileNotice('');
        }
      });
    };
    attachTileListeners(mdimLayer);
    attachTileListeners(hillshadeLayer);

    mdimLayer.addTo(map);

    const regionalZoneGroup = L.layerGroup().addTo(map);
    const jezeroGroup = L.layerGroup().addTo(map);
    const breadcrumbLine = L.polyline([], {
      color: '#38bdf8',
      weight: 1.5,
      opacity: 0.45,
      dashArray: '3 4',
    }).addTo(map);
    const plannedRouteGroup = L.layerGroup().addTo(map);
    const landformGroup = L.layerGroup().addTo(map);
    const tharsisGroup = L.layerGroup().addTo(map);
    const wpGroup = L.layerGroup().addTo(map);
    const routeLine = L.polyline([], {
      color: '#ffb347',
      weight: 2,
      opacity: 0.75,
      dashArray: '6 6',
    }).addTo(map);
    const blueTrail = L.polyline([], {
      color: '#52e0ff',
      weight: 3,
      opacity: 0.95,
      dashArray: '8 4',
    }).addTo(map);

    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      setCursorCoords({ lat: e.latlng.lat, lng: e.latlng.lng });
    });

    map.on('zoomend', () => {
      setZoomLevel(map.getZoom());
    });

    map.on('click', (e: L.LeafletMouseEvent) => {
      const mode = mapModeRef.current;
      if (mode === 'place') {
        playAckTone();
        const meters = latLngToJezeroMeters(e.latlng.lat, e.latlng.lng);
        const limit = WORLD_HALF_EXTENT - 90;
        if (Math.abs(meters.x) <= limit && Math.abs(meters.y) <= limit) {
          setGlobalOverrideLatLng(null);
          onSetAstronautCoords(meters.x, meters.y);
        } else {
          setGlobalOverrideLatLng({ lat: e.latlng.lat, lng: e.latlng.lng });
        }
        setMapMode(null);
      } else if (mode === 'waypoint') {
        if (emergencyRtbActiveRef.current) {
          setMapMode(null);
          return;
        }
        playChirpSound();
        onAddCustomWaypointRef.current(e.latlng.lat, e.latlng.lng);
      }
    });

    mapRef.current = map;
    mdimLayerRef.current = mdimLayer;
    hillshadeLayerRef.current = hillshadeLayer;
    regionalZoneLayerRef.current = regionalZoneGroup;
    jezeroLayerRef.current = jezeroGroup;
    breadcrumbLayerRef.current = breadcrumbLine;
    plannedRouteLayerRef.current = plannedRouteGroup;
    landformLayerRef.current = landformGroup;
    tharsisLayerRef.current = tharsisGroup;
    wpLayerRef.current = wpGroup;
    routeLineRef.current = routeLine;
    blueTrailRef.current = blueTrail;
    setZoomLevel(map.getZoom());

    return () => {
      map.remove();
      mapRef.current = null;
      astroMarkerRef.current = null;
      mdimLayerRef.current = null;
      hillshadeLayerRef.current = null;
      regionalZoneLayerRef.current = null;
      jezeroLayerRef.current = null;
      breadcrumbLayerRef.current = null;
      plannedRouteLayerRef.current = null;
      landformLayerRef.current = null;
      tharsisLayerRef.current = null;
      wpLayerRef.current = null;
      routeLineRef.current = null;
      blueTrailRef.current = null;
    };
  }, [onSetAstronautCoords, setGlobalOverrideLatLng]);

  // Toggle Viking MDIM tile layer
  useEffect(() => {
    const map = mapRef.current;
    const layer = mdimLayerRef.current;
    if (!map || !layer) return;
    if (showMdim) {
      if (!map.hasLayer(layer)) layer.addTo(map);
    } else {
      if (map.hasLayer(layer)) map.removeLayer(layer);
    }
  }, [showMdim]);

  // Toggle MOLA shaded relief (NASA Trek) hillshade tile layer
  useEffect(() => {
    const map = mapRef.current;
    const layer = hillshadeLayerRef.current;
    if (!map || !layer) return;
    if (showHillshade) {
      if (!map.hasLayer(layer)) layer.addTo(map);
    } else {
      if (map.hasLayer(layer)) map.removeLayer(layer);
    }
  }, [showHillshade]);

  // Smooth great-circle marker flight ref so teleports glide instead of snapping
  const markerFlightRef = useRef<{
    active: boolean;
    startMs: number;
    durationMs: number;
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
  }>({
    active: false,
    startMs: 0,
    durationMs: 1800,
    from: { lat: JEZERO_ORIGIN.lat, lng: JEZERO_ORIGIN.lon },
    to: { lat: JEZERO_ORIGIN.lat, lng: JEZERO_ORIGIN.lon },
  });

  // Sync Astronaut Marker on Leaflet map (only initial creation or non-animated rest)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const latlng: [number, number] = [currentAstroLatLng.lat, currentAstroLatLng.lng];
    if (astroMarkerRef.current) {
      if (!markerFlightRef.current.active) {
        astroMarkerRef.current.setLatLng(latlng);
      }
    } else {
      astroMarkerRef.current = L.marker(latlng, {
        icon: L.divIcon({
          className: '',
          html: '<div class="astro-marker"></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
        zIndexOffset: 500,
      }).addTo(map);
    }
  }, [currentAstroLatLng]);

  // 60fps direct-DOM & Leaflet sync from liveVehicleRef (eliminates 4.5 Hz marker/compass stutter & 360° wrap spin)
  const hudLiveSyncMetaRef = useRef({
    fallbackHeading: astronautPos.heading,
    fallbackLatLng: currentAstroLatLng,
  });
  hudLiveSyncMetaRef.current = {
    fallbackHeading: astronautPos.heading,
    fallbackLatLng: currentAstroLatLng,
  };

  useEffect(() => {
    let lastRenderedLat = NaN;
    let lastRenderedLng = NaN;
    let lastRenderedHdgText = '';
    let lastRenderedPaceText = '';
    let lastRenderedPosText = '';
    let lastTeleportEpoch = vehicleSim.poseRef.current.teleportEpoch ?? 0;

    const syncLiveHud = (_dt: number, nowMs: number, simPose: LiveVehiclePose) => {
      const pose = liveVehicleRef?.current ?? simPose;
      const rawHeading = pose ? pose.heading : hudLiveSyncMetaRef.current.fallbackHeading;

      // Continuous unwrapped angle prevents 359° -> 1° needle flip
      const prevUnwrapped = continuousHeadingRef.current;
      const deltaDeg = ((rawHeading - prevUnwrapped + 540) % 360) - 180;
      const nextUnwrapped = prevUnwrapped + deltaDeg;
      continuousHeadingRef.current = nextUnwrapped;

      if (compassNeedleRef.current) {
        compassNeedleRef.current.style.setProperty('--hdg', `${nextUnwrapped.toFixed(2)}deg`);
      }

      const hdgText = `${String(Math.round(((rawHeading % 360) + 360) % 360)).padStart(3, '0')}°`;
      if (headingOutRef.current && hdgText !== lastRenderedHdgText) {
        lastRenderedHdgText = hdgText;
        headingOutRef.current.textContent = hdgText;
      }

      if (pose && paceOutRef.current) {
        const spdVal = Math.round(Math.abs(pose.speedMps) * 10) / 10;
        const spdText = `${spdVal.toFixed(1)} m/s`;
        if (spdText !== lastRenderedPaceText) {
          lastRenderedPaceText = spdText;
          paceOutRef.current.textContent = spdText;
        }
      }

      let liveLat = hudLiveSyncMetaRef.current.fallbackLatLng.lat;
      let liveLng = hudLiveSyncMetaRef.current.fallbackLatLng.lng;
      if (pose) {
        if (pose.lat !== undefined && pose.lng !== undefined) {
          liveLat = pose.lat;
          liveLng = pose.lng;
        } else if (!pose.isGlobalOverride) {
          const [jLat, jLng] = jezeroMetersToLatLng(pose.x, pose.y);
          liveLat = jLat;
          liveLng = jLng;
        }

        if (pose.teleportEpoch !== lastTeleportEpoch) {
          lastTeleportEpoch = pose.teleportEpoch;
          const fromLL = {
            lat: pose.lastTeleportFromLat ?? (Number.isFinite(lastRenderedLat) ? lastRenderedLat : liveLat),
            lng: pose.lastTeleportFromLng ?? (Number.isFinite(lastRenderedLng) ? lastRenderedLng : liveLng),
          };
          const toLL = { lat: liveLat, lng: liveLng };
          const distKm = marsDistanceKm(fromLL, toLL);
          if (distKm > 0.25) {
            const durSec = Math.min(2.8, Math.max(1.6, 1.6 + distKm / 2600));
            markerFlightRef.current = {
              active: true,
              startMs: nowMs,
              durationMs: durSec * 1000,
              from: fromLL,
              to: toLL,
            };
            const targetZoom = distKm > 250 ? 4 : distKm > 15 ? 7 : 10;
            mapRef.current?.flyTo([toLL.lat, toLL.lng], targetZoom, {
              duration: durSec,
              easeLinearity: 0.22,
            });
          }
        }
      }

      if (markerFlightRef.current.active) {
        const rawU = Math.min(
          1,
          Math.max(0, (nowMs - markerFlightRef.current.startMs) / Math.max(1, markerFlightRef.current.durationMs))
        );
        const easedU = rawU * rawU * rawU * (rawU * (rawU * 6 - 15) + 10);
        const pt = slerpLatLng(markerFlightRef.current.from, markerFlightRef.current.to, easedU);
        liveLat = pt.lat;
        liveLng = pt.lng;
        if (rawU >= 1) {
          markerFlightRef.current.active = false;
        }
      }

      if (liveLat !== lastRenderedLat || liveLng !== lastRenderedLng) {
        lastRenderedLat = liveLat;
        lastRenderedLng = liveLng;

        if (astroMarkerRef.current) {
          astroMarkerRef.current.setLatLng([liveLat, liveLng]);
        }

        if (blueTrailRef.current) {
          const existing = blueTrailRef.current.getLatLngs();
          if (Array.isArray(existing) && existing.length > 0) {
            if (Array.isArray(existing[0])) {
              const chunks = existing as L.LatLng[][];
              if (chunks[0] && chunks[0].length >= 2) {
                blueTrailRef.current.setLatLngs([
                  [L.latLng(liveLat, liveLng), ...chunks[0].slice(1)],
                  ...chunks.slice(1),
                ]);
              }
            } else if (existing.length >= 2) {
              const pts = existing as L.LatLng[];
              blueTrailRef.current.setLatLngs([
                L.latLng(liveLat, liveLng),
                ...pts.slice(1),
              ]);
            }
          }
        }

        const posText = `${fmtLat(liveLat)}, ${fmtLon(liveLng)}`;
        if (posOutRef.current && posText !== lastRenderedPosText) {
          lastRenderedPosText = posText;
          posOutRef.current.textContent = posText;
        }
      }
    };

    syncLiveHud(0, performance.now(), vehicleSim.poseRef.current);
    return vehicleSim.addHudFrameListener(syncLiveHud);
  }, [liveVehicleRef]);

  // Sync User Waypoint Markers (only rebuild when waypoint list or next-waypoint ID changes)
  const nearestWpId = nearestWaypoint?.id ?? null;
  useEffect(() => {
    const wpGroup = wpLayerRef.current;
    if (!wpGroup) return;

    wpGroup.clearLayers();
    waypoints.forEach((wp) => {
      const isNext = nearestWpId !== null && wp.id === nearestWpId;
      const m = L.marker([wp.lat, wp.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="wp-marker${isNext ? ' next' : ''}"></div>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        }),
      });
      m.bindTooltip(isNext ? `WP${wp.id} · NEXT` : `WP${wp.id}`, {
        direction: 'top',
        offset: [0, -8],
        className: 'hud-map-tip',
      });
      m.addTo(wpGroup);
    });
  }, [waypoints, nearestWpId]);

  // Sync Blue Guidance Trail & Remaining Route Line without rebuilding markers
  useEffect(() => {
    const routeLine = routeLineRef.current;
    const blueTrail = blueTrailRef.current;
    if (!routeLine || !blueTrail) return;

    const buildArcOrLine = (
      fromPt: { lat: number; lng: number },
      toPt: { lat: number; lng: number },
      segments = 28
    ): Array<[number, number]> | Array<Array<[number, number]>> => {
      const distKm = marsDistanceKm(fromPt, toPt);
      if (distKm > 150) {
        const arc = sampleGreatCircleArc(fromPt, toPt, segments);
        return splitAntimeridianPolyline(arc);
      }
      return [
        [fromPt.lat, fromPt.lng],
        [toPt.lat, toPt.lng],
      ];
    };

    if (nearestWaypoint) {
      blueTrail.setLatLngs(buildArcOrLine(currentAstroLatLng, nearestWaypoint, 28));
      if (orderedWaypoints.length > 1) {
        const multiChunks: Array<Array<[number, number]>> = [];
        for (let i = 1; i < orderedWaypoints.length; i++) {
          const a = orderedWaypoints[i - 1];
          const b = orderedWaypoints[i];
          if (marsDistanceKm(a, b) > 150) {
            const arc = sampleGreatCircleArc(a, b, 20);
            multiChunks.push(...splitAntimeridianPolyline(arc));
          } else {
            multiChunks.push([
              [a.lat, a.lng],
              [b.lat, b.lng],
            ]);
          }
        }
        routeLine.setLatLngs(multiChunks);
      } else {
        routeLine.setLatLngs([]);
      }
    } else if (hasGuidanceTarget) {
      const destLatLng: [number, number] = targetLatLng
        ? [targetLatLng.lat, targetLatLng.lng]
        : jezeroMetersToLatLng(targetPos.x, targetPos.y);
      blueTrail.setLatLngs(
        buildArcOrLine(currentAstroLatLng, { lat: destLatLng[0], lng: destLatLng[1] }, 28)
      );
      routeLine.setLatLngs([]);
    } else {
      blueTrail.setLatLngs([]);
      routeLine.setLatLngs([]);
    }
  }, [orderedWaypoints, nearestWaypoint, currentAstroLatLng, targetPos, targetLatLng, hasGuidanceTarget]);

  // Sync Breadcrumb Trail separately from Jezero markers
  useEffect(() => {
    const breadcrumbLine = breadcrumbLayerRef.current;
    if (!breadcrumbLine) return;
    if (!showJezeroOverlay || astronautPos.path.length <= 1) {
      breadcrumbLine.setLatLngs([]);
      return;
    }
    breadcrumbLine.setLatLngs(
      astronautPos.path.map((pt) => jezeroMetersToLatLng(pt.x, pt.y))
    );
  }, [showJezeroOverlay, astronautPos.path]);

  // Sync Jezero Crater Waypoints & Radiation Hotspots (no path churn)
  useEffect(() => {
    const map = mapRef.current;
    const group = jezeroLayerRef.current;
    if (!map || !group) return;

    group.clearLayers();
    if (!showJezeroOverlay) return;

    // Radiation hotspots
    RADIATION_HOTSPOTS.forEach((hs) => {
      const center = jezeroMetersToLatLng(hs.x, hs.z);
      L.circle(center, {
        radius: hs.radius,
        color: '#ff5a4d',
        weight: 1,
        dashArray: '4 3',
        fillColor: '#ff5a4d',
        fillOpacity: 0.16,
      })
        .bindTooltip(`☢ ${hs.name} (${hs.doseRateMicroSvHr} µSv/h)`, {
          className: 'hud-map-tip',
        })
        .addTo(group);
    });

    // Jezero Waypoints
    MARS_WAYPOINTS.forEach((wp) => {
      const pos = jezeroMetersToLatLng(wp.x, wp.z);
      const isTarget = wp.id === state.navigation.targetWaypointId;
      const isDisabledForRtb = state.emergencyRtbActive && wp.type !== 'habitat';
      const cls =
        wp.type === 'habitat'
          ? 'jezero-wp-marker hab'
          : isTarget
            ? 'jezero-wp-marker target'
            : 'jezero-wp-marker';
      const marker = L.marker(pos, {
        opacity: isDisabledForRtb ? 0.35 : 1,
        icon: L.divIcon({
          className: '',
          html: `<div class="${cls}"></div>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        }),
      });
      marker.bindTooltip(
        isDisabledForRtb ? `${wp.id}: ${wp.name} (DISABLED · RTB)` : `${wp.id}: ${wp.name}`,
        {
          direction: 'top',
          offset: [0, -6],
          className: 'hud-map-tip',
        }
      );
      marker.on('click', (e: L.LeafletMouseEvent) => {
        if (mapModeRef.current === 'waypoint') {
          if (emergencyRtbActiveRef.current) return;
          L.DomEvent.stopPropagation(e);
          playChirpSound();
          onAddCustomWaypointRef.current(pos[0], pos[1]);
        } else if (mapModeRef.current === null) {
          L.DomEvent.stopPropagation(e);
          setSelectedLandmarkPopup({
            id: wp.id,
            name: wp.name,
            categoryLabel: wp.type.toUpperCase(),
            colorHex: WAYPOINT_TYPE_COLORS[wp.type].hex,
            lat: pos[0],
            lng: pos[1],
            summary: wp.description,
            isLandform: false,
          });
          onSetNavTarget(wp.id);
        }
      });
      marker.addTo(group);
    });

    // Discovered Jezero Science Features (Delta / Subsurface Ice / Mineral Reserves)
    JEZERO_SCIENCE_FEATURES.forEach((feat) => {
      if (!discoveredFeatureIds.includes(feat.id)) return;
      const pos = jezeroMetersToLatLng(feat.x, feat.z);
      const isSelected = feat.id === state.navigation.targetWaypointId;
      const marker = L.marker(pos, {
        icon: L.divIcon({
          className: '',
          html: `<div style="width:${isSelected ? 14 : 11}px;height:${isSelected ? 14 : 11}px;background:${feat.colorHex};border:${isSelected ? '2px solid #ffffff' : '1.5px solid #07090d'};clip-path:polygon(50% 0%,100% 100%,0% 100%);filter:drop-shadow(0 0 ${isSelected ? 8 : 5}px ${feat.colorHex});"></div>`,
          iconSize: [isSelected ? 14 : 11, isSelected ? 14 : 11],
          iconAnchor: [isSelected ? 7 : 5.5, isSelected ? 7 : 5.5],
        }),
        zIndexOffset: isSelected ? 360 : 250,
      });
      marker.bindTooltip(
        `<span style="color:${feat.colorHex};font-weight:700">[DISCOVERED] ${feat.name}</span> · ${feat.categoryLabel}`,
        {
          direction: 'top',
          offset: [0, -7],
          className: 'hud-map-tip',
        }
      );
      marker.on('click', (e: L.LeafletMouseEvent) => {
        if (mapModeRef.current === 'waypoint') {
          if (emergencyRtbActiveRef.current) return;
          L.DomEvent.stopPropagation(e);
          playChirpSound();
          onAddCustomWaypointRef.current(pos[0], pos[1]);
        } else if (mapModeRef.current === null) {
          L.DomEvent.stopPropagation(e);
          playAckTone();
          setSelectedLandmarkPopup({
            id: feat.id,
            name: feat.name,
            categoryLabel: `${feat.categoryLabel} · DISCOVERED`,
            colorHex: feat.colorHex,
            lat: pos[0],
            lng: pos[1],
            visualText: `${feat.mineralSignature} — ${feat.summary}`,
            summary: feat.summary,
            isLandform: false,
          });
          onSetNavTarget(feat.id);
        }
      });
      marker.addTo(group);
    });
  }, [
    showJezeroOverlay,
    state.navigation.targetWaypointId,
    state.emergencyRtbActive,
    onSetNavTarget,
    discoveredFeatureIds,
  ]);

  // Sync Planetary & Regional Martian Landforms (color-coded) with dynamic tooltip (zero DOM rebuild during movement)
  useEffect(() => {
    const map = mapRef.current;
    const group = landformLayerRef.current;
    if (!map || !group) return;

    group.clearLayers();
    if (!showLandforms) return;

    MARS_LANDFORMS.forEach((lf) => {
      const cat = LANDFORM_CATEGORY_COLORS[lf.category];
      const isSelected = lf.id === state.navigation.targetWaypointId;

      const marker = L.marker([lf.lat, lf.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="width:${isSelected ? 14 : 11}px;height:${isSelected ? 14 : 11}px;background:${cat.hex};border:${isSelected ? '2px solid #ffffff' : '1.5px solid #07090d'};transform:rotate(45deg);box-shadow:0 0 ${isSelected ? 14 : 9}px ${cat.hex};"></div>`,
          iconSize: [isSelected ? 14 : 11, isSelected ? 14 : 11],
          iconAnchor: [isSelected ? 7 : 5.5, isSelected ? 7 : 5.5],
        }),
        zIndexOffset: isSelected ? 350 : 200,
      });

      marker.bindTooltip(
        () => {
          const distKm = marsDistanceKm(currentAstroLatLngRef.current, { lat: lf.lat, lng: lf.lng });
          const inVisorRange = distKm <= VISOR_PROXIMITY_THRESHOLD_KM;
          return `<span style="color:${cat.hex};font-weight:700">${lf.name}</span> · ${cat.label} · ${fmtDist(distKm)} (${
            inVisorRange ? '3D Visor <=300km' : 'Culled >300km'
          })`;
        },
        {
          direction: 'top',
          offset: [0, -8],
          className: 'hud-map-tip',
        }
      );

      marker.on('click', (e: L.LeafletMouseEvent) => {
        if (mapModeRef.current === 'waypoint') {
          if (emergencyRtbActiveRef.current) return;
          L.DomEvent.stopPropagation(e);
          playChirpSound();
          onAddCustomWaypointRef.current(lf.lat, lf.lng);
          return;
        }
        L.DomEvent.stopPropagation(e);
        playAckTone();
        setSelectedLandmarkPopup({
          id: lf.id,
          name: lf.name,
          categoryLabel: cat.label,
          colorHex: cat.hex,
          lat: lf.lat,
          lng: lf.lng,
          elevationMeters: lf.elevationMeters,
          dimensionsText: `${lf.dimensions.verticalMetric} · ${lf.dimensions.horizontalMetric}`,
          visualText: lf.visualCharacteristics,
          constraints: lf.terrainConstraints,
          summary: lf.scienceSummary,
          isLandform: true,
        });
        onSetNavTarget(lf.id);
      });

      marker.addTo(group);
    });
  }, [
    showLandforms,
    state.navigation.targetWaypointId,
    onSetNavTarget,
  ]);

  // Mons / Ravines / Troughs topographic layer (Tharsis rise, Valles Marineris, Olympus Mons structure)
  useEffect(() => {
    const group = tharsisLayerRef.current;
    if (!group) return;
    group.clearLayers();
    if (!showTharsis) return;

    THARSIS_FEATURES.forEach((f) => {
      const style = FEATURE_KIND_STYLE[f.kind];
      const facts = [
        f.elevationMeters !== undefined ? `elev ${f.elevationMeters.toLocaleString()} m` : null,
        f.reliefMeters !== undefined
          ? `${f.kind === 'MONS' ? 'relief' : f.kind === 'ESCARPMENT' ? 'cliff' : 'depth'} ~${(f.reliefMeters / 1000).toFixed(1)} km`
          : null,
        f.widthKm !== undefined ? `~${f.widthKm} km wide` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const tip = `<span style="color:${style.color};font-weight:700">${f.name}</span> · ${style.label}${
        facts ? ` · ${facts}` : ''
      }<br/><span style="opacity:.85">${f.description}</span>`;

      if (f.points && f.points.length > 1) {
        const isArea = f.kind === 'AUREOLE';
        const line = isArea
          ? L.polygon(f.points, {
              color: style.color,
              weight: 1.2,
              dashArray: '4 4',
              fillColor: style.color,
              fillOpacity: 0.1,
            })
          : L.polyline(f.points, {
              color: style.color,
              weight: f.kind === 'ESCARPMENT' ? 3 : f.kind === 'RAVINE' ? 4 : 2.5,
              opacity: 0.9,
              dashArray: f.kind === 'TROUGH' ? '6 3' : f.kind === 'ESCARPMENT' ? '2 5' : undefined,
            });
        line.bindTooltip(tip, { sticky: true, className: 'hud-map-tip' });
        line.addTo(group);
        // wider translucent hazard corridor around ravines and troughs
        if (f.kind === 'RAVINE' || f.kind === 'TROUGH') {
          L.polyline(f.points, {
            color: '#ef4444',
            weight: f.kind === 'RAVINE' ? 14 : 9,
            opacity: 0.14,
            interactive: false,
          }).addTo(group);
        }
      }

      if (f.kind === 'MONS' || f.kind === 'CALDERA') {
        const size = f.kind === 'MONS' ? 11 : 9;
        L.marker([f.lat, f.lng], {
          icon: L.divIcon({
            className: '',
            html: `<div style="width:0;height:0;border-left:${size / 2 + 1}px solid transparent;border-right:${size / 2 + 1}px solid transparent;border-bottom:${size + 2}px solid ${style.color};filter:drop-shadow(0 0 4px ${style.color});"></div>`,
            iconSize: [size + 2, size + 2],
            iconAnchor: [(size + 2) / 2, size + 2],
          }),
          zIndexOffset: 150,
        })
          .bindTooltip(tip, { direction: 'top', offset: [0, -8], className: 'hud-map-tip' })
          .addTo(group);
      }
    });

    // Six nested summit caldera craters (visible when zoomed in on Olympus Mons)
    OLYMPUS_CALDERA_CRATERS.forEach((c) => {
      L.circle([c.lat, c.lng], {
        radius: (c.diameterKm * 1000) / 2,
        color: '#f97316',
        weight: 1.2,
        fillColor: '#f97316',
        fillOpacity: 0.08,
      })
        .bindTooltip(
          `<span style="color:#f97316;font-weight:700">${c.name}</span> · ${c.diameterKm} km wide · ${(c.depthMeters / 1000).toFixed(1)} km deep`,
          { sticky: true, className: 'hud-map-tip' }
        )
        .addTo(group);
    });
  }, [showTharsis]);

  // Sync Regional Zones & Hemispheric Dichotomy overlays on the global map
  useEffect(() => {
    const group = regionalZoneLayerRef.current;
    if (!group) return;
    group.clearLayers();
    if (!showRegions) return;

    MARS_REGIONAL_ZONES.forEach((zone) => {
      const tip = `<span style="color:${zone.colorHex};font-weight:700">${zone.name}</span> · ${zone.subtitle}`;
      if (zone.kind === 'circle' && zone.points[0] && zone.radiusMeters) {
        L.circle(zone.points[0], {
          radius: zone.radiusMeters,
          color: zone.colorHex,
          weight: 1.3,
          dashArray: '5 4',
          fillColor: zone.colorHex,
          fillOpacity: 0.08,
        })
          .bindTooltip(tip, { className: 'hud-map-tip', sticky: true })
          .addTo(group);
      } else if (zone.kind === 'polygon') {
        L.polygon(zone.points, {
          color: zone.colorHex,
          weight: 1.4,
          dashArray: '4 4',
          fillColor: zone.colorHex,
          fillOpacity: 0.1,
        })
          .bindTooltip(tip, { className: 'hud-map-tip', sticky: true })
          .addTo(group);
      } else if (zone.kind === 'polyline') {
        L.polyline(zone.points, {
          color: zone.colorHex,
          weight: 2.2,
          opacity: 0.72,
          dashArray: '6 5',
        })
          .bindTooltip(tip, { className: 'hud-map-tip', sticky: true })
          .addTo(group);
      }
    });
  }, [showRegions]);

  // Sync Planned Planetary Route Corridor preview on the Leaflet map
  useEffect(() => {
    const group = plannedRouteLayerRef.current;
    if (!group) return;
    group.clearLayers();
    if (!plannedRoute) return;

    plannedRoute.segments.forEach((seg) => {
      const chunks = splitAntimeridianPolyline(seg.points);
      chunks.forEach((chunk) => {
        L.polyline(chunk, {
          color: '#ffb347',
          weight: 3.2,
          opacity: 0.9,
          dashArray: '8 5',
        })
          .bindTooltip(
            `${seg.fromName} → ${seg.toName} · ${seg.distanceKm.toFixed(0)} km (${seg.difficulty})`,
            { className: 'hud-map-tip', sticky: true }
          )
          .addTo(group);
      });
    });

    const nodePoints = [
      { lat: plannedRoute.originLatLng.lat, lng: plannedRoute.originLatLng.lng, label: `ORIGIN: ${plannedRoute.originName}`, color: '#5dffa0' },
      { lat: plannedRoute.destinationLatLng.lat, lng: plannedRoute.destinationLatLng.lng, label: `DEST: ${plannedRoute.destinationName}`, color: '#ffb347' },
    ];
    nodePoints.forEach((pt) => {
      L.circleMarker([pt.lat, pt.lng], {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: pt.color,
        fillOpacity: 1,
      })
        .bindTooltip(pt.label, { direction: 'top', className: 'hud-map-tip' })
        .addTo(group);
    });
  }, [plannedRoute]);

  const handleGlobalView = () => {
    playChirpSound();
    mapRef.current?.flyTo(GLOBAL_VIEW.center, GLOBAL_VIEW.zoom, {
      duration: 2.0,
      easeLinearity: 0.22,
    });
  };

  const handleJezeroView = () => {
    playChirpSound();
    mapRef.current?.flyTo([JEZERO_ORIGIN.lat, JEZERO_ORIGIN.lon], 11, {
      duration: 2.2,
      easeLinearity: 0.22,
    });
  };

  const handleCenterAstro = () => {
    playChirpSound();
    const zoom = Math.max(mapRef.current?.getZoom() ?? 7, 10);
    mapRef.current?.flyTo([currentAstroLatLng.lat, currentAstroLatLng.lng], zoom, {
      duration: 1.75,
      easeLinearity: 0.22,
    });
  };

  const toggleMode = (m: 'place' | 'waypoint') => {
    if (m === 'waypoint' && state.emergencyRtbActive) return;
    playChirpSound();
    setMapMode((prev) => (prev === m ? null : m));
  };

  const removeWaypoint = (idx: number) => {
    playChirpSound();
    onRemoveCustomWaypoint(idx);
  };

  const clearWaypoints = () => {
    playChirpSound();
    onClearCustomWaypoints();
  };

  const handleDriveClick = useCallback(
    (dir: 'forward' | 'backward' | 'left' | 'right') => {
      onMoveAstronaut(dir);
    },
    [onMoveAstronaut]
  );

  // Derived Telemetry Values from real App State
  const {
    vitals,
    environmental,
    atmospheric,
    topography,
    navigation,
    hazardAlert,
    equipment,
    comms,
    activeChallenge,
    consequences,
    lastSettingChange,
  } = state;

  const settingToastDismissMs = getSettingToastDismissMs(lastSettingChange);

  const liveSpeedMps = liveVehicleRef ? Math.abs(liveVehicleRef.current.speedMps) : 0;
  const isRecentlyMoving =
    liveSpeedMps > 0.05 || Date.now() - lastMovedTimestamp < 1200 || equipment.autonomousAiPilot;
  const paceMps = liveVehicleRef
    ? Math.round(liveSpeedMps * 10) / 10
    : isRecentlyMoving
      ? Math.round(
          (equipment.autonomousAiPilot
            ? equipment.locomotionMode === 'rover'
              ? 52
              : 22
            : equipment.locomotionMode === 'rover'
              ? 18
              : 7.5) *
            equipment.speedTorqueSetting *
            10
        ) / 10
      : 0.0;

  const distanceWalkedKm = useMemo(() => {
    let totalMeters = 0;
    for (let i = 1; i < astronautPos.path.length; i++) {
      const a = astronautPos.path[i - 1];
      const b = astronautPos.path[i];
      totalMeters += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return totalMeters / 1000;
  }, [astronautPos.path]);

  // Traverse length, nearest checkpoint distance & live ETA
  const routeMetrics = useMemo(() => {
    const calcEta = (distKm: number) =>
      estimateMarsTravelEtaMinutes(
        distKm * 1000,
        equipment.locomotionMode,
        equipment.speedTorqueSetting
      );

    if (orderedWaypoints.length === 0) {
      if (targetLatLng && (globalOverrideLatLng || navigation.distanceMeters >= 1800)) {
        const km = haversineKm(currentAstroLatLng, targetLatLng);
        return {
          routeLen: fmtDist(km),
          toNext: fmtDist(km),
          etaMin: calcEta(km),
          bearing: Math.round(marsBearingDeg(currentAstroLatLng, targetLatLng)),
        };
      }
      if (globalOverrideLatLng) {
        const [tLat, tLng] = jezeroMetersToLatLng(targetPos.x, targetPos.y);
        const km = haversineKm(currentAstroLatLng, { lat: tLat, lng: tLng });
        return {
          routeLen: fmtDist(km),
          toNext: fmtDist(km),
          etaMin: calcEta(km),
          bearing: Math.round(marsBearingDeg(currentAstroLatLng, { lat: tLat, lng: tLng })),
        };
      }
      return {
        routeLen: `${(navigation.distanceMeters / 1000).toFixed(2)} km`,
        toNext: `${navigation.distanceMeters} m`,
        etaMin: navigation.etaMinutes,
        bearing: navigation.bearingDegrees,
      };
    }
    const path = [currentAstroLatLng, ...orderedWaypoints];
    let km = 0;
    for (let i = 1; i < path.length; i++) {
      km += haversineKm(path[i - 1], path[i]);
    }
    const nextKm = haversineKm(currentAstroLatLng, orderedWaypoints[0]);
    return {
      routeLen: fmtDist(km),
      toNext: fmtDist(nextKm),
      etaMin: calcEta(nextKm),
      bearing: Math.round(marsBearingDeg(currentAstroLatLng, orderedWaypoints[0])),
    };
  }, [
    orderedWaypoints,
    currentAstroLatLng,
    globalOverrideLatLng,
    targetPos.x,
    targetPos.y,
    targetLatLng,
    navigation.distanceMeters,
    navigation.etaMinutes,
    navigation.bearingDegrees,
    equipment.locomotionMode,
    equipment.speedTorqueSetting,
  ]);

  // Status Indicators
  const isBad =
    vitals.oxygenPercentage < 25 ||
    vitals.batteryPercentage < 25 ||
    vitals.co2PartialPressureMmhg > 6.5 ||
    hazardAlert.severity === 'CRITICAL_HAZARD';
  const isWarn =
    !isBad &&
    (vitals.oxygenPercentage < 45 ||
      vitals.batteryPercentage < 45 ||
      hazardAlert.active ||
      comms.commBlackoutActive);

  const suitTxt = isBad ? 'RED' : isWarn ? 'AMBER' : 'GREEN';
  const linkTxt = comms.commBlackoutActive
    ? 'BLACKOUT'
    : isBad
      ? 'ALERT'
      : isWarn
        ? 'CAUTION'
        : 'NOMINAL';
  const dotClass = isBad || comms.commBlackoutActive ? 'bad' : isWarn ? 'warn' : '';

  const o2BarClass = vitals.oxygenPercentage < 20 ? 'red' : vitals.oxygenPercentage < 40 ? 'amber' : '';
  const batBarClass = vitals.batteryPercentage < 20 ? 'red' : vitals.batteryPercentage < 40 ? 'amber' : '';
  const co2Pct = Math.min(100, (vitals.co2PartialPressureMmhg / 7.6) * 100);
  const co2BarClass = vitals.co2PartialPressureMmhg > 5.5 ? 'red' : 'amber';
  const tempPct = Math.min(100, Math.max(0, ((vitals.coreTempCelsius - 35) / 5) * 100));
  const tempBarClass = vitals.coreTempCelsius > 38.2 ? 'red' : 'amber';

  const remainSeconds = Math.max(
    0,
    Math.round(Math.min(vitals.oxygenReserveDurationHours, vitals.batteryReserveHours) * 3600)
  );

  const hudContainerClass = `hud${mobilePanel === 'left' ? ' show-left' : ''}${
    mobilePanel === 'right' ? ' show-right' : ''
  }`;

  const activeArrival = customArrival && !customArrival.dismissed
    ? {
        title: customArrival.nextWpId !== null ? `✓ WAYPOINT WP${customArrival.wpId} REACHED` : '✓ DESTINATION REACHED',
        label:
          customArrival.nextWpId !== null
            ? `Leading to WP${customArrival.nextWpId} (${customArrival.remainingCount} remaining)`
            : `WP${customArrival.wpId} (Traverse Complete)`,
        dismissed: customArrival.dismissed,
        exiting: Boolean(customArrival.exiting),
        onDismiss: () => {
          playChirpSound();
          onDismissCustomArrival();
        },
      }
    : !globalOverrideLatLng && destinationReached
      ? {
          title: '✓ DESTINATION REACHED',
          label: `${destinationReached.waypointId}: ${destinationReached.waypointName}`,
          dismissed: destinationReached.dismissed,
          exiting: Boolean(destinationReached.exiting),
          onDismiss: () => onDismissDestinationReached?.(),
        }
      : null;

  const isSpeVisualActive = environmental.solarParticleEventActive || environmental.radiationDoseRateMicroSvHr > 25;
  const isExtremeSpe = environmental.radiationDoseRateMicroSvHr >= 100 || environmental.speIntensityLevel === 'EXTREME_CME_STORM';
  const speIntensityAlpha = Math.min(0.68, Math.max(0.18, (environmental.radiationDoseRateMicroSvHr - 20) / 220));
  const showDustOverlay = atmospheric.dustOpacityTau > 0.45;
  const dustOverlayAlpha = Math.min(0.55, Math.max(0.08, (atmospheric.dustOpacityTau - 0.4) * 0.35));
  const isWindShearRisk =
    equipment.solarPanelsDeployed && (atmospheric.windGustMps > 13.5 || atmospheric.dustOpacityTau > 0.75);
  const isEmergencyRtbEligible =
    atmospheric.dustOpacityTau >= 0.9 ||
    atmospheric.windGustMps >= 15 ||
    atmospheric.dustStormStatus === 'GLOBAL_DUST_STORM' ||
    environmental.radiationDoseRateMicroSvHr >= 50 ||
    equipment.suitRoverIntegrityPercent < 65 ||
    vitals.oxygenPercentage < 25 ||
    vitals.batteryPercentage < 25 ||
    (hazardAlert.active && hazardAlert.severity === 'CRITICAL_HAZARD') ||
    state.returnToBaseTimerSeconds !== null;

  return (
    <div className="eva-hud-shell">
      {/* Full-screen Leaflet Map */}
      <div id="map" ref={mapContainerRef} />
      <div className="hud-fx" />
      {showDustOverlay && (
        <div
          className="dust-fx"
          style={
            {
              '--dust-alpha': dustOverlayAlpha.toFixed(2),
              '--dust-edge': Math.min(0.78, dustOverlayAlpha + 0.25).toFixed(2),
            } as React.CSSProperties
          }
        />
      )}
      {isSpeVisualActive && (
        <div
          className={`spe-fx ${isExtremeSpe ? 'extreme' : ''}`}
          style={{ '--spe-edge': speIntensityAlpha.toFixed(2) } as React.CSSProperties}
        />
      )}
      <div className="crosshair" />

      {activeArrival && !activeArrival.dismissed ? (
        <div
          className={`arrival-banner${activeArrival.exiting ? ' toast-exiting' : ''}`}
          role="status"
          aria-live="polite"
        >
          <div>
            <div className="arrival-title">{activeArrival.title}</div>
            <div className="arrival-sub">{activeArrival.label}</div>
          </div>
          <button type="button" onClick={activeArrival.onDismiss}>
            ACK
          </button>
          <span
            key={activeArrival.label}
            className="setting-toast-progress"
            style={{ '--toast-duration': `${NOTIFICATION_AUTO_DISMISS_MS.info}ms` } as React.CSSProperties}
          />
        </div>
      ) : lastSettingChange ? (
        <div
          className={`setting-toast ${lastSettingChange.severity}${lastSettingChange.exiting ? ' toast-exiting' : ''}`}
          role="status"
          aria-live="polite"
        >
          <div>
            <div className="setting-toast-title">{lastSettingChange.title}</div>
            <div className="setting-toast-detail">{lastSettingChange.detail}</div>
          </div>
          {onDismissSettingChange && (
            <button type="button" onClick={onDismissSettingChange}>
              {lastSettingChange.requiresAck ? 'ACK' : '×'}
            </button>
          )}
          {settingToastDismissMs !== null && (
            <span
              key={lastSettingChange.id}
              className="setting-toast-progress"
              style={{ '--toast-duration': `${settingToastDismissMs}ms` } as React.CSSProperties}
            />
          )}
        </div>
      ) : null}

      {/* PROXIMITY SCIENCE DISCOVERY PROMPT WITH AUTOPILOT TO LOCATION */}
      {(() => {
        const isDiscoveryToast = Boolean(recentDiscovery && !recentDiscovery.dismissed);
        const promptFeat = isDiscoveryToast
          ? recentDiscovery!.feature
          : activeProximityFeature;
        if (!promptFeat || globalOverrideLatLng) return null;
        const isCurrentTarget = state.navigation.targetWaypointId === promptFeat.id;
        const isDiscoveryExiting = isDiscoveryToast && Boolean(recentDiscovery?.exiting);
        return (
          <div
            role="status"
            aria-live="polite"
            className={`discovery-banner${isDiscoveryExiting ? ' toast-exiting' : ''}`}
            style={{
              position: 'fixed',
              bottom: selectedLandmarkPopup ? 242 : 84,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 1044,
              width: 'min(480px, calc(100vw - 32px))',
              background: 'rgba(8, 14, 24, 0.96)',
              border: `1px solid ${promptFeat.colorHex}`,
              boxShadow: `0 0 22px rgba(0,0,0,0.75), 0 0 14px ${promptFeat.colorHex}33`,
              padding: '9px 12px',
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
              transition: 'opacity 0.25s ease, transform 0.25s ease',
            }}
          >
            <div style={{ minWidth: 0, flex: '1 1 240px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    padding: '1px 5px',
                    border: `1px solid ${promptFeat.colorHex}`,
                    color: promptFeat.colorHex,
                    letterSpacing: '0.08em',
                  }}
                >
                  {activeProximityFeature?.id === promptFeat.id ? 'PROXIMITY SCAN' : 'SCIENCE DISCOVERED'} · {promptFeat.categoryLabel}
                </span>
                <span style={{ fontSize: 9, color: '#94a3b8' }}>
                  {discoveredFeatureIds.length}/{JEZERO_SCIENCE_FEATURES.length} LOGGED
                </span>
              </div>
              <div style={{ color: '#e2f1f8', fontSize: 12, fontWeight: 700, marginTop: 3 }}>
                {promptFeat.name}
              </div>
              <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 1 }}>
                {promptFeat.mineralSignature}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                className="on"
                onClick={() => onSetNavTarget(promptFeat.id, { autopilot: true })}
              >
                {isCurrentTarget && equipment.autonomousAiPilot ? 'Autopiloting' : 'Autopilot to Location'}
              </button>
              {recentDiscovery && !recentDiscovery.dismissed && onDismissRecentDiscovery && (
                <button type="button" onClick={onDismissRecentDiscovery} style={{ padding: '4px 8px' }}>
                  ×
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* INTERACTIVE LANDFORM / TACTICAL MAP POPUP WITH AUTOPILOT TO LOCATION TOGGLE */}
      {selectedLandmarkPopup && (
        <div
          style={{
            position: 'fixed',
            bottom: 84,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1045,
            width: 'min(420px, calc(100vw - 32px))',
            background: 'rgba(8, 14, 24, 0.96)',
            border: `1px solid ${selectedLandmarkPopup.colorHex}`,
            boxShadow: `0 0 24px rgba(0,0,0,0.75), 0 0 14px ${selectedLandmarkPopup.colorHex}33`,
            padding: '10px 12px',
            pointerEvents: 'auto',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    background: selectedLandmarkPopup.colorHex,
                    transform: 'rotate(45deg)',
                    display: 'inline-block',
                  }}
                />
                <strong style={{ color: '#e2f1f8', fontSize: 12, letterSpacing: '0.06em' }}>
                  {selectedLandmarkPopup.name}
                </strong>
                <span
                  style={{
                    fontSize: 9,
                    padding: '1px 5px',
                    border: `1px solid ${selectedLandmarkPopup.colorHex}`,
                    color: selectedLandmarkPopup.colorHex,
                  }}
                >
                  {selectedLandmarkPopup.categoryLabel}
                </span>
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 3 }} className="tabular-nums">
                {(() => {
                  const dKm = marsDistanceKm(currentAstroLatLng, {
                    lat: selectedLandmarkPopup.lat,
                    lng: selectedLandmarkPopup.lng,
                  });
                  const etaMin = estimateMarsTravelEtaMinutes(
                    dKm * 1000,
                    equipment.locomotionMode,
                    equipment.speedTorqueSetting
                  );
                  const inVisor = dKm <= VISOR_PROXIMITY_THRESHOLD_KM;
                  return `${formatAreographicCoords(selectedLandmarkPopup.lat, selectedLandmarkPopup.lng)} · ${fmtDist(dKm)} · ETA ${etaMin}m · ${
                    selectedLandmarkPopup.elevationMeters !== undefined
                      ? `Elev ${selectedLandmarkPopup.elevationMeters >= 0 ? '+' : ''}${selectedLandmarkPopup.elevationMeters.toLocaleString()}m · `
                      : ''
                  }${inVisor ? '3D Visor <=300km' : 'Culled >300km'}`;
                })()}
              </div>
              {selectedLandmarkPopup.dimensionsText && (
                <div style={{ fontSize: 10, color: '#7dd3fc', marginTop: 2 }} className="tabular-nums">
                  {selectedLandmarkPopup.dimensionsText}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setSelectedLandmarkPopup(null)}
              style={{ padding: '2px 6px', fontSize: 10 }}
            >
              ×
            </button>
          </div>
          <p style={{ fontSize: 10, color: '#cfeaf3', marginTop: 6, lineHeight: 1.45 }}>
            {selectedLandmarkPopup.visualText ?? selectedLandmarkPopup.summary}
          </p>
          {selectedLandmarkPopup.constraints && selectedLandmarkPopup.constraints.length > 0 && (
            <div style={{ fontSize: 9, color: '#fbbf24', marginTop: 4, lineHeight: 1.35 }}>
              Constraint: {selectedLandmarkPopup.constraints[0]}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginTop: 8,
              paddingTop: 8,
              borderTop: '1px dashed rgba(80,220,255,0.2)',
              flexWrap: 'wrap',
            }}
          >
            <label className="toggle" style={{ padding: 0, fontSize: 10 }}>
              <input
                type="checkbox"
                checked={state.equipment.enableAutopilotTravel}
                onChange={(e) => {
                  playChirpSound();
                  onUpdateEquipment({ enableAutopilotTravel: e.target.checked });
                }}
              />
              <span>Autopilot to Location</span>
            </label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => {
                  playChirpSound();
                  mapRef.current?.flyTo(
                    [selectedLandmarkPopup.lat, selectedLandmarkPopup.lng],
                    selectedLandmarkPopup.isLandform ? 4 : 11,
                    { duration: 1.9, easeLinearity: 0.22 }
                  );
                }}
              >
                Zoom
              </button>
              <button
                type="button"
                onClick={() => {
                  onSetNavTarget(selectedLandmarkPopup.id, {
                    autopilot: state.equipment.enableAutopilotTravel,
                  });
                }}
              >
                Set Target
              </button>
              <button
                type="button"
                className="on"
                onClick={() => {
                  onSetNavTarget(selectedLandmarkPopup.id, { autopilot: true });
                }}
              >
                Autopilot Now
              </button>
            </div>
          </div>
        </div>
      )}

      {showAtlas && (
        <Suspense fallback={null}>
          <PlanetaryAtlasDrawer
            isOpen={showAtlas}
            onClose={() => setShowAtlas(false)}
            currentAstroLatLng={currentAstroLatLng}
            currentAstroElevMeters={state.activeEnvironment.elevationMeters}
            locomotionMode={equipment.locomotionMode}
            speedTorqueSetting={equipment.speedTorqueSetting}
            activeTargetId={navigation.targetWaypointId}
            plannedRoute={plannedRoute}
            onSetPlannedRoute={setPlannedRoute}
            onFocusMapLatLng={(lat, lng, z = 4) => {
              mapRef.current?.flyTo([lat, lng], z, {
                duration: 2.0,
                easeLinearity: 0.22,
              });
            }}
            onFocusRouteBounds={(route) => {
              const allPts = route.segments.flatMap((s) => s.points);
              const crossesAntimeridian = allPts.some(
                (p, idx) => idx > 0 && Math.abs(p.lng - allPts[idx - 1].lng) > 180
              );
              if (crossesAntimeridian) {
                mapRef.current?.flyTo(GLOBAL_VIEW.center, GLOBAL_VIEW.zoom, {
                  duration: 2.1,
                  easeLinearity: 0.22,
                });
              } else if (allPts.length >= 2) {
                const bounds = L.latLngBounds(allPts.map((p) => [p.lat, p.lng] as [number, number]));
                mapRef.current?.flyToBounds(bounds.pad(0.28), {
                  maxZoom: 5,
                  duration: 2.1,
                  easeLinearity: 0.22,
                });
              }
            }}
            onSelectTarget={(id, opts) => {
              onSetNavTarget(id, opts);
            }}
            onDeployAndAutopilotRoute={(route) => {
              if (onDeployPlanetaryRoute) {
                onDeployPlanetaryRoute(route);
                return;
              }
              if (route.originId !== '__CURRENT__') {
                const originLatLng = route.originLatLng;
                const meters = latLngToJezeroMeters(originLatLng.lat, originLatLng.lng);
                const limit = WORLD_HALF_EXTENT - 90;
                if (Math.abs(meters.x) <= limit && Math.abs(meters.y) <= limit) {
                  setGlobalOverrideLatLng(null);
                  onSetAstronautCoords(meters.x, meters.y);
                } else {
                  setGlobalOverrideLatLng(originLatLng);
                }
                onSetNavTarget(route.destinationId, {
                  autopilot: true,
                  originOverride: {
                    lat: originLatLng.lat,
                    lng: originLatLng.lng,
                    elevationMeters: route.originElevationMeters,
                  },
                });
              } else {
                onSetNavTarget(route.destinationId, { autopilot: true });
              }
            }}
            emergencyRtbActive={state.emergencyRtbActive}
          />
        </Suspense>
      )}

      <div className={hudContainerClass} id="hud">
        {/* TOP BAR */}
        <header className="panel topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div className="brand">
              MARS <span>WALK</span> · EVA
            </div>
            <nav className="hud-nav">
              <button
                type="button"
                className={activeTab === 'hud' ? 'active-tab' : ''}
                onClick={() => {
                  playChirpSound();
                  setActiveTab('hud');
                }}
              >
                EVA HUD
              </button>
              <button
                type="button"
                className={activeTab === 'visor' ? 'active-tab' : ''}
                onClick={() => {
                  playChirpSound();
                  setActiveTab('visor');
                }}
              >
                3D Visor
              </button>
              <button
                type="button"
                className={activeTab === 'console' ? 'active-tab' : ''}
                onClick={() => {
                  playChirpSound();
                  setActiveTab('console');
                }}
              >
                Console
              </button>
              <button
                type="button"
                className={activeTab === 'sensors' ? 'active-tab' : ''}
                onClick={() => {
                  playChirpSound();
                  setActiveTab('sensors');
                }}
              >
                Datasets
              </button>
            </nav>
            <div className="mobile-drawer-btns">
              <button
                type="button"
                className={mobilePanel === 'left' ? 'on' : ''}
                onClick={() => setMobilePanel((p) => (p === 'left' ? 'none' : 'left'))}
              >
                Layers
              </button>
              <button
                type="button"
                className={mobilePanel === 'right' ? 'on' : ''}
                onClick={() => setMobilePanel((p) => (p === 'right' ? 'none' : 'right'))}
              >
                Suit
              </button>
            </div>
          </div>

          <div className="stat">
            <span className="pill">
              <i className={`dot ${dotClass}`} id="linkDot" /> Comms <b id="linkTxt">{linkTxt}</b>
            </span>
            <span className="pill">
              Suit <b id="suitTxt">{suitTxt}</b>
            </span>
            <span className="pill">
              EVA time <b id="clock">{hms(evaSecondsElapsed)}</b>
            </span>
            <span className="pill">
              Remaining <b id="remain">{hms(remainSeconds)}</b>
            </span>
            {state.returnToBaseTimerSeconds !== null && (
              <span
                className="pill"
                style={{
                  borderColor:
                    state.returnToBaseTimerSeconds <= 30
                      ? 'rgba(255, 82, 99, 0.7)'
                      : 'rgba(255, 195, 77, 0.6)',
                  color: state.returnToBaseTimerSeconds <= 30 ? 'var(--red)' : 'var(--amber)',
                }}
                title="Emergency Return-to-Base / Checkpoint countdown timer"
              >
                <i className={`dot ${state.returnToBaseTimerSeconds <= 30 ? 'bad' : 'warn'}`} />
                RTB{' '}
                <b id="rtbTimer">
                  {state.returnToBaseTimerSeconds === 0
                    ? 'EXPIRED!'
                    : mmss(state.returnToBaseTimerSeconds)}
                </b>
              </span>
            )}
            {state.emergencyRtbActive ? (
              <span
                className="pill"
                style={{
                  borderColor: 'rgba(255, 82, 99, 0.85)',
                  color: 'var(--red)',
                  background: 'rgba(255, 82, 99, 0.12)',
                  padding: '2px 8px',
                }}
              >
                <i className="dot bad" /> RTB LOCK <b>HAB-01</b>
              </span>
            ) : (
              isEmergencyRtbEligible &&
              onEngageEmergencyRtb && (
                <button
                  type="button"
                  className="danger on"
                  onClick={onEngageEmergencyRtb}
                  title="Clear all checkpoints, lock guidance & AI Co-Pilot to HAB-01 Base"
                >
                  ENGAGE EMERGENCY RTB
                </button>
              )
            )}
            <button
              type="button"
              onClick={() => setIsMuted(!isMuted)}
              title={isMuted ? 'Unmute audio alerts' : 'Mute audio alerts'}
            >
              {isMuted ? 'Muted' : 'Audio'}
            </button>
            <button
              type="button"
              className={`danger ${hazardAlert.active ? 'on' : ''}`}
              onClick={onSimulateEmergency}
            >
              {hazardAlert.active ? 'Clear Hazard' : 'Test Hazard'}
            </button>
            {onHazardOverride && (
              <button
                type="button"
                id="btnHazardOverride"
                className={`override ${anyHazardActive ? 'active' : ''}`}
                onClick={onHazardOverride}
                title="Clear all active hazards (storms, radiation, blackout, faults, and RTB lock)"
              >
                Hazard Override
              </button>
            )}
          </div>
        </header>

        {/* LEFT COLUMN */}
        <aside className="left">
          <section className="panel">
            <h2>
              Map layers <small>USGS</small>
            </h2>
            <div id="layerList">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showMdim}
                  onChange={(e) => setShowMdim(e.target.checked)}
                />
                <span>Viking MDIM 2.1 color</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showHillshade}
                  onChange={(e) => setShowHillshade(e.target.checked)}
                />
                <span>MOLA shaded relief (NASA Trek)</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showJezeroOverlay}
                  onChange={(e) => setShowJezeroOverlay(e.target.checked)}
                />
                <span>Jezero sector markers</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showLandforms}
                  onChange={(e) => setShowLandforms(e.target.checked)}
                />
                <span>Martian landforms ({MARS_LANDFORMS.length})</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showRegions}
                  onChange={(e) => setShowRegions(e.target.checked)}
                />
                <span>Regional zones &amp; dichotomy</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showTharsis}
                  onChange={(e) => setShowTharsis(e.target.checked)}
                />
                <span>Mons, ravines &amp; troughs ({THARSIS_FEATURES.length})</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={state.equipment.enableAutopilotTravel}
                  onChange={(e) => {
                    playChirpSound();
                    onUpdateEquipment({ enableAutopilotTravel: e.target.checked });
                  }}
                />
                <span>Autopilot to location</span>
              </label>
            </div>
            <div className="btns">
              <button
                type="button"
                className={showAtlas ? 'on' : ''}
                onClick={() => {
                  playChirpSound();
                  setShowAtlas((v) => !v);
                }}
                title="Open Global Mars Landmarks Atlas & Planetary Route Planner"
              >
                {showAtlas ? 'Close Atlas' : 'Atlas & Routes'}
              </button>
              <button type="button" id="btnHome" onClick={handleGlobalView}>
                Global view
              </button>
              <button type="button" onClick={handleJezeroView}>
                Jezero
              </button>
              <button type="button" onClick={handleCenterAstro}>
                Center
              </button>
            </div>
          </section>

          <section className="panel">
            <h2>
              Terrain hazards <small>RAVINES · TROUGHS</small>
            </h2>
            <div className="space-y-2">
              <TerrainHazardBanner
                biomeId={state.activeEnvironment.biomeId}
                frostMode={state.activeEnvironment.seasonalCo2FrostMode}
              />
              <OlympusClimbPanel
                biomeId={state.activeEnvironment.biomeId}
                slopePct={state.topography.slopePercentage}
                frostMode={state.activeEnvironment.seasonalCo2FrostMode}
              />
            </div>
          </section>

          <section className="panel grow">
            <h2>
              Traverse <small id="wpCount">{waypoints.length}</small>
            </h2>
            {state.emergencyRtbActive ? (
              <div
                style={{
                  marginBottom: 8,
                  padding: '6px 8px',
                  border: '1px solid rgba(255, 90, 77, 0.8)',
                  background: 'rgba(255, 90, 77, 0.14)',
                  color: 'var(--red)',
                  fontSize: 10,
                  lineHeight: 1.4,
                }}
              >
                <strong style={{ letterSpacing: '0.1em' }}>EMERGENCY RTB ACTIVE → HAB-01</strong>
                <div style={{ color: 'var(--text)', marginTop: 2 }}>
                  Checkpoints disabled. Waypoint creation locked until arrival at Habitat Base.
                </div>
              </div>
            ) : (
              isEmergencyRtbEligible &&
              onEngageEmergencyRtb && (
                <div className="btns" style={{ margin: '0 0 8px' }}>
                  <button
                    type="button"
                    id="btnEmergencyRtb"
                    className="danger on"
                    style={{ width: '100%' }}
                    onClick={onEngageEmergencyRtb}
                  >
                    ENGAGE EMERGENCY RTB
                  </button>
                </div>
              )
            )}
            <div className="btns" style={{ margin: '0 0 8px' }}>
              <button
                type="button"
                id="btnPlace"
                className={mapMode === 'place' ? 'on' : ''}
                onClick={() => toggleMode('place')}
              >
                {mapMode === 'place' ? 'Click map…' : 'Set position'}
              </button>
              <button
                type="button"
                id="btnAdd"
                className={mapMode === 'waypoint' ? 'on' : ''}
                disabled={state.emergencyRtbActive}
                style={state.emergencyRtbActive ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                title={
                  state.emergencyRtbActive
                    ? 'Locked until rover reaches HAB-01 Base'
                    : 'Click map to place custom waypoint'
                }
                onClick={() => toggleMode('waypoint')}
              >
                {state.emergencyRtbActive
                  ? 'WP LOCKED (RTB)'
                  : mapMode === 'waypoint'
                    ? 'Click map…'
                    : 'Add waypoint'}
              </button>
              <button type="button" id="btnClear" onClick={clearWaypoints}>
                Clear
              </button>
            </div>
            <ul className="wp-list" id="wpList">
              {waypoints.length === 0 ? (
                <li className="empty">
                  {state.emergencyRtbActive
                    ? 'Waypoints cleared & locked during Emergency RTB. Proceed to HAB-01.'
                    : 'No custom waypoints. Click Jezero markers or Add waypoint.'}
                </li>
              ) : (
                waypoints.map((p, i) => {
                  const isNext = nearestWaypoint !== null && p.id === nearestWaypoint.id;
                  return (
                    <li key={p.id}>
                      <span style={{ color: isNext ? 'var(--cyan)' : undefined }}>
                        WP{p.id}
                        {isNext ? ' · NEXT' : ''}
                      </span>
                      <span>
                        {p.lat.toFixed(2)}, {(((p.lng % 360) + 360) % 360).toFixed(2)}
                      </span>
                      <button type="button" onClick={() => removeWaypoint(i)}>
                        ×
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
            <div className="row">
              <label>Traverse length</label>
              <output id="routeLen">{routeMetrics.routeLen}</output>
            </div>
            <div className="row">
              <label>To next waypoint</label>
              <output id="toNext">{routeMetrics.toNext}</output>
            </div>
            <div className="row">
              <label>Mission target</label>
              <output>
                {nearestWaypoint ? `WP${nearestWaypoint.id} (NEXT)` : navigation.targetWaypointId}
              </output>
            </div>
            <div className="row">
              <label>Heading / ETA</label>
              <output style={{ color: 'var(--cyan)' }}>
                {routeMetrics.bearing}° · {routeMetrics.etaMin} min
              </output>
            </div>
            <div className="row">
              <label>Rover integrity</label>
              <output style={{ color: equipment.suitRoverIntegrityPercent < 60 ? 'var(--red)' : 'var(--green)' }}>
                {equipment.suitRoverIntegrityPercent.toFixed(1)}%
                {consequences.damageRatePercentPerSec > 0 && (
                  <span style={{ color: 'var(--red)', marginLeft: 6 }}>
                    (-{consequences.damageRatePercentPerSec.toFixed(1)}%/s)
                  </span>
                )}
              </output>
            </div>
            {state.returnToBaseTimerSeconds !== null && (
              <div className="row">
                <label style={{ color: state.returnToBaseTimerSeconds <= 30 ? 'var(--red)' : 'var(--amber)' }}>
                  RTB timer
                </label>
                <output
                  style={{
                    color: state.returnToBaseTimerSeconds <= 30 ? 'var(--red)' : 'var(--amber)',
                    fontWeight: 700,
                  }}
                >
                  {state.returnToBaseTimerSeconds === 0
                    ? 'EXPIRED — CRITICAL DMG'
                    : `${mmss(state.returnToBaseTimerSeconds)} → Shelter`}
                </output>
              </div>
            )}
            <div className="row">
              <label>Solar / Net power</label>
              <output style={{ color: consequences.netPowerWatts >= 0 ? 'var(--green)' : 'var(--amber)' }}>
                +{consequences.solarOutputWatts}W ({consequences.netPowerWatts >= 0 ? '+' : ''}{consequences.netPowerWatts}W)
              </output>
            </div>
            <div className="row">
              <label>Regolith slip risk</label>
              <output
                style={{
                  color:
                    topography.slipHazardRisk === 'SEVERE' || consequences.wheelSlipPercent > 40
                      ? 'var(--red)'
                      : topography.slipHazardRisk === 'MODERATE'
                        ? 'var(--amber)'
                        : 'var(--green)',
                }}
              >
                {topography.slipHazardRisk} ({consequences.wheelSlipPercent}%)
              </output>
            </div>
            <div className="row">
              <label>SEU upsets</label>
              <output style={{ color: consequences.seuBitFlipsCount > 3 ? 'var(--red)' : 'var(--text)' }}>
                {consequences.seuBitFlipsCount} upsets
              </output>
            </div>
            {consequences.activeFailureModes.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                {consequences.activeFailureModes.map((fm) => (
                  <span key={fm} className="rover-fault-pill">
                    {fm.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            )}
          </section>
        </aside>

        {/* RIGHT COLUMN */}
        <aside className="right">
          <section className="panel">
            <h2>
              Life support <small>{equipment.locomotionMode === 'rover' ? 'ROVER' : 'EVA'}</small>
            </h2>
            <div className="gauge">
              <div className="head">
                <span>Oxygen</span>
                <b id="o2Txt">{vitals.oxygenPercentage.toFixed(0)}%</b>
              </div>
              <div className={`bar ${o2BarClass}`} id="o2Bar">
                <i style={{ '--v': `${Math.max(0, Math.min(100, vitals.oxygenPercentage))}%` } as React.CSSProperties} />
              </div>
            </div>
            <div className="gauge">
              <div className="head">
                <span>Battery reserves</span>
                <b id="batTxt">
                  {vitals.batteryPercentage.toFixed(0)}% ({vitals.batteryReserveHours}h)
                </b>
              </div>
              <div className={`bar ${batBarClass}`} id="batBar">
                <i style={{ '--v': `${Math.max(0, Math.min(100, vitals.batteryPercentage))}%` } as React.CSSProperties} />
              </div>
            </div>
            <div className="gauge">
              <div className="head">
                <span>CO₂ level</span>
                <b id="co2Txt">{vitals.co2PartialPressureMmhg.toFixed(1)} mmHg</b>
              </div>
              <div className={`bar ${co2BarClass}`} id="co2Bar">
                <i style={{ '--v': `${co2Pct}%` } as React.CSSProperties} />
              </div>
            </div>
            <div className="gauge">
              <div className="head">
                <span>Thermal status</span>
                <b id="tmpTxt">
                  {vitals.suitThermalLoopStatus} ({vitals.coreTempCelsius.toFixed(1)} °C)
                </b>
              </div>
              <div className={`bar ${tempBarClass}`} id="tmpBar">
                <i style={{ '--v': `${tempPct}%` } as React.CSSProperties} />
              </div>
            </div>
            <div className="row">
              <label>Oxygen flow</label>
              <output style={{ color: 'var(--cyan)' }}>
                {vitals.oxygenFlowRateLpm.toFixed(2)} L/min
              </output>
            </div>
            <div className="row">
              <label>Suit pressure</label>
              <output id="spr">{vitals.suitPressureKpa.toFixed(1)} kPa</output>
            </div>
            <div className="btns">
              <button
                type="button"
                className={equipment.locomotionMode === 'rover' ? 'on' : ''}
                onClick={() => {
                  playChirpSound();
                  onUpdateEquipment({
                    locomotionMode: equipment.locomotionMode === 'rover' ? 'eva_walk' : 'rover',
                  });
                }}
              >
                {equipment.locomotionMode === 'rover' ? 'Mode: Rover' : 'Mode: EVA'}
              </button>
              <button
                type="button"
                className={equipment.autonomousAiPilot ? 'on' : ''}
                onClick={() => {
                  playAckTone();
                  onUpdateEquipment({ autonomousAiPilot: !equipment.autonomousAiPilot });
                }}
              >
                {equipment.autonomousAiPilot ? 'AI Pilot: ON' : 'AI Pilot'}
              </button>
              <button
                type="button"
                className={isWindShearRisk ? 'danger on' : equipment.solarPanelsDeployed ? 'on' : ''}
                onClick={() => {
                  playChirpSound();
                  onUpdateEquipment({ solarPanelsDeployed: !equipment.solarPanelsDeployed });
                }}
                title="Deploy or retract solar wings (risk of wind shear in storms!)"
              >
                {equipment.solarPanelsDeployed
                  ? isWindShearRisk
                    ? 'Solar: SHEAR!'
                    : 'Solar: OUT'
                  : 'Solar: STOW'}
              </button>
              <button
                type="button"
                className={equipment.headlightsEnabled ? 'on' : ''}
                onClick={() => {
                  playChirpSound();
                  onUpdateEquipment({ headlightsEnabled: !equipment.headlightsEnabled });
                }}
              >
                {equipment.headlightsEnabled ? 'Lights: ON' : 'Lights: OFF'}
              </button>
            </div>
          </section>

          <section className="panel">
            <h2>
              Astronaut <small>WASD</small>
            </h2>
            <div className="compass">
              <div
                ref={compassNeedleRef}
                className="needle"
                id="needle"
              />
            </div>
            <div className="row">
              <label>Heading</label>
              <output id="hdg" ref={headingOutRef}>
                {String(Math.round(astronautPos.heading)).padStart(3, '0')}°
              </output>
            </div>
            <div className="row">
              <label>Pace</label>
              <output id="spd" ref={paceOutRef}>
                {paceMps.toFixed(1)} m/s
              </output>
            </div>
            <div className="row">
              <label>Distance walked</label>
              <output id="dist">{distanceWalkedKm.toFixed(3)} km</output>
            </div>
            <div className="row">
              <label>Heart rate</label>
              <output id="hr">{Math.round(vitals.heartRateBpm)} bpm</output>
            </div>
            <div className="btns" style={{ justifyContent: 'space-between' }}>
              {(
                [
                  { dir: 'left', symbol: '◄', title: 'Turn Left (A)' },
                  { dir: 'forward', symbol: '▲', title: 'Forward (W)' },
                  { dir: 'backward', symbol: '▼', title: 'Reverse (S)' },
                  { dir: 'right', symbol: '►', title: 'Turn Right (D)' },
                ] as const
              ).map(({ dir, symbol, title }) => (
                <button
                  key={dir}
                  type="button"
                  title={title}
                  onPointerDown={(e) => {
                    try {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    } catch {
                      // ignore unsupported pointer capture
                    }
                    onDriveInput?.(dir, true, 'eva-hud');
                  }}
                  onPointerUp={(e) => {
                    try {
                      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                        e.currentTarget.releasePointerCapture(e.pointerId);
                      }
                    } catch {
                      // ignore
                    }
                    onDriveInput?.(dir, false, 'eva-hud');
                  }}
                  onPointerCancel={() => onDriveInput?.(dir, false, 'eva-hud')}
                  onLostPointerCapture={() => onDriveInput?.(dir, false, 'eva-hud')}
                  onBlur={() => onDriveInput?.(dir, false, 'eva-hud')}
                  onClick={(e) => {
                    if (!onDriveInput || e.detail === 0) {
                      handleDriveClick(dir);
                    }
                  }}
                >
                  {symbol}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setGlobalOverrideLatLng(null);
                  onResetPosition();
                }}
                title="Reset to Jezero Origin"
              >
                Reset
              </button>
            </div>
          </section>

          <section className="panel">
            <h2>
              Active Environment <small>MEDA / RAD</small>
            </h2>
            <div className="row">
              <label>Region</label>
              <output style={{ color: 'var(--cyan)', textAlign: 'right', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={state.activeEnvironment.regionName}>
                {state.activeEnvironment.regionName}
              </output>
            </div>
            <div className="row">
              <label>Elevation (MOLA)</label>
              <output className="tabular-nums">
                {state.activeEnvironment.elevationMeters >= 0 ? '+' : ''}
                {state.activeEnvironment.elevationMeters.toLocaleString()} m
              </output>
            </div>
            <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
              <label style={{ flexShrink: 0 }}>Surface</label>
              <output style={{ textAlign: 'right', fontSize: 10, lineHeight: 1.3, color: '#cbd5e1' }}>
                {state.activeEnvironment.surfaceType}
              </output>
            </div>
            <div className="row">
              <label>Air / Surface</label>
              <output id="air" className="tabular-nums">
                {environmental.ambientTempCelsius.toFixed(1)} °C
              </output>
            </div>
            <div className="row">
              <label>Pressure / Vis</label>
              <output id="prs" className="tabular-nums" style={{ textAlign: 'right', fontSize: 10 }}>
                {environmental.atmosphericPressurePa} Pa · {state.activeEnvironment.visibilityLabel}
              </output>
            </div>
            <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
              <label style={{ flexShrink: 0 }}>Active Weather</label>
              <output style={{ textAlign: 'right', fontSize: 10, lineHeight: 1.3, color: 'var(--amber)' }}>
                {state.activeEnvironment.activeWeather}
              </output>
            </div>
            <div className="row">
              <label>Wind / Dust τ</label>
              <output id="wnd" className="tabular-nums" style={{ color: atmospheric.dustOpacityTau > 0.75 ? 'var(--amber)' : 'var(--text)' }}>
                {atmospheric.windSpeedMps.toFixed(1)} m/s · {atmospheric.dustOpacityTau.toFixed(2)} τ
              </output>
            </div>
            <div className="row">
              <label>Radiation (RAD)</label>
              <output className="tabular-nums" style={{ color: environmental.radiationDoseRateMicroSvHr > 40 ? 'var(--red)' : environmental.radiationDoseRateMicroSvHr > 22 ? 'var(--amber)' : 'var(--text)' }}>
                {environmental.radiationDoseRateMicroSvHr.toFixed(1)} µSv/h
              </output>
            </div>
            <div className="row">
              <label>SPE / UHF Link</label>
              <output style={{ color: isExtremeSpe ? 'var(--red)' : isSpeVisualActive ? 'var(--amber)' : 'var(--green)' }}>
                {environmental.speIntensityLevel.replace(/_/g, ' ')} · {comms.signalStrengthPercent}%
              </output>
            </div>
            {state.activeEnvironment.navigationBoundaryNote && (
              <div
                style={{
                  fontSize: 10,
                  lineHeight: 1.35,
                  color: '#fbbf24',
                  background: 'rgba(245, 158, 11, 0.1)',
                  border: '1px solid rgba(245, 158, 11, 0.4)',
                  padding: '5px 7px',
                  marginTop: 4,
                  marginBottom: 4,
                }}
              >
                {state.activeEnvironment.navigationBoundaryNote}
              </div>
            )}
            {onTogglePolarFrostMode && (
              <div className="btns" style={{ marginTop: 4 }}>
                <button
                  type="button"
                  className={state.activeEnvironment.seasonalCo2FrostMode === 'DEPOSITION' ? 'on' : ''}
                  onClick={() => onTogglePolarFrostMode()}
                  title="Toggle seasonal CO2 dry-ice frost deposition vs sublimation across polar ice caps"
                  style={{ width: '100%' }}
                >
                  CO₂ Frost: {state.activeEnvironment.seasonalCo2FrostMode}
                </button>
              </div>
            )}
            {onTriggerSolarEvent && (
              <div className="btns">
                <button
                  type="button"
                  className={isExtremeSpe ? 'danger on' : isSpeVisualActive ? 'on' : ''}
                  onClick={() => onTriggerSolarEvent()}
                  title="Cycle Mars Solar Particle Event intensity (Nominal -> Elevated -> High Flux -> X-Class CME)"
                  style={{ width: '100%' }}
                >
                  {isExtremeSpe
                    ? 'Solar Event: X-CLASS CME'
                    : isSpeVisualActive
                      ? `Solar Event: ${environmental.speIntensityLevel.replace(/_/g, ' ')}`
                      : 'Trigger Solar Event'}
                </button>
              </div>
            )}
          </section>
        </aside>

        {/* BOTTOM BAR */}
        <footer className="panel bottombar">
          <div className="readout">
            <div>
              <label>Cursor lat</label>
              <output id="lat">{cursorCoords ? fmtLat(cursorCoords.lat) : '--'}</output>
            </div>
            <div>
              <label>Cursor lon</label>
              <output id="lon">{cursorCoords ? fmtLon(cursorCoords.lng) : '--'}</output>
            </div>
            <div>
              <label>Zoom</label>
              <output id="zoom">{zoomLevel}</output>
            </div>
            <div>
              <label>Astronaut position</label>
              <output id="pos" ref={posOutRef}>
                {fmtLat(currentAstroLatLng.lat)}, {fmtLon(currentAstroLatLng.lng)}
              </output>
            </div>
            <div>
              <label>Terrain / Slope</label>
              <output>
                {topography.slopePercentage}% · {topography.dominantGeology.replace('_', ' ')}
              </output>
            </div>
          </div>

          <div
            className={`notice ${hazardAlert.active ? 'bad' : activeArrival ? 'good' : ''}`}
            id="notice"
          >
            {tileNotice ? (
              <span>{tileNotice}</span>
            ) : hazardAlert.active ? (
              <>
                <span>
                  [!] {hazardAlert.title} — {hazardAlert.recommendedImmediateAction}
                  {state.returnToBaseTimerSeconds !== null &&
                    ` [RTB ${
                      state.returnToBaseTimerSeconds === 0
                        ? 'EXPIRED'
                        : mmss(state.returnToBaseTimerSeconds)
                    }]`}
                </span>
                {!state.emergencyRtbActive && isEmergencyRtbEligible && onEngageEmergencyRtb && (
                  <button type="button" className="danger on" onClick={onEngageEmergencyRtb}>
                    ENGAGE RTB
                  </button>
                )}
                <button type="button" className="danger" onClick={onAcknowledgeHazard}>
                  ACK
                </button>
              </>
            ) : activeArrival ? (
              <span>✓ DESTINATION REACHED · {activeArrival.label}</span>
            ) : activeChallenge ? (
              <span>
                {activeChallenge.completed
                  ? `★ CHALLENGE COMPLETE: ${activeChallenge.title}`
                  : `★ ${activeChallenge.title} · ${activeChallenge.elapsedSeconds}s`}
              </span>
            ) : (
              <span>
                {state.activeEnvironment.regionName.toUpperCase()} ·{' '}
                {state.activeEnvironment.activeWeather.toUpperCase()} · SOL {state.mission.currentSol}
              </span>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
};
