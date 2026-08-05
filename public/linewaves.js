// LineWaves — a full-bleed animated background of flowing amber lines.
// Original implementation built on the ogl library (Renderer/Program/Mesh/
// Triangle + GLSL shaders), plain JS, no React. Served locally from /vendor/ogl.

import { Renderer, Program, Mesh, Triangle } from '/vendor/ogl/index.js';

const VERT = `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;
varying vec2 vUv;

uniform float uTime;
uniform vec2  uMouse;       // 0..1, eased
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;
uniform float uAmp;
uniform float uBrightness;

const int LINES = 15;

void main() {
  vec2 uv = vUv;
  float t = uTime * 0.5236;               // base tempo (0.22 x1.7 x1.4)

  float mdx = uMouse.x - 0.5;
  float mdy = uMouse.y - 0.5;

  float acc = 0.0;
  for (int i = 0; i < LINES; i++) {
    float fi = float(i) / float(LINES - 1);          // 0..1 vertical slot
    float speed = 0.6 + fi * 0.9;

    // layered sines -> organic, non-repeating wave
    float w  = sin(uv.x * 6.2831 * (0.8 + fi * 0.7) + t * speed + fi * 5.5) * 0.045;
    w       += sin(uv.x * 12.566 - t * (0.9 + fi) + fi * 3.0) * 0.022;
    w       *= uAmp * (0.7 + 0.5 * sin(t * 0.7 + fi * 3.14159));
    w       += mdx * 0.05 * sin(uv.x * 6.2831 + t + fi * 2.0);   // mouse nudge

    float lineY = mix(0.08, 0.92, fi) + w + mdy * 0.03;
    float d = abs(uv.y - lineY);

    float core = smoothstep(0.010, 0.0, d);
    float halo = smoothstep(0.055, 0.0, d) * 0.35;
    acc += core + halo;
  }

  // gentle color-cycling across the three ambers (~40s period)
  float c1 = 0.5 + 0.5 * sin(t * 0.5);
  float c2 = 0.5 + 0.5 * sin(t * 0.5 + 2.09439);
  vec3 amber = mix(uColorA, uColorB, c1);
  amber = mix(amber, uColorC, c2 * 0.6);

  vec3 bg = vec3(0.039, 0.039, 0.043);   // ~ #0a0a0b
  vec3 col = bg + amber * acc * uBrightness * 3.0;

  // faint vignette to settle the edges
  vec2 p = uv - 0.5;
  col *= 1.0 - dot(p, p) * 0.55;

  gl_FragColor = vec4(col, 1.0);
}
`;

export function initLineWaves(canvas, options) {
  const opts = Object.assign(
    {
      // #f59e0b, #fbbf24, #b45309 as linear-ish 0..1 rgb
      colors: [
        [0.961, 0.620, 0.043],
        [0.984, 0.749, 0.141],
        [0.706, 0.325, 0.035],
      ],
      brightness: 0.18,
      amplitude: 1.0,
      mouse: true,
    },
    options || {}
  );

  const reduce =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new Renderer({
    canvas,
    alpha: false,
    antialias: true,
    dpr: Math.min(2, window.devicePixelRatio || 1),
  });
  const gl = renderer.gl;

  const program = new Program(gl, {
    vertex: VERT,
    fragment: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uMouse: { value: [0.5, 0.5] },
      uColorA: { value: opts.colors[0] },
      uColorB: { value: opts.colors[1] },
      uColorC: { value: opts.colors[2] },
      uAmp: { value: opts.amplitude },
      uBrightness: { value: opts.brightness },
    },
  });
  const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

  const host = canvas.parentElement || canvas;
  function resize() {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h);
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const target = [0.5, 0.5];
  // Named so destroy() can remove them (anonymous handlers would leak).
  let onPointerMove = null;
  let onPointerLeave = null;
  if (opts.mouse) {
    onPointerMove = (e) => {
      const r = host.getBoundingClientRect();
      target[0] = (e.clientX - r.left) / r.width;
      target[1] = 1.0 - (e.clientY - r.top) / r.height;
    };
    onPointerLeave = () => {
      target[0] = 0.5;
      target[1] = 0.5;
    };
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerleave', onPointerLeave);
  }

  let raf = 0;
  function frame(ms) {
    const m = program.uniforms.uMouse.value;
    m[0] += (target[0] - m[0]) * 0.05;
    m[1] += (target[1] - m[1]) * 0.05;
    program.uniforms.uTime.value = ms * 0.001;
    renderer.render({ scene: mesh });
    raf = requestAnimationFrame(frame);
  }

  if (reduce) {
    // Respect reduced-motion: render one calm static frame, no loop.
    program.uniforms.uTime.value = 8.0;
    renderer.render({ scene: mesh });
  } else {
    raf = requestAnimationFrame(frame);
  }

  return function destroy() {
    cancelAnimationFrame(raf);
    ro.disconnect();
    if (onPointerMove) host.removeEventListener('pointermove', onPointerMove);
    if (onPointerLeave) host.removeEventListener('pointerleave', onPointerLeave);
  };
}
