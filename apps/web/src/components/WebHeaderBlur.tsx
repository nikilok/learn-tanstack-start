import { useEffect, useState } from 'react';

import styles from './WebHeaderBlur.module.css';

/** Frosted backdrop that fades in behind the web header once the page scrolls, leaving it
 * clear at the top. Web-only — the Electron shell and the /download preview iframe (both
 * stamped `data-desktop` pre-paint) own the equivalent title-bar blur via DesktopScrollMask.
 * A tiny passive scroll listener toggles `data-scrolled`; JS-driven rather than a CSS
 * scroll-timeline so the blur also works on Safari, which the shell's timeline can assume. */
export default function WebHeaderBlur() {
  const [active, setActive] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (document.documentElement.hasAttribute('data-desktop')) return;
    setActive(true);
    let cur = false;
    const update = () => {
      const next = window.scrollY > 2;
      if (next !== cur) {
        cur = next;
        setScrolled(next);
      }
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  if (!active) return null;
  return (
    <div
      aria-hidden="true"
      data-scrolled={scrolled || undefined}
      className={`${styles.webHeaderBlur} backdrop-blur-lg`}
    />
  );
}
