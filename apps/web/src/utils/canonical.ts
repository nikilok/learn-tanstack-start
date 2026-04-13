const BASE_URL = 'https://sponsorsearch.co.uk';

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
