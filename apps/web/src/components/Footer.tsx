import { Link } from '@tanstack/react-router';
import { Suspense } from 'react';

import DiscordLink from './DiscordLink';
import LastUpdated, { LastUpdatedSkeleton } from './LastUpdated';
import Logo from './Logo';
import LondonSkyline from './LondonSkyline';

/**
 * Site footer rendered as a solid, theme-aware "chrome" block (white in light,
 * near-black in dark) that reads as distinct from the glow-lit page above it.
 * Stacks a muted brand mark, circular social buttons, a legal row, and a faint
 * copyright line, with the `LastUpdated` ingestion pill straddling the top seam.
 */
export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer relative mt-20 px-4 pt-10 pb-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-full flex justify-center"
      >
        <LondonSkyline className="h-auto w-56 sm:w-72" />
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex -translate-y-1/2 justify-center">
        <div className="pointer-events-auto">
          <Suspense fallback={<LastUpdatedSkeleton />}>
            <LastUpdated />
          </Suspense>
        </div>
      </div>
      <div className="page-wrap flex flex-col items-center gap-6 text-center">
        <Link
          to="/"
          search={{ search: '' }}
          className="group rounded-md no-underline transition"
        >
          <Logo className="h-7 opacity-70 grayscale transition-opacity group-hover:opacity-100" />
        </Link>

        <div className="flex items-center gap-3">
          <a
            href="https://x.com/NikilKuruvilla"
            target="_blank"
            rel="noreferrer"
            className="rounded-md p-2 text-(--sea-ink-soft) no-underline transition hover:text-(--sea-ink)"
          >
            <span className="sr-only">Follow on X</span>
            <svg viewBox="0 0 16 16" aria-hidden="true" width="20" height="20">
              <path
                fill="currentColor"
                d="M12.6 1h2.2L10 6.48 15.64 15h-4.41L7.78 9.82 3.23 15H1l5.14-5.84L.72 1h4.52l3.12 4.73L12.6 1zm-.77 12.67h1.22L4.57 2.26H3.26l8.57 11.41z"
              />
            </svg>
          </a>
          <a
            href="https://github.com/nikilok"
            target="_blank"
            rel="noreferrer"
            className="rounded-md p-2 text-(--sea-ink-soft) no-underline transition hover:text-(--sea-ink)"
          >
            <span className="sr-only">Go to GitHub</span>
            <svg viewBox="0 0 16 16" aria-hidden="true" width="20" height="20">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"
              />
            </svg>
          </a>
          <DiscordLink />
        </div>

        <div className="flex flex-col items-center gap-2">
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-(--sea-ink-soft)">
            <span>Made in London</span>
            <span aria-hidden="true" className="text-(--sea-ink-faint)">
              &middot;
            </span>
            <Link
              to="/privacy"
              className="no-underline transition hover:text-(--sea-ink)"
            >
              Privacy Policy
            </Link>
            {/* hidden sm:contents — desktop installers are useless on a phone,
                so suppress below sm, matching the header DownloadButton's sm+
                visibility. */}
            <span className="footer-desktop-link hidden sm:contents">
              <span aria-hidden="true" className="text-(--sea-ink-faint)">
                &middot;
              </span>
              <Link
                to="/download"
                className="no-underline transition hover:text-(--sea-ink)"
              >
                Download
              </Link>
            </span>
          </div>

          <p className="m-0 text-xs text-(--sea-ink-faint)">
            &copy; {year} Nikil Kuruvilla. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
