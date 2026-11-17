/**
 * What the registry importer does with one register finding: keep the row,
 * record a disagreement, or write. No I/O.
 */

import {
  decideWebsite,
  type ExistingWebsite,
  evidenceConfidence,
  statusForEvidence,
  type WebsiteEvidence,
  type WebsiteStatus,
} from './decide';
import { isSameSite } from './normalise-url';
import { namesAreCompatible } from './registry-rows';
import { isStagingCopyOf } from './staging-copy';

/** The registers the importer joins on a company number. */
export type RegistrySource = 'cqc' | 'wikidata';

/** One company's website as a register lists it. */
export type RegistryFinding = {
  companyNumber: string;
  url: string;
  /** The register's own name for the company. */
  registryName: string;
  source: RegistrySource;
};

/** A row the importer writes. */
export type RegistryWrite = {
  companyNumber: string;
  url: string;
  status: WebsiteStatus;
  evidence: WebsiteEvidence;
  confidence: string;
  source: RegistrySource;
  verifiedAt: Date | null;
};

/** The rows a finding is decided against: the one stored, and the one a stronger source wrote earlier in the run. */
export type RegistryRows = {
  stored: ExistingWebsite | null;
  pending: RegistryWrite | null;
};

/** The decision for one finding, with what the run summary counts. */
export type RegistryDecision = {
  /** The register's name for the company is not recognisably its registered one. */
  unconfirmed: boolean;
  /** The register lists a staging copy of the site the row holds, read as that site. */
  stagingCopy: boolean;
} & (
  | { action: 'keep' }
  | { action: 'conflict' }
  | { action: 'write'; write: RegistryWrite }
);

/** Verdicts the sweep reaches about a page, which an identity upgrade says nothing about. */
const SWEEP_VERDICTS: ReadonlySet<WebsiteStatus> = new Set([
  'unreachable',
  'dead',
  'candidate',
]);

/**
 * Decide one register finding. The ladder is read against the row as the run
 * has left it: what a stronger source wrote earlier, else what is stored. What
 * the sweep found is read off the stored row alone, as only that row has been
 * swept. The join is on the number; the name only decides how far up the
 * ladder the row lands.
 */
export function decideRegistryFinding(
  finding: RegistryFinding,
  companyName: string,
  { stored, pending }: RegistryRows,
  now: Date,
): RegistryDecision {
  // Only CQC's name is the registered one; Wikidata's label is the brand.
  const compatible =
    finding.source !== 'cqc' ||
    namesAreCompatible(finding.registryName, companyName);
  const evidence: WebsiteEvidence = compatible
    ? 'registry'
    : 'registry_unconfirmed';
  // A staging copy of the site the row holds, as written this run or as stored, is that site: no import moves a row onto its copy.
  const held =
    [pending?.url, stored?.url].find((site) =>
      isStagingCopyOf(finding.url, site ?? null),
    ) ?? null;
  const url = held ?? finding.url;
  const counted = { unconfirmed: !compatible, stagingCopy: held !== null };

  const { action } = decideWebsite(pending ?? stored, {
    url,
    evidence,
    source: finding.source,
  });
  if (action !== 'update') return { ...counted, action };

  // The sweep's verdict on the stored page survives an upgrade on that site, or a link it found broken is republished.
  const verdict =
    stored && SWEEP_VERDICTS.has(stored.status) && isSameSite(stored.url, url)
      ? stored.status
      : null;
  const status = verdict ?? statusForEvidence(evidence);
  return {
    ...counted,
    action: 'write',
    write: {
      companyNumber: finding.companyNumber,
      url,
      status,
      evidence,
      confidence: evidenceConfidence(evidence).toFixed(3),
      source: finding.source,
      verifiedAt: status === 'verified' ? now : null,
    },
  };
}
