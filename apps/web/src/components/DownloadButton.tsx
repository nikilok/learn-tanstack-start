import { Link } from '@tanstack/react-router';

/** Primary header CTA → desktop-app download page; sm+ only. Inverted fill. */
export default function DownloadButton() {
  return (
    <Link
      to="/download"
      className="hidden shrink-0 items-center rounded-full bg-(--sea-ink) px-3.5 py-2 text-sm font-medium text-(--bg-base) no-underline transition hover:opacity-90 sm:inline-flex"
    >
      Download
    </Link>
  );
}
