import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { stampPageFlip } from '../utils';

/**
 * A company page's way back to the search it came from, keeping the query: a link that rides the
 * bottom of the screen as a pill until the end of the page reaches it, and Esc. Shared by the page
 * and its frame while it loads (`CompanyScaffold`), so both look and leave the same way.
 */
export function BackToSearch({ search }: { search: string }) {
  const navigate = useNavigate();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);

  useEffect(() => {
    /** Esc, with no modifier held, goes back to the search. */
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      stampPageFlip('back');
      navigate({
        to: '/',
        search: { search },
        viewTransition: { types: ['back'] },
      });
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, search]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(([entry]) =>
      setStuck(!entry.isIntersecting),
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <Link
        to="/"
        search={{ search }}
        viewTransition={{ types: ['back'] }}
        onClick={() => stampPageFlip('back')}
        style={{ transition: 'none' }}
        className={`sticky bottom-6 z-10 mt-6 text-sm font-medium text-(--sea-ink-soft) no-underline hover:text-(--sea-ink) ${
          stuck
            ? 'glass mx-auto flex w-fit items-center rounded-full px-5 py-2.5 backdrop-blur-md!'
            : 'block w-full px-4 py-3 text-center'
        }`}
      >
        <span className={stuck ? 'shimmer-text' : undefined}>
          &larr; Back to search
        </span>
        <kbd className="ml-2 hidden font-sans text-xs pointer-fine:inline">
          Esc
        </kbd>
      </Link>
      <div ref={sentinelRef} aria-hidden className="h-px w-px" />
    </>
  );
}
