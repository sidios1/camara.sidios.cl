// Acceso a la cámara: equivalente web de la parte de AVCaptureSession de CameraEngine.swift.
// Lista de cámaras, resolución y fps, y capacidades de hardware (punto de enfoque, linterna,
// bloqueo de exposición y de balance de blancos) cuando el navegador las expone.

const PRESETS = [
  { w: 3840, h: 2160, name: "4K" },
  { w: 2560, h: 1440, name: "1440p" },
  { w: 1920, h: 1080, name: "1080p" },
  { w: 1600, h: 1200, name: "1200p" },
  { w: 1280, h: 960, name: "960p" },
  { w: 1280, h: 720, name: "720p" },
  { w: 960, h: 540, name: "540p" },
  { w: 640, h: 480, name: "480p" },
];
const RATES = [60, 50, 30, 25, 24, 15];

export function shortLabel(w, h) {
  const p = PRESETS.find((x) => x.w === w && x.h === h);
  if (p) return p.name;
  const lo = Math.min(w, h);
  return lo >= 2160 ? "4K" : `${lo}p`;
}

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.devices = [];
    this.caps = {};
    this.settings = {};
  }

  static get supported() { return !!navigator.mediaDevices?.getUserMedia; }

  async permissionState() {
    try { return (await navigator.permissions.query({ name: "camera" })).state; }
    catch (_) { return "prompt"; }
  }

  async listDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    this.devices = all.filter((d) => d.kind === "videoinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Cámara ${i + 1}` }));
    return this.devices;
  }

  /** Abre la cámara pedida (o la predeterminada) con la resolución y fps ideales. */
  async start({ deviceId, width = 1920, height = 1080, fps = 30 } = {}) {
    this.stop();
    const video = { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } };
    if (deviceId) video.deviceId = { exact: deviceId };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      // La cámara guardada ya no existe: probamos con la predeterminada.
      if (deviceId && (e.name === "OverconstrainedError" || e.name === "NotFoundError")) {
        delete video.deviceId;
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } else throw e;
    }
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    this.caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
    this.settings = this.track.getSettings();
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    if (!this.video.videoWidth) await new Promise((r) => this.video.addEventListener("loadedmetadata", r, { once: true }));
    await this.listDevices();
    return this.settings;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
  }

  get deviceId() { return this.settings.deviceId || null; }
  get facing() { return this.settings.facingMode || ""; }

  /** Resoluciones disponibles según las capacidades (o una lista estándar si no se conocen). */
  resolutions() {
    const mw = this.caps.width?.max, mh = this.caps.height?.max;
    let list = PRESETS.filter((p) => !mw || !mh || (p.w <= mw && p.h <= mh));
    if (!list.length) list = PRESETS.slice(-3);
    const cur = { w: this.video.videoWidth, h: this.video.videoHeight };
    // Se guarda la orientación horizontal; la resolución actual puede venir en vertical (móviles).
    const cw = Math.max(cur.w, cur.h), ch = Math.min(cur.w, cur.h);
    if (cw && !list.some((p) => p.w === cw && p.h === ch)) list = [{ w: cw, h: ch, name: shortLabel(cw, ch) }, ...list];
    return list.map((p) => ({ id: `${p.w}x${p.h}`, w: p.w, h: p.h, label: `${p.name} · ${p.w}×${p.h}`, short: p.name }));
  }

  frameRates() {
    const max = this.caps.frameRate?.max, min = this.caps.frameRate?.min || 1;
    let list = RATES.filter((r) => !max || (r <= max + 0.5 && r >= min - 0.5));
    if (!list.length) list = [30];
    const cur = Math.round(this.settings.frameRate || 0);
    if (cur && !list.includes(cur)) list = [...list, cur].sort((a, b) => b - a);
    return list;
  }

  // ---------- Capacidades de hardware ----------

  get canPointFocus() { return "pointsOfInterest" in this.caps; }
  get focusModes() { return this.caps.focusMode || []; }
  get exposureModes() { return this.caps.exposureMode || []; }
  get canLockWB() { return (this.caps.whiteBalanceMode || []).includes("manual"); }
  get hasTorch() { return !!this.caps.torch; }
  get hasAutofocus() { return this.focusModes.some((m) => m === "continuous" || m === "single-shot"); }

  async apply(adv) {
    if (!this.track) return false;
    try { await this.track.applyConstraints({ advanced: [adv] }); this.settings = this.track.getSettings(); return true; }
    catch (e) { console.warn("[Cámara] applyConstraints", adv, e); return false; }
  }

  /** Enfoque y exposición en un punto (coordenadas de la fuente sin zoom); `lock` los fija luego. */
  async focusAt(x, y, lock) {
    const adv = {};
    if (this.canPointFocus) adv.pointsOfInterest = [{ x, y }];
    if (this.focusModes.includes("single-shot")) adv.focusMode = "single-shot";
    else if (this.focusModes.includes("continuous")) adv.focusMode = "continuous";
    if (this.exposureModes.includes("continuous")) adv.exposureMode = "continuous";
    await this.apply(adv);
    if (lock) {
      await new Promise((r) => setTimeout(r, 1200));
      await this.lock(true);
    } else if (this.focusModes.includes("continuous")) {
      setTimeout(() => this.apply({ focusMode: "continuous" }), 1500);
    }
  }

  async lock(on) {
    const adv = {};
    if (on) {
      if (this.focusModes.includes("manual")) adv.focusMode = "manual";
      if (this.exposureModes.includes("manual")) adv.exposureMode = "manual";
    } else {
      if (this.canPointFocus) adv.pointsOfInterest = [{ x: 0.5, y: 0.5 }];
      if (this.focusModes.includes("continuous")) adv.focusMode = "continuous";
      if (this.exposureModes.includes("continuous")) adv.exposureMode = "continuous";
    }
    return Object.keys(adv).length ? this.apply(adv) : false;
  }

  setWBLock(on) { return this.apply({ whiteBalanceMode: on ? "manual" : "continuous" }); }
  setTorch(on) { return this.hasTorch ? this.apply({ torch: on }) : Promise.resolve(false); }
}
