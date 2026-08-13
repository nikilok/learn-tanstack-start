// Moving an identity writes the ADD file before the DROP file, so a failure between the two
// leaves disk changed and the panes describing the state before it.

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Text } from 'ink';
import { useEffect } from 'react';

import { renderInk } from './ink-harness';
import { type IdentityLists, useIdentityLists } from './use-lists';
import { IGNORELIST_FILE, WATCHLIST_FILE } from './watchlist';

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

    const real = await import('./watchlist');
    mock.module('./watchlist', () => ({
      ...real,
      recordExclusive: async () => ({
        error: `half-moved — written to ${WATCHLIST_FILE} but ${IGNORELIST_FILE} still lists it: EACCES`,
      }),
    }));
    const fresh = await import('./use-lists');
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
