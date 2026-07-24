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
  'e9eef7e3e8f3e0e7f3e1e6f3e1e8f7dfe9f8dde6f8dce7f8dbe5f8dae5f8dae5f8d9e4f7dae5f7dae6f8dbe6f7dce7f8dde8f8dfe9f8dde6f4c5ccd8d2d9e4e6edf7e6ecf6e9eef7ecf0f9d8dbe8d2d9e7ded7e4e2e6f3e3ebf8e1e9f8dfe8f8dee7f8dee7f8dde6f8dee7f8dee7f8dee7f8dfe8f8e0e9f8e1eaf8e3ecf9d4dbe775787ca0a4abe8eef7e4e9f1ebeff7eef1f8eef1f9edf1f9eaf0f9e8eef8e7edf8e6ecf8e5ebf8e4eaf8e2e9f7e2e9f7e2e9f7e3e9f7e3e9f7e4eaf7e4ebf7e5ecf7e6edf7e8eef8ecf2fcecf1fbebeff8edf0f8eef0f7f2f3f8f0f2f8eff1f8edf0f8ecf0f8e7ebf5dde1ecdbe0eadfe3efe7ebf7e6eaf7e6eaf6e7eaf6e7eaf6e7ebf6e8ecf6e8ecf6e9edf6eaedf7ebedf7ecedf7edeef7eeeef7efeff7f4f4f8f4f4f8f3f3f8f2f3f8f0f2f8f0f2f8f3f4f7f1f2f5f5f6f9f8f8fcf8f8fcf8f9fcf8f8fcf8f9fcf8f9fcf8f9fcf8f9fcf6f7faeeedf6ececf6eeecf6eeecf6efedf6efedf6f4f4f8f4f4f8f4f4f8f4f4f8f4f4f8f4f4f8f6f6f8f5f5f8f7f7faf8f8fbf7f7faf8f8fbf8f7faf7f5f9f7f6f9f6f4f8f6f4f9f5f3f8efecf5eeebf5eeeaf5eeeaf5eeeaf5eeeaf5f3f3f8f3f4f8f3f4f8f4f4f8f4f4f8f4f4f8f4f4f8f3f3f8f3f2f8f2f2f7f2f1f7edebf1edebf2f2eef7efebf4efeaf4eee9f3ede9f3eee9f3ede8f3ede8f4ece7f4ece7f5ece7f4f0f2f8f0f2f8f1f2f8f1f3f8f2f3f8f3f4f8f4f4f8f4f4f8f4f3f8f6f6fac2c1c5a6a5a9a09ea3c6c3cbf0ecf6eee9f4eee9f3ede8f3ece6f2ebe5f3eae5f4eae4f4eae3f5eae3f4eef0f8eef0f8eef1f8eff1f8f0f1f8f1f2f8f2f3f8f3f4f8f4f4f8f3f3f7d5d4d9d3d2d7d7d4dbd8d5ddeee9f3eee9f4ede8f3ece6f2ebe5f3eae3f3e9e2f3e8e1f3e8e0f4e8e0f4ebeff7ebeff8ebeff8eceff8edf0f8eef0f8eff1f8f0f2f8f1f2f8f1f3f8f2f2f8f1f0f8efedf6edebf5ede9f4ece8f4ece7f3ebe5f3eae3f3e8e2f3e8e0f3e7dff3e6ddf3e5dcf3e8edf7e7edf7e7edf7e8edf7e8eef7e9eef7eaeef7eceff8e2e9f5dbe4f2e3e5ebe2e3ebe3e3ece0dfe9e0dee9e4e1eee9e6f5e8e4f4e7e2f3e6e1f3e5dff3e5def3e5ddf3e5dcf3e2eaf7e2eaf8e2eaf8e2eaf8e3ebf8e4ecf8e5ecf7e7edf8e3e9f2e2e7efe4e8f2e3e5efe6e8f2e1e2eee1e1efe4e3f2e6e5f6e5e3f5e5e2f4e4e1f4e4dff4e4dff4e4def4e4def4dde7f8dde7f8dde7f8dde8f8dee8f8dfe9f8e1eaf8e2eaf8e5edf9e0e7f3d7dff0dbe2f4dee3f3d2daf0d7ddf3e6e7f7e4e5f6e3e4f6e3e2f5e3e1f5e3e1f5e3e0f4e3e0f5e4e0f4d7e4f7d6e4f7d7e4f7d7e4f7d9e5f7dae6f7dbe7f8dde7f8dfe9f9dbe2ecd4dbe4d3d8e1ced5e1cfd8e7d6dfefe3e7f7e1e5f6e1e4f6e1e3f6e1e2f5e1e1f5e1e1f5e2e1f5e2e1f5e0eaf9e0ebf9e0ebf9e1ebf9e2ebf9e3ecf9e4edf9e5edf9e6eefae6ecf5e6ebf0e9ebeeedf0f4e8ecf2e4ebf5eaeef9e9edf9e9ecf9e9ecf8e9ebf8e9ebf8eaebf8eaebf8ebebf8e8f0fbe9f1fbe9f1fbeaf2fbeaf2fbebf2fbebf2fbecf2fbedf3fbeff4fde9eef6c6cad1c5c9cfe5eaf1f1f6fef0f4fbf0f4fbf0f3fbf0f3fbf0f3fbf0f3fbf1f3fbf1f3fbf1f3fb';
const HOME_DARK_HEX =
  '0a0e1310141a0f141b0f121a0a111a0a111b0b131e0a121e0b13200b14210b14200c15210b131f0b141f0a131e09121d09121c09111a0d141d2a30361d2229090f150b10160a0e13080c1020212820242b211c2210131b0a10190a111b0b121d0c121d0c131e0c131f0c131e0c131d0c121d0b121c0a111a091119070e161a202687898c585b5e090e130f13180a0e110a0c0f080b0e080c0f080d120a0f150b0f160b0f170b10190b101a0d111b0d121b0d121b0e121b0d111a0d11190c11180b10170a0f16090e14060a10070b100a0d120a0c100a0c0f0a0b0b0a0b0d0a0c0e0a0d0f0a0d110e1116181b21191c231518200e10180f111910121a0f11191011181011170e10160e10150d0f140c0e130b0d120c0d120c0d110c0c100c0b0f0a0a0a0a0a0a0a0a0b0a0b0c0a0b0d0b0d0f0f10121212140e0e100c0c0f0c0c0f0c0c0e0e0d0f0b0c0d0c0d0e0c0c0e0b0c0d0e0e0f0f0e130e0d130e0c120e0c120e0c110e0b110a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0c0c0c0e0e0e0d0c0d0c0b0c0e0c0e0c0b0c0e0c0e100d0f0e0c0e110e100f0c0f100d10120e13110d13100c13100c130f0b130f0b130a0a0b0a0a0b0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0c0b0c0d0c0d0e0c0e151214151114110c10150f13140f13150f15140f15130e15130e15120d16110c16110c16110b160a0b0d0a0b0d0a0b0c0a0b0c0a0b0b0a0a0b0a0a0a0a0a0a0b0a0b090809403e3f5c5a5b6260623c393c120d12150f15150f16140e16150f17140e18140e19140d1a130c1a130c190a0c0f0a0c0f0a0c0e0a0c0e0a0b0d0a0b0c0a0b0b0a0a0a0a0a0a0b0b0b2928292b292c292629272428140f15140e15140e16150f17150f18150e1a160e1b150e1c150d1d150d1d0a0d110a0d110a0d100a0d100a0c0f0a0c0f0a0c0e0a0b0d0a0b0c0a0b0c0b0a0c0d0b0e0f0c11110d13130e15130e15140e17150e18150e1a160f1c160f1d160e1e170e20170e200a0e130a0e140b0e140b0e140b0e130b0e130b0e120b0d100e121a0f162017161918171b18161c1b181f1b171f18131d140e18150f1a160f1c160f1d160f1f170f20170e21170e200a0f170b0f170b0f170b0f170b0f160c0f160c0f150c0e1411131814151911111615141a13121816141c16131c15111b130e1a140f1b150f1d150f1e160f1f160f1f160f20160e1f0b111a0b111b0c111b0c111b0c111a0c10190c10180c0f170c0e150d0f150f10160f0e1513121a1c1a230f0d17110e19120e1b130e1c140f1d140f1e140f1e150f1e150e1e140e1e0c131f0c13200d131f0d131f0d121e0d121d0d111c0e111b0e101910121a16171e13131a14141b15141c13111b110f1a120f1b130f1c130f1d130f1d140f1e140f1e140f1e130e1d0c111b0d121b0d111b0d111a0d111a0d11190d10180d10180e0f170e1016141418121215121215131316100f160f0e16100e16100e17100e17100e17110e17110e17110e17100e160b0f170b0f170c0f160c0f160c0f150c0e150c0e140c0e140c0d130b0c1116161b3c3c402f2f331414180b0b100d0c120d0c120d0c120d0c120d0c120d0c120d0c120d0c120d0c11';

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
  'e9eef7e3e8f3e0e7f3e2e6f3e1e9f7dfe9f8dde8f8dce7f8dbe6f8dae6f8dae6f8d9e6f7d9e5f7dae6f8dae6f8dbe7f8dde7f8dfe9f8dde6f4c5ccd8d2d9e4e5edf7e6ecf6e9eef7ebf0f9d7dae8d1d8e7ddd6e4e1e5f3e1ebf9e0e9f8dee8f8dde8f8dce7f8dce7f8dbe7f8dbe7f8dce7f8dde7f8dde8f8dfe9f8e1ebfad2dae774777c9fa4abe7edf7e3e8f1e9eef7ebeff7ebf0f9eaf0f9e7eff9e5ecf8e3ebf7e1eaf8e0eaf9dfe9f8dde8f8dde8f8dde8f8dde7f8dde8f8dee8f8dfe9f8e0e9f8e1eaf8e4ecf9e9f0fce9f0fbe9eef8eaeff8ebeff8edf0f8ebeff8e9eef7e8eef8e7edf8e6edf7e8edf3e8ecf3eaeff6edf2f9ecf1f9ecf1f9ecf0f8ebf0f8ebf0f8ecf0f8ecf0f7ecf1f7e7edf7e7edf8e8eef8e9eef7ebeff8edf0f8eef1f8edf0f8ebeff8eaeef7e9eef7eaeff8dddee0d4d5d6e1e1e3ecedeeecedeeededeff1f2f3f6f7f8f6f7f8f6f7f8f6f7f8f5f6f8e9eef7e8eef8e9eef8ebeff8eceff8eef0f7f0f2f8eff1f8edf0f8ebeff8eaeef8ebeff8e7e8eae0e0e2dfe0e2dfe0e2e6e7e9f1f2f4f4f5f7f6f7f9f5f6f8f6f7f9f6f7f9f5f6f8eaeef7e9edf7eaeef7eceef7edeff7efeff7f2f3f8f0f2f8eff1f8eef0f8ecf0f8edf0f8e8e9ebeeeff0f3f4f6e8ebecf0f1f3f5f6f8e8e9ebebeceef3f4f6e8e9ebedeef0f1f2f4ebeef7eaedf7ebedf7ecedf7eeeef7efeff7f4f4f8f3f3f8f1f2f8f0f2f8eef1f8eef1f7eef0f2f3f4f6f5f6f8eef1f2f1f4f5f4f5f7edeef1edeef0f2f3f5e2e3e5ebeceff0f1f4eceef7ebecf7ececf7ededf6efedf7f0eef6f4f4f8f4f4f8f3f4f8f2f3f8f1f2f8f0f2f8f0f2f6f0f1f6f2f4f8eff1f6eff1f6f1f3f8eff1f6eff1f6f0f1f7eff0f6eff0f6f0f1f8ececf6ececf6edecf6eeecf6efecf6efecf6f4f4f8f4f4f8f4f4f8f4f4f8f3f3f8f3f4f9ebebeee4e5e7f2f3f6eeeff2f4f5f8f7f8fce7e8ebe4e5e8eff0f4e4e4e8ededf1f7f6fbeeedf6edebf6eeebf6eeebf6eeebf6eeebf6f4f4f8f4f4f8f4f4f8f4f4f8f4f4f8f5f5f9eaeaece6e7e9f6f6f9fafbfdfafafdf9fafdf8f9fcf8f8fbf8f8fbf7f7fbf7f7fbf7f5fbefecf6eeebf6eeeaf5eeeaf5eeeaf5eeeaf5f4f4f8f4f4f8f4f4f8f4f4f8f4f4f8f5f5f9eeeef0e7e7e9f0f0f2f4f4f6f3f3f5f4f4f6f9f9fcfaf9fcf9f8fcf9f7fcf8f7fcf7f5fbefecf6eeeaf5ede9f5ede8f5ede8f5ede8f5f3f3f8f3f3f8f3f4f8f4f4f8f4f4f8f2f2f6ebebebeaeae9e9e9e8ebebeae7e9e7e3e5e3eaeaeaecececefefeeeeeeeeefeeefefefefede9f3ede9f5ede8f5ece7f4ece6f4ece6f4f1f2f8f1f3f8f2f3f8f2f3f8f3f4f8f0f1f4e5e6e4e2e2dfe6e7e4e4e5e2e2e3e0e1e3dfe6e7e4e8eae6eaebe8e8e9e6e9eae6e7e8e5ece8f2ede7f5ece6f4ebe5f5ebe5f5ebe4f5f0f2f8f0f2f8f0f2f8f1f2f8f2f3f8f0f1f4e3e3e1e1e2dfe4e4e1dfe0dde4e5e4e3e0e0e3e0e0ebeceae7e8e5e6e7e4e7e7e5e7e7e5ebe7f2ece6f5ebe5f5eae4f5eae3f5e9e3f4eef1f7eff1f8eff1f7f0f1f8f1f2f8eff0f4e4e5e3e7e7e4e7e7e4e6e6e3e8e9e6d5d6d4dadad8e4e5e2ebece9e5e6e3e6e6e3eaeae8eae5f1ebe5f5eae3f4e9e2f4e9e1f4e8e1f4';
const DETAILS_DARK_HEX =
  '0a0e1310141a0f141b0e12190a101909111a09111b09121c09121d09131e09131e09131f09131f09131e09121e09121d09121c09111b0d141d2a30371d2229090f150b10160a0e13080c1120222920242c201c230f131b08101809111a09111b09121c09121c09121d09131d09121d09121d09121c09121c09111b070f181a202887898c575b5f090e150f14190a0e130a0d11080d11080d12080e14090f16090f17080f1708101808101909111a09111a09111a09111a08111a08111a081019081018081017080e16050b12070c120a0f140a0e120a0d110a0d100a0d110a0e130a0f140a0f150b1018171927181b291518261215241216251216251316251417261316251316251316251316240b10180a0f150a0f140a0e130a0d110a0d100a0c0e0a0d100a0d110a0e120a0e130c10183131433a3a4c2f2e412424372424372423371f1f331a1a2e1b1a2f1b1a2f1b1a2f1b1a2f0d11190a0e130a0e130a0d110a0d100a0c0f0a0b0d0a0c0e0a0d100a0d110a0d110c10172525372c2c3d2c2c3d2c2c3e2727391e1e321b1b2f19192d1a1a2e19192d19192d1a1a2e0d11180a0e120b0d120b0d110b0c100b0c0f0a0b0b0a0b0d0a0c0e0a0c0f0a0d100c0f152525372020341c1c302125351d1f311a1a2e2626382323361c1c302626392222351d1d310e10180c0d120c0d130c0d120c0c110c0b0f0a0a0a0a0b0b0a0b0c0a0c0d0a0c0e0d0e141e1e301b1b2e19192d1a1f2f1a1c2e19192d2020332020331b1b2f2b2b3d2222351d1d300f0f170c0d120d0d120d0c120d0c100d0b100a0a0a0a0a0a0a0a0b0a0b0c0a0b0c0c0d0f14161a15171b13151a15171c15171c13151b14161c15171c15161c16171d16161e15151c0f0e140e0c120e0c120e0c110e0b110e0b110a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0c0d2021222728281a1c1c1d1f1f17191a1416172325262728291c1d2028282b1f1f2316161a100e140e0c120f0c120f0c120f0c130f0c130a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0b0b22222225252617171813141413141513141514151615161716151816161916151a17161a110e140f0c130f0c13100b140f0b140f0b140a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0b0b1e1e1e2323231b1b1b18181819191918181814131514131515141615141816141917141a110e150f0b13100b14100b15100b15100b150a0a0b0a0a0b0a0a0b0a0a0a0909090f100f2627252f302f2f302e2e2e2d2e2f2e3435343131302f2f2e2a2a2a2c2c2c2d2c2d2b2a2c1512190f0b14110b16110c16110c17110c170a0b0c0a0b0c0a0b0c0a0b0b09090a1011102d2e2c40413f393a383c3d3b3f403e40403e3c3c3b3939383a3a393c3d3b3b3b3a3a3a3918141b100a15110c17120c18120c18120c180a0b0d0a0b0d0a0b0d0a0b0c090a0b1112123839373b3c393a3b383d3e3b4648454d48474741413839383c3c3b3d3d3c3d3e3c3a3b3917131b110b17120c18130c19130c1a130c1a0a0b0e0a0c0e0a0b0d0a0b0d090a0b1112133738363a3b383a3b39393a383839375656544f4f4e363734363735393a373b3c3a39393818131c110b17130c19130c1b140c1b140c1b';

// Home page with an active search (results list) — spliced from screenshots 5/6.
const SEARCH_LIGHT_HEX =
  'e9eef7e3e8f3e0e7f3e2e6f3e1e9f7e0e9f8dee8f8dce7f8dbe6f8dae6f8dae6f8d9e6f7d9e6f7dae6f8dbe6f8dce7f8dde7f8dfe9f8dde6f4c5ccd8d2d9e4e6edf7e6ecf6e9eef7ebf0f9d7dae8d2d8e7ded7e4e1e6f3e2ebf8e0eaf8dfe9f8dee8f8dde8f8dce7f8dce7f8dce8f8dde8f8dee8f8dee9f8e0e9f8e2ebfad3dbe775787ca0a4abe7edf7e3e8f1eaeef7ecf0f7ecf0f9ebf0f9e9f0f9e6edf8e5ecf8e4ecf8e3ebf9e2ebf8e0eaf8e0eaf9e0e9f8e0e9f8e0eaf8e1eaf8e2eaf8e3ebf8e4ebf7e6edf8ebf1fcebf1fbe9eef8ebeff8edf0f8eff1f8edf0f8eceff8eaeff8e9eef8e5ebf5dbe2ecd8dfe9dde4eee5ecf5dbe3efe0e8f3dfe6f2e0e8f4e3ebf7e4ebf7e5ecf7e6edf7e8eef8e9eef8eaeef8ebeef7edeff7eef0f7f2f2f8f0f2f8eef1f8edf0f8ebeff8ebeff7eef0f3f6f8fbf7f8fbf7f9fcf6f8fbf7f9fcf6f8fcf7f9fcf7f9fcf7f9fcf8f9fcf6f7faebeff7eaedf7ebedf7eceef7eeeef7efeff7f4f4f8f3f3f8f1f3f8f0f2f8eff1f8eff2f9f1f4f7f5f7fbf5f6fbf4f6fbf4f6fbf4f6fbf4f6fbf4f6fbf4f6fbf3f5faf4f5faf3f4f9ecedf7ebecf7ececf6eeedf6efedf6f0eef6f4f4f8f4f4f8f4f4f8f3f4f8f3f4f9e9e7efe9e2eaeef1f8edf0f7eceff7eceff7ebeff7ebeff7ebeff7ebeef7ebedf7ebecf6ebebf6ececf6edecf6eeecf6eeecf6efecf6efebf6f4f4f8f4f4f8f4f4f8f4f4f8f4f5f8eeecf3e8e4eaebecf0eaebefe7ebeee9ebefeaebf0e6e8eceaebf1efeff7eeeef7eeedf6eeecf6eeebf6eeebf6eeeaf5eeeaf5eeeaf5eeeaf5f3f4f8f4f4f8f4f4f8f4f4f8f4f4f8f2f2f8e4e4e9e1e1e4e6e7eaf4f3f8f3f3f7f2f3f7f1f1f7f1f0f7f0eff7efedf6eeecf6eeebf6eeeaf5ede9f5ede8f5ede8f5ece7f5ece7f4f1f2f8f2f3f8f2f3f8f2f3f8f3f4f8f3f2f8e7e7ece5e5e9e7eaecececf0ececf0e9eaeee9e9eef0eff7f0edf6eeecf6eeebf6edeaf5ede8f5ece7f5ebe6f5ebe5f5ebe5f5ebe5f5eff1f8f0f2f8f0f2f8f1f2f8f1f3f8f1f1f7e2e2e6dfdfe3dfe0e3e3e3e6f2f2f6f1f0f6f1f0f7f0eef7efecf6eeebf6eeeaf5ede8f5ece7f5ebe5f5eae4f5eae3f5e9e2f4e9e2f4edf0f8eef0f8eef1f8eff1f8f0f2f8f0f0f7e8e8ede7e7ebe7eaece8e8ecececf0e8e8ededecf3f0eef7efecf6eeeaf6ede9f5ece7f5ebe5f5eae4f5e9e2f4e8e1f4e8e0f4e8e0f4ebeff7eceff8ecf0f8edf0f8eef1f8eeeff6dcdde3d9dadedcdce0ededf1f4f4f9f2f1f8f0eff7efedf6eeebf6eeeaf6ede8f5ece6f5ebe5f5e9e3f4e9e1f4e7dff4e7def3e6ddf3e9eef7eaeef7eaeef8eaeef8eaeff8ebedf6dfe1e8dcdfe5dde3e7e5e6ece8e9efe6e6ece4e5ece6e6ede5e5ede4e3ebe3e2ebe7e4f2e9e3f5e8e2f4e7e0f4e6def3e6ddf3e5dbf2e7edf7e6edf7e6edf7e6edf7e7edf8e8ecf5dce0e9dadee7dce0e8e8ecf3edeff7ecedf7ebecf6eaebf6e9e9f5e8e7f5e8e5f5e7e4f5e6e2f5e6e1f4e5dff4e4def3e4ddf3e4dcf3e3eaf7e2eaf8e2eaf8e3ebf7e4ebf7e4eaf4d8dde6d4dae3d7dbe4e3e7f0ebeff8eaedf7eaebf6e9eaf6e8e8f6e7e6f6e6e4f5e5e3f5e5e2f5e4e1f5e4dff4e4def4e3ddf3e3ddf3';
const SEARCH_DARK_HEX =
  '0a0e1310141a0f141b0e12190a101909111a09111b09121c09121d09131e09131e09131f09131f09131e09121e09121d09121c09111b0d141d2a30371d2229090f150b10160a0e13080c1020212820242c211c220f131a08101809111909111a09121b09121c09121c09121c09121c09121c09121b09111b09111a070f171a202787898c585b5f090e140f14180a0e120a0d10080c10080c11080e13090f15090f16080f16080f17091018091119091019091119091119091119091019091018091017090f17080e15050b11070c110a0e130a0d110a0d100a0c0e0a0d0f0a0d110a0e120a0e130d1117161b20181d2313181f0d121810161d0e131a0e141b0c12190910170a10160a0f160a0f150a0f140a0e130a0e120a0d110b0d100a0c0f0a0b0c0a0c0d0a0c0e0a0d100a0d110b0e121315160c0d0f0c0d0f0b0d0e0b0d0f0b0d0e0b0d0f0b0c0e0b0c0e0b0c0e0a0c0d0c0d0f0b0e130b0e130c0d120c0d110c0c110c0b0f0a0a0a0a0a0b0a0b0c0a0b0d0a0c0e090c0e0d0f110b0c0d0b0c0e0b0c0e0b0c0e0b0c0e0b0c0e0b0c0e0b0c0e0b0d0f0b0c0f0d0d100d0d130d0d130d0d120d0c110d0c110d0b100a0a0a0a0a0a0a0a0a0a0a0b090a0a1614161a15170a0c0e0a0d0f0a0d0f0a0d100b0d100b0e100b0d100c0d110c0d120d0d120d0d130e0c120e0c120e0c120f0c120f0c120f0b120a0a0a0a0a0a0a0a0a0a0a0a0909091110111915171111121212131014131112131112131516161212130c0b0f0d0c100e0c110e0c120f0c120f0c130f0c13100c14100b140f0b140a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0b0c1a1a1b1e1e1d1818180a0a0a0b0b0b0b0b0b0c0b0d0c0b0d0d0b0f0e0c100f0c120f0c13100c14100b14100b15100c15110c16110b160a0b0c0a0b0c0a0b0b0a0a0b0a0a0a0b0b0c1615161818181216141111111111111414141413150d0b0f0e0b100f0c12100c13100c14100b15110c16110c17120c18120c18120c180a0b0d0a0c0d0a0b0d0a0b0c0a0b0c0c0c0d1c1c1d1f1f1f1e1f1f1c1c1c0c0c0c0d0c0e0d0b0e0d0b0f0e0c110f0c13100c14100b15110c17120c18130c19130c1a130d1a130c1a0a0c0f0a0c0f0a0c0e0a0c0e0a0b0d0c0c0e141416151616121614161515121112151516100f120d0b100f0b12100c13100b14110b16120c18130c19140c1b140d1c150d1d150d1d0a0d100a0d100a0d100a0c0f0a0c0e0c0d0f1f202123242522222210101109090a0b0a0d0d0b0f0e0c110f0c130f0b14100b15110c17120c18130c1a140d1c150d1d160d1f160d1f0a0d120a0e120a0e120a0d120a0d110d0e11181a1d1b1c1f171b1b16161714131516161817161916151917151a18161b19161c140f1a130c1a140d1c150d1d160d1e170e20170e210a0e140b0f150b0f150b0f150b0e140e10141a1c201d1e221b1c201011140c0c100e0d120f0d140f0d15100d16110d17120e19130d1a140d1c150e1d150e1e160e1f170e20170e200a0e160a0f160a0e170a0f160b0e160d10151b1d231f21261e1f241314180c0c100e0c120e0d140f0c15100c17110d18110d19120d1b130e1c140e1d150e1e150e1f160e1f150d1f';

// Mobile (portrait) home, no search — spliced from screenshots 7/8.
const MOBILE_LIGHT_HEX =
  'e9eef7e8eef8dfe4f0d9e0eedae4f3d9e3f3dae1f1dde0f1dadff1dae5f7dbe7f8dae5f7d5e0f1dae6f7dbe6f8d6e1f2dde7f7dee8f7dae3f2e2eaf8e2eaf5dee5efe7edf7e9eef7eceff7ebf0f9e1e4f0dadfecdde5f1dbe4f2dee3f0e2e2f0dddfeee0e8f7e0eaf8dfe8f7d8e1efdee8f7e0e9f8d9e2efe0e9f7e1e9f7dde4f0e6edf8e5eaf5dfe3ede9eef7eceff8f0f2f8e9ecf3e5e8f0e5e9f1e6eaf3e5eaf3e1e7f0dee5efdfe6f0dee5f0e4ebf6e4ebf8e5ecf8e5ecf7e5ecf7e5ebf8e6ebf7e7edf7e9edf8e8ebf6eaecf7eceef8edeef7eeeff6f4f4f8f0f0f5edeef2edeef3edeff4eceef4eaecf2e8ebf1e8ebf2e8ecf3ecf0f8edf1f9edf1f9edf0f9eceff9edf0f9eef0f8eef0f8eeeef7efeff8efeff7f0eff7efedf5efecf5f4f3f8f7f7fafafafaf8f8f9f7f7f8f5f5f5f9f8f9f6f6f8f6f6f7fcfcfdfffffffefefffefefffffffffdfdfefbf9fdfaf8fbfaf9fcfbfafcfaf9fbf7f6f8f8f7f9f4f1f8ede9f4f3f3f8f3f3f8f3f4f8f4f4f8f4f4f8f4f4f8f3f3f8f4f4fae8e8eddddde1d3d2d8d6d5dcd5d4dad0ced5dfdbe4e5e0ecefebf6eee9f5ede7f3ece6f2ede7f4ece7f4ebe6f3ebe5f2eff1f8f0f2f8f0f2f8f1f2f8f2f3f8f3f3f8f0f0f5ebebefdcdce1cccbd1c8c8cdd3d2d7d0ced5c6c2cad0cdd6dad6e0e5e0ebeae4f0ede6f4ece6f5eae4f4e9e2f2e9e2f3e9e2f4eceff7ecf0f8ecf0f8e5ebf7dfe8f7dfe8f7e7edf7eff0f7ececf2eeeef2eeedf3edebf3f0ecf6eceaf3e8e5efe7e3edeae4f0e7e2efe3ddebe0dae9e4ddeee8e0f3e7def3e6def3e9eef7e8eef7e8eef7e3e9f4dbe2eedbe2eee2e7f2e6eaf2dfe1e8dddfe5dcdce4e0e0e9e2e2ebdedde7e1dfeadedbe7dfdceadcd9e8ddd9e9dad5e7e2dcefe5def3e5dcf3e5dcf3e2eaf8e2eaf8e2eaf8e3ebf8e4ecf8e5ecf8e6edf9e3e9f4e3e8f3e5eaf3e6eaf3e8ebf5eaecf7e5e6f2e3e4f1e4e4f3e5e4f5e4e3f5e5e3f6e5e2f5e4e0f5e4dff4e4def4e4def4dbe6f8dbe7f8dbe7f8dce7f8dde8f8dee9f9d1d9e5d4deeed6e0f2d6e0f3dce3f2dce2f0d5dceedbe1f3dde0efd3d9f1cdd4eecdd3eddbdcf3e3e2f5e2e1f5e3e1f5e3e1f5e4e1f5dbe7f8dbe7f8dbe7f8dce8f8dde8f8e3ecfadadee1dce3ebdee5eee1e7efdcdfe3dddfe3dce1e8e0e6f0dbdde2e1e6f2dce2edd8e0e9e6e9f7e5e7f7e5e6f6e5e6f6e6e6f6e7e7f6e8f0fbe8f0fbe9f0fbe9f1fbeaf1fbebf2fbecf3fceef4fcdfe3eadde2e8e5eaf1e6eaf1e7ebf1e9ecf2e8ebf2e5e8efeef1f8f1f4fcf0f3fbf0f2fbf0f2fbf0f3fbf1f3fbf1f3fbe7f0fce7f0fce8f0fce8f0fce8f0fbe9f1fceaf2fdebf2fde8eff9e7eef8dce2eaeaf0f8e7edf5d9dee5eaf0f8ebf1f9eff4fceff4fdeff4fceff3fceff3fcf0f3fbf0f3fbf1f4fce8f0fbe8f0fce8f0fce8f0fce8f0fce2eaf5dde4eedfe7f1e2eaf4e2e9f2dde3ede4ebf4e9eff9e0e6efe2e8f0e4eaf3e4e9f2e3e8f1e9eff7eff4fceff4fcf0f4fcf0f5fcf1f5fce9f1fce8f1fce8f0fce8f0fce8f0fce5ecf8e3ebf6e4ecf6e4ecf6e5ecf7e5edf7e5edf7e6eef8e7edf8e5ecf6e7eef7e7edf7e7eef6eaf0f8eef3fceef4fceff4fcf0f5fcf0f5fc';
const MOBILE_DARK_HEX =
  '0a0e13090e1413171e161b2310171f0f172111162011151e1216210a131e09131e09131e0f18230a131e09121e0f172209121c0a121b0f161f0910180b111810161c0b10160a0e130a0d11080c1116181e1a1d2412181f11181f12161d13131b1517200a111a08111a0a121b1119220b121c0a111a1118200b111a0c111a11161e090f160e121815181e0c0f130a0d110a0b0d0f11141215181014170e12160e121711161b12181d11161c11171d0b10180a10180a0f170a0f160b10170c10180c10180b0f160c0f150f10170e0f150b0d120c0d110e0e110a0a0a0e0f0f1112131012130f11120f11131113161214171214171113170c0f140b0e120b0e120c0e130e0f160d0e130c0e120d0e12110f150e0e130e0d12100e12120f13100d120a0a0a0b0b0b0c0c0c0e0d0d0f0f0f1111110d0d0d0f0f100f0f100a0a0b0707070908090808080707070909090e0c0e0f0d0f0d0c0d0c0b0d0d0c0d0f0e100e0d0f0f0c11110d140a0a0b0a0a0b0a0a0a0a0a0a0a0a0a0a0a0a0b0b0c0a090b1616172222232d2c2f2b292c2b292c302e31241f241e181f110c13120d15170f17171018130d16120d17150e18150f180a0b0d0a0c0d0a0b0d0a0b0c0a0b0b0b0a0b0e0d0e1212122221233332353736372b2a2c302d313d383d302b312421271b151d19121a140d17120c17150e1917101b160e1b140d1b0a0c100a0d100a0d100a10170a131d0b131d0b10160d0d10111112100f10100f10131013110d12120e141612181a141b17111917111b1b15201e17231b1320160e1d160e1e170e1f0a0e130a0e130a0e130d121813181f14192011141a111216191a1c1d1d1f201e211b191e19171c1e1a211c181f1e19221b17211f19241e1824201a27191221160e1f170e20170e210a0f170b0f170b0f170b0f170b0f160b0e150c0e150f1117111218111217121116111016100e1514111a15121c14111b130e1a140f1c130e1c140e1d150e1e160e20160e20160e200b111c0c121d0c121c0c111c0c111b0c111a0e121b0f121a0f11190f10180e0f15101017110f18110f181b1923221f2a13101c14101e140f1d140f1e140f1e150f1f150f1f150f1f0c121d0d131d0d131d0d121d0d121c0d111915171f16171e16171d13141914151916161a15151a14131917161c14131a17161c16141c120f19120f1b130f1b130f1b130f1b130f1b0b0f170c10170c0f160c0f160c0f150c0f140e0f150d0e141d1f231f202418181d18181c18181b14141714141817171b1010140e0d120e0d130e0d130e0d130e0d130e0c120e0c120c10170c10180c10170c10170c0f170c0f160c0e150c0e141011181112181c1d221011161313182020241010150f0f140d0c120c0c110d0c120d0d120d0d120d0c120d0c120d0c110c0f170c10170c10170d10170d0f1713151c181a2116181f14151c15161d1a1b2114141a10101619191f17171d15151b16161b16171c1111160d0d120d0d120d0d110c0c110c0c100c0f160d10170d10170d10170d101710131a13151c13141b12131b12131a12131a12131a11111811111913131a1212181212181212181010160d0d120d0d120d0d120d0d110c0c11';

// /download — dark hero panel with the desktop preview window. Neutral
// placeholder tones until sampled (scripts/sample-theme-matrices.ts).
const DOWNLOAD_LIGHT_HEX =
  'e9eef7e3e9f4dfe7f3e2e6f3e1e9f7dfe9f8dde8f8dce7f8dbe6f8dae6f8dae6f8d9e6f7d9e5f7dae6f8dae6f8dbe7f8dde7f8dfe9f9dbe4f2c3cbd6d5dce7e5edf7e6ecf6e9eef7ebf0f9dadeeacfd7e6dcd6e4e0e4f1e1ebf9e0e9f8dee8f8dde8f8dce7f8dce7f8dce7f8dbe7f8dce7f8dde7f8dee8f8dfe9f8e2ecfaccd3df707277acb1b8e7edf7e3e9f2eaeef8ebeff7ebf0f9eaf0f9e7eef9e5edf8e3ebf7e2eaf8e0eaf8dfe9f8dee8f8dee8f8dee8f8dee8f8dee8f8dfe9f8e0e9f8e1eaf8e2ebf8e5edf9e9f0fce9f0fae9eef8eaeff8ebeff8edf0f8ebeff8e7ecf5c3c7cfbdc2cabcc2cbbac0cabcc3cdbac1cbc1c9d4dfe8f6e0eaf8e0e9f8e0eaf8e1eaf8e2ebf8e3ebf8e4ecf7e6edf7e7edf8e9eef8e9eef8ebeff8edf0f8eff1f8edf0f8ebeff7e1e5eee1e6efe0e5eedee4eedee4efe2e8f4e6edf9e5edfae3ebf7e2ebf7e3ebf7e3ebf7e4ecf7e5ecf7e6edf8e8eef8e9eef8eaeef8ebeff7eceff8eef0f8f0f2f8eff1f8eef1f9e8eaeadbdfdedaddddd7d7d8d5dcdfd6dde1d5dbdfdcdfe0e7edf7e5ecf7e5ecf7e6edf7e6edf7e7edf8e8eef8e9eef8eaedf7eaedf7eceef7edeff7eff0f7f2f3f8f1f2f8f1f4fad3d0cbdbdfe4dde2eadee3eadde4eddfe7f0dee5edc9c5c2e8ecf4e8eef8e8edf7e8edf8e8eef8e8edf8e9edf7eaedf7eaedf7ebedf7ededf7eeeef7f0eff7f4f4f8f3f3f8f5f6fbbcbab9e9e9eeeeeef5edeff6eef0f7eeeff8eeedf7bfbbbbe8ecf4eaeff8eaeef8eaeef8eaeef8eaedf7eaecf7ebecf7ebecf7ececf6eeedf6efedf6f0eef7f4f4f8f4f4f8f8f8fd9f9f9de3e3e8f5f5f9f4f4f8f1f0f7eeeaf5ece6f59b9899e8ecf1edf0f8edf0f8eceff7eceef7ecedf7ececf6ececf7edecf6edecf6eeecf6efecf6efecf6f4f4f8f4f4f8f9f9fd969995d8dee6edf0f8eff1f8ecebf6e9e5f5e5def49e988fecedf1f0f2f8eff0f8eeeff7eeeef7ededf7edecf6eeecf6eeebf6eeebf6eeebf6eeebf6efebf6f4f4f8f4f4f8f6f6facccecbdfe3e9eef2f8f0f3f8f0f1f8efeff8eeedf7d3d3d0f1f2f5f2f2f8f1f1f7f0eff7efeef7efedf6efecf6eeebf6eeebf6eeeaf5eeeaf5eee9f5eee9f5f4f4f8f4f4f8f5f5f9e9e9ecdcdcdeeeeef0eff0f1eff0f1eeeff0eff1f2f4f5f8f4f4f9f3f2f7f2f1f7f1eff7f0edf6efecf6eeebf6eeeaf5eee9f5ede8f5ede8f5ede7f5ede8f5f2f3f8f2f3f8f4f4f9e9e9ecd9dadcd8d9dbdbdcdef0f1f3f1f2f4f2f3f5f3f4f6f4f3f8f2f1f7f1f0f7f0eef7efecf6eeebf6eeeaf5eee9f5ede8f5ece7f5ece6f4ebe6f5ece6f5f1f2f8f1f2f8f8f9fdaaabac5b5b5c61626269696ae3e4e6f8f9fbf5f6f8f5f6f8f3f3f7f2f0f7f1eff7f0edf6efebf6eeebf6eee9f5ede8f5ece7f4ebe5f5ebe5f5eae4f5eae4f5eff1f8eff1f8f0f2f8edeff4e8e9ede8e9edeaebeff4f4f7f4f4f8f4f4f8f4f4f8f2f2f7f1f0f7f0eef7efecf6eeebf6eeeaf5ede8f5ece7f5ebe5f5eae4f5eae3f5e9e2f4e9e2f4eef0f7eef0f8eef0f7eff1f8f1f3f9f2f3f9f3f4f9f3f3f8f3f3f8f3f3f8f2f2f7f1f0f7f0eef7efedf6eeebf6edeaf5ede9f5ece7f4ebe5f4eae4f5e9e2f4e9e1f4e8e0f4e8e0f4';
const DOWNLOAD_DARK_HEX =
  '0a0e130f131a0f151b0e121a0a111909111a09111b09121c09121d09131e09131e09131f09131f09131e09121e09121d09121c08111a0f161f2b3138191f26090f150b10160a0e13080c111d1e2521262e201c2311141c08101809111a09111b09121c09121c09121d09121d09121d09121d09121c09121c09111b070f1821282f8c8e91494d52090e140f13180a0e120a0d11080d11080d12090f15090f160910170910180910190a111a0a121b09121b09121b09121b09111b09111a09111a091019091018080e16050b12070c130a0f140a0e120a0d110a0c100a0d110d101532363a373b40363b40373c4234393f363c422d333a0b121b091119091119091119091019091018091017090f16090f160a0f150a0f140a0e120a0d110a0d100a0c0e0a0d100a0e1113171a13161b14181d15191f13181e0f141a0a1016090f160910170a10170a10170910170a10160a0f160a0f150a0f140a0e130a0e120a0d110a0d100b0c0f0a0b0d0a0c0e0a0c0f1b203020273b1b2234171c2c192033171d2f191c2f191c2d0c11190a10150a10160a10160a0f150a0f140a0f140b0e130b0e130b0d120b0d110b0c100c0c0f0a0a0b0a0b0c0a0c0f1e2233151b2413192210151e1016200d131b0e121b1b1e2d0e11190a0f140a0f140b0f140a0e130b0e130b0e130c0e130c0d130c0d130c0c110c0c110d0c100a0a0a0a0a0b0b0c0e1617230a0b0c0f0f110d0f110c0e100c0c110d0b111b1b290e11180a0e110a0e120a0e120b0e120c0e130c0e130c0d130d0d130d0d120d0c120d0c110e0b100a0a0a0a0a0a0b0b0d12141c0a0b0c0a0a0a0a0a0a0d0b0e0f0b13120c1714141f0d10150a0d0f0a0d100b0d110c0d110c0d120d0d120d0d130e0c120e0c120e0c120f0c110f0c120a0a0a0a0a0a0b0b0c10131a090d100b0c0f0b0b0d0e0b11110c17150c1c191c230d0f130a0c0d0b0c0f0c0c100c0c110d0c110e0c120e0c120f0c120f0c130f0c130f0c13100c130a0a0a0a0a0a0b0b0b1a1d281b1d2b141624141522151423171525181527191b290d0e110a0b0b0b0b0e0c0b0f0d0b100e0c110f0c120f0c13100c130f0b140f0b14100b14100b140a0a0a0a0a0a0a0a0a2727373333452121342020332020342021341f20331d1d300d0d100b0a0b0c0b0d0d0b0f0e0b100e0b110f0c13100c13100b14100b15100b15110b16110c160a0a0b0a0b0b0a0a0b2222323232443333443131421e1e321d1d301d1d301c1c2f0d0d110b0a0c0c0b0e0d0b100e0b110f0c13100b13100b14100b15110c16110c17120c17120c180a0b0c0a0b0c0505085f5f6aadadb3a7a7ada0a0a72b2b3e18182d1a1a2f1a1a2e0e0d120c0a0d0d0b0f0e0b100f0c12100c13100b14100b15110c17120c18120c18130c19130c190a0b0d0a0c0d0a0b0d13141a1a1a21191a2018191e1010171010161010161010160c0c0e0c0b0e0d0b100e0c110f0c13100b14100c15110c17120c18130c19130c1a140c1b140d1b0a0c0e0a0c0e0a0c0e090a0c08090b08090a080909090a09090a0a090a0a0a0a0b0b0b0e0c0c100d0c110e0c130f0c140f0b15100c16110c17120c19130c1a140c1b140d1c150d1d';

// /download with the PWA "Install web app" card mounted (Chromium after
// beforeinstallprompt) — the extra card reshapes the card row. Neutral
// placeholder tones until sampled (scripts/sample-theme-matrices.ts).
const DOWNLOAD_INSTALL_LIGHT_HEX =
  'e9eef7e3e9f4dfe7f3e2e6f3e1e9f7dfe9f8dde8f8dce7f8dbe6f8dae6f8dae6f8d9e6f7d9e5f7dae6f8dae6f8dbe7f8dde7f8dfe9f9dbe4f2c3cbd6d5dce7e5edf7e6ecf6e9eef7ebf0f9dadeeacfd7e6dcd6e4e0e4f1e1ebf9e0e9f8dee8f8dde8f8dce7f8dce7f8dbe7f8dbe7f8dce7f8dde7f8dee8f8dfe9f8e2ebfaccd3df707277acb1b8e7edf7e3e9f2eaeef8ebeff7ebf0f9eaf0f9e7eef9e5edf8e3ebf7e2eaf8e0eaf8dfe9f8dee8f8dee8f8dee8f8dee8f8dee8f8dfe9f8e0e9f8e1eaf8e2eaf8e5edf9e9f0fce9f0fae9eef8eaeff8ebeff8edf0f8ebeff8e7ecf5c3c7cfbdc2cabcc2cbbac0cabcc3cdbac1cbc1c9d5dfe8f6e0eaf8e0e9f8e0eaf8e1eaf8e2eaf8e3ebf8e4ecf7e6ecf7e7edf8e9eef8e9eef7ebeff8edf0f8eff1f8edf0f8ebeff7e1e5eee1e6efdfe5eedee4eedee4efe2e8f4e6edf9e5edfae4ecf9e3ebf8e4ecf8e5ecf8e5edf8e6edf8e7eef8e8eef8e9eff8eaeef8ebeff7eceff8eef0f8f0f2f8eff1f8eef1f9e8eaeadcdfdddadeddd7d6d6d4dadcd5dce0d4dbdfd4d9dce2e5e8e6ecf6dfe5f1e2e6f1e4e7f2e5e8f2e8e9f2eaeaf3ebeaf3eeeef5eceff7edeff7eff0f7f2f3f8f1f2f8f1f3fad4d1ccd8dce1d9e0e9dae0e8d8e0eadbe4eddbe4eed2d6dad1cecbe2e7f4ced4e9d4d8ead9daebdee0f1e1deeee5e0ede8e0ebede8eeedeef7eeeef7f0eff7f4f4f8f3f3f8f5f6fbbab9b9e0e4ece5e9f4e2e6f1e6edf8e8eff9eaf0fbdbdde3cac8c6e7eaf6d6d9eadcdcedddd8e5d4a6aae8daddeae2ecebe0e5eee7eaeeeef7efedf6f0eef7f4f4f8f4f4f8f8f8fda4a3a0dee0e6e6ebf4dce2ebe6ecf5e8eef8edf0fad0d0d6adadacedeef8dddcece4e0efd5d8df8ea687eddbc6ece1e7eddfddefe7e6efedf7efecf6efecf6f4f4f8f4f4f8fafafe909290dedfe3eceef4dfe2e9e7eaf2eceef8efeffacecccfaaa89ef0f0fae3dfede8e1edeae1eae6dfdbede0e0eddfdbeeddd4f1e6e1efecf7eeebf6efebf6f4f4f8f4f4f8f8f8fcafb1a9e7e7e9f1f1f5e9eaeeeeeff4f0f0f7f2f0f9d9d6d9c0bfb5f4f2faebe5efede5ebede4e7efe4e5efe3e0f0e3dcf1e1d6f2e8e2eeebf7eee9f5eeeaf5f4f4f8f4f4f8f5f5f9e4e5e7dcdddff3f4f6f4f5f7f3f4f6f3f4f6f3f4f6f3f4f6f5f6f8e7e8eae8e9ebf5f6f8f4f4f6f3f4f6f3f4f5f3f4f6f3f4f6f4f3f6ede9f5ede8f5ede8f5f2f3f8f2f3f8f3f4f8f0f0f3e9eaececedeff0f1f3eff0f2ecedefeeeff0ededeff4f5f8eff0f3ebeceeecedefe7e8eaebeceeecedefedeef0edeef0f2f2f5ece7f5ece6f4ece6f5f1f2f8f1f2f8f6f7fcbdbec08282838687878e8e8fe9eaecf7f9fbf6f7f9f6f7f9f9f9fccdcdd0838485838384bebfc0fafbfcf6f7f9f6f7f9f6f7f9f4f5f7ebe5f5ebe4f5ebe4f5eff1f8f0f2f8f3f5fbcdced1a2a3a5a5a6a8aaabadececeff6f6f9f5f5f8f4f5f8f7f7fad8d7dba3a3a5a3a2a5cecdd1f7f6faf3f2f7f3f2f7f2f2f7f1f0f6eae4f5eae2f4eae2f5eef0f7eef0f7eff1f8f3f5fbf8f9fff9fafff9fafff5f5f9f4f4f8f4f4f8f3f3f8f2f1f7f4f2faf8f5fef7f3fef2eef9ede9f5ece7f4ebe6f4eae4f5e9e2f4e9e1f4e8e1f4e8e1f4';
const DOWNLOAD_INSTALL_DARK_HEX =
  '0a0e130f131a0f151b0e121a0a111909111a09111b09121c09121d09131e09131e09131f09131f09131e09121e09121d09121c08111a0f161f2b3138191f26090f150b10160a0e13080c111d1e2521262e201c2311141c08101809111a09111b09121c09121c09121d09121d09121d09121d09121c09121c09111b070f1821282f8c8e91494d52090e140f13190a0e120a0d11080d11080d12080f15090f160910170910180911190a111a0a121b09121b09121b09121b09111b09111a09111a091019091018080e16050b12070d130a0f140a0e120a0d110a0d100a0d110d101532363a373b40363b40373c4234393f363c422d333a0b121b091119091119091119091119091018091017090f16090f160a0f150a0f140a0e120a0d110a0d100a0c0e0a0d100a0e1113171a13161a14181c15191f13181e0e141a0a1016090f160910170a10170a10170910160a10160a10150a0f150a0f140a0f130a0e120a0d110a0d100a0c0f0a0b0d0a0c0e0a0c0f1b203120283b1d2437181c2c192033192033181c2f1a1d3115182613162415182b15182a16172a17172a1717291716291816291615250c0e120b0c100c0c0f0a0a0b0a0b0c0a0c0e1f2436171e29131b261017201118230f16210d131e131723191c2b15172a1719341818331917321413301a14311d15311f15321d162c0d0d130c0c100d0c100a0a0a0a0a0b0b0c0e151724090e130f131910161c0b1118091016090e140e12191a1c2a1516291917321916311f18316737432f1f301e143024163220172c0d0d130d0c100e0b100a0a0a0a0a0a0b0b0d1517200a0e120f141a191f2510151b0c11170a0f140c0f141316201716291b16321b14301d1f336d856a4934312113312a183224182d0e0c130e0b110f0c120a0a0a0a0a0a0b0b0d0f1218090b0d101317171c210d12160d11150b0d120d0f12151a1e1715281c15311e1430201530261c2e2818312c1932301a3327192d0f0d140f0c13100c130a0a0a0a0a0a0b0b0c13161e0c0d11121419181b211012190f11180f0f17121319161c211714261e15302017302318302618312919312c1a31301b32271a2d0f0c150f0b14100b140a0a0a0a0a0a0a0a0a2727363131431c1c2f1b1b2f1b1b2f1c1c2f1b1b2f1c1c3015152423233126263a1a1a2e1b1b2f1c1c2f1c1c2f1c1c2f1c1c2f1a182b110c16100b15110c160a0a0b0a0a0b0b0b0c1c1c2c2323362020331c1c301f1f322121342020332121351717261a1a282121342020322424372222352121342121342020331a1a2c110c17110c17120c170a0b0c0a0b0c0607094d4d5988889283838d7c7c8726263918182d1a1a2f1a1a301313233d3c488686908787904e4e5e16162b1a1a2e1a1a2e1a1a2e19182b120d19120c19130c190a0b0d0a0b0d07090b393a4464646c6161685d5d651f1f2d15152416162517162611111d2f2e3864646c64636c3c3b48151325181728181728181729181527130d1a130c1a140d1b0a0c0e0a0c0e0a0c0e0608090203060304050303040909090a0a0a0a0a0a0a0a0a0b0a0c0a080b06030907040a0c080f100b14100b15110b17120c18130c1a140c1b140c1c140d1c';

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
  skyT: 0.762,
  skyB: 0.927,
};
const DETAILS_ANCHORS: PageAnchors = {
  colL: 0.025,
  colR: 0.963,
  header: 0.107,
  hero: -1,
  skyT: 1.966,
  skyB: 2.131,
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
  skyT: 0.642,
  skyB: 0.751,
};
const DOWNLOAD_ANCHORS: PageAnchors = {
  colL: 0.031,
  colR: 0.969,
  header: 0.107,
  hero: -1,
  skyT: 1.886,
  skyB: 2.051,
};
const DOWNLOAD_INSTALL_ANCHORS: PageAnchors = {
  colL: 0.031,
  colR: 0.969,
  header: 0.107,
  hero: -1,
  skyT: 1.914,
  skyB: 2.079,
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
