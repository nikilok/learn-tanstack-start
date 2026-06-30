import { useEffect, useState } from 'react';

export interface TitleBarModel {
  canGoBack: boolean;
  canGoForward: boolean;
  title: string;
  dark: boolean;
  back: () => void;
  forward: () => void;
}

/** Owns all `window.titlebar` IPC: subscribes to nav/title/theme and exposes the actions. */
export function useTitleBar(): TitleBarModel {
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });
  const [title, setTitle] = useState('SponsorSearch');
  const [dark, setDark] = useState(true);

  useEffect(() => {
    const offNav = window.titlebar.onNavState(setNav);
    const offTitle = window.titlebar.onTitle((t) =>
      setTitle(t?.trim() || 'SponsorSearch'),
    );
    const offTheme = window.titlebar.onTheme((t) => setDark(t.dark));
    window.titlebar.ready();
    return () => {
      offNav();
      offTitle();
      offTheme();
    };
  }, []);

  // Mirror the resolved theme onto <html> so the CSS tokens switch.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  return {
    canGoBack: nav.canGoBack,
    canGoForward: nav.canGoForward,
    title,
    dark,
    back: () => window.titlebar.back(),
    forward: () => window.titlebar.forward(),
  };
}
