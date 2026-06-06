import type { ComponentType } from 'react';
import { useEffect, useRef, useState } from 'react';

import styles from './CustomCursor.module.css';

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

// CSS properties the engine tweens when morphing between states.
const TWEEN_PROPS = [
  'transform',
  'filter',
  'opacity',
  'width',
  'height',
  'border-radius',
];

const EMPTY_TOKENS: StateTokens = {};

// Pose inactive boxes park at, so component swaps bloom/collapse, not crossfade.
const DEFAULT_ENTER: StateTokens = { scale: 0.4 };

/** Props every author-supplied cursor component receives. */
export interface CursorRenderProps {
  state: string;
  previous: string | null;
  active: boolean;
}

export type CursorComponent = ComponentType<CursorRenderProps>;

/** Per-state visual tokens the engine interpolates on the shared box. */
export interface StateTokens {
  size?: number | { width: number; height: number };
  scale?: number;
  rotate?: number;
  filter?: string;
  opacity?: number;
  radius?: number | string;
}

/** How a state change animates: tween the box (`morph`) or hard-cut. */
export interface TransitionConfig {
  duration?: number;
  easing?: string;
  morph?: boolean;
}

export type MatchRule =
  | { selector: string; state: string }
  | { test: (target: EventTarget | null) => boolean; state: string };

export interface CustomCursorProps {
  /** Maps state names to the component rendered for that state. */
  cursors: Record<string, CursorComponent>;
  /** Per-state box tokens (size, scale, filter, …). */
  states?: Record<string, StateTokens>;
  /** Overrides built-in positional detection; first matching rule wins. */
  match?: MatchRule[];
  /** State used when nothing else matches. */
  fallback?: string;
  /** Default transition for every state change. */
  transition?: TransitionConfig;
  /** Per-pair overrides keyed `from->to`; `*` wildcards either side. */
  transitions?: Record<string, TransitionConfig>;
  /** Pose inactive boxes park at, so swaps between different components
   *  bloom/collapse rather than crossfade. Defaults to `{ scale: 0.4 }`. */
  enter?: StateTokens;
  zIndex?: number;
  /** Class added to `<html>` while active; the `cursor: none` rule is scoped to it. */
  activeClassName?: string;
  /** Extra attributes spread onto the follower layer (e.g. View-Transition hooks). */
  layerProps?: Record<string, string>;
}

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

/** True when the pointer target sits within an interactive (clickable) element. */
function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(INTERACTIVE_SELECTOR);
}

/** Resolves the active state from the element under the pointer. */
function resolveState(
  target: EventTarget | null,
  config: Pick<CustomCursorProps, 'cursors' | 'match'> & { fallback: string },
): string {
  const { cursors, match, fallback } = config;
  if (match && match.length) {
    for (const rule of match) {
      if ('test' in rule) {
        if (rule.test(target)) return rule.state;
      } else if (target instanceof Element && target.closest(rule.selector)) {
        return rule.state;
      }
    }
    return fallback;
  }
  if (cursors.text && isTextField(target)) return 'text';
  if (cursors.hover && isInteractive(target)) return 'hover';
  return fallback;
}

/** Normalizes a size token into explicit pixel dimensions. */
function normalizeSize(size: StateTokens['size']): {
  width?: number;
  height?: number;
} {
  if (size == null) return {};
  if (typeof size === 'number') return { width: size, height: size };
  return size;
}

/** De-duplicates the cursor map into one persistent box per unique component. */
function uniqueBoxes(
  cursors: Record<string, CursorComponent>,
): Array<{ key: string; Component: CursorComponent }> {
  const seen = new Map<CursorComponent, string>();
  for (const [name, Component] of Object.entries(cursors)) {
    if (!seen.has(Component)) seen.set(Component, name);
  }
  return Array.from(seen, ([Component, key]) => ({ key, Component }));
}

/** Injects a `cursor: none` rule scoped to the active class; returns the node we created. */
function injectCursorNone(activeClassName: string): HTMLStyleElement | null {
  const id = `custom-cursor-none-${activeClassName}`;
  if (document.getElementById(id)) return null;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = `html.${activeClassName}, html.${activeClassName} * { cursor: none !important; }`;
  document.head.appendChild(el);
  return el;
}

/**
 * Generic custom-cursor engine. Replaces the native pointer with a follower
 * whose appearance is a small state machine: positional states (hover, text,
 * default) are resolved from the element under the pointer, each maps to an
 * author-supplied component, and the engine tweens a shared box between
 * per-state tokens (size/scale/filter) so transitions morph. Mouse-only
 * (`pointer: fine`) and client-only — touch devices keep the default cursor.
 */
export default function CustomCursor({
  cursors,
  states,
  match,
  fallback = 'default',
  transition,
  transitions,
  enter,
  zIndex = 2147483647,
  activeClassName = 'custom-cursor-active',
  layerProps = {},
}: CustomCursorProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [visible, setVisible] = useState(false);
  const [cursorState, setCursorState] = useState(fallback);
  const stateRef = useRef(fallback);
  const prevStateRef = useRef<string | null>(null);
  const visibleRef = useRef(false);
  const shownRef = useRef(false);

  // Mirror detection config into a ref so the move handler reads fresh props
  // without re-subscribing the listener every render.
  const resolveRef = useRef({ cursors, match, fallback });
  resolveRef.current = { cursors, match, fallback };

  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) return;
    setEnabled(true);
    const html = document.documentElement;
    html.classList.add(activeClassName);
    const styleEl = injectCursorNone(activeClassName);

    let raf = 0;
    let nextX = 0;
    let nextY = 0;

    // Coalesce moves into one transform write per frame.
    const flush = () => {
      raf = 0;
      if (layerRef.current) {
        layerRef.current.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
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
      const next = resolveState(e.target, resolveRef.current);
      if (next !== stateRef.current) {
        prevStateRef.current = stateRef.current;
        stateRef.current = next;
        setCursorState(next);
      }
    };

    // Hide on blur/leave, re-show on focus/enter — recovers after Cmd/Alt-Tab,
    // where Safari fires no mouseenter (pointer already inside on refocus).
    const onLeave = () => hide();
    const onEnter = () => {
      if (shownRef.current) show();
    };

    document.addEventListener('pointermove', onMove, { passive: true });
    html.addEventListener('mouseleave', onLeave);
    html.addEventListener('mouseenter', onEnter);
    window.addEventListener('blur', onLeave);
    window.addEventListener('focus', onEnter);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('pointermove', onMove);
      html.removeEventListener('mouseleave', onLeave);
      html.removeEventListener('mouseenter', onEnter);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('focus', onEnter);
      html.classList.remove(activeClassName);
      styleEl?.remove();
    };
  }, [activeClassName]);

  if (!enabled) return null;

  // Resolve the transition for the current change (per-pair > wildcard > global).
  const prev = prevStateRef.current;
  const pair =
    (prev != null ? transitions?.[`${prev}->${cursorState}`] : undefined) ??
    transitions?.[`*->${cursorState}`] ??
    (prev != null ? transitions?.[`${prev}->*`] : undefined);
  const duration = pair?.duration ?? transition?.duration ?? 200;
  const easing = pair?.easing ?? transition?.easing ?? 'ease';
  const morph = pair?.morph ?? transition?.morph ?? true;
  const boxTransition =
    morph && duration > 0
      ? TWEEN_PROPS.map((p) => `${p} ${duration}ms ${easing}`).join(', ')
      : 'none';

  const tokens = states?.[cursorState] ?? EMPTY_TOKENS;
  const parked = enter ?? DEFAULT_ENTER;

  return (
    <div
      {...layerProps}
      ref={layerRef}
      aria-hidden="true"
      className={`${styles.layer} ${visible ? styles.layerVisible : ''}`}
      style={{ zIndex }}
    >
      {uniqueBoxes(cursors).map(({ key, Component }) => {
        const active = cursors[cursorState] === Component;
        // Active boxes wear the destination state's tokens; inactive boxes park
        // at their own resting look (`states[key]`) with the `enter` pose
        // overlaid, so a swap bloom/collapses (shrink + fade) without tweening
        // through the incoming state's size/filter/colour.
        const boxTokens = active
          ? tokens
          : { ...(states?.[key] ?? EMPTY_TOKENS), ...parked };
        const sz = normalizeSize(boxTokens.size);
        const scale = boxTokens.scale ?? 1;
        const rotate = boxTokens.rotate ?? 0;
        const transform = `translate(-50%, -50%) scale(${scale})${
          rotate ? ` rotate(${rotate}deg)` : ''
        }`;
        return (
          <div
            key={key}
            className={styles.box}
            // CSS hook so a view-transition snapshot can keep only the active box.
            data-cursor-box={active ? 'active' : 'inactive'}
            style={{
              // Active box stays in flow so the layer keeps a real size for its
              // view-transition snapshot; inactive boxes overlay it.
              position: active ? 'relative' : 'absolute',
              top: active ? undefined : 0,
              left: active ? undefined : 0,
              width: sz.width,
              height: sz.height,
              transform,
              filter: boxTokens.filter ?? 'none',
              borderRadius: boxTokens.radius,
              // Inactive boxes fade out (opacity 0) unless the `enter` pose
              // sets a parked opacity; a box's own-state opacity must not leak in.
              opacity: active
                ? (boxTokens.opacity ?? 1)
                : (parked.opacity ?? 0),
              transition: boxTransition,
            }}
          >
            <Component state={cursorState} previous={prev} active={active} />
          </div>
        );
      })}
    </div>
  );
}
