import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';
import { Download as DownloadIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  type DesktopPlatform,
  desktopReleasesQueryOptions,
  ownerDesktopReleasesQueryOptions,
} from '../api/releases';
import DownloadCard from '../components/DownloadCard';
import { PLATFORM_LABEL, recommendedAsset } from '../components/downloadMeta';
import { DownloadVersion } from '../components/DownloadVersion';
import Preview from '../components/Preview';
import WebAppCard from '../components/WebAppCard';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import {
  type Arch,
  getUAData,
  parseArch,
  parsePlatform,
} from '../hooks/usePlatform';
import { buildCanonical } from '../utils/canonical';
import { buildDownloadJsonLd } from '../utils/jsonld';
import { buildSeoHead } from '../utils/seo';

export const Route = createFileRoute('/download')({
  // Resolve owner membership up front so the loader can render the owner's
  // public+private snapshot and skip the public fetch. The owner check is local
  // cookie crypto (no backend), so the load never stalls on it. The page itself
  // is public — anonymous visitors get `owner: false` and the public list.
  beforeLoad: async ({ context: { queryClient } }) => {
    const ownerView = await queryClient.ensureQueryData(
      ownerDesktopReleasesQueryOptions,
    );
    return { owner: ownerView.owner };
  },
  head: ({ match }) => {
    const pageTitle = 'SponsorSearch . Download';
    const pageDescription =
      'Download the SponsorSearch desktop app for macOS, Windows, and Linux. Same data, native window, auto-updating.';
    const canonicalUrl = buildCanonical(match.pathname);
    return buildSeoHead({
      title: pageTitle,
      description: pageDescription,
      canonicalUrl,
      jsonLd: buildDownloadJsonLd({
        description: pageDescription,
        canonicalUrl,
      }),
    });
  },
  loader: async ({ context: { queryClient, owner } }) => {
    // The owner view (already warmed in beforeLoad) is safe to resolve during
    // SSR: /download documents are rendered per-request (no cache routeRule),
    // so an owner's variant can never be served to anyone else. Owners render
    // that snapshot INSTEAD of the public list, so don't BLOCK on the public
    // fetch — the component's useQuery still warms it post-hydration for the
    // credential-downgrade swap.
    if (owner) return;
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

/** UA-string arch — SSR-stable and correct for Firefox/Safari + all x64. Chrome's reduced UA reports Linux as x86_64 even on ARM, so Client Hints refines this post-hydration (in the component). */
const detectArch = createIsomorphicFn()
  .server(() => parseArch(getRequestHeader('user-agent') ?? ''))
  .client(() => parseArch(navigator.userAgent));

// Live-preview demo companies — one is picked at random per visit. Keep names
// resolving against real sponsor rows: "JP Morgan Chase" needs the "Chase" word
// (bare "JP Morgan" trigram-matches unrelated Morgans; the row is "JPMorgan
// Chase Bank, National Association", so the top-hit fallback clicks it).
const PREVIEW_COMPANIES = ['Checkout', 'PhysicsX', 'JP Morgan Chase', 'Boeing'];

// Rolling-hills wallpapers behind the preview window (public/download/, WebP).
const PREVIEW_WALLPAPER = {
  light: '/download/wallpaper-light.webp',
  dark: '/download/wallpaper-dark.webp',
};

/** `/download` — desktop builds served from our CDN, grouped by version and platform. */
function Download() {
  const { data: ownerView } = useQuery(ownerDesktopReleasesQueryOptions);
  const owner = ownerView?.owner ?? false;
  // Owner renders the server's single consistent snapshot (public + private).
  // Do NOT merge the two lists: they refetch independently after a
  // publish/unpublish flip, and the stale/fresh overlap transiently duplicates
  // (or drops) the flipped release. The public query stays enabled for owners
  // (non-blocking, edge-cached RPC): if the ss-owner credential dies
  // mid-session, `owner` flips false and this must swap to an already-warm
  // public list, not flash the "coming soon" empty state.
  const { data: publicReleases = [] } = useQuery(desktopReleasesQueryOptions);
  const releases = owner ? (ownerView?.releases ?? []) : publicReleases;
  const os = detectOS();
  // Arch for the Linux hero: SSR-stable UA string first, then Client-Hints refine on
  // Chromium (its reduced UA lies about Linux arch). No visible flash — only the href swaps.
  const [arch, setArch] = useState<Arch | null>(detectArch);
  useEffect(() => {
    // Arch only steers the Linux hero (mac = Universal, win = x64) — skip it otherwise.
    if (os !== 'linux') return;
    const uaData = getUAData();
    if (!uaData?.getHighEntropyValues) return;
    let cancelled = false;
    uaData
      .getHighEntropyValues(['architecture', 'bitness'])
      .then((h) => {
        if (cancelled) return;
        const refined: Arch | null =
          h.architecture === 'arm' && h.bitness === '64'
            ? 'arm64'
            : h.architecture === 'x86' && h.bitness === '64'
              ? 'x64'
              : null;
        if (refined) setArch(refined);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [os]);
  const { installable: webInstallable, install } = useInstallPrompt();
  const [inApp, setInApp] = useState(false);
  // Stable per-mount pick; never SSR-rendered, so server/client differing is fine.
  const [previewCompany] = useState(
    () =>
      PREVIEW_COMPANIES[Math.floor(Math.random() * PREVIEW_COMPANIES.length)],
  );

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
  const hero =
    os && latest ? recommendedAsset(os, latest.assets[os], arch) : null;
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
              image={
                <Preview
                  company={previewCompany}
                  platform={heroOS}
                  wallpaper={PREVIEW_WALLPAPER}
                />
              }
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
              owner={owner}
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
