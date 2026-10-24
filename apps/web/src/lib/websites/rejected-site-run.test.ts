import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyRun,
  makeBackup,
  parseRejections,
  planRun,
} from './rejected-site-run';
import type { ListedRow, RejectOutcome } from './rejected-site-sql';

const trust = 'https://www.club-trust.org';

/** A listed row as read: on the rejected site, banking it, or clean of it. */
const listed = (
  companyNumber: string,
  url: string | null,
  candidates: unknown,
  source = 'search',
): ListedRow => ({
  stored: { company_number: companyNumber, url, candidates, source },
  source,
  snapshot: {
    companyNumber,
    url,
    candidates,
    rowHash: `hash-${companyNumber}`,
  },
});
const onSite = listed('03260168', trust, [`${trust}/about`]);
const banking = listed('04111111', null, [`${trust}/`, 'https://club.co.uk']);
const clean = listed('05222222', null, ['https://club.co.uk']);
const entry = (companyNumber: string) => ({ companyNumber, url: trust });

describe('parseRejections', () => {
  test('a list of company numbers and sites, as given', () => {
    expect(
      parseRejections([{ companyNumber: '03260168', url: trust, note: 'x' }]),
    ).toEqual([{ companyNumber: '03260168', url: trust }]);
  });

  test('refuses anything else, and a company listed twice', () => {
    for (const json of [
      {},
      [{ companyNumber: '03260168' }],
      [null],
      [{ companyNumber: 3260168, url: trust }],
    ]) {
      expect(parseRejections(json)).toBe(
        'the list must be [{ companyNumber, url }]',
      );
    }
    // Each write is guarded on one snapshot of the row.
    expect(
      parseRejections([
        entry('03260168'),
        { companyNumber: '03260168', url: 'https://club.co.uk' },
      ]),
    ).toBe('a company is listed twice; list its other site in a second run');
  });
});

describe('planRun', () => {
  test('reads every listed row and plans each rejection from it', async () => {
    let asked: readonly string[] = [];
    const plan = await planRun(
      ['03260168', '04111111', '05222222', '06333333'].map(entry),
      async (numbers) => {
        asked = numbers;
        return [onSite, banking, clean];
      },
    );
    expect(asked).toEqual(['03260168', '04111111', '05222222', '06333333']);
    expect(plan.planned).toEqual({
      reset: 1,
      stripped: 1,
      unchanged: 1,
      missing: 1,
      not_search: 0,
    });
    expect(plan.refusal).toBeNull();
  });

  test("a registry's row refuses the run, as its next import would bring the site back", async () => {
    const registry = listed('07444444', trust, null, 'cqc');
    const plan = await planRun(
      [entry('03260168'), entry('07444444')],
      async () => [onSite, registry],
    );
    expect(plan.planned.not_search).toBe(1);
    expect(plan.refusal).toBe(
      "a registry's row takes its site back on the next import; list search rows only",
    );
  });
});

describe('applyRun', () => {
  /** A run's calls, each recorded once it has finished. */
  const recorder = (outcomes: RejectOutcome[] = []) => {
    const calls: string[] = [];
    let backedUp: Record<string, unknown>[] = [];
    const deps = {
      backup: async (stored: Record<string, unknown>[]) => {
        // Finishes a tick late, as a file write does, so a write not waiting for it shows.
        await new Promise((resolve) => setTimeout(resolve, 1));
        calls.push('backup');
        backedUp = stored;
      },
      reject: async (row: { companyNumber: string }) => {
        calls.push(`reject ${row.companyNumber}`);
        return outcomes.shift() ?? 'reset';
      },
    };
    return { calls, deps, backedUp: () => backedUp };
  };

  test('backs every row up as stored, one with nothing to change too, before rejecting any', async () => {
    const entries = [entry('03260168'), entry('04111111'), entry('05222222')];
    const plan = await planRun(entries, async () => [onSite, banking, clean]);
    const run = recorder(['reset', 'stripped', 'unchanged']);
    const result = await applyRun(entries, plan, run.deps);
    expect(run.calls).toEqual([
      'backup',
      'reject 03260168',
      'reject 04111111',
      'reject 05222222',
    ]);
    expect(run.backedUp()).toEqual([
      onSite.stored,
      banking.stored,
      clean.stored,
    ]);
    expect(result).toEqual({
      applied: { reset: 1, stripped: 1, unchanged: 1, missing: 0, moved: 0 },
      failure: null,
    });
  });

  test('a failed backup writes nothing', async () => {
    const plan = await planRun([entry('03260168')], async () => [onSite]);
    const run = recorder();
    const result = await applyRun([entry('03260168')], plan, {
      ...run.deps,
      backup: async () => {
        throw new Error('EEXIST: file already exists');
      },
    });
    expect(run.calls).toEqual([]);
    expect(result).toEqual({
      applied: null,
      failure:
        'nothing was written, as the backup failed: EEXIST: file already exists',
    });
  });

  test('a refused plan backs nothing up and writes nothing', async () => {
    const plan = await planRun([entry('07444444')], async () => [
      listed('07444444', trust, null, 'cqc'),
    ]);
    const run = recorder();
    const result = await applyRun([entry('07444444')], plan, run.deps);
    expect(run.calls).toEqual([]);
    expect(result.applied).toBeNull();
    expect(result.failure).toBe(plan.refusal);
  });

  test('a row moved since the backup, or missing, fails the run', async () => {
    const failure =
      'rows missing, or changed since the backup, were left; plan again and apply with a new --backup';
    const moved = await applyRun(
      [entry('03260168')],
      await planRun([entry('03260168')], async () => [onSite]),
      recorder(['moved']).deps,
    );
    expect(moved.failure).toBe(failure);
    const missing = await applyRun(
      [entry('06333333')],
      await planRun([entry('06333333')], async () => []),
      recorder().deps,
    );
    expect(missing).toEqual({
      applied: { reset: 0, stripped: 0, unchanged: 0, missing: 1, moved: 0 },
      failure,
    });
  });
});

describe('makeBackup', () => {
  test('writes every row once, and never over a file that exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reject-backup-'));
    try {
      const path = join(dir, 'backup.json');
      const at = new Date('2026-10-24T03:00:00.000Z');
      await makeBackup(path, at)([onSite.stored]);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        at: '2026-10-24T03:00:00.000Z',
        rows: [onSite.stored],
      });
      // A re-run's backup would hold rows the first run already changed.
      writeFileSync(path, 'first run');
      await expect(makeBackup(path, at)([banking.stored])).rejects.toThrow(
        'EEXIST',
      );
      expect(readFileSync(path, 'utf8')).toBe('first run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
