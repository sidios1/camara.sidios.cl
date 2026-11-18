// Fusión de varios fotogramas seguidos (equivalente web de FrameFusion en Backlight.swift):
// se alinean por traslación y se promedian para quitar el ruido que aparece al aclarar las sombras.
// El análisis se hace en la CPU sobre versiones pequeñas en escala de grises; el promedio, en la GPU.

export const FRAME_COUNT = 8;
const AW = 320; // ancho del análisis

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = Math.pow(i / 255, 2.2);

export class BurstAnalyzer {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.frames = [];
  }

  reset() { this.frames = []; }

  /** Guarda la luminancia lineal del fotograma (recorte con zoom) a 320 px de ancho. */
  add(video, zoom) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const H = Math.max(1, Math.round(AW * vh / vw));
    if (this.canvas.width !== AW || this.canvas.height !== H) { this.canvas.width = AW; this.canvas.height = H; }
    const sw = vw / zoom, sh = vh / zoom;
    this.ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, AW, H);
    const px = this.ctx.getImageData(0, 0, AW, H).data;
    const g = new Float32Array(AW * H);
    for (let i = 0; i < g.length; i++) g[i] = 0.2126 * LIN[px[i * 4]] + 0.7152 * LIN[px[i * 4 + 1]] + 0.0722 * LIN[px[i * 4 + 2]];
    this.frames.push(g);
    this.h = H;
  }

  /**
   * Elige la referencia (la más nítida en la zona del sujeto), alinea las demás y descarta las que
   * tienen movimiento dentro del cuadro. Devuelve { offsets: [[du, dv]…] en UV de la fuente, weights, used }.
   * `subject`: zona {x, y, w, h} normalizada o null; `zoom`: zoom digital aplicado.
   */
  solve(subject, zoom) {
    const W = AW, H = this.h, n = this.frames.length;
    const s = subject || { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
    const fx0 = Math.max(8, Math.floor(s.x * W)), fx1 = Math.min(W - 8, Math.ceil((s.x + s.w) * W));
    const fy0 = Math.max(8, Math.floor(s.y * H)), fy1 = Math.min(H - 8, Math.ceil((s.y + s.h) * H));
    const focus = { x0: fx0, x1: Math.max(fx0 + 8, fx1), y0: fy0, y1: Math.max(fy0 + 8, fy1) };

    // Nitidez: energía de bordes en la zona del sujeto.
    const sharp = this.frames.map((g) => {
      let e = 0;
      for (let y = focus.y0; y < focus.y1; y++) for (let x = focus.x0; x < focus.x1; x++) {
        const i = y * W + x;
        e += Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + W] - g[i - W]);
      }
      return e;
    });
    let sharpest = 0;
    sharp.forEach((v, i) => { if (v > sharp[sharpest]) sharpest = i; });

    let result = this.align(sharpest, focus);
    // Si la más nítida es justo la rara (alguien se movió), probamos con la del medio.
    const middle = Math.floor(n / 2);
    if (result.used * 2 < n && sharpest !== middle) {
      const alt = this.align(middle, focus);
      if (alt.used > result.used) result = alt;
    }
    // Desplazamientos en píxeles de análisis → UV de la textura fuente (sin zoom).
    result.offsets = result.shifts.map(([dx, dy]) => [dx / W / zoom, dy / H / zoom]);
    return result;
  }

  align(ref, focus) {
    const W = AW, H = this.h;
    const R = this.frames[ref];
    const max = Math.max(3, Math.round(W * 0.03));
    const shifts = [], weights = [];
    let used = 0;
    // Media de |a − b| en la zona del sujeto (submuestreada), con desplazamiento entero.
    const sad = (F, dx, dy, step) => {
      let s = 0, c = 0;
      for (let y = focus.y0; y < focus.y1; y += step) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let x = focus.x0; x < focus.x1; x += step) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          s += Math.abs(R[y * W + x] - F[yy * W + xx]); c++;
        }
      }
      return c ? s / c : Infinity;
    };
    for (let k = 0; k < this.frames.length; k++) {
      if (k === ref) { shifts.push([0, 0]); weights.push(1); used++; continue; }
      const F = this.frames[k];
      // Búsqueda gruesa (cada 2 px) y luego fina alrededor del mejor.
      let best = [0, 0], bv = Infinity;
      for (let dy = -max; dy <= max; dy += 2) for (let dx = -max; dx <= max; dx += 2) {
        const v = sad(F, dx, dy, 3);
        if (v < bv) { bv = v; best = [dx, dy]; }
      }
      const [cx, cy] = best;
      for (let dy = cy - 2; dy <= cy + 2; dy++) for (let dx = cx - 2; dx <= cx + 2; dx++) {
        const v = sad(F, dx, dy, 1);
        if (v < bv) { bv = v; best = [dx, dy]; }
      }
      // Refinamiento subpíxel con una parábola en cada eje.
      const [bx, by] = best;
      const sub = (a, b, c) => { const d = a - 2 * b + c; return d > 1e-9 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d))) : 0; };
      const fine = sad(F, bx, by, 1);
      const ox = sub(sad(F, bx - 1, by, 1), fine, sad(F, bx + 1, by, 1));
      const oy = sub(sad(F, bx, by - 1, 1), fine, sad(F, bx, by + 1, 1));
      // Si algo se movió dentro del cuadro (no solo la cámara), descartamos el fotograma.
      const moving = fine > 0.015 || Math.abs(bx) > max || Math.abs(by) > max;
      shifts.push([bx + ox, by + oy]);
      weights.push(moving ? 0 : 1);
      if (!moving) used++;
    }
    return { shifts, weights, used, ref };
  }
}
