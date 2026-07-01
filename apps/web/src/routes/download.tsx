import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { Download as DownloadIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { getDownloadsFlag } from '../api/flags';
import {
  type DesktopPlatform,
  desktopReleasesQueryOptions,
} from '../api/releases';
import { PLATFORM_LABEL, recommendedAsset } from '../components/downloadMeta';
import { DownloadVersion } from '../components/DownloadVersion';

export const Route = createFileRoute('/download')({
  // Gated: when the downloads flag is off, /download 404s (NotFound) rather than
  // redirecting, so a visitor can't tell it's flag-restricted vs nonexistent.
  // Entry points are hidden too, so this only catches direct-URL / crawler hits.
  beforeLoad: async () => {
    if (!(await getDownloadsFlag())) {
      throw notFound();
    }
  },
  head: () => ({
    meta: [
      { title: 'Download the desktop app — SponsorSearch.co.uk' },
      {
        name: 'description',
        content:
          'Download the SponsorSearch desktop app for macOS, Windows and Linux. Same data, native window, auto-updating.',
      },
    ],
  }),
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(desktopReleasesQueryOptions);
  },
  component: Download,
});

/** Best-effort OS guess from the UA, to surface the most likely build first. */
function detectOS(): DesktopPlatform | null {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return 'mac';
  if (/Win/i.test(ua)) return 'win';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return null;
}

/** `/download` — desktop builds served from our CDN, grouped by version and platform. */
function Download() {
  const { data: releases = [] } = useQuery(desktopReleasesQueryOptions);
  const [os, setOS] = useState<DesktopPlatform | null>(null);
  const [inApp, setInApp] = useState(false);

  useEffect(() => {
    setOS(detectOS());
    setInApp(
      Boolean(
        (window as { isSponsorSearchDesktop?: boolean }).isSponsorSearchDesktop,
      ),
    );
  }, []);

  const latest = releases[0] ?? null;
  const hero = os && latest ? recommendedAsset(os, latest.assets[os]) : null;

  return (
    <main className="page-wrap mx-auto max-w-5xl px-4 py-12 text-(--sea-ink)">
      <h1 className="text-3xl font-bold">Download SponsorSearch</h1>
      <p className="mt-2 text-(--sea-ink-soft)">
        Available for macOS, Windows, and Linux.
      </p>

      {inApp ? (
        <p className="mt-4 text-sm text-(--sea-ink-soft)">
          You're already running the desktop app — it keeps itself up to date
          automatically.
        </p>
      ) : hero && os ? (
        <a
          href={hero.url}
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-(--sea-ink) px-5 py-2.5 text-sm font-medium text-(--bg-base) no-underline transition hover:opacity-90"
        >
          <DownloadIcon className="size-4" aria-hidden="true" />
          Download for {PLATFORM_LABEL[os]}
        </a>
      ) : null}

      {releases.length === 0 ? (
        <p className="mt-10 text-(--sea-ink-soft)">
          No releases published yet — check back soon.
        </p>
      ) : (
        <div className="mt-10">
          {releases.map((r, i) => (
            <DownloadVersion
              key={r.version}
              release={r}
              latest={i === 0}
              defaultOpen={i === 0}
            />
          ))}
        </div>
      )}

      <div className="mt-10">
        <Link to="/" search={{ search: '' }} className="text-(--link-blue)">
          ← Back to search
        </Link>
      </div>
    </main>
  );
}
