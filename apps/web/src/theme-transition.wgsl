struct U {
  resolution: vec2f,
  progress: f32,
  cell: f32,
  sweep: f32,
  motion: f32,
  origin: vec2f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var lightTex: texture_2d<f32>;
@group(0) @binding(2) var darkTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

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
  v = v ^ (v >> vec2u(16u));
  v.x = v.x + v.y * 1664525u;
  v.y = v.y + v.x * 1664525u;
  v = v ^ (v >> vec2u(16u));
  return v;
}

// Value-noise fBm for the Patronus's wispy silver mist. hash21 is a precision-safe
// float hash (Dave Hoskins) — no sin(), so it stays stable across GPU backends.
fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, vec3f(p3.y, p3.z, p3.x) + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let e = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, e, w.x), w.y);
}

fn fbm(p: vec2f) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var freq = p;
  for (var k = 0; k < 3; k = k + 1) {
    sum = sum + amp * valueNoise(freq);
    freq = freq * 2.0;
    amp = amp * 0.5;
  }
  return sum / 0.875; // normalise the 0.5+0.25+0.125 octave sum to ~[0,1]
}

// Patronus bloom: silvery-blue light blooms out from the sun/moon (u.origin) to go
// light and recedes into it to go dark, with a wispy turbulent front and sparkles.
const EDGE_SOFT = 0.14; // width of the dithered theme boundary, as a fraction of the screen span
const PATRONUS_BLUE = vec3f(0.25, 0.50, 1.0); // saturated silvery-blue (glow fringe)
const PATRONUS_WHITE = vec3f(0.62, 0.82, 1.0); // cool blue-white core — NOT pure white, so it stays blue
const GLOW_WIDTH = 0.9; // halo thickness around the front, in units of EDGE_SOFT (narrower = more defined)
const GLOW_OPACITY = 0.92; // how strongly the front takes on the silvery-blue colour (blend, not add)
const GLOW_LIFT = 0.25; // gentle additive luminosity at the very peak (low, to avoid washing to white)
const WISP_SCALE = 5.0; // turbulence feature count across the screen height (higher = finer tendrils)
const WISP_FLOW = 1.6; // how far the mist drifts over the transition
const WISP_AMP = 0.26; // how far the wisps warp the front (fraction of the span) — higher = more flowing
const SPARKLE_CELL = 7.0; // sparkle grid size in device px
const SPARKLE_RATE = 30.0; // twinkle steps over the transition
const SPARKLE_THRESH = 0.93; // higher = fewer sparkles

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let ci = vec2u(frag.xy / u.cell);
  let r = pcg2d(ci);
  let hCover = f32(r.x) / 4294967296.0;
  let hColor = f32(r.y) / 4294967296.0;

  // The colour matrices are textures — the sampler does the bilinear in hardware
  // (fast + divergence-friendly on every backend, unlike a dynamically-indexed
  // uniform array, which is a slow constant-buffer path on D3D12/Windows).
  let uv = (vec2f(ci) * u.cell + vec2f(u.cell * 0.5)) / u.resolution;
  let light = textureSampleLevel(lightTex, samp, uv, 0.0).rgb;
  let dark = textureSampleLevel(darkTex, samp, uv, 0.0).rgb;

  // Cover envelope: dots fill in (0–0.3), hold full cover while the class-swap hides
  // at 0.5, then clear out (0.7–1). hCover gives each cell its own fill/clear moment.
  let p = u.progress;
  let fillFrac = clamp(p / 0.3, 0.0, 1.0);
  let clearFrac = clamp((p - 0.7) / 0.3, 0.0, 1.0);
  let morphFrac = clamp((p - 0.3) / 0.4, 0.0, 1.0);
  let on = hCover < fillFrac && hCover >= clearFrac;

  // Per-cell static grain so a cell keeps its tone as it recolours.
  let r2 = pcg2d(ci + vec2u(101u, 53u));
  let g = (f32(r2.x) / 4294967296.0 - 0.5) * 0.13;
  let lightColor = clamp(light + vec3f(g, g, g), vec3f(0.0), vec3f(1.0));
  let darkColor = clamp(dark + vec3f(g, g, g), vec3f(0.0), vec3f(1.0));

  let toLight = u.sweep > 0.0;
  var col = darkColor;
  if (u.motion > 0.5) {
    // Patronus bloom from the skyline sun/moon (u.origin). A radius sweeps the
    // nearest→farthest visible point so the front spans the screen over the whole
    // transition even when the sun is off-screen below.
    let sun = u.origin;
    let d = distance(frag.xy, sun);
    let dMin = distance(sun, clamp(sun, vec2f(0.0, 0.0), u.resolution));
    let c0 = distance(sun, vec2f(0.0, 0.0));
    let c1 = distance(sun, vec2f(u.resolution.x, 0.0));
    let c2 = distance(sun, vec2f(0.0, u.resolution.y));
    let c3 = distance(sun, vec2f(u.resolution.x, u.resolution.y));
    let dMax = max(max(c0, c1), max(c2, c3));
    let span = dMax - dMin;
    let soft = span * EDGE_SOFT;
    let lr = select(1.0 - p, p, toLight); // radius grows for sunrise, shrinks for sunset
    let frontR = mix(dMin - soft, dMax + soft, lr);

    // Wispy silver mist: turbulence warps the front so it flows like a Patronus.
    let nrm = frag.xy / max(u.resolution.y, 1.0);
    let flow = fbm(nrm * WISP_SCALE + vec2f(0.0, -p * WISP_FLOW));
    let dEff = d + (flow - 0.5) * WISP_AMP * span;

    // Theme dissolve, with the turbulent front giving a grainy, smoky boundary.
    let pLight = clamp((frontR - dEff) / soft + 0.5, 0.0, 1.0);
    let themeColor = select(darkColor, lightColor, hColor < pLight);

    // Luminous silvery-blue halo concentrated on the moving front (gaussian falloff),
    // whiter at the peak and bluer at the fringe.
    let edge = (dEff - frontR) / (soft * GLOW_WIDTH);
    let glow = exp(-edge * edge);
    let glowCol = mix(PATRONUS_BLUE, PATRONUS_WHITE, glow);

    // Twinkling sparkles riding the glow band.
    let scell = floor(frag.xy / SPARKLE_CELL) + floor(vec2f(p * SPARKLE_RATE, 0.0));
    let sparkle = step(SPARKLE_THRESH, hash21(scell) * (0.35 + 0.65 * glow)) * glow;

    // Blend the front toward the silvery-blue so it keeps that colour instead of washing
    // to white, then a small additive lift (glow², peak-only) and sparkles for luminosity.
    let lit = mix(themeColor, glowCol, glow * GLOW_OPACITY);
    col = clamp(lit + glow * glow * GLOW_LIFT * PATRONUS_WHITE + sparkle * PATRONUS_WHITE, vec3f(0.0), vec3f(1.0));
  } else {
    // Reduced motion: a plain non-directional dither, source theme → target theme.
    let srcColor = select(lightColor, darkColor, toLight);
    let tgtColor = select(darkColor, lightColor, toLight);
    col = select(srcColor, tgtColor, morphFrac > hColor);
  }

  let coverAlpha = select(0.0, 1.0, on);
  return vec4f(col * coverAlpha, coverAlpha);
}
