import { useRouterState } from '@tanstack/react-router';
import { useLayoutEffect, useRef } from 'react';

import { isDetailsPath, prefersReducedMotion } from '../utils';

/**
 * Page-content transition for the browsers that can't run the real morph. On non-Chromium
 * engines `browser-init.ts` shims `document.startViewTransition` to a no-op — WebKit + Gecko
 * render `backdrop-filter` bare inside a view-transition snapshot, glitching the frosted header
 * mid-morph. So instead of snapshotting the page we slide ONLY the content container via the
 * Web Animations API: the sticky header + its blur layer are siblings, never touched, so the
 * live blur keeps rendering. Chrome/Edge keep the real VT morph and skip this. Web-only.
 *
 * Scope + direction mirror router.tsx's resolver so the two engines stay in lockstep: we animate
 * ONLY the home<->details pair (logo->home, /download, everything else stays instant), and the
 * direction is intrinsic to it — into a company reads as forward (enter from the right), back to
 * the listing as back (from the left). The empty home hero is skipped: its `.streaks` backdrop
 * is position:fixed, so a transform on the wrapper would become its containing block and mis-place
 * it — home animates only when it's the results list. Pure slide, no fade: the incoming page is
 * solid over the app glow, native push/pop style (enter-only — a true two-panel slide needs the
 * outgoing page's pixels, which is the VT snapshot we can't use here).
 */
export default function PageContentTransition({
  contentRef,
}: {
  contentRef: React.RefObject<HTMLDivElement | null>;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({
    select: (s) => (s.location.search as { search?: string }).search ?? '',
  });
  const prevPath = useRef<string | null>(null);
  const anim = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const from = prevPath.current;
    prevPath.current = pathname;
    if (from === null || from === pathname) return; // mount + search-only updates on `/`: instant

    // The exact pair router.tsx morphs; direction falls straight out of it (to `/` = back).
    const back = pathname === '/';
    const withinPair =
      (from === '/' && isDetailsPath(pathname)) ||
      (isDetailsPath(from) && back);
    if (!withinPair) return;
    // Empty hero carries the position:fixed `.streaks` grid — never slide onto it.
    if (back && search.length === 0) return;

    const root = document.documentElement;
    if (root.hasAttribute('data-desktop')) return; // native shell / preview run their own thing
    const browser = root.getAttribute('data-browser');
    if (browser === 'chrome' || browser === 'edge') return; // Blink runs the real VT morph
    if (prefersReducedMotion()) return;

    const el = contentRef.current;
    if (!el) return;

    // Slide scales with viewport (capped); body has overflow-x:hidden so the offset adds no scrollbar.
    const dist = Math.min(Math.round(window.innerWidth * 0.22), 96);
    const offset = back ? -dist : dist;

    anim.current?.cancel(); // supersede an in-flight slide on a rapid re-nav
    anim.current = el.animate(
      [{ transform: `translateX(${offset}px)` }, { transform: 'none' }],
      // fill:backwards holds the pre-start offset; no forwards fill (end state = natural transform:none).
      // Back reads as "returning" — keep it a touch snappier than the forward push.
      {
        duration: back ? 220 : 320,
        easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
        fill: 'backwards',
      },
    );
  }, [pathname, search, contentRef]);

  return null;
}
