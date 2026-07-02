import { useEffect, useState } from 'react';

type Command = 'toggle-theme' | 'toggle-cursor' | 'share';
type WindowAction = 'minimize' | 'maximize' | 'close';

export interface TitleBarModel {
  canGoBack: boolean;
  canGoForward: boolean;
  title: string;
  themeMode: string;
  cursorOn: boolean;
  copied: boolean;
  platform: string;
  maximized: boolean;
  back: () => void;
  forward: () => void;
  command: (cmd: Command) => void;
  windowControl: (action: WindowAction) => void;
}

/** Owns all `window.titlebar` IPC: subscribes to nav/title/theme/cursor/copy/maximise and exposes the actions. */
export function useTitleBar(): TitleBarModel {
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });
  const [title, setTitle] = useState('SponsorSearch');
  const [dark, setDark] = useState(true);
  const [themeMode, setThemeMode] = useState('auto');
  const [cursorOn, setCursorOn] = useState(true);
  const [copied, setCopied] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const offNav = window.titlebar.onNavState(setNav);
    const offTitle = window.titlebar.onTitle((t) =>
      setTitle(t?.trim() || 'SponsorSearch'),
    );
    const offTheme = window.titlebar.onTheme((t) => {
      setDark(t.dark);
      setThemeMode(t.mode);
    });
    const offCursor = window.titlebar.onCursor(setCursorOn);
    let copiedTimer: ReturnType<typeof setTimeout> | undefined;
    const offCopied = window.titlebar.onCopied(() => {
      clearTimeout(copiedTimer);
      setCopied(true);
      copiedTimer = setTimeout(() => setCopied(false), 1500);
    });
    const offMax = window.titlebar.onMaximized(setMaximized);
    window.titlebar.ready();
    return () => {
      clearTimeout(copiedTimer);
      offNav();
      offTitle();
      offTheme();
      offCursor();
      offCopied();
      offMax();
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
    themeMode,
    cursorOn,
    copied,
    platform: window.titlebar.platform,
    maximized,
    back: () => window.titlebar.back(),
    forward: () => window.titlebar.forward(),
    command: (cmd) => window.titlebar.command(cmd),
    windowControl: (action) => window.titlebar.windowControl(action),
  };
}
