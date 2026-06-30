import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';

/** Primary header CTA → the desktop-app download page. Inverted fill: dark-on-light, white-on-dark. */
export default function DownloadButton() {
  return (
    <Link
      to="/download"
      className="flex shrink-0 items-center gap-1.5 rounded-md bg-(--sea-ink) px-3.5 py-2.5 text-sm font-medium text-(--bg-base) no-underline transition hover:opacity-90 sm:px-3 sm:py-2"
    >
      <Download className="size-4" aria-hidden="true" />
      Download
    </Link>
  );
}
