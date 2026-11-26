import { describe, expect, test } from 'bun:test';

import {
  applyRestores,
  type CommitRestoreInput,
  type MovedJoin,
  planRestores,
  RESTORED_BY,
  restoreKind,
  scoreOf,
} from './method-restore';
import { TIER_A2_SCORE } from './pipeline';

/** Westpac Banking Corporation, one of the first three moved on 2026-11-26: its join as the move left it, beside the move's audit row. */
const moved = (over: Partial<MovedJoin> = {}): MovedJoin => ({
  auditId: 501,
  newestAuditId: 501,
  organisationName: 'Westpac Banking Corporation',
  establishmentNumber: 'BR000106',
  method: 'exact',
  join: {
    stored: {
      organisation_name: 'Westpac Banking Corporation',
      company_number: 'BR000106',
      match_method: 'manual',
      match_score: null,
    },
    rowHash: 'hash of the join',
    companyNumber: 'BR000106',
    matchMethod: 'manual',
  },
  ...over,
});

/** The join as stored, with some of what the plan reads changed. */
const joinAs = (over: {
  companyNumber?: string | null;
  matchMethod?: string | null;
}) => ({
  ...(moved().join as NonNullable<MovedJoin['join']>),
  ...over,
});

describe('scoreOf', () => {
  // The 373 joins moved on 2026-11-26 were 285 exact at 1 and 88 exact_squash at 0.98.
  test('the two methods that fix their score', () => {
    expect(scoreOf('exact')).toBe(1);
    expect(scoreOf('exact_squash')).toBe(TIER_A2_SCORE);
  });

  test.each([
    ['previous_name'],
    ['token_sim'],
    ['fuzzy_edit'],
    ['manual'],
    [null],
  ])('%s leaves the score open', (method) => {
    expect(scoreOf(method)).toBeNull();
  });
});

describe('restoreKind', () => {
  test('a join still manual on its establishment, and not written since, is restored', () => {
    expect(restoreKind(moved())).toBe('restore');
    expect(restoreKind(moved({ method: 'exact_squash' }))).toBe('restore');
  });

  test('a join that already has its method back is done', () => {
    expect(
      restoreKind(
        // The restore's own audit row is then the newest for the sponsor.
        moved({ newestAuditId: 502, join: joinAs({ matchMethod: 'exact' }) }),
      ),
    ).toBe('already');
  });

  test('a join on any other company, or by any other method, differs', () => {
    expect(
      restoreKind(moved({ join: joinAs({ companyNumber: 'FC000138' }) })),
    ).toBe('differs');
    expect(restoreKind(moved({ join: joinAs({ companyNumber: null }) }))).toBe(
      'differs',
    );
    expect(
      restoreKind(moved({ join: joinAs({ matchMethod: 'previous_name' }) })),
    ).toBe('differs');
    // Its old method on another company is not the move's doing.
    expect(
      restoreKind(
        moved({
          join: joinAs({ companyNumber: 'FC000138', matchMethod: 'exact' }),
        }),
      ),
    ).toBe('differs');
  });

  // JPMorgan Chase Bank's join was corrected by hand: a manual join another writer recorded is that writer's.
  test('a join written since the move is left, manual as it is', () => {
    expect(restoreKind(moved({ newestAuditId: 502 }))).toBe('superseded');
  });

  test.each([['previous_name'], ['token_sim'], ['fuzzy_edit'], [null]])(
    'a method that does not fix its score (%s) is left',
    (method) => {
      expect(restoreKind(moved({ method }))).toBe('no_score');
    },
  );

  test('a sponsor with no join is missing', () => {
    expect(restoreKind(moved({ join: null }))).toBe('missing');
  });
});

describe('planRestores', () => {
  test('counts each outcome', async () => {
    const plan = await planRestores(async () => [
      moved(),
      moved({ organisationName: 'B', method: 'exact_squash' }),
      moved({ organisationName: 'C', newestAuditId: 502 }),
      moved({ organisationName: 'D', join: null }),
    ]);
    expect(plan.planned).toEqual({
      restore: 2,
      already: 0,
      differs: 0,
      superseded: 1,
      no_score: 0,
      missing: 1,
    });
    expect(plan.kinds.get('C')).toBe('superseded');
  });
});

/** The writes of a run, each recorded, with what the commit answers. */
function writes(over: { commit?: (boolean | Error)[]; backup?: Error } = {}) {
  const commits: CommitRestoreInput[] = [];
  const backups: Record<string, unknown>[][] = [];
  return {
    commits,
    backups,
    deps: {
      changedBy: RESTORED_BY,
      backup: async (stored: Record<string, unknown>[]) => {
        if (over.backup) throw over.backup;
        backups.push(stored);
      },
      commit: async (input: CommitRestoreInput) => {
        commits.push(input);
        const answer = over.commit?.[commits.length - 1] ?? true;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

describe('applyRestores', () => {
  test('backs the planned joins up, then gives each its method and the score it fixes', async () => {
    const plan = await planRestores(async () => [
      moved(),
      moved({
        organisationName: 'B',
        method: 'exact_squash',
        auditId: 77,
        newestAuditId: 77,
      }),
      moved({ organisationName: 'C', newestAuditId: 502 }),
    ]);
    const run = writes();
    const result = await applyRestores(plan, run.deps);
    // Only the joins about to be written are kept, each as stored.
    const stored = joinAs({}).stored;
    expect(run.backups).toEqual([[stored, stored]]);
    expect(run.commits).toEqual([
      {
        organisationName: 'Westpac Banking Corporation',
        rowHash: 'hash of the join',
        auditId: 501,
        method: 'exact',
        score: 1,
        changedBy: 'uk_establishment_method_restore',
      },
      {
        organisationName: 'B',
        rowHash: 'hash of the join',
        auditId: 77,
        method: 'exact_squash',
        score: 0.98,
        changedBy: 'uk_establishment_method_restore',
      },
    ]);
    expect(result).toEqual({
      applied: { restored: 2, changed: 0, errored: 0, not_tried: 0, left: 1 },
      failure: null,
    });
  });

  test('a failed backup writes nothing', async () => {
    const plan = await planRestores(async () => [moved()]);
    const run = writes({ backup: new Error('disk full') });
    const result = await applyRestores(plan, run.deps);
    expect(run.commits).toEqual([]);
    expect(result).toEqual({
      applied: null,
      failure: 'nothing was written, as the backup failed: disk full',
    });
  });

  test('a join changed since it was read is left, and fails the run', async () => {
    const plan = await planRestores(async () => [moved()]);
    const result = await applyRestores(plan, writes({ commit: [false] }).deps);
    expect(result.applied).toMatchObject({ restored: 0, changed: 1 });
    expect(result.failure).toBe(
      '1 planned restores were not written; plan again and apply with a new --backup',
    );
  });

  test('errors in a row stop the run, named by stage and kind only', async () => {
    const failed = new Error('the sponsor is Westpac');
    failed.name = 'NeonDbError';
    const plan = await planRestores(async () =>
      Array.from({ length: 7 }, (_, i) => moved({ organisationName: `S${i}` })),
    );
    const result = await applyRestores(
      plan,
      writes({ commit: Array.from({ length: 7 }, () => failed) }).deps,
    );
    expect(result.applied).toMatchObject({
      errored: 5,
      not_tried: 2,
      restored: 0,
    });
    expect(result.failure).toBe(
      '7 planned restores were not written (first error: restore: NeonDbError); plan again and apply with a new --backup',
    );
  });
});
