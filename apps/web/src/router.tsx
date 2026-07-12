import { QueryClient } from '@tanstack/react-query';
import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';

import { routeTree } from './routeTree.gen';
import { prefersReducedMotion, stampPageFlip } from './utils';

/** Whether the pathname is a company-details page. */
function isDetailsPath(pathname: string) {
  return pathname.startsWith('/company/');
}

/*
 * Edge-swipe tracker for the pop-navigation transitions below: an iOS
 * edge-swipe back/forward plays the native page-slide, so running our view
 * transition on the popstate that follows would animate twice. A touch
 * starting near a screen edge marks the next pop (while held + a grace
 * window after release) as gesture-driven. Best effort — WebKit sometimes
 * swallows the touchstart when the system gesture claims it.
 */
const EDGE_TOUCH_PX = 40;
const EDGE_GESTURE_GRACE_MS = 1000;
let edgeTouchActive = false;
let edgeGestureEndedAt = 0;
if (typeof window !== 'undefined') {
  const onEdgeTouchEnd = () => {
    if (!edgeTouchActive) return;
    edgeTouchActive = false;
    edgeGestureEndedAt = Date.now();
  };
  window.addEventListener(
    'touchstart',
    (e) => {
      const x = e.touches[0]?.clientX ?? Number.NaN;
      if (x <= EDGE_TOUCH_PX || x >= window.innerWidth - EDGE_TOUCH_PX) {
        edgeTouchActive = true;
      }
    },
    { capture: true, passive: true },
  );
  window.addEventListener('touchend', onEdgeTouchEnd, {
    capture: true,
    passive: true,
  });
  window.addEventListener('touchcancel', onEdgeTouchEnd, {
    capture: true,
    passive: true,
  });
}

/*
 * Gate for `defaultViewTransition`: the router only evaluates the `types`
 * resolver when the browser supports `:active-view-transition-type()`
 * (its own CSS.supports check). Without support (e.g. iOS Safari < 18.2)
 * an object default would run an UNTYPED transition for EVERY navigation
 * — including each search keystroke — so those browsers get no default
 * at all: pops stay instant there, explicit navs keep their handler-side
 * stamps.
 */
const supportsTypedViewTransitions =
  typeof window !== 'undefined' &&
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('selector(:active-view-transition-type(a))');

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
  // The native swipe animation already ran — don't animate twice.
  if (
    edgeTouchActive ||
    Date.now() - edgeGestureEndedAt < EDGE_GESTURE_GRACE_MS
  )
    return false;
  if (toLocation.state.__TSR_index < fromLocation.state.__TSR_index) {
    stampPageFlip('back');
    return ['back'];
  }
  if (isDetailsPath(to)) {
    // Re-arm the click morph: name the origin card (when still rendered —
    // the virtualized listing may have scrolled it out, then this is a
    // no-op and the details content just fades in). A direct DOM write,
    // not React state: it must land synchronously before the OLD snapshot
    // capture, and the node unmounts with the navigation anyway. The
    // sweep first clears any stale inline name so the transition can't
    // abort on duplicate `active-card` regions. Safari strips the name
    // via its [style*=…] override and keeps its root slide.
    for (const el of document.querySelectorAll<HTMLElement>(
      '.page-flip-listing a[style*="view-transition-name"]',
    )) {
      el.style.removeProperty('view-transition-name');
    }
    document
      .querySelector<HTMLElement>(`.page-flip-listing a[href^="${to}"]`)
      ?.style.setProperty('view-transition-name', 'active-card');
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
