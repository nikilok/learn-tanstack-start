import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

/** Top-edge progressive backdrop-blur that fades content into the transparent Electron title bar on scroll (CSS scroll-timeline in styles.css). Native shell only — gated on the preload flag, so the web and /download preview never subscribe. */
export default function DesktopScrollMask() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (window.isSponsorSearchDesktop) setActive(true); // native shell only
  }, []);

  return active ? <ShellScrollMask /> : null;
}

/** Remounts the mask on a nav that lands on a non-scrollable page — Chromium leaves the scroll timeline idle at its last opacity there, so a fresh element re-evaluates to 0. Scrollable-page navs (search refines) don't remount, so the blur never flickers mid-typing. */
function ShellScrollMask() {
  const href = useRouterState({ select: (s) => s.location.href });
  const [resetKey, setResetKey] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = document.scrollingElement;
      if (el && el.scrollHeight <= window.innerHeight + 1) {
        setResetKey((k) => k + 1);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [href]);

  return (
    <div key={resetKey} aria-hidden="true" className="desktop-scroll-mask" />
  );
}
