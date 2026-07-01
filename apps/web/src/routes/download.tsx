import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/start-server-core';
import { Download as DownloadIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { getDownloadsFlag } from '../api/flags';
import {
  type DesktopPlatform,
  desktopReleasesQueryOptions,
} from '../api/releases';
import DesktopPreview from '../components/DesktopPreview';
import DownloadCard from '../components/DownloadCard';
import { PLATFORM_LABEL, recommendedAsset } from '../components/downloadMeta';
import { DownloadVersion } from '../components/DownloadVersion';
import WebAppCard from '../components/WebAppCard';

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

/** Best-effort OS from a UA string, to surface the most likely build first. */
function osFromUA(ua: string): DesktopPlatform | null {
  if (/Mac/i.test(ua)) return 'mac';
  if (/Win/i.test(ua)) return 'win';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return null;
}

/** Isomorphic OS detect — server reads the request UA header, client reads navigator — so the native hero button renders on SSR with no post-hydration flash. */
const detectOS = createIsomorphicFn()
  .server(() => osFromUA(getRequestHeader('user-agent') ?? ''))
  .client(() => osFromUA(navigator.userAgent));

/** `/download` — desktop builds served from our CDN, grouped by version and platform. */
function Download() {
  const { data: releases = [] } = useQuery(desktopReleasesQueryOptions);
  const os = detectOS();
  const [inApp, setInApp] = useState(false);

  useEffect(() => {
    setInApp(
      Boolean(
        (window as { isSponsorSearchDesktop?: boolean }).isSponsorSearchDesktop,
      ),
    );
  }, []);

  const latest = releases[0] ?? null;
  const hasDesktop = releases.length > 0;
  const heroOS = os ?? 'mac';
  const hero = latest ? recommendedAsset(heroOS, latest.assets[heroOS]) : null;

  return (
    <main className="page-wrap mx-auto max-w-5xl px-4 py-12 text-(--sea-ink)">
      <h1 className="text-3xl font-bold">Download SponsorSearch</h1>
      <p className="mt-2 text-(--sea-ink-soft)">
        Available for macOS, Windows, and Linux.
      </p>

      <div
        className={`mt-8 grid gap-6 ${hasDesktop ? 'md:grid-cols-2' : 'sm:max-w-md'}`}
      >
        {hasDesktop ? (
          <DownloadCard
            image={<DesktopPreview platform={heroOS} />}
            title="Desktop"
            description="A native window with the same up-to-the-day data — installs and auto-updates like any app."
          >
            {inApp ? (
              <p className="text-sm text-(--sea-ink-soft)">
                You're already running the desktop app — it keeps itself up to
                date automatically.
              </p>
            ) : hero ? (
              <a
                href={hero.url}
                className="inline-flex items-center gap-2 rounded-full bg-(--sea-ink) px-5 py-2.5 text-sm font-medium text-(--bg-base) no-underline transition hover:opacity-90"
              >
                <DownloadIcon className="size-4" aria-hidden="true" />
                Download for {PLATFORM_LABEL[heroOS]}
              </a>
            ) : null}
          </DownloadCard>
        ) : null}
        <WebAppCard />
      </div>

      {hasDesktop ? (
        <div className="mt-12">
          {releases.map((r, i) => (
            <DownloadVersion
              key={r.version}
              release={r}
              latest={i === 0}
              defaultOpen={i === 0}
            />
          ))}
        </div>
      ) : null}

      <div className="mt-10">
        <Link to="/" search={{ search: '' }} className="text-(--link-blue)">
          ← Back to search
        </Link>
      </div>
    </main>
  );
}
