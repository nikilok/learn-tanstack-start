import {
  createFileRoute,
  redirect,
  stripSearchParams,
} from '@tanstack/react-router';

import { SHORT_EDGE_CACHE } from '../api/cache-headers';
import { getSlugForHash } from '../api/hmrc';

/**
 * Legacy hash-URL shim: /company/$id/$slug 301s to the slug-only page. The
 * hash resolves renames (its row carries the current slug); a vanished hash
 * falls back to the slug embedded in the URL, which company.$slug re-resolves
 * through the rename fallback or 404s.
 */
export const Route = createFileRoute('/company/$id/$slug')({
  validateSearch: (search: Record<string, unknown>) => ({
    search: ((search.search as string) || '').trim(),
  }),
  search: {
    middlewares: [stripSearchParams({ search: '' })],
  },
  loader: async ({ params, location }) => {
    const target = await getSlugForHash({ data: { hash: params.id } });
    // Static search value — SSR redirects must not use a functional `search`.
    // Hash-resolved 301s inherit the /company/** routeRule's long cache (the
    // mapping is durable); a dead-hash GUESS at the embedded slug must stay
    // short-cached — the guess can 404 today and resolve after a later ingest.
    throw redirect({
      to: '/company/$slug',
      params: { slug: target?.nameSlug ?? params.slug },
      search: {
        search: (location.search as { search?: string }).search ?? '',
      },
      statusCode: 301,
      ...(target ? {} : { headers: { 'Cache-Control': SHORT_EDGE_CACHE } }),
    });
  },
  component: () => null,
});
