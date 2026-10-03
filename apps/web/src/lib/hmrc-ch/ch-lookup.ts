import {
  type HmrcLocation,
  type ResolveResult,
  resolveOneSponsor,
} from './resolve-sponsor';

const CH_BASE_URL = 'https://api.company-information.service.gov.uk';
const CH_TIMEOUT_MS = 8_000;

/** One Companies House REST call's outcome. Status 0 is a transport failure: a network error, a timeout or an unreadable body. */
export type ChResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number };

/** Fetches one Companies House REST path. */
export type ChFetch = (path: string) => Promise<ChResponse>;

/** A lookup's answer when a Companies House call failed in a way that says nothing about the company. */
type Unavailable = { verdict: 'unavailable' };

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
  } catch {
    return { ok: false, status: 0 };
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

/** Thrown out of the resolver's fetch callback to stop it at the first transient failure. */
class ChUnavailable extends Error {}

/**
 * Runs the HMRC→CH resolver, stopping at the first transient Companies House
 * failure. A verdict reached without that call's answer, verified or
 * negative, rests on incomplete data, so the lookup reports unavailable and
 * nothing may be cached from it.
 */
export async function resolveWithoutGaps(
  orgName: string,
  location: HmrcLocation,
  fetchCh: ChFetch,
): Promise<ResolveResult | Unavailable> {
  try {
    return await resolveOneSponsor(orgName, location, async (path) => {
      const res = await fetchCh(path);
      if (res.ok) return res.data;
      if (isTransientChFailure(res.status)) throw new ChUnavailable();
      return null;
    });
  } catch (error) {
    if (error instanceof ChUnavailable) return { verdict: 'unavailable' };
    throw error;
  }
}
