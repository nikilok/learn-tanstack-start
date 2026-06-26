/**
 * Noise-dissolve theme transition between two colour matrices. A full-screen
 * overlay runs a granular dither in three windows over one progress timeline:
 *
 *   1. fill   (0   – 0.3): dots scatter in, coloured from the SOURCE matrix —
 *                          the page dissolves into a grainy field of its own
 *                          (current-theme) colours.
 *   2. morph  (0.3 – 0.7): fully covered; each dot flips from its SOURCE colour
 *                          to its TARGET colour in random dither order. The
 *                          light/dark class swap happens here (hidden), at 0.5.
 *   3. clear  (0.7 – 1  ): dots scatter away, revealing the new (target) page.
 *
 * The SOURCE/TARGET colours come from per-theme matrices (DARK_MAP / LIGHT_MAP)
 * sampled from screenshots of the real home page (downsampled to
 * MAP_COLS×MAP_ROWS), sampled bilinearly per dot — so the noise starts off in
 * the page's actual colours.
 *
 * Primary path is a WebGPU fragment shader; it falls back to a canvas-2D plot of
 * the same dissolve where WebGPU is unavailable, and to an instant swap if
 * neither canvas works. Deliberately NOT gated on `prefers-reduced-motion`.
 */

// This TS lib.dom ships the WebGPU interfaces but not the GPUBufferUsage flag
// constant — declare the bits we use; the browser provides them at runtime.
declare const GPUBufferUsage: {
  readonly UNIFORM: number;
  readonly COPY_DST: number;
};

// Single progress timeline; the three windows + the hidden swap point within it.
const TOTAL_MS = 900;
const COVER_END = 0.3; // dots finished scattering in
const REVEAL_START = 0.7; // dots start scattering out
const SWAP_AT = 0.5; // theme class flip, mid-morph under full cover
// Dot edge in CSS px (small = fine grain). The canvas-2D grid is capped to
// ~MAX_CELLS dots so large/HiDPI viewports don't overload the CPU path.
const CELL_CSS = 3;
const MAX_CELLS = 90000;
// Per-dot brightness jitter (±, 0–255 scale) so the fill reads as grain.
const JITTER = 16;

// Per-theme colour matrices sampled from screenshots of the actual home page,
// downsampled to MAP_COLS×MAP_ROWS and packed as `rrggbb` hex (row-major,
// top→bottom). These give the dots the page's real starting colours (grid tint,
// search box, skyline, glows). Regenerate via the sampling script if the design
// changes; keep MAP_COLS/MAP_ROWS in sync with the downsample size.
const MAP_COLS = 24;
const MAP_ROWS = 16;
const MAP_N = MAP_COLS * MAP_ROWS;

const LIGHT_MAP_HEX =
  'f8f7fae0dfe7e9e6ecf4e6ebfafafcfafbfdfafbfdfafbfdfafafdfafafdfafafdfafafdfafafdfafafdfafbfdfafbfdfafbfdfafbfdfafbfdfafbfdfbfbfdf9f9fbf6f6f8f7f7faf5f6faedeef5f1f2f8f1eff6f3f5faf4f6fcf3f5fcf3f5fcf3f5fbf2f4fbf2f4fbf2f4fbf2f4fbf2f5fbf2f5fbf3f5fbf3f6fbf4f6fbf4f6fbf5f6fbf5f7fbf5f6fbf4f6faf5f6faf1f1f8f0f1f9eef1f9edf0f9eceef8e8ebf5e6eaf5e5e8f4e7ebf7e8ecf8e7ebf7e8ebf7e8ebf7e8ebf7e9ecf7e9edf7ebeef8edf1faeceff9eceef8eceef8edeef8eeeef8f1f1f8f4f4f8f3f3f8f2f3f8f1f2f8eff0f8e8e9f0e6e8efe4e5ededeef6eef0f8f0f1f9f0f0f9f0f1f9f1f1f9f1f1f9f1f2f9e5e6edd4d4dce6e6efeeeef8efedf7efedf7efedf7f2eff7f4f4f8f4f4f8f4f4f8f4f4f8f3f3f8f8f8faf8f8f9f8f8f9f7f7f8f9f9fafcfcfdfdfdfdfcfcfdfcfcfdfcfcfdffffffc1c0c2646365c9c6cdf3effaefebf6efebf6efebf6f0eef7f3f3f8f3f3f8f3f4f8f4f4f8f4f4f8f4f4f8f4f4f8f3f3f8f3f2f8f3f3f8f5f4faf7f5fbf7f4fbf4f0f9f1edf6f0ecf6eeeaf4ece8f2eee9f4eee9f5eee8f5ede8f5ede8f5efecf6f1f2f8f1f2f8f1f2f8f2f2f8f3f3f8f3f3f8f3f3f8f3f3f8f4f3f9f0eff4d2d1d6bbb9bebfbcc3dcd8e1f1ecf7efe9f4efe9f5efe9f5ede7f4ece6f4ece5f5ebe5f5ebe3f5eee9f6eff0f8eff0f8eff0f8f0f1f8f1f1f8f1f2f8f2f2f8f3f3f8f4f4f9ecebf0bdbcc0a8a7acadaab1c9c6ceefeaf5efe9f5eee8f4ede7f4ece5f3ebe4f4eae3f4eae2f4e9e0f4ece7f5edeff8edeff8edeff8edeff8edf0f8eef0f8eff0f8f0f1f8f1f2f8ededf3e7e5ede9e7f0e8e5efe7e4eeece8f3ede9f5ece7f4ebe6f4eae4f4eae3f4e9e2f4e8e0f3e7def3ebe5f4e9eef8e9edf8e9edf8e9eef8e9eef8eaeef8ebeff8eceff8edeff8eff0f9eff0f9efeef8eeedf8eeecf7ebe9f6eae8f5e9e6f5e9e5f5e8e4f4e7e2f4e7e1f4e6e0f3e5def3eae5f5e4eaf8e4eaf8e4eaf8e4eaf9e5eaf9e6ecf8e7edf8e8edf8e9eef8eaedf6eceff7ecedf7ececf6e9eaf4e9e8f6e8e7f6e7e6f5e7e4f5e6e4f5e6e3f5e5e1f4e5e1f4e5e0f4ebe7f5dfe6f8dfe6f8e0e6f8e0e7f8e1e8f8e2e8f9e3e9f9e4eaf9e6ecf9e0e6f1e0e3ede4e8f2e2e5efe2e3f0e4e5f4e7e7f7e5e6f6e5e5f6e5e4f5e4e3f5e4e2f5e4e2f5e4e1f5eae8f6e5ebf9e5ebf9e6ebf9e6ebf9e6ecf9e7edf9e8edfaeaeefaeaeefae9edf7e9edf3eaecf0ecedf1ecedf4eaecf6ecedf8ebedf8ebecf8ebebf8ebebf8ebebf8ebebf8ebebf8efeef8ecf1fcedf1fcedf1fcedf1fceef1fceef2fceff2fcf0f3fcf0f3fcf1f4fde8ebf2e3e5ece7e9f0eff1f9f2f4fcf2f4fbf2f3fbf2f3fbf1f3fbf1f3fbf2f3fbf2f3fbf2f3fbf3f3faebf1fcebf1fcecf1fcecf1fcecf1fcedf1fcedf1fcedf1fceef2fceff2fdeff2fce9ecf4e9ebf4f1f3fcf1f3fcf1f3fcf1f3fcf1f3fcf1f3fbf1f3fbf2f3fbf2f3fbf2f3fbf3f4faecf1fcebf1fcebf1fcecf1fcecf1fcecf1fcecf1fcedf1fcedf1fcebeffae8ecf6e8ecf6e9ecf6eaedf7eef2fbeff3fcf0f3fcf0f3fcf1f3fcf1f4fcf2f4fcf2f4fcf3f5fcf3f5fb';
const DARK_MAP_HEX =
  '0f0d0e2926291e1c1e2015170b0b0d0a0a0c0a0a0b0a0a0b0a0a0c0a0a0c0a0a0c0a0a0c0a0a0c0a0a0c0a0a0b0a0a0b0a0a0c0a0a0c0a0a0c0a0a0c0a0a0c0c0c0d0f0f0f0d0d0d0c0d0e1213150f10131110140b0d110a0d100b0d120b0d120b0e120d0e140c0d130c0e130d0e140c0d130c0e130c0d120b0d120c0d110a0d110a0c100a0c0f0b0c0e0c0d0f0d0d0e0a0b0e090c0f0a0c100a0d120b0e140e11180f131a10141c0d111a0d11190e111a0e111a0e11190e111a0e10180d10170c0e15090b120a0d130b0d130b0d120b0c120c0c110d0d110a0a0a0a0a0b0a0a0c0a0b0e0b0d1014161a17181d1a1b200e10150d0e150d0e130e0f140f0f140d0e130e0e130e0d1215161b2525291414190d0c120d0b120d0b110e0a110e0c100a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0c0c0c0f0f0f0e0e0f0a0a0a0b0a0b0b0b0b0a0a0a0b0b0b0c0b0c0a0a0a070607474647a6a6a73c393d0d080f100b13100b13100b14100d130a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0b0c0b0b0c0c0c0d0d0c0e0d0c0d0d0b0d0b080b0c090c120c11130e13120d1316101619131a150f17130d16120c17120d18120d18110d150a0b0c0a0a0c0a0a0b0a0a0b0a0a0a0a0a0a0b0a0b0c0a0c0c0b0c0e0d0e242224383639393338221c22130c13150e15140d16140d16150e18150e19150e1a150e1b150d1c120e180a0c100a0c0f0a0c0e0a0b0e0a0b0d0a0a0c0a0a0c0b0b0b0a0a0b1615164e4d4e686668635f633f3a3f140c14150d16160e18170f19160f1a170f1c170f1d160d1d160d1f140e1a0a0d110a0d110a0d110a0d110a0c100a0c0f0b0b0e0b0b0d0b0b0d100f1119181b19161b1a151b1b151c150f17140e18160f1917101b180f1c170f1d170e1e180e20190f22160f1c0b0e140b0e140b0e140b0e140b0e140b0e130b0d120b0d110c0c100c0c100d0b100f0b11100b13110c15140f1815101a16101c17101d170f1e170f1f180f21180f22190f23150f1d0c111a0c111a0d111a0d10190d10190d10180c0f170d0e150c0e140d0d130e0e14100e1517151d1a1720140f1a14101c16111d17101e160f1e17101f171021170f21170f23150f1c0e131f0e121f0f121e0f121e0e121d0e111c0e111b0e10190e101812131b13141b12111917161f1a182215111d14101c15111e15101e15101f161120161020160f21160f22140f1b0f131f0f131f0f121f0f121e0f121d0f121d0f121c0f111b0f111a13131c17181d16161b16161b16151b14121c13101b13101b13101c13101c13101d13101d140f1d130f1d120f180d10190c10180c0f170c0f170c0f160c0e160c0e150c0d150d0e140d0e1314151917171b1313180f0f140d0c120d0d130e0d130e0d140e0d140e0d140e0c140e0c140e0c140e0d120c101a0c10190d10180d10180d0f180d0f170d0f170d0f160d0e150d0d141313191b1b2118181d0f0f150d0d130d0d130d0d130d0d130e0d140e0d130e0d130e0d130e0c130e0d120d10190d10190d10190d10180d10180d10180e0f170e0f170d0f160e0e160e0e151212191213190d0d150d0d140d0d140d0d140d0d130d0d130d0d130d0d120d0d120d0c120e0d11';

/** Parse a packed `rrggbb…` hex string into a MAP_N-length `[r, g, b]` grid. */
function parseHexMap(hex: string): number[][] {
  const map: number[][] = [];
  for (let i = 0; i < MAP_N; i++) {
    const o = i * 6;
    map.push([
      Number.parseInt(hex.slice(o, o + 2), 16),
      Number.parseInt(hex.slice(o + 2, o + 4), 16),
      Number.parseInt(hex.slice(o + 4, o + 6), 16),
    ]);
  }
  return map;
}

const DARK_MAP = parseHexMap(DARK_MAP_HEX);
const LIGHT_MAP = parseHexMap(LIGHT_MAP_HEX);

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

/** Clamp to [0, 1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Clamp to a valid 0–255 colour channel. */
function channel(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Bilinearly sample a `MAP_COLS×MAP_ROWS` colour matrix at viewport-normalised `(ux, uy)`. */
function sampleMap(map: number[][], ux: number, uy: number): number[] {
  const fx = clamp01(ux) * (MAP_COLS - 1);
  const fy = clamp01(uy) * (MAP_ROWS - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, MAP_COLS - 1);
  const y1 = Math.min(y0 + 1, MAP_ROWS - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const c00 = map[y0 * MAP_COLS + x0];
  const c10 = map[y0 * MAP_COLS + x1];
  const c01 = map[y1 * MAP_COLS + x0];
  const c11 = map[y1 * MAP_COLS + x1];
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const top = c00[k] + (c10[k] - c00[k]) * tx;
    const bot = c01[k] + (c11[k] - c01[k]) * tx;
    out[k] = top + (bot - top) * ty;
  }
  return out;
}

/** A shuffled `[0..total)` index array (Fisher–Yates) giving a dither reveal order. */
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

/** Tear down the in-flight run (stops its loop and removes its canvas). */
function teardown(): void {
  if (current) {
    current.cancel();
    current = null;
  }
}

const WGSL = /* wgsl */ `
struct U {
  srcMap: array<vec4f, ${MAP_N}>,
  tgtMap: array<vec4f, ${MAP_N}>,
  resolution: vec2f,
  progress: f32,
  cell: f32,
};
@group(0) @binding(0) var<uniform> u: U;

const MAP_COLS = ${MAP_COLS}u;
const MAP_ROWS = ${MAP_ROWS}u;

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

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let ci = vec2u(frag.xy / u.cell);
  let r = pcg2d(ci);
  let hCover = f32(r.x) / 4294967296.0;
  let hColor = f32(r.y) / 4294967296.0;

  // Bilinear weights/indices into the colour matrices for this dot's position.
  let uv = (vec2f(ci) * u.cell + vec2f(u.cell * 0.5)) / u.resolution;
  let fx = clamp(uv.x, 0.0, 1.0) * f32(MAP_COLS - 1u);
  let fy = clamp(uv.y, 0.0, 1.0) * f32(MAP_ROWS - 1u);
  let x0 = u32(floor(fx));
  let y0 = u32(floor(fy));
  let x1 = min(x0 + 1u, MAP_COLS - 1u);
  let y1 = min(y0 + 1u, MAP_ROWS - 1u);
  let tx = fx - floor(fx);
  let ty = fy - floor(fy);
  let i00 = y0 * MAP_COLS + x0;
  let i10 = y0 * MAP_COLS + x1;
  let i01 = y1 * MAP_COLS + x0;
  let i11 = y1 * MAP_COLS + x1;
  let s = mix(mix(u.srcMap[i00].rgb, u.srcMap[i10].rgb, tx), mix(u.srcMap[i01].rgb, u.srcMap[i11].rgb, tx), ty);
  let t = mix(mix(u.tgtMap[i00].rgb, u.tgtMap[i10].rgb, tx), mix(u.tgtMap[i01].rgb, u.tgtMap[i11].rgb, tx), ty);

  // Three dither windows: fill in, morph source→target, clear out.
  let p = u.progress;
  let fillFrac = clamp(p / 0.3, 0.0, 1.0);
  let clearFrac = clamp((p - 0.7) / 0.3, 0.0, 1.0);
  let morphFrac = clamp((p - 0.3) / 0.4, 0.0, 1.0);
  let on = hCover < fillFrac && hCover >= clearFrac;
  let base = select(s, t, morphFrac > hColor);

  let r2 = pcg2d(ci + vec2u(101u, 53u));
  let g = (f32(r2.x) / 4294967296.0 - 0.5) * 0.13;
  let rgb = clamp(base + vec3f(g, g, g), vec3f(0.0), vec3f(1.0));
  let a = select(0.0, 1.0, on);
  return vec4f(rgb * a, a);
}
`;

// Uniform Float32 layout: srcMap[MAP_N] vec4 | tgtMap[MAP_N] vec4 | resolution
// vec2 | progress | cell. Progress lives at index PROGRESS_IDX (set per frame).
const PROGRESS_IDX = MAP_N * 8 + 2;
const UNIFORM_FLOATS = MAP_N * 8 + 4;

/** Pack both matrices + resolution + cell into the uniform Float32Array (progress is set per frame at PROGRESS_IDX). */
function packUniforms(
  srcMap: number[][],
  tgtMap: number[][],
  width: number,
  height: number,
  cell: number,
): Float32Array {
  const data = new Float32Array(UNIFORM_FLOATS);
  const tgtBase = MAP_N * 4;
  for (let i = 0; i < MAP_N; i++) {
    const s = srcMap[i];
    const t = tgtMap[i];
    const so = i * 4;
    const to = tgtBase + i * 4;
    data[so] = s[0] / 255;
    data[so + 1] = s[1] / 255;
    data[so + 2] = s[2] / 255;
    data[so + 3] = 1;
    data[to] = t[0] / 255;
    data[to + 1] = t[1] / 255;
    data[to + 2] = t[2] / 255;
    data[to + 3] = 1;
  }
  const tail = MAP_N * 8;
  data[tail] = width;
  data[tail + 1] = height;
  data[tail + 3] = cell;
  return data;
}

/** Run the dissolve on the GPU. Resolves true if it took ownership (ran or was superseded), false to signal the caller to fall back. */
async function startWebGPU(
  srcMap: number[][],
  tgtMap: number[][],
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

  if (token !== runToken) {
    device.destroy();
    return true;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = makeCanvas();
  canvas.width = Math.ceil(window.innerWidth * dpr);
  canvas.height = Math.ceil(window.innerHeight * dpr);
  const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
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
      size: UNIFORM_FLOATS * 4,
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
    srcMap,
    tgtMap,
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
    if (!swapped && elapsed >= TOTAL_MS * SWAP_AT) {
      swap();
      swapped = true;
    }
    data[PROGRESS_IDX] = clamp01(elapsed / TOTAL_MS);
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

    if (elapsed >= TOTAL_MS) {
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

/** Run the dissolve on a 2D canvas: three incremental dither passes (fill source, repaint target, clear). */
function startCanvas2D(
  srcMap: number[][],
  tgtMap: number[][],
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

  // Per-cell static grain so a cell keeps its tone when repainted source→target.
  const grain = new Int8Array(total);
  for (let i = 0; i < total; i++) {
    grain[i] = Math.round(Math.random() * 2 * JITTER) - JITTER;
  }
  const orderFill = shuffledOrder(total);
  const orderMorph = shuffledOrder(total);
  const orderClear = shuffledOrder(total);

  let raf = 0;
  let alive = true;
  let swapped = false;
  const cancel = () => {
    alive = false;
    if (raf) {
      window.cancelAnimationFrame(raf);
    }
    canvas.remove();
  };
  current = { token, cancel };

  const paint = (idx: number, map: number[][]) => {
    const col = idx % cols;
    const row = (idx - col) / cols;
    const c = sampleMap(
      map,
      (col * cell + cell * 0.5) / w,
      (row * cell + cell * 0.5) / h,
    );
    const j = grain[idx];
    ctx.fillStyle = `rgb(${channel(c[0] + j)},${channel(c[1] + j)},${channel(c[2] + j)})`;
    ctx.fillRect(col * cell, row * cell, cell, cell);
  };
  const erase = (idx: number) => {
    const col = idx % cols;
    const row = (idx - col) / cols;
    ctx.clearRect(col * cell, row * cell, cell, cell);
  };

  let iFill = 0;
  let iMorph = 0;
  let iClear = 0;
  const start = performance.now();
  const step = (now: number) => {
    if (!alive || token !== runToken) {
      return;
    }
    const elapsed = now - start;
    if (!swapped && elapsed >= TOTAL_MS * SWAP_AT) {
      swap();
      swapped = true;
    }
    const p = clamp01(elapsed / TOTAL_MS);
    const fillTarget = Math.floor(clamp01(p / COVER_END) * total);
    for (; iFill < fillTarget; iFill++) {
      paint(orderFill[iFill], srcMap);
    }
    const morphFrac = clamp01((p - COVER_END) / (REVEAL_START - COVER_END));
    const morphTarget = Math.floor(morphFrac * total);
    for (; iMorph < morphTarget; iMorph++) {
      paint(orderMorph[iMorph], tgtMap);
    }
    const clearTarget = Math.floor(
      clamp01((p - REVEAL_START) / (1 - REVEAL_START)) * total,
    );
    for (; iClear < clearTarget; iClear++) {
      erase(orderClear[iClear]);
    }

    if (elapsed >= TOTAL_MS) {
      cancel();
      if (current && current.token === token) {
        current = null;
      }
      return;
    }
    raf = window.requestAnimationFrame(step);
  };
  raf = window.requestAnimationFrame(step);
}

/** Run the noise dissolve, applying `swap` (the light/dark flip) under full cover. Dots morph from the current theme's matrix to the other's. */
export function runThemeTransition(swap: () => void): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    swap();
    return;
  }

  teardown();
  const token = ++runToken;
  const sourceIsDark = document.documentElement.classList.contains('dark');
  const srcMap = sourceIsDark ? DARK_MAP : LIGHT_MAP;
  const tgtMap = sourceIsDark ? LIGHT_MAP : DARK_MAP;

  if (navigator.gpu) {
    startWebGPU(srcMap, tgtMap, swap, token)
      .then((handled) => {
        if (!handled && token === runToken) {
          startCanvas2D(srcMap, tgtMap, swap, token);
        }
      })
      .catch(() => {
        if (token === runToken) {
          startCanvas2D(srcMap, tgtMap, swap, token);
        }
      });
    return;
  }

  startCanvas2D(srcMap, tgtMap, swap, token);
}
