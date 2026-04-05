import { type RefObject, useEffect, useRef } from 'react';

// Global listener state — persists across React mount/unmount cycles
const state: {
  inputRef: RefObject<HTMLInputElement | null> | null;
  onActivate: (() => void) | null;
  registered: boolean;
} = { inputRef: null, onActivate: null, registered: false };

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
  }
}

function ensureListener() {
  if (state.registered || typeof window === 'undefined') return;
  window.addEventListener('keydown', handleKeyDown, true);
  state.registered = true;
}

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
