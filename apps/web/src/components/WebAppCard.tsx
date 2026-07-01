import { Download as DownloadIcon } from 'lucide-react';

import { useInstallPrompt } from '../hooks/useInstallPrompt';
import ChromeIcon from './ChromeIcon';
import DownloadCard from './DownloadCard';

/**
 * /download "Web" card — installs the site as a Chromium PWA via the deferred
 * install prompt. Shows the install CTA only when the browser has offered an
 * install; otherwise a short availability note. Always present (the web app is
 * available even before any native release exists).
 */
export default function WebAppCard() {
  const { installable, install } = useInstallPrompt();
  return (
    <DownloadCard
      icon={<ChromeIcon className="size-20" />}
      title="Web"
      description="The web version installed locally for faster access. Runs in its own window, no download required."
    >
      {installable ? (
        <button
          type="button"
          onClick={install}
          className="inline-flex items-center gap-2 rounded-full bg-(--sea-ink) px-5 py-2.5 text-sm font-medium text-(--bg-base) transition hover:opacity-90"
        >
          <DownloadIcon className="size-4" aria-hidden="true" />
          Download Web
        </button>
      ) : (
        <p className="text-xs text-(--sea-ink-faint)">
          Available in Chrome, Edge &amp; Brave.
        </p>
      )}
    </DownloadCard>
  );
}
