/**
 * Shared Companies House REST client for the backfill / sweep scripts. Basic
 * auth via COMPANIES_HOUSE_SEED_API_KEY (read lazily so callers' dotenv.config
 * runs first), 30s timeout, and retry on 429/5xx/network/parse honouring
 * Retry-After. Kept as one module so retry/timeout/auth policy can't drift
 * between scripts (the copy-paste the #258 review flagged).
 */

const BASE_URL = 'https://api.company-information.service.gov.uk';
const FETCH_MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;

/** Sleep for `ms` milliseconds. */
export function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

let cachedAuth: string | null = null;
/** Basic-auth header from COMPANIES_HOUSE_SEED_API_KEY; read on first use. */
function authHeader(): string {
  if (cachedAuth) return cachedAuth;
  const key = process.env.COMPANIES_HOUSE_SEED_API_KEY;
  if (!key) throw new Error('COMPANIES_HOUSE_SEED_API_KEY not set');
  cachedAuth = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  return cachedAuth;
}

/** Backoff for a 429/5xx, honouring Retry-After (seconds or HTTP date), capped. */
function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, MAX_BACKOFF_MS);
    const when = Date.parse(header);
    if (!Number.isNaN(when))
      return Math.min(Math.max(when - Date.now(), 0), MAX_BACKOFF_MS);
  }
  return 60_000;
}

export type FetchOutcome =
  | { ok: true; data: unknown }
  | { ok: false; notFound: boolean };

/** GET a CH REST path with Basic auth; retries 429/5xx/network/parse on backoff. */
export async function fetchApi(
  path: string,
  retriesLeft = FETCH_MAX_RETRIES,
): Promise<FetchOutcome> {
  // Resolve auth outside the try so a missing key fails fast rather than being
  // caught as a "network error" and retried 3×60s.
  const auth = authHeader();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: auth },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (retriesLeft <= 0) {
      console.error(`  network error for ${path}, giving up: ${err}`);
      return { ok: false, notFound: false };
    }
    await delay(60_000);
    return fetchApi(path, retriesLeft - 1);
  }
  clearTimeout(timeoutId);
  if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
    if (retriesLeft <= 0) {
      console.error(`  ${res.status} retries exhausted for ${path}`);
      return { ok: false, notFound: false };
    }
    const wait = retryAfterMs(res);
    console.log(
      `  ${res.status}, backing off ${Math.round(wait / 1000)}s… (${retriesLeft} left)`,
    );
    await delay(wait);
    return fetchApi(path, retriesLeft - 1);
  }
  if (res.status === 404 || res.status === 410)
    return { ok: false, notFound: true };
  if (!res.ok) {
    console.error(`  unexpected ${res.status} for ${path}`);
    return { ok: false, notFound: false };
  }
  // Parse inside the guard: a truncated / non-JSON 200 body is a transient error
  // (retryable), not an uncaught throw that kills the whole run.
  try {
    return { ok: true, data: await res.json() };
  } catch (err) {
    if (retriesLeft <= 0) {
      console.error(`  body parse failed for ${path}, giving up: ${err}`);
      return { ok: false, notFound: false };
    }
    await delay(60_000);
    return fetchApi(path, retriesLeft - 1);
  }
}
