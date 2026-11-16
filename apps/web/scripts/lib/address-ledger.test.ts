import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fileLedger,
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
});

describe('fileLedger', () => {
  test('two processes on one directory take turns at an address', () => {
    const dir = scratch();
    const one = fileLedger(dir);
    const two = fileLedger(dir);
    expect(one.reserve([A], 1000, 0)).toBe(0);
    expect(two.reserve([A], 1000, 0)).toBe(1000);
    expect(one.reserve([A, B], 1000, 500)).toBe(2000);
    expect(two.reserve([B], 1000, 500)).toBe(3000);
    expect(JSON.parse(readFileSync(join(dir, 'turns.json'), 'utf8'))).toEqual({
      [A]: 3000,
      [B]: 4000,
    });
    // Given back after every turn, or the next process would wait for it.
    expect(existsSync(join(dir, 'lock'))).toBe(false);
  });

  test('a file that will not parse, or holds something that is not a time, is read as empty', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'turns.json'), '{"192.0.2.10": 90');
    expect(fileLedger(dir).reserve([A], 1000, 5000)).toBe(5000);
    // Still the shared file, written whole again.
    expect(JSON.parse(readFileSync(join(dir, 'turns.json'), 'utf8'))).toEqual({
      [A]: 6000,
    });
    writeFileSync(
      join(dir, 'turns.json'),
      JSON.stringify({ [A]: 'soon', [B]: 9000 }),
    );
    expect(fileLedger(dir).reserve([A], 1000, 5000)).toBe(5000);
    expect(fileLedger(dir).reserve([B], 1000, 5000)).toBe(9000);
  });

  test('a lock left behind by a process that died is cleared', () => {
    const dir = scratch();
    const lock = join(dir, 'lock');
    mkdirSync(lock);
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, longAgo, longAgo);
    const warnings: string[] = [];
    const ledger = fileLedger(dir, { warn: (m) => warnings.push(m) });
    expect(ledger.reserve([A], 1000, 0)).toBe(0);
    expect(warnings).toEqual([]);
    expect(existsSync(join(dir, 'turns.json'))).toBe(true);
  });

  test('a lock another process keeps holding: this one paces alone, and says so once', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'lock'));
    const warnings: string[] = [];
    const ledger = fileLedger(dir, {
      warn: (m) => warnings.push(m),
      staleLockMs: 60_000,
      lockWaitMs: 20,
    });
    expect(ledger.reserve([A], 1000, 0)).toBe(0);
    // Still pacing, from its own memory.
    expect(ledger.reserve([A], 1000, 0)).toBe(1000);
    expect(warnings).toEqual([
      '  address ledger unavailable (ELOCKED): this process paces alone',
    ]);
    expect(existsSync(join(dir, 'turns.json'))).toBe(false);
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
    expect(statSync(join(dir, 'turns.json')).mode & 0o777).toBe(0o600);
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
    expect(existsSync(join(written, 'turns.json'))).toBe(false);
    expect(existsSync(join(written, 'lock'))).toBe(false);
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
    expect(existsSync(join(dir, 'turns.json'))).toBe(true);
  });

  test('separate processes never share a turn', async () => {
    const dir = scratch();
    const script = join(dir, 'worker.ts');
    writeFileSync(
      script,
      `import { fileLedger } from ${JSON.stringify(join(import.meta.dir, 'address-ledger.ts'))};
const ledger = fileLedger(process.argv[2]);
const turns: number[] = [];
for (let i = 0; i < 150; i++) turns.push(ledger.reserve(['192.0.2.10'], 7, Date.now()));
console.log(JSON.stringify(turns));
`,
    );
    const ledgerDir = join(dir, 'shared');
    const workers = [0, 1, 2].map(() =>
      Bun.spawn([process.execPath, script, ledgerDir], { stdout: 'pipe' }),
    );
    const turns = (
      await Promise.all(
        workers.map(
          async (worker) =>
            JSON.parse(await new Response(worker.stdout).text()) as number[],
        ),
      )
    )
      .flat()
      .sort((a, b) => a - b);
    expect(turns).toHaveLength(450);
    const gaps = turns.slice(1).map((turn, index) => turn - turns[index]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(7);
  });
});

describe('sharedLedgerDir', () => {
  test("is one place under the temp directory, so every walk a user starts finds the others' turns", () => {
    expect(sharedLedgerDir()).toBe(sharedLedgerDir());
    expect(
      sharedLedgerDir().startsWith(join(tmpdir(), 'sponsorsearch-walk-')),
    ).toBe(true);
  });
});
