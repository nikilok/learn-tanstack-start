// Preloaded before any test module is evaluated (see the `test` script).
//
// `rules.ts` reads its ceilings and deny lists from the environment AT IMPORT TIME and throws when
// they are missing, so a test file that pulls in that graph either works or poisons the module for
// every file after it, depending on which ran first. Setting these in a beforeAll is too late —
// the import has already happened.

import { afterAll, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { restoreTerminal } from './ink-harness';

// The app resolves its state files from process.cwd(), and the suite runs from the repo root —
// where the OPERATOR's live .firewall-watchlist and .firewall-ignorelist sit. A pane test seeded
// a row at that path and unlinked it afterwards, which DELETED the real watch list out from under
// a running TUI: entries vanished, and the next screen re-added one as though it were new.
// Every test process gets a throwaway cwd, so no test can reach those files however it builds the
// path. Done first, before anything imports a module that captures cwd at evaluation time.
const realCwd = process.cwd();
const testCwd = mkdtempSync(join(tmpdir(), 'fw-test-cwd-'));
process.chdir(testCwd);
// Restored and removed at the end, or every run leaves a directory behind for ever.
afterAll(() => {
  process.chdir(realCwd);
  rmSync(testCwd, { recursive: true, force: true });
});

/** The digest the rule set is seeded with, so a test asserting on a live deny names this one. */
export const TEST_DENIED_JA4 = 't13d1516h2_8daaf6152771_b0da82dd1658';

// Assigned outright, not with ??=. These ARE the fixture the assertions are written against, so
// a developer with FW_BLOCKED_JA4 exported in their shell would otherwise change what the tests
// see — the determinism this file exists for.
// Dry-run: placeholder ceilings, and the deny lists become optional rather than required.
process.env.DRY_RUN = '1';
process.env.FW_BLOCKED_JA4 = TEST_DENIED_JA4;
process.env.FW_CHALLENGE_JA4 = '';
process.env.FW_BLOCKED_ASN = '';
// Never used to reach Vercel — every test stubs the client — but resolveVercelCredentials throws
// without them, and it runs at import time too.
// Assigned outright, like the FW_* values above. Every test stubs the client, so a real
// credential is never needed — and inheriting one is how a suite reaches production by accident.
process.env.VERCEL_TOKEN = 'test-token';
process.env.VERCEL_PROJECT_ID = 'prj_test';
process.env.VERCEL_TEAM_ID = 'team_test';

// Registered from the preload so it covers EVERY test file: renderInk patches process.stdout, and
// a test that fails before reaching unmount would otherwise leave the next one measuring its width.
afterEach(restoreTerminal);

// Evaluated here, with the values above in place, so the rule set is the same whichever test file
// happens to pull it in first. `watch.ts` imports it dynamically from inside a try/catch, and a
// test that clears the environment around that call would otherwise fix a different rule set —
// or none at all — for every file that runs after it.
await import('./rules');

// `client.ts` is the same hazard: it resolves credentials and constructs its SDK client at import
// time. Evaluated here, while the fixture credentials are in place, so its ONE evaluation always
// succeeds. A test that triggered the first import with the environment cleared would poison the
// module for the rest of the process — since Bun 1.4 even `mock.module` rethrows a failed
// evaluation instead of shielding it. Tests that need the module to FAIL mock its calls instead.
await import('./client');
