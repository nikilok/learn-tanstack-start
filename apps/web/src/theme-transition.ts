/**
 * "Patronus bloom" theme transition between two colour matrices. A full-screen
 * overlay runs a granular dither in three windows over one progress timeline:
 *
 *   1. fill  (0   – 0.3): dots scatter in.
 *   2. cover (0.3 – 0.7): fully covered; the light/dark class swap happens here
 *                         (hidden), at 0.5.
 *   3. clear (0.7 – 1  ): dots scatter away, revealing the new (target) page.
 *
 * Under that envelope the WebGPU path recolours the dots as a radial bloom of
 * silvery-blue light — spreading out of the footer skyline's sun to go light, and
 * receding into its moon to go dark — with a wispy turbulent front and sparkles.
 * The dot colours come from per-theme matrices sampled from screenshots of the
 * real pages (downsampled to MAP_COLS×MAP_ROWS, sampled bilinearly per dot), so
 * the field starts off in the page's actual colours. Sets for the home page
 * (desktop + mobile layouts), the home with an active search (results), company
 * details, and /download — chosen by route, search param, and viewport width at
 * toggle, then warped onto the live layout via the sampled anchors.
 *
 * The bloom is WebGPU-only. Where WebGPU is unavailable — or its init fails, or
 * the user prefers reduced motion — the theme just swaps instantly with no
 * dither: a plain grain without the bloom reads as a glitch rather than an effect,
 * and an animated grain dissolve is itself the motion `prefers-reduced-motion`
 * opts out of. So there's deliberately no canvas-2D fallback and no reduced-motion
 * dither; the bloom (below) only ever runs at full motion.
 */

import { measureAnchors, type PageAnchors } from './measure-anchors';
import WGSL from './theme-transition.wgsl?raw';
import { isDetailsPath, prefersReducedMotion } from './utils';

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

// Single progress timeline; the hidden swap point within it. The fill/cover/clear
// windows themselves live in the WGSL shader (the only path that dithers).
const TOTAL_MS = 1000;
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
// (see cellSizeCss). Passed to the WGSL shader as the dither cell size.
const CELL_CSS_DESKTOP = 0.65;
const CELL_CSS_MOBILE = 1;
// Below this viewport width the home page uses its mobile (portrait) layout.
const MOBILE_BREAKPOINT = 640;

/** Dot edge in CSS px for the current viewport (smaller on the mobile layout). */
function cellSizeCss(): number {
  return window.innerWidth < MOBILE_BREAKPOINT
    ? CELL_CSS_MOBILE
    : CELL_CSS_DESKTOP;
}

/** Viewport point (CSS px) the light blooms from: the footer skyline's sun/moon, else top-centre. */
function sunOrigin(): [number, number] {
  const el = document.querySelector<SVGSVGElement>('[data-london-skyline]');
  const r = el?.getBoundingClientRect();
  if (el && r && r.width > 0) {
    // LondonSkyline owns the geometry: read its own viewBox and the sun/moon centre
    // it stamps as data-sun-x/y, then map linearly (h-auto makes the rect match the
    // viewBox aspect, so there's no preserveAspectRatio letterboxing to correct for).
    const vb = el.viewBox.baseVal;
    const sunX = Number(el.dataset.sunX);
    const sunY = Number(el.dataset.sunY);
    return [
      r.left + (sunX / vb.width) * r.width,
      r.top + (sunY / vb.height) * r.height,
    ];
  }
  return [window.innerWidth / 2, 0];
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
  'fcfcfef7f6faf5f6faf9f7f9fbfbfdfafcfefafcfefafcfefafbfefafbfefafbfefafbfefafbfefafbfefafbfefafcfefafcfefbfcfef8f9fbdbdbdde7e8eafbfcfdfbfbfdfcfcfefcfdfee8e7ede3e5ecf0e4eaf7f5f9fafcfefafbfef9fbfef9fbfef9fbfef9fafef9fafef9fbfef9fbfef9fbfef9fbfefafbfefcfdfeedeef17d7d7eacadaef9f9fbf5f6f7fbfcfdf1f3f8f1f4faf0f3faedf2faebf0f8eaeff8eaeff9e8eef9e8edf9e6ecf8e6ecf8e7ecf8e7ecf7e7edf8e8edf7e9edf7e9eff8eaeff8ecf0f9f0f4fdeff3fbeef0f8eff1f9f0f1f8f3f3f8f1f2f8f0f2f8eef1f8edf0f8e8ecf5dee2ecdce0eae0e3efe7ebf7e7ebf7e7eaf6e7eaf6e8ebf6e8ebf6e8ecf6e9ebf6e9ecf6eaedf6ebedf7ecedf7ededf7eeeef7efeef6f4f4f8f4f4f8f4f4f8f3f3f8f2f3f8f1f2f8f4f4f7f1f2f5f6f7f9f8f9fcf8f9fcf8f9fcf8f8fcf9fafcf9f9fcf8f9fcf9f9fcf6f7faeeedf6edebf5eeecf6efecf6efecf6efebf6f4f4f8f4f4f8f4f4f8f4f4f8f4f4f8f5f5f8f7f6f9f5f5f8f7f7faf9f8fbf8f7faf9f8fbf8f6faf7f5f9f7f5f9f6f4f8f6f4f9f5f2f8efebf4eeeaf4eee9f5ede9f5ede9f5ede8f5f1f2f8f2f3f8f2f3f8f2f3f8f3f4f8f4f4f8f4f4f8f4f3f8f3f2f8f3f2f7f2f1f7efecf3efecf4f1edf6efeaf4eee9f3ede8f3ede8f3ede7f3ece7f3ebe6f4ebe5f4ebe5f5ebe5f5eef1f8eef1f8eff1f8eff1f8f0f2f8f1f3f8f3f3f8f4f4f8f4f3f8f6f6fac3c2c699979b929095c7c4ccf0ebf6eee9f3ede8f3ece7f3ebe5f2eae4f3e9e3f4e9e2f4e3dcefe2dbedebeff7eceff8eceff8edf0f8edf0f8eef1f8eff1f8f1f2f8f2f3f8f2f2f7d4d4d9ceccd3cfccd4d7d5ddede9f3ede8f3ece7f3ebe5f2eae4f3e9e2f3e8e0f3eae2f7c3bccebab2c4e8edf7e8eef7e8edf7e8eef7e8eef7e9eef7eaeff7ebeff8ecf0f8eef1f8eff1f8efeff8ededf7ecebf5ebe8f4e9e7f4e8e5f4e8e3f3e7e2f3e6e0f3e5dff3e5def3e3dbf1e3daf1e2eaf8e2eaf8e2eaf8e2eaf8e3ebf8e4ebf8e5ecf8e6edf7e8eef8e5eaf5dce2f2e1e6f5e5e8f5d9def1dbdef2e7e6f5e6e4f5e5e3f4e4e2f4e4e1f4e4e0f4e3dff3e4def4e4def4dce7f8dbe7f8dce7f8dce7f8dde8f8dee8f8dfe9f8e1eaf8e3ecf9dee3ecd6dce6d5dbe7ced5e5ced6e9d8dff0e4e6f7e3e5f6e3e4f5e2e2f5e2e2f4e2e1f4e2e0f4e3e0f4e3e0f4dde8f8dde8f8dde9f8dee9f8dfeaf8e0eaf8e1ebf8e2ebf9e4ecfae2e8f1dfe5eae1e2e4e3e6eadfe5ecdce4f1e7eaf8e6e9f7e6e9f7e6e8f7e6e7f6e6e7f6e6e7f6e7e7f6e7e7f6e9f1fbe9f1fce9f1fbeaf1fbeaf1fbebf2fbecf2fbedf3fbedf3fceff4fdecf1f8e4e8eee8ebf1eef2f8f1f5fcf0f3fbf0f3fbf0f3fbf0f3fbf0f3fbf0f2fbf1f3fbf1f3fbf1f3fbe7f0fce8f0fce8f0fce8f0fce9f0fce9f1fceaf1fcebf2fcebf2fcecf3fcebf1fae4e9f1e4e9f1edf2faeff4fceef4fceff3fceff3fceff3fceff3fbeff3fbf0f3fbf0f3fbf1f3fbe8effce8f0fbe8f0fce8f0fbe8f0fbe8f0fbe9f0fbe9f1fbeaf1fbebf2fbebf2fce8eef7e7edf6edf3fcedf3fcedf3fcedf3fceef3fceef4fceff4fbeff4fceff4fbf0f4fbf0f4fb';
const HOME_DARK_HEX =
  '0a0b0b1010110f10120f0e0f0b0b0c0a0b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0c0a0b0c0a0b0c0d0e0f2a2b2c1e1f1f090a0b0b0c0d0a0b0b090a0a211f2120212421181a100f10090b0c0a0b0d0a0b0d0a0b0e0a0c0e0a0b0d0b0c0e0a0b0e0a0b0e0a0b0d0a0b0d0a0b0d090a0b1718198788885859590a0b0b0f11110b0c0c0a0c0e090b0d080b0e080d100b0e130b0f140b0f150c0f170b10170d11190d11190d11180e11190d10170d10170d10160b0f150b0f140a0e13060a0e080b0f0b0d110b0c100b0c0f0a0a0b0a0b0c0a0b0d0a0c0e0a0c100e1015181a20191c2216181f0e10170f11181011191011181011171011160e10150e10150d0f140c0e130c0d120c0d120d0c120d0c100d0b0f0a0a0a0a0a0a0a0a0a0a0a0b0a0b0c0b0c0e0f10111212140e0e0f0c0c0e0c0c0e0c0c0d0e0d0f0b0c0d0c0c0e0c0c0e0b0c0d0e0e0f100e120f0d130e0c120f0c120f0c120f0b120a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0c0c0c0e0e0e0d0c0d0c0b0b0e0c0d0c0b0b0f0c0e100d0f0e0c0e110e100f0c0f100d10120e13110d14110c14100c14100b15100b150a0b0c0a0b0c0a0b0b0a0b0b0a0a0b0a0a0a0a0a0a0a0a0b0c0b0c0d0c0d0e0c0e141013140f13120c11150f14140f15150f16150f16140e16140e17130d17120c18120c18120c180a0c0e0a0c0e0a0c0e0a0c0d0a0b0d0a0b0c0a0a0b0a0a0b0b0a0b0908093e3d3e6a686a716e713c383c120d13150f16150f16150e17160f18150e19150e1b150e1c140d1c140d1b0a0d100a0d100a0d100a0d0f0a0c0f0a0c0e0a0b0d0a0b0c0a0a0b0c0b0c292829302e31302d31272429140f16140e16150e17160f18160f1a160f1b160f1d160e1e17101e170f1e0a0e130a0e130a0e130b0e130b0e130b0e120b0d110b0d100b0c0f0c0c0e0c0b0e0d0b100f0c12110d14130e17140e18150f19160f1a160f1c17101d170f1f170f20170e20170e200a0f170b10170b0f170b0f170b0f170c0f160c0f150c0e140c0e130d0e130e0e120f0e141311181b1820110d17130f19140f1b15101c16101d16101e16101f171020160f20160e1f0b111c0b121c0c111c0c111c0c111b0c111a0c10190d0f180d0f160f111814151b12111814131b17161e13101a120f1a130f1b14101d15101e15101e15101f150f1f150f1f150e1e0c121c0c121c0d121c0d121c0d121b0d111a0d111a0e10190e10170f101716161b151519161519141319121119100e18110f19120f1a120f1a130f1a130f1a130f1a130f1a120e1a0b0f160b0f160c0f160c0f150c0f150c0e140c0e140c0e140c0e130c0d121111161b1b1e1515191010140c0c110d0d120d0d120e0d120e0d130e0d130e0d130e0c130e0c130e0c120c10180c10170c10170c0f170c0f160c0f160d0f150d0e150d0e150d0e140e0f1516171c16161b0e0e130d0d120d0d120d0d120d0d120d0d120d0d130d0d120d0d120d0c120d0c110c0f170c10170c0f170c0f170c0f170d0f160d0f160d0f150d0e150d0e150d0e141011161212180d0d130d0d130d0d130d0d130d0d120d0d120c0d110c0c110c0c110c0c110c0c10';

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
  'fcfdfef7f7faf5f6faf9f7f9fbfbfdfafcfefafcfefafcfefafbfefafbfefafbfef9fbfef9fbfefafbfefafbfefafcfefafcfefbfcfef7f9fbdbdbdde7e8eafbfcfdfbfbfdfcfcfefcfdfee8e6ede2e5ecf0e4eaf7f5f9fafcfef9fbfef9fbfef9fbfef9fbfef9fbfef9fafef9fbfef9fbfef9fbfef9fbfef9fbfefbfdfeedeef17d7d7eacadaef8f9fbf5f5f7fbfbfdeef1f8eef2f9edf2faeaf1fae8eff8e7eef8e5edf9e4ecf9e3ecf9e2ebf9e2ebf9e2ebf9e1eaf9e2ebf9e2ebf9e3ecf9e4ecf9e5edf8e8eef9edf3fdedf2fbebf0f8edf1f9eef1f8edf0f7ebeff8eaeef7e8eef7e7edf7e7edf7e8ecf3e7ecf2eaeff6edf1f9ecf1f9ecf1f9ecf0f8ebf0f7ebf0f8ecf0f7ecf0f7ecf1f7e7edf7e7edf8e9eef7eaeef7ebeff8edf0f7eff1f8eef1f8ecf0f8eaeff8e9eef8ebeff8dddee0d4d5d6e1e1e3ecedeeecedeeededeff1f2f3f6f7f8f6f7f8f6f7f8f6f7f8f5f6f8eaeff7e9eef8eaeef7ebeef7edeff7eef0f7f1f2f8f0f2f8eef1f8edf0f8ebeff8ecf0f8e7e8eae0e0e2dfe0e2dfe0e2e6e7e9f1f2f4f4f5f7f6f7f9f5f6f8f6f7f9f6f7f9f5f6f8ebeef7eaedf7ebedf7eceef7eeeef7efeff7f3f4f8f2f3f8f1f2f8eff1f8eef1f8eef1f8e8e9ebeeeff0f3f4f6e8ebecf0f1f3f5f6f8e8e9ebebeceef3f4f6e8e9ebedeef0f1f2f4eceef7ebecf7ecedf7ededf7efeef7f1eff7f4f4f8f4f4f8f3f3f8f2f3f8f0f2f8f0f2f7eff0f2f3f4f6f5f6f8eef1f2f1f4f5f4f5f7edeef1edeef0f2f3f5e2e3e5ebeceef0f1f4ededf6ececf6edecf6efedf7eae7f1e9e6eff4f4f8f4f4f8f4f4f8f4f4f8f3f4f8f2f3f8f2f3f6f1f2f6f3f4f8f1f2f6f0f2f6f2f4f8f1f2f6f0f1f6f1f2f7eff0f6f0f0f6f1f1f7edecf6eeebf6eeebf6f2eff9cac7d0c0bec6f4f4f8f4f4f8f4f4f8f4f4f8f4f4f8f5f5f9ececeee5e5e7f3f3f6eff0f2f5f6f8f9f9fce8e9ebe5e5e8f0f0f4e5e4e8ededf1f7f6fbefecf6eeeaf6eeeaf5eeeaf5ece8f4ece7f3f4f4f8f4f4f8f4f4f8f4f4f8f4f4f8f5f5f9ebebede7e7e9f7f7f9fbfbfdfbfbfdfbfbfdf9f9fbf8f8fbf8f7fbf8f6fbf7f6fbf6f5faefebf6ede9f5ede9f5ede8f5ede8f5ede8f5f2f3f8f2f3f8f3f3f8f3f4f8f4f4f8f5f5f9eeeef0e7e7e9f0f0f2f4f4f6f3f3f5f3f3f6f9f9fcf9f8fcf9f7fcf8f7fcf8f6fcf7f4fbeeeaf5ede8f5ece7f5ece6f4ebe6f5ebe5f4f0f2f8f1f2f8f1f2f8f1f3f8f3f3f8f1f2f6ebebebeaeae9e9e9e8ebebeae7e9e7e2e5e3eaeaeaeeeeededededececedefeeefefefefece8f3ece6f5ebe5f5ebe4f5eae4f5eae3f5eff1f8eff1f8eff1f8f0f2f8f1f3f8eff0f4e5e6e4e2e2dfe6e7e4e4e5e2e2e3e0e1e3dfe6e7e4e8e9e6e9e9e7e9eae7e9eae7e7e8e5eae6f1ebe5f5eae4f5eae3f4e9e2f4e9e1f4edf0f8edf0f8eef0f8eef1f8f0f2f8eef0f4e2e3e1e1e2dfe4e4e1dfe0dde4e5e4e3e1e0e3e1e0eaebe9e8e9e7e8e9e6e8e8e5e7e7e5eae5f2eae4f5e9e2f4e9e1f4e8e0f4e7dff4eceff7eceff7eceff7edf0f7eef1f8edeff4e4e5e3e7e7e4e7e7e4e6e6e3e8e9e6d5d6d4dadad8e4e5e2ebece9e5e6e3e5e6e3eaeae8e9e4f1eae3f5e8e1f4e7dff3e7def3e6ddf3';
const DETAILS_DARK_HEX =
  '0a0b0b1010120f10120f0e0f0b0b0c0a0b0c0a0b0c0a0b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0c0a0b0c0d0e0f2a2b2c1e1e1f090a0b0b0c0d0a0b0b090a0a211f2220212421181a100f10090b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0e0a0b0e0a0b0e0a0b0e0a0b0d0a0b0d0a0b0d090a0b17181987888858595a0a0b0c0f11110b0c0c0a0d10090c10080c11080e130a0f15090f15080f15090f16091017091017091018091018091118091018091017091017090f16090f15090e14050a10070c110a0e130a0d110a0d100a0c0f0a0d110a0e120a0e130a0f140b1018161927171b291518261215241216251216251316251317261316251316251316251316240b10180a0f140a0e130a0e120a0d110a0c0f0a0c0e0a0c0f0a0d100a0e120a0e120c10173131433a3a4c2f2e412424372424372423371f1f331a1a2e1b1a2f1b1a2f1b1a2f1b1a2f0d11190a0e130a0e120b0d110b0d100b0c0f0a0b0c0a0c0d0a0c0f0a0d100a0d100c0f162525362c2c3d2c2c3d2c2c3e2727391e1e321b1b2f19192d1a1a2e19192d19192d1a1a2e0e11180b0d120c0d130c0d120c0c110c0b0f0a0a0a0a0b0b0a0b0d0a0c0e0a0c0e0c0e142525372020341c1c302125351d1f311a1a2e2626382323361c1c302626392222351d1d310f10180c0d120d0d130d0c110d0c100d0b0f0a0a0a0a0a0a0a0a0b0a0b0c0a0b0c0d0e121e1e301b1b2e19192d1a1f2f1a1c2e19192d2020332020331b1b2f2b2b3d2222351d1d300f0f170d0c120e0c120e0c110e0c110e0b110a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0c0c0d14151915161a13141815161a15161b13151914161a15161b15161b16161d16161d15141c100e140e0c120f0c120f0b12110e14110e140a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0b0b2020202727271a1b1b1d1d1e1718181415152324242727281d1c1e28272a201f2217151a110e140f0c13100c13100b140f0b140f0b130a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0b0b22222225252517171613131313131313131415151616151716151817151917151a18161c110e150f0b14100b15100b15110c16100b150a0a0b0a0b0b0a0a0b0a0a0b0a0a0a0b0b0b1e1e1e2323231b1b1b18181819191919181915141515131615131716141917141b17141c110d16100b15110c16110c17120c17120c170a0b0c0a0b0c0a0b0c0a0b0c090a0b0f100f2627252f302f2f302e2e2e2d2e2f2e3536343031302b2b2b2d2d2e302f302d2c2d2b2a2c16121b110b16120c18120c19130c19130c190a0c0e0a0c0e0a0c0d0a0b0d090a0b1011112d2e2c40413f393a383c3d3b3f403e40403e3b3c3a3a3b393e3e3d3b3b393a3b393a3a3919141d110b17130c19130c1a140d1b140c1b0a0c0f0a0c0f0a0c0e0a0c0e090b0d1112133839373b3c393a3b383d3e3b4648454d4847474141393a393839383838373b3b3a3b3b3a18131d120b18140d1b140d1c150d1d150d1d0a0c100a0c100a0c0f0a0c0f090b0d1113143738363a3b383a3b39393a383839375656544f4f4e363734373735393a373b3c3a39393819131e120b19140c1b150d1d160d1e160d1f';

// Home page with an active search (results list) — spliced from screenshots 5/6.
const SEARCH_LIGHT_HEX =
  'fcfdfef7f7faf5f6faf9f7f9fbfbfdfbfcfefafcfefafcfefafcfefafbfefafbfef9fbfefafbfefafbfefafbfefafcfefafcfefbfcfef8f9fbdbdbdde7e8eafbfcfdfbfbfdfcfcfefcfdfee8e6ede3e5ecf0e4eaf7f5f9fafcfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfefbfdfeedeef17d7d7eacadaef9f9fbf5f5f7fbfcfdeef1f8eff2faeef2faebf2fae9eff8e8eef8e8eef9e6eef9e5edf9e4ecf9e4ecf9e4ecf9e4ecf9e4ecf9e4ecf9e5edf8e6edf8e7eef8e9eff9eef4fdeef3fbecf0f8eef1f9eff2f8eff1f8edf0f8ebeff7eaeef7e9eef8e5ebf5dbe1ecd8dee9dce3eee5ebf5dbe2efe0e7f3dfe6f2e0e7f4e3ebf7e4ebf7e4ecf7e6ecf7e8edf7e9eef8eaeef7ebeef7eceff7eef0f7f2f2f8f0f2f8eef1f8edf0f8ebeff8ebeff7eef0f3f6f8fbf7f8fbf7f9fcf6f8fbf7f9fcf6f8fcf7f9fcf7f9fcf7f9fcf8f9fcf6f7faebeff7eaedf7ebedf7eceef7eeeef7efeff7f4f4f8f3f3f8f1f3f8f0f2f8eff1f8eff2f9f1f4f7f5f7fbf5f6fbf4f6fbf4f6fbf4f6fbf4f6fbf4f6fbf4f6fbf3f5faf4f5faf3f4f9ecedf7ebecf7ececf6eeedf6efedf6f0eef6f4f4f8f4f4f8f4f4f8f3f4f8f3f4f9e9e7efe9e2eaeef1f8edf0f7eceff7eceff7ebeff7ebeff7ebeff7ebeef7ebedf7ebecf6ebebf6ececf6edecf6eeecf6eeecf6efecf6efecf6f4f4f8f4f4f8f4f4f8f4f4f8f4f5f8eeecf3e8e4eaebecf0eaebefe7ebeee9ebefeaebf0e6e8eceaebf1efeff7eeeef7eeedf6eeecf6eeebf6eeebf6eeeaf5efebf6e9e5f0e7e3eef3f4f8f4f4f8f4f4f8f4f4f8f4f4f8f2f2f8e4e4e9e1e1e4e6e7eaf4f3f8f3f3f7f2f3f7f1f1f7f1f0f7f0eff7efedf6eeecf6eeebf6eeeaf5ede9f5ede8f5f0ebf8c8c4cfbfbbc5f1f2f8f2f3f8f2f3f8f2f3f8f3f4f8f3f2f8e7e7ece5e5e9e7eaecececf0ececf0e9eaeee9e9eef0eff7f0edf6eeecf6eeebf6edeaf5ede8f5ece7f5ebe6f5ebe5f5eae4f3e9e3f3eff1f8f0f2f8f0f2f8f1f2f8f1f3f8f1f1f7e2e2e6dfdfe3dfe0e3e3e3e6f2f2f6f1f0f6f1f0f7f0eef7efecf6eeebf6eeeaf5ede8f5ece7f5ebe5f5eae4f5eae3f5eae3f5e9e2f5edf0f8eef0f8eef1f8eff1f8f0f2f8f0f0f7e8e8ede7e7ebe7eaece8e8ecececf0e8e8ededecf3f0eef7efecf6eeeaf6ede9f5ece7f5ebe5f5eae4f5e9e2f4e8e1f4e8e0f4e8e0f4ebeff7eceff8ecf0f8edf0f8eef1f8eeeff6dcdde3d9dadedcdce0ededf1f4f4f9f2f1f8f0eff7efedf6eeebf6eeeaf6ede8f5ece6f5ebe5f5e9e3f4e9e1f4e7dff4e7def3e6ddf3e9eef7eaeef7eaeef8eaeef8eaeff8ebedf6dfe1e8dcdfe5dde3e7e5e6ece8e9efe6e6ece4e5ece6e6ede5e5ede4e3ebe3e2ebe7e4f2e9e3f5e8e2f4e7e0f4e6def3e6ddf3e5dbf2e7edf7e6edf7e6edf7e6edf7e7edf8e8ecf5dce0e9dadee7dce0e8e8ecf3edeff7ecedf7ebecf6eaebf6e9e9f5e8e7f5e8e5f5e7e4f5e6e2f5e6e1f4e5dff4e4def3e4ddf3e4dcf3e3eaf7e2eaf8e2eaf8e3ebf7e4ebf7e4eaf4d8dde6d4dae3d7dbe4e3e7f0ebeff8eaedf7eaebf6e9eaf6e8e8f6e7e6f6e6e4f5e5e3f5e5e2f5e4e1f5e4dff4e4def4e3ddf3e3ddf3';
const SEARCH_DARK_HEX =
  '0a0b0b1010120f10120f0e0f0b0b0c0a0b0c0a0b0c0a0b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0c0a0b0c0d0e0f2a2b2c1e1e1f090a0b0b0c0d0a0b0b090a0a211f2120212421181a100f10090b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d090a0b17181987888858595a0a0b0c0f11110b0c0c0a0d10090c0f080c10080e120a0f140a0f15090e15090f15090f160a10170910170910170a10180a1017091017091017090f160a0f15090e14060a10070b100a0e120a0d100a0d0f0a0c0e0a0d0f0a0d110a0e120a0e130d1117151b20181d2313181f0d121810171d0d131a0e141b0c121a0910170910170a10160a0f150a0f140a0e130a0e130a0d120a0d100a0c0f0a0b0c0a0c0d0a0c0e0a0d100a0d110b0e121315160c0d0f0c0d0f0b0d0e0b0d0f0b0d0e0b0d0f0b0c0e0b0c0e0b0c0e0a0c0d0c0d0f0b0e130b0e130c0d120c0d110c0c110c0b0f0a0a0a0a0a0b0a0b0c0a0b0d0a0c0e090c0e0d0f110b0c0d0b0c0e0b0c0e0b0c0e0b0c0e0b0c0e0b0c0e0b0c0e0b0d0f0b0c0f0d0d100d0d130d0d130d0d120d0c110d0c110d0b100a0a0a0a0a0a0a0a0a0a0a0b090a0a1614161a15170a0c0e0a0d0f0a0d0f0a0d100b0d100b0e100b0d100c0d110c0d120d0d120d0d130e0c120e0c120e0c120f0c120f0c120f0b120a0a0a0a0a0a0a0a0a0a0a0a0909091110111915171111121212131014131112131112131516161212130c0b0f0d0c100e0c110e0c120f0c120f0c130f0c130f0c14100c140f0b140a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0b0c1a1a1b1e1e1d1818180a0a0a0b0b0b0b0b0b0c0b0d0c0b0d0d0b0f0e0c100f0c120f0c13100c14100b14100b15100b15130e17120e160a0b0c0a0b0c0a0b0b0a0a0b0a0a0a0b0b0c1615161818181216141111111111111414141413150d0b0f0e0b100f0c12100c13100c14100b15110c16110c17120c18120c18120c180a0b0d0a0c0d0a0b0d0a0b0c0a0b0c0c0c0d1c1c1d1f1f1f1e1f1f1c1c1c0c0c0c0d0c0e0d0b0e0d0b0f0e0c110f0c13100c14100b15110c17120c18130c19130c1a130d1a130c1a0a0c0f0a0c0f0a0c0e0a0c0e0a0b0d0c0c0e141416151616121614161515121112151516100f120d0b100f0b12100c13100b14110b16120c18130c19140c1b140d1c150d1d150d1d0a0d100a0d100a0d100a0c0f0a0c0e0c0d0f1f202123242522222210101109090a0b0a0d0d0b0f0e0c110f0c130f0b14100b15110c17120c18130c1a140d1c150d1d160d1f160d1f0a0d120a0e120a0e120a0d120a0d110d0e11181a1d1b1c1f171b1b16161714131516161817161916151917151a18161b19161c140f1a130c1a140d1c150d1d160d1e170e20170e210a0e140b0f150b0f150b0f150b0e140e10141a1c201d1e221b1c201011140c0c100e0d120f0d140f0d15100d16110d17120e19130d1a140d1c150e1d150e1e160e1f170e20170e200a0e160a0f160a0e170a0f160b0e160d10151b1d231f21261e1f241314180c0c100e0c120e0d140f0c15100c17110d18110d19120d1b130e1c140e1d150e1e150e1f160e1f150d1f';

// Mobile (portrait) home, no search — spliced from screenshots 7/8.
const MOBILE_LIGHT_HEX =
  'fdfcfefcfdfef4f3f7f0f0f4f4f5f9f4f6f9f6f4f7f9f5f7f8f4f7fafbfdfbfcfefbfcfefbfcfefbfcfefbfbfef5f6f8fafcfefafcfef6f7f8fcfdfefafbfcf4f5f6fbfcfefdfdfef6f7fbf7f8fcebecf3e5e7efe9eef5e9eef5edecf4f1ecf3ebe9f1f1f4faf1f5fcf1f5fbf0f5fbf0f5fbf0f5fbe9edf3f0f4faf1f5faebeef3f4f6fbf1f3f9eaebf0f5f6fbf6f8fcf0f2f8e9ebf2e4e8efe4e9f1e5eaf3e4eaf3e0e6f0dee5efdee5f0dde4efe3eaf6e3eaf7e3ebf7e4ebf7e4ebf7e5ebf8e5ebf7e7ecf7e8edf8e8eaf6e9ebf6eceef8eceef7eeeef6f4f4f8f0f1f5edeef2edeef3edeff4eceef4eaecf2e8ebf1e8ebf2e9ecf3ecf0f8eef1f9eef1f9edf0f9edeff9eef0f9eef0f8eff0f8eeeef7efeff8f0eff7f0eff6f0edf5efecf5f3f3f8f7f7fafafafaf8f8f9f7f7f8f5f5f5f9f8f9f6f6f8f6f6f7fcfcfdfffffffffffffffffffffffffdfdfefbf9fdfaf8fbfaf9fcfbfafcfaf9fbf7f6f8f8f7f9f4f1f8ede9f4f2f3f8f2f3f8f3f3f8f3f4f8f4f4f8f4f4f8f3f3f8f4f4fae8e8eddddde1d3d3d8cecdd4d0ced4cfcdd4dfdbe4e5e0ebefebf6eee9f4ede7f2ece5f2ece6f4ece6f4ebe5f3ebe5f2eff1f8eff1f8eff1f8f0f2f8f0f2f8f1f2f8efeff5ebebefdbdbe0cbcad0c8c7ccc7c6cbc3c1c8c5c1cad0ccd5d9d6dfe5e0ebe9e3efece5f3ebe5f4eae3f3eae3f4eae3f5e9e1f4ebeff7eceff8eceff8ecf0f8edf0f8eef1f8eff1f8eff0f7f2f2f9f5f5faf5f4faf3f1faf2eff9f1eff9efecf7ede8f4ebe5f2ebe5f4eae4f4e9e2f3e6def0d6cee1d5cde1e4dbf1e7edf7e7edf7e7edf7e7edf7e8eef7e8eef7eaeef8ebeff8ecf0f8eef0f7eeeef7ededf7ececf6ebeaf5eae8f4eae7f5eae7f5e9e5f5e7e2f4e6e0f3d8d3e6938f9c918d9ad9d1e6e1e9f8e0e9f8e0e9f8e1eaf8e1eaf8e3ebf8dfe8f5e0e8f6e1e8f6e2e8f6e7ecf7e7ebf7e5e8f6e6e8f5e8e9f7e0e2f4dbddf3dcdcf3e0dff4e4e1f5e3e0f4e5e1f6e6e1f6e4dff4d9e5f7d9e5f7d9e5f7dae6f7dbe6f8dde8facfd3dad2dae8d5deedd6dfeed6dce6d6dae5cfd6e6d6deefd4d6e1d2daefcdd5ebc8d2e7dcdef3e2e2f5e2e1f5e2e1f5e2e1f5e3e1f5e3ecf9e3ecfae3edfae4edfae5edfae6eefaebeff4e3ebf2e6ebf1e5e9ede7e9ece6e8ebe7eaeeebeef3e6e8ece9ecf2e9ecf2eaeef5ebedf9ebedf9ebedf9ebedf9ecedf9ecedf9e8f0fbe8f1fce9f1fce9f1fceaf1fceaf2fcebf2fdedf4fddee3ecdde2eae0e6eee6ebf3e4e9f1e1e5ede6ebf3e4e8f0eff3fbf0f4fcf0f3fcf0f3fbf0f3fbf1f3fbf1f3fbf2f3fbe7f0fbe7f0fbe7f0fbe8f0fbe8f1fce7effae6eef9e7eff9eaf1fceaf1fbdce2eaeaf0f9eaeff8d9dfe7e9eff8edf2fbecf1faecf1f9eef3fbeff4fceff4fcf0f4fcf0f4fcf1f4fce8f0fbe8f0fbe8f0fbe8f0fbe8f1fce1e9f3dbe2ecdee5eee0e7f1dfe6f0e0e7f0e2e9f2e7eef7e3eaf3dfe6efe1e7f0e1e7f0e1e6efe7edf5eff4fdeff4fceff4fcf0f5fcf1f5fce9f1fce9f1fce9f1fce9f1fce9f1fce9f1fce9f1fce9f1fce9f1fbe9f1fce9f1fce9f1fbe8f0fbe9f1fceaf1fcebf2fcebf2fcecf3fcedf3fceef3fceef4fceff4fcf0f5fcf0f5fc';
const MOBILE_DARK_HEX =
  '0a0b0b090a0b141315171619111213101213121012120e0f130f100b0c0c0a0b0c0a0b0c0a0b0c0a0b0c0a0b0d0f10110a0b0c0b0b0c0f10110a0a0b0b0c0d1112120b0b0c0a0b0c0a0c0d090b0c1616191b1b201315191215191313171410141614180b0e110a0d110a0d110a0e120a0d120b0e111114180b0e120b0e111114170b0d100e0f121516180b0d0f0a0c0d0a0b0d0f11141215181014170e12160e121711161b12181d11171d11171e0b11180a10180a10180a10170b10170c10180c10180b0f160c0f150f10170e0f150b0d120d0d110f0e110a0a0a0e0e0f1112131012130f10120f11131113151214171214171113170c0f130b0e120b0e110c0e130e0f160d0e130c0e120d0e12110f150f0e120e0d12100e12130f13100d120a0a0a0b0b0b0c0c0c0e0d0d0f0f0f1111110d0d0d0f0f100f0f100a0a0a0707070807080807080707070909090e0c0e0f0d0f0d0c0d0c0b0d0d0b0d100e100e0d0f0f0c11110d140a0a0b0a0b0b0a0a0b0a0a0a0a0a0a0a0a0a0b0b0c0a090b1616172222232d2c2e333134302f31312e32241f251e1820110c13120d15170f18181019130d17130d17150f18160f190a0c0e0a0c0e0a0c0d0a0b0d0a0b0d0a0b0d0e0e0f1212132322233433353736373837393d3a3e3e393e312c322521281b151d1a121b150e18130d18150e1a18101c160f1c150d1c0a0d100a0d100a0d100a0d100a0c0f0a0c0f0b0c0e0d0d0f0b0b0d09080909080a0d0a0e0e0a100d090f100b12140e16160f18130d18140d19170f1b170f1d160f1d160e1e170e200a0e140a0e140b0e140b0e140b0e130b0e130c0e130c0d120c0d100d0d100f0d110f0d120f0d13110e15130e16120d17120d18140e1a160f1c150e1d140d1c1c172116111c160d1f0a10180b10180b10180b10180b10170c0f170c0f160d0f150d0e150f0f150e0d120f0e14110e16110f1715121c191620130f1a140f1c140e1c140e1e150e1e150e1e150e1f160e1f0c121d0c121e0c121e0c121d0d121c0d111b11141d14161f14161d11131a11121814131a14131a13111a1c1a231e1c2615121d17131f140f1d140f1e140f1e140f1e140f1e140f1e0c11190c11190c11190d10190d10180d10170f101616161c16171b17181c15151817171a161619131316151519141317141418110f15100e16100e16100e16100e16100d16100d160b0f170c0f170c0f170c0f160c0f160c0e150c0e150b0d131b1d221d1e241a1b2016161b17171c18181d13131816161b0e0d130d0c120d0c120d0c120d0c120d0c120d0c120d0c110c0f170c10180c10180c0f170d0f170e10180f11190f11180d0e150e0f151c1c220f0f151010161f1f241111160e0e130f0f140f0f140e0e130d0d120d0d120d0c110d0c110d0c110c0f170c0f170d0f170d0f170d0f1714161d1a1c23181a2117181f17181f17181e16161c11121815151b19191f17171d18181d18191e1313180d0d120d0d120d0d110c0c110c0c100c0f160d0f170d0f170d0f170d0f170d0f170e0f170e0f170e0f170e0f160e0f160f0f160f0f160f0f160e0e150e0e150e0e140e0e140d0e130d0d130d0d120d0d120d0d110c0c11';

// /download — dark hero panel with the desktop preview window. Neutral
// placeholder tones until sampled (scripts/sample-theme-matrices.ts).
const DOWNLOAD_LIGHT_HEX =
  'fcfdfef7f7faf5f6faf9f7f9fbfbfdfafcfefafcfefafcfefafcfefafbfefafbfef9fbfefafbfefafbfefafbfefafcfefafcfefbfcfef8f9fbdbdbdde7e8eafbfcfdfbfbfdfcfcfefcfdfee8e6ede2e5ecf0e4eaf7f5f9fafcfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfefbfdfeedeef17d7d7eacadaef8f9fbf5f5f7fbfbfdeef1f8eef2f9edf1f9eaf1f9e9eff9e7edf8e6edf8e4ecf8e3ecf8e3ebf8e3ebf9e3ebf9e2ebf9e3ebf9e3ecf9e4ecf9e5edf9e6edf8e8eff9edf3fdedf3fbebf0f8edf1f9eef1f8edf0f7ecf0f8e5e9f2c1c5cdbec3cbbdc2cbbac0c9bdc4cebbc2ccc2c9d5e0e9f6e1eaf8e1eaf8e1eaf8e2eaf8e3ebf7e3ebf7e5ecf7e6edf7e8eef8e9eef7eaeef7ebeff7edf0f7f0f1f8eef1f8ebeff7e1e5ede2e6efe0e5eedfe4eee3e8f2e8eef9e7eef9e6eefae4ecf7e4ecf7e4ecf7e5ecf7e6ecf7e6edf8e8eef8e8eef8e9eef8eaeef7ebeef7edeff7eef0f7f2f3f8f0f2f8f0f2f9e7e9e8dbdfdedaddddd6d7d7d5dcdfd6dde1d5dce0dddfe0e9eef7e6edf8e7edf7e7edf8e8edf8e8eef8e9eef7eaedf7eaedf7ebedf7ecedf7eeeef7efeff7f4f4f8f3f3f8f2f3f8d0cec9dce1e7dce2eadce1e8dde4eddfe7efdee5edc8c4c0e9edf5e9eef8e9eef8e9eef8e9eef7e9edf7eaedf7ebecf7ebecf7ececf6ededf6f0eef7f1eef7f4f4f8f4f4f8f4f5f9bbb9b8edeff4eae9f1ebecf3edf0f8edeff8eeedf6bdbab9ebeef4ecf0f8ecf0f8eceff7ebeef7ebedf7ececf6ececf6edecf6eeecf6efecf7eae7f1e8e5eff4f4f8f4f4f8f5f5f99d9d9becedf1ececf0eeeef2efedf4eeeaf5ece6f4999796ebedf2f0f2f8eff0f8eeeff7edeef7ededf7edecf6eeecf6eeebf6eeebf6f2eef9cac7d0c0bdc6f4f4f8f4f4f8f5f5f9949792e4e8f1e5e7eeeaebf1edebf5eae5f5e6def39e998eefeff2f2f3f8f1f1f7f0eff7f0eef7efedf6eeecf6eeebf6eeeaf5eeeaf5ede9f5ece8f4ebe7f3f3f3f8f3f4f8f4f5f9cacccae4e8eeebeef3eef0f4eff0f5efeff6eeecf7d4d3d0f2f2f5f3f2f8f1f0f7f0eff7efedf6eeebf6eeebf6eeeaf5ede9f5ede8f5ece7f5ece7f5ece7f5f1f2f8f1f3f8f3f4f9e6e6e9dddddfeff0f1eff0f1eff0f2eeeff1eff1f2f4f5f8f4f3f8f2f1f7f1eff7f0edf6efecf6eeebf6eeeaf5ede8f5ece7f5ece6f5ebe5f5ebe5f5ebe4f5f0f1f8f0f2f8f1f3f9e6e7e9d9dadcd8d9dbdcdddff1f2f3f1f2f4f2f3f5f3f4f6f3f3f8f2f0f7f0eef7efedf6eeebf6eeeaf5ede9f5ece7f5ebe6f5ebe4f5eae3f5eae3f5e9e2f4eef0f8eef1f8f5f8fd9d9d9f5c5c5c6161616e6f6feaebecf7f8faf5f6f8f5f6f8f3f2f7f1eff7f0eef7efecf6efebf5eee9f5ede8f5ece6f5ebe4f5eae3f5e9e2f4e8e1f4e8e0f4ecf0f8ecf0f8edf1f8ebedf3e6e8ede7e8edeaebeff3f4f7f4f4f8f4f4f8f3f4f7f2f1f7f1eff7f0edf6eeebf6eeeaf5ede9f5ece7f4ebe5f5eae3f5e9e2f4e8e0f4e7dff4e7def3ebeff7ebeff7ebeff7edf0f8eef1f8eff1f8f0f2f8f0f1f8f1f2f7f2f2f7f1f1f7f0eff6efedf6eeecf5edeaf5ede9f4ece7f5ebe6f4eae4f4e9e2f4e8e1f4e7dff3e6ddf3e5dcf3';
const DOWNLOAD_DARK_HEX =
  '0a0b0b1010120f10120f0e0f0b0b0c0a0b0c0a0b0c0a0b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0c0a0b0c0d0e0f2a2b2c1e1e1f090a0b0b0c0d0a0b0b090a0a211f2220212421181a100f10090b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0e0a0b0e0a0b0e0a0b0e0a0b0d0a0b0d0a0b0d090a0b17181987888858595a0a0b0c0f11110b0c0c0a0d10090c10090d11090e130a0f140a0f16090f160a10170a11180a11180a11190a11190a11190a11190910180a10180a10170a0f16090e14060a10070c110a0e130a0d110a0d100a0c0f090c100f131735383c373b3f373b40383c4233383e353b412d32390b1119091018091019091018091018091017090f17090f160a0f150a0f140a0e130a0e120a0d110a0c0f0a0b0d0a0c0f0b0e1114171a13161914171c15191e10151a0a0f150a10160a0f150a10160a10160a10160a10160a0f160a0f150a0f140a0e140a0e130b0e120b0d110b0d100b0c0f0a0b0c0a0b0d0b0c101c223320273a1b2133191d2d1a2133181d2f191c2e191c2d0d11180a0f140b0f150b0f140b0f140a0e130b0e130b0e130c0e130c0d130c0d120c0c110c0b0f0a0a0a0a0a0b0c0d0f1f2335141b25131a241218211018220d131d0f141d1f22310d10170a0e120a0e120b0e120b0e120b0e130c0e130c0d130d0d130d0d120d0c110d0c110d0b100a0a0a0a0a0a0c0c0e151723090d1212161c0e131a091016090f150a0f131d1f2c0e10160a0d0f0b0d100b0d110c0d120c0d120d0d130d0d130e0c120e0c120e0c120f0c110f0c110a0a0a0a0a0a0c0c0e12141b0a0c0f13181d12171c0d12170b0f140b0d1114161e0d0f130a0b0d0b0c0f0c0c100d0c110d0c110e0c120e0c120f0c120f0c130f0b13120e15110e140a0a0a0a0a0a0c0c0e0f12180809091316171215170a0d100b0c110d0c10181e200d0e110a0a0b0c0b0d0d0b0f0d0b100e0c110f0c120f0c13100c13100b14100b14100b14100b140a0a0b0a0a0a0c0c0e1b1d291a1a24161622161723151521141421151422191b280d0d110b0a0b0c0b0e0d0b0f0e0b110f0c120f0c13100c14100b15100c15110c16110c16110c160a0b0c0a0b0c0b0c0e2b2a3b313144202034201f332020342121342020341d1d300d0d110b0a0c0d0b0f0e0b100f0b120f0c13100b14100b15110c16110c17120c18120c18120c180a0b0d0a0b0d0b0c0f2525373232443333443030411e1e311d1d311d1d301c1c2e0e0d120c0a0d0d0b0f0e0b110f0c130f0b14100b15110c16120c18120c19130c1a130c1a130c1a0a0c0e0a0c0e06070c6d6d78acacb2a8a8ad9b9aa226263919192d1a1a2f1a1a2e0e0e120c0b0d0e0b100f0b120f0c13100b14110c16120c17120c19130c1a140d1b140d1c140d1c0a0c0f0a0d0f0a0c1014151d1a1b221a1b2118191f1011171010161010161010170d0c0f0d0b0f0e0b110f0c12100b14100b15110c16120c18130c1a140d1b150d1d160d1e160d1e0a0d100a0d100a0d10090c0f090b0d090b0c090a0b0a0b0c0a0a0b0a0a0a0b0a0b0d0b0e0e0c100f0c12100c13100c14110c16120c17130d19140d1a150d1c150d1d160d1f160d20';

// /download with the PWA "Install web app" card mounted (Chromium after
// beforeinstallprompt) — the extra card reshapes the card row. Neutral
// placeholder tones until sampled (scripts/sample-theme-matrices.ts).
const DOWNLOAD_INSTALL_LIGHT_HEX =
  'fcfdfef7f7faf5f6faf9f7f9fbfbfdfafcfefafcfefafcfefafbfefafbfefafbfef9fbfefafbfefafbfefafbfefafcfefafcfefbfcfef8f9fbdbdbdde7e8eafbfcfdfbfbfdfcfcfefcfdfee8e6ede2e5ecf0e4eaf7f5f9fafcfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfefbfdfeedeef17d7d7eacadaef8f9fbf5f5f7fbfbfdeef1f8eef2f9edf1f9eaf1f9e9eff9e7edf8e6edf8e4ecf8e3ecf8e3ebf8e3ebf9e2ebf9e2ebf9e3ebf9e3ecf9e4ecf9e5edf9e6edf8e8eff9edf3fdedf3fbebf0f8edf1f9eef1f8edf0f7ecf0f8e5e9f2c0c5cdbec3cbbdc2cbbac0c9bdc4cebbc2ccc2c9d5e0e9f6e1eaf8e1eaf8e1eaf8e2eaf8e2ebf7e3ebf7e4ecf7e6edf7e8eef8e9eef7eaeef7ebeff8edf0f7f0f1f8eef1f8ebeff7e1e5ede2e6efe0e5eedee4eee3e8f3e8eef9e7eef9e7eefae5edf9e4ecf7e6edf8e6edf8e7eef8e7eef8e8eff8e9eff8eaeff8eaeef8ebeef7edeff7eef0f7f2f3f8f0f2f8f0f2f9e6e9e8dbdfdddaddddd6d5d5d4dadcd5dcdfd5dbdfd5dadde3e5e8e8edf6dfe5f1e2e6f1e4e7f2e6e8f2e8e9f2eaeaf3ebeaf3eeedf4edeef7eeeef7efeff7f4f4f8f2f3f8f2f3f9d1cfc8dadfe3dae1e9dbdfe6d9e0e8dde5eddde5efd3d5d8d0cdc9e2e8f5ced4e8d4d7ead8daebdee0f1e1deeee5e0ede8e0ebede6edeeeef7efeef7f1eef7f4f4f8f4f4f8f5f5f9b8b6b5ebedf2ebebf3eaeaf1eef1f8eff1f9eff0fadbd9dec9c6c4e8ebf6d6d9eadcdcecdddae8d3a6abe7d7d8eae3edebe0e5eee6e8f0eef7eae7f1e8e5eff4f4f8f4f4f8f6f6fa9f9e9bebebeeedecf1e6e7eaededf3edeaf4f1ecf9ccc7d0ababa9eeeff9dddcece3e0eed9dbe38aa58aead8bfece1e8eddfdeefe5e3f3f0facac7d0c0bdc6f4f4f8f4f4f8f6f6fa888b89e1e5ece9eaf1e3e5e9ececf3ece8f4ede6f9c5bdc9a9a69bf2f1fae3deede8e1edeae1eae6dfdcece0dfeddfdbeeddd5f0e4ddefebf6ece8f4ebe7f3f3f3f8f3f4f8f5f5faa9aba4e0e6f0e4e9f2e2e6ede9ebf2e8e7f2eae7f8d1cdd5c0beb3f4f3faebe5efece5ebede4e7efe4e5efe3e0f0e3dcf1e1d7f2e6dfede9f6ece7f5ece7f5f2f2f8f2f3f8f3f4f9e1e2e4dddfe1f3f5f7f3f5f7f3f4f6f3f4f6f3f4f6f3f4f6f4f5f8e7e8eae8e9eaf5f6f8f4f4f6f3f4f6f3f4f5f3f4f6f3f4f6f3f4f7ece7f5ebe5f5ebe5f5f0f2f8f0f2f8f1f3f8efeff2e9eaececedeff1f2f4eeeff1ecedefeeeff0edeeeff4f5f8eff0f3ebeceeecedefe7e8eaeaebedecedefedeef0edeef0f2f3f6ebe6f5eae3f5eae3f4eef1f8eef1f8f4f6fcb4b4b6828383868687929293eeeff0f7f8faf6f7f9f6f7f9f8f9fccecfd1848485838384bbbbbdfafbfcf6f7f9f6f7f9f6f7f9f5f6f8eae4f5e9e1f4e8e1f4edf0f7edf0f8f1f4fac5c6caa2a3a5a4a5a8adadb0eeeff2f5f6f9f5f5f8f4f5f8f6f6fad9d8dca3a3a5a2a2a5cbcbcef6f6faf3f2f7f2f2f7f2f1f7f1f0f7e9e2f4e7dff4e7dff3ebeef7ebeff7eceff7f1f4fcf5f8fff6f9fff6f8fef1f2f8f2f2f8f3f3f8f2f1f7f1eff7f2f1f9f6f4fef6f2fdf1edf9ece7f4ebe5f4eae4f5e9e2f4e8e0f4e7dff3e6ddf3e5dcf2';
const DOWNLOAD_INSTALL_DARK_HEX =
  '0a0b0b1010120f10120f0e0f0b0b0c0a0b0c0a0b0c0a0b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0c0a0b0c0d0e0f2a2b2c1e1e1f090a0b0b0c0d0a0b0b090a0a211f2120212421181a100f10090b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d090a0b17181987888858595a0a0b0c0f11110b0c0c0a0d0f090c0f090c10090e120a0f140b0f150a0f150a0f160a10170a10170a10170a10170a10170a10170910160a0f160a0f150a0f15090e14060a0f070b100a0e110a0d100a0c0f0a0b0d090b0e0f121535383b373a3e373a3e383c4034383d363a3f2d32370b11170a0f160a10160a10160a0f160a0f150a0f150a0f140a0e140a0e130b0d120b0d120b0c100b0c0f0a0a0b0a0b0c0b0c0e15161814161814171a16191c1114180b0f130b0f130a0f130a0f130a0f140b0f130a0e130b0e130b0e130b0e130c0e130c0d130c0d120d0c110d0c100d0b0f0a0a0a0a0a0a0b0c0d1415251416281516281515281616281716281815281816280d0f140a0d100b0d100b0d110c0d120c0d120d0d120d0d120e0c120e0c120e0c120e0c110e0b110a0a0a0a0a0a0c0c0d17192f17183419183319143019122f1c15321f15312017300d0e120a0b0d0b0c0e0c0c100d0c110e0c110e0c120f0c120f0c130f0c130f0c130f0c130f0b130a0a0a0a0a0a0c0c0d18172e19173216142f503847724c461d132d2416312418300d0d110b0a0b0c0b0e0d0b0f0e0c100f0c120f0c13100c14100b14100b15100b15110c15100c150a0b0c0a0b0c0c0d0f19172d1b15311b112e2f4a4a63624824142e2a1832291a300e0d110c0a0c0d0b0f0e0c100f0c12100c13100c14100b15110c16110c17120c18140f19130e180a0b0d0a0c0d0c0d101a152d1d143021153124142f25142f2c1932311a322f1b310e0d120c0b0d0e0b100f0b120f0c13100c14110b15110c17120c18130c19130c1a140c1b130c1b0a0c0f0a0c0f0c0d11201d321e19301e182e1f192f21192f231a2f251a2f241b2e0e0e130c0b0e0e0b100f0c12100c13100b15110c16120c18130c1a140d1b150d1c150d1d150d1e0a0d110a0d110b0d122a2b3b2424371f1f322121342020331f20331f20331c1c2f0f0e140d0b100f0c120f0c13100c15110c16120c18130c19140d1b150d1c150d1e160d1f170d200a0e130a0e130b0f1525253733334433334429293b2020331d1d301d1d301b1b2e100f160e0c120f0d140f0c15100c16110d18120d1a130d1b140d1d150e1e160e1f170e20170e210a0f160a0f16070b136b6c76acacb1a9a9ae43435415152a1a1a2f1a1a2f1a1a2e1110170f0d130f0d15100d17110d18120d1a130e1b140e1c150e1e150e1f160e20160e20160e200b10190b111a0b101a1517221b1d261a1d2713152111131e12131e12131d12121c0f0f150f0d15100d16110e18110e19120e1b130e1c140e1d140f1e150f1e150f1f150f1f150e1f0b111c0b111c0c121d09234507274f0a16290b0e160c0f170c0e150d0e140d0e140e0e140e0d150f0e17100e18110e19120e1b120e1c130e1c140e1d140e1d140e1e140e1e140e1e';

// Layout anchors captured with the matrices (viewport fractions at sample
// time): the centred content column's edges, the header bottom and the footer
// skyline band. At toggle time the live positions of the same landmarks warp
// the matrices onto the current layout, so the colour field tracks the UI at
// any window size instead of only the sampled one. -1 = not measured; the
// axis maps drop any anchor that is missing, off-viewport or non-monotonic.
const HOME_ANCHORS: PageAnchors = {
  colL: 0.025,
  colR: 0.963,
  header: 0.107,
  hero: 0.483,
  skyT: 0.649,
  skyB: 0.814,
};
const DETAILS_ANCHORS: PageAnchors = {
  colL: 0.025,
  colR: 0.963,
  header: 0.107,
  hero: -1,
  skyT: 1.683,
  skyB: 1.848,
};
const SEARCH_ANCHORS: PageAnchors = {
  colL: 0.025,
  colR: 0.963,
  header: 0.107,
  hero: -1,
  skyT: 1.228,
  skyB: 1.393,
};
const MOBILE_ANCHORS: PageAnchors = {
  colL: 0.041,
  colR: 0.959,
  header: 0.076,
  hero: 0.375,
  skyT: 0.611,
  skyB: 0.72,
};
const DOWNLOAD_ANCHORS: PageAnchors = {
  colL: 0.025,
  colR: 0.963,
  header: 0.107,
  hero: -1,
  skyT: 1.594,
  skyB: 1.759,
};
const DOWNLOAD_INSTALL_ANCHORS: PageAnchors = {
  colL: 0.025,
  colR: 0.963,
  header: 0.107,
  hero: -1,
  skyT: 1.622,
  skyB: 1.787,
};

// Lift dark maps / drop light maps by this much so the starting noise contrasts
// with the page it dissolves over (else the dots blend into the matching theme).
const BRIGHTNESS_SHIFT = 25;

// One record per sampled view — a page's maps and anchors are picked as a
// unit, so they can never be mismatched at the selection site.
type PageSet = { light: string; dark: string; anchors: PageAnchors };
const PAGE_SETS = {
  home: { light: HOME_LIGHT_HEX, dark: HOME_DARK_HEX, anchors: HOME_ANCHORS },
  details: {
    light: DETAILS_LIGHT_HEX,
    dark: DETAILS_DARK_HEX,
    anchors: DETAILS_ANCHORS,
  },
  search: {
    light: SEARCH_LIGHT_HEX,
    dark: SEARCH_DARK_HEX,
    anchors: SEARCH_ANCHORS,
  },
  mobile: {
    light: MOBILE_LIGHT_HEX,
    dark: MOBILE_DARK_HEX,
    anchors: MOBILE_ANCHORS,
  },
  download: {
    light: DOWNLOAD_LIGHT_HEX,
    dark: DOWNLOAD_DARK_HEX,
    anchors: DOWNLOAD_ANCHORS,
  },
  downloadInstall: {
    light: DOWNLOAD_INSTALL_LIGHT_HEX,
    dark: DOWNLOAD_INSTALL_DARK_HEX,
    anchors: DOWNLOAD_INSTALL_ANCHORS,
  },
} satisfies Record<string, PageSet>;

// Matrices parse lazily on first toggle (memoized) — hydration never pays
// for colour data most sessions never use.
const mapCache = new Map<string, number[][]>();
function getMap(hex: string, shift: number): number[][] {
  const key = `${shift}|${hex}`;
  let map = mapCache.get(key);
  if (!map) {
    map = parseHexMap(hex, shift);
    mapCache.set(key, map);
  }
  return map;
}

type Run = { token: number; cancel: () => void; hasSwapped: () => boolean };
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

/** Piecewise-linear axis map through valid, strictly increasing [live, ref]
 * anchor pairs with pinned endpoints — identity when no pair survives. */
function axisMap(pairs: Array<[number, number]>): (u: number) => number {
  const pts: Array<[number, number]> = [[0, 0]];
  for (const p of pairs) {
    const prev = pts[pts.length - 1];
    if (
      p[0] > prev[0] + 0.02 &&
      p[1] > prev[1] + 0.02 &&
      p[0] < 0.98 &&
      p[1] < 0.98
    ) {
      pts.push(p);
    }
  }
  pts.push([1, 1]);
  return (u) => {
    for (let i = 1; i < pts.length; i++) {
      if (u <= pts[i][0]) {
        const [l0, r0] = pts[i - 1];
        const [l1, r1] = pts[i];
        return r0 + ((u - l0) / (l1 - l0)) * (r1 - r0);
      }
    }
    return 1;
  };
}

/** Resample a matrix so live-viewport positions read the reference layout's
 * colours — the dots then sit on the UI elements they represent. */
function warpMap(
  map: number[][],
  ref: PageAnchors,
  live: PageAnchors,
): number[][] {
  const fx = axisMap([
    [live.colL, ref.colL],
    [live.colR, ref.colR],
  ]);
  const fy = axisMap([
    [live.header, ref.header],
    [live.hero, ref.hero],
    [live.skyT, ref.skyT],
    [live.skyB, ref.skyB],
  ]);
  const out: number[][] = [];
  for (let r = 0; r < MAP_ROWS; r++) {
    // node-aligned (i/(N-1)) to mirror sampleMap's read convention, so an
    // identity warp reproduces the sampled matrix exactly — no edge smear
    const v = fy(r / (MAP_ROWS - 1));
    for (let c = 0; c < MAP_COLS; c++) {
      out.push(sampleMap(map, fx(c / (MAP_COLS - 1)), v));
    }
  }
  return out;
}

/** Tear down the in-flight run (stops its loop and removes its canvas). */
function teardown(): void {
  if (current) {
    current.cancel();
    current = null;
  }
}

// Uniform Float32 layout: resolution vec2 | progress | cell | sweep | motion | origin vec2.
const PROGRESS_IDX = 2;

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

/** Run the dissolve on the GPU. Resolves true if it took ownership (ran or was superseded), false to signal the caller to swap the theme instantly (no dither). */
async function startWebGPU(
  lightMap: number[][],
  darkMap: number[][],
  swap: () => void,
  token: number,
  toLight: boolean,
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
  // WebGPU validation errors (e.g. a shader compile failure — Chrome-on-Windows
  // Tint is stricter than Apple's) surface through the error scope, not as
  // exceptions — capture them so we resolve false and the caller swaps the theme
  // instantly (no dither; there is no canvas-2D fallback).
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
    const lightTexture = makeMatrixTexture(device, lightMap);
    const darkTexture = makeMatrixTexture(device, darkMap);
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
        { binding: 1, resource: lightTexture.createView() },
        { binding: 2, resource: darkTexture.createView() },
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

  const data = new Float32Array(8);
  data[0] = canvas.width;
  data[1] = canvas.height;
  // data[2] = progress, written per frame in the loop.
  data[3] = cellSizeCss() * dpr;
  data[4] = toLight ? 1 : -1; // sweep direction: sunrise (+) to light, sunset (−) to dark
  data[5] = 1; // motion always on — reduced motion swaps instantly upstream, never reaching here
  // Bloom origin = the footer skyline's sun/moon.
  const [ox, oy] = sunOrigin();
  data[6] = ox * dpr;
  data[7] = oy * dpr;

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
  current = { token, cancel, hasSwapped: () => swapped };

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

/** Cancel any in-flight transition and remove its overlay without starting a new one — call before a non-animated swap so a superseded run's deferred class-flip can't fire late. */
export function cancelThemeTransition(): void {
  if (typeof window === 'undefined') {
    return;
  }
  // If the in-flight run has already applied its swap, it's just finishing its
  // reveal — let it play out (no stale deferred swap to clobber). Only supersede a
  // run whose swap is still pending — the rapid-toggle desync this guards against.
  if (current?.hasSwapped()) {
    return;
  }
  teardown();
  runToken++;
}

/** Run the noise dissolve, applying `swap` (the light/dark flip) under full cover. Dots morph from the current theme's matrix to the other's. */
export function runThemeTransition(swap: () => void): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    swap();
    return;
  }

  teardown();
  const token = ++runToken;

  // The bloom is WebGPU-only, and its motion is the whole point. Without WebGPU,
  // or when the user prefers reduced motion, swap the theme instantly with no
  // dither: a plain grain without the bloom reads as a glitch (and an animated
  // grain dissolve is itself the motion reduced-motion users opt out of), so
  // there's deliberately no canvas-2D fallback. Bailing here also skips the
  // matrix parse/warp below, which only the GPU path needs.
  if (!navigator.gpu || prefersReducedMotion()) {
    swap();
    return;
  }

  // Pick the sampled set for the current view: company details, home with an
  // active search (results), /download (with or without the PWA install
  // card), the mobile home, or the desktop home. /download on a phone keeps
  // the desktop set — the page isn't linked on mobile, so it only gets
  // column/header correction. Trailing slashes are normalised so
  // '/download/' still matches.
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const hasSearch =
    path === '/' &&
    (new URLSearchParams(window.location.search).get('search') ?? '').trim()
      .length > 0;
  let set: PageSet = PAGE_SETS.home;
  if (isDetailsPath(path)) {
    set = PAGE_SETS.details;
  } else if (hasSearch) {
    set = PAGE_SETS.search;
  } else if (path === '/download') {
    // The PWA install card only mounts when the browser offered an install —
    // pick the variant matching what is actually on the page right now.
    set = document.querySelector('[data-install-card]')
      ? PAGE_SETS.downloadInstall
      : PAGE_SETS.download;
  } else if (path === '/' && window.innerWidth < MOBILE_BREAKPOINT) {
    set = PAGE_SETS.mobile;
  }
  // Warp the sampled matrices onto the live layout (fixed centred column,
  // anchored header/hero/sky bands) so the dots line up at any window size.
  const live = measureAnchors();
  const lightMap = warpMap(
    getMap(set.light, -BRIGHTNESS_SHIFT),
    set.anchors,
    live,
  );
  const darkMap = warpMap(
    getMap(set.dark, BRIGHTNESS_SHIFT),
    set.anchors,
    live,
  );
  // Going dark→light is a sunrise (band rises); light→dark is a sunset (band falls).
  const toLight = document.documentElement.classList.contains('dark');

  // WebGPU init can still fail after the capability check (no adapter/device, a
  // shader validation error). If it does, swap instantly rather than dropping to
  // a bloom-less dither — same reasoning as the no-`navigator.gpu` bail above.
  startWebGPU(lightMap, darkMap, swap, token, toLight)
    .then((handled) => {
      if (!handled && token === runToken) {
        swap();
      }
    })
    .catch(() => {
      if (token === runToken) {
        swap();
      }
    });
}
