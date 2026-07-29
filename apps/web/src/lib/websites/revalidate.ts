/**
 * Pure decision for one revalidation: given what is stored and what a fetch
 * found, what should the row become. No I/O.
 *
 * This is the one legitimate way a row moves DOWN the ladder. decideWebsite is
 * upgrade-only because a weaker discoverer must never overwrite a stronger
 * one's answer; liveness is different, because a URL that has stopped
 * resolving is not a weaker opinion about the same fact, it is the fact having
 * changed.
 *
 * Stamping `checked_at` is the point of the whole exercise: with it NULL a row
 * cannot render, however sound its identity evidence, because only 74% of
 * registry URLs actually resolve.
 */

import type { WebsiteEvidence, WebsiteStatus } from './decide.ts';
import {
  evidenceConfidence,
  evidenceRank,
  statusForEvidence,
} from './decide.ts';

/** Why a fetch did not produce a page. Mirrors web-fetch's FetchFailure. */
export type RevalidateFailure =
  | 'http_error'
  | 'tls'
  | 'dns_or_refused'
  | 'timeout'
  | 'blocked_by_robots'
  | 'private_address'
  | 'not_html'
  | 'too_large';

export type RevalidateInput = {
  storedUrl: string;
  evidence: WebsiteEvidence;
  status: WebsiteStatus;
  failureCount: number;
  /** The variant that answered, before redirects. */
  attemptedUrl: string;
  outcome: { ok: true } | { ok: false; reason: RevalidateFailure };
  /** Set when the company's registered number was found on a fetched page. */
  crnFoundAt?: string | null;
  /** Set when the registered office postcode was found on a fetched page. */
  postcodeFoundAt?: string | null;
};

export type RevalidateResult = {
  url: string;
  status: WebsiteStatus;
  evidence: WebsiteEvidence;
  confidence: string;
  evidenceUrl: string | null;
  failureCount: number;
  /** Always set: the row has now been looked at, whatever the answer. */
  checkedAt: true;
  /** Set when this pass produced identity evidence worth timestamping. */
  verified: boolean;
  note: string;
};

/**
 * Consecutive failed passes before a row is called dead.
 *
 * One failure is not evidence of death — a timeout, a certificate renewal or a
 * host having a bad afternoon all look identical to a permanent disappearance
 * at the moment they happen. Requiring two consecutive passes costs one sweep
 * cycle of latency and removes almost all of the false demotions.
 */
export const DEAD_AFTER_FAILURES = 2;

/** `manual` is an owner decision about identity; a dead URL does not overturn
 *  it, so the row is marked dead without touching the evidence tier. */
function nextEvidence(
  current: WebsiteEvidence,
  proposed: WebsiteEvidence,
): WebsiteEvidence {
  if (current === 'manual') return current;
  return evidenceRank(proposed) > evidenceRank(current) ? proposed : current;
}

/** Apply one revalidation pass to a single row. */
export function revalidate(input: RevalidateInput): RevalidateResult {
  const base = {
    evidenceUrl: null as string | null,
    checkedAt: true as const,
  };

  if (!input.outcome.ok) {
    const reason = input.outcome.reason;

    // Robots served us a file, which means the host answered — we are simply
    // not permitted to read the page. Liveness is confirmed even though the
    // content is not, so the row keeps its identity evidence and is stamped.
    if (reason === 'blocked_by_robots') {
      return {
        ...base,
        url: input.storedUrl,
        status: input.status === 'dead' ? 'verified' : input.status,
        evidence: input.evidence,
        confidence: evidenceConfidence(input.evidence).toFixed(3),
        failureCount: 0,
        verified: false,
        note: 'robots.txt disallows us; host is live so the row stands',
      };
    }

    const failureCount = input.failureCount + 1;
    const dead = failureCount >= DEAD_AFTER_FAILURES;
    // NOT `input.status`. checked_at is the cursor and is stamped on every
    // pass including this one, so leaving a failed row as `verified` makes it
    // satisfy the render gate and publish a link we could not reach. The row
    // keeps its identity evidence and comes straight back to `verified` on the
    // next pass that succeeds.
    return {
      ...base,
      url: input.storedUrl,
      status: dead ? 'dead' : 'unreachable',
      evidence: input.evidence,
      confidence: evidenceConfidence(input.evidence).toFixed(3),
      failureCount,
      verified: false,
      note: dead
        ? `dead after ${failureCount} consecutive failures (${reason})`
        : `failure ${failureCount}/${DEAD_AFTER_FAILURES} (${reason})`,
    };
  }

  // Live. Promote on whatever proof the page carried, strongest first.
  let evidence = input.evidence;
  let evidenceUrl: string | null = null;
  let note = 'live; no disclosure found, identity rests on the registry join';

  if (input.crnFoundAt) {
    evidence = nextEvidence(evidence, 'crn_on_page');
    evidenceUrl = input.crnFoundAt;
    note = 'live; registered number found on the site';
  } else if (input.postcodeFoundAt) {
    evidence = nextEvidence(evidence, 'postcode_on_page');
    evidenceUrl = input.postcodeFoundAt;
    note = 'live; registered office postcode found on the site';
  }

  // Only adopt the variant when the stored URL is not itself the one that
  // answered — otherwise a working URL churns for no reason.
  const url =
    input.attemptedUrl && input.attemptedUrl !== input.storedUrl
      ? input.attemptedUrl
      : input.storedUrl;
  if (url !== input.storedUrl) {
    note += `; stored url did not answer, adopted ${url}`;
  }

  // A row that was dead and now answers comes back at whatever its evidence
  // supports, rather than staying dead because it once failed.
  const status: WebsiteStatus = statusForEvidence(evidence);

  return {
    ...base,
    url,
    status,
    evidence,
    confidence: evidenceConfidence(evidence).toFixed(3),
    evidenceUrl,
    failureCount: 0,
    verified: status === 'verified',
    note,
  };
}
