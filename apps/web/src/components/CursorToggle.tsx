import { useEffect, useState } from 'react';

import {
  setCustomCursorEnabled,
  useCustomCursorEnabled,
} from '../hooks/useCustomCursorEnabled';
import { CursorIcon, CursorOffIcon } from './CursorIcons';

/**
 * Desktop-only on/off toggle for the custom Union-Jack cursor. Renders nothing
 * on touch devices (the follower never activates without a fine pointer); on
 * pointer-fine devices it shows a button whose icon and label reflect the
 * persisted choice, letting users disable the follower on low-power machines
 * where its movement can glitch. The choice is stored in `localStorage` and
 * applied on the next visit.
 */
export default function CursorToggle() {
  const [pointerFine, setPointerFine] = useState(false);
  const enabled = useCustomCursorEnabled();

  useEffect(() => {
    setPointerFine(window.matchMedia('(pointer: fine)').matches);
  }, []);

  if (!pointerFine) {
    return null;
  }

  const label = enabled
    ? 'Custom cursor on. Click to turn it off.'
    : 'Custom cursor off. Click to turn it on.';

  return (
    <button
      type="button"
      onClick={() => setCustomCursorEnabled(!enabled)}
      aria-label={label}
      title={label}
      className="shadow-ring rounded-md p-2 text-(--sea-ink-soft) transition hover:bg-(--link-bg-hover) hover:text-(--sea-ink)"
    >
      {enabled ? <CursorIcon /> : <CursorOffIcon />}
    </button>
  );
}
