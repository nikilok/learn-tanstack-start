import { Link } from '@tanstack/react-router';

import CursorToggle from './CursorToggle';
import DownloadButton from './DownloadButton';
import Logo from './Logo';
import ShareButton from './ShareButton';
import ThemeToggle from './ThemeToggle';

/**
 * Sticky top header with the site logo, social links, and theme toggle. Also
 * provides the `#header-pill-portal` mount point that `SearchBar` uses to render
 * its collapsed pill once the user scrolls past the inline search input.
 */
export default function Header() {
  return (
    <header className="site-header sticky top-0 z-50 px-4 backdrop-blur-xl">
      <nav className="page-wrap flex items-center gap-x-3 py-3 sm:py-4">
        <h2 className="m-0 shrink-0">
          <Link
            to="/"
            search={{ search: '' }}
            className="inline-flex items-center rounded-md px-3 py-1.5 no-underline transition hover:bg-(--link-bg-hover)"
          >
            <Logo className="h-6 sm:h-8" />
          </Link>
        </h2>

        <div id="header-pill-portal" className="ml-auto min-w-0 sm:ml-0" />

        <div className="flex shrink-0 items-center gap-2.5 sm:ml-auto sm:gap-2">
          <DownloadButton />
          <ShareButton />
          <CursorToggle />
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
