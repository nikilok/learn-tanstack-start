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
  outcome:
    | { ok: true }
    | { ok: false; reason: RevalidateFailure; status?: number };
  /** Set when the company's registered number was found on a fetched page. */
  crnFoundAt?: string | null;
  /** Set when the registered office postcode was found on a fetched page. */
  postcodeFoundAt?: string | null;
  /**
   * Whether the company's registered office postcode appears on the HOMEPAGE.
   *
   * The one signal here that can move a row DOWN as well as up, so it must be
   * recomputed identically on every pass — which is why it is the homepage
   * rather than `postcodeFoundAt`, whose disclosure-path probing is
   * first-pass-only and would therefore read as absent from the second pass on
   * and revoke every row it had just confirmed.
   */
  postcodeConfirms?: boolean;
  /**
   * The final host is a known directory or profile site. A CERTAIN fact about
   * the host, not a guess about the page, which is why it is separate from
   * `looksParked` and why nothing is exempt from it.
   */
  onAggregator?: boolean;
  /**
   * The page looks parked, for sale, or under construction. A HEURISTIC over
   * page text, so `manual` and `crn_on_page` are exempt: an ordinary one-page
   * site announcing "our new wing is coming soon" trips it.
   */
  looksParked?: boolean;
  /**
   * The page carried too little text to have shown an address at all — a
   * cookie wall, a JS shell, or a response truncated at the fetcher's 2MB cap.
   *
   * Absence of the postcode on such a page is not evidence the site stopped
   * publishing it, so it must not withdraw a confirmation. Without this a
   * single interstitial unpublishes the link and the next clean pass restores
   * it, which reads to a visitor as a company website that flickers.
   */
  pageTooThin?: boolean;
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
  /** Whether the site answered. A failure verdict is the sweep's alone to make
   *  and is written unconditionally; a success-derived status is computed from
   *  evidence the importer may meanwhile have improved, so it is guarded. */
  live: boolean;
  /** Whether the HOST responded at all, even though we could not read the URL.
   *  Distinct from `live`: it does not affect the verdict, but it is how the
   *  circuit breaker tells a broken runner from sites that are refusing us. */
  hostAnswered: boolean;
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

/** Tiers the postcode check may move between, in either direction. Never
 *  `crn_on_page` or `manual`: the company's own registration number and an
 *  owner's decision both outrank an address match. */
const CONFIRMABLE = new Set<WebsiteEvidence>([
  'registry',
  'registry_confirmed',
]);

/** Tiers no page-shape heuristic may unpublish. `manual` is an owner decision
 *  and `crn_on_page` is the company's own registration number found on the
 *  site; a phrase match on a short page is not evidence against either. An
 *  ordinary one-page care home announcing "our new wing is coming soon" clears
 *  looksParked's bar, and without this it silently removed the link. */
const TERMINAL_EVIDENCE = new Set<WebsiteEvidence>(['manual', 'crn_on_page']);

/**
 * Failures where the host answered but the stored URL was never actually read.
 *
 * These get a NOTE, not an exemption. An earlier version treated them as proof
 * of life — resetting the failure count and returning the row to `verified` —
 * and that one branch produced two separate defects: a robots-banned URL nobody
 * had ever fetched satisfied the render gate, and a permanently-403 host could
 * never reach DEAD_AFTER_FAILURES, so a broken link was published forever.
 *
 * The exemption was wrong on the architecture's own terms. `verified` plus a
 * stamped `checked_at` means "we fetched this and it answered". A 403 to our
 * bot, a robots ban or a non-HTML body all mean we did not. We may well be
 * losing a link that works for a human, but publishing a URL we could not
 * verify is the exact failure this whole design exists to prevent — so an
 * unverifiable URL correctly stops rendering, and eventually is written off.
 * The distinction survives in the note and in the sweep's own counters, so an
 * operator can tell bot management from a dead domain.
 */
const ANSWERED_BUT_UNREAD = new Set<RevalidateFailure>([
  'blocked_by_robots',
  'not_html',
  'too_large',
]);

/** Whether the host answered, for reporting only — never for the verdict. */
function hostAnswered(reason: RevalidateFailure, status?: number): boolean {
  return (
    ANSWERED_BUT_UNREAD.has(reason) || (reason === 'http_error' && !!status)
  );
}

/** `manual` is an owner decision about identity; a dead URL does not overturn
 *  it, so the row is marked dead without touching the evidence tier. */
function nextEvidence(
  current: WebsiteEvidence,
  proposed: WebsiteEvidence,
): WebsiteEvidence {
  if (current === 'manual') return current;
  return evidenceRank(proposed) > evidenceRank(current) ? proposed : current;
}

/** The stored columns a merge has to reconcile against. */
export type StoredWebsite = {
  url: string;
  evidence: WebsiteEvidence;
  evidenceUrl: string | null;
  confidence: string | null;
};

/** Exactly what to write for one row, every column resolved. */
export type MergedWebsite = {
  url: string;
  status: WebsiteStatus;
  evidence: WebsiteEvidence;
  evidenceUrl: string | null;
  confidence: string;
  failureCount: number;
  bumpVerifiedAt: boolean;
};

/**
 * Reconcile a revalidation result with the row as it was read.
 *
 * This exists because the reconciliation used to live in SQL `CASE`
 * expressions, where nothing could test it — and three separate defects
 * settled there across two review rounds, each one a column written when it
 * should have been left alone: evidence_url wiped on every pass, status
 * clobbered back to a stale tier, and the URL written past a concurrent
 * update. Here the rules are ordinary code with ordinary tests, and the writer
 * becomes a plain assignment guarded by an optimistic lock.
 */
export function mergeRevalidation(
  stored: StoredWebsite,
  result: RevalidateResult,
): MergedWebsite {
  const resultConfidence = Number(result.confidence);
  return {
    url: result.url,
    status: result.status,
    evidence: result.evidence,
    // Absence of new proof is not proof of absence: a pass that finds nothing
    // returns null here, and overwriting with it destroyed the audit trail that
    // first-pass-only probing can never rebuild.
    evidenceUrl: result.evidenceUrl ?? stored.evidenceUrl,
    // Tracks `evidence` exactly, in BOTH directions. It used to be monotonic,
    // on the reasoning that revalidate could never propose a lower tier — which
    // stopped being true when registry_confirmed became revocable. A stored
    // 0.970 left behind on a row demoted to `registry` is not cosmetic: it is
    // the column upgradeOnlyPredicateSql compares, so every later correction
    // the registry publishes for that company is silently discarded, forever.
    confidence: resultConfidence.toFixed(3),
    failureCount: result.failureCount,
    bumpVerifiedAt: result.verified,
  };
}

/** Apply one revalidation pass to a single row. */
export function revalidate(input: RevalidateInput): RevalidateResult {
  const base = {
    evidenceUrl: null as string | null,
    checkedAt: true as const,
  };

  if (!input.outcome.ok) {
    const reason = input.outcome.reason;
    const status = input.outcome.status;
    const answered = hostAnswered(reason, status);

    // ONE failure path, no exemptions. Whether the host refused us or never
    // answered at all, the stored URL was not read, so the row cannot render
    // and must move toward being written off. `unreachable` rather than
    // `input.status`: checked_at is the cursor and is stamped on every pass
    // including this one, so leaving a failed row as `verified` would satisfy
    // the render gate and publish a link we could not reach.
    const failureCount = input.failureCount + 1;
    const dead = failureCount >= DEAD_AFTER_FAILURES;
    const detail = `${reason}${status ? ` ${status}` : ''}${answered ? ', host answered but the page was not read' : ''}`;
    return {
      ...base,
      url: input.storedUrl,
      status: dead ? 'dead' : 'unreachable',
      evidence: input.evidence,
      confidence: evidenceConfidence(input.evidence).toFixed(3),
      failureCount,
      verified: false,
      live: false,
      hostAnswered: answered,
      note: dead
        ? `dead after ${failureCount} consecutive failures (${detail})`
        : `failure ${failureCount}/${DEAD_AFTER_FAILURES} (${detail})`,
    };
  }

  // Live. Promote on whatever proof the page carried, strongest first.
  let evidence = input.evidence;
  let evidenceUrl: string | null = null;
  let note = 'live; no disclosure found, identity rests on the registry join';

  // A directory listing is not a company's website, whatever it prints on it.
  // Endole, OpenCorporates and the Companies House service all show the
  // registration number, so the crn check fires on exactly the hosts the
  // deny-list exists to reject — and it runs first, so without this guard the
  // listing is promoted to crn_on_page and published. Suppressing the whole
  // promotion block, rather than clamping status afterwards, is what stops the
  // tier being written at all: a stored 0.970 on a listing would then block
  // the registry from ever replacing that URL.
  if (input.onAggregator) {
    // Withdraw a stale confirmation as well as refusing a new one. The page
    // that supported the rung is now a directory listing, so the claim is no
    // longer backed by anything — and a latched 0.970 would block the registry
    // from ever replacing this URL, which is the freeze the confidence and
    // discoveryRank work elsewhere exists to prevent.
    if (evidence === 'registry_confirmed') evidence = 'registry';
    note = 'live; directory or profile listing, not a company website';
  } else if (input.crnFoundAt) {
    evidence = nextEvidence(evidence, 'crn_on_page');
    evidenceUrl = input.crnFoundAt;
    note = 'live; registered number found on the site';
  } else if (input.postcodeConfirms && CONFIRMABLE.has(evidence)) {
    // Record the postcode proof page if this pass found one. Disclosure
    // probing is first-pass-only, so a page not captured here can never be
    // recovered — and this branch outranks the postcode branch below, so
    // without this a confirmed row would carry no proof pointer at all.
    // The one revocable rung. Gated to `registry` and its own tier because it
    // corroborates a claim an exact company-number join already made; standing
    // alone behind a search result the same signal is far weaker.
    evidence = 'registry_confirmed';
    evidenceUrl = input.postcodeFoundAt ?? null;
    note = 'live; registered office postcode found on the site';
  } else if (evidence === 'registry_confirmed' && !input.pageTooThin) {
    evidenceUrl = input.postcodeFoundAt ?? null;
    // The address was there and is not any more: the site was rebuilt, the
    // domain changed hands, or the company moved. Upgrade-only applies
    // to DISCOVERY; revalidation is the one thing allowed to move a row down,
    // and leaving this rung latched would publish a link whose page no longer
    // names the company — the exact decay this tier exists to catch.
    evidence = 'registry';
    note =
      'live; registered office postcode no longer on the site, confirmation withdrawn';
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
  //
  // Unless there is no site there. A parked, for-sale or directory page answers
  // 200 quite happily, so liveness cannot see it and the row would keep its
  // verified status and its published link. Held at `candidate` — the review
  // backlog — with the evidence tier untouched, exactly as the dead path leaves
  // `manual` alone: this says nothing about whose domain it is, only that there
  // is currently nothing on it worth linking to. A later pass that finds a real
  // site restores the row on its own.
  let status: WebsiteStatus = statusForEvidence(evidence);
  // Certain: nothing renders off a directory, including an owner's choice —
  // if an owner really wants a listing linked they can say so with a URL that
  // is not on the deny-list.
  if (input.onAggregator) {
    status = 'candidate';
    note += '; held back from rendering';
  } else if (input.looksParked && !TERMINAL_EVIDENCE.has(evidence)) {
    // Heuristic: exempts the two tiers a phrase match has no business
    // overturning.
    status = 'candidate';
    note += '; parked page, held back from rendering';
  }

  return {
    ...base,
    url,
    status,
    evidence,
    confidence: evidenceConfidence(evidence).toFixed(3),
    evidenceUrl,
    failureCount: 0,
    verified: status === 'verified',
    live: true,
    hostAnswered: true,
    note,
  };
}
