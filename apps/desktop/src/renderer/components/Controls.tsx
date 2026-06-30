import { Moon, MousePointer2, Share2, Sun } from 'lucide-react';

type Command = 'toggle-theme' | 'toggle-cursor' | 'share';

interface ControlsProps {
  dark: boolean;
  cursorOn: boolean;
  onCommand: (cmd: Command) => void;
}

const button =
  'grid size-7 cursor-pointer place-items-center rounded-md text-(--tb-fg) opacity-[0.55] transition-opacity hover:opacity-100';

/** Top-right utility buttons (share / cursor / theme) absorbed from the web header. */
export function Controls({ dark, cursorOn, onCommand }: ControlsProps) {
  return (
    <div className="no-drag absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-0.5">
      <button
        type="button"
        aria-label="Share this page"
        title="Share this page"
        className={button}
        onClick={() => onCommand('share')}
      >
        <Share2 size={16} />
      </button>
      <button
        type="button"
        aria-label={cursorOn ? 'Custom cursor on' : 'Custom cursor off'}
        title={cursorOn ? 'Custom cursor on' : 'Custom cursor off'}
        className={`grid size-7 cursor-pointer place-items-center rounded-md text-(--tb-fg) transition-opacity hover:opacity-100 ${cursorOn ? 'opacity-[0.55]' : 'opacity-25'}`}
        onClick={() => onCommand('toggle-cursor')}
      >
        <MousePointer2 size={16} />
      </button>
      <button
        type="button"
        aria-label="Toggle theme"
        title="Toggle theme"
        className={button}
        onClick={() => onCommand('toggle-theme')}
      >
        {dark ? <Moon size={16} /> : <Sun size={16} />}
      </button>
    </div>
  );
}
