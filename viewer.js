import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SplatMesh, SparkRenderer } from "@sparkjsdev/spark";

/* =========================================================================
   場景參數 — 由 COLMAP 稀疏重建結果分析得出 (C:\3dgs\work\scene_bounds.json
   與 frame_camera_map.json)。這些數字定義了「影片實際拍到的範圍」,
   用來限制縮放距離與俯仰角,避免使用者轉到未拍攝到的區域。
   若之後視覺校對發現方向或比例不準,只需微調這個區塊。
   ========================================================================= */

// COLMAP 重建出來的世界座標系,「上」方向並不會自動對齊真正的重力垂直方向
// (COLMAP 沒有任何水平參考,整個座標系可能歪斜十幾度)。
// C:\3dgs\work\fix_tilt.py 用稀疏點雲做 RANSAC 平面偵測,找出地面/草皮所在的
// 主要平面,計算出「把地面轉平」所需的校正旋轉,再與原本 Y-down -> Y-up 的
// 180° 翻轉合併成單一四元數,直接套在 splatMesh 上;建築中心點也套用同一個
// 完整旋轉(先校正傾斜,再翻轉)。若之後重新跑 COLMAP,這組數字要重新計算。
const TILT_QUAT = { x: 0.13566441020102324, y: 0.0000309, z: 0, w: -0.990754846997176 };
const CENTER = new THREE.Vector3(0.41300097, 1.42430072, -0.29734846);

const LIMITS = {
  minDistance: 2.1,
  maxDistance: 6.2,
  minPolarDeg: 75,   // 對應影片拍到的最高仰角
  maxPolarDeg: 155,  // 對應影片拍到的最低仰角(多為由下往上/略仰角拍攝)
};

// 方位角與仰角皆已在「地面校正後」的座標系中重新計算(見 fix_tilt2.py 產出的
// frame_camera_map_corrected.json),數值取自實際拍攝到的鏡位,而非隨意假設。
const VIEWS = {
  initial: { azimuthDeg: -164, elevationDeg: -15, distance: 3.2 },
  road:    { azimuthDeg: 120,  elevationDeg: -20, distance: 4.0 },
  river:   { azimuthDeg: -45,  elevationDeg: -20, distance: 3.3 },
  aerial:  { azimuthDeg: 0,    elevationDeg: -8,  distance: 2.8 },
};

const MODEL_URL = "./model.spz";

/* ========================================================================= */

function sphericalToPosition(view) {
  const phi = THREE.MathUtils.degToRad(90 - view.elevationDeg);
  const theta = THREE.MathUtils.degToRad(view.azimuthDeg);
  const spherical = new THREE.Spherical(view.distance, phi, theta);
  const offset = new THREE.Vector3().setFromSpherical(spherical);
  return CENTER.clone().add(offset);
}

const canvasWrap = document.getElementById("canvas-wrap");
const loadingEl = document.getElementById("loading");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const loadingError = document.getElementById("loading-error");
const hintEl = document.getElementById("hint");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef2f6);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.01,
  100
);
const initialPos = sphericalToPosition(VIEWS.initial);
camera.position.copy(initialPos);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
canvasWrap.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(CENTER);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = LIMITS.minDistance;
controls.maxDistance = LIMITS.maxDistance;
controls.minPolarAngle = THREE.MathUtils.degToRad(LIMITS.minPolarDeg);
controls.maxPolarAngle = THREE.MathUtils.degToRad(LIMITS.maxPolarDeg);
controls.rotateSpeed = 0.75;
controls.zoomSpeed = 0.8;
controls.panSpeed = 0.6;
controls.screenSpacePanning = false;
// 平移範圍也鎖在建築附近,避免把旋轉中心拖離場景
controls.enablePan = true;
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_PAN,
};
controls.update();

// 限制平移距離:每次平移後,若目標點離建築中心太遠就拉回來
const MAX_PAN_FROM_CENTER = 1.5;
controls.addEventListener("change", () => {
  const d = controls.target.distanceTo(CENTER);
  if (d > MAX_PAN_FROM_CENTER) {
    controls.target.lerp(CENTER, 1 - MAX_PAN_FROM_CENTER / d);
  }
});

scene.add(new THREE.AmbientLight(0xffffff, 1.0));

// Spark 需要一個 SparkRenderer 節點加入場景才會實際渲染任何 SplatMesh
const sparkRenderer = new SparkRenderer({ renderer });
scene.add(sparkRenderer);

let splatMesh = null;

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", onResize);
window.addEventListener("orientationchange", () => setTimeout(onResize, 200));

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

/* ------------------------- 載入 splat 模型 ------------------------- */

loadingError.style.display = "none";

function showLoadError(err) {
  console.error("模型載入失敗:", err);
  progressText.textContent = "";
  loadingError.textContent =
    "模型載入失敗:" + (err && err.message ? err.message : String(err)) +
    "(請重新整理頁面再試一次)";
  loadingError.style.display = "block";
}

let lastPct = 0;
try {
  splatMesh = new SplatMesh({
    url: MODEL_URL,
    onProgress: (event) => {
      if (event.lengthComputable && event.total > 0) {
        const pct = Math.min(100, Math.round((event.loaded / event.total) * 100));
        // 只允許往上走,避免顯示忽大忽小的數字
        lastPct = Math.max(lastPct, pct);
        progressFill.style.width = lastPct + "%";
        progressText.textContent = lastPct + "%";
      } else {
        const mb = (event.loaded / (1024 * 1024)).toFixed(1);
        progressText.textContent = mb + " MB";
      }
    },
    onLoad: () => {
      loadingEl.classList.add("hidden");
      showHint();
    },
  });
  // 修正座標系:COLMAP Y-down -> three.js Y-up,並校正地面傾斜(見上方 TILT_QUAT)
  splatMesh.quaternion.set(TILT_QUAT.x, TILT_QUAT.y, TILT_QUAT.z, TILT_QUAT.w);
  scene.add(splatMesh);

  // SplatMesh 內部載入失敗時只會產生一個沒人接的 rejected promise,
  // 一定要在這裡 catch 住,否則畫面會無聲卡住、看不到任何錯誤。
  if (splatMesh.initialized && typeof splatMesh.initialized.catch === "function") {
    splatMesh.initialized.catch(showLoadError);
  }
} catch (err) {
  showLoadError(err);
}

window.addEventListener("error", (e) => showLoadError(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => showLoadError(e.reason));

// 若載入超過時間仍未完成,避免使用者以為當機
setTimeout(() => {
  if (!loadingEl.classList.contains("hidden") && loadingError.style.display === "none") {
    progressText.textContent += "(檔案較大,請耐心等候)";
  }
}, 8000);

function showHint() {
  hintEl.classList.add("show");
  setTimeout(() => hintEl.classList.remove("show"), 4000);
}

/* ------------------------- 動畫過渡到指定視角 ------------------------- */

let flyAnimId = null;
function flyTo(view, duration = 900) {
  if (flyAnimId) cancelAnimationFrame(flyAnimId);
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const endPos = sphericalToPosition(view);
  const endTarget = CENTER.clone();
  const startTime = performance.now();

  controls.autoRotate = false;
  autorotateBtn.classList.remove("active");

  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    camera.position.lerpVectors(startPos, endPos, ease);
    controls.target.lerpVectors(startTarget, endTarget, ease);
    controls.update();
    if (t < 1) {
      flyAnimId = requestAnimationFrame(step);
    } else {
      flyAnimId = null;
    }
  }
  flyAnimId = requestAnimationFrame(step);
}

/* ------------------------- UI 按鈕 ------------------------- */

const autorotateBtn = document.getElementById("autorotate-btn");
const resetBtn = document.getElementById("reset-btn");
const presetButtons = document.querySelectorAll("#preset-row [data-preset]");

autorotateBtn.addEventListener("click", () => {
  controls.autoRotate = !controls.autoRotate;
  controls.autoRotateSpeed = 1.2;
  autorotateBtn.classList.toggle("active", controls.autoRotate);
});

resetBtn.addEventListener("click", () => {
  flyTo(VIEWS.initial);
});

presetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.getAttribute("data-preset");
    if (VIEWS[key]) flyTo(VIEWS[key]);
  });
});

// 雙擊 / 雙點 重設視角
let lastTapTime = 0;
function handleDoubleTap(e) {
  const now = Date.now();
  if (now - lastTapTime < 350) {
    flyTo(VIEWS.initial);
  }
  lastTapTime = now;
}
renderer.domElement.addEventListener("dblclick", () => flyTo(VIEWS.initial));
renderer.domElement.addEventListener("touchend", handleDoubleTap, { passive: true });

/* ------------------------- 全螢幕 ------------------------- */

const fullscreenBtn = document.getElementById("fullscreen-btn");
fullscreenBtn.addEventListener("click", async () => {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock("landscape").catch(() => {});
      }
    } else {
      await document.exitFullscreen();
    }
  } catch (err) {
    console.warn("全螢幕不支援或被拒絕", err);
  }
});

// 橫向時自動嘗試補滿畫面(部分瀏覽器需使用者手勢才能真正進全螢幕API,
// 這裡至少確保 CSS 版面已經是無邊界全螢幕,詳見 index.html 的 media query)
function handleOrientation() {
  onResize();
}
if (screen.orientation) {
  screen.orientation.addEventListener("change", handleOrientation);
}
