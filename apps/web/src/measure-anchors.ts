/**
 * Layout-anchor measurement shared by the theme transition (live values at
 * toggle time) and scripts/sample-theme-matrices.ts, which injects this exact
 * function into the sampled page via `measureAnchors.toString()` — one
 * implementation, so reference and live anchors can never drift. Keep the
 * function fully self-contained: no imports, no outer-scope references.
 */

export type PageAnchors = {
  colL: number;
  colR: number;
  header: number;
  hero: number;
  skyT: number;
  skyB: number;
};

/** Layout anchors as viewport fractions (-1 = landmark missing). */
export function measureAnchors(): PageAnchors {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = (sel: string) =>
    document.querySelector(sel)?.getBoundingClientRect() ?? null;
  const wrap = rect('.page-wrap');
  const head = rect('header');
  const hero = rect('[data-hero-stat]');
  const sky = rect('[data-london-skyline]');
  return {
    colL: wrap ? wrap.left / vw : -1,
    colR: wrap ? wrap.right / vw : -1,
    header: head ? head.bottom / vh : -1,
    hero: hero ? (hero.top + hero.bottom) / 2 / vh : -1,
    skyT: sky ? sky.top / vh : -1,
    skyB: sky ? sky.bottom / vh : -1,
  };
}
