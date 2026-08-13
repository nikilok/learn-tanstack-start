// The pane's async state machine. Its failure mode is a spinner that never clears — the pane
// shows "loading…" with no data and no error, and nothing on screen says anything is wrong.

import { describe, expect, test } from 'bun:test';

import { Text } from 'ink';
import { useEffect } from 'react';

import { renderInk } from './ink-harness';
import { type Pane, usePane } from './use-pane';

/** Renders a pane's state as one line, and hands the pane back to the test to drive. */
function Probe({ onReady }: { onReady: (p: Pane<string>) => void }) {
  const pane = usePane<string>();
  useEffect(() => {
    onReady(pane);
  });
  return (
    <Text>
      loading={String(pane.loading)} data={pane.data ?? '-'} error=
      {pane.error || '-'}
    </Text>
  );
}

/** Mount a pane and expose it, with a settle between each interaction. */
async function mountPane() {
  let pane!: Pane<string>;
  const h = renderInk(<Probe onReady={(p) => (pane = p)} />);
  await h.settle();
  return { h, get: () => pane };
}

/** A promise the test resolves or rejects by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('usePane', () => {
  test('a load shows the spinner and then the data', async () => {
    const { h, get } = await mountPane();
    const d = deferred<string>();
    void get().load(() => d.promise);
    await h.settle();
    expect(h.frame()).toContain('loading=true');

    d.resolve('rows');
    await h.settle();
    expect(h.frame()).toContain('loading=false');
    expect(h.frame()).toContain('data=rows');
    h.unmount();
  });

  test('a failed load clears the spinner and reports the error', async () => {
    // Not clearing here is what leaves a 504 looking like an endless load.
    const { h, get } = await mountPane();
    const d = deferred<string>();
    void get().load(() => d.promise);
    await h.settle();

    d.reject(new Error('metrics 504: Query timed out'));
    await h.settle();
    expect(h.frame()).toContain('loading=false');
    expect(h.frame()).toContain('error=metrics 504: Query timed out');
    h.unmount();
  });

  // The bug this test exists for: a load superseded by reset() with no successor used to leave
  // `loading` true forever, because the spinner was keyed on the generation. The pane then showed
  // no data, no error and a permanent spinner — recoverable only by another completed load.
  test('a load superseded by reset() still clears the spinner', async () => {
    const { h, get } = await mountPane();
    const d = deferred<string>();
    const outcome = get().load(() => d.promise);
    await h.settle();
    expect(h.frame()).toContain('loading=true');

    get().reset(); // e.g. the window changed under it
    await h.settle();

    d.resolve('stale rows');
    expect(await outcome).toBe('skipped');
    await h.settle();

    expect(h.frame()).toContain('loading=false');
    // Dropped, not rendered: it belongs to a window no longer on screen.
    expect(h.frame()).toContain('data=-');
    h.unmount();
  });

  test('a superseded load that REJECTS also clears the spinner', async () => {
    const { h, get } = await mountPane();
    const d = deferred<string>();
    const outcome = get().load(() => d.promise);
    await h.settle();

    get().reset();
    await h.settle();
    d.reject(new Error('metrics 504'));
    expect(await outcome).toBe('skipped');
    await h.settle();

    expect(h.frame()).toContain('loading=false');
    // A superseded failure is not the current window's failure either.
    expect(h.frame()).toContain('error=-');
    h.unmount();
  });

  test('a successor still owns the spinner, so it does not flicker off mid-load', async () => {
    // This is what the condition is actually for, and it must survive the fix.
    const { h, get } = await mountPane();
    const first = deferred<string>();
    void get().load(() => first.promise);
    await h.settle();

    get().reset();
    first.resolve('stale');
    await h.settle();

    const second = deferred<string>();
    void get().load(() => second.promise);
    await h.settle();
    expect(h.frame()).toContain('loading=true');

    second.resolve('fresh');
    await h.settle();
    expect(h.frame()).toContain('data=fresh');
    expect(h.frame()).toContain('loading=false');
    h.unmount();
  });

  test('a concurrent load is skipped rather than clobbering the one in flight', async () => {
    const { h, get } = await mountPane();
    const d = deferred<string>();
    void get().load(() => d.promise);
    await h.settle();

    expect(await get().load(async () => 'second')).toBe('skipped');
    d.resolve('first');
    await h.settle();
    expect(h.frame()).toContain('data=first');
    h.unmount();
  });

  test('reset drops the data so the next load actually refetches', async () => {
    const { h, get } = await mountPane();
    const d = deferred<string>();
    void get().load(() => d.promise);
    d.resolve('rows');
    await h.settle();
    expect(h.frame()).toContain('data=rows');

    get().reset();
    await h.settle();
    expect(h.frame()).toContain('data=-');
    h.unmount();
  });
});
