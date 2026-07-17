import { ArrowLeft, ArrowRight } from 'lucide-react';

interface NavControlsProps {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

const button =
  'grid h-6 w-[30px] cursor-pointer place-items-center bg-transparent text-(--tb-fg) opacity-[0.55] transition-opacity hover:opacity-100 disabled:cursor-default disabled:opacity-25';

/** Back/forward arrows — bare (no pill); their own `no-drag` region, positioned by the left cluster in TitleBar. */
export function NavControls({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}: NavControlsProps) {
  return (
    <div className="no-drag flex h-8 items-center gap-1.5">
      <button
        type="button"
        aria-label="Back"
        title="Back"
        className={button}
        disabled={!canGoBack}
        onClick={onBack}
      >
        <ArrowLeft size={18} />
      </button>
      <button
        type="button"
        aria-label="Forward"
        title="Forward"
        className={button}
        disabled={!canGoForward}
        onClick={onForward}
      >
        <ArrowRight size={18} />
      </button>
    </div>
  );
}
