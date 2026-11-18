// Pipeline de imagen en WebGL2: equivalente web de ImagePipeline (Adjustments.swift).
// Paso 1: zoom digital → contraluz (quitar velo, piel, luz de relleno) → ajustes y estilo.
// Paso 2: reducción de ruido → nitidez (global y en la cara) → viñeta → espejo.
// Todas las coordenadas normalizadas usan origen arriba a la izquierda.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const COMMON = `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toEnc(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
// Óvalo con borde suave alrededor del sujeto s (x, y, w, h). inner/outer: radios relativos al
// tamaño de la cara; drop baja el centro hacia el cuello. Igual que ovalMask en Swift.
float oval(vec2 uv, vec2 size, vec4 s, float inner, float outer, float drop) {
  vec2 px = uv * size;
  float fw = s.z * size.x, fh = s.w * size.y;
  float f = max(fw, fh);
  vec2 c = vec2((s.x + s.z * 0.5) * size.x, (s.y + s.w * 0.5) * size.y + fh * drop);
  vec2 d = px - c;
  d.y /= 1.25;
  return 1.0 - clamp((length(d) - f * inner) / (f * (outer - inner)), 0.0, 1.0);
}`;

const PASS1 = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform sampler2D uHaze;
uniform vec2 uSize;
uniform vec2 uSrcUv0;      // esquina del recorte (zoom) en la textura fuente
uniform vec2 uSrcUvSize;   // tamaño del recorte
uniform float uBlurLod;    // nivel de mipmap para la «claridad» del quitar velo
uniform float uDarkLod;    // desenfoque leve para la máscara de sombras
uniform int uBL;
uniform vec4 uSubject;
uniform float uEV;
uniform vec3 uGains;
uniform int uDehaze;
uniform int uSkin;
uniform float uExposure;
uniform vec3 uWB;
uniform float uContrast;
uniform float uSat;
uniform float uVibrance;
uniform float uShadows;
uniform float uHighlights;
uniform int uEffect;
${COMMON}
float onlyDark(vec3 lin) { return clamp(1.6 - 3.0 * luma(lin), 0.0, 1.0); }

void main() {
  vec2 suv = uSrcUv0 + vUv * uSrcUvSize;
  vec3 c = toLin(texture(uSrc, suv).rgb);

  if (uBL == 1 && uSubject.z > 0.0) {
    float dark = onlyDark(toLin(textureLod(uSrc, suv, uDarkLod).rgb));
    if (uDehaze == 1) {
      vec3 kv = texture(uHaze, vUv).rgb * 0.35;
      vec3 clear = (c - kv) / (1.0 - kv);
      vec3 b = toLin(textureLod(uSrc, suv, uBlurLod).rgb);
      vec3 bc = (b - kv) / (1.0 - kv);
      clear = max(clear + (clear - bc) * 0.3, 0.0);
      c = mix(c, clear, oval(vUv, uSize, uSubject, 0.9, 2.2, 0.3));
    }
    if (uSkin == 1) {
      c = mix(c, c * uGains, oval(vUv, uSize, uSubject, 1.3, 3.6, 0.6) * dark);
    }
    if (uEV > 0.01) {
      c = mix(c, c * exp2(uEV), oval(vUv, uSize, uSubject, 0.5, 1.2, 0.1) * dark);
    }
  }

  c *= exp2(uExposure);
  c *= uWB;
  vec3 e = toEnc(c);

  e = (e - 0.5) * uContrast + 0.5;
  float L = luma(e);
  e = mix(vec3(L), e, uSat);

  if (uVibrance > 0.0) {
    float mx = max(e.r, max(e.g, e.b)), mn = min(e.r, min(e.g, e.b));
    float amt = uVibrance * (1.0 - clamp((mx - mn) * 1.6, 0.0, 1.0));
    e = mix(vec3(luma(e)), e, 1.0 + amt);
  }
  if (uShadows != 0.0 || uHighlights != 1.0) {
    float l = clamp(luma(e), 0.0, 1.0);
    e *= 1.0 + uShadows * (1.0 - smoothstep(0.0, 0.5, l)) * 0.9;
    e = mix(e, 0.5 + (e - 0.5) * uHighlights, smoothstep(0.45, 1.0, l));
  }

  e = clamp(e, 0.0, 1.0);
  L = luma(e);
  if (uEffect == 1) {            // Mono: blanco y negro suave
    e = vec3(L * 0.94 + 0.03);
  } else if (uEffect == 2) {     // Noir: blanco y negro de alto contraste
    float n = clamp((L - 0.5) * 1.55 + 0.47, 0.0, 1.0);
    e = vec3(n * n * (3.0 - 2.0 * n) * 0.6 + n * 0.4);
  } else if (uEffect == 3) {     // Cromo: más color y contraste, sombras algo frías
    e = mix(vec3(L), e, 1.3);
    e = (e - 0.5) * 1.12 + 0.5;
    e += vec3(-0.015, 0.0, 0.03) * (1.0 - L);
  } else if (uEffect == 4) {     // Desvanecido: negros levantados y poco color
    e = mix(vec3(L), e, 0.62);
    e = e * 0.82 + 0.1;
    e *= vec3(1.02, 1.0, 0.96);
  } else if (uEffect == 5) {     // Instantánea: tono cálido y suave, tipo película instantánea
    e = mix(vec3(L), e, 0.85);
    e = (e - 0.5) * 0.9 + 0.53;
    e *= vec3(1.06, 1.01, 0.86);
    e += vec3(0.0, 0.01, 0.04) * (1.0 - L);
  }
  outColor = vec4(clamp(e, 0.0, 1.0), 1.0);
}`;

const PASS2 = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform float uNR;
uniform float uSharp;
uniform float uFaceSharp;
uniform vec4 uSubject;
uniform float uVignette;
uniform int uMirror;
${COMMON}
vec3 tap(vec2 uv) { return texture(uTex, vec2(uv.x, 1.0 - uv.y)).rgb; }

void main() {
  vec2 uv = vUv;
  if (uMirror == 1) uv.x = 1.0 - uv.x;
  vec2 px = 1.0 / uSize;
  vec3 c = tap(uv);

  if (uNR > 0.001 || uSharp > 0.001 || uFaceSharp > 0.001) {
    float sigma = 0.02 + uNR * 0.1;
    float inv = 1.0 / (2.0 * sigma * sigma);
    vec3 bil = vec3(0.0); float bw = 0.0;
    vec3 blur = vec3(0.0); float gw = 0.0;
    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        vec2 o = vec2(float(x), float(y));
        vec3 s = tap(uv + o * px * 1.2);
        float g = exp(-dot(o, o) / 3.0);
        vec3 d = s - c;
        float w = g * exp(-dot(d, d) * inv);
        bil += s * w; bw += w;
        blur += s * g; gw += g;
      }
    }
    bil /= bw; blur /= gw;
    vec3 base = mix(c, bil, clamp(uNR * 1.2, 0.0, 1.0));
    float amount = uSharp * 1.2;
    if (uFaceSharp > 0.0 && uSubject.z > 0.0) amount += uFaceSharp * oval(uv, uSize, uSubject, 0.45, 0.85, 0.0);
    float detail = luma(base) - luma(mix(blur, bil, clamp(uNR, 0.0, 1.0)));
    c = base + detail * amount * 1.6;
  }

  if (uVignette > 0.001) {
    float aspect = uSize.x / uSize.y;
    vec2 d = (uv - 0.5) * vec2(aspect, 1.0);
    float r = length(d) / length(vec2(aspect, 1.0) * 0.5);
    c *= 1.0 - min(uVignette * 1.6, 1.6) * 0.42 * smoothstep(0.3, 1.05, r);
  }
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// Fusión: promedio de hasta 8 fotogramas alineados (desplazamiento por fotograma en UV de la fuente).
const FUSE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uF[8];
uniform vec2 uOff[8];
uniform float uW[8];
vec3 tapF(int i, vec2 uv) {
  if (i == 0) return texture(uF[0], uv).rgb;
  if (i == 1) return texture(uF[1], uv).rgb;
  if (i == 2) return texture(uF[2], uv).rgb;
  if (i == 3) return texture(uF[3], uv).rgb;
  if (i == 4) return texture(uF[4], uv).rgb;
  if (i == 5) return texture(uF[5], uv).rgb;
  if (i == 6) return texture(uF[6], uv).rgb;
  return texture(uF[7], uv).rgb;
}
void main() {
  // Se escribe con la misma orientación que una textura de vídeo (fila 0 = arriba).
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = 0; i < 8; i++) {
    if (uW[i] > 0.0) {
      vec3 s = tapF(i, clamp(uv + uOff[i], vec2(0.0), vec2(1.0)));
      acc += pow(s, vec3(2.2)) * uW[i];
      ws += uW[i];
    }
  }
  outColor = vec4(pow(acc / max(ws, 1e-4), vec3(1.0 / 2.2)), 1.0);
}`;

const STYLE_EFFECT = { mono: 1, noir: 2, chrome: 3, fade: 4, instant: 5 };

/** Colores (0..1) de un cuerpo negro a `k` grados Kelvin (aproximación de Tanner Helland). */
function kelvinRGB(k) {
  const t = k / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v) => Math.min(Math.max(v, 0), 255) / 255;
  return [c(r), c(g), c(b)];
}

/** Ganancias lineales por canal para temperatura (K) y tinte. Menos K = más cálido, como en la app. */
export function whiteBalanceGains(temperature, tint) {
  const a = kelvinRGB(temperature), n = kelvinRGB(6500);
  let g = [a[0] / n[0], a[1] / n[1], a[2] / n[2]].map((v) => Math.pow(v, 1.1));
  g = [g[0] * (1 + tint * 0.0016), g[1] * (1 - tint * 0.0032), g[2] * (1 + tint * 0.0016)];
  const l = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  return g.map((v) => v / l);
}

/** Parámetros derivados del estilo, como el switch de ImagePipeline.apply. */
export function styleParams(adj) {
  let { temperature, tint, contrast, saturation } = adj;
  let vibrance = 0, shadows = 0, highlights = 1;
  switch (adj.style) {
    case "vivid": saturation *= 1.18; contrast *= 1.06; vibrance = 0.45; break;
    case "warm": temperature -= 900; tint += 6; vibrance = 0.15; break;
    case "cool": temperature += 1200; tint -= 4; break;
    case "dramatic": contrast *= 1.22; saturation *= 0.82; shadows = -0.25; highlights = 0.8; break;
  }
  return { temperature, tint, contrast, saturation, vibrance, shadows, highlights, effect: STYLE_EFFECT[adj.style] || 0 };
}

export class Pipeline {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 no disponible");
    this.gl = gl;
    this.p1 = this.program(PASS1);
    this.p2 = this.program(PASS2);
    this.pf = this.program(FUSE);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.srcTex = this.texture(true);
    this.hazeTex = this.texture(false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.midTex = this.texture(false);
    this.midFbo = gl.createFramebuffer();
    this.midSize = [0, 0];
    this.burst = [];
    this.fusedTex = null;
    this.fusedFbo = null;
    this.srcSize = [0, 0];
  }

  program(fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, "");
      u[name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  texture(mip) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Sube el fotograma actual del vídeo (con mipmaps, para los desenfoques del contraluz). */
  upload(video) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.srcSize = [video.videoWidth, video.videoHeight];
  }

  /** Mapa de velo (RGBA8, valores k·V / 0,35) en el espacio de la imagen con zoom. */
  setHaze(data, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.hazeTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  ensureMid(w, h) {
    if (this.midSize[0] === w && this.midSize[1] === h) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.midTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.midFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.midTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.midSize = [w, h];
  }

  /**
   * Dibuja en el canvas. `s` = estado: zoom, adjustments, mirror, backlight {on, subject, ev, gains,
   * dehaze, skin, sharpen}, strongSharpen y useFused (usar la imagen fusionada como fuente).
   */
  render(s) {
    const gl = this.gl;
    const [w, h] = this.srcSize;
    if (!w || !h) return;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.ensureMid(w, h);
    gl.bindVertexArray(this.vao);

    const zoom = Math.max(1, s.zoom);
    const uvSize = 1 / zoom, uv0 = (1 - uvSize) / 2;
    const st = styleParams(s.adjustments);
    const wb = whiteBalanceGains(st.temperature, st.tint);
    const bl = s.backlight;
    const subj = bl.on && bl.subject ? [bl.subject.x, bl.subject.y, bl.subject.w, bl.subject.h] : [0, 0, 0, 0];

    // Paso 1
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.midFbo);
    gl.viewport(0, 0, w, h);
    const { p, u } = this.p1;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.useFused && this.fusedTex ? this.fusedTex : this.srcTex);
    gl.uniform1i(u.uSrc, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.hazeTex);
    gl.uniform1i(u.uHaze, 1);
    gl.uniform2f(u.uSize, w, h);
    gl.uniform2f(u.uSrcUv0, uv0, uv0);
    gl.uniform2f(u.uSrcUvSize, uvSize, uvSize);
    gl.uniform1f(u.uBlurLod, Math.max(0, Math.log2(w / 60 / zoom)));
    gl.uniform1f(u.uDarkLod, Math.max(0, Math.log2(w / 1200 / zoom) + 1));
    gl.uniform1i(u.uBL, bl.on && bl.subject ? 1 : 0);
    gl.uniform4f(u.uSubject, ...subj);
    gl.uniform1f(u.uEV, bl.ev || 0);
    gl.uniform3f(u.uGains, ...(bl.gains || [1, 1, 1]));
    gl.uniform1i(u.uDehaze, bl.dehaze ? 1 : 0);
    gl.uniform1i(u.uSkin, bl.skin ? 1 : 0);
    gl.uniform1f(u.uExposure, s.adjustments.exposure);
    gl.uniform3f(u.uWB, ...wb);
    gl.uniform1f(u.uContrast, st.contrast);
    gl.uniform1f(u.uSat, st.saturation);
    gl.uniform1f(u.uVibrance, st.vibrance);
    gl.uniform1f(u.uShadows, st.shadows);
    gl.uniform1f(u.uHighlights, st.highlights);
    gl.uniform1i(u.uEffect, st.effect);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Paso 2
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    const q = this.p2;
    gl.useProgram(q.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.midTex);
    gl.uniform1i(q.u.uTex, 0);
    gl.uniform2f(q.u.uSize, w, h);
    gl.uniform1f(q.u.uNR, s.adjustments.noiseReduction);
    gl.uniform1f(q.u.uSharp, s.adjustments.sharpness);
    gl.uniform1f(q.u.uFaceSharp, bl.on && bl.sharpen && bl.subject ? (s.strongSharpen ? 0.6 : 0.35) : 0);
    gl.uniform4f(q.u.uSubject, ...subj);
    gl.uniform1f(q.u.uVignette, s.adjustments.vignette);
    gl.uniform1i(q.u.uMirror, s.mirror ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---------- Fusión de fotogramas ----------

  /** Copia el fotograma actual del vídeo en la ranura `i` de la ráfaga. */
  grabBurstFrame(i, video) {
    const gl = this.gl;
    if (!this.burst[i]) this.burst[i] = this.texture(false);
    gl.bindTexture(gl.TEXTURE_2D, this.burst[i]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  }

  /** Promedia los fotogramas válidos con sus desplazamientos (UV de la fuente) en una textura con mipmaps. */
  fuse(offsets, weights) {
    const gl = this.gl;
    const [w, h] = this.srcSize;
    if (!this.fusedTex) {
      this.fusedTex = this.texture(true);
      this.fusedFbo = gl.createFramebuffer();
      this.fusedSize = [0, 0];
    }
    if (this.fusedSize[0] !== w || this.fusedSize[1] !== h) {
      gl.bindTexture(gl.TEXTURE_2D, this.fusedTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fusedFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fusedTex, 0);
      this.fusedSize = [w, h];
    }
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fusedFbo);
    gl.viewport(0, 0, w, h);
    const { p, u } = this.pf;
    gl.useProgram(p);
    const units = [], off = [], wt = [];
    for (let i = 0; i < 8; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.burst[i] || this.burst[0]);
      units.push(i);
      off.push(...(offsets[i] || [0, 0]));
      wt.push(this.burst[i] ? weights[i] || 0 : 0);
    }
    gl.uniform1iv(u.uF, units);
    gl.uniform2fv(u.uOff, off);
    gl.uniform1fv(u.uW, wt);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.fusedTex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }
}
