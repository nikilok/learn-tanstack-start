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
 * The SOURCE/TARGET colours come from per-theme matrices sampled from
 * screenshots of the real pages (downsampled to MAP_COLS×MAP_ROWS), sampled
 * bilinearly per dot — so the noise starts off in the page's actual colours.
 * Sets for the home page (desktop + mobile layouts), the home page with an
 * active search (results), and company details — chosen by route, search param,
 * and viewport width at toggle time.
 *
 * Primary path is a WebGPU fragment shader; it falls back to a canvas-2D plot of
 * the same dissolve where WebGPU is unavailable, and to an instant swap if
 * neither canvas works. The dissolve runs regardless of `prefers-reduced-motion`,
 * but the ripple rings (coherent radial motion) are gated off for users who
 * prefer reduced motion.
 */

// This TS lib.dom ships the WebGPU interfaces but not the GPUBufferUsage flag
// constant — declare the bits we use; the browser provides them at runtime.
declare const GPUBufferUsage: {
  readonly UNIFORM: number;
  readonly COPY_DST: number;
};
declare const GPUTextureUsage: {
  readonly TEXTURE_BINDING: number;
  readonly COPY_DST: number;
};

// Single progress timeline; the three windows + the hidden swap point within it.
const TOTAL_MS = 1000;
const COVER_END = 0.3; // dots finished scattering in
const REVEAL_START = 0.7; // dots start scattering out
const SWAP_AT = 0.5; // theme class flip, mid-morph under full cover
// Easing applied to the whole progress timeline. Point EASING at any entry to
// change the feel (cubic in-out / ease-in / ease-out / linear); each maps
// [0,1]→[0,1] monotonically.
const EASINGS = {
  linear: (t: number) => t,
  cubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  easeIn: (t: number) => t * t * t,
  easeOut: (t: number) => 1 - (1 - t) ** 3,
};
const EASING: (t: number) => number = EASINGS.easeOut;
// Dot edge in CSS px — chunkier on desktop, finer on the narrow mobile layout
// (see cellSizeCss). The canvas-2D grid is capped to ~MAX_CELLS dots so
// large/HiDPI viewports don't overload CPU.
const CELL_CSS_DESKTOP = 1.5;
const CELL_CSS_MOBILE = 1;
const MAX_CELLS = 360000;
// Per-dot brightness jitter (±, 0–255 scale) so the fill reads as grain.
const JITTER = 16;
// Below this viewport width the home page uses its mobile (portrait) layout.
const MOBILE_BREAKPOINT = 640;

/** Dot edge in CSS px for the current viewport (smaller on the mobile layout). */
function cellSizeCss(): number {
  return window.innerWidth < MOBILE_BREAKPOINT
    ? CELL_CSS_MOBILE
    : CELL_CSS_DESKTOP;
}

/** Viewport point (CSS px) the rings emanate from: just below the theme toggle, else screen centre. */
function rippleOrigin(): [number, number] {
  const el = document.querySelector('[data-theme-toggle]');
  if (el) {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.bottom];
  }
  return [window.innerWidth / 2, window.innerHeight / 2];
}

// Per-theme colour matrices sampled from screenshots of the real pages,
// downsampled to MAP_COLS×MAP_ROWS and packed as `rrggbb` hex (row-major,
// top→bottom) — so the dots start in the page's actual colours. One set for the
// home page, one for the company details page (chosen by route at toggle time).
// Regenerate via the sampling script if the design changes.
const MAP_COLS = 24;
const MAP_ROWS = 16;
const MAP_N = MAP_COLS * MAP_ROWS;

const HOME_LIGHT_HEX =
  'f8f7fae0dfe7e9e6ecf4e6ebfafafcfafbfdfafbfdfafbfdfafafdfafafdfafafdfafafdfafafdfafafdfafbfdfafbfdfafbfdfafbfdfafbfdfafbfdfbfbfdf9f9fbf6f6f8f7f7faf5f6faedeef5f1f2f8f1eff6f3f5faf4f6fcf3f5fcf3f5fcf3f5fbf2f4fbf2f4fbf2f4fbf2f4fbf2f5fbf2f5fbf3f5fbf3f6fbf4f6fbf4f6fbf5f6fbf5f7fbf5f6fbf4f6faf5f6faf1f1f8f0f1f9eef1f9edf0f9eceef8e8ebf5e6eaf5e5e8f4e7ebf7e8ecf8e7ebf7e8ebf7e8ebf7e8ebf7e9ecf7e9edf7ebeef8edf1faeceff9eceef8eceef8edeef8eeeef8f1f1f8f4f4f8f3f3f8f2f3f8f1f2f8eff0f8e8e9f0e6e8efe4e5ededeef6eef0f8f0f1f9f0f0f9f0f1f9f1f1f9f1f1f9f1f2f9e5e6edd4d4dce6e6efeeeef8efedf7efedf7efedf7f2eff7f4f4f8f4f4f8f4f4f8f4f4f8f3f3f8f8f8faf8f8f9f8f8f9f7f7f8f9f9fafcfcfdfdfdfdfcfcfdfcfcfdfcfcfdffffffc1c0c2646365c9c6cdf3effaefebf6efebf6efebf6f0eef7f3f3f8f3f3f8f3f4f8f4f4f8f4f4f8f4f4f8f4f4f8f3f3f8f3f2f8f3f3f8f5f4faf7f5fbf7f4fbf4f0f9f1edf6f0ecf6eeeaf4ece8f2eee9f4eee9f5eee8f5ede8f5ede8f5efecf6f1f2f8f1f2f8f1f2f8f2f2f8f3f3f8f3f3f8f3f3f8f3f3f8f4f3f9f0eff4d2d1d6bbb9bebfbcc3dcd8e1f1ecf7efe9f4efe9f5efe9f5ede7f4ece6f4ece5f5ebe5f5ebe3f5eee9f6eff0f8eff0f8eff0f8f0f1f8f1f1f8f1f2f8f2f2f8f3f3f8f4f4f9ecebf0bdbcc0a8a7acadaab1c9c6ceefeaf5efe9f5eee8f4ede7f4ece5f3ebe4f4eae3f4eae2f4e9e0f4ece7f5edeff8edeff8edeff8edeff8edf0f8eef0f8eff0f8f0f1f8f1f2f8ededf3e7e5ede9e7f0e8e5efe7e4eeece8f3ede9f5ece7f4ebe6f4eae4f4eae3f4e9e2f4e8e0f3e7def3ebe5f4e9eef8e9edf8e9edf8e9eef8e9eef8eaeef8ebeff8eceff8edeff8eff0f9eff0f9efeef8eeedf8eeecf7ebe9f6eae8f5e9e6f5e9e5f5e8e4f4e7e2f4e7e1f4e6e0f3e5def3eae5f5e4eaf8e4eaf8e4eaf8e4eaf9e5eaf9e6ecf8e7edf8e8edf8e9eef8eaedf6eceff7ecedf7ececf6e9eaf4e9e8f6e8e7f6e7e6f5e7e4f5e6e4f5e6e3f5e5e1f4e5e1f4e5e0f4ebe7f5dfe6f8dfe6f8e0e6f8e0e7f8e1e8f8e2e8f9e3e9f9e4eaf9e6ecf9e0e6f1e0e3ede4e8f2e2e5efe2e3f0e4e5f4e7e7f7e5e6f6e5e5f6e5e4f5e4e3f5e4e2f5e4e2f5e4e1f5eae8f6e5ebf9e5ebf9e6ebf9e6ebf9e6ecf9e7edf9e8edfaeaeefaeaeefae9edf7e9edf3eaecf0ecedf1ecedf4eaecf6ecedf8ebedf8ebecf8ebebf8ebebf8ebebf8ebebf8ebebf8efeef8ecf1fcedf1fcedf1fcedf1fceef1fceef2fceff2fcf0f3fcf0f3fcf1f4fde8ebf2e3e5ece7e9f0eff1f9f2f4fcf2f4fbf2f3fbf2f3fbf1f3fbf1f3fbf2f3fbf2f3fbf2f3fbf3f3faebf1fcebf1fcecf1fcecf1fcecf1fcedf1fcedf1fcedf1fceef2fceff2fdeff2fce9ecf4e9ebf4f1f3fcf1f3fcf1f3fcf1f3fcf1f3fcf1f3fbf1f3fbf2f3fbf2f3fbf2f3fbf3f4faecf1fcebf1fcebf1fcecf1fcecf1fcecf1fcecf1fcedf1fcedf1fcebeffae8ecf6e8ecf6e9ecf6eaedf7eef2fbeff3fcf0f3fcf0f3fcf1f3fcf1f4fcf2f4fcf2f4fcf3f5fcf3f5fb';
const HOME_DARK_HEX =
  '0f0d0e2926291e1c1e2015170b0b0d0a0a0c0a0a0b0a0a0b0a0a0c0a0a0c0a0a0c0a0a0c0a0a0c0a0a0c0a0a0b0a0a0b0a0a0c0a0a0c0a0a0c0a0a0c0a0a0c0c0c0d0f0f0f0d0d0d0c0d0e1213150f10131110140b0d110a0d100b0d120b0d120b0e120d0e140c0d130c0e130d0e140c0d130c0e130c0d120b0d120c0d110a0d110a0c100a0c0f0b0c0e0c0d0f0d0d0e0a0b0e090c0f0a0c100a0d120b0e140e11180f131a10141c0d111a0d11190e111a0e111a0e11190e111a0e10180d10170c0e15090b120a0d130b0d130b0d120b0c120c0c110d0d110a0a0a0a0a0b0a0a0c0a0b0e0b0d1014161a17181d1a1b200e10150d0e150d0e130e0f140f0f140d0e130e0e130e0d1215161b2525291414190d0c120d0b120d0b110e0a110e0c100a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0c0c0c0f0f0f0e0e0f0a0a0a0b0a0b0b0b0b0a0a0a0b0b0b0c0b0c0a0a0a070607474647a6a6a73c393d0d080f100b13100b13100b14100d130a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0b0c0b0b0c0c0c0d0d0c0e0d0c0d0d0b0d0b080b0c090c120c11130e13120d1316101619131a150f17130d16120c17120d18120d18110d150a0b0c0a0a0c0a0a0b0a0a0b0a0a0a0a0a0a0b0a0b0c0a0c0c0b0c0e0d0e242224383639393338221c22130c13150e15140d16140d16150e18150e19150e1a150e1b150d1c120e180a0c100a0c0f0a0c0e0a0b0e0a0b0d0a0a0c0a0a0c0b0b0b0a0a0b1615164e4d4e686668635f633f3a3f140c14150d16160e18170f19160f1a170f1c170f1d160d1d160d1f140e1a0a0d110a0d110a0d110a0d110a0c100a0c0f0b0b0e0b0b0d0b0b0d100f1119181b19161b1a151b1b151c150f17140e18160f1917101b180f1c170f1d170e1e180e20190f22160f1c0b0e140b0e140b0e140b0e140b0e140b0e130b0d120b0d110c0c100c0c100d0b100f0b11100b13110c15140f1815101a16101c17101d170f1e170f1f180f21180f22190f23150f1d0c111a0c111a0d111a0d10190d10190d10180c0f170d0e150c0e140d0d130e0e14100e1517151d1a1720140f1a14101c16111d17101e160f1e17101f171021170f21170f23150f1c0e131f0e121f0f121e0f121e0e121d0e111c0e111b0e10190e101812131b13141b12111917161f1a182215111d14101c15111e15101e15101f161120161020160f21160f22140f1b0f131f0f131f0f121f0f121e0f121d0f121d0f121c0f111b0f111a13131c17181d16161b16161b16151b14121c13101b13101b13101c13101c13101d13101d140f1d130f1d120f180d10190c10180c0f170c0f170c0f160c0e160c0e150c0d150d0e140d0e1314151917171b1313180f0f140d0c120d0d130e0d130e0d140e0d140e0d140e0c140e0c140e0c140e0d120c101a0c10190d10180d10180d0f180d0f170d0f170d0f160d0e150d0d141313191b1b2118181d0f0f150d0d130d0d130d0d130d0d130e0d140e0d130e0d130e0d130e0c130e0d120d10190d10190d10190d10180d10180d10180e0f170e0f170d0f160e0e160e0e151212191213190d0d150d0d140d0d140d0d140d0d130d0d130d0d130d0d120d0d120d0c120e0d11';

/** Parse a packed `rrggbb…` hex string into a MAP_N-length `[r, g, b]` grid, shifting every channel by `shift` (clamped). */
function parseHexMap(hex: string, shift: number): number[][] {
  const map: number[][] = [];
  for (let i = 0; i < MAP_N; i++) {
    const o = i * 6;
    map.push([
      channel(Number.parseInt(hex.slice(o, o + 2), 16) + shift),
      channel(Number.parseInt(hex.slice(o + 2, o + 4), 16) + shift),
      channel(Number.parseInt(hex.slice(o + 4, o + 6), 16) + shift),
    ]);
  }
  return map;
}

// Company details page maps (spliced from screenshots 3/4).
const DETAILS_LIGHT_HEX =
  'f8f7fadfdfe7e9e7edf4e6ebfafafcfafbfdfafbfdfafbfdfafafdfafafdfafafdfafafdfafafdfafafdfafafdfafafdfafbfdfafbfdfafbfdfafbfdfbfbfdfafafcf6f6f8f8f9faf4f5fbeceef5f0f2f8f0eff6f3f4fbf2f5fcf2f5fcf1f5fcf1f4fcf1f4fcf1f4fcf1f3fcf1f3fcf1f4fcf1f4fcf1f4fcf1f5fcf2f5fcf3f5fcf3f5fcf4f6fcf4f6fbf4f5faf5f6fbedeff9eceff8ebeff8eaeff8e8edf8e8edf8e9eef9e9eefae7ecf9e6ecf9e5ebf9e5ebf8e5ebf8e5ebf8e6ebf8e6ecf8e7ecf8e7edf7e8edf7e8edf8eaeef8ebeff8eceff8eff0f9eff0f9edeff9edeff8ebeff8eaeff8ebeef2dfe0e2dbdcdee8e9ebf3f4f6f1f3f5f2f3f6f2f3f6f4f5f8f4f5f8f4f5f8f4f5f8f4f5f8f0f2f7eaeff8eceff8eceff8edeff8f0f1f8f1f2f9f0f1f9eff0f9edeff9eceff9eef0f3dfe0e1dbdcdddddee0e2e3e5e1e2e4e3e4e6ecedeff5f6f8f5f6f8f5f6f8f5f6f8f5f6f8f1f3f7ebeef8eceef8eeeff8eeeff8f0f0f8f3f3f8f1f2f8f1f1f8eff0f9eef0f9f0f1f5ecedefecedefededefeeeff1f4f5f7f4f5f7f5f6f8f5f6f8f5f6f8f4f5f7f5f6f8f6f7f9f1f2f7ecedf8edeef8eeeef7efeef7f1eff8f4f4f8f3f3f8f2f3f8f1f2f8f0f1f8edeef2e6e7e8f5f6f8f3f4f6e7eaeaf4f5f7f4f5f7e4e5e6e8e9ebf5f6f8e8e8eae8e9eaeeeff0f2f2f8edecf7eeecf7efedf7efedf7f1eef7f4f4f8f4f4f8f4f4f8f3f3f8f2f3f8f1f2f6f0f1f4f2f3f6f3f4f7eff0f4f1f2f6f2f4f7eff0f5eff0f4f1f2f6eff0f5ededf2f0f0f5efeff7eeecf7eeecf7efecf7efecf7f0edf7f4f4f8f4f4f8f4f4f8f4f4f8f4f4f8f2f2f5e7e7eaf1f1f4f6f7faededf0f5f5f9f7f7fbe9e9ece4e4e8eeeef1e9e8ede9e8edf6f5faf3f1f9eeebf7efebf6efebf6efebf6f0ecf6f4f4f8f4f4f8f4f4f8f4f4f8f4f4f8f3f3f5e8e8eaf0f0f2f9f9fbfafafdfafafdfafafcf8f8fbf8f7faf8f7faf8f6faf8f6fbf9f7fbf3f1f8eeeaf6eeeaf6eeeaf6eee9f6efeaf6f3f3f8f3f3f8f3f3f8f3f4f8f4f4f8f2f2f5e6e6e8ededeef6f6f8f8f8faf7f7f9f7f7f9f7f6f9f6f5f8f6f4f8f5f4f8f4f3f8f7f4faf4f0f7eee9f6eee8f6ede8f5ede7f5eee9f5f2f2f8f2f2f8f3f3f8f3f3f8f3f3f8f3f3f5e7e7e9ebecedefeff0efeff1efeef0efeef0f0eff1efeef0efedf1eeedf1edebf0f3f1f5f2eef6ede7f5ece7f5ece6f5ece5f5ede7f6f0f1f8f1f2f8f1f2f8f2f2f8f2f2f7eaeaebe5e7e4e0e1dfdfe1dee0e1dfe3e3e1e3e4e1e6e6e4eae9e7e9e9e6e9e9e7ebebe9ebebe8ebe8ebece7f5ece5f6ebe4f5ebe3f5ece5f5eff1f9f0f1f9f0f1f9f0f1f9f1f2f8e4e9e6e0e5e0e0e0dee8e8e6e8e8e6e3e4e1e7e3e1e4e0dfe9e9e6e8e8e5e8e8e6ebebe8e9eae6e8e6eaece5f6ebe4f5ebe3f5eae2f5ebe4f4eef0f8eff0f9eff0f9f0f1f9f0f1f8e7eae9e5e7e3e1e3e0e9e9e7eaeae7e9e9e6e2dcdbe5deddeaebe7ebeae7ebeae7e9e9e6ecece8eae7ebece4f5ebe3f5eae2f5e9e0f4ebe4f5edeff8edeff8edeff8eef0f8eff0f8eeeff0eeefece2e6e1e3e3e1e6e6e3e8e8e5eaeae8e8e9e6ebebe8e9e9e6e9e9e6e9e9e6e7e7e4eae8ecebe3f6eae3f5e9e1f4e7dff3e4dcee';
const DETAILS_DARK_HEX =
  '0f0e0e2723271e1c1f2015160d0c0d0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0a0a0c0a0a0c0b0b0d0f0e0f1211110c0d101213170f11141111150c0e130b0d120b0e130b0e130b0e130b0e140b0e140b0e140c0e140b0e140b0e130b0e130b0e130b0d120b0d120b0d120a0d110a0d100b0d0f1011130b0d12090c12090e13090f150a10170d111b0d111b0d121d0e121e0f131f0e13200e14200f13200f14200f141f0f141f0f131e0e131d0c111a0a10170a0f16090e14090c120f12160a0d100a0d11090d12090d13090e13191a293132443434452a2a3c1d1d301d1e311d1e311d1d311a1a2e1a1a2e1a1a2d1a1a2d1b1a2e151726090e13090d130a0d120a0c111011150a0c0e0a0c0f0a0d110a0d12090d111618262b2b3d2f2f402e2e3f2a2a3c2b2b3d29293c2222351a1a2e1a1a2e1a1a2e1a1a2e1b1a2f1617260a0c120b0d130b0c120a0b111111150a0a0c0a0a0d0a0c0f0a0c0f0a0c101717262322362121342121342020331a1a2e1a1a2e1b1b2f1b1b2f1a1a2e1c1c301a1a2f1a1a2f1617260b0c120c0c130d0c120c0a111210150a0a0a0a0a0a0a0a0c0a0a0d090b0e191a282a293d1b1b301b1b302027361b1c301a1a3029293c28283b1b1b3026263928283b2223371616260d0b120e0b120e0b120d0910130f150a0a0a0a0a0a0a0a0a0a0a0a0a0a0b11111814151f15151f15161f15172015162015162015162015162015162016162116162117162315121d0f0b120f0b120f0a120f0912140f160a0a0a0a0a0a0a0a0a0a0a0a0a0a0a1414142323231c1d1d1718181f2020191a1a161717212122252527201f222322262423281a171d16131a0f0a12100a13100b14100a141510190a0a0a0a0a0a0a0a0a0a0a0a0a0a0a1515152a2a2a2020201616161616161414151414151a1a1b1e1d201b1a1d1d1a1e1b191f19161d17131b100b14110c15110c16110b1616111b0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a14141427272722222219191917171718181819181919181b1b191c1d1a1e1c1a1f1e1a211c182018141c110c16120c17120c18130c1817111c0a0a0d0a0a0c0a0a0b0a0a0a0a0a0a1616162525242020201e1e1d1d1d1d1e1f1e1f1e1f1f1e20201e21211e22221f24221f26201d241c1720120b17130d19140d1a140c1a18121e0a0c0d0a0b0d0a0a0c0a0a0c0a0a0b1b1b1b30312f3739373d3e3b3a3c393c3c3b393b38393a393435333535343535353434333535342a282b120b18140d1b140d1c140c1c19111f0a0c0f0a0c0f0a0b0f0a0b0d0a0a0c2223223a3b393f403e3939383839373e3f3d3d3a39423d3d373836383937363735363735383937302e31120b1a150d1c150c1c150c1d1912210a0c100a0c100a0c100a0c0f090b0d2a2c2b3e403d4142403939383637353637353f3b3a3e3939363735353634353634373836383936302e32130b1b150c1c150d1e160c1f1b12230b0d110b0d110a0d110a0c10090b0f2728283939384144403d3e3c3839373839373738363738363636353637353637353738363d3e3c2c2a2d130b1b150c1d160d1e170d201c1325';

// Home page with an active search (results list) — spliced from screenshots 5/6.
const SEARCH_LIGHT_HEX =
  'fdfdfefefeffefedf2e5e6edf3e8edfbfafbfcfdfefcfcfefcfcfefcfcfefcfcfefcfcfefcfcfefcfcfefcfcfefcfcfefcfdfefcfdfefcfdfefcfdfefafafcf9f9fafdfdfefcfcfdf5f6fbf4f6fbeff1f8eceff6eeeef6f0f3faf1f4fcf0f3fcf0f3fceff2fbeff2fceff2fbeff2fbeff2fbeff2fbf0f3fbf0f3fbf0f4fbf1f4fbf1f5fbf1f4faf2f4faf4f6fbf5f6fbeceff8e9eef8e8eef8e7ecf8e5ecf9e4eaf9e1e7f7dee5f5dde4f5e0e7f7dee5f6dee5f7dee5f7dfe6f8e0e7f8e0e8f9e1e8f9e3e9f9e4eaf9e5ebf9e7ecf8e8edf8eaeef8edf0f8eceff9ebeff8eaeef8e7edf8e6ecf9e5ebf9e1e6f3dee2ede0e4f0eaeef8e4e9f4e6ebf6e6ebf5e7ecf8e9eefae9eefaeaeffae6ecf9e5ebf9e7ecf8e8edf8e9eef8ebeff8eef0f8edeff9ebeff8eaeef8e8edf8e7ecf8e5ebf9ebeff8f2f4f6fbfdfffafcfefafbfefafbfdfafbfefafbfdfafbfdfafbfdf9fafcebeff9e5ebf9e7ecf8e8edf8eaeef8ebeff8eef0f8edeff8eceff8ebeff8e8edf8e7edf8e6ecf9e3e6f5e5e5f3e4e4f4e3e4f4e3e9f9e2e9fae3e9f9e2e9f9e3eaf9e4eaf9e4ebf9e5ebf9e6ecf8e7ecf8e8edf8eaeef8eceff8eef0f8edeff9eceff8ebeff8e9eef8e8edf8e8eef9dad9e9dbd3e1dad5e2dcd6e5dfe3efdfe4f0e2e8f8e2e9f9e2e9f9e3eaf9e4eaf9e5ebf9e6ecf8e8edf8e9eef8ebeff8eceff8eef0f8edeff9eceff8ebeff8eaeef8e8edf8e8edf8e3e9f7dee4f1e1e9f6e3eafae3e9f7e3e9f7e3eaf9e3eaf9e4eaf9e5ebf9e5ebf9e6ebf8e7ecf8e8edf8e9eef8ebeff8eceff8eff0f9eef0f9eceff8eceff8eaeef8e9eef8e9eef9e0e5f2cdd2ddd6dce8dde2efe1e6f3e3e8f5e4e9f8e4eaf9e4eaf9e5ebf9e5ebf8e6ecf8e7edf8e8edf8eaeef8ebeff8eceff8eff0f9eef0f9edeff9eceff8ebeff8e9eef8e9eef8e5e9f6e1e6f2dfe6f1dfe5f2e1e7f3e2e6f1e4eaf7e5ebf9e5ebf9e6ebf8e6ecf8e7ecf8e8edf8e9eef8ebeff8eceff8eceff8eff1f9eff0f9edeff9edeff8ebeff8eaeef8e9eef9e3e6f2d1d6e0d2d8e2dee3efe4e9f7e4e9f6e4e9f4e5ebf8e6ecf8e6ecf8e7ecf8e7edf8e8edf8e9eef8ebeff8eceff8edeff9f0f1f9eff0f9eeeff9eceff9eceff8ebeff8eaeef8e6e9f4dde1ecdce3ecdee3eee1e6f2e4e8f3e3e7f1e6ebf7e7ecf8e7edf8e8edf8e9eef8e9eef8ebeff8ebeff8eceff8edeff9f0f1f9eff1f9eef0f9edeff9eceff8ebeff8ebeff9e5e7f2d5d8e2d3d9e2d6dbe5e3e7f1e5e9f3e7edf8e7edf8e7edf8e8edf8e8edf8e9eef8eaeef8ebeff8eceff8edeff8eeeff8f0f1f8f0f1f9eff0f9eeeff9eceff8eceff8ebeff8e7eaf4dde1eadbe1eadde2ede2e6f0e6eaf4e7edf8e8edf8e8edf8e9eef8e9eef8eaeef8ebeff8eceff8eceff8edeff8eeeff8f0f1f8f0f1f9eff1f9eeeff9edeff9eceff8ecf0f9e6e8f1d5d9e2d2d9e0d6dae4dee2ebe4e8f0e7ecf7e8edf8e9eef8e9eef8eaeef8ebeff8eceff8eceff8eceff8edeff8eeeff8f0f1f8f1f2f9eff0f9eff0f9edeff9eceff9eceff9ebedf5eaeef7eaeef7e9eef8e8edf6e8ecf6e9eef7e9eef8eaeef8eaeef8ebeff8eceff8eceff8eceff8eceff8edeff8eeeff8f0f0f8';
const SEARCH_DARK_HEX =
  '0a0a0a09090a1c191c201f232016170d0b0c0a0a0b0a0a0b0a0a0b0a0a0c0a0a0c0a0a0c0a0a0c0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0a0a0b0d0d0e0e0e0f09090b0e0e0e0a0c0f0a0d101011161113181111170c0f150b0e140c0e140c0e150c0f160c0f150b0f150c0e150c0f160c0f150c0f150c0e140b0e140b0e140b0e130c0e130c0e12090d100e10120a0e140a0f160a0f170b10190b111b0c121d0e14201016221117230f15211016230f15220f15220e14210e14210d14200d131f0c121e0c121d0c111b0b11190b10170a0f150e12170a0d130a0f150a10160b10180c111a0b111b1318211a1e25181c2410141b12161e10141d11151d0e131c0d111a0d111a0d11190c121c0c111b0c11190b10180a0f170a0e140e11160a0d130a0e140a10160b10180c11190c111b0e12191314150a0b0c0b0c0d0b0c0d0b0c0e0b0c0e0b0c0e0b0c0e0b0c0e0c0d0d0d11180c111b0c11190b10180a0f160a0e130e11160a0d120a0e130a0f160b10170b10180c111911141e12131d12141e12141f0d121d0d121d0d131e0d131e0d131d0d121d0c121c0c111b0c111a0b10180b10170a0f150a0d130e10150a0d120a0d130a0f150a10170b10180a101822202b27212a232128221e281419211419210e141e0d131e0c121d0c121d0c121c0c111b0c11190b10180a10170a0f150a0d120e10150a0d120a0d130a0e140a0f160b10170b10180d131d1218220e141e0c131d0e131d0e131d0d131d0c131d0c121d0d121c0d121c0c111a0c11190b10180a0f160a0f140a0d120e10150a0d110a0d120a0e140a0f160a10170a0f17121720272b33191f2813182310151f0f141d0d131d0c121c0c121c0c121b0c111a0c11190b10180b10170a0f160a0e140a0d120e10150a0d110a0d120a0d130a0f150a0f160a10170e121c11161e11181f13182112171e13171e0e121c0c111c0c111b0c111a0c11190b10180b10170a0f160a0f150a0d130a0d120e10140a0d110a0d120a0d120a0e140a0f16090f1611151e22262d20252d1419220d121c0e131c0f141b0d121b0c111a0c11190c11190b10180b10170a0f160a0e140a0d130a0d120e10140a0d100a0d120a0d120a0e130a0f150a0f160f141c171c23151d23141a2112171f12151c13171d0d12190c11190b10180b10180b10170a0f160a0f150a0e130a0d120a0d110e10140a0d100a0d110a0d120a0d120a0e14090e1511151c20252c1f252b1e222a11151c0f131a0b10180b10180b10180b10180b10170a10160a0f150a0e140a0d130a0d120a0d110f10140a0c100a0d110a0d120a0d120a0e130a0e140f131a161b22161d2214192012161d10141a0b10180b10180b10180b10170a0f170a0f160a0f140a0e130a0d120a0d120b0c110f10140a0c0f0a0d100a0d120a0d120a0d13090d1312151b22272d21282d21252c181c2211151b0c11180b10170a10170a0f170a0f160a0f150a0e140a0d130a0d120b0c120b0c110f10140a0b0f0a0d100a0d110a0d120a0d120a0d130d10150d11170b11180c11180d12180e13190b11170a10170a10160a0f160a0f150a0e140a0e130a0d130b0d120b0c120b0c110f0f14';

// Mobile (portrait) home, no search — spliced from screenshots 7/8.
const MOBILE_LIGHT_HEX =
  'fafafdfbfbfee8e6ece4e5eceaedf3edebf0f5e9edf2ebf0f9fafdf9fafdf9fafdf9fafdf9fafdf9fafdf9fafdf9fafdf9fafcf9fbfdf5f7f9f6f7f9f4f4f6f5f6f8fafbfdf4f5f9f2f3faf2f4fbeeeff8eceef6eceff8eceef7edeef7eceff8edf1faecf0faecf0faecf0faebeffaeceffaedf0faecf0faedf0f9eef1faeef0f8efeff8eff1f8f0f1f8f2f3f9f3f3f8f1f2f8e9ebf2e0e2ebe3e5eee5e7f1e1e4eedce0eadde1ebe1e6f1e8edf8e7ecf8e6ebf8e7ebf8e8ecf8e8ebf7e8ebf7e9ecf7eaecf7eaebf7eff0fbf4f5fff0f0faeeeef7f3f2f8f4f4f8f3f4f7f3f4f6f3f4f7f2f3f7f1f2f6f1f2f6f1f2f6f2f2f7f3f4f8f5f6fbf5f6fcf5f7fcf6f7fcf6f7fcf6f7fcf6f7fcf6f5fbfaf9fecdcdd297969bd3d1d7f3f0faf3f2f7f4f4f8f6f6f9f7f7f8f7f7f9f5f5f7f6f6f8f6f6f9f6f6f7f6f7f8f6f6f9fcfbfdfdfdfffbfafefbfafdfaf9fcf9f6fbf9f7fbf9f8fbfcfafecac7cb8f8d91d0cdd3f2edf7f2f1f7f3f3f8f3f3f8f4f4f8f4f4f8f3f4f8f3f3f8f4f4f8f4f4f9ededf3dadadfd0d0d4d1cfd5d0cdd4dcdae2eae5f0f0eaf6efeaf5eee9f4eee7f3f2ecf9f7f0fdf0eaf6ede7f4f2f0f7f1f2f8f1f2f8f1f2f8f2f2f8f2f2f8f3f3f8f3f3f8ecebf1e2e2e7c7c6cac0bfc4bfbdc3bbb9bfc7c3ccd4cfdae7e3eeefe8f4eee7f3ede7f4ece6f4ebe4f2ebe4f4ebe4f5f1eff7eff0f8eff0f8eff0f8eff1f8f1f1f8f1f2f8f1f1f8f2f2f6f2f2f6f3f2f8f4f3f9f4f2faf2eef8f0ebf6efebf6ede7f3eee7f3ede7f4ece5f4eae3f3eae3f4e9e2f4e8e1f3f0eef6eceff8edeff8edeff8edeff8eef0f8eef0f8eff0f8f1f1f8f1f0f8f2f2f8f1f0f8f0ecf7efecf6efecf7edeaf5ede8f4ece7f5ebe5f4eae4f3eae3f4e8e2f4e7e0f3e7dff3f0edf6e9edf8e9edf8e9edf8e9edf8eaeef8ebeef8ebeef8eceef8edeff8eef0f8eeeef7edecf7edecf7ece9f6ebe9f5eae8f6e9e6f5e8e4f4e8e4f5e7e2f4e6e0f3e6e0f3e6dff4f0edf6e4eaf9e4eaf8e5eaf9e5ebf9e6ebf9e7ecf9e8ecf8e8edf8ebeff9ebeff8eceef8ecedf8ebebf6eaeaf6e9e9f6e8e7f6e7e6f6e7e5f6e6e4f5e6e3f5e6e2f5e6e1f5e6e1f5f0eef7dfe6f8dfe6f8dfe7f8e0e7f8e1e8f8e2e9f8e3e9f8e0e5f2e2e6f1e4e9f3e8ecf6e6e9f2e7e9f3e5e7f2e5e7f4e2e3f2e3e3f3e5e5f6e4e4f6e4e3f5e5e2f5e5e2f5e5e2f5efeef7e4eaf9e5eaf9e5ebf9e5ebf9e6ebf9e6ecf9ecf0fae4eaf2e9ebf1eaecf1eaecf1e9eaefeceef3eaecf1ecedf3e9eaf1edeef6ebebf8eaebf8ebebf8ebeaf8ebebf8ebebf8f1f1f8ecf1fcedf1fcedf1fcedf1fceef1fceef2fceff2fceff3fde7eaf3dadde4e6e8f0e6e8efe8e9f0e8eaf1e5e7edf1f2f9f3f4fbf2f3fbf2f3fbf2f3fcf2f3fbf2f3fbf2f3fbf3f3f9ebf1fcebf1fcecf1fcecf1fcecf1fcedf1fcedf1fdeef2fdedf1fcebeef8e1e4ecedf0f9e0e2eae7e9f2f0f3fbf2f4fcf2f4fcf1f3fbf1f3fbf2f3fbf2f3fbf2f3fbf2f4fbf3f4f9ebf1fcebf1fcebf1fcecf1fcecf1fcecf1fce7ecf7e5e9f3e8ecf7e9ecf7e4e7f1ecf0fae7ebf4e6eaf3e9ecf5e8ebf5eaedf5f1f3fcf1f3fcf1f4fcf2f4fcf2f4fcf3f5fcf3f4f9';
const MOBILE_DARK_HEX =
  '0405050304041c181b1d1c20131416151316170e0f1911130706070505060505070505060505060505060505060505060505060605070606070b0b0c09090a0e0e0f09090904050505070d04070d080a12090d15080d15080d15080c14090e15050c13060d15070d16060d15070e16080e17060d15060c14070d15080c15070b130a0c140a0b13070a1206080f07080e0305090a0d1313161e0e111b0d111b0e121c131823131823101722070d1a050c18060d19080e1b060d19060d19090e1b090d19070b17090b180a0b1703030f00000b0807110909110404040607080a0a0c090a0c0a0b0e0a0a0e0b0c100b0d110a0c11080a0e07080e07080f07080e06070d06070c06080c04060b06060c0a080e08070d4343486260661e1c2308040d0404040505050808080808080a0a090b0b0b0b0b0b0b0b0b0909090b0a0b0707070102010403040805090504070706090a070b0605080503080a070b55515575727626212a0f06130404040404040404040404040404050505060505050404040605081a191c2120222928292b292d24222617121a140b171109150e07141309171509180c02110b000f1509171509190405070405070405060405060505070505060504050b0a0d1110133534353a393b474548444246423f453a323b201823120b19140917170b1a140919160a1a1a0d1c170a1c16091c05070d04070d04060c04060b05050905050706060807060806060606050708050805030709040c0f07120d06130e0716160a19170a19150819180b1b1b0c1d17091d17081e180a1f04071105071105071005070f05070e06070e05070c05060908070a0806090705090a070e0e08120b06120e071414091815091914081a180b1c1a0c1d17081d17091f1a0c211a0b23050a15050a15050a15050a1505091405091406081307081208081107070d09080f0c08130c07140e0816120a18130a1914091a170c1c180b1d16091e170b20190c21190b22190a23070f1a080f1a080f1a080e19070e19070d17080c17080b160709140909130a09130a08140d0916110b1818111f140c1c150c1c160c1d150a1d150a1e170b20170b21170b21170b210a121f0a121f0a121f0b121f0b121e0b111d0a101c0e131e0f121d0f111c0b0c180e0d19110f1b120e1c231e2c1a1423181121140d1e140b1e150b1e160b1f160b20170b20170b200a111e0a111e0a111e0a111e0b101d0b101d0b0f1914161f13151c13151b11121814141a13121913121912101914121a16131c100d19110b1b110b1b120b1c120b1c120a1c120a1c070c18060c18070c18070c17060b17060a16070a15070a140a0b161d1e2615161f13141c13141c0f0f181111190e0d170908120908130a08140a07140a07140a07140a07140a0714070d19080d19080d18070d18080c18080c17070b17070a16090b1711141f13131f0f0f1a0f0f1a13131e0d0e190c0c17080814080814090814090814090714090714090713090712080d19080d19080d19090d19090d18080c18080c18090b17080b1707091511111d0e0e1a0d0d1a141520090915080814080915080814080814080814080813070812070712070711';

// Lift dark maps / drop light maps by this much so the starting noise contrasts
// with the page it dissolves over (else the dots blend into the matching theme).
const BRIGHTNESS_SHIFT = 25;

const HOME_LIGHT_MAP = parseHexMap(HOME_LIGHT_HEX, -BRIGHTNESS_SHIFT);
const HOME_DARK_MAP = parseHexMap(HOME_DARK_HEX, BRIGHTNESS_SHIFT);
const DETAILS_LIGHT_MAP = parseHexMap(DETAILS_LIGHT_HEX, -BRIGHTNESS_SHIFT);
const DETAILS_DARK_MAP = parseHexMap(DETAILS_DARK_HEX, BRIGHTNESS_SHIFT);
const SEARCH_LIGHT_MAP = parseHexMap(SEARCH_LIGHT_HEX, -BRIGHTNESS_SHIFT);
const SEARCH_DARK_MAP = parseHexMap(SEARCH_DARK_HEX, BRIGHTNESS_SHIFT);
const MOBILE_LIGHT_MAP = parseHexMap(MOBILE_LIGHT_HEX, -BRIGHTNESS_SHIFT);
const MOBILE_DARK_MAP = parseHexMap(MOBILE_DARK_HEX, BRIGHTNESS_SHIFT);

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

/** Eased [0,1] transition progress at `elapsed` ms (linear time mapped through EASING). */
function easedProgress(elapsed: number): number {
  return EASING(clamp01(elapsed / TOTAL_MS));
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
const RING_SPACING = 30.0; // ring period in cells (larger = fewer, more spaced-out rings)
const RING_SPEED = 8.0; // outward pulse speed across the transition (lower = calmer)
const RING_THRESHOLD = 0.78; // higher = thinner rings / fewer accent dots
const RING_OFFSET = -0.6; // morph offset for ring dots: negative trails old colours, positive previews new

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
  let col = select(pageColor, accent, ring > RING_THRESHOLD && u.ripple > 0.5);

  let a = select(0.0, 1.0, on);
  return vec4f(col * a, a);
}
`;

// Uniform Float32 layout: resolution vec2 | origin vec2 | progress | cell | ripple.
const PROGRESS_IDX = 4;

/** Upload a colour matrix (MAP_COLS×MAP_ROWS) as an RGBA8 texture so the sampler can bilinear-filter it in hardware. */
function makeMatrixTexture(device: GPUDevice, map: number[][]): GPUTexture {
  const texture = device.createTexture({
    size: { width: MAP_COLS, height: MAP_ROWS },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const data = new Uint8Array(MAP_N * 4);
  for (let i = 0; i < MAP_N; i++) {
    const c = map[i];
    data[i * 4] = c[0];
    data[i * 4 + 1] = c[1];
    data[i * 4 + 2] = c[2];
    data[i * 4 + 3] = 255;
  }
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: MAP_COLS * 4, rowsPerImage: MAP_ROWS },
    { width: MAP_COLS, height: MAP_ROWS },
  );
  return texture;
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
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const srcTexture = makeMatrixTexture(device, srcMap);
    const tgtTexture = makeMatrixTexture(device, tgtMap);
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: srcTexture.createView() },
        { binding: 2, resource: tgtTexture.createView() },
        { binding: 3, resource: sampler },
      ],
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

  const [ox, oy] = rippleOrigin();
  const reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches;
  const data = new Float32Array(8);
  data[0] = canvas.width;
  data[1] = canvas.height;
  data[2] = ox * dpr;
  data[3] = oy * dpr;
  data[5] = cellSizeCss() * dpr;
  data[6] = reducedMotion ? 0 : 1; // disable the ripple rings for reduced-motion users

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
    const p = easedProgress(elapsed);
    if (!swapped && p >= SWAP_AT) {
      swap();
      swapped = true;
    }
    data[PROGRESS_IDX] = p;
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

  const cell = Math.max(
    cellSizeCss(),
    Math.round(Math.sqrt((w * h) / MAX_CELLS)),
  );
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
    const p = easedProgress(elapsed);
    if (!swapped && p >= SWAP_AT) {
      swap();
      swapped = true;
    }
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
  // Pick the colour set for the current view: company details, the home page
  // with an active search (results), the mobile home, or the desktop home.
  const path = window.location.pathname;
  const hasSearch =
    path === '/' &&
    (new URLSearchParams(window.location.search).get('search') ?? '').trim()
      .length > 0;
  let lightMap = HOME_LIGHT_MAP;
  let darkMap = HOME_DARK_MAP;
  if (path.startsWith('/company/')) {
    lightMap = DETAILS_LIGHT_MAP;
    darkMap = DETAILS_DARK_MAP;
  } else if (hasSearch) {
    lightMap = SEARCH_LIGHT_MAP;
    darkMap = SEARCH_DARK_MAP;
  } else if (path === '/' && window.innerWidth < MOBILE_BREAKPOINT) {
    lightMap = MOBILE_LIGHT_MAP;
    darkMap = MOBILE_DARK_MAP;
  }
  const sourceIsDark = document.documentElement.classList.contains('dark');
  const srcMap = sourceIsDark ? darkMap : lightMap;
  const tgtMap = sourceIsDark ? lightMap : darkMap;

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
