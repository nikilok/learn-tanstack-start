import { Download as DownloadIcon } from 'lucide-react';

import BrowserIcon from './BrowserIcon';
import DownloadCard from './DownloadCard';

/**
 * /download "Web" card — installs the site as a Chromium PWA. Rendered only when
 * the browser has actually offered an install (the parent gates on
 * useInstallPrompt), so on unsupported browsers (Safari, Firefox) it's absent
 * rather than shown disabled. The icon reflects the visitor's actual browser.
 */
export default function WebAppCard({ onInstall }: { onInstall: () => void }) {
  return (
    <DownloadCard
      image={
        // Same sky gradient as Preview's no-wallpaper fallback — keeps the two
        // /download tiles reading as one set.
        <div className="flex h-full w-full items-center justify-center bg-linear-to-br from-[#c7d2e8] via-[#e9e2ee] to-[#f2dcc8] dark:from-[#131a33] dark:via-[#1d1430] dark:to-[#3a1d33]">
          <BrowserIcon className="size-20" />
        </div>
      }
      title="Web"
      description="The web version installed locally for faster access. Runs in its own window, no download required."
    >
      <button
        type="button"
        onClick={onInstall}
        className="inline-flex items-center gap-2 rounded-full bg-(--sea-ink) px-5 py-2.5 text-sm font-medium text-(--bg-base) transition hover:opacity-90"
      >
        <DownloadIcon className="size-4" aria-hidden="true" />
        Download Web
      </button>
    </DownloadCard>
  );
}
