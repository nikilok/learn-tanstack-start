type WindowAction = 'minimize' | 'maximize' | 'close';

interface WindowControlsProps {
  maximized: boolean;
  onAction: (action: WindowAction) => void;
}

const btn =
  'no-drag grid h-full w-[44px] cursor-pointer place-items-center text-(--tb-fg) opacity-70 transition hover:bg-(--tb-ctrl-hover) hover:opacity-100';

/** Custom minimise / maximise / close buttons for Windows & Linux (macOS uses the native traffic lights). */
export function WindowControls({ maximized, onAction }: WindowControlsProps) {
  return (
    <div className="flex h-full items-stretch">
      <button
        type="button"
        aria-label="Minimise"
        className={btn}
        onClick={() => onAction('minimize')}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor">
          <line x1="0" y1="5.5" x2="10" y2="5.5" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={maximized ? 'Restore' : 'Maximise'}
        className={btn}
        onClick={() => onAction('maximize')}
      >
        {maximized ? (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
          >
            <rect x="0.5" y="2.5" width="7" height="7" />
            <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" />
          </svg>
        ) : (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
          >
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button
        type="button"
        aria-label="Close"
        className="no-drag grid h-full w-[44px] cursor-pointer place-items-center text-(--tb-fg) opacity-70 transition hover:bg-[#e81123] hover:text-white hover:opacity-100"
        onClick={() => onAction('close')}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor">
          <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" />
        </svg>
      </button>
    </div>
  );
}
