const BASE_URL = 'https://sponsorsearch.co.uk';

/**
 * Build a fully-qualified canonical URL for SEO `<link rel="canonical">`
 * tags. Drops empty-value search params and omits the `?` entirely when no
 * params remain.
 */
export function buildCanonical(
  pathname: string,
  search?: Record<string, string>,
) {
  const params = new URLSearchParams(search);
  for (const [key, value] of [...params.entries()]) {
    if (!value) params.delete(key);
  }
  const searchStr = params.toString();
  return `${BASE_URL}${pathname}${searchStr ? `?${searchStr}` : ''}`;
}
