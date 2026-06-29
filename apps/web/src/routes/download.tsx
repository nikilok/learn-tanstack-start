import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

const REPO = 'nikilok/learn-tanstack-start';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const assetUrl = (file: string) =>
  `https://github.com/${REPO}/releases/latest/download/${file}`;

interface Build {
  os: 'mac' | 'win' | 'linux';
  label: string;
  file: string;
  note: string;
}

// Filenames are the stable (version-less) artifact names from electron-builder.yml,
// so the `releases/latest/download/<file>` links always resolve to the newest build.
const BUILDS: Build[] = [
  {
    os: 'mac',
    label: 'macOS',
    file: 'SponsorSearch-mac-universal.dmg',
    note: 'Universal — Apple Silicon & Intel',
  },
  {
    os: 'win',
    label: 'Windows',
    file: 'SponsorSearch-win-x64.exe',
    note: '64-bit — Windows 10 & 11',
  },
  {
    os: 'linux',
    label: 'Linux',
    file: 'SponsorSearch-linux-x64.AppImage',
    note: 'AppImage — 64-bit',
  },
];

export const Route = createFileRoute('/download')({
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
  component: Download,
});

/** Best-effort OS guess from the UA, used only to surface the most likely build first. */
function detectOS(): Build['os'] | null {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return 'mac';
  if (/Win/i.test(ua)) return 'win';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return null;
}

/** Static `/download` page — native desktop builds served from GitHub Releases, OS-ordered. */
function Download() {
  const [os, setOS] = useState<Build['os'] | null>(null);
  const [inApp, setInApp] = useState(false);

  useEffect(() => {
    setOS(detectOS());
    setInApp(
      Boolean(
        (window as { isSponsorSearchDesktop?: boolean }).isSponsorSearchDesktop,
      ),
    );
  }, []);

  const builds = os
    ? [
        ...BUILDS.filter((b) => b.os === os),
        ...BUILDS.filter((b) => b.os !== os),
      ]
    : BUILDS;

  return (
    <main className="page-wrap mx-auto max-w-2xl px-4 py-12 text-(--sea-ink)">
      <h1 className="text-3xl font-bold">Desktop app</h1>
      <p className="mt-3 leading-relaxed text-(--sea-ink-soft)">
        {inApp
          ? "You're already running the SponsorSearch desktop app — it keeps itself up to date automatically."
          : 'A native window for SponsorSearch with the same up-to-the-day data. It installs like any app and updates itself.'}
      </p>

      <div className="mt-8 flex flex-col gap-3">
        {builds.map((b) => (
          <a
            key={b.os}
            href={assetUrl(b.file)}
            className="flex items-center justify-between rounded-lg border border-(--sea-ink-faint) px-4 py-3 no-underline transition hover:border-(--link-blue) hover:bg-(--link-bg-hover)"
          >
            <span className="flex flex-col">
              <span className="font-semibold text-(--sea-ink)">
                Download for {b.label}
                {os === b.os ? (
                  <span className="ml-2 text-xs font-normal text-(--link-blue)">
                    detected
                  </span>
                ) : null}
              </span>
              <span className="text-sm text-(--sea-ink-soft)">{b.note}</span>
            </span>
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-5 text-(--sea-ink-soft)"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3v12" />
              <path d="M7 11 12 16 17 11" />
              <path d="M5 20h14" />
            </svg>
          </a>
        ))}
      </div>

      <p className="mt-6 text-sm text-(--sea-ink-soft)">
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          className="text-(--link-blue)"
        >
          All versions and release notes →
        </a>
      </p>

      <div className="mt-8">
        <Link to="/" search={{ search: '' }} className="text-(--link-blue)">
          ← Back to search
        </Link>
      </div>
    </main>
  );
}
