// The preload is what makes this package's tests deterministic — see the header of test-setup.ts.
// It is itself untested infrastructure otherwise, and both ways it can fail are silent: a value
// inherited from the developer's shell, or a rule set built before the values were in place.

import { describe, expect, test } from 'bun:test';

import { JA4_DENY, valuesOf } from './deny-list';
import { rules } from './rules';
import { TEST_DENIED_JA4 } from './test-setup';

describe('test-setup', () => {
  test('the fixture values are in force, whatever the shell exported', () => {
    // Assigned outright rather than with ??=, so a developer with FW_BLOCKED_JA4 set cannot
    // change what every assertion in this package is written against.
    expect(process.env.DRY_RUN).toBe('1');
    expect(process.env.FW_BLOCKED_JA4).toBe(TEST_DENIED_JA4);
    expect(process.env.FW_CHALLENGE_JA4).toBe('');
    expect(process.env.FW_BLOCKED_ASN).toBe('');
  });

  test('credentials exist, because resolveVercelCredentials throws at import time', () => {
    for (const k of ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID'])
      expect(process.env[k]).toBeTruthy();
  });

  // The reason the preload imports ./rules itself: watch.ts reaches it through a dynamic import
  // from inside a try/catch, and a test that clears the environment around that call would
  // otherwise fix a different rule set — or none — for every file running after it.
  test('the rule set was built from those values, not from an emptied environment', () => {
    const ja4 = rules.find((r) => r.name === 'deny-scraper-ja4');
    if (!ja4) throw new Error('deny-scraper-ja4 is missing from the rule set');
    expect(valuesOf(ja4, JA4_DENY)).toEqual([TEST_DENIED_JA4]);
  });

  test('dry-run is on, so no test can reach the live WAF', () => {
    expect(process.env.DRY_RUN).toBe('1');
  });
});
