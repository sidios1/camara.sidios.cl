// Cámara web — estado, interfaz, captura y atajos. Equivalente a CameraEngine + ContentView + SettingsPanel.
import { Camera, shortLabel } from "./camera.js";
import { Pipeline } from "./pipeline.js";
import { BacklightMeter } from "./backlight.js";
import { BurstAnalyzer, FRAME_COUNT } from "./fusion.js";
import { MediaStore, GalleryView, fileName, download, makeThumb } from "./gallery.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const MAX_ZOOM = 6;
const ZOOM_STEPS = [1, 2, 3, 5];

// ---------------------------------------------------------------------------------------------
// Ajustes guardados

const KEY = "camara.settings.v1";
const NEUTRAL = { exposure: 0, contrast: 1, saturation: 1, temperature: 6500, tint: 0, sharpness: 0, noiseReduction: 0, vignette: 0, style: "standard" };
const STYLES = [
  ["standard", "Estándar"], ["vivid", "Vívido"], ["warm", "Cálido"], ["cool", "Frío"], ["dramatic", "Dramático"],
  ["mono", "Mono"], ["noir", "Noir"], ["chrome", "Cromo"], ["fade", "Desvanecido"], ["instant", "Instantánea"],
];
const signed = (v, d) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d);
const SLIDERS = [
  { key: "exposure", title: "Exposición", min: -2, max: 2, step: 0.1, fmt: (v) => signed(v, 1) + " EV" },
  { key: "contrast", title: "Contraste", min: 0.6, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: "saturation", title: "Saturación", min: 0, max: 2, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: "temperature", title: "Temperatura", min: 3500, max: 9500, step: 50, fmt: (v) => Math.round(v) + " K" },
  { key: "tint", title: "Tinte", min: -60, max: 60, step: 1, fmt: (v) => signed(v, 0) },
  { key: "sharpness", title: "Nitidez", min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: "noiseReduction", title: "Reducción de ruido", min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: "vignette", title: "Viñeta", min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
];
const PHOTO_FORMATS = [
  { id: "jpeg", type: "image/jpeg", ext: "jpg", label: "JPEG (más compatible)", q: 0.95 },
  { id: "webp", type: "image/webp", ext: "webp", label: "WebP (más liviano)", q: 0.92 },
  { id: "png", type: "image/png", ext: "png", label: "PNG (sin pérdida)" },
];
const VIDEO_FORMATS = [
  { id: "mp4-h264", mime: "video/mp4;codecs=avc1.640028,mp4a.40.2", ext: "mp4", label: "MP4 (H.264)" },
  { id: "mp4-hevc", mime: "video/mp4;codecs=hvc1.1.6.L120.90,mp4a.40.2", ext: "mp4", label: "MP4 (HEVC)" },
  { id: "mp4", mime: "video/mp4", ext: "mp4", label: "MP4" },
  { id: "webm-vp9", mime: "video/webm;codecs=vp9,opus", ext: "webm", label: "WebM (VP9)" },
  { id: "webm-vp8", mime: "video/webm;codecs=vp8,opus", ext: "webm", label: "WebM (VP8)" },
  { id: "webm", mime: "video/webm", ext: "webm", label: "WebM" },
];

const DEFAULTS = {
  theme: "system", mode: "photo", deviceId: null, resolution: "1920x1080", fps: 30,
  mirrorPreview: true, mirrorCapture: false, photoFormat: "jpeg", videoFormat: null, audio: true,
  screenFlash: false, torch: false, shutterSound: true, autodownload: false,
  showGrid: false, showHistogram: false, timer: 0, panel: false,
  backlight: false, blFusion: true, blDehaze: true, blSkin: true, blSharpen: true,
};

function readSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (_) {}
  return { ...DEFAULTS, ...saved, adjustments: { ...NEUTRAL, ...(saved.adjustments || {}) } };
}
const settings = readSettings();
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (_) {} }, 250);
}

// ---------------------------------------------------------------------------------------------
// Estado de ejecución

const video = document.createElement("video");
video.muted = true;
video.playsInline = true;
video.setAttribute("playsinline", "");
video.setAttribute("aria-hidden", "true");
Object.assign(video.style, { position: "absolute", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
$("viewfinder").append(video);

const canvas = $("view");
const camera = new Camera(video);
const meter = new BacklightMeter();
const analyzer = new BurstAnalyzer();
let pipeline = null;

const S = {
  running: false, zoom: 1, zoomAnim: null,
  capturing: false, countdown: null, countdownTimer: 0,
  recording: false, recorder: null, recStart: 0, recTimer: 0, audioStream: null,
  focusLocked: false, wbLocked: false,
  frames: 0, fpsT0: performance.now(), fps: 0, histTick: 0,
  bl: { subject: null, ev: 0, gains: [1, 1, 1], target: null, manual: null, overlay: null, tick: 0 },
  burst: null, frameHooks: [], lastId: null, thumbURL: null, renderOpts: null,
};

const gallery = new GalleryView({
  onClose: () => refreshThumb(),
  onChange: () => refreshThumb(),
  toast: (m) => toast(m),
});

// ---------------------------------------------------------------------------------------------
// Utilidades de interfaz

let toastTimer = 0;
function toast(msg, ms = 2200) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

let audioCtx = null;
function ac() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
  if (audioCtx?.state === "suspended") audioCtx.resume();
  return audioCtx;
}
/** Sonido de obturador sintetizado: dos chasquidos de ruido filtrado. */
function playShutter() {
  if (!settings.shutterSound) return;
  const ctx = ac(); if (!ctx) return;
  const t0 = ctx.currentTime;
  for (const [dt, gain] of [[0, 0.5], [0.075, 0.35]]) {
    const len = Math.floor(ctx.sampleRate * 0.05);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 2400; f.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t0 + dt);
  }
}
function playTick() {
  if (!settings.shutterSound) return;
  const ctx = ac(); if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = 1760;
  g.gain.setValueAtTime(0.18, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
  o.connect(g).connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.09);
}

const timeString = (t) => {
  const s = Math.floor(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
};

/** Reflejo efectivo de la vista previa: nunca con la cámara trasera de un móvil. */
const mirrorPreview = () => settings.mirrorPreview && camera.facing !== "environment";

// ---------------------------------------------------------------------------------------------
// Tema (igual que en sidios.cl y prompt.sidios.cl)

const darkMQ = window.matchMedia("(prefers-color-scheme: dark)");
const isDark = () => settings.theme === "dark" || (settings.theme !== "light" && darkMQ.matches);
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === "light" || settings.theme === "dark") root.setAttribute("data-theme", settings.theme);
  else root.removeAttribute("data-theme");
  const dark = isDark();
  root.classList.toggle("is-dark", dark);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    if (settings.theme === "system") m.setAttribute("content", m.media.includes("dark") ? "#000000" : "#ffffff");
    else m.setAttribute("content", dark ? "#000000" : "#ffffff");
  });
  const btn = $("btn-theme");
  const label = dark ? "Cambiar a tema claro" : "Cambiar a tema oscuro";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  $("set-theme").value = settings.theme;
}
darkMQ.addEventListener("change", () => { if (settings.theme === "system") applyTheme(); });

// ---------------------------------------------------------------------------------------------
// Cámara: inicio, permiso y errores

function showGate(title, text, button) {
  $("gate").hidden = false;
  $("gate-title").textContent = title;
  $("gate-text").textContent = text;
  const b = $("btn-allow");
  b.hidden = !button;
  if (button) b.textContent = button;
}

async function startCamera(opts = {}) {
  const [w, h] = settings.resolution.split("x").map(Number);
  try {
    await camera.start({ deviceId: opts.deviceId ?? settings.deviceId, width: w, height: h, fps: settings.fps });
  } catch (e) {
    console.warn("[Cámara] getUserMedia", e);
    if (e.name === "NotAllowedError" || e.name === "SecurityError") {
      showGate("Cámara necesita acceso a la cámara",
        "El permiso está bloqueado. Actívalo en la configuración del sitio de tu navegador (el ícono junto a la dirección) y vuelve a intentarlo.",
        "Reintentar");
    } else if (e.name === "NotFoundError" || e.name === "OverconstrainedError") {
      showGate("No hay cámaras disponibles", "Conecta una cámara y vuelve a intentarlo.", "Reintentar");
    } else if (e.name === "NotReadableError" || e.name === "AbortError") {
      showGate("La cámara está ocupada", "Otra aplicación o pestaña la está usando. Ciérrala y vuelve a intentarlo.", "Reintentar");
    } else {
      showGate("No se pudo abrir la cámara", e.message || String(e), "Reintentar");
    }
    return false;
  }
  $("gate").hidden = true;
  settings.deviceId = camera.deviceId;
  save();
  camera.track.addEventListener("ended", () => {
    if (S.recording) stopRecording();
    toast("Se desconectó la cámara");
    startCamera({ deviceId: null });
  });
  S.focusLocked = false;
  S.wbLocked = false;
  if (settings.torch && !camera.hasTorch) settings.torch = false;
  populateCameraControls();
  updateUI();
  layout();
  if (!S.running) { S.running = true; lastFrameAt = performance.now(); scheduleFrame(); }
  return true;
}

async function boot() {
  applyTheme();
  buildPanel();
  updateUI();
  refreshThumb();
  if (!window.isSecureContext || !Camera.supported) {
    showGate("Este navegador no permite usar la cámara aquí", "Abre la página con HTTPS en un navegador actual (Safari, Chrome, Edge o Firefox).", null);
    return;
  }
  try {
    pipeline = new Pipeline(canvas);
  } catch (e) {
    console.error(e);
    showGate("Tu navegador no puede procesar la imagen", "Cámara necesita WebGL 2. Actualiza el navegador o activa la aceleración por hardware.", null);
    return;
  }
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); toast("Se reinició el procesamiento de imagen"); });
  canvas.addEventListener("webglcontextrestored", () => { pipeline = new Pipeline(canvas); });

  const state = await camera.permissionState();
  if (state === "granted") {
    await startCamera();
  } else if (state === "denied") {
    showGate("Cámara necesita acceso a la cámara",
      "El permiso está bloqueado. Actívalo en la configuración del sitio de tu navegador (el ícono junto a la dirección) y vuelve a intentarlo.",
      "Reintentar");
  } else {
    showGate("Cámara necesita acceso a la cámara", "Las imágenes se procesan solo en tu equipo: nada se sube a internet.", "Permitir acceso");
  }
  if (settings.backlight) meter.load();
}

$("btn-allow").addEventListener("click", () => { ac(); startCamera(); });

navigator.mediaDevices?.addEventListener?.("devicechange", async () => {
  if (!camera.track) return;
  await camera.listDevices();
  populateCameraControls();
});

// ---------------------------------------------------------------------------------------------
// Bucle de fotogramas

// Cada cadena de callbacks lleva un número; el vigilante reinicia la cadena si deja de llegar
// fotogramas (p. ej., tras cambiar de cámara) y la anterior se descarta si vuelve a dispararse.
let loopGen = 0, lastFrameAt = 0;
function scheduleFrame(gen = loopGen) {
  const cb = () => onFrame(gen);
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(cb);
  else requestAnimationFrame(cb);
}
setInterval(() => {
  if (S.running && camera.track && !document.hidden && performance.now() - lastFrameAt > 1500) {
    loopGen++;
    scheduleFrame();
  }
}, 1000);

let lastSize = "";
function onFrame(gen) {
  if (gen !== loopGen || !S.running) return;
  lastFrameAt = performance.now();
  try {
    if (video.videoWidth && camera.track && pipeline) {
      const size = video.videoWidth + "x" + video.videoHeight;
      if (size !== lastSize) { lastSize = size; layout(); populateFormatControls(); }
      pipeline.upload(video);
      if (settings.backlight) backlightStep();
      if (S.burst) burstStep();
      const opts = S.renderOpts || {};
      S.renderOpts = null;
      pipeline.render({
        zoom: S.zoom,
        adjustments: settings.adjustments,
        mirror: settings.mirrorCapture,
        backlight: {
          on: settings.backlight, subject: S.bl.subject, ev: S.bl.ev, gains: S.bl.gains,
          dehaze: settings.blDehaze, skin: settings.blSkin, sharpen: settings.blSharpen,
        },
        useFused: !!opts.useFused,
        strongSharpen: !!opts.strongSharpen,
      });
      // Lo que necesita leer el canvas debe hacerlo ahora, antes de que el navegador lo presente.
      const hooks = S.frameHooks; S.frameHooks = [];
      for (const fn of hooks) fn();
      if (settings.showHistogram && ++S.histTick % 6 === 0) drawHistogram();
      countFPS();
    }
  } catch (e) {
    console.error("[Cámara] Error en el fotograma", e);
  }
  scheduleFrame(gen);
}

/** Ejecuta `fn` justo después de dibujar el próximo fotograma (con `opts` especiales si se pasan). */
function afterNextFrame(fn, opts) {
  return new Promise((resolve, reject) => {
    if (opts) S.renderOpts = opts;
    S.frameHooks.push(() => { try { resolve(fn()); } catch (e) { reject(e); } });
  });
}

function countFPS() {
  S.frames++;
  const now = performance.now();
  if (now - S.fpsT0 >= 1000) {
    S.fps = S.frames * 1000 / (now - S.fpsT0);
    S.frames = 0; S.fpsT0 = now;
    $("fps").textContent = `${Math.round(S.fps)} fps`;
  }
}

const histCanvas = document.createElement("canvas");
const histCtx = histCanvas.getContext("2d", { willReadFrequently: true });
function drawHistogram() {
  const w = 160, h = Math.max(1, Math.round(160 * canvas.height / canvas.width));
  histCanvas.width = w; histCanvas.height = h;
  histCtx.drawImage(canvas, 0, 0, w, h);
  const px = histCtx.getImageData(0, 0, w, h).data;
  const bins = new Float32Array(64);
  for (let i = 0; i < px.length; i += 4) {
    const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    bins[Math.min(63, (l / 4) | 0)]++;
  }
  const max = Math.max(1, ...bins);
  const el = $("histogram");
  const dpr = window.devicePixelRatio || 1;
  const W = 150, H = 64;
  if (el.width !== W * dpr) { el.width = W * dpr; el.height = H * dpr; }
  const c = el.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const pw = W - 12, ph = H - 12;
  c.beginPath();
  c.moveTo(6, 6 + ph);
  for (let i = 0; i < 64; i++) c.lineTo(6 + i * pw / 63, 6 + ph - (bins[i] / max) * ph);
  c.lineTo(6 + pw, 6 + ph);
  c.closePath();
  c.fillStyle = "rgba(255,255,255,0.75)";
  c.fill();
}

// ---------------------------------------------------------------------------------------------
// Contraluz

function backlightStep() {
  const b = S.bl;
  // Suavizado en cada fotograma para que no haya saltos.
  if (b.target) {
    b.ev += (b.target.ev - b.ev) * 0.08;
    b.gains = b.gains.map((g, i) => g + (b.target.gains[i] - g) * 0.08);
    const t = b.target.rect;
    if (t) {
      const c = b.subject || t, k = 0.25;
      b.subject = { x: c.x + (t.x - c.x) * k, y: c.y + (t.y - c.y) * k, w: c.w + (t.w - c.w) * k, h: c.h + (t.h - c.h) * k };
    }
  }
  if (++b.tick % 5 !== 0) return;
  const m = meter.measure(video, S.zoom, b.manual, { dehaze: settings.blDehaze, skin: settings.blSkin });
  if (settings.blDehaze && meter.haze) pipeline.setHaze(meter.haze.data, meter.haze.w, meter.haze.h);
  b.target = m;
  // Seguimos la cara elegida mientras se mueve.
  if (b.manual && m.tracked) b.manual = m.tracked;
  b.overlay = { rect: m.rect, isFace: m.isFace, manual: !!b.manual, ev: m.ev };
  drawBacklightOverlay();
}

function resetBacklight() {
  S.bl = { subject: null, ev: 0, gains: [1, 1, 1], target: null, manual: null, overlay: null, tick: 0 };
  drawBacklightOverlay();
}

function drawBacklightOverlay() {
  const on = settings.backlight && camera.track;
  const oval = $("bl-oval"), status = $("bl-status");
  status.hidden = !on;
  if (!on) { oval.hidden = true; return; }
  const o = S.bl.overlay;
  const box = $("overlay").getBoundingClientRect();
  if (o && o.rect && (o.isFace || o.manual)) {
    const r = o.rect;
    const cx = mirrorPreview() ? 1 - (r.x + r.w / 2) : r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const w = r.w * box.width * 1.25, h = r.h * box.height * 1.45;
    Object.assign(oval.style, { left: `${cx * box.width - w / 2}px`, top: `${cy * box.height - h / 2}px`, width: `${w}px`, height: `${h}px` });
    oval.classList.toggle("manual", o.manual);
    $("bl-ev").textContent = o.ev > 0.05 ? `+${o.ev.toFixed(1)} EV` : "OK";
    oval.hidden = false;
  } else {
    oval.hidden = true;
  }
  const loading = !meter.detector && !meter.failed;
  const st = loading ? "Cargando detección de caras…"
    : !o ? "Buscando cara…"
    : o.manual ? (o.isFace ? "Siguiendo la cara elegida" : "Zona elegida")
    : o.isFace ? "Cara detectada · toca para elegir otra" : "Sin cara · toca sobre tu cara";
  const fusion = settings.blFusion && settings.mode === "photo" ? " · fusión" : "";
  status.textContent = `☀ CONTRALUZ · ${st}${fusion}${o?.manual ? "  ✕" : ""}`;
  status.classList.toggle("manual", !!o?.manual);
  status.title = o?.manual ? "Volver a la detección automática" : "";
}

$("bl-status").addEventListener("click", () => {
  if (!S.bl.manual) return;
  S.bl.manual = null;
  if (S.bl.overlay) S.bl.overlay.manual = false;
  drawBacklightOverlay();
  toast("Contraluz: detección automática de cara");
});

function setBacklight(on) {
  settings.backlight = on;
  save();
  resetBacklight();
  if (on) {
    meter.load().then(() => {
      if (meter.failed) toast("No se pudo cargar la detección de caras: se compensará la zona central");
      drawBacklightOverlay();
    });
  }
  updateUI();
}

// ---------------------------------------------------------------------------------------------
// Disparo: foto, temporizador y vídeo

function shutterPressed() {
  if (!camera.track || gallery.isOpen) return;
  if (S.countdown != null) { cancelCountdown(); return; }
  if (settings.mode === "video" && S.recording) { stopRecording(); return; }
  if (S.capturing) return;
  if (settings.timer > 0) startCountdown(settings.timer);
  else fire();
}

function startCountdown(seconds) {
  S.countdown = seconds;
  updateCountdown();
  S.countdownTimer = setInterval(() => {
    if (S.countdown <= 1) {
      clearInterval(S.countdownTimer);
      S.countdown = null;
      updateCountdown();
      fire();
    } else {
      S.countdown--;
      playTick();
      updateCountdown();
    }
  }, 1000);
}

function cancelCountdown() {
  clearInterval(S.countdownTimer);
  S.countdown = null;
  updateCountdown();
}

function updateCountdown() {
  const el = $("countdown");
  el.hidden = S.countdown == null;
  el.textContent = S.countdown ?? "";
  $("btn-shutter").classList.toggle("counting", S.countdown != null);
}

function fire() {
  if (settings.mode === "photo") capturePhoto();
  else startRecording();
}

function blink() {
  $("blink").hidden = false;
  setTimeout(() => { $("blink").hidden = true; }, 120);
}

/** Recoge 8 fotogramas seguidos, los alinea y los fusiona en la GPU. Devuelve cuántos se usaron. */
function collectBurst() {
  analyzer.reset();
  return new Promise((resolve) => { S.burst = { i: 0, resolve }; });
}
function burstStep() {
  const b = S.burst;
  pipeline.grabBurstFrame(b.i, video);
  analyzer.add(video, S.zoom);
  b.i++;
  if (b.i < FRAME_COUNT) return;
  S.burst = null;
  const r = analyzer.solve(S.bl.subject, S.zoom);
  // La referencia queda sin desplazamiento; cada fotograma k se muestrea en uv + desplazamiento.
  pipeline.fuse(r.offsets, r.weights);
  b.resolve(r.used);
}

async function capturePhoto() {
  if (S.capturing) return;
  S.capturing = true;
  updateUI();
  const useScreenFlash = settings.screenFlash;
  const useTorch = settings.torch && camera.hasTorch;
  try {
    if (useScreenFlash) {
      $("flash").hidden = false;
      // Damos tiempo a que la exposición se adapte a la luz de la pantalla.
      await sleep(450);
    }
    if (useTorch) { await camera.setTorch(true); await sleep(500); }
    playShutter();
    blink();

    let used = 0;
    if (settings.backlight && settings.blFusion && S.bl.subject) {
      toast("Quieto…", 1200);
      used = await collectBurst();
    }
    const fmt = PHOTO_FORMATS.find((f) => f.id === settings.photoFormat && f.supported) || PHOTO_FORMATS[0];
    const w = canvas.width, h = canvas.height;
    const { blobP, thumbP } = await afterNextFrame(() => ({
      blobP: new Promise((r) => canvas.toBlob(r, fmt.type, fmt.q)),
      thumbP: makeThumb(canvas, w, h),
    }), used ? { useFused: true, strongSharpen: used >= 4 } : null);
    const [blob, thumb] = await Promise.all([blobP, thumbP]);
    if (!blob) throw new Error("toBlob");
    await saveCapture({ blob, thumb, isVideo: false, ext: fmt.ext, type: fmt.type, width: w, height: h });
    if (used) toast(`Foto a contraluz · ${used} fotogramas fusionados`);
  } catch (e) {
    console.error(e);
    toast("No se pudo guardar la foto");
  } finally {
    if (useTorch) camera.setTorch(false);
    if (useScreenFlash) setTimeout(() => { $("flash").hidden = true; }, 50);
    S.capturing = false;
    updateUI();
  }
}

async function saveCapture({ blob, thumb, isVideo, ext, type, width, height, duration }) {
  const name = fileName(isVideo ? "VID" : "IMG", ext);
  try {
    const rec = await MediaStore.add({ name, type, blob, thumb, isVideo, width, height, duration });
    S.lastId = rec.id;
    setThumb(thumb, true);
    if (settings.autodownload) download(blob, name);
  } catch (e) {
    console.error(e);
    toast("Sin espacio en el navegador: se descargó el archivo");
    download(blob, name);
  }
}

function videoFormat() {
  return VIDEO_FORMATS.find((f) => f.id === settings.videoFormat && f.supported) || VIDEO_FORMATS.find((f) => f.supported);
}

async function startRecording() {
  if (S.recording) return;
  const fmt = videoFormat();
  if (!fmt || !canvas.captureStream) { toast("Este navegador no puede grabar vídeo"); return; }
  let audioTrack = null;
  if (settings.audio) {
    try {
      if (!S.audioStream || S.audioStream.getAudioTracks().every((t) => t.readyState === "ended")) {
        S.audioStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      }
      audioTrack = S.audioStream.getAudioTracks()[0];
    } catch (e) {
      toast("Sin acceso al micrófono: el vídeo se grabará sin sonido");
    }
  }
  const fps = Math.round(camera.settings.frameRate || 30);
  const stream = canvas.captureStream(fps);
  if (audioTrack) stream.addTrack(audioTrack);
  let rec;
  const bitrate = Math.round(clamp(canvas.width * canvas.height * fps * 0.12, 2e6, 4e7));
  try {
    rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 160000 });
  } catch (e) {
    try { rec = new MediaRecorder(stream); } catch (e2) { toast("No se pudo iniciar la grabación"); return; }
  }
  const chunks = [];
  const w = canvas.width, h = canvas.height;
  const thumbP = afterNextFrame(() => makeThumb(canvas, w, h)).then((p) => p);
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getVideoTracks().forEach((t) => t.stop());
    const type = (rec.mimeType || fmt.mime).split(";")[0];
    const blob = new Blob(chunks, { type });
    const duration = (performance.now() - S.recStart) / 1000;
    S.recording = false;
    S.recorder = null;
    clearInterval(S.recTimer);
    updateUI();
    if (!blob.size) { toast("La grabación no se pudo guardar"); return; }
    const ext = type.includes("mp4") ? "mp4" : "webm";
    await saveCapture({ blob, thumb: await thumbP, isVideo: true, ext, type, width: w, height: h, duration });
  };
  rec.onerror = () => toast("Error durante la grabación");
  rec.start(1000);
  S.recorder = rec;
  S.recording = true;
  S.recStart = performance.now();
  $("rec-time").textContent = timeString(0);
  S.recTimer = setInterval(() => { $("rec-time").textContent = timeString((performance.now() - S.recStart) / 1000); }, 250);
  updateUI();
}

function stopRecording() {
  if (S.recorder && S.recorder.state !== "inactive") S.recorder.stop();
}

function setMode(m) {
  if (S.recording || settings.mode === m) return;
  settings.mode = m;
  save();
  if (m === "photo" && S.audioStream) { S.audioStream.getTracks().forEach((t) => t.stop()); S.audioStream = null; }
  drawBacklightOverlay();
  updateUI();
}

// ---------------------------------------------------------------------------------------------
// Zoom

function setZoom(z, animate = false) {
  z = clamp(z, 1, MAX_ZOOM);
  cancelAnimationFrame(S.zoomAnim);
  if (!animate) { S.zoom = z; updateZoomUI(); return; }
  const from = S.zoom, t0 = performance.now();
  const stepFn = (now) => {
    const t = Math.min(1, (now - t0) / 200), e = 1 - Math.pow(1 - t, 3);
    S.zoom = from + (z - from) * e;
    updateZoomUI();
    if (t < 1) S.zoomAnim = requestAnimationFrame(stepFn);
  };
  S.zoomAnim = requestAnimationFrame(stepFn);
}

function updateZoomUI() {
  const nearest = [...ZOOM_STEPS].reverse().find((s) => S.zoom >= s - 0.05) || 1;
  for (const b of $("zoom-pills").children) {
    const z = Number(b.dataset.z), on = z === nearest;
    b.classList.toggle("on", on);
    b.textContent = on && Math.abs(S.zoom - z) > 0.05 ? `${S.zoom.toFixed(1)}×` : `${z}×`;
  }
  const chip = $("zoom-chip");
  chip.hidden = S.zoom <= 1.01;
  chip.textContent = `${S.zoom.toFixed(1)}×`;
}

$("zoom-pills").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-z]");
  if (b) setZoom(Number(b.dataset.z), true);
});

// ---------------------------------------------------------------------------------------------
// Visor: tocar para enfocar, mantener o Alt+clic para bloquear, pellizcar o rueda para zoom

/** Punto del evento en coordenadas del visor (0..1) o null si cae fuera de la imagen. */
function viewPoint(e) {
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

let reticleTimer = 0;
function showReticle(p, locked) {
  const el = $("reticle");
  const box = $("overlay").getBoundingClientRect();
  el.hidden = true;
  el.classList.remove("faded", "busy");
  void el.offsetWidth;
  el.style.left = `${p.x * box.width}px`;
  el.style.top = `${p.y * box.height}px`;
  el.classList.add("busy");
  el.hidden = false;
  clearTimeout(reticleTimer);
  if (!locked) reticleTimer = setTimeout(() => el.classList.add("faded"), 2200);
}

async function focusAt(p, lock) {
  // Coordenadas de la imagen sin reflejo (con zoom) y del sensor (sin zoom).
  const ix = mirrorPreview() ? 1 - p.x : p.x, iy = p.y;
  if (settings.backlight && !lock) {
    S.bl.manual = { x: ix, y: iy };
    toast("Contraluz: midiendo donde tocaste");
    if (!camera.canPointFocus) return;
  }
  const canLock = camera.focusModes.includes("manual") || camera.exposureModes.includes("manual");
  if (!camera.canPointFocus && !lock) {
    toast("Esta cámara ajusta enfoque y exposición automáticamente en todo el cuadro");
    return;
  }
  if (lock && !canLock && !camera.canPointFocus) {
    toast("Esta cámara no permite bloquear enfoque y exposición desde el navegador");
    return;
  }
  showReticle(p, lock);
  S.focusLocked = lock;
  updateUI();
  if (lock) toast("Bloqueo AE/AF");
  const sx = clamp(0.5 + (ix - 0.5) / S.zoom, 0, 1), sy = clamp(0.5 + (iy - 0.5) / S.zoom, 0, 1);
  await camera.focusAt(sx, sy, lock);
}

async function setFocusContinuous() {
  S.focusLocked = false;
  $("reticle").hidden = true;
  await camera.lock(false);
  updateUI();
}

(() => {
  const vf = $("viewfinder");
  const pointers = new Map();
  let tap = null, pinch = null, pressTimer = 0;
  vf.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, .gate")) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    vf.setPointerCapture(e.pointerId);
    if (pointers.size === 1) {
      tap = { x: e.clientX, y: e.clientY, t: performance.now(), alt: e.altKey, e };
      clearTimeout(pressTimer);
      if (e.pointerType !== "mouse") {
        pressTimer = setTimeout(() => {
          if (!tap) return;
          const p = viewPoint(tap.e);
          tap = null;
          if (p) focusAt(p, true);
        }, 650);
      }
    } else if (pointers.size === 2) {
      tap = null; clearTimeout(pressTimer);
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: S.zoom };
    }
  });
  vf.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) { tap = null; clearTimeout(pressTimer); }
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      setZoom(pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
    }
  });
  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    clearTimeout(pressTimer);
    if (pointers.size < 2) pinch = null;
    if (tap && e.type === "pointerup" && performance.now() - tap.t < 600 && camera.track) {
      const p = viewPoint(e);
      if (p) focusAt(p, tap.alt);
    }
    tap = null;
  };
  vf.addEventListener("pointerup", end);
  vf.addEventListener("pointercancel", end);
  vf.addEventListener("wheel", (e) => {
    if (!camera.track) return;
    e.preventDefault();
    setZoom(S.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });
  // Safari en macOS: pellizco del trackpad.
  let gBase = 1;
  vf.addEventListener("gesturestart", (e) => { e.preventDefault(); gBase = S.zoom; });
  vf.addEventListener("gesturechange", (e) => { e.preventDefault(); setZoom(gBase * e.scale); });
  vf.addEventListener("contextmenu", (e) => e.preventDefault());
})();

// ---------------------------------------------------------------------------------------------
// Disposición: el canvas se ajusta al visor manteniendo la proporción

function layout() {
  const vf = $("viewfinder");
  const W = vf.clientWidth, H = vf.clientHeight;
  const fw = video.videoWidth || 16, fh = video.videoHeight || 9;
  const s = Math.min(W / fw, H / fh);
  const w = Math.round(fw * s), h = Math.round(fh * s);
  const left = Math.round((W - w) / 2), top = Math.round((H - h) / 2);
  for (const el of [canvas, $("overlay")]) Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  drawBacklightOverlay();
}
new ResizeObserver(() => layout()).observe($("viewfinder"));

// ---------------------------------------------------------------------------------------------
// Controles de cámara (barra superior y panel)

function option(value, label, selected) {
  const o = document.createElement("option");
  o.value = value; o.textContent = label;
  if (selected) o.selected = true;
  return o;
}

function populateCameraControls() {
  for (const sel of [$("sel-device"), $("set-device")]) {
    sel.textContent = "";
    for (const d of camera.devices) sel.append(option(d.id, d.label, d.id === camera.deviceId));
    sel.disabled = camera.devices.length < 2 && !!camera.devices.length;
  }
  populateFormatControls();
  // Capacidades de hardware
  const c = camera;
  $("row-focus").hidden = !c.hasAutofocus;
  $("focus-note").textContent = c.canPointFocus
    ? "Toca la imagen para enfocar y exponer en ese punto. Mantén pulsado (o Alt + clic) para bloquear enfoque y exposición (AE/AF)."
    : c.hasAutofocus
      ? "Autoenfoque continuo activo. Esta cámara no permite elegir el punto de enfoque desde el navegador."
      : "El navegador no permite controlar el enfoque de esta cámara: ajusta enfoque y exposición automáticamente.";
  $("row-wb").hidden = !c.canLockWB;
  $("row-torch").hidden = !c.hasTorch;
}

function populateFormatControls() {
  if (!camera.track) return;
  const res = camera.resolutions(), rates = camera.frameRates();
  const vw = Math.max(video.videoWidth, video.videoHeight), vh = Math.min(video.videoWidth, video.videoHeight);
  const curRes = `${vw}x${vh}`;
  const curFps = Math.round(camera.settings.frameRate || settings.fps);
  const sr = $("set-resolution"); sr.textContent = "";
  for (const r of res) sr.append(option(r.id, r.label, r.id === curRes));
  const sf = $("set-fps"); sf.textContent = "";
  for (const f of rates) sf.append(option(String(f), `${f} fps`, f === curFps));
  const q = $("sel-quick-format"); q.textContent = "";
  q.append(option("", "Resolución y fps", true));
  q.firstChild.disabled = true; q.firstChild.hidden = true;
  const g1 = document.createElement("optgroup"); g1.label = "Resolución";
  for (const r of res) g1.append(option("r:" + r.id, (r.id === curRes ? "✓ " : "   ") + r.label));
  const g2 = document.createElement("optgroup"); g2.label = "Fotogramas por segundo";
  for (const f of rates) g2.append(option("f:" + f, (f === curFps ? "✓ " : "   ") + `${f} fps`));
  q.append(g1, g2);
  $("fmt-label").textContent = `${shortLabel(vw, vh)} · ${curFps}`;
  $("cam-note").textContent = `Imagen real: ${video.videoWidth}×${video.videoHeight} a ${curFps} fps.`;
}

async function changeFormat({ resolution, fps }) {
  if (S.recording) { toast("Detén la grabación para cambiar el formato"); populateFormatControls(); return; }
  if (resolution) settings.resolution = resolution;
  if (fps) settings.fps = fps;
  save();
  await startCamera({ deviceId: camera.deviceId });
}

async function changeDevice(id) {
  if (S.recording) { toast("Detén la grabación para cambiar de cámara"); populateCameraControls(); return; }
  settings.deviceId = id;
  save();
  resetBacklight();
  setZoom(1);
  if (await startCamera({ deviceId: id })) {
    const d = camera.devices.find((x) => x.id === camera.deviceId);
    if (d) toast(`Cambiado a ${d.label}`);
  }
}

$("sel-device").addEventListener("change", (e) => changeDevice(e.target.value));
$("set-device").addEventListener("change", (e) => changeDevice(e.target.value));
$("set-resolution").addEventListener("change", (e) => changeFormat({ resolution: e.target.value }));
$("set-fps").addEventListener("change", (e) => changeFormat({ fps: Number(e.target.value) }));
$("sel-quick-format").addEventListener("change", (e) => {
  const v = e.target.value;
  e.target.value = "";
  if (v.startsWith("r:")) changeFormat({ resolution: v.slice(2) });
  else if (v.startsWith("f:")) changeFormat({ fps: Number(v.slice(2)) });
});

// ---------------------------------------------------------------------------------------------
// Panel de ajustes

function buildPanel() {
  const styles = $("styles");
  for (const [id, title] of STYLES) {
    const b = document.createElement("button");
    b.type = "button"; b.dataset.style = id; b.textContent = title;
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => { settings.adjustments.style = id; save(); updateUI(); });
    styles.append(b);
  }

  const box = $("sliders");
  for (const s of SLIDERS) {
    const wrap = document.createElement("div");
    wrap.className = "slider";
    const id = "sl-" + s.key;
    wrap.innerHTML = `<div class="slider-head"><label for="${id}">${s.title}</label><output for="${id}"></output></div>
      <input type="range" id="${id}" min="${s.min}" max="${s.max}" step="${s.step}">`;
    const input = wrap.querySelector("input");
    input.addEventListener("input", () => { settings.adjustments[s.key] = Number(input.value); save(); updateSliders(); });
    input.addEventListener("dblclick", () => { settings.adjustments[s.key] = NEUTRAL[s.key]; save(); updateSliders(); });
    box.append(wrap);
  }
  $("btn-reset-adj").addEventListener("click", () => {
    settings.adjustments = { ...NEUTRAL, style: settings.adjustments.style };
    save(); updateUI();
  });

  const photo = $("set-photo-format");
  for (const f of PHOTO_FORMATS) {
    const c = document.createElement("canvas"); c.width = c.height = 1;
    f.supported = f.id === "jpeg" || c.toDataURL(f.type).startsWith(`data:${f.type}`);
    if (f.supported) photo.append(option(f.id, f.label, f.id === settings.photoFormat));
  }
  photo.addEventListener("change", () => { settings.photoFormat = photo.value; save(); });

  const vsel = $("set-video-format");
  const MR = window.MediaRecorder;
  for (const f of VIDEO_FORMATS) {
    f.supported = !!MR && (!MR.isTypeSupported || MR.isTypeSupported(f.mime));
  }
  // Mostrar solo variantes útiles: si hay una con códec explícito, ocultar la genérica del mismo contenedor.
  const shown = VIDEO_FORMATS.filter((f) => f.supported && !(["mp4", "webm"].includes(f.id) && VIDEO_FORMATS.some((g) => g.supported && g.id.startsWith(f.id + "-"))));
  for (const f of shown) vsel.append(option(f.id, f.label, f.id === (videoFormat()?.id)));
  if (!shown.length) { vsel.append(option("", "No disponible", true)); vsel.disabled = true; }
  vsel.addEventListener("change", () => { settings.videoFormat = vsel.value; save(); });

  const bind = (id, key, after) => {
    const el = $(id);
    el.addEventListener("change", () => { settings[key] = el.checked; save(); after?.(el.checked); updateUI(); });
  };
  bind("set-audio", "audio");
  bind("set-mirror-preview", "mirrorPreview", () => drawBacklightOverlay());
  bind("set-mirror-capture", "mirrorCapture");
  bind("set-screen-flash", "screenFlash");
  bind("set-shutter-sound", "shutterSound");
  bind("set-autodownload", "autodownload");
  bind("set-bl-fusion", "blFusion", () => drawBacklightOverlay());
  bind("set-bl-dehaze", "blDehaze");
  bind("set-bl-skin", "blSkin");
  bind("set-bl-sharpen", "blSharpen");
  bind("set-torch", "torch");
  $("set-backlight").addEventListener("change", (e) => setBacklight(e.target.checked));
  $("set-wb-lock").addEventListener("change", async (e) => {
    S.wbLocked = e.target.checked;
    if (!(await camera.setWBLock(S.wbLocked))) { S.wbLocked = false; toast("Esta cámara no permite bloquear el balance de blancos"); }
    updateUI();
  });
  for (const b of document.querySelectorAll("[data-focus]")) {
    b.addEventListener("click", () => {
      if (b.dataset.focus === "continuous") setFocusContinuous();
      else { S.focusLocked = true; camera.lock(true); updateUI(); }
    });
  }
  $("set-theme").addEventListener("change", (e) => { settings.theme = e.target.value; save(); applyTheme(); });
}

function updateSliders() {
  for (const s of SLIDERS) {
    const input = $("sl-" + s.key);
    const v = settings.adjustments[s.key];
    if (Number(input.value) !== v) input.value = v;
    const wrap = input.closest(".slider");
    wrap.querySelector("output").textContent = s.fmt(v);
    wrap.classList.toggle("changed", Math.abs(v - NEUTRAL[s.key]) > 1e-6);
  }
  const neutral = SLIDERS.every((s) => Math.abs(settings.adjustments[s.key] - NEUTRAL[s.key]) < 1e-6);
  $("btn-reset-adj").disabled = neutral;
}

function setPanel(open) {
  settings.panel = open;
  save();
  updateUI();
}

// ---------------------------------------------------------------------------------------------
// Interfaz: refleja el estado en todos los controles

function updateUI() {
  const photo = settings.mode === "photo";
  const pressed = (id, on) => $(id).setAttribute("aria-pressed", String(!!on));

  // Barra superior
  pressed("btn-backlight", settings.backlight);
  const flashOn = camera.hasTorch ? settings.torch : settings.screenFlash;
  pressed("btn-flash", flashOn);
  $("btn-flash").title = camera.hasTorch ? "Flash (linterna de la cámara)" : "Flash de pantalla";
  $("btn-flash").disabled = !photo;
  pressed("btn-timer", settings.timer > 0);
  $("timer-badge").hidden = !settings.timer;
  $("timer-badge").textContent = settings.timer ? `${settings.timer}s` : "";
  pressed("btn-grid", settings.showGrid);
  pressed("btn-histogram", settings.showHistogram);
  pressed("btn-panel", settings.panel);
  $("btn-settings-nav").setAttribute("aria-expanded", String(settings.panel));
  $("rec-badge").hidden = !S.recording;
  $("fmt-pick").hidden = S.recording || !camera.track;

  // Superposiciones
  $("grid").hidden = !settings.showGrid;
  $("histogram").hidden = !settings.showHistogram;
  $("lock-chip").hidden = !S.focusLocked;
  canvas.classList.toggle("mirrored", mirrorPreview() !== settings.mirrorCapture);
  drawBacklightOverlay();

  // Barra inferior
  for (const b of document.querySelectorAll("[data-mode]")) {
    b.setAttribute("aria-checked", String(b.dataset.mode === settings.mode));
    b.disabled = S.recording;
  }
  const sh = $("btn-shutter");
  sh.className = "shutter " + (photo ? "photo" : "video") + (S.recording ? " recording" : "") + (S.capturing ? " capturing" : "") + (S.countdown != null ? " counting" : "");
  const shLabel = photo ? "Tomar foto (barra espaciadora)" : S.recording ? "Detener grabación (barra espaciadora)" : "Grabar vídeo (barra espaciadora)";
  sh.title = shLabel;
  sh.setAttribute("aria-label", shLabel.replace(/ \(.*\)$/, ""));
  sh.disabled = !camera.track;
  updateZoomUI();

  // Panel
  $("panel").hidden = !settings.panel;
  $("scrim").hidden = !settings.panel;
  $("set-backlight").checked = settings.backlight;
  $("bl-options").hidden = !settings.backlight;
  $("set-bl-fusion").checked = settings.blFusion;
  $("set-bl-dehaze").checked = settings.blDehaze;
  $("set-bl-skin").checked = settings.blSkin;
  $("set-bl-sharpen").checked = settings.blSharpen;
  $("set-wb-lock").checked = S.wbLocked;
  $("set-torch").checked = settings.torch;
  $("set-audio").checked = settings.audio;
  $("set-mirror-preview").checked = settings.mirrorPreview;
  $("set-mirror-capture").checked = settings.mirrorCapture;
  $("set-screen-flash").checked = settings.screenFlash;
  $("set-shutter-sound").checked = settings.shutterSound;
  $("set-autodownload").checked = settings.autodownload;
  $("set-video-format").disabled = S.recording || !$("set-video-format").options.length;
  for (const b of document.querySelectorAll("[data-focus]")) {
    b.setAttribute("aria-checked", String((b.dataset.focus === "locked") === S.focusLocked));
  }
  for (const b of $("styles").children) b.setAttribute("aria-checked", String(b.dataset.style === settings.adjustments.style));
  updateSliders();
}

// Última captura
function setThumb(blob, pop) {
  const img = $("thumb-img");
  if (S.thumbURL) URL.revokeObjectURL(S.thumbURL);
  S.thumbURL = blob ? URL.createObjectURL(blob) : null;
  img.hidden = !blob;
  if (blob) img.src = S.thumbURL; else img.removeAttribute("src");
  if (pop) { const t = $("btn-thumb"); t.classList.remove("pop"); void t.offsetWidth; t.classList.add("pop"); }
}
async function refreshThumb() {
  try {
    const last = await MediaStore.latest();
    S.lastId = last?.id ?? null;
    setThumb(last?.thumb || null, false);
  } catch (_) {}
}

function openGallery() {
  if (S.recording) return;
  cancelCountdown();
  gallery.open(S.lastId);
}

// ---------------------------------------------------------------------------------------------
// Botones

$("btn-shutter").addEventListener("click", () => { ac(); shutterPressed(); });
for (const b of document.querySelectorAll("[data-mode]")) b.addEventListener("click", () => setMode(b.dataset.mode));
$("btn-backlight").addEventListener("click", () => setBacklight(!settings.backlight));
$("btn-flash").addEventListener("click", () => {
  if (camera.hasTorch) settings.torch = !settings.torch; else settings.screenFlash = !settings.screenFlash;
  save(); updateUI();
});
const cycleTimer = () => { settings.timer = settings.timer === 0 ? 3 : settings.timer === 3 ? 10 : 0; save(); updateUI(); };
$("btn-timer").addEventListener("click", cycleTimer);
const toggle = (key) => { settings[key] = !settings[key]; save(); updateUI(); };
$("btn-grid").addEventListener("click", () => toggle("showGrid"));
$("btn-histogram").addEventListener("click", () => toggle("showHistogram"));
$("btn-panel").addEventListener("click", () => setPanel(!settings.panel));
$("btn-settings-nav").addEventListener("click", () => setPanel(!settings.panel));
$("btn-panel-close").addEventListener("click", () => setPanel(false));
$("scrim").addEventListener("click", () => setPanel(false));
$("lock-chip").addEventListener("click", () => setFocusContinuous());
$("btn-thumb").addEventListener("click", openGallery);
$("btn-gallery").addEventListener("click", openGallery);
$("btn-gallery-nav").addEventListener("click", openGallery);
$("btn-theme").addEventListener("click", () => { settings.theme = isDark() ? "light" : "dark"; save(); applyTheme(); });

// ---------------------------------------------------------------------------------------------
// Atajos de teclado (equivalentes al menú «Cámara» de la app)

document.addEventListener("keydown", (e) => {
  if (gallery.isOpen) return;
  const t = e.target;
  const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) && t.type !== "checkbox" && t.type !== "range";
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();

  if (e.key === "Escape") {
    if (S.countdown != null) cancelCountdown();
    else if (settings.panel) setPanel(false);
    return;
  }
  if (typing) return;

  if (mod && !e.shiftKey && (k === "+" || k === "=")) { e.preventDefault(); setZoom(S.zoom * 1.25, true); return; }
  if (mod && !e.shiftKey && k === "-") { e.preventDefault(); setZoom(S.zoom / 1.25, true); return; }
  if (mod && !e.shiftKey && k === "0") { e.preventDefault(); setZoom(1, true); return; }
  if (mod && !e.shiftKey && k === "1") { e.preventDefault(); setMode("photo"); return; }
  if (mod && !e.shiftKey && k === "2") { e.preventDefault(); setMode("video"); return; }
  if (mod && !e.shiftKey && k === ",") { e.preventDefault(); setPanel(!settings.panel); return; }
  if (mod && !e.shiftKey && k === "y") { e.preventDefault(); openGallery(); return; }
  if (mod && e.shiftKey && k === "g") { e.preventDefault(); toggle("showGrid"); return; }
  if (mod && e.shiftKey && k === "h") { e.preventDefault(); toggle("showHistogram"); return; }
  if (mod && e.shiftKey && k === "f") { e.preventDefault(); setFocusContinuous(); return; }
  if (mod || e.altKey) return;

  switch (k) {
    case " ":
      if (t instanceof HTMLButtonElement && t.id !== "btn-shutter") return; // deja que Espacio active el botón enfocado
      e.preventDefault(); ac(); shutterPressed(); break;
    case "1": setMode("photo"); break;
    case "2": setMode("video"); break;
    case "+": case "=": setZoom(S.zoom * 1.25, true); break;
    case "-": setZoom(S.zoom / 1.25, true); break;
    case "0": setZoom(1, true); break;
    case "t": cycleTimer(); break;
    case "g": toggle("showGrid"); break;
    case "h": toggle("showHistogram"); break;
    case "l": setBacklight(!settings.backlight); break;
    case "f": setFocusContinuous(); break;
    case "s": setPanel(!settings.panel); break;
    case "c": openGallery(); break;
  }
});

// Evitar que la pestaña siga usando la cámara en segundo plano en móviles
document.addEventListener("visibilitychange", () => {
  if (document.hidden && S.recording) return;
  if (!document.hidden && camera.track && camera.track.readyState === "ended") startCamera();
});

boot();
