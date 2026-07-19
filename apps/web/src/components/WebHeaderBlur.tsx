import { useRouterState } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import styles from './WebHeaderBlur.module.css';

/** Frosted backdrop that tracks scroll behind the web header — clear at the top, blurred
 * once content scrolls under it. Web-only; the Electron shell and the /download preview
 * iframe (both stamped `data-desktop` pre-paint) get the equivalent via DesktopScrollMask. */
export default function WebHeaderBlur() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!document.documentElement.hasAttribute('data-desktop')) setActive(true);
  }, []);
  return active ? <BlurLayer /> : null;
}

/** The blur layer plus its scroll driver. Opacity is tied straight to scroll position (no
 * time-based fade), mirroring the desktop shell's CSS scroll-timeline. */
function BlurLayer() {
  const ref = useRef<HTMLDivElement>(null);
  const driver = useRef<{
    setOpacity: (o: number) => void;
    fromScroll: () => void;
  } | null>(null);
  // While true, scroll readings near 0 are held off (see the pre-seed effect below).
  const awaitingRestore = useRef(false);
  const isHome = useRouterState({ select: (s) => s.location.pathname === '/' });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Ramp to full blur over the first 12px of scroll, matching DesktopScrollMask's range.
    let last = -1;
    const setOpacity = (o: number) => {
      const v = Math.min(1, Math.max(0, o));
      if (v !== last) {
        last = v;
        el.style.opacity = String(v);
      }
    };
    const fromScroll = () => {
      if (awaitingRestore.current) {
        // Hold the pre-seeded blur until the real restore lands; ignore the scroll-to-0 the
        // back-nav fires first (which would otherwise clear it, then re-blur).
        if (window.scrollY < 1) return;
        awaitingRestore.current = false;
      }
      setOpacity(window.scrollY / 12);
    };
    driver.current = { setOpacity, fromScroll };
    fromScroll();
    window.addEventListener('scroll', fromScroll, { passive: true });
    return () => window.removeEventListener('scroll', fromScroll);
  }, []);

  // Back-nav to the home/results route restores its scroll a beat AFTER render (the virtual
  // list defers restore until it has correct row heights), so window.scrollY is momentarily 0.
  // Without help the scroll-driven blur would read "at top → clear" and briefly reveal the full
  // content (the guide-rail) under the transparent header before the restore jumps to the saved
  // position — most visible on Safari, which has no page morph to mask it (see browser-init).
  // Pre-seed the blur from the pending restore (`hmrc-scroll-y`) and hold it (awaitingRestore)
  // through that window so the header stays frosted. The timeout reconciles to the actual scroll
  // if the restore never comes (stranded key), so a genuinely-at-top home can't get stuck blurred.
  useLayoutEffect(() => {
    if (!isHome || !driver.current) return;
    const pending = Number.parseInt(
      sessionStorage.getItem('hmrc-scroll-y') ?? '',
      10,
    );
    if (!(pending >= 1)) return;
    awaitingRestore.current = true;
    driver.current.setOpacity(1);
    const timer = setTimeout(() => {
      awaitingRestore.current = false;
      driver.current?.fromScroll();
    }, 1500);
    return () => {
      clearTimeout(timer);
      awaitingRestore.current = false;
    };
  }, [isHome]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={`${styles.webHeaderBlur} backdrop-blur-lg`}
    />
  );
}
