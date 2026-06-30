import { useEffect, useState } from 'react';

type Command = 'toggle-theme' | 'toggle-cursor' | 'share';

export interface TitleBarModel {
  canGoBack: boolean;
  canGoForward: boolean;
  title: string;
  dark: boolean;
  cursorOn: boolean;
  back: () => void;
  forward: () => void;
  command: (cmd: Command) => void;
}

/** Owns all `window.titlebar` IPC: subscribes to nav/title/theme/cursor and exposes the actions. */
export function useTitleBar(): TitleBarModel {
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });
  const [title, setTitle] = useState('SponsorSearch');
  const [dark, setDark] = useState(true);
  const [cursorOn, setCursorOn] = useState(true);

  useEffect(() => {
    const offNav = window.titlebar.onNavState(setNav);
    const offTitle = window.titlebar.onTitle((t) =>
      setTitle(t?.trim() || 'SponsorSearch'),
    );
    const offTheme = window.titlebar.onTheme((t) => setDark(t.dark));
    const offCursor = window.titlebar.onCursor(setCursorOn);
    window.titlebar.ready();
    return () => {
      offNav();
      offTitle();
      offTheme();
      offCursor();
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
    cursorOn,
    back: () => window.titlebar.back(),
    forward: () => window.titlebar.forward(),
    command: (cmd) => window.titlebar.command(cmd),
  };
}
