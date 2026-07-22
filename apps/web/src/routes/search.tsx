import { createFileRoute, Link, redirect } from '@tanstack/react-router';

import { searchAccessQueryOptions, searchFiltered } from '../api/filterSearch';
import { filterSearchKey, useFilterSearch } from '../hooks/useFilterSearch';
import {
  filtersToSearchParams,
  parseSearchFilters,
} from '../lib/search/params';
import { formatLocation, titleCase } from '../utils';

export const Route = createFileRoute('/search')({
  // The registry is the validator: URL params parse leniently into canonical
  // filters (junk dropped), kept in URL form — comma-joined strings, not
  // JSON arrays — so the canonicalized URL stays human/model-readable and
  // round-trips without a re-serialize redirect.
  validateSearch: (search: Record<string, unknown>) =>
    filtersToSearchParams(parseSearchFilters(search).filters),
  head: () => ({
    meta: [
      { title: 'SponsorSearch . Search' },
      // Gated, combinatorial URLs — never indexable.
      { name: 'robots', content: 'noindex' },
    ],
  }),
  // Gate: owners always; everyone on non-production builds. Resolved once per
  // session (staleTime Infinity in the query options).
  beforeLoad: async ({ context: { queryClient } }) => {
    const { allowed } = await queryClient.ensureQueryData(
      searchAccessQueryOptions,
    );
    if (!allowed) throw redirect({ to: '/', search: { search: '' } });
  },
  loaderDeps: ({ search }) => ({ search }),
  loader: async ({ context: { queryClient }, deps: { search } }) => {
    if (typeof window !== 'undefined') return;
    // Mirror useFilterSearch's key/params exactly or SSR data never matches.
    const { filters } = parseSearchFilters(search);
    // Don't await — let page 0 stream in while the shell renders.
    queryClient.prefetchInfiniteQuery({
      queryKey: ['filter-search', filterSearchKey(filters)],
      queryFn: () => searchFiltered({ data: { params: filters, offset: 0 } }),
      initialPageParam: 0,
    });
  },
  component: SearchPage,
});

/**
 * AI-mode search surface (Phase A shell): renders the filtered sponsor list
 * for whatever params are in the URL — the URL itself is the confirmation of
 * what the caller (or, in Phase B, the local model) asked for. Deliberately
 * simple: no chips, no virtualization; the finished UX lands with the NL
 * input.
 */
function SearchPage() {
  const filters = Route.useSearch();
  const { results, total, issues, isLoading, hasMore, loadingMore, fetchMore } =
    useFilterSearch(filters);

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <p className="island-kicker mb-3">Search UK sponsors</p>
        <h1 className="heading-card text-2xl font-semibold text-(--sea-ink)">
          {total === null
            ? '…'
            : `${total.toLocaleString('en-GB')} sponsor${total === 1 ? '' : 's'} match`}
        </h1>
        {issues.length > 0 && (
          <ul className="mt-2 list-none p-0 text-xs text-(--sea-ink-soft)">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        <div className="mt-6">
          {isLoading ? (
            <p className="text-sm text-(--sea-ink-soft)">Loading…</p>
          ) : results.length === 0 ? (
            <p className="text-sm text-(--sea-ink-soft)">No sponsors match.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {results.map((row) => (
                <li key={row.slugId}>
                  <Link
                    to="/company/$id/$slug"
                    params={{ id: row.slugId, slug: row.nameSlug }}
                    search={{ search: '' }}
                    className="-mx-4 block px-4 py-2 no-underline"
                  >
                    <h3 className="heading-card truncate text-base font-semibold text-(--sea-ink)">
                      {titleCase(row.organisationName)}
                    </h3>
                    <p className="truncate text-xs text-(--sea-ink-soft)">
                      {[
                        row.typeRating,
                        row.route,
                        formatLocation(row.locality, row.region),
                        row.companyStatus ?? undefined,
                        row.incorporatedOn
                          ? `inc. ${row.incorporatedOn.slice(0, 4)}`
                          : undefined,
                        row.sicPrimary ?? undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {hasMore && (
            <button
              type="button"
              onClick={() => fetchMore()}
              disabled={loadingMore}
              className="mt-4 cursor-pointer border-none bg-transparent p-0 text-sm text-(--link-blue)"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
