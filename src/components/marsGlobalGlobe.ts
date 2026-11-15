import * as THREE from 'three';
import {
  evalPlanetaryTopography,
  MARS_PLANETARY_LANDMARKS,
  LANDFORM_CATEGORY_COLORS,
  slerpLatLng,
  marsDistanceKm,
  normalizeSignedLng180,
} from '../data/marsCartography';

export type GlobeSpectralMode = 'optical' | 'thermal' | 'topographic';

export const GLOBE_RADIUS = 1000;
export const GLOBE_ELEV_SCALE = 0.0044; // +24.5 km -> +107.8 units, -9.4 km -> -41.4 units

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

// Pre-allocated scratch helpers (Zero GC during animation frames)
const _vDir = new THREE.Vector3();
const _vEast = new THREE.Vector3();
const _vNegNorth = new THREE.Vector3();
const _vWork = new THREE.Vector3();
const _matBasis = new THREE.Matrix4();
const _quatPin = new THREE.Quaternion();
const _upLocal = new THREE.Vector3(0, 1, 0);

/**
 * Converts Martian Areographic (lat, lng) into a right-handed unit vector on the 3D globe
 * where +Y = North Pole, +X = 0°E Prime Meridian, -Z = +90°E (so East is to the right when +Y is up).
 */
export function latLngToGlobeDir(lat: number, lng: number, out: THREE.Vector3): THREE.Vector3 {
  const latR = Math.max(-90, Math.min(90, lat)) * DEG_TO_RAD;
  const lngR = normalizeSignedLng180(lng) * DEG_TO_RAD;
  const cosLat = Math.cos(latR);
  return out.set(
    cosLat * Math.cos(lngR),
    Math.sin(latR),
    -cosLat * Math.sin(lngR)
  );
}

/**
 * Returns the displaced radius on the 3D Mars sphere for a given (lat, lng).
 */
export function getGlobeSurfaceRadius(lat: number, lng: number): number {
  const topo = evalPlanetaryTopography(lat, lng);
  return GLOBE_RADIUS + topo.elevationMeters * GLOBE_ELEV_SCALE;
}

function molaHypsometricColor(norm: number, out: THREE.Color): THREE.Color {
  // NASA MGS MOLA rainbow-hypsometric elevation ramp
  if (norm < 0.14) {
    const t = norm / 0.14;
    return out.setRGB(0.11 + t * 0.05, 0.1 + t * 0.25, 0.44 + t * 0.36);
  }
  if (norm < 0.28) {
    const t = (norm - 0.14) / 0.14;
    return out.setRGB(0.16 - t * 0.06, 0.35 + t * 0.36, 0.8 + t * 0.08);
  }
  if (norm < 0.44) {
    const t = (norm - 0.28) / 0.16;
    return out.setRGB(0.1 + t * 0.28, 0.71 + t * 0.12, 0.88 - t * 0.56);
  }
  if (norm < 0.62) {
    const t = (norm - 0.44) / 0.18;
    return out.setRGB(0.38 + t * 0.56, 0.83 - t * 0.08, 0.32 - t * 0.18);
  }
  if (norm < 0.78) {
    const t = (norm - 0.62) / 0.16;
    return out.setRGB(0.94, 0.75 - t * 0.46, 0.14 + t * 0.04);
  }
  if (norm < 0.91) {
    const t = (norm - 0.78) / 0.13;
    return out.setRGB(0.94 - t * 0.18, 0.29 + t * 0.32, 0.18 + t * 0.52);
  }
  const t = Math.min(1, (norm - 0.91) / 0.09);
  return out.setRGB(0.76 + t * 0.22, 0.61 + t * 0.36, 0.7 + t * 0.29);
}

export class MarsGlobalGlobe {
  public readonly group = new THREE.Group();
  private readonly planetRoot = new THREE.Group();

  private readonly sphereGeom: THREE.SphereGeometry;
  private readonly sphereMat: THREE.MeshStandardMaterial;
  private readonly sphereMesh: THREE.Mesh;

  private readonly opticalColors: Float32Array;
  private readonly topoColors: Float32Array;
  private readonly thermalColors: Float32Array;
  private activeSpectralMode: GlobeSpectralMode = 'optical';

  private readonly haloGeom: THREE.SphereGeometry;
  private readonly haloMat: THREE.ShaderMaterial;
  private readonly haloMesh: THREE.Mesh;

  private readonly starGeom: THREE.BufferGeometry;
  private readonly starMat: THREE.PointsMaterial;
  private readonly starPoints: THREE.Points;

  private readonly landmarkGroup = new THREE.Group();
  private readonly landmarkGeom: THREE.OctahedronGeometry;
  private readonly landmarkMaterials: THREE.MeshBasicMaterial[] = [];

  private readonly roverMarkerGeom: THREE.SphereGeometry;
  private readonly roverMarkerMat: THREE.MeshBasicMaterial;
  private readonly roverMarkerMesh: THREE.Mesh;

  private readonly arcPointsCount = 65;
  private readonly arcPositions: Float32Array;
  private readonly arcGeom: THREE.BufferGeometry;
  private readonly arcMat: THREE.LineBasicMaterial;
  private readonly arcLine: THREE.Line;

  private readonly probeGeom: THREE.SphereGeometry;
  private readonly probeMat: THREE.MeshBasicMaterial;
  private readonly probeMesh: THREE.Mesh;

  private readonly arcAnchorFrom = { lat: 0, lng: 0 };
  private readonly arcAnchorTo = { lat: 0, lng: 0 };
  private hasArcGeometryBuilt = false;

  constructor() {
    this.group.visible = false;
    this.group.add(this.planetRoot);

    // 1. Displaced 3D Mars Sphere (160x80 segments = 12,960 vertices)
    this.sphereGeom = new THREE.SphereGeometry(GLOBE_RADIUS, 160, 80);
    const posAttr = this.sphereGeom.attributes.position as THREE.BufferAttribute;
    const vertCount = posAttr.count;

    this.opticalColors = new Float32Array(vertCount * 3);
    this.topoColors = new Float32Array(vertCount * 3);
    this.thermalColors = new Float32Array(vertCount * 3);

    const tmpCol = new THREE.Color();
    for (let i = 0; i < vertCount; i++) {
      const vx = posAttr.getX(i);
      const vy = posAttr.getY(i);
      const vz = posAttr.getZ(i);
      const mag = Math.hypot(vx, vy, vz) || 1;
      const nx = vx / mag;
      const ny = Math.max(-1, Math.min(1, vy / mag));
      const nz = vz / mag;

      const lat = Math.asin(ny) * RAD_TO_DEG;
      const lng = Math.atan2(-nz, nx) * RAD_TO_DEG;

      const topo = evalPlanetaryTopography(lat, lng);
      const displacedR = GLOBE_RADIUS + topo.elevationMeters * GLOBE_ELEV_SCALE;
      posAttr.setXYZ(i, nx * displacedR, ny * displacedR, nz * displacedR);

      // Optical Mars albedo colors
      let r = 0.72;
      let g = 0.36;
      let b = 0.21;
      const grain = topo.grain;
      if (topo.isPolarCap) {
        if (topo.isSpiralTrough) {
          r = 0.62;
          g = 0.44;
          b = 0.38;
        } else {
          r = 0.91 + grain * 0.08;
          g = 0.93 + grain * 0.06;
          b = 0.96;
        }
      } else if (topo.isOlympus) {
        const summitShade = Math.max(0, (topo.elevationMeters - 12000) / 13000);
        r = 0.56 + summitShade * 0.2 + grain * 0.06;
        g = 0.3 + summitShade * 0.14 + grain * 0.04;
        b = 0.22 + summitShade * 0.12;
      } else if (topo.isTharsisVolcano) {
        r = 0.58 + grain * 0.1;
        g = 0.28 + grain * 0.06;
        b = 0.18;
      } else if (topo.isValles) {
        const depthT = Math.min(1, Math.max(0, (-topo.elevationMeters - 2000) / 8000));
        r = 0.34 - depthT * 0.14 + grain * 0.05;
        g = 0.16 - depthT * 0.06 + grain * 0.03;
        b = 0.12 - depthT * 0.04;
      } else if (topo.isMountSharp) {
        r = 0.74 + grain * 0.12;
        g = 0.49 + grain * 0.08;
        b = 0.31;
      } else if (topo.isGaleCrater) {
        r = 0.46 + grain * 0.08;
        g = 0.28 + grain * 0.06;
        b = 0.2;
      } else if (topo.isHellas) {
        r = 0.78 + grain * 0.12;
        g = 0.51 + grain * 0.08;
        b = 0.34 + grain * 0.04;
      } else if (topo.isSyrtis) {
        r = 0.25 + grain * 0.08;
        g = 0.18 + grain * 0.06;
        b = 0.16;
      } else {
        const eNorm = topo.normElev;
        r = 0.54 + eNorm * 0.3 + (grain - 0.5) * 0.12;
        g = 0.26 + eNorm * 0.16 + (grain - 0.5) * 0.07;
        b = 0.16 + eNorm * 0.08 + (grain - 0.5) * 0.04;
      }
      this.opticalColors[i * 3] = Math.max(0, Math.min(1, r));
      this.opticalColors[i * 3 + 1] = Math.max(0, Math.min(1, g));
      this.opticalColors[i * 3 + 2] = Math.max(0, Math.min(1, b));

      // Topographic MOLA colors
      molaHypsometricColor(topo.normElev, tmpCol);
      this.topoColors[i * 3] = tmpCol.r;
      this.topoColors[i * 3 + 1] = tmpCol.g;
      this.topoColors[i * 3 + 2] = tmpCol.b;

      // Thermal IR colors (polar & high altitudes cold violet/blue; basalt & deep sun-warmed basins orange/gold)
      const latWarmth = Math.cos(lat * DEG_TO_RAD);
      const basaltBoost = topo.isSyrtis ? 0.24 : topo.isValles ? 0.12 : 0;
      const altCool = Math.max(0, topo.elevationMeters / 25000) * 0.35;
      const thermalVal = Math.max(
        0,
        Math.min(1, (topo.isPolarCap ? 0.04 : 0.24 + latWarmth * 0.52 + basaltBoost - altCool) + (grain - 0.5) * 0.08)
      );
      if (thermalVal < 0.35) {
        const t = thermalVal / 0.35;
        this.thermalColors[i * 3] = 0.09 + t * 0.35;
        this.thermalColors[i * 3 + 1] = 0.08 + t * 0.08;
        this.thermalColors[i * 3 + 2] = 0.36 + t * 0.22;
      } else if (thermalVal < 0.7) {
        const t = (thermalVal - 0.35) / 0.35;
        this.thermalColors[i * 3] = 0.44 + t * 0.48;
        this.thermalColors[i * 3 + 1] = 0.16 + t * 0.28;
        this.thermalColors[i * 3 + 2] = 0.58 - t * 0.44;
      } else {
        const t = (thermalVal - 0.7) / 0.3;
        this.thermalColors[i * 3] = 0.92 + t * 0.08;
        this.thermalColors[i * 3 + 1] = 0.44 + t * 0.52;
        this.thermalColors[i * 3 + 2] = 0.14 + t * 0.44;
      }
    }

    posAttr.needsUpdate = true;
    this.sphereGeom.setAttribute('color', new THREE.BufferAttribute(this.opticalColors.slice(), 3));
    this.sphereGeom.computeVertexNormals();
    this.sphereGeom.computeBoundingSphere();

    this.sphereMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.04,
      transparent: true,
      opacity: 1,
    });
    this.sphereMesh = new THREE.Mesh(this.sphereGeom, this.sphereMat);
    this.sphereMesh.receiveShadow = false;
    this.sphereMesh.castShadow = false;
    this.planetRoot.add(this.sphereMesh);

    // 2. Thin CO2 Dusty Atmospheric Limb Halo
    this.haloGeom = new THREE.SphereGeometry(GLOBE_RADIUS * 1.075, 64, 32);
    this.haloMat = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 1.0 },
        uGlowColor: { value: new THREE.Color(0xe68b5e) },
      },
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      vertexShader: `
        varying vec3 vNormalView;
        varying vec3 vViewPos;
        void main() {
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vViewPos = -mvPos.xyz;
          vNormalView = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        uniform vec3 uGlowColor;
        varying vec3 vNormalView;
        varying vec3 vViewPos;
        void main() {
          float viewDot = abs(dot(normalize(vNormalView), normalize(vViewPos)));
          float rim = pow(clamp(1.0 - viewDot, 0.0, 1.0), 2.8);
          gl_FragColor = vec4(uGlowColor * (0.6 + rim * 0.8), rim * 0.58 * uOpacity);
        }
      `,
    });
    this.haloMesh = new THREE.Mesh(this.haloGeom, this.haloMat);
    this.planetRoot.add(this.haloMesh);

    // 3. Deep Space Starfield Backdrop
    const starCount = 900;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const u = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
      const v = ((Math.sin(i * 78.233 + 1.7) * 29431.1234) % 1 + 1) % 1;
      const theta = u * Math.PI * 2;
      const phi = Math.acos(2 * v - 1);
      const r = 6400 + (i % 7) * 180;
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.cos(phi);
      starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    this.starGeom = new THREE.BufferGeometry();
    this.starGeom.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xdbeafe,
      size: 16,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      fog: false,
      depthWrite: false,
    });
    this.starPoints = new THREE.Points(this.starGeom, this.starMat);
    this.starPoints.frustumCulled = false;
    this.group.add(this.starPoints);

    // 4. 3D Planetary Landmark Beacons anchored onto the displaced sphere surface
    this.landmarkGeom = new THREE.OctahedronGeometry(14, 0);
    MARS_PLANETARY_LANDMARKS.forEach((lf) => {
      const cat = LANDFORM_CATEGORY_COLORS[lf.category];
      const mat = new THREE.MeshBasicMaterial({
        color: cat.num,
        transparent: true,
        opacity: 0.92,
        fog: false,
      });
      this.landmarkMaterials.push(mat);
      const mesh = new THREE.Mesh(this.landmarkGeom, mat);
      latLngToGlobeDir(lf.lat, lf.lng, _vDir);
      const r = getGlobeSurfaceRadius(lf.lat, lf.lng) + 22;
      mesh.position.copy(_vDir).multiplyScalar(r);
      _quatPin.setFromUnitVectors(_upLocal, _vDir);
      mesh.quaternion.copy(_quatPin);
      this.landmarkGroup.add(mesh);
    });
    this.planetRoot.add(this.landmarkGroup);

    // 5. Active Rover / Explorer Surface Beacon
    this.roverMarkerGeom = new THREE.SphereGeometry(14, 16, 12);
    this.roverMarkerMat = new THREE.MeshBasicMaterial({
      color: 0x52e0ff,
      transparent: true,
      opacity: 1.0,
      fog: false,
    });
    this.roverMarkerMesh = new THREE.Mesh(this.roverMarkerGeom, this.roverMarkerMat);
    this.planetRoot.add(this.roverMarkerMesh);

    // 6. Orbital Great-Circle Flight Arc & Transit Probe
    this.arcPositions = new Float32Array(this.arcPointsCount * 3);
    this.arcGeom = new THREE.BufferGeometry();
    this.arcGeom.setAttribute('position', new THREE.BufferAttribute(this.arcPositions, 3));
    this.arcMat = new THREE.LineBasicMaterial({
      color: 0x52e0ff,
      transparent: true,
      opacity: 0.92,
      fog: false,
    });
    this.arcLine = new THREE.Line(this.arcGeom, this.arcMat);
    this.arcLine.visible = false;
    this.arcLine.frustumCulled = false;
    this.planetRoot.add(this.arcLine);

    this.probeGeom = new THREE.SphereGeometry(12, 16, 12);
    this.probeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      fog: false,
    });
    this.probeMesh = new THREE.Mesh(this.probeGeom, this.probeMat);
    this.probeMesh.visible = false;
    this.planetRoot.add(this.probeMesh);
  }

  public setSpectralMode(mode: GlobeSpectralMode): void {
    if (mode === this.activeSpectralMode) return;
    this.activeSpectralMode = mode;
    const colAttr = this.sphereGeom.attributes.color as THREE.BufferAttribute;
    const src =
      mode === 'topographic'
        ? this.topoColors
        : mode === 'thermal'
          ? this.thermalColors
          : this.opticalColors;
    (colAttr.array as Float32Array).set(src);
    colAttr.needsUpdate = true;
    this.haloMat.uniforms.uGlowColor.value.setHex(
      mode === 'topographic' ? 0x38bdf8 : mode === 'thermal' ? 0x9333ea : 0xe68b5e
    );
  }

  /**
   * Rotates the 3D Mars sphere so `(lat, lng)` rests directly beneath world (0, 0, 0)
   * with surface normal along +Y, local North along -Z, and local East along +X.
   */
  public orientAt(lat: number, lng: number, localSurfaceOffsetY = 0): void {
    latLngToGlobeDir(lat, lng, _vDir).normalize();
    const latR = Math.max(-89.99, Math.min(89.99, lat)) * DEG_TO_RAD;
    const lngR = normalizeSignedLng180(lng) * DEG_TO_RAD;
    // East unit vector in globe-local space: d(pos)/dlng normalized = (-sin(lng), 0, -cos(lng))
    _vEast.set(-Math.sin(lngR), 0, -Math.cos(lngR)).normalize();
    // -North unit vector (= East x Up)
    _vNegNorth.crossVectors(_vEast, _vDir).normalize();

    // Wait: re-orthogonalize East = Up x (-North) for numerical precision at extreme latitudes
    _vEast.crossVectors(_vDir, _vNegNorth).normalize();

    // Matrix4.makeBasis puts columns [X=east, Y=up, Z=-north]; transpose maps local -> world
    _matBasis.makeBasis(_vEast, _vDir, _vNegNorth).transpose();
    this.planetRoot.quaternion.setFromRotationMatrix(_matBasis);

    const surfR = getGlobeSurfaceRadius(lat, lng);
    this.planetRoot.position.set(0, -surfR + localSurfaceOffsetY, 0);

    // Update live rover pin on the displaced planet surface
    this.roverMarkerMesh.position.copy(_vDir).multiplyScalar(surfR + 12);

    // Keep starfield subtly aligned with planet rotation
    this.starPoints.quaternion.copy(this.planetRoot.quaternion);
    void latR;
  }

  public setFlightArc(
    fromLL: { lat: number; lng: number } | null,
    toLL: { lat: number; lng: number } | null,
    progress: number
  ): void {
    if (!fromLL || !toLL) {
      this.arcLine.visible = false;
      this.probeMesh.visible = false;
      this.hasArcGeometryBuilt = false;
      return;
    }

    const distKm = marsDistanceKm(fromLL, toLL);
    if (distKm < 25) {
      this.arcLine.visible = false;
      this.probeMesh.visible = false;
      return;
    }

    const sameAnchors =
      this.hasArcGeometryBuilt &&
      Math.abs(this.arcAnchorFrom.lat - fromLL.lat) < 0.01 &&
      Math.abs(this.arcAnchorFrom.lng - fromLL.lng) < 0.01 &&
      Math.abs(this.arcAnchorTo.lat - toLL.lat) < 0.01 &&
      Math.abs(this.arcAnchorTo.lng - toLL.lng) < 0.01;

    const maxArchHeight = Math.min(360, Math.max(95, distKm * 0.06));

    if (!sameAnchors) {
      this.arcAnchorFrom.lat = fromLL.lat;
      this.arcAnchorFrom.lng = fromLL.lng;
      this.arcAnchorTo.lat = toLL.lat;
      this.arcAnchorTo.lng = toLL.lng;
      this.hasArcGeometryBuilt = true;

      const posAttr = this.arcGeom.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < this.arcPointsCount; i++) {
        const t = i / (this.arcPointsCount - 1);
        const pt = slerpLatLng(fromLL, toLL, t);
        latLngToGlobeDir(pt.lat, pt.lng, _vWork);
        const surfR = getGlobeSurfaceRadius(pt.lat, pt.lng);
        const r = surfR + 14 + Math.sin(Math.PI * t) * maxArchHeight;
        posAttr.setXYZ(i, _vWork.x * r, _vWork.y * r, _vWork.z * r);
      }
      posAttr.needsUpdate = true;
      this.arcGeom.computeBoundingSphere();
    }

    const clampedP = Math.max(0, Math.min(1, progress));
    const curPt = slerpLatLng(fromLL, toLL, clampedP);
    latLngToGlobeDir(curPt.lat, curPt.lng, _vWork);
    const curSurfR = getGlobeSurfaceRadius(curPt.lat, curPt.lng);
    const curR = curSurfR + 14 + Math.sin(Math.PI * clampedP) * maxArchHeight;
    this.probeMesh.position.copy(_vWork).multiplyScalar(curR);

    this.arcLine.visible = true;
    this.probeMesh.visible = true;
  }

  public setOpacity(alpha: number): void {
    const a = Math.max(0, Math.min(1, alpha));
    this.group.visible = a > 0.02;
    this.sphereMat.opacity = a;
    this.haloMat.uniforms.uOpacity.value = a;
    this.starMat.opacity = a * 0.85;
    this.roverMarkerMat.opacity = a;
    this.arcMat.opacity = a * 0.92;
    this.probeMat.opacity = a * 0.95;
    for (let i = 0; i < this.landmarkMaterials.length; i++) {
      this.landmarkMaterials[i].opacity = a * 0.92;
    }
  }

  public dispose(): void {
    this.sphereGeom.dispose();
    this.sphereMat.dispose();
    this.haloGeom.dispose();
    this.haloMat.dispose();
    this.starGeom.dispose();
    this.starMat.dispose();
    this.landmarkGeom.dispose();
    for (let i = 0; i < this.landmarkMaterials.length; i++) {
      this.landmarkMaterials[i].dispose();
    }
    this.roverMarkerGeom.dispose();
    this.roverMarkerMat.dispose();
    this.arcGeom.dispose();
    this.arcMat.dispose();
    this.probeGeom.dispose();
    this.probeMat.dispose();
  }
}
