import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/**
 * EVA astronaut figure: a rigid GLB model (public/models/astronaut.glb, Draco-compressed) tinted
 * orange, with whole-body walk / idle motion, a slope lean, a helmet lamp and suit status lights.
 * The model has no skeleton, so all motion is applied to pivots above it.
 *
 * Hierarchy: group (position + yaw, set by the caller) -> tiltPivot (slope lean)
 *            -> bodyPivot (bob / rock / sway) -> model + lights.
 */

const TARGET_HEIGHT_M = 1.9;
const SUIT_TINT = 0xf97316;
const SUIT_MATERIAL_NAME = 'astnt1_1';
const WALK_REF_SPEED_MPS = 1.6; // speed at which the walk motion reaches full amplitude
const STEP_LENGTH_M = 0.75;
const MAX_STEP_RATE = 9; // rad/s cap so fast traverses don't turn the bob into a buzz
const SLOPE_LEAN_STRENGTH = 0.35;
const MAX_LEAN_RAD = THREE.MathUtils.degToRad(14);
const LAMP_INTENSITY = 5;

const STATUS_OK = 0x34d399;
const STATUS_FAULT = 0xff3b30;

export interface MarsAstronautUpdate {
  delta: number;
  elapsed: number;
  speedMps: number;
  /** World-space terrain normal under the astronaut. */
  terrainNormal: THREE.Vector3;
  headingRad: number;
  headlightsOn: boolean;
  /** 0..1 lamp power multiplier (battery brownout flicker). */
  brownout: number;
  damaged: boolean;
}

export interface MarsAstronaut {
  group: THREE.Group;
  update(params: MarsAstronautUpdate): void;
  dispose(): void;
}

const _up = new THREE.Vector3(0, 1, 0);
const _localNormal = new THREE.Vector3();
const _leanDir = new THREE.Vector3();
const _leanQuat = new THREE.Quaternion();

export function createMarsAstronaut(baseUrl: string = import.meta.env.BASE_URL ?? '/'): MarsAstronaut {
  const group = new THREE.Group();
  const tiltPivot = new THREE.Group();
  const bodyPivot = new THREE.Group();
  group.add(tiltPivot);
  tiltPivot.add(bodyPivot);

  // Contact shadow stays on the ground while the body bobs
  const shadowGeom = new THREE.CircleGeometry(0.75, 24);
  shadowGeom.rotateX(-Math.PI / 2);
  const contactShadow = new THREE.Mesh(
    shadowGeom,
    new THREE.MeshBasicMaterial({ color: 0x050304, transparent: true, opacity: 0.4, depthWrite: false })
  );
  contactShadow.position.y = 0.04;
  group.add(contactShadow);

  // Placeholder shown until the GLB finishes loading (and kept if it fails)
  const placeholder = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.3, TARGET_HEIGHT_M - 0.6, 4, 10),
    new THREE.MeshStandardMaterial({ color: SUIT_TINT, roughness: 0.7, metalness: 0.05 })
  );
  placeholder.position.y = TARGET_HEIGHT_M / 2;
  bodyPivot.add(placeholder);

  // Helmet lamp: spotlight + two visible lamp housings beside the visor
  const helmetLamp = new THREE.SpotLight(0xe0f2fe, 0, 60, Math.PI / 5.5, 0.5, 1.4);
  helmetLamp.position.set(0, 1.78, 0.2);
  const lampTarget = new THREE.Object3D();
  lampTarget.position.set(0, 0.4, 14);
  bodyPivot.add(lampTarget);
  helmetLamp.target = lampTarget;
  bodyPivot.add(helmetLamp);

  const lampMat = new THREE.MeshBasicMaterial({ color: 0x334155 });
  const lampGeom = new THREE.SphereGeometry(0.035, 10, 8);
  for (const side of [-1, 1]) {
    const lamp = new THREE.Mesh(lampGeom, lampMat);
    lamp.position.set(side * 0.19, 1.72, 0.1);
    bodyPivot.add(lamp);
  }

  // Suit status lights on the life-support backpack
  const statusMat = new THREE.MeshBasicMaterial({ color: STATUS_OK });
  const statusGeom = new THREE.SphereGeometry(0.025, 8, 6);
  for (const side of [-1, 1]) {
    const light = new THREE.Mesh(statusGeom, statusMat);
    light.position.set(side * 0.1, 1.42, -0.36);
    bodyPivot.add(light);
  }

  let disposed = false;
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(`${baseUrl}draco/`);
  const gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);

  gltfLoader.load(
    `${baseUrl}models/astronaut.glb`,
    (gltf) => {
      const model = gltf.scene;
      if (disposed) {
        disposeObject(model);
        return;
      }

      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = TARGET_HEIGHT_M / Math.max(size.y, 1e-6);

      // Scale to human height, feet on y = 0, centred on x/z
      const holder = new THREE.Group();
      holder.scale.setScalar(scale);
      holder.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
      holder.add(model);

      let tinted = false;
      const materials: THREE.MeshStandardMaterial[] = [];
      model.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.castShadow = true;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (mat instanceof THREE.MeshStandardMaterial && !materials.includes(mat)) materials.push(mat);
        }
      });
      for (const mat of materials) {
        if (mat.name === SUIT_MATERIAL_NAME) {
          mat.color.setHex(SUIT_TINT);
          mat.roughness = 0.7;
          tinted = true;
        } else {
          // Visor: keep the gold, make it glint
          mat.roughness = 0.18;
          mat.metalness = 0.75;
        }
      }
      if (!tinted && materials.length > 0) {
        materials[0].color.setHex(SUIT_TINT);
        materials[0].roughness = 0.7;
        materials[0].metalness = 0;
      }

      bodyPivot.remove(placeholder);
      disposeObject(placeholder);
      bodyPivot.add(holder);
    },
    undefined,
    (err) => {
      console.warn('[marsAstronaut] Failed to load astronaut model; keeping placeholder.', err);
    }
  );

  let walkBlend = 0;
  let stepPhase = 0;

  const update = (p: MarsAstronautUpdate) => {
    const speed = Math.abs(p.speedMps);
    walkBlend = THREE.MathUtils.damp(walkBlend, Math.min(1, speed / WALK_REF_SPEED_MPS), 7, p.delta);
    // One step (half a stride cycle) per STEP_LENGTH_M travelled
    stepPhase += Math.min(MAX_STEP_RATE, (speed / STEP_LENGTH_M) * Math.PI) * p.delta;
    const w = walkBlend;
    const idle = 1 - w;

    // Walking: bounce twice per stride, rock side to side once per stride, lean into the walk
    const bob = Math.abs(Math.sin(stepPhase)) * 0.07 * w;
    const rock = Math.sin(stepPhase) * 0.075 * w;
    const twist = Math.sin(stepPhase) * 0.06 * w;
    const forwardLean = 0.09 * w;

    // Idle: slow breathing and a gentle weight shift
    const breathe = Math.sin(p.elapsed * 1.5) * 0.008 * idle;
    const sway = Math.sin(p.elapsed * 0.55) * 0.02 * idle;
    const nod = Math.sin(p.elapsed * 0.8 + 1.3) * 0.012 * idle;

    bodyPivot.position.y = bob + breathe;
    bodyPivot.rotation.set(forwardLean + nod, twist, rock + sway);

    // Slope lean: bring the terrain normal into the yawed local frame, follow it part-way
    _localNormal.copy(p.terrainNormal).applyAxisAngle(_up, -p.headingRad);
    _leanDir.copy(_up).lerp(_localNormal, SLOPE_LEAN_STRENGTH).normalize();
    _leanQuat.setFromUnitVectors(_up, _leanDir);
    const leanAngle = 2 * Math.acos(Math.min(1, Math.abs(_leanQuat.w)));
    if (leanAngle > MAX_LEAN_RAD) {
      _leanQuat.slerp(tiltIdentity, 1 - MAX_LEAN_RAD / leanAngle);
    }
    tiltPivot.quaternion.slerp(_leanQuat, 1 - Math.exp(-8 * p.delta));

    const lampOn = p.headlightsOn && p.brownout > 0.2;
    helmetLamp.intensity = p.headlightsOn ? LAMP_INTENSITY * p.brownout : 0;
    lampMat.color.setHex(lampOn ? 0xe0f2fe : 0x334155);

    if (p.damaged) {
      statusMat.color.setHex(Math.sin(p.elapsed * 10) > 0 ? STATUS_FAULT : 0x450a0a);
    } else {
      statusMat.color.setHex(STATUS_OK);
    }
  };

  const dispose = () => {
    disposed = true;
    disposeObject(group);
    dracoLoader.dispose();
  };

  return { group, update, dispose };
}

const tiltIdentity = new THREE.Quaternion();

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry?.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const value of Object.values(mat)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      mat.dispose();
    }
  });
}
