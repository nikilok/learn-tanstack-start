import { describe, expect, test } from 'bun:test';

import { KEY, renderInk } from '../ink-harness';
import type { Choice } from './boot';
import { CassettePicker, moveCursor, rowsFor } from './cassette-picker';
import type { CassetteInfo } from './cassette-store';

const AVAILABLE: CassetteInfo[] = [
  {
    name: 'fresh-scrape',
    path: '/d/fresh-scrape.jsonl',
    bytes: 2048,
    ageDays: 0,
    writtenMs: 1000000,
  },
  {
    name: 'quiet-tuesday',
    path: '/d/quiet-tuesday.jsonl',
    bytes: 900,
    ageDays: 12,
    writtenMs: 999988,
  },
];

describe('rowsFor', () => {
  test('one row per recorded corpus, in the order given', () => {
    expect(rowsFor(AVAILABLE).map((r) => r.label)).toEqual([
      'fresh-scrape',
      'quiet-tuesday',
    ]);
  });

  // A session with nothing to replay reads identically to a working one over a quiet window, so
  // the drawer is refused before the picker is shown rather than offering a way in.
  test('offers no way to continue without one', () => {
    expect(rowsFor(AVAILABLE).every((r) => r.choice.kind === 'cassette')).toBe(
      true,
    );
    expect(rowsFor([])).toEqual([]);
  });

  test('says how big each is and how old, which is what it is judged by', () => {
    expect(rowsFor(AVAILABLE)[0].detail).toBe('2 KB · recorded today');
    expect(rowsFor(AVAILABLE)[1].detail).toBe('900 B · recorded 12 days ago');
  });
});

describe('moveCursor', () => {
  test('stops at the ends rather than wrapping', () => {
    expect(moveCursor(0, -1, 3)).toBe(0);
    expect(moveCursor(2, 1, 3)).toBe(2);
  });

  test('moves within the list', () => {
    expect(moveCursor(0, 1, 3)).toBe(1);
    expect(moveCursor(2, -1, 3)).toBe(1);
  });

  test('an empty list has nowhere to go', () => {
    expect(moveCursor(0, 1, 0)).toBe(0);
  });
});

describe('the picker', () => {
  test('lists every cassette with its size and age', async () => {
    const h = renderInk(
      <CassettePicker available={AVAILABLE} onPick={() => {}} />,
      { columns: 90, rows: 12 },
    );
    await h.settle();
    const frame = h.frame();
    expect(frame).toContain('fresh-scrape');
    expect(frame).toContain('quiet-tuesday');
    expect(frame).toContain('recorded 12 days ago');
    // The badge is on the picker too: this screen is already part of the mock session.
    expect(frame).toContain('(MOCK)');
    h.unmount();
  });

  test('enter picks the row under the cursor', async () => {
    let picked: Choice | undefined;
    const h = renderInk(
      <CassettePicker available={AVAILABLE} onPick={(c) => (picked = c)} />,
      { columns: 90, rows: 12 },
    );
    await h.settle();
    await h.press(KEY.enter);
    expect(picked).toEqual({ kind: 'cassette', info: AVAILABLE[0] });
    h.unmount();
  });

  test('the cursor moves before it picks', async () => {
    let picked: Choice | undefined;
    const h = renderInk(
      <CassettePicker available={AVAILABLE} onPick={(c) => (picked = c)} />,
      { columns: 90, rows: 12 },
    );
    await h.settle();
    await h.press(KEY.down);
    await h.press(KEY.enter);
    expect(picked).toEqual({ kind: 'cassette', info: AVAILABLE[1] });
    h.unmount();
  });

  test('j and k move it too, like every other list in this tool', async () => {
    let picked: Choice | undefined;
    const h = renderInk(
      <CassettePicker available={AVAILABLE} onPick={(c) => (picked = c)} />,
      { columns: 90, rows: 12 },
    );
    await h.settle();
    await h.press('j');
    await h.press('k');
    await h.press('j');
    await h.press(KEY.enter);
    expect(picked).toEqual({ kind: 'cassette', info: AVAILABLE[1] });
    h.unmount();
  });

  // Quitting here must not start a session. The caller exits without loading the app.
  test.each([
    ['q', 'q'],
    ['escape', KEY.escape],
  ])('%s quits without choosing', async (_label, key) => {
    let picked: Choice | undefined;
    const h = renderInk(
      <CassettePicker available={AVAILABLE} onPick={(c) => (picked = c)} />,
      { columns: 90, rows: 12 },
    );
    await h.settle();
    await h.press(key);
    expect(picked).toEqual({ kind: 'quit' });
    h.unmount();
  });
});

describe('an empty list', () => {
  // Boot refuses an empty drawer before the picker is shown, so this should be unreachable — but
  // a crash on enter is a worse way to find out that it was not.
  test('enter does nothing rather than throwing', async () => {
    let picked: Choice | undefined;
    const h = renderInk(
      <CassettePicker available={[]} onPick={(c) => (picked = c)} />,
      { columns: 60, rows: 8 },
    );
    await h.settle();
    await h.press(KEY.enter);
    expect(picked).toBeUndefined();
    h.unmount();
  });
});

describe('the drawer label', () => {
  // Recording and replaying can resolve to different drawers, and a split is otherwise invisible.
  test('shows which drawer the list came from', async () => {
    const h = renderInk(
      <CassettePicker
        available={AVAILABLE}
        drawer="/somewhere/ops/firewall-cassettes"
        onPick={() => {}}
      />,
      { columns: 90, rows: 12 },
    );
    await h.settle();
    expect(h.frame()).toContain('/somewhere/ops/firewall-cassettes');
    h.unmount();
  });

  test('is omitted when there is nothing to say', async () => {
    const h = renderInk(
      <CassettePicker available={AVAILABLE} onPick={() => {}} />,
      { columns: 90, rows: 12 },
    );
    await h.settle();
    expect(h.frame()).not.toContain('firewall-cassettes');
    h.unmount();
  });
});
