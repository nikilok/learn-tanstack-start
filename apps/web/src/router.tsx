import { QueryClient } from '@tanstack/react-query';
import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';

import { routeTree } from './routeTree.gen';
import { isDetailsPath, prefersReducedMotion, stampPageFlip } from './utils';

// Gate: without :active-view-transition-type() the router runs UNTYPED
// transitions for every nav (search keystrokes included) — see CLAUDE.md.
const supportsTypedViewTransitions =
  typeof window !== 'undefined' &&
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('selector(:active-view-transition-type(a))');

// iOS edge-swipe pops already play the native slide; iOS-only (data-browser
// covers every iOS engine, and Android/desktop gestures have no native
// slide to double). Sampled at popstate — the resolver can run seconds
// later behind a loader. Best effort: WebKit may swallow the touch events.
const EDGE_TOUCH_PX = 24;
const EDGE_POP_WINDOW_MS = 1500;
let lastPopWasGesture = false;
if (
  supportsTypedViewTransitions &&
  document.documentElement.getAttribute('data-browser') === 'safari'
) {
  const edgeTouchIds = new Set<number>();
  let lastEdgeTouchAt = Number.NEGATIVE_INFINITY;
  window.addEventListener(
    'touchstart',
    (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const x = e.changedTouches[i].clientX;
        // Layout-viewport width: innerWidth shrinks under pinch zoom.
        const width = document.documentElement.clientWidth;
        if (x <= EDGE_TOUCH_PX || x >= width - EDGE_TOUCH_PX) {
          if (edgeTouchIds.size >= 10) edgeTouchIds.clear();
          edgeTouchIds.add(e.changedTouches[i].identifier);
          lastEdgeTouchAt = performance.now();
        }
      }
    },
    { capture: true, passive: true },
  );
  // End/cancel of an edge-started touch refreshes the window (long holds).
  const onEdgeTouchDone = (e: TouchEvent) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (edgeTouchIds.delete(e.changedTouches[i].identifier)) {
        lastEdgeTouchAt = performance.now();
      }
    }
  };
  window.addEventListener('touchend', onEdgeTouchDone, {
    capture: true,
    passive: true,
  });
  window.addEventListener('touchcancel', onEdgeTouchDone, {
    capture: true,
    passive: true,
  });
  window.addEventListener('popstate', () => {
    lastPopWasGesture =
      performance.now() - lastEdgeTouchAt < EDGE_POP_WINDOW_MS;
  });
}

/**
 * Resolves transition types for navigations without an explicit
 * `viewTransition` — in practice browser back/forward pops. Animates only
 * the home ↔ details pair; anything else (search-param updates, /download,
 * header-logo pushes) stays instant. Direction comes from the history
 * index (a decreasing index is provably a back traversal); stamps
 * `data-page-flip` for the Safari rules in transitions.css.
 */
function resolvePopTransitionTypes({
  fromLocation,
  toLocation,
  pathChanged,
}: {
  fromLocation?: { pathname: string; state: { __TSR_index: number } };
  toLocation: { pathname: string; state: { __TSR_index: number } };
  pathChanged: boolean;
}): Array<string> | false {
  const popWasGesture = lastPopWasGesture;
  lastPopWasGesture = false;
  if (!pathChanged || !fromLocation) return false;
  const from = fromLocation.pathname;
  const to = toLocation.pathname;
  const withinPair =
    (from === '/' && isDetailsPath(to)) || (isDetailsPath(from) && to === '/');
  if (!withinPair) return false;
  if (prefersReducedMotion()) return false;
  // The native swipe animation already ran — don't animate twice.
  if (popWasGesture) return false;
  // An error screen at a pair URL (RouteError renders in place) pops instantly.
  const oldPageMarker = isDetailsPath(from)
    ? '.page-flip-details'
    : '.page-flip-listing';
  if (!document.querySelector(oldPageMarker)) return false;
  // Sweep stale inline names (e.g. from a cmd+click) in BOTH directions so a
  // leftover card can't pair — duplicate `active-card` aborts the transition.
  for (const el of document.querySelectorAll<HTMLElement>(
    '.page-flip-listing a[style*="view-transition-name"]',
  )) {
    el.style.removeProperty('view-transition-name');
  }
  if (toLocation.state.__TSR_index < fromLocation.state.__TSR_index) {
    stampPageFlip('back');
    return ['back'];
  }
  if (isDetailsPath(to)) {
    // Re-arm the click morph via a direct DOM write (must land before the
    // OLD snapshot capture; the node unmounts with the nav) — see CLAUDE.md.
    // CSS.escape guards decoded quotes; encoded hrefs then simply not match.
    const anchor = document.querySelector<HTMLElement>(
      `.page-flip-listing a[href^="${CSS.escape(to)}"]`,
    );
    if (anchor) {
      // Only when actually in view: overscan keeps off-viewport rows mounted,
      // and a morph from an off-screen bbox streaks and covers the header.
      const rect = anchor.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < document.documentElement.clientHeight) {
        anchor.style.setProperty('view-transition-name', 'active-card');
      }
    }
    stampPageFlip('forward');
    return ['forward'];
  }
  // Forward-index motion landing on home (e.g. the header-logo push): keep
  // it instant, matching pre-pop-animation behaviour.
  return false;
}

/**
 * Build the TanStack Router instance with a shared QueryClient (5 min
 * staleTime, 10 min gcTime), intent-based preloading, and SSR-aware query
 * integration. Called once per request on the server and once on client
 * bootstrap.
 */
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
      },
    },
  });

  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    context: { queryClient },
    ...(supportsTypedViewTransitions
      ? { defaultViewTransition: { types: resolvePopTransitionTypes } }
      : {}),
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
