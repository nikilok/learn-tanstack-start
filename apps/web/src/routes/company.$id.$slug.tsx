import {
  createFileRoute,
  redirect,
  stripSearchParams,
} from '@tanstack/react-router';

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
    throw redirect({
      to: '/company/$slug',
      params: { slug: target?.nameSlug ?? params.slug },
      search: {
        search: (location.search as { search?: string }).search ?? '',
      },
      statusCode: 301,
    });
  },
  component: () => null,
});
