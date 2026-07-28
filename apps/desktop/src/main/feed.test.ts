import { describe, expect, test } from 'bun:test';

import { APP_VERSION_HEADER } from './feed';

describe('update feed contract', () => {
  // The web side reads this exact header in apps/web/server/routes/downloads/
  // [...path].get.ts and asserts the same literal in updaterLog.test.ts. The two
  // workspaces never import each other, so renaming one copy fails nothing at
  // build time — it just silently drops `from=` from every updater log line,
  // and is only fixable by shipping another desktop release.
  test('the app-version header matches the name the web side reads', () => {
    expect(APP_VERSION_HEADER).toBe('x-app-version');
  });
});
