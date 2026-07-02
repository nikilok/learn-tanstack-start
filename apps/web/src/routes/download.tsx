import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/start-server-core';
import { Download as DownloadIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { downloadsFlagQueryOptions } from '../api/flags';
import {
  type DesktopPlatform,
  desktopReleasesQueryOptions,
} from '../api/releases';
import DesktopPreview from '../components/DesktopPreview';
import DownloadCard from '../components/DownloadCard';
import { PLATFORM_LABEL, recommendedAsset } from '../components/downloadMeta';
import { DownloadVersion } from '../components/DownloadVersion';
import WebAppCard from '../components/WebAppCard';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { parsePlatform } from '../hooks/usePlatform';

export const Route = createFileRoute('/download')({
  // Gated: when the downloads flag is off, /download 404s (NotFound) rather than
  // redirecting, so a visitor can't tell it's flag-restricted vs nonexistent.
  // Entry points are hidden too, so this only catches direct-URL / crawler hits.
  beforeLoad: async ({ context: { queryClient } }) => {
    // ensureQueryData (not a bare getDownloadsFlag call) so this single SSR eval
    // also warms the header/footer flag query for the /download render.
    if (!(await queryClient.ensureQueryData(downloadsFlagQueryOptions))) {
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

/**
 * Best-effort desktop OS via the shared parsePlatform (one UA heuristic for the
 * whole app) — null for mobile/ChromeOS/unknown so we never show a wrong desktop
 * CTA. (Newest iPadOS masquerades fully as "Macintosh" and evades any UA check.)
 */
function osFromUA(ua: string): DesktopPlatform | null {
  const { platform, isMobile } = parsePlatform(ua);
  if (isMobile || platform === 'chromeos' || platform === 'unknown')
    return null;
  return platform === 'windows' ? 'win' : platform;
}

/** Isomorphic OS detect — server reads the request UA header, client reads navigator — so the native hero button renders on SSR with no post-hydration flash. */
const detectOS = createIsomorphicFn()
  .server(() => osFromUA(getRequestHeader('user-agent') ?? ''))
  .client(() => osFromUA(navigator.userAgent));

/** `/download` — desktop builds served from our CDN, grouped by version and platform. */
function Download() {
  const { data: releases = [] } = useQuery(desktopReleasesQueryOptions);
  const os = detectOS();
  const { installable: webInstallable, install } = useInstallPrompt();
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
  // The preview just needs *a* platform; the CTA needs the *user's* platform —
  // mobile/unknown (os = null) gets the mac preview but never a wrong download button.
  const heroOS = os ?? 'mac';
  const hero = os && latest ? recommendedAsset(os, latest.assets[os]) : null;
  const cardCount = (hasDesktop ? 1 : 0) + (webInstallable ? 1 : 0);

  return (
    <main className="page-wrap mx-auto max-w-5xl px-4 py-12 text-(--sea-ink)">
      <h1 className="text-3xl font-bold">Download SponsorSearch</h1>
      <p className="mt-2 text-(--sea-ink-soft)">
        Available for macOS, Windows, and Linux.
      </p>

      {cardCount > 0 ? (
        <div
          className={`mt-8 grid gap-6 ${cardCount === 2 ? 'md:grid-cols-2' : 'sm:max-w-md'}`}
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
              ) : (
                <p className="text-sm text-(--sea-ink-soft)">
                  Available for macOS, Windows &amp; Linux — grab any build from
                  the version list below.
                </p>
              )}
            </DownloadCard>
          ) : null}
          {webInstallable ? <WebAppCard onInstall={install} /> : null}
        </div>
      ) : (
        <p className="mt-8 text-sm text-(--sea-ink-soft)">
          Desktop apps are coming soon — the web app installs in Chrome, Edge,
          or Brave.
        </p>
      )}

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
