import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const isMac = window.titlebar?.platform === 'darwin';
const MOD = isMac ? '⌘' : 'Ctrl';
const SHIFT = isMac ? '⇧' : 'Shift';

// Label + keycaps per button; the keycaps mirror the bindings in keyboard-shortcuts.ts.
const TOOLTIPS: Record<TooltipKind, { label: string; keys: string[] }> = {
  back: { label: 'Go back', keys: [MOD, '['] },
  forward: { label: 'Go forward', keys: [MOD, ']'] },
  share: { label: 'Share', keys: [MOD, SHIFT, 'S'] },
  'toggle-cursor': { label: 'Cursor', keys: [MOD, SHIFT, 'C'] },
  'toggle-theme': { label: 'Theme', keys: [MOD, SHIFT, 'D'] },
};

/** Root of the tooltip overlay view: renders the keycap bubble the main process positions below a hovered button. */
export function TooltipOverlay() {
  const [content, setContent] = useState(TOOLTIPS.back);
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
        setContent(TOOLTIPS[payload.kind]);
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
        <span className="tooltip-keys">
          {content.keys.map((k) => (
            <kbd key={k}>{k}</kbd>
          ))}
        </span>
      </span>
      {/* Painted last, so it sits on top of the bubble and hides the border under it. */}
      <span className="tooltip-caret" style={{ left: caretX }} />
    </div>
  );
}
