import {
  createFileRoute,
  notFound,
  redirect,
  stripSearchParams,
} from '@tanstack/react-router';

import {
  CACHE_TAG_HEADER,
  LONG_EDGE_CACHE,
  SHORT_EDGE_CACHE,
} from '../api/cache-headers';
import { ALL_COMPANY_PAGES_TAG } from '../api/cache-tags';
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
    /** A 301 to the slug page carrying its own cache headers (no route rule covers it). Static search value — SSR redirects must not use a functional `search`. */
    const redirectTo = (
      slug: string,
      headers: { 'Cache-Control': string } & Record<string, string>,
    ) =>
      redirect({
        to: '/company/$slug',
        params: { slug },
        search: { search },
        statusCode: 301,
        headers,
      });
    // Redirect to the slug already in the URL. Used whenever a lookup FAILS:
    // "the database is unreachable" must never be answered with 404, which
    // Googlebot reads as gone and drops — a blip would deindex the whole
    // legacy corpus mid-recovery. Short-cached so it is re-resolved soon.
    const redirectToUrlSlug = () =>
      redirectTo(params.slug, { 'Cache-Control': SHORT_EDGE_CACHE });

    // A REJECTION and a null result mean different things and must not collapse
    // into one branch: null is "this hash is gone" (a real answer), a rejection
    // is "we could not ask".
    let target: { nameSlug: string } | null = null;
    try {
      target = await getSlugForHash({ data: { hash: params.id } });
    } catch {
      throw redirectToUrlSlug();
    }
    // Hash-resolved 301s are long-cached (the hash→slug mapping is durable) and
    // tagged so the company-pages purge reaches them.
    if (target) {
      throw redirectTo(target.nameSlug, {
        'Cache-Control': LONG_EDGE_CACHE,
        [CACHE_TAG_HEADER]: ALL_COMPANY_PAGES_TAG,
      });
    }

    // Dead hash: only redirect to the URL's own slug if it actually resolves
    // (directly or via the rename fallback), so a dead legacy URL 404s instead
    // of permanently redirecting crawlers into a 404. The redirect is
    // short-cached and the 404 not edge-cached — a later ingest can revive
    // either side.
    let echoed: { nameSlug: string } | null = null;
    try {
      echoed = await getHmrcCompanyBySlug({ data: { slug: params.slug } });
    } catch {
      throw redirectToUrlSlug();
    }
    if (!echoed) throw notFound();
    // Both variants carry the canonical slug: 'found' echoes it back
    // normalised, 'moved' gives the renamed target.
    throw redirectTo(echoed.nameSlug, { 'Cache-Control': SHORT_EDGE_CACHE });
  },
  component: () => null,
});
