/**
 * One run of an owner's repoints: every listed row planned as it reads now
 * and, when applying, every row backed up before any is written. The database
 * is passed in.
 */

import type { WebsiteEvidence } from './decide';
import type { ListedRow } from './rejected-site-sql';
import { type Repoint, type RepointEntry, repointRow } from './repoint';
import type { RepointOutcome, RepointSnapshot } from './repoint-sql';

/** How many listed rows came to each outcome. */
export type RepointCounts = Record<string, number>;

/** The listed rows as read, the change planned for each that has one, and why the run cannot go on, if it cannot. */
export type RepointPlan = {
  rows: ListedRow[];
  changes: Map<string, Repoint>;
  planned: RepointCounts;
  refusal: string | null;
};

/** What a repoint does to a listed row, read off the row as stored. */
function planned(
  row: ListedRow,
  entry: RepointEntry,
): ReturnType<typeof repointRow> {
  return repointRow(
    {
      url: row.snapshot.url,
      evidence: row.stored.evidence as WebsiteEvidence,
      // Absent before the column exists, which is not pinned either.
      pinned: (row.stored.url_pinned_at ?? null) !== null,
    },
    entry,
  );
}

/** Read the listed rows and plan each repoint; a row missing, or holding another address than listed, refuses the run. */
export async function planRepoints(
  entries: readonly RepointEntry[],
  read: (companyNumbers: readonly string[]) => Promise<ListedRow[]>,
): Promise<RepointPlan> {
  const rows = await read(entries.map((e) => e.companyNumber));
  const byNumber = new Map(rows.map((r) => [r.snapshot.companyNumber, r]));
  const changes = new Map<string, Repoint>();
  const counts: RepointCounts = {
    move: 0,
    pin: 0,
    already: 0,
    differs: 0,
    missing: 0,
  };
  for (const entry of entries) {
    const row = byNumber.get(entry.companyNumber);
    const change = row ? planned(row, entry) : 'missing';
    if (typeof change === 'string') {
      counts[change] += 1;
      continue;
    }
    counts[change.kind] += 1;
    changes.set(entry.companyNumber, change);
  }
  // An out-of-date list is corrected by the owner, never half applied.
  const refusal =
    counts.differs + counts.missing > 0
      ? 'a listed row is missing or holds another address than listed; correct the list and plan again'
      : null;
  return { rows, changes, planned: counts, refusal };
}

/** Back the listed rows up, then write each planned change; a failed backup writes nothing, and a row left alone fails the run. */
export async function applyRepoints(
  entries: readonly RepointEntry[],
  plan: RepointPlan,
  deps: {
    /** Writes every row as stored, or throws having written nothing. */
    backup: (stored: Record<string, unknown>[]) => Promise<void>;
    repoint: (row: RepointSnapshot, change: Repoint) => Promise<RepointOutcome>;
  },
): Promise<{ applied: RepointCounts | null; failure: string | null }> {
  if (plan.refusal) return { applied: null, failure: plan.refusal };
  try {
    await deps.backup(plan.rows.map((r) => r.stored));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      applied: null,
      failure: `nothing was written, as the backup failed: ${reason}`,
    };
  }
  const hashes = new Map(
    plan.rows.map((r) => [r.snapshot.companyNumber, r.snapshot.rowHash]),
  );
  const applied: RepointCounts = {
    repointed: 0,
    pinned: 0,
    already: 0,
    changed: 0,
  };
  for (const { companyNumber } of entries) {
    const change = plan.changes.get(companyNumber);
    const rowHash = hashes.get(companyNumber);
    // Planned with no change: already pinned on its new address.
    if (!change || !rowHash) {
      applied.already += 1;
      continue;
    }
    applied[await deps.repoint({ companyNumber, rowHash }, change)] += 1;
  }
  // A changed row's repoint was not applied: what runs next must not take it as done.
  const failure =
    applied.changed > 0
      ? 'rows changed since the backup were left; plan again and apply with a new --backup'
      : null;
  return { applied, failure };
}
