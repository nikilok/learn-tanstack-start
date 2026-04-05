import { type RefObject, useEffect, useRef } from 'react';

export function useSearchShortcut(
  inputRef: RefObject<HTMLInputElement | null>,
  onActivate?: () => void,
) {
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const el = inputRef.current;
      if (!el) return;
      if (el === document.activeElement) return;

      const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey;
      const isCmdK = e.key === 'k' && (e.metaKey || e.ctrlKey);
      const isCtrlF = e.key === 'f' && e.ctrlKey && !e.metaKey;

      if (isSlash || isCmdK || isCtrlF) {
        e.preventDefault();
        onActivateRef.current?.();
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [inputRef]);
}
