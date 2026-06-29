import { Link } from '@tanstack/react-router';

import BlackHole from './BlackHole';

/**
 * 404 page: the error code reads "4 ● 4" with a black hole as the zero. The hole is the
 * shared BlackHole (a WGSL accretion-disk shader with a plain-ring placeholder/fallback),
 * so the page reads "4 O 4" until the shader fades in.
 */
export default function NotFound() {
  const digit = 'text-[clamp(72px,17vw,165px)] font-extrabold leading-none';

  return (
    <main className="page-wrap flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <h1 className="sr-only">404 — this page does not exist</h1>
      <div
        aria-hidden="true"
        className="flex items-center justify-center tracking-tighter text-(--sea-ink) select-none"
      >
        <span className={digit}>4</span>
        <BlackHole
          className="shrink-0"
          style={{
            width: 'clamp(150px,32vw,300px)',
            height: 'clamp(150px,32vw,300px)',
            margin: '0 -0.04em',
          }}
        />
        <span className={digit}>4</span>
      </div>
      <p className="mt-3 text-(--sea-ink-soft)">
        This page slipped past the event horizon.
      </p>
      <Link
        to="/"
        search={{ search: '' }}
        className="glass mt-8 inline-flex items-center rounded-full px-5 py-2.5 text-sm font-medium text-(--sea-ink) no-underline transition-[box-shadow] duration-300"
      >
        &larr; Back to search
      </Link>
    </main>
  );
}
