import { Download as DownloadIcon } from 'lucide-react';

import { useInstallPrompt } from '../hooks/useInstallPrompt';
import ChromeIcon from './ChromeIcon';

/**
 * /download "Chrome App" card — installs the site as a Chromium PWA via the same
 * deferred install prompt as the header hint. Shows the install CTA only when
 * the browser has offered an install; otherwise a short availability note.
 */
export default function WebAppCard() {
  const { install } = useInstallPrompt();
  const installable = true; // TEMP force for screenshot
  return (
    <div className="flex items-center gap-5 rounded-xl border border-(--line) bg-(--sponsor-card-bg) p-6">
      <ChromeIcon className="size-16 shrink-0" />
      <div className="min-w-0">
        <h2 className="text-lg font-semibold text-(--sea-ink)">Chrome App</h2>
        <p className="mt-1 text-sm text-(--sea-ink-soft)">
          The web version installed locally for faster access.
        </p>
        {installable ? (
          <button
            type="button"
            onClick={install}
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-(--sea-ink) px-4 py-2 text-sm font-medium text-(--bg-base) transition hover:opacity-90"
          >
            <DownloadIcon className="size-4" aria-hidden="true" />
            Download Web
          </button>
        ) : (
          <p className="mt-3 text-xs text-(--sea-ink-faint)">
            Available in Chrome, Edge &amp; Brave.
          </p>
        )}
      </div>
    </div>
  );
}
