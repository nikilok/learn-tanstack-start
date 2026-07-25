import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useShortcut } from '../hooks/useShortcut';
import {
  filtersToSearchParams,
  parseSearchFilters,
  type SearchUrlParams,
} from '../lib/search/params';
import { loadStoredFilters } from '../lib/search/persist';
import { HEADER_CONTROL_CLASS, HEADER_ICON_CLASS } from './headerControls';
import { ariaKeyShortcuts } from './headerShortcuts';
import HeaderTooltip from './HeaderTooltip';

/** Registry-validated count of active filters in a raw search-param object — raw URL keys the registry drops must not badge. */
export function countActiveFilters(params: Record<string, unknown>): number {
  return Object.keys(
    filtersToSearchParams(
      parseSearchFilters({ ...params, q: undefined }).filters,
    ),
  ).length;
}

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
  const urlCount = countActiveFilters(current);
  const [storedCount, setStoredCount] = useState(0);
  useEffect(() => {
    setStoredCount(Object.keys(loadStoredFilters() ?? {}).length);
  }, [location.href]);
  const activeCount = onHome ? urlCount : storedCount;
  const label = activeCount > 0 ? `Filters (${activeCount} active)` : 'Filters';

  // Same destination as the link — the shortcut belongs to the control that owns it.
  const navigate = useNavigate();
  useShortcut('filters', () => {
    void navigate({
      to: '/filters',
      search: current as SearchUrlParams & { search?: string },
    });
  });

  return (
    <HeaderTooltip
      label="Filters"
      shortcut="filters"
      align="end"
      className="inline-flex"
    >
      <Link
        to="/filters"
        search={current as SearchUrlParams & { search?: string }}
        aria-label={label}
        aria-keyshortcuts={ariaKeyShortcuts('filters')}
        className={`${HEADER_CONTROL_CLASS} relative inline-flex no-underline`}
      >
        <SlidersHorizontal className={HEADER_ICON_CLASS} aria-hidden />
        {activeCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-(--logo-red) px-1 text-[10px] leading-none font-semibold text-white">
            {activeCount}
          </span>
        )}
      </Link>
    </HeaderTooltip>
  );
}
