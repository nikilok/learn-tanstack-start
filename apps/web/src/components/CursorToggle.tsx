import {
  setCustomCursorEnabled,
  useCustomCursorEnabled,
} from '../hooks/useCustomCursorEnabled';
import { useIsMac } from '../hooks/useIsMac';
import { useShortcut } from '../hooks/useShortcut';
import { CursorIcon, CursorOffIcon } from './CursorIcons';
import { HEADER_CONTROL_CLASS } from './headerControls';
import { ariaKeyShortcuts } from './headerShortcuts';
import HeaderTooltip from './HeaderTooltip';

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
  const isMac = useIsMac();

  const label = enabled
    ? 'Custom cursor on. Click to turn it off.'
    : 'Custom cursor off. Click to turn it on.';

  useShortcut('toggle-cursor', () => {
    // Matches the button's CSS gate — on a coarse pointer it's display:none, so a keyboard flip would strand the preference.
    if (!window.matchMedia('(pointer: fine)').matches) return;
    setCustomCursorEnabled(!enabled);
  });

  return (
    // Gate the wrapper, not the button: a wrapper around a hidden button still takes a flex-gap slot.
    <HeaderTooltip
      label="Cursor"
      shortcut="toggle-cursor"
      align="end"
      className="hidden pointer-fine:inline-flex"
    >
      <button
        type="button"
        onClick={() => setCustomCursorEnabled(!enabled)}
        aria-label={label}
        aria-keyshortcuts={ariaKeyShortcuts('toggle-cursor', isMac)}
        className={HEADER_CONTROL_CLASS}
      >
        {enabled ? <CursorIcon /> : <CursorOffIcon />}
      </button>
    </HeaderTooltip>
  );
}
