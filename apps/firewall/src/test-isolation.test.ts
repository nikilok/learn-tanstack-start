// The suite must never be able to reach the operator's live state.
//
// It could, and it did: a pane test seeded a row into the real .firewall-watchlist at the repo
// root and unlinked it afterwards, deleting the running TUI's watch list. The damage was silent —
// the next screen re-added one identity as though it were new, so it read as the app losing
// entries rather than as the tests destroying them.
//
// These assert the isolation itself rather than any behaviour, so removing it fails here instead
// of in someone's live list.

import { describe, expect, test } from 'bun:test';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { IGNORELIST_FILE, WATCHLIST_FILE } from './watchlist';

describe('test isolation', () => {
  test('the cwd is a throwaway directory, not the repo', () => {
    const cwd = process.cwd();
    // By MARKER, not by counting path segments: the repo root is wherever these sit.
    expect(existsSync(join(cwd, 'turbo.json'))).toBe(false);
    expect(existsSync(join(cwd, 'bun.lock'))).toBe(false);
    // realpath both: on macOS /var is a symlink to /private/var, so cwd comes back resolved
    // while tmpdir() does not, and a raw prefix check fails on a correctly isolated run.
    expect(realpathSync(cwd).startsWith(realpathSync(tmpdir()))).toBe(true);
  });

  // Every path the app builds for its state files goes through cwd, so this is what stops a test
  // reaching the real ones however it assembles the path.
  test('the list files resolved from cwd are not the operator list files', () => {
    for (const file of [WATCHLIST_FILE, IGNORELIST_FILE]) {
      const underTest = resolve(join(process.cwd(), file));
      expect(underTest).not.toBe(
        resolve(join(import.meta.dir, '../../..', file)),
      );
    }
  });
});
