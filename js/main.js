import * as THREE from "https://cdn.skypack.dev/three@0.129.0/build/three.module.js";
import { GLTFLoader } from "https://cdn.skypack.dev/three@0.129.0/examples/jsm/loaders/GLTFLoader.js";

// =====================
// SCENE / RENDERER
// =====================
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  50000 // large far clip so big maps are visible
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

// =====================
// SKYBOX (keep / replace as you like)
// =====================
const cubeLoader = new THREE.CubeTextureLoader();
const skybox = cubeLoader.setPath("textures/skybox/").load([
  "px.png", "nx.png",
  "py.png", "ny.png",
  "pz.png", "nz.png",
]);
scene.background = skybox;

// =====================
// LIGHTING
// =====================
const hemiLight = new THREE.HemisphereLight(0xffeebb, 0x444466, 0.9);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
dirLight.castShadow = true;
dirLight.position.set(0, 50, 0);
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 300;
const shadowRange = 120;
dirLight.shadow.camera.left = -shadowRange;
dirLight.shadow.camera.right = shadowRange;
dirLight.shadow.camera.top = shadowRange;
dirLight.shadow.camera.bottom = -shadowRange;
dirLight.shadow.bias = -0.0005;
scene.add(dirLight);

// =====================
// RAYCAST + GLOBAL STATE
// =====================
const raycaster = new THREE.Raycaster();
const downVector = new THREE.Vector3(0, -1, 0);

let car;           // the GLTF model (visuals)
let carRig;        // empty Object3D that moves/rotates
let trackMesh;

let angle = 0;     // heading (radians)
let velocity = 0;  // forward speed
let yawSlip = 0;   // drift angle contribution
let lastSlideTime = 0;
let oppositeSteerStartTime = null;
let gripRL = 1, gripRR = 1; // add near your other globals


let wheelFL, wheelFR, wheelRL, wheelRR;
let wheelFL_spinPivot, wheelFR_spinPivot, wheelRL_spinPivot, wheelRR_spinPivot;
let handbrake = false;

const keys = {};

// movement tuning (close to what you had)
const maxSpeed = 350 / 36;             // ~9.17 (km/h -> "scene units"/frame-ish)
const acceleration = maxSpeed / (5 * 60);
const friction = 0.02;
const turnSpeed = 0.02;
const slipFactor = 0.001;

// camera follows
let camYaw = 0;
let camPitch = 15 * Math.PI / 180;
let camDistance = 25;
let lastDragTime = Date.now();
let isDragging = false;
let lastMouse = { x: 0, y: 0 };

// =====================
// LOAD CAR
// =====================
const loader = new GLTFLoader();
loader.load(
  "./models/m4f821/scene.glb",
  (gltf) => {
    // make rig and mount car under it
    carRig = new THREE.Object3D();
    scene.add(carRig);
    carRig.position.set(0, 0, 0);


    car = gltf.scene;
    car.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = false;
      }
    });

    // scale car model (not the rig)
    car.scale.set(500, 500, 500);
    car.position.set(0, 0, 0);
    carRig.add(car);

    // find wheels if present (safe guards)
    wheelFL_spinPivot = car.getObjectByName("wheel_FL_spinPivot");
    wheelFR_spinPivot = car.getObjectByName("wheel_FR_spinPivot");
    wheelRL_spinPivot = car.getObjectByName("wheel_RL_spinPivot");
    wheelRR_spinPivot = car.getObjectByName("wheel_RR_spinPivot");
    wheelFL = wheelFL_spinPivot?.children.find((c) => c.name === "wheel_FL");
    wheelFR = wheelFR_spinPivot?.children.find((c) => c.name === "wheel_FR");
    wheelRL = wheelRL_spinPivot?.children.find((c) => c.name === "wheel_RL");
    wheelRR = wheelRR_spinPivot?.children.find((c) => c.name === "wheel_RR");

    // start camera above origin
    camera.position.set(0, 15, 25);
    camera.lookAt(0, 0, 0);
  },
  (xhr) => console.log(`Car ${(xhr.loaded / xhr.total) * 100}% loaded`),
  (err) => console.error("Model load error:", err)
);

// =====================
// LOAD TRACK
// =====================
const trackLoader = new GLTFLoader();
trackLoader.load(
  "./maps/city/burnin_rubber_crash_n_burn_city.glb",
  (gltf) => {
    trackMesh = gltf.scene;

    trackMesh.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.material.side = THREE.DoubleSide;
        if (child.material.map) {
          child.material.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
        }
      }
    });

    // scale/position — adjust as needed for your asset
    trackMesh.scale.set(500, 500, 500);
    trackMesh.position.set(0, 0, 0);
    scene.add(trackMesh);

    // optional: place camera above the map for first view
    camera.position.set(0, 300, 600);
    camera.lookAt(0, 0, 0);
  },
  (xhr) => console.log(`Track ${(xhr.loaded / xhr.total) * 100}% loaded`),
  (err) => console.error("Track load error:", err)
);

// =====================
// INPUT
// =====================
document.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (e.code === "Space") handbrake = true;
});
document.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  keys[k] = false;
  if (e.code === "Space") handbrake = false;
});

// mouse camera orbit
document.addEventListener("mousedown", (e) => {
  if (e.button === 0) {
    isDragging = true;
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
  }
  if (e.button === 2) {
    camYaw = angle;
    camPitch = 15 * Math.PI / 180;
    lastDragTime = 0;
  }
});
document.addEventListener("mouseup", (e) => {
  if (e.button === 0) {
    isDragging = false;
    lastDragTime = Date.now();
  }
});
document.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  const dx = e.clientX - lastMouse.x;
  const dy = e.clientY - lastMouse.y;
  lastMouse = { x: e.clientX, y: e.clientY };
  camYaw -= dx * 0.005;
  camPitch += dy * 0.005;
  camPitch = THREE.MathUtils.clamp(camPitch, 0.1, Math.PI / 2 - 0.1);
});
document.addEventListener("wheel", (e) => {
  camDistance += e.deltaY * 0.01;
  camDistance = THREE.MathUtils.clamp(camDistance, 5, 35);
});
document.addEventListener("contextmenu", (e) => e.preventDefault());

// =====================
// CAR CONTROL LOOP
// =====================
function updateCarControls() {
  if (!carRig) return;

  
    // === Constants based on real M4 F82 ===
    const realWheelbase = 2.812; // meters
    const realTurnRadius = 5.5;  // meters (manufacturer spec)
    const sceneScale = 5;        // your model is scaled by 500x and scene units are 1/100m
    const scaleFactor = 1 / sceneScale;
    const wheelbase = realWheelbase / scaleFactor;
    const minRadius = realTurnRadius / scaleFactor;
  
    // === Throttle and Braking ===
    if (handbrake) {
      // Apply strong deceleration
      velocity *= 0.98; // stronger slow down
      gripRL = gripRR = 0.5; // simulate sliding rear wheels
    } else {
      gripRL = gripRR = 1.0;
  
      if (keys['w']) {
        const isDrifting = Math.abs(yawSlip) > 0.01;
        const accel = isDrifting ? acceleration * gripRR : acceleration; // weaker push while drifting
        velocity = Math.min(maxSpeed, velocity + accel);
      }
  
      if (keys['s']) velocity = Math.max(-maxSpeed, velocity - acceleration);
      if (!keys['w'] && !keys['s']) {
        velocity *= (1 - friction);
        if (Math.abs(velocity) < 0.001) velocity = 0;
      }
    }
  
    const direction = Math.sign(velocity || 1); // 1 = forward, -1 = reverse
    let steerAngle = 0;
  
    // === Velocity-dependent steering angle ===
  const velocityAbs = Math.abs(velocity);
  const velocityMS = velocity * 4.16; // convert to meters/second (scene scale)
  
  const maxSteerDeg = Math.PI / 6;  // ~30° at low speed
  const minSteerDeg = Math.PI / 25; // ~10° at high speed
  const maxSpeedMS = 40;            // 144 km/h ~ upper bound of adjustment
  
  // Linearly interpolate between max and min steering angles
  const steerLimiter = Math.min(1, velocityMS / maxSpeedMS);
  const adaptiveSteerAngle = maxSteerDeg - (maxSteerDeg - minSteerDeg) * steerLimiter;
  
  // Assign based on key input and driving direction
  steerAngle = 0;
  if (keys['a']) steerAngle = adaptiveSteerAngle;
  if (keys['d']) steerAngle = -adaptiveSteerAngle;
  
  
    const maxLateralAcc = 1.07; // 1g in m/s²
  
    let effectiveRadius = velocityMS ** 2 / maxLateralAcc;
    effectiveRadius = Math.max(minRadius, effectiveRadius);
  
    // === Update heading (Grip vs Drift logic) ===
  if (Math.abs(yawSlip) < 0.001) {
    // === GRIP MODE: normal steering
    if ((keys['a']) && velocity !== 0) {
      const omega = direction * velocity / effectiveRadius;
      angle += omega * direction;
    }
  
    if ((keys['d']) && velocity !== 0) {
      const omega = direction * velocity / effectiveRadius;
      angle -= omega * direction;
    }
  } else {
    // === DRIFT MODE: A/D tweak yawSlip AND slightly affect turn rate
    const yawSign = Math.sign(yawSlip);
    const steerLeft = keys['a'];
    const steerRight = keys['d'];
    const driftAdjustStrength = 0.0002; // tweak to taste
    const flickStrength = 0.009;
  
    // 1. Drift flick — adjust yawSlip slightly
    if (steerLeft) yawSlip += flickStrength;
    if (steerRight) yawSlip -= flickStrength;
    yawSlip = THREE.MathUtils.clamp(yawSlip, -0.18, 0.18);
  
    // 2. Adjust actual turning angle (angle +=) based on steering during drift
    if (steerLeft && yawSign < 0) {
      angle -= driftAdjustStrength; // reduce turn rate
    } else if (steerLeft && yawSign > 0) {
      angle += driftAdjustStrength; // increase turn rate
    }
  
    if (steerRight && yawSign > 0) {
      angle -= driftAdjustStrength; // reduce turn rate
    } else if (steerRight && yawSign < 0) {
      angle += driftAdjustStrength; // increase turn rate
    }
  }
  
  
    if (Math.abs(yawSlip) > 0.001) {
    const driftDir = Math.sign(yawSlip);
  
    // Apply steering only if in the same direction
    if ((driftDir > 0 && keys['a']) || (driftDir < 0 && keys['d'])) {
      // Same direction – intensify drift slightly
      const steerAmount = turnSpeed * 1.5 * driftDir;
      angle += steerAmount;
    } else if ((driftDir > 0 && keys['d']) || (driftDir < 0 && keys['a'])) {
      // Opposite direction – reduce yawSlip instead of turning
      yawSlip *= 0.90; // slowly reduce slip
      // Optionally clamp to zero smoothly
      if (Math.abs(yawSlip) < 0.01) yawSlip = 0;
    }
  }
  
  
  // === Drift Logic ===
  const isDrifting = Math.abs(yawSlip) > 0.001;
  const steeringLeft = keys['a'];
  const steeringRight = keys['d'];
  const oppositePressed = (yawSlip > 0 && steeringRight) || (yawSlip < 0 && steeringLeft);
  const sameDirection = (yawSlip > 0 && steeringLeft) || (yawSlip < 0 && steeringRight);
  
  const driftInitiated = handbrake && (steeringLeft || steeringRight) && Math.abs(velocity) > 0.5;
  
  if (driftInitiated) {
    const slipDir = steeringLeft ? 1 : -1;
    const speedFactor = THREE.MathUtils.clamp(velocity / 2.5, 0.4, 1.2); // stronger at low speeds
    const slipTarget = velocity * 0.15 * slipDir * speedFactor;
    yawSlip += (slipTarget - yawSlip) * 0.05;
    yawSlip = THREE.MathUtils.clamp(yawSlip, -0.18, 0.18);
    lastSlideTime = Date.now();
  }
  
  // === Maintain or decay yawSlip ===
  if (isDrifting) {
    const timeSinceSlide = (Date.now() - lastSlideTime) / 1000;
    const decayRate = Math.max(0.005, 1 - velocity / maxSpeed);
    const speedMS = velocity * 4.16;
    const lowSpeedThreshold = 13.88; // 50 km/h in m/s
  
    const exitConditionsMet = !keys['w'] && (oppositePressed || speedMS < lowSpeedThreshold);
  
    
  
    if (!keys['w']) {
      yawSlip *= (1 - decayRate * 0.015);
    } else {
      // At low speed, yaw changes quicker (more torque effect)
      const torqueFactor = THREE.MathUtils.clamp(1 / (velocity + 0.2), 0.8, 4.0); // faster at low speeds
      yawSlip += slipFactor * 0.92 * torqueFactor * Math.sign(yawSlip);
      yawSlip = THREE.MathUtils.clamp(yawSlip, -0.18, 0.18);
    }
  
    // Opposite steering held OR low speed with no gas
  if (!keys['w'] && (oppositePressed || velocity * 4.16 < 13.88)) {
    if (!oppositeSteerStartTime) {
      oppositeSteerStartTime = Date.now();
    } else {
      const heldTime = Date.now() - oppositeSteerStartTime;
  
      // Fade time based on yawSlip (0.2s to 1.0s)
      const fadeDuration = THREE.MathUtils.mapLinear(
        Math.abs(yawSlip),
        0.02, 0.18,
        1000, 3000
      );
      const fadeRatio = THREE.MathUtils.clamp(heldTime / fadeDuration, 0, 1);
  
      yawSlip *= 1 - fadeRatio;
  
      if (fadeRatio >= 1 || Math.abs(yawSlip) < 0.002) {
        yawSlip = 0;
        angle = Math.atan2(Math.sin(angle), Math.cos(angle)); // normalize
        oppositeSteerStartTime = null;
      }
    }
  } else {
    oppositeSteerStartTime = null;
  }
  
    // Passive drift angle influence if no steering input
    if (!steeringLeft && !steeringRight) {
      const driftAssist = 0.012 * Math.sign(yawSlip);
      angle += driftAssist;
    }
  }
  
  
    // === Determine pivot point for rotation ===
    const halfWheelbase = wheelbase / 2;
    let pivotOffset = 0;
  
    // Rear axle for grip driving, front axle for drifting
    if (Math.abs(yawSlip) > 0.001) {
      // Drifting — pivot around front axle
      pivotOffset = halfWheelbase;
    } else {
      // Normal driving — pivot around rear axle
      pivotOffset = -halfWheelbase;
    }
  
    // Offset before rotation
    const offsetX = -Math.sin(angle + yawSlip) * pivotOffset;
    const offsetZ = -Math.cos(angle + yawSlip) * pivotOffset;
  
    // Apply pre-rotation offset
    carRig.position.x += offsetX;
    carRig.position.z += offsetZ;
  
    // Apply rotation
    
    carRig.rotation.y = angle + yawSlip*5;
  
    // Move car forward
    const dx = Math.sin(angle + yawSlip) * velocity;
    const dz = Math.cos(angle + yawSlip) * velocity;
    carRig.position.x += dx - offsetX;
    carRig.position.z += dz - offsetZ;

/*working raycast code*/
  // === throttle & braking ===
  // if (handbrake) {
  //   velocity *= 0.98;
  // } else {
  //   if (keys["w"]) velocity = Math.min(maxSpeed, velocity + acceleration);
  //   if (keys["s"]) velocity = Math.max(-maxSpeed, velocity - acceleration);
  //   if (!keys["w"] && !keys["s"]) {
  //     velocity *= 1 - friction;
  //     if (Math.abs(velocity) < 0.001) velocity = 0;
  //   }
  // }

  // // === steering (adaptive) ===
  // const vMS = velocity * 4.16;
  // const maxSteer = Math.PI / 6;
  // const minSteer = Math.PI / 25;
  // const steerLimiter = Math.min(1, vMS / 40);
  // const adaptiveSteer = maxSteer - (maxSteer - minSteer) * steerLimiter;

  // let steerAngle = 0;
  // if (keys["a"]) steerAngle = adaptiveSteer;
  // if (keys["d"]) steerAngle = -adaptiveSteer;

  // // basic yaw update (you can keep your drift logic if you like)
  // if (velocity !== 0) {
  //   angle += (velocity / 50) * steerAngle; // simple curvature; tweak denominator to taste
  // }

  // // === planar motion (XZ) ===
  // const dx = Math.sin(angle + yawSlip) * velocity;
  // const dz = Math.cos(angle + yawSlip) * velocity;
  // carRig.position.x += dx;
  // carRig.position.z += dz;
  /*end of working raycast*/

// === RAYCAST: stick to ground & orient ===
if (trackMesh) {
  // 1) Center ray under the car
  const rayOrigin = carRig.position.clone().add(new THREE.Vector3(0, 200, 0));
  raycaster.set(rayOrigin, downVector);
  const hits = raycaster.intersectObject(trackMesh, true);

  if (hits.length > 0) {
    // NEW: choose the closest hit that is <= current car Y (so ignore bridge ceilings)
    const currentY = carRig.position.y + 0.5; // small tolerance
    let hit = hits.find(h => h.point.y <= currentY);
    if (!hit) hit = hits[0]; // fallback to first if none qualify

    // 2) Ray a bit AHEAD to tell uphill vs downhill
    const forward = new THREE.Vector3(
      Math.sin(angle + yawSlip), 0, Math.cos(angle + yawSlip)
    ).normalize();

    const FORWARD_SAMPLE_DIST = 12;   // ≈ half–one car length
    const SLOPE_THRESHOLD     = 0.05; // y-diff to consider it a slope
    const VERTICAL_THRESHOLD  = 1.5;  // treat as "vertical wall" if y change > this without slope

    const aheadOrigin = carRig.position.clone()
      .add(forward.clone().multiplyScalar(FORWARD_SAMPLE_DIST))
      .add(new THREE.Vector3(0, 200, 0));

    raycaster.set(aheadOrigin, downVector);
    const aheadHits = raycaster.intersectObject(trackMesh, true);

    let isUphill = false, isDownhill = false;
    if (aheadHits.length > 0) {
      // also filter by <= currentY
      let aheadHit = aheadHits.find(h => h.point.y <= currentY);
      if (!aheadHit) aheadHit = aheadHits[0];

      const dy = aheadHit.point.y - hit.point.y; // +dy => ground ahead is higher
      if (Math.abs(dy) <= VERTICAL_THRESHOLD) {
        isUphill   = dy >  SLOPE_THRESHOLD;
        isDownhill = dy < -SLOPE_THRESHOLD;
      }
    }

    // 3) Height follow (+0.5 extra if uphill)
    const baseTargetY = hit.point.y;
    const heightOffset = (isUphill ? 0.45 : 0.0);
    const targetY = baseTargetY + heightOffset;
    carRig.position.y += (targetY - carRig.position.y) * 0.35;

    // 4) Surface normal (world space) and blended tilt
    const worldNormal = hit.face.normal.clone()
      .transformDirection(hit.object.matrixWorld)
      .normalize();

    const TILT_BLEND = 0.75; // resist over-banking
    const blendedNormal = new THREE.Vector3(0, 1, 0)
      .lerp(worldNormal, TILT_BLEND)
      .normalize();

    // tilt to the (blended) slope normal
    const tiltQ = new THREE.Quaternion()
      .setFromUnitVectors(new THREE.Vector3(0, 1, 0), blendedNormal);

    // 5) Downhill pitch correction: nose-up
    const PITCH_CORR_DEG = 5;
    const rightAxis = new THREE.Vector3().crossVectors(forward, blendedNormal).normalize();
    const pitchBiasQ = (isDownhill && rightAxis.lengthSq() > 1e-6)
      ? new THREE.Quaternion().setFromAxisAngle(rightAxis, THREE.MathUtils.degToRad(PITCH_CORR_DEG))
      : new THREE.Quaternion(); // identity

    // yaw around the slope normal
    const yawQ = new THREE.Quaternion()
      .setFromAxisAngle(blendedNormal, angle + yawSlip);

    // final orientation: tilt -> pitchBias -> yaw
    const tiltPitchQ = new THREE.Quaternion().multiplyQuaternions(tiltQ, pitchBiasQ);
    const targetQ = new THREE.Quaternion().multiplyQuaternions(tiltPitchQ, yawQ);

    // carRig.quaternion.slerp(targetQ, 0.9);
  }
}




  // === wheel visuals ===
  const wheelSpinSpeed = velocity / 1.5;
  if (wheelFL) wheelFL.rotation.x += wheelSpinSpeed;
  if (wheelFR) wheelFR.rotation.x += wheelSpinSpeed;
  if (wheelRL && !handbrake) wheelRL.rotation.x += wheelSpinSpeed;
  if (wheelRR && !handbrake) wheelRR.rotation.x += wheelSpinSpeed;

    let visualSteer = steerAngle;

if (Math.abs(yawSlip) > 0.001) {
  // Base countersteer visual during drift
  visualSteer = -yawSlip * 5;

  // Determine drift direction vs input
  const driftDirection = Math.sign(yawSlip);
  const inputDirection = (steeringLeft ? 1 : 0) - (steeringRight ? 1 : 0);

  if (inputDirection !== 0) {
    if (inputDirection === driftDirection) {
      visualSteer *= 0.75; // same direction — reduce
    } else {
      visualSteer *= 1.25; // opposite direction — exaggerate
    }
  }
}

// Apply to wheels
if (wheelFL_spinPivot) wheelFL_spinPivot.rotation.y = visualSteer;
if (wheelFR_spinPivot) wheelFR_spinPivot.rotation.y = visualSteer;

  // light follow
  dirLight.position.set(carRig.position.x + 10, carRig.position.y + 25, carRig.position.z + 10);
  dirLight.target.position.copy(carRig.position);
  dirLight.target.updateMatrixWorld();
}

// =====================
// CAMERA FOLLOW
// =====================
let cameraMode = "third";
function updateCamera() {
  if (!carRig) return;

  const now = Date.now();
  const timeSinceDrag = now - lastDragTime;

  if (cameraMode === "third") {
    let offset = 0;
    const lagAngle = 0.06;

    if (!isDragging && timeSinceDrag > 200) {
      if (keys["a"] && !keys["d"]) offset = -lagAngle;
      else if (keys["d"] && !keys["a"]) offset = lagAngle;
    }

    const targetYaw = angle + offset;
    const t = Math.min(1, (timeSinceDrag - 200) / 1000);
    if (!isDragging && timeSinceDrag > 200) {
      camYaw = THREE.MathUtils.lerp(camYaw, targetYaw, t);
      camPitch = THREE.MathUtils.lerp(camPitch, Math.PI / 12, t);
    }

    const camX = carRig.position.x - Math.sin(camYaw) * camDistance * Math.cos(camPitch);
    const camY = carRig.position.y + Math.sin(camPitch) * camDistance;
    const camZ = carRig.position.z - Math.cos(camYaw) * camDistance * Math.cos(camPitch);

    camera.position.set(camX, camY, camZ);
    camera.lookAt(carRig.position);

  } else {
    // simple first-person variant if you toggle later
    const camOffset = new THREE.Vector3(1.95, 5.5, -1);
    const camPos = camOffset.clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), angle)
      .add(carRig.position);
    camera.position.copy(camPos);
    const lookTarget = new THREE.Vector3(Math.sin(camYaw), Math.sin(camPitch), Math.cos(camYaw))
      .multiplyScalar(10).add(camera.position);
    camera.lookAt(lookTarget);
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "c") {
    cameraMode = (cameraMode === "third") ? "first" : "third";
  }
});

// =====================
// MAIN LOOP
// =====================
function animate() {
  requestAnimationFrame(animate);
  updateCarControls();
  updateCamera();
  renderer.render(scene, camera);
}
animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
