import { describe, expect, test } from 'bun:test';

import type { ListedRow } from './rejected-site-sql';
import type { Repoint, RepointEntry } from './repoint';
import { applyRepoints, planRepoints } from './repoint-run';
import type { RepointOutcome, RepointSnapshot } from './repoint-sql';

const OLD = 'https://www.quillmere-old.co.uk';
const NEW = 'https://www.quillmere.co.uk';

/** A listed row as read: the address it holds, and when it was pinned. */
const listed = (
  companyNumber: string,
  url: string | null,
  pinnedAt: string | null = null,
): ListedRow => ({
  stored: {
    company_number: companyNumber,
    url,
    evidence: 'registry_confirmed',
    source: 'cqc',
    url_pinned_at: pinnedAt,
  },
  source: 'cqc',
  snapshot: {
    companyNumber,
    url,
    candidates: null,
    rowHash: `hash-${companyNumber}`,
  },
});
const entry = (companyNumber: string): RepointEntry => ({
  companyNumber,
  url: OLD,
  newUrl: NEW,
  newEvidenceUrl: null,
  keepLive: false,
});

const toMove = listed('09990117', OLD);
const toPin = listed('09990118', NEW);
const done = listed('09990119', NEW, '2026-11-16T12:00:00');
const elsewhere = listed('09990120', 'https://www.hestwick.co.uk');

describe('planRepoints', () => {
  test('reads every listed row and plans each repoint from it', async () => {
    let asked: readonly string[] = [];
    const plan = await planRepoints(
      ['09990117', '09990118', '09990119'].map(entry),
      async (numbers) => {
        asked = numbers;
        return [toMove, toPin, done];
      },
    );
    expect(asked).toEqual(['09990117', '09990118', '09990119']);
    expect(plan.planned).toEqual({
      move: 1,
      pin: 1,
      already: 1,
      differs: 0,
      missing: 0,
    });
    expect(plan.refusal).toBeNull();
    expect(plan.rows).toEqual([toMove, toPin, done]);
  });

  test('a row with no column for the pin yet reads as not pinned', async () => {
    const before = listed('09990118', NEW);
    delete before.stored.url_pinned_at;
    const plan = await planRepoints([entry('09990118')], async () => [before]);
    expect(plan.planned).toMatchObject({ pin: 1, already: 0 });
  });

  test('a row holding another address, or no row at all, stops the run before anything is written', async () => {
    const plan = await planRepoints(
      ['09990117', '09990120', '09990121'].map(entry),
      async () => [toMove, elsewhere],
    );
    expect(plan.planned).toEqual({
      move: 1,
      pin: 0,
      already: 0,
      differs: 1,
      missing: 1,
    });
    expect(plan.refusal).toBe(
      'a listed row is missing or holds another address than listed; correct the list and plan again',
    );
  });
});

describe('applyRepoints', () => {
  /** Dependencies that record the order of what they are asked to do. */
  const recording = (outcomes: Record<string, RepointOutcome> = {}) => {
    const log: string[] = [];
    const written: { row: RepointSnapshot; change: Repoint }[] = [];
    return {
      log,
      written,
      deps: {
        backup: async (stored: Record<string, unknown>[]) => {
          log.push(`backup:${stored.map((s) => s.company_number).join(',')}`);
        },
        repoint: async (row: RepointSnapshot, change: Repoint) => {
          log.push(`write:${row.companyNumber}`);
          written.push({ row, change });
          return (
            outcomes[row.companyNumber] ??
            (change.kind === 'pin' ? 'pinned' : 'repointed')
          );
        },
      },
    };
  };
  const entries = ['09990117', '09990118', '09990119'].map(entry);
  const plan = () => planRepoints(entries, async () => [toMove, toPin, done]);

  test('backs every listed row up as stored, then writes each change from its backed-up row', async () => {
    const { deps, log, written } = recording();
    const result = await applyRepoints(entries, await plan(), deps);
    // The backup first, and a row already done is never written.
    expect(log).toEqual([
      'backup:09990117,09990118,09990119',
      'write:09990117',
      'write:09990118',
    ]);
    expect(written.map((w) => [w.row, w.change.kind])).toEqual([
      [{ companyNumber: '09990117', rowHash: 'hash-09990117' }, 'move'],
      [{ companyNumber: '09990118', rowHash: 'hash-09990118' }, 'pin'],
    ]);
    expect(result).toEqual({
      applied: { repointed: 1, pinned: 1, already: 1, changed: 0 },
      failure: null,
    });
  });

  test('a failed backup writes nothing', async () => {
    const { deps, log } = recording();
    const result = await applyRepoints(entries, await plan(), {
      ...deps,
      backup: async () => {
        throw new Error('EEXIST');
      },
    });
    expect(log).toEqual([]);
    expect(result).toEqual({
      applied: null,
      failure: 'nothing was written, as the backup failed: EEXIST',
    });
  });

  test('a plan that was refused writes nothing, not even a backup', async () => {
    const { deps, log } = recording();
    const refused = await planRepoints(
      ['09990117', '09990120'].map(entry),
      async () => [toMove, elsewhere],
    );
    const result = await applyRepoints(
      ['09990117', '09990120'].map(entry),
      refused,
      deps,
    );
    expect(log).toEqual([]);
    expect(result).toEqual({ applied: null, failure: refused.refusal });
  });

  test('a row another job changed since the backup is left, and fails the run so it is not taken as done', async () => {
    const { deps } = recording({ '09990117': 'changed' });
    const result = await applyRepoints(entries, await plan(), deps);
    expect(result.applied).toEqual({
      repointed: 0,
      pinned: 1,
      already: 1,
      changed: 1,
    });
    expect(result.failure).toBe(
      'rows changed since the backup were left; plan again and apply with a new --backup',
    );
  });
});
