import { Download as DownloadIcon } from 'lucide-react';

import ChromeIcon from './ChromeIcon';
import DownloadCard from './DownloadCard';

/**
 * /download "Web" card — installs the site as a Chromium PWA. Rendered only when
 * the browser has actually offered an install (the parent gates on
 * useInstallPrompt), so on unsupported browsers (Safari, Firefox) it's absent
 * rather than shown disabled.
 */
export default function WebAppCard({ onInstall }: { onInstall: () => void }) {
  return (
    <DownloadCard
      image={
        <div className="flex h-full w-full items-center justify-center">
          <ChromeIcon className="size-20" />
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
