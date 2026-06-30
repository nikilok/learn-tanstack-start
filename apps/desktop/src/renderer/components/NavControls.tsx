import { ArrowLeft, ArrowRight } from 'lucide-react';

interface NavControlsProps {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

const button =
  'grid h-6 w-[30px] cursor-pointer place-items-center bg-transparent text-(--tb-fg) opacity-[0.55] transition-opacity hover:opacity-100 disabled:cursor-default disabled:opacity-25';

/** Pinned-left back/forward pill — its own `no-drag` region. */
export function NavControls({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}: NavControlsProps) {
  return (
    <div className="no-drag absolute top-1/2 left-25 flex h-8 -translate-y-1/2 items-center rounded-full border border-(--tb-box-bd) bg-(--tb-box-bg) px-[5px] backdrop-blur-sm">
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
      <span className="mx-[3px] h-4 w-px shrink-0 bg-(--tb-box-bd)" />
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
