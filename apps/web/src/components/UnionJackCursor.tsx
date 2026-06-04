import { useEffect, useRef, useState } from 'react';

import UnionJackLens from './UnionJackLens';

import styles from './UnionJackCursor.module.css';

const INTERACTIVE_SELECTOR =
  'a, button, [role="button"], input, select, textarea, label, summary, [data-cursor-grow]';

// Input types that are NOT text-editable; every other type (incl. none) is.
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'range',
  'color',
  'file',
  'image',
  'hidden',
]);

/** True when the pointer is over an editable text field (input/textarea/contenteditable). */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  const field = target.closest('input, textarea');
  if (field instanceof HTMLTextAreaElement) return true;
  if (field instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(field.type);
  }
  return false;
}

/** Grayscale, outlined I-beam shown in place of the lens over editable fields. */
function IBeam() {
  return (
    <svg
      viewBox="0 0 14 22"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', width: '100%', height: '100%' }}
      aria-hidden="true"
    >
      <path
        d="M4 3 H10 M7 3 V19 M4 19 H10"
        stroke="#fff"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 3 H10 M7 3 V19 M4 19 H10"
        stroke="#1f1f1f"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Replaces the native mouse pointer with a grayscale Union-Jack lens that
 * follows the cursor and grows smoothly when hovering interactive elements.
 * Over editable text fields it swaps to a custom I-beam so the "editable"
 * affordance the native cursor used to give isn't lost.
 * Mouse-only (`pointer: fine`) and client-only — touch devices keep the default.
 */
export default function UnionJackCursor() {
  const posRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(false);
  const textRef = useRef(false);
  const shownRef = useRef(false);
  const visibleRef = useRef(false);
  const [enabled, setEnabled] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [textMode, setTextMode] = useState(false);
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
      const target = e.target;
      // Text fields show the I-beam; they take precedence over the grow.
      const text = isTextField(target);
      if (text !== textRef.current) {
        textRef.current = text;
        setTextMode(text);
      }
      const over =
        !text && !!(target as Element | null)?.closest?.(INTERACTIVE_SELECTOR);
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
      <div
        className={
          textMode
            ? styles.caret
            : `${styles.lens} ${hovering ? styles.lensHover : ''}`
        }
      >
        {textMode ? (
          <IBeam />
        ) : (
          <UnionJackLens
            style={{ display: 'block', width: '100%', height: '100%' }}
          />
        )}
      </div>
    </div>
  );
}
