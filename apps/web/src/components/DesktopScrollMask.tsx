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
 */
export default function DesktopScrollMask() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (window.isSponsorSearchDesktop) setActive(true); // native shell only
  }, []);

  if (!active) return null;
  return <div aria-hidden="true" className="desktop-scroll-mask" />;
}
