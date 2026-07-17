import { Check, Monitor, Moon, Share2, Sun } from 'lucide-react';

import { tooltipHover, tooltipLeave } from '../tooltip';
import { CursorIcon, CursorOffIcon } from './CursorIcons';

type Command = 'toggle-theme' | 'toggle-cursor' | 'share';

interface ControlsProps {
  themeMode: string;
  cursorOn: boolean;
  copied: boolean;
  onCommand: (cmd: Command) => void;
}

// p-2 around an 18px icon = 34px hit target, matching the web header's controls.
const button =
  'grid cursor-pointer place-items-center rounded-md p-2 text-(--tb-fg) opacity-[0.55] transition-opacity hover:opacity-100';

/** Top-right utility buttons (share / cursor / theme) absorbed from the web header. */
export function Controls({
  themeMode,
  cursorOn,
  copied,
  onCommand,
}: ControlsProps) {
  const ThemeIcon =
    themeMode === 'light' ? Sun : themeMode === 'dark' ? Moon : Monitor;
  return (
    <div
      className="no-drag flex items-center gap-2"
      onMouseLeave={tooltipLeave}
    >
      <button
        type="button"
        aria-label="Share this page"
        className={button}
        onClick={() => onCommand('share')}
        onMouseEnter={tooltipHover('share')}
      >
        {copied ? <Check size={18} /> : <Share2 size={18} />}
      </button>
      <button
        type="button"
        aria-label={cursorOn ? 'Custom cursor on' : 'Custom cursor off'}
        className={button}
        onClick={() => onCommand('toggle-cursor')}
        onMouseEnter={tooltipHover('toggle-cursor')}
      >
        {cursorOn ? <CursorIcon /> : <CursorOffIcon />}
      </button>
      <button
        type="button"
        aria-label="Toggle theme"
        className={button}
        onClick={() => onCommand('toggle-theme')}
        onMouseEnter={tooltipHover('toggle-theme')}
      >
        <ThemeIcon size={18} />
      </button>
    </div>
  );
}
