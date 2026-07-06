import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { downloadsFlagQueryOptions } from '../api/flags';

/** Primary header CTA → desktop-app download page; gated by the `downloads` flag, sm+ only. Inverted fill. */
export default function DownloadButton() {
  const { data: enabled } = useQuery(downloadsFlagQueryOptions);
  if (!enabled) return null;
  return (
    <Link
      to="/download"
      className="hidden shrink-0 items-center rounded-full bg-(--sea-ink) px-3.5 py-2 text-sm font-medium text-(--bg-base) no-underline transition hover:opacity-90 sm:inline-flex"
    >
      Download
    </Link>
  );
}
