import { useEffect, useState } from 'react';

/** Watch `<html class="dark">` for theme changes and return whether dark mode is currently active. Reads the initial value synchronously from the DOM so there's no light→dark flash on first paint — only safe to call from client-only components (e.g. inside `<ClientOnly>` or a `lazy()` boundary). */
export function useIsDark() {
  const [isDark, setIsDark] = useState(
    () =>
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const el = document.documentElement;
    const update = () => setIsDark(el.classList.contains('dark'));
    const observer = new MutationObserver(update);
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}
