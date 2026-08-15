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
    const message = refusal(await chooseCassette([], 'august', never));
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
    const message = refusal(await chooseCassette([], undefined, never));
    expect(message).toContain('No cassettes recorded yet');
    expect(message).toContain('bun run firewall:record --cassette <name>');
  });

  test('the picker is never shown an empty list', async () => {
    // `never` throws if reached; reaching it is the failure.
    await chooseCassette([], undefined, never);
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

describe('a cassette that recorded nothing', () => {
  // A recording session that failed to boot leaves an empty cassette behind, and it would then
  // sit in the picker looking like a valid choice.
  test('is listed but refused, with the command to re-record', async () => {
    const { bootMock } = await import('./boot');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fw-empty-'));
    const before = process.env.FW_CASSETTES_DIR;
    process.env.FW_CASSETTES_DIR = dir;
    try {
      writeFileSync(join(dir, 'blank.jsonl'), '{"cassette":1}\n');
      const result = await bootMock({ named: 'blank' });
      expect(result.kind).toBe('refused');
      expect((result as { message: string }).message).toContain(
        'no recordings',
      );
    } finally {
      if (before === undefined) delete process.env.FW_CASSETTES_DIR;
      else process.env.FW_CASSETTES_DIR = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
