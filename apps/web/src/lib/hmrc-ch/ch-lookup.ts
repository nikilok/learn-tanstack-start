const CH_BASE_URL = 'https://api.company-information.service.gov.uk';
const CH_TIMEOUT_MS = 8_000;

/** One Companies House REST call's outcome. Status 0 is a transport failure: a network error, a timeout or an unreadable body, named by `cause`. */
export type ChResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number; cause?: string };

/** Fetches one Companies House REST path. */
export type ChFetch = (path: string) => Promise<ChResponse>;

/** A lookup's answer when a Companies House call failed in a way that says nothing about the company. */
export type Unavailable = { verdict: 'unavailable' };

/** Whether a failed Companies House call says nothing about the company. Only a 404 means "no such company"; a 429, a 5xx, an auth error or a transport failure can clear on retry. */
export function isTransientChFailure(status: number): boolean {
  return status !== 404;
}

/**
 * GET a Companies House REST path with Basic auth, under one timeout that
 * also covers the body read. Never throws: a non-2xx comes back as its
 * status and a transport failure as status 0. `fetchImpl`/`timeoutMs` are
 * injectable for tests.
 */
export async function fetchChApi(
  path: string,
  apiKey: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ChResponse> {
  const { fetchImpl = fetch, timeoutMs = CH_TIMEOUT_MS } = opts;
  try {
    const res = await fetchImpl(`${CH_BASE_URL}${path}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: (await res.json()) as unknown };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, cause };
  }
}

/** A mapped company's profile: found, absent (a 404: Companies House has no such company), or unavailable (a transient failure). */
export async function fetchMappedProfile(
  companyNumber: string,
  fetchCh: ChFetch,
): Promise<
  { verdict: 'found'; profile: unknown } | { verdict: 'absent' } | Unavailable
> {
  const res = await fetchCh(`/company/${companyNumber}`);
  if (res.ok) return { verdict: 'found', profile: res.data };
  return isTransientChFailure(res.status)
    ? { verdict: 'unavailable' }
    : { verdict: 'absent' };
}
