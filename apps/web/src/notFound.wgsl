struct U {
  resolution: vec2f,
  time: f32,
};
@group(0) @binding(0) var<uniform> u: U;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

// hash21 / valueNoise / fbm — the sin-free, backend-stable helpers from theme-transition.wgsl.
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
  for (var k = 0; k < 6; k = k + 1) {
    sum = sum + amp * valueNoise(freq);
    freq = freq * 2.0;
    amp = amp * 0.5;
  }
  return sum;
}

const PI = 3.14159265;

// ---- look dials ----
const TILT = -0.62;       // disk / jet axis angle (diagonal, lower-left → upper-right)
const SQUASH = 0.78;      // disk foreshorten (minor/major) — smaller = more edge-on
const HORIZON = 0.22;     // event-horizon radius (uv units; whole artwork fits r < ~0.46)
const DISK_INNER = 0.235;
const DISK_OUTER = 0.42;
const SPIN = 0.16;        // accretion rotation speed
const WINDINGS = 2.6;     // spiral-arm tightness

// A high-fidelity tilted accretion disk: domain-warped plasma filaments swirling
// (differential rotation) around a dark event horizon, a relativistic jet along the
// tilted axis, two-tone Doppler colour (cool blue / hot crimson) with a beamed
// hotspot, a photon ring, and the far side lensed over the top. Premultiplied alpha,
// vignetted to a circle so it never clips the square canvas.
@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let uv = (frag.xy - 0.5 * u.resolution) / u.resolution.y;
  let t = u.time;
  let r = length(uv);

  // Tilt the whole hole so the disk + jet run on a diagonal axis.
  let ct = cos(TILT);
  let st = sin(TILT);
  let p = vec2f(uv.x * ct - uv.y * st, uv.x * st + uv.y * ct);

  // Elliptical (foreshortened) disk coordinates.
  let ey = p.y / SQUASH;
  let re = length(vec2f(p.x, ey));

  // Swirl the disk-plane sample coordinate by a radius-dependent twist (logarithmic
  // spiral) plus differential rotation over time, then domain-warp it. Rotating
  // Cartesian coords — NOT atan2 — means there is no ±π branch-cut seam (the artifact
  // that showed only on the blue side, where that cut falls under the tilt).
  let roll = t * SPIN;
  let twist = log(re + 0.02) * WINDINGS - roll / max(re, 0.12);
  let cw = cos(twist);
  let sw = sin(twist);
  let pe = vec2f(p.x, ey);
  let q = vec2f(pe.x * cw - pe.y * sw, pe.x * sw + pe.y * cw);
  let baseC = q * 13.0;
  let warp = vec2f(fbm(baseC * 0.7), fbm(baseC * 0.7 + vec2f(7.1, 2.3)));
  var dens = fbm(baseC * 1.4 + warp * 1.6);
  dens = dens * 0.62 + fbm(baseC * 3.0 + warp * 2.2) * 0.38;

  // Furious accretion disk: a full annulus with a low gas threshold so lots of
  // plasma shows, plus bright turbulent flares.
  let inEdge = smoothstep(DISK_INNER - 0.015, DISK_INNER + 0.03, re);
  let outEdge = 1.0 - smoothstep(0.35, 0.47, re);
  let radial = inEdge * outEdge;
  let hot = 1.0 - smoothstep(DISK_INNER, DISK_OUTER, re);
  let gas = smoothstep(0.16, 0.70, dens);
  let flare = smoothstep(0.60, 0.96, dens);
  var disk = radial * (gas * (0.5 + 1.4 * hot * hot) + flare * 0.8);

  // Relativistic jet / extended disk plane along the major (p.x) axis.
  let jy = p.y / 0.045;
  let jetCore = exp(-jy * jy);
  let jetSpan = 1.0 - smoothstep(0.16, 0.42, abs(p.x)); // taper fully inside the canvas (no edge clip)
  let jetTex = 0.35 + 0.85 * fbm(vec2f(p.x * 7.0 - roll * 2.0, p.y * 26.0));
  let jet = jetCore * jetSpan * jetTex;
  disk = disk + jet * 0.6; // additive, not max() — max leaves a hard crease where jet meets disk

  // Two-tone Doppler colour: cool blue (left) → hot crimson (right).
  let side = clamp(uv.x / max(r, 0.0001) * 0.5 + 0.5, 0.0, 1.0);
  let blue = vec3f(0.30, 0.55, 1.0);
  let red = vec3f(1.0, 0.24, 0.13);
  let hotw = vec3f(1.0, 0.95, 0.88);
  let tone = mix(blue, red, side);
  let beam = 0.55 + 0.9 * smoothstep(-0.55, 0.65, p.x); // beamed brighter on the approaching side
  let whiteMix = clamp(smoothstep(0.55, 0.95, dens) * (0.3 + 0.85 * hot), 0.0, 1.0);
  var col = mix(tone, hotw, whiteMix) * disk * beam * 2.1;

  // Bright beamed hotspot knot.
  let hd = (re - 0.30) * 6.0;
  let hs = exp(-hd * hd) * smoothstep(0.05, 0.6, p.x) * smoothstep(0.45, 0.9, dens);
  col = col + hotw * hs * 0.7;

  // Photon ring + a single unified lensed inner rim (no p.y split → no seam),
  // coloured from the disk's own left/right tone for consistency.
  let ring = 1.0 - smoothstep(0.0, 0.012, abs(r - HORIZON));
  col = col + hotw * ring;
  let arc = 1.0 - smoothstep(0.0, 0.05, abs(re - HORIZON * 1.18));
  col = col + mix(tone, hotw, 0.6) * arc * 0.5;

  // Carve the event horizon to black (the disk passes behind it at top/bottom).
  let horizonMask = smoothstep(HORIZON * 0.92, HORIZON, r);
  col = col * horizonMask;

  // Outer warm bloom — wider and stronger so the fury glows around the hole.
  let bd = max(r - HORIZON, 0.0) * 3.8;
  let bloom = exp(-bd * bd);
  col = col + tone * bloom * 0.14;

  // Sparse field stars.
  let scell = floor(frag.xy / 3.0);
  let star = step(0.9965, hash21(scell)) * smoothstep(DISK_OUTER * 0.95, DISK_OUTER + 0.04, re);
  col = col + vec3f(0.82, 0.88, 1.0) * star * 0.9;

  col = clamp(col, vec3f(0.0), vec3f(1.0));

  // Coverage alpha + a circular vignette so the artwork fades out before the square edge.
  let horizonFill = 1.0 - horizonMask;
  let glowA = bloom * 0.5 + ring + arc + jet * jetCore;
  let vign = 1.0 - smoothstep(0.42, 0.5, r);
  let alpha = clamp(max(max(horizonFill, disk), glowA), 0.0, 1.0) * vign;

  return vec4f(col * alpha, alpha);
}
