import { useEffect, useState } from 'react';

/**
 * A progressive backdrop-blur pinned to the top that fades page content into the
 * transparent Electron title bar as it scrolls up. Native shell only: gated on
 * the preload's `isSponsorSearchDesktop` flag, so it never renders on the web
 * (which has its own sticky header) nor in the /download preview (which stamps
 * `data-desktop` but isn't the real shell). Hidden at the very top; fades in on
 * scroll. Renders nothing until mounted in the shell, so SSR stays inert.
 */
export default function DesktopScrollMask() {
  const [active, setActive] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (!window.isSponsorSearchDesktop) return; // native shell only
    setActive(true);
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrolled(window.scrollY > 2);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  if (!active) return null;
  return (
    <div
      aria-hidden="true"
      className={`desktop-scroll-mask${scrolled ? ' is-scrolled' : ''}`}
    />
  );
}
