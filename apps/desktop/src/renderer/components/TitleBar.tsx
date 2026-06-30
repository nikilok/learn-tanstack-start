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
      {/* Left: native traffic lights + logo share a frosted pill (its left padding clears
          the lights) so the logo stays legible over scrolling page content; nav pill beside. */}
      <div className="absolute top-1/2 left-2 flex -translate-y-1/2 items-center gap-2">
        <div className="flex h-8 items-center rounded-lg border border-(--tb-box-bd) bg-(--tb-box-bg) pr-3.5 pl-[102px] backdrop-blur-md">
          <Logo className="hidden h-5 w-auto sm:block" />
          <BrandMark className="size-5 sm:hidden" />
        </div>
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
