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
 * Decide one register finding against the row it would change: the stored
 * one, or one a stronger source wrote earlier in the run. The join is on the
 * number; the name only decides how far up the ladder the row lands.
 */
export function decideRegistryFinding(
  finding: RegistryFinding,
  companyName: string,
  prior: ExistingWebsite | null,
  now: Date,
): RegistryDecision {
  // Only CQC's name is the registered one; Wikidata's label is the brand.
  const compatible =
    finding.source !== 'cqc' ||
    namesAreCompatible(finding.registryName, companyName);
  const evidence: WebsiteEvidence = compatible
    ? 'registry'
    : 'registry_unconfirmed';
  // A staging copy of the site the row holds is that site, so no import moves a row back onto its copy.
  const held = prior?.url ?? null;
  const stagingCopy = isStagingCopyOf(finding.url, held);
  const url = stagingCopy && held ? held : finding.url;
  const counted = { unconfirmed: !compatible, stagingCopy };

  const { action } = decideWebsite(prior, {
    url,
    evidence,
    source: finding.source,
  });
  if (action !== 'update') return { ...counted, action };

  // The sweep's verdict on the page survives an upgrade on the same site, or a link it found broken is republished.
  const verdict =
    prior && SWEEP_VERDICTS.has(prior.status) && isSameSite(prior.url, url)
      ? prior.status
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
