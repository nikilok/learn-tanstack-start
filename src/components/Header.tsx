import { Link } from '@tanstack/react-router';
import ThemeToggle from './ThemeToggle';

export default function Header() {
  return (
    <header className="site-header sticky top-0 z-50 px-4 backdrop-blur-xl">
      <nav className="page-wrap flex flex-wrap items-center gap-x-3 gap-y-2 py-3 sm:py-4">
        <h2 className="m-0 shrink-0">
          <Link
            to="/"
            search={{ search: '' }}
            className="shadow-ring inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-semibold text-(--sea-ink) no-underline transition hover:bg-(--link-bg-hover)"
          >
            <span className="inline-block h-2 w-2 rounded-full bg-[linear-gradient(135deg,#0070f3,#7928ca)]" />
            TanStack Start
          </Link>
        </h2>

        <div className="ml-auto flex items-center gap-1.5 sm:ml-0 sm:gap-2">
          <a
            href="https://x.com/NikilKuruvilla"
            target="_blank"
            rel="noreferrer"
            className="hidden rounded-md p-2 text-(--sea-ink-soft) no-underline transition hover:text-(--sea-ink) sm:block"
          >
            <span className="sr-only">Follow TanStack on X</span>
            <svg viewBox="0 0 16 16" aria-hidden="true" width="18" height="18">
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
            className="hidden rounded-md p-2 text-(--sea-ink-soft) no-underline transition hover:text-(--sea-ink) sm:block"
          >
            <span className="sr-only">Go to TanStack GitHub</span>
            <svg viewBox="0 0 16 16" aria-hidden="true" width="18" height="18">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"
              />
            </svg>
          </a>

          <ThemeToggle />
        </div>

        <div className="order-3 flex w-full flex-wrap items-center gap-x-5 gap-y-1 pb-1 text-sm font-medium sm:order-2 sm:w-auto sm:flex-nowrap sm:pb-0">
          <Link
            to="/"
            search={{ search: '' }}
            className="nav-link"
            activeProps={{ className: 'nav-link is-active' }}
          >
            Home
          </Link>
        </div>
      </nav>
    </header>
  );
}
