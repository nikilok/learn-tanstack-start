// Preloaded before any test module is evaluated (see the `test` script).
//
// `rules.ts` reads its ceilings and deny lists from the environment AT IMPORT TIME and throws when
// they are missing, so a test file that pulls in that graph either works or poisons the module for
// every file after it, depending on which ran first. Setting these in a beforeAll is too late —
// the import has already happened.

/** The digest the rule set is seeded with, so a test asserting on a live deny names this one. */
export const TEST_DENIED_JA4 = 't13d1516h2_8daaf6152771_b0da82dd1658';

// Dry-run: placeholder ceilings, and the deny lists become optional rather than required.
process.env.DRY_RUN ??= '1';
process.env.FW_BLOCKED_JA4 ??= TEST_DENIED_JA4;
process.env.FW_CHALLENGE_JA4 ??= '';
process.env.FW_BLOCKED_ASN ??= '';
// Never used to reach Vercel — every test stubs the client — but resolveVercelCredentials throws
// without them, and it runs at import time too.
process.env.VERCEL_TOKEN ??= 'test-token';
process.env.VERCEL_PROJECT_ID ??= 'prj_test';
process.env.VERCEL_TEAM_ID ??= 'team_test';

// Evaluated here, with the values above in place, so the rule set is the same whichever test file
// happens to pull it in first. `watch.ts` imports it dynamically from inside a try/catch, and a
// test that clears the environment around that call would otherwise fix a different rule set —
// or none at all — for every file that runs after it.
await import('./rules');
