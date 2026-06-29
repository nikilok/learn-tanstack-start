import {
  setCustomCursorEnabled,
  useCustomCursorEnabled,
} from '../hooks/useCustomCursorEnabled';
import { CursorIcon, CursorOffIcon } from './CursorIcons';
import { HEADER_CONTROL_CLASS } from './headerControls';

/**
 * On/off toggle for the custom Union-Jack cursor, shown only on pointer-fine
 * (desktop) devices via a CSS media variant — the follower never activates
 * without a fine pointer. Gating in CSS (not JS) keeps the button in the first
 * paint, so it never pops in and shifts the neighbouring header icons. Its icon
 * and label reflect the persisted choice, letting users disable the follower on
 * low-power machines where its movement can glitch; the choice is stored in
 * `localStorage` and applied on the next visit.
 */
export default function CursorToggle() {
  const enabled = useCustomCursorEnabled();

  const label = enabled
    ? 'Custom cursor on. Click to turn it off.'
    : 'Custom cursor off. Click to turn it on.';

  return (
    <button
      type="button"
      onClick={() => setCustomCursorEnabled(!enabled)}
      aria-label={label}
      title={label}
      className={`${HEADER_CONTROL_CLASS} hidden pointer-fine:inline-flex`}
    >
      {enabled ? <CursorIcon /> : <CursorOffIcon />}
    </button>
  );
}
