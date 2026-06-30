import { useTitleBar } from '../hooks/useTitleBar';
import { Controls } from './Controls';
import { NavControls } from './NavControls';
import { TitlePill } from './TitlePill';

/** The desktop title bar: pinned nav controls, a centered title pill, and utility controls. */
export function TitleBar() {
  const {
    canGoBack,
    canGoForward,
    title,
    dark,
    cursorOn,
    back,
    forward,
    command,
  } = useTitleBar();
  return (
    <>
      <NavControls
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={back}
        onForward={forward}
      />
      <TitlePill title={title} />
      <Controls dark={dark} cursorOn={cursorOn} onCommand={command} />
    </>
  );
}
