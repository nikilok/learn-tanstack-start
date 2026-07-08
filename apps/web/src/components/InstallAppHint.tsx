import { useQuery } from '@tanstack/react-query';

import { downloadsFlagQueryOptions } from '../api/flags';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import BrowserIcon from './BrowserIcon';
import { HEADER_CONTROL_CLASS, HEADER_ICON_CLASS } from './headerControls';

/**
 * Header PWA-install pill — the inverse of DownloadButton on the same `downloads`
 * flag. Shown only while the flag is OFF, so it offers the Chrome install right
 * in the header while /download is gated; when the flag is ON it hides and
 * install moves to the download page. Appears once a desktop Chromium browser has
 * offered an install (deferred prompt captured pre-hydration); clicking opens the
 * native install dialog.
 */
export default function InstallAppHint() {
  const { data: downloadsEnabled } = useQuery(downloadsFlagQueryOptions);
  const { installable, install } = useInstallPrompt();

  // Explicit `!== false`: stay hidden while the flag is still resolving so the
  // pill can't flash before a downloads-on value arrives.
  if (downloadsEnabled !== false || !installable) return null;

  return (
    <button
      type="button"
      onClick={install}
      aria-label="Install as Chrome-based app"
      title="Install as Chrome-based app"
      className={`group inline-flex items-center ${HEADER_CONTROL_CLASS}`}
    >
      <BrowserIcon
        className={`${HEADER_ICON_CLASS} grayscale transition group-hover:grayscale-0`}
      />
    </button>
  );
}
