// Moving an identity between the watch and ignore lists. The two sides are exclusive, so every
// decision here is about which side a result belongs to — and swapping them is silent.

import { describe, expect, test } from 'bun:test';

import {
  IGNORELIST_FILE,
  WATCHLIST_FILE,
  type WatchlistEntry,
  afterMove,
  clampCursor,
  filesFor,
  loadError,
  moveNote,
} from './watchlist';

const entry = (id: string): WatchlistEntry => ({
  kind: 'ja4',
  id,
  addedAt: '2026-08-13T10:00:00.000Z',
  lastSeen: '2026-08-13T10:00:00.000Z',
  seen: 1,
  source: 'manual',
  note: '',
});

describe('filesFor', () => {
  test('watching adds to the watch list and drops from the ignore list', () => {
    expect(filesFor('watch')).toEqual({
      add: WATCHLIST_FILE,
      drop: IGNORELIST_FILE,
    });
  });

  test('ignoring is the exact mirror', () => {
    expect(filesFor('ignore')).toEqual({
      add: IGNORELIST_FILE,
      drop: WATCHLIST_FILE,
    });
  });

  test('the two sides never share a file, or a move would delete what it just wrote', () => {
    for (const side of ['watch', 'ignore'] as const) {
      const { add, drop } = filesFor(side);
      expect(add).not.toBe(drop);
    }
  });
});

describe('loadError', () => {
  test('a clean read reports no error', () => {
    expect(loadError({ ok: true, entries: [] })).toBe('');
  });

  // An unreadable list rendered as empty says "nothing is being watched" about a file nobody
  // could read, which is the reverse of what the operator needs to know.
  test('an unreadable list carries its reason', () => {
    expect(loadError({ ok: false, entries: [], error: 'EACCES' })).toBe(
      'EACCES',
    );
  });

  test('a failure with no reason still reads as unreadable, never as empty', () => {
    expect(loadError({ ok: false, entries: [] })).toBe('unreadable');
    // An EMPTY string is a reason too — and `?? 'unreadable'` passed it straight through, so the
    // pane showed a failed read as no failure at all.
    expect(loadError({ ok: false, entries: [], error: '' })).toBe('unreadable');
  });
});

describe('clampCursor', () => {
  test('a cursor inside the list stays put', () => {
    expect(clampCursor(2, 5)).toBe(2);
  });

  test('a cursor past the end lands on the new last row', () => {
    expect(clampCursor(7, 3)).toBe(2);
  });

  test('an emptied list parks the cursor at 0, never at -1', () => {
    // -1 indexes nothing, so the next keypress reads undefined and the pane goes silent.
    expect(clampCursor(4, 0)).toBe(0);
    expect(clampCursor(0, 0)).toBe(0);
  });

  test('moving up from the first row does not go negative', () => {
    expect(clampCursor(-1, 5)).toBe(0);
  });
});

describe('afterMove', () => {
  const added = [entry('a')];
  const remaining = [entry('b')];

  // Swapping these writes the ignore list into the watch pane and vice versa — both panes then
  // show the other's contents, and the operator acts on the wrong list.
  test('moving TO watch puts the destination in watch and the source in ignore', () => {
    expect(afterMove('watch', added, remaining)).toEqual({
      watch: added,
      ignore: remaining,
    });
  });

  test('moving TO ignore is the mirror', () => {
    expect(afterMove('ignore', added, remaining)).toEqual({
      watch: remaining,
      ignore: added,
    });
  });

  test('the destination never ends up on both sides', () => {
    const out = afterMove('watch', added, remaining);
    expect(out.ignore).not.toContain(added[0]);
  });
});

describe('moveNote', () => {
  test('watching names the key that shows the watch list', () => {
    expect(moveNote('watch', '1.2.3.4')).toContain('t to view');
  });

  test('ignoring names its own key, and that screening now skips it', () => {
    const note = moveNote('ignore', '1.2.3.4');
    expect(note).toContain('g to view');
    expect(note).toContain('skips it');
  });

  test('both name the identity, so the note cannot describe the wrong one', () => {
    for (const side of ['watch', 'ignore'] as const)
      expect(moveNote(side, '1.2.3.4')).toContain('1.2.3.4');
  });
});
