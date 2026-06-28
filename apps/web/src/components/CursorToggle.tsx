import {
  setCustomCursorEnabled,
  useCustomCursorEnabled,
} from '../hooks/useCustomCursorEnabled';
import { CursorIcon, CursorOffIcon } from './CursorIcons';

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
      className="shadow-ring hidden rounded-md p-2.5 text-(--sea-ink-soft) transition hover:bg-(--link-bg-hover) hover:text-(--sea-ink) pointer-fine:inline-flex sm:p-2"
    >
      {enabled ? <CursorIcon /> : <CursorOffIcon />}
    </button>
  );
}
