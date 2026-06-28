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

// hash21 / valueNoise / fbm — same sin-free, backend-stable helpers as theme-transition.wgsl.
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
  for (var k = 0; k < 5; k = k + 1) {
    sum = sum + amp * valueNoise(freq);
    freq = freq * 2.0;
    amp = amp * 0.5;
  }
  return sum;
}

const PI = 3.14159265;

// A two-tone accretion disk (cool blue sweeping one side, hot crimson the other)
// swirling around a dark event horizon, with a photon ring and a lensed arc bent
// over the top. Output is premultiplied alpha so the disk's glow fades into the
// page and the corners stay transparent.
@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let uv = (frag.xy - 0.5 * u.resolution) / u.resolution.y;
  let t = u.time;
  let r = length(uv);
  let ang = atan2(uv.y, uv.x);
  let side = clamp(uv.x / max(r, 0.0001) * 0.5 + 0.5, 0.0, 1.0); // 0 = blue (left), 1 = crimson (right)

  let horizon = 0.30;
  let inner = horizon * 1.03;
  let outer = 0.66;

  // Spiral swirl coordinate (angle + log-radius), drifting over time.
  let lr = log(r + 0.001);
  let sp = vec2f(ang * 1.5 / PI + lr * 0.9, lr * 1.5 - t * 0.04);
  var dens = fbm(sp * 4.0 + vec2f(t * 0.05, 0.0));
  dens = mix(dens, fbm(sp * 9.0 - vec2f(0.0, t * 0.09)), 0.45);

  let band = 1.0 - smoothstep(inner, outer, r);
  let hot = pow(band, 1.6);
  let gas = smoothstep(0.34, 0.86, dens);
  let disk = band * gas * (0.42 + 0.95 * hot);

  let blue = vec3f(0.22, 0.46, 1.0);
  let red = vec3f(1.0, 0.21, 0.12);
  let hotw = vec3f(1.0, 0.93, 0.82);
  let tone = mix(blue, red, side);
  let whiteMix = clamp(smoothstep(0.58, 0.95, dens) * (0.4 + 0.7 * hot), 0.0, 1.0);
  var col = mix(tone, hotw, whiteMix) * disk * 1.5;

  // Photon ring hugging the horizon.
  let ring = 1.0 - smoothstep(0.0, 0.016, abs(r - horizon));
  col = col + hotw * ring * 1.1;

  // Gravitational-lens arc bent over the top.
  let top = smoothstep(0.0, 0.14, uv.y);
  let arc = (1.0 - smoothstep(0.0, 0.05, abs(r - horizon * 1.16))) * top;
  col = col + mix(blue, hotw, 0.5) * arc * 0.8;

  // Carve the event horizon to black.
  let horizonMask = smoothstep(horizon * 0.9, horizon, r);
  col = col * horizonMask;

  // Outer warm bloom.
  let bloom = exp(-pow(max(r - horizon, 0.0) * 4.0, 2.0));
  col = col + tone * bloom * 0.10;
  col = clamp(col, vec3f(0.0), vec3f(1.0));

  let horizonFill = 1.0 - horizonMask;
  let glowA = bloom * 0.55 + ring + arc;
  let alpha = clamp(max(horizonFill, max(disk, glowA)), 0.0, 1.0);

  return vec4f(col * alpha, alpha);
}
