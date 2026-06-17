import { useCustomCursorEnabled } from '../hooks/useCustomCursorEnabled';
import CustomCursor from './CustomCursor';
import IBeam from './IBeam';
import UnionJackLens from './UnionJackLens';

const FILL_STYLE = { display: 'block', width: '100%', height: '100%' } as const;

const BADGE_STYLE = {
  position: 'absolute',
  top: '50%',
  left: '100%',
  width: 14,
  height: 14,
  transform: 'translateY(-50%)',
  filter: 'grayscale(1)',
} as const;

/** Grayscale Union-Jack lens drawing for the default/hover states. */
function UJLens() {
  return <UnionJackLens style={FILL_STYLE} />;
}

/** I-beam plus a small grayscale Union-Jack badge for editable text fields. */
function UJCaret() {
  return (
    <>
      <IBeam />
      <span style={BADGE_STYLE}>
        <UnionJackLens style={FILL_STYLE} />
      </span>
    </>
  );
}

/**
 * Union-Jack preset of {@link CustomCursor}: a grayscale lens that grows over
 * interactive elements as a click affordance and swaps to a custom I-beam over
 * editable text fields. Wires the site-specific View-Transition hooks
 * (`data-uj-cursor`, `uj-cursor-active`) so the follower survives page flips.
 * Self-gates on the persisted `CursorToggle` preference: when disabled it
 * unmounts {@link CustomCursor}, whose cleanup restores the native cursor.
 */
export default function UnionJackCursor() {
  const enabled = useCustomCursorEnabled();
  if (!enabled) {
    return null;
  }

  return (
    <CustomCursor
      activeClassName="uj-cursor-active"
      layerProps={{ 'data-uj-cursor': '' }}
      cursors={{ default: UJLens, hover: UJLens, text: UJCaret }}
      states={{
        default: { size: 20, scale: 1, filter: 'grayscale(1)' },
        hover: { size: 20, scale: 1.4, filter: 'grayscale(1)' },
        text: { size: { width: 14, height: 22 } },
      }}
      transition={{
        duration: 240,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        morph: true,
      }}
      enter={{ scale: 0.3 }}
      transitions={{
        '*->text': { morph: true, duration: 450 },
        'text->*': { morph: true, duration: 450 },
      }}
    />
  );
}
