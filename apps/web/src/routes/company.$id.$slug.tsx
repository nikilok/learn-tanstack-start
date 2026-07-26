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
    // Redirect to the slug already in the URL. Used whenever a lookup FAILS:
    // "the database is unreachable" must never be answered with 404, which
    // Googlebot reads as gone and drops — a blip would deindex the whole
    // legacy corpus mid-recovery. Short-cached so it is re-resolved soon.
    const redirectToUrlSlug = () =>
      redirect({
        to: '/company/$slug',
        params: { slug: params.slug },
        search: { search },
        statusCode: 301,
        headers: { 'Cache-Control': SHORT_EDGE_CACHE },
      });

    // A REJECTION and a null result mean different things and must not collapse
    // into one branch: null is "this hash is gone" (a real answer), a rejection
    // is "we could not ask".
    let target: { nameSlug: string } | null = null;
    try {
      target = await getSlugForHash({ data: { hash: params.id } });
    } catch {
      throw redirectToUrlSlug();
    }
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
    let echoed: { nameSlug: string } | null = null;
    try {
      echoed = await getHmrcCompanyBySlug({ data: { slug: params.slug } });
    } catch {
      throw redirectToUrlSlug();
    }
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
