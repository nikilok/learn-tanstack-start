import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';

/** Primary header CTA → desktop-app download page; sm+ only (no native mobile app yet). Inverted fill. */
export default function DownloadButton() {
  return (
    <Link
      to="/download"
      className="hidden shrink-0 items-center gap-1.5 rounded-full bg-(--sea-ink) px-3.5 py-2 text-sm font-medium text-(--bg-base) no-underline transition hover:opacity-90 sm:inline-flex"
    >
      <Download className="size-4" aria-hidden="true" />
      Download
    </Link>
  );
}
