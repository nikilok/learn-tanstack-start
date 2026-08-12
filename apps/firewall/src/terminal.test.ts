// The failure that matters: control codes leaking into a non-TTY stream (a piped headless run),
// or an unbalanced restore leaving the operator's shell stranded on the app buffer.

import { describe, expect, test } from 'bun:test';

import { enterTuiScreen, leaveTuiScreen } from './terminal';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const stream = (isTTY: boolean) => {
  const writes: string[] = [];
  const out = {
    isTTY,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { writes, out };
};

const listenerCounts = () => SIGNALS.map((s) => process.listeners(s).length);

// Module-level entered flag: these tests are order-dependent and each leaves the state clean.
describe('enterTuiScreen / leaveTuiScreen', () => {
  test('a non-TTY stream never receives control codes nor signal handlers', () => {
    const { writes, out } = stream(false);
    const before = listenerCounts();
    enterTuiScreen(out);
    leaveTuiScreen(out);
    expect(writes).toEqual([]);
    expect(listenerCounts()).toEqual(before);
  });

  test('enter and leave are balanced, idempotent, and symmetric', () => {
    const { writes, out } = stream(true);
    enterTuiScreen(out);
    enterTuiScreen(out); // re-entry while entered is a no-op
    leaveTuiScreen(out);
    leaveTuiScreen(out); // the exit hook makes a second leave the normal case
    expect(writes).toEqual([
      '\x1b[?1049h\x1b[?1007h\x1b[H',
      '\x1b[?1007l\x1b[?1049l',
    ]);
    // Inner-out: the wheel mode is cleared before the buffer switch that discards it.
    expect(writes[1]?.indexOf('1007l')).toBeLessThan(
      writes[1]?.indexOf('1049l') ?? -1,
    );
  });

  test('a signal restores the screen, then re-delivers itself rather than being swallowed', () => {
    // 'exit' never fires on death by signal, so the signal handlers are the only restore path.
    const { writes, out } = stream(true);
    const raised: string[] = [];
    const before = process.listeners('SIGTERM');
    enterTuiScreen(out, (sig) => raised.push(sig));
    const added = process
      .listeners('SIGTERM')
      .filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    expect(writes).toEqual([
      '\x1b[?1049h\x1b[?1007h\x1b[H',
      '\x1b[?1007l\x1b[?1049l',
    ]);
    expect(raised).toEqual(['SIGTERM']);
    // The handler detached everything on its way out — nothing of ours is left listening.
    expect(process.listeners('SIGTERM')).toHaveLength(before.length);
  });

  test('a normal leave detaches the signal handlers with it', () => {
    const { out } = stream(true);
    const before = listenerCounts();
    enterTuiScreen(out);
    expect(listenerCounts()).toEqual(before.map((n) => n + 1));
    leaveTuiScreen(out);
    expect(listenerCounts()).toEqual(before);
  });
});
