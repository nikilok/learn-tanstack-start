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
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (res.ok) {
      const type = res.headers.get('content-type') ?? '';
      // An HTML "404 page" served with 200 is not a robots.txt.
      if (!/html/i.test(type)) {
        rules = parseRobots(await res.text(), ROBOTS_AGENT);
      }
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

/** Read at most MAX_BYTES of a response body, so one enormous page cannot stall
 *  or exhaust the job. */
async function readCapped(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

/** Fetch one URL, applying every guard. Does not try variants. */
export async function fetchPage(url: string): Promise<PageFetch> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'dns_or_refused' };
  }

  const resolution = await resolveHost(parsed.hostname);
  if (resolution === 'private') {
    return { ok: false, reason: 'private_address' };
  }
  if (resolution === 'unresolvable') {
    return { ok: false, reason: 'dns_or_refused' };
  }

  const rules = await robotsFor(parsed.origin);
  if (!isAllowedByRobots(rules, parsed.pathname || '/')) {
    return { ok: false, reason: 'blocked_by_robots' };
  }

  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, reason: 'http_error', status: res.status };
    }
    const type = res.headers.get('content-type') ?? '';
    if (type && !/html|xml|text\/plain/i.test(type)) {
      await res.body?.cancel();
      return { ok: false, reason: 'not_html', status: res.status };
    }
    const html = await readCapped(res);
    if (html === null)
      return { ok: false, reason: 'too_large', status: res.status };

    // res.url is the post-redirect address; a site that redirects to its real
    // home is live there, and that is what we want to record.
    return { ok: true, url: res.url || url, status: res.status, html };
  } catch (err) {
    return { ok: false, reason: classify(err) };
  }
}

export type SiteFetch = PageFetch & { attempts: number };

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
    return { ok: false, reason: 'dns_or_refused', attempts: 0 };
  }

  const retryable = new Set<FetchFailure>(['tls', 'dns_or_refused', 'timeout']);
  let last: PageFetch = { ok: false, reason: 'dns_or_refused' };
  let attempts = 0;

  for (const candidate of candidates) {
    if (attempts > 0) await onAttempt?.(candidate);
    attempts++;
    last = await fetchPage(candidate);
    if (last.ok) return { ...last, attempts };
    if (!retryable.has(last.reason)) return { ...last, attempts };
  }
  return { ...last, attempts };
}

/** Drop every cached robots.txt. Exposed for tests and long-lived processes. */
export function clearRobotsCache(): void {
  robotsCache.clear();
}
