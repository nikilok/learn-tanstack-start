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
  // Only a *results* home (a search query present) ever has a pending scroll to restore; the
  // empty hero home never scrolls, so gating on pathname alone would wrongly frost it whenever a
  // stale `hmrc-scroll-y` lingers (e.g. logo → home after a scrolled results → details hop).
  const restorableHome = useRouterState({
    select: (s) => {
      const q = (s.location.search as { search?: string }).search ?? '';
      return s.location.pathname === '/' && q.length >= 3;
    },
  });

  // Driver setup as a LAYOUT effect, declared BEFORE the pre-seed, so driver.current is
  // populated by the time the pre-seed runs on the initial mount too — this covers a
  // reload/deep-link onto a scrolled results home, not just client back-navs.
  useLayoutEffect(() => {
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
        // Hold the pre-seeded blur through the back-nav's spurious scroll-to-0 until the real
        // restore lands, then hand back to live scroll tracking.
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

  // A results home restores its scroll a beat AFTER render (the virtual list defers restore
  // until it has correct row heights), so window.scrollY is momentarily 0 and the scroll-driven
  // blur would read "at top → clear", briefly revealing the guide-rail under the transparent
  // header before the restore jumps to the saved position — most visible on Safari/Firefox,
  // which have no page morph to mask it (see browser-init). Pre-seed the blur at its true target
  // opacity from the pending restore (`hmrc-scroll-y`) and hold it through that window. Cleanup
  // reconciles to the actual scroll so navigating away mid-hold can't strand the frost on the
  // next page; the timeout is the same safety net if the restore never lands (stranded key).
  useLayoutEffect(() => {
    if (!restorableHome || !driver.current) return;
    const pending = Number.parseInt(
      sessionStorage.getItem('hmrc-scroll-y') ?? '',
      10,
    );
    if (!(pending >= 1)) return;
    awaitingRestore.current = true;
    driver.current.setOpacity(pending / 12);
    const reconcile = () => {
      awaitingRestore.current = false;
      driver.current?.fromScroll();
    };
    const timer = setTimeout(reconcile, 1500);
    return () => {
      clearTimeout(timer);
      reconcile();
    };
  }, [restorableHome]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={`${styles.webHeaderBlur} backdrop-blur-lg`}
    />
  );
}
