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

// Sunlight spread: light blooms out from the sun to go light, and recedes back into
// it to go dark. The sun's screen position comes from the footer skyline's sun/moon
// SVG (u.origin); this tunes only the softness of the dithered light front.
const EDGE_SOFT = 0.14; // width of the dithered light front, as a fraction of the screen span

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
    // Sunlight blooms from the sun/moon in the footer skyline (u.origin): a dithered
    // disc of light grows out of it for sunrise (→ light) and shrinks back into it for
    // sunset (→ dark). The radius sweeps the nearest→farthest visible point, so the
    // bloom spans the screen over the whole transition even when the sun is off-screen.
    let sun = u.origin;
    let d = distance(frag.xy, sun);
    let dMin = distance(sun, clamp(sun, vec2f(0.0, 0.0), u.resolution));
    let c0 = distance(sun, vec2f(0.0, 0.0));
    let c1 = distance(sun, vec2f(u.resolution.x, 0.0));
    let c2 = distance(sun, vec2f(0.0, u.resolution.y));
    let c3 = distance(sun, vec2f(u.resolution.x, u.resolution.y));
    let dMax = max(max(c0, c1), max(c2, c3));
    let soft = (dMax - dMin) * EDGE_SOFT;
    let lr = select(1.0 - p, p, toLight); // radius grows for sunrise, shrinks for sunset
    let frontR = mix(dMin - soft, dMax + soft, lr);
    // Dithered front: lit well inside the radius, dark well outside, grainy between.
    let pLight = clamp((frontR - d) / soft + 0.5, 0.0, 1.0);
    col = select(darkColor, lightColor, hColor < pLight);
  } else {
    // Reduced motion: a plain non-directional dither, source theme → target theme.
    let srcColor = select(lightColor, darkColor, toLight);
    let tgtColor = select(darkColor, lightColor, toLight);
    col = select(srcColor, tgtColor, morphFrac > hColor);
  }

  let coverAlpha = select(0.0, 1.0, on);
  return vec4f(col * coverAlpha, coverAlpha);
}
