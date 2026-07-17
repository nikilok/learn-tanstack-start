import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { MouseEvent } from 'react';

interface NavControlsProps {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

// Same 34px button as the utility controls, but the arrows render at 22px (vs the
// utility glyphs' 18px): lucide's arrows are sparse — thin line + head — so at 18px
// their ink reads ~30% smaller. 22px matches their perceived size; p-1.5 keeps 34px.
const button =
  'grid cursor-pointer place-items-center rounded-md p-1.5 text-(--tb-fg) opacity-[0.55] transition-opacity hover:opacity-100 disabled:cursor-default disabled:opacity-25';

// Report the hovered arrow + its centre x so the tooltip overlay view can point at it.
// Disabled buttons fire no mouse events, so a disabled arrow never raises a tooltip.
function emitHover(kind: NavTooltipKind) {
  return (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    window.titlebar.hoverNav({ kind, x: Math.round(r.left + r.width / 2) });
  };
}
const clearHover = () => window.titlebar.hoverNav(null);

/** Back/forward arrows — bare (no pill); their own `no-drag` region, positioned by the left cluster in TitleBar. */
export function NavControls({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}: NavControlsProps) {
  return (
    <div className="no-drag flex items-center gap-2" onMouseLeave={clearHover}>
      <button
        type="button"
        aria-label="Go back"
        className={button}
        disabled={!canGoBack}
        onClick={onBack}
        onMouseEnter={emitHover('back')}
      >
        <ArrowLeft size={22} />
      </button>
      <button
        type="button"
        aria-label="Go forward"
        className={button}
        disabled={!canGoForward}
        onClick={onForward}
        onMouseEnter={emitHover('forward')}
      >
        <ArrowRight size={22} />
      </button>
    </div>
  );
}
