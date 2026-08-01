import { describe, expect, test } from 'bun:test';

import { PUBLISHABLE_EVIDENCE } from './publishable';

describe('PUBLISHABLE_EVIDENCE', () => {
  test('publishes only tiers a measurement or an owner stands behind', () => {
    // Each entry earned its place differently and none may drift in:
    // crn_on_page is the company publishing its own registration number,
    // manual is an owner decision, and registry_confirmed is the registered
    // office postcode on the page — measured at 97.9% over 97 rows with zero
    // wrong, and shipped as a judgement call recorded in publishable.ts.
    expect([...PUBLISHABLE_EVIDENCE].sort()).toEqual([
      'crn_on_page',
      'manual',
      'registry_confirmed',
    ]);
  });

  test('bare registry is NOT publishable', () => {
    // The measurement that matters: the registry tier as a whole is 90%
    // precise, and the rows it would add beyond registry_confirmed were 14/29.
    // This is the assertion that fails if anyone widens the list to `registry`.
    expect(PUBLISHABLE_EVIDENCE).not.toContain('registry');
    expect(PUBLISHABLE_EVIDENCE).not.toContain('registry_unconfirmed');
    expect(PUBLISHABLE_EVIDENCE).not.toContain('postcode_on_page');
  });
});
