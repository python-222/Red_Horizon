import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Camera, Eye, Compass, Video, Orbit, Globe, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Cpu, Navigation, X } from 'lucide-react';
import { playChirpSound, playAckTone } from '../utils/audioAlerts';
import {
  getMarsElevation,
  getTerrainFrameId,
  sampleTerrainGridElevation,
  sampleTerrainGridNormalAndSlope,
  MARS_WAYPOINTS,
  JEZERO_SCIENCE_FEATURES,
  RADIATION_HOTSPOTS,
  WORLD_HALF_EXTENT,
  WAYPOINT_TYPE_COLORS,
  VISOR_PROXIMITY_THRESHOLD_KM,
  estimateMarsTravelEtaMinutes,
  LandformCategory,
  MarsWaypoint,
} from '../data/marsTerrain';
import { marsDistanceKm, slerpLatLng } from '../data/marsCartography';
import { EquipmentControlState, ActiveEnvironmentState, MarsBiomeId, SeasonalFrostMode } from '../types/telemetry';
import { MarsTerrainManager } from './marsTerrain';
import { MarsFarTerrain } from './marsFarTerrain';
import { MarsGlobalGlobe, GLOBE_RADIUS } from './marsGlobalGlobe';
import { vehicleSim, type LiveVehiclePose } from '../utils/vehicleController';
import { dualSense } from '../utils/dualsenseController';

export type MarsSpectralViewMode = 'optical' | 'thermal' | 'topographic';
export type CameraPreset = 'mastcam' | 'closeup' | 'overview' | 'orbit' | 'orbital';

export interface VisorLandformBeacon {
  id: string;
  name: string;
  category: LandformCategory;
  categoryLabel: string;
  colorHex: string;
  colorNum: number;
  x: number;
  z: number;
  distanceKm: number;
  bearingDeg: number;
  elevationMeters: number;
  scienceSummary: string;
}

export interface VisorWaypointBeacon {
  id: string;
  name: string;
  x: number;
  z: number;
  distanceKm: number;
  type: MarsWaypoint['type'];
  description: string;
}

interface BeaconTooltipInfo {
  id: string;
  name: string;
  categoryLabel: string;
  colorHex: string;
  distanceKm: number;
  bearingDeg?: number;
  summary: string;
  isLandform: boolean;
}

interface Mars3DViewportProps {
  astronautPos: { x: number; y: number; heading: number };
  liveVehicleRef?: React.MutableRefObject<LiveVehiclePose>;
  targetPos: { x: number; y: number };
  showGuidanceTrail?: boolean;
  customWaypoints?: Array<{ id: number; x: number; y: number; isNext: boolean }>;
  pitchOffset: number;
  rollOffset: number;
  spectralMode?: MarsSpectralViewMode;
  onSelectWaypoint?: (waypointId: string) => void;
  onSelectBeacon?: (id: string, options?: { autopilot?: boolean }) => void;
  visorLandforms?: VisorLandformBeacon[];
  visorWaypoints?: VisorWaypointBeacon[];
  targetTrailDirectionDeg?: number | null;
  activeTargetId?: string;
  enableAutopilotTravel?: boolean;
  onToggleAutopilotTravel?: (enabled: boolean) => void;
  equipment: EquipmentControlState;
  dustOpacityTau: number;
  windGustMps?: number;
  radiationDoseRateMicroSvHr?: number;
  solarParticleEventActive?: boolean;
  wheelSlipPercent?: number;
  vitals?: {
    batteryPercentage: number;
    ambientTempCelsius: number;
  };
  activeEnvironment?: ActiveEnvironmentState;
  discoveredFeatureIds?: string[];
  onCycleLandmark?: (direction: 'prev' | 'next') => void;
}

// Re-export elevation & waypoints for backwards compatibility
export { getMarsElevation };
export const WAYPOINT_ANCHORS = MARS_WAYPOINTS.map((w) => ({
  id: w.id,
  name: w.name,
  x: w.x,
  z: w.z,
}));

// Pre-allocated math helpers outside render loop (Zero GC per frame)
const _tempObj = new THREE.Object3D();
const _tangentDir = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _colorTmp = new THREE.Color();

// Terrain suspension & chasing camera scratch objects (Zero GC per frame)
const _upVec = new THREE.Vector3(0, 1, 0);
const _terrainNormal = new THREE.Vector3(0, 1, 0);
const _smoothedTerrainNormal = new THREE.Vector3(0, 1, 0);
const _centerHitNormal = new THREE.Vector3(0, 1, 0);
const _vFwd = new THREE.Vector3();
const _vRight = new THREE.Vector3();
const _computedNormal = new THREE.Vector3();
const _yawQuat = new THREE.Quaternion();
const _tiltQuat = new THREE.Quaternion();
const _camDesiredPos = new THREE.Vector3();
const _camDesiredLook = new THREE.Vector3();
const _skyHorizonTarget = new THREE.Color();
const _skyZenithTarget = new THREE.Color();
const _fogColorTarget = new THREE.Color();
const _spaceBackdropColor = new THREE.Color(0x02040a);
const _sunOffsetVec = new THREE.Vector3(260, 175, 190);
const _orbCamPos = new THREE.Vector3();
const _orbCamLook = new THREE.Vector3();
const _curGlobeLL = { lat: 18.44, lng: 77.45 };
const _transFromLL = { lat: 18.44, lng: 77.45 };
const _transToLL = { lat: 18.44, lng: 77.45 };

function smootherstep01(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * c * (c * (c * 6 - 15) + 10);
}

function rockHash(x: number, y: number, z: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.3) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Generates 4 distinct sculpted procedural Martian rock geometries
 * (0: angular basalt block, 1: stratified sedimentary slab, 2: wind-carved ventifact, 3: jagged regolith cobble).
 */
function createSculptedRockGeometry(variant: 0 | 1 | 2 | 3): THREE.BufferGeometry {
  let geom: THREE.BufferGeometry;
  if (variant === 0) {
    geom = new THREE.DodecahedronGeometry(1.0, 1);
  } else if (variant === 1) {
    geom = new THREE.CylinderGeometry(0.95, 1.25, 0.56, 7, 2);
  } else if (variant === 2) {
    geom = new THREE.OctahedronGeometry(1.05, 1);
  } else {
    geom = new THREE.IcosahedronGeometry(0.92, 1);
  }

  const pos = geom.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let vx = pos.getX(i);
    let vy = pos.getY(i);
    let vz = pos.getZ(i);

    const n1 = rockHash(Math.round(vx * 10), Math.round(vy * 10), Math.round(vz * 10), variant + 1);
    const n2 = rockHash(Math.round(vz * 14), Math.round(vx * 14), Math.round(vy * 14), variant + 17);
    const radialWarp = 0.78 + n1 * 0.42;

    if (variant === 0) {
      // Angular basalt block with sharp planar cleavage
      vx *= radialWarp * (vx > 0 ? 1.08 : 0.92);
      vz *= radialWarp * (vz > 0 ? 0.95 : 1.12);
      vy *= 0.78 + n2 * 0.36;
      if (vy < -0.35) vy *= 0.55; // broader embedded base
    } else if (variant === 1) {
      // Stratified flat sedimentary slab with stepped horizontal bedding ledges
      const ledge = vy > 0.05 ? 0.86 : 1.08;
      vx *= ledge * (0.85 + n1 * 0.32);
      vz *= ledge * (0.82 + n2 * 0.34);
      vy += (n1 - 0.5) * 0.08;
    } else if (variant === 2) {
      // Wind-carved elongated ventifact keel
      vx *= 1.32 * (0.82 + n1 * 0.35);
      vz *= 0.72 * (0.8 + n2 * 0.35);
      vy *= 0.68 + (vy > 0 ? n1 * 0.35 : 0.1);
    } else {
      // Jagged regolith cobble
      vx *= 0.8 + n1 * 0.45;
      vy *= 0.7 + n2 * 0.4;
      vz *= 0.8 + ((n1 + n2) * 0.5) * 0.42;
    }

    pos.setXYZ(i, vx, vy, vz);
  }

  pos.needsUpdate = true;
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  return geom;
}

function createProceduralRockBumpTexture(maxAnisotropy = 2): THREE.DataTexture {
  const size = 64;
  const bytes = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = rockHash(x, y, x ^ y, 91) * 0.65 + Math.sin(y * 0.55) * 0.18 + 0.17;
      const v = Math.max(0, Math.min(255, Math.round(n * 255)));
      const idx = (y * size + x) * 4;
      bytes[idx] = v;
      bytes[idx + 1] = v;
      bytes[idx + 2] = v;
      bytes[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = Math.min(2, Math.max(1, maxAnisotropy));
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export const Mars3DViewport: React.FC<Mars3DViewportProps> = React.memo(({
  astronautPos,
  liveVehicleRef,
  targetPos,
  showGuidanceTrail = false,
  customWaypoints = [],
  pitchOffset,
  rollOffset,
  spectralMode = 'optical',
  onSelectWaypoint,
  onSelectBeacon,
  visorLandforms = [],
  visorWaypoints,
  targetTrailDirectionDeg = null,
  activeTargetId,
  enableAutopilotTravel = false,
  onToggleAutopilotTravel,
  equipment,
  dustOpacityTau,
  windGustMps = 13.2,
  radiationDoseRateMicroSvHr = 28.4,
  solarParticleEventActive = false,
  wheelSlipPercent = 0,
  vitals,
  activeEnvironment,
  discoveredFeatureIds = [],
  onCycleLandmark,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const [activeCamPreset, setActiveCamPreset] = useState<CameraPreset>('closeup');
  const [hoveredBeacon, setHoveredBeacon] = useState<BeaconTooltipInfo | null>(null);
  const [selectedBeacon, setSelectedBeacon] = useState<BeaconTooltipInfo | null>(null);
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);

  const calcEtaMinutes = (distanceKm: number) =>
    estimateMarsTravelEtaMinutes(
      distanceKm * 1000,
      equipment.locomotionMode,
      equipment.speedTorqueSetting
    );

  const liveSelectedBeacon = React.useMemo<BeaconTooltipInfo | null>(() => {
    if (!selectedBeacon) return null;
    if (selectedBeacon.isLandform) {
      const match = visorLandforms.find((l) => l.id === selectedBeacon.id);
      if (match) {
        return {
          ...selectedBeacon,
          distanceKm: match.distanceKm,
          bearingDeg: match.bearingDeg,
        };
      }
    } else {
      const match = visorWaypoints?.find((w) => w.id === selectedBeacon.id);
      if (match) {
        const curX = liveVehicleRef?.current?.x ?? astronautPos.x;
        const curY = liveVehicleRef?.current?.y ?? astronautPos.y;
        const brg =
          (Math.round((Math.atan2(match.x - curX, match.z - curY) * 180) / Math.PI) + 360) %
          360;
        return {
          ...selectedBeacon,
          distanceKm: match.distanceKm,
          bearingDeg: brg,
        };
      }
    }
    return selectedBeacon;
  }, [selectedBeacon, visorLandforms, visorWaypoints, astronautPos.x, astronautPos.y, liveVehicleRef]);

  const onSelectWaypointRef = useRef(onSelectWaypoint);
  useEffect(() => {
    onSelectWaypointRef.current = onSelectWaypoint;
  }, [onSelectWaypoint]);

  const onSelectBeaconRef = useRef(onSelectBeacon);
  useEffect(() => {
    onSelectBeaconRef.current = onSelectBeacon;
  }, [onSelectBeacon]);

  const camOffsetRef = useRef({
    distance: 15,
    height: 6.2,
    pitch: -0.16,
  });
  const targetCamOffsetRef = useRef({
    distance: 15,
    height: 6.2,
    pitch: -0.16,
  });
  const camUserOrbitRef = useRef({
    yaw: 0,
    pitch: 0,
    recentering: false,
  });
  const orbitalZoomDistRef = useRef<number>(1650);

  const stateRef = useRef({
    astronautPos,
    targetPos,
    showGuidanceTrail,
    customWaypoints,
    visorLandforms,
    visorWaypoints,
    targetTrailDirectionDeg,
    activeTargetId,
    pitchOffset,
    rollOffset,
    spectralMode,
    activeCamPreset,
    equipment,
    dustOpacityTau,
    windGustMps,
    radiationDoseRateMicroSvHr,
    solarParticleEventActive,
    wheelSlipPercent,
    vitals,
    activeEnvironment,
    discoveredFeatureIds,
  });

  stateRef.current = {
    astronautPos,
    targetPos,
    showGuidanceTrail,
    customWaypoints,
    visorLandforms,
    visorWaypoints,
    targetTrailDirectionDeg,
    activeTargetId,
    pitchOffset,
    rollOffset,
    spectralMode,
    activeCamPreset,
    equipment,
    dustOpacityTau,
    windGustMps,
    radiationDoseRateMicroSvHr,
    solarParticleEventActive,
    wheelSlipPercent,
    vitals,
    activeEnvironment,
    discoveredFeatureIds,
  };

  const handleSelectCameraPreset = (preset: CameraPreset) => {
    playChirpSound();
    setActiveCamPreset(preset);
    camUserOrbitRef.current.recentering = true;

    if (preset === 'mastcam') {
      targetCamOffsetRef.current = { distance: 0.2, height: 2.3, pitch: 0.0 };
    } else if (preset === 'closeup') {
      targetCamOffsetRef.current = { distance: 15, height: 6.2, pitch: -0.16 };
    } else if (preset === 'overview') {
      // High-altitude VERVE-style huge crater sector overview
      targetCamOffsetRef.current = { distance: 110, height: 165, pitch: -0.95 };
    } else if (preset === 'orbit') {
      targetCamOffsetRef.current = { distance: 24, height: 11.5, pitch: -0.25 };
    } else if (preset === 'orbital') {
      orbitalZoomDistRef.current = 1650;
      camUserOrbitRef.current.yaw = 0;
      camUserOrbitRef.current.pitch = 0.12;
      camUserOrbitRef.current.recentering = false;
    }
  };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    // Software WebGL detection from GPU renderer string
    const isSoftwareGl = (() => {
      try {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return true;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
        const gpu = String(gl.getParameter(param));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
      } catch {
        return false;
      }
    })();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xc87d55);
    scene.fog = new THREE.FogExp2(0xc87d55, 0.00078);

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const camera = new THREE.PerspectiveCamera(68, width / height, 0.25, 250000);

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
      alpha: false,
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // Mandatory studio environment reflection for metals, ice & mineral lenses
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envTex = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    pmremGenerator.dispose();

    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    // --- CUSTOM MARTIAN ATMOSPHERIC SKY DOME GRADIENT (Blends with FogExp2) ---
    const skyUniforms = {
      uHorizonColor: { value: new THREE.Color(0xc87d55) },
      uZenithColor: { value: new THREE.Color(0xb86e5c) },
      uSunDir: { value: _sunOffsetVec.clone().normalize() },
      uSunGlowColor: { value: new THREE.Color(0xffe0bd) },
    };
    const skyDomeGeom = new THREE.SphereGeometry(4300, 32, 16);
    const skyDomeMat = new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `
        varying vec3 vWorldDir;
        void main() {
          vWorldDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uHorizonColor;
        uniform vec3 uZenithColor;
        uniform vec3 uSunDir;
        uniform vec3 uSunGlowColor;
        varying vec3 vWorldDir;
        void main() {
          float h = clamp(vWorldDir.y, 0.0, 1.0);
          float horizonMix = pow(1.0 - h, 2.2);
          vec3 skyCol = mix(uZenithColor, uHorizonColor, horizonMix);
          float sunDot = max(dot(normalize(vWorldDir), normalize(uSunDir)), 0.0);
          float mieHalo = pow(sunDot, 14.0) * 0.34 + pow(sunDot, 160.0) * 0.85;
          skyCol += uSunGlowColor * mieHalo * (0.35 + 0.65 * horizonMix);
          gl_FragColor = vec4(skyCol, 1.0);
        }
      `,
    });
    const skyDome = new THREE.Mesh(skyDomeGeom, skyDomeMat);
    skyDome.frustumCulled = false;
    scene.add(skyDome);

    // --- TRUE 3D DISPLACED PLANETARY MARS GLOBE (For Orbital Views & Long-Haul Transitions) ---
    const marsGlobe = new MarsGlobalGlobe();
    marsGlobe.setSpectralMode(stateRef.current.spectralMode);
    scene.add(marsGlobe.group);

    // --- CHUNKED THREE.LOD MARS TERRAIN PIPELINE ---
    const initBiomeId: MarsBiomeId = stateRef.current.activeEnvironment?.biomeId ?? 'JEZERO_CRATER';
    const initFrostMode: SeasonalFrostMode =
      stateRef.current.activeEnvironment?.seasonalCo2FrostMode ?? 'SUBLIMATION';
    const terrainSize = WORLD_HALF_EXTENT * 2; // 3600 meters!
    const terrainManager = new MarsTerrainManager({
      maxAnisotropy,
      initialSpectralMode: stateRef.current.spectralMode,
      initialBiomeId: initBiomeId,
      initialFrostMode: initFrostMode,
    });
    scene.add(terrainManager.group);
    // Real-MOLA horizon rings out to ~100 km so mountains/crater rims show where they are on the map
    const farTerrain = new MarsFarTerrain(skyUniforms.uSunDir);
    scene.add(farTerrain.group);

    // --- IDLE-DEFERRED NON-CRITICAL 3D ASSETS (ROCK SCATTER, GEOLOGY FEATURES, PARTICLES) ---
    let isDisposed = false;
    const pendingIdleTasks: Array<{ type: 'idle' | 'timeout'; id: number }> = [];
    const scheduleIdleTask = (fn: () => void, delayMs = 24) => {
      if (isDisposed) return;
      const win = window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      };
      if (typeof win.requestIdleCallback === 'function') {
        const id = win.requestIdleCallback(
          () => {
            if (!isDisposed) fn();
          },
          { timeout: Math.max(90, delayMs + 90) }
        );
        pendingIdleTasks.push({ type: 'idle', id });
      } else {
        const id = window.setTimeout(() => {
          if (!isDisposed) fn();
        }, delayMs);
        pendingIdleTasks.push({ type: 'timeout', id });
      }
    };

    const rockVariantCount = 4;
    const rocksPerVariant = 800; // 3,200 total rocks across the 3.6 km map
    const rockBumpTex = createProceduralRockBumpTexture(maxAnisotropy);
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      bumpMap: rockBumpTex,
      bumpScale: 0.14,
      roughness: 0.86,
      metalness: 0.1,
    });
    const rockGeometries: THREE.BufferGeometry[] = [];
    const rockMeshes: Array<THREE.InstancedMesh | null> = [null, null, null, null];
    const dummy = new THREE.Object3D();

    const populateRockVariant = (v: number, bId: MarsBiomeId, fMode: SeasonalFrostMode) => {
      const instMesh = rockMeshes[v];
      if (!instMesh) return;
      const isPolar = bId === 'PLANUM_BOREUM' || bId === 'PLANUM_AUSTRALE';
      const isBasaltDark = bId === 'OLYMPUS_MONS' || bId === 'THARSIS_BULGE' || bId === 'SYRTIS_MAJOR';
      const isGaleTan = bId === 'GALE_CRATER';
      const isSmoothHellas = bId === 'HELLAS_PLANITIA' || bId === 'NORTHERN_LOWLANDS';

      for (let localIdx = 0; localIdx < rocksPerVariant; localIdx++) {
        const i = v * rocksPerVariant + localIdx;
        const rx = (rockHash(i, 1, 7, 3) - 0.5) * (terrainSize - 140);
        const rz = (rockHash(i, 2, 13, 5) - 0.5) * (terrainSize - 140);
        const baseScale = 0.42 + Math.pow(rockHash(i, 3, 19, 11), 1.6) * 3.4;
        const rotX = (rockHash(i, 4, 23, 13) - 0.5) * 0.55;
        const rotY = rockHash(i, 5, 29, 17) * Math.PI * 2;
        const rotZ = (rockHash(i, 6, 31, 19) - 0.5) * 0.55;
        const j = rockHash(i, 7, 37, 23);

        const ry = sampleTerrainGridElevation(rx, rz, bId, fMode);
        const scale = isSmoothHellas && i % 3 !== 0 ? 0.01 : isPolar ? baseScale * 0.72 : baseScale;

        dummy.position.set(rx, ry - scale * 0.26, rz);
        dummy.rotation.set(rotX, rotY, rotZ);
        const sx = scale * (0.78 + j * 0.44);
        const sy = scale * (v === 1 ? 0.45 + j * 0.3 : 0.62 + j * 0.38);
        const sz = scale * (0.82 + (1 - j) * 0.38);
        dummy.scale.set(sx, sy, sz);
        dummy.updateMatrix();
        instMesh.setMatrixAt(localIdx, dummy.matrix);

        if (isPolar) {
          if (fMode === 'DEPOSITION' || j > 0.35) {
            _colorTmp.setRGB(0.84 + j * 0.14, 0.9 + j * 0.08, 0.96);
          } else {
            _colorTmp.setHSL(0.03, 0.32, 0.24 + j * 0.14);
          }
        } else if (isBasaltDark) {
          _colorTmp.setHSL(0.04, 0.16, 0.15 + j * 0.13);
        } else if (isGaleTan) {
          _colorTmp.setHSL(0.08, 0.32, 0.36 + j * 0.18);
        } else if (v === 0 || (v === 3 && j < 0.4)) {
          _colorTmp.setHSL(0.045, 0.22, 0.18 + j * 0.12);
        } else {
          _colorTmp.setHSL(0.048 + j * 0.025, 0.42, 0.28 + j * 0.18);
        }
        instMesh.setColorAt(localIdx, _colorTmp);
      }
      instMesh.instanceMatrix.needsUpdate = true;
      if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;
      instMesh.computeBoundingSphere();
    };

    const syncRocksForBiome = (bId: MarsBiomeId, fMode: SeasonalFrostMode) => {
      for (let v = 0; v < rockVariantCount; v++) {
        if (rockMeshes[v]) populateRockVariant(v, bId, fMode);
      }
    };

    // --- JEZERO GEOLOGICAL FORMATIONS (Deferred over idle frames; shared geometries) ---
    let geologyFeaturesGroup: THREE.Group | null = null;
    const featureRingById = new Map<string, THREE.Mesh>();
    const featurePickables: THREE.Object3D[] = [];
    const sharedPoiRingGeom = new THREE.RingGeometry(11.5, 13.0, 32);
    sharedPoiRingGeom.rotateX(-Math.PI / 2);

    const strataSlabMat = new THREE.MeshStandardMaterial({
      color: 0xb8704b,
      roughness: 0.88,
      metalness: 0.06,
      bumpMap: rockBumpTex,
      bumpScale: 0.22,
    });
    const strataDarkBandMat = new THREE.MeshStandardMaterial({
      color: 0x7c4530,
      roughness: 0.9,
      metalness: 0.08,
      bumpMap: rockBumpTex,
      bumpScale: 0.18,
    });
    const subsurfaceIceMat = new THREE.MeshPhysicalMaterial({
      color: 0xcbeeff,
      roughness: 0.15,
      metalness: 0.04,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      ior: 1.31,
      transmission: isSoftwareGl ? 0 : 0.62,
      transparent: true,
      opacity: isSoftwareGl ? 0.8 : 0.92,
      emissive: 0x0b3b54,
      emissiveIntensity: 0.2,
    });
    const vesicularBasaltMat = new THREE.MeshStandardMaterial({
      color: 0x2a2426,
      roughness: 0.84,
      metalness: 0.18,
      bumpMap: rockBumpTex,
      bumpScale: 0.26,
    });
    const olivineCarbonateMat = new THREE.MeshPhysicalMaterial({
      color: 0x6f8f42,
      roughness: 0.26,
      metalness: 0.48,
      iridescence: 0.95,
      iridescenceIOR: 1.46,
      clearcoat: 0.65,
      clearcoatRoughness: 0.18,
    });
    const silicaVeinMat = new THREE.MeshPhysicalMaterial({
      color: 0x3b9aa0,
      roughness: 0.22,
      metalness: 0.42,
      iridescence: 0.95,
      iridescenceIOR: 1.48,
      clearcoat: 0.72,
      clearcoatRoughness: 0.15,
    });

    const buildGeologyFeatures = () => {
      if (geologyFeaturesGroup || isDisposed) return;
      if (rockGeometries.length === 0) {
        rockGeometries.push(
          createSculptedRockGeometry(0),
          createSculptedRockGeometry(1),
          createSculptedRockGeometry(2),
          createSculptedRockGeometry(3)
        );
      }
      const group = new THREE.Group();
      const discSet = new Set(stateRef.current.discoveredFeatureIds);

      JEZERO_SCIENCE_FEATURES.forEach((feat, fIdx) => {
        const fGroup = new THREE.Group();
        const baseY = sampleTerrainGridElevation(feat.x, feat.z, 'JEZERO_CRATER', 'SUBLIMATION');
        fGroup.position.set(feat.x, baseY, feat.z);

        const meta = {
          beaconId: feat.id,
          name: feat.name,
          categoryLabel: feat.categoryLabel,
          colorHex: feat.colorHex,
          summary: `${feat.mineralSignature} — ${feat.summary}`,
          isLandform: false,
          x: feat.x,
          z: feat.z,
        };

        if (feat.category === 'DELTA_FORMATION') {
          for (let tier = 0; tier < 4; tier++) {
            const w = 16 - tier * 3.1;
            const h = 1.65 + (tier % 2) * 0.45;
            const d = 12 - tier * 2.2;
            const slab = new THREE.Mesh(
              rockGeometries[1],
              tier % 2 === 0 ? strataSlabMat : strataDarkBandMat
            );
            slab.scale.set(w * 0.55, h * 1.3, d * 0.55);
            slab.position.set(
              (tier - 1.5) * 1.4,
              tier * 1.85 - 0.35,
              (tier % 2 === 0 ? 0.8 : -0.6)
            );
            slab.rotation.y = fIdx * 0.7 + tier * 0.12;
            slab.castShadow = !isSoftwareGl;
            slab.receiveShadow = true;
            slab.userData = meta;
            fGroup.add(slab);
            featurePickables.push(slab);
          }
          for (let t = 0; t < 7; t++) {
            const ang = (t / 7) * Math.PI * 2 + fIdx;
            const dist = 8.5 + (t % 3) * 2.5;
            const talus = new THREE.Mesh(rockGeometries[t % 4], strataDarkBandMat);
            const s = 1.1 + (t % 3) * 0.65;
            talus.scale.set(s * 1.2, s * 0.8, s);
            talus.position.set(Math.cos(ang) * dist, -0.35, Math.sin(ang) * dist);
            talus.rotation.set(0.2 * t, ang, 0.15);
            talus.receiveShadow = true;
            fGroup.add(talus);
          }
        } else if (feat.category === 'SUBSURFACE_ICE') {
          for (let k = 0; k < 8; k++) {
            const ang = (k / 8) * Math.PI * 2 + fIdx * 0.5;
            const dist = k === 0 ? 0 : 2.2 + (k % 3) * 1.8;
            const shard = new THREE.Mesh(rockGeometries[k % 2 === 0 ? 2 : 3], subsurfaceIceMat);
            const s = k === 0 ? 2.6 : 1.1 + (k % 3) * 0.55;
            shard.scale.set(s * 0.85, s * 1.45, s * 0.78);
            shard.position.set(Math.cos(ang) * dist, s * 0.25 - 0.3, Math.sin(ang) * dist);
            shard.rotation.set((k % 2 - 0.5) * 0.35, ang, (k % 3 - 1) * 0.25);
            shard.castShadow = !isSoftwareGl;
            shard.receiveShadow = true;
            shard.userData = meta;
            fGroup.add(shard);
            if (k < 3) featurePickables.push(shard);
          }
          for (let c = 0; c < 6; c++) {
            const ang = (c / 6) * Math.PI * 2 + 0.3;
            const collar = new THREE.Mesh(rockGeometries[0], strataSlabMat);
            collar.scale.set(1.4, 0.75, 1.3);
            collar.position.set(Math.cos(ang) * 5.2, -0.38, Math.sin(ang) * 5.2);
            collar.rotation.y = ang;
            collar.receiveShadow = true;
            fGroup.add(collar);
          }
        } else {
          for (let b = 0; b < 5; b++) {
            const ang = (b / 5) * Math.PI * 2 + fIdx;
            const dist = b === 0 ? 0 : 3.2 + (b % 2) * 2.1;
            const basalt = new THREE.Mesh(rockGeometries[0], vesicularBasaltMat);
            const s = b === 0 ? 3.2 : 1.4 + (b % 3) * 0.6;
            basalt.scale.set(s * 0.95, s * 1.35, s * 0.9);
            basalt.position.set(Math.cos(ang) * dist, s * 0.2 - 0.35, Math.sin(ang) * dist);
            basalt.rotation.set(0.12 * b, ang, -0.1 * b);
            basalt.castShadow = !isSoftwareGl;
            basalt.receiveShadow = true;
            basalt.userData = meta;
            fGroup.add(basalt);
            if (b < 2) featurePickables.push(basalt);
          }
          const veinMat = feat.id === 'SCI-MIN-02' ? silicaVeinMat : olivineCarbonateMat;
          for (let m = 0; m < 6; m++) {
            const ang = (m / 6) * Math.PI * 2 + 0.25;
            const vein = new THREE.Mesh(rockGeometries[2], veinMat);
            const s = 0.95 + (m % 3) * 0.38;
            vein.scale.set(s * 0.7, s * 1.3, s * 0.65);
            vein.position.set(Math.cos(ang) * 2.5, s * 0.35, Math.sin(ang) * 2.5);
            vein.rotation.set(0.3, ang, 0.25);
            vein.userData = meta;
            fGroup.add(vein);
            if (m < 2) featurePickables.push(vein);
          }
        }

        const discRingMat = new THREE.MeshBasicMaterial({
          color: feat.colorNum,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: discSet.has(feat.id) ? 0.78 : 0.16,
        });
        const discRing = new THREE.Mesh(sharedPoiRingGeom, discRingMat);
        discRing.position.y = 0.35;
        fGroup.add(discRing);
        featureRingById.set(feat.id, discRing);

        group.add(fGroup);
      });
      geologyFeaturesGroup = group;
      scene.add(group);
    };

    // --- JEZERO PRESSURIZED HABITAT DOME AT HAB-01 (0, 0) ---
    const habitatGroup = new THREE.Group();
    const habY = getMarsElevation(0, 0);
    habitatGroup.position.set(0, habY, 0);

    const domeGeom = new THREE.SphereGeometry(11, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    const domeMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.35, metalness: 0.65 });
    const domeMesh = new THREE.Mesh(domeGeom, domeMat);
    habitatGroup.add(domeMesh);

    const airlockGeom = new THREE.BoxGeometry(5, 4, 8);
    const airlockMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.55, metalness: 0.7 });
    const airlock = new THREE.Mesh(airlockGeom, airlockMat);
    airlock.position.set(0, 2, 11);
    habitatGroup.add(airlock);

    const habRingGeom = new THREE.RingGeometry(13, 14.5, 32);
    habRingGeom.rotateX(-Math.PI / 2);
    const habRingMat = new THREE.MeshBasicMaterial({ color: 0x10b981, side: THREE.DoubleSide });
    const habRing = new THREE.Mesh(habRingGeom, habRingMat);
    habRing.position.y = 0.25;
    habitatGroup.add(habRing);

    scene.add(habitatGroup);

    // --- 3D NASA PROCEDURAL ROVER (Composite 10-part Group with Hinged Solar Wings & Headlight) ---
    const roverGroup = new THREE.Group();

    const chassisGeom = new THREE.BoxGeometry(2.5, 0.95, 3.3);
    const chassisMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.32, metalness: 0.68 });
    const chassis = new THREE.Mesh(chassisGeom, chassisMat);
    chassis.position.y = 1.1;
    chassis.castShadow = true;
    roverGroup.add(chassis);

    // Contact shadow grounding plane
    const shadowPlaneGeom = new THREE.CircleGeometry(2.6, 24);
    shadowPlaneGeom.rotateX(-Math.PI / 2);
    const shadowPlaneMat = new THREE.MeshBasicMaterial({
      color: 0x050304,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    const contactShadow = new THREE.Mesh(shadowPlaneGeom, shadowPlaneMat);
    contactShadow.position.y = 0.04;
    roverGroup.add(contactShadow);

    // Gold thermal foil deck
    const foilGeom = new THREE.PlaneGeometry(2.15, 2.95);
    foilGeom.rotateX(-Math.PI / 2);
    const foilMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.22, metalness: 0.88 });
    const foil = new THREE.Mesh(foilGeom, foilMat);
    foil.position.y = 1.59;
    roverGroup.add(foil);

    // Deployable Hinged Solar Wing Arrays (Left & Right)
    const wingGeom = new THREE.BoxGeometry(2.2, 0.06, 1.8);
    const wingMat = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.2, metalness: 0.85 });

    const leftWingPivot = new THREE.Group();
    leftWingPivot.position.set(-1.25, 1.48, -0.2);
    const leftWingMesh = new THREE.Mesh(wingGeom, wingMat);
    leftWingMesh.position.set(-1.1, 0, 0);
    leftWingPivot.add(leftWingMesh);
    roverGroup.add(leftWingPivot);

    const rightWingPivot = new THREE.Group();
    rightWingPivot.position.set(1.25, 1.48, -0.2);
    const rightWingMesh = new THREE.Mesh(wingGeom, wingMat);
    rightWingMesh.position.set(1.1, 0, 0);
    rightWingPivot.add(rightWingMesh);
    roverGroup.add(rightWingPivot);

    // Rocker-bogie struts & 6 wheels
    const strutMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5, metalness: 0.8 });
    const strutGeom = new THREE.CylinderGeometry(0.06, 0.06, 2.5);
    const leftStrut = new THREE.Mesh(strutGeom, strutMat);
    leftStrut.position.set(-1.35, 0.82, 0);
    leftStrut.rotateZ(0.3);
    roverGroup.add(leftStrut);

    const rightStrut = new THREE.Mesh(strutGeom, strutMat);
    rightStrut.position.set(1.35, 0.82, 0);
    rightStrut.rotateZ(-0.3);
    roverGroup.add(rightStrut);

    const wheelGeom = new THREE.CylinderGeometry(0.44, 0.44, 0.4, 16);
    wheelGeom.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.65, metalness: 0.78 });

    const wheelPositions = [
      [-1.45, 0.44, 1.35],
      [1.45, 0.44, 1.35],
      [-1.55, 0.44, 0],
      [1.55, 0.44, 0],
      [-1.45, 0.44, -1.35],
      [1.45, 0.44, -1.35],
    ];
    const wheelMeshes: THREE.Mesh[] = [];
    wheelPositions.forEach((pos) => {
      const wheel = new THREE.Mesh(wheelGeom, wheelMat);
      wheel.position.set(pos[0], pos[1], pos[2]);
      roverGroup.add(wheel);
      wheelMeshes.push(wheel);
    });

    // MastCam-Z Head & Headlight Spotlight
    const mastPoleGeom = new THREE.CylinderGeometry(0.06, 0.08, 1.85, 12);
    const mastPole = new THREE.Mesh(mastPoleGeom, strutMat);
    mastPole.position.set(0.6, 2.35, 1.05);
    roverGroup.add(mastPole);

    const mastHead = new THREE.Group();
    mastHead.position.set(0.6, 3.28, 1.05);
    const headBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.58, 0.34, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.3, metalness: 0.82 })
    );
    mastHead.add(headBox);

    const lensGeom = new THREE.CylinderGeometry(0.08, 0.08, 0.16, 12);
    lensGeom.rotateX(Math.PI / 2);
    const lensMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4 });
    const leftLens = new THREE.Mesh(lensGeom, lensMat);
    leftLens.position.set(-0.16, 0, 0.22);
    mastHead.add(leftLens);
    const rightLens = new THREE.Mesh(lensGeom, lensMat);
    rightLens.position.set(0.16, 0, 0.22);
    mastHead.add(rightLens);
    roverGroup.add(mastHead);

    // Volumetric Headlight Beam + SpotLight
    const headlightSpot = new THREE.SpotLight(0xe0f2fe, 0, 120, Math.PI / 5, 0.45, 1.4);
    headlightSpot.position.set(0, 1.65, 1.65);
    const headlightTarget = new THREE.Object3D();
    headlightTarget.position.set(0, 0, 35);
    roverGroup.add(headlightTarget);
    headlightSpot.target = headlightTarget;
    roverGroup.add(headlightSpot);

    const beamConeGeom = new THREE.ConeGeometry(8.5, 36, 20, 1, true);
    beamConeGeom.rotateX(-Math.PI / 2);
    const beamConeMat = new THREE.MeshBasicMaterial({
      color: 0xbae6fd,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const beamConeMesh = new THREE.Mesh(beamConeGeom, beamConeMat);
    beamConeMesh.position.set(0, 1.4, 19.6);
    beamConeMesh.visible = false;
    roverGroup.add(beamConeMesh);

    // Rear RTG & High-Gain Dish
    const rtg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.38, 0.38, 1.05, 12),
      new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.7, metalness: 0.6 })
    );
    rtg.position.set(0, 1.55, -1.65);
    rtg.rotateX(0.4);
    roverGroup.add(rtg);

    const dish = new THREE.Mesh(
      new THREE.SphereGeometry(0.44, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3),
      new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.2, metalness: 0.9, side: THREE.DoubleSide })
    );
    dish.position.set(-0.6, 1.82, -0.6);
    dish.rotateX(-0.5);
    roverGroup.add(dish);

    // Fault Warning Beacon + Electrical Arc Light (visible when rover takes damage / wind shear / CME fault)
    const faultBeaconMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
    const faultBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 10), faultBeaconMat);
    faultBeacon.position.set(-0.75, 1.72, 1.15);
    faultBeacon.visible = false;
    roverGroup.add(faultBeacon);

    const faultLight = new THREE.PointLight(0xff453a, 0, 18);
    faultLight.position.set(-0.75, 1.9, 1.15);
    roverGroup.add(faultLight);

    // Astronaut EVA Suit figure (visible when locomotionMode === 'eva_walk')
    const astronautGroup = new THREE.Group();
    const suitTorso = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.42, 0.9, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.45, metalness: 0.15 })
    );
    suitTorso.position.y = 1.15;
    astronautGroup.add(suitTorso);

    const plssPack = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.85, 0.38),
      new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.35, metalness: 0.65 })
    );
    plssPack.position.set(0, 1.25, -0.45);
    astronautGroup.add(plssPack);

    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.12, metalness: 0.88 })
    );
    helmet.position.set(0, 1.98, 0.05);
    astronautGroup.add(helmet);
    astronautGroup.visible = false;
    scene.add(astronautGroup);

    scene.add(roverGroup);

    // --- 8 INTERACTIVE 3D WAYPOINT TOWERS (Shared geometries, culled when > 300 km from astronaut) ---
    const waypointGroup = new THREE.Group();
    const waypointTowerById = new Map<string, THREE.Group>();
    const waypointMeshes: THREE.Object3D[] = [];
    const sharedWaypointPillarGeom = new THREE.CylinderGeometry(1.4, 2.2, 68, 12);
    const sharedWaypointDiamondGeom = new THREE.OctahedronGeometry(4.8, 0);
    const sharedWaypointRingGeom = new THREE.RingGeometry(10, 13, 32);
    sharedWaypointRingGeom.rotateX(-Math.PI / 2);

    MARS_WAYPOINTS.forEach((wp) => {
      const g = new THREE.Group();
      const el = getMarsElevation(wp.x, wp.z);
      g.position.set(wp.x, el, wp.z);

      const accentColor =
        wp.type === 'habitat'
          ? 0x10b981
          : wp.type === 'cache'
            ? 0x38bdf8
            : wp.id === 'WP-DELTA-04'
              ? 0xf59e0b
              : 0x06b6d4;
      const colorHex = WAYPOINT_TYPE_COLORS[wp.type].hex;

      const pillar = new THREE.Mesh(
        sharedWaypointPillarGeom,
        new THREE.MeshBasicMaterial({
          color: accentColor,
          transparent: true,
          opacity: 0.38,
          wireframe: true,
        })
      );
      pillar.position.y = 34;
      pillar.userData = {
        beaconId: wp.id,
        name: wp.name,
        categoryLabel: wp.type.toUpperCase(),
        colorHex,
        summary: wp.description,
        isLandform: false,
        x: wp.x,
        z: wp.z,
      };
      g.add(pillar);

      const diamond = new THREE.Mesh(
        sharedWaypointDiamondGeom,
        new THREE.MeshBasicMaterial({ color: accentColor })
      );
      diamond.position.y = 26;
      diamond.userData = {
        beaconId: wp.id,
        name: wp.name,
        categoryLabel: wp.type.toUpperCase(),
        colorHex,
        summary: wp.description,
        isLandform: false,
        x: wp.x,
        z: wp.z,
      };
      g.add(diamond);

      const ring = new THREE.Mesh(
        sharedWaypointRingGeom,
        new THREE.MeshBasicMaterial({
          color: accentColor,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.78,
        })
      );
      ring.position.y = 0.4;
      g.add(ring);

      waypointGroup.add(g);
      waypointTowerById.set(wp.id, g);
      waypointMeshes.push(diamond, pillar);
    });
    scene.add(waypointGroup);

    // --- COLOR-CODED 3D LANDFORM BEACONS (Shared geometries, <= 300 km from astronaut) ---
    const landformBeaconGroup = new THREE.Group();
    const landformBeaconMeshes: THREE.Object3D[] = [];
    const sharedLandformPillarGeom = new THREE.CylinderGeometry(2.0, 3.4, 115, 12);
    const sharedLandformCrystalGeom = new THREE.OctahedronGeometry(8.8, 0);
    const sharedLandformRingGeom = new THREE.RingGeometry(15, 20, 32);
    sharedLandformRingGeom.rotateX(-Math.PI / 2);

    const landformTowerById = new Map<
      string,
      {
        group: THREE.Group;
        pillar: THREE.Mesh;
        crystal: THREE.Mesh;
        ring: THREE.Mesh;
        bx: number;
        bz: number;
        colorNum: number;
        selected: boolean;
      }
    >();
    scene.add(landformBeaconGroup);

    const disposeGroupMaterialsOnly = (obj: THREE.Object3D) => {
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
          else child.material.dispose();
        }
      });
    };

    const syncLandformBeacons3D = (
      list: VisorLandformBeacon[],
      astroX: number,
      astroZ: number,
      selectedId?: string
    ) => {
      const inJezeroSector =
        Math.abs(astroX) <= WORLD_HALF_EXTENT && Math.abs(astroZ) <= WORLD_HALF_EXTENT;
      const maxTerrain = WORLD_HALF_EXTENT - 70;
      const activeIds = new Set<string>();

      for (let i = 0; i < list.length; i++) {
        const lf = list[i];
        activeIds.add(lf.id);

        const localDist = Math.hypot(lf.x - astroX, lf.z - astroZ);
        let bx = lf.x;
        let bz = lf.z;
        if (
          localDist > 1420 ||
          (inJezeroSector && (Math.abs(bx) > maxTerrain || Math.abs(bz) > maxTerrain))
        ) {
          const brgRad = (lf.bearingDeg * Math.PI) / 180;
          const radius = Math.min(1360, localDist);
          const rawBx = astroX + Math.sin(brgRad) * radius;
          const rawBz = astroZ + Math.cos(brgRad) * radius;
          bx = inJezeroSector ? Math.max(-maxTerrain, Math.min(maxTerrain, rawBx)) : rawBx;
          bz = inJezeroSector ? Math.max(-maxTerrain, Math.min(maxTerrain, rawBz)) : rawBz;
        }

        const isSelected = lf.id === selectedId;
        const existing = landformTowerById.get(lf.id);
        if (existing) {
          const udP = existing.pillar.userData;
          udP.distanceKm = lf.distanceKm;
          existing.crystal.userData.distanceKm = lf.distanceKm;

          if (Math.hypot(bx - existing.bx, bz - existing.bz) > 25) {
            existing.bx = bx;
            existing.bz = bz;
            existing.group.position.set(
              bx,
              getMarsElevation(
                bx,
                bz,
                stateRef.current.activeEnvironment?.biomeId ?? 'JEZERO_CRATER',
                stateRef.current.activeEnvironment?.seasonalCo2FrostMode ?? 'SUBLIMATION'
              ),
              bz
            );
          }
          if (existing.selected !== isSelected) {
            existing.selected = isSelected;
            (existing.pillar.material as THREE.MeshBasicMaterial).opacity = isSelected ? 0.65 : 0.42;
            existing.crystal.scale.setScalar(isSelected ? 1.3 : 1.0);
            (existing.ring.material as THREE.MeshBasicMaterial).color.setHex(
              isSelected ? 0xffffff : existing.colorNum
            );
          }
          continue;
        }

        const el = getMarsElevation(
          bx,
          bz,
          stateRef.current.activeEnvironment?.biomeId ?? 'JEZERO_CRATER',
          stateRef.current.activeEnvironment?.seasonalCo2FrostMode ?? 'SUBLIMATION'
        );
        const g = new THREE.Group();
        g.position.set(bx, el, bz);

        const userMeta = {
          beaconId: lf.id,
          name: lf.name,
          categoryLabel: lf.categoryLabel,
          colorHex: lf.colorHex,
          distanceKm: lf.distanceKm,
          summary: lf.scienceSummary,
          isLandform: true,
        };

        const pillar = new THREE.Mesh(
          sharedLandformPillarGeom,
          new THREE.MeshBasicMaterial({
            color: lf.colorNum,
            transparent: true,
            opacity: isSelected ? 0.65 : 0.42,
            wireframe: true,
          })
        );
        pillar.position.y = 57.5;
        pillar.userData = userMeta;
        g.add(pillar);

        const crystal = new THREE.Mesh(
          sharedLandformCrystalGeom,
          new THREE.MeshBasicMaterial({ color: lf.colorNum })
        );
        crystal.position.y = 48;
        crystal.scale.setScalar(isSelected ? 1.3 : 1.0);
        crystal.userData = userMeta;
        g.add(crystal);

        const ring = new THREE.Mesh(
          sharedLandformRingGeom,
          new THREE.MeshBasicMaterial({
            color: isSelected ? 0xffffff : lf.colorNum,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.86,
          })
        );
        ring.position.y = 0.6;
        g.add(ring);

        landformBeaconGroup.add(g);
        landformTowerById.set(lf.id, {
          group: g,
          pillar,
          crystal,
          ring,
          bx,
          bz,
          colorNum: lf.colorNum,
          selected: isSelected,
        });
      }

      let removedAny = false;
      landformTowerById.forEach((entry, id) => {
        if (!activeIds.has(id)) {
          landformBeaconGroup.remove(entry.group);
          disposeGroupMaterialsOnly(entry.group);
          landformTowerById.delete(id);
          removedAny = true;
        }
      });

      if (removedAny || landformBeaconMeshes.length !== landformTowerById.size * 2) {
        landformBeaconMeshes.length = 0;
        landformTowerById.forEach((entry) => {
          landformBeaconMeshes.push(entry.crystal, entry.pillar);
        });
      }
    };

    // --- RADIATION HOTSPOTS & STEEP DROP AR MARKERS (Shared unit dome geometry) ---
    const hotspotGroup = new THREE.Group();
    const sharedHotspotDomeGeom = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    const sharedHotspotDomeMat = new THREE.MeshBasicMaterial({
      color: 0xe11d48,
      transparent: true,
      opacity: 0.14,
      wireframe: true,
    });
    const sharedHotspotRingMat = new THREE.MeshBasicMaterial({
      color: 0xf43f5e,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.7,
    });
    RADIATION_HOTSPOTS.forEach((hs) => {
      const el = getMarsElevation(hs.x, hs.z);
      const hsRingGeom = new THREE.RingGeometry(hs.radius - 3, hs.radius, 48);
      hsRingGeom.rotateX(-Math.PI / 2);
      const hsRing = new THREE.Mesh(hsRingGeom, sharedHotspotRingMat);
      hsRing.position.set(hs.x, el + 1.5, hs.z);
      hotspotGroup.add(hsRing);

      const domeWarning = new THREE.Mesh(sharedHotspotDomeGeom, sharedHotspotDomeMat);
      domeWarning.scale.setScalar(hs.radius);
      domeWarning.position.set(hs.x, el, hs.z);
      hotspotGroup.add(domeWarning);
    });
    scene.add(hotspotGroup);

    // --- DEFERRED DUST & SPE PARTICLE BUFFERS ---
    let dustGeom: THREE.BufferGeometry | null = null;
    let dustMat: THREE.PointsMaterial | null = null;
    let dustPoints: THREE.Points | null = null;
    let speGeom: THREE.BufferGeometry | null = null;
    let speMat: THREE.PointsMaterial | null = null;
    let spePoints: THREE.Points | null = null;

    const buildAtmosphericParticles = () => {
      if (dustPoints || isDisposed) return;
      const dustCount = 900;
      const dustPositions = new Float32Array(dustCount * 3);
      for (let i = 0; i < dustCount; i++) {
        dustPositions[i * 3] = (Math.random() - 0.5) * 400;
        dustPositions[i * 3 + 1] = Math.random() * 45;
        dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 400;
      }
      dustGeom = new THREE.BufferGeometry();
      dustGeom.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
      dustMat = new THREE.PointsMaterial({
        color: 0xe8a87c,
        size: 0.9,
        transparent: true,
        opacity: 0.35,
      });
      dustPoints = new THREE.Points(dustGeom, dustMat);
      scene.add(dustPoints);

      const speCount = 650;
      const spePositions = new Float32Array(speCount * 3);
      for (let i = 0; i < speCount; i++) {
        spePositions[i * 3] = (Math.random() - 0.5) * 180;
        spePositions[i * 3 + 1] = Math.random() * 42;
        spePositions[i * 3 + 2] = (Math.random() - 0.5) * 180;
      }
      speGeom = new THREE.BufferGeometry();
      speGeom.setAttribute('position', new THREE.BufferAttribute(spePositions, 3));
      speMat = new THREE.PointsMaterial({
        color: 0xffb347,
        size: 0.55,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      spePoints = new THREE.Points(speGeom, speMat);
      scene.add(spePoints);
    };

    // --- HOLOGRAPHIC BLUE GUIDANCE TRAIL (#52e0ff) & 3D CUSTOM WAYPOINTS (Shared geometries) ---
    let safePathMesh: THREE.Mesh | null = null;
    let safePathPointsMesh: THREE.InstancedMesh | null = null;
    const customWpGroup = new THREE.Group();
    const sharedCustomPillarGeom = new THREE.CylinderGeometry(0.8, 1.3, 46, 10);
    const sharedCustomHeadGeom = new THREE.OctahedronGeometry(3.0, 0);
    const sharedCustomRingGeom = new THREE.RingGeometry(6.5, 8.5, 24);
    sharedCustomRingGeom.rotateX(-Math.PI / 2);
    scene.add(customWpGroup);

    const syncCustomWaypoints3D = (
      list: Array<{ id: number; x: number; y: number; isNext: boolean }>,
      astroX = 0,
      astroZ = 0
    ) => {
      while (customWpGroup.children.length > 0) {
        const child = customWpGroup.children.pop()!;
        disposeGroupMaterialsOnly(child);
      }
      list.forEach((wp) => {
        if (Math.hypot(wp.x - astroX, wp.y - astroZ) / 1000 > VISOR_PROXIMITY_THRESHOLD_KM) return;
        const g = new THREE.Group();
        const el = getMarsElevation(
          wp.x,
          wp.y,
          stateRef.current.activeEnvironment?.biomeId ?? 'JEZERO_CRATER',
          stateRef.current.activeEnvironment?.seasonalCo2FrostMode ?? 'SUBLIMATION'
        );
        g.position.set(wp.x, el, wp.y);
        const colorHex = wp.isNext ? 0x52e0ff : 0xf59e0b;

        const beaconPillar = new THREE.Mesh(
          sharedCustomPillarGeom,
          new THREE.MeshBasicMaterial({
            color: colorHex,
            transparent: true,
            opacity: wp.isNext ? 0.55 : 0.3,
            wireframe: true,
          })
        );
        beaconPillar.position.y = 23;
        g.add(beaconPillar);

        const beaconHead = new THREE.Mesh(
          sharedCustomHeadGeom,
          new THREE.MeshBasicMaterial({ color: colorHex })
        );
        beaconHead.scale.setScalar(wp.isNext ? 1.4 : 1.0);
        beaconHead.position.y = 22;
        g.add(beaconHead);

        const ringM = new THREE.Mesh(
          sharedCustomRingGeom,
          new THREE.MeshBasicMaterial({
            color: colorHex,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: wp.isNext ? 0.85 : 0.5,
          })
        );
        ringM.position.y = 0.45;
        g.add(ringM);

        customWpGroup.add(g);
      });
    };

    const clearSafePath = () => {
      if (safePathMesh) {
        scene.remove(safePathMesh);
        safePathMesh.geometry.dispose();
        (safePathMesh.material as THREE.Material).dispose();
        safePathMesh = null;
      }
      if (safePathPointsMesh) {
        scene.remove(safePathPointsMesh);
        safePathPointsMesh.geometry.dispose();
        (safePathPointsMesh.material as THREE.Material).dispose();
        safePathPointsMesh = null;
      }
    };

    const createSafePath = (
      startX: number,
      startZ: number,
      tgtX: number,
      tgtZ: number,
      dirDeg?: number | null
    ) => {
      clearSafePath();

      const rawDx = tgtX - startX;
      const rawDz = tgtZ - startZ;
      const rawDist = Math.hypot(rawDx, rawDz);
      if (rawDist < 0.5 && dirDeg == null) return;

      const inJezeroSector =
        Math.abs(startX) <= WORLD_HALF_EXTENT && Math.abs(startZ) <= WORLD_HALF_EXTENT;
      let endX = tgtX;
      let endZ = tgtZ;
      const maxTerrain = WORLD_HALF_EXTENT - 70;
      if (
        rawDist > 1550 ||
        (inJezeroSector && (Math.abs(endX) > maxTerrain || Math.abs(endZ) > maxTerrain))
      ) {
        const rad =
          dirDeg !== null && dirDeg !== undefined
            ? (dirDeg * Math.PI) / 180
            : Math.atan2(rawDx, rawDz);
        const span = Math.min(1480, Math.max(400, rawDist));
        const rawEndX = startX + Math.sin(rad) * span;
        const rawEndZ = startZ + Math.cos(rad) * span;
        endX = inJezeroSector ? Math.max(-maxTerrain, Math.min(maxTerrain, rawEndX)) : rawEndX;
        endZ = inJezeroSector ? Math.max(-maxTerrain, Math.min(maxTerrain, rawEndZ)) : rawEndZ;
      }

      const totalDist = Math.hypot(endX - startX, endZ - startZ);
      if (totalDist < 0.5) return;

      const pts: THREE.Vector3[] = [];
      const numSteps = 32;

      const anchor1 = new THREE.Vector2(startX, startZ);
      const anchor2 = new THREE.Vector2((startX + endX) * 0.5, (startZ + endZ) * 0.5);
      const anchor3 = new THREE.Vector2(endX, endZ);

      for (let i = 0; i <= numSteps; i++) {
        const t = i / numSteps;
        const px = (1 - t) * (1 - t) * anchor1.x + 2 * (1 - t) * t * anchor2.x + t * t * anchor3.x;
        const pz = (1 - t) * (1 - t) * anchor1.y + 2 * (1 - t) * t * anchor2.y + t * t * anchor3.y;
        const py =
          getMarsElevation(
            px,
            pz,
            stateRef.current.activeEnvironment?.biomeId ?? 'JEZERO_CRATER',
            stateRef.current.activeEnvironment?.seasonalCo2FrostMode ?? 'SUBLIMATION'
          ) + 0.65;
        pts.push(new THREE.Vector3(px, py, pz));
      }

      const curve = new THREE.CatmullRomCurve3(pts);
      const tubeGeom = new THREE.TubeGeometry(curve, 48, 0.75, 6, false);
      const tubeMat = new THREE.MeshBasicMaterial({
        color: 0x52e0ff,
        transparent: true,
        opacity: 0.9,
      });

      safePathMesh = new THREE.Mesh(tubeGeom, tubeMat);
      scene.add(safePathMesh);

      const beaconCount = Math.max(4, Math.min(24, Math.round(totalDist / 18)));
      const beaconGeom = new THREE.ConeGeometry(0.95, 2.2, 6);
      beaconGeom.rotateX(Math.PI / 2);
      const beaconMat = new THREE.MeshBasicMaterial({ color: 0x52e0ff });
      safePathPointsMesh = new THREE.InstancedMesh(beaconGeom, beaconMat, beaconCount);

      for (let j = 0; j < beaconCount; j++) {
        const u = (j + 0.5) / beaconCount;
        const pt = curve.getPointAt(u);
        curve.getTangentAt(u, _tangentDir);

        _tempObj.position.copy(pt);
        _tempObj.position.y += 0.6;
        _tempObj.quaternion.setFromUnitVectors(_zAxis, _tangentDir);
        _tempObj.scale.setScalar(1.0);
        _tempObj.updateMatrix();
        safePathPointsMesh.setMatrixAt(j, _tempObj.matrix);
      }
      safePathPointsMesh.instanceMatrix.needsUpdate = true;
      safePathPointsMesh.computeBoundingSphere();
      scene.add(safePathPointsMesh);
    };

    const initClamp = (val: number) =>
      Math.abs(val) > 15_000 ? ((val % 6_000) + 6_000) % 6_000 - 3_000 : val;
    const initPos = stateRef.current.astronautPos;
    const initX = initClamp(initPos.x);
    const initZ = initClamp(initPos.y);
    const initIsWarp = Math.abs(initPos.x) > 15_000 || Math.abs(initPos.y) > 15_000;

    if (stateRef.current.showGuidanceTrail) {
      createSafePath(
        initX,
        initZ,
        initIsWarp ? initX : stateRef.current.targetPos.x,
        initIsWarp ? initZ : stateRef.current.targetPos.y,
        stateRef.current.targetTrailDirectionDeg
      );
    }
    syncCustomWaypoints3D(stateRef.current.customWaypoints, initX, initZ);
    syncLandformBeacons3D(
      stateRef.current.visorLandforms,
      initX,
      initZ,
      stateRef.current.activeTargetId
    );

    // --- LIGHTING RIG (Low-angle Martian Sun + Tight Rover-Tracking Shadow Frustum) ---
    const sunLight = new THREE.DirectionalLight(0xffdfb8, 2.45);
    sunLight.position.copy(_sunOffsetVec);
    sunLight.castShadow = !isSoftwareGl;
    sunLight.shadow.mapSize.width = 1024;
    sunLight.shadow.mapSize.height = 1024;
    sunLight.shadow.camera.left = -52;
    sunLight.shadow.camera.right = 52;
    sunLight.shadow.camera.top = 52;
    sunLight.shadow.camera.bottom = -52;
    sunLight.shadow.camera.near = 40;
    sunLight.shadow.camera.far = 620;
    sunLight.shadow.bias = -0.0004;
    sunLight.shadow.normalBias = 0.03;
    scene.add(sunLight);
    scene.add(sunLight.target);

    const hemiLight = new THREE.HemisphereLight(0xd98a64, 0x3f2018, 1.12);
    scene.add(hemiLight);

    // Position camera & hydrate initial chunked LOD terrain before shader pre-warm
    const initGroundY = sampleTerrainGridElevation(initX, initZ, initBiomeId, initFrostMode);
    const initHeadingRad = (initPos.heading * Math.PI) / 180;
    camera.position.set(
      initX - Math.sin(initHeadingRad) * camOffsetRef.current.distance,
      initGroundY + camOffsetRef.current.height,
      initZ - Math.cos(initHeadingRad) * camOffsetRef.current.distance
    );
    camera.lookAt(
      initX + Math.sin(initHeadingRad) * 6,
      initGroundY + 1.6,
      initZ + Math.cos(initHeadingRad) * 6
    );
    terrainManager.update(camera, true);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // --- RAYCASTING ---
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let lastHoverCheck = 0;

    const extractBeaconInfo = (obj: THREE.Object3D): BeaconTooltipInfo | null => {
      const ud = obj.userData as {
        beaconId?: string;
        name?: string;
        categoryLabel?: string;
        colorHex?: string;
        distanceKm?: number;
        summary?: string;
        isLandform?: boolean;
        x?: number;
        z?: number;
      };
      if (!ud?.beaconId) return null;
      const livePose = liveVehicleRef?.current;
      const curX = livePose ? livePose.x : stateRef.current.astronautPos.x;
      const curY = livePose ? livePose.y : stateRef.current.astronautPos.y;
      const distKm =
        ud.distanceKm !== undefined
          ? ud.distanceKm
          : Math.hypot((ud.x ?? 0) - curX, (ud.z ?? 0) - curY) / 1000;
      return {
        id: ud.beaconId,
        name: ud.name || ud.beaconId,
        categoryLabel: ud.categoryLabel || 'WAYPOINT',
        colorHex: ud.colorHex || '#52e0ff',
        distanceKm: distKm,
        summary: ud.summary || '',
        isLandform: Boolean(ud.isLandform),
      };
    };

    const getVisibleRaycastTargets = () => {
      const targets: THREE.Object3D[] = [];
      for (const m of waypointMeshes) {
        if (m.parent?.visible !== false) targets.push(m);
      }
      for (const m of landformBeaconMeshes) {
        targets.push(m);
      }
      if (geologyFeaturesGroup && geologyFeaturesGroup.visible) {
        for (const m of featurePickables) {
          targets.push(m);
        }
      }
      return targets;
    };

    let pointerDownPt = { x: 0, y: 0 };
    let lastDragPt = { x: 0, y: 0 };
    let isPointerDown = false;
    const handlePointerDown = (e: PointerEvent) => {
      pointerDownPt = { x: e.clientX, y: e.clientY };
      lastDragPt = { x: e.clientX, y: e.clientY };
      isPointerDown = true;
    };
    const handlePointerUp = () => {
      isPointerDown = false;
    };
    const handleWheel = (e: WheelEvent) => {
      if (stateRef.current.activeCamPreset === 'orbital') {
        e.preventDefault();
        orbitalZoomDistRef.current = THREE.MathUtils.clamp(
          orbitalZoomDistRef.current + e.deltaY * 1.15,
          1260,
          3400
        );
      } else if (stateRef.current.activeCamPreset !== 'mastcam') {
        const tgt = targetCamOffsetRef.current;
        tgt.distance = THREE.MathUtils.clamp(tgt.distance + e.deltaY * 0.04, 8, 180);
        tgt.height = THREE.MathUtils.clamp(tgt.height + e.deltaY * 0.03, 3.5, 220);
      }
    };

    const handleCanvasClick = (e: MouseEvent) => {
      if (Math.hypot(e.clientX - pointerDownPt.x, e.clientY - pointerDownPt.y) > 6) return;
      const rect = container.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(getVisibleRaycastTargets());
      if (intersects.length > 0) {
        const info = extractBeaconInfo(intersects[0].object);
        if (info) {
          playAckTone();
          setSelectedBeacon(info);
          if (onSelectBeaconRef.current) {
            onSelectBeaconRef.current(info.id);
          } else if (!info.isLandform && onSelectWaypointRef.current) {
            onSelectWaypointRef.current(info.id);
          }
        }
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (isPointerDown) {
        const dx = e.clientX - lastDragPt.x;
        const dy = e.clientY - lastDragPt.y;
        lastDragPt = { x: e.clientX, y: e.clientY };
        if (Math.hypot(e.clientX - pointerDownPt.x, e.clientY - pointerDownPt.y) > 5) {
          const uOrbit = camUserOrbitRef.current;
          uOrbit.recentering = false;
          uOrbit.yaw -= dx * 0.0055;
          if (uOrbit.yaw > Math.PI) uOrbit.yaw -= Math.PI * 2;
          if (uOrbit.yaw < -Math.PI) uOrbit.yaw += Math.PI * 2;
          uOrbit.pitch = THREE.MathUtils.clamp(uOrbit.pitch + dy * 0.0045, -0.55, 0.85);
          return;
        }
      }

      const now = performance.now();
      if (now - lastHoverCheck < 65) return;
      lastHoverCheck = now;

      const rect = container.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(getVisibleRaycastTargets());
      if (intersects.length > 0) {
        const info = extractBeaconInfo(intersects[0].object);
        setHoveredBeacon(info);
        container.style.cursor = info ? 'pointer' : 'default';
      } else {
        setHoveredBeacon(null);
        container.style.cursor = 'default';
      }
    };

    container.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('pointerup', handlePointerUp);
    container.addEventListener('click', handleCanvasClick);
    container.addEventListener('pointermove', handlePointerMove);
    container.addEventListener('wheel', handleWheel, { passive: false });

    const onResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 1.5));
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    // --- SINGLE-LOOP REGISTERED FRAME RENDERER (Physics -> Mesh -> Camera -> WebGL) ---
    let elapsed = 0;
    let lastPathState = {
      ax: stateRef.current.astronautPos.x,
      az: stateRef.current.astronautPos.y,
      tx: stateRef.current.targetPos.x,
      tz: stateRef.current.targetPos.y,
      visible: stateRef.current.showGuidanceTrail,
      dirDeg: stateRef.current.targetTrailDirectionDeg,
    };
    let lastCustomWpSignature = '';
    let lastLandformRef = stateRef.current.visorLandforms;
    let lastSelectedTargetId = stateRef.current.activeTargetId;
    let lastVisorWaypointsRef: VisorWaypointBeacon[] | undefined = undefined;
    let lastBeaconAstroPos = {
      x: stateRef.current.astronautPos.x,
      z: stateRef.current.astronautPos.y,
    };
    const smoothPos = {
      x: initX,
      z: initZ,
      heading: stateRef.current.astronautPos.heading,
    };
    const initialPoseSnapshot = liveVehicleRef?.current ?? vehicleSim.poseRef.current;
    let smoothGroundY = sampleTerrainGridElevation(initX, initZ, initBiomeId, initFrostMode);
    let smoothedSpeedLag = 0;
    let lastTeleportEpoch = initialPoseSnapshot.teleportEpoch ?? 0;
    let prevPoseLat = initialPoseSnapshot.lat ?? 18.44;
    let prevPoseLng = initialPoseSnapshot.lng ?? 77.45;
    let camInitialized = false;
    const camSmoothedPos = new THREE.Vector3();
    const camSmoothedLook = new THREE.Vector3();
    let currentMode = stateRef.current.spectralMode;
    let currentBiomeId: MarsBiomeId = initBiomeId;
    let currentFrostMode: SeasonalFrostMode = initFrostMode;
    let currentTerrainFrameId = getTerrainFrameId();
    let lastCamPreset: CameraPreset = stateRef.current.activeCamPreset;
    let orbitalPresetBlend = lastCamPreset === 'orbital' ? 1 : 0;
    let wingAngle = 0;
    let lastDiscoveredCount = -1;
    let smoothedPitchOffset = stateRef.current.pitchOffset;
    let lastRecenterEpoch = dualSense.cameraRecenterEpoch;

    const camTransition = {
      active: false,
      kind: 'preset' as 'preset' | 'local_hop' | 'orbital_arc',
      startElapsed: 0,
      duration: 1.8,
      fromLat: prevPoseLat,
      fromLng: prevPoseLng,
      toLat: prevPoseLat,
      toLng: prevPoseLng,
      fromX: initX,
      fromZ: initZ,
      toX: initX,
      toZ: initZ,
      fromPos: new THREE.Vector3(),
      fromLook: new THREE.Vector3(),
      peakAltitude: 1350,
      biomeSwitched: true,
    };

    const renderFrame = (rawDt: number, _nowMs: number, incomingPose?: LiveVehiclePose) => {
      if (isDisposed) return;
      const delta = Math.min(Math.max(rawDt, 1 / 240), 0.05);
      elapsed += delta;

      const {
        astronautPos: pos,
        targetPos: tgt,
        showGuidanceTrail: showTrail,
        customWaypoints: customWps,
        visorLandforms: vLandforms,
        visorWaypoints: vWaypoints,
        targetTrailDirectionDeg: trailDirDeg,
        activeTargetId: selTargetId,
        pitchOffset: pOff,
        spectralMode: sMode,
        activeCamPreset: camPreset,
        equipment: eq,
        dustOpacityTau: tau,
        windGustMps: gust,
        radiationDoseRateMicroSvHr: radRate,
        solarParticleEventActive: speActive,
        wheelSlipPercent: slipPct,
        vitals: curVitals,
        activeEnvironment: activeEnv,
        discoveredFeatureIds: discIds,
      } = stateRef.current;

      if (discIds.length !== lastDiscoveredCount) {
        lastDiscoveredCount = discIds.length;
        const discSet = new Set(discIds);
        featureRingById.forEach((ring, id) => {
          const mat = ring.material as THREE.MeshBasicMaterial;
          mat.opacity = discSet.has(id) ? 0.78 : 0.16;
        });
      }

      const activeBiome: MarsBiomeId = activeEnv?.biomeId ?? 'JEZERO_CRATER';
      const activeFrost: SeasonalFrostMode = activeEnv?.seasonalCo2FrostMode ?? 'SUBLIMATION';

      const isHighSpe = speActive || radRate > 30;
      const isExtremeSpe = radRate >= 100;
      const isWindShear = eq.solarPanelsDeployed && (gust > 13.5 || tau > 0.75);
      const isRoverDamaged = eq.suitRoverIntegrityPercent < 75 || isWindShear || radRate > 80;

      // Read single-source-of-truth pose from vehicleSim (updated immediately prior in this exact rAF tick)
      const livePose = incomingPose ?? liveVehicleRef?.current ?? vehicleSim.poseRef.current;
      const targetAstroX = livePose.x;
      const targetAstroY = livePose.y;
      const targetHeading = livePose.heading;

      // Detect teleport / scenario / landmark transitions & trigger damped 1.5-3.0s transitions
      if (livePose.teleportEpoch !== lastTeleportEpoch) {
        lastTeleportEpoch = livePose.teleportEpoch;
        const fromLat = livePose.lastTeleportFromLat ?? prevPoseLat;
        const fromLng = livePose.lastTeleportFromLng ?? prevPoseLng;
        const toLat = livePose.lat;
        const toLng = livePose.lng;
        _transFromLL.lat = fromLat;
        _transFromLL.lng = fromLng;
        _transToLL.lat = toLat;
        _transToLL.lng = toLng;
        const jumpDistKm = marsDistanceKm(_transFromLL, _transToLL);
        const localDeltaM = Math.hypot(initClamp(targetAstroX) - smoothPos.x, initClamp(targetAstroY) - smoothPos.z);

        if (jumpDistKm >= 25) {
          camTransition.active = true;
          camTransition.kind = 'orbital_arc';
          camTransition.startElapsed = elapsed;
          camTransition.duration = Math.min(3.0, Math.max(1.85, 1.85 + jumpDistKm / 2600));
          camTransition.fromLat = fromLat;
          camTransition.fromLng = fromLng;
          camTransition.toLat = toLat;
          camTransition.toLng = toLng;
          camTransition.fromX = smoothPos.x;
          camTransition.fromZ = smoothPos.z;
          camTransition.toX = initClamp(targetAstroX);
          camTransition.toZ = initClamp(targetAstroY);
          camTransition.fromPos.copy(camInitialized ? camSmoothedPos : camera.position);
          camTransition.fromLook.copy(camInitialized ? camSmoothedLook : camera.position);
          camTransition.peakAltitude = Math.min(2200, Math.max(1020, 880 + jumpDistKm * 0.22));
          camTransition.biomeSwitched = false;
        } else if (jumpDistKm > 0.02 || localDeltaM > 15) {
          camTransition.active = true;
          camTransition.kind = 'local_hop';
          camTransition.startElapsed = elapsed;
          camTransition.duration = Math.min(2.1, Math.max(1.5, 1.5 + jumpDistKm * 0.04));
          camTransition.fromLat = fromLat;
          camTransition.fromLng = fromLng;
          camTransition.toLat = toLat;
          camTransition.toLng = toLng;
          camTransition.fromX = smoothPos.x;
          camTransition.fromZ = smoothPos.z;
          camTransition.toX = initClamp(targetAstroX);
          camTransition.toZ = initClamp(targetAstroY);
          camTransition.fromPos.copy(camInitialized ? camSmoothedPos : camera.position);
          camTransition.fromLook.copy(camInitialized ? camSmoothedLook : camera.position);
          camTransition.peakAltitude = Math.min(240, Math.max(42, localDeltaM * 0.16));
          camTransition.biomeSwitched = false;
        }
      }

      if (camPreset !== lastCamPreset) {
        const involvesOrbital = camPreset === 'orbital' || lastCamPreset === 'orbital';
        lastCamPreset = camPreset;
        if (!camTransition.active || camTransition.kind === 'preset') {
          camTransition.active = true;
          camTransition.kind = 'preset';
          camTransition.startElapsed = elapsed;
          camTransition.duration = involvesOrbital ? 1.95 : 1.55;
          camTransition.fromLat = livePose.lat;
          camTransition.fromLng = livePose.lng;
          camTransition.toLat = livePose.lat;
          camTransition.toLng = livePose.lng;
          camTransition.fromPos.copy(camInitialized ? camSmoothedPos : camera.position);
          camTransition.fromLook.copy(camInitialized ? camSmoothedLook : camera.position);
          camTransition.biomeSwitched = true;
        }
      }

      const rawTransU = camTransition.active
        ? Math.min(1, (elapsed - camTransition.startElapsed) / Math.max(0.1, camTransition.duration))
        : 1;
      const easedTransU = smootherstep01(rawTransU);
      if (camTransition.active && rawTransU >= 1) {
        camTransition.active = false;
      }

      const isOrbitalArc = camTransition.active && camTransition.kind === 'orbital_arc';
      const isLocalHop = camTransition.active && camTransition.kind === 'local_hop';

      // Defer destination biome mesh swap to orbital peak (u >= 0.45) so departure relief never snaps
      if (
        (activeBiome !== currentBiomeId ||
          activeFrost !== currentFrostMode ||
          getTerrainFrameId() !== currentTerrainFrameId) &&
        (!isOrbitalArc || easedTransU >= 0.45)
      ) {
        currentBiomeId = activeBiome;
        currentFrostMode = activeFrost;
        currentTerrainFrameId = getTerrainFrameId();
        terrainManager.setEnvironment(activeBiome, activeFrost, currentTerrainFrameId);
        farTerrain.setEnvironment(activeBiome, activeFrost);
        syncRocksForBiome(activeBiome, activeFrost);
        terrainManager.update(camera, true);
        lastBeaconAstroPos = { x: 999999, z: 999999 };
        camTransition.biomeSwitched = true;
      }

      const targetOrbitalPreset = camPreset === 'orbital' ? 1 : 0;
      orbitalPresetBlend = THREE.MathUtils.damp(orbitalPresetBlend, targetOrbitalPreset, 3.8, delta);
      const orbitalArcBell = isOrbitalArc ? Math.pow(Math.sin(Math.PI * easedTransU), 0.72) : 0;
      const orbitalBlend = Math.min(1, Math.max(orbitalPresetBlend, orbitalArcBell));

      // Update spectral material, custom sky dome gradient, CME skyglow & dust/frost-adjusted FogExp2
      const regionalFogDensity = activeEnv?.fogDensity ?? 0.00078;
      // Thin base haze (visibility ~10 km) so real distant terrain reads; dust storms still thicken it.
      const baseFogFactor = Math.max(regionalFogDensity * 0.3, 0.00014) + Math.max(0, tau - 0.45) * 0.0038;
      const fogFactor = THREE.MathUtils.lerp(baseFogFactor, 0.00004, orbitalBlend);
      const isJezeroOpt = activeBiome === 'JEZERO_CRATER';
      const regionalSkyColor = isJezeroOpt ? '#b86e5c' : (activeEnv?.skyColorHex ?? '#b86e5c');
      const regionalFogColor = isJezeroOpt ? '#c87d55' : (activeEnv?.fogColorHex ?? '#c87d55');

      if (sMode !== currentMode) {
        currentMode = sMode;
        terrainManager.setSpectralMode(sMode);
        marsGlobe.setSpectralMode(sMode);
        if (sMode === 'thermal') {
          skyUniforms.uHorizonColor.value.setHex(0x090514);
          skyUniforms.uZenithColor.value.setHex(0x04020a);
          skyUniforms.uSunGlowColor.value.setHex(0x4c1d95);
          if (scene.background instanceof THREE.Color) scene.background.setHex(0x090514);
          scene.fog = new THREE.FogExp2(0x090514, fogFactor);
          rockMat.color.setHex(0xf59e0b);
          sunLight.intensity = 0.65;
          hemiLight.color.setHex(0x0284c7);
        } else if (sMode === 'topographic') {
          skyUniforms.uHorizonColor.value.setHex(0x070c18);
          skyUniforms.uZenithColor.value.setHex(0x03060d);
          skyUniforms.uSunGlowColor.value.setHex(0x0284c7);
          if (scene.background instanceof THREE.Color) scene.background.setHex(0x070c18);
          scene.fog = new THREE.FogExp2(0x070c18, fogFactor);
          rockMat.color.setHex(0x38bdf8);
          sunLight.intensity = 1.45;
          hemiLight.color.setHex(0x38bdf8);
        } else {
          skyUniforms.uHorizonColor.value.set(regionalFogColor);
          skyUniforms.uZenithColor.value.set(regionalSkyColor);
          skyUniforms.uSunGlowColor.value.setHex(0xffe0bd);
          if (scene.background instanceof THREE.Color) scene.background.set(regionalFogColor);
          scene.fog = new THREE.FogExp2(regionalFogColor, fogFactor);
          rockMat.color.setHex(0xffffff);
          sunLight.intensity = 2.45;
          hemiLight.color.setHex(0xd98a64);
        }
      } else {
        if (sMode === 'optical') {
          _skyZenithTarget.set(regionalSkyColor);
          _skyHorizonTarget.set(regionalFogColor);
          if (isExtremeSpe) {
            _skyZenithTarget.lerp(_colorTmp.setHex(0x8d3438), 0.55);
            _skyHorizonTarget.lerp(_colorTmp.setHex(0x9e3b3f), 0.45);
          } else if (tau > 1.2) {
            _skyZenithTarget.lerp(_colorTmp.setHex(0xb46239), 0.62);
            _skyHorizonTarget.lerp(_colorTmp.setHex(0xc87444), 0.55);
          }
          const skyLerpAlpha = 1 - Math.exp(-5 * delta);
          skyUniforms.uZenithColor.value.lerp(_skyZenithTarget, skyLerpAlpha);
          skyUniforms.uHorizonColor.value.lerp(_skyHorizonTarget, skyLerpAlpha);
          skyUniforms.uSunGlowColor.value.setHex(0xffe0bd);

          _fogColorTarget.copy(skyUniforms.uHorizonColor.value).lerp(_spaceBackdropColor, orbitalBlend);
          if (scene.background instanceof THREE.Color) {
            scene.background.lerp(_fogColorTarget, Math.max(skyLerpAlpha, orbitalBlend * 0.35));
          }
          if (scene.fog instanceof THREE.FogExp2) {
            scene.fog.color.lerp(_fogColorTarget, Math.max(skyLerpAlpha, orbitalBlend * 0.35));
          }
          const isPolar = activeBiome === 'PLANUM_BOREUM' || activeBiome === 'PLANUM_AUSTRALE';
          hemiLight.color.setHex(isPolar ? 0xbcd4e6 : activeBiome === 'OLYMPUS_MONS' ? 0x9b7bb8 : 0xd98a64);
          const dustDim = Math.max(0.45, Math.exp(-tau * 0.42));
          const cmePulse = isExtremeSpe ? Math.sin(elapsed * 9) * 0.35 : 0;
          sunLight.intensity = THREE.MathUtils.lerp((isPolar ? 1.95 : 2.45) * dustDim + cmePulse, 2.35, orbitalBlend);
        } else {
          _fogColorTarget.setHex(sMode === 'thermal' ? 0x090514 : 0x070c18).lerp(_spaceBackdropColor, orbitalBlend);
          if (scene.background instanceof THREE.Color) {
            scene.background.lerp(_fogColorTarget, 1 - Math.exp(-6 * delta));
          }
          if (scene.fog instanceof THREE.FogExp2) {
            scene.fog.color.lerp(_fogColorTarget, 1 - Math.exp(-6 * delta));
          }
        }
        if (scene.fog instanceof THREE.FogExp2) {
          scene.fog.density = THREE.MathUtils.damp(scene.fog.density, fogFactor, 4.5, delta);
        }
      }

      const isFarFromJezero = Math.abs(targetAstroX) > 15_000 || Math.abs(targetAstroY) > 15_000;
      const isPlanetaryWarp = Boolean(livePose.isPlanetaryWarp) || isFarFromJezero;

      if (isOrbitalArc) {
        if (easedTransU < 0.5) {
          smoothPos.x = camTransition.fromX;
          smoothPos.z = camTransition.fromZ;
        } else {
          smoothPos.x = camTransition.toX;
          smoothPos.z = camTransition.toZ;
        }
        smoothPos.heading = targetHeading;
      } else if (isLocalHop) {
        smoothPos.x = THREE.MathUtils.lerp(camTransition.fromX, camTransition.toX, easedTransU);
        smoothPos.z = THREE.MathUtils.lerp(camTransition.fromZ, camTransition.toZ, easedTransU);
        smoothPos.heading = targetHeading;
      } else if (isPlanetaryWarp) {
        let hDiff = targetHeading - smoothPos.heading;
        while (hDiff > 180) hDiff -= 360;
        while (hDiff < -180) hDiff += 360;
        smoothPos.heading = (smoothPos.heading + hDiff * (1 - Math.exp(-16 * delta)) + 360) % 360;

        if (eq.autonomousAiPilot || Math.abs(livePose.speedMps) > 0.1) {
          const warpRad = (smoothPos.heading * Math.PI) / 180;
          const visualCruiseSpeed = Math.min(95, Math.abs(livePose.speedMps));
          smoothPos.x += Math.sin(warpRad) * visualCruiseSpeed * delta;
          smoothPos.z += Math.cos(warpRad) * visualCruiseSpeed * delta;
          if (Math.abs(smoothPos.x) > 12_000 || Math.abs(smoothPos.z) > 12_000) {
            smoothPos.x = ((smoothPos.x % 4_000) + 4_000) % 4_000 - 2_000;
            smoothPos.z = ((smoothPos.z % 4_000) + 4_000) % 4_000 - 2_000;
          }
        }
      } else {
        const localJumpDist = Math.hypot(targetAstroX - smoothPos.x, targetAstroY - smoothPos.z);
        if (localJumpDist > 180) {
          // Trigger smooth local hop instead of snapping
          camTransition.active = true;
          camTransition.kind = 'local_hop';
          camTransition.startElapsed = elapsed;
          camTransition.duration = 1.6;
          camTransition.fromX = smoothPos.x;
          camTransition.fromZ = smoothPos.z;
          camTransition.toX = targetAstroX;
          camTransition.toZ = targetAstroY;
          camTransition.fromLat = prevPoseLat;
          camTransition.fromLng = prevPoseLng;
          camTransition.toLat = livePose.lat;
          camTransition.toLng = livePose.lng;
          camTransition.fromPos.copy(camSmoothedPos);
          camTransition.fromLook.copy(camSmoothedLook);
          camTransition.peakAltitude = Math.min(220, Math.max(40, localJumpDist * 0.16));
        } else {
          // Rigid 1:1 lock to fixed-timestep interpolated physics pose (zero double-damping or phase lag)
          smoothPos.x = targetAstroX;
          smoothPos.z = targetAstroY;
          smoothPos.heading = targetHeading;
        }
      }

      const rx = smoothPos.x;
      const rz = smoothPos.z;
      const showLocalSurface = orbitalBlend < 0.62;
      const insideJezeroView =
        showLocalSurface &&
        activeBiome === 'JEZERO_CRATER' &&
        Math.abs(targetAstroX) <= 4_000 &&
        Math.abs(targetAstroY) <= 4_000;

      terrainManager.group.visible = showLocalSurface;
      if (scene.fog instanceof THREE.FogExp2) {
        farTerrain.update(
          camera.position.x,
          camera.position.z,
          scene.fog.color,
          scene.fog.density,
          showLocalSurface && sMode === 'optical'
        );
      }
      skyDome.visible = orbitalBlend < 0.72;
      habitatGroup.visible = insideJezeroView;
      hotspotGroup.visible = insideJezeroView;
      if (geologyFeaturesGroup) geologyFeaturesGroup.visible = insideJezeroView;
      waypointGroup.visible = showLocalSurface;
      landformBeaconGroup.visible = showLocalSurface;
      customWpGroup.visible = showLocalSurface;
      for (let v = 0; v < rockMeshes.length; v++) {
        if (rockMeshes[v]) rockMeshes[v]!.visible = showLocalSurface;
      }
      if (dustPoints) dustPoints.visible = showLocalSurface;
      if (spePoints) spePoints.visible = showLocalSurface;
      if (safePathMesh) safePathMesh.visible = showLocalSurface && showTrail;
      if (safePathPointsMesh) safePathPointsMesh.visible = showLocalSurface && showTrail;

      // Update 3D Displaced Mars Globe when visible in orbital arc or orbital preset
      if (orbitalBlend > 0.02) {
        if (isOrbitalArc) {
          _transFromLL.lat = camTransition.fromLat;
          _transFromLL.lng = camTransition.fromLng;
          _transToLL.lat = camTransition.toLat;
          _transToLL.lng = camTransition.toLng;
          const slerped = slerpLatLng(_transFromLL, _transToLL, easedTransU);
          _curGlobeLL.lat = slerped.lat;
          _curGlobeLL.lng = slerped.lng;
          marsGlobe.setFlightArc(_transFromLL, _transToLL, easedTransU);
        } else {
          _curGlobeLL.lat = livePose.lat;
          _curGlobeLL.lng = livePose.lng;
          marsGlobe.setFlightArc(null, null, 0);
        }
        marsGlobe.orientAt(_curGlobeLL.lat, _curGlobeLL.lng, -35 * (1 - orbitalBlend));
        marsGlobe.setOpacity(Math.min(1, orbitalBlend * 1.45));
      } else {
        marsGlobe.setOpacity(0);
      }

      // --- 1. UPDATE ROVER / ASTRONAUT MESH TRANSFORM FIRST ---
      const headingRad = (smoothPos.heading * Math.PI) / 180;
      const fwdX = Math.sin(headingRad);
      const fwdZ = Math.cos(headingRad);
      const rightX = Math.cos(headingRad);
      const rightZ = -Math.sin(headingRad);

      const centerSample = sampleTerrainGridNormalAndSlope(
        rx,
        rz,
        activeBiome,
        activeFrost,
        _centerHitNormal
      );
      const hCenter = centerSample.elevation;

      const fx = rx + fwdX * 1.45;
      const fz = rz + fwdZ * 1.45;
      const bx = rx - fwdX * 1.45;
      const bz = rz - fwdZ * 1.45;
      const rgtX = rx + rightX * 1.45;
      const rgtZ = rz + rightZ * 1.45;
      const lftX = rx - rightX * 1.45;
      const lftZ = rz - rightZ * 1.45;

      const hFront = sampleTerrainGridElevation(fx, fz, activeBiome, activeFrost);
      const hBack = sampleTerrainGridElevation(bx, bz, activeBiome, activeFrost);
      const hRight = sampleTerrainGridElevation(rgtX, rgtZ, activeBiome, activeFrost);
      const hLeft = sampleTerrainGridElevation(lftX, lftZ, activeBiome, activeFrost);

      const suspensionTargetY = (hCenter * 2 + hFront + hBack + hRight + hLeft) / 6;
      if (!camInitialized || (isOrbitalArc && easedTransU >= 0.45 && easedTransU <= 0.55)) {
        smoothGroundY = suspensionTargetY;
      } else {
        smoothGroundY = THREE.MathUtils.damp(smoothGroundY, suspensionTargetY, 16, delta);
      }
      const groundY = smoothGroundY;

      _vFwd.set(fwdX * 2.9, hFront - hBack, fwdZ * 2.9);
      _vRight.set(rightX * 2.9, hRight - hLeft, rightZ * 2.9);
      _computedNormal.crossVectors(_vRight, _vFwd).normalize();
      if (_computedNormal.y < 0) _computedNormal.negate();
      _terrainNormal.copy(_computedNormal).lerp(_centerHitNormal, 0.3).normalize();

      if (!camInitialized) {
        _smoothedTerrainNormal.copy(_terrainNormal);
      } else {
        _smoothedTerrainNormal.lerp(_terrainNormal, 1 - Math.exp(-12 * delta)).normalize();
      }

      const isEvaWalk = eq.locomotionMode === 'eva_walk';
      roverGroup.visible = showLocalSurface && !isEvaWalk;
      astronautGroup.visible = showLocalSurface && isEvaWalk;

      const vib = isWindShear || slipPct > 40 ? Math.sin(elapsed * 28) * 0.016 : 0;
      roverGroup.position.set(rx, groundY + vib, rz);

      // Lock rover yaw 1:1 to physics heading while smoothly damping terrain tilt normal
      _tiltQuat.setFromUnitVectors(_upVec, _smoothedTerrainNormal);
      _yawQuat.setFromAxisAngle(_upVec, headingRad);
      roverGroup.quaternion.multiplyQuaternions(_tiltQuat, _yawQuat);

      const wingFlutter = isWindShear ? Math.sin(elapsed * 22) * 0.14 : 0;
      const targetWingAngle = eq.solarPanelsDeployed ? wingFlutter : Math.PI * 0.48;
      wingAngle = THREE.MathUtils.damp(wingAngle, targetWingAngle, 6, delta);
      leftWingPivot.rotation.z = -wingAngle;
      rightWingPivot.rotation.z = wingAngle;

      const dustBlend = Math.min(1, eq.solarDustCoatingPercent / 100);
      wingMat.color.setHex(0x1e3a8a).lerp(_colorTmp.setHex(0x9a4d2c), dustBlend * 0.85);

      if (isRoverDamaged) {
        const pulse = Math.sin(elapsed * 10) > 0;
        faultBeacon.visible = showLocalSurface && pulse;
        faultLight.intensity = showLocalSurface && pulse ? 5.5 : 0.4;
      } else {
        faultBeacon.visible = false;
        faultLight.intensity = 0;
      }

      const brownoutFlicker =
        curVitals && curVitals.batteryPercentage < 15 ? (Math.sin(elapsed * 32) > -0.3 ? 0.55 : 0.1) : 1.0;
      headlightSpot.intensity = showLocalSurface && eq.headlightsEnabled ? 6.5 * brownoutFlicker : 0;
      beamConeMesh.visible = showLocalSurface && eq.headlightsEnabled && brownoutFlicker > 0.2;

      const actualLinearSpeed = livePose.speedMps;
      const speedNorm = Math.min(1, Math.abs(actualLinearSpeed) / 6.0);
      const evaBounce = isEvaWalk ? Math.abs(Math.sin(elapsed * 6.5)) * 0.16 * speedNorm : 0;
      astronautGroup.position.set(rx, groundY + evaBounce, rz);
      astronautGroup.rotation.y = headingRad;

      // Wheel rotation read directly from single-source-of-truth physics store
      for (let i = 0; i < wheelMeshes.length; i++) {
        wheelMeshes[i].rotation.x = livePose.wheelRotationRad;
      }

      roverGroup.updateMatrixWorld();
      astronautGroup.updateMatrixWorld();

      if (dustPoints && dustMat) {
        const pMode = activeEnv?.particleMode ?? 'dust';
        dustPoints.position.set(rx, groundY, rz);
        if (pMode === 'ice_crystals') {
          dustMat.color.setHex(0xe0f2fe);
          dustMat.opacity = activeFrost === 'DEPOSITION' ? 0.65 : 0.42;
          dustMat.size = 0.75;
          dustPoints.rotation.y = elapsed * (0.14 + gust * 0.02);
        } else if (pMode === 'fog_mist') {
          dustMat.color.setHex(0xd8e2e8);
          dustMat.opacity = 0.48;
          dustMat.size = 1.65;
          dustPoints.rotation.y = elapsed * (0.04 + gust * 0.008);
        } else if (pMode === 'dust_devil') {
          dustMat.color.setHex(0xe8a87c);
          dustMat.opacity = Math.min(0.92, Math.max(0.18, (tau - 0.15) * 0.62 + (slipPct / 100) * 0.25));
          dustMat.size = 1.1;
          dustPoints.rotation.y = elapsed * (0.24 + gust * 0.028);
        } else {
          dustMat.color.setHex(0xe8a87c);
          dustMat.opacity = Math.min(0.92, Math.max(0.06, (tau - 0.2) * 0.55 + (slipPct / 100) * 0.25));
          dustMat.size = tau > 1.0 ? 1.45 : 0.9;
          dustPoints.rotation.y = elapsed * (0.08 + gust * 0.015);
        }
      }

      if (spePoints && speMat) {
        spePoints.position.set(rx, groundY, rz);
        if (isHighSpe) {
          speMat.opacity = Math.min(0.95, Math.max(0.25, (radRate - 18) / 140));
          speMat.color.setHex(isExtremeSpe ? 0xff4d6d : 0xffb347);
          speMat.size = isExtremeSpe ? 0.85 : 0.55;
          spePoints.rotation.y = -elapsed * (isExtremeSpe ? 0.85 : 0.35);
        } else {
          speMat.opacity = 0;
        }
      }

      // --- 2. IMMEDIATELY UPDATE CAMERA POSITION & LOOKAT IN THE EXACT SAME TICK ---
      const offsetAlpha = 1 - Math.exp(-6.5 * delta);
      const offset = camOffsetRef.current;
      const tgtOffset = targetCamOffsetRef.current;
      offset.distance += (tgtOffset.distance - offset.distance) * offsetAlpha;
      offset.height += (tgtOffset.height - offset.height) * offsetAlpha;
      offset.pitch += (tgtOffset.pitch - offset.pitch) * offsetAlpha;

      // DualSense Right Stick (axes[2], axes[3]) smooth camera panning & tilt (zero React state)
      const ds = dualSense.inputRef.current;
      const userOrbit = camUserOrbitRef.current;
      if (dualSense.cameraRecenterEpoch !== lastRecenterEpoch) {
        lastRecenterEpoch = dualSense.cameraRecenterEpoch;
        userOrbit.recentering = true;
      }

      if (Math.abs(ds.cameraX) > 0.005 || Math.abs(ds.cameraY) > 0.005) {
        userOrbit.recentering = false;
        userOrbit.yaw += ds.cameraX * 2.15 * delta;
        if (userOrbit.yaw > Math.PI) userOrbit.yaw -= Math.PI * 2;
        if (userOrbit.yaw < -Math.PI) userOrbit.yaw += Math.PI * 2;
        userOrbit.pitch = THREE.MathUtils.clamp(
          userOrbit.pitch + ds.cameraY * 1.35 * delta,
          -0.55,
          0.85
        );
      } else if (userOrbit.recentering) {
        userOrbit.yaw = THREE.MathUtils.damp(userOrbit.yaw, 0, 9, delta);
        userOrbit.pitch = THREE.MathUtils.damp(userOrbit.pitch, 0, 9, delta);
        if (Math.abs(userOrbit.yaw) < 0.002 && Math.abs(userOrbit.pitch) < 0.002) {
          userOrbit.yaw = 0;
          userOrbit.pitch = 0;
          userOrbit.recentering = false;
        }
      }

      const lookHeadingRad = headingRad - userOrbit.yaw;
      const lookFwdX = Math.sin(lookHeadingRad);
      const lookFwdZ = Math.cos(lookHeadingRad);

      const rawSpeedLag = THREE.MathUtils.clamp(actualLinearSpeed * 0.08, -1.2, 2.4);
      smoothedSpeedLag = !camInitialized
        ? rawSpeedLag
        : THREE.MathUtils.damp(smoothedSpeedLag, rawSpeedLag, 8, delta);
      const speedLag = smoothedSpeedLag;

      smoothedPitchOffset = !camInitialized
        ? pOff
        : THREE.MathUtils.damp(smoothedPitchOffset, pOff, 8, delta);

      if (camPreset === 'mastcam') {
        const gentleSway = Math.sin(elapsed * 0.72) * 0.06;
        const mastPitchLift = -userOrbit.pitch * 36;
        _camDesiredPos.set(
          rx + fwdX * 0.5,
          groundY + offset.height,
          rz + fwdZ * 0.5
        );
        _camDesiredLook.set(
          rx + lookFwdX * 65,
          groundY + offset.height + smoothedPitchOffset * 0.1 + mastPitchLift + gentleSway,
          rz + lookFwdZ * 65
        );
      } else if (camPreset === 'overview') {
        const horDist = offset.distance + speedLag * 1.4;
        const armLen = Math.hypot(horDist, offset.height);
        const effElev = THREE.MathUtils.clamp(
          Math.atan2(offset.height, horDist) + userOrbit.pitch * 0.65,
          0.18,
          1.38
        );
        const effHor = Math.cos(effElev) * armLen;
        const effVert = Math.sin(effElev) * armLen;
        _camDesiredPos.set(
          rx - lookFwdX * effHor,
          groundY + effVert,
          rz - lookFwdZ * effHor
        );
        _camDesiredLook.set(
          rx + lookFwdX * (4 + speedLag * 1.2),
          groundY + 1.5,
          rz + lookFwdZ * (4 + speedLag * 1.2)
        );
      } else if (camPreset === 'orbit') {
        const orbitAngle = elapsed * 0.28 - userOrbit.yaw;
        const orbitRadius = 22;
        const orbitVert = THREE.MathUtils.clamp(10.5 + userOrbit.pitch * 12, 2.5, 24);
        _camDesiredPos.set(
          rx + Math.sin(orbitAngle) * orbitRadius,
          groundY + orbitVert,
          rz + Math.cos(orbitAngle) * orbitRadius
        );
        _camDesiredLook.set(rx, groundY + 1.5, rz);
      } else {
        const horDist = offset.distance + speedLag;
        const armLen = Math.hypot(horDist, offset.height);
        const effElev = THREE.MathUtils.clamp(
          Math.atan2(offset.height, horDist) + userOrbit.pitch * 0.75,
          0.1,
          1.25
        );
        const effHor = Math.cos(effElev) * armLen;
        const effVert = Math.max(1.4, Math.sin(effElev) * armLen);
        _camDesiredPos.set(
          rx - lookFwdX * effHor,
          groundY + effVert,
          rz - lookFwdZ * effHor
        );
        _camDesiredLook.set(
          rx + lookFwdX * (6.5 + speedLag * 1.35),
          groundY + 1.65 - userOrbit.pitch * 2.2,
          rz + lookFwdZ * (6.5 + speedLag * 1.35)
        );
      }

      // Apply local hop parabolic arc elevation if mid-hop
      if (isLocalHop) {
        _camDesiredPos.y += Math.sin(Math.PI * easedTransU) * camTransition.peakAltitude;
      }

      // Compute Orbital 3D Planet camera target when viewing Mars from orbit or arching between regions
      if (orbitalBlend > 0.005) {
        const orbDist = isOrbitalArc
          ? THREE.MathUtils.lerp(420, camTransition.peakAltitude, orbitalBlend)
          : orbitalZoomDistRef.current;
        const orbAngle = -userOrbit.yaw + (camPreset === 'orbital' ? elapsed * 0.035 : 0);
        const orbTilt = THREE.MathUtils.clamp(0.46 + userOrbit.pitch * 0.55, 0.12, 1.12);
        const horOrb = Math.sin(orbTilt) * orbDist;
        const vertOrb = Math.cos(orbTilt) * orbDist;
        _orbCamPos.set(
          Math.sin(orbAngle) * horOrb,
          vertOrb,
          Math.cos(orbAngle) * horOrb
        );
        _orbCamLook.set(0, -GLOBE_RADIUS * 0.24 * orbitalBlend, 0);

        _camDesiredPos.lerp(_orbCamPos, orbitalBlend);
        _camDesiredLook.lerp(_orbCamLook, orbitalBlend);
      }

      if (!camInitialized) {
        camSmoothedPos.copy(_camDesiredPos);
        camSmoothedLook.copy(_camDesiredLook);
        camera.position.copy(camSmoothedPos);
        camera.lookAt(camSmoothedLook);
        camInitialized = true;
      } else if (camTransition.active && camTransition.kind === 'preset') {
        camSmoothedPos.lerpVectors(camTransition.fromPos, _camDesiredPos, easedTransU);
        camSmoothedLook.lerpVectors(camTransition.fromLook, _camDesiredLook, easedTransU);
        camera.position.copy(camSmoothedPos);
        camera.lookAt(camSmoothedLook);
      } else {
        const isFirstPerson = camPreset === 'mastcam' && orbitalBlend < 0.05;
        const posAlpha = 1 - Math.exp(-(isFirstPerson ? 24 : orbitalBlend > 0.2 ? 9.0 : 11.5) * delta);
        const lookAlpha = 1 - Math.exp(-(isFirstPerson ? 24 : orbitalBlend > 0.2 ? 10.5 : 14.5) * delta);

        camSmoothedPos.lerp(_camDesiredPos, posAlpha);
        camSmoothedLook.lerp(_camDesiredLook, lookAlpha);
        camera.position.copy(camSmoothedPos);
        camera.lookAt(camSmoothedLook);
      }

      prevPoseLat = livePose.lat;
      prevPoseLng = livePose.lng;

      // Keep directional shadow frustum tightly centered on rover/astronaut & move sky dome with camera
      if (orbitalBlend > 0.35) {
        sunLight.position.set(2200, 1400, 1800);
        sunLight.target.position.set(0, -GLOBE_RADIUS * 0.4, 0);
      } else {
        sunLight.position.set(rx + _sunOffsetVec.x, groundY + _sunOffsetVec.y, rz + _sunOffsetVec.z);
        sunLight.target.position.set(rx, groundY, rz);
      }
      sunLight.target.updateMatrixWorld();
      skyDome.position.set(camera.position.x, groundY - 40, camera.position.z);

      // Stream active chunked LOD terrain, update LOD levels, and dispose exited chunks
      if (showLocalSurface) {
        terrainManager.update(camera, false);
      }

      // Spin waypoint & landform diamonds
      waypointGroup.children.forEach((g) => {
        if (!g.visible) return;
        const d = g.children[1];
        if (d) d.rotation.y = elapsed * 1.1;
      });
      landformBeaconGroup.children.forEach((g) => {
        const d = g.children[1];
        if (d) d.rotation.y = elapsed * 0.9;
      });
      customWpGroup.children.forEach((g) => {
        const d = g.children[1];
        if (d) d.rotation.y = -elapsed * 1.6;
      });

      // Strict 300 km culling for Jezero waypoint towers
      if (vWaypoints && vWaypoints !== lastVisorWaypointsRef) {
        lastVisorWaypointsRef = vWaypoints;
        const visibleSet = new Set(vWaypoints.map((w) => w.id));
        waypointTowerById.forEach((g, id) => {
          g.visible = visibleSet.has(id);
        });
      } else if (!vWaypoints) {
        MARS_WAYPOINTS.forEach((wp) => {
          const g = waypointTowerById.get(wp.id);
          if (g) {
            g.visible = Math.hypot(wp.x - rx, wp.z - rz) / 1000 <= VISOR_PROXIMITY_THRESHOLD_KM;
          }
        });
      }

      // Sync color-coded 3D landform beacons (strictly <= 300 km, incremental in-place updates)
      const beaconShiftDist = Math.hypot(rx - lastBeaconAstroPos.x, rz - lastBeaconAstroPos.z);
      if (
        vLandforms !== lastLandformRef ||
        selTargetId !== lastSelectedTargetId ||
        beaconShiftDist > 120
      ) {
        lastLandformRef = vLandforms;
        lastSelectedTargetId = selTargetId;
        lastBeaconAstroPos = { x: rx, z: rz };
        syncLandformBeacons3D(vLandforms, rx, rz, selTargetId);
      }

      // Sync custom 3D beacons only when waypoint list/targets change
      const customSig = customWps.map((w) => `${w.id}:${Math.round(w.x)},${Math.round(w.y)},${w.isNext ? 1 : 0}`).join('|');
      if (customSig !== lastCustomWpSignature) {
        lastCustomWpSignature = customSig;
        syncCustomWaypoints3D(customWps, rx, rz);
      }

      // Update blue guidance trail (#52e0ff) throttled smoothly to prevent frequent TubeGeometry rebuilds while driving
      const trailMoveThreshold = isPlanetaryWarp ? 240 : 95;
      const movedDist = Math.hypot(rx - lastPathState.ax, rz - lastPathState.az);
      const targetChanged =
        (!isPlanetaryWarp && (tgt.x !== lastPathState.tx || tgt.y !== lastPathState.tz)) ||
        Math.abs((trailDirDeg ?? 0) - (lastPathState.dirDeg ?? 0)) > 3 ||
        (trailDirDeg == null) !== (lastPathState.dirDeg == null);
      const visibilityChanged = showTrail !== lastPathState.visible;
      if (visibilityChanged || (showTrail && (movedDist > trailMoveThreshold || targetChanged))) {
        lastPathState = {
          ax: rx,
          az: rz,
          tx: tgt.x,
          tz: tgt.y,
          visible: showTrail,
          dirDeg: trailDirDeg,
        };
        if (showTrail) {
          createSafePath(rx, rz, isPlanetaryWarp ? rx : tgt.x, isPlanetaryWarp ? rz : tgt.y, trailDirDeg);
        } else {
          clearSafePath();
        }
      }

      renderer.render(scene, camera);
    };

    renderFrame(1 / 60, performance.now(), liveVehicleRef?.current ?? vehicleSim.poseRef.current);
    vehicleSim.setViewportCallback(renderFrame);
    vehicleSim.start();

    // Progressively hydrate non-critical 3D assets across idle frames so startup never freezes
    scheduleIdleTask(() => {
      terrainManager.upgradePbrDetailMaps();
      scheduleIdleTask(() => {
        buildAtmosphericParticles();
        scheduleIdleTask(() => {
          buildGeologyFeatures();
          const buildNextRockVariant = (v: number) => {
            if (isDisposed || v >= rockVariantCount) return;
            if (!rockGeometries[v]) rockGeometries[v] = createSculptedRockGeometry(v as 0 | 1 | 2 | 3);
            const inst = new THREE.InstancedMesh(rockGeometries[v], rockMat, rocksPerVariant);
            inst.receiveShadow = true;
            inst.castShadow = false;
            inst.frustumCulled = true;
            rockMeshes[v] = inst;
            populateRockVariant(v, currentBiomeId, currentFrostMode);
            scene.add(inst);
            if (v + 1 < rockVariantCount) {
              scheduleIdleTask(() => buildNextRockVariant(v + 1), 24);
            }
          };
          scheduleIdleTask(() => buildNextRockVariant(0), 24);
        }, 24);
      }, 24);
    }, 32);

    return () => {
      isDisposed = true;
      vehicleSim.setViewportCallback(null);
      const win = window as Window & { cancelIdleCallback?: (handle: number) => void };
      for (const task of pendingIdleTasks) {
        if (task.type === 'idle' && typeof win.cancelIdleCallback === 'function') {
          win.cancelIdleCallback(task.id);
        } else {
          clearTimeout(task.id);
        }
      }
      pendingIdleTasks.length = 0;

      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointerup', handlePointerUp);
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('click', handleCanvasClick);
      container.removeEventListener('pointermove', handlePointerMove);
      container.removeEventListener('wheel', handleWheel);
      if (container && renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      clearSafePath();
      syncCustomWaypoints3D([]);
      syncLandformBeacons3D([], 0, 0);
      terrainManager.disposeAll();
      farTerrain.dispose();
      marsGlobe.dispose();

      const disposeGroupMeshes = (root: THREE.Object3D) => {
        root.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry?.dispose();
            if (Array.isArray(obj.material)) {
              obj.material.forEach((m) => m.dispose());
            } else {
              obj.material?.dispose();
            }
          }
        });
      };
      disposeGroupMeshes(roverGroup);
      disposeGroupMeshes(astronautGroup);
      disposeGroupMeshes(habitatGroup);

      // Waypoint, landform, custom waypoint, hotspot dome, and POI meshes share geometries
      disposeGroupMaterialsOnly(waypointGroup);
      disposeGroupMaterialsOnly(landformBeaconGroup);
      disposeGroupMaterialsOnly(customWpGroup);
      if (geologyFeaturesGroup) disposeGroupMaterialsOnly(geologyFeaturesGroup);
      hotspotGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.geometry !== sharedHotspotDomeGeom) {
          obj.geometry?.dispose();
        }
      });

      sharedWaypointPillarGeom.dispose();
      sharedWaypointDiamondGeom.dispose();
      sharedWaypointRingGeom.dispose();
      sharedLandformPillarGeom.dispose();
      sharedLandformCrystalGeom.dispose();
      sharedLandformRingGeom.dispose();
      sharedCustomPillarGeom.dispose();
      sharedCustomHeadGeom.dispose();
      sharedCustomRingGeom.dispose();
      sharedHotspotDomeGeom.dispose();
      sharedHotspotDomeMat.dispose();
      sharedHotspotRingMat.dispose();
      sharedPoiRingGeom.dispose();

      rockGeometries.forEach((g) => g.dispose());
      rockMat.dispose();
      rockBumpTex.dispose();
      strataSlabMat.dispose();
      strataDarkBandMat.dispose();
      subsurfaceIceMat.dispose();
      vesicularBasaltMat.dispose();
      olivineCarbonateMat.dispose();
      silicaVeinMat.dispose();
      skyDomeGeom.dispose();
      skyDomeMat.dispose();
      dustGeom?.dispose();
      dustMat?.dispose();
      speGeom?.dispose();
      speMat?.dispose();
      envTex.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div className="absolute inset-0 z-0 overflow-hidden">
      {/* Dedicated WebGL Canvas Mount */}
      <div ref={mountRef} className="w-full h-full" />

      {/* Hovered 3D Beacon Tooltip */}
      {hoveredBeacon && (
        <div
          className="absolute top-20 left-1/2 -translate-x-1/2 z-20 bg-slate-950/95 border rounded-xl px-3.5 py-2 shadow-2xl pointer-events-none flex items-center gap-2.5"
          style={{ borderColor: hoveredBeacon.colorHex }}
        >
          <span
            className="w-2.5 h-2.5 rotate-45 shrink-0"
            style={{ backgroundColor: hoveredBeacon.colorHex }}
          />
          <div className="text-xs font-mono">
            <div className="text-slate-100 font-bold flex items-center gap-2">
              <span>{hoveredBeacon.name}</span>
              <span style={{ color: hoveredBeacon.colorHex }} className="text-[10px]">
                [{hoveredBeacon.categoryLabel}]
              </span>
              <span className="text-cyan-300 tabular-nums">
                {hoveredBeacon.distanceKm < 1
                  ? `${Math.round(hoveredBeacon.distanceKm * 1000)} m`
                  : `${hoveredBeacon.distanceKm.toFixed(1)} km`}
              </span>
              <span className="text-slate-400 text-[10px] tabular-nums">
                ETA {calcEtaMinutes(hoveredBeacon.distanceKm)}m
              </span>
            </div>
            <div className="text-[10px] text-slate-400">
              Click 3D beacon to lock target &amp; optionally engage Autopilot
            </div>
          </div>
        </div>
      )}

      {/* Selected 3D Beacon / Landform Tooltip Card (No backdrop-blur over WebGL) */}
      {liveSelectedBeacon && (
        <div
          className="absolute top-32 left-1/2 -translate-x-1/2 z-30 w-[min(390px,calc(100vw-32px))] bg-slate-950/96 border rounded-xl p-3 shadow-2xl pointer-events-auto font-mono text-xs space-y-2"
          style={{ borderColor: liveSelectedBeacon.colorHex }}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span
                  className="w-2.5 h-2.5 rotate-45 shrink-0"
                  style={{ backgroundColor: liveSelectedBeacon.colorHex }}
                />
                <span className="font-bold text-slate-100">{liveSelectedBeacon.name}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-slate-400 mt-0.5 tabular-nums">
                <span style={{ color: liveSelectedBeacon.colorHex }}>{liveSelectedBeacon.categoryLabel}</span>
                <span>·</span>
                <span className="text-cyan-300 font-bold">
                  {liveSelectedBeacon.distanceKm < 1
                    ? `${Math.round(liveSelectedBeacon.distanceKm * 1000)} m`
                    : `${liveSelectedBeacon.distanceKm.toFixed(1)} km`}
                </span>
                <span>·</span>
                <span className="text-amber-300">ETA {calcEtaMinutes(liveSelectedBeacon.distanceKm)} min</span>
                <span>·</span>
                <span className="text-emerald-400">&lt;=300km</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedBeacon(null)}
              className="text-slate-400 hover:text-white p-0.5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {liveSelectedBeacon.summary && (
            <p className="text-[11px] text-slate-300 leading-relaxed">{liveSelectedBeacon.summary}</p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800">
            {onToggleAutopilotTravel && (
              <label className="flex items-center gap-1.5 text-[10px] text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableAutopilotTravel}
                  onChange={(e) => {
                    playChirpSound();
                    onToggleAutopilotTravel(e.target.checked);
                  }}
                  className="accent-cyan-400 cursor-pointer"
                />
                <Cpu className="w-3 h-3 text-cyan-400" />
                <span>Autopilot to Location</span>
              </label>
            )}

            <div className="flex items-center gap-1.5 ml-auto">
              {!liveSelectedBeacon.isLandform && onSelectWaypoint && (
                <button
                  type="button"
                  onClick={() => {
                    playAckTone();
                    onSelectWaypoint(liveSelectedBeacon.id);
                  }}
                  className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-cyan-300 text-[10px] font-bold flex items-center gap-1"
                >
                  <Camera className="w-3 h-3" />
                  <span>NASA Photos</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  playAckTone();
                  onSelectBeacon?.(liveSelectedBeacon.id, { autopilot: enableAutopilotTravel });
                }}
                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-cyan-500/40 text-cyan-300 text-[10px] font-bold"
              >
                Set Target
              </button>
              <button
                type="button"
                onClick={() => {
                  playAckTone();
                  onSelectBeacon?.(liveSelectedBeacon.id, { autopilot: true });
                }}
                className="px-2.5 py-1 rounded bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-[10px] font-bold flex items-center gap-1"
              >
                <Navigation className="w-3 h-3" />
                <span>Autopilot</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* COLLAPSIBLE BOTTOM CONTROL DOCK (No backdrop-blur over WebGL) */}
      <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center pointer-events-auto">
        <button
          type="button"
          onClick={() => {
            playChirpSound();
            setDockCollapsed(!dockCollapsed);
          }}
          className="px-3 py-0.5 mb-1 rounded-t-lg bg-slate-950/95 border border-b-0 border-cyan-500/40 text-[10px] font-mono text-cyan-300 hover:text-white flex items-center gap-1"
        >
          {dockCollapsed ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          <span>{dockCollapsed ? 'Show Camera Dock' : 'Hide Camera Dock'}</span>
        </button>

        {!dockCollapsed && (
          <div className="w-[94vw] max-w-4xl bg-slate-950/92 border border-cyan-500/40 rounded-xl shadow-2xl px-3 sm:px-4 py-2 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-mono text-slate-400 font-bold uppercase tracking-wider hidden md:inline">
                Camera Presets:
              </span>
              <button
                type="button"
                onClick={() => handleSelectCameraPreset('overview')}
                className={`px-2.5 py-1 text-xs font-mono rounded-lg transition-all flex items-center gap-1.5 ${
                  activeCamPreset === 'overview'
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-md shadow-cyan-500/40'
                    : 'bg-slate-900 text-slate-300 hover:text-white border border-slate-800'
                }`}
              >
                <Compass className="w-3.5 h-3.5" />
                <span>Overview (3.6km VERVE)</span>
              </button>
              <button
                type="button"
                onClick={() => handleSelectCameraPreset('closeup')}
                className={`px-2.5 py-1 text-xs font-mono rounded-lg transition-all flex items-center gap-1.5 ${
                  activeCamPreset === 'closeup'
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-md shadow-cyan-500/40'
                    : 'bg-slate-900 text-slate-300 hover:text-white border border-slate-800'
                }`}
              >
                <Video className="w-3.5 h-3.5" />
                <span>Rover Follow</span>
              </button>
              <button
                type="button"
                onClick={() => handleSelectCameraPreset('mastcam')}
                className={`px-2.5 py-1 text-xs font-mono rounded-lg transition-all flex items-center gap-1.5 ${
                  activeCamPreset === 'mastcam'
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-md shadow-cyan-500/40'
                    : 'bg-slate-900 text-slate-300 hover:text-white border border-slate-800'
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                <span>MastCam 1st Person</span>
              </button>
              <button
                type="button"
                onClick={() => handleSelectCameraPreset('orbit')}
                className={`px-2.5 py-1 text-xs font-mono rounded-lg transition-all hidden sm:flex items-center gap-1.5 ${
                  activeCamPreset === 'orbit'
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-md shadow-cyan-500/40'
                    : 'bg-slate-900 text-slate-300 hover:text-white border border-slate-800'
                }`}
              >
                <Orbit className="w-3.5 h-3.5" />
                <span>Orbit</span>
              </button>
              <button
                type="button"
                onClick={() => handleSelectCameraPreset('orbital')}
                className={`px-2.5 py-1 text-xs font-mono rounded-lg transition-all flex items-center gap-1.5 ${
                  activeCamPreset === 'orbital'
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-md shadow-cyan-500/40'
                    : 'bg-slate-900 text-slate-300 hover:text-white border border-slate-800'
                }`}
              >
                <Globe className="w-3.5 h-3.5" />
                <span>Orbital Mars</span>
              </button>
              {onCycleLandmark && (
                <div className="flex items-center gap-1 ml-1 pl-1.5 border-l border-slate-800">
                  <button
                    type="button"
                    onClick={() => onCycleLandmark('prev')}
                    title="Orbital transit to previous Martian landmark"
                    className="px-1.5 py-1 text-xs font-mono rounded-lg bg-slate-900 text-slate-300 hover:text-cyan-300 border border-slate-800 flex items-center"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-[10px] font-mono text-cyan-300 font-bold uppercase tracking-wider px-1 hidden lg:inline">
                    Cycle Site
                  </span>
                  <button
                    type="button"
                    onClick={() => onCycleLandmark('next')}
                    title="Orbital transit to next Martian landmark"
                    className="px-1.5 py-1 text-xs font-mono rounded-lg bg-slate-900 text-slate-300 hover:text-cyan-300 border border-slate-800 flex items-center"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 text-xs font-mono text-slate-300">
              <div className="flex items-center gap-1">
                <span className="text-slate-500">REGION:</span>
                <span className="text-cyan-300 font-bold truncate max-w-[160px]">
                  {activeEnvironment?.regionName ?? 'Jezero Crater'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-slate-500">BAT:</span>
                <span className="text-amber-300 font-bold">{vitals?.batteryPercentage?.toFixed(0) ?? 81}%</span>
              </div>
              <div className="flex items-center gap-1 hidden md:flex">
                <span className="text-slate-500">TEMP:</span>
                <span className="text-cyan-300 font-bold">{vitals?.ambientTempCelsius?.toFixed(1) ?? -38.4}°C</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
