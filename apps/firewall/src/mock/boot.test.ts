// The choice a mock session makes before it exists. Nothing here touches the real drawer: the
// available list is passed in, which is the whole reason chooseCassette does not read it itself.

import { describe, expect, test } from 'bun:test';

import { type Boot, type Chosen, chooseCassette } from './boot';
import type { CassetteInfo } from './cassette-store';

const FRESH: CassetteInfo = {
  name: 'fresh-scrape',
  path: '/d/fresh-scrape.jsonl',
  bytes: 2048,
  ageDays: 0,
  writtenMs: 1000000,
};
const QUIET: CassetteInfo = {
  name: 'quiet-tuesday',
  path: '/d/quiet-tuesday.jsonl',
  bytes: 900,
  ageDays: 12,
  writtenMs: 999988,
};
const AVAILABLE = [FRESH, QUIET];

const never = async (): Promise<never> => {
  throw new Error('the picker should not have been reached');
};

// Passed explicitly rather than resolved. These messages depend on whether the drawer is
// reachable, and reading that from the environment is why they passed locally — where a private
// ops checkout exists — and failed in CI, where one never will.
const REACHABLE = {
  kind: 'found',
  dir: '/d',
  source: 'found',
} as const;
const UNREACHABLE = {
  kind: 'missing',
  message: 'the ops repo could not be found',
} as const;

function refusal(result: Boot | Chosen): string {
  expect(result.kind).toBe('refused');
  return (result as { kind: 'refused'; message: string }).message;
}

describe('choosing by name', () => {
  test('takes the named cassette without showing the picker', async () => {
    const result = await chooseCassette(AVAILABLE, 'quiet-tuesday', never);
    expect(result).toEqual({ kind: 'chose', info: QUIET });
  });

  // A typo produces exactly the same silent nothing as a real empty corpus, and an operator reads
  // that as a broken tool rather than a mistyped flag.
  test('a name that is not there lists what is, rather than starting empty', async () => {
    const message = refusal(await chooseCassette(AVAILABLE, 'august', never));
    expect(message).toContain('No cassette named "august"');
    expect(message).toContain('fresh-scrape');
    expect(message).toContain('quiet-tuesday');
  });

  test('an unusable name is refused before it ever reaches a path', async () => {
    const message = refusal(
      await chooseCassette(AVAILABLE, '../../etc/passwd', never),
    );
    expect(message).toContain('not a usable cassette name');
  });

  test('a name given against an empty drawer says to record one', async () => {
    const message = refusal(
      await chooseCassette([], 'august', never, REACHABLE),
    );
    expect(message).toContain('firewall:record --cassette');
  });
});

describe('choosing from the picker', () => {
  test('takes what the picker returned', async () => {
    const result = await chooseCassette(AVAILABLE, undefined, async () => ({
      kind: 'cassette',
      info: QUIET,
    }));
    expect(result).toEqual({ kind: 'chose', info: QUIET });
  });

  test('the picker sees everything available', async () => {
    let seen: readonly CassetteInfo[] = [];
    await chooseCassette(AVAILABLE, undefined, async (available) => {
      seen = available;
      return { kind: 'cassette', info: FRESH };
    });
    expect(seen).toEqual(AVAILABLE);
  });

  // Quitting must not start a session, and must not be mistaken for a refusal — one is the
  // operator's choice and the other is an error worth an exit code.
  test('quitting is its own outcome, not a refusal', async () => {
    const result = await chooseCassette(AVAILABLE, undefined, async () => ({
      kind: 'quit',
    }));
    expect(result).toEqual({ kind: 'quit' });
  });
});

describe('with nothing recorded', () => {
  // Starting empty would make every traffic pane read zero, which is indistinguishable from a
  // working session over a quiet window.
  test('refuses and says how to record one', async () => {
    const message = refusal(
      await chooseCassette([], undefined, never, REACHABLE),
    );
    expect(message).toContain('No cassettes recorded yet');
    expect(message).toContain('bun run firewall:record --cassette <name>');
  });

  test('the picker is never shown an empty list', async () => {
    // `never` throws if reached; reaching it is the failure.
    await chooseCassette([], undefined, never, REACHABLE);
  });

  // Empty for two very different reasons. Telling someone to record into a drawer that cannot be
  // found sends them in a circle.
  test('an unreachable drawer says so instead of saying to record one', async () => {
    const message = refusal(
      await chooseCassette([], undefined, never, UNREACHABLE),
    );
    expect(message).toContain('could not be found');
    expect(message).not.toContain('No cassettes recorded yet');
  });

  test('and the same when a name was given', async () => {
    const message = refusal(
      await chooseCassette([], 'august', never, UNREACHABLE),
    );
    expect(message).toContain('could not be found');
  });
});

describe('with no picker available', () => {
  // A piped or redirected run has no terminal to draw one on.
  test('says the flag is the only way through', async () => {
    const message = refusal(
      await chooseCassette(AVAILABLE, undefined, undefined),
    );
    expect(message).toContain('--cassette');
  });
});

/**
 * Run `fn` against a fake ops repo holding one cassette of the given lines.
 *
 * The marker file is what identifies an ops repo, so the drawer resolves here rather than to the
 * operator's real corpus — which is the whole reason these tests can run at all.
 */
async function withCassette(
  name: string,
  lines: string[],
  fn: (bootMock: typeof import('./boot').bootMock) => Promise<void>,
): Promise<void> {
  const { mkdirSync, mkdtempSync, writeFileSync, rmSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const ops = mkdtempSync(join(tmpdir(), 'fw-ops-'));
  mkdirSync(join(ops, 'firewall-operator'), { recursive: true });
  writeFileSync(join(ops, 'firewall-operator', 'SKILL.md'), '# fake\n');
  mkdirSync(join(ops, 'firewall-cassettes'), { recursive: true });
  writeFileSync(
    join(ops, 'firewall-cassettes', `${name}.jsonl`),
    `${lines.join('\n')}\n`,
  );
  const before = process.env.FW_OPS_PATH;
  process.env.FW_OPS_PATH = ops;
  try {
    const { bootMock } = await import('./boot');
    await fn(bootMock);
  } finally {
    if (before === undefined) delete process.env.FW_OPS_PATH;
    else process.env.FW_OPS_PATH = before;
    rmSync(ops, { recursive: true, force: true });
  }
}

describe('a cassette that recorded nothing', () => {
  // A recording session that failed to boot leaves an empty cassette behind, and it would then
  // sit in the picker looking like a valid choice.
  test('is listed but refused, with the command to re-record', async () => {
    const { CASSETTE_VERSION } = await import('./cassette');
    await withCassette(
      'blank',
      [JSON.stringify({ cassette: CASSETTE_VERSION })],
      async (boot) => {
        const result = await boot({ named: 'blank' });
        expect(result.kind).toBe('refused');
        expect((result as { message: string }).message).toContain(
          'no recordings',
        );
      },
    );
  });
});

describe('a cassette this build cannot read', () => {
  // Literal 1, not CASSETTE_VERSION - 1: this asserts that an OLDER format is refused, and it must
  // keep saying that after the constant moves.
  test('an older format is refused, naming both versions', async () => {
    await withCassette(
      'old',
      ['{"cassette":1}', '{"k":"a","v":"x"}'],
      async (boot) => {
        const result = await boot({ named: 'old' });
        expect(result.kind).toBe('refused');
        const message = (result as { message: string }).message;
        expect(message).toContain('format 1');
        expect(message).toContain('firewall:record --cassette old');
      },
    );
  });

  test('a cassette with no header at all is refused too', async () => {
    await withCassette('old', ['{"k":"a","v":"x"}'], async (boot) => {
      const result = await boot({ named: 'old' });
      expect(result.kind).toBe('refused');
      expect((result as { message: string }).message).toContain('format 0');
    });
  });
});

describe('the miss log', () => {
  // A miss line carries the QUERY, and a query's filter names the client IP or TLS fingerprint it
  // was about. Measured at 375 such lines in one session.
  test('is created readable only by its owner', async () => {
    const { mkdtempSync, rmSync, statSync, existsSync } =
      await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { appendMissLog } = await import('./boot');
    const dir = mkdtempSync(join(tmpdir(), 'fw-misslog-'));
    const log = join(dir, 'mock-misses.log');
    try {
      appendMissLog(log, 'unrecorded  metrics["x"]');
      expect(existsSync(log)).toBe(true);
      expect(statSync(log).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The boot-level reset is NOT unit-tested here on purpose. Exercising it means calling
// bootRecording, which installs a WAF backend — and client.ts resolves credentials at module
// scope, so once an earlier test file has made that evaluation throw, everything below it
// (including `backend` itself) is in TDZ for the rest of the process and cannot be restored.
// The pieces it is built from — headerVersionOf and resetCassette — are covered directly in
// cassette.test.ts, and the wiring was verified against a real stale cassette from the CLI:
// re-recording turned a format 1 file into a current-format one, and the replay changed from
// "is cassette format 1" to "has no recordings in it".
