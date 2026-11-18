// Compensación de contraluz: equivalente web de BacklightMeter (Backlight.swift) y de
// BacklightParams.skinGains (Adjustments.swift). Detecta la cara con MediaPipe (incluido en el sitio,
// sin llamadas externas), mide sobre la imagen sin velo el color de piel y cuánta luz le falta,
// y calcula el mapa de velo que usa el shader.
// Coordenadas normalizadas con origen arriba a la izquierda, en el espacio de la imagen con zoom.

const VENDOR = new URL("./vendor/mediapipe/", import.meta.url).href;

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = Math.pow(i / 255, 2.2);
const enc = (v) => Math.pow(Math.max(v, 0), 1 / 2.2);
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Pasos de luz (EV) que faltan para llevar la luminancia codificada `lum` a `target`. */
export function evNeeded(lum, target, maxEV) {
  const ev = 2.2 * Math.log2(target / Math.max(lum, 0.01));
  return Math.min(Math.max(ev, 0), maxEV);
}

/**
 * Ganancias lineales que acercan el tono medio de la cara (codificado) al de una piel de referencia
 * (g/r ≈ 0,80, b/r ≈ 0,68). Corrige solo el tono, al 80 %, con límites por canal (0,6–1,35). Conserva la luminancia.
 */
export function skinGains(c) {
  if (c[0] <= 0.05) return [1, 1, 1];
  const target = [c[0], c[0] * 0.8, c[0] * 0.68];
  const g = [0, 1, 2].map((i) => Math.min(Math.max(1 + (target[i] / Math.max(c[i], 0.01) - 1) * 0.8, 0.6), 1.35));
  let lin = g.map((v) => Math.pow(v, 2.2));
  const lc = c.map((v) => Math.pow(Math.max(v, 0), 2.2));
  const before = luma(lc);
  const after = 0.2126 * lc[0] * lin[0] + 0.7152 * lc[1] * lin[1] + 0.0722 * lc[2] * lin[2];
  if (after > 0) lin = lin.map((v) => v * before / after);
  return lin;
}

/** Máscara ovalada (igual que en el shader) evaluada en un punto. */
function ovalAt(x, y, w, h, s, inner, outer, drop) {
  const fw = s.w * w, fh = s.h * h, f = Math.max(fw, fh);
  const cx = (s.x + s.w / 2) * w, cy = (s.y + s.h / 2) * h + fh * drop;
  const dx = x - cx, dy = (y - cy) / 1.25;
  return 1 - Math.min(Math.max((Math.hypot(dx, dy) - f * inner) / (f * (outer - inner)), 0), 1);
}

export class BacklightMeter {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.hcanvas = document.createElement("canvas");
    this.hctx = this.hcanvas.getContext("2d", { willReadFrequently: true });
    this.detector = null;
    this.loading = null;
    this.failed = false;
    this.lastTs = 0;
  }

  /** Carga MediaPipe la primera vez (≈ 15 MB, queda en caché del navegador). */
  load() {
    if (this.detector || this.failed) return Promise.resolve(this.detector);
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const { FilesetResolver, FaceDetector } = await import(VENDOR + "vision_bundle.mjs");
          const fileset = await FilesetResolver.forVisionTasks(VENDOR + "wasm");
          const make = (delegate) => FaceDetector.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: VENDOR + "blaze_face_short_range.tflite", delegate },
            runningMode: "VIDEO",
            minDetectionConfidence: 0.5,
          });
          try { this.detector = await make("GPU"); } catch (_) { this.detector = await make("CPU"); }
        } catch (e) {
          console.warn("[Cámara] No se pudo cargar la detección de caras", e);
          this.failed = true;
        }
        return this.detector;
      })();
    }
    return this.loading;
  }

  /** Dibuja en `canvas` el recorte central (zoom) del vídeo, con `width` px de ancho. */
  static drawZoomed(ctx, video, zoom, width) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const height = Math.max(1, Math.round(width * vh / vw));
    if (ctx.canvas.width !== width || ctx.canvas.height !== height) { ctx.canvas.width = width; ctx.canvas.height = height; }
    const sw = vw / zoom, sh = vh / zoom;
    ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, width, height);
    return height;
  }

  /**
   * Mapa de velo «dark channel»: mínimo local por canal (radio = ancho/40), suavizado (σ = ancho/30),
   * por k = 0,7 y limitado a 0,35. Devuelve RGBA8 con los valores divididos por 0,35.
   */
  hazeMap(video, zoom) {
    const W = 120;
    const H = BacklightMeter.drawZoomed(this.hctx, video, zoom, W);
    const px = this.hctx.getImageData(0, 0, W, H).data;
    const n = W * H;
    const out = new Uint8Array(n * 4);
    const r = 3, sigma = 4, kr = 12;
    const kern = [];
    let ks = 0;
    for (let i = -kr; i <= kr; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); kern.push(v); ks += v; }
    for (let i = 0; i < kern.length; i++) kern[i] /= ks;
    const a = new Float32Array(n), b = new Float32Array(n);
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 0; i < n; i++) a[i] = LIN[px[i * 4 + ch]];
      // Mínimo separable: horizontal y luego vertical.
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let m = 1;
        for (let d = -r; d <= r; d++) { const xx = Math.min(W - 1, Math.max(0, x + d)); const v = a[y * W + xx]; if (v < m) m = v; }
        b[y * W + x] = m;
      }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let m = 1;
        for (let d = -r; d <= r; d++) { const yy = Math.min(H - 1, Math.max(0, y + d)); const v = b[yy * W + x]; if (v < m) m = v; }
        a[y * W + x] = m;
      }
      // Desenfoque gaussiano separable.
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s = 0;
        for (let d = -kr; d <= kr; d++) s += a[y * W + Math.min(W - 1, Math.max(0, x + d))] * kern[d + kr];
        b[y * W + x] = s;
      }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s = 0;
        for (let d = -kr; d <= kr; d++) s += b[Math.min(H - 1, Math.max(0, y + d)) * W + x] * kern[d + kr];
        const kv = Math.min(s * 0.7, 0.35);
        out[(y * W + x) * 4 + ch] = Math.round(kv / 0.35 * 255);
      }
    }
    for (let i = 0; i < n; i++) out[i * 4 + 3] = 255;
    this.haze = { data: out, w: W, h: H };
    return this.haze;
  }

  /**
   * Busca al sujeto (cara, zona elegida o, en último caso, el centro frente al fondo) y mide.
   * `manual`: punto {x, y} elegido por la persona o null.
   * Devuelve { rect, ev, isFace, tracked, gains }.
   */
  measure(video, zoom, manual, opts) {
    const W = 480;
    const H = BacklightMeter.drawZoomed(this.ctx, video, zoom, W);
    const haze = opts.dehaze ? this.hazeMap(video, zoom) : null;

    let faces = [];
    if (this.detector) {
      try {
        const ts = Math.max(performance.now(), this.lastTs + 1);
        this.lastTs = ts;
        const res = this.detector.detectForVideo(this.canvas, ts);
        faces = (res.detections || []).map((d) => {
          const bb = d.boundingBox;
          return { x: bb.originX / W, y: bb.originY / H, w: bb.width / W, h: bb.height / H };
        }).filter((f) => f.w > 0.02).sort((p, q) => q.w * q.h - p.w * p.h);
      } catch (e) {
        console.warn("[Cámara] Falló la detección de caras", e);
      }
    }

    let subject = null, isFace = false, tracked = null;
    if (manual) {
      const dist = (f) => Math.hypot(f.x + f.w / 2 - manual.x, f.y + f.h / 2 - manual.y);
      const near = faces.filter((f) => {
        const inX = manual.x >= f.x - f.w * 0.5 && manual.x <= f.x + f.w * 1.5;
        const inY = manual.y >= f.y - f.h * 0.5 && manual.y <= f.y + f.h * 1.5;
        return (inX && inY) || dist(f) < 0.15;
      }).sort((p, q) => dist(p) - dist(q));
      if (near.length) {
        subject = near[0]; isFace = true;
        tracked = { x: subject.x + subject.w / 2, y: subject.y + subject.h / 2 };
      } else {
        const w = 0.14, h = 0.14 * W / H;
        subject = { x: manual.x - w / 2, y: manual.y - h / 2, w, h };
      }
    } else if (faces.length) {
      subject = faces[0]; isFace = true;
    }

    const img = this.ctx.getImageData(0, 0, W, H).data;

    if (subject) {
      // Color medio (lineal) dentro de la cara, ya sin velo, con un margen del 15 %.
      const x0 = Math.max(0, Math.floor((subject.x + subject.w * 0.15) * W));
      const x1 = Math.min(W, Math.ceil((subject.x + subject.w * 0.85) * W));
      const y0 = Math.max(0, Math.floor((subject.y + subject.h * 0.15) * H));
      const y1 = Math.min(H, Math.ceil((subject.y + subject.h * 0.85) * H));
      if (x1 - x0 < 2 || y1 - y0 < 2) return { rect: subject, ev: 0, isFace, tracked, gains: [1, 1, 1] };
      const acc = [0, 0, 0];
      let count = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * W + x) * 4;
        let c = [LIN[img[i]], LIN[img[i + 1]], LIN[img[i + 2]]];
        if (haze) {
          const hx = Math.min(haze.w - 1, Math.floor(x / W * haze.w)), hy = Math.min(haze.h - 1, Math.floor(y / H * haze.h));
          const m = ovalAt(x, y, W, H, subject, 0.9, 2.2, 0.3);
          c = c.map((v, ch) => {
            const kv = haze.data[(hy * haze.w + hx) * 4 + ch] / 255 * 0.35;
            return v + (Math.max((v - kv) / (1 - kv), 0) - v) * m;
          });
        }
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; count++;
      }
      let rgb = acc.map((v) => enc(v / count));
      let gains = [1, 1, 1];
      if (opts.skin && isFace) {
        gains = skinGains(rgb);
        const lin = rgb.map((v, i) => Math.pow(v, 2.2) * gains[i]);
        rgb = lin.map(enc);
      }
      return { rect: subject, ev: evNeeded(luma(rgb), 0.52, 2.0), isFace, tracked, gains };
    }

    // Sin cara ni clic: solo compensamos si el fondo está claramente más claro que el centro.
    const avg = (rx, ry, rw, rh) => {
      const xa = Math.floor(rx * W), xb = Math.ceil((rx + rw) * W), ya = Math.floor(ry * H), yb = Math.ceil((ry + rh) * H);
      const acc = [0, 0, 0]; let n = 0;
      for (let y = ya; y < yb; y += 3) for (let x = xa; x < xb; x += 3) {
        const i = (y * W + x) * 4;
        acc[0] += LIN[img[i]]; acc[1] += LIN[img[i + 1]]; acc[2] += LIN[img[i + 2]]; n++;
      }
      return luma(acc.map((v) => enc(v / Math.max(n, 1))));
    };
    const center = { x: 0.3, y: 0.2, w: 0.4, h: 0.6 };
    const c = avg(center.x, center.y, center.w, center.h);
    const all = avg(0, 0, 1, 1);
    if (all <= c + 0.08) return { rect: null, ev: 0, isFace: false, tracked: null, gains: [1, 1, 1] };
    return { rect: center, ev: evNeeded(c, 0.5, 1.2), isFace: false, tracked: null, gains: [1, 1, 1] };
  }
}
