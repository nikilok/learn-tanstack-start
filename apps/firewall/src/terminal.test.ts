// The failure that matters: control codes leaking into a non-TTY stream (a piped headless run),
// or an unbalanced restore leaving the operator's shell stranded on the app buffer.

import { describe, expect, test } from 'bun:test';

import { enterTuiScreen, leaveTuiScreen } from './terminal';

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

// Module-level entered flag: these tests are order-dependent and each leaves the state clean.
describe('enterTuiScreen / leaveTuiScreen', () => {
  test('a non-TTY stream never receives control codes', () => {
    const { writes, out } = stream(false);
    enterTuiScreen(out);
    leaveTuiScreen(out);
    expect(writes).toEqual([]);
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
});
