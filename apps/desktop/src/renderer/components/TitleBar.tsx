import { useTitleBar } from '../hooks/useTitleBar';
import { Controls } from './Controls';
import { Logo } from './Logo';
import { NavControls } from './NavControls';
import { TitlePill } from './TitlePill';
import { WindowControls } from './WindowControls';

/** The desktop title bar. macOS uses native traffic lights (left); Windows/Linux draw their own window buttons (right). */
export function TitleBar() {
  const {
    canGoBack,
    canGoForward,
    title,
    themeMode,
    cursorOn,
    copied,
    platform,
    maximized,
    back,
    forward,
    command,
    windowControl,
  } = useTitleBar();
  const isMac = platform === 'darwin';

  const controls = (
    <Controls
      themeMode={themeMode}
      cursorOn={cursorOn}
      copied={copied}
      onCommand={command}
    />
  );

  return (
    <>
      {/* Left cluster: logo Home button + nav arrows. macOS traffic-light gutter is padding on the cluster (a drag region), not the no-drag button — else clicks beside the lights navigate home and lose window-drag. */}
      <div
        className={`absolute top-1/2 left-2 flex -translate-y-1/2 items-center gap-2 ${
          isMac ? 'pl-[102px]' : ''
        }`}
      >
        <button
          type="button"
          aria-label="Go to home page"
          title="Home"
          onClick={() => command('home')}
          className={`no-drag flex h-8 cursor-pointer items-center transition-opacity hover:opacity-80 ${
            isMac ? 'pr-3.5' : 'px-3.5'
          }`}
        >
          <Logo className="h-7 w-auto" />
        </button>
        <NavControls
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onBack={back}
          onForward={forward}
        />
      </div>

      <TitlePill title={title} />

      {/* Right: utility controls. On Windows/Linux the custom window buttons sit at the corner. */}
      {isMac ? (
        <div className="absolute top-1/2 right-(--tb-controls-right) -translate-y-1/2">
          {controls}
        </div>
      ) : (
        <div className="absolute top-0 right-0 flex h-full">
          <div className="flex items-center px-2">{controls}</div>
          <WindowControls maximized={maximized} onAction={windowControl} />
        </div>
      )}
    </>
  );
}
