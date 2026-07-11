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
 * The bloom is WebGPU-only. Where WebGPU is unavailable it falls back to a plain
 * non-directional canvas-2D dither (no bloom), and to an instant swap if neither
 * canvas works. The transition runs regardless of `prefers-reduced-motion`, but
 * the bloom's coherent radial motion is gated off for those users — they get the
 * same plain dither as the fallback.
 */

import { measureAnchors, type PageAnchors } from './measure-anchors';
import WGSL from './theme-transition.wgsl?raw';
import { prefersReducedMotion } from './utils';

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
const CELL_CSS_DESKTOP = 0.65;
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
  'fcfcfef7f6faf5f6faf9f7f9fbfbfdfafcfefafcfefafcfefafbfefafbfefafbfefafbfefafbfefafbfefafbfefafcfefafcfefbfdfef3f4f6d8d9daeff0f2fbfcfdfcfcfdf1f1f1fcfdfee7e7ede3e5ecf1e4eaf8f6f9fafcfefafbfef9fbfef9fbfef9fbfef9fafef9fafef9fbfef9fbfef9fbfef9fbfefafbfefdfdfed8d9dc737475cacaccf9f9fbf6f7f8ecececf1f3f8f1f4faf0f3faedf2faebf0f8eaeff8eaeff9e8eef9e8edf9e6ecf8e7ecf8e7ecf8e7ecf7e7edf8e8edf7e9eef7e9eff8eaeff8edf1faf0f4fdeff2faeef1f8eff1f8e9e9ebf3f3f8f1f2f8f0f2f8eef1f8edf0f8e7ebf4dee2ecdcdfeae1e5f0e7ebf7e7ebf7e7eaf6e7ebf6e8ebf6e8ebf6e8ecf6e9ebf6e9ecf6eaedf7ebedf7ecedf7ededf7eeedf6e9e8eaf4f4f8f4f4f8f4f4f8f3f3f8f2f3f8f2f3f8f4f4f7f1f2f5f6f7faf8f9fcf8f9fcf8f9fcf8f8fcf9fafcf9f9fcf9f9fcf9f9fcf5f5f9edecf5eeebf6eeecf6efecf6efebf6e8e7eaf4f4f8f4f4f8f4f4f8f4f4f8f4f4f8f5f5f8f7f7f8f5f5f8f8f7faf9f8fbf8f7fbf9f8fbf8f6faf7f5f9f7f5f9f6f4f8f6f4f9f4f1f7eeeaf4eeeaf4eee9f5ede9f5ede8f5e8e7eaf1f2f8f2f3f8f2f3f8f2f3f8f3f4f8f4f4f8f4f4f8f4f3f8f3f2f8f3f2f7f2f0f6eeecf3efecf4f1edf6eeeaf4eee9f3ede8f3ede8f3ede7f3ece6f3ebe6f4ebe5f4ebe5f5e8e6eaeef1f8eef1f8eff1f8eff1f8f0f2f8f1f3f8f3f3f8f4f4f8f4f3f8f4f4f8bbbabe959498969499d1cdd5f1ecf7eee9f3ede8f3ece6f2ebe5f2eae4f3e9e2f4e9e2f4e0d9ebe4e2e7ebeff7eceff8eceff8edf0f8edf0f8eef1f8eff1f8f1f2f8f3f3f8f0f0f5d2d1d6cecdd3cfcdd4dbd8e1eee9f4ede8f3ece6f3ebe5f2eae3f3e9e2f3e8e0f3eae2f7b0a9b9d3d2d5e8edf7e8eef7e8edf7e8eef7e9eef7e9eef7eaeff8ebeff8edf0f8eff1f8f0f1f8efeff8edecf7eceaf5ebe8f4e9e6f4e8e5f3e7e3f3e7e1f3e6e0f3e5dff3e5ddf3e2daf0e5e3e9e2eaf8e2eaf8e2eaf8e2eaf8e3ebf8e4ebf8e5ecf7e7edf7e9eef8e4e9f4dce2f2e1e6f5e5e8f5d7dbf0dee0f3e7e6f5e5e4f4e5e3f4e4e2f4e4e0f4e3dff4e3dff4e3def4e6e4eadce7f8dbe7f8dce7f8dce7f8dde8f8dee8f8dfe9f8e1eaf8e3ecf9dce1e9d7dde8d3d9e6ced5e5cdd6e9dce1f2e4e6f7e3e5f6e3e3f5e2e2f5e2e1f4e2e1f4e2e0f4e2e0f4e6e5eadde8f8dde8f8dde9f8dee9f8dfeaf8e0eaf8e1ebf8e3ebf9e4ecfae1e7efe0e5eae1e2e3e4e6ebdde4ecdfe6f3e7eaf8e6e9f7e6e8f7e6e8f7e6e7f6e6e7f6e6e7f6e6e6f6e6e6eae9f1fbe9f1fce9f1fbeaf1fbeaf1fbebf2fbecf2fbedf3fbeef3fceff4fdeaeff6e4e8efe8ecf2eff3faf1f4fcf0f3fbf0f3fbf0f3fbf0f3fbf0f3fbf0f2fbf1f3fbf1f3fbededefe7f0fce8f0fce8f0fce8f0fce9f0fce9f1fceaf1fcebf2fcebf2fcecf3fceaf0f9e3e9f1e5eaf2eef3fbeff4fceff3fceff3fceff3fceff3fbeff3fbeff3fbf0f3fbf1f4fcf1f2f4e8effce8f0fce8f0fce8f0fbe8f0fbe8f0fbe9f1fbe9f1fbeaf1fbebf2fbebf2fbe8eef7e8eef7edf3fcedf3fcedf3fceef3fceef3fceff4fceff4fbeff4fcf0f4fbf1f4fcf1f2f3';
const HOME_DARK_HEX =
  '0a0b0b1010110f10120f0e0f0b0b0c0a0b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0c0a0b0c090a0b1213142d2e2f1617180a0b0c090a0a3a3b3b090a0a211f2220202321181a0f0e100a0b0c0a0b0d0a0b0d0a0b0e0a0b0e0a0b0d0b0c0e0a0b0e0a0b0e0a0b0d0a0b0d0a0b0d0607092c2d2e9191923b3b3c0a0b0c0e0f0f3f40400a0c0e090b0d080b0e080d100b0f130b0f140b0f150c0f170b10170d111a0d11190d11180e11190c10170d10170c10160b0f140b0f14090d1206090e090b100b0d100a0b0e4040410a0a0b0a0b0c0a0c0d0a0c0e0a0c100e1116181a201a1c2314171e0e10170f11181011190f11171011170f11160e10150e10150d0f140c0e130c0d120c0d120d0c110c0a0f4040410a0a0a0a0a0a0a0a0a0a0a0b0a0b0c0b0c0e1010111212140d0e0f0c0c0e0c0c0e0c0c0e0e0d0f0b0c0d0d0d0e0c0c0d0c0c0d0e0e10100e130f0d120e0c120f0b120e0a114040410a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0d0c0c0e0e0e0c0c0c0c0b0c0e0c0d0c0b0b0f0c0e100d0f0f0c0e110e100f0c0f110e11120e14110d14110c14100b140f0a144140420a0b0c0a0b0c0a0b0b0a0b0b0a0a0b0a0a0a0a0a0a0b0a0b0c0b0c0d0c0d0f0d0e141013130f13120d12150f15150f15150f16140e16140e16130e17130d18120c18110b174140430a0c0e0a0c0e0a0c0e0a0c0d0a0b0d0a0b0c0a0a0b0a0a0a0b0a0b0b0a0b4645466d6b6d6c6a6c322d32120c12150f16150f16150e17160f18150e1a150e1b150d1c130c1b4240440a0d100a0d100a0d100a0d0f0a0c0f0a0c0e0a0b0d0a0b0c0a0a0b0e0d0e2c2b2c302e31302d31242026130e15140e16150e17160f19160f1a160f1c160f1d160e1e17101d4241440a0e130a0e130a0e130b0e130b0e130b0e120b0d110b0d100b0c0f0c0c0e0c0b0e0d0b100f0c12110d15130e17140e18150f19160f1b160f1c17101e170f1f170f20160d1f4240450a0f170b10170b0f170b0f170b0f170c0f160c0f150c0e140c0e130d0e120e0e130f0e1416131b19161f110d17140f1a150f1b15101c16101e16101f171020160f20150e1f4240450b111c0b121c0c121c0c111c0c111b0c111a0c10190d0f180d0f1610111814141a12111815141c17151e12101a120f1a130f1c14101d15101e15101e15101f150f1f140e1e4240440c121c0c121c0d121c0d121c0d121b0d111a0d11190e10180e0f170f111816161b151519151519141319111019100f18110f19120f1a120f1a130f1a130f1a130f1a120d194241440b0f160b0f160c0f160c0f150c0f150c0e140c0e140c0e140c0e130b0d121313171a1a1e1515180e0e120d0c110d0d120d0d120e0d130e0d130e0d130e0d130e0c130c0b113c3c3d0c10180c10170c10170c0f170c0f160c0f160d0f150d0e150d0e150d0e140f101517171c15151a0d0d120d0d120d0d120d0d120d0d120d0d120d0d130d0d120d0c120b0a103737380c0f170c10170c0f170c0f170d0f170d0f160d0f160d0f150d0e150d0e150d0e141111171111170d0d130d0d130d0d130d0d120d0d120d0d120c0d110c0c110c0c110a0a0f373738';

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
  'fcfdfef7f6faf5f6faf9f7f9fbfbfdfafcfefafcfefafcfefafbfefafbfefafbfef9fbfefafbfefafbfefafbfefafcfefafcfefbfdfef3f4f6d8d9daeff0f2fbfcfdfbfcfdf1f1f1fcfdfee7e6ede3e5ecf0e4eaf8f6f9fafcfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfefcfdfed8d9db737475c9caccf9f9fbf6f6f8ecececeef1f8eef2f9edf2faeaf1fae8eff8e7edf8e5edf9e4ecf9e3ecf9e2ebf9e2ebf9e1ebf9e1ebf9e2ebf9e2ebf9e3ecf9e4ecf9e6edf8e9effaedf3fdecf2faecf0f8edf0f9e8e9ebedf0f7ebeff8eaeef7e8eef7e7edf7e7edf7e9edf3e7ecf2eaeff7edf1f9ecf1f9ecf1f9ebf0f8ebf0f7ebf0f7ecf0f7ecf0f7ecf0f7e6edf7e8eef8e9eef7eaeef7ebeff7e8e9ebeff1f8eef1f8ecf0f8eaeff8e9eef8ebeff7dcddded5d5d6e3e3e5ecedeeecedeeededeff2f3f5f6f7f8f6f7f8f6f7f8f6f6f8f4f5f7e8eef7e9eef8eaeef7eceff7edeff7e8e9ebf1f2f8f0f2f8eef1f8edf0f8ebeff8ecf0f7e6e7e9e0e1e2dfe0e2dfe0e2e8e9ebf1f2f4f4f5f7f6f7f9f5f6f8f6f7f9f6f7f9f3f5f7eaedf7eaedf7ebedf7edeef7eeeef7e8e8eaf3f4f8f2f3f8f1f2f8eff1f8eef1f8eef1f7e8e9ebeff0f2f2f3f5e8ebebf1f3f4f4f5f7e7e8e9edeef0f2f3f5e8e9ebeeeff0f1f2f5ebedf7ebecf7ecedf7eeedf7efeef7e9e8eaf4f4f8f4f4f8f3f3f8f2f3f8f0f2f8f0f2f7eff0f2f3f4f6f4f6f8edf1f1f2f4f6f3f4f7edeef0eeeff1f0f1f3e2e3e5eceef0f0f1f4ececf6ececf6edecf6efedf7e7e4eeebeaedf4f4f8f4f4f8f4f4f8f4f4f8f3f3f8f2f3f8f2f3f6f1f2f6f3f4f8f0f1f6f1f2f6f2f4f8f0f2f6f0f1f6f1f2f7eff0f5f0f0f6f1f0f7edebf6eeebf6eeebf6f2eff9b7b4bcdddcdef4f4f8f4f4f8f4f4f8f4f4f8f4f4f8f5f5f9ebebede6e6e8f4f4f7efeff2f6f7f9f8f8fbe7e7eae6e6e9f1f0f4e3e2e6f1f0f5f6f5fbeeebf6eeeaf6eeeaf5eeeaf5ece8f4efeef1f4f4f8f4f4f8f4f4f8f4f4f8f4f4f8f5f5f8e9e9ebe8e8eaf8f8fafbfbfdfbfbfdfafafdf9f9fbf8f8fbf8f7fbf8f6fbf7f6fbf5f3faeeeaf5ede9f5ede8f5ede8f5ede8f5f0eff2f2f3f8f2f3f8f3f3f8f3f4f8f4f4f8f5f5f9ededefe8e8eaf1f1f3f4f4f6f3f3f5f4f4f6faf9fcf9f8fcf9f7fcf8f6fcf8f6fcf5f3faede9f5ece8f5ece7f4ece6f5ece6f5efeef2f0f2f8f1f2f8f1f2f8f2f3f8f3f3f8f1f1f5ebebebeaeae9e9e9e8ebebeae6e8e6e3e5e3ebebeaeeefeeededededededefefefeeedefece7f4ece6f5ebe5f5eae4f5eae4f5efedf2eff1f8eff1f8eff1f8f0f2f8f1f3f8eeeff3e5e5e4e2e3e0e6e7e4e4e4e2e2e3e0e2e3e0e7e7e5e8e9e6e9eae7e9eae6e9eae6e7e7e6ebe6f3ebe5f5eae3f5e9e2f4e9e2f5efedf2edf0f8edf0f8eef0f8eef1f8f0f2f8eeeff3e2e3e0e2e3e0e3e4e1dfe0dde5e6e4e2dfdee5e3e2eaebe9e8e9e6e8e9e6e7e8e5e7e7e6ebe5f4eae3f5e9e2f4e8e1f4e8e0f4eeecf2eceff7eceff7eceff7edf0f7eef1f8eceef3e4e5e2e7e8e5e6e7e4e7e7e5e7e8e5d4d3d2dcdddbe5e6e3ebebe9e4e5e2e7e7e4eae9e9eae4f3e9e2f4e8e0f4e7dff3e7def3eeecf1';
const DETAILS_DARK_HEX =
  '0a0b0b1010120f10120f0e0f0b0b0c0a0b0c0a0b0c0a0b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0c090a0b1213142d2e2f1617180a0b0c090a0a3a3b3a090a0a211f2220212421181a0f0e100a0b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0e0a0b0e0a0b0e0a0b0e0a0b0d0a0b0d0a0b0d0607092c2d2e9191923b3b3c0a0b0c0e0f0f3f40400a0d10090c10080c11080e130a0f15090f15080f15090f16091017091017091018091018091118091018091017091017090f16090f15080d13050a10080d120a0e12090c103f40410a0c0f0a0d110a0e120a0e140a0f140c1119171a28171b291417261215241216251216251316251317261316251316251316251215220a10160a0f140a0e130a0e12090c0f3f40410a0c0e0a0c0f0a0d100a0e120a0e120e11193333453a3a4c2d2d3f2423372424372423371e1e321a1a2f1b1a2f1b1a2f1b1a2f19192c0b0f150a0e130a0e120b0d110a0b0f3f40400a0b0c0a0c0d0a0c0f0a0d100a0d100d10172626382b2b3d2c2c3e2c2c3e2525381e1e321b1b2f19192d1a1a2e19192d19192d18192b0c0f150b0d120c0d120c0d110b0b0f4040410a0a0a0a0b0b0a0b0d0a0c0e0a0c0e0e0f162525381f1f331c1c302125351c1d301b1b2f2727392121351d1d312626392121351b1b2d0d0e140c0d130d0d120d0c110c0a0f4040410a0a0a0a0a0a0a0a0b0a0b0c0a0b0c0e0f141e1e311a1a2e19192d1b1f2f191b2d1a1a2e2020331f1f321d1d312a2a3c2121341a1a2c0e0d140d0c120e0c120e0b110d0a0f3a3a3b0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0c0d0e14151915161a13141815161b15161a13151914161a15161b15151b16161d16161d15141b0f0d130f0c120f0c120f0b12100e133838390a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0c0c0c212221262626191a1a1d1e1e1617171516162526262626271d1c1e29282b1d1b1f161419100d130f0c13100c140f0b140d09123837390a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0c0c0c23232324242416161613131313131314131415151616151716151817151a18151b18151b100c14100b14100b15100b150f09143837390a0a0b0a0b0b0a0a0b0a0a0b0a0a0a0c0c0c1f1f1f2222221a1a1a18181819191918181914131515141615131816141917151b17131b100c15100c16110c16110c17100a1538373a0a0b0c0a0b0c0a0b0c0a0b0c090a0a10111027282630302f2f2f2e2d2e2d2f302e3536342f302f2a2a2a2f2e2f2f2e302d2c2d29272a120e17110b17120c18120c19110a1739373a0a0c0e0a0c0e0a0c0d0a0b0d090a0b1113122f302f40413e393a383c3d3b3f413e3f403e3b3b393b3b3a3e3e3d3a3b393b3b39363535130e19120c18130c1a140c1b120b1939373b0a0c0f0a0c0f0a0c0e0a0c0e090a0c131515393b383b3c393a3b383e3f3c4749464e4747433f3f393a393838373838373d3d3b353535140e19130c19140d1b150d1c130b1b39373b0a0c100a0c100a0c0f0a0c0f090b0d1415163839373a3a383a3b383a3a383939375b5b5a484946373735373735393a373c3d3b343333140e1a130c1a140c1c150d1d140b1d39373c';

// Home page with an active search (results list) — spliced from screenshots 5/6.
const SEARCH_LIGHT_HEX =
  'fcfdfef7f6faf5f6faf9f7f9fbfbfdfafcfefafcfefafcfefafbfefafbfefafbfef9fbfefafbfefafbfefafbfefafcfefafcfefbfdfef3f4f6d8d9daeff0f2fbfcfdfbfcfdf1f1f1fcfdfee7e6ede3e5ecf1e4eaf8f6f9fafcfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfefcfdfed8d9db737475c9caccf9f9fbf6f6f8ecececeef1f8eff2faeef2faebf1fae9eff8e8eef8e7eef9e6eef9e5edf9e4ecf9e4ecf9e4ecf9e4ecf9e4ecf9e4ecf9e5edf8e6edf8e7eef8eaf0faeff4fdedf2faecf0f8edf1f9e8e9ebeff1f8edf0f8ebeff7eaeef7e9eef8e4eaf4dbe1ecd7dee9dee5f0e4eaf5dae2eee1e8f4dee5f1e1e8f5e3ebf7e4ebf7e5ecf7e6edf7e8eef7e9eef8eaeef7ebeef7eceff7e8e9ebf2f2f8f0f2f8eef1f8edf0f8ebeff8ebeff7eff1f4f6f8fbf7f9fbf7f9fcf6f8fbf7f9fcf6f8fbf7f9fcf7f9fcf7f9fcf8f9fcf4f6faeaeef7eaedf7ecedf7edeef7eeeef7e8e8eaf4f4f8f3f3f8f1f3f8f0f2f8eff1f8eff2f9f2f4f7f5f7fbf5f6fbf4f6fbf4f6fbf4f6fbf4f6fbf4f6fbf4f6fbf4f5faf4f5faf2f3f8ebecf7ececf6edecf6eeedf6efedf6e9e8eaf4f4f8f4f4f8f4f4f8f3f4f8f3f4f9e8e6eeeae3eceef1f8edf0f7eceff7eceff7ebeff7ebeff7ebeff7ebeef7ebedf7ebecf6ebecf6edecf6edecf6eeecf6efecf6efecf7e8e8eaf4f4f8f4f4f8f4f4f8f4f4f8f5f5f9edebf2e8e4eaebecf0eaeaefe7eceee9eaf0eaebf0e6e8ecebecf3efeff7eeedf7eeedf6eeecf6eeebf6eeebf6eeeaf5efebf6e5e1ece5e4e7f3f4f8f4f4f8f4f4f8f4f4f8f4f4f8f2f2f7e3e3e8e1e1e5e8e8ecf4f4f8f3f3f7f2f2f7f1f1f7f1f0f7f0eef7efedf6eeebf6eeeaf6eeeaf5ede9f5ede8f5f0ebf8b4b1bbd4d3d6f1f2f8f2f3f8f2f3f8f3f3f8f3f4f8f2f1f7e7e6ebe5e5e9e8ebedececf0ecedf0e9e9edeaeaeff1eff7efedf6eeebf6eeeaf6ede9f5ece8f5ece7f5ebe6f5ebe5f5e9e3f3edecf0eff1f8f0f2f8f0f2f8f1f2f8f2f3f8f0f0f6e1e1e6dfdfe3dfe0e3e4e4e8f3f3f7f1f0f6f1f0f7f0eef7efecf6eeebf6eee9f5ede8f5ece6f4ebe5f5eae4f5eae3f5eae3f5efedf2edf0f8eef0f8eef1f8eff1f8f0f2f8f0eff6e7e8ede7e8ebe7eaece8e8ecececf0e8e8edeeedf4f0edf7efebf6eeeaf5ede9f5ece7f4ebe5f5eae3f5e9e2f4e8e1f4e8e0f4eeecf2ebeff7eceff8ecf0f8edf0f8eef1f8eeeef5dbdce2d9dadfdddde1efeff4f3f3f9f2f1f8f0eef7efecf6eeebf6eeeaf5ede8f5ebe6f5eae4f5e9e2f4e8e1f4e7dff4e7def4eeecf1e9eef7eaeef7eaeef8eaeef8eaeff8eaedf5dee0e8dcdfe5dee3e7e6e7ede8e9eee5e6ece5e5ece6e6ede5e4ece3e2ebe3e2ece8e4f4e8e3f5e8e1f4e7dff4e6def3e6dcf3eeebf1e7edf7e6edf7e6edf7e6edf7e7edf8e7ebf5dbdfe8dadee7dde1e9eaedf4edeff7ecedf6ebecf6eaeaf6e9e8f5e8e7f5e7e5f5e7e4f5e6e2f5e5e0f4e5dff4e4ddf3e5ddf4eeecf1e3eaf7e2eaf8e2eaf8e3ebf7e4ebf7e4eaf4d7dce6d5dae3d7dce5e5e9f2ebeef8eaedf6eaebf6e8e9f6e7e8f6e6e6f6e6e4f5e5e3f5e5e2f5e4e0f4e4dff4e3def4e3ddf3edecf1';
const SEARCH_DARK_HEX =
  '0a0b0b1010120f10120f0e0f0b0b0c0a0b0c0a0b0c0a0b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0c090a0b1213142d2e2f1617180a0b0c090a0a3a3b3a090a0a211f2220212421181a0f0e100a0b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0e0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0607092c2d2e9191923b3b3c0a0b0c0e0f0f3f40400a0d10090c0f080c10080e120a0f140a0f15090e15090f15090f160a10170910170a10180a10180a1017091017091017090f160a0f15080d13060a0f080c110a0e11090c0f3f40410a0c0e0a0d0f0a0d110a0e120a0e130d1218151b20181d2412171e0d121811171e0d131a0f151c0b11190910170910160a0f160a0f150a0f140a0e130a0e120a0d11090b0f3f40410a0b0c0a0c0d0a0c0e0a0d100a0d110c0f121314160c0d0f0c0d0f0b0d0e0b0d0f0b0d0e0b0d0f0b0c0e0b0c0e0b0c0e0b0c0e0c0e100b0e130b0d120c0d120c0d110b0b0f4040410a0a0a0a0a0b0a0b0c0a0b0d0a0c0e090c0e0d0f110a0c0d0b0c0e0b0c0e0b0c0e0b0c0e0b0c0e0b0c0e0b0c0e0b0c0f0c0c0f0d0d110d0d130d0d130d0c120d0c110c0a0f403f410a0a0a0a0a0a0a0a0a0a0a0b090a0a1815181914160a0c0e0a0d0f0a0d0f0b0d100b0d100b0e100b0d100c0d110c0d120d0d130d0d130e0c120e0c120f0c120f0c120e0a114040410a0a0a0a0a0a0a0a0a0a0a0a0909091210121815161111121212131014131112131213131616171010120c0b0f0d0c100e0c110f0c120f0c130f0c130f0c130f0b140f0b134140420a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0b0c1a1b1c1d1e1d1616160a0a0a0b0b0b0b0b0c0c0b0d0c0b0e0d0b0f0e0b110f0c12100c13100c14100b14100b15100b15120e164140420a0b0c0a0b0c0a0b0b0a0a0b0a0a0a0c0c0d1616171818181115131111111111111514151312140d0b0f0e0b110f0c12100c13100b14100b15110c16120c17120c18100a163a383b0a0b0d0a0c0d0a0b0d0a0b0c0a0b0c0d0d0e1d1d1d1f1f1f1e1f1f1a1a1a0b0b0b0d0c0e0d0b0e0d0b100f0c12100c13100b14100c15110c17120c18130c19130c1a120a1939373b0a0c0f0a0c0f0a0c0e0a0c0e0a0b0d0c0d0e1515161516161216141515151212121515160f0e110e0b100f0c120f0c13100b15110c16120c18130c1a140d1b140d1c130b1b39373b0a0d100a0d100a0d100a0c0f0a0c0e0d0e102021222324252121210e0e0f0a090b0b0a0d0d0b0f0e0c110f0c130f0b14100b15110c17120c19130c1a140d1c150d1e140b1d39373c0a0d120a0e120a0e120a0d120a0d110d0e12191a1d1b1c1e171b1b15151614141516161817161916151917151a18161c19161c130e19130d1a140d1c150d1d160d1f150c1f3a373c0a0e140b0f150b0f150b0f150b0e140e10151b1d211c1e221b1c1f0f0f120d0c100e0d120f0d14100d15100d16110d18120e19130d1b140d1c150e1d160e1f160e20150c1f3a373c0a0e160a0f160a0e170a0f160b0e150e10161c1e241f21261e1f241112160c0c110e0c130e0d140f0c15100c17110d18120d19130d1b140e1c140e1d150e1e150e1f140c1e39373c';

// Mobile (portrait) home, no search — spliced from screenshots 7/8.
const MOBILE_LIGHT_HEX =
  'fdfcfefcfdfef4f3f7f0f0f4f4f5f9f4f6f9f6f4f7f9f5f7f8f4f7fafbfdfbfcfefbfcfefbfcfefbfcfefbfbfef5f6f8fafcfefafcfef6f7f8fcfdfefafbfcf4f5f6fbfcfefdfdfef6f7fbf7f8fcebecf3e5e7efe9eef5e9eef5edecf4f1ecf3ebe9f1f1f4faf1f5fcf1f5fbf0f5fbf0f5fbf0f5fbe9edf3f0f4faf1f5faebeef3f4f6fbf1f3f9eaebf0f5f6fbf6f8fcf0f2f8e9ebf2e4e8efe4e9f1e5eaf3e4eaf3e0e6f0dee5efdee5f0dde4efe3eaf6e3eaf7e3ebf7e4ebf7e4ebf7e5ebf8e5ebf7e7ecf7e8edf8e8eaf6e9ebf6eceef8eceef7eeeef6f4f4f8f0f1f5edeef2edeef3edeff4eceef4eaecf2e8ebf1e8ebf2e9ecf3ecf0f8eef1f9eef1f9edf0f9edeff9eef0f9eef0f8eff0f8eeeef7efeff8f0eff7f0eff6f0edf5efecf5f3f3f8f7f7fafafafaf8f8f9f7f7f8f5f5f5f9f8f9f6f6f8f6f6f7fcfcfdfffffffffffffffffffffffffdfdfefbf9fdfaf8fbfaf9fcfbfafcfaf9fbf7f6f8f8f7f9f4f1f8ede9f4f2f3f8f2f3f8f3f3f8f3f4f8f4f4f8f4f4f8f3f3f8f4f4fae8e8eddddde1d3d3d8cecdd4d0ced4cfcdd4dfdbe4e5e0ebefebf6eee9f4ede7f2ece5f2ece6f4ece6f4ebe5f3ebe5f2eff1f8eff1f8eff1f8f0f2f8f0f2f8f1f2f8efeff5ebebefdbdbe0cbcad0c8c7ccc7c6cbc3c1c8c5c1cad0ccd5d9d6dfe5e0ebe9e3efece5f3ebe5f4eae3f3eae3f4eae3f5e9e1f4ebeff7eceff8eceff8ecf0f8edf0f8eef1f8eff1f8eff0f7f2f2f9f5f5faf5f4faf3f1faf2eff9f1eff9efecf7ede8f4ebe5f2ebe5f4eae4f4e9e2f3e6def0d6cee1d5cde1e4dbf1e7edf7e7edf7e7edf7e7edf7e8eef7e8eef7eaeef8ebeff8ecf0f8eef0f7eeeef7ededf7ececf6ebeaf5eae8f4eae7f5eae7f5e9e5f5e7e2f4e6e0f3d8d3e6938f9c918d9ad9d1e6e1e9f8e0e9f8e0e9f8e1eaf8e1eaf8e3ebf8dfe8f5e0e8f6e1e8f6e2e8f6e7ecf7e7ebf7e5e8f6e6e8f5e8e9f7e0e2f4dbddf3dcdcf3e0dff4e4e1f5e3e0f4e5e1f6e6e1f6e4dff4d9e5f7d9e5f7d9e5f7dae6f7dbe6f8dde8facfd3dad2dae8d5deedd6dfeed6dce6d6dae5cfd6e6d6deefd4d6e1d2daefcdd5ebc8d2e7dcdef3e2e2f5e2e1f5e2e1f5e2e1f5e3e1f5e3ecf9e3ecfae3edfae4edfae5edfae6eefaebeff4e3ebf2e6ebf1e5e9ede7e9ece6e8ebe7eaeeebeef3e6e8ece9ecf2e9ecf2eaeef5ebedf9ebedf9ebedf9ebedf9ecedf9ecedf9e8f0fbe8f1fce9f1fce9f1fceaf1fceaf2fcebf2fdedf4fddee3ecdde2eae0e6eee6ebf3e4e9f1e1e5ede6ebf3e4e8f0eff3fbf0f4fcf0f3fcf0f3fbf0f3fbf1f3fbf1f3fbf2f3fbe7f0fbe7f0fbe7f0fbe8f0fbe8f1fce7effae6eef9e7eff9eaf1fceaf1fbdce2eaeaf0f9eaeff8d9dfe7e9eff8edf2fbecf1faecf1f9eef3fbeff4fceff4fcf0f4fcf0f4fcf1f4fce8f0fbe8f0fbe8f0fbe8f0fbe8f1fce1e9f3dbe2ecdee5eee0e7f1dfe6f0e0e7f0e2e9f2e7eef7e3eaf3dfe6efe1e7f0e1e7f0e1e6efe7edf5eff4fdeff4fceff4fcf0f5fcf1f5fce9f1fce9f1fce9f1fce9f1fce9f1fce9f1fce9f1fce9f1fce9f1fbe9f1fce9f1fce9f1fbe8f0fbe9f1fceaf1fcebf2fcebf2fcecf3fcedf3fceef3fceef4fceff4fcf0f5fcf0f5fc';
const MOBILE_DARK_HEX =
  '0a0b0b090a0b141315171619111213101213121012120e0f130f100b0c0c0a0b0c0a0b0c0a0b0c0a0b0c0a0b0d0f10110a0b0c0b0b0c0f10110a0a0b0b0c0d1112120b0b0c0a0b0c0a0c0d090b0c1616191b1b201315191215191313171410141614180b0e110a0d110a0d110a0e120a0d120b0e111114180b0e120b0e111114170b0d100e0f121516180b0d0f0a0c0d0a0b0d0f11141215181014170e12160e121711161b12181d11171d11171e0b11180a10180a10180a10170b10170c10180c10180b0f160c0f150f10170e0f150b0d120d0d110f0e110a0a0a0e0e0f1112131012130f10120f11131113151214171214171113170c0f130b0e120b0e110c0e130e0f160d0e130c0e120d0e12110f150f0e120e0d12100e12130f13100d120a0a0a0b0b0b0c0c0c0e0d0d0f0f0f1111110d0d0d0f0f100f0f100a0a0a0707070807080807080707070909090e0c0e0f0d0f0d0c0d0c0b0d0d0b0d100e100e0d0f0f0c11110d140a0a0b0a0b0b0a0a0b0a0a0a0a0a0a0a0a0a0b0b0c0a090b1616172222232d2c2e333134302f31312e32241f251e1820110c13120d15170f18181019130d17130d17150f18160f190a0c0e0a0c0e0a0c0d0a0b0d0a0b0d0a0b0d0e0e0f1212132322233433353736373837393d3a3e3e393e312c322521281b151d1a121b150e18130d18150e1a18101c160f1c150d1c0a0d100a0d100a0d100a0d100a0c0f0a0c0f0b0c0e0d0d0f0b0b0d09080909080a0d0a0e0e0a100d090f100b12140e16160f18130d18140d19170f1b170f1d160f1d160e1e170e200a0e140a0e140b0e140b0e140b0e130b0e130c0e130c0d120c0d100d0d100f0d110f0d120f0d13110e15130e16120d17120d18140e1a160f1c150e1d140d1c1c172116111c160d1f0a10180b10180b10180b10180b10170c0f170c0f160d0f150d0e150f0f150e0d120f0e14110e16110f1715121c191620130f1a140f1c140e1c140e1e150e1e150e1e150e1f160e1f0c121d0c121e0c121e0c121d0d121c0d111b11141d14161f14161d11131a11121814131a14131a13111a1c1a231e1c2615121d17131f140f1d140f1e140f1e140f1e140f1e140f1e0c11190c11190c11190d10190d10180d10170f101616161c16171b17181c15151817171a161619131316151519141317141418110f15100e16100e16100e16100e16100d16100d160b0f170c0f170c0f170c0f160c0f160c0e150c0e150b0d131b1d221d1e241a1b2016161b17171c18181d13131816161b0e0d130d0c120d0c120d0c120d0c120d0c120d0c120d0c110c0f170c10180c10180c0f170d0f170e10180f11190f11180d0e150e0f151c1c220f0f151010161f1f241111160e0e130f0f140f0f140e0e130d0d120d0d120d0c110d0c110d0c110c0f170c0f170d0f170d0f170d0f1714161d1a1c23181a2117181f17181f17181e16161c11121815151b19191f17171d18181d18191e1313180d0d120d0d120d0d110c0c110c0c100c0f160d0f170d0f170d0f170d0f170d0f170e0f170e0f170e0f170e0f160e0f160f0f160f0f160f0f160e0e150e0e150e0e140e0e140d0e130d0d130d0d120d0d120d0d110c0c11';

// /download — dark hero panel with the desktop preview window. Neutral
// placeholder tones until sampled (scripts/sample-theme-matrices.ts).
const DOWNLOAD_LIGHT_HEX =
  'fcfdfef7f6faf5f6faf9f7f9fbfbfdfafcfefafcfefafcfefafbfefafbfefafbfef9fbfefafbfefafbfefafbfefafcfefafcfefbfdfef3f4f6d8d9daeff0f2fbfcfdfbfcfdf1f1f1fcfdfee7e6ede3e5edf1e4eaf8f6f9fafcfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfefcfdfed8d9db737475c9caccf9f9fbf6f6f8ecececeef1f8eef2faedf1f9eaf1f9e8eff9e7edf8e6edf8e4ecf8e3ecf8e3ebf8e3ebf9e3ebf9e2ebf9e3ecf9e3ecf9e4ecf9e5edf8e6edf8e9f0faeef3fdedf2faecf0f8edf0f9e8e9ebedf0f7ecf0f8e4e8f1c0c4ccbec3cbbdc2cbbbc0cabdc4cebbc1ccc5cdd8e1eaf8e1eaf8e1eaf8e1eaf8e2eaf8e3ebf7e4ebf7e5ecf7e7edf7e8eef8e9eef7eaeef7ebeff7e8e9ebf0f1f8eef1f8ebeef6e1e5ede2e6efe0e5eedee4ede3e9f3e8eef9e7eef9e6eef9e4ecf7e4ecf7e4ecf7e5ecf7e6edf7e7edf8e8eef8e9eef8e9eef7ebeef7eceef7edeff7e8e9ebf2f3f8f0f2f8f0f2f8e6e8e7dbdfdedadcdcd6d7d7d6dde0d6dde1d5dbdfdfe1e3e9eef8e7edf7e7edf7e7edf7e8eef8e8eef8e9edf7eaedf7eaedf7ecedf7edeef7eeeef7e8e8eaf4f4f8f3f3f8f2f3f8cfcec9dae1e8dae1eadae0e9dbe4eddde5f0dae1e9cac6c2ebf0f9e9eef8e9eef8e9eef8e9eef7eaedf7eaedf7ebecf7ececf7edecf6eeedf6f0eef7e9e8eaf4f4f8f4f4f8f4f4f7b9b8b8e7ecf6e0e5f0e2e9f5e5edf9e8eef9e6eaf3bfbdbbeef1f9ecf0f8eceff8eceef7ebedf7ebedf7ececf6ececf6edecf6eeecf6efecf7e7e4eee9e8eaf4f4f8f4f4f8f3f3f79d9d9ce9ecf4dfe4ede0e6efe5ebf4e9edf7e5e7ef9e9e9af1f3f9eff1f8eef0f7eeeff7edeef7ededf7edecf6eeebf6eeebf6eeebf6f2eef9b7b4bcdddcdef4f4f8f4f4f8f3f4f7969893eeeff4e3e6ede4e8efebeef7ecedf7e6e5eda3a091f4f5f9f2f2f8f1f0f7f0eff7efeef6efecf6eeebf6eeebf6eeeaf5eeeaf5ede9f5ece7f3efeef1f3f3f8f3f4f8f3f4f8cbcdc9ededf0f1f2f5f0f2f6f2f3f7f3f3f8f0eff4d6d5d0f4f4f8f2f2f7f1f0f7f0eef7efedf6eeebf6eeeaf6eeeaf5ede8f5ece8f5ece7f5ede7f5f0eef2f1f2f8f1f3f8f3f4f9e5e6e8dddedfeff0f2eff0f1eff0f1eeeff0eff0f2f5f6f9f3f3f8f2f1f7f1eff7f0edf6efecf6eeebf6eee9f5ede8f5ece7f5ebe6f5ebe5f5ebe5f5efeef2f0f1f8f0f2f8f1f3f9e6e7e8d9dadcd8d9dbdddee0f1f2f4f1f2f4f2f3f5f3f4f6f3f2f8f1f0f7f0eef6efecf6eeebf6eeeaf5ede8f5ece7f4ebe5f5eae4f5eae3f5eae3f5efedf2eef0f8eef1f8f5f7fd98999a5c5c5d606060757676eff0f2f6f7f9f5f6f8f5f6f8f2f1f7f1eff7f0edf6efecf6eeeaf6eee9f5ece7f5ebe5f5eae4f5e9e2f4e9e1f4e8e1f4efedf2ecf0f8ecf0f8eef1f8ebedf2e6e8ede7e8edeaebf0f3f4f8f4f4f8f4f4f8f3f3f7f2f1f7f1eff7efedf6eeebf6eeeaf5ede8f5ece6f4ebe5f5eae3f5e9e1f4e8e0f4e7dff4eeecf1ebeff7ebeff7ebeff7edf0f8eef1f8eff1f8f0f1f8f0f1f8f1f2f7f2f2f7f1f1f7f0eff6efedf6eeebf5edeaf5ede9f5ece7f4ebe5f4eae4f4e9e2f4e8e0f4e7def3e6ddf3eeebf1';
const DOWNLOAD_DARK_HEX =
  '0a0b0b1010120f10120f0e0f0b0b0c0a0b0c0a0b0c0a0b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0c090a0b1213142d2e2f1617180a0b0c090a0a3a3b3a090a0a211f2220202421181a0f0e10090b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0e0a0b0e0a0b0e0a0b0e0a0b0d0a0b0d0a0b0d0607092c2d2e9191923b3b3c0a0b0c0e0f0f3f40400a0d10090c10090d11090e130a0f140a1016090f160a10170a11180a11190a11190a11190a11190a11180910180a10170a10170a0f16080d13050a10080d110a0e12090c103f40410a0c0f090c1010141835393d373b3f373b40373c4133383e363b41292f36091018091119091018091018091018091017090f17090f160a0f150a0f140a0e130a0d12090c0f3f40410a0b0d0a0c0f0b0e1114171a13161914181c151a1e1014190a0f150a10160a0f160a10160a10160a10160a10160a0f160a0f150a0f140a0e140a0e130b0d120b0d110a0b0f3f40400a0b0c0a0b0d0b0d101d22341f273a1b2132191d2e1a2133181d2f191c2f181b2b0c10160a0f140a0f150b0f140a0f140a0e130b0e130b0e130c0d130c0d120c0c110b0b0f4040410a0a0a0a0a0b0c0d101f2435141b24131a241218211017210d131d10151f1f21310c0f150a0e120a0e120b0e120b0e120c0e130c0e130c0d130d0d120d0d120d0c110c0a0f4040410a0a0a0a0a090c0c0f151722090d1213161c0d1319090f16090e140c10141d1f2c0c0e130a0d0f0b0d100b0d110c0d120d0d120d0d130e0d120e0c120e0c120e0b120d0a103d3c3e0a0a0a0a0a0a0c0c0f12141b0a0c0f14191d11161b0d12170b0f140c0e1214171e0c0d110a0c0d0b0c0f0c0c100d0c110d0c110e0c120f0c120f0c130f0c130f0b13100d133837390a0a0a0a0a0a0c0c0f0f12170809091417181114170a0d100b0c110e0d11181e210c0c0f0b0b0c0c0b0e0d0b0f0d0b100e0b110f0c120f0c13100c14100b14100b140e09123837390a0a0b0a0a0a0c0c0e1c1e2a191924161722161622141521141421161422181b270c0c0e0b0a0c0c0b0e0d0b0f0e0b110f0c12100c13100c14100b15100c16110c160f0a1438373a0a0b0c0a0b0b0b0c0f2c2b3d3131431f1f33201f332020342121342020341c1c2e0c0c0e0c0a0d0d0b0f0e0b100f0c12100c13100b14100b15110c16120c17120c18100a1639373a0a0b0d0a0b0d0b0c102626383232443333442f2f401d1d311d1d311d1d301a1a2c0d0c0f0c0b0e0d0b100e0c110f0c130f0b14100b15110c16120c18130c19130c1a110a1839373a0a0c0e0a0c0e07080d72727dacacb1a8a8ae94949c20203419192e1a1a2f19192c0d0c100c0b0e0e0b100f0b12100c13100b14110c16120c18130c19130c1a140d1b120b1a39373b0a0c0f0a0d0f0a0d1014161d1a1b221a1b2117181f1010171010161010161010160d0b0e0d0b0f0e0c110f0c13100b14100c15110c17120c18130d1a140d1c150d1d140b1c39373b0a0d100a0d100a0d10090c0f090b0d090b0c090a0b0a0b0c0a0a0b0a0a0a0b0a0c0d0b0f0e0c100f0c12100c14100c14110c16120d17130d19140d1b150d1c150d1e140b1e39373c';

// /download with the PWA "Install web app" card mounted (Chromium after
// beforeinstallprompt) — the extra card reshapes the card row. Neutral
// placeholder tones until sampled (scripts/sample-theme-matrices.ts).
const DOWNLOAD_INSTALL_LIGHT_HEX =
  'fcfdfef7f6faf5f6faf9f7f9fbfbfdfafcfefafcfefafcfefafbfefafbfefafbfef9fbfefafbfefafbfefafbfefafcfefafcfefbfdfef3f4f6d8d9daeff0f2fbfcfdfbfcfdf1f1f1fcfdfee7e6ede3e5edf1e4eaf8f6f9fafcfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfef9fbfefcfdfed8d9db737475c9caccf9f9fbf6f6f8ecececeef1f8eef2faedf1f9eaf1f9e8eff9e7edf8e6edf8e4ecf8e3ecf8e2ebf8e3ebf9e3ebf9e2ebf9e3ebf9e3ecf9e4ecf9e5edf9e6edf8e9f0faeef3fdedf2faecf0f8edf0f9e8e9ebedf0f7ecf0f8e4e8f1c0c4ccbec3cbbcc2cbbac0cabdc4cebac1ccc5cdd8e1eaf8e0eaf8e1eaf8e1eaf8e2eaf8e2ebf7e3ebf7e5ecf7e6edf7e8eef8e9eef7eaeef7ebeff7e8e9ebf0f1f8eef1f8ebeef6e1e5ede2e6efe0e5eedee4eee3e9f4e8eef9e7eef9e7eefae5ecf8e5ecf7e6edf8e6edf8e7eef8e8eef8e9eff8e9eff8eaeff8ebeef8eceff7edeff7e8e9ebf2f3f8f0f2f8f0f2f8e6e8e7dbdfdddadddcd6d5d5d4dadcd5dce0d5dbdfd5dadce6e8ece6ebf5e0e5f1e2e6f1e4e7f2e6e8f2e8e9f2eaeaf3eceaf3efeef5edeef7eeeef7e8e8eaf4f4f8f2f3f8f2f3f8d0cec7d8dee4d8e0e9d9dee6d7e0e9dbe4eddce4f0cdced0d7d5d3dee4f2cfd4e9d4d8ead9dbecdfe0f1e2deede6e0ede9e0ebeeeaf0eeeef7f0eef7e9e8eaf4f4f8f4f4f8f4f4f8b6b5b5e5ebf4e3e7f2e3e9f5e6edf9e8effaebf1fcd2d2d6d1cfcfe4e7f4d7d9eaddddeddbd2dfd6a8aae9dfe4eae2ebebe0e4efe9ecefedf8e7e4eeeae9ebf4f4f8f4f4f8f4f4f89f9e9be7eaf1e1e6f0dce3ece3e9f3e6ecf5eef2fdc0c1c5b9bab9ebebf7dddcece6e1f0c8d2d596a885f1dfd2ece1e5eddfdcf0e8e9f2effbb7b4bcdddcdef4f4f8f4f4f8f4f4f8898c89e9eaf0e5e8f0e0e4ece9edf6eaedf7f0f2fdbebbbab8b6aeefeef8e4dfede8e1ece9e1e9e7dfdbede0e0eddfdaefddd4f0e7e5eeeaf7ece7f4efeef1f3f3f8f3f4f8f4f4f8abada4eff0f3ecedf2e8eaefedeff5eeeff7f2f1fbcecbc9cac9c0f3f0f9ebe5eeede5ebeee4e7efe4e4efe3dff0e3dbf1e1d6f1e9e6ece8f6ede7f5f0eef2f2f2f8f2f3f8f3f4f9e0e1e3dfe0e2f4f5f7f4f5f7f3f4f6f3f4f6f3f4f6f3f4f6f5f5f8e4e4e7ececeef5f5f7f4f4f6f3f4f6f3f4f5f3f4f6f3f4f6f3f2f7ebe5f5ebe5f5efeef2f0f2f8f0f2f8f1f3f8eeeff1e9eaececedeff1f2f4eeeff1ecedefeeeef0edeef0f4f5f8eeeff2ecedefecedefe7e8e9ebeceeecedefedeef0edeff0f1f1f6eae3f5eae3f5efedf2eef1f8eef1f8f4f6fbb0b1b2828384858586979899f2f3f5f7f8faf6f7f9f6f7f9f9f9fbbfc0c2838384848485cdced0fafbfcf6f7f9f6f7f9f6f8f9f2f2f7e9e1f4e9e1f4efedf2edf0f7edf0f8f1f4fac2c4c7a2a3a5a4a5a7b1b1b4f1f2f5f5f6f8f5f5f8f4f5f8f7f6faceced2a2a2a5a3a3a6d8d8dcf6f6faf3f2f7f2f2f7f2f2f7f0edf6e8e0f4e8dff4eeecf1ebeef7ebeff7eceff7f1f4fcf5f8fff7f9fff6f8fef1f2f8f2f3f8f3f3f8f2f1f7f0eff7f3f1faf6f3fef6f2fdf0ecf8ece6f4ebe5f4eae4f5e9e2f4e8e0f4e7def3e6ddf3eeebf1';
const DOWNLOAD_INSTALL_DARK_HEX =
  '0a0b0b1010120f10120f0e0f0b0b0c0a0b0c0a0b0c0a0b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0d0a0b0c090a0b1213142d2e2f1617180a0b0c090a0a3a3b3a090a0a211f2220202421181a0f0e10090b0c0a0b0d0a0b0d0a0b0d0a0b0d0a0b0e0a0b0e0a0b0e0a0b0e0a0b0d0a0b0d0a0b0d0607092c2d2e9191923b3b3c0a0b0c0e0f0f3f40400a0d10090c10090d11090e130a0f140a1016090f160a10170a11180a11190a11190a11190a11190a11190910180a10170a10170a0f16080d13050a10080d110a0e12090c103f40410a0c0f090c1010141835393d373b3f373b40373c4133383e363b41292f36091018091119091019091018091018091017090f17090f160a0f150a0f140a0e130a0e12090c0f3f40410a0b0d0a0c0f0b0e1114171a13161914171c151a1f0f14190a0f150a10160a0f150a0f160a10160a10160a10160a10150a0f150a0f140a0f130a0e120b0e120b0d110a0b0f3f40400a0b0c0a0b0d0b0d101d223520283b1c2335191d2d1a2134192033181c2f1a1d3114172413172615182b16182a16172a1717291716291816291816291614230c0c110b0b0f4040410a0a0a0a0a0b0c0d10212639161e28141c26131923121a240f16200c121d191d29191b2915182c1719341818331816321413301b15321d15312015321b15290d0c110c0a0f4040410a0a0a0a0a090c0c0f151723080d1211141a0e13190a1016080e15080d121518201a1c2916162b191732181631261b33683942271b2f1f14302517321e16290e0c110d0a103c3b3d0a0a0a0a0a0a0c0c0f14161f0a0c1012171c14191f0e12180c11160a0d1210121714162018162b1b16321a13302129397688683c282d2315312b193221172a0e0b12100d133837390a0a0a0a0a0a0c0c0f0e1117090a0b12151715181b0c0f130b0e120c0c1111141615191e19152a1c15311e1430201530271d2e2817312c1932311a3324182a0f0b140d09123837390a0a0a0a0a0a0c0c0f12161d0c0c1013141815171c1011170f0f17100e1715171d171b211914291e1530211730241830261831291a312c1a31311c3223182a100b160f0a1438373a0a0b0c0a0b0b0b0c0f2b2b3c2f2f401a1a2e1b1b2e1c1b2f1c1c2f1b1b2f1b1b301514222827362323371b1a2e1b1b2f1c1c2f1c1c2f1c1c2f1c1c30181729120c17100a1638373a0a0b0d0a0b0d0c0d101e1e302222352020321c1c302020332121342020332020351615241c1c2c20203420203325253722223521213420213420203419182a130c19110a1839373a0a0c0e0a0c0e08090e5b5b6887879084848e73737f1e1e3219192e1a1a2f1a1a301211204a4a5687879186868f40405116162b1a1a2e1a1a2e1a1a2f19172a140d1b120b1a39373b0a0c0f0a0c0f090b0f43444e63646b62626a56575f19192816162516162517172611101b39384265646d64636b31303f15142518172818172919172a181527150d1d130b1c39373b0a0d100a0d100a0d1005080b0204080304070405070a0b0b0a0a0a0a0a0a0b0a0c0c0b0e0a080c07040b08040c0d0811100b15110b17120c19130c1a140c1c150d1e140b1d39373c';

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

/** Run the dissolve on the GPU. Resolves true if it took ownership (ran or was superseded), false to signal the caller to fall back. */
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

  const reducedMotion = prefersReducedMotion();
  const data = new Float32Array(8);
  data[0] = canvas.width;
  data[1] = canvas.height;
  // data[2] = progress, written per frame in the loop.
  data[3] = cellSizeCss() * dpr;
  data[4] = toLight ? 1 : -1; // sweep direction: sunrise (+) to light, sunset (−) to dark
  data[5] = reducedMotion ? 0 : 1; // 0 = reduced-motion plain dither, 1 = sunlight spread
  if (!reducedMotion) {
    // Bloom origin = the footer skyline's sun/moon. Skipped for reduced motion, whose
    // plain dither ignores u.origin — so its layout read is avoided too.
    const [ox, oy] = sunOrigin();
    data[6] = ox * dpr;
    data[7] = oy * dpr;
  }

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

  // ceil (not round) so the cap term always keeps total cells <= MAX_CELLS, even
  // when cellSizeCss() is below 1 (it no longer dominates the max() as a floor).
  const cell = Math.max(
    cellSizeCss(),
    Math.ceil(Math.sqrt((w * h) / MAX_CELLS)),
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
  current = { token, cancel, hasSwapped: () => swapped };

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
  if (path.startsWith('/company/')) {
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
  const sourceIsDark = document.documentElement.classList.contains('dark');
  const srcMap = sourceIsDark ? darkMap : lightMap;
  const tgtMap = sourceIsDark ? lightMap : darkMap;
  // Going dark→light is a sunrise (band rises); light→dark is a sunset (band falls).
  const toLight = sourceIsDark;

  if (navigator.gpu) {
    startWebGPU(lightMap, darkMap, swap, token, toLight)
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
