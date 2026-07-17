import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

/**
 * A progressive backdrop-blur pinned to the top that fades page content into the
 * transparent Electron title bar as it scrolls up. Native shell only: gated on
 * the preload's `isSponsorSearchDesktop` flag, so it never renders on the web
 * (which has its own sticky header) nor in the /download preview (which stamps
 * `data-desktop` but isn't the real shell). Its opacity is driven entirely by a
 * CSS scroll-timeline (styles.css), so the blur tracks scroll on the compositor
 * with no scroll listener and no perceptible lag. Renders nothing until mounted
 * in the shell, so SSR stays inert.
 *
 * Keyed on the router location so every navigation remounts the element: when a
 * nav lands on a non-scrollable page (e.g. the logo → empty home from a scrolled
 * inner page) Chromium keeps the scroll timeline's last opacity instead of
 * resetting to 0, leaving a stale blur; a fresh element re-evaluates to 0.
 * Scrolling doesn't change the href, so this never remounts mid-scroll.
 */
export default function DesktopScrollMask() {
  const [active, setActive] = useState(false);
  const href = useRouterState({ select: (s) => s.location.href });
  useEffect(() => {
    if (window.isSponsorSearchDesktop) setActive(true); // native shell only
  }, []);

  if (!active) return null;
  return <div key={href} aria-hidden="true" className="desktop-scroll-mask" />;
}
