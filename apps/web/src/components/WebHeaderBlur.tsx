import { useEffect, useRef, useState } from 'react';

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

/** The blur layer plus its scroll driver, split out so the listener attaches only once the
 * element is in the DOM. Opacity is tied straight to scroll position (no time-based fade),
 * mirroring the desktop shell's CSS scroll-timeline: when a back-navigation restores a
 * scrolled position a beat after the view transition, the blur is instantly correct instead
 * of fading in late — a timed fade there reads as a clear-then-blink. */
function BlurLayer() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Ramp to full blur over the first 12px of scroll, matching DesktopScrollMask's range.
    let last = -1;
    const update = () => {
      const next = Math.min(1, Math.max(0, window.scrollY / 12));
      if (next !== last) {
        last = next;
        el.style.opacity = String(next);
      }
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={`${styles.webHeaderBlur} backdrop-blur-lg`}
    />
  );
}
