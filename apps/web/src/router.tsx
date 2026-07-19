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

// Page morphs only run on Blink. browser-init.ts neutralises
// `document.startViewTransition` on every non-Chromium engine (WebKit + Gecko
// can't composite backdrop-filter in a VT snapshot), so the resolver below is
// Blink-gated — running it on Safari/Firefox is pure wasted per-pop DOM work the
// shim discards. This also retires the old iOS edge-swipe gesture guard: it kept
// a Safari swipe-back from double-animating a real transition, but Safari now
// runs no app transition at all, so there is nothing to double.
const isBlink =
  typeof document !== 'undefined' &&
  (document.documentElement.getAttribute('data-browser') === 'chrome' ||
    document.documentElement.getAttribute('data-browser') === 'edge');

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
  if (!pathChanged || !fromLocation) return false;
  const from = fromLocation.pathname;
  const to = toLocation.pathname;
  const withinPair =
    (from === '/' && isDetailsPath(to)) || (isDetailsPath(from) && to === '/');
  if (!withinPair) return false;
  if (prefersReducedMotion()) return false;
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
    // Blink-only: browser-init.ts shims `document.startViewTransition` to a no-op on every
    // non-Chromium engine (WebKit + Gecko can't composite backdrop-filter in a VT snapshot,
    // which broke the frosted header mid-morph), so gating the resolver off there avoids
    // running its per-pop DOM work for a transition that never plays.
    ...(supportsTypedViewTransitions && isBlink
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
