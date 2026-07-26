import {
  createFileRoute,
  notFound,
  redirect,
  stripSearchParams,
} from '@tanstack/react-router';

import { SHORT_EDGE_CACHE, setSsrCacheControl } from '../api/cache-headers';
import { getHmrcCompanyBySlug, getSlugForHash } from '../api/hmrc';
import { searchTermInput } from '../lib/search/params';

/**
 * Legacy hash-URL shim: /company/$id/$slug 301s to the slug-only page. The
 * hash resolves renames (its row carries the current slug); a vanished hash
 * falls back to the slug embedded in the URL, but only after confirming that
 * slug resolves — a 301 into a 404 is worse for crawlers than a clean 404.
 */
export const Route = createFileRoute('/company/$id/$slug')({
  // searchTermInput: the router JSON-parses ?search=365 into a NUMBER — a raw
  // string cast + .trim() throws before the loader can 301.
  validateSearch: (search: Record<string, unknown>) => ({
    search: searchTermInput(search.search),
  }),
  search: {
    middlewares: [stripSearchParams({ search: '' })],
  },
  loader: async ({ params, location }) => {
    const search = (location.search as { search?: string }).search ?? '';
    // A lookup failure must still redirect: the slug is already in the URL, so
    // a DB blip should not crash-screen the entire indexed legacy corpus.
    const target = await getSlugForHash({ data: { hash: params.id } }).catch(
      () => null,
    );
    if (target) {
      // Static search value — SSR redirects must not use a functional `search`.
      // Hash-resolved 301s inherit the /company/** routeRule's long cache: the
      // hash→slug mapping is durable.
      throw redirect({
        to: '/company/$slug',
        params: { slug: target.nameSlug },
        search: { search },
        statusCode: 301,
      });
    }

    // Dead hash: only redirect to the URL's own slug if it actually resolves
    // (directly or via the rename fallback), so a dead legacy URL 404s instead
    // of permanently redirecting crawlers into a 404. Short-cached — a later
    // ingest can revive either side.
    const echoed = await getHmrcCompanyBySlug({
      data: { slug: params.slug },
    }).catch(() => null);
    if (!echoed) {
      setSsrCacheControl(SHORT_EDGE_CACHE);
      throw notFound();
    }
    throw redirect({
      to: '/company/$slug',
      // Both variants carry the canonical slug: 'found' echoes it back
      // normalised, 'moved' gives the renamed target.
      params: { slug: echoed.nameSlug },
      search: { search },
      statusCode: 301,
      headers: { 'Cache-Control': SHORT_EDGE_CACHE },
    });
  },
  component: () => null,
});
