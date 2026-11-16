import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  currentTurns,
  fileLedger,
  KEPT,
  memoryLedger,
  sharedLedgerDir,
  takeTurn,
} from './address-ledger.ts';

// Documentation addresses: nobody's.
const A = '192.0.2.10';
const B = '192.0.2.11';
const C = '2001:db8::10';

const made: string[] = [];
/** A throwaway directory, removed when the file is done. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'address-ledger-test-'));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe('takeTurn', () => {
  test('an idle address is free at once, and busy for the gap after', () => {
    expect(takeTurn({}, [A], 1000, 5000)).toEqual({
      turn: 5000,
      turns: { [A]: 6000 },
    });
  });

  test('a request inside the gap waits it out; one after it goes at once', () => {
    expect(takeTurn({ [A]: 6000 }, [A], 1000, 5200)).toEqual({
      turn: 6000,
      turns: { [A]: 7000 },
    });
    expect(takeTurn({ [A]: 6000 }, [A], 1000, 9000)).toEqual({
      turn: 9000,
      turns: { [A]: 10_000 },
    });
  });

  test('a host on several addresses waits for the busiest, and takes its turn at each', () => {
    expect(takeTurn({ [A]: 6000, [B]: 8000 }, [A, B, C], 1000, 5000)).toEqual({
      turn: 8000,
      turns: { [A]: 9000, [B]: 9000, [C]: 9000 },
    });
  });

  test("another address's turn costs nothing: one still ahead is kept, one past is dropped", () => {
    expect(takeTurn({ [A]: 6000, [B]: 4000 }, [C], 1000, 5000)).toEqual({
      turn: 5000,
      turns: { [A]: 6000, [C]: 6000 },
    });
  });
});

describe('memoryLedger', () => {
  test('remembers the turns it gave', () => {
    const ledger = memoryLedger();
    expect(ledger.reserve([A], 1000, 0)).toBe(0);
    expect(ledger.reserve([A], 1000, 0)).toBe(1000);
    expect(ledger.reserve([A], 1000, 0)).toBe(2000);
    expect(ledger.reserve([B], 1000, 0)).toBe(0);
  });

  test('starts from the turns it is given, and leaves them as they were', () => {
    const known = { [A]: 4000 };
    const ledger = memoryLedger(known);
    expect(ledger.reserve([A], 1000, 0)).toBe(4000);
    expect(ledger.reserve([B], 1000, 0)).toBe(0);
    expect(known).toEqual({ [A]: 4000 });
  });
});

describe('fileLedger', () => {
  /** The numbers of the turns files in a ledger directory, lowest first. */
  const numbersIn = (dir: string) =>
    readdirSync(dir)
      .flatMap((name) => {
        const match = /^turns\.(\d+)\.json$/.exec(name);
        return match ? [Number(match[1])] : [];
      })
      .sort((a, b) => a - b);

  test('two processes on one directory take turns at an address, each change a new numbered file', () => {
    const dir = scratch();
    const one = fileLedger(dir);
    const two = fileLedger(dir);
    expect(one.reserve([A], 1000, 0)).toBe(0);
    expect(two.reserve([A], 1000, 0)).toBe(1000);
    expect(one.reserve([A, B], 1000, 500)).toBe(2000);
    expect(two.reserve([B], 1000, 500)).toBe(3000);
    expect(currentTurns(dir)).toEqual({ [A]: 3000, [B]: 4000 });
    // Four changes, and nothing half-made left beside them.
    expect(readdirSync(dir).sort()).toEqual([
      'turns.1.json',
      'turns.2.json',
      'turns.3.json',
      'turns.4.json',
    ]);
  });

  test('only the newest files are kept', () => {
    expect(KEPT).toBe(64);
    const dir = scratch();
    const ledger = fileLedger(dir);
    for (let i = 0; i < KEPT + 4; i++) ledger.reserve([A], 1000, 0);
    expect(numbersIn(dir)).toEqual(
      Array.from({ length: KEPT }, (_, i) => i + 5),
    );
    expect(readdirSync(dir)).toHaveLength(KEPT);
  });

  test('a file that will not parse, or holds something that is not a time, is read as empty', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'turns.7.json'), '{"192.0.2.10": 90');
    expect(currentTurns(dir)).toEqual({});
    expect(fileLedger(dir).reserve([A], 1000, 5000)).toBe(5000);
    // Still the shared files: the next number, whole.
    expect(numbersIn(dir)).toEqual([7, 8]);
    expect(currentTurns(dir)).toEqual({ [A]: 6000 });
    writeFileSync(
      join(dir, 'turns.9.json'),
      JSON.stringify({ [A]: 'soon', [B]: 9000 }),
    );
    expect(fileLedger(dir).reserve([A], 1000, 5000)).toBe(5000);
    expect(fileLedger(dir).reserve([B], 1000, 5000)).toBe(9000);
  });

  test('a file that is not one of its numbered ones is left alone and never read', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'turns.json'), JSON.stringify({ [A]: 9000 }));
    writeFileSync(join(dir, 'turns.x.json'), JSON.stringify({ [A]: 9000 }));
    expect(fileLedger(dir).reserve([A], 1000, 0)).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([
      'turns.1.json',
      'turns.json',
      'turns.x.json',
    ]);
  });

  /** A ledger that lets `step` run once, at the given point of its next change. */
  const interrupted = (
    dir: string,
    stage: 'read' | 'made',
    step: () => void,
  ) => {
    let pending: (() => void) | undefined = step;
    return fileLedger(dir, {
      between: (reached) => {
        if (reached !== stage || !pending) return;
        const run = pending;
        pending = undefined;
        run();
      },
    });
  };

  test('a process that another gets in ahead of reads again: no turn is given twice', () => {
    const dir = scratch();
    const two = fileLedger(dir);
    let theirs = -1;
    const one = interrupted(dir, 'read', () => {
      theirs = two.reserve([A], 1000, 0);
    });
    expect(one.reserve([A], 1000, 0)).toBe(1000);
    expect(theirs).toBe(0);
    expect(currentTurns(dir)).toEqual({ [A]: 2000 });
    expect(numbersIn(dir)).toEqual([1, 2]);
  });

  test('a change another process builds on at once still stands: its turn is not taken a second time', () => {
    const dir = scratch();
    const two = fileLedger(dir);
    let theirs = -1;
    const one = interrupted(dir, 'made', () => {
      theirs = two.reserve([A], 1000, 0);
    });
    expect(one.reserve([A], 1000, 0)).toBe(0);
    // Built on the first change, not beside it.
    expect(theirs).toBe(1000);
    expect(numbersIn(dir)).toEqual([1, 2]);
    expect(currentTurns(dir)).toEqual({ [A]: 2000 });
  });

  test('a process left so far behind that its number is free again does not take it for the next', () => {
    const dir = scratch();
    const two = fileLedger(dir);
    // It reads the turns, then stands still while the others go on until its number has been tidied away.
    const one = interrupted(dir, 'read', () => {
      for (let i = 0; i <= KEPT; i++) {
        expect(two.reserve([A], 1000, 0)).toBe(i * 1000);
      }
      expect(numbersIn(dir)[0]).toBe(2);
    });
    expect(one.reserve([A], 1000, 0)).toBe((KEPT + 1) * 1000);
    expect(currentTurns(dir)).toEqual({ [A]: (KEPT + 2) * 1000 });
    expect(Math.max(...numbersIn(dir))).toBe(KEPT + 2);
  });

  test('a process that keeps losing the race paces alone, from the turns that last beat it, and says so once', () => {
    const dir = scratch();
    const two = fileLedger(dir);
    const warnings: string[] = [];
    let lost = 0;
    const one = fileLedger(dir, {
      warn: (m) => warnings.push(m),
      maxAttempts: 3,
      between: (stage) => {
        if (stage !== 'read') return;
        lost += 1;
        two.reserve([B], 1000, 0);
      },
    });
    // Three tries, each beaten: B is busy until 3000.
    expect(one.reserve([B], 1000, 0)).toBe(3000);
    expect(lost).toBe(3);
    expect(one.reserve([B], 1000, 0)).toBe(4000);
    expect(lost).toBe(3);
    expect(warnings).toEqual([
      '  address ledger unavailable (ECONTENDED): this process paces alone',
    ]);
  });

  test('files that stop working mid-run: this process paces alone without forgetting the turns it had', () => {
    const dir = join(scratch(), 'ledger');
    const warnings: string[] = [];
    const ledger = fileLedger(dir, { warn: (m) => warnings.push(m) });
    expect(ledger.reserve([A], 1000, 0)).toBe(0);
    // The directory is gone, and a file stands where it was.
    rmSync(dir, { recursive: true });
    writeFileSync(dir, '');
    expect(ledger.reserve([A], 1000, 100)).toBe(1000);
    expect(ledger.reserve([A], 1000, 100)).toBe(2000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^ {2}address ledger unavailable \(E[A-Z]+\)/);
  });

  test('a directory that cannot be made: this process paces alone', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'file'), '');
    const warnings: string[] = [];
    const ledger = fileLedger(join(dir, 'file', 'ledger'), {
      warn: (m) => warnings.push(m),
    });
    expect(ledger.reserve([A], 1000, 0)).toBe(0);
    expect(ledger.reserve([A], 1000, 0)).toBe(1000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^ {2}address ledger unavailable \(E[A-Z]+\)/);
  });

  test("a directory it makes, and the file in it, are this user's alone", () => {
    const dir = join(scratch(), 'made');
    fileLedger(dir).reserve([A], 1000, 0);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'turns.1.json')).mode & 0o777).toBe(0o600);
  });

  /** A ledger on a directory it must not trust: it paces alone, says why, and writes nothing there. */
  const refused = (dir: string, written = dir) => {
    const warnings: string[] = [];
    const ledger = fileLedger(dir, { warn: (m) => warnings.push(m) });
    expect(ledger.reserve([A], 1000, 0)).toBe(0);
    expect(ledger.reserve([A], 1000, 0)).toBe(1000);
    expect(warnings).toEqual([
      '  address ledger unavailable (EUNTRUSTED): this process paces alone',
    ]);
    expect(readdirSync(written)).toEqual([]);
  };

  test('a directory other users can write to is not used', () => {
    const dir = join(scratch(), 'open');
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    refused(dir);
    chmodSync(dir, 0o770);
    refused(dir);
  });

  test('a link standing in for the directory is not followed', () => {
    const real = scratch();
    const link = join(scratch(), 'link');
    symlinkSync(real, link);
    refused(link, real);
  });

  test("another user's directory is not used", () => {
    const dir = scratch();
    const uid = spyOn(process, 'getuid').mockReturnValue(statSync(dir).uid + 1);
    try {
      refused(dir);
    } finally {
      uid.mockRestore();
    }
    // The same directory, once it is ours again.
    expect(fileLedger(dir).reserve([A], 1000, 0)).toBe(0);
    expect(numbersIn(dir)).toEqual([1]);
  });

  test('separate processes never share a turn', async () => {
    const dir = scratch();
    const script = join(dir, 'worker.ts');
    writeFileSync(
      script,
      `import { fileLedger } from ${JSON.stringify(join(import.meta.dir, 'address-ledger.ts'))};
const warnings: string[] = [];
const ledger = fileLedger(process.argv[2], { warn: (m) => warnings.push(m) });
const turns: number[] = [];
for (let i = 0; i < 150; i++) turns.push(ledger.reserve(['192.0.2.10'], 7, Date.now()));
console.log(JSON.stringify({ turns, warnings }));
`,
    );
    const ledgerDir = join(dir, 'shared');
    const workers = [0, 1, 2].map(() =>
      Bun.spawn([process.execPath, script, ledgerDir], { stdout: 'pipe' }),
    );
    const results = await Promise.all(
      workers.map(
        async (worker) =>
          JSON.parse(await new Response(worker.stdout).text()) as {
            turns: number[];
            warnings: string[];
          },
      ),
    );
    // Every one of them stayed on the shared files throughout.
    expect(results.flatMap((result) => result.warnings)).toEqual([]);
    const turns = results
      .flatMap((result) => result.turns)
      .sort((a, b) => a - b);
    expect(turns).toHaveLength(450);
    const gaps = turns.slice(1).map((turn, index) => turn - turns[index]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(7);
    // A change for every turn: a process held up mid-change may make one again, never one fewer.
    expect(Math.max(...numbersIn(ledgerDir))).toBeGreaterThanOrEqual(450);
    // Only the newest kept, and no drafts left.
    expect(numbersIn(ledgerDir).length).toBeLessThanOrEqual(KEPT);
    expect(readdirSync(ledgerDir)).toHaveLength(numbersIn(ledgerDir).length);
  });
});

describe('sharedLedgerDir', () => {
  test("is one place under the temp directory, so every walk a user starts finds the others' turns", () => {
    expect(sharedLedgerDir()).toBe(sharedLedgerDir());
    expect(
      sharedLedgerDir().startsWith(join(tmpdir(), 'sponsorsearch-walk-')),
    ).toBe(true);
  });

  test('is a different place for each user', () => {
    const mine = sharedLedgerDir();
    const uid = spyOn(process, 'getuid').mockReturnValue(
      (process.getuid?.() ?? 0) + 1,
    );
    try {
      expect(sharedLedgerDir()).not.toBe(mine);
    } finally {
      uid.mockRestore();
    }
    expect(sharedLedgerDir()).toBe(mine);
  });
});
