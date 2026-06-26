/**
 * Noise-dissolve theme transition. A full-screen overlay scatters randomly-
 * ordered opaque dots over the page until they fully cover it; the light/dark
 * class swap happens under that cover (hidden), then the dots clear away to
 * reveal the new theme underneath. Reads as a granular dither dissolve.
 *
 * Each dot is coloured to approximate the SOURCE page behind it: the current
 * theme's base colour plus the four body glow gradients, reconstructed from the
 * CSS variables read at transition start. So the noise starts off built from the
 * theme it began on (e.g. a dark, faintly-glowing field in dark mode) rather
 * than a flat colour, then clears to the new theme.
 *
 * Primary path is a WebGPU fragment shader (per-pixel dither on the GPU); it
 * falls back to a canvas-2D plot of the same dissolve where WebGPU is
 * unavailable, and to an instant swap if neither canvas works. Deliberately NOT
 * gated on `prefers-reduced-motion`.
 */

// Phase durations: dots scatter in, then clear out to reveal the new theme.
const FILL_MS = 480;
const CLEAR_MS = 360;
// Dot edge in CSS px (small = fine grain / more noise). The canvas-2D grid is
// also capped to ~MAX_CELLS dots so large/HiDPI viewports don't overload the CPU.
const CELL_CSS = 3;
const MAX_CELLS = 90000;
// Per-dot brightness jitter (±, 0–255 scale) so the fill reads as grain.
const JITTER = 16;

// The four body glow gradients (see styles.css `body` background): centre x/y
// and half-size x/y in viewport-normalised units, paired with --glow-a/b/c and
// --bg-wash read at runtime. Kept in sync with the CSS radial-gradient stops.
const GLOWS: number[][] = [
  [0.5, -0.2, 0.4, 0.25],
  [1.0, 0.5, 0.3, 0.2],
  [0.0, 0.8, 0.25, 0.25],
  [0.5, 1.0, 0.55, 0.275],
];

type Run = { token: number; cancel: () => void };
let current: Run | null = null;
let runToken = 0;

/** Create the fixed, click-through, top-most overlay canvas (no drawing context yet). */
function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = [
    'position:fixed',
    'inset:0',
    'width:100%',
    'height:100%',
    'pointer-events:none',
    'z-index:2147483647',
  ].join(';');
  return canvas;
}

/** Parse a CSS colour (`#rgb`, `#rrggbb`, `rgb(...)`, `rgba(...)`) into `[r, g, b, a]` (0–255, a 0–1). */
function parseCssColor(input: string): number[] {
  const s = input.trim();
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    const n = Number.parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((x) => Number.parseFloat(x.trim()));
    return [p[0] || 0, p[1] || 0, p[2] || 0, p[3] === undefined ? 1 : p[3]];
  }
  return [0, 0, 0, 1];
}

/** Read the current theme's base + glow colours: `[base, glowA, glowB, glowC, bgWash]`, each `[r, g, b, a]`. */
function readPalette(): number[][] {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string) => parseCssColor(cs.getPropertyValue(name));
  return [
    get('--bg-page-edge'),
    get('--glow-a'),
    get('--glow-b'),
    get('--glow-c'),
    get('--bg-wash'),
  ];
}

/** Approximate the source page background colour at viewport-normalised `(ux, uy)`: the base with the four glows composited over it. */
function bgColorAt(ux: number, uy: number, palette: number[][]): number[] {
  let r = palette[0][0];
  let g = palette[0][1];
  let b = palette[0][2];
  for (let i = 0; i < GLOWS.length; i++) {
    const [cx, cy, hx, hy] = GLOWS[i];
    const c = palette[i + 1];
    const dx = (ux - cx) / hx;
    const dy = (uy - cy) / hy;
    const w = c[3] * (1 - Math.min(1, Math.sqrt(dx * dx + dy * dy)));
    r += (c[0] - r) * w;
    g += (c[1] - g) * w;
    b += (c[2] - b) * w;
  }
  return [r, g, b];
}

/** Clamp to a valid 0–255 colour channel. */
function channel(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** A shuffled `[0..total)` index array (Fisher–Yates) giving the dot reveal order. */
function shuffledOrder(total: number): Int32Array {
  const a = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    a[i] = i;
  }
  for (let i = total - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/** Map elapsed ms to dissolve progress in [0,1]: 0–0.5 fills in, 0.5–1 clears out. */
function progressFor(elapsed: number): number {
  return elapsed < FILL_MS
    ? (elapsed / FILL_MS) * 0.5
    : 0.5 + Math.min(1, (elapsed - FILL_MS) / CLEAR_MS) * 0.5;
}

/** Tear down the in-flight run (stops its loop and removes its canvas). */
function teardown(): void {
  if (current) {
    current.cancel();
    current = null;
  }
}

const WGSL = /* wgsl */ `
struct U {
  base: vec4f,
  glowA: vec4f,
  glowB: vec4f,
  glowC: vec4f,
  glowW: vec4f,
  resolution: vec2f,
  progress: f32,
  cell: f32,
};
@group(0) @binding(0) var<uniform> u: U;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

// PCG2D — a high-quality integer hash (Jarzynski, "Hash Functions for GPU
// Rendering"). Bit-mixes the cell coords into two decorrelated randoms, so the
// dither has no directional/banding pattern the way a sin-based hash does.
fn pcg2d(p: vec2u) -> vec2u {
  var v = p * 1664525u + 1013904223u;
  v.x = v.x + v.y * 1664525u;
  v.y = v.y + v.x * 1664525u;
  v = v ^ (v >> 16u);
  v.x = v.x + v.y * 1664525u;
  v.y = v.y + v.x * 1664525u;
  v = v ^ (v >> 16u);
  return v;
}

// Composite one glow (colour→transparent over an ellipse) onto the base.
fn applyGlow(base: vec3f, uv: vec2f, center: vec2f, rad: vec2f, c: vec4f) -> vec3f {
  let d = length((uv - center) / rad);
  let w = c.a * (1.0 - clamp(d, 0.0, 1.0));
  return mix(base, c.rgb, w);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let ci = vec2u(frag.xy / u.cell);
  let r = pcg2d(ci);
  let n = f32(r.x) / 4294967296.0;
  let m = f32(r.y) / 4294967296.0;
  var a: f32;
  if (u.progress < 0.5) {
    a = select(0.0, 1.0, n < u.progress * 2.0);
  } else {
    a = select(1.0, 0.0, m < (u.progress - 0.5) * 2.0);
  }

  // Approximate the source page background at this dot (base + four glows).
  let uv = (vec2f(ci) * u.cell + vec2f(u.cell * 0.5)) / u.resolution;
  var bg = u.base.rgb;
  bg = applyGlow(bg, uv, vec2f(0.5, -0.2), vec2f(0.4, 0.25), u.glowA);
  bg = applyGlow(bg, uv, vec2f(1.0, 0.5), vec2f(0.3, 0.2), u.glowB);
  bg = applyGlow(bg, uv, vec2f(0.0, 0.8), vec2f(0.25, 0.25), u.glowC);
  bg = applyGlow(bg, uv, vec2f(0.5, 1.0), vec2f(0.55, 0.275), u.glowW);

  let r2 = pcg2d(ci + vec2u(101u, 53u));
  let g = (f32(r2.x) / 4294967296.0 - 0.5) * 0.13;
  let rgb = clamp(bg + vec3f(g, g, g), vec3f(0.0), vec3f(1.0));
  return vec4f(rgb * a, a);
}
`;

/** Pack the palette + resolution + cell into the 96-byte uniform Float32Array (progress is set per frame at index 22). */
function packUniforms(
  palette: number[][],
  width: number,
  height: number,
  cell: number,
): Float32Array {
  const data = new Float32Array(24);
  for (let i = 0; i < 5; i++) {
    const c = palette[i];
    data[i * 4] = c[0] / 255;
    data[i * 4 + 1] = c[1] / 255;
    data[i * 4 + 2] = c[2] / 255;
    data[i * 4 + 3] = i === 0 ? 1 : c[3];
  }
  data[20] = width;
  data[21] = height;
  data[23] = cell;
  return data;
}

/** Run the dissolve on the GPU. Resolves true if it took ownership (ran or was superseded), false to signal the caller to fall back. */
async function startWebGPU(
  palette: number[][],
  swap: () => void,
  token: number,
): Promise<boolean> {
  const gpu = navigator.gpu;
  if (!gpu) {
    return false;
  }

  let device: GPUDevice;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return false;
    }
    device = await adapter.requestDevice();
  } catch {
    return false;
  }

  // A newer toggle superseded this one while we awaited the GPU.
  if (token !== runToken) {
    device.destroy();
    return true;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = makeCanvas();
  canvas.width = Math.ceil(window.innerWidth * dpr);
  canvas.height = Math.ceil(window.innerHeight * dpr);
  const ctx = canvas.getContext('webgpu');
  if (!ctx) {
    device.destroy();
    return false;
  }

  let pipeline: GPURenderPipeline;
  let uniform: GPUBuffer;
  let bindGroup: GPUBindGroup;
  // WebGPU validation errors (e.g. a shader compile failure) surface through the
  // error scope, not as exceptions — capture them so we fall back to canvas-2D.
  device.pushErrorScope('validation');
  try {
    const format = gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: 'premultiplied' });
    const module = device.createShaderModule({ code: WGSL });
    pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    uniform = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniform } }],
    });
  } catch {
    await device.popErrorScope().catch(() => null);
    device.destroy();
    return false;
  }
  const setupError = await device.popErrorScope();
  if (token !== runToken) {
    device.destroy();
    return true;
  }
  if (setupError) {
    device.destroy();
    return false;
  }

  document.body.appendChild(canvas);

  const data = packUniforms(
    palette,
    canvas.width,
    canvas.height,
    CELL_CSS * dpr,
  );

  let raf = 0;
  let alive = true;
  let swapped = false;
  const cancel = () => {
    alive = false;
    if (raf) {
      window.cancelAnimationFrame(raf);
    }
    canvas.remove();
    device.destroy();
  };
  current = { token, cancel };

  const start = performance.now();
  const frame = (now: number) => {
    if (!alive || token !== runToken) {
      return;
    }
    const elapsed = now - start;
    if (!swapped && elapsed >= FILL_MS) {
      swap();
      swapped = true;
    }
    data[22] = progressFor(elapsed);
    device.queue.writeBuffer(uniform, 0, data);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: ctx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    if (elapsed >= FILL_MS + CLEAR_MS) {
      cancel();
      if (current && current.token === token) {
        current = null;
      }
      return;
    }
    raf = window.requestAnimationFrame(frame);
  };
  raf = window.requestAnimationFrame(frame);
  return true;
}

/** Run the dissolve on a 2D canvas by plotting/clearing dots in shuffled order. */
function startCanvas2D(
  palette: number[][],
  swap: () => void,
  token: number,
): void {
  const w = Math.ceil(window.innerWidth);
  const h = Math.ceil(window.innerHeight);
  const canvas = makeCanvas();
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    swap();
    return;
  }
  document.body.appendChild(canvas);

  const cell = Math.max(CELL_CSS, Math.round(Math.sqrt((w * h) / MAX_CELLS)));
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const total = cols * rows;

  let raf = 0;
  let alive = true;
  const cancel = () => {
    alive = false;
    if (raf) {
      window.cancelAnimationFrame(raf);
    }
    canvas.remove();
  };
  current = { token, cancel };

  /** Paint one shuffled cell with its approximate page colour plus grain. */
  const paint = (idx: number) => {
    const col = idx % cols;
    const row = (idx - col) / cols;
    const bg = bgColorAt(
      (col * cell + cell * 0.5) / w,
      (row * cell + cell * 0.5) / h,
      palette,
    );
    const j = Math.round(Math.random() * 2 * JITTER) - JITTER;
    ctx.fillStyle = `rgb(${channel(bg[0] + j)},${channel(bg[1] + j)},${channel(bg[2] + j)})`;
    ctx.fillRect(col * cell, row * cell, cell, cell);
  };
  const erase = (idx: number) => {
    const col = idx % cols;
    const row = (idx - col) / cols;
    ctx.clearRect(col * cell, row * cell, cell, cell);
  };

  // Phase 2: clear the dots away to reveal the (already swapped) new theme.
  const clearPhase = () => {
    const order = shuffledOrder(total);
    const startTime = performance.now();
    let cleared = 0;
    const step = (now: number) => {
      if (!alive || token !== runToken) {
        return;
      }
      const target = Math.floor(
        Math.min(1, (now - startTime) / CLEAR_MS) * total,
      );
      for (; cleared < target; cleared++) {
        erase(order[cleared]);
      }
      if (cleared < total) {
        raf = window.requestAnimationFrame(step);
        return;
      }
      cancel();
      if (current && current.token === token) {
        current = null;
      }
    };
    raf = window.requestAnimationFrame(step);
  };

  // Phase 1: scatter the dots in until the page is fully covered.
  const order = shuffledOrder(total);
  const start = performance.now();
  let painted = 0;
  const step = (now: number) => {
    if (!alive || token !== runToken) {
      return;
    }
    const target = Math.floor(Math.min(1, (now - start) / FILL_MS) * total);
    for (; painted < target; painted++) {
      paint(order[painted]);
    }
    if (painted < total) {
      raf = window.requestAnimationFrame(step);
      return;
    }
    swap();
    clearPhase();
  };
  raf = window.requestAnimationFrame(step);
}

/** Run the noise dissolve, applying `swap` (the light/dark flip) under full cover. The dots are coloured from the current page, read before the swap. */
export function runThemeTransition(swap: () => void): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    swap();
    return;
  }

  teardown();
  const token = ++runToken;
  const palette = readPalette();

  if (navigator.gpu) {
    startWebGPU(palette, swap, token)
      .then((handled) => {
        if (!handled && token === runToken) {
          startCanvas2D(palette, swap, token);
        }
      })
      .catch(() => {
        if (token === runToken) {
          startCanvas2D(palette, swap, token);
        }
      });
    return;
  }

  startCanvas2D(palette, swap, token);
}
