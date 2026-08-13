// ENV_PATH is a relative walk up from the module's own location, so it breaks silently whenever
// the file moves — and it did, when useDenylist.ts moved into hooks/. A deny then persisted to
// apps/.env.local while the rules kept being rebuilt from the untouched root file, which lifts
// the ban on the next apply and reports success.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ENV_PATH } from './hooks/useDenylist';

describe('ENV_PATH', () => {
  test('names .env.local', () => {
    expect(ENV_PATH.endsWith('/.env.local')).toBe(true);
  });

  // Asserted by MARKER, not by counting `../` segments: a depth check would have to be edited by
  // the same move that breaks the path, so it would never catch one.
  test('resolves to the repo root — the file the rules are rebuilt from', () => {
    const dir = dirname(ENV_PATH);
    expect(existsSync(join(dir, 'turbo.json'))).toBe(true);
    expect(existsSync(join(dir, 'bun.lock'))).toBe(true);
  });

  test('is NOT inside apps/, which is where the last move put it', () => {
    expect(dirname(ENV_PATH).endsWith('/apps')).toBe(false);
    expect(ENV_PATH).not.toContain('/apps/');
  });
});
