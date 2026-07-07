/**
 * Pure mapping from a Companies House bulk-snapshot CSV record
 * (BasicCompanyDataAsOneFile) to the shapes the offline matcher consumes.
 * The caller is responsible for trimming header names — the raw file's
 * header contains space-padded columns like " CompanyNumber".
 */

import type { CHCandidate } from '../hmrc-ch/pipeline.ts';

export type SnapshotCompany = {
  companyNumber: string;
  name: string;
  /** Snapshot display status, e.g. "Active", "Liquidation",
   *  "Active - Proposal to Strike off". */
  status: string;
  postTown: string | null;
  county: string | null;
  previousNames: string[];
};

/** Columns the matcher requires — validated against the first parsed record
 *  so a silent snapshot-format change fails loudly. */
export const REQUIRED_SNAPSHOT_COLUMNS = [
  'CompanyName',
  'CompanyNumber',
  'CompanyStatus',
  'RegAddress.PostTown',
  'RegAddress.County',
  'PreviousName_1.CompanyName',
] as const;

const PREVIOUS_NAME_COLUMNS = Array.from(
  { length: 10 },
  (_, i) => `PreviousName_${i + 1}.CompanyName`,
);

/** Parses one CSV record into a SnapshotCompany; null when the row is
 *  unusable (missing name/number). */
export function snapshotRowToCompany(
  record: Record<string, string>,
): SnapshotCompany | null {
  const name = record.CompanyName?.trim();
  const companyNumber = record.CompanyNumber?.trim();
  if (!name || !companyNumber) return null;

  const previousNames: string[] = [];
  for (const col of PREVIOUS_NAME_COLUMNS) {
    const prev = record[col]?.trim();
    if (prev) previousNames.push(prev);
  }

  return {
    companyNumber,
    name,
    status: record.CompanyStatus?.trim() ?? '',
    postTown: record['RegAddress.PostTown']?.trim() || null,
    county: record['RegAddress.County']?.trim() || null,
    previousNames,
  };
}

/** "Active" and "Active - Proposal to Strike off" count as operationally
 *  live; everything else (Liquidation, Administration, …) does not. The
 *  live-API verify step re-checks status before any commit. */
export function isSnapshotActive(status: string): boolean {
  return /^active/i.test(status);
}

/** Adapts a snapshot row to the CHCandidate shape the pipeline matchers and
 *  tiebreak read. `company_status` carries the raw snapshot string — only
 *  the bulk matcher's own isSnapshotActive interprets it. */
export function toCHCandidate(company: SnapshotCompany): CHCandidate {
  return {
    company_number: company.companyNumber,
    company_name: company.name,
    company_status: company.status || null,
    previous_company_names: company.previousNames.length
      ? company.previousNames
      : null,
    locality: company.postTown,
    region: company.county,
  };
}
