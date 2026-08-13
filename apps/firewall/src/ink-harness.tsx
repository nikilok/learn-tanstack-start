// Driving an Ink component from a test, on Ink 7's own render(). No library: ink-testing-library
// emits 'data' and Ink 7 reads 'readable', so under it every keypress is silently dropped.

import { PassThrough } from 'node:stream';

import { render } from 'ink';
import type { ReactElement } from 'react';

// Outlasts Ink's 20ms hold on a lone ESC, or a bare escape never arrives.
const FLUSH_MS = 25;

// Captured once, before any harness has patched it. Restoring the value that was current when a
// given harness started would hand back another harness's patch if two overlap, or if one is
// abandoned by a failing assertion before it reaches unmount.
const REAL_TERMINAL = {
  columns: process.stdout.columns,
  rows: process.stdout.rows,
};

// Matching the ESC byte is the whole job here — assertions read frames as plain text.
// eslint-disable-next-line no-control-regex
const ANSI =
  /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B/g;

/** Put the real terminal size back. The preload calls this after every test, so a harness abandoned by a failing assertion cannot leave the next one measuring a patched width. */
export function restoreTerminal(): void {
  Object.assign(process.stdout, REAL_TERMINAL);
}

/** Escape sequences for the keys the TUI binds, so a test presses `KEY.down` rather than a literal. */
export const KEY = {
  up: '\u001B[A',
  down: '\u001B[B',
  left: '\u001B[D',
  right: '\u001B[C',
  pageUp: '\u001B[5~',
  pageDown: '\u001B[6~',
  enter: '\r',
  escape: '\u001B',
  tab: '\t',
  shiftTab: '\u001B[Z',
  backspace: '\u007F',
} as const;

export type Harness = {
  /** The latest frame, ANSI stripped. */
  frame: () => string;
  /** Every frame rendered so far, ANSI stripped. */
  frames: () => string[];
  /** Send `sequence` and wait for the frame it produces. */
  press: (sequence: string) => Promise<void>;
  /** Wait for a frame without sending a key — for state an effect or a resolved promise sets. */
  settle: () => Promise<void>;
  rerender: (node: ReactElement) => Promise<void>;
  unmount: () => void;
};

/** Mount `node` on a fake terminal. `columns`/`rows` also patch process.stdout, which the layout reads directly, and are restored on unmount. */
export function renderInk(
  node: ReactElement,
  opts: { columns?: number; rows?: number } = {},
): Harness {
  const columns = opts.columns ?? 120;
  const rows = opts.rows ?? 40;
  const written: string[] = [];
  const stdout = {
    write: (frame: string) => {
      written.push(frame);
      return true;
    },
    columns,
    rows,
    isTTY: true,
    on() {},
    off() {},
    removeListener() {},
  } as unknown as NodeJS.WriteStream;

  const input = new PassThrough();
  const stdin = Object.assign(input, {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  }) as unknown as NodeJS.ReadStream;

  Object.assign(process.stdout, { columns, rows });

  const app = render(node, {
    stdout,
    stdin,
    // Each frame kept whole rather than diffed over the last one, so `frames()` is a history.
    debug: true,
    interactive: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  const settle = async () => {
    await new Promise((r) => setTimeout(r, FLUSH_MS));
    await app.waitUntilRenderFlush();
  };

  // Non-breaking spaces are a layout device — FooterHints uses them so a hint never wraps
  // mid-hint — so `toContain('watch it')` would otherwise fail against a frame that reads exactly
  // that. What they do to wrapping is covered by hintRows' own tests.
  const readable = (f: string) => f.replace(ANSI, '').replaceAll('\u00A0', ' ');

  return {
    frame: () => readable(written.at(-1) ?? ''),
    frames: () => written.map(readable),
    press: async (sequence: string) => {
      input.write(sequence);
      await settle();
    },
    settle,
    rerender: async (next: ReactElement) => {
      app.rerender(next);
      await settle();
    },
    unmount: () => {
      app.unmount();
      restoreTerminal();
    },
  };
}
