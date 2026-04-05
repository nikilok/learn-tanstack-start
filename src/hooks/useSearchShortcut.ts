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

      if (document.activeElement === el) return;

      const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey;
      const isCmdK = e.key === 'k' && (e.metaKey || e.ctrlKey);
      const isCtrlF = e.key === 'f' && e.ctrlKey && !e.metaKey;

      if (isSlash || isCmdK || isCtrlF) {
        e.preventDefault();
        e.stopPropagation();
        if (onActivateRef.current) {
          onActivateRef.current();
          // Delay focus until after React re-renders (pill → input transition)
          requestAnimationFrame(() => {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          });
        } else {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [inputRef]);
}
