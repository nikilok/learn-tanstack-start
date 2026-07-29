/**
 * Polite fetcher for third-party company websites.
 *
 * Unlike ch-client.ts, which talks to one API we have a key for, this reaches
 * arbitrary hosts we do not control, from a job that runs with database
 * credentials in its environment. So it identifies itself, honours robots.txt,
 * refuses to resolve into private address space, caps how much it will read,
 * and gives up quickly.
 *
 * The policy decisions live in src/lib/websites/fetch-policy.ts so they can be
 * tested without a network; this module is the I/O around them.
 */

import { lookup } from 'node:dns/promises';

import {
  isAllowedByRobots,
  isPrivateAddress,
  parseRobots,
  type RobotsRules,
  urlVariants,
} from '../../src/lib/websites/fetch-policy.ts';

/** Named so an operator seeing it in their logs can find out who we are. */
export const USER_AGENT =
  'SponsorSearchBot/1.0 (+https://sponsorsearch.co.uk/about-our-crawler)';
/** The token robots.txt groups address us by. */
export const ROBOTS_AGENT = 'SponsorSearchBot';

const REQUEST_TIMEOUT_MS = 12_000;
const ROBOTS_TIMEOUT_MS = 8_000;
/** Enough for any disclosure footer; a page larger than this is not one we need
 *  to read in full, and reading it is someone else's bandwidth. */
const MAX_BYTES = 2_000_000;
/** Redirect hops we will follow ourselves. Node's own follower cannot be used
 *  because it re-issues the request without re-running our guards. */
const MAX_REDIRECTS = 5;

export type FetchFailure =
  | 'http_error'
  | 'tls'
  | 'dns_or_refused'
  | 'timeout'
  | 'blocked_by_robots'
  | 'private_address'
  | 'not_html'
  | 'too_large';

export type PageFetch =
  | { ok: true; url: string; status: number; html: string }
  | { ok: false; reason: FetchFailure; status?: number };

/** Classify a thrown fetch error, so a TLS name mismatch (which a host variant
 *  may fix) is distinguishable from a dead domain (which nothing will). */
function classify(err: unknown): FetchFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out|timeout|aborted/i.test(message)) return 'timeout';
  if (/TLS|certificate|CERT_|SSL/i.test(message)) return 'tls';
  return 'dns_or_refused';
}

const robotsCache = new Map<string, RobotsRules>();

/** Fetch and cache one origin's robots.txt. A missing or unreadable file means
 *  no restrictions, which is what the standard says to assume. */
async function robotsFor(origin: string): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;

  let rules: RobotsRules = { disallow: [], allow: [] };
  try {
    const target = new URL('/robots.txt', origin);
    // Same two protections fetchPage is built around, and for the same reasons:
    // a host answering /robots.txt with `302 Location: http://169.254.169.254/…`
    // would otherwise be followed before any guard saw the new target, and an
    // unbounded res.text() would buffer a "robots.txt" of any size at all.
    if ((await resolveHost(target.hostname)) !== 'public') {
      robotsCache.set(origin, rules);
      return rules;
    }
    const res = await fetch(target.href, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
      redirect: 'manual',
    });
    const type = res.headers.get('content-type') ?? '';
    // An HTML "404 page" served with 200 is not a robots.txt. A redirect is not
    // followed: robots.txt is defined for the origin it was requested from.
    if (res.ok && !/html/i.test(type)) {
      rules = parseRobots(await readCapped(res), ROBOTS_AGENT);
    } else {
      await res.body?.cancel();
    }
  } catch {
    // Unreachable robots.txt is not a reason to refuse the site.
  }
  robotsCache.set(origin, rules);
  return rules;
}

/**
 * Resolve the host, distinguishing "points somewhere we must not go" from
 * "does not resolve at all".
 *
 * Collapsing these into one boolean is a trap worth naming: a dead domain gets
 * reported as `private_address`, which is both the wrong diagnosis and, because
 * that reason is not retryable, stops the host variants from ever being tried.
 * On a 120-site sample that mislabelled 9.2% of rows and silently skipped the
 * retry they needed.
 */
async function resolveHost(
  hostname: string,
): Promise<'public' | 'private' | 'unresolvable'> {
  try {
    const addresses = await lookup(hostname, { all: true });
    if (addresses.length === 0) return 'unresolvable';
    return addresses.some((a) => isPrivateAddress(a.address))
      ? 'private'
      : 'public';
  } catch {
    return 'unresolvable';
  }
}

/**
 * Read at most MAX_BYTES of a response body.
 *
 * TRUNCATES rather than discarding. Returning null on overflow made an
 * oversized but perfectly live page a `too_large` failure, which fed the death
 * counter deterministically and killed the row for good; the same applied to a
 * mid-stream read error. What we came for is a disclosure footer, and the first
 * 2MB is far more likely to contain it than nothing is.
 */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    // Keep whatever arrived before the stream broke.
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

/** Every guard that must hold before we are allowed to request a URL. */
async function guard(target: URL): Promise<FetchFailure | null> {
  const resolution = await resolveHost(target.hostname);
  if (resolution === 'private') return 'private_address';
  if (resolution === 'unresolvable') return 'dns_or_refused';
  const rules = await robotsFor(target.origin);
  if (!isAllowedByRobots(rules, target.pathname || '/')) {
    return 'blocked_by_robots';
  }
  return null;
}

/**
 * Fetch one URL, applying every guard at EVERY hop. Does not try variants.
 *
 * Redirects are followed by hand rather than by `redirect: 'follow'`, because
 * the built-in follower re-issues the request itself and so never re-runs
 * resolveHost or the robots check. That left the private-address guard
 * protecting only the first hop: a parked or hostile domain answering
 * `302 Location: http://169.254.169.254/…` would have been fetched from a
 * runner holding database credentials, and its body could even have been
 * written into evidence_url as a company's proof of identity.
 */
export async function fetchPage(url: string): Promise<PageFetch> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { ok: false, reason: 'dns_or_refused' };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = await guard(current);
    if (blocked) return { ok: false, reason: blocked };

    try {
      const res = await fetch(current.href, {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'manual',
      });

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        try {
          current = new URL(location, current);
        } catch {
          return { ok: false, reason: 'http_error', status: res.status };
        }
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel();
        return { ok: false, reason: 'http_error', status: res.status };
      }
      const type = res.headers.get('content-type') ?? '';
      if (type && !/html|xml|text\/plain/i.test(type)) {
        await res.body?.cancel();
        return { ok: false, reason: 'not_html', status: res.status };
      }
      return {
        ok: true,
        url: current.href,
        status: res.status,
        html: await readCapped(res),
      };
    } catch (err) {
      return { ok: false, reason: classify(err) };
    }
  }
  // A redirect loop is a broken site, not a transient fault.
  return { ok: false, reason: 'http_error' };
}

export type SiteFetch = PageFetch & {
  attempts: number;
  /** The candidate that produced this outcome, BEFORE redirects. When it
   *  differs from the URL we were asked for, the stored URL does not itself
   *  work and only a host or scheme variant of it does — which is the ~8% of
   *  rows a single-attempt sweep would have demoted as dead. */
  attemptedUrl: string;
};

/**
 * Fetch a site, trying host and scheme variants before concluding it is dead.
 *
 * Only connection-level failures are retried. An HTTP error means the server
 * answered and said no, so a `www.` counterpart will not change that answer,
 * and a 404 on a franchise path is genuinely a dead link rather than a host
 * problem. Retrying those would just triple the request count for nothing.
 */
export async function fetchSite(
  url: string,
  onAttempt?: (candidate: string) => Promise<void> | void,
): Promise<SiteFetch> {
  const candidates = urlVariants(url);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'dns_or_refused',
      attempts: 0,
      attemptedUrl: url,
    };
  }

  const retryable = new Set<FetchFailure>(['tls', 'dns_or_refused', 'timeout']);
  let last: PageFetch = { ok: false, reason: 'dns_or_refused' };
  let attempts = 0;
  let attemptedUrl = candidates[0];

  for (const candidate of candidates) {
    if (attempts > 0) await onAttempt?.(candidate);
    attempts++;
    attemptedUrl = candidate;
    last = await fetchPage(candidate);
    if (last.ok) return { ...last, attempts, attemptedUrl };
    if (!retryable.has(last.reason)) return { ...last, attempts, attemptedUrl };
  }
  return { ...last, attempts, attemptedUrl };
}

/** Drop every cached robots.txt. Exposed for tests and long-lived processes. */
export function clearRobotsCache(): void {
  robotsCache.clear();
}
