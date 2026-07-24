import { Link, useLocation } from '@tanstack/react-router';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { SearchUrlParams } from '../lib/search/params';
import { loadStoredFilters } from '../lib/search/persist';
import { HEADER_CONTROL_CLASS, HEADER_ICON_CLASS } from './headerControls';

/**
 * Header action linking to the /filters page, badged with the number of
 * active filters. On home the count reads the URL (SSR-safe); on every other
 * page it reads the persisted set post-hydration — the filters are durable,
 * so the badge must not vanish just because this page's URL doesn't carry
 * them. The link carries home's params when available; /filters prefills
 * from storage otherwise.
 */
export default function FiltersButton() {
  const location = useLocation();
  const onHome = location.pathname === '/';
  const current = (onHome ? location.search : {}) as Record<string, unknown>;
  const urlCount = Object.keys(current).filter(
    (key) => key !== 'search' && current[key] !== undefined,
  ).length;
  const [storedCount, setStoredCount] = useState(0);
  useEffect(() => {
    setStoredCount(Object.keys(loadStoredFilters() ?? {}).length);
  }, [location.href]);
  const activeCount = onHome ? urlCount : storedCount;
  const label = activeCount > 0 ? `Filters (${activeCount} active)` : 'Filters';
  return (
    <Link
      to="/filters"
      search={current as SearchUrlParams & { search?: string }}
      aria-label={label}
      title={label}
      className={`${HEADER_CONTROL_CLASS} relative inline-flex no-underline`}
    >
      <SlidersHorizontal className={HEADER_ICON_CLASS} aria-hidden />
      {activeCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-(--logo-red) px-1 text-[10px] leading-none font-semibold text-white">
          {activeCount}
        </span>
      )}
    </Link>
  );
}
