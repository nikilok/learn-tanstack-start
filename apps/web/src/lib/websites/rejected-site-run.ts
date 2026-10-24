/**
 * One run of rejecting hand-judged sites: the list checked, every listed row
 * planned as it reads now, and, when applying, every row backed up before any
 * is written. The database is passed in.
 */

import { writeFileSync } from 'node:fs';

import { rejectSite } from './rejected-site';
import type {
  ListedRow,
  RejectOutcome,
  RowSnapshot,
} from './rejected-site-sql';

/** A site judged not to be a company's. */
export type RejectionEntry = { companyNumber: string; url: string };

/** How many listed rows came to each outcome. */
export type Counts = Record<string, number>;

/** The listed rows as read, what rejecting each would do, and why the run cannot go on, if it cannot. */
export type Plan = {
  rows: ListedRow[];
  planned: Counts;
  refusal: string | null;
};

/** Whether a list item is a company number and a URL. */
function isEntry(item: unknown): item is RejectionEntry {
  const entry = item as RejectionEntry | null;
  return (
    typeof entry?.companyNumber === 'string' && typeof entry.url === 'string'
  );
}

/** The list as given, or why it cannot run. */
export function parseRejections(json: unknown): RejectionEntry[] | string {
  if (!Array.isArray(json) || !json.every(isEntry)) {
    return 'the list must be [{ companyNumber, url }]';
  }
  // Each write is guarded on one snapshot, so a second site for a company needs a run of its own.
  if (new Set(json.map((e) => e.companyNumber)).size < json.length) {
    return 'a company is listed twice; list its other site in a second run';
  }
  return json.map(({ companyNumber, url }) => ({ companyNumber, url }));
}

/** Read the listed rows and plan each rejection; a registry's row refuses the run. */
export async function planRun(
  entries: readonly RejectionEntry[],
  read: (companyNumbers: readonly string[]) => Promise<ListedRow[]>,
): Promise<Plan> {
  const rows = await read(entries.map((e) => e.companyNumber));
  const byNumber = new Map(rows.map((r) => [r.snapshot.companyNumber, r]));
  const planned: Counts = {
    reset: 0,
    stripped: 0,
    unchanged: 0,
    missing: 0,
    not_search: 0,
  };
  for (const entry of entries) {
    const row = byNumber.get(entry.companyNumber);
    const change = row ? rejectSite(row.snapshot, entry.url) : null;
    planned[
      !row
        ? 'missing'
        : row.source !== 'search'
          ? 'not_search'
          : !change
            ? 'unchanged'
            : change.reset
              ? 'reset'
              : 'stripped'
    ] += 1;
  }
  // A registry's row takes its site back on the next import.
  const refusal =
    planned.not_search > 0
      ? "a registry's row takes its site back on the next import; list search rows only"
      : null;
  return { rows, planned, refusal };
}

/** Back the planned rows up, then reject each listed site; a failed backup writes nothing, and a row left alone fails the run. */
export async function applyRun(
  entries: readonly RejectionEntry[],
  plan: Plan,
  deps: {
    /** Writes every row as stored, or throws having written nothing. */
    backup: (stored: Record<string, unknown>[]) => Promise<void>;
    reject: (row: RowSnapshot, rejectedUrl: string) => Promise<RejectOutcome>;
  },
): Promise<{ applied: Counts | null; failure: string | null }> {
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
  const byNumber = new Map(plan.rows.map((r) => [r.snapshot.companyNumber, r]));
  const applied: Counts = {
    reset: 0,
    stripped: 0,
    unchanged: 0,
    missing: 0,
    moved: 0,
  };
  for (const entry of entries) {
    const row = byNumber.get(entry.companyNumber);
    applied[row ? await deps.reject(row.snapshot, entry.url) : 'missing'] += 1;
  }
  // A moved or missing row's rejection was not applied: what runs next must not take it as done.
  const failure =
    applied.moved > 0 || applied.missing > 0
      ? 'rows missing, or changed since the backup, were left; plan again and apply with a new --backup'
      : null;
  return { applied, failure };
}

/** A backup written to a new file only: a re-run's backup would hold rows the first run already changed. */
export function makeBackup(path: string, at: Date) {
  return async (stored: Record<string, unknown>[]): Promise<void> => {
    writeFileSync(
      path,
      JSON.stringify({ at: at.toISOString(), rows: stored }, null, 1),
      { flag: 'wx' },
    );
  };
}
