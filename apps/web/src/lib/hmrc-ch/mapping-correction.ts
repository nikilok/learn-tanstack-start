/**
 * An owner's corrections to sponsor-to-company joins: a join held with no
 * company, or moved to another company. Either is stored as `manual`, which
 * no sweep selects or overwrites. The database is passed in.
 */

import { COMPANY_NUMBER_RE } from '../company/ids';
import type {
  CommitPromotionInput,
  CommitPromotionResult,
} from '../phase5/apply-promotion';
import type { CHFullProfile, MatchMethod } from '../phase5/decide';
import { NAME_ONLY_METHODS } from './name-only-guard';

/** One listed correction. */
export type MappingCorrection = {
  organisationName: string;
  /** The company the join holds now. */
  companyNumber: string;
  /** The company it moves to; null holds the join with no company. */
  newCompanyNumber: string | null;
};

/** A mapping row: exactly as stored, for the backup, and what a correction is decided on. */
export type ListedMapping = {
  stored: Record<string, unknown>;
  organisationName: string;
  companyNumber: string | null;
  matchMethod: string | null;
  queryUsed: string | null;
  verifiedAt: Date | null;
};

/** What a listed correction comes to for the row as stored. */
export type CorrectionKind =
  | 'hold'
  | 'repoint'
  | 'already'
  | 'differs'
  | 'missing';

/** How many listed rows came to each outcome. */
export type CorrectionCounts = Record<string, number>;

/** The listed rows as read, and what each correction comes to. */
export type CorrectionPlan = {
  rows: ListedMapping[];
  kinds: Map<string, CorrectionKind>;
  planned: CorrectionCounts;
};

/** What writing one correction did. */
type CorrectionOutcome = 'held' | 'repointed' | 'changed' | 'no_profile';

/** Whether a value is a non-empty string. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** Whether a value has the shape of a company number. */
function isCompanyNumber(value: unknown): value is string {
  return typeof value === 'string' && COMPANY_NUMBER_RE.test(value);
}

/** Read a corrections list; a string says what is wrong with it, by position only. */
export function parseMappingCorrections(
  raw: unknown,
): MappingCorrection[] | string {
  if (!Array.isArray(raw)) return 'the list must be an array';
  const seen = new Set<string>();
  const entries: MappingCorrection[] = [];
  for (const [index, item] of raw.entries()) {
    const { organisationName, companyNumber, newCompanyNumber } = (item ??
      {}) as Record<string, unknown>;
    if (!isText(organisationName)) {
      return `entry ${index}: organisationName must be a non-empty string`;
    }
    if (!isCompanyNumber(companyNumber)) {
      return `entry ${index}: companyNumber must be a company number`;
    }
    if (newCompanyNumber !== null && !isCompanyNumber(newCompanyNumber)) {
      return `entry ${index}: newCompanyNumber must be null or a company number`;
    }
    if (newCompanyNumber === companyNumber) {
      return `entry ${index}: newCompanyNumber is the company the join already holds`;
    }
    if (seen.has(organisationName)) {
      return `entry ${index}: its organisationName is listed twice`;
    }
    seen.add(organisationName);
    entries.push({ organisationName, companyNumber, newCompanyNumber });
  }
  return entries;
}

/** What a listed correction comes to for the row as stored now. */
export function correctionKind(
  entry: MappingCorrection,
  row: ListedMapping | undefined,
): CorrectionKind {
  if (!row) return 'missing';
  if (
    row.matchMethod === 'manual' &&
    row.companyNumber === entry.newCompanyNumber
  ) {
    return 'already';
  }
  // Only a join still on the listed company, and still made on the name alone, is corrected.
  if (
    row.companyNumber !== entry.companyNumber ||
    !NAME_ONLY_METHODS.has(row.matchMethod ?? '')
  ) {
    return 'differs';
  }
  return entry.newCompanyNumber === null ? 'hold' : 'repoint';
}

/** The write for a correction: the join held with no company, or moved to another. */
export function correctionInput(
  row: ListedMapping,
  newCompanyNumber: string | null,
  changedBy: string,
): CommitPromotionInput {
  return {
    organisationName: row.organisationName,
    originalVerifiedAt: row.verifiedAt,
    newCompanyNumber,
    newMatchMethod: 'manual',
    newMatchScore: null,
    newQueryUsed: row.queryUsed,
    newIsPublicBody: false,
    oldCompanyNumber: row.companyNumber,
    oldMatchMethod: row.matchMethod as MatchMethod | null,
    changedBy,
  };
}

/** What the writes of a correction need from outside. */
export type CorrectionWrites = {
  /** The guarded mapping update with its audit row; null when the row changed since it was read. */
  commit: (input: CommitPromotionInput) => Promise<CommitPromotionResult>;
  /** The company's profile from Companies House; null when it has none to give. */
  fetchProfile: (companyNumber: string) => Promise<CHFullProfile | null>;
  storeProfile: (profile: CHFullProfile) => Promise<void>;
};

/** Write one correction. A move stores the company's own profile first, so a failed write leaves the join as it was. */
async function writeCorrection(
  row: ListedMapping,
  newCompanyNumber: string | null,
  changedBy: string,
  writes: CorrectionWrites,
): Promise<CorrectionOutcome> {
  if (newCompanyNumber !== null) {
    const profile = await writes.fetchProfile(newCompanyNumber);
    // A profile for any other number is not this company's.
    if (profile?.company_number !== newCompanyNumber) return 'no_profile';
    await writes.storeProfile(profile);
  }
  const done = await writes.commit(
    correctionInput(row, newCompanyNumber, changedBy),
  );
  if (!done) return 'changed';
  return newCompanyNumber === null ? 'held' : 'repointed';
}

/** Read the listed rows and say what each correction comes to. */
export async function planCorrections(
  entries: readonly MappingCorrection[],
  read: (organisationNames: readonly string[]) => Promise<ListedMapping[]>,
): Promise<CorrectionPlan> {
  const rows = await read(entries.map((e) => e.organisationName));
  const byName = new Map(rows.map((r) => [r.organisationName, r]));
  const kinds = new Map<string, CorrectionKind>();
  const planned: CorrectionCounts = {
    hold: 0,
    repoint: 0,
    already: 0,
    differs: 0,
    missing: 0,
  };
  for (const entry of entries) {
    const kind = correctionKind(entry, byName.get(entry.organisationName));
    kinds.set(entry.organisationName, kind);
    planned[kind] += 1;
  }
  return { rows, kinds, planned };
}

/** Errors in a row after which the run stops trying. */
const MAX_ERRORS_IN_A_ROW = 5;

/** Back the listed rows up, then write each planned correction; a failed backup writes nothing, and a planned row not written fails the run. */
export async function applyCorrections(
  entries: readonly MappingCorrection[],
  plan: CorrectionPlan,
  deps: CorrectionWrites & {
    /** Writes every row as stored, or throws having written nothing. */
    backup: (stored: Record<string, unknown>[]) => Promise<void>;
    changedBy: string;
  },
): Promise<{ applied: CorrectionCounts | null; failure: string | null }> {
  try {
    await deps.backup(plan.rows.map((r) => r.stored));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      applied: null,
      failure: `nothing was written, as the backup failed: ${reason}`,
    };
  }
  const byName = new Map(plan.rows.map((r) => [r.organisationName, r]));
  const applied: CorrectionCounts = {
    held: 0,
    repointed: 0,
    changed: 0,
    no_profile: 0,
    errored: 0,
    not_tried: 0,
    left: 0,
  };
  let errorsInARow = 0;
  let firstError: string | null = null;
  for (const entry of entries) {
    const kind = plan.kinds.get(entry.organisationName);
    const row = byName.get(entry.organisationName);
    if (!row || (kind !== 'hold' && kind !== 'repoint')) {
      applied.left += 1;
      continue;
    }
    if (errorsInARow >= MAX_ERRORS_IN_A_ROW) {
      applied.not_tried += 1;
      continue;
    }
    try {
      const outcome = await writeCorrection(
        row,
        entry.newCompanyNumber,
        deps.changedBy,
        deps,
      );
      applied[outcome] += 1;
      errorsInARow = 0;
    } catch (error) {
      applied.errored += 1;
      errorsInARow += 1;
      // The kind of error only: its message may quote the row.
      firstError ??= error instanceof Error ? error.name : 'error';
    }
  }
  // A row planned and not written must not be taken as done by what runs next.
  const unwritten =
    applied.changed + applied.no_profile + applied.errored + applied.not_tried;
  const failure =
    unwritten > 0
      ? `${unwritten} planned rows were not written${firstError ? ` (first error: ${firstError})` : ''}; plan again and apply with a new --backup`
      : null;
  return { applied, failure };
}
