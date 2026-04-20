import { type RefObject, useEffect, useRef } from 'react';

// Global listener state — persists across React mount/unmount cycles
const state: {
  inputRef: RefObject<HTMLInputElement | null> | null;
  onActivate: (() => void) | null;
  registered: boolean;
} = { inputRef: null, onActivate: null, registered: false };

/**
 * Global capture-phase keydown handler: focuses the search input on `/` or
 * `⌘K`/`Ctrl+K`, and on any printable character (desktop auto-focus). No-op
 * when the input is already focused or unmounted. Calls `state.onActivate`
 * before focusing so consumers can open pill mode in the same tick.
 */
function handleKeyDown(e: KeyboardEvent) {
  const el = state.inputRef?.current;
  if (!el) return;
  if (document.activeElement === el) return;

  const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey;
  const isCmdK = e.key === 'k' && (e.metaKey || e.ctrlKey);

  if (isSlash || isCmdK) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    state.onActivate?.();
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return;
  }

  // Auto-focus on any printable character (desktop only)
  const isPrintable =
    e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
  if (isPrintable) {
    state.onActivate?.();
    el.value = '';
    el.focus();
  }
}

/**
 * Register the global keydown listener once per page load. Idempotent and
 * SSR-safe — the listener outlives React mount cycles so shortcut behaviour
 * is uninterrupted by HMR or route transitions.
 */
function ensureListener() {
  if (state.registered || typeof window === 'undefined') return;
  window.addEventListener('keydown', handleKeyDown, true);
  state.registered = true;
}

/**
 * Hook that wires an input ref and optional `onActivate` callback into the
 * module-level keydown listener. `onActivate` is held in a ref so latest-
 * closure values are always used without re-registering the global handler.
 */
export function useSearchShortcut(
  inputRef: RefObject<HTMLInputElement | null>,
  onActivate?: () => void,
) {
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;

  useEffect(() => {
    state.inputRef = inputRef;
    state.onActivate = () => onActivateRef.current?.();
    ensureListener();
    return () => {
      state.inputRef = null;
      state.onActivate = null;
    };
  }, [inputRef]);
}
