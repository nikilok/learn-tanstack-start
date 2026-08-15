// Asserted by MARKER, never by counting `../` segments: a depth check would have to be edited by
// the same move that breaks the path, so it could never catch one.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { REPO_ROOT, ROOT_MARKERS } from './repo-root';

describe('REPO_ROOT', () => {
  test.each([...ROOT_MARKERS])('contains %s', (marker: string) => {
    expect(existsSync(join(REPO_ROOT, marker))).toBe(true);
  });

  test('is not apps/, which is where the last bad move landed', () => {
    expect(basename(REPO_ROOT)).not.toBe('apps');
  });

  test('is not the firewall package', () => {
    expect(existsSync(join(REPO_ROOT, 'src', 'app.tsx'))).toBe(false);
  });
});
