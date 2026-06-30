import { useTitleBar } from '../hooks/useTitleBar';
import { NavControls } from './NavControls';
import { TitlePill } from './TitlePill';

/** The desktop title bar: pinned nav controls + a centered title pill, fed by the IPC bridge. */
export function TitleBar() {
  const { canGoBack, canGoForward, title, dark, back, forward } = useTitleBar();
  return (
    <>
      <NavControls
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={back}
        onForward={forward}
      />
      <TitlePill title={title} dark={dark} />
    </>
  );
}
