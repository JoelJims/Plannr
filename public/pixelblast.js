// PixelBlast — amber pixel-dither background for the Cash Flow page.
// Converted from the React Bits "PixelBlast" component to plain JS the same way
// LineWaves / Prism / Hyperspeed were: no React, no hooks/props/JSX/export-default.
// A single init function mounts into a fixed full-viewport container.
//
// RESTRAINED / IDLE by design (this is an idle landing page):
//   - color hardcoded to amber #f59e0b (the one-amber rule, not the lavender default).
//   - liquid = false and noiseAmount = 0, so the postprocessing / liquid / noise /
//     touch-texture code paths are removed entirely — this needs only `three`
//     (loaded locally via the page's import map; no CDN, no new install).
//   - enableRipples = true is the ONLY motion: at rest we render a SINGLE static
//     frame and stop. A tap starts the loop; the ripple propagates and fades; then
//     the loop auto-stops back to static. No continuous churn.
//   - autoPauseOffscreen (IntersectionObserver), reduced-motion single-frame,
//     dpr capped at 2, full teardown on pagehide.

import * as THREE from 'three';

const MAX_CLICKS = 10;
const SHAPE = { square: 0, circle: 1, triangle: 2, diamond: 3 };

const VERTEX_SRC = `
void main() {
  gl_Position = vec4(position, 1.0);
}
`;

const FRAGMENT_SRC = `
precision highp float;

uniform vec3  uColor;
uniform vec2  uResolution;
uniform float uTime;
uniform float uPixelSize;
uniform float uScale;
uniform float uDensity;
uniform float uPixelJitter;
uniform int   uEnableRipples;
uniform float uRippleSpeed;
uniform float uRippleThickness;
uniform float uRippleIntensity;
uniform float uEdgeFade;

uniform int   uShapeType;
const int SHAPE_SQUARE   = 0;
const int SHAPE_CIRCLE   = 1;
const int SHAPE_TRIANGLE = 2;
const int SHAPE_DIAMOND  = 3;

const int   MAX_CLICKS = 10;

uniform vec2  uClickPos  [MAX_CLICKS];
uniform float uClickTimes[MAX_CLICKS];

out vec4 fragColor;

float Bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2. + a.y * a.y * .75);
}
#define Bayer4(a) (Bayer2(.5*(a))*0.25 + Bayer2(a))
#define Bayer8(a) (Bayer4(.5*(a))*0.25 + Bayer2(a))

#define FBM_OCTAVES     5
#define FBM_LACUNARITY  1.25
#define FBM_GAIN        1.0

float hash11(float n){ return fract(sin(n)*43758.5453); }

float vnoise(vec3 p){
  vec3 ip = floor(p);
  vec3 fp = fract(p);
  float n000 = hash11(dot(ip + vec3(0.0,0.0,0.0), vec3(1.0,57.0,113.0)));
  float n100 = hash11(dot(ip + vec3(1.0,0.0,0.0), vec3(1.0,57.0,113.0)));
  float n010 = hash11(dot(ip + vec3(0.0,1.0,0.0), vec3(1.0,57.0,113.0)));
  float n110 = hash11(dot(ip + vec3(1.0,1.0,0.0), vec3(1.0,57.0,113.0)));
  float n001 = hash11(dot(ip + vec3(0.0,0.0,1.0), vec3(1.0,57.0,113.0)));
  float n101 = hash11(dot(ip + vec3(1.0,0.0,1.0), vec3(1.0,57.0,113.0)));
  float n011 = hash11(dot(ip + vec3(0.0,1.0,1.0), vec3(1.0,57.0,113.0)));
  float n111 = hash11(dot(ip + vec3(1.0,1.0,1.0), vec3(1.0,57.0,113.0)));
  vec3 w = fp*fp*fp*(fp*(fp*6.0-15.0)+10.0);
  float x00 = mix(n000, n100, w.x);
  float x10 = mix(n010, n110, w.x);
  float x01 = mix(n001, n101, w.x);
  float x11 = mix(n011, n111, w.x);
  float y0  = mix(x00, x10, w.y);
  float y1  = mix(x01, x11, w.y);
  return mix(y0, y1, w.z) * 2.0 - 1.0;
}

float fbm2(vec2 uv, float t){
  vec3 p = vec3(uv * uScale, t);
  float amp = 1.0;
  float freq = 1.0;
  float sum = 1.0;
  for (int i = 0; i < FBM_OCTAVES; ++i){
    sum  += amp * vnoise(p * freq);
    freq *= FBM_LACUNARITY;
    amp  *= FBM_GAIN;
  }
  return sum * 0.5 + 0.5;
}

float maskCircle(vec2 p, float cov){
  float r = sqrt(cov) * .25;
  float d = length(p - 0.5) - r;
  float aa = 0.5 * fwidth(d);
  return cov * (1.0 - smoothstep(-aa, aa, d * 2.0));
}

float maskTriangle(vec2 p, vec2 id, float cov){
  bool flip = mod(id.x + id.y, 2.0) > 0.5;
  if (flip) p.x = 1.0 - p.x;
  float r = sqrt(cov);
  float d  = p.y - r*(1.0 - p.x);
  float aa = fwidth(d);
  return cov * clamp(0.5 - d/aa, 0.0, 1.0);
}

float maskDiamond(vec2 p, float cov){
  float r = sqrt(cov) * 0.564;
  return step(abs(p.x - 0.49) + abs(p.y - 0.49), r);
}

void main(){
  float pixelSize = uPixelSize;
  vec2 fragCoord = gl_FragCoord.xy - uResolution * .5;
  float aspectRatio = uResolution.x / uResolution.y;

  vec2 pixelId = floor(fragCoord / pixelSize);
  vec2 pixelUV = fract(fragCoord / pixelSize);

  float cellPixelSize = 8.0 * pixelSize;
  vec2 cellId = floor(fragCoord / cellPixelSize);
  vec2 cellCoord = cellId * cellPixelSize;
  vec2 uv = cellCoord / uResolution * vec2(aspectRatio, 1.0);

  float base = fbm2(uv, uTime * 0.05);
  base = base * 0.5 - 0.65;

  float feed = base + (uDensity - 0.5) * 0.3;

  float speed     = uRippleSpeed;
  float thickness = uRippleThickness;
  const float dampT     = 1.0;
  const float dampR     = 10.0;

  if (uEnableRipples == 1) {
    for (int i = 0; i < MAX_CLICKS; ++i){
      vec2 pos = uClickPos[i];
      if (pos.x < 0.0) continue;
      float cellPixelSize = 8.0 * pixelSize;
      vec2 cuv = (((pos - uResolution * .5 - cellPixelSize * .5) / (uResolution))) * vec2(aspectRatio, 1.0);
      float t = max(uTime - uClickTimes[i], 0.0);
      float r = distance(uv, cuv);
      float waveR = speed * t;
      float ring  = exp(-pow((r - waveR) / thickness, 2.0));
      float atten = exp(-dampT * t) * exp(-dampR * r);
      feed = max(feed, ring * atten * uRippleIntensity);
    }
  }

  float bayer = Bayer8(fragCoord / uPixelSize) - 0.5;
  float bw = step(0.5, feed + bayer);

  float h = fract(sin(dot(floor(fragCoord / uPixelSize), vec2(127.1, 311.7))) * 43758.5453);
  float jitterScale = 1.0 + (h - 0.5) * uPixelJitter;
  float coverage = bw * jitterScale;
  float M;
  if      (uShapeType == SHAPE_CIRCLE)   M = maskCircle (pixelUV, coverage);
  else if (uShapeType == SHAPE_TRIANGLE) M = maskTriangle(pixelUV, pixelId, coverage);
  else if (uShapeType == SHAPE_DIAMOND)  M = maskDiamond(pixelUV, coverage);
  else                                   M = coverage;

  if (uEdgeFade > 0.0) {
    vec2 norm = gl_FragCoord.xy / uResolution;
    float edge = min(min(norm.x, norm.y), min(1.0 - norm.x, 1.0 - norm.y));
    float fade = smoothstep(0.0, uEdgeFade, edge);
    M *= fade;
  }

  vec3 color = uColor;

  // sRGB gamma correction - convert linear to sRGB for accurate color output
  vec3 srgbColor = mix(
    color * 12.92,
    1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055,
    step(0.0031308, color)
  );

  fragColor = vec4(srgbColor, M);
}
`;

export function initPixelBlast(container) {
  if (!container) return;

  // ---- hardcoded config (former props) ----
  const COLOR = '#f59e0b';        // amber — never the lavender default
  const VARIANT = 'circle';       // subtle dots on near-black
  const PIXEL_SIZE = 6;
  const PATTERN_SCALE = 3;
  const PATTERN_DENSITY = 1.2;
  const PIXEL_JITTER = 0.5;
  const ENABLE_RIPPLES = true;
  const RIPPLE_SPEED = 0.4;
  const RIPPLE_THICKNESS = 0.12;
  const RIPPLE_INTENSITY = 1.5;
  const SPEED = 0.4;              // low — gentle
  const EDGE_FADE = 0.25;
  const TRANSPARENT = true;
  const AUTO_PAUSE_OFFSCREEN = true;
  const RIPPLE_LIFETIME_MS = 11000; // run only until a tap's ripple has fully faded

  const reduce = typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // dpr cap
  if (TRANSPARENT) renderer.setClearAlpha(0); else renderer.setClearColor(0x000000, 1);
  container.appendChild(canvas);

  const uniforms = {
    uResolution: { value: new THREE.Vector2(0, 0) },
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(COLOR) },
    uClickPos: { value: Array.from({ length: MAX_CLICKS }, () => new THREE.Vector2(-1, -1)) },
    uClickTimes: { value: new Float32Array(MAX_CLICKS) },
    uShapeType: { value: SHAPE[VARIANT] ?? 0 },
    uPixelSize: { value: PIXEL_SIZE * renderer.getPixelRatio() },
    uScale: { value: PATTERN_SCALE },
    uDensity: { value: PATTERN_DENSITY },
    uPixelJitter: { value: PIXEL_JITTER },
    uEnableRipples: { value: ENABLE_RIPPLES ? 1 : 0 },
    uRippleSpeed: { value: RIPPLE_SPEED },
    uRippleThickness: { value: RIPPLE_THICKNESS },
    uRippleIntensity: { value: RIPPLE_INTENSITY },
    uEdgeFade: { value: EDGE_FADE },
  };

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SRC,
    fragmentShader: FRAGMENT_SRC,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    glslVersion: THREE.GLSL3,
  });
  const quadGeom = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(quadGeom, material);
  scene.add(quad);

  const renderFrame = () => renderer.render(scene, camera);

  function setSize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    uniforms.uResolution.value.set(canvas.width, canvas.height);
    uniforms.uPixelSize.value = PIXEL_SIZE * renderer.getPixelRatio();
    renderFrame(); // keep the static frame correct after a resize
  }
  setSize();
  const ro = new ResizeObserver(setSize);
  ro.observe(container);

  const timeOffset = Math.random() * 1000; // pattern variety between loads
  let uTimeVal = timeOffset;
  uniforms.uTime.value = uTimeVal;
  renderFrame(); // initial STATIC frame; the loop stays stopped (idle)

  // ---- reduced motion: one static frame, no loop / pointer / observer ----
  if (reduce) {
    return function destroy() {
      ro.disconnect();
      material.dispose();
      quadGeom.dispose();
      renderer.dispose();
      if (canvas.parentElement === container) container.removeChild(canvas);
    };
  }

  // ---- on-demand ripple loop (idle at rest) ----
  let visible = true;
  let raf = 0;
  let lastTS = 0;
  let lastClickReal = -Infinity;
  let clickIx = 0;
  const rippleActive = () => (performance.now() - lastClickReal) < RIPPLE_LIFETIME_MS;

  function frame(ts) {
    const dt = lastTS ? Math.min((ts - lastTS) / 1000, 0.05) : 0;
    lastTS = ts;
    uTimeVal += dt * SPEED;
    uniforms.uTime.value = uTimeVal;
    renderFrame();
    if (visible && rippleActive()) raf = requestAnimationFrame(frame);
    else raf = 0; // freeze; the last frame persists on screen
  }
  function startLoop() { if (!raf) { lastTS = 0; raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  // Listen on window (not the canvas) so a tap anywhere sends a ripple while the
  // background stays pointer-events:none and never blocks the buttons.
  function onPointerDown(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const fx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const fy = (rect.height - (e.clientY - rect.top)) * (canvas.height / rect.height);
    uniforms.uClickPos.value[clickIx].set(fx, fy);
    uniforms.uClickTimes.value[clickIx] = uTimeVal;
    clickIx = (clickIx + 1) % MAX_CLICKS;
    lastClickReal = performance.now();
    if (visible) startLoop();
  }
  window.addEventListener('pointerdown', onPointerDown, { passive: true });

  let io = null;
  if (AUTO_PAUSE_OFFSCREEN) {
    io = new IntersectionObserver((entries) => {
      visible = entries.some((en) => en.isIntersecting);
      if (visible) { if (rippleActive()) startLoop(); }
      else stopLoop();
    });
    io.observe(container);
  }

  return function destroy() {
    stopLoop();
    ro.disconnect();
    if (io) io.disconnect();
    window.removeEventListener('pointerdown', onPointerDown);
    material.dispose();
    quadGeom.dispose();
    renderer.dispose();
    if (canvas.parentElement === container) container.removeChild(canvas);
  };
}
