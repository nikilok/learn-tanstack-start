import { useTitleBar } from '../hooks/useTitleBar';
import { BrandMark } from './BrandMark';
import { Controls } from './Controls';
import { Logo } from './Logo';
import { NavControls } from './NavControls';
import { TitlePill } from './TitlePill';

/** The desktop title bar: brand mark + nav controls, a centered title pill, and utility controls. */
export function TitleBar() {
  const {
    canGoBack,
    canGoForward,
    title,
    themeMode,
    cursorOn,
    copied,
    back,
    forward,
    command,
  } = useTitleBar();
  return (
    <>
      {/* Left cluster: theme-aware logo (full wordmark >= sm, brand mark < sm) + nav pill. */}
      <div className="absolute top-1/2 left-25 flex -translate-y-1/2 items-center gap-2.5">
        <Logo className="hidden h-6 w-auto sm:block" />
        <BrandMark className="size-6 sm:hidden" />
        <NavControls
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onBack={back}
          onForward={forward}
        />
      </div>
      <TitlePill title={title} />
      <Controls
        themeMode={themeMode}
        cursorOn={cursorOn}
        copied={copied}
        onCommand={command}
      />
    </>
  );
}
