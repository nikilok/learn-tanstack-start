import { useRouterState } from '@tanstack/react-router';
import { useLayoutEffect, useRef } from 'react';

import { prefersReducedMotion } from '../utils';

/**
 * Page-content transition for the browsers that can't run the real morph. On non-Chromium
 * engines `browser-init.ts` shims `document.startViewTransition` to a no-op — WebKit + Gecko
 * render `backdrop-filter` bare inside a view-transition snapshot, which glitches the frosted
 * header mid-morph. So instead of snapshotting the whole page, we animate ONLY the content
 * container (via the Web Animations API) on each real page nav: the sticky header + its blur
 * layer are siblings, never touched, so the live blur keeps rendering. Chrome/Edge keep the
 * real VT morph and skip this (no double-animation). Web-only, page-navs only (a pathname
 * change — search-param updates on `/` stay instant), reduced-motion respected.
 *
 * The motion is a directional slide echoing native iOS push/pop: forward (history index up)
 * enters from the right, back (index down) from the left, with a fade so the enter reads
 * cleanly over the app glow (it's enter-only — a true two-panel slide would need the outgoing
 * page's *pixels*, which is exactly the VT snapshot we can't use here).
 */
export default function PageContentTransition({
  contentRef,
}: {
  contentRef: React.RefObject<HTMLDivElement | null>;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // TanStack's monotonic history index (same field router.tsx keys pop direction off): a lower
  // index on a nav is provably a back traversal.
  const index = useRouterState({
    select: (s) =>
      (s.location.state as { __TSR_index?: number }).__TSR_index ?? 0,
  });
  const prevPath = useRef<string | null>(null);
  const prevIndex = useRef(0);
  const anim = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const first = prevPath.current === null;
    const changed = prevPath.current !== pathname;
    const back = index < prevIndex.current;
    prevPath.current = pathname;
    prevIndex.current = index;

    if (first || !changed) return; // initial mount + search-param updates: no animation

    const root = document.documentElement;
    if (root.hasAttribute('data-desktop')) return; // native shell / preview run their own thing
    const browser = root.getAttribute('data-browser');
    if (browser === 'chrome' || browser === 'edge') return; // Blink runs the real VT morph
    if (prefersReducedMotion()) return;

    const el = contentRef.current;
    if (!el) return;

    // Slide distance scales with viewport (capped) so it reads on phones and desktop alike;
    // body has overflow-x:hidden, so the off-screen start never adds a horizontal scrollbar.
    const dist = Math.min(Math.round(window.innerWidth * 0.22), 96);
    const from = back ? -dist : dist;

    anim.current?.cancel(); // supersede an in-flight enter on a rapid re-nav
    const running = el.animate(
      [
        { opacity: 0, transform: `translateX(${from}px)` },
        { opacity: 1, transform: 'none' },
      ],
      // Back reads as "returning" — keep it snappier than the forward push.
      {
        duration: back ? 220 : 320,
        easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
        fill: 'both',
      },
    );
    anim.current = running;
    running.finished
      .then(() => {
        if (anim.current === running) {
          running.cancel(); // release fill:both once settled (final = natural state)
          anim.current = null;
        }
      })
      .catch(() => {});
  }, [pathname, index, contentRef]);

  return null;
}
