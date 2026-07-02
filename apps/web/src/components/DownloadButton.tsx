import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';

import { downloadsFlagQueryOptions } from '../api/flags';

/** Primary header CTA → desktop-app download page; gated by the `downloads` flag, sm+ only. Inverted fill. */
export default function DownloadButton() {
  const { data: enabled } = useQuery(downloadsFlagQueryOptions);
  if (!enabled) return null;
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
