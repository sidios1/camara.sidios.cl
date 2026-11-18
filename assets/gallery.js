// Capturas: equivalente web de MediaStore (guardado) y GalleryView (visor).
// Las fotos y vídeos se guardan en IndexedDB, solo en este navegador.

const DB_NAME = "camara";
const STORE = "media";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const os = req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      os.createIndex("date", "date");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
const db = () => (dbPromise ||= openDB());

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
/** Nombre como en la app: IMG_yyyyMMdd_HHmmss_SSS.ext */
export function fileName(prefix, ext, d = new Date()) {
  return `${prefix}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}.${ext}`;
}

export const MediaStore = {
  /** Guarda { name, type, blob, thumb, isVideo, width, height } y devuelve el registro con id. */
  async add(item) {
    const rec = { ...item, date: Date.now() };
    const id = await tx("readwrite", (s) => s.add(rec));
    // Pide almacenamiento persistente (para que el navegador no borre las capturas por falta de espacio).
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    return { ...rec, id };
  },
  /** Metadatos de todas las capturas, de la más reciente a la más antigua (sin el archivo completo). */
  async list() {
    const all = await tx("readonly", (s) => s.getAll());
    return (all || []).map(({ blob, ...meta }) => meta).sort((a, b) => b.date - a.date);
  },
  async get(id) { return tx("readonly", (s) => s.get(id)); },
  async remove(id) { return tx("readwrite", (s) => s.delete(id)); },
  async latest() {
    const items = await this.list();
    return items[0] || null;
  },
};

/** Descarga un blob con su nombre. */
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Miniatura cuadrada (JPEG, 240 px) a partir de un canvas o un elemento dibujable. */
export function makeThumb(source, sw, sh) {
  const size = 240;
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const s = Math.min(sw, sh);
  c.getContext("2d").drawImage(source, (sw - s) / 2, (sh - s) / 2, s, s, 0, 0, size, size);
  return new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
}

// ---------------------------------------------------------------------------------------------
// Visor

export class GalleryView {
  constructor({ onClose, onChange, toast }) {
    this.el = document.getElementById("gallery");
    this.img = document.getElementById("gal-img");
    this.video = document.getElementById("gal-video");
    this.empty = document.getElementById("gal-empty");
    this.strip = document.getElementById("filmstrip");
    this.sub = document.getElementById("gal-sub");
    this.title = document.getElementById("gal-title");
    this.prev = document.getElementById("gal-prev");
    this.next = document.getElementById("gal-next");
    this.shareBtn = document.getElementById("gal-share");
    this.onClose = onClose;
    this.onChange = onChange;
    this.toast = toast;
    this.items = [];
    this.index = 0;
    this.urls = new Map();
    this.current = null;
    this.loadToken = 0;
    this.zoom = { s: 1, x: 0, y: 0 };

    document.getElementById("gal-back").addEventListener("click", () => this.close());
    this.prev.addEventListener("click", () => this.step(-1));
    this.next.addEventListener("click", () => this.step(1));
    document.getElementById("gal-download").addEventListener("click", () => this.downloadCurrent());
    document.getElementById("gal-delete").addEventListener("click", () => this.removeCurrent());
    this.shareBtn.addEventListener("click", () => this.shareCurrent());
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    this.setupZoom();
  }

  get isOpen() { return !this.el.hidden; }

  async open(selectId) {
    this.lastFocus = document.activeElement;
    this.el.hidden = false;
    this.el.tabIndex = -1;
    this.el.focus();
    await this.reload(selectId);
  }

  close() {
    if (!this.isOpen) return;
    this.video.pause();
    this.el.hidden = true;
    this.clearMedia();
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.onClose?.();
    this.lastFocus?.focus?.();
  }

  async reload(selectId) {
    this.items = await MediaStore.list();
    let i = selectId != null ? this.items.findIndex((x) => x.id === selectId) : 0;
    this.renderStrip();
    this.select(Math.max(0, i));
  }

  renderStrip() {
    this.strip.textContent = "";
    for (const [i, it] of this.items.entries()) {
      const b = document.createElement("button");
      b.type = "button";
      b.title = it.name;
      b.setAttribute("aria-label", `${it.isVideo ? "Vídeo" : "Foto"} ${it.name}`);
      if (it.isVideo) b.classList.add("vid");
      if (it.thumb) {
        const im = document.createElement("img");
        im.alt = "";
        im.loading = "lazy";
        im.src = this.thumbURL(it);
        b.append(im);
      }
      b.addEventListener("click", () => this.select(i));
      this.strip.append(b);
    }
  }

  thumbURL(it) {
    const key = "t" + it.id;
    if (!this.urls.has(key)) this.urls.set(key, URL.createObjectURL(it.thumb));
    return this.urls.get(key);
  }

  clearMedia() {
    this.img.hidden = true;
    this.img.removeAttribute("src");
    this.video.hidden = true;
    this.video.removeAttribute("src");
    this.video.load();
    if (this.mediaURL) { URL.revokeObjectURL(this.mediaURL); this.mediaURL = null; }
  }

  async select(i) {
    const n = this.items.length;
    this.empty.hidden = n > 0;
    this.prev.disabled = i <= 0;
    this.next.disabled = i >= n - 1;
    [...this.strip.children].forEach((b, k) => b.classList.toggle("on", k === i));
    this.strip.children[i]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (!n) {
      this.current = null;
      this.clearMedia();
      this.title.textContent = "Capturas";
      this.sub.textContent = "";
      this.shareBtn.hidden = true;
      return;
    }
    this.index = Math.min(Math.max(i, 0), n - 1);
    const meta = this.items[this.index];
    const fmt = new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" });
    this.title.textContent = fmt.format(meta.date);
    this.sub.textContent = `${this.index + 1} de ${n} · ${meta.name}`;
    this.resetZoom();

    const token = ++this.loadToken;
    const rec = await MediaStore.get(meta.id);
    if (token !== this.loadToken || !rec) return;
    this.clearMedia();
    this.current = rec;
    this.mediaURL = URL.createObjectURL(rec.blob);
    if (rec.isVideo) {
      this.video.src = this.mediaURL;
      this.video.hidden = false;
    } else {
      this.img.src = this.mediaURL;
      this.img.hidden = false;
    }
    const file = new File([rec.blob], rec.name, { type: rec.type });
    this.shareBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  }

  step(d) { if (this.items.length) this.select(Math.min(Math.max(this.index + d, 0), this.items.length - 1)); }

  downloadCurrent() { if (this.current) download(this.current.blob, this.current.name); }

  async shareCurrent() {
    if (!this.current) return;
    const file = new File([this.current.blob], this.current.name, { type: this.current.type });
    try { await navigator.share({ files: [file], title: this.current.name }); }
    catch (e) { if (e.name !== "AbortError") this.toast("No se pudo compartir"); }
  }

  async removeCurrent() {
    if (!this.current) return;
    const { id, isVideo } = this.current;
    await MediaStore.remove(id);
    this.urls.has("t" + id) && URL.revokeObjectURL(this.urls.get("t" + id));
    this.urls.delete("t" + id);
    const keep = this.index;
    this.items = this.items.filter((x) => x.id !== id);
    this.renderStrip();
    this.select(Math.min(keep, this.items.length - 1));
    this.toast(isVideo ? "Vídeo borrado" : "Foto borrada");
    this.onChange?.();
  }

  onKey(e) {
    if (e.key === "ArrowLeft") { this.step(-1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { this.step(1); e.preventDefault(); }
    else if (e.key === "Escape") { this.close(); e.preventDefault(); }
    else if (e.key === "Delete" || e.key === "Backspace") { this.removeCurrent(); e.preventDefault(); }
    else if (e.key === " " && !this.video.hidden && e.target !== this.video) {
      this.video.paused ? this.video.play() : this.video.pause();
      e.preventDefault();
    }
    e.stopPropagation();
  }

  // Zoom de la foto: doble clic, rueda o pellizco; arrastrar para mover.
  resetZoom() { this.zoom = { s: 1, x: 0, y: 0 }; this.applyZoom(); }
  applyZoom() {
    const { s, x, y } = this.zoom;
    this.img.style.transform = s > 1.001 ? `translate(${x}px, ${y}px) scale(${s})` : "";
    this.img.classList.toggle("zoomed", s > 1.001);
  }
  setupZoom() {
    const stage = document.getElementById("gal-stage");
    const pointers = new Map();
    let base = null;
    const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
    this.img.addEventListener("dblclick", () => {
      this.zoom = this.zoom.s > 1.01 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 };
      this.applyZoom();
    });
    stage.addEventListener("wheel", (e) => {
      if (this.img.hidden) return;
      e.preventDefault();
      const s = clamp(this.zoom.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), 1, 8);
      this.zoom = s <= 1.001 ? { s: 1, x: 0, y: 0 } : { ...this.zoom, s };
      this.applyZoom();
    }, { passive: false });
    stage.addEventListener("pointerdown", (e) => {
      if (this.img.hidden || e.target.closest("button")) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      stage.setPointerCapture(e.pointerId);
      base = { ...this.zoom, pts: new Map(pointers) };
    });
    stage.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId) || !base) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...pointers.values()], b = [...base.pts.values()];
      if (pts.length >= 2 && b.length >= 2) {
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const d0 = Math.hypot(b[0].x - b[1].x, b[0].y - b[1].y) || 1;
        this.zoom.s = clamp(base.s * d / d0, 1, 8);
      } else if (this.zoom.s > 1.01 && b.length) {
        this.zoom.x = base.x + pts[0].x - b[0].x;
        this.zoom.y = base.y + pts[0].y - b[0].y;
      }
      this.applyZoom();
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      base = pointers.size ? { ...this.zoom, pts: new Map(pointers) } : null;
      if (this.zoom.s <= 1.01) this.resetZoom();
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
  }
}
