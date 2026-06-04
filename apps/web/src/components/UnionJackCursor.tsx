import { useEffect, useRef, useState } from 'react';

import UnionJackLens from './UnionJackLens';

import styles from './UnionJackCursor.module.css';

const INTERACTIVE_SELECTOR =
  'a, button, [role="button"], input, select, textarea, label, summary, [data-cursor-grow]';

/**
 * Replaces the native mouse pointer with a grayscale Union-Jack lens that
 * follows the cursor and grows smoothly when hovering interactive elements.
 * Mouse-only (`pointer: fine`) and client-only — touch devices keep the default.
 */
export default function UnionJackCursor() {
  const posRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(false);
  const shownRef = useRef(false);
  const visibleRef = useRef(false);
  const [enabled, setEnabled] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) return;
    setEnabled(true);
    document.documentElement.classList.add('uj-cursor-active');

    let raf = 0;
    let nextX = 0;
    let nextY = 0;

    // Coalesce moves into one transform write per frame.
    const flush = () => {
      raf = 0;
      if (posRef.current) {
        posRef.current.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
      }
    };

    // Toggle follower opacity via a ref so the closures read fresh state.
    const show = () => {
      if (!visibleRef.current) {
        visibleRef.current = true;
        setVisible(true);
      }
    };
    const hide = () => {
      if (visibleRef.current) {
        visibleRef.current = false;
        setVisible(false);
      }
    };

    const onMove = (e: PointerEvent) => {
      nextX = e.clientX;
      nextY = e.clientY;
      if (!raf) raf = requestAnimationFrame(flush);
      // Reveal on every move (not just the first) so it recovers after a blur.
      shownRef.current = true;
      show();
      const over = !!(e.target as Element | null)?.closest?.(
        INTERACTIVE_SELECTOR,
      );
      if (over !== hoverRef.current) {
        hoverRef.current = over;
        setHovering(over);
      }
    };

    // Hide on blur/leave, re-show on focus/enter — recovers after Cmd/Alt-Tab,
    // where Safari fires no mouseenter (pointer already inside on refocus).
    const onLeave = () => hide();
    const onEnter = () => {
      if (shownRef.current) show();
    };

    document.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('mouseleave', onLeave);
    document.documentElement.addEventListener('mouseenter', onEnter);
    window.addEventListener('blur', onLeave);
    window.addEventListener('focus', onEnter);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      document.documentElement.removeEventListener('mouseenter', onEnter);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('focus', onEnter);
      document.documentElement.classList.remove('uj-cursor-active');
    };
  }, []);

  if (!enabled) return null;

  return (
    <div
      ref={posRef}
      aria-hidden="true"
      data-uj-cursor
      className={`${styles.layer} ${visible ? styles.layerVisible : ''}`}
    >
      <div className={`${styles.lens} ${hovering ? styles.lensHover : ''}`}>
        <UnionJackLens
          style={{ display: 'block', width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
}
