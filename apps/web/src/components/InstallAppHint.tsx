import { useInstallPrompt } from '../hooks/useInstallPrompt';
import ChromeIcon from './ChromeIcon';

/**
 * Header "Install app" pill. Not dismissible — it appears once a desktop browser
 * has offered an install (deferred prompt captured pre-hydration by the Chromium-
 * gated INSTALL_PROMPT_INIT_SCRIPT) and disappears once installed. Clicking opens
 * the browser's native install dialog. Install state is shared with the /download
 * Chrome-app card via useInstallPrompt.
 */
export default function InstallAppHint() {
  const { installable, install } = useInstallPrompt();

  if (!installable) return null;

  return (
    <button
      type="button"
      onClick={install}
      aria-label="Install as Chrome-based app"
      title="Install as Chrome-based app"
      className="group install-pill-in install-rainbow shadow-ring hidden items-center rounded-md p-2.5 text-(--sea-ink-soft) transition hover:bg-(--link-bg-hover) hover:text-(--sea-ink) sm:inline-flex sm:p-2"
    >
      <ChromeIcon className="size-5 grayscale transition group-hover:grayscale-0 sm:size-[18px]" />
    </button>
  );
}
