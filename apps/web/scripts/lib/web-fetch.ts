/**
 * Polite fetcher for third-party company websites.
 *
 * Unlike ch-client.ts, which talks to one API we have a key for, this reaches
 * arbitrary hosts we do not control, from a job that runs with database
 * credentials in its environment. So it identifies itself, honours robots.txt,
 * refuses to resolve into private address space, sends each request to an
 * address it resolved (address-binding.ts), caps how much it will read, and
 * gives up quickly. A walk also paces it by hosting address (address-gate.ts).
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
import {
  accepts,
  asAsked,
  bindTo,
  type Dial,
  firstToAccept,
  portOf,
} from './address-binding.ts';
import {
  type AddressGate,
  makeAddressGate,
  type Outcome,
} from './address-gate.ts';
import { fileLedger, sharedLedgerDir } from './address-ledger.ts';

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
/** Redirect hops followed for robots.txt, guarded the same way. */
const ROBOTS_REDIRECTS = 3;
/** Gap between variant attempts against the same host. */
const VARIANT_DELAY_MS = 400;

export type FetchFailure =
  | 'http_error'
  | 'tls'
  | 'dns_or_refused'
  | 'timeout'
  | 'blocked_by_robots'
  | 'private_address'
  | 'not_html'
  | 'too_large'
  // Not sent: the address had stopped answering this run (address-gate.ts).
  | 'address_paused';

export type PageFetch =
  | { ok: true; url: string; status: number; html: string }
  | { ok: false; reason: FetchFailure; status?: number };

/** What the fetcher resolves, dials and requests with, and the gate its requests wait at. */
export type FetchIo = {
  /** Every address a host resolves to. */
  lookup(hostname: string): Promise<{ address: string }[]>;
  /** Whether an address accepts a connection: how a host on several is chosen an address. */
  connect: Dial;
  fetch(url: string, init: BunFetchRequestInit): Promise<Response>;
  /** Null paces nothing, which is how every caller but a walk runs. */
  gate: AddressGate | null;
};

let io: FetchIo = {
  lookup: (hostname) => lookup(hostname, { all: true }),
  connect: accepts,
  fetch: (url, init) => fetch(url, init),
  gate: null,
};

/** Replace part of the fetcher's I/O for this process: a walk installs its address gate, a test its resolver and fetch. Returns what puts the previous I/O back. */
export function configureFetch(overrides: Partial<FetchIo>): () => void {
  const previous = io;
  io = { ...io, ...overrides };
  return () => {
    io = previous;
  };
}

/** Pace every request this process sends by its hosting address, taking turns with every other walk that shares `ledgerDir`. Returns the gate, for its counts. */
export function paceByAddress(
  gapMs: number,
  log: (message: string) => void,
  ledgerDir = sharedLedgerDir(),
): AddressGate {
  const gate = makeAddressGate({
    gapMs,
    ledger: fileLedger(ledgerDir, { warn: log }),
    log,
  });
  configureFetch({ gate });
  return gate;
}

/** Classify a thrown fetch error, so a TLS name mismatch (which a host variant
 *  may fix) is distinguishable from a dead domain (which nothing will). */
function classify(err: unknown): FetchFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out|timeout|aborted/i.test(message)) return 'timeout';
  if (/TLS|certificate|CERT_|SSL/i.test(message)) return 'tls';
  return 'dns_or_refused';
}

/** The address each origin last answered at: where its host is on several, it is asked there again without another dial. */
const answeredAt = new Map<string, string>();

/**
 * The address a request is sent to: its host's only one, the one its origin
 * last answered at, else the first of them to accept a connection. When none
 * accepts, `unanswered` holds each one dialled that did not refuse either.
 */
async function addressFor(
  target: URL,
  addresses: readonly string[],
  limit: AbortSignal,
  unanswered: string[],
): Promise<string> {
  if (addresses.length === 1) return addresses[0];
  const last = answeredAt.get(target.origin);
  if (last && addresses.includes(last)) return last;
  /** A dial that notes its address, and forgets one that refuses. */
  const dial: Dial = async (address, port, signal) => {
    unanswered.push(address);
    try {
      await io.connect(address, port, signal);
    } catch (err) {
      // Ended by the time limit, it never answered either way.
      if (!signal.aborted) unanswered.splice(unanswered.indexOf(address), 1);
      throw err;
    }
  };
  return firstToAccept(addresses, portOf(target), limit, dial);
}

/** One request, sent to one address its host resolved to, under the host's own name. */
async function ask(
  target: URL,
  address: string,
  headers: Record<string, string>,
  limit: AbortSignal,
): Promise<Response> {
  const bound = bindTo(target, address);
  try {
    const res = await io.fetch(bound.url, {
      headers: { ...headers, host: bound.host },
      signal: limit,
      redirect: 'manual',
      ...(bound.serverName && { tls: { serverName: bound.serverName } }),
    });
    answeredAt.set(target.origin, address);
    return res;
  } catch (err) {
    answeredAt.delete(target.origin);
    throw asAsked(err, bound.url, target.href);
  }
}

/**
 * One request, sent in its turn at its host's addresses; null when one of them
 * is paused and nothing was sent. What it came to is reported to the gate for
 * the address it was sent to, or, when none accepted a connection in time, for
 * each one dialled and left unanswered. Its time limit starts as it is sent,
 * never while it waits its turn.
 */
async function send(
  target: URL,
  addresses: readonly string[],
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response | null> {
  const { gate } = io;
  if (gate && !(await gate.enter(addresses))) return null;
  const limit = AbortSignal.timeout(timeoutMs);
  const unanswered: string[] = [];
  let asked: string | undefined;
  /** Tell the gate what the request came to, at each address it went to. */
  const report = (outcome: Outcome) => {
    const went = asked === undefined ? unanswered : [asked];
    if (went.length === 0) return;
    gate?.settle(target.hostname, went, portOf(target), outcome);
  };
  try {
    asked = await addressFor(target, addresses, limit, unanswered);
    const res = await ask(target, asked, headers, limit);
    report('answered');
    return res;
  } catch (err) {
    report(classify(err) === 'timeout' ? 'silent' : 'other');
    throw err;
  }
}

const robotsCache = new Map<string, RobotsRules>();

/** Fetch and cache one origin's robots.txt. A missing or unreadable file means
 *  no restrictions, which is what the standard says to assume. Null, and
 *  nothing cached, when a paused address kept it from being asked for. */
async function robotsFor(origin: string): Promise<RobotsRules | null> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;

  let rules: RobotsRules = { disallow: [], allow: [] };
  try {
    const target = new URL('/robots.txt', origin);
    // Same two protections fetchPage is built around, and for the same reasons:
    // a host answering /robots.txt with `302 Location: http://169.254.169.254/…`
    // would otherwise be followed before any guard saw the new target, and an
    // unbounded res.text() would buffer a "robots.txt" of any size at all.
    if ((await resolveHost(target.hostname)).reach !== 'public') {
      robotsCache.set(origin, rules);
      return rules;
    }
    // Follow redirects by hand, guarding each hop. Refusing to follow at all
    // meant a canonical-host 301 on /robots.txt left us with empty rules — a
    // site that had banned us by name was crawled anyway, because every
    // non-ideal outcome fell through to "no restrictions".
    let current = target;
    let body: string | null = null;
    for (let hop = 0; hop <= ROBOTS_REDIRECTS; hop++) {
      const resolved = await resolveHost(current.hostname);
      if (resolved.reach !== 'public') break;
      const res = await send(
        current,
        resolved.addresses,
        { 'user-agent': USER_AGENT },
        ROBOTS_TIMEOUT_MS,
      );
      // Not asked for is not unreadable: nothing is assumed, and nothing cached.
      if (!res) return null;
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        try {
          current = new URL(location, current);
        } catch {
          break;
        }
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        break;
      }
      body = await readCapped(res);
      break;
    }
    // Content-type is NOT the test. A framework catch-all serving a perfectly
    // valid robots.txt as text/html had its rules discarded; what matters is
    // whether the body parses as robots directives rather than as a web page.
    if (body !== null && !/^\s*<(?:!doctype|html)/i.test(body)) {
      rules = parseRobots(body, ROBOTS_AGENT);
    }
  } catch {
    // Unreachable robots.txt is not a reason to refuse the site.
  }
  robotsCache.set(origin, rules);
  return rules;
}

/** Where a host points: the public addresses it resolves to, or why it has none we may ask. */
type Resolution =
  | { reach: 'public'; addresses: string[] }
  | { reach: 'private' }
  | { reach: 'unresolvable' };

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
async function resolveHost(hostname: string): Promise<Resolution> {
  try {
    const addresses = await io.lookup(hostname);
    if (addresses.length === 0) return { reach: 'unresolvable' };
    return addresses.some((a) => isPrivateAddress(a.address))
      ? { reach: 'private' }
      : { reach: 'public', addresses: addresses.map((a) => a.address) };
  } catch {
    return { reach: 'unresolvable' };
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

/** The guards a page must pass before we may request it, for a caller that fetches some other way: null when it may be fetched. */
export async function checkFetchable(
  url: string,
): Promise<FetchFailure | null> {
  try {
    const checked = await guard(new URL(url));
    return typeof checked === 'string' ? checked : null;
  } catch {
    return 'dns_or_refused';
  }
}

/** checkFetchable for a page about to be opened some other way: it also waits the page's turn at its address, and is refused at a paused one. */
export async function awaitTurn(url: string): Promise<FetchFailure | null> {
  try {
    const checked = await guard(new URL(url));
    if (typeof checked === 'string') return checked;
    if (io.gate && !(await io.gate.enter(checked))) return 'address_paused';
    return null;
  } catch {
    return 'dns_or_refused';
  }
}

/** Every guard that must hold before we are allowed to request a URL: why it may not be, else the addresses its host resolved to. */
async function guard(target: URL): Promise<FetchFailure | string[]> {
  const resolved = await resolveHost(target.hostname);
  if (resolved.reach === 'private') return 'private_address';
  if (resolved.reach === 'unresolvable') return 'dns_or_refused';
  const rules = await robotsFor(target.origin);
  if (!rules) return 'address_paused';
  if (!isAllowedByRobots(rules, target.pathname || '/')) {
    return 'blocked_by_robots';
  }
  return resolved.addresses;
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
    const checked = await guard(current);
    if (typeof checked === 'string') return { ok: false, reason: checked };

    try {
      const res = await send(
        current,
        checked,
        {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
        },
        REQUEST_TIMEOUT_MS,
      );
      if (!res) return { ok: false, reason: 'address_paused' };

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
  /** Paced between variant attempts. Defaults to a real delay because the sole
   *  caller never supplied one, so the gap this is meant to create did not
   *  exist: a TLS-mismatched host — live, not dead — took up to four page
   *  requests plus four robots.txt requests inside a second, from a named bot,
   *  which is exactly the access-log burst the pacing exists to avoid. */
  onAttempt: (candidate: string) => Promise<void> | void = () =>
    new Promise((resolve) => setTimeout(resolve, VARIANT_DELAY_MS)),
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
    if (attempts > 0) await onAttempt(candidate);
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

/** Forget which address each origin last answered at. Exposed for tests and long-lived processes. */
export function forgetAnsweredAddresses(): void {
  answeredAt.clear();
}
