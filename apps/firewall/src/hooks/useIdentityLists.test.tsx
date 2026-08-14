// Moving an identity writes the ADD file before the DROP file, so a failure between the two
// leaves disk changed and the panes describing the state before it.

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Text } from 'ink';
import { useEffect } from 'react';

import { renderInk } from '../ink-harness';
import { IGNORELIST_FILE, WATCHLIST_FILE } from '../watchlist';
import { type IdentityLists, useIdentityLists } from './useIdentityLists';

const DIGEST = 't13d1516h2_8daaf6152771_b0da82dd1658';

/** One on-disk list line. The note is what each assertion below reads back. */
const line = (note: string) =>
  `ja4|${DIGEST}|2026-08-13T10:00:00.000Z|2026-08-13T10:00:00.000Z|1|manual|${note}\n`;

/** Renders both lists by note, and hands the hook back so the test can drive it. */
function Probe({
  root,
  hook,
  onReady,
}: {
  root: string;
  hook: typeof useIdentityLists;
  onReady: (l: IdentityLists) => void;
}) {
  const lists = hook(root);
  useEffect(() => {
    onReady(lists);
  });
  return (
    <Text>
      watch={lists.watch.entries.map((e) => e.note).join(',') || '-'} ignore=
      {lists.ignore.entries.map((e) => e.note).join(',') || '-'}
    </Text>
  );
}

/** Mount against `root`, optionally with a hook from a freshly-imported module so a mock applies. */
async function mountLists(root: string, hook = useIdentityLists) {
  let lists!: IdentityLists;
  const h = renderInk(
    <Probe root={root} hook={hook} onReady={(l) => (lists = l)} />,
  );
  await h.settle();
  return { h, get: () => lists };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'fw-lists-'));

afterEach(() => {
  mock.restore();
});

describe('useIdentityLists.removeAtCursor', () => {
  // The pane drops the row optimistically. If the save then fails, the file still holds what the
  // pane just removed — so it re-reads rather than leaving the two disagreeing.
  //
  // The failure is a real one: a read-only directory, not a mocked saveList. mock.module does not
  // reliably revert for modules already instantiated, and a leaked mock broke the next test.
  test.skipIf(process.getuid?.() === 0)(
    'a failed save re-reads the pane from disk and reports it',
    async () => {
      const root = tmp();
      writeFileSync(join(root, WATCHLIST_FILE), line('on-disk'));
      const { h, get } = await mountLists(root);
      await get().load('watch');
      await h.settle();
      expect(h.frame()).toContain('watch=on-disk');

      chmodSync(root, 0o500); // readable and traversable, not writable
      try {
        const msg = await get().removeAtCursor('watch');
        await h.settle();
        expect(msg).toBeTruthy();
        expect(msg).toContain('watch list');
        // Restored, not left showing the row it optimistically dropped.
        expect(h.frame()).toContain('watch=on-disk');
      } finally {
        chmodSync(root, 0o700);
        h.unmount();
      }
    },
  );
});

describe('useIdentityLists, unreadable list', () => {
  // "Unreadable is not empty" holds on the WRITE path too: saving the in-memory list over a file
  // we could not read is how a hand edit gets destroyed.
  test('a removal aborts rather than saving over a file it could not read', async () => {
    const root = tmp();
    writeFileSync(join(root, WATCHLIST_FILE), line('on-disk'));
    const { h, get } = await mountLists(root);
    await get().load('watch');
    await h.settle();

    // Malformed: parseWatchlist refuses the whole file, so the late read reports not-ok.
    writeFileSync(join(root, WATCHLIST_FILE), 'not|a|valid|line\n');
    const msg = await get().removeAtCursor('watch');
    await h.settle();

    expect(msg).toContain('nothing removed');
    // The file is untouched — the removal did not overwrite what it could not parse.
    expect(readFileSync(join(root, WATCHLIST_FILE), 'utf8')).toContain(
      'not|a|valid|line',
    );
    h.unmount();
  });
});

describe('useIdentityLists, loading and cursors', () => {
  test('a list is read from disk into the pane', async () => {
    const root = tmp();
    writeFileSync(join(root, WATCHLIST_FILE), line('from-disk'));
    const { h, get } = await mountLists(root);
    await get().load('watch');
    await h.settle();
    expect(h.frame()).toContain('watch=from-disk');
    h.unmount();
  });

  test('a missing file is an empty list, not an error', async () => {
    const { h, get } = await mountLists(tmp());
    await get().load('watch');
    await h.settle();
    expect(h.frame()).toContain('watch=-');
    expect(get().watch.error).toBe('');
    h.unmount();
  });

  // Unreadable and empty are different answers, and the pane must not show one as the other.
  test('an unreadable list reports why rather than reading as empty', async () => {
    const root = tmp();
    writeFileSync(join(root, WATCHLIST_FILE), 'not|a|valid|line\n');
    const { h, get } = await mountLists(root);
    await get().load('watch');
    await h.settle();
    expect(get().watch.error).toBeTruthy();
    h.unmount();
  });

  test('the cursor moves within the list and never leaves it', async () => {
    const root = tmp();
    writeFileSync(
      join(root, WATCHLIST_FILE),
      line('one') + line('two').replace(DIGEST, `${DIGEST.slice(0, -1)}9`),
    );
    const { h, get } = await mountLists(root);
    await get().load('watch');
    await h.settle();
    get().moveCursor('watch', 1);
    await h.settle();
    expect(get().watch.cursor).toBe(1);
    get().moveCursor('watch', 1);
    await h.settle();
    expect(get().watch.cursor).toBe(1);
    get().moveCursor('watch', -1);
    get().moveCursor('watch', -1);
    await h.settle();
    expect(get().watch.cursor).toBe(0);
    h.unmount();
  });

  test('an empty list parks the cursor at 0, never at -1', async () => {
    const { h, get } = await mountLists(tmp());
    get().moveCursor('watch', 1);
    await h.settle();
    expect(get().watch.cursor).toBe(0);
    expect(get().watch.current).toBeUndefined();
    h.unmount();
  });

  // The watch tick feeds the pane as it screens, so a list open on screen stays current.
  test('replaceWatch swaps the entries and clears the error', async () => {
    const { h, get } = await mountLists(tmp());
    get().replaceWatch([
      {
        kind: 'ja4',
        id: DIGEST,
        addedAt: '2026-08-14T06:00:00.000Z',
        lastSeen: '2026-08-14T06:00:00.000Z',
        seen: 1,
        source: 'watch',
        note: 'from-the-tick',
      },
    ]);
    await h.settle();
    expect(h.frame()).toContain('watch=from-the-tick');
    expect(get().watch.error).toBe('');
    h.unmount();
  });
});

describe('useIdentityLists.removeAtCursor, confirmed path', () => {
  // The confirm lives in the container; what this asserts is that the removal it triggers still
  // does the right thing, and that nothing is dropped when there is no row under the cursor.
  test('removing the row under the cursor takes it off disk', async () => {
    const root = tmp();
    writeFileSync(join(root, WATCHLIST_FILE), line('doomed'));
    const { h, get } = await mountLists(root);
    await get().load('watch');
    await h.settle();

    expect(await get().removeAtCursor('watch')).toBeUndefined();
    await h.settle();
    expect(h.frame()).toContain('watch=-');
    expect(readFileSync(join(root, WATCHLIST_FILE), 'utf8').trim()).toBe('');
    h.unmount();
  });

  test('an empty list removes nothing and reports nothing', async () => {
    const { h, get } = await mountLists(tmp());
    expect(await get().removeAtCursor('watch')).toBeUndefined();
    await h.settle();
    h.unmount();
  });
});

describe('useIdentityLists.move', () => {
  test('a successful move puts the identity on one list and off the other', async () => {
    const root = tmp();
    writeFileSync(join(root, IGNORELIST_FILE), line('was-ignored'));
    const { h, get } = await mountLists(root);
    await get().load('ignore');
    await h.settle();

    const note = await get().move(
      'watch',
      { kind: 'ja4', value: DIGEST },
      'moved',
    );
    await h.settle();
    expect(note).toContain('watching');
    expect(h.frame()).toContain('watch=moved');
    expect(h.frame()).toContain('ignore=-');
    h.unmount();
  });

  // The half-move: recordExclusive has already written the ADD file when the DROP save fails, so
  // returning early left the panes showing the pre-move state over changed files.
  test('a half-move re-reads both lists rather than leaving the panes stale', async () => {
    const root = tmp();
    // What disk holds AFTER the half-move: added to watch, and still on ignore.
    writeFileSync(join(root, WATCHLIST_FILE), line('on-disk-watch'));
    writeFileSync(join(root, IGNORELIST_FILE), line('still-on-ignore'));

    const real = await import('../watchlist');
    mock.module('../watchlist', () => ({
      ...real,
      recordExclusive: async () => ({
        error: `half-moved — written to ${WATCHLIST_FILE} but ${IGNORELIST_FILE} still lists it: EACCES`,
      }),
    }));
    const fresh = await import('./useIdentityLists');
    const { h, get } = await mountLists(root, fresh.useIdentityLists);

    const msg = await get().move(
      'watch',
      { kind: 'ja4', value: DIGEST },
      'attempted',
    );
    await h.settle();

    expect(msg).toContain('half-moved');
    // Both panes now describe the files rather than the attempt.
    expect(h.frame()).toContain('watch=on-disk-watch');
    expect(h.frame()).toContain('ignore=still-on-ignore');
    h.unmount();
  });
});
