struct U {
  resolution: vec2f,
  origin: vec2f,
  progress: f32,
  cell: f32,
  ripple: f32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var tgtTex: texture_2d<f32>;
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

// Animated accent dots: concentric rings expanding from the centre that recolour
// a moving subset of dots (see the fs body for the colour). Tunable.
const RING_SPACING = 180.0; // ring period in cells (larger = fewer, more spaced-out rings)
const RING_SPEED = 2.0; // outward pulse speed across the transition (lower = calmer)
const RING_THRESHOLD = 0.89; // higher = thinner rings / fewer accent dots
const RING_OFFSET = -0.6; // morph offset for ring dots: negative trails old colours, positive previews new
const ACCENT_ALPHA = 0.8; // accent (ripple) dot opacity; lower = more see-through

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
  let s = textureSampleLevel(srcTex, samp, uv, 0.0).rgb;
  let t = textureSampleLevel(tgtTex, samp, uv, 0.0).rgb;

  // Three dither windows: fill in, morph source→target, clear out.
  let p = u.progress;
  let fillFrac = clamp(p / 0.3, 0.0, 1.0);
  let clearFrac = clamp((p - 0.7) / 0.3, 0.0, 1.0);
  let morphFrac = clamp((p - 0.3) / 0.4, 0.0, 1.0);
  let on = hCover < fillFrac && hCover >= clearFrac;
  let base = select(s, t, morphFrac > hColor);

  // Existing dots: static grid, recolouring source→target, with fixed grain.
  let r2 = pcg2d(ci + vec2u(101u, 53u));
  let g = (f32(r2.x) / 4294967296.0 - 0.5) * 0.13;
  let pageColor = clamp(base + vec3f(g, g, g), vec3f(0.0), vec3f(1.0));

  // Accent dots run the SAME source-to-target progression as the field, just
  // offset in the morph by RING_OFFSET — so each ring is a wavefront of that same
  // colour progression (trailing old colours, or leading the new) rather than a flip.
  let accent = clamp(select(s, t, (morphFrac + RING_OFFSET) > hColor) + vec3f(g, g, g), vec3f(0.0), vec3f(1.0));
  let distPx = length(frag.xy - u.origin);
  let ring = sin(distPx / (u.cell * RING_SPACING) - u.progress * RING_SPEED);
  let isAccent = ring > RING_THRESHOLD && u.ripple > 0.5;
  let col = select(pageColor, accent, isAccent);

  // Accent (ripple) dots render at reduced alpha so the page tints through them;
  // the field dots stay fully opaque to keep the class-swap hidden.
  let a = select(0.0, 1.0, on) * select(1.0, ACCENT_ALPHA, isAccent);
  return vec4f(col * a, a);
}
