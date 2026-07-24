import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { SHORTCUTS } from '../../shared/shortcuts';
import type { ShortcutId } from '../../shared/shortcuts';

const isMac = window.titlebar?.platform === 'darwin';
const MOD = isMac ? '⌘' : 'Ctrl';
const SHIFT = isMac ? '⇧' : 'Shift';

const LABELS: Record<TooltipKind, string> = {
  back: 'Go back',
  forward: 'Go forward',
  share: 'Share',
  'toggle-cursor': 'Cursor',
  'toggle-theme': 'Theme',
  home: 'Home',
  filters: 'Filters',
};

/** Keycaps for a button from the shared shortcut config — empty when it has no shortcut (e.g. home). */
function contentFor(kind: TooltipKind): { label: string; keys: string[] } {
  const keys =
    kind in SHORTCUTS
      ? SHORTCUTS[kind as ShortcutId].keys.map((k) =>
          k === 'mod' ? MOD : k === 'shift' ? SHIFT : k,
        )
      : [];
  return { label: LABELS[kind], keys };
}

/** Root of the tooltip overlay view: renders the keycap bubble the main process positions below a hovered button. */
export function TooltipOverlay() {
  const [content, setContent] = useState(() => contentFor('back'));
  const [caretX, setCaretX] = useState(0);
  const [shown, setShown] = useState(false);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [bubbleLeft, setBubbleLeft] = useState(0);

  useEffect(() => {
    const offTheme = window.titlebar.onTheme((t) => {
      document.documentElement.classList.toggle('dark', t.dark);
    });
    const offTip = window.titlebar.onTooltip((payload) => {
      if (payload) {
        setContent(contentFor(payload.kind));
        setCaretX(payload.caretX);
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

  // Keep the bubble centred under the caret, but clamped inside the view (edge buttons).
  useLayoutEffect(() => {
    const bw = bubbleRef.current?.offsetWidth ?? 0;
    const pad = 6;
    const max = Math.max(pad, window.innerWidth - bw - pad);
    setBubbleLeft(Math.round(Math.min(Math.max(caretX - bw / 2, pad), max)));
  }, [caretX, content]);

  return (
    <div className={`tooltip${shown ? ' tooltip--shown' : ''}`}>
      <span
        ref={bubbleRef}
        className="tooltip-bubble"
        style={{ left: bubbleLeft }}
      >
        <span className="tooltip-label">{content.label}</span>
        {content.keys.length > 0 && (
          <span className="tooltip-keys">
            {content.keys.map((k) => (
              <kbd key={k}>{k}</kbd>
            ))}
          </span>
        )}
      </span>
      {/* Painted last, so it sits on top of the bubble and hides the border under it. */}
      <span className="tooltip-caret" style={{ left: caretX }} />
    </div>
  );
}
