/**
 * Serper client: one company name in, ranked result URLs out.
 *
 * Kept deliberately thin. Everything that decides anything lives in
 * lib/websites/discover.ts where it can be tested without a network or a
 * credit, and this file only knows how to ask.
 *
 * Chosen over running SearXNG on a persistent host after measuring both on the
 * same 150 companies whose websites we already knew: Serper reached 80.7%
 * recall at rank 5, SearXNG 70% at rank 10 with three of its four general
 * engines blocked mid-run. SearXNG's recall also rested on a hardcoded Google
 * Custom Search id belonging to a third party, on a product Google retires on
 * 1 January 2027.
 */

/** One credit per query at ten results, two beyond that — so ten it is. */
const RESULTS_PER_QUERY = 10;

const ENDPOINT = 'https://google.serper.dev/search';

export type SearchOutcome =
  | { ok: true; urls: string[] }
  | {
      ok: false;
      reason: 'auth' | 'rate_limit' | 'out_of_credits' | 'http' | 'network';
      status?: number;
    };

/**
 * Run one query and return organic result URLs in rank order.
 *
 * `gl: 'gb'` is not cosmetic. Every company here is UK-registered and UK
 * company names collide heavily with American ones, so an unlocalised query
 * spends its top results on the wrong country.
 *
 * Failure modes are distinguished rather than collapsed because they need
 * different responses: an exhausted balance must stop the whole run, while a
 * single rate-limited query should just be retried later.
 */
export async function searchCompany(
  query: string,
  apiKey: string,
  timeoutMs = 30_000,
): Promise<SearchOutcome> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        q: query,
        gl: 'gb',
        hl: 'en',
        num: RESULTS_PER_QUERY,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }

  if (!res.ok) {
    // 403 covers both a bad key and an exhausted balance; the body
    // distinguishes them, and the difference decides whether the run continues.
    if (res.status === 401) return { ok: false, reason: 'auth', status: 401 };
    if (res.status === 429) {
      return { ok: false, reason: 'rate_limit', status: 429 };
    }
    // Serper answers an exhausted balance with 402. Falling through to the
    // generic `http` reason would spend ten more rows on the failure streak
    // before the run stopped, each one a query that could never have worked.
    if (res.status === 402) {
      return { ok: false, reason: 'out_of_credits', status: 402 };
    }
    if (res.status === 403) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        reason: /credit|balance|quota/i.test(body) ? 'out_of_credits' : 'auth',
        status: 403,
      };
    }
    return { ok: false, reason: 'http', status: res.status };
  }

  // A truncated or non-JSON 200 is a FAILURE, not an empty result set. Read as
  // "no results" it would bank an empty candidate list and write a permanent
  // `none` for a company that was never actually searched — a credit spent on
  // a wrong answer that nothing would ever revisit.
  let body: { organic?: { link?: string }[]; message?: string } | null = null;
  try {
    body = (await res.json()) as { organic?: { link?: string }[] };
  } catch {
    return { ok: false, reason: 'http', status: res.status };
  }
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'http', status: res.status };
  }
  // A body that parsed but carries an error message is a failure wearing a
  // 200. A body with no `organic` key at all is Serper's shape for a query
  // with zero organic results, which is a real answer worth banking — reading
  // it as a failure meant that company was re-searched and re-charged on every
  // future run, forever.
  if ('message' in body && !('organic' in body)) {
    return { ok: false, reason: 'http', status: res.status };
  }
  const organic = Array.isArray(body.organic) ? body.organic : [];
  return { ok: true, urls: organic.map((r) => r.link ?? '').filter(Boolean) };
}
