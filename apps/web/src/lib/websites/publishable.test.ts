import { describe, expect, test } from 'bun:test';

import { PUBLISHABLE_EVIDENCE } from './publishable';

describe('PUBLISHABLE_EVIDENCE', () => {
  test('publishes only tiers a measurement or an owner stands behind', () => {
    // Each entry earned its place differently and none may drift in:
    // crn_on_page is the company publishing its own registration number, and
    // manual is an owner decision. Nothing else is published on a heuristic
    // until a sample of the SHIPPED rule clears the floor.
    expect([...PUBLISHABLE_EVIDENCE].sort()).toEqual(['crn_on_page', 'manual']);
  });

  test('registry_confirmed is written but NOT yet published', () => {
    // The tier exists and the sweep maintains it, but the precision figure that
    // motivated it scored a different rule: the sample used the post-redirect
    // host while the sweep read the pre-redirect one, and fixing that also
    // meant tightening token and squash matching. It publishes when a fresh
    // sample clears the floor against the rule as shipped, not before.
    expect(PUBLISHABLE_EVIDENCE).not.toContain('registry_confirmed');
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
