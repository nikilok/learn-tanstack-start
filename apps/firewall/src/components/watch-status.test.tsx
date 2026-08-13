// The panel an operator glances at while doing something else, so what it must never do is look
// the same whether the loop is working, idle, or reporting a conclusion nobody has read.

import { describe, expect, test } from 'bun:test';

import type { Watch } from '../hooks/useWatch';
import { renderInk } from '../ink-harness';
import { WatchStatus } from './watch-status';

const ARMED: Watch = {
  on: true,
  toggle: () => {},
  busy: false,
  at: '23:29',
  keepingAwake: true,
  note: '33 fingerprint(s) allowed through · 0 profiled · 0 would ban',
  who: [],
  invokedAt: '',
  invokedCount: 0,
  notifiedAt: '',
  verdictHead: '',
  verdictClipped: 0,
  verdictOf: '',
};

/** Render a panel and hand back its frame. */
async function frameOf(over: Partial<Watch> = {}) {
  const h = renderInk(<WatchStatus watch={{ ...ARMED, ...over }} />, {
    columns: 80,
  });
  await h.settle();
  const frame = h.frame();
  h.unmount();
  return frame;
}

describe('WatchStatus', () => {
  test('a disarmed loop renders nothing at all', async () => {
    expect((await frameOf({ on: false })).trim()).toBe('');
  });

  test('an armed loop reports its timing, last tick and what it screened', async () => {
    const frame = await frameOf();
    expect(frame).toContain('watch');
    expect(frame).toContain('23:29');
    expect(frame).toContain('33 fingerprint(s) allowed through');
  });

  // Boxed so it reads as its own panel rather than as more footer.
  test('it is drawn inside a border', async () => {
    const frame = await frameOf();
    expect(frame).toMatch(/[╭╰]/);
    expect(frame).toMatch(/[─│]/);
  });

  test('a tick that has not run yet says starting, not a stale time', async () => {
    expect(await frameOf({ at: '' })).toContain('starting');
  });

  test('holding the machine awake is stated, because it is a thing being done to the mac', async () => {
    expect(await frameOf()).toContain('holding the mac awake');
    expect(await frameOf({ keepingAwake: false })).not.toContain(
      'holding the mac awake',
    );
  });

  // Named, or "1 profiled" sends the operator digging through the log.
  test('it names every identity the last tick profiled', async () => {
    const frame = await frameOf({
      who: ['t13d1516h2… · 900 req · ban', 't13d1517h2… · 400 req · watch'],
    });
    expect(frame).toContain('900 req');
    expect(frame).toContain('400 req');
  });

  test('an invocation stays on screen once it has happened', async () => {
    // The loop runs while you are in another pane, so one you did not watch must still be visible.
    const frame = await frameOf({ invokedCount: 2, invokedAt: '23:31' });
    expect(frame).toContain('claude invoked');
    expect(frame).toContain('2×');
    expect(frame).toContain('23:31');
  });

  test('with no invocation it says where the log is instead', async () => {
    const frame = await frameOf();
    expect(frame).toContain('logging to');
    expect(frame).not.toContain('claude invoked');
  });

  test('a verdict is shown under the identity it belongs to', async () => {
    // Without the identity the pane renders the PREVIOUS conclusion under a generic heading while
    // a new investigation runs, and an operator acting on it acts on the wrong fingerprint.
    const frame = await frameOf({
      verdictHead: 'VERDICT: challenge\nshared digest, zero rendering',
      verdictOf: 't13d1516h2_8daaf6152771_b0da82dd1658',
    });
    expect(frame).toContain('investigation');
    expect(frame).toContain('t13d1516h2_8daaf6152771_b0da82dd1658');
    expect(frame).toContain('VERDICT: challenge');
  });

  test('a clipped verdict says how much is missing and where the rest is', async () => {
    // A clipped verdict that does not say so reads as complete, which is worse than none.
    const frame = await frameOf({
      verdictHead: 'VERDICT: ban',
      verdictClipped: 7,
      verdictOf: 'abc',
    });
    expect(frame).toContain('7 more line(s)');
    expect(frame).toContain('firewall-watch.log');
  });
});
