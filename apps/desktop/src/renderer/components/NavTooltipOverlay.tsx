import { useEffect, useState } from 'react';

const MOD = window.titlebar?.platform === 'darwin' ? '⌘' : 'Ctrl';

/** Root of the tooltip overlay view: renders the keycap bubble the main process positions below a hovered nav arrow. */
export function NavTooltipOverlay() {
  const [kind, setKind] = useState<NavTooltipKind>('back');
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const offTheme = window.titlebar.onTheme((t) => {
      document.documentElement.classList.toggle('dark', t.dark);
    });
    const offTip = window.titlebar.onNavTooltip((payload) => {
      if (payload) {
        setKind(payload.kind);
        setShown(true);
      } else {
        setShown(false);
      }
    });
    window.titlebar.ready(); // ask main for the current theme
    return () => {
      offTheme();
      offTip();
    };
  }, []);

  return (
    <div className={`nav-tooltip${shown ? ' nav-tooltip--shown' : ''}`}>
      <span className="nav-tooltip-caret" />
      <span className="nav-tooltip-bubble">
        <span className="nav-tooltip-label">
          {kind === 'forward' ? 'Go forward' : 'Go back'}
        </span>
        <span className="nav-tooltip-keys">
          <kbd>{MOD}</kbd>
          <kbd>{kind === 'forward' ? ']' : '['}</kbd>
        </span>
      </span>
    </div>
  );
}
