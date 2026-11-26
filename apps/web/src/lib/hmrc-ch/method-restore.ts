/**
 * Giving the joins the establishment move stored as `manual` their match
 * method back, so the sweeps check them again. Only a join still exactly as
 * the move left it is restored: still `manual`, still on the establishment,
 * and not corrected since. The database is passed in.
 */

import type { StoredRow } from './establishment-move';
import { MAX_ERRORS_IN_A_ROW, StageError, staged } from './mapping-correction';
import { TIER_A2_SCORE, TIER_A_SCORE } from './pipeline';

/** The audit label of the move whose joins are restored. */
export const MOVED_BY = 'uk_establishment_move';

/** The audit label a restored join is recorded under. */
export const RESTORED_BY = 'uk_establishment_method_restore';

/** A sponsor's join as stored now. */
export type RestorableJoin = StoredRow & {
  companyNumber: string | null;
  matchMethod: string | null;
};

/** One join the move stored as `manual`, as its audit row records it, beside the join as stored now. */
export type MovedJoin = {
  auditId: number;
  /** The newest audit row for the sponsor, whatever wrote it. */
  newestAuditId: number;
  organisationName: string;
  /** The establishment the move put the join on. */
  establishmentNumber: string | null;
  /** The method the join had before the move. */
  method: string | null;
  /** Null when the sponsor has no join any more. */
  join: RestorableJoin | null;
};

/** What a moved join comes to for the rows as stored now. */
export type RestoreKind =
  | 'restore'
  | 'already'
  | 'differs'
  | 'superseded'
  | 'no_score'
  | 'missing';

/** How many moved joins came to each outcome. */
export type RestoreCounts = Record<string, number>;

/** The moved joins as read, and what each comes to. */
export type RestorePlan = {
  rows: MovedJoin[];
  kinds: Map<string, RestoreKind>;
  planned: RestoreCounts;
};

/** The guarded write of one restore, with what it was planned on. */
export type CommitRestoreInput = {
  organisationName: string;
  rowHash: string;
  auditId: number;
  method: string;
  score: number;
  changedBy: string;
};

/** The score each method fixes: the only methods a join can be given back without its stored score. */
const SCORE_OF: ReadonlyMap<string | null, number> = new Map([
  ['exact', TIER_A_SCORE],
  ['exact_squash', TIER_A2_SCORE],
]);

/** The score a method fixes, or null when the method leaves it open. */
export function scoreOf(method: string | null): number | null {
  return SCORE_OF.get(method) ?? null;
}

/** What a moved join comes to for the rows as stored now. */
export function restoreKind(moved: MovedJoin): RestoreKind {
  const { join } = moved;
  if (!join) return 'missing';
  if (join.companyNumber !== moved.establishmentNumber) return 'differs';
  if (join.matchMethod !== 'manual') {
    return join.matchMethod === moved.method ? 'already' : 'differs';
  }
  // Something has written the join since the move: it is that writer's to settle.
  if (moved.auditId !== moved.newestAuditId) return 'superseded';
  return scoreOf(moved.method) === null ? 'no_score' : 'restore';
}

/** Read the joins the move stored as `manual` and say what each comes to. */
export async function planRestores(
  read: () => Promise<MovedJoin[]>,
): Promise<RestorePlan> {
  const rows = await read();
  const kinds = new Map<string, RestoreKind>();
  const planned: RestoreCounts = {
    restore: 0,
    already: 0,
    differs: 0,
    superseded: 0,
    no_score: 0,
    missing: 0,
  };
  for (const row of rows) {
    const kind = restoreKind(row);
    kinds.set(row.organisationName, kind);
    planned[kind] += 1;
  }
  return { rows, kinds, planned };
}

/** Back the planned joins up, then restore each; a failed backup writes nothing, and a planned join not written fails the run. */
export async function applyRestores(
  plan: RestorePlan,
  deps: {
    /** Writes every row as stored, or throws having written nothing. */
    backup: (stored: Record<string, unknown>[]) => Promise<void>;
    /** One restore as one write; false when the join or its audit trail has changed since it was read. */
    commit: (input: CommitRestoreInput) => Promise<boolean>;
    changedBy: string;
  },
): Promise<{ applied: RestoreCounts | null; failure: string | null }> {
  const planned = plan.rows.flatMap((row) => {
    const score = scoreOf(row.method);
    return plan.kinds.get(row.organisationName) === 'restore' &&
      row.join &&
      row.method !== null &&
      score !== null
      ? [{ row, join: row.join, method: row.method, score }]
      : [];
  });
  try {
    await deps.backup(planned.map(({ join }) => join.stored));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      applied: null,
      failure: `nothing was written, as the backup failed: ${reason}`,
    };
  }
  const applied: RestoreCounts = {
    restored: 0,
    changed: 0,
    errored: 0,
    not_tried: 0,
    left: plan.rows.length - planned.length,
  };
  let errorsInARow = 0;
  let firstError: string | null = null;
  for (const { row, join, method, score } of planned) {
    if (errorsInARow >= MAX_ERRORS_IN_A_ROW) {
      applied.not_tried += 1;
      continue;
    }
    try {
      const done = await staged('restore', () =>
        deps.commit({
          organisationName: row.organisationName,
          rowHash: join.rowHash,
          auditId: row.auditId,
          method,
          score,
          changedBy: deps.changedBy,
        }),
      );
      applied[done ? 'restored' : 'changed'] += 1;
      errorsInARow = 0;
    } catch (error) {
      applied.errored += 1;
      errorsInARow += 1;
      firstError ??= error instanceof StageError ? error.message : 'error';
    }
  }
  // A restore planned and not written must not be taken as done by what runs next.
  const unwritten = applied.changed + applied.errored + applied.not_tried;
  const failure =
    unwritten > 0
      ? `${unwritten} planned restores were not written${firstError ? ` (first error: ${firstError})` : ''}; plan again and apply with a new --backup`
      : null;
  return { applied, failure };
}
